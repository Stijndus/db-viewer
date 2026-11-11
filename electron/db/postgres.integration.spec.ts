/**
 * Runs against a real PostgreSQL server. Skipped unless PG_TEST_HOST is set.
 *
 *   psql -h 127.0.0.1 -U postgres -f scripts/setup-test-db.postgres.sql
 *   npm run test:integration
 */
import { describe, expect, it } from 'vitest';
import { toDbError } from '../ipc/errors';
import type { ConnectionConfig, DbSession } from './driver';
import { postgresDriver } from './postgres.driver';

const host = process.env['PG_TEST_HOST'];
const port = Number(process.env['PG_TEST_PORT'] ?? 5432);

const base: ConnectionConfig = {
  type: 'postgres',
  host: host ?? '127.0.0.1',
  port,
  database: 'app_dev',
  user: 'viewer',
  password: 'test123',
  ssl: false,
  allowSelfSigned: false,
  readOnly: false,
};

async function withSession<T>(
  fn: (s: DbSession) => Promise<T>,
  extra: Partial<ConnectionConfig> = {},
) {
  const session = await postgresDriver.open({ ...base, ...extra });
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
const newTab = () => `pg${Date.now()}${tabNo++}`;

describe.skipIf(!host)('postgresDriver connecting', () => {
  it('connects and reports the version', async () => {
    await withSession(async (s) => expect(await s.serverVersion()).toMatch(/^PostgreSQL \d+/));
  });

  it('maps a wrong password, a missing database and a closed port', async () => {
    expect((await errorOf(postgresDriver.open({ ...base, password: 'fout' }))).code).toBe('28P01');
    expect((await errorOf(postgresDriver.open({ ...base, database: 'bestaat_niet' }))).code).toBe(
      '3D000',
    );
    const closed = await errorOf(postgresDriver.open({ ...base, port: 1 }));
    expect(closed.code).toBe('ECONNREFUSED');
    expect(closed.message).toBe('Server weigert verbinding.');
  });
});

describe.skipIf(!host)('postgresDriver schema metadata', () => {
  it('lists the schemas the user may use, system schemas flagged', async () => {
    await withSession(async (s) => {
      const schemas = await s.listDatabases();
      const names = schemas.map((d) => d.name);
      expect(names).toContain('public');
      expect(names).toContain('shop');
      expect(names).not.toContain('secret');
      expect(schemas.find((d) => d.name === 'pg_catalog')?.system).toBe(true);
      expect(schemas.find((d) => d.name === 'public')?.system).toBe(false);
    });
  });

  it('lists tables, views and routines with estimates and comments', async () => {
    await withSession(async (s) => {
      const objects = await s.listObjects('public');
      const byName = Object.fromEntries(objects.map((o) => [o.name, o]));
      expect(byName['customers']).toMatchObject({ kind: 'table', comment: 'Klanten' });
      expect(byName['paid_orders']?.kind).toBe('view');
      expect(byName['refresh_stats']?.kind).toBe('procedure');
      expect(byName['order_count']?.kind).toBe('function');
      expect(byName['events']?.rowEstimate).toBe(2500);
      expect(byName['we"ird']?.kind).toBe('table');
    });
  });

  it('describes columns with keys, defaults and identity', async () => {
    await withSession(async (s) => {
      const cols = await s.listColumns('public', 'customers');
      expect(cols.map((c) => [c.name, c.key])).toEqual([
        ['id', 'primary'],
        ['email', 'unique'],
        ['status', 'index'],
        ['note', null],
        ['created_at', null],
      ]);
      expect(cols[0]).toMatchObject({ type: 'integer', nullable: false, extra: 'serial' });
      expect(cols[1]?.type).toBe('character varying(255)');
      expect(cols[2]?.defaultValue).toBe("'open'::text");
      const editable = await s.listColumns('public', 'editable');
      expect(editable[0]?.extra).toBe('identity');
    });
  });

  it('lists all columns of a schema per table, for autocompletion', async () => {
    await withSession(async (s) => {
      const all = await s.listAllColumns('public');
      expect(all['events']).toEqual(['id', 'kind', 'amount', 'created_at']);
      expect(all['Order Items']).toEqual(['id', 'Unit Price']);
    });
  });
});

describe.skipIf(!host)('postgresDriver table data', () => {
  it('pages, sorts, filters and counts', async () => {
    await withSession(async (s) => {
      const first = await s.readRows('public', 'events', page);
      expect(first.columns).toEqual(['id', 'kind', 'amount', 'created_at']);
      expect(first.rows[0]).toEqual(['1', 'view', '1.50', '2026-01-01 00:01:00']);
      expect(first.hasMore).toBe(true);
      const last = await s.readRows('public', 'events', { ...page, offset: 2400 });
      expect(last.rows).toHaveLength(100);
      expect(last.hasMore).toBe(false);

      const desc = await s.readRows('public', 'events', {
        ...page,
        limit: 3,
        orderBy: [{ column: 'id', direction: 'desc' }],
      });
      expect(desc.rows.map((r) => r[0])).toEqual(['2500', '2499', '2498']);
      const where = "kind = 'buy' AND amount IS NULL";
      const filtered = await s.readRows('public', 'events', { ...page, where });
      expect(filtered.rows.every((r) => r[1] === 'buy' && r[2] === null)).toBe(true);
      expect(await s.countRows('public', 'events', where)).toBe(filtered.rows.length);
      expect(await s.countRows('public', 'events')).toBe(2500);
    });
  });

  it('returns every kind of value exactly as stored', async () => {
    await withSession(async (s) => {
      const { columns, rows } = await s.readRows('public', 'value_types', page);
      const row = Object.fromEntries(columns.map((c, i) => [c, rows[0]?.[i]]));
      expect(row['big']).toBe('18446744073709551615');
      expect(JSON.parse(row['doc'] as string)).toEqual({ a: 1, b: [true, null] });
      expect(row['payload']).toEqual({ kind: 'binary', bytes: 4, hex: 'deadbeef' });
      expect(row['flag']).toBe('t');
      expect(row['body']).toMatchObject({ kind: 'truncated', length: 5000 });
      expect(row['missing']).toBeNull();
      expect(row['tags']).toBe('{a,b}');
      expect(row['at']).toMatch(/^2026-11-10 \d\d:10:00\+00$/);
    });
  });

  it('reads awkward names, views and other schemas', async () => {
    await withSession(async (s) => {
      expect((await s.readRows('public', 'we"ird', page)).rows).toEqual([['1', 'ok']]);
      expect((await s.readRows('public', 'Order Items', { ...page, orderBy: [] })).columns).toEqual(
        ['id', 'Unit Price'],
      );
      expect((await s.readRows('public', 'paid_orders', { ...page, orderBy: [] })).columns).toEqual(
        ['id', 'total'],
      );
      expect((await s.readRows('shop', 'orders', page)).rows).toEqual([['1', 'boek']]);
    });
  });

  it('explains filter mistakes and keeps working afterwards', async () => {
    await withSession(async (s) => {
      const bad = await errorOf(s.readRows('public', 'events', { ...page, where: 'nope = 1' }));
      expect(bad).toMatchObject({ code: '42703', message: 'Onbekende kolom in het filter.' });
      expect(bad.hint).toContain('nope');
      expect(
        (await errorOf(s.readRows('public', 'events', { ...page, where: 'kind =' }))).code,
      ).toBe('42601');
      for (let i = 0; i < 8; i++) {
        await s.readRows('public', 'events', { ...page, where: 'kind =' }).catch(() => undefined);
      }
      expect((await s.readRows('public', 'events', { ...page, limit: 1 })).rows).toHaveLength(1);
    });
  });

  it('never runs a second statement or a write from the filter', async () => {
    await withSession(async (s) => {
      // The extended protocol takes exactly one statement.
      const multi = await errorOf(
        s.readRows('public', 'events', {
          ...page,
          where: '1=1) ; DELETE FROM public.counter; SELECT (1',
        }),
      );
      expect(multi.code).toBe('42601');
      // Writes inside the filter hit the READ ONLY transaction.
      const write = await errorOf(
        s.readRows('public', 'events', { ...page, where: 'public.bump() = 1' }),
      );
      expect(write.code).toBe('25006');
      expect(await s.countRows('public', 'counter')).toBe(0);
      // A comment at the end cannot swallow LIMIT.
      const r = await s.readRows('public', 'events', { ...page, limit: 5, where: '1=1 -- ' });
      expect(r.rows).toHaveLength(5);
    });
  });
});

describe.skipIf(!host)('postgresDriver SQL editor', () => {
  it('returns rows with types and applies the row limit through a cursor', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      const r = await s.runScript(tab, {
        statements: ['SELECT id, kind, amount FROM events ORDER BY id'],
        maxRows: 100,
      });
      const res = r.results[0]!;
      expect(res.kind).toBe('rows');
      if (res.kind !== 'rows') return;
      expect(res.columns).toEqual([
        { name: 'id', type: 'int' },
        { name: 'kind', type: 'varchar' },
        { name: 'amount', type: 'numeric' },
      ]);
      expect(res.rows).toHaveLength(100);
      expect(res.truncated).toBe(true);
      expect(r.database).toBe('public');
    });
  });

  it('keeps session state per tab: search_path, temp tables, transactions', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      const r = await s.runScript(tab, {
        statements: [
          'CREATE TEMP TABLE scratch (v int)',
          'INSERT INTO scratch VALUES (1), (2)',
          'BEGIN',
          'UPDATE scratch SET v = v + 10',
          'SELECT sum(v) FROM scratch',
          'ROLLBACK',
          'SELECT sum(v) AS s FROM scratch',
        ],
        maxRows: 1000,
      });
      expect(r.results.map((x) => x.kind)).toEqual(['ok', 'ok', 'ok', 'ok', 'rows', 'ok', 'rows']);
      expect(r.results[1]).toMatchObject({ kind: 'ok', affectedRows: 2, info: 'INSERT' });
      expect(r.results[4]).toMatchObject({ rows: [['23']] });
      expect(r.results[6]).toMatchObject({ rows: [['3']] });

      const inShop = await s.runScript(tab, {
        statements: ['SELECT item FROM orders'],
        database: 'shop',
        maxRows: 10,
      });
      expect(inShop.results[0]).toMatchObject({ rows: [['boek']] });
      expect(inShop.database).toBe('shop');
      // Another tab is another session.
      const other = await s.runScript(newTab(), {
        statements: ['SELECT * FROM scratch'],
        maxRows: 10,
      });
      expect(other.results[0]).toMatchObject({ kind: 'error', error: { code: '42P01' } });
    });
  });

  it('splits dollar-quoted bodies correctly and stops at the first error', async () => {
    await withSession(async (s) => {
      const r = await s.runScript(newTab(), {
        statements: ['DO $$ BEGIN PERFORM 1; END $$', 'SELEC 1', 'SELECT 2'],
        maxRows: 10,
      });
      expect(r.results.map((x) => x.kind)).toEqual(['ok', 'error']);
      expect(r.results[1]).toMatchObject({ error: { code: '42601' } });
    });
  });

  it('stops a long query on request', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      await s.runScript(tab, { statements: ['SELECT 1'], maxRows: 10 });
      const started = Date.now();
      const running = s.runScript(tab, { statements: ['SELECT pg_sleep(20)'], maxRows: 10 });
      await new Promise((r) => setTimeout(r, 300));
      await s.cancelScript(tab);
      const r = await running;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.results[0]).toMatchObject({
        kind: 'error',
        error: { code: '57014', message: 'Query afgebroken.' },
      });
      // The tab keeps working.
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
      expect(await s.countRows('public', 'counter', 'n = 99')).toBe(0);
    });
  });

  it('refuses writes on a read-only connection, also when they hide in a function', async () => {
    await withSession(
      async (s) => {
        const tab = newTab();
        const del = await s.runScript(tab, { statements: ['DELETE FROM counter'], maxRows: 10 });
        expect(del.results[0]).toMatchObject({ error: { code: 'READ_ONLY_CONNECTION' } });
        const sneaky = await s.runScript(tab, { statements: ['SELECT bump()'], maxRows: 10 });
        expect(sneaky.results[0]).toMatchObject({
          kind: 'error',
          error: { code: '25006', message: 'Deze verbinding is alleen-lezen.' },
        });
        const escape = await s.runScript(tab, {
          statements: ["SELECT set_config('default_transaction_read_only', 'off', false)"],
          maxRows: 10,
        });
        expect(escape.results[0]).toMatchObject({ error: { code: 'READ_ONLY_CONNECTION' } });
        expect(
          (await s.runScript(tab, { statements: ['SELECT 1'], maxRows: 10 })).results[0]?.kind,
        ).toBe('rows');
      },
      { readOnly: true },
    );
  });
});

