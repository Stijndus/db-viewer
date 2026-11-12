import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  changeCount,
  changeStatements,
  isSqlValue,
  type CellValue,
  type ChangeSet,
  type RowValues,
} from '../../../../../shared/changes';
import type {
  ColumnInfo,
  DbError,
  RowsPage,
  SortDirection,
  SortKey,
} from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { KeybindingsStore } from '../../../core/keybindings/keybindings.store';
import { ConnectionsStore } from '../../connections/connections.store';
import { SchemaStore, type Load, type SelectedObject } from '../../schema/schema.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { TransferStore } from '../../transfer/transfer.store';
import { gridValues } from '../data-grid/copy-formats';
import { PromptStore } from '../../../core/prompt/prompt';
import type { MenuAction, MenuEntry } from '../../../core/context-menu/context-menu.store';
import { quoteIdent, stringLiteral } from '../../../../../shared/dialect';
import {
  base64Bytes,
  binaryValue,
  bytesBase64,
  dateValues,
  fileSize,
  guidValues,
  isBinaryType,
  sqlFunctionSuggestions,
  utf8Text,
} from './cell-values';
import {
  DataGrid,
  DEFAULT_CELL,
  type CellEdit,
  type GridCell,
  type GridColumn,
  type GridMenuSections,
  type GridSelection,
  type RowMark,
} from '../data-grid/data-grid';

export const PAGE_SIZES = [100, 200, 500, 1000] as const;
const PAGE_SIZE_KEY = 'dbv.pageSize';

/** Unsaved edits on the current page. Row and column numbers refer to the page as loaded. */
interface Pending {
  /** row → col → new value (text, NULL, or SQL such as NOW()) */
  edits: Record<number, Record<number, CellValue>>;
  deleted: number[];
  /** New rows: col → value; a column left out gets its DEFAULT. */
  added: Record<number, CellValue>[];
}

/** A pending value as the grid shows it. */
function asCell(value: CellValue): GridCell {
  return isSqlValue(value)
    ? { kind: 'sql', sql: value.sql, ...(value.label && { label: value.label }) }
    : value;
}

const NO_CHANGES: Pending = { edits: {}, deleted: [], added: [] };
const DISCARD_QUESTION = 'Er zijn niet-opgeslagen wijzigingen. Weggooien?';

type CountState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; value: number }
  | { status: 'error'; error: DbError };

/** The Data tab: filter, sort and page through the rows of one table or view, and edit them. */
let uidCounter = 0;

@Component({
  selector: 'app-table-data',
  imports: [DataGrid],
  templateUrl: './table-data.html',
})
export class TableData {
  readonly object = input.required<SelectedObject>();
  /** The workspace tab this view lives in: shows a marker there while edits are unsaved. */
  readonly tabId = input<string | null>(null);
  /** Unique per instance: several tabs are rendered at once. */
  protected readonly uid = `u${++uidCounter}`;
  /** Column metadata from the schema cache: types for the header, primary key for default order. */
  readonly columns = input<Load<ColumnInfo[]> | undefined>(undefined);
  /** Row estimate from table statistics, shown until an exact count is asked for. */
  readonly estimate = input<number | null>(null);

