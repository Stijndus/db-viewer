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

  it('returns no columns for a table the user cannot see', async () => {
    const session = await mysqlDriver.open(base);
    expect(await session.listColumns('secret_db', 'hidden')).toEqual([]);
    expect(await session.listObjects('secret_db')).toEqual([]);
    await session.close();
  });
});
