import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { looksLikeJson } from './json-text';
import { nowFor, type TypeCategory } from './column-types';
import { viewOf } from './cell-view';
import type { GridCell, GridColumn, RowMark } from './data-grid';

/** One field of the row, as the panel shows it. */
interface Field {
  col: number;
  column: GridColumn;
  cell: GridCell;
  /** Text to edit; '' for NULL, DEFAULT or SQL (shown as placeholder). */
  text: string;
  placeholder: string;
  cls: string;
  editable: boolean;
  /** A text area: several lines, long or JSON. */
  multiline: boolean;
  edited: boolean;
  link: string | null;
  category: TypeCategory;
}

/**
 * The selected row as a form, one column under the other: easier to read than a wide grid, and
 * with room for long text and JSON. Editing follows the grid's rules: the same cells can be
 * edited, a change goes into the pending changes (saved with Opslaan), JSON and long values open
 * in the cell editor. The grid owns the row; this panel follows its selection.
 */
@Component({
  selector: 'app-row-detail',
  templateUrl: './row-detail.html',
})
export class RowDetail {
  readonly columns = input.required<GridColumn[]>();
  readonly row = input.required<GridCell[] | null>();
  /** Index of the row on this page, or null when nothing is selected. */
  readonly index = input.required<number | null>();
  readonly count = input.required<number>();
  /** Rows before this page, for the row number shown. */
  readonly rowOffset = input(0);
  readonly mark = input<RowMark>(null);
  readonly editedCols = input<ReadonlySet<number>>(new Set());
  readonly categories = input<TypeCategory[]>([]);
  readonly canEdit = input<(col: number) => boolean>(() => false);
  readonly links = input<Record<number, string>>({});
  /** The column of the active cell: its field is marked. */
  readonly activeCol = input<number | null>(null);

  readonly edited = output<{ col: number; value: string | null; draft?: boolean }>();
  /** A field with typed changes was left (or Enter): the change is finished. */
  readonly committed = output<void>();
  readonly openEditor = output<number>();
  readonly follow = output<number>();
  readonly move = output<1 | -1>();
  readonly closed = output<void>();

  protected readonly filter = signal('');
  /**
   * Columns shown as a text area for this row. Decided when the row is chosen, so a field does not
   * turn from a line into an area (and lose the cursor) while you type.
   */
  private readonly multilineCols = signal<ReadonlySet<number>>(new Set());
  /** The value a field had when it got the focus: Esc goes back to it. */
  private readonly before = new Map<number, GridCell>();

  protected readonly fields = computed<Field[]>(() => {
    const row = this.row();
    if (!row) return [];
    const words = this.filter().toLowerCase().split(/\s+/).filter(Boolean);
    const canEdit = this.canEdit();
    const edited = this.editedCols();
    const categories = this.categories();
    const links = this.links();
    const multiline = this.multilineCols();
    const out: Field[] = [];
    this.columns().forEach((column, col) => {
      const name = column.name.toLowerCase();
      if (words.length && !words.every((w) => name.includes(w))) return;
      const cell = row[col] ?? null;
      const view = viewOf(cell);
      const isText = typeof cell === 'string';
      const category = categories[col] ?? 'other';
      out.push({
        col,
        column,
        cell,
        text: isText ? cell : '',
        placeholder: isText ? '' : view.text,
        cls: view.cls === '' ? `t-${category}` : view.cls,
        editable: canEdit(col),
        multiline: multiline.has(col),
        edited: edited.has(col),
        link: links[col] ?? null,
        category,
      });
    });
    return out;
  });

  protected readonly number = computed(() => {
    const i = this.index();
    return i === null ? null : this.rowOffset() + i + 1;
  });

  constructor() {
    effect(() => {
      this.index();
      this.columns();
      untracked(() => {
        const row = this.row() ?? [];
        const categories = this.categories();
        const cols = new Set<number>();
        row.forEach((cell, col) => {
          const text = typeof cell === 'string' ? cell : '';
          if (
            categories[col] === 'json' ||
            text.includes('\n') ||
            text.length > 80 ||
            looksLikeJson(text)
          )
            cols.add(col);
        });
        this.multilineCols.set(cols);
        this.before.clear();
        this.typed.clear();
      });
    });
  }

  protected onFocus(f: Field): void {
    this.before.set(f.col, f.cell);
  }

  /** Every keystroke goes into the pending changes, as in the grid after Enter. */
  protected onInput(f: Field, value: string): void {
    if (!this.before.has(f.col)) this.before.set(f.col, f.cell);
    this.typed.add(f.col);
    this.edited.emit({ col: f.col, value, draft: true });
  }

  /** Fields typed in since they got the focus. */
  private readonly typed = new Set<number>();

  /** Leaving a field you typed in finishes the change. */
  protected onBlur(f: Field): void {
    if (!this.typed.delete(f.col)) return;
    this.before.delete(f.col);
    this.committed.emit();
  }

  protected setNull(f: Field): void {
    if (f.cell !== null) this.edited.emit({ col: f.col, value: null });
  }

  /** Date and time columns that are NULL: the current time, as a double-click in the grid. */
  protected nowValue(f: Field): string | null {
    return f.cell === null && f.editable ? nowFor(f.category) : null;
  }

  protected setNow(f: Field): void {
    const now = this.nowValue(f);
    if (now !== null) this.edited.emit({ col: f.col, value: now });
  }

  /**
   * Esc puts back what the field held when it got the focus. Enter in a one-line field finishes
   * the change, as in the grid.
   */
  protected onKey(f: Field, event: KeyboardEvent): void {
    if (event.key === 'Enter' && !f.multiline && this.typed.has(f.col)) {
      event.preventDefault();
      this.typed.delete(f.col);
      this.before.delete(f.col);
      this.committed.emit();
      return;
    }
    if (event.key !== 'Escape' || !this.before.has(f.col)) return;
    const before = this.before.get(f.col) ?? null;
    if (before === f.cell) return;
    event.preventDefault();
    event.stopPropagation();
    // Only text and NULL can be typed over; DEFAULT and SQL values are left alone.
    if (before === null || typeof before === 'string') {
      this.edited.emit({ col: f.col, value: before, draft: true });
    }
  }

  protected rows(f: Field): number {
    // Lines, plus the ones a long line wraps into at about 45 characters.
    const lines = f.text.split('\n').reduce((n, l) => n + 1 + Math.floor(l.length / 45), 0);
    return Math.min(12, Math.max(3, lines));
  }
}
