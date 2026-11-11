import {
  Component,
  computed,
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
import { ConnectionsStore } from '../../connections/connections.store';
import type { Load, SelectedObject } from '../../schema/schema.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import {
  DataGrid,
  DEFAULT_CELL,
  type CellEdit,
  type GridCell,
  type GridColumn,
  type RowMark,
} from '../data-grid/data-grid';

export const PAGE_SIZES = [100, 200, 500, 1000] as const;
const PAGE_SIZE_KEY = 'dbv.pageSize';

/** Unsaved edits on the current page. Row and column numbers refer to the page as loaded. */
interface Pending {
  /** row → col → new value */
  edits: Record<number, Record<number, string | null>>;
  deleted: number[];
  /** New rows: col → value; a column left out gets its DEFAULT. */
  added: Record<number, string | null>[];
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
  host: { '(keydown)': 'onKeydown($event)' },
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
  private readonly connections = inject(ConnectionsStore);
  private readonly workspace = inject(WorkspaceStore);
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
      edits[r] ? row.map((cell, c) => (c in edits[r]! ? edits[r]![c]! : cell)) : row,
    );
    for (const values of added) {
      rows.push(page.columns.map((_, c) => (c in values ? values[c]! : DEFAULT_CELL)));
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
    const valuesOf = (cols: Record<number, string | null>): RowValues =>
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
  private readonly dialect = computed(
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

  constructor() {
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
    this.showNote(`Gekopieerd: ${text.length > 40 ? text.slice(0, 40) + '…' : text}`);
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
        const added = p.added.map((values, i) =>
          i === row - n ? { ...values, [col]: value } : values,
        );
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

  /** Deletes the selected row (or restores it, or drops it when it is new). */
  protected toggleDelete(): void {
    const cell = this.selectedCell();
    const n = this.page()?.rows.length ?? 0;
    if (!cell) return;
    this.pending.update((p) => {
      if (cell.row >= n) {
        return { ...p, added: p.added.filter((_, i) => i !== cell.row - n) };
      }
      const deleted = p.deleted.includes(cell.row)
        ? p.deleted.filter((r) => r !== cell.row)
        : [...p.deleted, cell.row];
      return { ...p, deleted };
    });
    if (cell.row >= n) this.selectedCell.set(null);
  }

  protected setNull(): void {
    const cell = this.selectedCell();
    if (cell && this.selectedRowMark() !== 'deleted') this.onCellEdited({ ...cell, value: null });
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

  protected onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
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
    this.noteTimer = setTimeout(() => this.note.set(null), 3000);
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
