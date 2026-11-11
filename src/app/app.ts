import { Component, inject, OnInit } from '@angular/core';
import { UpdateStore } from './core/update.store';
import { ConnectionForm } from './features/connections/connection-form/connection-form';
import { ConnectionList } from './features/connections/connection-list/connection-list';
import { ConnectionsOverview } from './features/connections/connections-overview/connections-overview';
import { ConnectionsStore } from './features/connections/connections.store';
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

  ngOnInit(): void {
    void this.store.init();
    void this.updates.init();
  }
}
