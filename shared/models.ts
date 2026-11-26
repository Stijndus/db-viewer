/** Database types the app knows about. Only `mysql` has a driver in step 1. */
export type DbType = 'mysql' | 'postgres' | 'mssql' | 'sqlite';

export const DEFAULT_PORTS: Record<DbType, number> = {
  mysql: 3306,
  postgres: 5432,
  mssql: 1433,
  sqlite: 0,
};

/** A saved connection as the renderer sees it. The password never leaves the main process. */
export interface ConnectionProfile {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  allowSelfSigned: boolean;
  color: ConnectionColor;
  /** Refuse anything that changes data, in every part of the app. */
  readOnly: boolean;
  /**
   * The tag Development: a change in a table's grid is saved at once, without Opslaan. Off by
   * default; no effect on a read-only connection.
   */
  development: boolean;
  /** True when an encrypted password is stored for this profile. */
  hasPassword: boolean;
  /** Reach the database through an SSH tunnel; null = connect directly. */
  ssh: SshSettings | null;
  /** True when an SSH password or key passphrase is stored (encrypted). */
  hasSshSecret: boolean;
  /** Opened from the command line without --save: not saved, gone when the app quits. */
  temporary: boolean;
}

/** How to log in on the SSH server. */
export type SshAuth = 'password' | 'key' | 'agent' | 'pageant';

/**
 * An SSH tunnel like HeidiSQL's: the app logs in on `host`, and from there connects to the
 * database host and port of the profile (often `localhost` on that machine).
 */
export interface SshSettings {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** Private key file (OpenSSH or PuTTY .ppk) for `auth: 'key'`. */
  keyFile: string;
  /** SHA256 fingerprint of the server's host key, trusted on first use. Empty = not yet known. */
  hostKey: string;
}

/** Colour labels for connections, in the order of the picker. */
export const CONNECTION_COLORS = [
  'green',
  'orange',
  'red',
  'blue',
  'purple',
  'pink',
  'yellow',
  'teal',
  'brown',
  'gray',
] as const;
export type ConnectionColor = (typeof CONNECTION_COLORS)[number];

