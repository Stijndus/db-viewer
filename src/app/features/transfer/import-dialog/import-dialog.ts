import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  type OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { DIALECTS } from '../../../../../shared/dialect';
import type { DbError, ImportFileInfo, SqlImportRequest } from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { SchemaStore } from '../../schema/schema.store';
import { TransferStore } from '../transfer.store';

/**
 * Runs a SQL script on the connection: a .sql or .sql.gz file, or one out of a zip or 7z archive,
 * also password-protected. Shows progress while it runs and what failed afterwards.
 */
@Component({
  selector: 'app-import-dialog',
  templateUrl: './import-dialog.html',
})
export class ImportDialog implements OnInit {
  readonly connectionId = input.required<string>();
  /** Import into this database (from the tree's context menu); else the usual default. */
  readonly intoDatabase = input<string | undefined>();
  /** Show this started import (opened again from the status bar). */
  readonly job = input<string | undefined>();

  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);
  protected readonly transfer = inject(TransferStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly profile = computed(
    () => this.connections.connections().find((c) => c.id === this.connectionId()) ?? null,
  );
  protected readonly container = computed(
    () => DIALECTS[this.profile()?.type ?? 'mysql'].container,
  );

  protected readonly info = signal<ImportFileInfo | null>(null);
  protected readonly file = signal('');
  protected readonly entry = signal<string | null>(null);
  protected readonly password = signal('');
  /** The archive hides its file names: the password is needed to see them. */
  protected readonly needsPasswordToList = signal(false);
  protected readonly database = signal('');
  protected readonly onError = signal<'stop' | 'skip'>('stop');
  protected readonly busy = signal(false);
  protected readonly error = signal<DbError | null>(null);
  protected readonly jobId = signal<string | null>(null);

  protected readonly databases = computed(() => {
    const state = this.schema.databases(this.connectionId());
    return state?.status === 'loaded' ? state.data.filter((d) => !d.system).map((d) => d.name) : [];
  });

  protected readonly selectedEntry = computed(
    () => this.info()?.entries.find((e) => e.path === this.entry()) ?? null,
  );
  protected readonly passwordNeeded = computed(
    () => this.needsPasswordToList() || Boolean(this.selectedEntry()?.encrypted),
  );
  protected readonly canStart = computed(() => {
    const info = this.info();
    if (!info || this.busy() || this.profile()?.readOnly) return false;
    if (info.kind === 'archive' && !this.selectedEntry()) return false;
    return !this.passwordNeeded() || Boolean(this.password());
  });

  protected readonly progress = computed(() => {
    const id = this.jobId();
    return id ? (this.transfer.progress()[id] ?? null) : null;
  });
  protected readonly running = computed(() => {
    const p = this.progress();
    return this.jobId() !== null && (!p || p.phase === 'running');
  });
  protected readonly percent = computed(() => {
    const p = this.progress();
    if (!p?.totalBytes) return null;
    return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100));
  });

  /** Stop was clicked and the import has not ended yet. */
  protected readonly stopping = computed(() => {
    const id = this.jobId();
    return id !== null && this.running() && this.transfer.stopping().has(id);
  });

  /** The started import this dialog shows, for its name. */
  protected readonly jobInfo = computed(() => {
    const id = this.jobId();
    return id ? (this.transfer.imports().find((j) => j.jobId === id) ?? null) : null;
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());

    // Default target: the database the profile opens in, else the selected one, else the first.
    const selected = this.schema.selected();
    queueMicrotask(() => {
      const p = this.profile();
      const dbs = this.databases();
      const preferred = [
        this.intoDatabase() ?? '',
        selected?.connectionId === this.connectionId() ? selected.database : '',
        p?.type === 'sqlite' ? 'main' : (p?.database ?? ''),
      ];
      this.database.set(preferred.find((d) => d && dbs.includes(d)) ?? dbs[0] ?? '');
    });
  }

  protected async choose(): Promise<void> {
    const picked = await this.api.pickImportFile(this.file() || undefined);
    if (!picked.ok || !picked.data) return;
    this.file.set(picked.data);
    this.password.set('');
    this.entry.set(null);
    this.info.set(null);
    this.needsPasswordToList.set(false);
    await this.inspect();
  }

  /** Reads the file (or the archive's list); a 7z with hidden names asks for the password first. */
  protected async inspect(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    const result = await this.api.inspectImportFile(this.file(), this.password() || undefined);
    this.busy.set(false);
    if (!result.ok) {
      if (result.error.code === 'ARCHIVE_PASSWORD_REQUIRED') {
        this.needsPasswordToList.set(true);
        return;
      }
      this.error.set(result.error);
      return;
    }
    this.info.set(result.data);
    if (result.data.kind === 'archive') {
      // Pick the obvious one: the only .sql file, else the only script, else the only file.
      const entries = result.data.entries;
      const sql = entries.filter((e) => /\.sql$/i.test(e.path));
      const scripts = entries.filter((e) => e.script);
      const only = [sql, scripts, entries].find((list) => list.length === 1)?.[0];
      this.entry.set(only?.path ?? null);
    }
  }

  protected async start(): Promise<void> {
    if (!this.canStart()) return;
    const info = this.info()!;
    const request: SqlImportRequest = {
      file: info.file,
      onError: this.onError(),
      ...(info.kind === 'archive' && this.entry() && { entry: this.entry()! }),
      ...(this.password() && { password: this.password() }),
      ...(this.database() && { database: this.database() }),
    };
    this.error.set(null);
    this.busy.set(true);
    const result = await this.api.startSqlImport(this.connectionId(), request);
    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.error);
      return;
    }
    this.jobId.set(result.data.jobId);
    this.transfer.addImport({
      jobId: result.data.jobId,
      connectionId: this.connectionId(),
      name: (info.kind === 'archive' && this.entry()?.split('/').pop()) || info.name,
      ...(this.database() && { database: this.database() }),
    });
  }

  ngOnInit(): void {
    const job = this.job();
    if (job) this.jobId.set(job);
  }

  protected stop(): void {
    const id = this.jobId();
    if (id) this.transfer.stop(id);
  }

  /** Closes the dialog; a running import goes on (the store refreshes the schema when done). */
  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** Closing a finished import forgets it; a running one goes on in the background. */
  protected onClose(): void {
    const id = this.jobId();
    if (id && !this.running()) this.transfer.forget(id);
    this.transfer.importFor.set(null);
  }

  /** Esc while running: on to the background, like the button. */
  protected onCancel(_event: Event): void {}

  protected size(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toLocaleString('nl-NL', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
  }

  protected count(n: number): string {
    return n.toLocaleString('nl-NL');
  }
}
