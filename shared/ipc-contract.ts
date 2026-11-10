import type {
  ColumnInfo,
  ConnectionInput,
  ConnectionProfile,
  ConnectResult,
  DatabaseInfo,
  Result,
  SchemaObject,
  TestResult,
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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface AppInfo {
  /** False when the OS keychain is unavailable; passwords can then not be saved. */
  encryptionAvailable: boolean;
}

/** The API exposed to the renderer as `window.dbApi`. */
export interface DbApi {
  appInfo(): Promise<Result<AppInfo>>;
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
}