/** What the form sends to create, update or test a connection. */
export interface ConnectionInput {
  name: string;
  type: DbType;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  allowSelfSigned: boolean;
  color: ConnectionColor;
  readOnly: boolean;
  /** The tag Development (saves table edits at once). Missing = off. */
  development?: boolean;
  /** Empty or missing on update = keep the stored password. */
  password?: string;
  /** Store the password encrypted with the OS keychain. */
  savePassword: boolean;
  ssh?: SshSettings | null;
  /** SSH password or key passphrase. Empty or missing on update = keep the stored one. */
  sshSecret?: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface TestResult {
  latencyMs: number;
  serverVersion: string;
}

/** Secrets typed by the user for one connect, when none are stored. Never saved. */
export interface ConnectSecrets {
  password?: string;
  /** SSH password or key passphrase. */
  sshSecret?: string;
}

/** What the command line asked the app to open; sent to the window. */
export type LaunchRequest =
  { kind: 'open'; connectionId: string } | { kind: 'error'; message: string; hint?: string };

export interface ConnectResult {
  serverVersion: string;
}

export interface DbError {
  code: string;
  message: string;
  hint?: string;
  /** SSH_HOST_KEY_UNKNOWN / SSH_HOST_KEY_CHANGED: the fingerprint the server presented. */
  fingerprint?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: DbError };

// ── Schema (step 2) ────────────────────────────────────────────────

export interface DatabaseInfo {
  name: string;
  /** information_schema, mysql, performance_schema, sys: hidden by default. */
  system: boolean;
}

export type ObjectKind = 'table' | 'view' | 'procedure' | 'function';

/** A parameter of a procedure or function, for the call template. */
export interface RoutineParam {
  /** Without a leading `@` (SQL Server); empty for unnamed PostgreSQL parameters. */
  name: string;
  mode: 'in' | 'out' | 'inout';
  type: string;
}

/** A schema change from the tree's context menu. Refused on read-only connections. */
/**
 * What the tree's context menu can change. `force` gets past foreign keys: MySQL runs it with
 * FOREIGN_KEY_CHECKS = 0, PostgreSQL with CASCADE (see `forceOption`).
 */
export type ObjectAction =
  | { action: 'truncate'; database: string; name: string; force?: boolean }
  | { action: 'drop'; database: string; kind: ObjectKind; name: string; force?: boolean }
  | { action: 'drop-container'; database: string; force?: boolean }
  | { action: 'create-container'; database: string };

export interface SchemaObject {
  name: string;
  kind: ObjectKind;
  /** Estimated row count for tables (InnoDB statistics, not exact). Null when unknown. */
  rowEstimate: number | null;
  comment: string;
}

export type ColumnKey = 'primary' | 'unique' | 'index' | null;

export interface ColumnInfo {
  name: string;
  /** Full declared type, e.g. `varchar(255)`, `decimal(10,2) unsigned`, `enum('a','b')`. */
  type: string;
  nullable: boolean;
  key: ColumnKey;
  /** Default as SQL text, or null when there is no default. */
  defaultValue: string | null;
  /** e.g. `auto_increment`, `on update CURRENT_TIMESTAMP`, `VIRTUAL GENERATED`. */
  extra: string;
  comment: string;
}

/**
 * A foreign key: `columns` of `database`.`table` point to `refColumns` of `refDatabase`.`refTable`.
 * In PostgreSQL and SQL Server "database" is the schema, as in the tree.
 */
export interface ForeignKey {
  name: string;
  database: string;
  table: string;
  columns: string[];
  refDatabase: string;
  refTable: string;
  refColumns: string[];
}

/** The tables of a database with their columns, and its foreign keys: for relations and the ER diagram. */
export interface DatabaseModel {
  tables: { name: string; columns: { name: string; type: string; primary: boolean }[] }[];
  /** Keys from tables in this database, and keys from elsewhere that point into it. */
  foreignKeys: ForeignKey[];
}

// ── Table data (step 3) ────────────────────────────────────────────

/** Binary values (BLOB, BINARY, BIT): only a size and the first bytes as hex travel to the UI. */
export interface BinaryCell {
  kind: 'binary';
  bytes: number;
  /** Hex of at most the first 32 bytes. */
  hex: string;
}

/** Text longer than the transfer limit: the start, plus the full length. */
export interface TruncatedCell {
  kind: 'truncated';
  text: string;
  length: number;
}

/** One value as shown in the grid. Numbers, dates and JSON arrive as text, exactly as stored. */
export type Cell = string | null | BinaryCell | TruncatedCell;

export type SortDirection = 'asc' | 'desc';

export interface SortKey {
  column: string;
  direction: SortDirection;
}

export interface RowsRequest {
  offset: number;
  /** Rows per page, 1–1000. */
  limit: number;
  /** Empty = server order. The UI sends the primary key when the user picked no sort. */
  orderBy: SortKey[];
  /** Raw SQL condition typed by the user, without the word WHERE. Runs read-only. */
  where?: string;
}

export interface RowsPage {
  columns: string[];
  rows: Cell[][];
  /** True when at least one more row exists after this page. */
  hasMore: boolean;
  durationMs: number;
}

// ── SQL editor (step 4) ────────────────────────────────────────────

export interface ResultColumn {
  name: string;
  /** Type label derived from the result metadata, e.g. `int`, `varchar`, `datetime`. */
  type: string;
}

interface StatementBase {
  /** Position of the statement in the script that was run, from 0. */
  index: number;
  sql: string;
  durationMs: number;
}

export type StatementResult =
  | (StatementBase & {
      kind: 'rows';
      columns: ResultColumn[];
      rows: Cell[][];
      /** More rows existed than the row limit allowed. */
      truncated: boolean;
    })
  | (StatementBase & {
      kind: 'ok';
      affectedRows: number;
      /** Last AUTO_INCREMENT value, as text; null when none. */
      insertId: string | null;
      warnings: number;
      info: string;
    })
  | (StatementBase & { kind: 'error'; error: DbError });

export interface RunRequest {
  statements: string[];
  /** Run in this database (USE) first; undefined = stay in the current one. */
  database?: string;
  /** Row limit per result; null = no limit (up to a hard safety cap). */
  maxRows: number | null;
}

export interface RunResult {
  /** One entry per statement that ran; execution stops at the first error. */
  results: StatementResult[];
  /** Current database of the editor session after the run (USE may change it). */
  database: string | null;
}

// ── Updates ────────────────────────────────────────────────────────

/** Release notes of one version, as written in .github/release-notes (Markdown). */
export interface ReleaseNote {
  version: string;
  markdown: string;
}

/** What the app knows about updates; pushed from main to the UI whenever it changes. */
export type UpdateState =
  /** Development build or a platform without auto-update. */
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current' }
  | { status: 'downloading'; version: string; percent: number; notes?: string }
  /** Downloaded; installs on restart or when the app quits. */
  | { status: 'ready'; version: string; notes?: string }
  /** The portable exe can't replace itself: the user downloads the new version. */
  | { status: 'manual'; version: string; url: string; notes?: string }
  | { status: 'error'; message: string };

/** `notes` on an update: the GitHub release text of the new version, as HTML. */

// ── Import and export ──────────────────────────────────────────────

/** A file chosen for a SQL import, as the dialog shows it. */
export interface ImportFileInfo {
  file: string;
  name: string;
  size: number;
  /** A plain script, a .gz, or a zip/7z archive with `entries`. */
  kind: 'script' | 'gzip' | 'archive';
  /** Some file in the archive needs a password. */
  encrypted?: boolean;
  entries: {
    path: string;
    size: number | null;
    encrypted: boolean;
    /** A SQL script by its name. */
    script: boolean;
    /** A CSV, JSON or Excel file by its name. */
    data?: boolean;
  }[];
}

export interface SqlImportRequest {
  file: string;
  /** The file inside a zip or 7z archive. */
  entry?: string;
  /** Archive password; used for this import only, never stored. */
  password?: string;
  /** Run in this database (schema) first; the script's own USE statements still apply. */
  database?: string;
  /** Stop at the first failing statement, or note it and go on. */
  onError: 'stop' | 'skip';
}

export type DataFileFormat = 'csv' | 'json' | 'xlsx';
export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | 'iso-8859-1';

/** How to read a CSV, JSON or Excel file; left out, it is detected. */
export interface DataFileOptions {
  file: string;
  /** The file inside a zip or 7z archive. */
  entry?: string;
  /** Archive password; used for this import only, never stored. */
  password?: string;
  format?: DataFileFormat;
  /** CSV: the delimiter (one character) and encoding. */
  delimiter?: string;
  encoding?: CsvEncoding;
  /** CSV and Excel: the first row holds the column names. Default true. */
  header?: boolean;
  /** Excel: the worksheet by name; default the first. */
  sheet?: string;
}

/** The first rows of a data file, as the import dialog shows them. */
export interface DataPreview {
  format: DataFileFormat;
  columns: string[];
  /** The first rows, values cut to a few hundred characters. */
  rows: (string | null)[][];
  /** Rows in the file, when known without reading it all (JSON). */
  rowCount?: number;
  /** CSV: what was detected or chosen. */
  delimiter?: string;
  encoding?: CsvEncoding;
  /** Excel: the worksheets, and the one shown. */
  sheets?: string[];
  sheet?: string;
}

export interface DataImportRequest extends DataFileOptions {
  database: string;
  table: string;
  /** File column (index in the preview's columns) → table column. */
  mapping: { source: number; target: string }[];
  /** Add rows, empty the table first, or update rows whose primary key exists. */
  mode: 'append' | 'replace' | 'upsert';
  /** All in one transaction undone at the first error, or bad rows skipped and listed. */
  onError: 'rollback' | 'skip';
  /** An empty text field becomes NULL (other column types always do). */
  emptyAsNull: boolean;
  /** MySQL and SQLite: no foreign key checks during the import. */
  disableForeignKeys?: boolean;
}

/** Progress of an import or export, pushed while it runs and once at the end. */
export interface TransferProgress {
  jobId: string;
  kind: 'import' | 'export';
  phase: 'running' | 'done' | 'done-with-errors' | 'stopped-at-error' | 'cancelled' | 'failed';
  /** Bytes read (import) or written (export) so far. */
  bytes: number;
  totalBytes: number | null;
  /** Statements run (import), rows imported (data import) or rows written (export). */
  statements: number;
  /** A CSV, JSON or Excel import: `statements` and `failed` count rows. */
  unit?: 'rows';
  /** Data import in one transaction: nothing was saved (rolled back after an error or stop). */
  rolledBack?: boolean;
  failed: number;
  /** The first failing statements or rows (at most 100), with the server's message. */
  errors: { statement: number; sql: string; message: string }[];
  /** Set when the whole job failed (phase 'failed'). */
  error?: DbError;
  /** Export: copied to the clipboard instead of written to a file. */
  clipboard?: boolean;
  /** Export: the file written. */
  file?: string;
}

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx' | 'markdown';

/** The clipboard is for small things: larger exports go to a file. */
export const CLIPBOARD_MAX_ROWS = 100_000;
export const CLIPBOARD_MAX_BYTES = 50 * 1024 * 1024;

/** What to export: a table (with the grid's filter and sort), a query's result, or a database. */
export type ExportSource =
  | { kind: 'table'; database: string; table: string; where?: string; orderBy: SortKey[] }
  | { kind: 'query'; sql: string; database?: string }
  /** Several tables as one SQL script: structure, data, or both. */
  | { kind: 'database'; database: string; tables: string[]; structure: boolean; data: boolean }
  /** Selected rows of a table, fetched again by primary key: complete values, in key order. */
  | {
      kind: 'keys';
      database: string;
      table: string;
      keyColumns: string[];
      /** One entry per row: its key values in `keyColumns` order. */
      keys: (string | null)[][];
    }
  /** Rows exactly as the grid shows them (query results, tables without a key, unsaved edits). */
  | {
      kind: 'values';
      columns: string[];
      /** Per column: numeric, so JSON and Excel can make numbers of it. */
      numeric: boolean[];
      rows: (string | null)[][];
    };

export interface ExportRequest {
  source: ExportSource;
  format: ExportFormat;
  /** The file to write (chosen in the save dialog); empty when copying to the clipboard. */
  file: string;
  /** Write to the clipboard instead of a file (not Excel, no archive, within the limits above). */
  destination?: 'file' | 'clipboard';
  csv?: { delimiter: ',' | ';' | '\t'; header: boolean; bom: boolean };
  json?: { style: 'array' | 'lines' };
  sql?: {
    /** Rows per INSERT statement. */
    rowsPerInsert: number;
    /** Table name in the INSERTs of a query export. */
    tableName?: string;
    /** Single tables: also write CREATE TABLE (and DROP TABLE IF EXISTS). */
    createTable?: boolean;
    dropTable?: boolean;
  };
  /** Pack the file: gzip, zip or 7z; zip and 7z can have a password (AES-256). */
  archive?: { kind: 'gzip' | 'zip' | '7z'; password?: string };
}

/** A file read for a grid cell ("load file into cell"). */
export interface CellFile {
  name: string;
  size: number;
  base64: string;
}

/** The largest file that can go into a cell (it travels as a literal in an UPDATE or INSERT). */
export const CELL_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** "Save value to file": fetched again by primary key (complete), or the value as shown. */
/** One cell of a table row, found by its primary key: to read its whole value. */
export interface CellKey {
  database: string;
  table: string;
  keyColumns: string[];
  keyValues: (string | null)[];
  column: string;
}

/** Longest value the cell editor loads in full; past this it shows the start. */
export const CELL_TEXT_MAX_CHARS = 5_000_000;

export type CellSaveRequest =
  | {
      kind: 'key';
      database: string;
      table: string;
      keyColumns: string[];
      keyValues: (string | null)[];
      column: string;
      name: string;
    }
  | { kind: 'content'; base64: string; name: string };

// ── Query history ──────────────────────────────────────────────────

/** What a statement in the history gave: rows, changed rows, or an error. */
export type HistoryResult =
  | { kind: 'rows'; rows: number; more?: boolean }
  | { kind: 'ok'; affected: number }
  | { kind: 'error'; message: string };

/** One query (or, for long scripts, one run) from a SQL tab, kept on this computer only. */
export interface HistoryEntry {
  id: string;
  connectionId: string;
  /** The connection's name when it ran; shown when the connection is gone. */
  connectionName: string;
  database: string | null;
  sql: string;
  /** Longer than HISTORY_SQL_MAX: only the start was kept. */
  truncated?: boolean;
  /** When it ran (ms since 1970). */
  at: number;
  durationMs: number;
  result: HistoryResult;
  /** A whole script kept as one entry: how many statements ran. */
  statements?: number;
}

export type NewHistoryEntry = Omit<HistoryEntry, 'id'>;

/** The oldest entries go past this many. */
export const HISTORY_MAX = 5000;
/** SQL longer than this is kept cut off (and marked). */
export const HISTORY_SQL_MAX = 64 * 1024;
/** A run of more statements than this is kept as one entry, not one per statement. */
export const HISTORY_SCRIPT_STATEMENTS = 20;
