import type { DbType } from './models';

/**
 * The server's process list: connections and what they run. MySQL/MariaDB (PROCESSLIST),
 * PostgreSQL (pg_stat_activity) and SQL Server (sys.dm_exec_sessions with the requests).
 */

export type ProcessDialect = Exclude<DbType, 'sqlite'>;

export function hasProcesses(type: DbType): type is ProcessDialect {
  return type !== 'sqlite';
}

export interface ServerProcess {
  /** Thread id (MySQL), pid (PostgreSQL) or session id (SQL Server). */
  id: string;
  user: string;
  /** Client host and port, as the server knows it. */
  host: string;
  database: string | null;
  /** MySQL's command (Query, Sleep), PostgreSQL's state, SQL Server's status. */
  state: string;
  /** Seconds in this state: how long the query runs, or how long it has been idle. */
  seconds: number | null;
  /** The running query; for an idle PostgreSQL connection the last one. */
  query: string | null;
  /** Waiting for a lock held by these processes (PostgreSQL, SQL Server). */
  blockedBy: string[];
  /** Nothing running: Sleep, idle, sleeping. */
  idle: boolean;
  /** The server's own workers (replication, autovacuum, system sessions). */
  background: boolean;
  /** The connection that read this list. */
  own: boolean;
  /** PostgreSQL: application_name; SQL Server: program_name. */
  program?: string;
}

export interface ProcessList {
  processes: ServerProcess[];
  /** When the list was read (ms since 1970). */
  at: number;
}

/** Stop only the running query (the connection stays), or end the whole connection. */
export type ProcessAction = 'cancel' | 'kill';

/** SQL Server has no way to stop only the query of another session: KILL ends it. */
export function canCancelQuery(dialect: ProcessDialect): boolean {
  return dialect !== 'mssql';
}

export function processListSql(dialect: ProcessDialect): string {
  switch (dialect) {
    case 'mysql':
      return (
        'SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO, CONNECTION_ID() ' +
        'FROM information_schema.PROCESSLIST ORDER BY ID'
      );
    case 'postgres':
      return (
        "SELECT pid, COALESCE(usename, ''), " +
        "COALESCE(host(client_addr) || ':' || client_port, ''), datname, " +
        'COALESCE(state, backend_type), ' +
        "EXTRACT(EPOCH FROM now() - COALESCE(CASE WHEN state = 'active' THEN query_start ELSE state_change END, backend_start))::bigint, " +
        "NULLIF(query, ''), pg_backend_pid(), backend_type, " +
        "array_to_string(pg_blocking_pids(pid), ','), application_name " +
        'FROM pg_stat_activity ORDER BY pid'
      );
    case 'mssql':
      return (
        'SELECT s.session_id, s.login_name, ' +
        "COALESCE(s.host_name, '') + COALESCE(':' + CAST(c.client_tcp_port AS varchar(10)), ''), " +
        'DB_NAME(COALESCE(r.database_id, s.database_id)), COALESCE(r.status, s.status), ' +
        'COALESCE(r.total_elapsed_time / 1000, DATEDIFF(second, COALESCE(s.last_request_end_time, s.login_time), GETDATE())), ' +
        't.text, @@SPID, s.is_user_process, ' +
        "CASE WHEN r.blocking_session_id > 0 THEN CAST(r.blocking_session_id AS varchar(10)) ELSE '' END, " +
        's.program_name, r.command ' +
        'FROM sys.dm_exec_sessions s ' +
        'LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id ' +
        'LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL ' +
        'OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t ' +
        'ORDER BY s.session_id'
      );
  }
}

/** The statement that stops a process; the id must be a number (it is checked). */
export function processActionSql(
  dialect: ProcessDialect,
  action: ProcessAction,
  id: string,
): string {
  if (!/^\d{1,10}$/.test(id)) throw new Error(`Ongeldig proces-id: ${id}`);
  switch (dialect) {
    case 'mysql':
      return action === 'cancel' ? `KILL QUERY ${id}` : `KILL ${id}`;
    case 'postgres':
      return action === 'cancel'
        ? `SELECT pg_cancel_backend(${id})`
        : `SELECT pg_terminate_backend(${id})`;
    case 'mssql':
      if (action === 'cancel') throw new Error('SQL Server kan alleen de hele sessie beëindigen.');
      return `KILL ${id}`;
  }
}

type Raw = (string | null)[];

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
};
const str = (v: string | null | undefined) => v ?? '';

/** Rows of processListSql, as text, into processes. */
export function parseProcesses(dialect: ProcessDialect, rows: Raw[]): ServerProcess[] {
  return rows.map((r) => {
    switch (dialect) {
      case 'mysql': {
        const command = str(r[4]);
        const user = str(r[1]);
        const state = str(r[6]);
        return {
          id: str(r[0]),
          user,
          host: str(r[2]),
          database: r[3] ?? null,
          state: command === 'Query' && state ? `Query · ${state}` : command,
          seconds: num(r[5]),
          query: r[7] ?? null,
          blockedBy: [],
          idle: command === 'Sleep',
          background:
            /^(Daemon|Binlog Dump|Binlog Dump GTID|Connect|Slave_IO|Slave_SQL|Slave_worker)$/.test(
              command,
            ) ||
            user === 'system user' ||
            user === 'event_scheduler',
          own: str(r[0]) === str(r[8]),
        };
      }
      case 'postgres': {
        const state = str(r[4]);
        return {
          id: str(r[0]),
          user: str(r[1]),
          host: str(r[2]),
          database: r[3] ?? null,
          state,
          seconds: num(r[5]),
          query: r[6] ?? null,
          blockedBy: str(r[9]).split(',').filter(Boolean),
          idle: state === 'idle',
          background: str(r[8]) !== 'client backend',
          own: str(r[0]) === str(r[7]),
          ...(r[10] ? { program: r[10] } : {}),
        };
      }
      case 'mssql': {
        const status = str(r[4]);
        const command = str(r[11]);
        return {
          id: str(r[0]),
          user: str(r[1]),
          host: str(r[2]),
          database: r[3] ?? null,
          state: command && status !== 'sleeping' ? `${status} · ${command}` : status,
          seconds: num(r[5]),
          query: r[6] ?? null,
          blockedBy: str(r[9]) ? [str(r[9])] : [],
          idle: status === 'sleeping',
          background: !['1', 'true', 'True'].includes(str(r[8])),
          own: str(r[0]) === str(r[7]),
          ...(r[10] ? { program: r[10] } : {}),
        };
      }
    }
  });
}
