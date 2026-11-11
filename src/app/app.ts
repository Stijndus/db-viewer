import { Component, inject, OnInit } from '@angular/core';
import type { ConnectionProfile } from '../../shared/models';
import { UpdateStore } from './core/update.store';
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
  ],
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly store = inject(ConnectionsStore);
  protected readonly sql = inject(SqlStore);
  protected readonly updates = inject(UpdateStore);
  protected readonly ws = inject(WorkspaceStore);
  protected readonly transfer = inject(TransferStore);
  /** Database name, or the file name for SQLite. */
  protected location(c: ConnectionProfile): string {
    return c.type === 'sqlite' ? connectionLocation(c) : c.database;
  }

  ngOnInit(): void {
    void this.store.init();
    void this.updates.init();
  }
}
