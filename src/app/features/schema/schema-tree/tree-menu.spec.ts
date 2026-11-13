import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../../shared/ipc-contract';
import type { ConnectionProfile, ObjectAction } from '../../../../../shared/models';
import { ConfirmDangerStore } from '../../../core/confirm-danger/confirm-danger';
import { PromptStore } from '../../../core/prompt/prompt';
import {
  isSubmenu,
  type MenuAction,
  type MenuEntry,
} from '../../../core/context-menu/context-menu.store';
import { DB_API } from '../../../core/db-api';
import { COLUMNS, fakeDbApi, OBJECTS, PROFILE } from '../../../testing/fake-db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { SqlStore } from '../../sql/sql.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { SchemaStore } from '../schema.store';
import { TreeMenu } from './tree-menu';

const ID = PROFILE.id;
const table = OBJECTS[0]!; // customers
const view = OBJECTS[2]!; // paid_orders
const procedure = OBJECTS[3]!; // refresh_stats

/** Labels as shown, with a submenu as "Kopiëren als: Naam, SELECT, …" and separators as "—". */
function labels(entries: MenuEntry[]): string[] {
  return entries.map((e) =>
    e === 'separator'
      ? '—'
      : isSubmenu(e)
        ? `${e.label}: ${e.items.map((i) => (i === 'separator' ? '—' : i.label)).join(', ')}`
        : e.label,
  );
}

function find(entries: MenuEntry[], label: string): MenuAction {
  for (const e of entries) {
    if (e === 'separator') continue;
    if (isSubmenu(e)) {
      const hit = e.items.find((i) => i !== 'separator' && i.label === label);
      if (hit && hit !== 'separator') return hit;
    } else if (e.label === label) return e;
  }
  throw new Error(`Geen menu-item ${label}`);
}

async function setup(overrides: Partial<DbApi> = {}) {
  localStorage.clear(); // saved tabs of other tests
  TestBed.configureTestingModule({
    providers: [{ provide: DB_API, useValue: fakeDbApi(overrides) }],
  });
  const connections = TestBed.inject(ConnectionsStore);
  await connections.init();
  await connections.connect(ID);
  connections.activeId.set(ID);
  return {
    menu: TestBed.inject(TreeMenu),
    ws: TestBed.inject(WorkspaceStore),
    sql: TestBed.inject(SqlStore),
    schema: TestBed.inject(SchemaStore),
    danger: TestBed.inject(ConfirmDangerStore),
  };
}

const as = (changes: Partial<ConnectionProfile>): ConnectionProfile => ({ ...PROFILE, ...changes });

