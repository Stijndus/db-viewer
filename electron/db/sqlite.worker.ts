/**
 * One SQLite connection in its own process. node:sqlite is synchronous and cannot be interrupted
 * from JavaScript: running it in a child process keeps the app responsive, and a query is stopped by
 * ending the process. Electron starts it as a utility process; the tests fork it with Node.
 *
 * Self-contained on purpose (only Node built-ins, only erasable TypeScript), so Node can run the
 * source directly in tests.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type WorkerRequest =
  | { op: 'open'; path: string; readOnly: boolean }
  | {
      op: 'query';
      sql: string;
      params?: (string | null)[];
      /** Rows to fetch at most; null = all. */
      maxRows?: number | null;
      /** Run with PRAGMA query_only, so the statement cannot write. */
      guard?: boolean;
    }
  | { op: 'exec'; sql: string }
  | { op: 'close' };

export interface QueryResponse {
  /** Columns of a statement that returns rows; empty for anything else. */
  columns: { name: string; type: string | null }[];
  rows: unknown[][];
  /** More rows existed than maxRows. */
  more: boolean;
  changes: number;
  lastInsertRowid: string | null;
}

let db: DatabaseSync | null = null;

function handle(req: WorkerRequest): unknown {
  switch (req.op) {
    case 'open': {
      db = new DatabaseSync(req.path, { readOnly: req.readOnly });
      db.exec('PRAGMA busy_timeout = 5000');
      return query({ op: 'query', sql: 'SELECT sqlite_version()' }).rows[0]?.[0];
    }
    case 'query':
      return query(req);
    case 'exec':
      connection().exec(req.sql);
      return null;
    case 'close':
      db?.close();
      db = null;
      return null;
  }
}

function connection(): DatabaseSync {
  if (!db) throw Object.assign(new Error('Database is niet geopend.'), { code: 'NOT_CONNECTED' });
  return db;
}

function query(req: Extract<WorkerRequest, { op: 'query' }>): QueryResponse {
  const conn = connection();
  if (req.guard) conn.exec('PRAGMA query_only = 1');
  try {
    // Only the first statement of the text is compiled; anything after it is ignored.
    const stmt: StatementSync = conn.prepare(req.sql);
    stmt.setReadBigInts(true); // INTEGER beyond 2^53 stays exact
    const columns = stmt.columns().map((c) => ({ name: c.name, type: c.type ?? null }));
    const params = req.params ?? [];
    if (columns.length === 0) {
      const r = stmt.run(...params);
      return {
        columns,
        rows: [],
        more: false,
        changes: Number(r.changes),
        lastInsertRowid: r.lastInsertRowid === undefined ? null : String(r.lastInsertRowid),
      };
    }
    stmt.setReturnArrays(true);
    const max = req.maxRows ?? Infinity;
    const rows: unknown[][] = [];
    let more = false;
    for (const row of stmt.iterate(...params)) {
      if (rows.length >= max) {
        more = true;
        break; // ends the iterator, which resets the statement
      }
      rows.push(row as unknown as unknown[]);
    }
    return { columns, rows, more, changes: 0, lastInsertRowid: null };
  } finally {
    if (req.guard) conn.exec('PRAGMA query_only = 0');
  }
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function reply(message: unknown): void {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (port) port.postMessage(message);
  else process.send?.(message);
}

function onMessage(message: { id: number; request: WorkerRequest }): void {
  try {
    const result = handle(message.request);
    reply({ id: message.id, ok: true, result });
  } catch (err) {
    const e = err as { message?: string; code?: string; errcode?: number; errstr?: string };
    reply({
      id: message.id,
      ok: false,
      error: {
        message: String(e.message ?? err),
        code: e.code,
        errcode: e.errcode,
        errstr: e.errstr,
      },
    });
  }
}

// Electron utility process: messages arrive on process.parentPort. Node fork: on process itself.
const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (port)
  port.on('message', (event) => onMessage(event.data as { id: number; request: WorkerRequest }));
else
  process.on('message', (message) => onMessage(message as { id: number; request: WorkerRequest }));
