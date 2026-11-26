import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  addColumnSql,
  alterColumnSql,
  canAlterColumn,
  createIndexSql,
  createTableSql,
  dropColumnSql,
  dropIndexSql,
  hasComments,
  indexName,
  typeSuggestions,
  type ColumnDef,
} from '../../../../shared/ddl';
import type { DbError } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { SchemaStore } from '../schema/schema.store';
import { WorkspaceStore } from '../workspace/workspace.store';
import { StructureStore, type StructureRequest } from './structure.store';

type TableColumn = ColumnDef & { primary: boolean };

const emptyColumn = (): ColumnDef => ({
  name: '',
  type: '',
  nullable: true,
  defaultValue: '',
  autoIncrement: false,
  comment: '',
});

/**
 * Structure changes in one dialog: a column (add or change), an index, a new table, or dropping a
 * column or index. The SQL is built live under the form and runs only with Uitvoeren.
 */
@Component({
  selector: 'app-structure-dialog',
  templateUrl: './structure-dialog.html',
})
export class StructureDialog {
  readonly request = input.required<StructureRequest>();

  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);
  private readonly ws = inject(WorkspaceStore);
  private readonly store = inject(StructureStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly dialect = computed(
    () =>
      this.connections.connections().find((c) => c.id === this.request().connectionId)?.type ??
      'mysql',
  );
  protected readonly types = computed(() => typeSuggestions(this.dialect()));
  protected readonly comments = computed(() => hasComments(this.dialect()));

  /** The column form (add or change). */
  protected readonly column = signal<ColumnDef>(emptyColumn());
  /** The index form. */
  protected readonly indexCols = signal<string[]>([]);
  protected readonly unique = signal(false);
  protected readonly indexNameDraft = signal('');
  private readonly indexNameTouched = signal(false);
  /** The new-table form. */
  protected readonly tableName = signal('');
  protected readonly tableColumns = signal<TableColumn[]>([]);

  protected readonly busy = signal(false);
  protected readonly error = signal<DbError | null>(null);

  protected readonly tableColumnsOfTable = computed(() => {
    const r = this.request();
    if (!('table' in r)) return [];
    const state = this.schema.columns(r.connectionId, r.database, r.table);
    return state?.status === 'loaded' ? state.data.map((c) => c.name) : [];
  });

  protected readonly title = computed(() => {
    const r = this.request();
    switch (r.kind) {
      case 'column':
        return r.before ? `Kolom ${r.before.name} wijzigen` : `Kolom toevoegen aan ${r.table}`;
      case 'index':
        return `Index toevoegen aan ${r.table}`;
      case 'table':
        return `Nieuwe tabel in ${r.database}`;
      case 'drop-column':
        return `Kolom ${r.column} verwijderen`;
      case 'drop-index':
        return `Index ${r.index} verwijderen`;
    }
  });

  /** The statements for what the form says now, or the reason it can't be built yet. */
  protected readonly sql = computed<{ statements: string[]; problem: string | null }>(() => {
    const r = this.request();
    const d = this.dialect();
    try {
      switch (r.kind) {
        case 'column': {
          const c = this.column();
          if (!c.name.trim() || !c.type.trim())
            return { statements: [], problem: 'Vul een naam en een type in.' };
          const statements = r.before
            ? alterColumnSql(d, r.database, r.table, r.before, c)
            : addColumnSql(d, r.database, r.table, c);
          return { statements, problem: statements.length ? null : 'Er is niets veranderd.' };
        }
        case 'index': {
          if (this.indexCols().length === 0)
            return { statements: [], problem: 'Kies een of meer kolommen.' };
          return {
            statements: createIndexSql(d, r.database, r.table, {
              name: this.indexNameDraft(),
              columns: this.indexCols(),
              unique: this.unique(),
            }),
            problem: null,
          };
        }
        case 'table': {
          const cols = this.tableColumns().filter((c) => c.name.trim() || c.type.trim());
          if (!this.tableName().trim())
            return { statements: [], problem: 'Geef de tabel een naam.' };
          if (cols.length === 0) return { statements: [], problem: 'Voeg minstens één kolom toe.' };
          return {
            statements: createTableSql(d, r.database, this.tableName(), cols),
            problem: null,
          };
        }
        case 'drop-column':
          return { statements: dropColumnSql(d, r.database, r.table, r.column), problem: null };
        case 'drop-index':
          return { statements: dropIndexSql(d, r.database, r.table, r.index), problem: null };
      }
    } catch (err) {
      return { statements: [], problem: err instanceof Error ? err.message : String(err) };
    }
  });

  protected readonly sqlText = computed(() =>
    this.sql()
      .statements.map((s) => s + ';')
      .join('\n\n'),
  );
  protected readonly danger = computed(() => this.request().kind.startsWith('drop'));
  /** Auto numbering: when adding a column, or changing one in MySQL (others need more than ALTER). */
  protected readonly showAuto = computed(() => {
    const r = this.request();
    if (this.dialect() === 'sqlite' || r.kind !== 'column') return false;
    return !r.before || this.dialect() === 'mysql';
  });
  /** SQLite: only the name of an existing column can change. */
  protected readonly renameOnly = computed(() => {
    const r = this.request();
    return r.kind === 'column' && !!r.before && !canAlterColumn(this.dialect());
  });

  constructor() {
    afterNextRender(() => {
      const r = this.request();
      if (r.kind === 'column' && r.before) this.column.set({ ...r.before });
      if (r.kind === 'table') {
        const d = this.dialect();
        const int = d === 'postgres' ? 'integer' : d === 'sqlite' ? 'INTEGER' : 'int';
        const text = d === 'mssql' ? 'nvarchar(255)' : d === 'sqlite' ? 'TEXT' : 'varchar(255)';
        this.tableColumns.set([
          {
            ...emptyColumn(),
            name: 'id',
            type: int,
            nullable: false,
            autoIncrement: true,
            primary: true,
          },
          { ...emptyColumn(), name: 'naam', type: text, primary: false },
        ]);
      }
      this.dialog().nativeElement.showModal();
      this.dialog()
        .nativeElement.querySelector<HTMLInputElement>('input:not([type=checkbox])')
        ?.focus();
    });
  }

  protected setColumn(patch: Partial<ColumnDef>): void {
    this.column.update((c) => ({ ...c, ...patch }));
  }

  /** Clicking columns builds the index in that order; clicking again takes one out. */
  protected toggleIndexColumn(name: string): void {
    this.indexCols.update((cols) =>
      cols.includes(name) ? cols.filter((c) => c !== name) : [...cols, name],
    );
    this.suggestName();
  }

  protected setUnique(on: boolean): void {
    this.unique.set(on);
    this.suggestName();
  }

  protected setIndexName(name: string): void {
    this.indexNameDraft.set(name);
    this.indexNameTouched.set(true);
  }

  private suggestName(): void {
    const r = this.request();
    if (r.kind !== 'index' || this.indexNameTouched()) return;
    this.indexNameDraft.set(
      this.indexCols().length ? indexName(r.table, this.indexCols(), this.unique()) : '',
    );
  }

  protected setTableColumn(i: number, patch: Partial<TableColumn>): void {
    this.tableColumns.update((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  protected addTableColumn(): void {
    this.tableColumns.update((cols) => [...cols, { ...emptyColumn(), primary: false }]);
  }

  protected removeTableColumn(i: number): void {
    this.tableColumns.update((cols) => cols.filter((_, j) => j !== i));
  }

  protected async run(): Promise<void> {
    const { statements, problem } = this.sql();
    if (problem || statements.length === 0 || this.busy()) return;
    const r = this.request();
    this.busy.set(true);
    this.error.set(null);
    const result = await this.api.applyDdl(r.connectionId, r.database, statements);
    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.error);
      // Part of it may have run: read the structure again anyway.
      void this.store.done(r);
      return;
    }
    const table = r.kind === 'table' ? this.tableName().trim() : undefined;
    await this.store.done(r, table);
    this.close();
    if (r.kind === 'table' && table) {
      this.ws.openTable({
        connectionId: r.connectionId,
        database: r.database,
        name: table,
        kind: 'table',
      });
    }
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected onClose(): void {
    this.store.request.set(null);
  }
}
