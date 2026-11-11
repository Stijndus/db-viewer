import mysql from 'mysql2/promise';
import type { FieldPacket, ResultSetHeader } from 'mysql2/promise';
import type { ResultColumn, RunRequest, RunResult, StatementResult } from '../../shared/models';
import { readOnlyViolation } from '../../shared/sql';
import { AppError, toSqlError } from '../ipc/errors';
import type { ConnectionConfig } from './driver';
import { quoteIdent, toCell } from './mysql.data';

/** Absolute ceiling for "no limit", so one runaway SELECT can't exhaust memory. */
export const HARD_ROW_CAP = 100_000;

interface Editor {
  conn: mysql.Connection;
  threadId: number;
  running: boolean;
}

type OptionsFactory = (cfg: ConnectionConfig) => mysql.ConnectionOptions;

/**
 * One dedicated connection per SQL tab, so USE, variables, temporary tables and transactions
 * behave as the user expects. Created on first run, closed with the tab or the session.
 */
export class EditorSessions {
  private readonly editors = new Map<string, Promise<Editor>>();

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly pool: mysql.Pool,
    private readonly connectionOptions: OptionsFactory,
  ) {}

  async run(tabId: string, req: RunRequest): Promise<RunResult> {
    const editor = await this.get(tabId);
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
      const { conn } = editor;
      if (req.database) await conn.query(`USE ${quoteIdent(req.database)}`);
      // The row limit applies to SELECTs without their own LIMIT; one extra row reveals truncation.
      const limit = Math.min(req.maxRows ?? HARD_ROW_CAP, HARD_ROW_CAP);
      await conn.query(`SET SESSION sql_select_limit = ${limit + 1}`);

      for (const [index, sql] of req.statements.entries()) {
        const violation = this.cfg.readOnly ? readOnlyViolation(sql) : null;
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
          const [res, fields] = await conn.query({ sql, rowsAsArray: true });
          const durationMs = Math.round(performance.now() - started);
          results.push(...toResults(index, sql, res, fields, limit, durationMs));
        } catch (err) {
          results.push({
            kind: 'error',
            index,
            sql,
            durationMs: Math.round(performance.now() - started),
            error: toSqlError(err),
          });
          if ((err as { fatal?: boolean }).fatal) await this.close(tabId);
          break;
        }
      }

      const database = this.editors.has(tabId) ? await currentDatabase(conn) : null;
      return { results, database };
    } finally {
      editor.running = false;
    }
  }

  /** Stops the running query of a tab (KILL QUERY from another connection). */
  async cancel(tabId: string): Promise<void> {
    const pending = this.editors.get(tabId);
    if (!pending) return;
    const editor = await pending;
    if (!editor.running) return;
    await this.pool.query('KILL QUERY ?', [editor.threadId]);
  }

  async close(tabId: string): Promise<void> {
    const pending = this.editors.get(tabId);
    this.editors.delete(tabId);
    if (!pending) return;
    const editor = await pending.catch(() => null);
    // Ending the connection rolls back an open transaction.
    await editor?.conn.end().catch(() => editor.conn.destroy());
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
    const conn = await mysql.createConnection(this.connectionOptions(this.cfg));
    if (this.cfg.readOnly) {
      // The server refuses writes from here on; the check above explains it before trying.
      await conn.query('SET SESSION TRANSACTION READ ONLY');
    }
    conn.on('error', () => undefined); // a dropped connection surfaces on the next query
    return { conn, threadId: conn.threadId, running: false };
  }
}

async function currentDatabase(conn: mysql.Connection): Promise<string | null> {
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db');
    const db = rows[0]?.['db'];
    return typeof db === 'string' ? db : null;
  } catch {
    return null;
  }
}

/** One query can return several result sets (CALL), or an OK packet for writes. */
function toResults(
  index: number,
  sql: string,
  res: unknown,
  fields: unknown,
  limit: number,
  durationMs: number,
): StatementResult[] {
  if (isMultiResult(fields)) {
    const sets = res as unknown[];
    const out: StatementResult[] = [];
    fields.forEach((f, i) => {
      if (f) out.push(rowsResult(index, sql, sets[i] as unknown[][], f, limit, durationMs));
    });
    const header = sets.find((s) => !Array.isArray(s)) as ResultSetHeader | undefined;
    if (out.length === 0 && header) out.push(okResult(index, sql, header, durationMs));
    return out;
  }
  if (Array.isArray(res) && Array.isArray(fields)) {
    return [rowsResult(index, sql, res as unknown[][], fields as FieldPacket[], limit, durationMs)];
  }
  return [okResult(index, sql, res as ResultSetHeader, durationMs)];
}

function isMultiResult(fields: unknown): fields is (FieldPacket[] | undefined)[] {
  return Array.isArray(fields) && fields.some((f) => Array.isArray(f) || f === undefined);
}

function rowsResult(
  index: number,
  sql: string,
  rows: unknown[][],
  fields: FieldPacket[],
  limit: number,
  durationMs: number,
): StatementResult {
  return {
    kind: 'rows',
    index,
    sql,
    durationMs,
    columns: fields.map(toResultColumn),
    rows: rows.slice(0, limit).map((r) => r.map(toCell)),
    truncated: rows.length > limit,
  };
}

function okResult(
  index: number,
  sql: string,
  h: ResultSetHeader,
  durationMs: number,
): StatementResult {
  return {
    kind: 'ok',
    index,
    sql,
    durationMs,
    affectedRows: Number(h?.affectedRows ?? 0),
    insertId: h?.insertId ? String(h.insertId) : null,
    warnings: Number(h?.warningStatus ?? 0),
    info: String(h?.info ?? '').trim(),
  };
}

// mysql2 column type codes → labels the grid understands (alignment and widths).
const TYPES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  14: 'date',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinytext',
  250: 'mediumtext',
  251: 'longtext',
  252: 'text',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
};
const BINARY_CHARSET = 63;
const UNSIGNED_FLAG = 32;

export function toResultColumn(
  f: Pick<FieldPacket, 'name' | 'columnType' | 'characterSet' | 'flags'>,
): ResultColumn {
  let type = TYPES[f.columnType ?? -1] ?? 'unknown';
  if (f.characterSet === BINARY_CHARSET) {
    type = type
      .replace('text', 'blob')
      .replace(/^varchar$/, 'varbinary')
      .replace(/^char$/, 'binary');
  }
  const flags = typeof f.flags === 'number' ? f.flags : 0;
  if (flags & UNSIGNED_FLAG && /int|decimal|float|double/.test(type)) type += ' unsigned';
  return { name: f.name, type };
}
