import sql from 'mssql';
import type { RunRequest, RunResult, StatementResult } from '../../shared/models';
import { classify, readOnlyViolation } from '../../shared/sql';
import { AppError, toSqlError } from '../ipc/errors';
import { HARD_ROW_CAP, toCell } from './common';
import { columnType, mssqlError, mssqlValue, poolConfig } from './mssql.common';
import type { ConnectionConfig } from './driver';

interface Editor {
  pool: sql.ConnectionPool;
  running: sql.Request | null;
  broken: boolean;
}

/** Rows read and dropped after the limit before a result is cut off by stopping the batch. */
const DISCARD_CAP = HARD_ROW_CAP;

/**
 * One dedicated connection per SQL tab (a pool of exactly one), so USE, #temp tables and
 * transactions carry over between runs. Variables live per batch, as in SQL Server's own tools.
 * Each batch runs as sent (not through sp_executesql) and returns one result per statement in it.
 */
export class MssqlEditorSessions {
  private readonly editors = new Map<string, Promise<Editor>>();

  constructor(private readonly cfg: ConnectionConfig) {}

  async run(tabId: string, req: RunRequest): Promise<RunResult> {
    const editor = await this.get(tabId).catch((err: unknown) => {
      throw mssqlError(err, 'connect');
    });
    if (editor.running) {
      throw new AppError(
        'BUSY',
        'Er loopt al een query in dit tabblad.',
        'Wacht tot hij klaar is of klik op Stop.',
      );
    }
    const limit = Math.min(req.maxRows ?? HARD_ROW_CAP, HARD_ROW_CAP);
    const results: StatementResult[] = [];
    try {
      for (const [index, batch] of req.statements.entries()) {
        const violation = this.cfg.readOnly ? readOnlyViolation(batch, 'mssql') : null;
        if (violation) {
          results.push({
            kind: 'error',
            index,
            sql: batch,
            durationMs: 0,
            error: {
              code: 'READ_ONLY_CONNECTION',
              message: 'Deze verbinding is alleen-lezen.',
              hint: violation,
            },
          });
          break;
        }
        const ok = await this.runBatch(editor, index, batch, limit, results);
        if (!ok) break;
      }
      return { results, database: null };
    } finally {
      editor.running = null;
      if (editor.broken) await this.close(tabId);
    }
  }

  /** Streams one batch; returns false when it failed (the script stops there). */
  private runBatch(
    editor: Editor,
    index: number,
    batch: string,
    limit: number,
    results: StatementResult[],
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const request = editor.pool.request();
      request.stream = true;
      request.arrayRowMode = true;
      editor.running = request;
      const before = results.length;
      // Variable assignments (DECLARE @x = 1, SELECT @x = ...) also report "1 row"; only batches
      // that write show row counts.
      const writes = classify(batch, 'mssql').kind === 'write';

      let current: Extract<StatementResult, { kind: 'rows' }> | null = null;
      let types: string[] = [];
      let dropped = 0;
      let error: unknown = null;
      let cutOff = false;

      request.on('recordset', (columns: { name: string; type?: unknown }[]) => {
        types = columns.map(columnType);
        current = {
          kind: 'rows',
          index,
          sql: batch,
          durationMs: elapsed(),
          columns: columns.map((c, i) => ({ name: c.name, type: types[i] ?? 'unknown' })),
          rows: [],
          truncated: false,
        };
        results.push(current);
      });
      request.on('row', (row: unknown[]) => {
        if (!current) return;
        if (current.rows.length < limit) {
          current.rows.push(row.map((v, i) => toCell(mssqlValue(v, types[i] ?? ''))));
          return;
        }
        current.truncated = true;
        // Rows past the limit are read and dropped, so the rest of the batch still runs; a
        // runaway result is stopped instead (the remaining statements then don't run).
        if (++dropped > DISCARD_CAP && !cutOff) {
          cutOff = true;
          request.cancel();
        }
      });
      request.on('rowsaffected', (count: number) => {
        if (current) {
          current.durationMs = elapsed();
          current = null; // the DONE of a SELECT: its row count, not a write
          return;
        }
        if (!writes) return;
        results.push({
          kind: 'ok',
          index,
          sql: batch,
          durationMs: elapsed(),
          affectedRows: count,
          insertId: null,
          warnings: 0,
          info: '',
        });
      });
      request.on('error', (err: unknown) => {
        error ??= err;
      });
      request.on('done', () => {
        if (error && !(cutOff && (error as { code?: string }).code === 'ECANCEL')) {
          const e = mssqlError(error) as { fatal?: boolean };
          if (e.fatal) editor.broken = true;
          results.push({
            kind: 'error',
            index,
            sql: batch,
            durationMs: elapsed(),
            error: toSqlError(e),
          });
          resolve(false);
          return;
        }
        if (results.length === before) {
          // SET NOCOUNT ON, or a statement without results (DECLARE, PRINT, USE).
          results.push({
            kind: 'ok',
            index,
            sql: batch,
            durationMs: elapsed(),
            affectedRows: 0,
            insertId: null,
            warnings: 0,
            info: '',
          });
        }
        resolve(true);
      });
      void request.batch(batch);
    });
  }

  /** Stops the running batch of a tab (a TDS attention signal). */
  async cancel(tabId: string): Promise<void> {
    const pending = this.editors.get(tabId);
    if (!pending) return;
    const editor = await pending.catch(() => null);
    editor?.running?.cancel();
  }

  async close(tabId: string): Promise<void> {
    const pending = this.editors.get(tabId);
    this.editors.delete(tabId);
    if (!pending) return;
    const editor = await pending.catch(() => null);
    // Closing the connection rolls back an open transaction.
    await editor?.pool.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.editors.keys()].map((id) => this.close(id)));
  }

  private get(tabId: string): Promise<Editor> {
    let pending = this.editors.get(tabId);
    if (!pending) {
      pending = this.open();
      this.editors.set(tabId, pending);
      pending.catch(() => this.editors.delete(tabId));
    }
    return pending;
  }

  private async open(): Promise<Editor> {
    const base = poolConfig(this.cfg);
    const pool = new sql.ConnectionPool({
      ...base,
      requestTimeout: 0, // the user decides how long a query may run (Stop)
      // Exactly one connection, never closed while idle: it carries the tab's session.
      pool: { max: 1, min: 0, idleTimeoutMillis: 2_147_483_647 },
    });
    const editor: Editor = { pool, running: null, broken: false };
    pool.on('error', () => {
      editor.broken = true;
    });
    await pool.connect();
    return editor;
  }
}
