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
import { autoMap, canDisableForeignKeys, isWritableColumn } from '../../../../../shared/import-sql';
import type {
  ColumnInfo,
  CsvEncoding,
  DataFileOptions,
  DataImportRequest,
  DataPreview,
  DbError,
  ImportFileInfo,
} from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { SchemaStore } from '../../schema/schema.store';
import { TransferStore } from '../transfer.store';

const ARCHIVE = /\.(zip|7z)$/i;

/**
 * Loads a CSV, JSON or Excel file (also from a zip or 7z) into an existing table: a preview of the
 * first rows, file columns matched to table columns, append / empty first / update by key, and
 * one transaction or skipped bad rows. Runs as a job like the SQL import.
 */
@Component({
  selector: 'app-data-import-dialog',
  templateUrl: './data-import-dialog.html',
})
export class DataImportDialog implements OnInit {
  readonly connectionId = input.required<string>();
  readonly intoDatabase = input<string | undefined>();
  readonly intoTable = input<string | undefined>();
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
  protected readonly dialect = computed(() => this.profile()?.type ?? 'mysql');
  protected readonly container = computed(() => DIALECTS[this.dialect()].container);

  protected readonly file = signal('');
  protected readonly info = signal<ImportFileInfo | null>(null);
  protected readonly entry = signal<string | null>(null);
  protected readonly password = signal('');
  protected readonly needsPasswordToList = signal(false);

  protected readonly preview = signal<DataPreview | null>(null);
  protected readonly delimiter = signal<string | undefined>(undefined);
  protected readonly encoding = signal<CsvEncoding | undefined>(undefined);
  protected readonly header = signal(true);
  protected readonly sheet = signal<string | undefined>(undefined);

  protected readonly database = signal('');
  protected readonly table = signal('');
  protected readonly tables = signal<string[]>([]);
  protected readonly columns = signal<ColumnInfo[]>([]);
  /** Per file column: the table column it goes into, or null. */
  protected readonly mapping = signal<(string | null)[]>([]);

  protected readonly mode = signal<DataImportRequest['mode']>('append');
  protected readonly onError = signal<DataImportRequest['onError']>('rollback');
  protected readonly emptyAsNull = signal(false);
  protected readonly disableForeignKeys = signal(false);

  protected readonly busy = signal(false);
  protected readonly error = signal<DbError | null>(null);
  protected readonly jobId = signal<string | null>(null);

  protected readonly delimiters = [
    { value: ',', label: 'Komma (,)' },
    { value: ';', label: 'Puntkomma (;)' },
    { value: '\t', label: 'Tab' },
    { value: '|', label: 'Verticale streep (|)' },
  ];
  protected readonly encodings: { value: CsvEncoding; label: string }[] = [
    { value: 'utf-8', label: 'UTF-8' },
    { value: 'windows-1252', label: 'Windows-1252 (Excel)' },
    { value: 'iso-8859-1', label: 'ISO-8859-1' },
    { value: 'utf-16le', label: 'UTF-16 LE' },
    { value: 'utf-16be', label: 'UTF-16 BE' },
  ];

  protected readonly databases = computed(() => {
    const state = this.schema.databases(this.connectionId());
    return state?.status === 'loaded' ? state.data.filter((d) => !d.system).map((d) => d.name) : [];
  });
  protected readonly targets = computed(() => this.columns().filter(isWritableColumn));
  protected readonly keyColumns = computed(() =>
    this.columns()
      .filter((c) => c.key === 'primary')
      .map((c) => c.name),
  );
  protected readonly canFk = computed(() => canDisableForeignKeys(this.dialect()));
  protected readonly dataEntries = computed(() => this.info()?.entries ?? []);
  protected readonly selectedEntry = computed(
    () => this.info()?.entries.find((e) => e.path === this.entry()) ?? null,
  );
  protected readonly passwordNeeded = computed(
    () => this.needsPasswordToList() || Boolean(this.selectedEntry()?.encrypted),
  );

