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
import type { Cell, SortDirection } from '../../../../../shared/models';

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
export type GridCell = Cell | typeof DEFAULT_CELL;

export type RowMark = 'new' | 'deleted' | null;

export interface CellEdit {
  row: number;
  col: number;
  /** New value; null is SQL NULL. */
  value: string | null;
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
  readonly copied = output<string>();
  readonly cellEdited = output<CellEdit>();
  readonly selectionChange = output<{ row: number; col: number } | null>();

  protected readonly rowHeight = ROW_HEIGHT;
  private readonly destroyRef = inject(DestroyRef);
  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(0);
  protected readonly selected = signal<{ row: number; col: number } | null>(null);
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
    // A new page starts at the top with nothing selected. Without a page key, new rows do.
    effect(() => {
      const key = this.pageKey();
      if (key === undefined) this.rows();
      untracked(() => {
        this.editing.set(null);
        this.selected.set(null);
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

  protected select(row: number, col: number): void {
    const editing = this.editing();
    if (editing && (editing.row !== row || editing.col !== col)) this.commit();
    this.setSelected(row, col);
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

  private setSelected(row: number, col: number): void {
    this.selected.set({ row, col });
    this.selectionChange.emit({ row, col });
  }

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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      if (s) {
        void this.copy(copyText(this.rows()[s.row]?.[s.col] ?? null));
        event.preventDefault();
      }
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
    this.setSelected(row, col);
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

  private async copy(text: string): Promise<void> {
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
    this.copied.emit(text);
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
  if (cell.kind === 'binary') return `0x${cell.hex.toUpperCase()}`;
  return cell.text;
}
