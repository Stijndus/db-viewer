import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { ObjectKind, SchemaObject } from '../../../../shared/models';
import { SchemaStore } from './schema.store';

export interface QuickItem {
  database: string;
  object: SchemaObject;
}

const KIND_LABEL: Record<ObjectKind, string> = {
  table: 'tabel',
  view: 'view',
  procedure: 'procedure',
  function: 'functie',
};

/** Databases loaded at the same time when the search opens. */
const PARALLEL = 6;
const MAX_RESULTS = 100;
const RECENT_KEY = 'dbv.quickOpen.recent';

/**
 * How well a name matches what was typed: higher is better, null for no match. Exact beats a
 * prefix, a prefix beats a word start, that beats anywhere, and that beats the letters in order
 * ("ordit" finds order_items), like VS Code's Ctrl+P.
 */
export function matchScore(name: string, query: string): number | null {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - n.length;
  const at = n.indexOf(q);
  if (at >= 0) {
    const wordStart = at > 0 && /[_\-. ]/.test(n[at - 1]!);
    return (wordStart ? 600 : 400) - at - n.length / 100;
  }
  let from = 0;
  for (const ch of q) {
    const i = n.indexOf(ch, from);
    if (i < 0) return null;
    from = i + 1;
  }
  return 100 - n.length / 10;
}

/**
 * Finds objects over all databases. "shop.ord" searches "ord" in databases that match "shop".
 */
export function quickMatches(
  items: QuickItem[],
  query: string,
  recent: string[] = [],
): QuickItem[] {
  const q = query.trim();
  if (!q) {
    const rank = (i: QuickItem) => {
      const r = recent.indexOf(`${i.database}.${i.object.name}`);
      return r < 0 ? Number.MAX_SAFE_INTEGER : r;
    };
    return [...items]
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          a.database.localeCompare(b.database) ||
          a.object.name.localeCompare(b.object.name),
      )
      .slice(0, MAX_RESULTS);
  }
  const { dbPart, namePart } = splitQuery(q);
  const scored: { item: QuickItem; score: number }[] = [];
  for (const item of items) {
    if (dbPart && matchScore(item.database, dbPart) === null) continue;
    const score = matchScore(item.object.name, namePart);
    if (score === null) continue;
    // Tables before views before routines when equally good.
    const kindBonus = item.object.kind === 'table' ? 0.3 : item.object.kind === 'view' ? 0.2 : 0;
    scored.push({ item, score: score + kindBonus });
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.object.name.localeCompare(b.item.object.name) ||
        a.item.database.localeCompare(b.item.database),
    )
    .slice(0, MAX_RESULTS)
    .map((s) => s.item);
}

/** "db.table", or the tags "db:…" and "tb:…" as in the tree filter; text alone is the name. */
export function splitQuery(query: string): { dbPart: string; namePart: string } {
  const q = query.trim();
  const db = /(?:^|\s)db:(\S*)/i.exec(q);
  const tb = /(?:^|\s)(?:tb|tabel|table):(\S*)/i.exec(q);
  if (db || tb) {
    const rest = q
      .replace(/(?:^|\s)db:\S*/i, ' ')
      .replace(/(?:^|\s)(?:tb|tabel|table):\S*/i, ' ')
      .trim();
    return { dbPart: db ? db[1]! : rest, namePart: tb ? tb[1]! : rest };
  }
  const dot = q.lastIndexOf('.');
  return dot > 0
    ? { dbPart: q.slice(0, dot), namePart: q.slice(dot + 1) }
    : { dbPart: '', namePart: q };
}

/** Ctrl+P: open any table, view or routine of the connection, over all its databases. */
@Component({
  selector: 'app-quick-open',
  template: `
    @if (schema.quickOpenFor(); as conn) {
      <dialog
        #dialog
        class="dialog cp-dialog qo-dialog"
        aria-label="Snel openen"
        (cancel)="$event.preventDefault(); close()"
        (click)="$event.target === dialog && close()"
      >
        <input
          #input
          class="input cp-input"
          type="text"
          role="combobox"
          aria-label="Tabel, view of routine zoeken"
          aria-controls="qo-list"
          [attr.aria-activedescendant]="'qo-' + active()"
          placeholder="Typ een tabelnaam, of database.tabel…"
          autocomplete="off"
          spellcheck="false"
          [value]="query()"
          (input)="query.set(input.value); active.set(0)"
          (keydown)="onKey($event)"
        />
        <ul id="qo-list" class="cp-list" role="listbox" aria-label="Gevonden">
          @for (m of matches(); track m.database + '.' + m.object.name; let i = $index) {
            <li
              [id]="'qo-' + i"
              role="option"
              class="cp-item"
              [class.active]="i === active()"
              [attr.aria-selected]="i === active()"
              (mousemove)="active.set(i)"
              (click)="open(m)"
            >
              <span class="qo-name"
                ><span class="mono">{{ m.object.name }}</span>
                <span class="muted small">{{ m.database }}</span></span
              >
              <span class="muted small">{{ kindLabel[m.object.kind] }}</span>
            </li>
          } @empty {
            <li class="cp-item muted">
              {{ loading() ? 'Zoeken…' : 'Niets gevonden' }}
            </li>
          }
        </ul>
        <div class="qo-foot muted small" aria-live="polite">
          @if (loading()) {
            Databases laden: {{ loaded() }} van {{ total() }}
          } @else {
            {{ items().length }} objecten in {{ total() }}
            {{ total() === 1 ? 'database' : 'databases' }} · Enter opent
          }
        </div>
      </dialog>
    }
  `,
})
export class QuickOpen {
  protected readonly schema = inject(SchemaStore);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly kindLabel = KIND_LABEL;

