import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DIALECTS } from '../../../../../shared/dialect';
import { HISTORY_MAX, type HistoryEntry } from '../../../../../shared/models';
import { ConnectionsStore } from '../../connections/connections.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { HistoryStore } from '../history.store';
import { SqlStore } from '../sql.store';

/** Shown at most at once; "Meer tonen" adds the next ones. */
const PAGE = 200;

/**
 * Ctrl+H: every query run in a SQL tab, newest first. Search the text, filter on connection (the
 * one you work in by default) or errors; put a query in the current or a new tab, copy it, or
 * delete it (a CREATE USER with a password, say).
 */
@Component({
  selector: 'app-query-history',
  templateUrl: './query-history.html',
})
export class QueryHistory {
  protected readonly history = inject(HistoryStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly ws = inject(WorkspaceStore);
  private readonly sql = inject(SqlStore);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  protected readonly max = HISTORY_MAX;
  protected readonly query = signal('');
  /** Connection id, or '' for all. */
  protected readonly connection = signal('');
  protected readonly errorsOnly = signal(false);
  protected readonly active = signal(0);
  protected readonly shown = signal(PAGE);
  protected readonly copied = signal<string | null>(null);

  /**
   * Which connection an entry belongs to now: its own, or, for a temporary connection (opened
   * from a link, with a new id each time), the open temporary connection with the same name.
   */
  private readonly keyOf = computed(() => {
    const profiles = this.connections.connections();
    const ids = new Set(profiles.map((c) => c.id));
    const temporary = new Map(profiles.filter((c) => c.temporary).map((c) => [c.name, c.id]));
    return (e: HistoryEntry) =>
      ids.has(e.connectionId)
        ? e.connectionId
        : (temporary.get(e.connectionName) ?? e.connectionId);
  });

  /** The connections in the history, by their current name (or the name it had). */
  protected readonly connectionOptions = computed(() => {
    const names = new Map<string, string>();
    for (const c of this.connections.connections()) names.set(c.id, c.name);
    const key = this.keyOf();
    const seen = new Map<string, string>();
    for (const e of this.history.entries() ?? []) {
      const k = key(e);
      if (!seen.has(k)) seen.set(k, names.get(k) ?? `${e.connectionName} (verwijderd)`);
    }
    const current = this.history.panelFor()?.connectionId;
    if (current && !seen.has(current)) seen.set(current, names.get(current) ?? current);
    return [...seen]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly matches = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const conn = this.connection();
    const errors = this.errorsOnly();
    const key = this.keyOf();
    return (this.history.entries() ?? []).filter((e) => {
      if (conn && key(e) !== conn) return false;
      if (errors && e.result.kind !== 'error') return false;
      if (words.length === 0) return true;
      const text = `${e.sql}\n${e.database ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });
  protected readonly visible = computed(() => this.matches().slice(0, this.shown()));
  protected readonly selected = computed(() => this.visible()[this.active()] ?? null);

  constructor() {
    // Each time it opens: the connection you work in, no search, the newest entry selected.
    effect(() => {
      const open = this.history.panelFor();
      if (!open) return;
      untracked(() => {
        this.connection.set(open.connectionId ?? '');
        this.query.set('');
        this.errorsOnly.set(false);
        this.active.set(0);
        this.shown.set(PAGE);
      });
    });
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.open) {
        dialog.showModal();
        this.input()?.nativeElement.focus();
      }
    });
  }

  protected setFilter(apply: () => void): void {
    apply();
    this.active.set(0);
    this.shown.set(PAGE);
  }

  protected close(): void {
    this.dialog()?.nativeElement.close();
    this.history.panelFor.set(null);
  }

  /** Arrows move, Enter puts the query in the current tab, Ctrl+Enter in a new one. */
  protected onKey(event: KeyboardEvent): void {
    const n = this.visible().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (n === 0) return;
      const next = (this.active() + (event.key === 'ArrowDown' ? 1 : -1) + n) % n;
      this.active.set(next);
      this.list()
        ?.nativeElement.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const e = this.selected();
      if (e) this.use(e, event.ctrlKey || event.metaKey ? 'new' : 'current');
    } else if (event.key === 'Delete' && event.target !== this.input()?.nativeElement) {
      const e = this.selected();
      if (e) void this.remove(e);
    }
  }

  protected isConnected(e: HistoryEntry): boolean {
    return this.connections.statusOf(this.keyOf()(e)) === 'connected';
  }

  /** The SQL tab shown now, when it belongs to the entry's connection. */
  protected currentTab(e: HistoryEntry): string | null {
    if (this.connections.activeId() !== this.keyOf()(e)) return null;
    const tab = this.ws.active();
    return tab?.kind === 'sql' ? tab.id : null;
  }

  protected use(e: HistoryEntry, where: 'current' | 'new'): void {
    if (!this.isConnected(e)) return;
    const tab = where === 'current' ? this.currentTab(e) : null;
    const id = this.keyOf()(e);
    if (tab) this.sql.insertText(tab, e.sql + '\n');
    else {
      const type = this.connections.connections().find((c) => c.id === id)?.type;
      this.connections.activeId.set(id);
      this.ws.newSql(id, {
        text: e.sql,
        ...(e.database &&
          type &&
          DIALECTS[type].editorDefaultContainer && { database: e.database }),
      });
    }
    this.close();
  }

  protected async copy(e: HistoryEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(e.sql);
      this.copied.set(e.id);
      setTimeout(() => this.copied() === e.id && this.copied.set(null), 1500);
    } catch {
      // No clipboard (tests): nothing to show.
    }
  }

  protected async remove(e: HistoryEntry): Promise<void> {
    const index = this.visible().indexOf(e);
    await this.history.remove(e.id);
    this.active.set(Math.max(0, Math.min(index, this.visible().length - 1)));
  }

  protected async clear(): Promise<void> {
    const conn = this.connection();
    const name = this.connectionOptions().find((c) => c.id === conn)?.name;
    const ok = confirm(
      conn
        ? `Alle queries van ${name} uit de geschiedenis verwijderen?`
        : 'De hele query-geschiedenis verwijderen, van alle verbindingen?',
    );
    if (!ok) return;
    if (!conn) await this.history.clear();
    else {
      // Also the entries of earlier temporary connections that count as this one.
      const key = this.keyOf();
      await this.history.removeMany(
        (this.history.entries() ?? []).filter((e) => key(e) === conn).map((e) => e.id),
      );
    }
    this.active.set(0);
  }

  protected connectionName(e: HistoryEntry): string {
    const id = this.keyOf()(e);
    return this.connections.connections().find((c) => c.id === id)?.name ?? e.connectionName;
  }

  protected when(at: number): string {
    const d = new Date(at);
    const today = new Date();
    const time = d.toLocaleTimeString('nl-NL', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (d.toDateString() === today.toDateString()) return time;
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `gisteren ${time}`;
    const date = d.toLocaleDateString('nl-NL', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }),
    });
    return `${date} ${time}`;
  }

  protected duration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000)
      return `${(ms / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} s`;
    const m = Math.floor(ms / 60_000);
    return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
  }

  protected resultText(e: HistoryEntry): string {
    const r = e.result;
    const n = (x: number) => x.toLocaleString('nl-NL');
    const prefix = e.statements ? `${n(e.statements)} statements · ` : '';
    if (r.kind === 'rows')
      return `${prefix}${n(r.rows)}${r.more ? '+' : ''} ${r.rows === 1 ? 'rij' : 'rijen'}`;
    if (r.kind === 'ok')
      return `${prefix}${n(r.affected)} ${r.affected === 1 ? 'rij' : 'rijen'} gewijzigd`;
    return `${prefix}Fout`;
  }
}
