import { TestBed } from '@angular/core/testing';
import { HISTORY_SCRIPT_STATEMENTS } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, fakeRun, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { HistoryStore, historyEntries, joinStatements } from './history.store';
import { SqlStore } from './sql.store';

const run = (statements: string[]) => ({
  connectionId: PROFILE.id,
  connectionName: 'lokaal-dev',
  database: 'app_dev',
  dialect: 'mysql' as const,
  statements,
  startedAt: 1000,
  totalMs: 9,
});

describe('historyEntries', () => {
  it('keeps each statement that ran, with its result, up to the failing one', () => {
    const statements = ['SELECT 1', 'UPDATE t SET a = 1', 'SELEC x', 'SELECT 3'];
    const entries = historyEntries(run(statements), {
      ok: true,
      data: fakeRun({ statements, maxRows: 100 }),
    });
    expect(entries.map((e) => [e.sql, e.result.kind, e.at])).toEqual([
      ['SELECT 1', 'rows', 1000],
      ['UPDATE t SET a = 1', 'ok', 1001],
      ['SELEC x', 'error', 1002],
    ]);
    expect(entries[0]).toMatchObject({ database: 'app_dev', result: { rows: 1 } });
  });

  it('keeps a long script as one entry', () => {
    const statements = Array.from({ length: HISTORY_SCRIPT_STATEMENTS + 1 }, (_, i) => `DO ${i}`);
    const entries = historyEntries(run(statements), {
      ok: true,
      data: fakeRun({ statements, maxRows: 100 }),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ statements: statements.length, durationMs: 9 });
    expect(entries[0]!.sql.split('\n')).toHaveLength(statements.length);
  });

  it('keeps a failed run (lost connection) with its message', () => {
    expect(
      historyEntries(run(['SELECT 1']), {
        ok: false,
        error: { code: 'LOST', message: 'Verbinding verbroken' },
      }),
    ).toEqual([
      expect.objectContaining({
        sql: 'SELECT 1;',
        result: { kind: 'error', message: 'Verbinding verbroken' },
      }),
    ]);
  });

  it('joins statements the way the dialect splits them', () => {
    expect(joinStatements(['SELECT 1', 'SELECT 2;'], 'postgres')).toBe('SELECT 1;\nSELECT 2;');
    expect(joinStatements(['SELECT 1', 'SELECT 2'], 'mssql')).toBe('SELECT 1\nGO\nSELECT 2');
  });
});

describe('HistoryStore with the SQL tabs', () => {
  async function setup() {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: fakeDbApi() }] });
    const connections = TestBed.inject(ConnectionsStore);
    await connections.init();
    await connections.connect(PROFILE.id);
    TestBed.tick();
    const sql = TestBed.inject(SqlStore);
    const history = TestBed.inject(HistoryStore);
    const tab = sql.newTab(PROFILE.id, {});
    const exec = (text: string) =>
      sql.run(PROFILE.id, tab.id, 'all', { text, selectionFrom: 0, selectionTo: 0 });
    return { sql, history, exec };
  }

  it('records what runs in a SQL tab, newest first', async () => {
    const { history, exec } = await setup();
    await exec('SELECT 1; SELECT 2');
    await history.load();
    expect(history.entries()!.map((e) => e.sql)).toEqual(['SELECT 2', 'SELECT 1']);
    await exec('SELECT 3');
    await new Promise((r) => setTimeout(r));
    expect(history.entries()!.map((e) => e.sql)).toEqual(['SELECT 3', 'SELECT 2', 'SELECT 1']);
    expect(history.entries()![0]).toMatchObject({ connectionName: 'lokaal-dev' });
  });

  it('records nothing when turned off, and remembers that', async () => {
    const { history, exec } = await setup();
    history.setEnabled(false);
    await exec('SELECT 1');
    await history.load();
    expect(history.entries()).toEqual([]);
    expect(localStorage.getItem('dbv.history.enabled')).toBe('0');
  });

  it('deletes one entry and clears a connection', async () => {
    const { history, exec } = await setup();
    await exec('SELECT 1; SELECT 2');
    await history.load();
    await history.remove(history.entries()![0]!.id);
    expect(history.entries()!.map((e) => e.sql)).toEqual(['SELECT 1']);
    await history.clear(PROFILE.id);
    await history.load();
    expect(history.entries()).toEqual([]);
  });
});
