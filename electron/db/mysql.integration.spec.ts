/**
 * Runs against a real MySQL/MariaDB server. Skipped unless MYSQL_TEST_HOST is set.
 *
 *   docker run -d --name dbv-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8
 *   npm run test:integration   (see scripts/setup-test-db.sql for the test user)
 */
import { describe, expect, it } from 'vitest';
import { toDbError } from '../ipc/errors';
import type { ConnectionConfig } from './driver';
import { mysqlDriver } from './mysql.driver';

const host = process.env['MYSQL_TEST_HOST'];
const port = Number(process.env['MYSQL_TEST_PORT'] ?? 3306);

const base: ConnectionConfig = {
  type: 'mysql',
  host: host ?? '127.0.0.1',
  port,
  database: 'app_dev',
  user: 'viewer',
  password: 'test123',
  ssl: false,
  allowSelfSigned: false,
  readOnly: false,
};

async function errorCodeOf(config: Partial<ConnectionConfig>): Promise<string> {
  try {
    const session = await mysqlDriver.open({ ...base, ...config });
    await session.close();
  } catch (err) {
    return toDbError(err).code;
  }
  throw new Error('verbinden had moeten mislukken');
}

describe.skipIf(!host)('mysqlDriver against a real server', () => {
  it('connects, reports the version and closes', async () => {
    const session = await mysqlDriver.open(base);
    expect(await session.serverVersion()).toMatch(/^\d+\.\d+/);
    await session.close();
  });

  it('returns BIGINT, DECIMAL and DATETIME exactly as stored', async () => {
    const session = await mysqlDriver.open(base);
    const { rows, fields } = await session.query(
      'SELECT id, total, created_at FROM orders ORDER BY id LIMIT 1',
    );
    expect(fields).toEqual(['id', 'total', 'created_at']);
    expect(rows[0]).toEqual({
      id: '9007199254740993',
      total: '129.95',
      created_at: '2026-11-10 14:10:00',
    });
    await session.close();
  });

  it('maps a wrong password', async () => {
    expect(await errorCodeOf({ password: 'fout' })).toBe('ER_ACCESS_DENIED_ERROR');
  });

  it('maps a database without rights', async () => {
    expect(await errorCodeOf({ database: 'secret_db' })).toBe('ER_DBACCESS_DENIED_ERROR');
  });

  it('maps a missing database (as a user who may see all databases)', async () => {
    const code = await errorCodeOf({ database: 'bestaat_niet' });
    // MySQL hides missing databases from users without global rights behind 1044.
    expect(['ER_BAD_DB_ERROR', 'ER_DBACCESS_DENIED_ERROR']).toContain(code);
  });

  it('maps a closed port', async () => {
    expect(await errorCodeOf({ port: 1 })).toBe('ECONNREFUSED');
  });

  it('maps an unknown host', async () => {
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(
      await errorCodeOf({ host: 'bestaat-niet.invalid' }),
    );
  });
});

describe.skipIf(!host)('mysqlDriver schema metadata', () => {
  it('lists only databases the user may see, system ones flagged', async () => {
    const session = await mysqlDriver.open({ ...base, database: '' });
    const dbs = await session.listDatabases();
    await session.close();

    const names = dbs.map((d) => d.name);
    expect(names).toContain('app_dev');
    expect(names).not.toContain('secret_db');
    expect(dbs.find((d) => d.name === 'information_schema')?.system).toBe(true);
    expect(dbs.find((d) => d.name === 'app_dev')?.system).toBe(false);
  });

  it('lists tables, views and routines, including awkward names', async () => {
    const session = await mysqlDriver.open(base);
    const objects = await session.listObjects('app_dev');
    await session.close();

    const kindOf = (name: string) => objects.find((o) => o.name === name)?.kind;
    expect(kindOf('orders')).toBe('table');
    expect(kindOf('Order Items')).toBe('table');
    expect(kindOf('paid_orders')).toBe('view');
    expect(kindOf('refresh_stats')).toBe('procedure');
    expect(kindOf('order_count')).toBe('function');
    expect(objects.find((o) => o.name === 'customers')?.comment).toBe('Klanten');
    expect(objects.find((o) => o.name === 'paid_orders')?.rowEstimate).toBeNull();
  });

  it('describes columns with keys, defaults and extras the same on MySQL and MariaDB', async () => {
    const session = await mysqlDriver.open(base);
    const cols = await session.listColumns('app_dev', 'customers');
    await session.close();

    expect(cols.map((c) => c.name)).toEqual(['id', 'email', 'status', 'note', 'created_at']);
    const col = (name: string) => cols.find((c) => c.name === name)!;
    expect(col('id')).toMatchObject({ key: 'primary', nullable: false, extra: 'auto_increment' });
    expect(col('email')).toMatchObject({ key: 'unique', type: 'varchar(255)', defaultValue: null });
    expect(col('status')).toMatchObject({
      key: 'index',
      type: "enum('open','closed')",
      defaultValue: 'open',
    });
    expect(col('note')).toMatchObject({ nullable: true, defaultValue: "it's" });
    expect(col('created_at').defaultValue?.toLowerCase()).toMatch(/^current_timestamp/);
  });

  it('handles table and column names with spaces', async () => {
    const session = await mysqlDriver.open(base);
    const cols = await session.listColumns('app_dev', 'Order Items');
    await session.close();
    expect(cols.map((c) => c.name)).toEqual(['id', 'Unit Price']);
  });

  it('lists all columns of a database per table, for autocompletion', async () => {
    const session = await mysqlDriver.open(base);
    const all = await session.listAllColumns('app_dev');
    await session.close();
    expect(all['events']).toEqual(['id', 'kind', 'amount', 'created_at']);
    expect(all['Order Items']).toEqual(['id', 'Unit Price']);
  });

  it('returns no columns for a table the user cannot see', async () => {
    const session = await mysqlDriver.open(base);
    expect(await session.listColumns('secret_db', 'hidden')).toEqual([]);
    expect(await session.listObjects('secret_db')).toEqual([]);
    await session.close();
  });
});

