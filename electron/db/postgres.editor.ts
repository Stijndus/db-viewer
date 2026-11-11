import pg from 'pg';
import Cursor from 'pg-cursor';
import type { ResultColumn, RunRequest, RunResult, StatementResult } from '../../shared/models';
import { readOnlyViolation } from '../../shared/sql';
import { AppError, toSqlError } from '../ipc/errors';
import { HARD_ROW_CAP, toCell } from './common';
import type { ConnectionConfig } from './driver';
import { clientConfig, pgError, RAW_TYPES, searchPath } from './postgres.common';

interface Editor {
  client: pg.Client;
  pid: number;
  running: boolean;
  broken: boolean;
}

/**
 * One dedicated connection per SQL tab, so search_path, temporary tables and transactions behave as
 * the user expects. Each statement runs through a cursor: only the rows within the limit (plus one,
 * to detect truncation) are fetched, however large the result.
 */
export class PgEditorSessions {
  private readonly editors = new Map<string, Promise<Editor>>();

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly pool: pg.Pool,
  ) {}

  async run(tabId: string, req: RunRequest): Promise<RunResult> {
    const editor = await this.get(tabId).catch((err: unknown) => {
      throw pgError(err);
    });
    if (editor.running) {
      throw new AppError(
        'BUSY',
        'Er loopt al een query in dit tabblad.',
        'Wacht tot hij klaar is of klik op Stop.',
      );
    }
    editor.running = true;
    const results: StatementResult[] = [];
    try {
      const { client } = editor;
      if (req.database) {
        await client.query("SELECT set_config('search_path', $1, false)", [
          searchPath(req.database),
        ]);
      }
      const limit = Math.min(req.maxRows ?? HARD_ROW_CAP, HARD_ROW_CAP);

      for (const [index, sql] of req.statements.entries()) {
        const violation = this.cfg.readOnly ? readOnlyViolation(sql, 'postgres') : null;
        if (violation) {
          results.push({
            kind: 'error',
            index,
            sql,
            durationMs: 0,
            error: {
              code: 'READ_ONLY_CONNECTION',
              message: 'Deze verbinding is alleen-lezen.',
              hint: violation,
            },
          });
          break;
        }
        const started = performance.now();
        try {
          const res = await runCursor(client, sql, limit + 1);
          const durationMs = Math.round(performance.now() - started);
          results.push(toResult(index, sql, res, limit, durationMs));
        } catch (err) {
          const e = pgError(err) as Error & { fatal?: boolean };
          results.push({
            kind: 'error',
            index,
            sql,
            durationMs: Math.round(performance.now() - started),
            error: toSqlError(e),
          });
          if (e.fatal) editor.broken = true;
          break;
        }
      }

      const schema = editor.broken ? null : await currentSchema(client);
      return { results, database: schema };
    } finally {
      editor.running = false;
      if (editor.broken) await this.close(tabId);
    }
  }

  /** Stops the running statement of a tab (pg_cancel_backend from another connection). */
  async cancel(tabId: string): Promise<void> {
    const pending = this.editors.get(tabId);
    if (!pending) return;
    const editor = await pending.catch(() => null);
    if (!editor?.running) return;
    await this.pool.query('SELECT pg_cancel_backend($1)', [editor.pid]);
  }

  async close(tabId: string): Promise<void> {
    const pending = this.editors.get(tabId);
    this.editors.delete(tabId);
    if (!pending) return;
    const editor = await pending.catch(() => null);
    // Ending the connection rolls back an open transaction.
    await editor?.client.end().catch(() => undefined);
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
    const client = new pg.Client(clientConfig(this.cfg));
    const editor: Editor = { client, pid: 0, running: false, broken: false };
    client.on('error', () => {
      editor.broken = true; // a dropped connection: the next run opens a new one
    });
    await client.connect();
    editor.pid = (client as unknown as { processID: number }).processID;
    return editor;
  }
}

interface CursorResult {
  rows: unknown[][];
  fields: { name: string; dataTypeID: number }[];
  command: string | null;
  rowCount: number | null;
}

function runCursor(client: pg.Client, sql: string, maxRows: number): Promise<CursorResult> {
  return new Promise((resolve, reject) => {
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: RAW_TYPES }));
    cursor.read(maxRows, (err, rows, result) => {
      if (err) {
        reject(err);
        return;
      }
      const r = result as unknown as Omit<CursorResult, 'rows'>;
      cursor.close(() =>
        resolve({
          rows: rows as unknown as unknown[][],
          fields: r.fields ?? [],
          command: r.command,
          rowCount: r.rowCount,
        }),
      );
    });
  });
}

async function currentSchema(client: pg.Client): Promise<string | null> {
  try {
    const res = await client.query<{ s: string | null }>('SELECT current_schema() AS s');
    return res.rows[0]?.s ?? null;
  } catch {
    return null;
  }
}

function toResult(
  index: number,
  sql: string,
  res: CursorResult,
  limit: number,
  durationMs: number,
): StatementResult {
  if (res.fields.length > 0) {
    return {
      kind: 'rows',
      index,
      sql,
      durationMs,
      columns: res.fields.map(toResultColumn),
      rows: res.rows.slice(0, limit).map((r) => r.map(toCell)),
      truncated: res.rows.length > limit,
    };
  }
  return {
    kind: 'ok',
    index,
    sql,
    durationMs,
    affectedRows: res.rowCount ?? 0,
    insertId: null,
    warnings: 0,
    info: res.command ?? '',
  };
}

// Built-in type oids → labels the grid understands (alignment and widths).
const TYPES: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'bigint',
  21: 'smallint',
  23: 'int',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  700: 'float',
  701: 'double',
  790: 'money',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

export function toResultColumn(f: { name: string; dataTypeID: number }): ResultColumn {
  return { name: f.name, type: TYPES[f.dataTypeID] ?? 'unknown' };
}
