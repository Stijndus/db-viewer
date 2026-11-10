import { Component, computed, effect, ElementRef, inject, untracked } from '@angular/core';
import type {
  ColumnInfo,
  DatabaseInfo,
  DbError,
  ObjectKind,
  SchemaObject,
} from '../../../../../shared/models';
import { ConnectionsStore } from '../../connections/connections.store';
import { dbKey, groupKey, type GroupId, objectKey, SchemaStore } from '../schema.store';

type Row =
  | { type: 'db'; key: string; level: 1; db: DatabaseInfo; expanded: boolean }
  | {
      type: 'group';
      key: string;
      level: 2;
      db: string;
      group: GroupId;
      label: string;
      count: number;
      expanded: boolean;
    }
  | {
      type: 'object';
      key: string;
      level: 3;
      db: string;
      obj: SchemaObject;
      expanded: boolean;
      selected: boolean;
    }
  | { type: 'column'; key: string; level: 4; col: ColumnInfo }
  | {
      type: 'status';
      key: string;
      level: number;
      state: 'loading' | 'error' | 'empty';
      text: string;
      hint?: string;
    };

const GROUPS: { id: GroupId; label: string; kinds: ObjectKind[] }[] = [
  { id: 'tables', label: 'Tabellen', kinds: ['table'] },
  { id: 'views', label: 'Views', kinds: ['view'] },
  { id: 'routines', label: 'Routines', kinds: ['procedure', 'function'] },
];

