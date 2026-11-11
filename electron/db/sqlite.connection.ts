import { fork } from 'node:child_process';
import path from 'node:path';
import type { QueryResponse, WorkerRequest } from './sqlite.worker';

/** A child process running sqlite.worker: Electron's utility process, or a Node fork in tests. */
interface Child {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

function startWorker(): Child {
  if (process.versions['electron'] && process.type === 'browser') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { utilityProcess } = require('electron') as typeof import('electron');
    const child = utilityProcess.fork(path.join(__dirname, 'sqlite-worker.js'), [], {
      serviceName: 'DB Viewer SQLite',
      stdio: 'ignore',
    });
    return {
      postMessage: (m) => child.postMessage(m),
      onMessage: (l) => child.on('message', l),
      onExit: (l) => child.once('exit', l),
      kill: () => void child.kill(),
    };
  }
  const child = fork(path.join(__dirname, 'sqlite.worker.ts'), [], {
    serialization: 'advanced', // BigInt and Uint8Array survive the trip
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return {
    postMessage: (m) => child.send(m as never),
    onMessage: (l) => child.on('message', l),
    onExit: (l) => child.once('exit', l),
    kill: () => void child.kill('SIGKILL'),
  };
}

/** Error codes for what node:sqlite reports, matching the app's error translations. */
export function sqliteError(raw: {
  message: string;
  code?: string;
  errcode?: number;
  errstr?: string;
}): Error & { code: string; sqlMessage: string } {
  const message = raw.message;
  let code = raw.code && raw.code !== 'ERR_SQLITE_ERROR' ? raw.code : 'SQLITE_ERROR';
  if (/no such column/i.test(message)) code = 'SQLITE_NO_COLUMN';
  else if (/no such table/i.test(message)) code = 'SQLITE_NO_TABLE';
  else if (/syntax error|incomplete input|unrecognized token/i.test(message))
    code = 'SQLITE_SYNTAX';
  else if (raw.errcode !== undefined) {
    const byNumber: Record<number, string> = {
      5: 'SQLITE_BUSY',
      6: 'SQLITE_BUSY',
      8: 'SQLITE_READONLY',
      9: 'SQLITE_INTERRUPT',
      14: 'SQLITE_CANTOPEN',
      26: 'SQLITE_NOTADB',
    };
    code = byNumber[raw.errcode & 0xff] ?? code;
  }
  return Object.assign(new Error(message), { code, sqlMessage: message });
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string; errcode?: number; errstr?: string };
}

interface Running {
  worker: Child;
  /** Requests sent to this worker that have no answer yet. */
  pending: Map<number, Pending>;
}

const interrupted = () =>
  Object.assign(new Error('Query afgebroken.'), {
    code: 'SQLITE_INTERRUPT',
    sqlMessage: 'Query afgebroken.',
  });

/**
 * One SQLite connection living in a child process. Requests run one at a time, in order. `stop()`
 * ends the process (the only way to interrupt a running query); the next request reopens it.
 */
export class SqliteConnection {
  private current: Running | null = null;
  private opening: Promise<string> | null = null;
  private nextId = 1;
  version = '';

  constructor(
    private readonly file: string,
    private readonly readOnly: boolean,
  ) {}

  /** Opens the database (again, after a stop) and returns the SQLite version. */
  open(): Promise<string> {
    if (!this.opening) {
      const running: Running = { worker: startWorker(), pending: new Map() };
      this.current = running;
      running.worker.onMessage((message) => {
        const m = message as WorkerReply;
        const p = running.pending.get(m.id);
        if (!p) return;
        running.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(sqliteError(m.error ?? { message: 'Onbekende fout.' }));
      });
      const fail = (err: unknown) => {
        for (const p of running.pending.values()) p.reject(err);
        running.pending.clear();
        if (this.current === running) {
          this.current = null;
          this.opening = null;
        }
      };
      running.worker.onExit(() => fail(interrupted()));
      const opening = this.send<string>({
        op: 'open',
        path: this.file,
        readOnly: this.readOnly,
      }).then((v) => (this.version = String(v)));
      this.opening = opening;
      opening.catch(() => {
        if (this.opening === opening) void this.stop();
      });
    }
    return this.opening;
  }

  async query(
    sql: string,
    params?: (string | null)[],
    options: { maxRows?: number | null; guard?: boolean; timeoutMs?: number } = {},
  ): Promise<QueryResponse> {
    await this.open();
    const request = this.send<QueryResponse>({
      op: 'query',
      sql,
      params,
      maxRows: options.maxRows,
      guard: options.guard,
    });
    if (!options.timeoutMs) return request;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }));
        void this.stop();
      }, options.timeoutMs);
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async exec(sql: string): Promise<void> {
    await this.open();
    await this.send({ op: 'exec', sql });
  }

  /** True while the worker has unanswered requests. */
  get busy(): boolean {
    return (this.current?.pending.size ?? 0) > 0;
  }

  /** Ends the worker, interrupting whatever runs; open transactions are rolled back. */
  async stop(): Promise<void> {
    const running = this.current;
    this.current = null;
    this.opening = null;
    if (running) running.worker.kill();
  }

  async close(): Promise<void> {
    if (this.current) await this.send({ op: 'close' }).catch(() => undefined);
    await this.stop();
  }

  private send<T>(request: WorkerRequest): Promise<T> {
    const running = this.current;
    if (!running) return Promise.reject(interrupted());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      running.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      running.worker.postMessage({ id, request });
    });
  }
}