describe.skipIf(!host)('postgresDriver grid edits', () => {
  const reset = (s: DbSession) =>
    s.runScript(newTab(), {
      statements: [
        'DELETE FROM editable',
        "INSERT INTO editable (id, name, qty, note) OVERRIDING SYSTEM VALUE VALUES (1, 'appel', 3, 'rood'), (2, 'peer', 5, NULL), (3, 'kiwi', 7, 'groen')",
      ],
      maxRows: 10,
    });

  it('applies deletes, updates and inserts together', async () => {
    await withSession(async (s) => {
      await reset(s);
      const result = await s.applyChanges('public', 'editable', {
        primaryKey: ['id'],
        deletes: [{ key: { id: '3' } }],
        updates: [{ key: { id: '1' }, values: { qty: '10', note: null } }],
        inserts: [{ values: { name: 'mango' } }],
      });
      expect(result).toEqual({ deleted: 1, updated: 1, inserted: 1 });
      const rows = (await s.readRows('public', 'editable', page)).rows;
      expect(rows.map((r) => r.slice(1))).toEqual([
        ['appel', '10', null],
        ['peer', '5', null],
        ['mango', null, 'n/a'],
      ]);
    });
  });

  it('rolls everything back when a row is gone, and reports invalid values per row', async () => {
    await withSession(async (s) => {
      await reset(s);
      const gone = await errorOf(
        s.applyChanges('public', 'editable', {
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
      const invalid = await errorOf(
        s.applyChanges('public', 'editable', {
          primaryKey: ['id'],
          deletes: [],
          updates: [{ key: { id: '2' }, values: { qty: 'veel' } }],
          inserts: [],
        }),
      );
      expect(invalid.message).toContain('wijzigen van de rij met id = 2');
      expect(invalid.hint).toContain('Er is niets opgeslagen.');
      const rows = (await s.readRows('public', 'editable', page)).rows;
      expect(rows.map((r) => r[2])).toEqual(['3', '5', '7']);
    });
  });

  it('updates rows with a composite key and handles a ? in names and values', async () => {
    await withSession(async (s) => {
      await s.applyChanges('public', 'pairs', {
        primaryKey: ['a', 'b'],
        deletes: [],
        updates: [{ key: { a: '1', b: '2' }, values: { v: 'twee!' } }],
        inserts: [],
      });
      expect((await s.readRows('public', 'pairs', { ...page, orderBy: [] })).rows).toContainEqual([
        '1',
        '2',
        'twee!',
      ]);
      await s.applyChanges('public', 'wat?', {
        primaryKey: ['id'],
        deletes: [],
        updates: [{ key: { id: '2' }, values: { label: 'nee?' } }],
        inserts: [],
      });
      expect(
        (await s.readRows('public', 'wat?', { ...page, where: "label LIKE '%?%'" })).rows,
      ).toEqual([
        ['1', 'echt?'],
        ['2', 'nee?'],
      ]);
    });
  });

  it('refuses views, tables without a key and read-only connections', async () => {
    await withSession(async (s) => {
      const change = {
        primaryKey: ['id'],
        deletes: [{ key: { id: '1' } }],
        updates: [],
        inserts: [],
      };
      expect((await errorOf(s.applyChanges('public', 'paid_orders', change))).code).toBe(
        'NOT_EDITABLE',
      );
      expect(
        (
          await errorOf(
            s.applyChanges('public', 'nopk', {
              ...change,
              primaryKey: ['x'],
              deletes: [{ key: { x: '1' } }],
            }),
          )
        ).code,
      ).toBe('NOT_EDITABLE');
    });
    await withSession(
      async (s) => {
        const e = await errorOf(
          s.applyChanges('public', 'editable', {
            primaryKey: ['id'],
            deletes: [{ key: { id: '1' } }],
            updates: [],
            inserts: [],
          }),
        );
        expect(e.code).toBe('READ_ONLY_CONNECTION');
      },
      { readOnly: true },
    );
  });
});
