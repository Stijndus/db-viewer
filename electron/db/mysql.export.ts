import type { Pool, RowDataPacket } from 'mysql2/promise';
import { qualifiedName, quoteIdent } from '../../shared/dialect';
import { AppError } from '../ipc/errors';
import { cancelledExport, EXPORT_BATCH, exportQuery, orderByClause, whereClause } from './common';
import type { RowBatch, RowSource } from './driver';

interface RawQuery {
  on(event: 'fields', fn: (fields: { name: string }[]) => void): RawQuery;
  on(event: 'result', fn: (row: unknown[]) => void): RawQuery;
  on(event: 'end', fn: () => void): RawQuery;
  on(event: 'error', fn: (err: Error) => void): RawQuery;
}
interface RawConnection {
  query(options: { sql: string; rowsAsArray: boolean }): RawQuery;
  pause(): void;
  resume(): void;
}

/**
 * Streams every row on a dedicated connection inside a READ ONLY transaction. The driver's
 * pause/resume keeps memory flat while a batch is being written.
 */
export async function streamRows(
  pool: Pool,
  source: RowSource,
  onBatch: (batch: RowBatch) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const sql =
    source.kind === 'table'
      ? `SELECT * FROM ${qualifiedName(source.database, source.table, 'mysql')}` +
        whereClause(source.where) +
        orderByClause(source.orderBy)
      : exportQuery(source.sql, 'mysql');
  const conn = await pool.getConnection();
  let broken = false;
  try {
    if (source.kind === 'query' && source.database)
      await conn.query(`USE ${quoteIdent(source.database)}`);
    await conn.query('START TRANSACTION READ ONLY');
    const raw = (conn as unknown as { connection: RawConnection }).connection;
    await new Promise<void>((resolve, reject) => {
      let columns: string[] = [];
      let rows: unknown[][] = [];
      let failed = false;
      const fail = (err: unknown) => {
        if (failed) return;
        failed = true;
        broken = true;
        reject(err);
      };
      const onAbort = () => fail(cancelledExport());
      signal.addEventListener('abort', onAbort, { once: true });
      raw
        .query({ sql, rowsAsArray: true })
        .on('fields', (fields) => (columns = fields.map((f) => f.name)))
        .on('result', (row) => {
          if (failed) return;
          rows.push(row);
          if (rows.length >= EXPORT_BATCH) {
            const batch = rows;
            rows = [];
            raw.pause();
            onBatch({ columns, rows: batch }).then(() => raw.resume(), fail);
          }
        })
        .on('end', () => {
          signal.removeEventListener('abort', onAbort);
          if (failed) return;
          onBatch({ columns, rows }).then(resolve, fail);
        })
        .on('error', (err) => {
          signal.removeEventListener('abort', onAbort);
          fail(err);
        });
    });
  } finally {
    // A stopped stream leaves the connection mid-result: never reuse it.
    if (broken) conn.destroy();
    else {
      await conn.query('ROLLBACK').catch(() => undefined);
      conn.release();
    }
  }
}

/** The server's own CREATE TABLE (or CREATE VIEW). */
export async function tableDdl(pool: Pool, database: string, table: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>({
    sql: `SHOW CREATE TABLE ${qualifiedName(database, table, 'mysql')}`,
    rowsAsArray: true,
  });
  const ddl = (rows[0] as unknown as unknown[] | undefined)?.[1];
  if (typeof ddl !== 'string')
    throw new AppError('ER_NO_SUCH_TABLE', `Tabel ${table} bestaat niet.`);
  return ddl;
}
