import { ConnectionTools } from '../../workspace/connection-tools';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  untracked,
} from '@angular/core';
import type {
  ColumnInfo,
  DatabaseInfo,
  DbError,
  ObjectKind,
  SchemaObject,
} from '../../../../../shared/models';
import { defaultContainer } from '../../../../../shared/dialect';
import { ContextMenuStore } from '../../../core/context-menu/context-menu.store';
import { KeybindingsStore } from '../../../core/keybindings/keybindings.store';
import type { ConnectionProfile } from '../../../../../shared/models';
import { ConnectionsStore } from '../../connections/connections.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { dbKey, groupKey, type GroupId, objectKey, SchemaStore } from '../schema.store';
import { TreeMenu } from './tree-menu';

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
  imports: [ConnectionTools],
  templateUrl: './schema-tree.html',
})
export class SchemaTree {
  protected readonly connections = inject(ConnectionsStore);
  protected readonly schema = inject(SchemaStore);
  protected readonly ws = inject(WorkspaceStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly menus = inject(TreeMenu);
  private readonly contextMenu = inject(ContextMenuStore);

  protected readonly conn = computed(() => this.connections.active());

  constructor() {
    this.registerCommands();
    // Load the database list whenever another connection becomes active.
    effect(() => {
      const conn = this.conn();
      if (conn)
        untracked(() => void this.schema.open(conn.id, defaultContainer(conn.type, conn.database)));
    });
  }

  protected readonly rows = computed<Row[]>(() => {
    const conn = this.conn();
    if (!conn) return [];
    const dbs = this.schema.databases(conn.id);
    if (!dbs || dbs.status === 'loading')
      return [statusRow('root', 1, 'loading', 'Databases laden…')];
    if (dbs.status === 'error') return [errorRow('root', 1, dbs.error)];

    const { q, dbPart, objPart } = this.query();
    const matches = (name: string) => !q || name.toLowerCase().includes(q);
    const dbMatches = (name: string) => dbPart !== null && name.toLowerCase().includes(dbPart);
    const objMatches = (name: string) => objPart !== null && name.toLowerCase().includes(objPart);
    // A system database whose name is searched for is shown too.
    const visible = dbs.data.filter(
      (d) =>
        !d.system ||
        this.schema.showSystem() ||
        this.schema.isExpanded(dbKey(conn.id, d.name)) ||
        (!!q && (dbPart === null ? matches(d.name) : !!dbPart && dbMatches(d.name))),
    );
    const rows: Row[] = [];

    for (const db of visible) {
      const objects = this.schema.objects(conn.id, db.name);
      const loaded = objects?.status === 'loaded' ? objects.data : null;
      let onlyHits: boolean;
      let hits: SchemaObject[];
      if (dbPart !== null) {
        // "database.table": only databases matching the first part, with the objects matching
        // the second (all of them when it is empty). They load by themselves.
        if (!dbMatches(db.name)) continue;
        hits = loaded?.filter((o) => !objPart || objMatches(o.name)) ?? [];
        if (loaded && hits.length === 0) continue;
        onlyHits = true;
      } else {
        hits = loaded?.filter((o) => matches(o.name)) ?? [];
        // While filtering, show a database when its name or one of its loaded objects matches.
        if (q && !matches(db.name) && hits.length === 0) continue;
        // Matching objects inside: open, showing just those. Only the name of the database
        // matches: as it was, and opened it shows all its objects.
        onlyHits = !!q && hits.length > 0;
      }

      const dbOpen = this.schema.isExpanded(dbKey(conn.id, db.name)) || onlyHits;
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
        const items = (onlyHits ? hits : objects.data).filter((o) => g.kinds.includes(o.kind));
        if (items.length === 0) continue;
        const gKey = groupKey(conn.id, db.name, g.id);
        const gOpen = this.schema.isExpanded(gKey) || onlyHits;
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
            ? dbPart !== null
              ? `Geen tabel gevonden met "${objPart}" in een database met "${dbPart}".`
              : 'Geen database of tabel gevonden. Tabellen worden gezocht in de databases die al geladen zijn; typ database.tabel om ook in andere te zoeken.'
            : 'Geen databases zichtbaar voor deze gebruiker.',
        ),
      );
    }
    return rows;
  });

  /** A name split around what the filter matches, to mark it: [before, match, after]. */
  /**
   * The filter: plain text matches databases and tables; "database.table" (or "base.tab")
   * matches the first part in database names and the second in table names.
   */
  protected readonly query = computed(() => parseTreeFilter(this.schema.filter()));

  /** The databases a "database.table" search looks in: loaded when not yet (at most 30). */
  private readonly searchLoader = effect(() => {
    const conn = this.conn();
    const { dbPart } = this.query();
    const dbs = conn ? this.schema.databases(conn.id) : undefined;
    if (!conn || dbPart === null || dbs?.status !== 'loaded') return;
    untracked(() => {
      const todo = dbs.data
        .filter((d) => d.name.toLowerCase().includes(dbPart))
        .filter((d) => !d.system || this.schema.showSystem())
        .filter((d) => !this.schema.objects(conn.id, d.name))
        .slice(0, 30);
      for (const d of todo) void this.schema.loadObjects(conn.id, d.name);
    });
  });

  protected marked(name: string, part: 'db' | 'obj' = 'obj'): [string, string, string] {
    const { q: all, dbPart, objPart } = this.query();
    const q = dbPart === null ? all : part === 'db' ? dbPart : (objPart ?? '');
    const at = q ? name.toLowerCase().indexOf(q) : -1;
    if (at < 0) return [name, '', ''];
    return [name.slice(0, at), name.slice(at, at + q.length), name.slice(at + q.length)];
  }

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
        // Routines have no data to show; their actions are in the context menu.
        if (!this.hasColumns(row)) break;
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

  /** Tree commands: focus (Ctrl+D), filter (Ctrl+E), refresh (F5), empty a table (Del). */
  private registerCommands(): void {
    const keys = inject(KeybindingsStore);
    const destroy = inject(DestroyRef);
    const buttons = () =>
      Array.from(this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.tree-main'));
    keys.handle(
      'tree.focus',
      () => {
        const all = buttons();
        const selected = this.host.nativeElement.querySelector<HTMLElement>(
          '[aria-selected="true"] .tree-main',
        );
        (selected ?? all[0])?.focus();
        return all.length > 0;
      },
      destroy,
    );
    keys.handle(
      'tree.focusFilter',
      () => {
        const input = this.host.nativeElement.querySelector<HTMLInputElement>('#tree-filter');
        input?.focus();
        input?.select();
        return !!input;
      },
      destroy,
    );
    keys.handle(
      'tree.refresh',
      () => {
        const conn = this.conn();
        if (!conn) return false;
        void this.schema.refresh(conn.id);
        return true;
      },
      destroy,
    );
    keys.handle(
      'tree.emptyTable',
      () => {
        const conn = this.conn();
        const index = buttons().indexOf(document.activeElement as HTMLButtonElement);
        const row = this.rows().filter((r) => r.type !== 'column')[index];
        if (!conn || conn.readOnly || row?.type !== 'object' || row.obj.kind !== 'table')
          return false;
        void this.menus.emptyTable(conn, row.db, row.obj.name);
        return true;
      },
      destroy,
    );
  }

  /** Right click, Shift+F10 or the menu key: the actions for this row. */
  protected openMenu(event: MouseEvent | KeyboardEvent, row: Row): void {
    const conn = this.conn();
    if (!conn) return;
    switch (row.type) {
      case 'db':
        this.contextMenu.open(
          event,
          `Acties voor ${row.db.name}`,
          this.menus.forDatabase(conn, row.db.name),
        );
        break;
      case 'object':
        this.contextMenu.open(
          event,
          `Acties voor ${row.obj.name}`,
          this.menus.forObject(conn, row.db, row.obj),
        );
        break;
      case 'column':
        this.contextMenu.open(
          event,
          `Acties voor ${row.col.name}`,
          this.menus.forColumn(conn, row.col),
        );
        break;
    }
  }

  protected openConnectionMenu(event: MouseEvent | KeyboardEvent, conn: ConnectionProfile): void {
    this.contextMenu.open(event, `Acties voor ${conn.name}`, this.menus.forConnection(conn));
  }

  protected menuKey(event: KeyboardEvent): boolean {
    return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
  }

  /** Arrow keys walk the visible rows; Right/Left open and close like a file explorer. */
  protected onKeydown(event: KeyboardEvent, row: Row): void {
    if (this.menuKey(event)) {
      this.openMenu(event, row);
      return;
    }
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

/**
 * The tree filter: plain text matches databases and tables; `database.table` (or `base.tab`)
 * and the tags `db:…` and `tb:…` match the database and the table part separately. A part that
 * is left out matches everything.
 */
export function parseTreeFilter(text: string): {
  q: string;
  dbPart: string | null;
  objPart: string | null;
} {
  const q = text.trim().toLowerCase();
  const db = /(?:^|\s)db:(\S*)/.exec(q);
  const tb = /(?:^|\s)(?:tb|tabel|table):(\S*)/.exec(q);
  if (db || tb) {
    const rest = q
      .replace(/(?:^|\s)db:\S*/, ' ')
      .replace(/(?:^|\s)(?:tb|tabel|table):\S*/, ' ')
      .trim();
    // Text next to a tag: the other part ("db:plan ord" looks for ord in plan…).
    return {
      q,
      dbPart: db ? db[1]! : rest,
      objPart: tb ? tb[1]! : rest,
    };
  }
  const dot = q.indexOf('.');
  return dot > 0
    ? { q, dbPart: q.slice(0, dot), objPart: q.slice(dot + 1) }
    : { q, dbPart: null, objPart: null };
}
