import { Component, computed, inject, input } from '@angular/core';
import type { ConnectionProfile } from '../../../../shared/models';
import { ConnectionHome } from '../schema/connection-home/connection-home';
import { ObjectView } from '../schema/object-view/object-view';
import { SchemaStore } from '../schema/schema.store';
import { SqlPanel } from '../sql/sql-panel/sql-panel';
import { SqlStore, type SqlTab } from '../sql/sql.store';

/** Main area of an open connection: the selected table, or one of the SQL tabs. */
@Component({
  selector: 'app-workspace',
  imports: [ObjectView, ConnectionHome, SqlPanel],
  templateUrl: './workspace.html',
})
export class Workspace {
  readonly connection = input.required<ConnectionProfile>();

  protected readonly sql = inject(SqlStore);
  private readonly schema = inject(SchemaStore);

  /** The selected table or view, but only when it belongs to this connection. */
  protected readonly selected = computed(() => {
    const s = this.schema.selected();
    return s && s.connectionId === this.connection().id ? s : null;
  });

  /** Wrapped in an array so switching tabs gives a fresh editor per tab (see the template). */
  protected readonly activeTabs = computed(() => {
    const tab = this.sql.activeTab();
    return tab ? [tab] : [];
  });

  protected showObject(): void {
    this.sql.show(this.connection().id, { kind: 'object' });
  }

  protected showTab(tab: SqlTab): void {
    this.sql.show(this.connection().id, { kind: 'sql', tabId: tab.id });
  }

  protected newTab(): void {
    this.sql.newTab(this.connection().id);
  }

  protected close(tab: SqlTab, event: Event): void {
    event.stopPropagation();
    if (tab.text.trim() && !confirm(`${tab.title} sluiten? De tekst gaat verloren.`)) return;
    void this.sql.closeTab(this.connection().id, tab.id);
  }

  /** Middle click closes a tab, like in a browser. */
  protected onAuxClick(tab: SqlTab, event: MouseEvent): void {
    if (event.button === 1) this.close(tab, event);
  }
}
