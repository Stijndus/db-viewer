import { Component, inject } from '@angular/core';
import { DIALECTS } from '../../../../../shared/dialect';
import { ConnectionsStore, connectionAddress, STATUS_LABEL } from '../connections.store';

/** Main area when no connection is open: saved connections as cards. */
@Component({
  selector: 'app-connections-overview',
  templateUrl: './connections-overview.html',
})
export class ConnectionsOverview {
  protected readonly store = inject(ConnectionsStore);
  protected readonly address = connectionAddress;
  protected readonly dialects = DIALECTS;
  protected readonly label = STATUS_LABEL;
}
