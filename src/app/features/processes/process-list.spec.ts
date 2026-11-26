import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../shared/ipc-contract';
import type { ProcessAction } from '../../../../shared/process-list';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { WorkspaceStore } from '../workspace/workspace.store';
import { SqlStore } from '../sql/sql.store';
import { ProcessListView } from './process-list';

async function setup(overrides: Partial<DbApi> = {}) {
  localStorage.clear();
  const stopped: [ProcessAction, string][] = [];
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DB_API,
        useValue: fakeDbApi({
          stopProcess: (_id, action, pid) => {
            stopped.push([action, pid]);
            return Promise.resolve({ ok: true, data: undefined });
          },
          ...overrides,
        }),
      },
    ],
  });
  const connections = TestBed.inject(ConnectionsStore);
  await connections.init();
  await connections.connect(PROFILE.id);
  const fixture = TestBed.createComponent(ProcessListView);
  fixture.componentRef.setInput('connectionId', PROFILE.id);
  fixture.componentRef.setInput('active', false);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  await settle();
  const ids = () =>
    Array.from(el.querySelectorAll('.pl-table tbody tr td:first-child')).map((td) =>
      td.textContent?.trim(),
    );
  const button = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    )!;
  return { el, settle, ids, button, stopped };
}

describe('ProcessListView', () => {
  it('shows running queries and its own connection; idle and server processes on request', async () => {
    const { el, ids, settle } = await setup();
    expect(ids()).toEqual(['5', '9']);
    expect(el.querySelector('.um-bar')?.textContent).toContain('3 verbindingen, 1 bezig');
    expect(el.textContent).toContain('deze lijst');
    // Running for more than 30 seconds: marked.
    expect(el.querySelector('tbody tr td.warn-text')?.textContent?.trim()).toBe('1 min 15 s');
    const [idle, background] = Array.from(
      el.querySelectorAll<HTMLInputElement>('.um-bar input[type="checkbox"]'),
    );
    idle!.click();
    background!.click();
    await settle();
    expect(ids()).toEqual(['5', '6', '9', '1']);
  });

  it('searches, and stops a query or a connection after asking', async () => {
    const { el, ids, settle, button, stopped } = await setup();
    const search = el.querySelector<HTMLInputElement>('.pl-search')!;
    search.value = 'orders';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(ids()).toEqual(['5']);
    el.querySelector<HTMLElement>('.pl-table tbody tr')!.click();
    await settle();
    expect(el.querySelector('.pl-sql')?.textContent).toBe('SELECT * FROM orders WHERE total > 100');
    const answers = [false, true, true];
    window.confirm = () => answers.shift()!;
    button('Query stoppen').click();
    await settle();
    expect(stopped).toEqual([]);
    button('Query stoppen').click();
    await settle();
    button('Verbinding verbreken').click();
    await settle();
    expect(stopped).toEqual([
      ['cancel', '5'],
      ['kill', '5'],
    ]);
    expect(el.querySelector('.ok-text')?.textContent).toContain('Verbinding 5 verbroken');
  });

  it('does not let its own connection be ended, and opens a query in a SQL tab', async () => {
    const { el, settle, button } = await setup();
    const rows = el.querySelectorAll<HTMLElement>('.pl-table tbody tr');
    rows[1]!.click();
    await settle();
    expect(button('Verbinding verbreken').disabled).toBe(true);
    rows[0]!.click();
    await settle();
    button('In SQL-tabblad').click();
    const ws = TestBed.inject(WorkspaceStore);
    const tab = ws.active();
    expect(tab?.kind).toBe('sql');
    expect(TestBed.inject(SqlStore).tab(PROFILE.id, tab!.id)?.text).toBe(
      'SELECT * FROM orders WHERE total > 100',
    );
  });

  it('shows the server refusing', async () => {
    const { el } = await setup({
      listProcesses: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'ACCESS_DENIED', message: 'Deze verbinding mag dat niet op de server.' },
        }),
    });
    expect(el.querySelector('.banner-error')?.textContent).toContain('mag dat niet');
  });
});
