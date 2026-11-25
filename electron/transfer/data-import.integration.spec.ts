/**
 * CSV, JSON and Excel import against real servers (MYSQL_TEST_HOST, PG_TEST_HOST, MSSQL_TEST_HOST)
 * and SQLite: append, replace and upsert, both error modes, stopping, and a file from a 7z.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataImportRequest, DbType, TransferProgress } from '../../shared/models';
import type { ConnectionConfig, DbSession } from '../db/driver';
import { getDriver } from '../db/driver-registry';
import { sevenZip } from './archive';
import { importData } from './data-import';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const base = {
  ssl: false,
  allowSelfSigned: false,
  readOnly: false,
  database: 'app_dev',
  user: 'viewer',
};
const sqliteDir = mkdtempSync(path.join(os.tmpdir(), 'dbv-dimp-sqlite-'));
writeFileSync(path.join(sqliteDir, 'dimp.db'), '');

const servers: {
  type: DbType;
  enabled: boolean;
  config: Partial<ConnectionConfig>;
  schema: string;
  create: string;
}[] = [
  {
    type: 'mysql',
    enabled: Boolean(process.env['MYSQL_TEST_HOST']),
    config: {
      host: process.env['MYSQL_TEST_HOST'],
      port: Number(process.env['MYSQL_TEST_PORT'] ?? 3306),
      password: 'test123',
    },
    schema: 'app_dev',
    create: `CREATE TABLE dimp (id int PRIMARY KEY, naam varchar(50) NOT NULL, bedrag decimal(10,2), datum date, actief tinyint(1), notitie text)`,
  },
  {
    type: 'postgres',
    enabled: Boolean(process.env['PG_TEST_HOST']),
    config: {
      host: process.env['PG_TEST_HOST'],
      port: Number(process.env['PG_TEST_PORT'] ?? 5432),
      password: 'test123',
    },
    schema: 'public',
    create: `CREATE TABLE dimp (id int PRIMARY KEY, naam varchar(50) NOT NULL, bedrag numeric(10,2), datum date, actief boolean, notitie text)`,
  },
  {
    type: 'mssql',
    enabled: Boolean(process.env['MSSQL_TEST_HOST']),
    config: {
      host: process.env['MSSQL_TEST_HOST'],
      port: Number(process.env['MSSQL_TEST_PORT'] ?? 1433),
      password: 'Test123!viewer',
    },
    schema: 'dbo',
    // An identity key: explicit ids need IDENTITY_INSERT, which the import turns on.
    create: `CREATE TABLE dimp (id int IDENTITY PRIMARY KEY, naam nvarchar(50) NOT NULL, bedrag decimal(10,2), datum date, actief bit, notitie nvarchar(max))`,
  },
  {
    type: 'sqlite',
    enabled: true,
    config: { host: '', database: path.join(sqliteDir, 'dimp.db'), user: '' },
    schema: 'main',
    create: `CREATE TABLE dimp (id integer PRIMARY KEY, naam varchar(50) NOT NULL, bedrag numeric, datum date, actief integer, notitie text)`,
  },
];

const fixture = path.join(__dirname, 'fixtures', 'sample.xlsx');

for (const server of servers) {
  describe.skipIf(!server.enabled)(`data import into ${server.type}`, () => {
    let session: DbSession;
    let dir: string;

    const exec = async (sql: string) => {
      const r = await session.runScript('setup', {
        statements: [sql],
        maxRows: 1000,
        database: server.schema,
      });
      await session.closeEditor('setup');
      const first = r.results[0];
      if (first?.kind === 'error') throw new Error(first.error.message);
      return first?.kind === 'rows' ? first.rows : [];
    };
    const rows = () =>
      exec(
        `SELECT id, naam, bedrag, ${server.type === 'mssql' ? 'CONVERT(varchar(10), datum, 23)' : 'datum'}, actief, notitie FROM dimp ORDER BY id`,
      );
    const run = (
      request: Partial<DataImportRequest> & { file: string },
      signal?: AbortSignal,
      report: (p: TransferProgress) => void = () => {},
    ) =>
      importData(
        session,
        server.type,
        false,
        {
          database: server.schema,
          table: 'dimp',
          mapping: [],
          mode: 'append',
          onError: 'rollback',
          emptyAsNull: false,
          ...request,
        },
        'job',
        report,
        signal ?? new AbortController().signal,
      );

    beforeAll(async () => {
      session = await getDriver(server.type).open({
        ...base,
        type: server.type,
        port: 0,
        password: '',
        ...server.config,
      } as ConnectionConfig);
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-dimp-it-'));
    });
    beforeEach(async () => {
      await exec('DROP TABLE IF EXISTS dimp');
      await exec(server.create);
    });
    afterAll(async () => {
      await exec('DROP TABLE IF EXISTS dimp');
      await session.close();
    });

    const csvMapping = [
      { source: 0, target: 'id' },
      { source: 1, target: 'naam' },
      { source: 2, target: 'bedrag' },
      { source: 3, target: 'datum' },
      { source: 4, target: 'notitie' },
    ];

    it('appends a Windows-1252 CSV with ; and quoted line breaks', async () => {
      const file = path.join(dir, 'klanten.csv');
      const text =
        'nummer;naam;bedrag;datum;notitie\r\n' +
        '1;Café;12.50;2024-01-31;"twee\r\nregels"\r\n' +
        '2;"Zeg ""hoi""";;;\r\n' +
        "3;it's;-1;2023-12-01;\r\n";
      await fs.writeFile(file, Buffer.from(text, 'latin1'));
      const result = await run({ file, mapping: csvMapping });
      expect(result.errors).toEqual([]);
      expect(result).toMatchObject({ phase: 'done', statements: 3, unit: 'rows' });
      const got = await rows();
      expect(got.map((r) => [r[0], r[1], r[5]])).toEqual([
        ['1', 'Café', 'twee\r\nregels'],
        ['2', 'Zeg "hoi"', ''],
        ['3', "it's", ''],
      ]);
      // Empty number and date fields became NULL; empty text stays empty unless asked.
      expect(got[1]![2]).toBeNull();
      expect(got[1]![3]).toBeNull();
      expect(Number(got[0]![2])).toBe(12.5);
      expect(String(got[0]![3])).toMatch(/^2024-01-31/);
    });

    it('updates rows with the same key and adds the others (upsert from JSON)', async () => {
      await exec(
        `${server.type === 'mssql' ? 'SET IDENTITY_INSERT dimp ON; ' : ''}INSERT INTO dimp (id, naam, bedrag) VALUES (1, 'oud', 1), (2, 'blijft', 2)`,
      );
      const file = path.join(dir, 'rijen.json');
      await fs.writeFile(
        file,
        JSON.stringify([
          { id: 1, naam: 'nieuw', bedrag: 10.25, actief: true, extra: { a: 1 } },
          { id: 3, naam: 'toegevoegd', bedrag: null, actief: false },
        ]),
      );
      const result = await run({
        file,
        mode: 'upsert',
        mapping: [
          { source: 0, target: 'id' },
          { source: 1, target: 'naam' },
          { source: 2, target: 'bedrag' },
          { source: 3, target: 'actief' },
          { source: 4, target: 'notitie' },
        ],
      });
      expect(result.errors).toEqual([]);
      expect(result.phase).toBe('done');
      const got = await rows();
      expect(got.map((r) => [r[0], r[1]])).toEqual([
        ['1', 'nieuw'],
        ['2', 'blijft'],
        ['3', 'toegevoegd'],
      ]);
      expect(Number(got[0]![2])).toBe(10.25);
      expect(['1', 'true', 't']).toContain(String(got[0]![4]));
      expect(['0', 'false', 'f']).toContain(String(got[2]![4]));
      expect(got[0]![5]).toBe('{"a":1}');
    });

    const xlsxMapping = [
      { source: 0, target: 'id' },
      { source: 1, target: 'naam' },
      { source: 4, target: 'bedrag' },
      { source: 2, target: 'datum' },
      { source: 5, target: 'actief' },
    ];

    it('rolls everything back at the first bad row (Excel, replace)', async () => {
      await exec(
        `${server.type === 'mssql' ? 'SET IDENTITY_INSERT dimp ON; ' : ''}INSERT INTO dimp (id, naam) VALUES (99, 'was er al')`,
      );
      const result = await run({ file: fixture, mode: 'replace', mapping: xlsxMapping });
      // Row 4 of the sheet has no name: NOT NULL.
      expect(result).toMatchObject({ phase: 'stopped-at-error', rolledBack: true, failed: 1 });
      expect(result.errors[0]).toMatchObject({ statement: 4 });
      expect(await rows()).toEqual([['99', 'was er al', null, null, null, null]]);
    });

    it('skips bad rows and keeps the rest', async () => {
      const result = await run({ file: fixture, mapping: xlsxMapping, onError: 'skip' });
      expect(result).toMatchObject({ phase: 'done-with-errors', statements: 3, failed: 2 });
      expect(result.errors.map((e) => e.statement)).toEqual([4, 5]);
      const got = await rows();
      expect(got.map((r) => [r[0], r[1], String(r[3]).slice(0, 10)])).toEqual([
        ['1', 'Anna & Bob', '1990-05-17'],
        ['2', 'Één "quote"', '2000-01-01'],
        ['3', 'Vet en gewoon', 'null'],
      ]);
      expect(Number(got[1]![2])).toBe(0.3);
    });

    it('reads a CSV from a password-protected 7z', async () => {
      await fs.writeFile(path.join(dir, 'in.csv'), 'id,naam\n7,zeven\n8,acht\n');
      execFileSync(sevenZip(), ['a', '-bd', '-y', '-pgeheim', '-mhe=on', 'in.7z', 'in.csv'], {
        cwd: dir,
        stdio: 'ignore',
      });
      const result = await run({
        file: path.join(dir, 'in.7z'),
        entry: 'in.csv',
        password: 'geheim',
        mapping: [
          { source: 0, target: 'id' },
          { source: 1, target: 'naam' },
        ],
      });
      expect(result).toMatchObject({ phase: 'done', statements: 2 });
      expect((await rows()).map((r) => r[1])).toEqual(['zeven', 'acht']);
    });

    it('undoes everything when stopped in one transaction', async () => {
      const file = path.join(dir, 'groot.csv');
      const lines = ['id,naam'];
      for (let i = 1; i <= 100_000; i++) lines.push(`${i},rij ${i}`);
      await fs.writeFile(file, lines.join('\n'));
      const controller = new AbortController();
      const running = run(
        {
          file,
          mapping: [
            { source: 0, target: 'id' },
            { source: 1, target: 'naam' },
          ],
        },
        controller.signal,
        // Stop as soon as the first rows are in (SQLite is done with all of them in no time).
        (p) => p.statements > 0 && controller.abort(),
      );
      const result = await running;
      expect(result).toMatchObject({ phase: 'cancelled', rolledBack: true });
      expect(await rows()).toEqual([]);
    });
  });
}

afterAll(() => fs.rm(sqliteDir, { recursive: true, force: true }));
