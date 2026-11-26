import { Component, computed, inject, input } from '@angular/core';
import type { ConnectionProfile } from '../../../../shared/models';
import { hasUsers } from '../../../../shared/user-sql';
import { KeybindingsStore } from '../../core/keybindings/keybindings.store';
import { SchemaStore } from '../schema/schema.store';
import { TransferStore } from '../transfer/transfer.store';
import { WorkspaceStore } from './workspace.store';

/** The actions on a whole connection, as a row of icons under the schema heading. */
@Component({
  selector: 'app-connection-tools',
  templateUrl: './connection-tools.html',
})
export class ConnectionTools {
  readonly connection = input.required<ConnectionProfile>();

  protected readonly ws = inject(WorkspaceStore);
  protected readonly transfer = inject(TransferStore);
  protected readonly keys = inject(KeybindingsStore);
  private readonly schema = inject(SchemaStore);
  /** SQLite has no users. */
  protected readonly hasUsers = computed(() => hasUsers(this.connection().type));

  /** Into the table of the active tab, when that is a table. */
  protected openDataImport(): void {
    const tab = this.ws.active();
    if (tab?.kind === 'table' && tab.objectKind === 'table') {
      this.transfer.openDataImport(this.connection().id, tab.database, tab.name);
    } else this.transfer.openDataImport(this.connection().id);
  }

  /** Export a database as SQL: the one of the active table, else the profile's own. */
  protected exportDatabase(): void {
    const conn = this.connection();
    const active = this.ws.active();
    const state = this.schema.databases(conn.id);
    const names =
      state?.status === 'loaded' ? state.data.filter((d) => !d.system).map((d) => d.name) : [];
    const preferred = [
      active?.kind === 'table' ? active.database : '',
      conn.type === 'sqlite' ? 'main' : conn.database,
      conn.type === 'postgres' ? 'public' : conn.type === 'mssql' ? 'dbo' : '',
    ].find((d) => d && names.includes(d));
    const database = preferred ?? names[0] ?? '';
    this.transfer.openExport({
      connectionId: conn.id,
      title: conn.name,
      baseName: database || conn.name,
      source: { kind: 'database', database, tables: [], structure: true, data: true },
    });
  }
}
