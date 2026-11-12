import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { CellValue } from '../../../../../shared/changes';
import type { Cell, DbType, SortDirection } from '../../../../../shared/models';
import { ContextMenuStore, type MenuEntry } from '../../../core/context-menu/context-menu.store';
import { KeybindingsStore } from '../../../core/keybindings/keybindings.store';
import { COPY_FORMAT_LABELS, formatBlock, incompleteCount, type CopyFormat } from './copy-formats';
import { DB_API } from '../../../core/db-api';

export interface GridColumn {
  name: string;
  /** Declared type, shown under the name, e.g. `varchar(255)`. */
  type: string;
  numeric: boolean;
  width: number;
  primary: boolean;
  sort: SortDirection | null;
}

/** A column of a new row that will get its DEFAULT (the value was left untouched). */
export const DEFAULT_CELL = { kind: 'default' } as const;
/** A cell that gets SQL as its value (NOW(), DEFAULT, a loaded file), not saved yet. */
export interface SqlCell {
  kind: 'sql';
  sql: string;
  label?: string;
}
export type GridCell = Cell | typeof DEFAULT_CELL | SqlCell;

/** The selected block, given to the parent's menu items. */
export interface GridSelection {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** The active cell (where Shift+click started from, or the only cell). */
  row: number;
  col: number;
}

/** Menu items from the view that owns the grid (table or query result), per section. */
export interface GridMenuSections {
  /** After copy and paste: insert value, load or save a file. */
  values?: MenuEntry[];
  /** Row actions: add, duplicate, save, delete. */
  rows?: MenuEntry[];
  /** Sorting and filtering, before "Zoeken". */
  view?: MenuEntry[];
  /** At the end, before "Alles selecteren": refresh. */
  tail?: MenuEntry[];
}

export type RowMark = 'new' | 'deleted' | null;

export interface CellEdit {
  row: number;
  col: number;
  /** New value; null is SQL NULL; an object is SQL written as is. */
  value: CellValue;
}

interface Editing {
  row: number;
  col: number;
  draft: string;
}

interface CellView {
  text: string;
  cls: string;
  title: string | null;
}

export const ROW_HEIGHT = 30;
const NUM_WIDTH = 64;
/** Rows rendered above and below the visible area, so fast scrolling doesn't show gaps. */
const OVERSCAN = 12;

/**
 * Spreadsheet-like grid for one page of rows. Only the rows in view (plus a margin) are in the DOM,
 * so 1000 rows scroll as smoothly as 10. Header and row numbers stay in place while scrolling.
 */
@Component({
  selector: 'app-data-grid',
  templateUrl: './data-grid.html',
})
export class DataGrid {
  readonly columns = input.required<GridColumn[]>();
  readonly rows = input.required<GridCell[][]>();
  /** Changes when a new page is shown: scroll back to the top and clear the selection. */
  readonly pageKey = input<unknown>(undefined);
  /** Cells can be edited (double-click, Enter, F2 or just start typing). */
  readonly editable = input(false);
  readonly rowMarks = input<readonly RowMark[]>([]);
  /** `row:col` of cells with an unsaved change. */
  readonly editedCells = input<ReadonlySet<string>>(new Set());
  /** Absolute number of the first row on this page, for the row-number column. */
  readonly rowOffset = input(0);
  /** Query results are shown as returned; only table data can be re-sorted by the server. */
  readonly sortable = input(true);
  readonly sortRequested = output<string>();
  /** For copying as SQL: the dialect and the table the rows come from (query results: `export`). */
  readonly dialect = input<DbType>('mysql');
  readonly tableName = input('export');
  /** After copying: the value (shortened) or a summary such as "3 rijen × 2 kolommen als CSV". */
  readonly copied = output<string>();
  /** "Export selected rows…": the row indexes, top to bottom; to the clipboard for Ctrl+Shift+C. */
  readonly exportRows = output<{ rows: number[]; clipboard: boolean }>();
  readonly cellEdited = output<CellEdit>();
  /** Extra menu items from the owner, built when the menu opens. */
  readonly menuSections = input<((selection: GridSelection) => GridMenuSections) | null>(null);
  readonly selectionChange = output<{ row: number; col: number } | null>();

