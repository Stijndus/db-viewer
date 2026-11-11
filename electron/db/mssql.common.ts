import sql from 'mssql';
import type { ConnectionConfig } from './driver';

export const CONNECT_TIMEOUT_MS = 8000;

/** Pool options; the SQL editor tabs use the same with one connection each. */
export function poolConfig(cfg: ConnectionConfig): sql.config {
  return {
    server: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || 'master',
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: 30_000,
    options: {
      encrypt: cfg.ssl,
      trustServerCertificate: cfg.allowSelfSigned,
      appName: 'DB Viewer',
      useUTC: true, // DATETIME values arrive as written, without a local-time shift
      enableArithAbort: true,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
  };
}

type MssqlError = Error & {
  code?: string;
  number?: number;
  sqlMessage?: string;
  fatal?: boolean;
  originalError?: unknown;
};

/**
 * mssql errors carry the server's error number; the app translates `MSSQL_<number>` codes and
 * network codes, and shows `sqlMessage` (the server's text) for mistakes in the user's SQL.
 */
export function mssqlError(err: unknown, phase: 'connect' | 'query' = 'query'): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as MssqlError;
  // Network failures hide the real cause a level or two down (AggregateError of each address).
  const inner = e.originalError as
    | { message?: string; code?: string; cause?: { code?: string; errors?: { code?: string }[] } }
    | undefined;
  const causes = [
    inner?.code,
    inner?.cause?.code,
    ...(inner?.cause?.errors ?? []).map((x) => x.code),
  ];
  const text = `${e.message} ${inner?.message ?? ''} ${causes.filter(Boolean).join(' ')}`;
  if (/Cannot open database/i.test(text)) {
    // Also reported as login failure 18456; the database is the real reason.
    e.code = 'MSSQL_4060';
    e.sqlMessage = e.message;
  } else if (typeof e.number === 'number' && e.number > 0) {
    e.code = `MSSQL_${e.number}`;
    e.sqlMessage = e.message;
  } else if (e.code === 'ELOGIN') {
    if (/Cannot open database/i.test(text)) e.code = 'MSSQL_4060';
    else if (/Login failed/i.test(text)) e.code = 'MSSQL_18456';
    e.sqlMessage = e.message;
  } else if (e.code === 'ESOCKET' || e.code === 'ETIMEOUT' || e.code === 'ECONNCLOSED') {
    e.fatal = true;
    if (/ECONNREFUSED/.test(text)) e.code = 'ECONNREFUSED';
    else if (/ENOTFOUND|getaddrinfo/.test(text)) e.code = 'ENOTFOUND';
    else if (e.code === 'ETIMEOUT' && phase === 'connect') e.code = 'ETIMEDOUT';
    else if (/self[- ]signed/i.test(text)) e.code = 'SELF_SIGNED_CERT_IN_CHAIN';
  }
  return e;
}

/** A readable text for a value, as SQL Server itself shows it. */
export function mssqlValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    // useUTC: the UTC parts are exactly the stored date and time.
    const iso = value.toISOString(); // 2026-11-10T14:10:00.000Z
    if (type === 'date') return iso.slice(0, 10);
    if (type === 'time') return iso.slice(11, 23);
    if (type === 'datetimeoffset') return iso.replace('T', ' ').replace('Z', ' +00:00');
    return iso.slice(0, 23).replace('T', ' ');
  }
  return value;
}

/** The declared type name of a result column, lower case (`int`, `nvarchar`, ...). */
export function columnType(column: { type?: unknown }): string {
  const t = column.type as { declaration?: string; name?: string } | undefined;
  return String(t?.declaration ?? t?.name ?? 'unknown').toLowerCase();
}
