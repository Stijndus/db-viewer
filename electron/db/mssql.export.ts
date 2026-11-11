import sql from 'mssql';
import { qualifiedName } from '../../shared/dialect';
import {
  cancelledExport,
  ddlFromColumns,
  EXPORT_BATCH,
  exportQuery,
  orderByClause,
  whereClause,
} from './common';
import type { RowBatch, RowSource } from './driver';
import { mssqlError } from './mssql.common';
import { checkFilter, selectExpression } from './mssql.data';
import { columnTypes, listColumns } from './mssql.metadata';

/**
 * Streams rows in a transaction that is rolled back afterwards. A table is selected column by
 * column like the grid does, so DECIMAL, MONEY and dates come out exactly as stored.
 */
export async function streamRows(
  pool: sql.ConnectionPool,
  source: RowSource,
  onBatch: (batch: RowBatch) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let text: string;
  if (source.kind === 'table') {
    checkFilter(source.where);
    const columns = await columnTypes(pool, source.database, source.table);
    const list = columns.length
      ? columns.map((c) => selectExpression(c.name, c.type)).join(', ')
      : '*';
    text =
      `SELECT ${list} FROM ${qualifiedName(source.database, source.table, 'mssql')}` +
      whereClause(source.where) +
      orderByClause(source.orderBy, 'mssql');
  } else {
    text = exportQuery(source.sql, 'mssql');
  }

  const tx = new sql.Transaction(pool);
  await tx.begin().catch((err: unknown) => {
    throw mssqlError(err);
  });
  try {
    const request = new sql.Request(tx);
    request.stream = true;
    request.arrayRowMode = true;
    await new Promise<void>((resolve, reject) => {
      let columns: string[] = [];
      let rows: unknown[][] = [];
      let failed = false;
      const fail = (err: unknown) => {
        if (failed) return;
        failed = true;
        request.cancel();
        reject(err);
      };
      const onAbort = () => fail(cancelledExport());
      signal.addEventListener('abort', onAbort, { once: true });
      request.on(
        'recordset',
        (cols: { name: string }[] | Record<string, { name: string; index: number }>) => {
          // arrayRowMode gives an array; otherwise an object keyed by name.
          columns = Array.isArray(cols)
            ? cols.map((c) => c.name)
            : Object.values(cols)
                .sort((a, b) => a.index - b.index)
                .map((c) => c.name);
        },
      );
      request.on('row', (row: unknown[]) => {
        if (failed) return;
        rows.push(row);
        if (rows.length >= EXPORT_BATCH) {
          const batch = rows;
          rows = [];
          request.pause();
          onBatch({ columns, rows: batch }).then(() => request.resume(), fail);
        }
      });
      request.on('error', (err: unknown) => fail(mssqlError(err)));
      request.on('done', () => {
        signal.removeEventListener('abort', onAbort);
        if (!failed) onBatch({ columns, rows }).then(resolve, fail);
      });
      void request.query(text);
    });
  } finally {
    await tx.rollback().catch(() => undefined);
  }
}

export async function tableDdl(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
): Promise<string> {
  return ddlFromColumns(schema, table, await listColumns(pool, schema, table), 'mssql');
}
