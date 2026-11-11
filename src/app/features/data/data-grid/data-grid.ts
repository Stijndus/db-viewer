import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
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
  readonly rows = input.required<Cell[][]>();
  /** Absolute number of the first row on this page, for the row-number column. */
  readonly rowOffset = input(0);
  readonly sortRequested = output<string>();
  readonly copied = output<string>();

  protected readonly rowHeight = ROW_HEIGHT;
  private readonly destroyRef = inject(DestroyRef);
  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(0);
  protected readonly selected = signal<{ row: number; col: number } | null>(null);

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
    const out: { index: number; cells: CellView[] }[] = [];
    for (let i = first; i < last; i++) {
      out.push({ index: i, cells: (rows[i] ?? []).map(viewOf) });
    }
    return out;
  });

  constructor() {
    // A new page starts at the top with nothing selected.
    effect(() => {
      this.rows();
      untracked(() => {
        this.selected.set(null);
        this.scrollTop.set(0);
        const el = this.scroller()?.nativeElement;
        if (el) el.scrollTop = 0;
      });
    });

    afterNextRender(() => {
      const el = this.scroller().nativeElement;
      this.viewportHeight.set(el.clientHeight);
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
    this.selected.set({ row, col });
    this.scroller().nativeElement.focus({ preventScroll: true });
  }

  protected isSelected(row: number, col: number): boolean {
    const s = this.selected();
    return s !== null && s.row === row && s.col === col;
  }

  protected ariaSort(col: GridColumn): string | null {
    return col.sort === 'asc' ? 'ascending' : col.sort === 'desc' ? 'descending' : null;
  }

  protected onKeydown(event: KeyboardEvent): void {
    const s = this.selected();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      if (s) {
        void this.copy(copyText(this.rows()[s.row]?.[s.col] ?? null));
        event.preventDefault();
      }
      return;
    }
    if (!s) return;
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
    this.selected.set({ row, col });
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

export function viewOf(cell: Cell): CellView {
  if (cell === null) return { text: 'NULL', cls: 'is-null', title: null };
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
export function copyText(cell: Cell): string {
  if (cell === null) return 'NULL';
  if (typeof cell === 'string') return cell;
  if (cell.kind === 'binary') return `0x${cell.hex.toUpperCase()}`;
  return cell.text;
}
