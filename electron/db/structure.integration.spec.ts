/**
 * Structure changes on real servers (MYSQL_TEST_HOST, PG_TEST_HOST, MSSQL_TEST_HOST) and SQLite:
 * create a table, add, change and drop a column, create, list and drop an index.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addColumnSql,
  alterColumnSql,
  columnDefOf,
  createIndexSql,
  createTableSql,
  dropColumnSql,
  dropIndexSql,
  type ColumnDef,
} from '../../shared/ddl';
import { qualifiedName } from '../../shared/dialect';
import type { DbType } from '../../shared/models';
import type { ConnectionConfig, DbSession } from './driver';
import { getDriver } from './driver-registry';
import { applyDdl, listIndexes } from './structure';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sqliteFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-ddl-')), 'ddl.db');
writeFileSync(sqliteFile, '');

const servers: {
  type: DbType;
  enabled: boolean;
  config: Partial<ConnectionConfig>;
  schema: string;
  text: string;
  int: string;
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
    schema: 'app_dev',
    text: 'varchar(50)',
    int: 'int',
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
    schema: 'public',
    text: 'varchar(50)',
    int: 'integer',
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
    schema: 'dbo',
    text: 'nvarchar(50)',
    int: 'int',
  },
  {
    type: 'sqlite',
    enabled: true,
    config: { host: '', database: sqliteFile, user: '' },
    schema: 'main',
    text: 'TEXT',
    int: 'INTEGER',
  },
];

const col = (over: Partial<ColumnDef> & { name: string; type: string }): ColumnDef => ({
  nullable: true,
  defaultValue: '',
  autoIncrement: false,
  comment: '',
  ...over,
});

for (const server of servers) {
  describe.skipIf(!server.enabled)(`structure on ${server.type}`, () => {
    let session: DbSession;
    const T = 'ddl_test';
    const run = (statements: string[]) => applyDdl(session, false, server.schema, statements);
    const columns = async () => {
      const cols = await session.listColumns(server.schema, T);
      return Object.fromEntries(cols.map((c) => [c.name, c]));
    };

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
      await run([`DROP TABLE IF EXISTS ${qualifiedName(server.schema, T, server.type)}`]);
    });
    afterAll(async () => {
      await run([`DROP TABLE IF EXISTS ${qualifiedName(server.schema, T, server.type)}`]).catch(
        () => undefined,
      );
      await session.close();
    });

    it('creates a table with an auto-increment key', async () => {
      await run(
        createTableSql(server.type, server.schema, T, [
          {
            ...col({ name: 'id', type: server.int, nullable: false, autoIncrement: true }),
            primary: true,
          },
          {
            ...col({ name: 'naam', type: server.text, nullable: false, defaultValue: "''" }),
            primary: false,
          },
        ]),
      );
      const c = await columns();
      expect(Object.keys(c)).toEqual(['id', 'naam']);
      expect(c['id']!.key).toBe('primary');
      expect(c['naam']!.nullable).toBe(false);
      // The key fills itself.
      await run([
        `INSERT INTO ${qualifiedName(server.schema, T, server.type)} (naam) VALUES ('a')`,
      ]);
    });

    it('adds a column with a default, and drops it again', async () => {
      await run(
        addColumnSql(
          server.type,
          server.schema,
          T,
          col({ name: 'stad', type: server.text, defaultValue: "'Delft'" }),
        ),
      );
      expect((await columns())['stad']?.defaultValue).toMatch(/Delft/);
      await run(dropColumnSql(server.type, server.schema, T, 'stad'));
      expect((await columns())['stad']).toBeUndefined();
    });

    it.runIf(server.type !== 'sqlite')(
      'changes name, type, NULL and default of a column',
      async () => {
        await run(
          addColumnSql(
            server.type,
            server.schema,
            T,
            col({ name: 'aantal', type: server.int, defaultValue: '1' }),
          ),
        );
        const before = columnDefOf((await columns())['aantal']!, server.type);
        await run(
          alterColumnSql(server.type, server.schema, T, before, {
            ...before,
            name: 'stuks',
            type: 'bigint',
            nullable: false,
            defaultValue: '5',
          }),
        );
        const c = (await columns())['stuks']!;
        expect(c.type).toMatch(/bigint/i);
        expect(c.nullable).toBe(false);
        expect(c.defaultValue).toMatch(/5/);
        expect((await columns())['aantal']).toBeUndefined();
        await run(dropColumnSql(server.type, server.schema, T, 'stuks'));
      },
    );

    it.runIf(server.type === 'sqlite')('renames a column, and refuses other changes', async () => {
      await run(addColumnSql(server.type, server.schema, T, col({ name: 'oud', type: 'TEXT' })));
      const before = columnDefOf((await columns())['oud']!, server.type);
      await run(
        alterColumnSql(server.type, server.schema, T, before, { ...before, name: 'nieuw' }),
      );
      expect((await columns())['nieuw']).toBeDefined();
      expect(() =>
        alterColumnSql(server.type, server.schema, T, before, { ...before, type: 'INTEGER' }),
      ).toThrow(/alleen de naam/);
    });

    it('creates, lists and drops an index', async () => {
      await run(
        createIndexSql(server.type, server.schema, T, {
          name: 'uq_ddl_naam',
          columns: ['naam'],
          unique: true,
        }),
      );
      const indexes = await listIndexes(session, server.type, server.schema, T);
      expect(indexes.find((i) => i.primary)?.columns).toEqual(['id']);
      expect(indexes.find((i) => i.name === 'uq_ddl_naam')).toMatchObject({
        columns: ['naam'],
        unique: true,
        primary: false,
      });
      await run(dropIndexSql(server.type, server.schema, T, 'uq_ddl_naam'));
      expect(
        (await listIndexes(session, server.type, server.schema, T)).some(
          (i) => i.name === 'uq_ddl_naam',
        ),
      ).toBe(false);
    });

    it('stops at the first error and says how far it got; refuses when read-only', async () => {
      await expect(
        run([
          ...addColumnSql(server.type, server.schema, T, col({ name: 'x1', type: server.int })),
          `ALTER TABLE ${qualifiedName(server.schema, T, server.type)} DROP COLUMN bestaat_niet`,
        ]),
      ).rejects.toMatchObject({ hint: expect.stringContaining('1 van de 2') });
      await expect(applyDdl(session, true, server.schema, ['SELECT 1'])).rejects.toThrow(
        /alleen-lezen/,
      );
    });
  });
}
