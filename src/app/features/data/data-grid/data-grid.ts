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
import { CellEditor, looksLikeJson, type CellEditorRequest } from './cell-editor';
import { nowFor, typeCategory } from './column-types';

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
/** Height of the sticky column header, for scrolling while dragging past the top. */
const HEADER_HEIGHT = 44;
const NUM_WIDTH = 64;
/** Some non-NULL values in the first rows, and all of them JSON objects or arrays. */
function holdsJson(rows: GridCell[][], col: number): boolean {
  let seen = 0;
  for (const row of rows.slice(0, 50)) {
    const cell = row[col];
    if (cell === null || cell === undefined) continue;
    const text = typeof cell === 'string' ? cell : cell.kind === 'truncated' ? null : undefined;
    if (text === undefined) return false;
    if (text === null) continue; // cut off: cannot tell
    if (!looksLikeJson(text)) return false;
    seen++;
  }
  return seen > 0;
}

const MIN_COL_WIDTH = 40;
const MAX_COL_WIDTH = 2000;
/** Padding left and right of a value, plus the border: what a fitted column adds to the text. */
const CELL_PADDING = 22;
const WIDTHS_KEY = 'dbv.columnWidths';
/** Tables whose widths are remembered; the least recently changed are forgotten first. */
const WIDTHS_MAX_TABLES = 300;

function loadWidths(): Record<string, Record<string, number>> {
  try {
    const raw = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, Record<string, number>>) : {};
  } catch {
    return {};
  }
}

function storeWidths(key: string, widths: Record<string, number>): void {
  try {
    const { [key]: _, ...rest } = loadWidths();
    const all = Object.keys(widths).length ? { ...rest, [key]: widths } : rest;
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - WIDTHS_MAX_TABLES))) delete all[old];
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(all));
  } catch {
    // Not remembered: the widths stay until the grid closes.
  }
}

/** Measures text in the grid's fonts (cells, column name, column type) with a canvas. */
function textMeasurer(
  grid: HTMLElement,
): (text: string, kind: 'cell' | 'header' | 'type') => number {
  const context = document.createElement('canvas').getContext('2d');
  const fontOf = (selector: string, fallback: string) => {
    const el = grid.querySelector(selector);
    return el ? getComputedStyle(el).font : fallback;
  };
  const fonts = {
    cell: fontOf('.dg-cell', '12.5px monospace'),
    header: fontOf('.dg-th-name .tl', '600 13px sans-serif'),
    type: fontOf('.dg-th-type', '11px monospace'),
  };
  return (text, kind) => {
    if (!context) return text.length * 8;
    context.font = fonts[kind];
    return context.measureText(text).width;
  };
}

/** Rows rendered above and below the visible area, so fast scrolling doesn't show gaps. */
const OVERSCAN = 12;

/**
 * Spreadsheet-like grid for one page of rows. Only the rows in view (plus a margin) are in the DOM,
 * so 1000 rows scroll as smoothly as 10. Header and row numbers stay in place while scrolling.
 */
