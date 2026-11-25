import { describe, expect, it } from 'vitest';
import {
  diffPrivileges,
  parseMysqlGrant,
  privilegeOptions,
  userChangeSql,
  userChangeStatements,
} from './user-sql';

const my = { name: "o'brien", host: '%' };
const pg = { name: 'lezer' };

describe('user SQL', () => {
  it('creates, changes the password and drops, with the password hidden in the preview', () => {
    expect(
      userChangeStatements('mysql', { action: 'create', user: my, password: 'geheim' }),
    ).toEqual(["CREATE USER 'o''brien'@'%' IDENTIFIED BY 'geheim'"]);
    expect(userChangeSql('mysql', { action: 'create', user: my, password: 'geheim' })).toBe(
      "CREATE USER 'o''brien'@'%' IDENTIFIED BY '••••••••'",
    );
    expect(userChangeSql('postgres', { action: 'password', user: pg, password: 'x' })).toBe(
      'ALTER ROLE "lezer" WITH PASSWORD \'••••••••\'',
    );
    expect(userChangeStatements('mssql', { action: 'create', user: pg, password: 'x' })).toEqual([
      "CREATE LOGIN [lezer] WITH PASSWORD = N'x'",
      'CREATE USER [lezer] FOR LOGIN [lezer]',
    ]);
    expect(userChangeStatements('postgres', { action: 'drop', user: pg })).toEqual([
      'REASSIGN OWNED BY "lezer" TO CURRENT_USER',
      'DROP OWNED BY "lezer"',
      'DROP ROLE "lezer"',
    ]);
  });

  it('grants and revokes per scope in each dialect', () => {
    const grant = (d: 'mysql' | 'postgres' | 'mssql', scope: object, privileges: string[]) =>
      userChangeStatements(d, {
        action: 'grant',
        user: d === 'mysql' ? my : pg,
        scope,
        privileges,
      });
    expect(grant('mysql', {}, ['PROCESS', 'GRANT OPTION'])).toEqual([
      "GRANT PROCESS ON *.* TO 'o''brien'@'%' WITH GRANT OPTION",
    ]);
    expect(grant('mysql', { database: 'shop' }, ['GRANT OPTION'])).toEqual([
      "GRANT USAGE ON `shop`.* TO 'o''brien'@'%' WITH GRANT OPTION",
    ]);
    expect(grant('mysql', { database: 'shop', table: 'orders' }, ['SELECT'])).toEqual([
      "GRANT SELECT ON `shop`.`orders` TO 'o''brien'@'%'",
    ]);
    expect(grant('postgres', { database: 'shop' }, ['USAGE', 'SELECT'])).toEqual([
      'GRANT USAGE ON SCHEMA "shop" TO "lezer"',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "shop" TO "lezer"',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "shop" GRANT SELECT ON TABLES TO "lezer"',
    ]);
    expect(grant('postgres', {}, ['CREATEDB'])).toEqual(['ALTER ROLE "lezer" WITH CREATEDB']);
    expect(
      userChangeStatements('postgres', {
        action: 'revoke',
        user: pg,
        scope: {},
        privileges: ['CREATEDB'],
      }),
    ).toEqual(['ALTER ROLE "lezer" WITH NOCREATEDB']);
    expect(grant('mssql', { database: 'dbo' }, ['SELECT', 'EXECUTE'])).toEqual([
      'GRANT SELECT, EXECUTE ON SCHEMA::[dbo] TO [lezer]',
    ]);
    expect(
      userChangeStatements('mssql', {
        action: 'role',
        user: pg,
        role: { name: 'sysadmin', server: true },
        member: true,
      }),
    ).toEqual(['ALTER SERVER ROLE [sysadmin] ADD MEMBER [lezer]']);
    expect(privilegeOptions('mssql', 'server')).toEqual([]);
  });

  it('turns ticks into the revokes and grants that get there', () => {
    expect(
      diffPrivileges({ database: 'shop' }, ['SELECT', 'DELETE'], ['SELECT', 'INSERT'], my),
    ).toEqual([
      { action: 'revoke', user: my, scope: { database: 'shop' }, privileges: ['DELETE'] },
      { action: 'grant', user: my, scope: { database: 'shop' }, privileges: ['INSERT'] },
    ]);
    expect(diffPrivileges({}, ['SELECT'], ['SELECT'], my)).toEqual([]);
  });
});

describe('SHOW GRANTS', () => {
  it('reads privileges per scope, ALL and the grant option', () => {
    expect(parseMysqlGrant('GRANT USAGE ON *.* TO `viewer`@`%`')).toEqual({
      kind: 'privileges',
      set: { scope: {}, privileges: [] },
    });
    expect(
      parseMysqlGrant('GRANT SELECT, INSERT ON `app\\_dev`.* TO `viewer`@`%` WITH GRANT OPTION'),
    ).toEqual({
      kind: 'privileges',
      set: { scope: { database: 'app_dev' }, privileges: ['SELECT', 'INSERT', 'GRANT OPTION'] },
    });
    expect(parseMysqlGrant('GRANT UPDATE ON `shop`.`orders` TO `viewer`@`%`')).toEqual({
      kind: 'privileges',
      set: { scope: { database: 'shop', table: 'orders' }, privileges: ['UPDATE'] },
    });
    const all = parseMysqlGrant('GRANT ALL PRIVILEGES ON `shop`.* TO `a`@`%`');
    expect(all?.kind === 'privileges' && all.set.privileges).toEqual(
      privilegeOptions('mysql', 'database').filter((p) => p !== 'GRANT OPTION'),
    );
    // Old MySQL adds the password hash; MariaDB the password on the USAGE line.
    expect(
      parseMysqlGrant("GRANT USAGE ON *.* TO 'a'@'%' IDENTIFIED BY PASSWORD '*ABC'")?.kind,
    ).toBe('privileges');
  });

  it('reads role grants, and leaves column grants and proxies as text', () => {
    expect(parseMysqlGrant('GRANT `lezers` TO `viewer`@`%`')).toEqual({
      kind: 'role',
      role: 'lezers',
    });
    expect(
      parseMysqlGrant('GRANT SELECT (`id`, `naam`) ON `shop`.`klanten` TO `a`@`%`'),
    ).toBeNull();
    expect(
      parseMysqlGrant("GRANT PROXY ON ''@'%' TO 'root'@'localhost' WITH GRANT OPTION"),
    ).toBeNull();
  });
});
