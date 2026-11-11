/**
 * Runs against a real SQL Server. Skipped unless MSSQL_TEST_HOST is set (CI starts one).
 *
 *   docker run -d -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Str0ng!Passw0rd' -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
 *   node scripts/setup-test-db.mssql.mjs
 */
import { describe, expect, it } from 'vitest';
import { toDbError } from '../ipc/errors';
import type { ConnectionConfig, DbSession } from './driver';
import { mssqlDriver } from './mssql.driver';

const host = process.env['MSSQL_TEST_HOST'];
const port = Number(process.env['MSSQL_TEST_PORT'] ?? 1433);

const base: ConnectionConfig = {
  type: 'mssql',
  host: host ?? '127.0.0.1',
  port,
  database: 'app_dev',
  user: 'viewer',
  password: 'Test123!viewer',
  ssl: false,
  allowSelfSigned: true,
  readOnly: false,
};

async function withSession<T>(
  fn: (s: DbSession) => Promise<T>,
  extra: Partial<ConnectionConfig> = {},
) {
  const session = await mssqlDriver.open({ ...base, ...extra });
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
const newTab = () => `ms${Date.now()}${tabNo++}`;

describe.skipIf(!host)('mssqlDriver connecting', () => {
  it('connects and reports the version', async () => {
    await withSession(async (s) => expect(await s.serverVersion()).toMatch(/^SQL Server \d+\./));
  });

  it('maps a wrong password, a missing database and a closed port', async () => {
    const pw = await errorOf(mssqlDriver.open({ ...base, password: 'fout' }));
    expect(pw).toMatchObject({ code: 'MSSQL_18456', message: 'Inloggen mislukt.' });
    const db = await errorOf(mssqlDriver.open({ ...base, database: 'bestaat_niet' }));
    expect(db.code).toBe('MSSQL_4060');
    const closed = await errorOf(mssqlDriver.open({ ...base, port: 1 }));
    expect(closed.code).toBe('ECONNREFUSED');
  });
});

describe.skipIf(!host)('mssqlDriver schema metadata', () => {
  it('lists schemas, system ones flagged', async () => {
    await withSession(async (s) => {
      const schemas = await s.listDatabases();
      expect(schemas.find((d) => d.name === 'dbo')?.system).toBe(false);
      expect(schemas.find((d) => d.name === 'shop')?.system).toBe(false);
      expect(schemas.find((d) => d.name === 'sys')?.system).toBe(true);
      expect(schemas.find((d) => d.name === 'db_owner')?.system).toBe(true);
    });
  });

  it('lists tables, views and routines with estimates and comments', async () => {
    await withSession(async (s) => {
      const byName = Object.fromEntries((await s.listObjects('dbo')).map((o) => [o.name, o]));
      expect(byName['customers']).toMatchObject({ kind: 'table', comment: 'Klanten' });
      expect(byName['paid_orders']?.kind).toBe('view');
      expect(byName['refresh_stats']?.kind).toBe('procedure');
      expect(byName['order_count']?.kind).toBe('function');
      expect(byName['events']?.rowEstimate).toBe(2500);
      expect(byName['we]ird']?.kind).toBe('table');
    });
  });

  it('describes columns with keys, defaults and identity', async () => {
    await withSession(async (s) => {
      const cols = await s.listColumns('dbo', 'customers');
      expect(cols.map((c) => [c.name, c.key])).toEqual([
        ['id', 'primary'],
        ['email', 'unique'],
        ['status', 'index'],
        ['note', null],
        ['created_at', null],
      ]);
      expect(cols[0]).toMatchObject({ type: 'int', nullable: false, extra: 'identity' });
      expect(cols[1]?.type).toBe('nvarchar(255)');
      expect(cols[2]?.defaultValue).toBe('open');
      expect(cols[3]?.defaultValue).toBe("it's");
      expect(cols[4]?.defaultValue).toBe('getdate()');
      const all = await s.listAllColumns('dbo');
      expect(all['events']).toEqual(['id', 'kind', 'amount', 'created_at']);
    });
  });
});

describe.skipIf(!host)('mssqlDriver table data', () => {
  it('pages, sorts, filters and counts', async () => {
    await withSession(async (s) => {
      const first = await s.readRows('dbo', 'events', page);
      expect(first.columns).toEqual(['id', 'kind', 'amount', 'created_at']);
      expect(first.rows[0]?.slice(0, 3)).toEqual(['1', 'view', '1.50']);
      expect(first.rows[0]?.[3]).toMatch(/^2026-01-01 00:01:00/);
      expect(first.hasMore).toBe(true);
      const last = await s.readRows('dbo', 'events', { ...page, offset: 2400 });
      expect(last.rows).toHaveLength(100);
      expect(last.hasMore).toBe(false);
      const desc = await s.readRows('dbo', 'events', {
        ...page,
        limit: 2,
        orderBy: [{ column: 'id', direction: 'desc' }],
      });
      expect(desc.rows.map((r) => r[0])).toEqual(['2500', '2499']);
      const unsorted = await s.readRows('dbo', 'events', { ...page, limit: 3, orderBy: [] });
      expect(unsorted.rows).toHaveLength(3);
      const where = "kind = 'buy' AND amount IS NULL";
      const filtered = await s.readRows('dbo', 'events', { ...page, where });
      expect(filtered.rows.every((r) => r[1] === 'buy' && r[2] === null)).toBe(true);
      expect(await s.countRows('dbo', 'events', where)).toBe(filtered.rows.length);
      expect(await s.countRows('dbo', 'events')).toBe(2500);
    });
  });

  it('returns every kind of value exactly as stored', async () => {
    await withSession(async (s) => {
      const { columns, rows } = await s.readRows('dbo', 'value_types', page);
      const row = Object.fromEntries(columns.map((c, i) => [c, rows[0]?.[i]]));
      expect(row['big']).toBe('18446744073709551615');
      expect(row['money_value']).toBe('1234.5678');
      expect(row['payload']).toEqual({ kind: 'binary', bytes: 4, hex: 'deadbeef' });
      expect(row['flag']).toBe('1');
      expect(row['body']).toMatchObject({ kind: 'truncated', length: 5000 });
      expect(row['missing']).toBeNull();
      expect(String(row['uid']).toUpperCase()).toBe('6F9619FF-8B86-D011-B42D-00C04FC964FF');
      expect(row['at']).toBe('2026-11-10 14:10:00.123 +01:00');
      expect(row['day']).toBe('2026-11-10');
      expect(row['moment']).toBe('14:10:00.500');
      expect(row['precise']).toBe('2026-11-10 14:10:00.1234567');
      expect(row['legacy']).toBe('2026-11-10 14:10:00.997');
      const orders = await s.readRows('dbo', 'orders', page);
      expect(orders.rows[0]?.[0]).toBe('9007199254740993');
    });
  });

  it('reads awkward names, views and other schemas', async () => {
    await withSession(async (s) => {
      expect((await s.readRows('dbo', 'we]ird', page)).rows).toEqual([['1', 'ok']]);
      expect((await s.readRows('dbo', 'Order Items', { ...page, orderBy: [] })).columns).toEqual([
        'id',
        'Unit Price',
      ]);
      expect((await s.readRows('dbo', 'paid_orders', { ...page, orderBy: [] })).columns).toEqual([
        'id',
        'total',
      ]);
      expect((await s.readRows('shop', 'orders', page)).rows).toEqual([['1', 'boek']]);
    });
  });

  it('explains filter mistakes, refuses statements in a filter, and keeps working', async () => {
    await withSession(async (s) => {
      const bad = await errorOf(s.readRows('dbo', 'events', { ...page, where: 'nope = 1' }));
      expect(bad).toMatchObject({ code: 'MSSQL_207', message: 'Onbekende kolom in het filter.' });
      expect(bad.hint).toContain('nope');
      expect(
        (await errorOf(s.readRows('dbo', 'events', { ...page, where: 'kind =' }))).message,
      ).toBe('Fout in het filter.');
      const smuggled = await errorOf(
        s.readRows('dbo', 'events', { ...page, where: '1=1) DELETE FROM dbo.counter WHERE (1=1' }),
      );
      expect(smuggled.code).toBe('FILTER_NOT_ALLOWED');
      for (let i = 0; i < 8; i++) {
        await s.readRows('dbo', 'events', { ...page, where: 'kind =' }).catch(() => undefined);
      }
      expect(
        (await s.readRows('dbo', 'events', { ...page, limit: 5, where: '1=1 -- ' })).rows,
      ).toHaveLength(5);
    });
  });
});

describe.skipIf(!host)('mssqlDriver SQL editor', () => {
  it('returns rows with types and applies the row limit', async () => {
    await withSession(async (s) => {
      const r = await s.runScript(newTab(), {
        statements: ['SELECT id, kind, amount FROM events ORDER BY id'],
        maxRows: 100,
      });
      const res = r.results[0]!;
      expect(res.kind).toBe('rows');
      if (res.kind !== 'rows') return;
      expect(res.columns.map((c) => c.name)).toEqual(['id', 'kind', 'amount']);
      expect(res.columns[0]?.type).toBe('int');
      expect(res.rows).toHaveLength(100);
      expect(res.truncated).toBe(true);
    });
  });

  it('returns one result per statement in a batch, and per result set of a procedure', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      const r = await s.runScript(tab, {
        statements: [
          'SELECT 1 AS a; SELECT 2 AS b',
          'EXEC refresh_stats',
          'DECLARE @x int = 5; SELECT @x AS x',
        ],
        maxRows: 10,
      });
      const shape = r.results.map((x) =>
        x.kind === 'rows' ? `${x.index}:${JSON.stringify(x.rows)}` : `${x.index}:${x.kind}`,
      );
      expect(shape).toEqual(['0:[["1"]]', '0:[["2"]]', '1:[["1"]]', '1:[["2"]]', '2:[["5"]]']);
    });
  });

  it('keeps session state per tab and stops at the first error', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      const first = await s.runScript(tab, {
        statements: ['CREATE TABLE #scratch (v int); INSERT INTO #scratch VALUES (1), (2)'],
        maxRows: 10,
      });
      expect(first.results).toEqual([expect.objectContaining({ kind: 'ok', affectedRows: 2 })]);
      const sum = await s.runScript(tab, {
        statements: ['SELECT SUM(v) AS s FROM #scratch'],
        maxRows: 10,
      });
      expect(sum.results[0]).toMatchObject({ rows: [['3']] });
      const other = await s.runScript(newTab(), {
        statements: ['SELECT * FROM #scratch'],
        maxRows: 10,
      });
      expect(other.results[0]).toMatchObject({ kind: 'error', error: { code: 'MSSQL_208' } });
      const stops = await s.runScript(tab, {
        statements: ['SELECT 1', 'SELECT FROM', 'SELECT 2'],
        maxRows: 10,
      });
      expect(stops.results.map((x) => x.kind)).toEqual(['rows', 'error']);
    });
  });

  it('stops a long batch on request', async () => {
    await withSession(async (s) => {
      const tab = newTab();
      await s.runScript(tab, { statements: ['SELECT 1'], maxRows: 10 });
      const started = Date.now();
      const running = s.runScript(tab, { statements: ["WAITFOR DELAY '00:00:20'"], maxRows: 10 });
      await new Promise((r) => setTimeout(r, 500));
      await s.cancelScript(tab);
      const r = await running;
      expect(Date.now() - started).toBeLessThan(8000);
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
        statements: ['BEGIN TRAN; INSERT INTO counter VALUES (99)'],
        maxRows: 10,
      });
      await s.closeEditor(tab);
      expect(await s.countRows('dbo', 'counter', 'n = 99')).toBe(0);
    });
  });

  it('allows only reads on a read-only connection', async () => {
    await withSession(
      async (s) => {
        const tab = newTab();
        const del = await s.runScript(tab, {
          statements: ['SELECT 1; DELETE FROM counter'],
          maxRows: 10,
        });
        expect(del.results[0]).toMatchObject({ error: { code: 'READ_ONLY_CONNECTION' } });
        const unknown = await s.runScript(tab, { statements: ['IF 1 = 1 SELECT 1'], maxRows: 10 });
        expect(unknown.results[0]).toMatchObject({ error: { code: 'READ_ONLY_CONNECTION' } });
        expect(
          (await s.runScript(tab, { statements: ['SELECT 1'], maxRows: 10 })).results[0]?.kind,
        ).toBe('rows');
      },
      { readOnly: true },
    );
  });
});