/** Sidebar tree of the active connection: databases → tables/views/routines → columns. */
@Component({
  selector: 'app-schema-tree',
  templateUrl: './schema-tree.html',
})
export class SchemaTree {
  protected readonly connections = inject(ConnectionsStore);
  protected readonly schema = inject(SchemaStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly conn = computed(() => this.connections.active());

  constructor() {
    // Load the database list whenever another connection becomes active.
    effect(() => {
      const conn = this.conn();
      if (conn) untracked(() => void this.schema.open(conn.id, conn.database));
    });
  }

  protected readonly rows = computed<Row[]>(() => {
    const conn = this.conn();
    if (!conn) return [];
    const dbs = this.schema.databases(conn.id);
    if (!dbs || dbs.status === 'loading')
      return [statusRow('root', 1, 'loading', 'Databases laden…')];
    if (dbs.status === 'error') return [errorRow('root', 1, dbs.error)];

    const q = this.schema.filter().trim().toLowerCase();
    const matches = (name: string) => !q || name.toLowerCase().includes(q);
    const visible = dbs.data.filter(
      (d) =>
        !d.system || this.schema.showSystem() || this.schema.isExpanded(dbKey(conn.id, d.name)),
    );
    const rows: Row[] = [];

    for (const db of visible) {
      const objects = this.schema.objects(conn.id, db.name);
      const loaded = objects?.status === 'loaded' ? objects.data : null;
      const hits = loaded?.filter((o) => matches(o.name)) ?? [];
      // While filtering, show a database when its name or one of its loaded objects matches.
      if (q && !matches(db.name) && hits.length === 0) continue;

      const dbOpen = this.schema.isExpanded(dbKey(conn.id, db.name)) || (!!q && hits.length > 0);
      rows.push({ type: 'db', key: dbKey(conn.id, db.name), level: 1, db, expanded: dbOpen });
      if (!dbOpen) continue;

      if (!objects || objects.status === 'loading') {
        rows.push(statusRow(dbKey(conn.id, db.name) + 'l', 2, 'loading', 'Laden…'));
        continue;
      }
      if (objects.status === 'error') {
        rows.push(errorRow(dbKey(conn.id, db.name) + 'e', 2, objects.error));
        continue;
      }
      if (objects.data.length === 0) {
        rows.push(statusRow(dbKey(conn.id, db.name) + '0', 2, 'empty', 'Geen tabellen of views'));
        continue;
      }

      for (const g of GROUPS) {
        const items = (q ? hits : objects.data).filter((o) => g.kinds.includes(o.kind));
        if (items.length === 0) continue;
        const gKey = groupKey(conn.id, db.name, g.id);
        const gOpen = this.schema.isExpanded(gKey) || !!q;
        rows.push({
          type: 'group',
          key: gKey,
          level: 2,
          db: db.name,
          group: g.id,
          label: g.label,
          count: items.length,
          expanded: gOpen,
        });
        if (!gOpen) continue;

        for (const obj of items) {
          const oKey = objectKey(conn.id, db.name, obj.name);
          const oOpen = this.schema.isExpanded(oKey);
          const sel = this.schema.selected();
          const selected =
            sel?.connectionId === conn.id && sel.database === db.name && sel.name === obj.name;
          rows.push({
            type: 'object',
            key: oKey,
            level: 3,
            db: db.name,
            obj,
            expanded: oOpen,
            selected,
          });
          if (!oOpen) continue;

          const cols = this.schema.columns(conn.id, db.name, obj.name);
          if (!cols || cols.status === 'loading')
            rows.push(statusRow(oKey + 'l', 4, 'loading', 'Laden…'));
          else if (cols.status === 'error') rows.push(errorRow(oKey + 'e', 4, cols.error));
          else
            for (const col of cols.data)
              rows.push({ type: 'column', key: oKey + '\u0001' + col.name, level: 4, col });
        }
      }
    }

    if (rows.length === 0) {
      rows.push(
        statusRow(
          'none',
          1,
          'empty',
          q
            ? 'Niets gevonden in de geopende databases.'
            : 'Geen databases zichtbaar voor deze gebruiker.',
        ),
      );
    }
    return rows;
  });

  protected readonly hiddenSystemCount = computed(() => {
    const conn = this.conn();
    const dbs = conn ? this.schema.databases(conn.id) : undefined;
    return dbs?.status === 'loaded' && !this.schema.showSystem()
      ? dbs.data.filter((d) => d.system).length
      : 0;
  });

  protected activate(row: Row): void {
    const conn = this.conn();
    if (!conn) return;
    switch (row.type) {
      case 'db':
        void this.schema.toggleDatabase(conn.id, row.db.name);
        break;
      case 'group':
        this.schema.toggleGroup(conn.id, row.db, row.group);
        break;
      case 'object':
        void this.schema.select({
          connectionId: conn.id,
          database: row.db,
          name: row.obj.name,
          kind: row.obj.kind,
        });
        break;
    }
  }

  protected toggleColumns(row: Row & { type: 'object' }): void {
    const conn = this.conn();
    if (conn) void this.schema.toggleObject(conn.id, row.db, row.obj.name);
  }

  /** Arrow keys walk the visible rows; Right/Left open and close like a file explorer. */
  protected onKeydown(event: KeyboardEvent, row: Row): void {
    const buttons = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.tree-main'),
    );
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const focus = (i: number) => buttons.at(Math.max(0, Math.min(i, buttons.length - 1)))?.focus();
    const expandable =
      row.type === 'db' || row.type === 'group' || (row.type === 'object' && this.hasColumns(row));
    const expanded = 'expanded' in row && row.expanded;

    switch (event.key) {
      case 'ArrowDown':
        focus(index + 1);
        break;
      case 'ArrowUp':
        focus(index - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(buttons.length - 1);
        break;
      case 'ArrowRight':
        if (expandable && !expanded) this.expand(row);
        else focus(index + 1);
        break;
      case 'ArrowLeft':
        if (expandable && expanded) this.expand(row);
        else this.focusParent(buttons, index, row.level);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  protected hasColumns(row: Row & { type: 'object' }): boolean {
    return row.obj.kind === 'table' || row.obj.kind === 'view';
  }

  protected icon(kind: ObjectKind): string {
    return kind === 'table' ? 'table' : kind === 'view' ? 'view' : 'routine';
  }

  protected ariaExpanded(row: Row): boolean | null {
    if (row.type === 'db' || row.type === 'group') return row.expanded;
    if (row.type === 'object' && this.hasColumns(row)) return row.expanded;
    return null;
  }

  private expand(row: Row): void {
    if (row.type === 'object') this.toggleColumns(row);
    else this.activate(row);
  }

  private focusParent(buttons: HTMLButtonElement[], index: number, level: number): void {
    for (let i = index - 1; i >= 0; i--) {
      if (Number(buttons.at(i)?.dataset['level']) < level) {
        buttons.at(i)?.focus();
        return;
      }
    }
  }
}

function statusRow(key: string, level: number, state: 'loading' | 'empty', text: string): Row {
  return { type: 'status', key, level, state, text };
}

function errorRow(key: string, level: number, error: DbError): Row {
  return { type: 'status', key, level, state: 'error', text: error.message, hint: error.hint };
}
