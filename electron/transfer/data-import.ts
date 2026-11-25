import type {
  ColumnInfo,
  DataImportRequest,
  DbType,
  StatementResult,
  TransferProgress,
} from '../../shared/models';
import {
  beginSql,
  commitSql,
  deleteAllSql,
  foreignKeySql,
  IMPORT_BATCH_CHARS,
  IMPORT_BATCH_ROWS,
  identityInsertSql,
  importLiteral,
  insertRowsSql,
  isIdentityColumn,
  isWritableColumn,
  type ImportCell,
} from '../../shared/import-sql';
import type { DbSession } from '../db/driver';
import { AppError } from '../ipc/errors';
import { openDataFile } from './data-file';

const MAX_ERRORS = 100;
const PROGRESS_MS = 200;

/**
 * Loads a CSV, JSON or Excel file into an existing table. Rows go in as multi-row INSERTs (or the
 * dialect's upsert) on a session of its own, like the SQL import. "rollback" runs everything in
 * one transaction that is undone at the first error or a stop; "skip" commits as it goes and
 * retries a failing batch row by row, so only the bad rows are left out (and listed).
 */
export async function importData(
  session: DbSession,
  dialect: DbType,
  readOnly: boolean,
  request: DataImportRequest,
  jobId: string,
  report: (progress: TransferProgress) => void,
  signal: AbortSignal,
): Promise<TransferProgress> {
  if (readOnly) {
    throw new AppError(
      'READ_ONLY_CONNECTION',
      'Deze verbinding is alleen-lezen.',
      'Importeren wijzigt de database. Gebruik een verbinding zonder alleen-lezen.',
    );
  }
  const progress: TransferProgress = {
    jobId,
    kind: 'import',
    unit: 'rows',
    phase: 'running',
    bytes: 0,
    totalBytes: null,
    statements: 0,
    failed: 0,
    errors: [],
  };

  const tableColumns = await session.listColumns(request.database, request.table);
  const byName = new Map(tableColumns.map((c) => [c.name, c]));
  const mapping = request.mapping.map((m) => {
    const column = byName.get(m.target);
    if (!column || !isWritableColumn(column)) {
      throw new AppError(
        'IMPORT_COLUMN',
        `De kolom ${m.target} bestaat niet of kan niet worden gevuld.`,
      );
    }
    return { source: m.source, column };
  });
  if (mapping.length === 0) {
    throw new AppError(
      'IMPORT_NO_COLUMNS',
      'Koppel minstens één kolom uit het bestand aan de tabel.',
    );
  }
  const targets = mapping.map((m) => m.column.name);
  if (new Set(targets).size !== targets.length) {
    throw new AppError(
      'IMPORT_COLUMN',
      'Elke tabelkolom kan maar aan één bestandskolom worden gekoppeld.',
    );
  }
  const keyColumns = tableColumns.filter((c) => c.key === 'primary').map((c) => c.name);
  if (request.mode === 'upsert') {
    if (keyColumns.length === 0) {
      throw new AppError(
        'IMPORT_NO_KEY',
        'Bijwerken kan alleen bij een tabel met een primaire sleutel.',
        'Kies "Toevoegen" of "Tabel eerst leegmaken".',
      );
    }
    const missing = keyColumns.filter((k) => !targets.includes(k));
    if (missing.length > 0) {
      throw new AppError(
        'IMPORT_NO_KEY',
        `Koppel de sleutelkolom ${missing.join(', ')} om bestaande rijen te herkennen.`,
      );
    }
  }

  const reader = await openDataFile(request);
  progress.totalBytes = reader.total;
  const tab = `data-import-${jobId}`;
  const transaction = request.onError === 'rollback';
  const identity =
    mapping.some((m) => isIdentityColumn(m.column, dialect)) &&
    identityInsertSql(dialect, request.database, request.table, true);
  const fkOff = request.disableForeignKeys ? foreignKeySql(dialect, false) : null;

  let lastReport = 0;
  const tick = (force = false) => {
    progress.bytes = reader.read();
    const now = Date.now();
    if (force || now - lastReport >= PROGRESS_MS) {
      lastReport = now;
      report({ ...progress, errors: [...progress.errors] });
    }
  };
  const onAbort = () => {
    void reader.close();
    void session.cancelScript(tab).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  /** Runs statements; the first error is returned, not thrown. */
  const run = async (statements: string[]) => {
    if (signal.aborted) throw cancelled();
    const result = await session.runScript(tab, { statements, maxRows: null });
    const failed = result.results.find((r) => r.kind === 'error') as
      Extract<StatementResult, { kind: 'error' }> | undefined;
    return failed?.error.message ?? null;
  };
  const must = async (statements: string[]) => {
    const message = await run(statements);
    if (message) throw new AppError('IMPORT_FAILED', message);
  };

  const literalRow = (row: ImportCell[]) =>
    mapping.map((m) =>
      importLiteral(row[m.source] ?? null, m.column, dialect, request.emptyAsNull),
    );
  const sqlFor = (rows: string[][]) =>
    insertRowsSql(
      dialect,
      request.database,
      request.table,
      targets,
      rows,
      request.mode,
      keyColumns,
    );
  const preview = (row: ImportCell[]) =>
    mapping
      .map((m) => `${m.column.name}=${row[m.source] === null ? 'NULL' : String(row[m.source])}`)
      .join(', ')
      .slice(0, 300);

  let batch: { number: number; row: ImportCell[]; literals: string[] }[] = [];
  let batchChars = 0;
  let rowNumber = 0;

  const flush = async () => {
    const pending = batch;
    batch = [];
    batchChars = 0;
    if (pending.length === 0) return;
    const message = await run([sqlFor(pending.map((p) => p.literals))]);
    if (!message) {
      progress.statements += pending.length;
      return;
    }
    if (signal.aborted) throw cancelled();
    if (transaction) {
      // Which row it was: the server's message rarely says. One by one, inside the transaction,
      // until the bad row fails again; PostgreSQL first needs the failed statement undone.
      if (dialect === 'postgres') await run(['ROLLBACK TO SAVEPOINT dbv_batch']);
      let bad: { number: number; row: ImportCell[]; message: string } | null = null;
      if (pending.length > 1) {
        for (const p of pending) {
          if (dialect === 'postgres') await run(['SAVEPOINT dbv_row']);
          const one = await run([sqlFor([p.literals])]);
          if (one) {
            bad = { number: p.number, row: p.row, message: one };
            break;
          }
        }
      }
      if (signal.aborted) throw cancelled();
      progress.failed++;
      progress.errors.push(
        bad
          ? { statement: bad.number, sql: preview(bad.row), message: bad.message }
          : {
              statement: pending[0]!.number,
              sql:
                pending.length === 1
                  ? preview(pending[0]!.row)
                  : `Rij ${pending[0]!.number} t/m ${pending.at(-1)!.number}`,
              message,
            },
      );
      throw new StopAtError();
    }
    for (const p of pending) {
      const one = await run([sqlFor([p.literals])]);
      if (!one) {
        progress.statements++;
        continue;
      }
      if (signal.aborted) throw cancelled();
      progress.failed++;
      if (progress.errors.length < MAX_ERRORS) {
        progress.errors.push({ statement: p.number, sql: preview(p.row), message: one });
      }
    }
  };

  try {
    // Foreign keys first: SQLite ignores the pragma inside a transaction.
    if (fkOff) await must([fkOff]);
    if (identity) await must([identity]);
    if (transaction) await must([beginSql(dialect)]);
    if (request.mode === 'replace') {
      await must([deleteAllSql(dialect, request.database, request.table)]);
    }
    for await (const row of reader.rows) {
      if (signal.aborted) throw cancelled();
      rowNumber++;
      const literals = literalRow(row);
      batch.push({ number: rowNumber, row, literals });
      batchChars += literals.reduce((n, l) => n + l.length + 2, 0);
      if (batch.length >= IMPORT_BATCH_ROWS || batchChars >= IMPORT_BATCH_CHARS) {
        if (transaction && dialect === 'postgres') await must(['SAVEPOINT dbv_batch']);
        await flush();
        tick();
      }
    }
    if (transaction && dialect === 'postgres' && batch.length) await must(['SAVEPOINT dbv_batch']);
    await flush();
    if (transaction) await must([commitSql(dialect)]);
    if (identity) await must([identityInsertSql(dialect, request.database, request.table, false)]);
    if (fkOff) await must([foreignKeySql(dialect, true)!]);
    progress.phase = progress.failed > 0 ? 'done-with-errors' : 'done';
  } catch (err) {
    if (err instanceof StopAtError) {
      progress.phase = 'stopped-at-error';
      progress.rolledBack = true;
      progress.statements = 0;
    } else if (signal.aborted) {
      progress.phase = 'cancelled';
      if (transaction) {
        progress.rolledBack = true;
        progress.statements = 0;
      }
    } else if (err instanceof AppError && err.code === 'IMPORT_FAILED') {
      progress.phase = 'failed';
      progress.rolledBack = transaction;
      progress.error = { code: err.code, message: err.message };
    } else throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.close().catch(() => undefined);
    // Closing the session rolls back an open transaction (on stop or error) and ends the
    // session's foreign key and identity settings with it.
    await session.closeEditor(tab).catch(() => undefined);
  }
  tick(true);
  return progress;
}

class StopAtError extends Error {}

function cancelled(): AppError {
  return new AppError('CANCELLED', 'Import gestopt.');
}

/** For tests: the columns an import can fill. */
export function writableColumns(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter(isWritableColumn);
}
