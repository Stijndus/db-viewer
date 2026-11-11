import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../shared/ipc-contract';
import type { RunRequest } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { pickStatements, SqlStore } from './sql.store';

const ID = PROFILE.id;

async function setup(overrides: Partial<DbApi> = {}, readOnly = false) {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  const runs: RunRequest[] = [];
  const closed: string[] = [];
  const api = fakeDbApi({
    listConnections: async () => ({ ok: true, data: [{ ...PROFILE, readOnly }] }),
    ...overrides,
  });
  const recorded: DbApi = {
    ...api,
    runScript: (id, tab, request) => {
      runs.push(request);
      return api.runScript(id, tab, request);
    },
    closeEditor: (id, tab) => {
      closed.push(tab);
      return api.closeEditor(id, tab);
    },
  };
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: recorded }] });
  const connections = TestBed.inject(ConnectionsStore);
  const sql = TestBed.inject(SqlStore);
  await connections.init();
  await connections.connect(ID);
  TestBed.tick();
  return { sql, connections, runs, closed };
}

const snap = (text: string, from = text.length, to = from) => ({
  text,
  selectionFrom: from,
  selectionTo: to,
});

describe('pickStatements', () => {
  const text = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
  it('takes the statement under the cursor', () => {
    expect(pickStatements(snap(text, 12), 'current').map((s) => s.sql)).toEqual(['SELECT 2']);
  });
  it('prefers the selection, with offsets in the full text', () => {
    const picked = pickStatements(snap(text, 10, text.length), 'current');
    expect(picked.map((s) => s.sql)).toEqual(['SELECT 2', 'SELECT 3']);
    expect(text.slice(picked[0]!.from, picked[0]!.to)).toBe('SELECT 2');
  });
  it('runs everything in mode all', () => {
    expect(pickStatements(snap(text, 0), 'all')).toHaveLength(3);
  });
});

describe('SqlStore', () => {
  it('opens numbered tabs in the database of the profile', async () => {
    const { sql } = await setup();
    const a = sql.newTab(ID);
    const b = sql.newTab(ID);
    expect([a.title, b.title]).toEqual(['SQL 1', 'SQL 2']);
    expect(a.database).toBe('app_dev');
    expect(sql.tabsOf(ID).map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it('runs reads without asking and shows the last result', async () => {
    const { sql, runs } = await setup();
    const tab = sql.newTab(ID);
    await sql.run(ID, tab.id, 'all', snap('SELECT 1; SELECT 2'));
    expect(runs[0]).toEqual({
      statements: ['SELECT 1', 'SELECT 2'],
      database: 'app_dev',
      maxRows: 1000,
    });
    expect(sql.tab(ID, tab.id)?.result?.results).toHaveLength(2);
    expect(sql.tab(ID, tab.id)?.activeResult).toBe(1);
  });

  it('jumps to the failing statement', async () => {
    const { sql } = await setup();
    const tab = sql.newTab(ID);
    await sql.run(ID, tab.id, 'all', snap('SELECT 1; SELEC 2; SELECT 3'));
    const t = sql.tab(ID, tab.id)!;
    expect(t.result?.results.map((r) => r.kind)).toEqual(['rows', 'error']);
    expect(t.activeResult).toBe(1);
  });

  it('asks before a write, and runs nothing when cancelled', async () => {
    const { sql, runs } = await setup();
    const tab = sql.newTab(ID);
    const pending = sql.run(ID, tab.id, 'all', snap('SELECT 1; DELETE FROM t'));
    await Promise.resolve();
    const request = sql.confirmation();
    expect(request?.statements).toEqual([
      { sql: 'DELETE FROM t', keyword: 'DELETE', unbounded: true },
    ]);
    expect(request?.total).toBe(2);
    sql.answerConfirmation(false);
    await pending;
    expect(runs).toHaveLength(0);
    expect(sql.confirmation()).toBeNull();
  });

  it('remembers "don\'t ask again" for the connection', async () => {
    const { sql, runs } = await setup();
    const tab = sql.newTab(ID);
    const first = sql.run(ID, tab.id, 'current', snap('UPDATE t SET a = 1 WHERE id = 2'));
    await Promise.resolve();
    sql.answerConfirmation(true, true);
    await first;
    await sql.run(ID, tab.id, 'current', snap('INSERT INTO t VALUES (1)'));
    expect(sql.confirmation()).toBeNull();
    expect(runs).toHaveLength(2);
  });

  it('does not ask on a read-only connection: the server refuses writes itself', async () => {
    const { sql, runs } = await setup({}, true);
    const tab = sql.newTab(ID);
    await sql.run(ID, tab.id, 'current', snap('DELETE FROM t'));
    expect(sql.confirmation()).toBeNull();
    expect(runs).toHaveLength(1);
  });

  it('reports an empty editor instead of running', async () => {
    const { sql, runs } = await setup();
    const tab = sql.newTab(ID);
    await sql.run(ID, tab.id, 'current', snap('  -- only a comment\n'));
    expect(runs).toHaveLength(0);
    expect(sql.tab(ID, tab.id)?.error?.code).toBe('EMPTY');
  });

  it('closes the server session with the tab', async () => {
    const { sql, closed } = await setup();
    const a = sql.newTab(ID);
    const b = sql.newTab(ID);
    await sql.closeTab(ID, b.id);
    expect(closed).toEqual([b.id]);
    expect(sql.tabsOf(ID).map((t) => t.id)).toEqual([a.id]);
  });

  it('keeps tab text across restarts', async () => {
    vi.useFakeTimers();
    const { sql } = await setup();
    const tab = sql.newTab(ID);
    sql.setText(ID, tab.id, 'SELECT 42');
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    const saved = JSON.parse(localStorage.getItem(`dbv.sql.v1.${ID}`) ?? '[]');
    expect(saved).toEqual([
      { id: tab.id, title: 'SQL 1', text: 'SELECT 42', database: 'app_dev', maxRows: 1000 },
    ]);
  });
});

describe('pickStatements per dialect', () => {
  it('runs a SQL Server batch as a whole, split only on GO', () => {
    const text = 'DECLARE @x int = 1;\nSELECT @x;\nGO\nSELECT 2';
    const picked = pickStatements(snap(text, 5), 'current', 'mssql');
    expect(picked.map((s) => s.sql)).toEqual(['DECLARE @x int = 1;\nSELECT @x;']);
    expect(pickStatements(snap(text, 0), 'all', 'mssql')).toHaveLength(2);
  });

  it('keeps a PostgreSQL function body in one piece', () => {
    const text = 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\nSELECT f();';
    expect(pickStatements(snap(text, 0), 'all', 'postgres').map((s) => s.sql)).toEqual([
      'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql',
      'SELECT f()',
    ]);
  });
});
