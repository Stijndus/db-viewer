import { Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { DIALECTS } from '../../../../shared/dialect';
import type { DbError } from '../../../../shared/models';
import {
  canCancelQuery,
  hasProcesses,
  type ProcessAction,
  type ServerProcess,
} from '../../../../shared/process-list';
import { DB_API } from '../../core/db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { WorkspaceStore } from '../workspace/workspace.store';

const REFRESH_KEY = 'dbv.processRefresh';
/** Choices for refreshing by itself, in seconds (0: off). */
const REFRESH_CHOICES = [0, 2, 5, 10, 30];
/** An active query running this long is marked. */
const SLOW_SECONDS = 30;

/**
 * The server's process list: connections and their running queries, refreshed by itself while the
 * tab is shown. A query can be stopped, or the whole connection ended.
 */
@Component({
  selector: 'app-process-list',
  templateUrl: './process-list.html',
})
export class ProcessListView {
  readonly connectionId = input.required<string>();
  /** The tab is shown: only then it refreshes by itself. */
  readonly active = input(true);

  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  private readonly ws = inject(WorkspaceStore);

  protected readonly refreshChoices = REFRESH_CHOICES;
  protected readonly slow = SLOW_SECONDS;

  protected readonly processes = signal<ServerProcess[] | null>(null);
  protected readonly at = signal<number | null>(null);
  protected readonly error = signal<DbError | null>(null);
  protected readonly loading = signal(false);
  protected readonly note = signal<string | null>(null);
  protected readonly selectedId = signal<string | null>(null);

  protected readonly query = signal('');
  protected readonly showIdle = signal(false);
  protected readonly showBackground = signal(false);
  protected readonly refreshEvery = signal(readRefresh());

  protected readonly profile = computed(
    () => this.connections.connections().find((c) => c.id === this.connectionId()) ?? null,
  );
  protected readonly dialect = computed(() => {
    const type = this.profile()?.type ?? 'mysql';
    return hasProcesses(type) ? type : 'mysql';
  });
  protected readonly canCancel = computed(() => canCancelQuery(this.dialect()));
  protected readonly readOnly = computed(() => this.profile()?.readOnly ?? false);

  protected readonly visible = computed(() => {
    const all = this.processes() ?? [];
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const idle = this.showIdle();
    const background = this.showBackground();
    return all.filter((p) => {
      if (!idle && p.idle && !p.own) return false;
      if (!background && p.background) return false;
      if (words.length === 0) return true;
      const text =
        `${p.id} ${p.user} ${p.host} ${p.database ?? ''} ${p.state} ${p.query ?? ''} ${p.program ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });
  protected readonly counts = computed(() => {
    const all = (this.processes() ?? []).filter((p) => !p.background);
    return { total: all.length, running: all.filter((p) => !p.idle && !p.own).length };
  });
  protected readonly hidden = computed(
    () => (this.processes() ?? []).length - this.visible().length,
  );
  protected readonly selected = computed(
    () => this.processes()?.find((p) => p.id === this.selectedId()) ?? null,
  );

  constructor() {
    // First load, and again for another connection.
    effect(() => {
      this.connectionId();
      this.processes.set(null);
      this.selectedId.set(null);
      void this.load();
    });
    // By itself every few seconds, while the tab is shown and the window visible.
    const destroy = inject(DestroyRef);
    let timer: ReturnType<typeof setInterval> | null = null;
    effect(() => {
      const seconds = this.refreshEvery();
      const active = this.active();
      if (timer) clearInterval(timer);
      timer = null;
      if (!seconds || !active) return;
      timer = setInterval(() => {
        if (document.visibilityState === 'visible' && !this.loading()) void this.load();
      }, seconds * 1000);
    });
    destroy.onDestroy(() => timer && clearInterval(timer));
  }

  async load(): Promise<void> {
    this.loading.set(true);
    const result = await this.api.listProcesses(this.connectionId());
    this.loading.set(false);
    if (result.ok) {
      this.processes.set(result.data.processes);
      this.at.set(result.data.at);
      this.error.set(null);
    } else this.error.set(result.error);
  }

  protected setRefresh(seconds: number): void {
    this.refreshEvery.set(seconds);
    try {
      localStorage.setItem(REFRESH_KEY, String(seconds));
    } catch {
      // Not remembered.
    }
  }

  protected select(p: ServerProcess): void {
    this.selectedId.set(this.selectedId() === p.id ? null : p.id);
  }

  protected async stop(p: ServerProcess, action: ProcessAction): Promise<void> {
    const what =
      action === 'cancel'
        ? `De query van proces ${p.id} (${p.user}) stoppen? De verbinding blijft bestaan.`
        : `De verbinding van proces ${p.id} (${p.user}) verbreken? Een lopende query wordt afgebroken en een open transactie teruggedraaid.`;
    if (!confirm(what)) return;
    const result = await this.api.stopProcess(this.connectionId(), action, p.id);
    if (!result.ok) {
      this.error.set(result.error);
      return;
    }
    this.error.set(null);
    this.flash(action === 'cancel' ? `Query van ${p.id} gestopt` : `Verbinding ${p.id} verbroken`);
    await this.load();
  }

  protected async copy(p: ServerProcess): Promise<void> {
    if (!p.query) return;
    try {
      await navigator.clipboard.writeText(p.query);
      this.flash('Query gekopieerd');
    } catch {
      // No clipboard.
    }
  }

  protected openInSql(p: ServerProcess): void {
    if (!p.query) return;
    const type = this.profile()?.type;
    this.ws.newSql(this.connectionId(), {
      text: p.query,
      ...(p.database && type && DIALECTS[type].editorDefaultContainer && { database: p.database }),
    });
  }

  private flash(text: string): void {
    this.note.set(text);
    setTimeout(() => this.note() === text && this.note.set(null), 2500);
  }

  protected duration(seconds: number | null): string {
    if (seconds === null) return '';
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    if (seconds < 86400)
      return `${Math.floor(seconds / 3600)} u ${Math.floor((seconds % 3600) / 60)} min`;
    return `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} u`;
  }

  protected time(at: number): string {
    return new Date(at).toLocaleTimeString('nl-NL');
  }

  protected oneLine(q: string | null): string {
    return q ? q.replace(/\s+/g, ' ').trim() : '';
  }
}

function readRefresh(): number {
  try {
    const v = Number(localStorage.getItem(REFRESH_KEY) ?? 5);
    return REFRESH_CHOICES.includes(v) ? v : 5;
  } catch {
    return 5;
  }
}