  private readonly api = inject(DB_API);
  private readonly prompt = inject(PromptStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly transfer = inject(TransferStore);
  private readonly schema = inject(SchemaStore);
  protected readonly keys = inject(KeybindingsStore);
  private readonly grid = viewChild(DataGrid);
  private readonly sqlDialog = viewChild<ElementRef<HTMLDialogElement>>('sqlDialog');

  protected readonly pageSizes = PAGE_SIZES;
  protected readonly pageSize = signal<number>(readPageSize());
  protected readonly offset = signal(0);
  /** The sort the user picked; null = primary key order. */
  protected readonly sort = signal<SortKey | null>(null);
  protected readonly whereDraft = signal('');
  protected readonly whereApplied = signal('');
  protected readonly page = signal<RowsPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<DbError | null>(null);
  protected readonly count = signal<CountState>({ status: 'idle' });
  protected readonly note = signal<string | null>(null);
  protected readonly pending = signal<Pending>(NO_CHANGES);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<DbError | null>(null);
  protected readonly selectedCell = signal<{ row: number; col: number } | null>(null);
  /** Bumped when a fresh page is loaded: the grid scrolls back to the top. */
  protected readonly pageVersion = signal(0);

  private requestId = 0;
  private objectKey = '';
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly columnInfo = computed(() => {
    const state = this.columns();
    return state?.status === 'loaded' ? state.data : [];
  });

  private readonly primaryKey = computed(() =>
    this.columnInfo()
      .filter((c) => c.key === 'primary')
      .map((c) => c.name),
  );

  /** The order actually used: the user's choice, else the primary key, else server order. */
  protected readonly effectiveOrder = computed<SortKey[]>(() => {
    const sort = this.sort();
    if (sort) return [sort];
    return this.primaryKey().map((column) => ({ column, direction: 'asc' as const }));
  });

  protected readonly gridColumns = computed<GridColumn[]>(() => {
    const page = this.page();
    if (!page) return [];
    const info = new Map(this.columnInfo().map((c) => [c.name, c]));
    const sort = this.sort();
    return page.columns.map((name) => {
      const col = info.get(name);
      const type = col?.type ?? '';
      return {
        name,
        type,
        numeric: isNumericType(type),
        width: columnWidth(name, type),
        primary: col?.key === 'primary',
        sort: sort?.column === name ? sort.direction : null,
      };
    });
  });

  protected readonly rangeText = computed(() => {
    const page = this.page();
    if (!page || page.rows.length === 0) return null;
    const from = this.offset() + 1;
    const to = this.offset() + page.rows.length;
    return `Rijen ${fmt(from)}–${fmt(to)}`;
  });

  protected readonly totalText = computed(() => {
    const count = this.count();
    if (count.status === 'done') return `van ${fmt(count.value)}`;
    const estimate = this.estimate();
    if (!this.whereApplied() && estimate !== null && estimate > 0) return `van ≈ ${fmt(estimate)}`;
    return null;
  });

  protected readonly pageNumber = computed(() => Math.floor(this.offset() / this.pageSize()) + 1);

  /** Whether this table can be edited, and if not, why. */
  protected readonly editState = computed<{ editable: boolean; reason: string | null }>(() => {
    const o = this.object();
    if (o.kind !== 'table') return { editable: false, reason: 'Views zijn alleen-lezen.' };
    const profile = this.connections.connections().find((c) => c.id === o.connectionId);
    if (profile?.readOnly) return { editable: false, reason: 'Deze verbinding is alleen-lezen.' };
    if (this.columns()?.status !== 'loaded') return { editable: false, reason: null };
    const pk = this.columnInfo().filter((c) => c.key === 'primary');
    if (pk.length === 0) {
      return {
        editable: false,
        reason: 'Geen primaire sleutel: een rij is niet eenduidig aan te wijzen, dus alleen-lezen.',
      };
    }
    if (pk.some((c) => /blob|binary|bit/i.test(c.type))) {
      return {
        editable: false,
        reason: 'Binaire primaire sleutel: bewerken wordt niet ondersteund.',
      };
    }
    return { editable: true, reason: null };
  });

  /** The page with unsaved edits applied, plus new rows at the bottom. */
  protected readonly displayRows = computed<GridCell[][]>(() => {
    const page = this.page();
    if (!page) return [];
    const { edits, added } = this.pending();
    const rows: GridCell[][] = page.rows.map((row, r) =>
      edits[r] ? row.map((cell, c) => (c in edits[r]! ? asCell(edits[r]![c]!) : cell)) : row,
    );
    for (const values of added) {
      rows.push(page.columns.map((_, c) => (c in values ? asCell(values[c]!) : DEFAULT_CELL)));
    }
    return rows;
  });

  protected readonly rowMarks = computed<RowMark[]>(() => {
    const page = this.page();
    if (!page) return [];
    const deleted = new Set(this.pending().deleted);
    return [
      ...page.rows.map((_, r) => (deleted.has(r) ? ('deleted' as const) : null)),
      ...this.pending().added.map(() => 'new' as const),
    ];
  });

  protected readonly editedCells = computed(() => {
    const { edits, added } = this.pending();
    const n = this.page()?.rows.length ?? 0;
    const keys = new Set<string>();
    for (const [r, cols] of Object.entries(edits))
      for (const c of Object.keys(cols)) keys.add(`${r}:${c}`);
    added.forEach((values, i) => Object.keys(values).forEach((c) => keys.add(`${n + i}:${c}`)));
    return keys;
  });

  protected readonly changeSet = computed<ChangeSet | null>(() => {
    const page = this.page();
    if (!page) return null;
    const pk = this.columnInfo()
      .filter((c) => c.key === 'primary')
      .map((c) => c.name);
    const pkIndex = pk.map((name) => page.columns.indexOf(name));
    if (pk.length === 0 || pkIndex.some((i) => i < 0)) return null;
    const keyOf = (r: number) =>
      Object.fromEntries(pk.map((name, i) => [name, String(page.rows[r]?.[pkIndex[i]!] ?? '')]));
    const valuesOf = (cols: Record<number, CellValue>): RowValues =>
      Object.fromEntries(Object.entries(cols).map(([c, v]) => [page.columns[Number(c)]!, v]));

    const { edits, deleted, added } = this.pending();
    const deletedSet = new Set(deleted);
    return {
      primaryKey: pk,
      deletes: deleted.map((r) => ({ key: keyOf(r) })),
      updates: Object.entries(edits)
        .filter(([r, cols]) => !deletedSet.has(Number(r)) && Object.keys(cols).length > 0)
        .map(([r, cols]) => ({ key: keyOf(Number(r)), values: valuesOf(cols) })),
      inserts: added.map((values) => ({ values: valuesOf(values) })),
    };
  });

  protected readonly changeTotal = computed(() => {
    const cs = this.changeSet();
    return cs ? changeCount(cs) : 0;
  });

  /** The database type of this table's connection: decides quoting in the SQL preview. */
  protected readonly dialect = computed(
    () =>
      this.connections.connections().find((c) => c.id === this.object().connectionId)?.type ??
      'mysql',
  );

  protected readonly previewSql = computed(() => {
    const cs = this.changeSet();
    if (!cs) return '';
    const o = this.object();
    return changeStatements(o.database, o.name, cs, this.dialect())
      .map((s) => s.preview + ';')
      .join('\n');
  });

  /** The selected row: is it deleted, new, or a normal row? */
  protected readonly selectedRowMark = computed<RowMark | undefined>(() => {
    const cell = this.selectedCell();
    return cell ? (this.rowMarks()[cell.row] ?? null) : undefined;
  });

  protected readonly selectedNullable = computed(() => {
    const cell = this.selectedCell();
    const name = cell ? this.page()?.columns[cell.col] : undefined;
    return name ? (this.columnInfo().find((c) => c.name === name)?.nullable ?? true) : false;
  });

  protected readonly orderText = computed(() => {
    const order = this.effectiveOrder();
    if (order.length === 0) return 'Volgorde van de server';
    const keys = order.map((k) => `${k.column} ${k.direction === 'asc' ? '↑' : '↓'}`).join(', ');
    return this.sort() ? `Gesorteerd op ${keys}` : `Op primaire sleutel (${keys})`;
  });

  /**
   * Export dialog for selected rows. With a primary key and no unsaved changes in them, the rows
   * are fetched again by key (complete values); otherwise exactly as the grid shows them.
   */
  protected exportRows({ rows: indexes, clipboard }: { rows: number[]; clipboard: boolean }): void {
    const o = this.object();
    const page = this.page();
    if (!page || indexes.length === 0) return;
    const { edits, deleted } = this.pending();
    const pk = this.primaryKey();
    const pkIndex = pk.map((name) => page.columns.indexOf(name));
    const saved = indexes.every((r) => r < page.rows.length && !edits[r] && !deleted.includes(r));
    const keys =
      saved && pk.length > 0 && pkIndex.every((i) => i >= 0)
        ? indexes.map((r) => pkIndex.map((i) => page.rows[r]?.[i!] ?? null))
        : null;
    const n = indexes.length;
    const rows = `${n} ${n === 1 ? 'rij' : 'rijen'}`;
    if (keys && keys.every((k) => k.every((v) => v === null || typeof v === 'string'))) {
      this.transfer.openExport({
        connectionId: o.connectionId,
        title: `${rows} uit ${o.name}`,
        baseName: o.name,
        note: `De geselecteerde ${rows} worden opnieuw opgehaald op primaire sleutel, met alle waarden volledig.`,
        ...(clipboard && { output: 'clipboard' as const }),
        source: {
          kind: 'keys',
          database: o.database,
          table: o.name,
          keyColumns: pk,
          keys: keys as (string | null)[][],
        },
      });
      return;
    }
    const shown = this.displayRows();
    const cols = this.gridColumns();
    this.transfer.openExport({
      connectionId: o.connectionId,
      title: `${rows} uit ${o.name}`,
      baseName: o.name,
      note: `De ${rows} zoals het grid ze toont${pk.length ? ', met je niet-opgeslagen wijzigingen' : ' (de tabel heeft geen primaire sleutel)'}; lange teksten kunnen ingekort zijn.`,
      ...(clipboard && { output: 'clipboard' as const }),
      source: gridValues(
        cols,
        indexes.map((r) => shown[r] ?? []),
      ),
    });
  }

  /** Export dialog with this table, the applied filter and the order shown. */
  protected exportTable(): void {
    const o = this.object();
    this.transfer.openExport({
      connectionId: o.connectionId,
      title: o.name,
      baseName: o.name,
      source: {
        kind: 'table',
        database: o.database,
        table: o.name,
        ...(this.whereApplied().trim() && { where: this.whereApplied() }),
        orderBy: this.effectiveOrder(),
      },
    });
  }

  private readonly createdAt = performance.now();

  constructor() {
    this.registerCommands();
    // Emptied from the tree's menu: show the (now empty) table again, edits are gone with the rows.
    effect(() => {
      const changed = this.schema.dataChanged();
      const o = untracked(this.object);
      if (
        changed &&
        changed.at >= this.createdAt &&
        changed.object.connectionId === o.connectionId &&
        changed.object.database === o.database &&
        changed.object.name === o.name
      ) {
        untracked(() => {
          this.reset();
          void this.load();
        });
      }
    });
    // New table: start over. Load once the column metadata is in (it decides the default order).
    effect(() => {
      const o = this.object();
      const status = this.columns()?.status;
      untracked(() => {
        const key = `${o.connectionId}\u0001${o.database}\u0001${o.name}`;
        if (key !== this.objectKey) {
          this.objectKey = key;
          this.reset();
        }
        const ready = status === 'loaded' || status === 'error';
        if (ready && !this.page() && !this.loading() && !this.error()) void this.load();
      });
    });
  }

  /** Refresh button: also asks before throwing away unsaved edits. */
  protected refresh(): void {
    if (this.confirmDiscard()) void this.load();
  }

  /** Unsaved edits mark the tab, so they are not forgotten behind another tab. */
  private readonly reportDirty = effect(() => {
    const id = this.tabId();
    this.pending();
    const dirty = this.hasChanges();
    if (id) untracked(() => this.workspace.setDirty(id, dirty));
  });

  async load(): Promise<void> {
    const o = this.object();
    const id = ++this.requestId;
    this.pending.set(NO_CHANGES);
    this.saveError.set(null);
    this.loading.set(true);
    const result = await this.api.readRows(o.connectionId, o.database, o.name, {
      offset: this.offset(),
      limit: this.pageSize(),
      orderBy: this.effectiveOrder(),
      where: this.whereApplied() || undefined,
    });
    if (id !== this.requestId) return; // A newer request superseded this one.
    this.loading.set(false);
    if (result.ok) {
      this.page.set(result.data);
      this.pageVersion.update((v) => v + 1);
      this.selectedCell.set(null);
      this.error.set(null);
    } else {
      this.page.set(null);
      this.error.set(result.error);
    }
  }

  protected applyFilter(event?: Event): void {
    event?.preventDefault();
    if (!this.confirmDiscard()) return;
    this.whereApplied.set(this.whereDraft().trim());
    this.offset.set(0);
    this.count.set({ status: 'idle' });
    void this.load();
  }

  protected clearFilter(): void {
    this.whereDraft.set('');
    this.applyFilter();
  }

  protected toggleSort(column: string): void {
    if (!this.confirmDiscard()) return;
    const current = this.sort();
    const next: SortDirection | null =
      current?.column !== column ? 'asc' : current.direction === 'asc' ? 'desc' : null;
    this.sort.set(next ? { column, direction: next } : null);
    this.offset.set(0);
    void this.load();
  }

  protected goTo(offset: number): void {
    if (!this.confirmDiscard()) return;
    this.offset.set(Math.max(0, offset));
    void this.load();
  }

  protected setPageSize(select: HTMLSelectElement): void {
    if (!this.confirmDiscard()) {
      select.value = String(this.pageSize()); // keep showing the size that is still in use
      return;
    }
    const size = Number(select.value);
    this.pageSize.set(size);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
    this.offset.set(0);
    void this.load();
  }

  protected async countRows(): Promise<void> {
    const o = this.object();
    const id = this.requestId;
    this.count.set({ status: 'loading' });
    const result = await this.api.countRows(
      o.connectionId,
      o.database,
      o.name,
      this.whereApplied() || undefined,
    );
    if (id !== this.requestId && this.count().status !== 'loading') return;
    this.count.set(
      result.ok ? { status: 'done', value: result.data } : { status: 'error', error: result.error },
    );
  }

  protected onCopied(text: string): void {
    this.showNote(text);
  }

  // ── Editing ────────────────────────────────────────────────────

  hasChanges(): boolean {
    const { edits, deleted, added } = this.pending();
    return deleted.length > 0 || added.length > 0 || Object.keys(edits).length > 0;
  }

  protected onCellEdited({ row, col, value }: CellEdit): void {
    const page = this.page();
    if (!page) return;
    const n = page.rows.length;
    this.pending.update((p) => {
      if (row >= n) {
        const added = p.added.map((values, i) => {
          if (i !== row - n) return values;
          // DEFAULT on a new row: leave the column out, the server fills it in.
          if (isSqlValue(value) && value.sql === 'DEFAULT') {
            const rest = { ...values };
            delete rest[col];
            return rest;
          }
          return { ...values, [col]: value };
        });
        return { ...p, added };
      }
      const original = page.rows[row]?.[col] ?? null;
      const cols = { ...(p.edits[row] ?? {}) };
      // Back to the original value: no longer a change.
      if (value === original) delete cols[col];
      else cols[col] = value;
      const edits = { ...p.edits };
      if (Object.keys(cols).length > 0) edits[row] = cols;
      else delete edits[row];
      return { ...p, edits };
    });
  }

  protected addRow(): void {
    this.pending.update((p) => ({ ...p, added: [...p.added, {}] }));
    const row = (this.page()?.rows.length ?? 0) + this.pending().added.length - 1;
    const grid = this.grid();
    if (grid) grid.focusCell(row, 0);
    // An empty table only gets its grid once the first row exists.
    else setTimeout(() => this.grid()?.focusCell(row, 0));
  }

  /** The NULL button: every selected cell, like Ctrl+Shift+N. */
  protected setNull(): void {
    this.fill(() => null);
  }

  protected discard(): void {
    this.pending.set(NO_CHANGES);
    this.saveError.set(null);
  }

  protected async save(): Promise<void> {
    const changes = this.changeSet();
    if (!changes || changeCount(changes) === 0 || this.saving()) return;
    const o = this.object();
    this.saving.set(true);
    this.saveError.set(null);
    const result = await this.api.applyChanges(o.connectionId, o.database, o.name, changes);
    this.saving.set(false);
    if (!result.ok) {
      this.saveError.set(result.error);
      return;
    }
    const { deleted, updated, inserted } = result.data;
    const parts = [
      updated && `${updated} gewijzigd`,
      inserted && `${inserted} toegevoegd`,
      deleted && `${deleted} verwijderd`,
    ].filter(Boolean);
    this.showNote(`Opgeslagen: ${parts.join(', ')}`);
    this.count.set({ status: 'idle' });
    await this.load();
  }

  protected showSql(): void {
    this.sqlDialog()?.nativeElement.showModal();
  }

  protected closeSql(): void {
    this.sqlDialog()?.nativeElement.close();
  }

  // ── The grid's context menu (like HeidiSQL's) ──────────────────────
  /** The items this table adds to the grid menu: values, rows, sorting and filtering. */
  protected readonly gridMenu = (sel: GridSelection): GridMenuSections => {
    const editable = this.editState().editable;
    const page = this.page();
    const n = page?.rows.length ?? 0;
    const key = (command: string) => this.keys.keyLabel(command);
    const single = sel.top === sel.bottom && sel.left === sel.right;
    const rows = sel.bottom - sel.top + 1;
    const dates = dateValues();
    const fill = (make: () => CellValue) => () => this.fill(make);
    const valueItems: MenuEntry[] = [];
    if (editable) {
      valueItems.push({
        label: 'Waarde invoegen',
        items: [
          { label: 'NULL', shortcut: key('data.setNull'), run: fill(() => null) },
          {
            label: 'SQL-functie…',
            shortcut: key('data.sqlFunction'),
            run: () => void this.sqlFunction(),
          },
          ...(this.dialect() === 'sqlite' && sel.top < n
            ? []
            : [{ label: 'Standaardwaarde (DEFAULT)', run: fill(() => ({ sql: 'DEFAULT' })) }]),
          'separator',
          ...dates.local.map((v) => ({ label: v.label, run: fill(v.make) })),
          'separator',
          ...dates.utc.map((v) => ({ label: v.label, run: fill(v.make) })),
          'separator',
          ...guidValues().map((v) => ({ label: v.label, run: fill(v.make) })),
        ],
      });
      if (single)
        valueItems.push({ label: 'Bestand in cel laden…', run: () => void this.loadFile() });
    }
    if (single && sel.row < n) {
      valueItems.push({ label: 'Waarde opslaan als bestand…', run: () => void this.saveValue() });
    }

    const rowItems: MenuEntry[] = [];
    if (editable) {
      const marks = this.rowMarks();
      const allDeleted = Array.from({ length: rows }, (_, i) => sel.top + i).every(
        (r) => r >= n || marks[r] === 'deleted',
      );
      rowItems.push(
        { label: 'Rij toevoegen', shortcut: key('data.addRow'), run: () => this.addRow() },
        {
          label:
            rows === 1
              ? 'Rij dupliceren zonder sleutels'
              : `${rows} rijen dupliceren zonder sleutels`,
          shortcut: key('data.duplicateRow'),
          run: () => this.duplicate(sel, false),
        },
        {
          label:
            rows === 1 ? 'Rij dupliceren met sleutels' : `${rows} rijen dupliceren met sleutels`,
          run: () => this.duplicate(sel, true),
        },
        ...(this.hasChanges()
          ? [
              {
                label: 'Wijzigingen opslaan',
                shortcut: key('data.save'),
                run: () => void this.save(),
              },
              { label: 'Wijzigingen annuleren', run: () => this.discard() },
            ]
          : []),
        {
          label: allDeleted
            ? rows === 1
              ? 'Rij terugzetten'
              : `${rows} rijen terugzetten`
            : rows === 1
              ? 'Rij verwijderen'
              : `${rows} rijen verwijderen`,
          shortcut: key('data.deleteRows'),
          danger: !allDeleted,
          run: () => this.deleteRows(sel),
        },
      );
    }

    const viewItems: MenuEntry[] = [];
    if (this.sort()) {
      viewItems.push({
        label: 'Sortering herstellen',
        shortcut: key('data.resetSort'),
        run: () => this.resetSort(),
      });
    }
    const filters = this.quickFilters(sel);
    if (filters.length) viewItems.push({ label: 'Snelfilter', items: filters });

    return {
      values: valueItems,
      rows: rowItems,
      view: viewItems,
      tail: [{ label: 'Vernieuwen', shortcut: key('data.refresh'), run: () => this.refresh() }],
    };
  };

  /** Gives every replaceable cell of the selection a value (a GUID per cell, for instance). */
  private fill(make: () => CellValue): void {
    const grid = this.grid();
    const sel = grid?.selection();
    if (!grid || !sel) return;
    let n = 0;
    for (let row = sel.top; row <= sel.bottom; row++)
      for (let col = sel.left; col <= sel.right; col++)
        if (grid.canReplace(row, col)) {
          this.onCellEdited({ row, col, value: make() });
          n++;
        }
    if (n > 1) this.showNote(`${n} cellen gewijzigd`);
  }

  /** Ctrl+F2: SQL for the selected cells, e.g. NOW() or UUID(). */
  protected async sqlFunction(): Promise<void> {
    if (!this.editState().editable || !this.grid()?.selection()) return;
    const sql = await this.prompt.ask({
      title: 'SQL-functie in cel',
      label: 'SQL, wordt bij opslaan zo uitgevoerd',
      value: sqlFunctionSuggestions(this.dialect())[0] ?? '',
      suggestions: sqlFunctionSuggestions(this.dialect()),
      hint: 'De database rekent de waarde uit bij het opslaan, zoals een functie in een UPDATE.',
      confirm: 'Invoegen',
    });
    if (sql) this.fill(() => ({ sql }));
  }

  /** "Bestand in cel laden": bytes for a binary column, text (UTF-8) for the others. */
  private async loadFile(): Promise<void> {
    const sel = this.grid()?.selection();
    const page = this.page();
    if (!sel || !page) return;
    const result = await this.api.pickCellFile();
    if (!result.ok) return this.showNote(result.error.message);
    if (!result.data) return;
    const { name, base64 } = result.data;
    const bytes = base64Bytes(base64);
    const column = this.columnInfo().find((c) => c.name === page.columns[sel.col]);
    if (column && isBinaryType(column.type)) {
      this.onCellEdited({
        row: sel.row,
        col: sel.col,
        value: binaryValue(bytes, name, this.dialect()),
      });
    } else {
      const text = utf8Text(bytes);
      if (text === null)
        return this.showNote(`${name} is geen tekst; kies een binaire kolom (BLOB).`);
      this.onCellEdited({ row: sel.row, col: sel.col, value: text });
    }
    this.showNote(`${name} geladen (${fileSize(bytes.length)}); sla op om het te bewaren`);
  }

  /** "Waarde opslaan als bestand": complete from the server by key, else as shown. */
  private async saveValue(): Promise<void> {
    const sel = this.grid()?.selection();
    const page = this.page();
    if (!sel || !page) return;
    const o = this.object();
    const column = page.columns[sel.col]!;
    const pk = this.primaryKey();
    const pkIndex = pk.map((c) => page.columns.indexOf(c));
    const keyValues = pkIndex.map((i) => page.rows[sel.row]?.[i] ?? null);
    const binary = isBinaryType(this.columnInfo().find((c) => c.name === column)?.type ?? '');
    const name = `${o.name}-${column}-${keyValues.join('-') || sel.row + 1}.${binary ? 'bin' : 'txt'}`;
    let result;
    if (
      pk.length &&
      pkIndex.every((i) => i >= 0) &&
      keyValues.every((v) => v === null || typeof v === 'string')
    ) {
      result = await this.api.saveCellToFile(o.connectionId, {
        kind: 'key',
        database: o.database,
        table: o.name,
        keyColumns: pk,
        keyValues: keyValues as (string | null)[],
        column,
        name,
      });
    } else {
      const cell = page.rows[sel.row]?.[sel.col] ?? null;
      const text =
        cell === null ? '' : typeof cell === 'string' ? cell : 'text' in cell ? cell.text : '';
      result = await this.api.saveCellToFile(o.connectionId, {
        kind: 'content',
        base64: bytesBase64(new TextEncoder().encode(text)),
        name,
      });
    }
    if (!result.ok) this.showNote(result.error.message);
    else if (result.data) this.showNote(`Opgeslagen: ${result.data}`);
  }

  /**
   * New rows with the values of the selected rows. Without keys: the primary key and columns the
   * server fills (auto-increment, identity) get their default. Values the grid has only in part
   * (long text, large binary) are left to their default too, and the note says so.
   */
  protected duplicate(sel: GridSelection, withKeys: boolean): void {
    const page = this.page();
    if (!page || !this.editState().editable) return;
    const shown = this.displayRows();
    const info = new Map(this.columnInfo().map((c) => [c.name, c]));
    let skipped = 0;
    const added: Record<number, CellValue>[] = [];
    for (let r = sel.top; r <= sel.bottom; r++) {
      const values: Record<number, CellValue> = {};
      page.columns.forEach((name, c) => {
        const col = info.get(name);
        if (
          !withKeys &&
          (col?.key === 'primary' ||
            /auto_increment|identity|generated|computed/i.test(col?.extra ?? ''))
        )
          return;
        const cell = shown[r]?.[c];
        if (cell === undefined) return;
        if (cell === null || typeof cell === 'string') values[c] = cell;
        else if (cell.kind === 'sql')
          values[c] = { sql: cell.sql, ...(cell.label && { label: cell.label }) };
        else if (cell.kind === 'binary' && cell.hex.length / 2 >= cell.bytes)
          values[c] = binaryValue(hexBytes(cell.hex), `${cell.bytes} bytes`, this.dialect());
        else if (cell.kind !== 'default') skipped++;
      });
      added.push(values);
    }
    this.pending.update((p) => ({ ...p, added: [...p.added, ...added] }));
    const first = n0(page) + this.pending().added.length - added.length;
    this.grid()?.focusCell(first, 0);
    this.showNote(
      `${added.length === 1 ? 'Rij' : `${added.length} rijen`} gedupliceerd${
        skipped
          ? `; ${skipped} lange ${skipped === 1 ? 'waarde krijgt' : 'waarden krijgen'} de standaardwaarde`
          : ''
      }`,
    );
  }

  /** The toolbar button: the selected rows, like Ctrl+Del. */
  protected deleteSelected(): void {
    const sel = this.grid()?.selection();
    if (sel) this.deleteRows(sel);
  }

  /** Marks the selected rows deleted (new rows are dropped); all deleted already: restores them. */
  protected deleteRows(sel: GridSelection): void {
    const page = this.page();
    if (!page || !this.editState().editable) return;
    const n = page.rows.length;
    const rows = Array.from({ length: sel.bottom - sel.top + 1 }, (_, i) => sel.top + i);
    this.pending.update((p) => {
      const existing = rows.filter((r) => r < n);
      const restore = existing.length > 0 && existing.every((r) => p.deleted.includes(r));
      const deleted = restore
        ? p.deleted.filter((r) => !existing.includes(r))
        : [...new Set([...p.deleted, ...existing])];
      const added = p.added.filter((_, i) => !rows.includes(n + i));
      return { ...p, deleted, added };
    });
    if (rows.some((r) => r >= n)) this.selectedCell.set(null);
  }

  private resetSort(): void {
    if (!this.sort() || !this.confirmDiscard()) return;
    this.sort.set(null);
    this.offset.set(0);
    void this.load();
  }

  /** Filters on the active cell's value, like HeidiSQL's Quick Filter. */
  private quickFilters(sel: GridSelection): (MenuAction | 'separator')[] {
    const page = this.page();
    if (!page || sel.row >= page.rows.length) return [];
    const name = page.columns[sel.col];
    if (!name) return [];
    const dialect = this.dialect();
    const col = quoteIdent(name, dialect);
    const cell = page.rows[sel.row]?.[sel.col] ?? null;
    const numeric = this.gridColumns()[sel.col]?.numeric ?? false;
    const apply = (where: string) => () => {
      this.whereDraft.set(where);
      this.applyFilter();
    };
    const items: (MenuAction | 'separator')[] = [];
    if (typeof cell === 'string' && cell.length <= 1000) {
      const v = numeric && /^-?\d+(\.\d+)?$/.test(cell) ? cell : stringLiteral(cell, dialect);
      const like = (pattern: string) => stringLiteral(pattern, dialect);
      const escaped = cell.replace(/[\\%_]/g, (c) => `\\${c}`);
      const show = cell.length > 30 ? stringLiteral(cell.slice(0, 30) + '…', dialect) : v;
      items.push(
        { label: `${name} = ${show}`, run: apply(`${col} = ${v}`) },
        { label: `${name} <> ${show}`, run: apply(`${col} <> ${v}`) },
        { label: `${name} bevat ${show}`, run: apply(`${col} LIKE ${like(`%${escaped}%`)}`) },
        {
          label: `${name} bevat niet ${show}`,
          run: apply(`${col} NOT LIKE ${like(`%${escaped}%`)}`),
        },
        { label: `${name} > ${show}`, run: apply(`${col} > ${v}`) },
        { label: `${name} < ${show}`, run: apply(`${col} < ${v}`) },
        'separator',
      );
    }
    items.push(
      { label: `${name} IS NULL`, run: apply(`${col} IS NULL`) },
      { label: `${name} IS NOT NULL`, run: apply(`${col} IS NOT NULL`) },
    );
    if (this.whereApplied())
      items.push('separator', { label: 'Filter wissen', run: () => this.clearFilter() });
    return items;
  }

  /** Data commands (F5, Ctrl+S, Ins, …) for this table while its tab is shown. */
  private registerCommands(): void {
    const keys = this.keys;
    const ws = inject(WorkspaceStore);
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroy = inject(DestroyRef);
    const shown = () =>
      (this.tabId() === null || ws.activeId() === this.tabId()) &&
      host.isConnected &&
      host.getClientRects().length > 0;
    const on = (command: string, run: () => boolean | void) =>
      keys.handle(command, () => (shown() ? run() : false), destroy);
    on('data.refresh', () => this.refresh());
    on('data.save', () => {
      if (!this.hasChanges()) return false;
      void this.save();
      return true;
    });
    on('data.addRow', () => (this.editState().editable ? this.addRow() : false));
    on('data.deleteRows', () => {
      const sel = this.grid()?.selection();
      return sel && this.editState().editable ? this.deleteRows(sel) : false;
    });
    on('data.setNull', () =>
      this.editState().editable && this.grid()?.selection() ? this.fill(() => null) : false,
    );
    on('data.focusFilter', () => {
      const input = host.querySelector<HTMLInputElement>('.dt-where');
      input?.focus();
      input?.select();
    });
    on('data.clearFilter', () => {
      if (!this.whereDraft() && !this.whereApplied()) return false;
      this.clearFilter();
      return true;
    });
    on('data.resetSort', () => (this.sort() ? this.resetSort() : false));
    on('data.sqlFunction', () => (this.editState().editable ? void this.sqlFunction() : false));
    on('data.duplicateRow', () => {
      const sel = this.grid()?.selection();
      return sel && this.editState().editable ? this.duplicate(sel, false) : false;
    });
    on('data.discard', () => (this.hasChanges() ? this.discard() : false));
    on('data.nextPage', () => {
      if (!this.page()?.hasMore || this.loading()) return;
      this.goTo(this.offset() + this.pageSize());
    });
    on('data.previousPage', () => {
      if (this.offset() === 0 || this.loading()) return;
      this.goTo(this.offset() - this.pageSize());
    });
  }

  private confirmDiscard(): boolean {
    if (!this.hasChanges()) return true;
    if (!confirm(DISCARD_QUESTION)) return false;
    this.pending.set(NO_CHANGES);
    return true;
  }

  private showNote(text: string): void {
    this.note.set(text);
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.note.set(null), text.includes('let op') ? 6000 : 3000);
  }

