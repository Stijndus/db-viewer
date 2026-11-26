/**
 * Column filters run on real servers: every operator, with characters that mean something in LIKE
 * (%, _, \, [) and quotes, against text, numbers, dates and NULL.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { combinedWhere, type ColumnFilter } from '../../shared/column-filter';
import { qualifiedName } from '../../shared/dialect';
import type { DbType } from '../../shared/models';
import type { ConnectionConfig, DbSession } from './driver';
import { getDriver } from './driver-registry';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sqliteFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-cf-')), 'cf.db');
writeFileSync(sqliteFile, '');

const servers: {
  type: DbType;
  enabled: boolean;
  config: Partial<ConnectionConfig>;
  schema: string;
}[] = [
  {
    type: 'mysql',
    enabled: Boolean(process.env['MYSQL_TEST_HOST']),
    config: {
      host: process.env['MYSQL_TEST_HOST'],
      port: Number(process.env['MYSQL_TEST_PORT'] ?? 3306),
      user: 'viewer',
      password: 'test123',
      database: 'app_dev',
    },
    schema: 'app_dev',
  },
  {
    type: 'postgres',
    enabled: Boolean(process.env['PG_TEST_HOST']),
    config: {
      host: process.env['PG_TEST_HOST'],
      port: Number(process.env['PG_TEST_PORT'] ?? 5432),
      user: 'viewer',
      password: 'test123',
      database: 'app_dev',
    },
    schema: 'public',
  },
  {
    type: 'mssql',
    enabled: Boolean(process.env['MSSQL_TEST_HOST']),
    config: {
      host: process.env['MSSQL_TEST_HOST'],
      port: Number(process.env['MSSQL_TEST_PORT'] ?? 1433),
      user: 'viewer',
      password: 'Test123!viewer',
      database: 'app_dev',
    },
    schema: 'dbo',
  },
  {
    type: 'sqlite',
    enabled: true,
    config: { host: '', database: sqliteFile, user: '' },
    schema: 'main',
  },
];

const ROWS: [number, string | null, number | null, string | null][] = [
  [1, 'Anna', 10, '2024-01-05'],
  [2, '100% zeker', 20, '2024-02-10'],
  [3, 'a_b', 30, null],
  [4, 'C:\\pad', null, '2024-03-15'],
  [5, "it's [x]", 40, '2024-04-20'],
  [6, '', 50, '2024-05-25'],
  [7, null, 60, '2024-06-30'],
];

for (const server of servers) {
  describe.skipIf(!server.enabled)(`column filters on ${server.type}`, () => {
    let session: DbSession;
    const table = () => qualifiedName(server.schema, 'cf_test', server.type);
    const exec = async (sql: string) => {
      const r = await session.runScript('cf', { statements: [sql], maxRows: 100 });
      const first = r.results[0];
      if (first?.kind === 'error') throw new Error(`${first.error.message}\n${sql}`);
      return first?.kind === 'rows' ? first.rows : [];
    };
    const ids = async (...filters: ColumnFilter[]) => {
      const where = combinedWhere('', filters, server.type);
      const rows = await exec(`SELECT id FROM ${table()} WHERE ${where} ORDER BY id`);
      return rows.map((r) => Number(r[0]));
    };

    beforeAll(async () => {
      session = await getDriver(server.type).open({
        type: server.type,
        port: 0,
        password: '',
        ssl: false,
        allowSelfSigned: false,
        readOnly: false,
        ...server.config,
      } as ConnectionConfig);
      const text = server.type === 'mssql' ? 'nvarchar(50)' : 'varchar(50)';
      await exec(`DROP TABLE IF EXISTS ${table()}`);
      await exec(
        `CREATE TABLE ${table()} (id int PRIMARY KEY, naam ${text}, bedrag int, datum date)`,
      );
      const lit = (v: string | number | null) =>
        v === null
          ? 'NULL'
          : typeof v === 'number'
            ? String(v)
            : `${server.type === 'mssql' ? 'N' : ''}'${v.replace(/'/g, "''")}'`;
      const values = ROWS.map((r) => `(${r.map(lit).join(', ')})`).join(', ');
      // MySQL reads a backslash in quotes as an escape: double it there.
      const sql = `INSERT INTO ${table()} VALUES ${values}`;
      await exec(server.type === 'mysql' ? sql.replace(/\\/g, '\\\\') : sql);
    });
    afterAll(async () => {
      await exec(`DROP TABLE IF EXISTS ${table()}`).catch(() => undefined);
      await session.closeEditor('cf').catch(() => undefined);
      await session.close();
    });

    it('contains, ignoring case, with LIKE characters taken literally', async () => {
      expect(await ids({ column: 'naam', op: 'contains', value: 'ANN' })).toEqual([1]);
      expect(await ids({ column: 'naam', op: 'contains', value: '%' })).toEqual([2]);
      expect(await ids({ column: 'naam', op: 'contains', value: '_' })).toEqual([3]);
      expect(await ids({ column: 'naam', op: 'contains', value: '\\' })).toEqual([4]);
      expect(await ids({ column: 'naam', op: 'contains', value: "'s [x" })).toEqual([5]);
      expect(await ids({ column: 'naam', op: 'notContains', value: 'a' })).toEqual([2, 5, 6]);
    });

    it('starts with, ends with, equals', async () => {
      expect(await ids({ column: 'naam', op: 'startsWith', value: 'a' })).toEqual([1, 3]);
      expect(await ids({ column: 'naam', op: 'endsWith', value: 'zeker' })).toEqual([2]);
      expect(await ids({ column: 'naam', op: 'equals', value: 'a_b' })).toEqual([3]);
      expect(await ids({ column: 'bedrag', op: 'notEquals', value: '10' })).toEqual([
        2, 3, 4, 5, 6, 7,
      ]);
    });

    it('numbers and dates: greater, less, between, and contains on a number', async () => {
      expect(await ids({ column: 'bedrag', op: 'greater', value: '35' })).toEqual([5, 6, 7]);
      expect(await ids({ column: 'bedrag', op: 'less', value: '20' })).toEqual([1]);
      expect(
        await ids({ column: 'datum', op: 'between', value: '2024-02-01', value2: '2024-04-30' }),
      ).toEqual([2, 4, 5]);
      expect(await ids({ column: 'bedrag', op: 'contains', value: '0' })).toEqual([
        1, 2, 3, 5, 6, 7,
      ]);
    });

    it('NULL and empty, and several filters together with the WHERE field', async () => {
      expect(await ids({ column: 'naam', op: 'isNull' })).toEqual([7]);
      expect(
        await ids({ column: 'datum', op: 'notNull' }, { column: 'bedrag', op: 'notNull' }),
      ).toEqual([1, 2, 5, 6, 7]);
      expect(await ids({ column: 'naam', op: 'isEmpty' })).toEqual([6, 7]);
      const where = combinedWhere(
        'id > 1 OR id = 1',
        [{ column: 'bedrag', op: 'less', value: '30' }],
        server.type,
      );
      const rows = await exec(`SELECT id FROM ${table()} WHERE ${where} ORDER BY id`);
      expect(rows.map((r) => Number(r[0]))).toEqual([1, 2]);
    });
  });
}
