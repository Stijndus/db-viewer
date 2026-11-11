import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  changeStatements,
  describeKey,
  quoteIdent,
  type ApplyResult,
  type ChangeSet,
  type ChangeStatement,
} from '../../shared/changes';
import type { Cell, RowsPage, RowsRequest, SortKey } from '../../shared/models';
import { AppError, toSqlError } from '../ipc/errors';

export { quoteIdent };

/** A data query that runs longer is aborted (client side; the connection is then discarded). */
export const QUERY_TIMEOUT_MS = 30_000;
/** Longer strings are cut before they travel to the UI. */
export const MAX_TEXT_LENGTH = 2_000;
const BINARY_PREVIEW_BYTES = 32;

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
 * Saves grid edits in one transaction. The server first checks that the target is a table whose
 * primary key matches what the UI used; every UPDATE and DELETE must then hit exactly one row,
 * otherwise everything is rolled back (the row was changed or removed by someone else).
 */
export async function applyChanges(
  pool: Pool,
  database: string,
  table: string,
  changes: ChangeSet,
): Promise<ApplyResult> {
  const conn = await pool.getConnection();
  let broken = false;
  let inTransaction = false;
  let current: ChangeStatement | null = null;
  try {
    await verifyTarget(conn, database, table, changes);
    await conn.query('START TRANSACTION');
    inTransaction = true;
    const result: ApplyResult = { deleted: 0, updated: 0, inserted: 0 };
    for (const statement of changeStatements(database, table, changes)) {
      current = statement;
      // Server-side prepared statement: placeholders are parsed by MySQL itself.
      const [res] = await conn.execute<ResultSetHeader>(statement.sql, statement.params);
      if (statement.kind !== 'insert' && res.affectedRows !== 1) {
        throw new AppError(
          'ROW_CHANGED',
          'Een rij is intussen gewijzigd of verwijderd.',
          'Vernieuw de data en probeer het opnieuw.',
        );
      }
      result[
        statement.kind === 'delete'
          ? 'deleted'
          : statement.kind === 'update'
            ? 'updated'
            : 'inserted'
      ]++;
    }
    await conn.query('COMMIT');
    inTransaction = false;
    return result;
  } catch (err) {
    broken = Boolean((err as { fatal?: boolean }).fatal);
    const error = err instanceof AppError ? err : null;
    const base = error
      ? { code: error.code, message: error.message, hint: error.hint }
      : toSqlError(err);
    const where = current ? describeChange(current, changes) : null;
    throw new AppError(
      base.code,
      where ? `Opslaan mislukt bij ${where}: ${base.message}` : base.message,
      [base.hint, 'Er is niets opgeslagen.'].filter(Boolean).join(' '),
    );
  } finally {
    if (broken) conn.destroy();
    else {
      if (inTransaction) await conn.query('ROLLBACK').catch(() => undefined);
      conn.release();
    }
  }
}

async function verifyTarget(
  conn: PoolConnection,
  database: string,
  table: string,
  changes: ChangeSet,
) {
  const [tables] = await conn.query<RowDataPacket[]>(
    'SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  );
  if (tables.length === 0) {
    throw new AppError('ER_NO_SUCH_TABLE', 'Tabel bestaat niet (meer).', 'Vernieuw het schema.');
  }
  if (String(tables[0]?.['t']).toUpperCase() !== 'BASE TABLE') {
    throw new AppError('NOT_EDITABLE', 'Alleen tabellen kunnen worden bewerkt, geen views.');
  }
  const [cols] = await conn.query<RowDataPacket[]>(
    'SELECT COLUMN_NAME AS c, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  );
  const names = new Set(cols.map((c) => String(c['c'])));
  const primaryKey = cols.filter((c) => String(c['k']) === 'PRI').map((c) => String(c['c']));
  const samePk =
    primaryKey.length > 0 &&
    primaryKey.length === changes.primaryKey.length &&
    primaryKey.every((c) => changes.primaryKey.includes(c));
  if (!samePk) {
    throw new AppError(
      'NOT_EDITABLE',
      'Deze tabel kan niet worden bewerkt.',
      primaryKey.length === 0
        ? 'Hij heeft geen primaire sleutel, dus een rij is niet eenduidig aan te wijzen.'
        : 'De primaire sleutel is intussen veranderd. Vernieuw het schema.',
    );
  }
  const keys = [...changes.deletes.map((d) => d.key), ...changes.updates.map((u) => u.key)];
  for (const key of keys) {
    if (
      Object.keys(key).length !== primaryKey.length ||
      primaryKey.some((c) => typeof key[c] !== 'string')
    ) {
      throw new AppError('VALIDATION', 'Ongeldige rij-sleutel.');
    }
  }
  const valueSets = [
    ...changes.updates.map((u) => u.values),
    ...changes.inserts.map((i) => i.values),
  ];
  for (const values of valueSets) {
    const unknown = Object.keys(values).find((c) => !names.has(c));
    if (unknown)
      throw new AppError(
        'ER_BAD_FIELD_ERROR',
        `Kolom ${unknown} bestaat niet (meer).`,
        'Vernieuw het schema.',
      );
  }
}

function describeChange(statement: ChangeStatement, changes: ChangeSet): string {
  const n = statement.index + 1;
  if (statement.kind === 'insert') return `nieuwe rij ${n}`;
  const key =
    statement.kind === 'delete'
      ? changes.deletes[statement.index]?.key
      : changes.updates[statement.index]?.key;
  const what = statement.kind === 'delete' ? 'verwijderen van' : 'wijzigen van';
  return `${what} de rij met ${key ? describeKey(key) : `nummer ${n}`}`;
}
