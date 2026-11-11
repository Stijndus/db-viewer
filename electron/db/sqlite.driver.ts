import { existsSync, statSync } from 'node:fs';
import type { ApplyResult, ChangeSet } from '../../shared/changes';
import { qualifiedName } from '../../shared/dialect';
import type {
  RowsPage,
  RowsRequest,
  RunRequest,
  RunResult,
  StatementResult,
} from '../../shared/models';
import { classify, readOnlyViolation } from '../../shared/sql';
import { AppError, toSqlError } from '../ipc/errors';
import {
  HARD_ROW_CAP,
  orderByClause,
  QUERY_TIMEOUT_MS,
  refuseReadOnly,
  saveChanges,
  toCell,
  whereClause,
} from './common';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';
import { SqliteConnection } from './sqlite.connection';
import * as exporter from './sqlite.export';
import * as meta from './sqlite.metadata';

export function buildSelect(database: string, table: string, req: RowsRequest): string {
  const limit = Math.trunc(req.limit) + 1; // one extra row reveals whether a next page exists
  const offset = Math.trunc(req.offset);
  return (
    `SELECT * FROM ${qualifiedName(database, table, 'sqlite')}` +
    whereClause(req.where) +
    orderByClause(req.orderBy, 'sqlite') +
    ` LIMIT ${limit} OFFSET ${offset}`
  );
}

/** The profile's `database` field holds the file path. */
function checkFile(file: string): void {
  if (!file)
    throw new AppError('SQLITE_CANTOPEN', 'Geen databasebestand gekozen.', 'Kies een bestand.');
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new AppError(
      'SQLITE_CANTOPEN',
      'Databasebestand niet gevonden.',
      `Bestaat ${file} nog? Kies het bestand opnieuw.`,
    );
  }
}

export const sqliteDriver: DbDriver = {
  type: 'sqlite',

  async open(cfg: ConnectionConfig): Promise<DbSession> {
    const file = cfg.database;
    checkFile(file);
    // Reads (tree, grid) and grid edits use separate connections: a read never sees a half-done
    // save, and a slow read can be stopped without touching a transaction.
    const reader = new SqliteConnection(file, cfg.readOnly);
    let writer: SqliteConnection | null = null;
    const editors = new Map<string, SqliteConnection>();
    try {
      await reader.open();
      // Fails here, not later, when the file is not a database.
      await reader.query('SELECT count(*) FROM sqlite_master');
    } catch (err) {
      await reader.close();
      throw err;
    }

    const editor = (tabId: string) => {
      let conn = editors.get(tabId);
      if (!conn) {
        conn = new SqliteConnection(file, cfg.readOnly);
        editors.set(tabId, conn);
      }
      return conn;
    };

    return {
      serverVersion: async () => `SQLite ${reader.version}`,
      listDatabases: () => meta.listDatabases(reader),
      listObjects: (database) => meta.listObjects(reader, database),
      listColumns: (database, table) => meta.listColumns(reader, database, table),
      listAllColumns: (database) => meta.listAllColumns(reader, database),

      streamRows: (source, onBatch, signal) => exporter.streamRows(file, source, onBatch, signal),
      tableDdl: (database, table) => exporter.tableDdl(reader, database, table),

      async readRows(database, table, req): Promise<RowsPage> {
        const started = performance.now();
        const res = await reader.query(buildSelect(database, table, req), [], {
          guard: true,
          timeoutMs: QUERY_TIMEOUT_MS,
        });
        return {
          columns: res.columns.map((c) => c.name),
          rows: res.rows.slice(0, req.limit).map((r) => r.map(toCell)),
          hasMore: res.rows.length > req.limit,
          durationMs: Math.round(performance.now() - started),
        };
      },

      async countRows(database, table, where) {
        const res = await reader.query(
          `SELECT count(*) FROM ${qualifiedName(database, table, 'sqlite')}${whereClause(where)}`,
          [],
          { guard: true, timeoutMs: QUERY_TIMEOUT_MS },
        );
        return Number(res.rows[0]?.[0] ?? 0);
      },

      async applyChanges(database, table, changes: ChangeSet): Promise<ApplyResult> {
        refuseReadOnly(cfg.readOnly);
        writer ??= new SqliteConnection(file, false);
        const w = writer;
        return saveChanges(
          {
            target: () => meta.readTarget(w, database, table),
            begin: () => w.exec('BEGIN IMMEDIATE'),
            execute: async (s) => (await w.query(s.sql, s.params)).changes,
            commit: () => w.exec('COMMIT'),
            rollback: () => w.exec('ROLLBACK'),
          },
          database,
          table,
          changes,
          'sqlite',
        );
      },

      async runScript(tabId: string, req: RunRequest): Promise<RunResult> {
        const conn = editor(tabId);
        if (conn.busy) {
          throw new AppError(
            'BUSY',
            'Er loopt al een query in dit tabblad.',
            'Wacht tot hij klaar is of klik op Stop.',
          );
        }
        const limit = Math.min(req.maxRows ?? HARD_ROW_CAP, HARD_ROW_CAP);
        const results: StatementResult[] = [];
        for (const [index, sql] of req.statements.entries()) {
          const violation = cfg.readOnly ? readOnlyViolation(sql, 'sqlite') : null;
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
            const res = await conn.query(sql, [], { maxRows: limit });
            const durationMs = Math.round(performance.now() - started);
            if (res.columns.length > 0) {
              results.push({
                kind: 'rows',
                index,
                sql,
                durationMs,
                columns: res.columns.map((c, i) => ({
                  name: c.name,
                  type: c.type?.toLowerCase() ?? valueType(res.rows[0]?.[i]),
                })),
                rows: res.rows.map((r) => r.map(toCell)),
                truncated: res.more,
              });
            } else {
              const insert = classify(sql, 'sqlite').keyword === 'INSERT';
              results.push({
                kind: 'ok',
                index,
                sql,
                durationMs,
                affectedRows: res.changes,
                insertId: insert ? res.lastInsertRowid : null,
                warnings: 0,
                info: '',
              });
            }
          } catch (err) {
            results.push({
              kind: 'error',
              index,
              sql,
              durationMs: Math.round(performance.now() - started),
              error: toSqlError(err),
            });
            break;
          }
        }
        return { results, database: 'main' };
      },

      /** SQLite can only be interrupted by ending the tab's worker; its session starts over. */
      async cancelScript(tabId) {
        const conn = editors.get(tabId);
        if (conn?.busy) await conn.stop();
      },
      async closeEditor(tabId) {
        const conn = editors.get(tabId);
        editors.delete(tabId);
        await conn?.close();
      },
      async query(sql, params) {
        const res = await reader.query(sql, (params ?? []) as (string | null)[]);
        return { rows: res.rows, fields: res.columns.map((c) => c.name) };
      },
      async close() {
        await Promise.allSettled([...editors.values()].map((c) => c.close()));
        editors.clear();
        await writer?.close();
        await reader.close();
      },
    };
  },
};

/** SQLite has no column type for expressions: label by the first value, for grid alignment. */
function valueType(value: unknown): string {
  if (typeof value === 'bigint') return 'integer';
  if (typeof value === 'number') return 'real';
  if (value instanceof Uint8Array) return 'blob';
  return 'text';
}
