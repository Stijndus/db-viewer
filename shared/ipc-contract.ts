import type { ApplyResult, ChangeSet } from './changes';
import type {
  ColumnInfo,
  ConnectionInput,
  ConnectionProfile,
  ConnectResult,
  ConnectSecrets,
  DatabaseInfo,
  ExportRequest,
  ImportFileInfo,
  LaunchRequest,
  SqlImportRequest,
  TransferProgress,
  ReleaseNote,
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
  releaseNotes: 'app:release-notes',
  takeLaunch: 'cli:take',
  pickImportFile: 'dialog:import-file',
  inspectImportFile: 'transfer:inspect',
  startSqlImport: 'transfer:import-sql',
  cancelTransfer: 'transfer:cancel',
  pickExportFile: 'dialog:export-file',
  startExport: 'transfer:export',
  showInFolder: 'shell:show-in-folder',
  pickDatabaseFile: 'dialog:database-file',
  pickKeyFile: 'dialog:key-file',
  trustHostKey: 'connections:trust-host-key',
} as const;

/** Pushed from main to the renderer whenever the update state changes. */
export const UPDATE_STATE_EVENT = 'updates:state';

/** Pushed while an import or export runs, and once when it ends. */
export const TRANSFER_EVENT = 'transfer:progress';

/** Pushed when `db-viewer …` is run again while the app is open. */
export const LAUNCH_EVENT = 'cli:launch';

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
  /** Opens the OS file dialog for an SSH private key; null when cancelled. */
  pickKeyFile(current?: string): Promise<Result<string | null>>;
  listConnections(): Promise<Result<ConnectionProfile[]>>;
  saveConnection(input: ConnectionInput, id?: string): Promise<Result<ConnectionProfile>>;
  deleteConnection(id: string): Promise<Result<void>>;
  /** Tests without saving. With `id` and no password, the stored password is used. */
  testConnection(input: ConnectionInput, id?: string): Promise<Result<TestResult>>;
  /** Opens a pooled session. Secrets are only needed when none are stored. */
  connect(id: string, secrets?: ConnectSecrets): Promise<Result<ConnectResult>>;
  /** Trusts an SSH server's host key for a profile, after the user compared the fingerprint. */
  trustHostKey(id: string, fingerprint: string): Promise<Result<ConnectionProfile>>;
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
  // Import and export.
  /** File dialog for a SQL script or an archive (.sql, .gz, .zip, .7z); null when cancelled. */
  pickImportFile(current?: string): Promise<Result<string | null>>;
  /** What is in the file: a script, or the files in an archive (password needed for hidden names). */
  inspectImportFile(file: string, password?: string): Promise<Result<ImportFileInfo>>;
  /** Starts running a SQL script on a connection; progress arrives through onTransfer. */
  startSqlImport(
    connectionId: string,
    request: SqlImportRequest,
  ): Promise<Result<{ jobId: string }>>;
  cancelTransfer(jobId: string): Promise<Result<void>>;
  /** Save dialog for an export; `name` includes the extension. Null when cancelled. */
  pickExportFile(name: string): Promise<Result<string | null>>;
  /** Starts writing an export; progress arrives through onTransfer. */
  startExport(connectionId: string, request: ExportRequest): Promise<Result<{ jobId: string }>>;
  /** Opens the folder with the file selected (only files an export wrote). */
  showInFolder(file: string): Promise<Result<void>>;
  onTransfer(listener: (progress: TransferProgress) => void): () => void;

  /** What the command line asked to open at start; null when nothing (asked once). */
  takeLaunch(): Promise<Result<LaunchRequest | null>>;
  /** Later launches from the command line while the app runs. Returns an unsubscribe function. */
  onLaunch(listener: (launch: LaunchRequest) => void): () => void;
  /** Release notes bundled with the app, newest first. */
  releaseNotes(): Promise<Result<ReleaseNote[]>>;
  /** Restarts the app into the downloaded update. */
  installUpdate(): Promise<Result<void>>;
  /** Subscribes to update state changes; returns a function that unsubscribes. */
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}
