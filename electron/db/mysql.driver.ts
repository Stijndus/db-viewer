import mysql from 'mysql2/promise';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';

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
  };
}

export const mysqlDriver: DbDriver = {
  type: 'mysql',

  async open(cfg: ConnectionConfig): Promise<DbSession> {
    const pool = mysql.createPool(createPoolOptions(cfg));
    try {
      // The pool connects lazily; this forces a real connection and login.
      await pool.query('SELECT 1');
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }

    return {
      async serverVersion() {
        const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
        return String(rows[0]?.['v'] ?? 'onbekend');
      },
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
