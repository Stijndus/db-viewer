import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../shared/ipc-contract';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { SchemaStore } from '../schema/schema.store';
import { WorkspaceStore } from '../workspace/workspace.store';
import { StructureDialog } from './structure-dialog';
import { StructureStore, type StructureRequest } from './structure.store';

async function setup(request: StructureRequest, overrides: Partial<DbApi> = {}) {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  const ran: string[][] = [];
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DB_API,
        useValue: fakeDbApi({
          applyDdl: async (_id, _db, statements) => {
            ran.push(statements);
            return { ok: true, data: { ran: statements.length } };
          },
          ...overrides,
        }),
      },
    ],
  });
  const connections = TestBed.inject(ConnectionsStore);
  await connections.init();
  await connections.connect(PROFILE.id);
  await TestBed.inject(SchemaStore).loadColumns(PROFILE.id, 'app_dev', 'customers');
  const store = TestBed.inject(StructureStore);
  store.open(request);
  const fixture = TestBed.createComponent(StructureDialog);
  fixture.componentRef.setInput('request', request);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  await settle();
  const type = async (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const sql = () => el.querySelector('.sd-sql')?.textContent ?? '';
  const button = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('.dialog-foot button')).find(
      (b) => b.textContent?.trim() === text,
    )!;
  return { el, settle, type, sql, button, ran, store };
}

const base = { connectionId: PROFILE.id, database: 'app_dev', table: 'customers' };

describe('StructureDialog', () => {
  it('adds a column, showing the SQL as you type', async () => {
    const { type, sql, button, ran, settle, store, el } = await setup({ kind: 'column', ...base });
    expect(button('Uitvoeren').disabled).toBe(true);
    await type('#sd-name', 'stad');
    await type('#sd-type', 'varchar(80)');
    await type('#sd-default', "'Delft'");
    expect(sql()).toBe(
      "ALTER TABLE `app_dev`.`customers` ADD COLUMN `stad` varchar(80) NULL DEFAULT 'Delft';",
    );
    button('Uitvoeren').click();
    await settle();
    expect(ran).toEqual([
      ["ALTER TABLE `app_dev`.`customers` ADD COLUMN `stad` varchar(80) NULL DEFAULT 'Delft'"],
    ]);
    expect(store.changed()).toMatchObject({ table: 'customers' });
    // Closed (the close event that clears the store depends on the test's dialog stub).
    expect(el.querySelector('dialog')!.open).toBe(false);
  });

  it('changes a column with one CHANGE in MySQL, and says when nothing changed', async () => {
    const before = {
      name: 'email',
      type: 'varchar(255)',
      nullable: false,
      defaultValue: '',
      autoIncrement: false,
      comment: '',
    };
    const { type, sql, el } = await setup({ kind: 'column', ...base, before });
    expect(el.querySelector<HTMLInputElement>('#sd-name')!.value).toBe('email');
    await type('#sd-name', 'e_mail');
    expect(sql()).toBe(
      'ALTER TABLE `app_dev`.`customers` CHANGE COLUMN `email` `e_mail` varchar(255) NOT NULL;',
    );
  });

  it('builds an index from the clicked columns, with a suggested name', async () => {
    const { el, sql, settle } = await setup({ kind: 'index', ...base, columns: [] });
    const chips = Array.from(el.querySelectorAll<HTMLButtonElement>('.sd-col'));
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['id', 'email', 'status']);
    chips[2]!.click();
    chips[1]!.click();
    el.querySelector<HTMLInputElement>('.sd-unique input')!.click();
    await settle();
    expect(el.querySelector<HTMLInputElement>('#sd-iname')!.value).toBe(
      'uq_customers_status_email',
    );
    expect(sql()).toBe(
      'CREATE UNIQUE INDEX `uq_customers_status_email` ON `app_dev`.`customers` (`status`, `email`);',
    );
  });

  it('creates a table and opens it', async () => {
    const { type, sql, button, ran, settle } = await setup({
      kind: 'table',
      connectionId: PROFILE.id,
      database: 'app_dev',
    });
    await type('#sd-tname', 'klanten');
    expect(sql()).toContain('CREATE TABLE `app_dev`.`klanten` (');
    expect(sql()).toContain('`id` int AUTO_INCREMENT NOT NULL');
    expect(sql()).toContain('PRIMARY KEY (`id`)');
    button('Uitvoeren').click();
    await settle();
    expect(ran).toHaveLength(1);
    const tab = TestBed.inject(WorkspaceStore).active();
    expect(tab).toMatchObject({ kind: 'table', name: 'klanten' });
  });

  it('asks before dropping a column and shows a refusal', async () => {
    const { sql, button, el, settle } = await setup(
      { kind: 'drop-column', ...base, column: 'status' },
      {
        applyDdl: async () => ({
          ok: false,
          error: { code: 'DDL_FAILED', message: "Can't DROP 'status'" },
        }),
      },
    );
    expect(sql()).toBe('ALTER TABLE `app_dev`.`customers` DROP COLUMN `status`;');
    button('Verwijderen').click();
    await settle();
    expect(el.querySelector('.banner-error')?.textContent).toContain("Can't DROP");
  });
});