describe.skipIf(!host)('mssqlDriver grid edits', () => {
  const reset = (s: DbSession) =>
    s.runScript(newTab(), {
      statements: [
        "SET IDENTITY_INSERT editable ON; DELETE FROM editable; INSERT INTO editable (id, name, qty, note) VALUES (1, N'appel', 3, N'rood'), (2, N'peer', 5, NULL), (3, N'kiwi', 7, N'groen'); SET IDENTITY_INSERT editable OFF",
      ],
      maxRows: 10,
    });

  it('applies deletes, updates and inserts together', async () => {
    await withSession(async (s) => {
      await reset(s);
      const result = await s.applyChanges('dbo', 'editable', {
        primaryKey: ['id'],
        deletes: [{ key: { id: '3' } }],
        updates: [{ key: { id: '1' }, values: { qty: '10', note: null } }],
        inserts: [{ values: { name: 'mango' } }],
      });
      expect(result).toEqual({ deleted: 1, updated: 1, inserted: 1 });
      const rows = (await s.readRows('dbo', 'editable', page)).rows;
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
        s.applyChanges('dbo', 'editable', {
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
        s.applyChanges('dbo', 'editable', {
          primaryKey: ['id'],
          deletes: [],
          updates: [{ key: { id: '2' }, values: { qty: 'veel' } }],
          inserts: [],
        }),
      );
      expect(invalid.message).toContain('wijzigen van de rij met id = 2');
      expect((await s.readRows('dbo', 'editable', page)).rows.map((r) => r[2])).toEqual([
        '3',
        '5',
        '7',
      ]);
    });
  });

  it('updates rows with a composite key and handles a ? in names and values', async () => {
    await withSession(async (s) => {
      await s.applyChanges('dbo', 'pairs', {
        primaryKey: ['a', 'b'],
        deletes: [],
        updates: [{ key: { a: '1', b: '2' }, values: { v: 'twee!' } }],
        inserts: [],
      });
      expect((await s.readRows('dbo', 'pairs', { ...page, orderBy: [] })).rows).toContainEqual([
        '1',
        '2',
        'twee!',
      ]);
      await s.applyChanges('dbo', 'wat?', {
        primaryKey: ['id'],
        deletes: [],
        updates: [{ key: { id: '2' }, values: { label: 'nee?' } }],
        inserts: [],
      });
      expect(
        (await s.readRows('dbo', 'wat?', { ...page, where: "label LIKE '%?%'" })).rows,
      ).toEqual([
        ['1', 'echt?'],
        ['2', 'nee?'],
      ]);
    });
  });

  it('refuses views, tables without a key and read-only connections', async () => {
    const change = {
      primaryKey: ['id'],
      deletes: [{ key: { id: '1' } }],
      updates: [],
      inserts: [],
    };
    await withSession(async (s) => {
      expect((await errorOf(s.applyChanges('dbo', 'paid_orders', change))).code).toBe(
        'NOT_EDITABLE',
      );
      expect(
        (
          await errorOf(
            s.applyChanges('dbo', 'nopk', {
              ...change,
              primaryKey: ['x'],
              deletes: [{ key: { x: '1' } }],
            }),
          )
        ).code,
      ).toBe('NOT_EDITABLE');
    });
    await withSession(
      async (s) =>
        expect((await errorOf(s.applyChanges('dbo', 'editable', change))).code).toBe(
          'READ_ONLY_CONNECTION',
        ),
      { readOnly: true },
    );
  });
});
