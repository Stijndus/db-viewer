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
  /** True when an encrypted password is stored for this profile. */
  hasPassword: boolean;
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
  /** Empty or missing on update = keep the stored password. */
  password?: string;
  /** Store the password encrypted with the OS keychain. */
  savePassword: boolean;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface TestResult {
  latencyMs: number;
  serverVersion: string;
}

export interface ConnectResult {
  serverVersion: string;
}

export interface DbError {
  code: string;
  message: string;
  hint?: string;
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
