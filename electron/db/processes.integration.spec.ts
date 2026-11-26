/**
 * The process list against real servers (MYSQL_TEST_HOST, PG_TEST_HOST, MSSQL_TEST_HOST): a second
 * connection runs a long query, which shows in the list and can be stopped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbType } from '../../shared/models';
import type { ProcessDialect } from '../../shared/process-list';
import type { ConnectionConfig, DbSession } from './driver';
import { getDriver } from './driver-registry';
import { listProcesses, stopProcess } from './processes';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const servers: {
  type: ProcessDialect;
  host?: string;
  port: number;
  password: string;
  sleep: string;
}[] = [
  {
    type: 'mysql',
    host: process.env['MYSQL_TEST_HOST'],
    port: Number(process.env['MYSQL_TEST_PORT'] ?? 3306),
    password: 'admin123',
    sleep: 'SELECT SLEEP(30) AS dbv_slow',
  },
  {
    type: 'postgres',
    host: process.env['PG_TEST_HOST'],
    port: Number(process.env['PG_TEST_PORT'] ?? 5432),
    password: 'admin123',
    sleep: 'SELECT pg_sleep(30) AS dbv_slow',
  },
  {
    type: 'mssql',
    host: process.env['MSSQL_TEST_HOST'],
    port: Number(process.env['MSSQL_TEST_PORT'] ?? 1433),
    password: 'Admin123!dbv',
    sleep: "WAITFOR DELAY '00:00:30'; SELECT 1 AS dbv_slow",
  },
];

for (const server of servers) {
  describe.runIf(server.host)(`process list on ${server.type}`, () => {
    let admin: DbSession;
    let other: DbSession;
    const open = () =>
      getDriver(server.type as DbType).open({
        type: server.type,
        host: server.host!,
        port: server.port,
        database: 'app_dev',
        user: 'dbv_admin',
        password: server.password,
        ssl: false,
        allowSelfSigned: true,
        readOnly: false,
      } as ConnectionConfig);

    beforeAll(async () => {
      admin = await open();
      other = await open();
    });
    afterAll(async () => {
      await admin?.close();
      await other?.close();
    });

    /** Starts the slow query on the other connection and waits until the list shows it. */
    const startSlow = async (tab: string) => {
      const running = other.runScript(tab, { statements: [server.sleep], maxRows: 10 });
      for (let i = 0; i < 50; i++) {
        const list = await listProcesses(admin, server.type);
        const slow = list.processes.find((p) => p.query?.includes('dbv_slow') && !p.own);
        if (slow) return { running, slow, list };
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('De trage query staat niet in de lijst');
    };

    it('lists its own connection and a running query of another', async () => {
      const { running, slow, list } = await startSlow('slow-1');
      const own = list.processes.filter((p) => p.own);
      expect(own).toHaveLength(1);
      expect(own[0]!.idle).toBe(false);
      expect(slow).toMatchObject({ idle: false, background: false });
      expect(slow.user.toLowerCase()).toBe('dbv_admin');
      expect(slow.seconds).toBeGreaterThanOrEqual(0);
      // Stop it so the test does not wait 30 seconds.
      await stopProcess(admin, server.type, false, 'kill', slow.id);
      await running.catch(() => undefined);
      await other.closeEditor('slow-1').catch(() => undefined);
    });

    it.runIf(server.type !== 'mssql')('stops only the query, the connection stays', async () => {
      const { running, slow } = await startSlow('slow-2');
      const started = Date.now();
      await stopProcess(admin, server.type, false, 'cancel', slow.id);
      await running.catch(() => undefined);
      expect(Date.now() - started).toBeLessThan(10_000);
      const after = await listProcesses(admin, server.type);
      expect(after.processes.some((p) => p.id === slow.id)).toBe(true);
      await other.closeEditor('slow-2').catch(() => undefined);
    });

    it('ends the connection', async () => {
      const { running, slow } = await startSlow('slow-3');
      const started = Date.now();
      await stopProcess(admin, server.type, false, 'kill', slow.id);
      await running.catch(() => undefined);
      expect(Date.now() - started).toBeLessThan(10_000);
      for (let i = 0; i < 20; i++) {
        const after = await listProcesses(admin, server.type);
        if (!after.processes.some((p) => p.id === slow.id)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('De verbinding staat nog in de lijst');
    });

    it('refuses on a read-only connection, and tells a stopped process apart', async () => {
      await expect(stopProcess(admin, server.type, true, 'kill', '1')).rejects.toThrow(
        /alleen-lezen/,
      );
      if (server.type === 'postgres') {
        await expect(stopProcess(admin, server.type, false, 'cancel', '999999')).rejects.toThrow(
          /bestaat niet meer/,
        );
      }
    });

    it('keeps working after its own connection was ended', async () => {
      const own = (await listProcesses(admin, server.type)).processes.find((p) => p.own)!;
      await stopProcess(other, server.type, false, 'kill', own.id).catch(() => undefined);
      const again = await listProcesses(admin, server.type);
      expect(again.processes.some((p) => p.own)).toBe(true);
      // SQL Server hands a freed session id out again, so the new one can have the same number.
      if (server.type !== 'mssql') {
        expect(again.processes.find((p) => p.own)?.id).not.toBe(own.id);
      }
    });
  });
}
