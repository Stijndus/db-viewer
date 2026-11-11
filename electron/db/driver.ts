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
} from '../../shared/models';

/** Everything a driver needs to open a connection, password resolved. */
export type ConnectionConfig = Omit<
  ConnectionInput,
  'password' | 'savePassword' | 'name' | 'color'
> & {
  password: string;
};

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
