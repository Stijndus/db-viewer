import { Component, inject, OnInit } from '@angular/core';
import { ConnectionForm } from './features/connections/connection-form/connection-form';
import { ConnectionList } from './features/connections/connection-list/connection-list';
import { ConnectionsOverview } from './features/connections/connections-overview/connections-overview';
import { ConnectionsStore, connectionAddress } from './features/connections/connections.store';
import { PasswordPrompt } from './features/connections/password-prompt/password-prompt';

@Component({
  selector: 'app-root',
  imports: [ConnectionList, ConnectionsOverview, ConnectionForm, PasswordPrompt],
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly store = inject(ConnectionsStore);
  protected readonly address = connectionAddress;

  ngOnInit(): void {
    void this.store.init();
  }
}
