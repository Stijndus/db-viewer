import type { ApplyResult, ChangeSet } from '../../shared/changes';
import type {
  ColumnInfo,
  ConnectionInput,
  DatabaseInfo,
  DbType,
  RowsPage,
  RowsRequest,
  RunRequest,
  RunResult,
  SchemaObject,
  SortKey,
} from '../../shared/models';

/** Everything a driver needs to open a connection, password resolved. */
export type ConnectionConfig = Omit<
  ConnectionInput,
  'password' | 'savePassword' | 'name' | 'color' | 'ssh' | 'sshSecret'
> & {
  password: string;
  /**
   * The database's real host name when `host` is a local SSH tunnel: TLS checks the server
   * certificate against this name, not against 127.0.0.1.
   */
  tlsServerName?: string;
};

/** What an export reads: a whole table (with the grid's filter and sort) or one SELECT. */
export type RowSource =
  | { kind: 'table'; database: string; table: string; where?: string; orderBy: SortKey[] }
  | { kind: 'query'; sql: string; database?: string };

/**
 * Rows for an export, with full values (no truncation): strings, numbers, bigints, booleans,
 * Buffers/Uint8Arrays for binary data, Dates, or null. `columns` comes with every batch.
 */
export interface RowBatch {
  columns: string[];
  rows: unknown[][];
}

export interface QueryResult {
  rows: unknown[];
  fields: string[];
}

/** An open, pooled connection to one database server. */
export interface DbSession {
  serverVersion(): Promise<string>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;

  // Metadata. Each driver answers these in its own dialect.
  listDatabases(): Promise<DatabaseInfo[]>;
  listObjects(database: string): Promise<SchemaObject[]>;
  listColumns(database: string, table: string): Promise<ColumnInfo[]>;
  listAllColumns(database: string): Promise<Record<string, string[]>>;

  // Table data, read-only and time-limited.
  readRows(database: string, table: string, request: RowsRequest): Promise<RowsPage>;
  countRows(database: string, table: string, where?: string): Promise<number>;
  /** Saves grid edits in one transaction; refused on read-only connections. */
  applyChanges(database: string, table: string, changes: ChangeSet): Promise<ApplyResult>;

  // Export: read-only, without a time limit, in batches; `onBatch` is awaited (backpressure).
  streamRows(
    source: RowSource,
    onBatch: (batch: RowBatch) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  /** CREATE TABLE for a table, as the server has it (MySQL, SQLite) or rebuilt from metadata. */
  tableDdl(database: string, table: string): Promise<string>;

  // SQL editor: one dedicated connection per tab, identified by the UI's tab id.
  runScript(tabId: string, request: RunRequest): Promise<RunResult>;
  cancelScript(tabId: string): Promise<void>;
  closeEditor(tabId: string): Promise<void>;
}

export interface DbDriver {
  readonly type: DbType;
  /** Opens a session and proves it works; rejects with the driver's own error otherwise. */
  open(config: ConnectionConfig): Promise<DbSession>;
}
