import { Component, inject, OnInit, signal } from '@angular/core';
import type { ConnectionProfile } from '../../shared/models';
import { ConfirmDanger } from './core/confirm-danger/confirm-danger';
import { Prompt } from './core/prompt/prompt';
import { ContextMenu } from './core/context-menu/context-menu';
import { CommandPalette } from './core/keybindings/command-palette';
import { KeybindingsEditor } from './core/keybindings/keybindings-editor';
import { KeybindingsStore } from './core/keybindings/keybindings.store';
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
    ContextMenu,
    ConfirmDanger,
    KeybindingsEditor,
    CommandPalette,
    Prompt,
  ],
  templateUrl: './app.html',
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
  protected readonly keys = inject(KeybindingsStore);
  /** Database name, or the file name for SQLite. */
  protected location(c: ConnectionProfile): string {
    return c.type === 'sqlite' ? connectionLocation(c) : c.database;
  }

  constructor() {
    // Before the editor, the grid and the browser: the keyboard shortcuts decide first.
    document.addEventListener('keydown', (e) => this.keys.onKeydown(e), true);
    this.registerCommands();
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

  /** App-wide commands: zoom, theme, keyboard shortcuts, the palette. */
  private registerCommands(): void {
    const keys = this.keys;
    keys.handle('workbench.zoomIn', () => void this.api.zoom('in'));
    keys.handle('workbench.zoomOut', () => void this.api.zoom('out'));
    keys.handle('workbench.zoomReset', () => void this.api.zoom('reset'));
    keys.handle('workbench.theme', () => this.theme.openPicker());
    keys.handle('workbench.keybindings', () => keys.editorOpen.set(true));
    keys.handle('workbench.commandPalette', () => keys.paletteOpen.set(true));
    keys.provideContext(() => {
      const tab = this.ws.active();
      return {
        connected: this.store.activeId() !== null,
        tableTab: tab?.kind === 'table',
        sqlTab: tab?.kind === 'sql',
      };
    });
  }
}
