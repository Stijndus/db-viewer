/**
 * The whole path through an SSH tunnel against real servers: an in-process SSH server forwards
 * to MySQL/MariaDB (MYSQL_TEST_HOST) and PostgreSQL (PG_TEST_HOST). Skipped without them.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbType, SshSettings } from '../../shared/models';
import { ConnectionStore } from '../store/connection-store';
import { fakeCipher, input } from '../test-helpers';
import { ConnectionManager } from './connection-manager';
import { getDriver } from './driver-registry';
import { startTestSshServer, type TestSshServer } from './test-ssh-server';

const servers: {
  type: DbType;
  host: string | undefined;
  port: number;
  password?: string;
  schema: string;
}[] = [
  {
    type: 'mysql',
    host: process.env['MYSQL_TEST_HOST'],
    port: Number(process.env['MYSQL_TEST_PORT'] ?? 3306),
    schema: 'app_dev',
  },
  {
    type: 'postgres',
    host: process.env['PG_TEST_HOST'],
    port: Number(process.env['PG_TEST_PORT'] ?? 5432),
    schema: 'public',
  },
  {
    type: 'mssql',
    host: process.env['MSSQL_TEST_HOST'],
    port: Number(process.env['MSSQL_TEST_PORT'] ?? 1433),
    password: 'Test123!viewer',
    schema: 'dbo',
  },
];

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

for (const server of servers) {
  describe.skipIf(!server.host)(`${server.type} through an SSH tunnel`, () => {
    let ssh: TestSshServer;
    let store: ConnectionStore;
    let manager: ConnectionManager;
    let settings: SshSettings;

    beforeAll(async () => {
      ssh = await startTestSshServer();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-ssh-it-'));
      store = new ConnectionStore(path.join(dir, 'connections.json'), fakeCipher());
      manager = new ConnectionManager(store, getDriver);
      settings = {
        host: '127.0.0.1',
        port: ssh.port,
        user: 'tunnel',
        auth: 'password',
        keyFile: '',
        hostKey: '',
      };
    });
    afterAll(async () => {
      await manager.closeAll();
      await ssh.close();
    });

    const profile = (extra: Partial<SshSettings> = {}) =>
      input({
        type: server.type,
        // The database host as seen from the SSH server.
        host: server.host!,
        port: server.port,
        ssh: { ...settings, ...extra },
        sshSecret: 'geheim',
        ...(server.password && { password: server.password }),
      });

    it('test() reports the unknown host key, then works once it is trusted', async () => {
      const err = await manager.test(profile()).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'SSH_HOST_KEY_UNKNOWN', fingerprint: ssh.fingerprint });
      const ok = await manager.test(profile({ hostKey: ssh.fingerprint }));
      expect(ok.serverVersion).toBeTruthy();
    });

    it('a saved profile browses, reads data and runs SQL through the tunnel', async () => {
      const saved = await store.save(profile({ hostKey: ssh.fingerprint }));
      expect(saved.hasSshSecret).toBe(true);
      await manager.connect(saved.id);
      const session = manager.session(saved.id);

      const dbs = await session.listDatabases();
      expect(dbs.length).toBeGreaterThan(0);
      const page = await session.readRows(server.schema, 'events', {
        offset: 0,
        limit: 5,
        orderBy: [],
      });
      expect(page.rows).toHaveLength(5);
      // The editor opens its own connection: also through the tunnel.
      const run = await session.runScript('t1', { statements: ['SELECT 1 + 1'], maxRows: 10 });
      expect(run.results[0]).toMatchObject({ kind: 'rows', rows: [['2']] });

      const loginsBefore = ssh.logins();
      await manager.disconnect(saved.id);
      // Disconnecting closes the tunnel too: a new connect logs in again.
      await manager.connect(saved.id);
      expect(ssh.logins()).toBe(loginsBefore + 1);
      await manager.disconnect(saved.id);
    });

    it('says when the database is not reachable from the SSH server', async () => {
      const err = await manager
        .test({ ...profile({ hostKey: ssh.fingerprint }), port: 1 })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'SSH_FORWARD_FAILED' });
    });

    it('asks for the SSH password when none is stored', async () => {
      const saved = await store.save({
        ...profile({ hostKey: ssh.fingerprint }),
        name: 'zonder-ssh-wachtwoord',
        sshSecret: '',
        savePassword: true,
      });
      // savePassword with an empty secret keeps nothing for a new profile.
      expect(saved.hasSshSecret).toBe(false);
      await expect(manager.connect(saved.id)).rejects.toMatchObject({
        code: 'SSH_SECRET_REQUIRED',
      });
      await manager.connect(saved.id, { sshSecret: 'geheim' });
      expect(manager.isConnected(saved.id)).toBe(true);
      await manager.disconnect(saved.id);
    });
  });
}
