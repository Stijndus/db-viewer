import { inject, Injectable, signal } from '@angular/core';
import type { ColumnDef } from '../../../../shared/ddl';
import { SchemaStore } from '../schema/schema.store';

/** What the structure dialog is opened for. */
export type StructureRequest =
  | { kind: 'column'; connectionId: string; database: string; table: string; before?: ColumnDef }
  | { kind: 'index'; connectionId: string; database: string; table: string; columns: string[] }
  | { kind: 'table'; connectionId: string; database: string }
  | { kind: 'drop-column'; connectionId: string; database: string; table: string; column: string }
  | { kind: 'drop-index'; connectionId: string; database: string; table: string; index: string };

/**
 * Opens the structure dialog (one at a time) and tells the views when a structure changed, so
 * the columns and indexes are read again.
 */
@Injectable({ providedIn: 'root' })
export class StructureStore {
  private readonly schema = inject(SchemaStore);
  readonly request = signal<StructureRequest | null>(null);
  /** Bumped after a change: which table (or database, for a new table). */
  readonly changed = signal<{
    connectionId: string;
    database: string;
    table: string | null;
    at: number;
  } | null>(null);

  open(request: StructureRequest): void {
    this.request.set(request);
  }

  async done(request: StructureRequest, newTable?: string): Promise<void> {
    const table = 'table' in request ? request.table : (newTable ?? null);
    this.changed.set({
      connectionId: request.connectionId,
      database: request.database,
      table,
      at: performance.now(),
    });
    if (request.kind === 'table') await this.schema.refresh(request.connectionId);
    else await this.schema.loadColumns(request.connectionId, request.database, request.table);
  }
}