@Component({
  selector: 'app-data-grid',
  templateUrl: './data-grid.html',
  imports: [CellEditor],
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
  /**
   * Where column widths set by the user are remembered (e.g. the table); without one they last
   * as long as the grid.
   */
  readonly widthKey = input<string | null>(null);
  /**
   * Loads the whole value of a cut-off cell for the cell editor (table data, by key). Without it
   * a cut-off value is shown in the editor, not edited.
   */
  readonly loadFullValue = input<((row: number, col: number) => Promise<string | null>) | null>(
    null,
  );

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
  protected readonly keys = inject(KeybindingsStore);
  private readonly api = inject(DB_API);
  protected readonly editing = signal<Editing | null>(null);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly injector = inject(Injector);

  /** Widths the user dragged or fitted, by column name, over the starting widths. */
  private readonly customWidths = signal<Record<string, number>>({});
  protected readonly widths = computed(() => {
    const custom = this.customWidths();
    return this.columns().map((c) => custom[c.name] ?? c.width);
  });
  protected readonly template = computed(
    () =>
      `${NUM_WIDTH}px ` +
      this.widths()
        .map((w) => `${w}px`)
        .join(' '),
  );
  protected readonly totalWidth = computed(
    () => NUM_WIDTH + this.widths().reduce((sum, w) => sum + w, 0),
  );

  /** Per column what kind of value it holds: colours the values, fills in the current time. */
  protected readonly categories = computed(() => {
    const rows = this.rows();
    return this.columns().map((c, i) => {
      const category = typeCategory(c.type);
      // MariaDB reports a JSON column as LONGTEXT (with a JSON_VALID check): a text column whose
      // values on this page are all JSON objects or arrays is shown as JSON.
      return category === 'text' && /text|clob/i.test(c.type) && holdsJson(rows, i)
        ? 'json'
        : category;
    });
  });
  /** Columns declared JSON: only valid JSON can be applied to them. */
  private readonly declaredJson = computed(() =>
    this.columns().map((c) => typeCategory(c.type) === 'json'),
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
    const categories = this.categories();
    const out: { index: number; mark: RowMark; cells: (CellView & { edited: boolean })[] }[] = [];
    for (let i = first; i < last; i++) {
      out.push({
        index: i,
        mark: marks[i] ?? null,
        cells: (rows[i] ?? []).map((cell, c) => {
          const view = viewOf(cell);
          // A plain value gets the colour of its type; NULL, '' and binary keep their own look.
          const cls = view.cls === '' ? `t-${categories[c] ?? 'other'}` : view.cls;
          return { ...view, cls, edited: edited.has(`${i}:${c}`) };
        }),
      });
    }
    return out;
  });

  constructor() {
    this.registerCommands();
    // The remembered widths of this table.
    effect(() => {
      const key = this.widthKey();
      untracked(() => this.customWidths.set(key ? (loadWidths()[key] ?? {}) : {}));
    });
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
    if (event?.button === 0 && !this.editing()) this.startDrag('cells', event);
  }

  /** Rows of the selected block: shown like a hovered row, so the row is clearly selected. */
  protected rowActive(row: number): boolean {
    const r = this.range();
    return !!r && row >= r.top && row <= r.bottom;
  }

  // ── Drag to select (like Explorer): cells from a cell, whole rows from a row number ──
  private drag: { mode: 'cells' | 'rows'; stop: () => void } | null = null;

  private startDrag(mode: 'cells' | 'rows', event: MouseEvent): void {
    this.drag?.stop();
    const scroller = this.scroller().nativeElement;
    let lastY = event.clientY;
    let lastX = event.clientX;
    let timer: ReturnType<typeof setInterval> | null = null;
    const extendTo = () => {
      const target = this.cellAt(lastX, lastY);
      if (!target) return;
      const s = this.selected();
      if (mode === 'rows') {
        const last = this.columns().length - 1;
        if (s && s.row === target.row && s.col === last) return;
        this.selected.set({ row: target.row, col: last });
        this.selectionChange.emit({ row: target.row, col: last });
      } else if (!s || s.row !== target.row || s.col !== target.col) {
        this.setSelected(target.row, target.col, true);
      }
    };
    // Past the top or bottom edge: keep scrolling, faster the further out.
    const autoScroll = () => {
      const box = scroller.getBoundingClientRect();
      const top = box.top + HEADER_HEIGHT;
      const dy = lastY < top ? lastY - top : lastY > box.bottom ? lastY - box.bottom : 0;
      const dx = lastX < box.left ? lastX - box.left : lastX > box.right ? lastX - box.right : 0;
      if (dy === 0 && dx === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
      }
      timer ??= setInterval(() => {
        scroller.scrollTop += clamp(dy, -40, 40);
        scroller.scrollLeft += clamp(dx, -40, 40);
        this.onScroll();
        extendTo();
        autoScroll();
      }, 30);
    };
    const move = (e: MouseEvent) => {
      if ((e.buttons & 1) === 0) return stop();
      lastX = e.clientX;
      lastY = e.clientY;
      extendTo();
      autoScroll();
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      if (timer) clearInterval(timer);
      document.body.classList.remove('grid-dragging');
      this.drag = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    document.body.classList.add('grid-dragging');
    this.drag = { mode, stop };
  }

  /** The cell under a point of the window (clamped to the grid), for dragging. */
  private cellAt(x: number, y: number): { row: number; col: number } | null {
    const rows = this.rows().length;
    const widths = this.widths();
    if (!rows || !widths.length) return null;
    const body = this.scroller().nativeElement.querySelector('.dg-body');
    if (!body) return null;
    const box = body.getBoundingClientRect();
    const row = clamp(Math.floor((y - box.top) / ROW_HEIGHT), 0, rows - 1);
    let left = box.left + NUM_WIDTH;
    let col = 0;
    for (; col < widths.length - 1; col++) {
      if (x < left + widths[col]!) break;
      left += widths[col]!;
    }
    return { row, col };
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

  // ── Column widths (like Excel: drag the border, double-click to fit) ──
  protected widthOf(col: number): number {
    return this.widths()[col] ?? MIN_COL_WIDTH;
  }

  protected startResize(event: PointerEvent, col: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const name = this.columns()[col]?.name;
    if (name === undefined) return;
    const handle = event.target as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const start = this.widthOf(col);
    document.body.classList.add('col-resizing');
    const move = (e: PointerEvent) => this.setWidth(name, start + e.clientX - startX, false);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('col-resizing');
      this.saveWidths();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** Double-click on a border: as wide as the longest value on this page (or the header). */
  autofit(col: number): void {
    const column = this.columns()[col];
    if (!column) return;
    const measure = textMeasurer(this.scroller().nativeElement);
    // Header: name (bold, with key icon and sort arrow) and the type below it.
    let widest = Math.max(
      measure(column.name, 'header') + (column.primary ? 16 : 0) + (column.sort ? 14 : 0),
      measure(column.type, 'type'),
    );
    for (const row of this.rows()) {
      const text = viewOf(row[col] ?? null).text;
      widest = Math.max(widest, measure(text.length > 300 ? text.slice(0, 300) : text, 'cell'));
    }
    this.setWidth(column.name, Math.ceil(widest) + CELL_PADDING, true);
  }

  /** Back to the starting widths (menu). */
  resetWidths(): void {
    this.customWidths.set({});
    this.saveWidths();
  }

  private setWidth(name: string, width: number, save: boolean): void {
    const w = clamp(Math.round(width), MIN_COL_WIDTH, MAX_COL_WIDTH);
    this.customWidths.update((all) => ({ ...all, [name]: w }));
    if (save) this.saveWidths();
  }

  private saveWidths(): void {
    const key = this.widthKey();
    if (key) storeWidths(key, this.customWidths());
  }

  /**
   * Double-click: edit. On an empty (NULL) date or time it starts with the current time, as in
   * HeidiSQL: Enter or clicking away keeps it, Esc leaves the cell NULL. JSON and long or
   * multi-line text open in the cell editor.
   */
  protected onCellDblclick(row: number, col: number): void {
    const cell = this.rows()[row]?.[col];
    const now = cell === null ? nowFor(this.categories()[col] ?? 'other') : null;
    if (now !== null) this.startEdit(row, col, now, true);
    else if (this.wantsPopup(row, col)) void this.openPopup(row, col);
    else this.startEdit(row, col);
  }

  /** Values that do not fit a one-line editor: JSON, several lines, long or cut-off text. */
  private wantsPopup(row: number, col: number): boolean {
    const cell = this.rows()[row]?.[col] ?? null;
    if (cell !== null && typeof cell === 'object' && cell.kind === 'truncated') return true;
    if (typeof cell !== 'string') return this.categories()[col] === 'json' && cell === null;
    return (
      this.categories()[col] === 'json' ||
      cell.includes('\n') ||
      cell.length > 120 ||
      looksLikeJson(cell)
    );
  }

  // ── Cell editor (popup) ────────────────────────────────────────────
  protected readonly popup = signal<{
    row: number;
    col: number;
    request: CellEditorRequest;
  } | null>(null);

  /** Opens the cell editor for a cell; with `draft`, starting from what was typed inline. */
  async openPopup(row: number, col: number, draft?: string): Promise<void> {
    const column = this.columns()[col];
    const cell = this.rows()[row]?.[col] ?? null;
    if (!column) return;
    if (cell !== null && typeof cell === 'object' && cell.kind === 'binary') {
      this.copied.emit(
        'Binaire waarden kun je niet als tekst bewerken; gebruik Waarde opslaan als bestand.',
      );
      return;
    }
    this.setSelected(row, col);
    let value: string | null;
    let partOf: number | undefined;
    let editable = this.editable() && this.rowMarks()[row] !== 'deleted';
    if (draft !== undefined) value = draft;
    else if (cell === null) value = null;
    else if (typeof cell === 'string') value = cell;
    else if (cell.kind === 'default') value = '';
    else if (cell.kind === 'sql') value = cell.sql;
    else if (cell.kind === 'truncated') {
      const load = this.loadFullValue();
      const full = load ? await load(row, col).catch(() => undefined) : undefined;
      if (full !== undefined) value = full;
      else {
        value = cell.text;
        partOf = cell.length;
        editable = false;
      }
    } else value = null;
    this.popup.set({
      row,
      col,
      request: {
        column: column.name,
        type: column.type,
        value,
        jsonColumn: this.declaredJson()[col] ?? false,
        readOnly: !editable,
        ...(partOf !== undefined && { partOf }),
      },
    });
  }

  /** From the inline editor's "…" button: on in the cell editor with what was typed. */
  protected expandEditor(): void {
    const e = this.editing();
    if (!e) return;
    this.editing.set(null);
    void this.openPopup(e.row, e.col, e.draft);
  }

  protected onPopupSaved(value: string | null): void {
    const p = this.popup();
    if (p) this.cellEdited.emit({ row: p.row, col: p.col, value });
  }

  protected onPopupClosed(): void {
    this.popup.set(null);
    this.scroller().nativeElement.focus({ preventScroll: true });
  }

  protected startEdit(row: number, col: number, initial?: string, selectAll = false): void {
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
        if (initial === undefined || selectAll) input.select();
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
    if (event.button === 0) this.startDrag('rows', event);
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
      ...(cells === 1
        ? [
            {
              label:
                this.editable() && this.rowMarks()[sel.row] !== 'deleted'
                  ? 'Bewerken in venster…'
                  : 'Bekijken in venster…',
              shortcut: key('data.editPopup'),
              run: () => void this.openPopup(sel.row, sel.col),
            },
          ]
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
      ...(Object.keys(this.customWidths()).length
        ? [{ label: 'Kolombreedtes herstellen', run: () => this.resetWidths() }]
        : []),
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
    on('data.editPopup', () => {
      const s = this.selected();
      if (!s) return false;
      void this.openPopup(s.row, s.col);
      return true;
    });
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
