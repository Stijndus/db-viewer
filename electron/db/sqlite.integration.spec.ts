/**
 * Runs the SQLite driver against a fresh database file built from scripts/setup-test-db.sqlite.sql.
 * Needs nothing installed: SQLite is built into Node and Electron.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toDbError } from '../ipc/errors';
import type { ConnectionConfig, DbSession } from './driver';
import { sqliteDriver } from './sqlite.driver';

const dir = mkdtempSync(path.join(tmpdir(), 'dbv-sqlite-'));
const file = path.join(dir, 'app_dev.db');
const fixtures = readFileSync(
  path.join(__dirname, '../../scripts/setup-test-db.sqlite.sql'),
  'utf8',
);

const base: ConnectionConfig = {
  type: 'sqlite',
  host: '',
  port: 0,
  database: file,
  user: '',
  password: '',
  ssl: false,
  allowSelfSigned: false,
  readOnly: false,
};

beforeEach(() => {
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(fixtures);
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function withSession<T>(
  fn: (s: DbSession) => Promise<T>,
  extra: Partial<ConnectionConfig> = {},
) {
  const session = await sqliteDriver.open({ ...base, ...extra });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return toDbError(err);
  }
  throw new Error('had moeten mislukken');
}

const page = { offset: 0, limit: 200, orderBy: [{ column: 'id', direction: 'asc' as const }] };
let tabNo = 0;
const newTab = () => `sq${Date.now()}${tabNo++}`;

describe('sqliteDriver', () => {
  it('opens a file and reports the version; refuses missing files and non-databases', async () => {
    await withSession(async (s) => expect(await s.serverVersion()).toMatch(/^SQLite 3\.\d+/));
    expect(
      (await errorOf(sqliteDriver.open({ ...base, database: path.join(dir, 'nope.db') }))).message,
    ).toBe('Databasebestand niet gevonden.');
    const text = path.join(dir, 'notes.txt');
    writeFileSync(
      text,
      'dit is geen database, maar wel lang genoeg om op een header te lijken.'.repeat(20),
    );
    expect((await errorOf(sqliteDriver.open({ ...base, database: text }))).code).toBe(
      'SQLITE_NOTADB',
    );
  });

  it('lists databases, objects and columns', async () => {
    await withSession(async (s) => {
      expect(await s.listDatabases()).toEqual([{ name: 'main', system: false }]);
      const objects = await s.listObjects('main');
      expect(objects.map((o) => `${o.name}:${o.kind}`)).toContain('paid_orders:view');
      expect(objects.map((o) => o.name)).toContain('we"ird');
      const cols = await s.listColumns('main', 'customers');
      expect(cols.map((c) => [c.name, c.key, c.nullable])).toEqual([
        ['id', 'primary', false],
        ['email', 'unique', false],
        ['status', 'index', false],
        ['note', null, true],
        ['created_at', null, true],
      ]);
      expect(cols[0]?.extra).toBe('rowid');
      expect(cols[2]?.defaultValue).toBe("'open'");
      const generated = await s.listColumns('main', 'value_types');
      expect(generated.at(-1)).toMatchObject({ name: 'total', extra: 'generated' });
      const all = await s.listAllColumns('main');
      expect(all['events']).toEqual(['id', 'kind', 'amount', 'created_at']);
    });
  });

  it('pages, sorts, filters and counts', async () => {
    await withSession(async (s) => {
      const first = await s.readRows('main', 'events', page);
      // DECIMAL has NUMERIC affinity in SQLite: '1.50' is stored as the number 1.5.
      expect(first.rows[0]).toEqual(['1', 'view', '1.5', '2026-01-01 00:01:00']);
      expect(first.hasMore).toBe(true);
      const last = await s.readRows('main', 'events', { ...page, offset: 2400 });
      expect(last.rows).toHaveLength(100);
      expect(last.hasMore).toBe(false);
      const desc = await s.readRows('main', 'events', {
        ...page,
        limit: 2,
        orderBy: [{ column: 'id', direction: 'desc' }],
      });
      expect(desc.rows.map((r) => r[0])).toEqual(['2500', '2499']);
      const where = "kind = 'buy' AND amount IS NULL";
      const filtered = await s.readRows('main', 'events', { ...page, where });
      expect(await s.countRows('main', 'events', where)).toBe(filtered.rows.length);
      expect(await s.countRows('main', 'events')).toBe(2500);
    });
  });

  it('returns values exactly: big integers, blobs, long text, NULL', async () => {
    await withSession(async (s) => {
      const { columns, rows } = await s.readRows('main', 'value_types', page);
      const row = Object.fromEntries(columns.map((c, i) => [c, rows[0]?.[i]]));
      expect(row['big']).toBe('9007199254740993');
      expect(row['payload']).toEqual({ kind: 'binary', bytes: 4, hex: 'deadbeef' });
      expect(row['real_value']).toBe('0.1');
      expect(row['body']).toMatchObject({ kind: 'truncated', length: 5000 });
      expect(row['missing']).toBeNull();
      expect(row['total']).toBe('9007199254740994');
    });
  });

  it('explains filter mistakes; a filter can neither write nor run a second statement', async () => {
    await withSession(async (s) => {
      expect(
        await errorOf(s.readRows('main', 'events', { ...page, where: 'nope = 1' })),
      ).toMatchObject({
        code: 'SQLITE_NO_COLUMN',
        message: 'Onbekende kolom in het filter.',
      });
      expect((await errorOf(s.readRows('main', 'events', { ...page, where: 'kind =' }))).code).toBe(
        'SQLITE_SYNTAX',
      );
      await s
        .readRows('main', 'events', { ...page, where: '1=1) ; DELETE FROM counter; SELECT (1' })
        .catch(() => undefined);
      expect(
        (await s.readRows('main', 'events', { ...page, limit: 5, where: '1=1 -- ' })).rows,
      ).toHaveLength(5);
      expect(await s.countRows('main', 'events')).toBe(2500);
    });
  });

  it('runs scripts per tab with their own session, and stops at the first error', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      const r = await s.runScript(tab, {
        statements: [
          'CREATE TEMP TABLE scratch (v INTEGER)',
          'INSERT INTO scratch VALUES (1), (2)',
          'SELECT sum(v) AS s, 1.5 AS r FROM scratch',
          'SELEC 1',
          'SELECT 2',
        ],
        maxRows: 100,
      });
      expect(r.results.map((x) => x.kind)).toEqual(['ok', 'ok', 'rows', 'error']);
      expect(r.results[1]).toMatchObject({ affectedRows: 2, insertId: '2' });
      expect(r.results[2]).toMatchObject({
        rows: [['3', '1.5']],
        columns: [
          { name: 's', type: 'integer' },
          { name: 'r', type: 'real' },
        ],
      });
      const other = await s.runScript(newTab(), {
        statements: ['SELECT * FROM scratch'],
        maxRows: 10,
      });
      expect(other.results[0]).toMatchObject({ kind: 'error', error: { code: 'SQLITE_NO_TABLE' } });
      const limited = await s.runScript(tab, {
        statements: ['SELECT * FROM events'],
        maxRows: 100,
      });
      expect(limited.results[0]).toMatchObject({ truncated: true });
      if (limited.results[0]?.kind === 'rows') expect(limited.results[0].rows).toHaveLength(100);
    });
  });

  it('stops a long query by restarting the tab session', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      const started = Date.now();
      const running = s.runScript(tab, {
        statements: [
          'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n',
        ],
        maxRows: 10,
      });
      await new Promise((r) => setTimeout(r, 300));
      await s.cancelScript(tab);
      const r = await running;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.results[0]).toMatchObject({
        kind: 'error',
        error: { message: 'Query afgebroken.' },
      });
      expect(
        (await s.runScript(tab, { statements: ['SELECT 1'], maxRows: 10 })).results[0]?.kind,
      ).toBe('rows');
    });
  });

  it('rolls back an open transaction when the tab is closed', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      await s.runScript(tab, {
        statements: ['BEGIN', 'INSERT INTO counter VALUES (99)'],
        maxRows: 10,
      });
      await s.closeEditor(tab);
      expect(await s.countRows('main', 'counter')).toBe(0);
    });
  });

  it('saves grid edits in one transaction, and rolls back when a row is gone', async () => {
    await withSession(async (s) => {
      expect(
        await s.applyChanges('main', 'editable', {
          primaryKey: ['id'],
          deletes: [{ key: { id: '3' } }],
          updates: [{ key: { id: '1' }, values: { qty: '10', note: null } }],
          inserts: [{ values: { name: 'mango' } }],
        }),
      ).toEqual({ deleted: 1, updated: 1, inserted: 1 });
      expect((await s.readRows('main', 'editable', page)).rows).toEqual([
        ['1', 'appel', '10', null],
        ['2', 'peer', '5', null],
        // Without AUTOINCREMENT the rowid of the deleted row is free again.
        ['3', 'mango', null, 'n/a'],
      ]);
      const gone = await errorOf(
        s.applyChanges('main', 'editable', {
          primaryKey: ['id'],
          deletes: [],
          updates: [
            { key: { id: '1' }, values: { qty: '99' } },
            { key: { id: '42' }, values: { qty: '1' } },
          ],
          inserts: [],
        }),
      );
      expect(gone.code).toBe('ROW_CHANGED');
      expect((await s.readRows('main', 'editable', page)).rows[0]?.[2]).toBe('10');
      await s.applyChanges('main', 'pairs', {
        primaryKey: ['a', 'b'],
        deletes: [],
        updates: [{ key: { a: '1', b: '2' }, values: { v: 'twee?' } }],
        inserts: [],
      });
      expect((await s.readRows('main', 'pairs', { ...page, orderBy: [] })).rows).toContainEqual([
        '1',
        '2',
        'twee?',
      ]);
      const view = await errorOf(
        s.applyChanges('main', 'paid_orders', {
          primaryKey: ['id'],
          deletes: [{ key: { id: '1' } }],
          updates: [],
          inserts: [],
        }),
      );
      expect(view.code).toBe('NOT_EDITABLE');
    });
  });

  it('read-only connections refuse writes in the grid, the editor and on the file itself', async () => {
    await withSession(
      async (s) => {
        expect(
          (
            await errorOf(
              s.applyChanges('main', 'editable', {
                primaryKey: ['id'],
                deletes: [{ key: { id: '1' } }],
                updates: [],
                inserts: [],
              }),
            )
          ).code,
        ).toBe('READ_ONLY_CONNECTION');
        const tab = newTab();
        const del = await s.runScript(tab, { statements: ['DELETE FROM counter'], maxRows: 10 });
        expect(del.results[0]).toMatchObject({ error: { code: 'READ_ONLY_CONNECTION' } });
        // Not recognised as a write by the app, refused by SQLite: the file is opened read-only.
        const sneaky = await s.runScript(tab, {
          statements: ['REPLACE INTO counter VALUES (1)'],
          maxRows: 10,
        });
        expect(sneaky.results[0]?.kind).toBe('error');
        const pragma = await s.runScript(tab, {
          statements: ['PRAGMA user_version = 7'],
          maxRows: 10,
        });
        expect(pragma.results[0]).toMatchObject({ error: { code: 'SQLITE_READONLY' } });
      },
      { readOnly: true },
    );
  });
});
