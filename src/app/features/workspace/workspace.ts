import { Component, computed, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import type { ConnectionProfile } from '../../../../shared/models';
import { ConnectionHome } from '../schema/connection-home/connection-home';
import { ObjectView } from '../schema/object-view/object-view';
import type { SelectedObject } from '../schema/schema.store';
import { SqlPanel } from '../sql/sql-panel/sql-panel';
import { SqlStore } from '../sql/sql.store';
import { TransferStore } from '../transfer/transfer.store';
import { WorkspaceStore, type WorkspaceTab } from './workspace.store';

interface TabMenu {
  tab: WorkspaceTab;
  x: number;
  y: number;
}

/** Main area of an open connection: one tab bar for tables and SQL, and the active tab below it. */
@Component({
  selector: 'app-workspace',
  imports: [ObjectView, ConnectionHome, SqlPanel],
  templateUrl: './workspace.html',
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:pointerdown)': 'closeMenu($event)',
  },
})
export class Workspace {
  readonly connection = input.required<ConnectionProfile>();

  protected readonly ws = inject(WorkspaceStore);
  protected readonly sql = inject(SqlStore);
  protected readonly transfer = inject(TransferStore);
  private readonly bar = viewChild<ElementRef<HTMLElement>>('bar');
  protected readonly menu = signal<TabMenu | null>(null);

  /** Rendered tab bodies: only tabs opened this session, so restored tabs load lazily. */
  protected readonly bodies = computed(() => this.ws.tabs().filter((t) => this.ws.isVisited(t.id)));

  protected objectOf(tab: WorkspaceTab & { kind: 'table' }): SelectedObject {
    return {
      connectionId: this.connection().id,
      database: tab.database,
      name: tab.name,
      kind: tab.objectKind,
    };
  }

  protected sqlTab(tab: WorkspaceTab) {
    return this.sql.tab(this.connection().id, tab.id);
  }

  protected title(tab: WorkspaceTab): string {
    return tab.kind === 'table' ? tab.name : (this.sqlTab(tab)?.title ?? 'SQL');
  }

  /** Same table name in two databases: show the database too. */
  protected showDatabase(tab: WorkspaceTab): boolean {
    if (tab.kind !== 'table') return false;
    return this.ws
      .tabs()
      .some((t) => t.kind === 'table' && t.name === tab.name && t.database !== tab.database);
  }

  protected activate(tab: WorkspaceTab): void {
    this.ws.activate(this.connection().id, tab.id);
    this.scrollIntoView(tab.id);
  }

  protected close(tab: WorkspaceTab, event?: Event): void {
    event?.stopPropagation();
    this.ws.close(this.connection().id, tab.id);
  }

  protected newSql(): void {
    this.ws.newSql(this.connection().id);
    const active = this.ws.activeId();
    if (active) this.scrollIntoView(active);
  }

  /** Middle click closes a tab, like in a browser. */
  protected onAuxClick(tab: WorkspaceTab, event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.close(tab, event);
    }
  }

  protected openMenu(tab: WorkspaceTab, event: MouseEvent): void {
    event.preventDefault();
    this.menu.set({ tab, x: event.clientX, y: event.clientY });
  }

  protected closeMenu(event?: Event): void {
    if (event && (event.target as HTMLElement | null)?.closest('.tab-menu')) return;
    this.menu.set(null);
  }

  protected menuAction(action: 'close' | 'others' | 'right' | 'all'): void {
    const m = this.menu();
    this.menu.set(null);
    if (!m) return;
    const id = this.connection().id;
    if (action === 'close') this.ws.close(id, m.tab.id);
    if (action === 'others') this.ws.closeOthers(id, m.tab.id);
    if (action === 'right') this.ws.closeToRight(id, m.tab.id);
    if (action === 'all') this.ws.closeAll(id);
  }

  protected hasTabsRight(tab: WorkspaceTab): boolean {
    const tabs = this.ws.tabs();
    return tabs.findIndex((t) => t.id === tab.id) < tabs.length - 1;
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab switch tabs; Escape closes the tab menu. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.menu()) {
      this.menu.set(null);
      return;
    }
    if (event.ctrlKey && event.key === 'Tab') {
      event.preventDefault();
      this.ws.cycle(this.connection().id, event.shiftKey ? -1 : 1);
      const active = this.ws.activeId();
      if (active) this.scrollIntoView(active);
    }
  }

  private scrollIntoView(tabId: string): void {
    // After the bar has rendered the (possibly new) tab.
    setTimeout(() => {
      this.bar()
        ?.nativeElement.querySelector<HTMLElement>(`[data-tab="${tabId}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
}
