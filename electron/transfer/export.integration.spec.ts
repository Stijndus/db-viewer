/**
 * Export against real servers and SQLite: a table with awkward values goes out as SQL (with
 * CREATE TABLE), is dropped, comes back through the SQL import, and must be identical.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbType, ExportRequest } from '../../shared/models';
import type { ConnectionConfig, DbSession, RowSource } from '../db/driver';
import { getDriver } from '../db/driver-registry';
import { asText, exportData } from './export';
import { importSql } from './sql-import';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sqliteFile = path.join(os.tmpdir(), `dbv-exp-it-${process.pid}.db`);
const base = { ssl: false, allowSelfSigned: false, readOnly: false, user: 'viewer' };

const servers: {
  type: DbType;
  enabled: boolean;
  config: Partial<ConnectionConfig>;
  schema: string;
  setup: string[];
}[] = [
  {
    type: 'mysql',
    enabled: Boolean(process.env['MYSQL_TEST_HOST']),
    config: {
      host: process.env['MYSQL_TEST_HOST'],
      port: 3306,
      password: 'test123',
      database: 'app_dev',
    },
    schema: 'app_dev',
    setup: [
      'DROP TABLE IF EXISTS exp_rt',
      'CREATE TABLE exp_rt (id int PRIMARY KEY, d decimal(20,2), t datetime(3), b varbinary(10), s varchar(50), n int)',
      "INSERT INTO exp_rt VALUES (1, 123456789012345678.91, '2026-01-02 03:04:05.678', X'00FF10', 'it''s; \"q\" \\\\ één', NULL), (2, NULL, NULL, NULL, '', 0)",
    ],
  },
  {
    type: 'postgres',
    enabled: Boolean(process.env['PG_TEST_HOST']),
    config: {
      host: process.env['PG_TEST_HOST'],
      port: 5432,
      password: 'test123',
      database: 'app_dev',
    },
    schema: 'public',
    setup: [
      'DROP TABLE IF EXISTS exp_rt',
      'CREATE TABLE exp_rt (id int PRIMARY KEY, d numeric(20,2), t timestamp(3), b bytea, s text, n int)',
      "INSERT INTO exp_rt VALUES (1, 123456789012345678.91, '2026-01-02 03:04:05.678', '\\x00ff10', 'it''s; \"q\" \\ één', NULL), (2, NULL, NULL, NULL, '', 0)",
    ],
  },
  {
    type: 'mssql',
    enabled: Boolean(process.env['MSSQL_TEST_HOST']),
    config: {
      host: process.env['MSSQL_TEST_HOST'],
      port: 1433,
      password: 'Test123!viewer',
      database: 'app_dev',
    },
    schema: 'dbo',
    setup: [
      'DROP TABLE IF EXISTS dbo.exp_rt',
      'CREATE TABLE dbo.exp_rt (id int PRIMARY KEY, d decimal(20,2), t datetime2(3), b varbinary(10), s nvarchar(50), n int)',
      "INSERT INTO dbo.exp_rt VALUES (1, 123456789012345678.91, '2026-01-02 03:04:05.678', 0x00FF10, N'it''s; \"q\" \\ één', NULL), (2, NULL, NULL, NULL, N'', 0)",
    ],
  },
  {
    type: 'sqlite',
    enabled: true,
    config: { host: '', port: 0, password: '', database: sqliteFile },
    schema: 'main',
    setup: [
      'DROP TABLE IF EXISTS exp_rt',
      'CREATE TABLE exp_rt (id integer PRIMARY KEY, d text, t text, b blob, s text, n integer)',
      "INSERT INTO exp_rt VALUES (1, '123456789012345678.91', '2026-01-02 03:04:05.678', X'00FF10', 'it''s; \"q\" \\ één', NULL), (2, NULL, NULL, NULL, '', 0)",
    ],
  },
];

for (const server of servers) {
  describe.skipIf(!server.enabled)(`export from ${server.type}`, () => {
    let session: DbSession;
    let dir: string;
    const signal = new AbortController().signal;

    const rows = async (
      source: RowSource = {
        kind: 'table',
        database: server.schema,
        table: 'exp_rt',
        orderBy: [{ column: 'id', direction: 'asc' }],
      },
    ) => {
      const out: (string | null)[][] = [];
      await session.streamRows(
        source,
        async (b) => void out.push(...b.rows.map((r) => r.map(asText))),
        signal,
      );
      return out;
    };
    const exec = async (statements: string[]) => {
      const r = await session.runScript('setup', {
        statements,
        maxRows: 1,
        database: server.schema,
      });
      const err = r.results.find((x) => x.kind === 'error');
      if (err) throw new Error(JSON.stringify(err));
    };

    beforeAll(async () => {
      if (server.type === 'sqlite') new DatabaseSync(sqliteFile).close();
      session = await getDriver(server.type).open({
        ...base,
        type: server.type,
        ...server.config,
      } as ConnectionConfig);
      await exec(server.setup);
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-exp-it-'));
    });
    afterAll(async () => {
      await exec(['DROP TABLE IF EXISTS exp_rt']).catch(() => undefined);
      await session.closeEditor('setup');
      await session.close();
      if (server.type === 'sqlite') await fs.rm(sqliteFile, { force: true });
    });

    it('streams full values: exact decimals, binary, unicode', async () => {
      const [first, second] = await rows();
      expect(first).toEqual([
        '1',
        '123456789012345678.91',
        expect.stringMatching(/^2026-01-02 03:04:05\.678/),
        '0x00ff10',
        'it\'s; "q" \\ één',
        null,
      ]);
      expect(second).toEqual(['2', null, null, null, '', '0']);
    });

    it('exports a query, and refuses one that writes', async () => {
      expect(
        await rows({
          kind: 'query',
          sql: 'SELECT id FROM exp_rt WHERE id = 2',
          database: server.schema,
        }),
      ).toEqual([['2']]);
      await expect(rows({ kind: 'query', sql: 'DELETE FROM exp_rt' })).rejects.toMatchObject({
        code: 'EXPORT_NOT_READ',
      });
      expect(await rows()).toHaveLength(2);
    });

    it('round-trips: SQL export with CREATE TABLE, drop, import, same rows', async () => {
      const before = await rows();
      const file = path.join(dir, 'exp_rt.sql');
      const request: ExportRequest = {
        source: {
          kind: 'database',
          database: server.schema,
          tables: ['exp_rt'],
          structure: true,
          data: true,
        },
        format: 'sql',
        file,
        sql: { rowsPerInsert: 100 },
      };
      const exported = await exportData(session, server.type, request, 'e', () => {}, signal);
      expect(exported).toMatchObject({ phase: 'done', statements: 2 });
      await exec(['DROP TABLE exp_rt']);
      const imported = await importSql(
        session,
        server.type,
        false,
        { file, database: server.schema, onError: 'stop' },
        'i',
        () => {},
        signal,
      );
      expect(imported.errors).toEqual([]);
      expect(imported.phase).toBe('done');
      expect(await rows()).toEqual(before);
    });

    it('writes CSV and Excel files', async () => {
      const csv = await exportData(
        session,
        server.type,
        {
          source: { kind: 'table', database: server.schema, table: 'exp_rt', orderBy: [] },
          format: 'csv',
          file: path.join(dir, 'x.csv'),
        },
        'c',
        () => {},
        signal,
      );
      expect(csv.statements).toBe(2);
      expect((await fs.readFile(path.join(dir, 'x.csv'), 'utf8')).split('\r\n')[0]).toBe(
        'id,d,t,b,s,n',
      );
      const xlsx = await exportData(
        session,
        server.type,
        {
          source: { kind: 'table', database: server.schema, table: 'exp_rt', orderBy: [] },
          format: 'xlsx',
          file: path.join(dir, 'x.xlsx'),
        },
        'x',
        () => {},
        signal,
      );
      expect(xlsx.phase).toBe('done');
    });
  });
}