  private reset(): void {
    this.requestId++;
    this.offset.set(0);
    this.sort.set(null);
    this.whereDraft.set('');
    this.whereApplied.set('');
    this.page.set(null);
    this.loading.set(false);
    this.error.set(null);
    this.count.set({ status: 'idle' });
    this.note.set(null);
    this.pending.set(NO_CHANGES);
    this.saveError.set(null);
    this.selectedCell.set(null);
  }
}

function fmt(n: number): string {
  return new Intl.NumberFormat('nl-NL').format(n);
}

function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if ((PAGE_SIZES as readonly number[]).includes(stored)) return stored;
  } catch {
    // Storage unavailable.
  }
  return 200;
}

export function isNumericType(type: string): boolean {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/i.test(
    type,
  );
}

/** A starting width per column, from its type and name; long text gets the most room. */
export function columnWidth(name: string, type: string): number {
  const t = type.toLowerCase();
  let width: number;
  if (/^(tinyint|smallint|mediumint|int|integer|year|bit)\b/.test(t)) width = 96;
  else if (/^bigint\b/.test(t))
    width = 190; // 20 digits for BIGINT UNSIGNED
  else if (/^(decimal|numeric|float|double|real)\b/.test(t)) width = 120;
  else if (/^date$/.test(t)) width = 110;
  else if (/^(datetime|timestamp)\b/.test(t)) width = 170;
  else if (/^time\b/.test(t)) width = 100;
  else if (/^(enum|set)\b/.test(t)) width = 130;
  else if (/^(var)?char\((\d+)\)/.test(t)) {
    const length = Number(/\((\d+)\)/.exec(t)?.[1] ?? 50);
    width = Math.min(320, Math.max(120, length * 6));
  } else if (/(text|json)/.test(t)) width = 320;
  else if (/(blob|binary)/.test(t)) width = 200;
  else width = 160;
  // Never narrower than the header: name in the 13px font plus the sort arrow.
  return Math.max(width, Math.min(320, name.length * 8 + 44));
}

function n0(page: RowsPage): number {
  return page.rows.length;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
