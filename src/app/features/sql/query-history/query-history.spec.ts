import { TestBed } from '@angular/core/testing';
import type { NewHistoryEntry } from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { fakeDbApi, PROFILE } from '../../../testing/fake-db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { HistoryStore } from '../history.store';
import { SqlStore } from '../sql.store';
import { QueryHistory } from './query-history';

const entry = (sql: string, extra: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  connectionId: PROFILE.id,
  connectionName: 'lokaal-dev',
  database: 'app_dev',
  sql,
  at: Date.now(),
  durationMs: 12,
  result: { kind: 'rows', rows: 3 },
  ...extra,
});

async function setup() {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  const api = fakeDbApi();
  await api.historyAdd([
    entry('SELECT * FROM customers'),
    entry("CREATE USER 'x' IDENTIFIED BY 'geheim'", {
      result: { kind: 'error', message: 'Access denied' },
    }),
    entry('SELECT 1', {
      connectionId: '22222222-2222-4222-8222-222222222222',
      connectionName: 'oud',
    }),
    entry('UPDATE orders SET total = 0', { result: { kind: 'ok', affected: 4 } }),
  ]);
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: api }] });
  const connections = TestBed.inject(ConnectionsStore);
  await connections.init();
  await connections.connect(PROFILE.id);
  connections.activeId.set(PROFILE.id);
  const history = TestBed.inject(HistoryStore);
  history.open(PROFILE.id);
  const fixture = TestBed.createComponent(QueryHistory);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  await settle();
  const sqls = () => Array.from(el.querySelectorAll('.qh-sql')).map((s) => s.textContent);
  const button = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    )!;
  const key = async (k: string, init: KeyboardEventInit = {}) => {
    el.querySelector('input[type="search"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }),
    );
    await settle();
  };
  return { el, settle, sqls, button, key, history };
}

describe('QueryHistory', () => {
  it('shows the current connection first, newest on top, with results', async () => {
    const { el, sqls } = await setup();
    expect(sqls()).toEqual([
      'UPDATE orders SET total = 0',
      "CREATE USER 'x' IDENTIFIED BY 'geheim'",
      'SELECT * FROM customers',
    ]);
    const results = Array.from(el.querySelectorAll('.qh-result')).map((r) => r.textContent?.trim());
    expect(results).toEqual(['4 rijen gewijzigd', 'Fout', '3 rijen']);
    expect(el.querySelector('.qh-msg')?.textContent).toBe('Access denied');
  });

  it('searches the SQL, filters errors, and shows other connections', async () => {
    const { el, sqls, settle } = await setup();
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'select customers';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(sqls()).toEqual(['SELECT * FROM customers']);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    el.querySelector<HTMLInputElement>('.qh-errors input')!.click();
    await settle();
    expect(sqls()).toEqual(["CREATE USER 'x' IDENTIFIED BY 'geheim'"]);
    el.querySelector<HTMLInputElement>('.qh-errors input')!.click();
    const conn = el.querySelector<HTMLSelectElement>('.qh-conn')!;
    expect(Array.from(conn.options).map((o) => o.textContent?.trim())).toEqual([
      'Alle verbindingen',
      'lokaal-dev',
      'oud (verwijderd)',
    ]);
    conn.value = '';
    conn.dispatchEvent(new Event('change'));
    await settle();
    expect(sqls()).toHaveLength(4);
  });

  it('deletes one query (Delete key on the list) and keeps the rest', async () => {
    const { el, sqls, settle, history } = await setup();
    el.querySelectorAll<HTMLElement>('.qh-item')[1]!.click();
    await settle();
    el.querySelector('.qh-list')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
    );
    await settle();
    expect(sqls()).not.toContain("CREATE USER 'x' IDENTIFIED BY 'geheim'");
    await history.load();
    expect(history.entries()).toHaveLength(3);
  });

  it('opens a query in a new tab with Ctrl+Enter, or into the current SQL tab', async () => {
    const { key, history, button, settle } = await setup();
    const ws = TestBed.inject(WorkspaceStore);
    const sql = TestBed.inject(SqlStore);
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter', { ctrlKey: true });
    expect(history.panelFor()).toBeNull();
    const active = ws.active();
    expect(active?.kind).toBe('sql');
    expect(sql.tab(PROFILE.id, active!.id)?.text).toBe('SELECT * FROM customers');

    history.open(PROFILE.id);
    await settle();
    button('In huidig tabblad').click();
    expect(sql.insertRequest()).toEqual({
      tabId: active!.id,
      text: 'UPDATE orders SET total = 0\n',
    });
  });
});
