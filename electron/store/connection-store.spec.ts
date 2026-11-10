import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeCipher, input } from '../test-helpers';
import { ConnectionStore } from './connection-store';

describe('ConnectionStore', () => {
  let file: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-store-'));
    file = path.join(dir, 'connections.json');
  });

  it('saves a profile and never exposes or writes the plain password', async () => {
    const store = new ConnectionStore(file, fakeCipher());
    const saved = await store.save(input());

    expect(saved).toMatchObject({ name: 'lokaal-dev', hasPassword: true });
    expect(saved).not.toHaveProperty('password');
    expect(saved).not.toHaveProperty('encryptedPassword');
    expect(await fs.readFile(file, 'utf8')).not.toContain('test123');
    expect(await store.getPassword(saved.id)).toBe('test123');
  });

  it('survives a restart (new instance reads the file)', async () => {
    const saved = await new ConnectionStore(file, fakeCipher()).save(input());
    const reopened = new ConnectionStore(file, fakeCipher());
    expect(await reopened.list()).toEqual([saved]);
    expect(await reopened.getPassword(saved.id)).toBe('test123');
  });

  it('keeps the stored password when an update sends none', async () => {
    const store = new ConnectionStore(file, fakeCipher());
    const saved = await store.save(input());
    await store.save(input({ name: 'hernoemd', password: '' }), saved.id);
    expect(await store.getPassword(saved.id)).toBe('test123');
    expect((await store.get(saved.id)).name).toBe('hernoemd');
  });

  it('forgets the password when savePassword is turned off', async () => {
    const store = new ConnectionStore(file, fakeCipher());
    const saved = await store.save(input());
    const updated = await store.save(input({ savePassword: false }), saved.id);
    expect(updated.hasPassword).toBe(false);
    expect(await store.getPassword(saved.id)).toBeUndefined();
  });

  it('refuses to store a password when encryption is unavailable', async () => {
    const store = new ConnectionStore(file, fakeCipher(false));
    await expect(store.save(input())).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' });
    const withoutPassword = await store.save(input({ savePassword: false }));
    expect(withoutPassword.hasPassword).toBe(false);
  });

  it('drops allowSelfSigned when SSL is off', async () => {
    const saved = await new ConnectionStore(file, fakeCipher()).save(
      input({ ssl: false, allowSelfSigned: true }),
    );
    expect(saved.allowSelfSigned).toBe(false);
  });

  it('deletes and reports unknown ids', async () => {
    const store = new ConnectionStore(file, fakeCipher());
    const saved = await store.save(input());
    await store.delete(saved.id);
    expect(await store.list()).toEqual([]);
    await expect(store.delete(saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('moves a corrupt file aside instead of overwriting it silently', async () => {
    await fs.writeFile(file, '{ niet geldig');
    const store = new ConnectionStore(file, fakeCipher());
    expect(await store.list()).toEqual([]);
    const files = await fs.readdir(path.dirname(file));
    expect(files.some((f) => f.startsWith('connections.json.corrupt-'))).toBe(true);
  });
});
