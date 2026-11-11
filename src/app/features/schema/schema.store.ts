import { effect, inject, Injectable, signal, untracked, type WritableSignal } from '@angular/core';
import type {
  ColumnInfo,
  DatabaseInfo,
  DbError,
  ObjectKind,
  Result,
  SchemaObject,
} from '../../../../shared/models';
import { DB_API } from '../../core/db-api';
import { ConnectionsStore } from '../connections/connections.store';

/** One lazily loaded piece of metadata. Absent from the cache = not requested yet. */
export type Load<T> =
  { status: 'loading' } | { status: 'loaded'; data: T } | { status: 'error'; error: DbError };

export interface SelectedObject {
  connectionId: string;
  database: string;
  name: string;
  kind: ObjectKind;
}

/** Expandable groups under a database. */
export type GroupId = 'tables' | 'views' | 'routines';

// Database and table names may contain almost anything, so keys use a control character as separator.
const SEP = '\u0001';
export const dbKey = (conn: string, db: string) => ['db', conn, db].join(SEP);
export const groupKey = (conn: string, db: string, group: GroupId) =>
  ['grp', conn, db, group].join(SEP);
export const objectKey = (conn: string, db: string, name: string) =>
  ['obj', conn, db, name].join(SEP);
const objectsCacheKey = (conn: string, db: string) => [conn, db].join(SEP);
const columnsCacheKey = (conn: string, db: string, table: string) => [conn, db, table].join(SEP);

/**
 * Schema metadata per open connection: databases → objects → columns, each loaded on first expand
 * and cached until refresh or disconnect.
 */
