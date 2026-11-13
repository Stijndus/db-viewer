import { inject, Injectable } from '@angular/core';
import { DIALECTS, qualifiedName, quoteIdent } from '../../../../../shared/dialect';
import type {
  ColumnInfo,
  ConnectionProfile,
  ObjectAction,
  Result,
  SchemaObject,
} from '../../../../../shared/models';
import {
  actionSql,
  callTemplate,
  canCreateContainer,
  canDropContainer,
  forceOption,
  insertTemplate,
  selectSql,
} from '../../../../../shared/object-sql';
import { ConfirmDangerStore } from '../../../core/confirm-danger/confirm-danger';
import { KeybindingsStore } from '../../../core/keybindings/keybindings.store';
import { PromptStore } from '../../../core/prompt/prompt';
import type { MenuAction, MenuEntry } from '../../../core/context-menu/context-menu.store';
import { DB_API } from '../../../core/db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { SqlStore } from '../../sql/sql.store';
import { TransferStore } from '../../transfer/transfer.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { SchemaStore } from '../schema.store';

const KIND_NAME = {
  table: 'tabel',
  view: 'view',
  procedure: 'procedure',
  function: 'functie',
} as const;

/**
 * The context menus of the schema tree: per kind of item only the actions that fit it. Actions
 * that change something are left out on read-only connections and always ask first.
 */
