import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { columnDefOf, type IndexInfo } from '../../../../../shared/ddl';
import type { ColumnInfo, DbError, SchemaObject } from '../../../../../shared/models';
import { copyToClipboard } from '../../../core/clipboard';
import { DB_API } from '../../../core/db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { StructureStore } from '../../structure/structure.store';
import { TableData } from '../../data/table-data/table-data';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { SchemaStore, type ObjectTab, type SelectedObject } from '../schema.store';

/** Main panel for a selected table or view: header, then its data or its structure. */
let uidCounter = 0;

@Component({
  selector: 'app-object-view',
  imports: [TableData],
  templateUrl: './object-view.html',
})
export class ObjectView {
  readonly object = input.required<SelectedObject>();
  /** The workspace tab this view lives in (for the unsaved-edits marker). */
  readonly tabId = input<string | null>(null);
  /** Unique per instance: several tabs are rendered at once. */
  protected readonly uid = `u${++uidCounter}`;
  protected readonly schema = inject(SchemaStore);
  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  private readonly structure = inject(StructureStore);
  private readonly ws = inject(WorkspaceStore);

  /** A table on a connection that may change it: the structure can be edited. */
  protected readonly editable = computed(() => {
    const o = this.object();
    const profile = this.connections.connections().find((c) => c.id === o.connectionId);
    return o.kind === 'table' && !!profile && !profile.readOnly;
  });

  protected readonly indexes = signal<IndexInfo[] | null>(null);
  protected readonly indexError = signal<DbError | null>(null);

  /** The DDL tab: the whole CREATE script, read when the tab is first shown. */
  protected readonly ddl = signal<
    | { status: 'loading' }
    | { status: 'loaded'; text: string }
    | { status: 'error'; error: DbError }
    | null
  >(null);
  protected readonly copied = signal(false);

  /** Data or Structure, per tab; a new tab starts with the last choice. */
  protected readonly view = signal(this.schema.lastObjectTab());

  private readonly createdAt = performance.now();

  constructor() {
    // Indexes: read when Structure is first shown, and again after a change to this table.
    effect(() => {
      if (this.view() !== 'structure') return;
      const o = this.object();
      const changed = this.structure.changed();
      untracked(() => {
        if (
          this.indexes() === null ||
          (changed &&
            changed.connectionId === o.connectionId &&
            changed.database === o.database &&
            changed.table === o.name)
        )
          void this.loadIndexes();
      });
    });
    // DDL: read when its tab is first shown, and again after a change to this table.
    effect(() => {
      if (this.view() !== 'ddl') return;
      const o = this.object();
      const changed = this.structure.changed();
      untracked(() => {
        if (
          this.ddl() === null ||
          (changed &&
            changed.connectionId === o.connectionId &&
            changed.database === o.database &&
            changed.table === o.name)
        )
          void this.loadDdl();
      });
    });
    effect(() => {
      const request = this.schema.viewRequest();
      const o = untracked(this.object);
      // Only requests made while this tab exists (a new tab starts on lastObjectTab anyway).
      if (
        request &&
        request.at >= this.createdAt &&
        request.object.connectionId === o.connectionId &&
        request.object.database === o.database &&
        request.object.name === o.name
      ) {
        untracked(() => this.view.set(request.view));
      }
    });
  }

  protected setView(view: ObjectTab): void {
    this.view.set(view);
    this.schema.lastObjectTab.set(view);
  }

  protected readonly columns = computed(() => {
    const o = this.object();
    return this.schema.columns(o.connectionId, o.database, o.name);
  });

  /** Row estimate and comment come from the objects list already in the cache. */
  protected readonly info = computed<SchemaObject | undefined>(() => {
    const o = this.object();
    const objects = this.schema.objects(o.connectionId, o.database);
    return objects?.status === 'loaded' ? objects.data.find((x) => x.name === o.name) : undefined;
  });

  protected readonly columnCount = computed(() => {
    const state = this.columns();
    return state?.status === 'loaded' ? state.data.length : null;
  });

  /** MySQL puts the literal text "VIEW" in TABLE_COMMENT for views; that is not a comment. */
  protected readonly comment = computed(() => {
    const text = this.info()?.comment ?? '';
    return text && text !== 'VIEW' ? text : null;
  });

  protected readonly keyLabel = { primary: 'PK', unique: 'UNIQUE', index: 'INDEX' } as const;

  protected rowEstimate(n: number | null | undefined): string | null {
    if (n === null || n === undefined) return null;
    return `≈ ${new Intl.NumberFormat('nl-NL').format(n)} ${n === 1 ? 'rij' : 'rijen'}`;
  }

  private async loadIndexes(): Promise<void> {
    const o = this.object();
    if (o.kind !== 'table') {
      this.indexes.set([]);
      return;
    }
    const result = await this.api.listIndexes(o.connectionId, o.database, o.name);
    if (result.ok) {
      this.indexes.set(result.data);
      this.indexError.set(null);
    } else this.indexError.set(result.error);
  }

  private async loadDdl(): Promise<void> {
    const o = this.object();
    this.ddl.set({ status: 'loading' });
    if (o.kind === 'view') {
      const result = await this.api.objectDefinition(o.connectionId, o.database, 'view', o.name);
      this.ddl.set(
        result.ok
          ? { status: 'loaded', text: endStatement(result.data) }
          : { status: 'error', error: result.error },
      );
      return;
    }
    const result = await this.api.tableDefinition(o.connectionId, o.database, o.name);
    if (!result.ok) {
      this.ddl.set({ status: 'error', error: result.error });
      return;
    }
    const { create, extras, triggers } = result.data;
    const parts = [endStatement(create), ...extras.map(endStatement)];
    if (triggers.length) {
      parts.push('-- Triggers', ...triggers.map((t) => endStatement(t.sql)));
    }
    this.ddl.set({ status: 'loaded', text: parts.join('\n\n') + '\n' });
  }

  protected async copyDdl(): Promise<void> {
    const state = this.ddl();
    if (state?.status !== 'loaded') return;
    await copyToClipboard(state.text);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected ddlInSql(): void {
    const state = this.ddl();
    if (state?.status !== 'loaded') return;
    const o = this.object();
    this.ws.newSql(o.connectionId, { database: o.database, text: state.text, title: o.name });
  }

  protected reloadDdl(): void {
    void this.loadDdl();
  }

  private base() {
    const o = this.object();
    return { connectionId: o.connectionId, database: o.database, table: o.name };
  }

  protected addColumn(): void {
    this.structure.open({ kind: 'column', ...this.base() });
  }

  protected editColumn(c: ColumnInfo): void {
    const type = this.connections
      .connections()
      .find((p) => p.id === this.object().connectionId)?.type;
    this.structure.open({ kind: 'column', ...this.base(), before: columnDefOf(c, type) });
  }

  protected dropColumn(c: ColumnInfo): void {
    this.structure.open({ kind: 'drop-column', ...this.base(), column: c.name });
  }

  protected addIndex(): void {
    this.structure.open({ kind: 'index', ...this.base(), columns: [] });
  }

  protected dropIndex(i: IndexInfo): void {
    this.structure.open({ kind: 'drop-index', ...this.base(), index: i.name });
  }

  protected reload(): void {
    const o = this.object();
    void this.schema.loadColumns(o.connectionId, o.database, o.name);
  }
}

/** A statement ending in a semicolon, so the parts can be run one after another. */
function endStatement(sql: string): string {
  const text = sql.trim();
  return /;\s*$/.test(text) || /\bEND\s*$/i.test(text) ? text : text + ';';
}
