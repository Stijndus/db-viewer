import { Component, inject, OnInit, signal } from '@angular/core';
import type { ConnectionProfile } from '../../shared/models';
import { ThemePicker } from './core/theme-picker/theme-picker';
import { ThemeStore } from './core/theme.store';
import { UpdateStore } from './core/update.store';
import { DB_API } from './core/db-api';
import { ConnectionForm } from './features/connections/connection-form/connection-form';
import { ConnectionList } from './features/connections/connection-list/connection-list';
import { ConnectionsOverview } from './features/connections/connections-overview/connections-overview';
import { ConnectionsStore, connectionLocation } from './features/connections/connections.store';
import { WhatsNew } from './core/whats-new/whats-new';
import { ExportDialog } from './features/transfer/export-dialog/export-dialog';
import { ImportDialog } from './features/transfer/import-dialog/import-dialog';
import { TransferStore } from './features/transfer/transfer.store';
import { HostKeyPrompt } from './features/connections/host-key-prompt/host-key-prompt';
import { PasswordPrompt } from './features/connections/password-prompt/password-prompt';
import { SchemaTree } from './features/schema/schema-tree/schema-tree';
import { ConfirmWrite } from './features/sql/confirm-write/confirm-write';
import { SqlStore } from './features/sql/sql.store';
import { Workspace } from './features/workspace/workspace';
import { WorkspaceStore } from './features/workspace/workspace.store';

@Component({
  selector: 'app-root',
  imports: [
    ConnectionList,
    ConnectionsOverview,
    ConnectionForm,
    PasswordPrompt,
    HostKeyPrompt,
    WhatsNew,
    ImportDialog,
    ExportDialog,
    SchemaTree,
    Workspace,
    ConfirmWrite,
    ThemePicker,
  ],
  templateUrl: './app.html',
  host: { '(window:keydown)': 'onKeydown($event)' },
})
export class App implements OnInit {
  protected readonly store = inject(ConnectionsStore);
  protected readonly sql = inject(SqlStore);
  protected readonly updates = inject(UpdateStore);
  protected readonly ws = inject(WorkspaceStore);
  protected readonly transfer = inject(TransferStore);
  protected readonly theme = inject(ThemeStore);
  private readonly api = inject(DB_API);
  /** Zoom factor; shown in the status bar when it is not 100%. */
  protected readonly zoom = signal(1);
  /** Ctrl+K was pressed: the next key may complete a chord (Ctrl+K Ctrl+T = theme). */
  private chordUntil = 0;
  /** Database name, or the file name for SQLite. */
  protected location(c: ConnectionProfile): string {
    return c.type === 'sqlite' ? connectionLocation(c) : c.database;
  }

  ngOnInit(): void {
    void this.store.init();
    void this.updates.init();
    this.api.onZoom((factor) => this.zoom.set(factor));
    // Ctrl+scroll zooms. Not passive, so the browser's own zoom is held back (one zoom, saved).
    window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    void this.api.zoom('get').then((r) => r.ok && this.zoom.set(r.data));
  }

  protected resetZoom(): void {
    void this.api.zoom('reset');
  }

  protected zoomPercent(): string {
    return `${Math.round(this.zoom() * 100)}%`;
  }

  private lastWheelZoom = 0;

  private onWheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
    event.preventDefault();
    // A trackpad sends many small steps: at most one zoom step per 120 ms.
    const now = Date.now();
    if (now - this.lastWheelZoom < 120) return;
    this.lastWheelZoom = now;
    void this.api.zoom(event.deltaY < 0 ? 'in' : 'out');
  }

  /** Ctrl+= / Ctrl+- / Ctrl+0 zoom; Ctrl+K Ctrl+T opens the theme picker, like in VS Code. */
  protected onKeydown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey) {
      const zoom =
        event.key === '=' || event.key === '+'
          ? 'in'
          : event.key === '-' || event.key === '_'
            ? 'out'
            : event.key === '0'
              ? 'reset'
              : null;
      if (zoom) {
        event.preventDefault();
        void this.api.zoom(zoom);
        return;
      }
    }
    if (mod && event.key.toLowerCase() === 'k' && !event.shiftKey && !event.altKey) {
      this.chordUntil = Date.now() + 1500;
      return;
    }
    if (mod && event.key.toLowerCase() === 't' && Date.now() < this.chordUntil) {
      event.preventDefault();
      this.chordUntil = 0;
      this.theme.openPicker();
      return;
    }
    if (!['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) this.chordUntil = 0;
  }
}
