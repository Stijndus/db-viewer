import { Component, computed, inject, signal } from '@angular/core';
import {
  ConnectionsStore,
  connectionAddress,
  connectionLocation,
  STATUS_LABEL,
} from '../connections.store';

/** Sidebar: saved connections with live status. Double-click or Enter connects. */
@Component({
  selector: 'app-connection-list',
  templateUrl: './connection-list.html',
})
export class ConnectionList {
  protected readonly store = inject(ConnectionsStore);
  protected readonly query = signal('');
  protected readonly address = connectionAddress;
  protected readonly location = connectionLocation;
  protected readonly label = STATUS_LABEL;

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.store.connections();
    if (!q) return all;
    return all.filter((c) => `${c.name} ${c.host} ${c.database}`.toLowerCase().includes(q));
  });

  protected select(id: string): void {
    if (this.store.statusOf(id) === 'connected') this.store.activeId.set(id);
  }

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
