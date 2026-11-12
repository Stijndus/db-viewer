import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { DbError, RunResult } from '../../../../shared/models';
import { defaultContainer, DIALECTS } from '../../../../shared/dialect';
import type { DbType } from '../../../../shared/models';
import { classify, splitStatements, statementAt, type SqlStatement } from '../../../../shared/sql';
import { DB_API } from '../../core/db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { SchemaStore } from '../schema/schema.store';

export const ROW_LIMITS = [100, 1000, 10000, null] as const;
export type RowLimit = (typeof ROW_LIMITS)[number];

export interface SqlTab {
  id: string;
  title: string;
  text: string;
  /** Database the next run starts in (USE); follows USE statements the user runs. */
  database: string | null;
  maxRows: RowLimit;
  running: boolean;
  /** Statements of the last run with their place in the editor text. */
  ran: SqlStatement[];
  result: RunResult | null;
  /** A failure of the run itself (lost connection, busy), not of one statement. */
  error: DbError | null;
  activeResult: number;
  totalMs: number | null;
  /** Statements in the editor that the last run left out (it ran only the one under the cursor). */
  skipped?: number;
}

/** What the user is about to run and has to confirm, because it changes data. */
export interface WriteConfirmation {
  connectionId: string;
  statements: { sql: string; keyword: string; unbounded: boolean }[];
  total: number;
  resolve: (answer: { run: boolean; dontAskAgain: boolean }) => void;
}

export interface EditorSnapshot {
  text: string;
  selectionFrom: number;
  selectionTo: number;
}

const STORAGE_PREFIX = 'dbv.sql.v1.';

/**
 * The contents of SQL tabs per connection. Text, title and database survive restarts (per profile).
 * Which tab is shown, and in what order, is the WorkspaceStore's business.
 */
