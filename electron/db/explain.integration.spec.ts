/**
 * EXPLAIN on real servers: each dialect returns a plan as rows, the statement itself does not run,
 * and SQL Server's SHOWPLAN is switched off again afterwards.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { explainStatements } from '../../shared/explain';
import type { DbType } from '../../shared/models';
import type { ConnectionConfig, DbSession } from './driver';
import { getDriver } from './driver-registry';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sqliteFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-explain-')), 'x.db');
writeFileSync(sqliteFile, '');

const servers: {
  type: DbType;
  enabled: boolean;
  config: Partial<ConnectionConfig>;
  table: string;
}[] = [
  {
    type: 'mysql',
    enabled: Boolean(process.env['MYSQL_TEST_HOST']),
    config: {
      host: process.env['MYSQL_TEST_HOST'],
      port: Number(process.env['MYSQL_TEST_PORT'] ?? 3306),
      user: 'dbv_admin',
      password: 'admin123',
      database: 'app_dev',
    },
    table: 'app_dev.explain_t',
  },
  {
    type: 'postgres',
    enabled: Boolean(process.env['PG_TEST_HOST']),
    config: {
      host: process.env['PG_TEST_HOST'],
      port: Number(process.env['PG_TEST_PORT'] ?? 5432),
      user: 'dbv_admin',
      password: 'admin123',
      database: 'app_dev',
    },
    table: 'public.explain_t',
  },
  {
    type: 'mssql',
    enabled: Boolean(process.env['MSSQL_TEST_HOST']),
    config: {
      host: process.env['MSSQL_TEST_HOST'],
      port: Number(process.env['MSSQL_TEST_PORT'] ?? 1433),
      user: 'dbv_admin',
      password: 'Admin123!dbv',
      database: 'app_dev',
    },
    table: 'dbo.explain_t',
  },
  {
    type: 'sqlite',
    enabled: true,
    config: { host: '', database: sqliteFile, user: '' },
    table: 'explain_t',
  },
];

for (const server of servers) {
  describe.skipIf(!server.enabled)(`explain on ${server.type}`, () => {
    let session: DbSession;
    const tab = 'explain-test';
    const run = (statements: string[]) => session.runScript(tab, { statements, maxRows: 1000 });

    beforeAll(async () => {
      session = await getDriver(server.type).open({
        type: server.type,
        port: 0,
        password: '',
        ssl: false,
        allowSelfSigned: true,
        readOnly: false,
        ...server.config,
      } as ConnectionConfig);
      await run([`DROP TABLE IF EXISTS ${server.table}`]);
      await run([`CREATE TABLE ${server.table} (id int PRIMARY KEY, n int)`]);
      await run([`INSERT INTO ${server.table} (id, n) VALUES (1, 1)`]);
    });
    afterAll(async () => {
      await run([`DROP TABLE IF EXISTS ${server.table}`]).catch(() => undefined);
      await session.closeEditor(tab).catch(() => undefined);
      await session.close();
    });

    it('returns a plan without running the statement', async () => {
      const plan = explainStatements(
        [`SELECT * FROM ${server.table} WHERE id = 1`, `DELETE FROM ${server.table} WHERE n = 1`],
        server.type,
      );
      const result = await run(plan.statements);
      for (const at of plan.planAt) {
        const r = result.results[at]!;
        expect(r.kind, JSON.stringify(r)).toBe('rows');
        if (r.kind === 'rows') expect(r.rows.length).toBeGreaterThan(0);
      }
      // The DELETE was only explained; SHOWPLAN is off again, so this really runs.
      const count = await run([`SELECT COUNT(*) FROM ${server.table}`]);
      const r = count.results[0]!;
      expect(r.kind === 'rows' && r.rows[0]![0]).toBe('1');
    });
  });
}
