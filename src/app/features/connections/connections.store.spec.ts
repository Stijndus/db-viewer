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
      appInfo: async () => ({
        ok: true,
        data: { encryptionAvailable: false, version: '0.0.0-test' },
      }),
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
    expect(store.passwordPrompt()?.profile.id).toBe(PROFILE.id);
    expect(store.statusOf(PROFILE.id)).toBe('idle');
  });

  it('asks for the SSH password, and passes it with the next connect', async () => {
    const ssh = {
      host: 'server.example.com',
      port: 22,
      user: 'stijn',
      auth: 'password' as const,
      keyFile: '',
      hostKey: 'SHA256:' + 'a'.repeat(43),
    };
    const calls: unknown[] = [];
    const store = setup({
      listConnections: async () => ({ ok: true, data: [{ ...PROFILE, ssh }] }),
      connect: async (_id, secrets) => {
        calls.push(secrets);
        return secrets?.sshSecret
          ? { ok: true, data: { serverVersion: '8.0.40' } }
          : { ok: false, error: { code: 'SSH_SECRET_REQUIRED', message: 'SSH-wachtwoord nodig.' } };
      },
    });
    await store.init();
    await store.connect(PROFILE.id);
    expect(store.passwordPrompt()).toMatchObject({ askSsh: true, askPassword: false });
    await store.connect(PROFILE.id, { sshSecret: 'geheim' });
    expect(store.statusOf(PROFILE.id)).toBe('connected');
    expect(calls).toEqual([{}, { sshSecret: 'geheim' }]);
  });

  it('asks to trust an unknown SSH server, saves the fingerprint and connects again', async () => {
    const fingerprint = 'SHA256:' + 'b'.repeat(43);
    const ssh = {
      host: 'srv',
      port: 22,
      user: 'u',
      auth: 'agent' as const,
      keyFile: '',
      hostKey: '',
    };
    let trusted = '';
    const store = setup({
      listConnections: async () => ({
        ok: true,
        data: [{ ...PROFILE, ssh: { ...ssh, hostKey: trusted } }],
      }),
      trustHostKey: async (_id, fp) => {
        trusted = fp;
        return { ok: true, data: { ...PROFILE, ssh: { ...ssh, hostKey: fp } } };
      },
      connect: async () =>
        trusted
          ? { ok: true, data: { serverVersion: '8.0.40' } }
          : {
              ok: false,
              error: { code: 'SSH_HOST_KEY_UNKNOWN', message: 'Onbekend.', fingerprint },
            },
    });
    await store.init();
    const connecting = store.connect(PROFILE.id);
    await vi.waitFor(() => expect(store.hostKeyPrompt()).not.toBeNull());
    expect(store.hostKeyPrompt()).toMatchObject({ host: 'srv', fingerprint, changed: false });
    store.hostKeyPrompt()!.answer(true);
    await connecting;
    expect(trusted).toBe(fingerprint);
    expect(store.statusOf(PROFILE.id)).toBe('connected');
  });

  it('does not connect when the user does not trust the SSH server', async () => {
    const fingerprint = 'SHA256:' + 'c'.repeat(43);
    const trust = vi.fn();
    const store = setup({
      listConnections: async () => ({
        ok: true,
        data: [
          {
            ...PROFILE,
            ssh: { host: 'srv', port: 22, user: 'u', auth: 'agent', keyFile: '', hostKey: 'x' },
          },
        ],
      }),
      trustHostKey: trust,
      connect: async () => ({
        ok: false,
        error: { code: 'SSH_HOST_KEY_CHANGED', message: 'Veranderd.', fingerprint },
      }),
    });
    await store.init();
    const connecting = store.connect(PROFILE.id);
    await vi.waitFor(() => expect(store.hostKeyPrompt()?.changed).toBe(true));
    store.hostKeyPrompt()!.answer(false);
    await connecting;
    expect(trust).not.toHaveBeenCalled();
    expect(store.statusOf(PROFILE.id)).toBe('idle');
  });

  it('shows the SSH tunnel in the address', () => {
    const ssh = {
      host: 'srv',
      port: 22,
      user: 'stijn',
      auth: 'agent' as const,
      keyFile: '',
      hostKey: '',
    };
    expect(connectionAddress({ ...PROFILE, host: 'localhost', ssh })).toBe(
      'root@localhost:3306/app_dev via stijn@srv',
    );
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
