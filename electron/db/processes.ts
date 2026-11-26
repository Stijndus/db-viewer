import {
  parseProcesses,
  processActionSql,
  processListSql,
  type ProcessAction,
  type ProcessDialect,
  type ProcessList,
} from '../../shared/process-list';
import { AppError } from '../ipc/errors';
import type { DbSession } from './driver';

/**
 * The process list is read on one connection of its own per session, kept open while the app is
 * connected: refreshing every few seconds then costs no new logins (and adds no new rows to the
 * list itself). That connection is the one marked "deze lijst".
 */
const TAB = 'process-list';

/** A connection that was ended (by KILL, a restart): opened again on the next statement. */
const LOST =
  /lost connection|gone away|terminating connection|connection.*(closed|reset|ended)|ECONNRESET|broken pipe|not connected|not queryable|connection error/i;

async function runOnce(session: DbSession, sql: string) {
  const result = await session.runScript(TAB, { statements: [sql], maxRows: 10_000 });
  return result.results[0];
}

async function run(session: DbSession, sql: string) {
  let r;
  try {
    r = await runOnce(session, sql);
  } catch {
    r = undefined;
  }
  if (r === undefined || (r.kind === 'error' && LOST.test(r.error.message))) {
    await session.closeEditor(TAB).catch(() => undefined);
    r = await runOnce(session, sql);
  }
  if (r?.kind === 'error') {
    if (/denied|permission|privilege|not allowed|must be a member/i.test(r.error.message)) {
      throw new AppError(
        'ACCESS_DENIED',
        'Deze verbinding mag dat niet op de server.',
        `De server zegt: ${r.error.message}`,
      );
    }
    throw new AppError(r.error.code, r.error.message, r.error.hint);
  }
  return r;
}

export async function listProcesses(
  session: DbSession,
  dialect: ProcessDialect,
): Promise<ProcessList> {
  const r = await run(session, processListSql(dialect));
  const rows = r?.kind === 'rows' ? r.rows : [];
  const text = rows.map((row) => row.map((c) => (typeof c === 'string' ? c : null)));
  return { processes: parseProcesses(dialect, text), at: Date.now() };
}

/**
 * Stops a query or ends a connection. PostgreSQL answers false (not an error) when the process
 * is already gone; that becomes a message too.
 */
export async function stopProcess(
  session: DbSession,
  dialect: ProcessDialect,
  readOnly: boolean,
  action: ProcessAction,
  id: string,
): Promise<void> {
  if (readOnly) {
    throw new AppError(
      'READ_ONLY_CONNECTION',
      'Deze verbinding is alleen-lezen.',
      'Een proces stoppen kan alleen op een verbinding zonder alleen-lezen.',
    );
  }
  const r = await run(session, processActionSql(dialect, action, id));
  if (dialect === 'postgres' && r?.kind === 'rows') {
    const answer = r.rows[0]?.[0];
    if (answer === 'false' || answer === 'f') {
      throw new AppError(
        'PROCESS_GONE',
        `Proces ${id} bestaat niet meer, of mag niet worden gestopt.`,
      );
    }
  }
}
