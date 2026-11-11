import { Component, computed, inject, input, output } from '@angular/core';
import type { ConnectionProfile } from '../../../../../shared/models';
import { ConnectionsStore, connectionAddress } from '../../connections/connections.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { SchemaStore } from '../schema.store';

/** Main panel for an open connection with nothing selected yet. */
@Component({
  selector: 'app-connection-home',
  template: `
    <div class="intro">
      <h1>Verbonden met {{ connection().name }}</h1>
      <p class="mono muted">
        {{ address(connection()) }} · {{ connections.serverVersions()[connection().id] }}
      </p>
    </div>
    <div class="placeholder">
      <strong>Kies een tabel of view in de boom links, of schrijf zelf een query.</strong>
      <span class="muted">
        @if (databaseCount() !== null) {
          {{ databaseCount() }} {{ databaseCount() === 1 ? 'database' : 'databases' }} zichtbaar
          voor {{ connection().user }}.
        }
        Pijltjestoetsen werken in de boom: rechts klapt open, links klapt dicht.
      </span>
    </div>
    <div class="row">
      <button type="button" class="btn btn-primary" (click)="newSql.emit()">
        Nieuwe SQL-query
      </button>
      <button type="button" class="btn btn-ghost" (click)="ws.disconnect(connection().id)">
        Verbreken
      </button>
    </div>
  `,
})
export class ConnectionHome {
  readonly connection = input.required<ConnectionProfile>();
  readonly newSql = output<void>();
  protected readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);
  protected readonly ws = inject(WorkspaceStore);
  protected readonly address = connectionAddress;

  protected readonly databaseCount = computed(() => {
    const state = this.schema.databases(this.connection().id);
    return state?.status === 'loaded' ? state.data.filter((d) => !d.system).length : null;
  });
}
