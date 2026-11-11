import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type {
  ColumnInfo,
  DbError,
  RowsPage,
  SortDirection,
  SortKey,
} from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import type { Load, SelectedObject } from '../../schema/schema.store';
import { DataGrid, type GridColumn } from '../data-grid/data-grid';

export const PAGE_SIZES = [100, 200, 500, 1000] as const;
const PAGE_SIZE_KEY = 'dbv.pageSize';

type CountState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; value: number }
  | { status: 'error'; error: DbError };

/** The Data tab: filter, sort and page through the rows of one table or view. */
@Component({
  selector: 'app-table-data',
  imports: [DataGrid],
  templateUrl: './table-data.html',
})
export class TableData {
  readonly object = input.required<SelectedObject>();
  /** Column metadata from the schema cache: types for the header, primary key for default order. */
  readonly columns = input<Load<ColumnInfo[]> | undefined>(undefined);
  /** Row estimate from table statistics, shown until an exact count is asked for. */
  readonly estimate = input<number | null>(null);

  private readonly api = inject(DB_API);

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

  async load(): Promise<void> {
    const o = this.object();
    const id = ++this.requestId;
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
      this.error.set(null);
    } else {
      this.page.set(null);
      this.error.set(result.error);
    }
  }

  protected applyFilter(event?: Event): void {
    event?.preventDefault();
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
    const current = this.sort();
    const next: SortDirection | null =
      current?.column !== column ? 'asc' : current.direction === 'asc' ? 'desc' : null;
    this.sort.set(next ? { column, direction: next } : null);
    this.offset.set(0);
    void this.load();
  }

  protected goTo(offset: number): void {
    this.offset.set(Math.max(0, offset));
    void this.load();
  }

  protected setPageSize(value: string): void {
    const size = Number(value);
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
    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
    this.note.set(`Gekopieerd: ${preview}`);
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.note.set(null), 2500);
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
