import { computed, inject, Injectable, signal } from '@angular/core';
import type { UpdateState } from '../../../shared/models';
import { DB_API } from './db-api';

/** Update status pushed by the main process, plus the app version for the status bar. */
@Injectable({ providedIn: 'root' })
export class UpdateStore {
  private readonly api = inject(DB_API);
  private unsubscribe: (() => void) | null = null;

  readonly state = signal<UpdateState>({ status: 'unsupported' });
  readonly version = signal('');
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