describe.skipIf(!host)('mysqlDriver table data', () => {
  const page = { offset: 0, limit: 200, orderBy: [{ column: 'id', direction: 'asc' as const }] };

  async function withSession<T>(
    fn: (s: Awaited<ReturnType<typeof mysqlDriver.open>>) => Promise<T>,
  ) {
    const session = await mysqlDriver.open(base);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  async function dataErrorCode(where: string): Promise<string> {
    return withSession(async (s) => {
      try {
        await s.readRows('app_dev', 'events', { ...page, where });
      } catch (err) {
        return toDbError(err).code;
      }
      throw new Error('query had moeten mislukken');
    });
  }

  it('pages through a table and knows when the end is reached', async () => {
    await withSession(async (s) => {
      const first = await s.readRows('app_dev', 'events', page);
      expect(first.columns).toEqual(['id', 'kind', 'amount', 'created_at']);
      expect(first.rows).toHaveLength(200);
      expect(first.rows[0]).toEqual(['1', 'view', '1.50', '2026-01-01 00:01:00']);
      expect(first.hasMore).toBe(true);

      const last = await s.readRows('app_dev', 'events', { ...page, offset: 2400 });
      expect(last.rows).toHaveLength(100);
      expect(last.rows.at(-1)?.[0]).toBe('2500');
      expect(last.hasMore).toBe(false);
    });
  });

  it('sorts descending and filters with a raw condition', async () => {
    await withSession(async (s) => {
      const desc = await s.readRows('app_dev', 'events', {
        ...page,
        limit: 3,
        orderBy: [{ column: 'id', direction: 'desc' }],
      });
      expect(desc.rows.map((r) => r[0])).toEqual(['2500', '2499', '2498']);

      const filtered = await s.readRows('app_dev', 'events', {
        ...page,
        where: "kind = 'buy' AND amount IS NULL",
      });
      expect(filtered.rows.every((r) => r[1] === 'buy' && r[2] === null)).toBe(true);
      expect(await s.countRows('app_dev', 'events', "kind = 'buy' AND amount IS NULL")).toBe(
        filtered.rows.length,
      );
      expect(await s.countRows('app_dev', 'events')).toBe(2500);
    });
  });

  it('keeps LIMIT in force when the filter ends in a comment', async () => {
    await withSession(async (s) => {
      const result = await s.readRows('app_dev', 'events', { ...page, limit: 5, where: '1=1 -- ' });
      expect(result.rows).toHaveLength(5);
      expect(result.hasMore).toBe(true);
    });
  });

  it('returns every kind of value safely', async () => {
    await withSession(async (s) => {
      const { columns, rows } = await s.readRows('app_dev', 'value_types', page);
      const row = Object.fromEntries(columns.map((c, i) => [c, rows[0]?.[i]]));
      expect(row['big']).toBe('18446744073709551615');
      expect(JSON.parse(row['doc'] as string)).toEqual({ a: 1, b: [true, null] });
      expect(row['payload']).toEqual({ kind: 'binary', bytes: 4, hex: 'deadbeef' });
      expect(row['flags']).toEqual({ kind: 'binary', bytes: 1, hex: 'a5' });
      expect(row['body']).toMatchObject({ kind: 'truncated', length: 5000 });
      expect(row['missing']).toBeNull();
    });
  });

  it('reads tables with spaces or backticks in the name, and views', async () => {
    await withSession(async (s) => {
      const weird = await s.readRows('app_dev', 'we`ird', page);
      expect(weird.rows).toEqual([['1', 'ok']]);
      const view = await s.readRows('app_dev', 'paid_orders', { ...page, orderBy: [] });
      expect(view.columns).toEqual(['id', 'total']);
    });
  });

  it('explains mistakes in the filter', async () => {
    expect(await dataErrorCode('kind = ')).toBe('ER_PARSE_ERROR');
    expect(await dataErrorCode('nope = 1')).toBe('ER_BAD_FIELD_ERROR');
    // A second statement is never executed: multiple statements are off.
    expect(await dataErrorCode('1=1; DELETE FROM app_dev.events')).toBe('ER_PARSE_ERROR');
    await withSession(async (s) => expect(await s.countRows('app_dev', 'events')).toBe(2500));
  });

  it('puts the server message in the hint', async () => {
    await withSession(async (s) => {
      try {
        await s.readRows('app_dev', 'events', { ...page, where: 'nope = 1' });
        throw new Error('had moeten mislukken');
      } catch (err) {
        const e = toDbError(err);
        expect(e.message).toBe('Onbekende kolom in het filter.');
        expect(e.hint).toContain('nope');
      }
    });
  });

  it('does not let a filter write, thanks to the read-only transaction', async () => {
    await withSession(async (s) => {
      // A user-defined variable assignment is allowed; any table write is not.
      const r = await s.readRows('app_dev', 'events', {
        ...page,
        limit: 1,
        where: '(@x := 1) = 1',
      });
      expect(r.rows).toHaveLength(1);
    });
  });

  it('keeps working after a failed query (connection returned to the pool)', async () => {
    await withSession(async (s) => {
      for (let i = 0; i < 8; i++) {
        await s.readRows('app_dev', 'events', { ...page, where: 'kind =' }).catch(() => undefined);
      }
      const ok = await s.readRows('app_dev', 'events', { ...page, limit: 1 });
      expect(ok.rows).toHaveLength(1);
    });
  });
});

describe.skipIf(!host)('mysqlDriver SQL editor', () => {
  type Session = Awaited<ReturnType<typeof mysqlDriver.open>>;
  let tab = 0;
  const newTab = () => `t${Date.now()}${tab++}`;

  async function withSession<T>(fn: (s: Session) => Promise<T>, readOnly = false) {
    const session = await mysqlDriver.open({ ...base, readOnly });
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  it('returns rows with column types and applies the row limit', async () => {
    await withSession(async (s) => {
      const { results } = await s.runScript(newTab(), {
        statements: ['SELECT id, kind, amount, created_at FROM events ORDER BY id'],
        maxRows: 100,
      });
      const r = results[0]!;
      expect(r.kind).toBe('rows');
      if (r.kind !== 'rows') return;
      expect(r.rows).toHaveLength(100);
      expect(r.truncated).toBe(true);
      expect(r.columns.map((c) => c.type)).toEqual(['int', 'varchar', 'decimal', 'datetime']);
      expect(r.rows[0]).toEqual(['1', 'view', '1.50', '2026-01-01 00:01:00']);
    });
  });

  it('respects an explicit LIMIT and reports no truncation below the limit', async () => {
    await withSession(async (s) => {
      const { results } = await s.runScript(newTab(), {
        statements: ['SELECT id FROM events ORDER BY id LIMIT 5'],
        maxRows: 1000,
      });
      expect(results[0]).toMatchObject({ kind: 'rows', truncated: false });
    });
  });

  it('runs several statements in one session: USE, variables, writes', async () => {
    await withSession(async (s) => {
      const id = newTab();
      const run = (...statements: string[]) => s.runScript(id, { statements, maxRows: 1000 });

      const first = await run(
        'USE app_dev',
        'DROP TABLE IF EXISTS sql_scratch',
        'CREATE TABLE sql_scratch (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(10))',
        "INSERT INTO sql_scratch (v) VALUES ('a'), ('b')",
        "UPDATE sql_scratch SET v = 'c' WHERE id = 2",
        'SET @answer = 42',
      );
      expect(first.database).toBe('app_dev');
      expect(first.results.map((r) => r.kind)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      expect(first.results[3]).toMatchObject({ affectedRows: 2, insertId: '1' });
      expect(first.results[4]).toMatchObject({ affectedRows: 1 });

      // Same tab, same session: the variable survives.
      const second = await run('SELECT @answer AS answer, (SELECT GROUP_CONCAT(v) FROM sql_scratch) AS vs');
      expect(second.results[0]).toMatchObject({ kind: 'rows', rows: [['42', 'a,c']] });

      // Another tab has its own session.
      const other = await s.runScript(newTab(), { statements: ['SELECT @answer'], maxRows: 10 });
      expect(other.results[0]).toMatchObject({ rows: [[null]] });

      await run('DROP TABLE sql_scratch');
    });
  });

  it('stops at the first error and reports the server message', async () => {
    await withSession(async (s) => {
      const { results } = await s.runScript(newTab(), {
        statements: ['SELECT 1', 'SELEC 2', 'SELECT 3'],
        maxRows: 10,
      });
      expect(results.map((r) => r.kind)).toEqual(['rows', 'error']);
      const err = results[1]!;
      if (err.kind !== 'error') return;
      expect(err.index).toBe(1);
      expect(err.error.code).toBe('ER_PARSE_ERROR');
      expect(err.error.message).toContain('SELEC 2');
    });
  });

  it('returns the result sets of a procedure call', async () => {
    await withSession(async (s) => {
      const { results } = await s.runScript(newTab(), { statements: ['CALL refresh_stats()'], maxRows: 10 });
      expect(results[0]).toMatchObject({ kind: 'rows', rows: [['1']] });
    });
  });

  it('rolls back an open transaction when the tab is closed', async () => {
    await withSession(async (s) => {
      const setup = newTab();
      await s.runScript(setup, {
        statements: ['DROP TABLE IF EXISTS sql_tx', 'CREATE TABLE sql_tx (id INT PRIMARY KEY)'],
        maxRows: 10,
      });
      const tx = newTab();
      await s.runScript(tx, { statements: ['BEGIN', 'INSERT INTO sql_tx VALUES (1)'], maxRows: 10 });
      await s.closeEditor(tx);
      const check = await s.runScript(setup, { statements: ['SELECT COUNT(*) FROM sql_tx'], maxRows: 10 });
      expect(check.results[0]).toMatchObject({ rows: [['0']] });
      await s.runScript(setup, { statements: ['DROP TABLE sql_tx'], maxRows: 10 });
    });
  });

  it('stops a long query on request', async () => {
    await withSession(async (s) => {
      const id = newTab();
      const started = Date.now();
      const running = s.runScript(id, {
        statements: ['SELECT COUNT(*) FROM events a, events b, events c'],
        maxRows: 10,
      });
      await new Promise((r) => setTimeout(r, 500));
      await s.cancelScript(id);
      const { results } = await running;
      expect(results[0]).toMatchObject({ kind: 'error', error: { code: 'ER_QUERY_INTERRUPTED' } });
      expect(Date.now() - started).toBeLessThan(5000);
      // The tab keeps working afterwards.
      const after = await s.runScript(id, { statements: ['SELECT 1'], maxRows: 10 });
      expect(after.results[0]).toMatchObject({ kind: 'rows' });
    });
  });

  it('refuses writes on a read-only connection, also when they hide in a function', async () => {
    await withSession(async (s) => {
      const id = newTab();
      const blocked = await s.runScript(id, { statements: ["INSERT INTO counter VALUES (99)"], maxRows: 10 });
      expect(blocked.results[0]).toMatchObject({ kind: 'error', error: { code: 'READ_ONLY_CONNECTION' } });

      const lifted = await s.runScript(id, {
        statements: ['SET SESSION TRANSACTION READ WRITE'],
        maxRows: 10,
      });
      expect(lifted.results[0]).toMatchObject({ error: { code: 'READ_ONLY_CONNECTION' } });

      // SELECT bump() looks like a read; the server's read-only session still refuses it.
      const hidden = await s.runScript(id, { statements: ['SELECT bump()'], maxRows: 10 });
      expect(hidden.results[0]).toMatchObject({
        kind: 'error',
        error: { code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' },
      });

      const read = await s.runScript(id, { statements: ['SELECT COUNT(*) FROM counter'], maxRows: 10 });
      expect(read.results[0]).toMatchObject({ kind: 'rows' });
    }, true);
  });
});
