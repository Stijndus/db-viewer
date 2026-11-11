import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Cell, RowsPage, RowsRequest, SortKey } from '../../shared/models';

/** A data query that runs longer is aborted (client side; the connection is then discarded). */
export const QUERY_TIMEOUT_MS = 30_000;
/** Longer strings are cut before they travel to the UI. */
export const MAX_TEXT_LENGTH = 2_000;
const BINARY_PREVIEW_BYTES = 32;

/** Quotes a MySQL identifier: wraps in backticks and doubles any backtick inside. */
export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * The user's filter goes inside parentheses on its own lines, so a `--` or `#` comment in it
 * can only swallow the rest of its own line, never the closing parenthesis, ORDER BY or LIMIT.
 */
export function whereClause(where: string | undefined): string {
  const condition = where?.trim();
  return condition ? ` WHERE (\n${condition}\n)` : '';
}

export function orderByClause(orderBy: SortKey[]): string {
  if (orderBy.length === 0) return '';
  const keys = orderBy.map(
    (k) => `${quoteIdent(k.column)} ${k.direction === 'desc' ? 'DESC' : 'ASC'}`,
  );
  return ` ORDER BY ${keys.join(', ')}`;
}

export function buildSelect(database: string, table: string, req: RowsRequest): string {
  return (
    `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)}` +
    whereClause(req.where) +
    orderByClause(req.orderBy) +
    ' LIMIT ? OFFSET ?'
  );
}

export function buildCount(database: string, table: string, where?: string): string {
  return `SELECT COUNT(*) AS n FROM ${quoteIdent(database)}.${quoteIdent(table)}${whereClause(where)}`;
}

/** Turns a raw driver value into something small and safe to send over IPC. */
export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
    return {
      kind: 'binary',
      bytes: value.length,
      hex: value.subarray(0, BINARY_PREVIEW_BYTES).toString('hex'),
    };
  }
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    text = String(value);
  else if (value instanceof Date) text = value.toISOString();
  else text = JSON.stringify(value); // JSON columns, spatial types
  return text.length > MAX_TEXT_LENGTH
    ? { kind: 'truncated', text: text.slice(0, MAX_TEXT_LENGTH), length: text.length }
    : text;
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
      values: [req.limit + 1, req.offset],
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
