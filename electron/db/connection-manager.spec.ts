import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../store/connection-store';
import { fakeCipher, input } from '../test-helpers';
import { ConnectionManager } from './connection-manager';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';

function fakeDriver() {
  const opened: ConnectionConfig[] = [];
  const closed = vi.fn();
  const driver: DbDriver = {
    type: 'mysql',
    async open(config) {
      opened.push(config);
      await new Promise((r) => setTimeout(r, 5));
      if (config.password !== 'test123')
        throw Object.assign(new Error('denied'), { code: 'ER_ACCESS_DENIED_ERROR' });
      const session: DbSession = {
        serverVersion: async () => '8.0.40',
        query: async () => ({ rows: [], fields: [] }),
        close: async () => closed(),
      };
      return session;
    },
  };
  return { driver, opened, closed };
}

describe('ConnectionManager', () => {
  let store: ConnectionStore;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-mgr-'));
    store = new ConnectionStore(path.join(dir, 'connections.json'), fakeCipher());
  });

  it('test() measures latency and closes the session', async () => {
    const { driver, closed } = fakeDriver();
    const manager = new ConnectionManager(store, () => driver);
    const result = await manager.test(input());
    expect(result.serverVersion).toBe('8.0.40');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('test() with an id and no password uses the stored password', async () => {
    const { driver, opened } = fakeDriver();
    const manager = new ConnectionManager(store, () => driver);
    const saved = await store.save(input());
    await manager.test(input({ password: '' }), saved.id);
    expect(opened[0]?.password).toBe('test123');
  });

  it('connect() opens one pool even when clicked twice', async () => {
    const { driver, opened } = fakeDriver();
    const manager = new ConnectionManager(store, () => driver);
    const saved = await store.save(input());
    await Promise.all([manager.connect(saved.id), manager.connect(saved.id)]);
    expect(opened).toHaveLength(1);
    expect(manager.isConnected(saved.id)).toBe(true);
  });

  it('connect() asks for a password when none is stored', async () => {
    const { driver } = fakeDriver();
    const manager = new ConnectionManager(store, () => driver);
    const saved = await store.save(input({ savePassword: false }));
    await expect(manager.connect(saved.id)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    await expect(manager.connect(saved.id, 'test123')).resolves.toEqual({
      serverVersion: '8.0.40',
    });
  });

  it('a failed connect leaves nothing open and can be retried', async () => {
    const { driver } = fakeDriver();
    const manager = new ConnectionManager(store, () => driver);
    const saved = await store.save(input({ savePassword: false }));
    await expect(manager.connect(saved.id, 'fout')).rejects.toMatchObject({
      code: 'ER_ACCESS_DENIED_ERROR',
    });
    expect(manager.isConnected(saved.id)).toBe(false);
    await manager.connect(saved.id, 'test123');
    expect(manager.isConnected(saved.id)).toBe(true);
  });

  it('closeAll() closes every open session', async () => {
    const { driver, closed } = fakeDriver();
    const manager = new ConnectionManager(store, () => driver);
    const a = await store.save(input({ name: 'a' }));
    const b = await store.save(input({ name: 'b' }));
    await manager.connect(a.id);
    await manager.connect(b.id);
    await manager.closeAll();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(manager.isConnected(a.id) || manager.isConnected(b.id)).toBe(false);
  });
});
