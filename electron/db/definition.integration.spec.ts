/**
 * A table's full definition on real servers: CREATE TABLE, an index and a foreign key that are
 * not in it (PostgreSQL, SQL Server), and a trigger.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { qualifiedName } from '../../shared/dialect';
import type { DbType } from '../../shared/models';
import { tableDefinition } from './definition';
import type { ConnectionConfig, DbSession } from './driver';
import { getDriver } from './driver-registry';
import { applyDdl } from './structure';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sqliteFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-def-')), 'def.db');
writeFileSync(sqliteFile, '');

const servers: {
  type: DbType;
  enabled: boolean;
  config: Partial<ConnectionConfig>;
  schema: string;
  setup: (p: string, c: string) => string[];
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
    setup: (p, c) => [
      `CREATE TABLE ${p} (id int PRIMARY KEY)`,
      `CREATE TABLE ${c} (id int PRIMARY KEY, p_id int, naam varchar(20), KEY idx_def_naam (naam), CONSTRAINT fk_def FOREIGN KEY (p_id) REFERENCES ${p} (id))`,
      `CREATE TRIGGER trg_def BEFORE INSERT ON ${c} FOR EACH ROW SET NEW.naam = UPPER(NEW.naam)`,
    ],
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
    setup: (p, c) => [
      `CREATE TABLE ${p} (id int PRIMARY KEY)`,
      `CREATE TABLE ${c} (id int PRIMARY KEY, p_id int, naam varchar(20), CONSTRAINT fk_def FOREIGN KEY (p_id) REFERENCES ${p} (id))`,
      `CREATE INDEX idx_def_naam ON ${c} (naam)`,
      `CREATE OR REPLACE FUNCTION def_upper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.naam := upper(NEW.naam); RETURN NEW; END $$`,
      `CREATE TRIGGER trg_def BEFORE INSERT ON ${c} FOR EACH ROW EXECUTE FUNCTION def_upper()`,
    ],
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
    setup: (p, c) => [
      `CREATE TABLE ${p} (id int PRIMARY KEY)`,
      `CREATE TABLE ${c} (id int PRIMARY KEY, p_id int, naam nvarchar(20), CONSTRAINT fk_def FOREIGN KEY (p_id) REFERENCES ${p} (id))`,
      `CREATE INDEX idx_def_naam ON ${c} (naam)`,
      `CREATE TRIGGER trg_def ON ${c} AFTER INSERT AS BEGIN SET NOCOUNT ON; END`,
    ],
  },
  {
    type: 'sqlite',
    enabled: true,
    config: { host: '', database: sqliteFile, user: '' },
    schema: 'main',
    setup: (p, c) => [
      `CREATE TABLE ${p} (id INTEGER PRIMARY KEY)`,
      `CREATE TABLE ${c} (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES def_parent (id), naam TEXT)`,
      `CREATE INDEX ${qualifiedName('main', 'idx_def_naam', 'sqlite')} ON def_child (naam)`,
      `CREATE TRIGGER trg_def AFTER INSERT ON def_child BEGIN UPDATE def_child SET naam = upper(naam) WHERE id = NEW.id; END`,
    ],
  },
];

for (const server of servers) {
  describe.skipIf(!server.enabled)(`table definition on ${server.type}`, () => {
    let session: DbSession;
    const p = () => qualifiedName(server.schema, 'def_parent', server.type);
    const c = () => qualifiedName(server.schema, 'def_child', server.type);
    const drop = () =>
      applyDdl(session, false, server.schema, [`DROP TABLE IF EXISTS ${c()}`]).then(() =>
        applyDdl(session, false, server.schema, [`DROP TABLE IF EXISTS ${p()}`]),
      );

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
      await drop();
      for (const sql of server.setup(p(), c()))
        await applyDdl(session, false, server.schema, [sql]);
    });
    afterAll(async () => {
      await drop().catch(() => undefined);
      await session.close();
    });

    it('holds the CREATE TABLE, the index, the foreign key and the trigger', async () => {
      const def = await tableDefinition(session, server.type, server.schema, 'def_child');
      const all = [def.create, ...def.extras].join('\n');
      expect(def.create).toMatch(/CREATE TABLE/i);
      expect(all).toMatch(/idx_def_naam/);
      if (server.type !== 'sqlite') expect(all).toMatch(/fk_def/);
      expect(all).toMatch(/def_parent/);
      expect(def.triggers.map((t) => t.name)).toEqual(['trg_def']);
      expect(def.triggers[0]!.sql).toMatch(/CREATE TRIGGER/i);
    });
  });
}
