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
