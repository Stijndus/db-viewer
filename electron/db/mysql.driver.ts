import mysql from 'mysql2/promise';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';
import * as data from './mysql.data';
import * as meta from './mysql.metadata';

export const CONNECT_TIMEOUT_MS = 8000;

export function createPoolOptions(cfg: ConnectionConfig): mysql.PoolOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    ssl: cfg.ssl ? { rejectUnauthorized: !cfg.allowSelfSigned } : undefined,
    connectionLimit: 5,
    maxIdle: 2,
    idleTimeout: 30_000,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // A viewer must show values exactly as stored:
    dateStrings: true, // DATETIME/DATE as text, no timezone shift
    supportBigNumbers: true, // BIGINT/DECIMAL without precision loss
    bigNumberStrings: true,
    jsonStrings: true, // JSON columns as stored text, not re-serialised objects
  };
}

export const mysqlDriver: DbDriver = {
  type: 'mysql',

  async open(cfg: ConnectionConfig): Promise<DbSession> {
    const pool = mysql.createPool(createPoolOptions(cfg));
    let version: string;
    try {
      // The pool connects lazily; this forces a real connection and login.
      version = await readVersion(pool);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }

    // MariaDB reports metadata slightly differently (see mysql.metadata.ts).
    const isMariaDb = /mariadb/i.test(version);

    return {
      serverVersion: () => readVersion(pool),
      listDatabases: () => meta.listDatabases(pool),
      listObjects: (database) => meta.listObjects(pool, database),
      listColumns: (database, table) => meta.listColumns(pool, database, table, isMariaDb),
      readRows: (database, table, request) => data.readRows(pool, database, table, request),
      countRows: (database, table, where) => data.countRows(pool, database, table, where),
      async query(sql, params) {
        const [rows, fields] = await pool.query(sql, params);
        return {
          rows: Array.isArray(rows) ? (rows as unknown[]) : [rows],
          fields: (fields ?? []).map((f) => f.name),
        };
      },
      close: () => pool.end(),
    };
  },
};

async function readVersion(pool: mysql.Pool): Promise<string> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
  return String(rows[0]?.['v'] ?? 'onbekend');
}
