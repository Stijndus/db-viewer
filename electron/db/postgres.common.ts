import net from 'node:net';
import tls from 'node:tls';
import pg from 'pg';
import { quoteIdent } from '../../shared/dialect';
import type { ConnectionConfig } from './driver';

export const CONNECT_TIMEOUT_MS = 8000;

/**
 * Every value arrives as the text PostgreSQL sends, so numbers, dates and JSON show exactly as
 * stored (no float rounding, no timezone shift). Only bytea becomes bytes, for the binary preview.
 */
export const RAW_TYPES = {
  getTypeParser: (oid: number) =>
    oid === 17
      ? (v: string) => Buffer.from(v.startsWith('\\x') ? v.slice(2) : v, 'hex')
      : (v: string) => v,
} as unknown as pg.CustomTypesConfig;

/** Options for one connection; the pool and the SQL editor tabs share them. */
export function clientConfig(cfg: ConnectionConfig): pg.ClientConfig {
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || 'postgres',
    ssl: cfg.ssl ? tlsOptions(cfg) : false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: 'DB Viewer',
    types: RAW_TYPES,
    // Read-only profiles: every transaction on every connection starts read-only, server side.
    options: cfg.readOnly ? '-c default_transaction_read_only=on' : undefined,
  };
}

/** SQLSTATE codes that mean the connection itself is gone. */
const FATAL_CLASSES = ['08', '57P'];

/**
 * pg errors carry a SQLSTATE `code` and the server message; the app's error translation reads
 * `sqlMessage` and `fatal`, as for MySQL.
 */
export function pgError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & { code?: string; sqlMessage?: string; fatal?: boolean };
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    e.sqlMessage ??= e.message;
    e.fatal ??= FATAL_CLASSES.some((c) => e.code!.startsWith(c)) && e.code !== '57014';
  }
  if (/Connection terminated|connection timeout/i.test(e.message) && !e.code) {
    e.code = /timeout/i.test(e.message) ? 'ETIMEDOUT' : 'PROTOCOL_CONNECTION_LOST';
    e.fatal = true;
  }
  return e;
}

/** `SET search_path` for "run in this schema": the chosen schema first, public as fallback. */
export function searchPath(schema: string): string {
  return schema === 'public'
    ? quoteIdent('public', 'postgres')
    : `${quoteIdent(schema, 'postgres')}, public`;
}

/** Through an SSH tunnel the socket goes to 127.0.0.1: check the certificate against the real host. */
function tlsOptions(cfg: ConnectionConfig): pg.ClientConfig['ssl'] {
  const name = cfg.tlsServerName;
  if (!name) return { rejectUnauthorized: !cfg.allowSelfSigned };
  return {
    rejectUnauthorized: !cfg.allowSelfSigned,
    ...(net.isIP(name) === 0 && { servername: name }),
    checkServerIdentity: (_host: string, cert: tls.PeerCertificate) =>
      tls.checkServerIdentity(name, cert),
  };
}
