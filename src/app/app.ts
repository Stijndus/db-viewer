import { Component, computed, inject, OnInit } from '@angular/core';
import { ConnectionForm } from './features/connections/connection-form/connection-form';
import { ConnectionList } from './features/connections/connection-list/connection-list';
import { ConnectionsOverview } from './features/connections/connections-overview/connections-overview';
import { ConnectionsStore } from './features/connections/connections.store';
import { PasswordPrompt } from './features/connections/password-prompt/password-prompt';
import { ConnectionHome } from './features/schema/connection-home/connection-home';
import { ObjectStructure } from './features/schema/object-structure/object-structure';
import { SchemaTree } from './features/schema/schema-tree/schema-tree';
import { SchemaStore } from './features/schema/schema.store';

@Component({
  selector: 'app-root',
  imports: [
    ConnectionList,
    ConnectionsOverview,
    ConnectionForm,
    PasswordPrompt,
    SchemaTree,
    ObjectStructure,
    ConnectionHome,
  ],
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly store = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);

  /** The selected table or view, but only when it belongs to the connection on screen. */
  protected readonly selectedInActive = computed(() => {
    const selected = this.schema.selected();
    return selected && selected.connectionId === this.store.activeId() ? selected : null;
  });

  ngOnInit(): void {
    void this.store.init();
  }
}
