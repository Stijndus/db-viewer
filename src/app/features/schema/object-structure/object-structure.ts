import { Component, computed, inject, input } from '@angular/core';
import type { SchemaObject } from '../../../../../shared/models';
import { SchemaStore, type SelectedObject } from '../schema.store';

/** Main panel for a selected table or view: its columns. Data view follows in step 3. */
@Component({
  selector: 'app-object-structure',
  templateUrl: './object-structure.html',
})
export class ObjectStructure {
  readonly object = input.required<SelectedObject>();
  protected readonly schema = inject(SchemaStore);

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
    return `≈ ${new Intl.NumberFormat('nl-NL').format(n)} rijen`;
  }

  protected reload(): void {
    const o = this.object();
    void this.schema.loadColumns(o.connectionId, o.database, o.name);
  }
}
