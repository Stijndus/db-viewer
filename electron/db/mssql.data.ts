import sql from 'mssql';
import type { ApplyResult, ChangeSet } from '../../shared/changes';
import { qualifiedName, quoteIdent } from '../../shared/dialect';
import type { RowsPage, RowsRequest, SortKey } from '../../shared/models';
import { allWords } from '../../shared/sql';
import { AppError } from '../ipc/errors';
import { orderByClause, saveChanges, toCell, whereClause } from './common';
import { columnType, mssqlError, mssqlValue } from './mssql.common';
import { columnTypes, readTarget } from './mssql.metadata';

/**
 * How each column is selected for the grid. DECIMAL, MONEY and dates are converted to text by the
 * server, so they show exactly as stored (the driver would turn them into JavaScript numbers and
 * Dates, losing digits and precision).
 */
export function selectExpression(name: string, type: string): string {
  const col = quoteIdent(name, 'mssql');
  const t = type.toLowerCase();
  let expr = col;
  if (['datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'].includes(t))
    expr = `CONVERT(nvarchar(40), ${col}, 121)`;
  else if (t === 'date') expr = `CONVERT(nvarchar(10), ${col}, 23)`;
  else if (t === 'money' || t === 'smallmoney')
    expr = `CONVERT(nvarchar(40), ${col}, 2)`; // 4 decimals
  else if (['time', 'decimal', 'numeric', 'sql_variant'].includes(t))
    expr = `CAST(${col} AS nvarchar(4000))`;
  else if (['hierarchyid', 'geometry', 'geography'].includes(t)) expr = `${col}.ToString()`;
  return expr === col ? col : `${expr} AS ${col}`;
}

function orderBy(keys: SortKey[]): string {
  // OFFSET ... FETCH needs an ORDER BY; without a sort, keep the server's order.
  return keys.length > 0 ? orderByClause(keys, 'mssql') : ' ORDER BY (SELECT NULL)';
}

export function buildSelect(
  schema: string,
  table: string,
  columns: { name: string; type: string }[],
  req: RowsRequest,
): string {
  const limit = Math.trunc(req.limit) + 1; // one extra row reveals whether a next page exists
  const offset = Math.trunc(req.offset);
  const list =
    columns.length > 0 ? columns.map((c) => selectExpression(c.name, c.type)).join(', ') : '*';
  return (
    `SELECT ${list} FROM ${qualifiedName(schema, table, 'mssql')}` +
    whereClause(req.where) +
    orderBy(req.orderBy) +
    ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
  );
}

/** Words that have no place in a filter condition: they would start a second statement. */
const NOT_IN_FILTER = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'REVOKE',
  'DENY',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'INTO',
  'DBCC',
  'BACKUP',
  'RESTORE',
  'SHUTDOWN',
  'KILL',
  'USE',
  'DECLARE',
  'SET',
  'GO',
]);

/**
 * A SQL Server batch can hold several statements, so a filter could smuggle one in. The read runs
 * in a transaction that is always rolled back, and filters containing statement words are refused.
 */
export function checkFilter(where: string | undefined): void {
  if (!where) return;
  const bad = allWords(where, 'mssql').find((w) => NOT_IN_FILTER.has(w));
  if (bad) {
    throw new AppError(
      'FILTER_NOT_ALLOWED',
      'Het filter mag geen gegevens wijzigen.',
      `${bad} hoort niet in een filter. Gebruik de SQL-editor voor andere statements.`,
    );
  }
}

/** Runs one read batch in a transaction that is rolled back, whatever happens. */
async function readOnly<T>(
  pool: sql.ConnectionPool,
  fn: (request: sql.Request) => Promise<T>,
): Promise<T> {
  const tx = new sql.Transaction(pool);
  await tx.begin().catch((err: unknown) => {
    throw mssqlError(err);
  });
  try {
    const request = new sql.Request(tx);
    request.arrayRowMode = true;
    return await fn(request);
  } catch (err) {
    throw mssqlError(err);
  } finally {
    await tx.rollback().catch(() => undefined);
  }
}

export async function readRows(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
  req: RowsRequest,
): Promise<RowsPage> {
  checkFilter(req.where);
  const columns = await columnTypes(pool, schema, table).catch((err: unknown) => {
    throw mssqlError(err);
  });
  return readOnly(pool, async (request) => {
    const started = performance.now();
    const res = await request.query(buildSelect(schema, table, columns, req));
    const durationMs = Math.round(performance.now() - started);
    const recordset = res.recordset as unknown as unknown[][];
    const meta =
      (res as unknown as { columns?: { name: string; type?: unknown }[][] }).columns?.[0] ?? [];
    const types = meta.map(columnType);
    return {
      columns: meta.map((c) => c.name),
      rows: recordset
        .slice(0, req.limit)
        .map((row) => row.map((v, i) => toCell(mssqlValue(v, types[i] ?? '')))),
      hasMore: recordset.length > req.limit,
      durationMs,
    };
  });
}

export async function countRows(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
  where?: string,
): Promise<number> {
  checkFilter(where);
  return readOnly(pool, async (request) => {
    const res = await request.query(
      `SELECT COUNT_BIG(*) FROM ${qualifiedName(schema, table, 'mssql')}${whereClause(where)}`,
    );
    return Number((res.recordset as unknown as unknown[][])[0]?.[0] ?? 0);
  });
}

export async function applyChanges(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
  changes: ChangeSet,
): Promise<ApplyResult> {
  const tx = new sql.Transaction(pool);
  let begun = false;
  const wrap = async <T>(p: Promise<T>) => {
    try {
      return await p;
    } catch (err) {
      throw mssqlError(err);
    }
  };
  return saveChanges(
    {
      target: () => wrap(readTarget(() => pool.request(), schema, table)),
      begin: async () => {
        await wrap(tx.begin());
        begun = true;
      },
      execute: async (s) => {
        const request = new sql.Request(tx);
        s.params.forEach((value, i) => request.input(`p${i + 1}`, sql.NVarChar(sql.MAX), value));
        const res = await wrap(request.query(s.sql));
        return res.rowsAffected[0] ?? 0;
      },
      commit: () => wrap(tx.commit()),
      rollback: async () => {
        if (begun) await tx.rollback().catch(() => undefined);
      },
    },
    schema,
    table,
    changes,
    'mssql',
  );
}
