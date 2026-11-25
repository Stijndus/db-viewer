import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../../shared/ipc-contract';
import type { DataFileOptions, DataImportRequest } from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { fakeDbApi, PROFILE } from '../../../testing/fake-db-api';
import { ConnectionsStore } from '../../connections/connections.store';
import { SchemaStore } from '../../schema/schema.store';
import { TransferStore } from '../transfer.store';
import { DataImportDialog } from './data-import-dialog';

async function setup(overrides: Partial<DbApi> = {}) {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  const previews: DataFileOptions[] = [];
  const started: DataImportRequest[] = [];
  const base = fakeDbApi();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DB_API,
        useValue: fakeDbApi({
          pickImportFile: () => Promise.resolve({ ok: true, data: '/home/test/klanten.csv' }),
          previewDataFile: (options) => {
            previews.push(options);
            return base.previewDataFile(options);
          },
          startDataImport: (_id, request) => {
            started.push(request);
            return Promise.resolve({ ok: true, data: { jobId: 'job-00000003' } });
          },
          ...overrides,
        }),
      },
    ],
  });
  const connections = TestBed.inject(ConnectionsStore);
  await connections.init();
  await connections.connect(PROFILE.id);
  await TestBed.inject(SchemaStore).loadDatabases(PROFILE.id);
  const fixture = TestBed.createComponent(DataImportDialog);
  fixture.componentRef.setInput('connectionId', PROFILE.id);
  fixture.componentRef.setInput('intoDatabase', 'app_dev');
  fixture.componentRef.setInput('intoTable', 'customers');
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
    await fixture.whenStable();
  };
  await settle();
  const button = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    )!;
  const choose = async () => {
    button('Kiezen…').click();
    await settle();
  };
  const selects = () => Array.from(el.querySelectorAll<HTMLSelectElement>('.dimp-preview select'));
  const pick = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await settle();
  };
  return { el, settle, previews, started, button, choose, selects, pick };
}

describe('DataImportDialog', () => {
  it('previews the file and matches its columns to the table by name', async () => {
    const { el, choose, selects } = await setup();
    await choose();
    expect(Array.from(el.querySelectorAll('.dimp-source')).map((s) => s.textContent)).toEqual([
      'id',
      'Email',
      'extra',
    ]);
    expect(selects().map((s) => s.value)).toEqual(['id', 'email', '']);
    expect(el.querySelectorAll('.dimp-preview tbody tr')).toHaveLength(2);
    expect(el.querySelector('.dimp-null')?.textContent?.trim()).toBe('NULL');
    expect((el.querySelector('#dimp-delim') as HTMLSelectElement).value).toBe(';');
  });

  it('starts the import with the mapping and options', async () => {
    const { choose, button, started, settle } = await setup();
    await choose();
    button('Importeren').click();
    await settle();
    expect(started).toEqual([
      {
        file: '/home/test/klanten.csv',
        header: true,
        delimiter: ';',
        encoding: 'utf-8',
        format: 'csv',
        database: 'app_dev',
        table: 'customers',
        mapping: [
          { source: 0, target: 'id' },
          { source: 1, target: 'email' },
        ],
        mode: 'append',
        onError: 'rollback',
        emptyAsNull: false,
      },
    ]);
    expect(TestBed.inject(TransferStore).imports()).toEqual([
      expect.objectContaining({ kind: 'data', table: 'customers', name: 'klanten.csv' }),
    ]);
  });

  it('reads the file again with another delimiter, keeping the matches', async () => {
    const { el, choose, previews, pick, selects } = await setup();
    await choose();
    await pick(selects()[2]!, 'status');
    await pick(el.querySelector<HTMLSelectElement>('#dimp-delim')!, ',');
    expect(previews.at(-1)).toMatchObject({ delimiter: ',' });
    expect(selects().map((s) => s.value)).toEqual(['id', 'email', 'status']);
  });

  it('needs the key column to update existing rows, and each column once', async () => {
    const { el, choose, button, pick, selects } = await setup();
    await choose();
    const upsert = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="dimp-mode"]'))[2]!;
    upsert.click();
    await pick(selects()[0]!, '');
    expect(button('Importeren').disabled).toBe(true);
    expect(el.textContent).toContain('Koppel de sleutelkolom id');
    await pick(selects()[0]!, 'email');
    expect(el.textContent).toContain('Elke tabelkolom kan maar één keer worden gekozen: email');
  });

  it('shows progress in rows, and that nothing was saved after a rollback', async () => {
    const { el, choose, button, settle } = await setup();
    await choose();
    button('Importeren').click();
    await settle();
    TestBed.inject(TransferStore).progress.set({
      'job-00000003': {
        jobId: 'job-00000003',
        kind: 'import',
        unit: 'rows',
        phase: 'stopped-at-error',
        rolledBack: true,
        bytes: 10,
        totalBytes: 10,
        statements: 0,
        failed: 1,
        errors: [
          { statement: 2, sql: 'id=2, email=NULL', message: "Column 'email' cannot be null" },
        ],
      },
    });
    await settle();
    expect(el.textContent).toContain('Gestopt bij een fout. Niets is opgeslagen.');
    expect(el.querySelector('.import-error')?.textContent).toContain('Rij 2');
  });
});