  /** The databases searched: all but system databases (unless those are shown). */
  private readonly databases = computed(() => {
    const conn = this.schema.quickOpenFor();
    const dbs = conn ? this.schema.databases(conn) : undefined;
    if (dbs?.status !== 'loaded') return [];
    return dbs.data.filter((d) => !d.system || this.schema.showSystem()).map((d) => d.name);
  });
  protected readonly total = computed(() => this.databases().length);
  protected readonly loaded = computed(() => {
    const conn = this.schema.quickOpenFor();
    return conn
      ? this.databases().filter((db) => {
          const s = this.schema.objects(conn, db)?.status;
          return s === 'loaded' || s === 'error';
        }).length
      : 0;
  });
  protected readonly loading = computed(() => {
    const conn = this.schema.quickOpenFor();
    const dbs = conn ? this.schema.databases(conn) : undefined;
    return !dbs || dbs.status === 'loading' || this.loaded() < this.total();
  });

  protected readonly items = computed<QuickItem[]>(() => {
    const conn = this.schema.quickOpenFor();
    if (!conn) return [];
    const out: QuickItem[] = [];
    for (const db of this.databases()) {
      const objects = this.schema.objects(conn, db);
      if (objects?.status === 'loaded')
        for (const object of objects.data) out.push({ database: db, object });
    }
    return out;
  });

  private recent: string[] = [];
  protected readonly matches = computed(() =>
    quickMatches(this.items(), this.query(), this.recent),
  );

  constructor() {
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.open) {
        dialog.showModal();
        this.input()?.nativeElement.focus();
      }
    });
    // Opened: load the objects of every database not loaded yet, a few at a time.
    effect(() => {
      const conn = this.schema.quickOpenFor();
      if (!conn) return;
      untracked(() => {
        this.recent = loadRecent(conn);
        void this.loadAll(conn);
      });
    });
  }

  private async loadAll(conn: string): Promise<void> {
    if (!this.schema.databases(conn)) await this.schema.loadDatabases(conn);
    const todo = this.databases().filter((db) => !this.schema.objects(conn, db));
    const next = async (): Promise<void> => {
      const db = todo.shift();
      if (db === undefined || this.schema.quickOpenFor() !== conn) return;
      await this.schema.loadObjects(conn, db);
      return next();
    };
    await Promise.all(Array.from({ length: PARALLEL }, next));
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.matches().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (n) this.active.set((this.active() + (event.key === 'ArrowDown' ? 1 : n - 1)) % n);
      document.getElementById(`qo-${this.active()}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const m = this.matches()[this.active()];
      if (m) this.open(m);
    }
  }

  protected open(item: QuickItem): void {
    const conn = this.schema.quickOpenFor();
    if (!conn) return;
    storeRecent(conn, `${item.database}.${item.object.name}`);
    this.close();
    // Shown in the tree too: its database opens.
    void this.schema.expandDatabase(conn, item.database);
    void this.schema.select({
      connectionId: conn,
      database: item.database,
      name: item.object.name,
      kind: item.object.kind,
    });
  }

  protected close(): void {
    this.dialog()?.nativeElement.close();
    this.schema.quickOpenFor.set(null);
    this.query.set('');
    this.active.set(0);
  }
}

function loadRecent(conn: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>;
    return Array.isArray(all[conn]) ? all[conn] : [];
  } catch {
    return [];
  }
}

function storeRecent(conn: string, name: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>;
    all[conn] = [name, ...(all[conn] ?? []).filter((n) => n !== name)].slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // Not remembered: the list starts alphabetically next time.
  }
}