@Injectable({ providedIn: 'root' })
export class SchemaStore {
  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);

  private readonly databasesCache = signal<Record<string, Load<DatabaseInfo[]>>>({});
  private readonly objectsCache = signal<Record<string, Load<SchemaObject[]>>>({});
  private readonly columnsCache = signal<Record<string, Load<ColumnInfo[]>>>({});

  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly selected = signal<SelectedObject | null>(null);
  readonly filter = signal('');
  readonly showSystem = signal(false);
  /** Tab of the object panel; stays the same when another table is picked. */
  readonly objectTab = signal<'data' | 'structure'>('data');

  constructor() {
    // Drop everything we know about a connection once it is no longer open.
    effect(() => {
      const status = this.connections.status();
      untracked(() => {
        for (const [id, s] of Object.entries(status)) {
          if (s !== 'connected') this.forget(id);
        }
      });
    });
  }

  databases(conn: string): Load<DatabaseInfo[]> | undefined {
    return this.databasesCache()[conn];
  }

  objects(conn: string, db: string): Load<SchemaObject[]> | undefined {
    return this.objectsCache()[objectsCacheKey(conn, db)];
  }

  columns(conn: string, db: string, table: string): Load<ColumnInfo[]> | undefined {
    return this.columnsCache()[columnsCacheKey(conn, db, table)];
  }

  isExpanded(key: string): boolean {
    return this.expanded().has(key);
  }

  /** Called when a connection becomes active: loads databases and opens the profile's own database. */
  async open(conn: string, defaultDatabase: string): Promise<void> {
    if (this.databases(conn)) return;
    await this.loadDatabases(conn);
    const dbs = this.databases(conn);
    if (
      defaultDatabase &&
      dbs?.status === 'loaded' &&
      dbs.data.some((d) => d.name === defaultDatabase)
    ) {
      await this.expandDatabase(conn, defaultDatabase);
      this.setExpanded(groupKey(conn, defaultDatabase, 'tables'), true);
    }
  }

  async expandDatabase(conn: string, db: string): Promise<void> {
    this.setExpanded(dbKey(conn, db), true);
    if (!this.objects(conn, db)) await this.loadObjects(conn, db);
  }

  async toggleDatabase(conn: string, db: string): Promise<void> {
    const key = dbKey(conn, db);
    if (this.isExpanded(key)) this.setExpanded(key, false);
    else await this.expandDatabase(conn, db);
  }

  toggleGroup(conn: string, db: string, group: GroupId): void {
    const key = groupKey(conn, db, group);
    this.setExpanded(key, !this.isExpanded(key));
  }

  async toggleObject(conn: string, db: string, name: string): Promise<void> {
    const key = objectKey(conn, db, name);
    if (this.isExpanded(key)) {
      this.setExpanded(key, false);
      return;
    }
    this.setExpanded(key, true);
    if (!this.columns(conn, db, name)) await this.loadColumns(conn, db, name);
  }

  async select(object: SelectedObject): Promise<void> {
    this.selected.set(object);
    const { connectionId: conn, database: db, name, kind } = object;
    if ((kind === 'table' || kind === 'view') && !this.columns(conn, db, name)) {
      await this.loadColumns(conn, db, name);
    }
  }

  /** Reloads databases and everything currently expanded; keeps what is open open. */
  async refresh(conn: string): Promise<void> {
    const keepExpanded = this.expanded();
    const selected = this.selected();
    this.forget(conn, { keepUiState: true });
    await this.loadDatabases(conn);

    const reloads: Promise<void>[] = [];
    for (const key of keepExpanded) {
      const [kind, c, db, name] = key.split(SEP);
      if (c !== conn || !db) continue;
      if (kind === 'db') reloads.push(this.loadObjects(conn, db));
      if (kind === 'obj' && name) reloads.push(this.loadColumns(conn, db, name));
    }
    if (
      selected?.connectionId === conn &&
      !keepExpanded.has(objectKey(conn, selected.database, selected.name))
    ) {
      reloads.push(this.loadColumns(conn, selected.database, selected.name));
    }
    await Promise.all(reloads);
  }

  async loadDatabases(conn: string): Promise<void> {
    await this.load(this.databasesCache, conn, () => this.api.listDatabases(conn));
  }

  async loadObjects(conn: string, db: string): Promise<void> {
    await this.load(this.objectsCache, objectsCacheKey(conn, db), () =>
      this.api.listObjects(conn, db),
    );
  }

  async loadColumns(conn: string, db: string, table: string): Promise<void> {
    await this.load(this.columnsCache, columnsCacheKey(conn, db, table), () =>
      this.api.listColumns(conn, db, table),
    );
  }

  private async load<T>(
    cache: WritableSignal<Record<string, Load<T>>>,
    key: string,
    fetch: () => Promise<Result<T>>,
  ): Promise<void> {
    cache.update((c) => ({ ...c, [key]: { status: 'loading' } }));
    const result = await fetch();
    cache.update((c) => ({
      ...c,
      [key]: result.ok
        ? { status: 'loaded', data: result.data }
        : { status: 'error', error: result.error },
    }));
  }

  private setExpanded(key: string, open: boolean): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  private forget(conn: string, opts: { keepUiState?: boolean } = {}): void {
    const ofConn = (key: string) => key === conn || key.startsWith(conn + SEP);
    const drop = <T>(cache: Record<string, T>) =>
      Object.fromEntries(Object.entries(cache).filter(([k]) => !ofConn(k)));

    // Runs on every status change: skip signal writes when there is nothing to forget.
    const hasCache = Object.keys(this.databasesCache()).some(ofConn);
    const hasUi =
      this.selected()?.connectionId === conn ||
      [...this.expanded()].some((k) => k.split(SEP)[1] === conn);
    if (!hasCache && (opts.keepUiState || !hasUi)) return;

    this.databasesCache.update(drop);
    this.objectsCache.update(drop);
    this.columnsCache.update(drop);
    if (!opts.keepUiState) {
      this.expanded.update((set) => new Set([...set].filter((k) => k.split(SEP)[1] !== conn)));
      if (this.selected()?.connectionId === conn) this.selected.set(null);
    }
  }
}
