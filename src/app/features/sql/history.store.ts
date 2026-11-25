import { inject, Injectable, signal } from '@angular/core';
import {
  HISTORY_SCRIPT_STATEMENTS,
  type DbError,
  type DbType,
  type HistoryEntry,
  type HistoryResult,
  type NewHistoryEntry,
  type Result,
  type RunResult,
  type StatementResult,
} from '../../../../shared/models';
import { DB_API } from '../../core/db-api';

const ENABLED_KEY = 'dbv.history.enabled';

/** The SQL text of several statements, as they would be typed in one tab. */
export function joinStatements(statements: string[], dialect: DbType): string {
  if (dialect === 'mssql') return statements.join('\nGO\n');
  return statements.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join('\n');
}

function resultOf(r: StatementResult): HistoryResult {
  if (r.kind === 'rows')
    return { kind: 'rows', rows: r.rows.length, ...(r.truncated && { more: true }) };
  if (r.kind === 'ok') return { kind: 'ok', affected: r.affectedRows };
  return { kind: 'error', message: r.error.message };
}

/**
 * What a run adds to the history: one entry per statement that ran (a failing one included,
 * the ones after it did not run), or for a long script one entry for the whole run.
 */
export function historyEntries(
  run: {
    connectionId: string;
    connectionName: string;
    database: string | null;
    dialect: DbType;
    statements: string[];
    startedAt: number;
    totalMs: number;
  },
  result: Result<RunResult>,
): NewHistoryEntry[] {
  const base = {
    connectionId: run.connectionId,
    connectionName: run.connectionName,
    database: run.database,
  };
  if (!result.ok) {
    return [
      {
        ...base,
        sql: joinStatements(run.statements, run.dialect),
        at: run.startedAt,
        durationMs: run.totalMs,
        result: { kind: 'error', message: result.error.message },
        ...(run.statements.length > 1 && { statements: run.statements.length }),
      },
    ];
  }
  const results = result.data.results;
  if (results.length === 0) return [];
  if (results.length > HISTORY_SCRIPT_STATEMENTS) {
    const failed = results.find((r) => r.kind === 'error') as
      (StatementResult & { error: DbError }) | undefined;
    const affected = results.reduce((n, r) => n + (r.kind === 'ok' ? r.affectedRows : 0), 0);
    return [
      {
        ...base,
        sql: joinStatements(run.statements.slice(0, results.length), run.dialect),
        at: run.startedAt,
        durationMs: run.totalMs,
        statements: results.length,
        result: failed
          ? { kind: 'error', message: failed.error.message }
          : { kind: 'ok', affected },
      },
    ];
  }
  let at = run.startedAt;
  return results.map((r, i) => {
    const entry: NewHistoryEntry = {
      ...base,
      sql: run.statements[i] ?? r.sql,
      at: Math.round(at),
      durationMs: r.durationMs,
      result: resultOf(r),
    };
    at += r.durationMs;
    return entry;
  });
}

/**
 * The query history of the SQL tabs, kept by the main process in a file on this computer. Loaded
 * the first time the panel opens; new runs are added as they finish. Recording can be turned off.
 */
@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly api = inject(DB_API);

  readonly enabled = signal(readEnabled());
  /** Null until loaded. */
  readonly entries = signal<HistoryEntry[] | null>(null);
  readonly loadError = signal<DbError | null>(null);
  /** The panel is open, starting with this connection's entries (null: all). */
  readonly panelFor = signal<{ connectionId: string | null } | null>(null);
  /** Writes in flight: the panel waits for them so a just-run query is there. */
  private pending: Promise<unknown> = Promise.resolve();

  setEnabled(on: boolean): void {
    this.enabled.set(on);
    try {
      localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
    } catch {
      // Storage unavailable: on for this session only.
    }
  }

  record(entries: NewHistoryEntry[]): void {
    if (!this.enabled() || entries.length === 0) return;
    this.pending = this.api.historyAdd(entries).then((r) => {
      if (r.ok && this.entries()) {
        this.entries.update((all) => [...[...r.data].reverse(), ...(all ?? [])]);
      }
    });
  }

  async load(): Promise<void> {
    await this.pending;
    const r = await this.api.historyList();
    if (r.ok) {
      this.entries.set(r.data);
      this.loadError.set(null);
    } else this.loadError.set(r.error);
  }

  open(connectionId: string | null): void {
    this.panelFor.set({ connectionId });
    void this.load();
  }

  async remove(id: string): Promise<void> {
    this.entries.update((all) => all?.filter((e) => e.id !== id) ?? null);
    await this.api.historyDelete([id]);
  }

  async removeMany(ids: string[]): Promise<void> {
    const gone = new Set(ids);
    this.entries.update((all) => all?.filter((e) => !gone.has(e.id)) ?? null);
    await this.api.historyDelete(ids);
  }

  async clear(connectionId?: string): Promise<void> {
    this.entries.update((all) =>
      connectionId ? (all?.filter((e) => e.connectionId !== connectionId) ?? null) : [],
    );
    await this.api.historyClear(connectionId);
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}
