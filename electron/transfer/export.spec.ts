import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExportRequest, TransferProgress } from '../../shared/models';
import type { DbSession, RowBatch, RowSource } from '../db/driver';
import { extractEntry, listArchive } from './archive';
import { csvField, exportData, keyWhere, markdownCell, sqlLiteral } from './export';

const COLUMNS = ['id', 'naam', 'bedrag', 'leeg', 'bin'];
const ROWS: unknown[][] = [
  [1, 'gewoon', '12.50', null, Buffer.from([0xde, 0xad])],
  [2, 'met, komma en "quote"', '99999999999999999.99', '', null],
  [3, 'regel\neen', '-0.5', ' spatie ', new Uint8Array([1])],
];

function fakeSession(batches = [ROWS.slice(0, 2), ROWS.slice(2)]) {
  const sources: RowSource[] = [];
  const session = {
    async streamRows(source: RowSource, onBatch: (b: RowBatch) => Promise<void>) {
      sources.push(source);
      for (const rows of batches) await onBatch({ columns: COLUMNS, rows });
    },
    async tableDdl(_db: string, table: string) {
      return `CREATE TABLE \`app\`.\`${table}\` (id int)`;
    },
    async listColumns() {
      return [];
    },
  } as unknown as DbSession;
  return { session, sources };
}

