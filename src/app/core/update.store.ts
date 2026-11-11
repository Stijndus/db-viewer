import { computed, inject, Injectable, signal } from '@angular/core';
import type { ReleaseNote, UpdateState } from '../../../shared/models';
import { DB_API } from './db-api';
import { renderMarkdown } from './markdown';

const SEEN_KEY = 'dbv.seenVersion';

/** The "Wat is er nieuw" dialog: one or more versions, newest first. */
export interface WhatsNew {
  title: string;
  entries: { version: string; html: string }[];
  /** Shown for an update that is not installed yet. */
  pending?: boolean;
}

/** Compares x.y.z versions; anything else sorts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? [0, 0, 0, 0]).slice(1).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Update status pushed by the main process, plus the app version for the status bar. */
@Injectable({ providedIn: 'root' })
export class UpdateStore {
  private readonly api = inject(DB_API);
  private unsubscribe: (() => void) | null = null;

  readonly state = signal<UpdateState>({ status: 'unsupported' });
  readonly version = signal('');
  readonly notes = signal<ReleaseNote[]>([]);
  readonly whatsNew = signal<WhatsNew | null>(null);
  /** "Later" hides the banner for this version only. */
  private readonly dismissedVersion = signal<string | null>(null);

  readonly banner = computed(() => {
    const s = this.state();
    if (s.status !== 'ready' && s.status !== 'manual') return null;
    return s.version === this.dismissedVersion() ? null : s;
  });

  /** Short status text next to the version in the status bar. */
  readonly statusText = computed(() => {
    const s = this.state();
    switch (s.status) {
      case 'checking':
        return 'Zoeken naar updates…';
      case 'current':
        return 'Up-to-date';
      case 'downloading':
        return `Update ${s.version} downloaden (${s.percent}%)`;
      case 'ready':
        return `Update ${s.version} klaar`;
      case 'manual':
        return `Versie ${s.version} beschikbaar`;
      case 'error':
        return s.message;
      default:
        return null;
    }
  });

  async init(): Promise<void> {
    const info = await this.api.appInfo();
    if (info.ok) this.version.set(info.data.version);
    this.unsubscribe?.();
    this.unsubscribe = this.api.onUpdateState((state) => this.state.set(state));
    const current = await this.api.updateState();
    if (current.ok) this.state.set(current.data);
    const notes = await this.api.releaseNotes();
    if (notes.ok) this.notes.set(notes.data);
    this.showNewSinceLastStart();
  }

  /** After an update: the notes of every version since the one used last time, once. */
  private showNewSinceLastStart(): void {
    const version = this.version();
    if (!version) return;
    let seen: string | null = null;
    let usedBefore = false;
    try {
      seen = localStorage.getItem(SEEN_KEY);
      // Versions before 0.8.0 didn't remember this; any saved UI state means the app was used.
      usedBefore = Object.keys(localStorage).some((k) => k.startsWith('dbv.') && k !== SEEN_KEY);
      localStorage.setItem(SEEN_KEY, version);
    } catch {
      return; // no storage: never nag
    }
    if (seen === null && !usedBefore) return; // fresh install
    const since = seen ?? '0.0.0';
    const entries = this.notes().filter(
      (n) =>
        compareVersions(n.version, version) <= 0 &&
        (seen === null ? n.version === version : compareVersions(n.version, since) > 0),
    );
    if (entries.length === 0) return;
    this.whatsNew.set({
      title: entries.length === 1 ? `Nieuw in versie ${version}` : `Nieuw sinds versie ${since}`,
      entries: entries.map((n) => ({ version: n.version, html: renderMarkdown(n.markdown) })),
    });
  }

  /** All release notes, from the status bar. */
  showAllNotes(): void {
    this.whatsNew.set({
      title: 'Release notes',
      entries: this.notes().map((n) => ({ version: n.version, html: renderMarkdown(n.markdown) })),
    });
  }

  /** The notes of an update that is downloading or ready, from GitHub. */
  showUpdateNotes(): void {
    const s = this.state();
    if (s.status !== 'ready' && s.status !== 'manual' && s.status !== 'downloading') return;
    this.whatsNew.set({
      title: `Nieuw in versie ${s.version}`,
      entries: [{ version: s.version, html: s.notes ?? '<p>Geen release notes gevonden.</p>' }],
      pending: true,
    });
  }

  async check(): Promise<void> {
    const result = await this.api.checkForUpdates();
    if (result.ok) this.state.set(result.data);
  }

  install(): void {
    void this.api.installUpdate();
  }

  dismiss(): void {
    const s = this.state();
    if (s.status === 'ready' || s.status === 'manual') this.dismissedVersion.set(s.version);
  }
}
