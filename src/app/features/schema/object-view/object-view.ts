import { Component, computed, inject, input, signal } from '@angular/core';
import type { SchemaObject } from '../../../../../shared/models';
import { TableData } from '../../data/table-data/table-data';
import { SchemaStore, type SelectedObject } from '../schema.store';

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

  /** Data or Structure, per tab; a new tab starts with the last choice. */
  protected readonly view = signal(this.schema.lastObjectTab());

  protected setView(view: 'data' | 'structure'): void {
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

  protected reload(): void {
    const o = this.object();
    void this.schema.loadColumns(o.connectionId, o.database, o.name);
  }
}
