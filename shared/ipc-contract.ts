import type { IndexInfo } from './ddl';
import type { ProcessAction, ProcessList } from './process-list';
import type { DbUserRef, DbUserSummary, UserChange, UserDetails } from './user-sql';
import type { ApplyResult, ChangeSet } from './changes';
import type {
  CellFile,
  CellKey,
  DatabaseModel,
  CellSaveRequest,
  ColumnInfo,
  ConnectResult,
  ConnectSecrets,
  ConnectionInput,
  ConnectionProfile,
  DatabaseInfo,
  DataFileOptions,
  DataImportRequest,
  DataPreview,
  ExportRequest,
  HistoryEntry,
  NewHistoryEntry,
  ImportFileInfo,
  LaunchRequest,
  ObjectAction,
  ObjectKind,
  ReleaseNote,
  Result,
  RoutineParam,
  RowsPage,
  RowsRequest,
  RunRequest,
  RunResult,
  SchemaObject,
  SqlImportRequest,
  TableDefinition,
  TestResult,
  TransferProgress,
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
  databaseModel: 'schema:model',
  objectDefinition: 'schema:definition',
  routineParams: 'schema:routine-params',
  objectAction: 'schema:action',
  listUsers: 'users:list',
  userDetails: 'users:details',
  applyUserChanges: 'users:apply',
  listProcesses: 'processes:list',
  listIndexes: 'structure:indexes',
  tableDefinition: 'structure:definition',
  applyDdl: 'structure:apply',
  stopProcess: 'processes:stop',
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
  previewDataFile: 'transfer:preview-data',
  startDataImport: 'transfer:import-data',
  cancelTransfer: 'transfer:cancel',
  historyList: 'history:list',
  historyAdd: 'history:add',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  pickExportFile: 'dialog:export-file',
  startExport: 'transfer:export',
  showInFolder: 'shell:show-in-folder',
  readClipboard: 'clipboard:read',
  pickCellFile: 'cell:pick-file',
  saveCellToFile: 'cell:save-file',
  readCellText: 'cell:read-text',
  setAppearance: 'app:appearance',
  zoom: 'app:zoom',
  pickDatabaseFile: 'dialog:database-file',
  pickKeyFile: 'dialog:key-file',
  trustHostKey: 'connections:trust-host-key',
} as const;

/** Pushed from main to the renderer whenever the update state changes. */
export const UPDATE_STATE_EVENT = 'updates:state';

