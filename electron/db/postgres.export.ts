import type pg from 'pg';
import Cursor from 'pg-cursor';
import { qualifiedName, quoteIdent } from '../../shared/dialect';
import {
  cancelledExport,
  ddlFromColumns,
  EXPORT_BATCH,
  exportQuery,
  orderByClause,
  whereClause,
} from './common';
import type { RowBatch, RowSource } from './driver';
import { pgError, RAW_TYPES } from './postgres.common';
import { listColumns } from './postgres.metadata';

/** Reads through a cursor, a batch at a time, in a READ ONLY transaction. */
export async function streamRows(
  pool: pg.Pool,
  source: RowSource,
  onBatch: (batch: RowBatch) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const sql =
    source.kind === 'table'
      ? `SELECT * FROM ${qualifiedName(source.database, source.table, 'postgres')}` +
        whereClause(source.where) +
        orderByClause(source.orderBy, 'postgres')
      : exportQuery(source.sql, 'postgres');
  const client = await pool.connect();
  let broken = false;
  const onAbort = () => {
    broken = true;
    // Ends the connection: the server stops the query, the read below fails.
    (
      client as unknown as { connection?: { stream?: { destroy(): void } } }
    ).connection?.stream?.destroy();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.query('BEGIN READ ONLY');
    if (source.kind === 'query' && source.database)
      await client.query(`SET LOCAL search_path TO ${quoteIdent(source.database, 'postgres')}`);
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: RAW_TYPES }));
    for (;;) {
      const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: string[] }>(
        (resolve, reject) =>
          cursor.read(EXPORT_BATCH, (err, rows, result) => {
            if (err) reject(err);
            else
              resolve({
                rows: rows as unknown[][],
                fields: ((result as unknown as { fields?: { name: string }[] }).fields ?? []).map(
                  (f) => f.name,
                ),
              });
          }),
      );
      if (signal.aborted) throw cancelledExport();
      await onBatch({ columns: fields, rows });
      if (rows.length < EXPORT_BATCH) break;
    }
    await new Promise<void>((resolve) => cursor.close(() => resolve()));
  } catch (err) {
    if (signal.aborted) throw cancelledExport();
    broken = true;
    throw pgError(err);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!broken) await client.query('ROLLBACK').catch(() => undefined);
    client.release(broken ? true : undefined);
  }
}

export async function tableDdl(pool: pg.Pool, schema: string, table: string): Promise<string> {
  return ddlFromColumns(schema, table, await listColumns(pool, schema, table), 'postgres');
}
