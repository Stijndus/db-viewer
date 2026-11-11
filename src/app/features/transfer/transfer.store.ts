import { inject, Injectable, signal } from '@angular/core';
import type { TransferProgress } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';

/** Which import or export dialog is open, and the progress of running jobs. */
@Injectable({ providedIn: 'root' })
export class TransferStore {
  private readonly api = inject(DB_API);

  /** The SQL import dialog, for this connection. */
  readonly importFor = signal<string | null>(null);
  /** Latest progress per job id. */
  readonly progress = signal<Record<string, TransferProgress>>({});

  constructor() {
    this.api.onTransfer((p) => this.progress.update((all) => ({ ...all, [p.jobId]: p })));
  }

  openImport(connectionId: string): void {
    this.importFor.set(connectionId);
  }

  forget(jobId: string): void {
    this.progress.update(({ [jobId]: _, ...rest }) => rest);
  }
}