/** Pushed when the zoom level changes (Ctrl+scroll, Ctrl+=, Ctrl+-, Ctrl+0). */
export const ZOOM_EVENT = 'app:zoom-changed';

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
  /** Tables, columns and foreign keys of a database: following keys and the ER diagram. */
  databaseModel(connectionId: string, database: string): Promise<Result<DatabaseModel>>;

  /** CREATE statement of a table, view, procedure or function (tree context menu). */
  objectDefinition(
    connectionId: string,
    database: string,
    kind: ObjectKind,
    name: string,
  ): Promise<Result<string>>;
  /** Parameters of a procedure or function, for a call template. */
  routineParams(
    connectionId: string,
    database: string,
    kind: 'procedure' | 'function',
    name: string,
  ): Promise<Result<RoutineParam[]>>;
  /** Empties or drops an object or database; refused on read-only connections. */
  objectAction(connectionId: string, action: ObjectAction): Promise<Result<void>>;
  /** The server's users (MySQL accounts, PostgreSQL roles, SQL Server logins). */
  listUsers(connectionId: string): Promise<Result<DbUserSummary[]>>;
  /** A table as SQL: CREATE TABLE, extra indexes and foreign keys, triggers. */
  tableDefinition(
    connectionId: string,
    database: string,
    table: string,
  ): Promise<Result<TableDefinition>>;
  /** A table's indexes. */
  listIndexes(connectionId: string, database: string, table: string): Promise<Result<IndexInfo[]>>;
  /** Runs structure changes (shown first), stopping at the first error; refused when read-only. */
  applyDdl(
    connectionId: string,
    database: string,
    statements: string[],
  ): Promise<Result<{ ran: number }>>;
  /** Connections and running queries on the server (not SQLite). */
  listProcesses(connectionId: string): Promise<Result<ProcessList>>;
  /** Stops a process's query, or ends its connection (refused on a read-only connection). */
  stopProcess(connectionId: string, action: ProcessAction, id: string): Promise<Result<void>>;
  userDetails(connectionId: string, user: DbUserRef): Promise<Result<UserDetails>>;
  /** Runs the changes in order; refused on a read-only connection. */
  applyUserChanges(connectionId: string, changes: UserChange[]): Promise<Result<void>>;

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
  /** A SQL script (default) or a CSV, JSON or Excel file, or an archive holding one. */
  pickImportFile(current?: string, kind?: 'sql' | 'data'): Promise<Result<string | null>>;
  /** What is in the file: a script, or the files in an archive (password needed for hidden names). */
  inspectImportFile(file: string, password?: string): Promise<Result<ImportFileInfo>>;
  /** Starts running a SQL script on a connection; progress arrives through onTransfer. */
  startSqlImport(
    connectionId: string,
    request: SqlImportRequest,
  ): Promise<Result<{ jobId: string }>>;
  /** The columns and first rows of a CSV, JSON or Excel file (also inside an archive). */
  previewDataFile(options: DataFileOptions): Promise<Result<DataPreview>>;
  /** Starts loading a data file into a table; progress arrives through onTransfer. */
  startDataImport(
    connectionId: string,
    request: DataImportRequest,
  ): Promise<Result<{ jobId: string }>>;
  cancelTransfer(jobId: string): Promise<Result<void>>;

  // Query history, on this computer only.
  /** All entries, newest first. */
  historyList(): Promise<Result<HistoryEntry[]>>;
  /** Adds entries (in the order they ran); returns them with their ids. */
  historyAdd(entries: NewHistoryEntry[]): Promise<Result<HistoryEntry[]>>;
  historyDelete(ids: string[]): Promise<Result<void>>;
  /** One connection's entries, or all of them. */
  historyClear(connectionId?: string): Promise<Result<void>>;
  /** Save dialog for an export; `name` includes the extension. Null when cancelled. */
  pickExportFile(name: string): Promise<Result<string | null>>;
  /** Starts writing an export; progress arrives through onTransfer. */
  startExport(connectionId: string, request: ExportRequest): Promise<Result<{ jobId: string }>>;
  /** Opens the folder with the file selected (only files an export wrote). */
  showInFolder(file: string): Promise<Result<void>>;
  /** Text on the system clipboard (paste into the grid). */
  readClipboard(): Promise<Result<string>>;
  /** Lets the user pick a file for a cell; null when cancelled. Max CELL_FILE_MAX_BYTES. */
  pickCellFile(): Promise<Result<CellFile | null>>;
  /** Saves a cell's value as a file (save dialog); the file, or null when cancelled. */
  saveCellToFile(connectionId: string, request: CellSaveRequest): Promise<Result<string | null>>;
  /**
   * The whole value of a cell as text, for the cell editor: null for NULL. Refuses binary values
   * and values over CELL_TEXT_MAX_CHARS.
   */
  readCellText(connectionId: string, cell: CellKey): Promise<Result<string | null>>;
  onTransfer(listener: (progress: TransferProgress) => void): () => void;

  /** What the command line asked to open at start; null when nothing (asked once). */
  takeLaunch(): Promise<Result<LaunchRequest | null>>;
  /** Later launches from the command line while the app runs. Returns an unsubscribe function. */
  onLaunch(listener: (launch: LaunchRequest) => void): () => void;
  /** The window background for the next start (the theme's background colour). */
  setAppearance(appearance: { background: string }): Promise<Result<void>>;
  /** Zoom: 'in', 'out', 'reset', or 'get'; returns the factor (1 = 100%). */
  zoom(action: 'in' | 'out' | 'reset' | 'get'): Promise<Result<number>>;
  onZoom(listener: (factor: number) => void): () => void;
  /** Release notes bundled with the app, newest first. */
  releaseNotes(): Promise<Result<ReleaseNote[]>>;
  /** Restarts the app into the downloaded update. */
  installUpdate(): Promise<Result<void>>;
  /** Subscribes to update state changes; returns a function that unsubscribes. */
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}