  protected readonly mappedCount = computed(() => this.mapping().filter(Boolean).length);
  /** Table columns chosen twice: each can take one file column. */
  protected readonly duplicates = computed(() => {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const m of this.mapping()) {
      if (!m) continue;
      if (seen.has(m)) twice.add(m);
      seen.add(m);
    }
    return twice;
  });
  protected readonly duplicateNames = computed(() => [...this.duplicates()].join(', '));
  /** Upsert: the key columns that no file column fills. */
  protected readonly missingKeys = computed(() =>
    this.keyColumns().filter((k) => !this.mapping().includes(k)),
  );
  /** Required columns (NOT NULL, no default, not generated) that get nothing from the file. */
  protected readonly unfilledRequired = computed(() =>
    this.targets()
      .filter(
        (c) =>
          !c.nullable &&
          c.defaultValue === null &&
          !/auto_increment|identity/i.test(c.extra) &&
          !(this.dialect() === 'sqlite' && c.key === 'primary' && /^integer$/i.test(c.type)) &&
          !this.mapping().includes(c.name),
      )
      .map((c) => c.name),
  );

  protected readonly canStart = computed(() => {
    if (this.busy() || this.profile()?.readOnly || !this.preview() || !this.table()) return false;
    if (this.mappedCount() === 0 || this.duplicates().size > 0) return false;
    if (this.mode() === 'upsert' && (this.keyColumns().length === 0 || this.missingKeys().length))
      return false;
    return true;
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
    if (p && p.phase !== 'running') return 100;
    if (!p?.totalBytes) return null;
    return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100));
  });
  protected readonly stopping = computed(() => {
    const id = this.jobId();
    return id !== null && this.running() && this.transfer.stopping().has(id);
  });
  protected readonly jobInfo = computed(() => {
    const id = this.jobId();
    return id ? (this.transfer.imports().find((j) => j.jobId === id) ?? null) : null;
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  ngOnInit(): void {
    const job = this.job();
    if (job) {
      this.jobId.set(job);
      return;
    }
    // Into: the given table, else the selected one; the database the profile opens in otherwise.
    const selected = this.schema.selected();
    const p = this.profile();
    const dbs = this.databases();
    const own = selected?.connectionId === this.connectionId() ? selected : null;
    const preferred = [
      this.intoDatabase() ?? '',
      own?.database ?? '',
      p?.type === 'sqlite' ? 'main' : (p?.database ?? ''),
    ];
    const db = preferred.find((d) => d && dbs.includes(d)) ?? dbs[0] ?? '';
    const table =
      this.intoTable() ?? (own?.database === db && own.kind === 'table' ? own.name : '');
    void this.setDatabase(db, table);
  }

  protected async choose(): Promise<void> {
    const picked = await this.api.pickImportFile(this.file() || undefined, 'data');
    if (!picked.ok || !picked.data) return;
    this.file.set(picked.data);
    this.password.set('');
    this.entry.set(null);
    this.info.set(null);
    this.preview.set(null);
    this.needsPasswordToList.set(false);
    this.delimiter.set(undefined);
    this.encoding.set(undefined);
    this.sheet.set(undefined);
    this.error.set(null);
    if (ARCHIVE.test(picked.data)) await this.inspect();
    else await this.loadPreview();
  }

  /** An archive: list it (a 7z with hidden names asks for the password first). */
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
    const data = result.data.entries.filter((e) => e.data);
    const only =
      data.length === 1
        ? data[0]
        : result.data.entries.length === 1
          ? result.data.entries[0]
          : null;
    if (only) await this.chooseEntry(only.path);
  }

  protected async chooseEntry(path: string): Promise<void> {
    this.entry.set(path);
    this.preview.set(null);
    this.delimiter.set(undefined);
    this.encoding.set(undefined);
    this.sheet.set(undefined);
    if (!this.selectedEntry()?.encrypted || this.password()) await this.loadPreview();
  }

  private options(): DataFileOptions {
    return {
      file: this.file(),
      header: this.header(),
      ...(this.entry() && { entry: this.entry()! }),
      ...(this.password() && { password: this.password() }),
      ...(this.delimiter() !== undefined && { delimiter: this.delimiter()! }),
      ...(this.encoding() && { encoding: this.encoding()! }),
      ...(this.sheet() && { sheet: this.sheet()! }),
    };
  }

  /** Reads the first rows again (after choosing the file, delimiter, encoding, sheet, header). */
  protected async loadPreview(): Promise<void> {
    if (!this.file() || (this.info() && !this.entry())) return;
    this.error.set(null);
    this.busy.set(true);
    const result = await this.api.previewDataFile(this.options());
    this.busy.set(false);
    if (!result.ok) {
      this.preview.set(null);
      this.error.set(result.error);
      return;
    }
    const before = this.preview()?.columns;
    const p = result.data;
    this.preview.set(p);
    if (p.delimiter !== undefined) this.delimiter.set(p.delimiter);
    if (p.encoding) this.encoding.set(p.encoding);
    if (p.sheet) this.sheet.set(p.sheet);
    // Same columns as before: keep what was matched by hand.
    if (!before || before.join('\u0000') !== p.columns.join('\u0000')) this.remap();
  }

  protected setOption(apply: () => void): void {
    apply();
    void this.loadPreview();
  }

  protected async setDatabase(db: string, table = ''): Promise<void> {
    this.database.set(db);
    this.tables.set([]);
    if (!db) return;
    const result = await this.api.listObjects(this.connectionId(), db);
    if (this.database() !== db) return;
    const tables = result.ok
      ? result.data.filter((o) => o.kind === 'table').map((o) => o.name)
      : [];
    this.tables.set(tables);
    await this.setTable(tables.includes(table) ? table : '');
  }

  protected async setTable(table: string): Promise<void> {
    this.table.set(table);
    this.columns.set([]);
    if (table) {
      const db = this.database();
      const result = await this.api.listColumns(this.connectionId(), db, table);
      if (this.table() !== table || this.database() !== db) return;
      if (result.ok) this.columns.set(result.data);
      else this.error.set(result.error);
    }
    if (this.mode() === 'upsert' && this.keyColumns().length === 0) this.mode.set('append');
    this.remap();
  }

  /** Matches file columns to table columns by name. */
  protected remap(): void {
    const cols = this.preview()?.columns ?? [];
    this.mapping.set(
      autoMap(
        cols,
        this.targets().map((c) => c.name),
      ),
    );
  }

  protected setMapping(index: number, target: string): void {
    this.mapping.update((m) => m.map((v, i) => (i === index ? target || null : v)));
  }

  protected clearMapping(): void {
    this.mapping.update((m) => m.map(() => null));
  }

  protected async start(): Promise<void> {
    if (!this.canStart()) return;
    const request: DataImportRequest = {
      ...this.options(),
      format: this.preview()!.format,
      database: this.database(),
      table: this.table(),
      mapping: this.mapping().flatMap((target, source) => (target ? [{ source, target }] : [])),
      mode: this.mode(),
      onError: this.onError(),
      emptyAsNull: this.emptyAsNull(),
      ...(this.canFk() && this.disableForeignKeys() && { disableForeignKeys: true }),
    };
    this.error.set(null);
    this.busy.set(true);
    const result = await this.api.startDataImport(this.connectionId(), request);
    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.error);
      return;
    }
    this.jobId.set(result.data.jobId);
    const name = (this.entry()?.split('/').pop() || this.file().split(/[\\/]/).pop()) ?? '';
    this.transfer.addImport({
      jobId: result.data.jobId,
      connectionId: this.connectionId(),
      name,
      database: this.database(),
      table: this.table(),
      kind: 'data',
    });
  }

  protected stop(): void {
    const id = this.jobId();
    if (id) this.transfer.stop(id);
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected onClose(): void {
    const id = this.jobId();
    if (id && !this.running()) this.transfer.forget(id);
    this.transfer.dataImportFor.set(null);
  }

  protected label(c: ColumnInfo): string {
    return `${c.name} · ${c.type}${c.key === 'primary' ? ' · sleutel' : ''}`;
  }

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
