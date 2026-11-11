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
  /** True when an encrypted password is stored for this profile. */
  hasPassword: boolean;
  /** Reach the database through an SSH tunnel; null = connect directly. */
  ssh: SshSettings | null;
  /** True when an SSH password or key passphrase is stored (encrypted). */
  hasSshSecret: boolean;
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

export type ConnectionColor = 'green' | 'orange' | 'red' | 'blue';

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