  protected readonly rowHeight = ROW_HEIGHT;
  private readonly destroyRef = inject(DestroyRef);
  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(0);
  protected readonly selected = signal<{ row: number; col: number } | null>(null);
  /** The other corner of a block selection (Shift+click, Shift+arrows); the active cell is `selected`. */
  private readonly anchor = signal<{ row: number; col: number } | null>(null);
  /** The selected block, inclusive; a single cell when nothing was extended. */
  protected readonly range = computed(() => {
    const s = this.selected();
    if (!s) return null;
    const a = this.anchor() ?? s;
    return {
      top: Math.min(a.row, s.row),
      bottom: Math.max(a.row, s.row),
      left: Math.min(a.col, s.col),
      right: Math.max(a.col, s.col),
    };
  });
  private readonly contextMenu = inject(ContextMenuStore);
  private readonly keys = inject(KeybindingsStore);
  private readonly api = inject(DB_API);
  protected readonly editing = signal<Editing | null>(null);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly injector = inject(Injector);

  protected readonly template = computed(
    () =>
      `${NUM_WIDTH}px ` +
      this.columns()
        .map((c) => `${c.width}px`)
        .join(' '),
  );
  protected readonly totalWidth = computed(
    () => NUM_WIDTH + this.columns().reduce((sum, c) => sum + c.width, 0),
  );

  private readonly first = computed(() =>
    Math.max(0, Math.floor(this.scrollTop() / ROW_HEIGHT) - OVERSCAN),
  );
  protected readonly offsetY = computed(() => this.first() * ROW_HEIGHT);

  protected readonly visible = computed(() => {
    const rows = this.rows();
    const first = this.first();
    const last = Math.min(
      rows.length,
      Math.ceil((this.scrollTop() + this.viewportHeight()) / ROW_HEIGHT) + OVERSCAN,
    );
    const marks = this.rowMarks();
    const edited = this.editedCells();
    const out: { index: number; mark: RowMark; cells: (CellView & { edited: boolean })[] }[] = [];
    for (let i = first; i < last; i++) {
      out.push({
        index: i,
        mark: marks[i] ?? null,
        cells: (rows[i] ?? []).map((cell, c) => ({
          ...viewOf(cell),
          edited: edited.has(`${i}:${c}`),
        })),
      });
    }
    return out;
  });

  constructor() {
    this.registerCommands();
    // A new page starts at the top with nothing selected. Without a page key, new rows do.
    effect(() => {
      const key = this.pageKey();
      if (key === undefined) this.rows();
      untracked(() => {
        this.editing.set(null);
        this.selected.set(null);
        this.anchor.set(null);
        this.selectionChange.emit(null);
        this.scrollTop.set(0);
        const el = this.scroller()?.nativeElement;
        if (el) el.scrollTop = 0;
      });
    });

    afterNextRender(() => {
      const el = this.scroller().nativeElement;
      this.viewportHeight.set(el.clientHeight);
      if (typeof ResizeObserver === 'undefined') return; // test environments without layout
      const observer = new ResizeObserver(() => this.viewportHeight.set(el.clientHeight));
      observer.observe(el);
      this.destroyRef.onDestroy(() => {
        observer.disconnect();
        cancelAnimationFrame(this.frame);
      });
    });
  }

  private frame = 0;

