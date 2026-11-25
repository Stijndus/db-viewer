import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../shared/ipc-contract';
import type { UserChange } from '../../../../shared/user-sql';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { generatePassword, UserManager } from './user-manager';

async function setup(overrides: Partial<DbApi> = {}) {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  const applied: UserChange[][] = [];
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DB_API,
        useValue: fakeDbApi({
          applyUserChanges: (_id, changes) => {
            applied.push(changes);
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
  const fixture = TestBed.createComponent(UserManager);
  fixture.componentRef.setInput('connectionId', PROFILE.id);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  await settle();
  return { fixture, el, settle, applied };
}

const byText = (el: HTMLElement, selector: string, text: string) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>(selector)).find(
    (b) => b.textContent?.trim() === text,
  )!;

describe('UserManager', () => {
  it('lists the users and shows the privileges of the first', async () => {
    const { el } = await setup();
    expect(
      Array.from(el.querySelectorAll('.um-user-name')).map((u) => u.textContent?.trim()),
    ).toEqual(['root@localhost', 'viewer@%']);
    expect(el.querySelector('.um-head h3')?.textContent).toBe('root@localhost');
    const scopes = Array.from(el.querySelectorAll('.um-scope-name .mono')).map(
      (s) => s.textContent,
    );
    expect(scopes).toEqual(['Hele server', 'app_dev']);
    const ticked = Array.from(
      el.querySelectorAll<HTMLInputElement>('.um-scope:nth-of-type(2) input:checked'),
    );
    expect(ticked).toHaveLength(2);
  });

  it('turns ticks into grants and revokes, shows the SQL and runs it', async () => {
    const { el, settle, applied } = await setup();
    const appDev = el.querySelectorAll('.um-scope')[1]!;
    const box = (name: string) =>
      Array.from(appDev.querySelectorAll('label'))
        .find((l) => l.textContent?.trim() === name)!
        .querySelector('input')!;
    box('INSERT').click();
    box('DELETE').click();
    await settle();
    expect(el.querySelector('.um-foot')?.textContent).toContain('2 wijzigingen');
    byText(el, '.um-foot button', 'Opslaan…').click();
    await settle();
    expect(el.querySelector('.danger-sql')?.textContent).toBe(
      "REVOKE INSERT ON `app_dev`.* FROM 'root'@'localhost'\nGRANT DELETE ON `app_dev`.* TO 'root'@'localhost'",
    );
    byText(el, '.um-dialog button', 'Uitvoeren').click();
    await settle();
    expect(applied).toEqual([
      [
        {
          action: 'revoke',
          user: { name: 'root', host: 'localhost' },
          scope: { database: 'app_dev' },
          privileges: ['INSERT'],
        },
        {
          action: 'grant',
          user: { name: 'root', host: 'localhost' },
          scope: { database: 'app_dev' },
          privileges: ['DELETE'],
        },
      ],
    ]);
  });

  it('creates a user with a generated password, hidden in the SQL', async () => {
    const { el, settle, applied } = await setup();
    byText(el, '.um-bar button', 'Nieuwe gebruiker…').click();
    await settle();
    const name = el.querySelector<HTMLInputElement>('#um-name')!;
    name.value = 'lezer';
    name.dispatchEvent(new Event('input'));
    const password = el.querySelector<HTMLInputElement>('#um-pw')!.value;
    expect(password).toHaveLength(20);
    await settle();
    byText(el, '.um-dialog button', 'Verder').click();
    await settle();
    expect(el.querySelector('.danger-sql')?.textContent).toBe(
      "CREATE USER 'lezer'@'%' IDENTIFIED BY '••••••••'",
    );
    byText(el, '.um-dialog button', 'Uitvoeren').click();
    await settle();
    expect(applied[0]).toEqual([
      { action: 'create', user: { name: 'lezer', host: '%' }, password },
    ]);
  });

  it('only shows on a read-only connection', async () => {
    const { el } = await setup({
      listConnections: () => Promise.resolve({ ok: true, data: [{ ...PROFILE, readOnly: true }] }),
    });
    expect(byText(el, '.um-bar button', 'Nieuwe gebruiker…').disabled).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLInputElement>('.um-scope input')).every((i) => i.disabled),
    ).toBe(true);
  });

  it('generates strong passwords', () => {
    const a = generatePassword();
    expect(a).toMatch(/^[A-Za-z2-9!#%*\-_+]{20}$/);
    expect(generatePassword()).not.toBe(a);
  });
});
