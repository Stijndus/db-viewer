/**
 * SQL import against real servers (MYSQL_TEST_HOST, PG_TEST_HOST, MSSQL_TEST_HOST) and SQLite:
 * dumps with each dialect's tricky parts, also from an encrypted 7z.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbType } from '../../shared/models';
import type { ConnectionConfig, DbSession } from '../db/driver';
import { getDriver } from '../db/driver-registry';
import { sevenZip } from './archive';
import { importSql } from './sql-import';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const base = {
  ssl: false,
  allowSelfSigned: false,
  readOnly: false,
  database: 'app_dev',
  user: 'viewer',
};
const servers: {
  type: DbType;
  host?: string;
  config: Partial<ConnectionConfig>;
  schema: string;
  dump: string;
}[] = [
  {
    type: 'mysql',
    host: process.env['MYSQL_TEST_HOST'],
    config: { port: Number(process.env['MYSQL_TEST_PORT'] ?? 3306), password: 'test123' },
    schema: 'app_dev',
    dump: `-- MySQL dump
/*!40101 SET NAMES utf8mb4 */;
DROP TABLE IF EXISTS imp_test;
CREATE TABLE imp_test (id int PRIMARY KEY, naam varchar(50), n int DEFAULT 0);
INSERT INTO imp_test (id, naam) VALUES (1,'a;b'),(2,'it''s'),(3,'één');
DELIMITER ;;
CREATE TRIGGER imp_test_bi BEFORE INSERT ON imp_test FOR EACH ROW BEGIN
  SET NEW.n = NEW.id * 10;
END ;;
DELIMITER ;
INSERT INTO imp_test (id, naam) VALUES (4, 'na trigger');
`,
  },
  {
    type: 'postgres',
    host: process.env['PG_TEST_HOST'],
    config: { port: Number(process.env['PG_TEST_PORT'] ?? 5432), password: 'test123' },
    schema: 'public',
    dump: `SET client_encoding = 'UTF8';
DROP TABLE IF EXISTS imp_test;
CREATE TABLE imp_test (id int PRIMARY KEY, naam text, n int DEFAULT 0);
INSERT INTO imp_test (id, naam) VALUES (1,'a;b'),(2,'it''s'),(3,'één');
CREATE OR REPLACE FUNCTION imp_test_fn() RETURNS trigger AS $$
BEGIN NEW.n := NEW.id * 10; RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER imp_test_bi BEFORE INSERT ON imp_test FOR EACH ROW EXECUTE FUNCTION imp_test_fn();
INSERT INTO imp_test (id, naam) VALUES (4, 'na trigger');
`,
  },
  {
    type: 'mssql',
    host: process.env['MSSQL_TEST_HOST'],
    config: { port: Number(process.env['MSSQL_TEST_PORT'] ?? 1433), password: 'Test123!viewer' },
    schema: 'dbo',
    dump: `DROP TABLE IF EXISTS dbo.imp_test;
CREATE TABLE dbo.imp_test (id int PRIMARY KEY, naam nvarchar(50), n int DEFAULT 0);
INSERT INTO dbo.imp_test (id, naam) VALUES (1,N'a;b'),(2,N'it''s'),(3,N'één');
GO
CREATE TRIGGER dbo.imp_test_bi ON dbo.imp_test AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  UPDATE t SET n = t.id * 10 FROM dbo.imp_test t JOIN inserted i ON i.id = t.id;
END
GO
INSERT INTO dbo.imp_test (id, naam) VALUES (4, N'na trigger');
GO
`,
  },
];

for (const server of servers) {
  describe.skipIf(!server.host)(`SQL import into ${server.type}`, () => {
    let session: DbSession;
    let dir: string;

    beforeAll(async () => {
      session = await getDriver(server.type).open({
        ...base,
        type: server.type,
        host: server.host!,
        port: 0,
        password: '',
        ...server.config,
      } as ConnectionConfig);
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-imp-it-'));
    });
    afterAll(async () => {
      await session.runScript('cleanup', {
        statements: [`DROP TABLE IF EXISTS imp_test`],
        maxRows: 1,
        database: server.schema,
      });
      if (server.type === 'postgres')
        await session.runScript('cleanup', {
          statements: ['DROP FUNCTION IF EXISTS imp_test_fn()'],
          maxRows: 1,
        });
      await session.closeEditor('cleanup');
      await session.close();
    });

    const rows = async () => {
      const r = await session.runScript('check', {
        statements: ['SELECT id, naam, n FROM imp_test ORDER BY id'],
        maxRows: 100,
        database: server.schema,
      });
      await session.closeEditor('check');
      const first = r.results[0];
      return first?.kind === 'rows' ? first.rows : first;
    };

    it('runs a dump with its dialect-specific parts', async () => {
      const file = path.join(dir, 'dump.sql');
      await fs.writeFile(file, server.dump);
      const result = await importSql(
        session,
        server.type,
        false,
        { file, database: server.schema, onError: 'stop' },
        'a',
        () => {},
        new AbortController().signal,
      );
      expect(result.phase).toBe('done');
      expect(await rows()).toEqual([
        ['1', 'a;b', '0'],
        ['2', "it's", '0'],
        ['3', 'één', '0'],
        ['4', 'na trigger', '40'],
      ]);
    });

    it('runs the same dump from a password-protected 7z', async () => {
      await fs.writeFile(path.join(dir, 'dump.sql'), server.dump);
      execFileSync(sevenZip(), ['a', '-bd', '-y', '-pgeheim', '-mhe=on', 'dump.7z', 'dump.sql'], {
        cwd: dir,
        stdio: 'ignore',
      });
      const result = await importSql(
        session,
        server.type,
        false,
        {
          file: path.join(dir, 'dump.7z'),
          entry: 'dump.sql',
          password: 'geheim',
          database: server.schema,
          onError: 'stop',
        },
        'b',
        () => {},
        new AbortController().signal,
      );
      expect(result).toMatchObject({ phase: 'done', failed: 0 });
      expect(await rows()).toHaveLength(4);
    });

    it('stops at an error and leaves the rest', async () => {
      const file = path.join(dir, 'fout.sql');
      const sep = server.type === 'mssql' ? '\nGO\n' : ';\n';
      await fs.writeFile(
        file,
        [
          'DELETE FROM imp_test WHERE id = 4',
          'INSERT INTO bestaat_niet VALUES (1)',
          'DELETE FROM imp_test',
        ].join(sep) + sep,
      );
      const result = await importSql(
        session,
        server.type,
        false,
        { file, database: server.schema, onError: 'stop' },
        'c',
        () => {},
        new AbortController().signal,
      );
      expect(result).toMatchObject({ phase: 'stopped-at-error', statements: 1, failed: 1 });
      expect(result.errors[0]?.message).toMatch(/bestaat_niet/i);
      expect(await rows()).toHaveLength(3);
    });
  });
}
