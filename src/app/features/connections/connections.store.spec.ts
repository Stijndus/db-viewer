import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../shared/ipc-contract';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { connectionAddress, ConnectionsStore } from './connections.store';

function setup(overrides: Partial<DbApi> = {}) {
  TestBed.configureTestingModule({
    providers: [{ provide: DB_API, useValue: fakeDbApi(overrides) }],
  });
  return TestBed.inject(ConnectionsStore);
}

describe('ConnectionsStore', () => {
  it('loads connections and encryption status on init', async () => {
    const store = setup({
      appInfo: async () => ({ ok: true, data: { encryptionAvailable: false, version: '0.0.0-test' } }),
    });
    await store.init();
    expect(store.connections()).toEqual([PROFILE]);
    expect(store.encryptionAvailable()).toBe(false);
  });

  it('marks a connection connected and active', async () => {
    const store = setup();
    await store.init();
    await store.connect(PROFILE.id);
    expect(store.statusOf(PROFILE.id)).toBe('connected');
    expect(store.active()?.id).toBe(PROFILE.id);
    expect(store.serverVersions()[PROFILE.id]).toBe('8.0.40');
    expect(store.connectedCount()).toBe(1);
  });

  it('keeps the error per connection when connecting fails', async () => {
    const store = setup({
      connect: async () => ({
        ok: false,
        error: { code: 'ER_ACCESS_DENIED_ERROR', message: 'Inloggen mislukt.' },
      }),
    });
    await store.init();
    await store.connect(PROFILE.id);
    expect(store.statusOf(PROFILE.id)).toBe('error');
    expect(store.errors()[PROFILE.id]?.message).toBe('Inloggen mislukt.');
    expect(store.active()).toBeNull();
  });

  it('opens the password prompt when no password is stored', async () => {
    const store = setup({
      connect: async () => ({
        ok: false,
        error: { code: 'PASSWORD_REQUIRED', message: 'Wachtwoord nodig.' },
      }),
    });
    await store.init();
    await store.connect(PROFILE.id);
    expect(store.passwordPrompt()?.id).toBe(PROFILE.id);
    expect(store.statusOf(PROFILE.id)).toBe('idle');
  });

  it('shows a load error when not running inside Electron', async () => {
    const store = setup({
      listConnections: async () => ({
        ok: false,
        error: { code: 'NO_ELECTRON', message: 'Alleen in de desktop-app.' },
      }),
    });
    await store.init();
    expect(store.loadError()?.code).toBe('NO_ELECTRON');
  });

  it('disconnects and clears the active connection', async () => {
    const store = setup();
    await store.init();
    await store.connect(PROFILE.id);
    await store.disconnect(PROFILE.id);
    expect(store.statusOf(PROFILE.id)).toBe('idle');
    expect(store.active()).toBeNull();
  });

  it('formats an address', () => {
    expect(connectionAddress(PROFILE)).toBe('root@localhost:3306/app_dev');
    expect(connectionAddress({ ...PROFILE, database: '' })).toBe('root@localhost:3306');
  });
});
