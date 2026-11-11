import { qualifiedName } from '../../shared/dialect';
import { cancelledExport, EXPORT_BATCH, exportQuery, orderByClause, whereClause } from './common';
import type { RowBatch, RowSource } from './driver';
import { SqliteConnection } from './sqlite.connection';

/**
 * Reads on a connection of its own, opened read-only, through a cursor in the worker: the file
 * cannot be changed by the export, and a stop ends just this worker.
 */
export async function streamRows(
  file: string,
  source: RowSource,
  onBatch: (batch: RowBatch) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const sql =
    source.kind === 'table'
      ? `SELECT * FROM ${qualifiedName(source.database, source.table, 'sqlite')}` +
        whereClause(source.where) +
        orderByClause(source.orderBy, 'sqlite')
      : exportQuery(source.sql, 'sqlite');
  const conn = new SqliteConnection(file, true);
  const onAbort = () => void conn.stop();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const columns = await conn.openCursor(sql);
    for (;;) {
      const { rows, done } = await conn.nextRows(EXPORT_BATCH);
      await onBatch({ columns, rows });
      if (done) break;
    }
  } catch (err) {
    if (signal.aborted) throw cancelledExport();
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await conn.close();
  }
}

/** SQLite keeps each table's CREATE statement as written. */
export async function tableDdl(
  reader: SqliteConnection,
  database: string,
  table: string,
): Promise<string> {
  const res = await reader.query(
    `SELECT sql FROM ${qualifiedName(database, 'sqlite_schema', 'sqlite')} WHERE name = ? AND type IN ('table', 'view')`,
    [table],
  );
  const ddl = res.rows[0]?.[0];
  if (typeof ddl !== 'string')
    throw Object.assign(new Error(`Tabel ${table} bestaat niet.`), { code: 'ER_NO_SUCH_TABLE' });
  return ddl;
}
