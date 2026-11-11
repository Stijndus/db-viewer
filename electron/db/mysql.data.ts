import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ApplyResult, ChangeSet } from '../../shared/changes';
import { quoteIdent } from '../../shared/dialect';
import type { RowsPage, RowsRequest } from '../../shared/models';
import {
  orderByClause,
  QUERY_TIMEOUT_MS,
  saveChanges,
  toCell,
  whereClause,
  type EditTarget,
} from './common';

export { MAX_TEXT_LENGTH, QUERY_TIMEOUT_MS, toCell, whereClause, orderByClause } from './common';
export { quoteIdent };

/**
 * LIMIT and OFFSET are written as numbers (validated integers), not as `?` placeholders: the driver
 * would otherwise also replace a `?` inside the user's filter or a table name.
 */
export function buildSelect(database: string, table: string, req: RowsRequest): string {
  const limit = Math.trunc(req.limit) + 1; // one extra row reveals whether a next page exists
  const offset = Math.trunc(req.offset);
  return (
    `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)}` +
    whereClause(req.where) +
    orderByClause(req.orderBy) +
    ` LIMIT ${limit} OFFSET ${offset}`
  );
}

export function buildCount(database: string, table: string, where?: string): string {
  return `SELECT COUNT(*) AS n FROM ${quoteIdent(database)}.${quoteIdent(table)}${whereClause(where)}`;
}

/**
 * Runs `fn` on a dedicated connection inside a READ ONLY transaction, so the user's filter can
 * never change data, and always ends the transaction. A connection that failed hard is discarded.
 */
async function readOnly<T>(pool: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  let broken = false;
  try {
    await conn.query('START TRANSACTION READ ONLY');
    return await fn(conn);
  } catch (err) {
    broken = Boolean((err as { fatal?: boolean }).fatal);
    throw err;
  } finally {
    if (broken) {
      conn.destroy();
    } else {
      await conn.query('ROLLBACK').catch(() => undefined);
      conn.release();
    }
  }
}

export function readRows(
  pool: Pool,
  database: string,
  table: string,
  req: RowsRequest,
): Promise<RowsPage> {
  return readOnly(pool, async (conn) => {
    const started = performance.now();
    // One extra row tells us whether a next page exists without counting the table.
    const [rows, fields] = await conn.query<RowDataPacket[][]>({
      sql: buildSelect(database, table, req),
      rowsAsArray: true,
      timeout: QUERY_TIMEOUT_MS,
    });
    const durationMs = Math.round(performance.now() - started);
    const hasMore = rows.length > req.limit;
    return {
      columns: (fields ?? []).map((f) => f.name),
      rows: rows.slice(0, req.limit).map((row) => (row as unknown[]).map(toCell)),
      hasMore,
      durationMs,
    };
  });
}

export function countRows(
  pool: Pool,
  database: string,
  table: string,
  where?: string,
): Promise<number> {
  return readOnly(pool, async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>({
      sql: buildCount(database, table, where),
      timeout: QUERY_TIMEOUT_MS,
    });
    return Number(rows[0]?.['n'] ?? 0);
  });
}

/**
 * Saves grid edits in one transaction (see `saveChanges`). Statements run as server-side prepared
 * statements, so placeholders are parsed by MySQL itself.
 */
export async function applyChanges(
  pool: Pool,
  database: string,
  table: string,
  changes: ChangeSet,
): Promise<ApplyResult> {
  const conn = await pool.getConnection();
  let broken = false;
  try {
    return await saveChanges(
      {
        target: () => readTarget(conn, database, table),
        begin: async () => void (await conn.query('START TRANSACTION')),
        execute: async (s) =>
          (await conn.execute<ResultSetHeader>(s.sql, s.params))[0].affectedRows,
        commit: async () => void (await conn.query('COMMIT')),
        rollback: async () => void (await conn.query('ROLLBACK')),
      },
      database,
      table,
      changes,
      'mysql',
    );
  } catch (err) {
    broken = Boolean((err as { fatal?: boolean }).fatal);
    throw err;
  } finally {
    if (broken) conn.destroy();
    else conn.release();
  }
}

async function readTarget(
  conn: PoolConnection,
  database: string,
  table: string,
): Promise<EditTarget> {
  const [tables] = await conn.query<RowDataPacket[]>(
    'SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  );
  if (tables.length === 0) return { type: null, columns: [], primaryKey: [] };
  const [cols] = await conn.query<RowDataPacket[]>(
    'SELECT COLUMN_NAME AS c, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table],
  );
  return {
    type: String(tables[0]?.['t']).toUpperCase() === 'BASE TABLE' ? 'table' : 'view',
    columns: cols.map((c) => String(c['c'])),
    primaryKey: cols.filter((c) => String(c['k']) === 'PRI').map((c) => String(c['c'])),
  };
}
