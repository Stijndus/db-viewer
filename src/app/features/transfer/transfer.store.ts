import { inject, Injectable, signal } from '@angular/core';
import type { ExportSource, TransferProgress } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';

/** What the export dialog was opened for. */
export interface ExportTarget {
  connectionId: string;
  source: ExportSource;
  /** Shown in the title, e.g. the table name. */
  title: string;
  /** File name without extension for the save dialog. */
  baseName: string;
  /** Shown at the top of the dialog, e.g. where selected rows come from. */
  note?: string;
}

/** Which import or export dialog is open, and the progress of running jobs. */
@Injectable({ providedIn: 'root' })
export class TransferStore {
  private readonly api = inject(DB_API);

  /** The SQL import dialog, for this connection (and a database to start with). */
  readonly importFor = signal<{ connectionId: string; database?: string } | null>(null);
  readonly exportFor = signal<ExportTarget | null>(null);
  /** Latest progress per job id. */
  readonly progress = signal<Record<string, TransferProgress>>({});

  constructor() {
    this.api.onTransfer((p) => this.progress.update((all) => ({ ...all, [p.jobId]: p })));
  }

  openImport(connectionId: string, database?: string): void {
    this.importFor.set({ connectionId, ...(database && { database }) });
  }

  openExport(target: ExportTarget): void {
    this.exportFor.set(target);
  }

  forget(jobId: string): void {
    this.progress.update(({ [jobId]: _, ...rest }) => rest);
  }
}
