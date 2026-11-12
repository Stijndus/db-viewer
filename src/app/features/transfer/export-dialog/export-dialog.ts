import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DIALECTS } from '../../../../../shared/dialect';
import type {
  DbError,
  ExportFormat,
  ExportRequest,
  ExportSource,
} from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { SchemaStore } from '../../schema/schema.store';
import { TransferStore, type ExportTarget } from '../transfer.store';

type Packing = 'none' | 'gzip' | 'zip' | '7z';
/** What the dialog offers: the export formats, plus tab-separated (CSV with tabs) for Excel. */
type Format = ExportFormat | 'tsv';

const EXTENSIONS: Record<Format, string> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  sql: 'sql',
  xlsx: 'xlsx',
  markdown: 'md',
};

/**
 * Exports a table (all rows or as filtered), a query's result, or tables of a database, as CSV,
 * JSON, SQL or Excel; optionally packed as .gz, .zip or a password-protected .7z.
 */
@Component({
  selector: 'app-export-dialog',
  templateUrl: './export-dialog.html',
})
export class ExportDialog {
  readonly target = input.required<ExportTarget>();

  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  protected readonly schema = inject(SchemaStore);
  protected readonly transfer = inject(TransferStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly formats: { value: Format; label: string }[] = [
    { value: 'csv', label: 'CSV' },
    { value: 'tsv', label: 'Tab' },
    { value: 'xlsx', label: 'Excel' },
    { value: 'json', label: 'JSON' },
    { value: 'sql', label: 'SQL' },
    { value: 'markdown', label: 'Markdown' },
  ];

  protected readonly profile = computed(
    () => this.connections.connections().find((c) => c.id === this.target().connectionId) ?? null,
  );
  protected readonly dialect = computed(() => DIALECTS[this.profile()?.type ?? 'mysql']);
  protected readonly kind = computed(() => this.target().source.kind);

  protected readonly format = signal<Format>('csv');
  // CSV
  protected readonly delimiter = signal<',' | ';' | '\t'>(',');
  protected readonly header = signal(true);
  protected readonly bom = signal(false);
  // JSON
  protected readonly jsonStyle = signal<'array' | 'lines'>('array');
  // SQL
  protected readonly rowsPerInsert = signal(100);
  protected readonly createTable = signal(false);
  protected readonly tableName = signal('export');
  // Table: filtered or all
  protected readonly useFilter = signal(true);
  // Database
  protected readonly database = signal('');
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly structure = signal(true);
  protected readonly data = signal(true);
  // Packing
  protected readonly packing = signal<Packing>('none');
  protected readonly password = signal('');
  protected readonly password2 = signal('');

  protected readonly busy = signal(false);
  protected readonly error = signal<DbError | null>(null);
  protected readonly jobId = signal<string | null>(null);

  protected readonly filtered = computed(() => {
    const s = this.target().source;
    return s.kind === 'table' && Boolean(s.where?.trim());
  });
  protected readonly databases = computed(() => {
    const state = this.schema.databases(this.target().connectionId);
    return state?.status === 'loaded' ? state.data.filter((d) => !d.system).map((d) => d.name) : [];
  });
  protected readonly tables = computed(() => {
    const db = this.database();
    if (!db) return null;
    const state = this.schema.objects(this.target().connectionId, db);
    if (!state) return null;
    return state.status === 'loaded'
      ? state.data.filter((o) => o.kind === 'table').map((o) => o.name)
      : state.status === 'error'
        ? []
        : null;
  });

  protected readonly passwordMismatch = computed(
    () => this.password2() !== '' && this.password() !== this.password2(),
  );
  protected readonly canExport = computed(() => {
    if (this.busy()) return false;
    if (this.kind() === 'database') {
      if (this.selected().size === 0 || (!this.structure() && !this.data())) return false;
    }
    if (this.format() === 'sql' && this.kind() === 'query' && !this.tableName().trim())
      return false;
    if (this.packing() === 'zip' || this.packing() === '7z') {
      if (this.password() && this.password() !== this.password2()) return false;
    }
    return true;
  });

  /** Why copying to the clipboard is not possible with these choices, or null when it is. */
  protected readonly noClipboard = computed(() => {
    if (this.format() === 'xlsx')
      return 'Excel kan niet naar het klembord; kies Tab om in Excel te plakken.';
    if (this.packing() !== 'none') return 'Ingepakt kan alleen als bestand.';
    return null;
  });

  protected readonly progress = computed(() => {
    const id = this.jobId();
    return id ? (this.transfer.progress()[id] ?? null) : null;
  });
  protected readonly running = computed(() => {
    const p = this.progress();
    return this.jobId() !== null && (!p || p.phase === 'running');
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    // Database export: SQL only; start on the database of the target, load its tables.
    effect(() => {
      const t = this.target();
      untracked(() => {
        if (t.source.kind === 'database') {
          this.format.set('sql');
          this.database.set(t.source.database);
        }
        if (t.source.kind === 'table') this.createTable.set(false);
      });
    });
    effect(() => {
      const db = this.database();
      if (!db || this.kind() !== 'database') return;
      const conn = this.target().connectionId;
      untracked(() => {
        if (!this.schema.objects(conn, db)) void this.schema.loadObjects(conn, db);
      });
    });
    // All tables ticked when a database's list arrives.
    effect(() => {
      const tables = this.tables();
      if (tables) untracked(() => this.selected.set(new Set(tables)));
    });
  }

  protected toggle(table: string, on: boolean): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (on) next.add(table);
      else next.delete(table);
      return next;
    });
  }

  protected selectAll(on: boolean): void {
    this.selected.set(new Set(on ? (this.tables() ?? []) : []));
  }

  /** e.g. klanten.csv, klanten.csv.gz, klanten.7z */
  protected fileName(): string {
    const base = this.target().baseName.replace(/[\\/:*?"<>|]+/g, '_') || 'export';
    const inner = `${base}.${EXTENSIONS[this.format()]}`;
    switch (this.packing()) {
      case 'gzip':
        return `${inner}.gz`;
      case 'zip':
        return `${base}.zip`;
      case '7z':
        return `${base}.7z`;
      default:
        return inner;
    }
  }

  private source(): ExportSource {
    const s = this.target().source;
    if (s.kind === 'table') {
      return this.useFilter() ? s : { ...s, where: undefined };
    }
    if (s.kind === 'database') {
      return {
        kind: 'database',
        database: this.database(),
        tables: (this.tables() ?? []).filter((t) => this.selected().has(t)),
        structure: this.structure(),
        data: this.data(),
      };
    }
    return s;
  }

  /** The export as asked in the dialog, without the destination. */
  private request(file: string): ExportRequest {
    const packing = this.packing();
    const format = this.format();
    const delimiter = format === 'tsv' ? '\t' : this.delimiter();
    return {
      source: this.source(),
      format: format === 'tsv' ? 'csv' : format,
      file,
      ...((format === 'csv' || format === 'tsv') && {
        csv: { delimiter, header: this.header(), bom: format === 'csv' && this.bom() },
      }),
      ...(format === 'json' && { json: { style: this.jsonStyle() } }),
      ...(format === 'sql' && {
        sql: {
          rowsPerInsert: Math.max(1, Math.min(10_000, Math.round(this.rowsPerInsert()) || 100)),
          ...(this.kind() === 'query' && { tableName: this.tableName().trim() }),
          ...(this.kind() === 'table' && {
            createTable: this.createTable(),
            dropTable: this.createTable(),
          }),
        },
      }),
      ...(packing !== 'none' && {
        archive: {
          kind: packing,
          ...((packing === 'zip' || packing === '7z') &&
            this.password() && { password: this.password() }),
        },
      }),
    };
  }

  protected async start(): Promise<void> {
    if (!this.canExport()) return;
    this.error.set(null);
    const picked = await this.api.pickExportFile(this.fileName());
    if (!picked.ok || !picked.data) return;
    await this.run(this.request(picked.data));
  }

  /** Same export, onto the clipboard instead of into a file. */
  protected async copy(): Promise<void> {
    if (!this.canExport() || this.noClipboard()) return;
    this.error.set(null);
    await this.run({ ...this.request(''), destination: 'clipboard' });
  }

  private async run(request: ExportRequest): Promise<void> {
    this.busy.set(true);
    const result = await this.api.startExport(this.target().connectionId, request);
    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.error);
      return;
    }
    this.jobId.set(result.data.jobId);
  }

  protected stop(): void {
    const id = this.jobId();
    if (id) void this.api.cancelTransfer(id);
  }

  protected showFile(): void {
    const file = this.progress()?.file;
    if (file) void this.api.showInFolder(file);
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected onClose(): void {
    const id = this.jobId();
    if (id && !this.running()) this.transfer.forget(id);
    this.transfer.exportFor.set(null);
  }

  protected onCancel(event: Event): void {
    if (this.running()) event.preventDefault();
  }

  protected size(bytes: number): string {
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