@Injectable({ providedIn: 'root' })
export class TreeMenu {
  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);
  private readonly ws = inject(WorkspaceStore);
  private readonly sql = inject(SqlStore);
  private readonly transfer = inject(TransferStore);
  private readonly danger = inject(ConfirmDangerStore);
  private readonly keys = inject(KeybindingsStore);
  private readonly prompt = inject(PromptStore);

  /** The connection itself (the tree's header). */
  forConnection(conn: ConnectionProfile): MenuEntry[] {
    return [
      { label: 'Nieuw SQL-tabblad', run: () => this.ws.newSql(conn.id) },
      { label: 'Vernieuwen', run: () => void this.schema.refresh(conn.id) },
      ...(conn.readOnly
        ? []
        : [
            ...this.createEntry(conn),
            { label: 'SQL-bestand importeren…', run: () => this.transfer.openImport(conn.id) },
          ]),
      'separator',
      {
        label: 'Verbinding bewerken…',
        run: () => this.connections.editor.set({ mode: 'edit', profile: conn }),
      },
      { label: 'Verbinding verbreken', run: () => this.ws.disconnect(conn.id) },
    ];
  }

  /** A database (MySQL, SQLite) or schema (PostgreSQL, SQL Server). */
  forDatabase(conn: ConnectionProfile, database: string): MenuEntry[] {
    const container = DIALECTS[conn.type].container;
    return [
      {
        label: `Nieuw SQL-tabblad in deze ${container}`,
        run: () => this.ws.newSql(conn.id, { database }),
      },
      { label: 'Vernieuwen', run: () => void this.schema.refresh(conn.id) },
      ...(conn.readOnly ? [] : this.createEntry(conn)),
      'separator',
      {
        label: 'Exporteren…',
        run: () =>
          this.transfer.openExport({
            connectionId: conn.id,
            title: database,
            baseName: database,
            source: { kind: 'database', database, tables: [], structure: true, data: true },
          }),
      },
      ...(conn.readOnly
        ? []
        : [
            {
              label: 'SQL-bestand importeren…',
              run: () => this.transfer.openImport(conn.id, database),
            },
          ]),
      'separator',
      { label: 'Naam kopiëren', run: () => void copy(database) },
      ...(conn.readOnly || !canDropContainer(conn.type)
        ? []
        : [
            'separator' as const,
            {
              label: `${container === 'schema' ? 'Schema' : 'Database'} verwijderen…`,
              danger: true,
              run: () =>
                void this.confirm(
                  conn,
                  { action: 'drop-container', database },
                  {
                    title: `${container === 'schema' ? 'Schema' : 'Database'} ${database} verwijderen`,
                    message:
                      container === 'schema'
                        ? `Het schema ${database} wordt verwijderd, met alle tabellen, views en routines erin.`
                        : `De database ${database} wordt verwijderd, met alle tabellen, views en routines erin.`,
                    confirm: `${container === 'schema' ? 'Schema' : 'Database'} verwijderen`,
                    after: () => this.ws.dropTabsOf(conn.id, database),
                  },
                ),
            },
          ]),
    ];
  }

  forObject(conn: ConnectionProfile, database: string, obj: SchemaObject): MenuEntry[] {
    const selected = { connectionId: conn.id, database, name: obj.name, kind: obj.kind };
    const name = qualifiedName(database, obj.name, conn.type);
    const kindName = KIND_NAME[obj.kind];
    const drop: MenuAction = {
      label: 'Verwijderen…',
      danger: true,
      run: () =>
        void this.confirm(
          conn,
          { action: 'drop', database, kind: obj.kind, name: obj.name },
          {
            title: `${capital(kindName)} ${obj.name} verwijderen`,
            message:
              obj.kind === 'table'
                ? `De tabel ${obj.name} wordt verwijderd, met alle rijen.`
                : `De ${kindName} ${obj.name} wordt verwijderd.`,
            confirm: `${capital(kindName)} verwijderen`,
            after: () => this.ws.dropTabsOf(conn.id, database, obj.name),
          },
        ),
    };

    if (obj.kind === 'procedure' || obj.kind === 'function') {
      const kind = obj.kind;
      const call = async () =>
        this.withResult(await this.api.routineParams(conn.id, database, kind, obj.name), (params) =>
          callTemplate(conn.type, database, kind, obj.name, params),
        );
      const definition = async () =>
        this.withResult(
          await this.api.objectDefinition(conn.id, database, kind, obj.name),
          (d) => d,
        );
      return [
        {
          label: 'Aanroep in nieuw SQL-tabblad',
          run: () => void this.inNewTab(conn, database, obj.name, call),
        },
        {
          label: 'Definitie in nieuw SQL-tabblad',
          run: () => void this.inNewTab(conn, database, obj.name, definition),
        },
        {
          label: 'Kopiëren als',
          items: [
            { label: 'Naam', run: () => void copy(obj.name) },
            { label: 'Aanroep', run: () => void this.copyFrom(call) },
            { label: 'Definitie', run: () => void this.copyFrom(definition) },
          ],
        },
        ...(conn.readOnly ? [] : ['separator' as const, drop]),
      ];
    }

    const select = selectSql(conn.type, database, obj.name);
    const definition = async () =>
      this.withResult(
        await this.api.objectDefinition(conn.id, database, obj.kind, obj.name),
        (d) => (/;\s*$/.test(d) ? d : d + ';'),
      );
    const insert = async () => {
      const cols = await this.columns(conn.id, database, obj.name);
      return cols && insertTemplate(conn.type, database, obj.name, cols);
    };
    const isTable = obj.kind === 'table';
    return [
      {
        label: 'Openen',
        shortcut: 'Enter',
        run: () => void this.schema.openAs(selected, 'data'),
      },
      { label: 'Structuur bekijken', run: () => void this.schema.openAs(selected, 'structure') },
      {
        label: 'SELECT in nieuw SQL-tabblad',
        run: () => this.ws.newSql(conn.id, { database, text: select, title: obj.name }),
      },
      'separator',
      {
        label: 'Exporteren…',
        run: () =>
          this.transfer.openExport({
            connectionId: conn.id,
            title: obj.name,
            baseName: obj.name,
            source: { kind: 'table', database, table: obj.name, orderBy: [] },
          }),
      },
      {
        label: 'Kopiëren als',
        items: [
          { label: 'Naam', run: () => void copy(obj.name) },
          { label: 'Volledige naam', run: () => void copy(name) },
          { label: 'SELECT', run: () => void copy(select) },
          ...(isTable ? [{ label: 'INSERT', run: () => void this.copyFrom(insert) }] : []),
          {
            label: isTable ? 'CREATE TABLE' : 'Definitie',
            run: () => void this.copyFrom(definition),
          },
        ],
      },
      ...(conn.readOnly
        ? []
        : [
            'separator' as const,
            ...(isTable
              ? [
                  {
                    label: 'Leegmaken…',
                    danger: true,
                    shortcut: this.keys.keyLabel('tree.emptyTable'),
                    run: () => void this.emptyTable(conn, database, obj.name),
                  },
                ]
              : []),
            drop,
          ]),
    ];
  }

  forColumn(conn: ConnectionProfile, column: ColumnInfo): MenuEntry[] {
    const active = this.ws.active();
    const sqlTab = active?.kind === 'sql' ? this.sql.tab(conn.id, active.id) : undefined;
    return [
      { label: 'Naam kopiëren', run: () => void copy(column.name) },
      ...(sqlTab
        ? [
            {
              label: `Invoegen in ${sqlTab.title}`,
              run: () => this.sql.insertText(sqlTab.id, quoteIfNeeded(column.name, conn)),
            },
          ]
        : []),
    ];
  }

  /** "Nieuwe database…" (or schema), where the dialect has more than one. */
  private createEntry(conn: ConnectionProfile): MenuAction[] {
    if (!canCreateContainer(conn.type)) return [];
    const container = DIALECTS[conn.type].container;
    return [
      {
        label: container === 'schema' ? 'Nieuw schema…' : 'Nieuwe database…',
        run: () => void this.createContainer(conn),
      },
    ];
  }

  /** Asks for a name, creates the database or schema and shows it in the tree. */
  async createContainer(conn: ConnectionProfile): Promise<void> {
    const container = DIALECTS[conn.type].container;
    const word = container === 'schema' ? 'Schema' : 'Database';
    let value = '';
    for (;;) {
      const name = (
        await this.prompt.ask({
          title: container === 'schema' ? 'Nieuw schema' : 'Nieuwe database',
          label: 'Naam',
          value,
          hint:
            conn.type === 'mysql'
              ? 'Met de standaard tekenset en collatie van de server.'
              : `Een leeg schema in de huidige database.`,
          confirm: `${word} aanmaken`,
        })
      )?.trim();
      if (!name) return;
      const result = await this.api.objectAction(conn.id, {
        action: 'create-container',
        database: name,
      });
      if (result.ok) {
        await this.schema.refresh(conn.id);
        return;
      }
      // Ask again with the name kept, so a typo or taken name is quickly fixed.
      alert(
        result.error.hint
          ? `${result.error.message}\n\n${result.error.hint}`
          : result.error.message,
      );
      value = name;
    }
  }

  /** Asks (name typed over) and empties the table; its open tab shows the empty table. */
  emptyTable(conn: ConnectionProfile, database: string, name: string): Promise<void> {
    return this.confirm(
      conn,
      { action: 'truncate', database, name },
      {
        title: `Tabel ${name} leegmaken`,
        message: `Alle rijen van ${name} worden verwijderd; de tabel zelf blijft.`,
        confirm: 'Leegmaken',
        after: () =>
          this.schema.dataChanged.set({
            object: { connectionId: conn.id, database, name },
            at: performance.now(),
          }),
      },
    );
  }

  /** Asks with the name typed over, runs the action, then refreshes the tree. */
  private async confirm(
    conn: ConnectionProfile,
    action: Exclude<ObjectAction, { action: 'create-container' }>,
    texts: { title: string; message: string; confirm: string; after: () => void },
  ): Promise<void> {
    const option = forceOption(conn.type, action);
    const ok = await this.danger.ask({
      title: texts.title,
      message: texts.message,
      sql: actionSql(conn.type, action),
      ...(option && {
        option: { ...option, sql: actionSql(conn.type, { ...action, force: true }) },
      }),
      name: 'name' in action ? action.name : action.database,
      confirm: texts.confirm,
      run: (force) => this.api.objectAction(conn.id, force ? { ...action, force } : action),
    });
    if (!ok) return;
    texts.after();
    await this.schema.refresh(conn.id);
  }

  private async inNewTab(
    conn: ConnectionProfile,
    database: string,
    title: string,
    make: () => Promise<string | null>,
  ): Promise<void> {
    const text = await make();
    if (text !== null) this.ws.newSql(conn.id, { database, text, title });
  }

  private async copyFrom(make: () => Promise<string | null>): Promise<void> {
    const text = await make();
    if (text !== null) await copy(text);
  }

  /** The data, or null after telling the user what went wrong. */
  private withResult<T>(result: Result<T>, use: (data: T) => string): string | null {
    if (result.ok) return use(result.data);
    alert(
      result.error.hint ? `${result.error.message}\n\n${result.error.hint}` : result.error.message,
    );
    return null;
  }

  private async columns(
    conn: string,
    database: string,
    table: string,
  ): Promise<ColumnInfo[] | null> {
    const cached = this.schema.columns(conn, database, table);
    if (cached?.status === 'loaded') return cached.data;
    const result = await this.api.listColumns(conn, database, table);
    if (result.ok) return result.data;
    this.withResult(result, () => '');
    return null;
  }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Plain names as they are; anything else quoted for the dialect. */
function quoteIfNeeded(name: string, conn: ConnectionProfile): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quoteIdent(name, conn.type);
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