  protected onScroll(): void {
    // One update per animation frame keeps scrolling smooth.
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.scrollTop.set(this.scroller().nativeElement.scrollTop);
    });
  }

  protected select(row: number, col: number, event?: MouseEvent): void {
    // The right button keeps a block that already holds the cell (its menu copies the block).
    if (event?.button === 2 && this.inRange(row, col)) return;
    const editing = this.editing();
    if (editing && (editing.row !== row || editing.col !== col)) this.commit();
    this.setSelected(row, col, Boolean(event?.shiftKey) && event?.button !== 2);
    if (!this.editing()) this.scroller().nativeElement.focus({ preventScroll: true });
  }

  /** Selects a cell from outside (e.g. a freshly added row) and scrolls it into view. */
  focusCell(row: number, col: number): void {
    this.setSelected(row, col);
    // The row may only just have been added: wait for it to render.
    afterNextRender(
      () => {
        this.scrollIntoView(row, col);
        // Never steal focus from a cell editor the user already opened.
        if (!this.editing()) this.scroller().nativeElement.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  protected canEdit(row: number, col: number): boolean {
    if (!this.editable() || this.rowMarks()[row] === 'deleted') return false;
    const cell = this.rows()[row]?.[col];
    // Binary and cut-off values would be destroyed by editing their preview.
    return !(
      cell &&
      typeof cell === 'object' &&
      (cell.kind === 'binary' || cell.kind === 'truncated')
    );
  }

  /** Whether a whole new value may go in (insert value, paste, load file): also binary cells. */
  canReplace(row: number, col: number): boolean {
    return this.editable() && this.rowMarks()[row] !== 'deleted' && row < this.rows().length;
  }

  /** The selected block, or null. */
  selection(): GridSelection | null {
    const r = this.range();
    const s = this.selected();
    return r && s ? { ...r, row: s.row, col: s.col } : null;
  }

  /** Gives every replaceable cell in the selection this value; the number of cells changed. */
  fillSelection(value: CellValue): number {
    const r = this.range();
    if (!r) return 0;
    let n = 0;
    for (let row = r.top; row <= r.bottom; row++)
      for (let col = r.left; col <= r.right; col++)
        if (this.canReplace(row, col)) {
          this.cellEdited.emit({ row, col, value });
          n++;
        }
    return n;
  }

  /**
   * Pastes tab-separated text (from Excel or a copy here) at the active cell. One value fills the
   * whole selection; a block goes from the top left of the selection, as far as the grid reaches.
   */
  async paste(): Promise<void> {
    const r = this.range();
    if (!r || !this.editable()) return;
    const result = await this.api.readClipboard();
    if (!result.ok) return;
    const block = parseTsv(result.data);
    if (block.length === 0) return;
    let n = 0;
    if (block.length === 1 && block[0]!.length === 1) {
      n = this.fillSelection(block[0]![0]!);
    } else {
      block.forEach((values, i) =>
        values.forEach((value, j) => {
          const row = r.top + i;
          const col = r.left + j;
          if (col < this.columns().length && this.canReplace(row, col)) {
            this.cellEdited.emit({ row, col, value });
            n++;
          }
        }),
      );
    }
    this.copied.emit(`Geplakt in ${n} ${n === 1 ? 'cel' : 'cellen'}`);
  }

  protected startEdit(row: number, col: number, initial?: string): void {
    if (!this.canEdit(row, col)) return;
    const cell = this.rows()[row]?.[col] ?? null;
    const current = typeof cell === 'string' ? cell : '';
    this.setSelected(row, col);
    this.editing.set({ row, col, draft: initial ?? current });
    afterNextRender(
      () => {
        const input = this.editor()?.nativeElement;
        if (!input) return;
        input.focus();
        if (initial === undefined) input.select();
        else input.setSelectionRange(input.value.length, input.value.length);
      },
      { injector: this.injector },
    );
  }

  protected isEditing(row: number, col: number): boolean {
    const e = this.editing();
    return e !== null && e.row === row && e.col === col;
  }

  protected onDraft(value: string): void {
    const e = this.editing();
    if (e) this.editing.set({ ...e, draft: value });
  }

  /** Saves the draft into the pending changes (not yet to the database). */
  protected commit(value?: string | null): void {
    const e = this.editing();
    if (!e) return;
    this.editing.set(null);
    this.cellEdited.emit({ row: e.row, col: e.col, value: value === undefined ? e.draft : value });
  }

  protected cancelEdit(): void {
    this.editing.set(null);
    this.scroller().nativeElement.focus({ preventScroll: true });
  }

  protected onEditorKeydown(event: KeyboardEvent): void {
    const e = this.editing();
    if (!e) return;
    event.stopPropagation(); // the grid's own keys (arrows, Ctrl+C) don't apply while typing
    const next = (row: number, col: number) => {
      this.commit();
      this.setSelected(
        clamp(row, 0, this.rows().length - 1),
        clamp(col, 0, this.columns().length - 1),
      );
      this.scrollIntoView(this.selected()!.row, this.selected()!.col);
      this.scroller().nativeElement.focus({ preventScroll: true });
    };
    if (event.key === 'Enter') {
      event.preventDefault();
      next(e.row + (event.shiftKey ? -1 : 1), e.col);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      next(e.row, e.col + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }

  private setSelected(row: number, col: number, extend = false): void {
    const current = this.selected();
    if (!extend || !current) this.anchor.set({ row, col });
    else if (!this.anchor()) this.anchor.set(current);
    this.selected.set({ row, col });
    this.selectionChange.emit({ row, col });
  }

  protected inRange(row: number, col: number): boolean {
    const r = this.range();
    return !!r && row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;
  }

  private isSingle(): boolean {
    const r = this.range();
    return !r || (r.top === r.bottom && r.left === r.right);
  }

  /** Click on a row number: the whole row; with Shift, every row up to it. */
  protected selectRow(row: number, event: MouseEvent): void {
    if (event.button === 2 && this.inRange(row, 0) && this.inRange(row, this.columns().length - 1))
      return;
    const last = this.columns().length - 1;
    if (last < 0) return;
    if (this.editing()) this.commit();
    const a = this.anchor();
    if (event.shiftKey && a) this.anchor.set({ row: a.row, col: 0 });
    else this.anchor.set({ row, col: 0 });
    this.selected.set({ row, col: last });
    this.selectionChange.emit({ row, col: last });
    this.scroller().nativeElement.focus({ preventScroll: true });
  }

  /** Ctrl+A: every cell on this page. */
  protected selectAll(): void {
    const rows = this.rows().length;
    const cols = this.columns().length;
    if (!rows || !cols) return;
    this.anchor.set({ row: 0, col: 0 });
    this.selected.set({ row: rows - 1, col: cols - 1 });
    this.selectionChange.emit({ row: rows - 1, col: cols - 1 });
  }

  /** Right click or the menu key: copy the selected block, or export its rows (with all formats). */
  protected openMenu(event: MouseEvent | KeyboardEvent, row?: number, col?: number): void {
    if (this.editing()) return;
    if (row !== undefined && col !== undefined && !this.inRange(row, col))
      this.setSelected(row, col);
    const sel = this.selection();
    if (!sel) return;
    const cells = (sel.bottom - sel.top + 1) * (sel.right - sel.left + 1);
    const rows = sel.bottom - sel.top + 1;
    const extra = this.menuSections()?.(sel) ?? {};
    const formats = Object.keys(COPY_FORMAT_LABELS) as CopyFormat[];
    const active = this.rows()[sel.row]?.[sel.col] ?? null;
    const url =
      typeof active === 'string' && /^https?:\/\/\S+$/i.test(active.trim()) ? active.trim() : null;
    const key = (command: string) => this.keys.keyLabel(command);
    const items: MenuEntry[] = [
      {
        label: cells === 1 ? 'Waarde kopiëren' : 'Kopiëren',
        shortcut: key('data.copy'),
        run: () => this.copySelection(),
      },
      {
        label: 'Kopiëren als',
        items: [
          { label: 'Met kolomnamen', run: () => this.copyBlock('tsv', true) },
          ...formats.map((f) => ({
            label: COPY_FORMAT_LABELS[f],
            run: () => this.copyBlock(f, true),
          })),
        ],
      },
      ...(this.editable()
        ? [{ label: 'Plakken', shortcut: key('data.paste'), run: () => void this.paste() }]
        : []),
      ...(extra.values ?? []),
      ...(url ? [{ label: 'URL openen', run: () => void window.open(url, '_blank') }] : []),
      'separator',
      ...(extra.rows ?? []),
      'separator',
      ...(extra.view ?? []),
      { label: 'Zoeken…', shortcut: key('data.find'), run: () => this.openFind() },
      'separator',
      {
        label: rows === 1 ? 'Rij exporteren…' : `${rows} rijen exporteren…`,
        shortcut: key('data.exportRows'),
        run: () => this.emitExport(false),
      },
      ...(extra.tail ?? []),
      { label: 'Alles selecteren', shortcut: key('data.selectAll'), run: () => this.selectAll() },
    ];
    this.contextMenu.open(event, 'Acties voor de selectie', items);
  }

  // ── Find in the grid (Ctrl+F) ──────────────────────────────────────
  protected readonly findOpen = signal(false);
  protected readonly findText = signal('');
  private readonly findInput = viewChild<ElementRef<HTMLInputElement>>('findInput');
  /** Cells on this page that contain the search text, in reading order. */
  protected readonly findMatches = computed(() => {
    const q = this.findText().toLowerCase();
    if (!q) return [];
    const out: { row: number; col: number }[] = [];
    this.rows().forEach((r, row) =>
      r.forEach((cell, col) => {
        if (viewOf(cell).text.toLowerCase().includes(q)) out.push({ row, col });
      }),
    );
    return out;
  });
  protected readonly findIndex = signal(-1);

  openFind(): void {
    this.findOpen.set(true);
    afterNextRender(
      () => {
        this.findInput()?.nativeElement.focus();
        this.findInput()?.nativeElement.select();
      },
      { injector: this.injector },
    );
  }

  protected closeFind(): void {
    this.findOpen.set(false);
    this.scroller().nativeElement.focus({ preventScroll: true });
  }

  /** Next (or previous) cell with the text, after the active cell; wraps around. */
  protected findStep(back: boolean): void {
    const matches = this.findMatches();
    if (matches.length === 0) return;
    const s = this.selected() ?? { row: -1, col: -1 };
    const after = (m: { row: number; col: number }) =>
      m.row > s.row || (m.row === s.row && m.col > s.col);
    let i: number;
    if (back) {
      const before = matches.filter((m) => !after(m) && !(m.row === s.row && m.col === s.col));
      i = before.length ? matches.indexOf(before.at(-1)!) : matches.length - 1;
    } else {
      const next = matches.findIndex(after);
      i = next >= 0 ? next : 0;
    }
    const m = matches[i]!;
    this.findIndex.set(i);
    this.setSelected(m.row, m.col);
    this.scrollIntoView(m.row, m.col);
  }

  protected onFindKey(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.findStep(event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.closeFind();
    }
  }

  private emitExport(clipboard: boolean): void {
    const r = this.range();
    if (!r) return;
    const rows = Array.from({ length: r.bottom - r.top + 1 }, (_, i) => r.top + i);
    this.exportRows.emit({ rows, clipboard });
  }

  /** Copy, select all and export rows: only for the grid that has the focus. */
  private registerCommands(): void {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroy = inject(DestroyRef);
    const focused = () => host.contains(document.activeElement) && !this.editing();
    const on = (command: string, run: () => boolean | void) =>
      this.keys.handle(command, () => (focused() ? run() : false), destroy);
    on('data.copy', () => (this.selected() ? this.copySelection() : false));
    on('data.paste', () => (this.selected() && this.editable() ? void this.paste() : false));
    on('data.find', () => this.openFind());
    on('data.selectAll', () => this.selectAll());
    on('data.exportRows', () => (this.selected() ? this.emitExport(true) : false));
  }

  private copySelection(): void {
    const s = this.selected();
    if (!s) return;
    if (this.isSingle()) void this.copy(copyText(this.rows()[s.row]?.[s.col] ?? null));
    else this.copyBlock('tsv', false);
  }

  /** The selected block in a format, with a summary for the note under the grid. */
  private copyBlock(format: CopyFormat, header: boolean): void {
    const r = this.range();
    if (!r) return;
    const columns = this.columns()
      .slice(r.left, r.right + 1)
      .map((c) => ({ name: c.name, numeric: c.numeric }));
    const rows = this.rows()
      .slice(r.top, r.bottom + 1)
      .map((row) => row.slice(r.left, r.right + 1));
    const text = formatBlock({ columns, rows }, format, {
      header,
      dialect: this.dialect(),
      table: this.tableName(),
    });
    const n = rows.length;
    const incomplete = incompleteCount(rows);
    const what = `${n} ${n === 1 ? 'rij' : 'rijen'} × ${columns.length} ${columns.length === 1 ? 'kolom' : 'kolommen'}`;
    const warning = incomplete
      ? ` (let op: ${incomplete} ${incomplete === 1 ? 'waarde is' : 'waarden zijn'} ingekort; Rijen exporteren geeft alles)`
      : '';
    void this.copy(text, what + warning);
  }

  /** The active cell; the block around it is `inRange`. */
  protected isSelected(row: number, col: number): boolean {
    const s = this.selected();
    return s !== null && s.row === row && s.col === col;
  }

  protected ariaSort(col: GridColumn): string | null {
    return col.sort === 'asc' ? 'ascending' : col.sort === 'desc' ? 'descending' : null;
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Typing fast after selecting a cell: keys can arrive before the editor input has focus.
    const editing = this.editing();
    if (editing) {
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        this.editing.set({ ...editing, draft: editing.draft + event.key });
      } else if (['Enter', 'Tab', 'Escape'].includes(event.key)) {
        this.onEditorKeydown(event);
      }
      return;
    }
    const s = this.selected();
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      if (s) this.openMenu(event);
      return;
    }
    if (!s) return;
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      this.startEdit(s.row, s.col);
      return;
    }
    // Typing a character starts editing with it, like a spreadsheet.
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      this.canEdit(s.row, s.col)
    ) {
      event.preventDefault();
      this.startEdit(s.row, s.col, event.key);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-20, 0],
      PageDown: [20, 0],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const row = clamp(s.row + move[0], 0, this.rows().length - 1);
    const col = clamp(s.col + move[1], 0, this.columns().length - 1);
    this.setSelected(row, col, event.shiftKey);
    this.scrollIntoView(row, col);
  }

  private scrollIntoView(row: number, col: number): void {
    const el = this.scroller().nativeElement;
    const headerHeight = 44;
    const top = row * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight - headerHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight + headerHeight;

    const left =
      NUM_WIDTH +
      this.columns()
        .slice(0, col)
        .reduce((sum, c) => sum + c.width, 0);
    const width = this.columns()[col]?.width ?? 0;
    if (left - NUM_WIDTH < el.scrollLeft) el.scrollLeft = left - NUM_WIDTH;
    else if (left + width > el.scrollLeft + el.clientWidth)
      el.scrollLeft = left + width - el.clientWidth;
  }

  /** Copies and reports what was copied: the value itself, or a summary for a block. */
  private async copy(text: string, summary?: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for when the async clipboard API is unavailable.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      this.scroller().nativeElement.focus({ preventScroll: true });
    }
    this.copied.emit(
      `Gekopieerd: ${summary ?? (text.length > 40 ? text.slice(0, 40) + '…' : text)}`,
    );
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function viewOf(cell: GridCell): CellView {
  if (cell === null) return { text: 'NULL', cls: 'is-null', title: null };
  if (typeof cell === 'object' && cell.kind === 'default') {
    return { text: 'DEFAULT', cls: 'is-default', title: 'Krijgt de standaardwaarde van de kolom' };
  }
  if (typeof cell === 'object' && cell.kind === 'sql') {
    return {
      text: cell.label ?? cell.sql,
      cls: 'is-sql',
      title: `Wordt bij opslaan: ${cell.sql.slice(0, 200)}`,
    };
  }
  if (typeof cell === 'string') {
    if (cell === '') return { text: "''", cls: 'is-empty', title: 'Lege tekst' };
    return { text: cell, cls: '', title: cell.length > 30 ? cell.slice(0, 500) : null };
  }
  if (cell.kind === 'binary') {
    const more = cell.bytes * 2 > cell.hex.length ? '…' : '';
    return {
      text: `0x${cell.hex.toUpperCase()}${more}`,
      cls: 'is-binary',
      title: `Binair, ${cell.bytes} ${cell.bytes === 1 ? 'byte' : 'bytes'}`,
    };
  }
  return {
    text: cell.text,
    cls: 'is-truncated',
    title: `Lange tekst: ${cell.length.toLocaleString('nl-NL')} tekens, eerste ${cell.text.length.toLocaleString('nl-NL')} getoond`,
  };
}

/** What Ctrl+C puts on the clipboard for one cell. */
export function copyText(cell: GridCell): string {
  if (cell === null) return 'NULL';
  if (typeof cell === 'string') return cell;
  if (cell.kind === 'default') return '';
  if (cell.kind === 'sql') return cell.sql;
  if (cell.kind === 'binary') return `0x${cell.hex.toUpperCase()}`;
  return cell.text;
}

/**
 * Tab-separated text as rows of values, the way Excel puts it on the clipboard: quoted fields may
 * hold tabs, line breaks and doubled quotes; a final line break is not an extra row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/\r\n?/g, '\n');
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') quoted = false;
      else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === '\t') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
