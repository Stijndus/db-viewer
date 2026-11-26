import { randomUUID } from 'node:crypto';
import { indexListSql, parseIndexes, type IndexInfo } from '../../shared/ddl';
import { stringLiteral } from '../../shared/dialect';
import type { DbType } from '../../shared/models';
import { AppError } from '../ipc/errors';
import type { DbSession } from './driver';

/**
 * A table's indexes, and running structure changes (ALTER, CREATE and DROP) on a connection of
 * its own. The statements come from the renderer, where they were shown before running.
 */

export async function listIndexes(
  session: DbSession,
  dialect: DbType,
  database: string,
  table: string,
): Promise<IndexInfo[]> {
  const tab = `structure-${randomUUID()}`;
  try {
    const result = await session.runScript(tab, {
      statements: [indexListSql(dialect, database, table)],
      maxRows: 10_000,
    });
    const r = result.results[0];
    if (r?.kind === 'error') throw new AppError(r.error.code, r.error.message, r.error.hint);
    const rows = r?.kind === 'rows' ? r.rows : [];
    const indexes = parseIndexes(
      rows.map((row) => row.map((c) => (typeof c === 'string' ? c : null))),
    );
    // SQLite: an INTEGER PRIMARY KEY is the rowid itself and has no index of its own.
    if (dialect === 'sqlite' && !indexes.some((i) => i.primary)) {
      const pk = await session.runScript(tab, {
        statements: [
          `SELECT name FROM pragma_table_info(${stringLiteral(table, 'sqlite')}) WHERE pk > 0 ORDER BY pk`,
        ],
        maxRows: 100,
      });
      const p = pk.results[0];
      const cols = p?.kind === 'rows' ? p.rows.map((row) => String(row[0])) : [];
      if (cols.length)
        indexes.unshift({ name: 'PRIMARY', columns: cols, unique: true, primary: true });
    }
    return indexes;
  } finally {
    await session.closeEditor(tab).catch(() => undefined);
  }
}

/**
 * Runs the statements one after the other and stops at the first error. Most databases commit
 * structure changes at once (MySQL always), so what ran before an error stays.
 */
export async function applyDdl(
  session: DbSession,
  readOnly: boolean,
  database: string,
  statements: string[],
): Promise<{ ran: number }> {
  if (readOnly) {
    throw new AppError(
      'READ_ONLY_CONNECTION',
      'Deze verbinding is alleen-lezen.',
      'De structuur wijzigen kan alleen op een verbinding zonder alleen-lezen.',
    );
  }
  const tab = `ddl-${randomUUID()}`;
  try {
    // The statements name their table in full; no USE needed.
    void database;
    const result = await session.runScript(tab, { statements, maxRows: 0 });
    const failed = result.results.findIndex((r) => r.kind === 'error');
    if (failed >= 0) {
      const r = result.results[failed]!;
      const message = r.kind === 'error' ? r.error.message : 'Mislukt';
      throw new AppError(
        'DDL_FAILED',
        message,
        failed > 0
          ? `${failed} van de ${statements.length} statements waren al uitgevoerd.`
          : undefined,
      );
    }
    return { ran: result.results.length };
  } finally {
    await session.closeEditor(tab).catch(() => undefined);
  }
}
