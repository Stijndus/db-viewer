import type { ConnectionInput, DbType } from '../../shared/models';

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
}

export interface DbDriver {
  readonly type: DbType;
  /** Opens a session and proves it works; rejects with the driver's own error otherwise. */
  open(config: ConnectionConfig): Promise<DbSession>;
}
