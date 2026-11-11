import type { ApplyResult, ChangeSet } from './changes';
import type {
  ColumnInfo,
  ConnectionInput,
  ConnectionProfile,
  ConnectResult,
  DatabaseInfo,
  Result,
  RowsPage,
  RowsRequest,
  RunRequest,
  RunResult,
  SchemaObject,
  TestResult,
  UpdateState,
} from './models';

/** IPC channel names. Main registers a handler for each; preload exposes one function per channel. */
export const IPC = {
  listConnections: 'connections:list',
  saveConnection: 'connections:save',
  deleteConnection: 'connections:delete',
  testConnection: 'db:test',
  connect: 'db:connect',
  disconnect: 'db:disconnect',
  appInfo: 'app:info',
  listDatabases: 'schema:databases',
  listObjects: 'schema:objects',
  listColumns: 'schema:columns',
  listAllColumns: 'schema:all-columns',
  readRows: 'data:rows',
  countRows: 'data:count',
  applyChanges: 'data:apply',
  runScript: 'sql:run',
  cancelScript: 'sql:cancel',
  closeEditor: 'sql:close',
  updateState: 'updates:get',
  checkForUpdates: 'updates:check',
  installUpdate: 'updates:install',
  pickDatabaseFile: 'dialog:database-file',
} as const;

/** Pushed from main to the renderer whenever the update state changes. */
export const UPDATE_STATE_EVENT = 'updates:state';

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface AppInfo {
  /** False when the OS keychain is unavailable; passwords can then not be saved. */
  encryptionAvailable: boolean;
  version: string;
}

/** The API exposed to the renderer as `window.dbApi`. */
export interface DbApi {
  appInfo(): Promise<Result<AppInfo>>;
  /** Opens the OS file dialog for a SQLite database; null when cancelled. */
  pickDatabaseFile(current?: string): Promise<Result<string | null>>;
  listConnections(): Promise<Result<ConnectionProfile[]>>;
  saveConnection(input: ConnectionInput, id?: string): Promise<Result<ConnectionProfile>>;
  deleteConnection(id: string): Promise<Result<void>>;
  /** Tests without saving. With `id` and no password, the stored password is used. */
  testConnection(input: ConnectionInput, id?: string): Promise<Result<TestResult>>;
  /** Opens a pooled session. `password` is only needed when none is stored. */
  connect(id: string, password?: string): Promise<Result<ConnectResult>>;
  disconnect(id: string): Promise<Result<void>>;

  // Schema browsing on an open connection (step 2).
  /** Databases the connected user can see, sorted by name. */
  listDatabases(connectionId: string): Promise<Result<DatabaseInfo[]>>;
  /** Tables, views and routines in one database. */
  listObjects(connectionId: string, database: string): Promise<Result<SchemaObject[]>>;
  /** Columns of one table or view, in table order. */
  listColumns(connectionId: string, database: string, table: string): Promise<Result<ColumnInfo[]>>;

  /** Column names per table of one database (for autocompletion). */
  listAllColumns(connectionId: string, database: string): Promise<Result<Record<string, string[]>>>;

  // Table data (step 3). Always read-only, with a time limit.
  /** One page of rows from a table or view. */
  readRows(
    connectionId: string,
    database: string,
    table: string,
    request: RowsRequest,
  ): Promise<Result<RowsPage>>;
  /** Exact row count, optionally filtered. Can be slow on big tables, so the UI asks on demand. */
  countRows(
    connectionId: string,
    database: string,
    table: string,
    where?: string,
  ): Promise<Result<number>>;

  /** Saves edits from the grid in one transaction: all or nothing. */
  applyChanges(
    connectionId: string,
    database: string,
    table: string,
    changes: ChangeSet,
  ): Promise<Result<ApplyResult>>;

  // SQL editor (step 4). Each tab has its own server connection, opened on first run.
  /** Runs statements one after another; stops at the first error. */
  runScript(connectionId: string, tabId: string, request: RunRequest): Promise<Result<RunResult>>;
  /** Stops the statement that is running in a tab. */
  cancelScript(connectionId: string, tabId: string): Promise<Result<void>>;
  /** Closes the tab's connection; an open transaction is rolled back. */
  closeEditor(connectionId: string, tabId: string): Promise<Result<void>>;

  // Updates.
  updateState(): Promise<Result<UpdateState>>;
  checkForUpdates(): Promise<Result<UpdateState>>;
  /** Restarts the app into the downloaded update. */
  installUpdate(): Promise<Result<void>>;
  /** Subscribes to update state changes; returns a function that unsubscribes. */
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}
