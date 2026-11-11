import { TestBed } from '@angular/core/testing';
import type { ConnectionInput } from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { fakeDbApi, PROFILE } from '../../../testing/fake-db-api';
import { ConnectionForm } from './connection-form';

async function setup() {
  const saved: ConnectionInput[] = [];
  const api = fakeDbApi({
    saveConnection: async (input) => {
      saved.push(input);
      return { ok: true, data: { ...PROFILE, ...input, hasPassword: false } };
    },
  });
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: api }] });
  const fixture = TestBed.createComponent(ConnectionForm);
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const click = async (text: string) => {
    const button = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === text,
    );
    if (!button) throw new Error(`knop ${text} niet gevonden`);
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const input = (id: string) => el.querySelector<HTMLInputElement>(`#${id}`);
  const type = async (id: string, value: string) => {
    const i = input(id)!;
    i.value = value;
    i.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { el, click, input, type, saved };
}

describe('ConnectionForm', () => {
  it('switches port and user defaults with the database type', async () => {
    const { click, input } = await setup();
    expect(input('f-port')?.value).toBe('3306');
    await click('PostgreSQL');
    expect(input('f-port')?.value).toBe('5432');
    expect(input('f-user')?.value).toBe('postgres');
    await click('SQL Server');
    expect(input('f-port')?.value).toBe('1433');
    expect(input('f-user')?.value).toBe('sa');
  });

  it('keeps a port the user typed when switching type', async () => {
    const { click, input, type } = await setup();
    await click('PostgreSQL');
    await type('f-port', '6543');
    await click('MySQL / MariaDB');
    expect(input('f-port')?.value).toBe('6543');
  });

  it('asks only for a file for SQLite, and saves without server fields', async () => {
    const { el, click, input, type, saved } = await setup();
    await click('SQLite');
    expect(input('f-host')).toBeNull();
    expect(input('f-pw')).toBeNull();
    expect(el.textContent).toContain('Databasebestand');
    await click('Bladeren…');
    expect(input('f-db')?.value).toBe('/home/test/app.db');
    expect(input('f-name')?.value).toBe('app'); // named after the file when still empty
    await type('f-name', 'lokaal');
    await click('Opslaan');
    expect(saved[0]).toMatchObject({
      type: 'sqlite',
      name: 'lokaal',
      database: '/home/test/app.db',
      host: '',
      user: '',
      savePassword: false,
    });
  });

  it('requires a file for SQLite', async () => {
    const { el, click, saved } = await setup();
    await click('SQLite');
    await click('Opslaan');
    expect(saved).toHaveLength(0);
    expect(el.textContent).toContain('Kies een SQLite-databasebestand.');
  });
});
