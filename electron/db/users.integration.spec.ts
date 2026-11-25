/**
 * User management against real servers (MYSQL_TEST_HOST, PG_TEST_HOST, MSSQL_TEST_HOST), as the
 * administrator dbv_admin from the setup scripts: create, grant, read back, revoke, password,
 * roles, drop.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbType } from '../../shared/models';
import type { DbUserRef, UserDialect } from '../../shared/user-sql';
import type { ConnectionConfig, DbSession } from './driver';
import { getDriver } from './driver-registry';
import { applyUserChanges, listUsers, userDetails } from './users';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

interface Server {
  type: UserDialect;
  host?: string;
  port: number;
  password: string;
  schema: string;
  table: string;
  user: DbUserRef;
  /** A role the test user can be made a member of. */
  role: { name: string; server: boolean };
}

const servers: Server[] = [
  {
    type: 'mysql',
    host: process.env['MYSQL_TEST_HOST'],
    port: Number(process.env['MYSQL_TEST_PORT'] ?? 3306),
    password: 'admin123',
    schema: 'app_dev',
    table: 'orders',
    user: { name: 'dbv_test_user', host: '%' },
    role: { name: '', server: false },
  },
  {
    type: 'postgres',
    host: process.env['PG_TEST_HOST'],
    port: Number(process.env['PG_TEST_PORT'] ?? 5432),
    password: 'admin123',
    schema: 'public',
    table: 'orders',
    user: { name: 'dbv_test_user' },
    role: { name: 'pg_read_all_data', server: false },
  },
  {
    type: 'mssql',
    host: process.env['MSSQL_TEST_HOST'],
    port: Number(process.env['MSSQL_TEST_PORT'] ?? 1433),
    password: 'Admin123!dbv',
    schema: 'dbo',
    table: 'orders',
    user: { name: 'dbv_test_user' },
    role: { name: 'db_datareader', server: false },
  },
];

for (const server of servers) {
  describe.runIf(server.host)(`users on ${server.type}`, () => {
    let session: DbSession;
    const user = server.user;
    const grantsOn = async (scope: { database?: string; table?: string }) => {
      const d = await userDetails(session, server.type, user);
      return (
        d.grants.find((g) => g.scope.database === scope.database && g.scope.table === scope.table)
          ?.privileges ?? []
      ).sort();
    };

    beforeAll(async () => {
      session = await getDriver(server.type as DbType).open({
        type: server.type,
        host: server.host!,
        port: server.port,
        database: 'app_dev',
        user: 'dbv_admin',
        password: server.password,
        ssl: false,
        allowSelfSigned: false,
        readOnly: false,
      } as ConnectionConfig);
      await applyUserChanges(session, server.type, false, [{ action: 'drop', user }]).catch(
        () => undefined,
      );
    });

    afterAll(async () => {
      if (!session) return;
      await applyUserChanges(session, server.type, false, [{ action: 'drop', user }]).catch(
        () => undefined,
      );
      await session.close();
    });

    it('creates a user that shows in the list', async () => {
      await applyUserChanges(session, server.type, false, [
        { action: 'create', user, password: 'Eerste!Wachtw00rd' },
      ]);
      const list = await listUsers(session, server.type);
      const found = list.find((u) => u.name === user.name && u.host === user.host);
      expect(found).toMatchObject({ canLogin: true, superuser: false });
      expect(list.some((u) => u.name === 'dbv_admin' && u.superuser)).toBe(true);
    });

    it('grants on a database and a table, reads them back and revokes', async () => {
      const db = { database: server.schema };
      const table = { database: server.schema, table: server.table };
      const dbPrivs = server.type === 'postgres' ? ['USAGE', 'SELECT'] : ['SELECT', 'INSERT'];
      await applyUserChanges(session, server.type, false, [
        { action: 'grant', user, scope: db, privileges: dbPrivs },
        { action: 'grant', user, scope: table, privileges: ['UPDATE'] },
      ]);
      expect(await grantsOn(db)).toEqual([...dbPrivs].sort());
      expect(await grantsOn(table)).toEqual(['UPDATE']);

      await applyUserChanges(session, server.type, false, [
        { action: 'revoke', user, scope: db, privileges: [dbPrivs[1]!] },
        { action: 'revoke', user, scope: table, privileges: ['UPDATE'] },
      ]);
      expect(await grantsOn(db)).toEqual([dbPrivs[0]!]);
      expect(await grantsOn(table)).toEqual([]);
    });

    it.runIf(server.type === 'mysql')(
      'reads server-wide privileges and the grant option',
      async () => {
        await applyUserChanges(session, server.type, false, [
          { action: 'grant', user, scope: {}, privileges: ['PROCESS', 'GRANT OPTION'] },
        ]);
        expect(await grantsOn({})).toEqual(['GRANT OPTION', 'PROCESS']);
        await applyUserChanges(session, server.type, false, [
          { action: 'revoke', user, scope: {}, privileges: ['PROCESS', 'GRANT OPTION'] },
        ]);
        expect(await grantsOn({})).toEqual([]);
      },
    );

    it.runIf(server.type === 'postgres')('sets role attributes as server privileges', async () => {
      await applyUserChanges(session, server.type, false, [
        { action: 'grant', user, scope: {}, privileges: ['CREATEDB'] },
      ]);
      expect(await grantsOn({})).toEqual(['CREATEDB', 'LOGIN']);
      await applyUserChanges(session, server.type, false, [
        { action: 'revoke', user, scope: {}, privileges: ['CREATEDB'] },
      ]);
      expect(await grantsOn({})).toEqual(['LOGIN']);
    });

    it.runIf(server.type !== 'mysql')('adds and removes a role', async () => {
      await applyUserChanges(session, server.type, false, [
        { action: 'role', user, role: server.role, member: true },
      ]);
      let d = await userDetails(session, server.type, user);
      expect(d.roles.map((r) => r.name)).toContain(server.role.name);
      expect(d.availableRoles.map((r) => r.name)).toContain(server.role.name);
      await applyUserChanges(session, server.type, false, [
        { action: 'role', user, role: server.role, member: false },
      ]);
      d = await userDetails(session, server.type, user);
      expect(d.roles.map((r) => r.name)).not.toContain(server.role.name);
      if (server.type === 'mssql') expect(d.mapped).toBe(true);
    });

    it('changes the password: the user logs in with the new one', async () => {
      await applyUserChanges(session, server.type, false, [
        { action: 'password', user, password: 'Tweede!Wachtw00rd' },
      ]);
      const as = await getDriver(server.type as DbType).open({
        type: server.type,
        host: server.host!,
        port: server.port,
        database: server.type === 'postgres' ? 'app_dev' : '',
        user: user.name,
        password: 'Tweede!Wachtw00rd',
        ssl: false,
        allowSelfSigned: false,
        readOnly: false,
      } as ConnectionConfig);
      await as.close();
    });

    it('refuses changes on a read-only connection, and stops at a refused statement', async () => {
      await expect(
        applyUserChanges(session, server.type, true, [{ action: 'drop', user }]),
      ).rejects.toThrow(/alleen-lezen/);
      await expect(
        applyUserChanges(session, server.type, false, [
          { action: 'create', user, password: 'Nog!Een1keer' },
        ]),
      ).rejects.toThrow();
    });

    it('drops the user', async () => {
      await applyUserChanges(session, server.type, false, [{ action: 'drop', user }]);
      const list = await listUsers(session, server.type);
      expect(list.some((u) => u.name === user.name)).toBe(false);
    });
  });
}
