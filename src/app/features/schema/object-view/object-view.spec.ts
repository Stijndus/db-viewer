import { TestBed } from '@angular/core/testing';
import { DB_API } from '../../../core/db-api';
import { fakeDbApi, PROFILE } from '../../../testing/fake-db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { WorkspaceStore } from '../../workspace/workspace.store';
import { ObjectView } from './object-view';

async function setup(kind: 'table' | 'view') {
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: fakeDbApi() }] });
  const connections = TestBed.inject(ConnectionsStore);
  await connections.init();
  await connections.connect(PROFILE.id);
  const fixture = TestBed.createComponent(ObjectView);
  fixture.componentRef.setInput('object', {
    connectionId: PROFILE.id,
    database: 'app_dev',
    name: 'customers',
    kind,
  });
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  await settle();
  const tab = (label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  tab('DDL').click();
  await settle();
  return { el, settle };
}

describe('ObjectView DDL tab', () => {
  it('shows the CREATE script with its indexes and triggers', async () => {
    const { el } = await setup('table');
    const text = el.querySelector('.ddl-text')?.textContent ?? '';
    expect(text).toContain('CREATE TABLE customers (id int);');
    expect(text).toContain('CREATE INDEX idx_customers ON customers (id);');
    expect(text).toContain('-- Triggers');
    expect(text).toContain('CREATE TRIGGER trg_customers');
  });

  it('opens the script in a new SQL tab', async () => {
    const { el, settle } = await setup('table');
    const ws = TestBed.inject(WorkspaceStore);
    const before = ws.tabs().length;
    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'In SQL-tabblad')!
      .click();
    await settle();
    expect(ws.tabs().length).toBe(before + 1);
  });

  it('shows the definition of a view', async () => {
    const { el } = await setup('view');
    expect(el.querySelector('.ddl-text')?.textContent).toContain('CREATE TABLE customers');
    expect(el.querySelector('.st-title')?.textContent).toContain('Definitie');
  });
});
