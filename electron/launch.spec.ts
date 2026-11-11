import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseCli } from './cli';
import { resolveLaunch } from './launch';
import { ConnectionStore } from './store/connection-store';
import { fakeCipher, input } from './test-helpers';

const ctx = { cwd: '/tmp', env: {}, isFile: () => false };
const run = (store: ConnectionStore, args: string[], canSave = true) =>
  resolveLaunch(parseCli(args, ctx), store, canSave);

describe('resolveLaunch', () => {
  let store: ConnectionStore;
  let file: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-launch-'));
    file = path.join(dir, 'connections.json');
    store = new ConnectionStore(file, fakeCipher());
  });

  it('opens a saved connection by name, any case, with the password for this run only', async () => {
    const saved = await store.save(input({ name: 'Productie', password: '', savePassword: false }));
    const launch = await run(store, ['-c', 'productie', '-p', 'eenmalig']);
    expect(launch).toEqual({ kind: 'open', connectionId: saved.id });
    expect(await store.getPassword(saved.id)).toBe('eenmalig');
    // Never written to disk.
    expect(await fs.readFile(file, 'utf8')).not.toContain('eenmalig');
  });

  it('names the saved connections when the name is unknown', async () => {
    await store.save(input({ name: 'Lokaal' }));
    expect(await run(store, ['Produktie'])).toEqual({
      kind: 'error',
      message: 'Geen opgeslagen verbinding met de naam "Produktie".',
      hint: 'Opgeslagen: "Lokaal".',
    });
  });

  it('adds a temporary connection, once, that is not written to disk', async () => {
    const args = ['mysql://viewer:test123@127.0.0.1:3306/app_dev'];
    const first = await run(store, args);
    const second = await run(store, args);
    expect(first).toMatchObject({ kind: 'open' });
    expect(second).toEqual(first);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ temporary: true, name: 'viewer@127.0.0.1/app_dev' });
    expect(await store.getPassword(list[0]!.id)).toBe('test123');
    await expect(fs.readFile(file, 'utf8')).rejects.toThrow(); // nothing saved at all
  });

  it('uses a saved profile for the same server instead of adding one', async () => {
    const saved = await store.save(input({ host: 'localhost' }));
    expect(await run(store, ['mysql://viewer@127.0.0.1:3306/app_dev'])).toEqual({
      kind: 'open',
      connectionId: saved.id,
    });
    expect(await store.list()).toHaveLength(1);
  });

  it('--save keeps it, with the password encrypted when the keychain is there', async () => {
    const launch = await run(store, [
      '-t',
      'postgres',
      '-u',
      'app',
      '-p',
      'pw',
      '--name',
      'Pg',
      '--save',
    ]);
    const [profile] = await store.list();
    expect(launch).toEqual({ kind: 'open', connectionId: profile!.id });
    expect(profile).toMatchObject({ name: 'Pg', temporary: false, hasPassword: true });
    expect(await fs.readFile(file, 'utf8')).not.toContain('"pw"');

    const noKeychain = new ConnectionStore(file + '2', fakeCipher(false));
    await run(noKeychain, ['-t', 'postgres', '-u', 'x', '-p', 'pw', '--save'], false);
    const [other] = await noKeychain.list();
    expect(other).toMatchObject({ temporary: false, hasPassword: false });
    expect(await noKeychain.getPassword(other!.id)).toBe('pw'); // still usable this run
  });

  it('saving a temporary connection keeps its id and its password', async () => {
    const launch = await run(store, ['mysql://viewer:test123@db/app']);
    const id = launch?.kind === 'open' ? launch.connectionId : '';
    const profile = await store.get(id);
    const saved = await store.save(
      { ...input(), ...profile, name: 'Bewaard', password: '', savePassword: true },
      id,
    );
    expect(saved).toMatchObject({ id, name: 'Bewaard', temporary: false, hasPassword: true });
    expect(await store.list()).toHaveLength(1);
  });

  it('reports invalid options as an error to show', async () => {
    expect(await run(store, ['--hots', 'x'])).toMatchObject({
      kind: 'error',
      message: 'Onbekende optie: --hots',
    });
  });
});
