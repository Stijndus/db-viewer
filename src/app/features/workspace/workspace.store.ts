import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { ObjectKind } from '../../../../shared/models';
import { ConnectionsStore } from '../connections/connections.store';
import { SchemaStore, type SelectedObject } from '../schema/schema.store';
import { SqlStore } from '../sql/sql.store';

export type WorkspaceTab =
  | { id: string; kind: 'table'; database: string; name: string; objectKind: ObjectKind }
  | { id: string; kind: 'sql' };

interface Saved {
  tabs: WorkspaceTab[];
  active: string | null;
}

const STORAGE_PREFIX = 'dbv.ws.v1.';

/**
 * The tab bar of an open connection: tables and SQL tabs in one row, in the user's order. Each
 * open tab keeps its own state (page, filter, unsaved edits, editor text) while others are shown.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  private readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);
  private readonly sql = inject(SqlStore);

  private readonly tabsByConnection = signal<Record<string, WorkspaceTab[]>>({});
  private readonly activeByConnection = signal<Record<string, string | null>>({});
  /** Tabs with unsaved edits, reported by their table view. */
  private readonly dirtyTabs = signal<ReadonlySet<string>>(new Set());
  /** Tabs shown at least once this session; others are only rendered when first opened. */
  private readonly visitedTabs = signal<ReadonlySet<string>>(new Set());

  readonly tabs = computed(() => {
    const id = this.connections.activeId();
    return id ? (this.tabsByConnection()[id] ?? []) : [];
  });

  readonly activeId = computed(() => {
    const id = this.connections.activeId();
    const active = id ? this.activeByConnection()[id] : null;
    return active && this.tabs().some((t) => t.id === active) ? active : null;
  });

  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()) ?? null);

  constructor() {
    // Load the saved tabs when a connection opens; after reconnecting, re-select the active table
    // so the tree highlights it and its columns are loaded again.
    effect(() => {
      const id = this.connections.activeId();
      const connected = id ? this.connections.status()[id] === 'connected' : false;
      if (!id || !connected) return;
      untracked(() => {
        this.restore(id);
        const active = this.activeByConnection()[id];
        if (active) this.activate(id, active);
      });
    });
    // A click in the tree opens that table in a tab, or brings its tab to the front.
    effect(() => {
      const selected = this.schema.selected();
      if (selected) untracked(() => this.openTable(selected));
    });
  }

  isDirty(tabId: string): boolean {
    return this.dirtyTabs().has(tabId);
  }

  isVisited(tabId: string): boolean {
    return this.visitedTabs().has(tabId);
  }

  setDirty(tabId: string, dirty: boolean): void {
    if (this.dirtyTabs().has(tabId) === dirty) return;
    this.dirtyTabs.update((set) => {
      const next = new Set(set);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }

  openTable(object: SelectedObject): void {
    const conn = object.connectionId;
    this.restore(conn);
    const existing = this.tabsOf(conn).find(
      (t) => t.kind === 'table' && t.database === object.database && t.name === object.name,
    );
    if (existing) {
      this.activate(conn, existing.id);
      return;
    }
    const tab: WorkspaceTab = {
      id: newId(),
      kind: 'table',
      database: object.database,
      name: object.name,
      objectKind: object.kind,
    };
    this.insert(conn, tab);
  }

  newSql(
    connectionId: string,
    init: { text?: string; database?: string; title?: string } = {},
  ): void {
    this.restore(connectionId);
    const tab = this.sql.newTab(connectionId, init);
    this.sql.focusRequest.set(tab.id);
    this.insert(connectionId, { id: tab.id, kind: 'sql' });
  }

  activate(connectionId: string, tabId: string): void {
    const tab = this.tabsOf(connectionId).find((t) => t.id === tabId);
    if (!tab) return;
    this.activeByConnection.update((a) => ({ ...a, [connectionId]: tabId }));
    if (!this.visitedTabs().has(tabId)) this.visitedTabs.update((v) => new Set(v).add(tabId));
    // Keep the tree in step with the table that is shown (and load its columns).
    if (tab.kind === 'table') {
      const s = this.schema.selected();
      const same =
        s?.connectionId === connectionId && s.database === tab.database && s.name === tab.name;
      if (!same) {
        void this.schema.select({
          connectionId,
          database: tab.database,
          name: tab.name,
          kind: tab.objectKind,
        });
      }
    }
    this.persist(connectionId);
  }

  /** Ctrl+Tab and Ctrl+Shift+Tab: the next or previous tab, wrapping around. */
  cycle(connectionId: string, step: 1 | -1): void {
    const tabs = this.tabsOf(connectionId);
    if (tabs.length === 0) return;
    const index = tabs.findIndex((t) => t.id === this.activeByConnection()[connectionId]);
    const next = tabs.at((index + step + tabs.length) % tabs.length);
    if (next) this.activate(connectionId, next.id);
  }

  /** Closes one tab after asking about unsaved edits or SQL text. Returns false when cancelled. */
  close(connectionId: string, tabId: string): boolean {
    const tab = this.tabsOf(connectionId).find((t) => t.id === tabId);
    if (!tab) return true;
    const question = this.closeQuestion(connectionId, [tab]);
    if (question && !confirm(question)) return false;
    this.remove(connectionId, [tabId]);
    return true;
  }

  /** Closes the tabs of a dropped table or view (or of every object in a dropped database). */
  dropTabsOf(connectionId: string, database: string, name?: string): void {
    const ids = this.tabsOf(connectionId)
      .filter(
        (t) =>
          t.kind === 'table' && t.database === database && (name === undefined || t.name === name),
      )
      .map((t) => t.id);
    if (ids.length) this.remove(connectionId, ids);
    const s = this.schema.selected();
    if (s?.connectionId === connectionId && s.database === database && (!name || s.name === name)) {
      this.schema.selected.set(null);
    }
  }

  closeOthers(connectionId: string, keepId: string): void {
    this.closeMany(
      connectionId,
      this.tabsOf(connectionId).filter((t) => t.id !== keepId),
    );
  }

  closeToRight(connectionId: string, fromId: string): void {
    const tabs = this.tabsOf(connectionId);
    const index = tabs.findIndex((t) => t.id === fromId);
    this.closeMany(connectionId, tabs.slice(index + 1));
  }

  closeAll(connectionId: string): void {
    this.closeMany(connectionId, this.tabsOf(connectionId));
  }

  /**
   * Leaving a connection (disconnect, back to the list) drops the views of its tabs.
   * Ask first when one of them has unsaved edits.
   */
  confirmLeave(connectionId: string): boolean {
    const dirty = this.tabsOf(connectionId).filter((t) => this.isDirty(t.id));
    if (dirty.length === 0) return true;
    const names = dirty.map((t) => (t.kind === 'table' ? t.name : 'SQL')).join(', ');
    return confirm(`Niet-opgeslagen wijzigingen in ${names} gaan verloren. Doorgaan?`);
  }

  /** Disconnects after confirming that unsaved edits may be lost. */
  disconnect(connectionId: string): void {
    if (!this.confirmLeave(connectionId)) return;
    this.forgetDirty(connectionId);
    void this.connections.disconnect(connectionId);
  }

  /** Back to the connection list (the connection stays open) after the same check. */
  leave(connectionId: string): void {
    if (!this.confirmLeave(connectionId)) return;
    this.forgetDirty(connectionId);
    this.connections.activeId.set(null);
  }

  /** Clears the unsaved-edit markers of a connection after leaving it. */
  forgetDirty(connectionId: string): void {
    const ids = new Set(this.tabsOf(connectionId).map((t) => t.id));
    this.dirtyTabs.update((set) => new Set([...set].filter((id) => !ids.has(id))));
    this.visitedTabs.update((set) => new Set([...set].filter((id) => !ids.has(id))));
  }

  private closeMany(connectionId: string, tabs: WorkspaceTab[]): void {
    if (tabs.length === 0) return;
    const question = this.closeQuestion(connectionId, tabs);
    if (question && !confirm(question)) return;
    this.remove(
      connectionId,
      tabs.map((t) => t.id),
    );
  }

  private closeQuestion(connectionId: string, tabs: WorkspaceTab[]): string | null {
    const lost: string[] = [];
    for (const t of tabs) {
      if (t.kind === 'table' && this.isDirty(t.id))
        lost.push(`niet-opgeslagen wijzigingen in ${t.name}`);
      if (t.kind === 'sql') {
        const sqlTab = this.sql.tab(connectionId, t.id);
        if (sqlTab?.text.trim()) lost.push(`de tekst in ${sqlTab.title}`);
      }
    }
    if (lost.length === 0) return null;
    const what = lost.length > 3 ? `${lost.slice(0, 3).join(', ')} en meer` : lost.join(', ');
    return `Sluiten? ${what.charAt(0).toUpperCase()}${what.slice(1)} gaan verloren.`;
  }

  private remove(connectionId: string, ids: string[]): void {
    const tabs = this.tabsOf(connectionId);
    const gone = new Set(ids);
    const activeId = this.activeByConnection()[connectionId] ?? null;
    let nextActive = activeId;
    if (activeId && gone.has(activeId)) {
      // Like a browser: the tab to the right takes its place, else the one to the left.
      const index = tabs.findIndex((t) => t.id === activeId);
      const right = tabs.slice(index + 1).find((t) => !gone.has(t.id));
      const left = tabs
        .slice(0, index)
        .reverse()
        .find((t) => !gone.has(t.id));
      nextActive = (right ?? left)?.id ?? null;
    }
    this.tabsByConnection.update((all) => ({
      ...all,
      [connectionId]: tabs.filter((t) => !gone.has(t.id)),
    }));
    this.dirtyTabs.update((set) => new Set([...set].filter((id) => !gone.has(id))));
    this.visitedTabs.update((set) => new Set([...set].filter((id) => !gone.has(id))));
    for (const t of tabs) {
      if (gone.has(t.id) && t.kind === 'sql') void this.sql.closeTab(connectionId, t.id);
    }
    if (nextActive && nextActive !== activeId) this.activate(connectionId, nextActive);
    else {
      this.activeByConnection.update((a) => ({ ...a, [connectionId]: nextActive }));
      this.persist(connectionId);
    }
  }

  /** New tabs open right after the active one, like in a browser. */
  private insert(connectionId: string, tab: WorkspaceTab): void {
    const tabs = this.tabsOf(connectionId);
    const index = tabs.findIndex((t) => t.id === this.activeByConnection()[connectionId]);
    const next =
      index < 0 ? [...tabs, tab] : [...tabs.slice(0, index + 1), tab, ...tabs.slice(index + 1)];
    this.tabsByConnection.update((all) => ({ ...all, [connectionId]: next }));
    this.activate(connectionId, tab.id);
  }

  private tabsOf(connectionId: string): WorkspaceTab[] {
    return this.tabsByConnection()[connectionId] ?? [];
  }

  /** Brings back the saved tab order; SQL tabs missing from it (older versions) are appended. */
  private restore(connectionId: string): void {
    if (untracked(this.tabsByConnection)[connectionId]) return;
    let saved: Saved = { tabs: [], active: null };
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + connectionId);
      if (raw) saved = JSON.parse(raw) as Saved;
    } catch {
      // Unreadable or unavailable storage: start with the SQL tabs only.
    }
    const sqlIds = new Set(this.sql.tabsOf(connectionId).map((t) => t.id));
    const tabs: WorkspaceTab[] = [];
    for (const t of Array.isArray(saved.tabs) ? saved.tabs : []) {
      if (t?.kind === 'sql' && sqlIds.has(t.id)) {
        tabs.push({ id: t.id, kind: 'sql' });
        sqlIds.delete(t.id);
      } else if (
        t?.kind === 'table' &&
        typeof t.database === 'string' &&
        typeof t.name === 'string'
      ) {
        tabs.push({
          id: String(t.id),
          kind: 'table',
          database: t.database,
          name: t.name,
          objectKind: t.objectKind ?? 'table',
        });
      }
    }
    for (const id of sqlIds) tabs.push({ id, kind: 'sql' });
    this.tabsByConnection.update((all) => ({ ...all, [connectionId]: tabs }));
    const active = tabs.some((t) => t.id === saved.active) ? saved.active : (tabs[0]?.id ?? null);
    if (active) this.activate(connectionId, active);
  }

  private persist(connectionId: string): void {
    const data: Saved = {
      tabs: this.tabsOf(connectionId),
      active: this.activeByConnection()[connectionId] ?? null,
    };
    try {
      localStorage.setItem(STORAGE_PREFIX + connectionId, JSON.stringify(data));
    } catch {
      // Storage unavailable: the tabs just aren't remembered.
    }
  }
}

function newId(): string {
  return 'w' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