@Injectable({ providedIn: 'root' })
export class SqlStore {
  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);

  private readonly tabsByConnection = signal<Record<string, SqlTab[]>>({});
  private readonly columnsCache = signal<Record<string, Record<string, string[]>>>({});
  /** Connections where the user said "don't ask again" for writes; forgotten on restart. */
  private readonly trusted = new Set<string>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly confirmation = signal<WriteConfirmation | null>(null);

  readonly tabs = computed(() => {
    const id = this.connections.activeId();
    return id ? (this.tabsByConnection()[id] ?? []) : [];
  });

  constructor() {
    // Closing the window within the save pause must not lose the last keystrokes.
    const onPageHide = () => this.flush();
    window.addEventListener('pagehide', onPageHide);
    // When the store itself goes away (tests), pending saves are dropped, not written later.
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('pagehide', onPageHide);
      for (const timer of this.saveTimers.values()) clearTimeout(timer);
      this.saveTimers.clear();
    });
    // A closed connection closes the server sessions of its tabs; nothing is left running.
    effect(() => {
      const status = this.connections.status();
      untracked(() => {
        for (const [id, s] of Object.entries(status)) {
          if (s !== 'connected' && this.tabsByConnection()[id]?.some((t) => t.running)) {
            this.patchAll(id, { running: false });
          }
        }
      });
    });
  }

  /** The SQL tabs of a connection, loading the saved ones the first time. */
  tabsOf(connectionId: string): SqlTab[] {
    this.ensureRestored(connectionId);
    return this.tabsByConnection()[connectionId] ?? [];
  }

  tab(connectionId: string, tabId: string): SqlTab | undefined {
    return this.find(connectionId, tabId);
  }

  ensureRestored(connectionId: string): void {
    if (!untracked(this.tabsByConnection)[connectionId]) this.restore(connectionId);
  }

  /** A new SQL tab, optionally with text, a database and a title (from the tree's menu). */
  newTab(
    connectionId: string,
    init: { text?: string; database?: string; title?: string } = {},
  ): SqlTab {
    const existing = this.tabsByConnection()[connectionId] ?? [];
    const numbers = existing.map((t) => Number(/^SQL (\d+)$/.exec(t.title)?.[1] ?? 0));
    const selected = this.schema.selected();
    const profile = this.connections.connections().find((c) => c.id === connectionId);
    const tab: SqlTab = {
      ...emptyRunState(),
      id: newId(),
      title: init.title ?? `SQL ${Math.max(0, ...numbers) + 1}`,
      text: init.text ?? '',
      database:
        init.database ||
        (selected?.connectionId === connectionId ? selected.database : null) ||
        (profile ? defaultContainer(profile.type, profile.database) : null) ||
        null,
      maxRows: 1000,
    };
    this.tabsByConnection.update((all) => ({ ...all, [connectionId]: [...existing, tab] }));
    this.persist(connectionId);
    return tab;
  }

  async closeTab(connectionId: string, tabId: string): Promise<void> {
    const tab = this.find(connectionId, tabId);
    if (tab?.running) await this.cancel(connectionId, tabId);
    const remaining = (this.tabsByConnection()[connectionId] ?? []).filter((t) => t.id !== tabId);
    this.tabsByConnection.update((all) => ({ ...all, [connectionId]: remaining }));
    this.persist(connectionId);
    // Ends the tab's server connection; an open transaction is rolled back.
    await this.api.closeEditor(connectionId, tabId);
  }

  /** Text to insert at the cursor of a tab's editor; the SQL panel takes it and clears it. */
  readonly insertRequest = signal<{ tabId: string; text: string } | null>(null);

  /** A tab whose editor should get the focus once shown (a new tab). */
  readonly focusRequest = signal<string | null>(null);

  insertText(tabId: string, text: string): void {
    this.insertRequest.set({ tabId, text });
  }

  setText(connectionId: string, tabId: string, text: string): void {
    this.patch(connectionId, tabId, { text });
    this.persist(connectionId);
  }

  setDatabase(connectionId: string, tabId: string, database: string | null): void {
    this.patch(connectionId, tabId, { database });
    this.persist(connectionId);
  }

  setMaxRows(connectionId: string, tabId: string, maxRows: RowLimit): void {
    this.patch(connectionId, tabId, { maxRows });
    this.persist(connectionId);
  }

  setActiveResult(connectionId: string, tabId: string, index: number): void {
    this.patch(connectionId, tabId, { activeResult: index });
  }

  /** Column names per table of a database, for autocompletion (empty until loaded). */
  completionColumns(
    connectionId: string,
    database: string | null,
  ): Record<string, string[]> | undefined {
    if (!database) return {};
    return this.columnsCache()[`${connectionId}\u0001${database}`];
  }

  /** Loads the autocompletion columns once; call from an effect, never while rendering. */
  loadCompletionColumns(connectionId: string, database: string | null): void {
    if (!database) return;
    const key = `${connectionId}\u0001${database}`;
    if (this.columnsCache()[key]) return;
    this.columnsCache.update((c) => ({ ...c, [key]: {} }));
    void this.api.listAllColumns(connectionId, database).then((r) => {
      if (r.ok) this.columnsCache.update((c) => ({ ...c, [key]: r.data }));
    });
  }

  /**
   * Runs the selection, or the statement under the cursor, or everything. Statements that change
   * data are confirmed first, unless the connection is read-only (the server refuses them anyway).
   */
  async run(
    connectionId: string,
    tabId: string,
    mode: 'current' | 'all',
    editor: EditorSnapshot,
  ): Promise<void> {
    const tab = this.find(connectionId, tabId);
    if (!tab || tab.running) return;

    const dialect = this.dialectOf(connectionId);
    const statements = pickStatements(editor, mode, dialect);
    if (statements.length === 0) {
      this.patch(connectionId, tabId, {
        ...emptyRunState(),
        error: {
          code: 'EMPTY',
          message: 'Niets om uit te voeren.',
          hint: 'Typ een statement, of zet de cursor erin.',
        },
      });
      return;
    }

    const profile = this.connections.connections().find((c) => c.id === connectionId);
    if (!profile?.readOnly && !this.trusted.has(connectionId)) {
      const writes = statements
        .map((s) => ({ sql: s.sql, ...classify(s.sql, dialect) }))
        .filter((s) => s.kind === 'write');
      if (writes.length > 0) {
        const answer = await new Promise<{ run: boolean; dontAskAgain: boolean }>((resolve) =>
          this.confirmation.set({
            connectionId,
            statements: writes.map(({ sql, keyword, unbounded }) => ({ sql, keyword, unbounded })),
            total: statements.length,
            resolve,
          }),
        );
        this.confirmation.set(null);
        if (!answer.run) return;
        if (answer.dontAskAgain) this.trusted.add(connectionId);
      }
    }

    // Only the statement under the cursor of a longer script: say so, the rest did not run.
    const skipped =
      mode === 'current' && editor.selectionTo === editor.selectionFrom
        ? splitStatements(editor.text, dialect).length - statements.length
        : 0;
    this.patch(connectionId, tabId, {
      ...emptyRunState(),
      running: true,
      ran: statements,
      skipped,
    });
    const started = performance.now();
    const result = await this.api.runScript(connectionId, tabId, {
      statements: statements.map((s) => s.sql),
      // Only where the editor can switch the default schema/database (USE, search_path).
      database: DIALECTS[dialect].editorDefaultContainer ? (tab.database ?? undefined) : undefined,
      maxRows: tab.maxRows,
    });
    const totalMs = Math.round(performance.now() - started);

    if (!this.find(connectionId, tabId)) return; // tab closed meanwhile
    if (result.ok) {
      const results = result.data.results;
      const failed = results.findIndex((r) => r.kind === 'error');
      this.patch(connectionId, tabId, {
        running: false,
        result: result.data,
        totalMs,
        // Show the error if there is one, else the last result (usually what you asked for).
        activeResult: failed >= 0 ? failed : Math.max(0, results.length - 1),
        database: result.data.database ?? tab.database,
      });
      this.persist(connectionId);
      // DDL may have changed the schema: refresh what the tree shows on its next look.
      if (
        statements.some((s) =>
          /^(CREATE|ALTER|DROP|RENAME|TRUNCATE)$/.test(classify(s.sql, dialect).keyword),
        )
      ) {
        this.columnsCache.set({});
      }
    } else {
      this.patch(connectionId, tabId, { running: false, error: result.error, totalMs });
    }
  }

  /** The database type of a connection; decides how scripts are split and classified. */
  dialectOf(connectionId: string): DbType {
    return this.connections.connections().find((c) => c.id === connectionId)?.type ?? 'mysql';
  }

  async cancel(connectionId: string, tabId: string): Promise<void> {
    await this.api.cancelScript(connectionId, tabId);
  }

  answerConfirmation(run: boolean, dontAskAgain = false): void {
    this.confirmation()?.resolve({ run, dontAskAgain });
  }

  private find(connectionId: string, tabId: string): SqlTab | undefined {
    return this.tabsByConnection()[connectionId]?.find((t) => t.id === tabId);
  }

  private patch(connectionId: string, tabId: string, changes: Partial<SqlTab>): void {
    this.tabsByConnection.update((all) => ({
      ...all,
      [connectionId]: (all[connectionId] ?? []).map((t) =>
        t.id === tabId ? { ...t, ...changes } : t,
      ),
    }));
  }

  private patchAll(connectionId: string, changes: Partial<SqlTab>): void {
    this.tabsByConnection.update((all) => ({
      ...all,
      [connectionId]: (all[connectionId] ?? []).map((t) => ({ ...t, ...changes })),
    }));
  }

  private restore(connectionId: string): void {
    let saved: Pick<SqlTab, 'id' | 'title' | 'text' | 'database' | 'maxRows'>[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + connectionId);
      if (raw) saved = JSON.parse(raw);
    } catch {
      // Unreadable or unavailable storage: start without saved tabs.
    }
    const tabs = Array.isArray(saved)
      ? saved
          .filter((t) => t && typeof t.id === 'string' && typeof t.text === 'string')
          .map((t) => ({
            ...emptyRunState(),
            id: t.id,
            title: String(t.title ?? 'SQL'),
            text: t.text,
            database: typeof t.database === 'string' ? t.database : null,
            maxRows: (ROW_LIMITS as readonly RowLimit[]).includes(t.maxRows) ? t.maxRows : 1000,
          }))
      : [];
    this.tabsByConnection.update((all) => ({ ...all, [connectionId]: tabs }));
  }

  /** Saves after a short pause, so typing doesn't write on every key. */
  private persist(connectionId: string): void {
    clearTimeout(this.saveTimers.get(connectionId));
    this.saveTimers.set(
      connectionId,
      setTimeout(() => this.save(connectionId), 400),
    );
  }

  /** Writes pending saves now, e.g. when the window closes within the pause. */
  flush(): void {
    for (const [connectionId, timer] of this.saveTimers) {
      clearTimeout(timer);
      this.save(connectionId);
    }
    this.saveTimers.clear();
  }

  private save(connectionId: string): void {
    this.saveTimers.delete(connectionId);
    const tabs = (this.tabsByConnection()[connectionId] ?? []).map(
      ({ id, title, text, database, maxRows }) => ({ id, title, text, database, maxRows }),
    );
    try {
      localStorage.setItem(STORAGE_PREFIX + connectionId, JSON.stringify(tabs));
    } catch {
      // Storage full or unavailable: the tabs just aren't remembered.
    }
  }
}

function emptyRunState(): Omit<SqlTab, 'id' | 'title' | 'text' | 'database' | 'maxRows'> {
  return {
    running: false,
    ran: [],
    result: null,
    error: null,
    activeResult: 0,
    totalMs: null,
    skipped: 0,
  };
}

/** Selection wins; else the statement under the cursor; `all` runs the whole text. */
export function pickStatements(
  editor: EditorSnapshot,
  mode: 'current' | 'all',
  dialect: DbType = 'mysql',
): SqlStatement[] {
  if (mode === 'all') return splitStatements(editor.text, dialect);
  const { selectionFrom: from, selectionTo: to } = editor;
  if (to > from) {
    return splitStatements(editor.text.slice(from, to), dialect).map((s) => ({
      ...s,
      from: s.from + from,
      to: s.to + from,
    }));
  }
  const current = statementAt(splitStatements(editor.text, dialect), from);
  return current ? [current] : [];
}

function newId(): string {
  return 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
