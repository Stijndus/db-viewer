import { computed, inject, Injectable, signal } from '@angular/core';
import type { ExportSource, TransferProgress } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';
import { SchemaStore } from '../schema/schema.store';

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
  /** Start with this output (Ctrl+Shift+C: the clipboard). */
  output?: 'file' | 'clipboard';
}

/** A SQL import that was started; it keeps going when its dialog is closed. */
export interface ImportJob {
  jobId: string;
  connectionId: string;
  /** The file (or the file in the archive), for the status bar and the dialog. */
  name: string;
  database?: string;
}

/** Which import or export dialog is open, and the progress of running jobs. */
@Injectable({ providedIn: 'root' })
export class TransferStore {
  private readonly api = inject(DB_API);

  private readonly schema = inject(SchemaStore);

  /** The SQL import dialog: a new import (with a database to start with), or a started one. */
  readonly importFor = signal<{ connectionId: string; database?: string; jobId?: string } | null>(
    null,
  );
  /** Imports started in this session, running or finished, until their result was seen. */
  readonly imports = signal<ImportJob[]>([]);
  /** The imports still running, per connection or all. */
  readonly runningImports = computed(() =>
    this.imports().filter((j) => (this.progress()[j.jobId]?.phase ?? 'running') === 'running'),
  );
  readonly exportFor = signal<ExportTarget | null>(null);
  /** Latest progress per job id. */
  readonly progress = signal<Record<string, TransferProgress>>({});

  constructor() {
    this.api.onTransfer((p) => {
      const before = this.progress()[p.jobId]?.phase;
      this.progress.update((all) => ({ ...all, [p.jobId]: p }));
      // An import finished (also in the background): the schema may have new tables.
      const job = this.imports().find((j) => j.jobId === p.jobId);
      if (job && p.phase !== 'running' && before !== p.phase) {
        void this.schema.refresh(job.connectionId);
      }
    });
  }

  addImport(job: ImportJob): void {
    this.imports.update((all) => [...all, job]);
  }

  /** Opens the dialog of a started import (from the status bar). */
  showImport(jobId: string): void {
    const job = this.imports().find((j) => j.jobId === jobId);
    if (job) this.importFor.set({ connectionId: job.connectionId, jobId });
  }

  /**
   * Before disconnecting or quitting: imports running on this connection (or anywhere) are
   * stopped after the user agrees; false when they want to keep them.
   */
  confirmStopImports(connectionId?: string): boolean {
    const running = this.runningImports().filter(
      (j) => connectionId === undefined || j.connectionId === connectionId,
    );
    if (running.length === 0) return true;
    const names = running.map((j) => j.name).join(', ');
    const ok = confirm(
      `Er loopt nog een import (${names}). Verbreken stopt die import; wat al is uitgevoerd blijft staan. Doorgaan?`,
    );
    if (ok) for (const j of running) void this.api.cancelTransfer(j.jobId);
    return ok;
  }

  openImport(connectionId: string, database?: string): void {
    this.importFor.set({ connectionId, ...(database && { database }) });
  }

  openExport(target: ExportTarget): void {
    this.exportFor.set(target);
  }

  forget(jobId: string): void {
    this.progress.update(({ [jobId]: _, ...rest }) => rest);
    this.imports.update((all) => all.filter((j) => j.jobId !== jobId));
  }
}