let dir: string;
/** The Excel check reads the file with Python's openpyxl (CI installs it). */
const hasOpenpyxl = (() => {
  try {
    execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
async function run(
  request: Omit<ExportRequest, 'file'> & { file?: string },
  dialect: 'mysql' | 'postgres' | 'mssql' = 'mysql',
) {
  const file = request.file ?? path.join(dir, 'out');
  const reports: TransferProgress[] = [];
  const result = await exportData(
    fakeSession().session,
    dialect,
    { ...request, file } as ExportRequest,
    'job',
    (p) => reports.push(p),
    new AbortController().signal,
  );
  return { result, file, reports };
}
const table = { kind: 'table' as const, database: 'app', table: 'klanten', orderBy: [] };

describe('export', () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-export-'));
  });

  it('writes CSV per RFC 4180: NULL empty, empty string quoted, binary as hex', async () => {
    const { result, file } = await run({
      source: table,
      format: 'csv',
      csv: { delimiter: ';', header: true, bom: true },
    });
    expect(result).toMatchObject({ phase: 'done', statements: 3 });
    expect(await fs.readFile(file, 'utf8')).toBe(
      '﻿id;naam;bedrag;leeg;bin\r\n' +
        '1;gewoon;12.50;;0xdead\r\n' +
        '2;met, komma en ""quote"";99999999999999999.99;"";\r\n'.replace(
          'met, komma en ""quote""',
          '"met, komma en ""quote"""',
        ) +
        '3;"regel\neen";-0.5;" spatie ";0x01\r\n',
    );
    expect(csvField('a,b', ',')).toBe('"a,b"');
  });

  it('writes JSON as an array or as lines, keeping exact decimals as strings', async () => {
    const { file } = await run({ source: table, format: 'json', json: { style: 'array' } });
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(parsed[1]).toEqual({
      id: 2,
      naam: 'met, komma en "quote"',
      bedrag: '99999999999999999.99',
      leeg: '',
      bin: null,
    });
    expect(parsed[0].bin).toBe('0xdead');
    const lines = await run({
      source: table,
      format: 'json',
      json: { style: 'lines' },
      file: path.join(dir, 'l.jsonl'),
    });
    expect((await fs.readFile(lines.file, 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('writes SQL INSERTs per dialect, with CREATE TABLE when asked', async () => {
    const { file } = await run({
      source: table,
      format: 'sql',
      sql: { rowsPerInsert: 2, createTable: true, dropTable: true },
    });
    const sql = await fs.readFile(file, 'utf8');
    expect(sql).toContain('DROP TABLE IF EXISTS `klanten`;');
    expect(sql).toContain('CREATE TABLE `klanten` (id int);');
    expect(sql).toContain(
      "INSERT INTO `klanten` (`id`, `naam`, `bedrag`, `leeg`, `bin`) VALUES\n(1, 'gewoon', '12.50', NULL, X'dead'),\n(2, 'met, komma en \"quote\"', '99999999999999999.99', '', NULL);",
    );
    expect(sql).toContain("(3, 'regel\neen', '-0.5', ' spatie ', X'01');");
    expect(sql).toContain('SET FOREIGN_KEY_CHECKS = 0;');

    const mssql = await run(
      {
        source: table,
        format: 'sql',
        sql: { rowsPerInsert: 5000 },
        file: path.join(dir, 'ms.sql'),
      },
      'mssql',
    );
    const ms = await fs.readFile(mssql.file, 'utf8');
    expect(ms).toContain(
      "INSERT INTO [klanten] ([id], [naam], [bedrag], [leeg], [bin]) VALUES\n(1, N'gewoon', N'12.50', NULL, 0xdead)",
    );
    expect(ms).toMatch(/\)\nGO\n/);
    expect(sqlLiteral(Buffer.from([1, 2]), 'postgres')).toBe("'\\x0102'");
    expect(sqlLiteral("it's", 'mysql')).toBe("'it''s'");
  });

  it('writes a database as one script: structure and data per table', async () => {
    const { file, result } = await run({
      source: {
        kind: 'database',
        database: 'app',
        tables: ['a', 'b'],
        structure: true,
        data: false,
      },
      format: 'sql',
    });
    const sql = await fs.readFile(file, 'utf8');
    expect(sql).toContain('CREATE TABLE `a` (id int);');
    expect(sql).toContain('CREATE TABLE `b` (id int);');
    expect(sql).not.toContain('INSERT');
    expect(result.statements).toBe(0);
    await expect(
      run({
        source: { kind: 'database', database: 'app', tables: ['a'], structure: true, data: true },
        format: 'csv',
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_FORMAT' });
  });

  it.skipIf(!hasOpenpyxl)('writes an Excel file that Excel-compatible readers open', async () => {
    const { file } = await run({
      source: table,
      format: 'xlsx',
      file: path.join(dir, 'klanten.xlsx'),
    });
    const out = execFileSync('python3', [
      '-c',
      'import sys, openpyxl; ws = openpyxl.load_workbook(sys.argv[1]).active; print(ws.title); [print(repr([c.value for c in r])) for r in ws.iter_rows()]',
      file,
    ]).toString();
    expect(out).toContain('klanten');
    expect(out).toContain("['id', 'naam', 'bedrag', 'leeg', 'bin']");
    expect(out).toContain("[1, 'gewoon', 12.5, None, '0xdead']");
    // 20 digits don't fit a double: kept as text.
    expect(out).toContain("[2, 'met, komma en \"quote\"', '99999999999999999.99', '', None]");
  });

  it('packs into .gz, .zip and an encrypted .7z', async () => {
    const gz = await run({
      source: table,
      format: 'csv',
      archive: { kind: 'gzip' },
      file: path.join(dir, 'k.csv.gz'),
    });
    expect(gunzipSync(await fs.readFile(gz.file)).toString()).toContain('1,gewoon,12.50');

    for (const kind of ['7z', 'zip'] as const) {
      const file = path.join(dir, `k.${kind}`);
      await run({ source: table, format: 'sql', archive: { kind, password: 'geheim' }, file });
      const listing = await listArchive(file, 'geheim');
      expect(listing).toMatchObject({ encrypted: true, entries: [{ path: `k.sql` }] });
      const x = extractEntry(file, 'k.sql', 'geheim');
      const [content] = await Promise.all([text(x.stream), x.done]);
      expect(content).toContain('INSERT INTO `klanten`');
    }
    // The 7z hides the file names too; the temporary zip folder is gone.
    await expect(listArchive(path.join(dir, 'k.7z'))).rejects.toMatchObject({
      code: 'ARCHIVE_PASSWORD_REQUIRED',
    });
  });

  it('removes a half-written file when stopped', async () => {
    const controller = new AbortController();
    const session = {
      async streamRows(_s: RowSource, onBatch: (b: RowBatch) => Promise<void>) {
        await onBatch({ columns: COLUMNS, rows: ROWS });
        controller.abort();
      },
    } as unknown as DbSession;
    const file = path.join(dir, 'half.csv');
    const result = await exportData(
      session,
      'mysql',
      { source: table, format: 'csv', file },
      'j',
      () => {},
      controller.signal,
    );
    expect(result.phase).toBe('cancelled');
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('writes a Markdown table, escaping pipes and line breaks', async () => {
    const { file } = await run({ source: table, format: 'markdown' });
    const md = await fs.readFile(file, 'utf8');
    expect(md.split('\n').slice(0, 3)).toEqual([
      '| id | naam | bedrag | leeg | bin |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | gewoon | 12.50 | *NULL* | 0xdead |',
    ]);
    expect(md).toContain('| 3 | regel<br>een |');
    expect(markdownCell('a|b\\c')).toBe('a\\|b\\\\c');
  });

  describe('to the clipboard', () => {
    async function copy(request: Omit<ExportRequest, 'file'>, batches?: unknown[][][]) {
      let clipboard: string | null = null;
      const result = await exportData(
        fakeSession(batches).session,
        'mysql',
        { ...request, file: '', destination: 'clipboard' },
        'job',
        () => {},
        new AbortController().signal,
        (text) => (clipboard = text),
      );
      return { result, clipboard: clipboard as string | null };
    }

    it('puts tab-separated rows on the clipboard, no file', async () => {
      const { result, clipboard } = await copy({
        source: table,
        format: 'csv',
        csv: { delimiter: '\t', header: true, bom: false },
      });
      expect(result).toMatchObject({ phase: 'done', clipboard: true, statements: 3 });
      expect(result.file).toBeUndefined();
      expect(clipboard!.split('\r\n')[0]).toBe('id\tnaam\tbedrag\tleeg\tbin');
      expect(clipboard!.split('\r\n')[1]).toBe('1\tgewoon\t12.50\t\t0xdead');
    });

    it('copies JSON, SQL and Markdown too', async () => {
      expect((await copy({ source: table, format: 'json' })).clipboard).toMatch(
        /^\[\n {2}\{"id":1/,
      );
      expect((await copy({ source: table, format: 'sql' })).clipboard).toContain(
        'INSERT INTO `klanten`',
      );
      expect((await copy({ source: table, format: 'markdown' })).clipboard).toMatch(/^\| id \|/);
    });

    it('refuses more rows than the clipboard is for, and leaves it alone', async () => {
      const many = Array.from({ length: 101 }, () =>
        Array.from({ length: 1000 }, (_, i) => [i, 'x', '1', null, null]),
      );
      await expect(copy({ source: table, format: 'csv' }, many)).rejects.toMatchObject({
        code: 'CLIPBOARD_TOO_LARGE',
      });
    });

    it('does not put Excel or an archive on the clipboard', async () => {
      await expect(copy({ source: table, format: 'xlsx' })).rejects.toMatchObject({
        code: 'EXPORT_FORMAT',
      });
      await expect(
        copy({ source: table, format: 'csv', archive: { kind: 'zip' } }),
      ).rejects.toMatchObject({ code: 'EXPORT_FORMAT' });
    });
  });

  describe('selected rows', () => {
    it('fetches rows again by key, with a WHERE per dialect', async () => {
      expect(keyWhere(['id'], [['1'], ['2']], 'mysql')).toBe("`id` IN ('1', '2')");
      expect(
        keyWhere(
          ['a', 'b'],
          [
            ['1', "it's"],
            ['2', null],
          ],
          'postgres',
        ),
      ).toBe(`("a" = '1' AND "b" = 'it''s') OR ("a" = '2' AND "b" IS NULL)`);
      expect(keyWhere(['id'], [['x']], 'mssql')).toBe("[id] IN (N'x')");

      const { session, sources } = fakeSession();
      await exportData(
        session,
        'mysql',
        {
          source: {
            kind: 'keys',
            database: 'app',
            table: 'klanten',
            keyColumns: ['id'],
            keys: [['1'], ['3']],
          },
          format: 'csv',
          file: path.join(dir, 'keys.csv'),
        },
        'job',
        () => {},
        new AbortController().signal,
      );
      expect(sources[0]).toEqual({
        kind: 'table',
        database: 'app',
        table: 'klanten',
        where: "`id` IN ('1', '3')",
        orderBy: [{ column: 'id', direction: 'asc' }],
      });
    });

    it('exports the rows as shown without asking the server, numbers as numbers', async () => {
      const { session, sources } = fakeSession();
      let clipboard = '';
      const result = await exportData(
        session,
        'mysql',
        {
          source: {
            kind: 'values',
            columns: ['id', 'naam', 'bedrag'],
            numeric: [true, false, true],
            rows: [
              ['1', 'een', '12.50'],
              ['2', null, '99999999999999999.99'],
            ],
          },
          format: 'json',
          file: '',
          destination: 'clipboard',
        },
        'job',
        () => {},
        new AbortController().signal,
        (t) => (clipboard = t),
      );
      expect(sources).toEqual([]);
      expect(result.statements).toBe(2);
      expect(JSON.parse(clipboard)).toEqual([
        { id: 1, naam: 'een', bedrag: 12.5 },
        { id: 2, naam: null, bedrag: '99999999999999999.99' },
      ]);
    });

    it('writes INSERTs for shown rows with the chosen table name', async () => {
      const { session } = fakeSession();
      let clipboard = '';
      await exportData(
        session,
        'postgres',
        {
          source: { kind: 'values', columns: ['id'], numeric: [true], rows: [['7']] },
          format: 'sql',
          file: '',
          destination: 'clipboard',
          sql: { rowsPerInsert: 100, tableName: 'doel' },
        },
        'job',
        () => {},
        new AbortController().signal,
        (t) => (clipboard = t),
      );
      expect(clipboard).toContain('INSERT INTO "doel" ("id") VALUES\n(7);');
    });
  });
});
