import { TestBed } from '@angular/core/testing';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { SchemaStore, type SelectedObject } from '../schema/schema.store';
import { SqlStore } from '../sql/sql.store';
import { WorkspaceStore } from './workspace.store';

const ID = PROFILE.id;
const table = (name: string, database = 'app_dev'): SelectedObject => ({
  connectionId: ID,
  database,
  name,
  kind: 'table',
});

async function setup() {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  const closed: string[] = [];
  const api = fakeDbApi({
    closeEditor: async (_id, tab) => {
      closed.push(tab);
      return { ok: true, data: undefined };
    },
  });
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: api }] });
  const connections = TestBed.inject(ConnectionsStore);
  const schema = TestBed.inject(SchemaStore);
  const sql = TestBed.inject(SqlStore);
  const ws = TestBed.inject(WorkspaceStore);
  await connections.init();
  await connections.connect(ID);
  TestBed.tick();
  return { connections, schema, sql, ws, closed };
}

const names = (ws: WorkspaceStore) => ws.tabs().map((t) => (t.kind === 'table' ? t.name : 'sql'));

describe('WorkspaceStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens a tab per table and reuses it when the table is clicked again', async () => {
    const { schema, ws } = await setup();
    await schema.select(table('customers'));
    TestBed.tick();
    await schema.select(table('orders'));
    TestBed.tick();
    expect(names(ws)).toEqual(['customers', 'orders']);
    await schema.select(table('customers'));
    TestBed.tick();
    expect(names(ws)).toEqual(['customers', 'orders']);
    expect(ws.active()).toMatchObject({ name: 'customers' });
  });

  it('keeps the same name in two databases apart', async () => {
    const { ws } = await setup();
    ws.openTable(table('customers'));
    ws.openTable(table('customers', 'shop'));
    expect(ws.tabs()).toHaveLength(2);
  });

  it('puts SQL tabs in the same row, right after the active tab', async () => {
    const { ws } = await setup();
    ws.openTable(table('customers'));
    ws.openTable(table('orders'));
    ws.activate(ID, ws.tabs()[0]!.id);
    ws.newSql(ID);
    expect(names(ws)).toEqual(['customers', 'sql', 'orders']);
    expect(ws.active()?.kind).toBe('sql');
  });

  it('activates the right neighbour when the active tab closes, else the left one', async () => {
    const { ws } = await setup();
    for (const n of ['a', 'b', 'c']) ws.openTable(table(n));
    const [a, b, c] = ws.tabs();
    ws.activate(ID, b!.id);
    ws.close(ID, b!.id);
    expect(ws.activeId()).toBe(c!.id);
    ws.close(ID, c!.id);
    expect(ws.activeId()).toBe(a!.id);
    ws.close(ID, a!.id);
    expect(ws.active()).toBeNull();
  });

  it('cycles with wrap-around', async () => {
    const { ws } = await setup();
    for (const n of ['a', 'b', 'c']) ws.openTable(table(n));
    expect(ws.active()).toMatchObject({ name: 'c' });
    ws.cycle(ID, 1);
    expect(ws.active()).toMatchObject({ name: 'a' });
    ws.cycle(ID, -1);
    expect(ws.active()).toMatchObject({ name: 'c' });
  });

  it('asks before closing a tab with unsaved edits, and keeps it when cancelled', async () => {
    const { ws } = await setup();
    ws.openTable(table('customers'));
    const id = ws.tabs()[0]!.id;
    ws.setDirty(id, true);
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(ws.close(ID, id)).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    expect(ws.tabs()).toHaveLength(1);
    ask.mockReturnValue(true);
    expect(ws.close(ID, id)).toBe(true);
    expect(ws.tabs()).toHaveLength(0);
  });

  it('closes clean tabs without asking', async () => {
    const { ws } = await setup();
    ws.openTable(table('customers'));
    const ask = vi.spyOn(window, 'confirm');
    ws.close(ID, ws.tabs()[0]!.id);
    expect(ask).not.toHaveBeenCalled();
  });

  it('closes others, to the right, and all; SQL sessions close with their tab', async () => {
    const { ws, closed } = await setup();
    for (const n of ['a', 'b']) ws.openTable(table(n));
    ws.newSql(ID);
    ws.openTable(table('c'));
    const [a, b, sql] = ws.tabs();
    ws.closeToRight(ID, sql!.id);
    expect(names(ws)).toEqual(['a', 'b', 'sql']);
    ws.closeOthers(ID, b!.id);
    expect(names(ws)).toEqual(['b']);
    expect(closed).toEqual([sql!.id]);
    expect(ws.activeId()).toBe(b!.id);
    ws.closeAll(ID);
    expect(ws.tabs()).toEqual([]);
    void a;
  });

  it('restores tab order and the active tab after a restart', async () => {
    const first = await setup();
    first.ws.openTable(table('customers'));
    first.ws.newSql(first.connections.activeId()!);
    first.ws.openTable(table('orders'));
    first.ws.activate(ID, first.ws.tabs()[0]!.id);
    first.sql.flush();
    const saved = localStorage.getItem(`dbv.ws.v1.${ID}`);
    const sqlSaved = localStorage.getItem(`dbv.sql.v1.${ID}`);

    TestBed.resetTestingModule();
    const second = await (async () => {
      TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: fakeDbApi() }] });
      localStorage.setItem(`dbv.ws.v1.${ID}`, saved!);
      if (sqlSaved) localStorage.setItem(`dbv.sql.v1.${ID}`, sqlSaved);
      const connections = TestBed.inject(ConnectionsStore);
      const ws = TestBed.inject(WorkspaceStore);
      await connections.init();
      await connections.connect(ID);
      TestBed.tick();
      return { ws };
    })();
    expect(names(second.ws)).toEqual(['customers', 'sql', 'orders']);
    expect(second.ws.active()).toMatchObject({ name: 'customers' });
  });

  it('asks before leaving a connection with unsaved edits', async () => {
    const { ws, connections } = await setup();
    ws.openTable(table('customers'));
    ws.setDirty(ws.tabs()[0]!.id, true);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    ws.leave(ID);
    expect(connections.activeId()).toBe(ID);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    ws.leave(ID);
    expect(connections.activeId()).toBeNull();
    expect(ws.isDirty(ws.tabs()[0]?.id ?? '')).toBe(false);
  });

  it('switches between open connections with their own tabs, round', async () => {
    const { connections, schema, ws } = await setup();
    const OTHER = '22222222-2222-4222-8222-222222222222';
    connections.connections.update((all) => [...all, { ...PROFILE, id: OTHER, name: 'productie' }]);
    await schema.select(table('customers'));
    TestBed.tick();

    // One open connection: nothing to switch to, so Ctrl+Tab goes on to the tabs.
    expect(ws.switchBy(1)).toBe(false);

    await connections.connect(OTHER);
    TestBed.tick();
    expect(connections.open().map((c) => c.name)).toEqual(['lokaal-dev', 'productie']);
    expect(names(ws)).toEqual([]);

    expect(ws.switchBy(1)).toBe(true);
    await vi.waitFor(() => expect(connections.activeId()).toBe(ID));
    TestBed.tick();
    expect(names(ws)).toEqual(['customers']);
    expect(ws.switchBy(-1)).toBe(true);
    await vi.waitFor(() => expect(connections.activeId()).toBe(OTHER));

    // From the overview, the first open one.
    connections.activeId.set(null);
    expect(ws.switchBy(1)).toBe(true);
    await vi.waitFor(() => expect(connections.activeId()).toBe(ID));
  });

  it('asks before switching away from unsaved edits', async () => {
    const { connections, schema, ws } = await setup();
    const OTHER = '22222222-2222-4222-8222-222222222222';
    connections.connections.update((all) => [...all, { ...PROFILE, id: OTHER, name: 'productie' }]);
    await connections.connect(OTHER);
    connections.activeId.set(ID);
    TestBed.tick();
    await schema.select(table('customers'));
    TestBed.tick();
    ws.setDirty(ws.tabs()[0]!.id, true);

    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    ws.switchTo(OTHER);
    expect(ask).toHaveBeenCalledOnce();
    expect(connections.activeId()).toBe(ID);
    ask.mockReturnValue(true);
    ws.switchTo(OTHER);
    await vi.waitFor(() => expect(connections.activeId()).toBe(OTHER));
  });
});