describe('TreeMenu', () => {
  it('gives a table its own actions, destructive ones last', async () => {
    const { menu } = await setup();
    expect(labels(menu.forObject(PROFILE, 'app_dev', table))).toEqual([
      'Openen',
      'Structuur bekijken',
      'SELECT in nieuw SQL-tabblad',
      '—',
      'Exporteren…',
      'Kopiëren als: Naam, Volledige naam, SELECT, INSERT, CREATE TABLE',
      '—',
      'Leegmaken…',
      'Verwijderen…',
    ]);
  });

  it('leaves out what does not fit a view or routine', async () => {
    const { menu } = await setup();
    const forView = labels(menu.forObject(PROFILE, 'app_dev', view));
    expect(forView).not.toContain('Leegmaken…');
    expect(forView).toContain('Kopiëren als: Naam, Volledige naam, SELECT, Definitie');
    expect(labels(menu.forObject(PROFILE, 'app_dev', procedure))).toEqual([
      'Aanroep in nieuw SQL-tabblad',
      'Definitie in nieuw SQL-tabblad',
      'Kopiëren als: Naam, Aanroep, Definitie',
      '—',
      'Verwijderen…',
    ]);
  });

  it('shows nothing that changes data on a read-only connection', async () => {
    const { menu } = await setup();
    const readOnly = as({ readOnly: true });
    const all = [
      ...labels(menu.forConnection(readOnly)),
      ...labels(menu.forDatabase(readOnly, 'app_dev')),
      ...labels(menu.forObject(readOnly, 'app_dev', table)),
      ...labels(menu.forObject(readOnly, 'app_dev', procedure)),
    ];
    expect(
      all.filter((l) => /verwijderen…|leegmaken|importeren|nieuwe? (database|schema)/i.test(l)),
    ).toEqual([]);
  });

  it('only drops a database where the dialect can', async () => {
    const { menu } = await setup();
    expect(labels(menu.forDatabase(PROFILE, 'app_dev'))).toContain('Database verwijderen…');
    expect(labels(menu.forDatabase(as({ type: 'postgres' }), 'public'))).toContain(
      'Schema verwijderen…',
    );
    expect(labels(menu.forDatabase(as({ type: 'sqlite' }), 'main')).join()).not.toMatch(
      /verwijderen/,
    );
    expect(labels(menu.forDatabase(as({ type: 'mssql' }), 'dbo')).join()).not.toMatch(
      /verwijderen/,
    );
  });

  it('opens a SELECT in a new SQL tab on the right database', async () => {
    const { menu, ws, sql } = await setup();
    find(menu.forObject(PROFILE, 'shop', table), 'SELECT in nieuw SQL-tabblad').run();
    const tab = sql.tab(ID, ws.activeId()!);
    expect(tab).toMatchObject({
      title: 'customers',
      database: 'shop',
      text: 'SELECT *\nFROM `shop`.`customers`\nLIMIT 1000;',
    });
  });

  it('opens a call with the routine parameters', async () => {
    const { menu, ws, sql } = await setup({
      routineParams: () =>
        Promise.resolve({ ok: true, data: [{ name: 'dagen', mode: 'in', type: 'int' }] }),
    });
    find(menu.forObject(PROFILE, 'app_dev', procedure), 'Aanroep in nieuw SQL-tabblad').run();
    await vi.waitFor(() => expect(ws.active()?.kind).toBe('sql'));
    expect(sql.tab(ID, ws.activeId()!)?.text).toBe(
      'CALL `app_dev`.`refresh_stats`(\n  NULL -- dagen int\n);',
    );
  });

  it('asks with the SQL and the name, and runs the action only after that', async () => {
    const actions: ObjectAction[] = [];
    const { menu, danger, ws, schema } = await setup({
      objectAction: (_id, action) => {
        actions.push(action);
        return Promise.resolve({ ok: true, data: undefined });
      },
    });
    ws.openTable({ connectionId: ID, database: 'app_dev', name: 'customers', kind: 'table' });
    expect(ws.tabs()).toHaveLength(1);

    find(menu.forObject(PROFILE, 'app_dev', table), 'Verwijderen…').run();
    const question = danger.question()!;
    expect(question).toMatchObject({
      title: 'Tabel customers verwijderen',
      sql: 'DROP TABLE `app_dev`.`customers`',
      name: 'customers',
    });
    expect(actions).toEqual([]);

    expect(question.option?.label).toBe('Foreign key checks uitzetten');
    const result = await question.run(false);
    expect(result.ok).toBe(true);
    question.done(true);
    await vi.waitFor(() => expect(ws.tabs()).toHaveLength(0));
    expect(actions).toEqual([
      { action: 'drop', database: 'app_dev', kind: 'table', name: 'customers' },
    ]);
    expect(schema.selected()).toBeNull();
  });

  it('inserts a column name into the active SQL tab, quoted when needed', async () => {
    const { menu, ws, sql } = await setup();
    expect(labels(menu.forColumn(PROFILE, COLUMNS[0]!))).toEqual(['Naam kopiëren']);
    ws.newSql(ID);
    const tab = sql.tab(ID, ws.activeId()!)!;
    find(
      menu.forColumn(PROFILE, { ...COLUMNS[0]!, name: 'order id' }),
      `Invoegen in ${tab.title}`,
    ).run();
    expect(sql.insertRequest()).toEqual({ tabId: tab.id, text: '`order id`' });
  });

  it('offers to turn foreign key checks off, and runs with them off when chosen', async () => {
    const actions: ObjectAction[] = [];
    const { menu, danger } = await setup({
      objectAction: (_id, action) => {
        actions.push(action);
        return Promise.resolve({ ok: true, data: undefined });
      },
    });
    void menu.emptyTable(PROFILE, 'app_dev', 'customers');
    const question = danger.question()!;
    expect(question.sql).toBe('TRUNCATE TABLE `app_dev`.`customers`');
    expect(question.option?.sql).toBe(
      'SET FOREIGN_KEY_CHECKS = 0;\nTRUNCATE TABLE `app_dev`.`customers`;\nSET FOREIGN_KEY_CHECKS = 1;',
    );
    await question.run(true);
    question.done(true);
    expect(actions).toEqual([
      { action: 'truncate', database: 'app_dev', name: 'customers', force: true },
    ]);
    // Nothing to offer where it does not apply.
    void menu.emptyTable(as({ type: 'sqlite' }), 'main', 'customers');
    expect(danger.question()?.option).toBeUndefined();
  });

  it('creates a database from the connection or a database, asking for the name', async () => {
    const actions: ObjectAction[] = [];
    const { menu, schema } = await setup({
      objectAction: (_id, action) => {
        actions.push(action);
        return Promise.resolve({ ok: true, data: undefined });
      },
    });
    const prompt = TestBed.inject(PromptStore);
    const refresh = vi.spyOn(schema, 'refresh');
    expect(labels(menu.forConnection(PROFILE))).toContain('Nieuwe database…');
    expect(labels(menu.forDatabase(PROFILE, 'app_dev'))).toContain('Nieuwe database…');
    expect(labels(menu.forConnection(as({ type: 'postgres' })))).toContain('Nieuw schema…');
    expect(labels(menu.forConnection(as({ type: 'sqlite' }))).join()).not.toMatch(
      /Nieuwe? (database|schema)/,
    );

    find(menu.forConnection(PROFILE), 'Nieuwe database…').run();
    expect(prompt.question()?.confirm).toBe('Database aanmaken');
    prompt.question()!.answer('  crm_test ');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith(ID));
    expect(actions).toEqual([{ action: 'create-container', database: 'crm_test' }]);
  });
});
