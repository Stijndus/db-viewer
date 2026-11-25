/**
 * Database users: what can be granted per dialect, and the statements for every change (shown
 * before they run, with the password hidden). MySQL/MariaDB accounts are `name`@`host`;
 * PostgreSQL has roles; SQL Server has logins with a user in the connection's database.
 * "Database" here is the tree's container: a schema in PostgreSQL and SQL Server.
 */
import { qualifiedName, quoteIdent, stringLiteral } from './dialect';
import type { DbType } from './models';

export type UserDialect = 'mysql' | 'postgres' | 'mssql';

export function hasUsers(type: DbType): type is UserDialect {
  return type !== 'sqlite';
}

export interface DbUserRef {
  name: string;
  /** MySQL/MariaDB only: where the account may log in from ('%' = anywhere). */
  host?: string;
}

export interface DbUserSummary extends DbUserRef {
  canLogin: boolean;
  superuser: boolean;
}

/** Server-wide (no database), a database (or schema), or one table. */
export interface PrivilegeScope {
  database?: string;
  table?: string;
}

export interface PrivilegeSet {
  scope: PrivilegeScope;
  privileges: string[];
}

export interface DbRoleRef {
  name: string;
  /** SQL Server: a server role (sysadmin, …) rather than a database role. */
  server: boolean;
}

export interface UserDetails {
  grants: PrivilegeSet[];
  roles: DbRoleRef[];
  availableRoles: DbRoleRef[];
  /** SQL Server: the login has a user in the connection's database. */
  mapped?: boolean;
  /** Grants the matrix cannot show (column grants, proxies, …), as the server wrote them. */
  other: string[];
}

export type UserChange =
  | { action: 'create'; user: DbUserRef; password: string }
  | { action: 'drop'; user: DbUserRef }
  | { action: 'password'; user: DbUserRef; password: string }
  | { action: 'grant' | 'revoke'; user: DbUserRef; scope: PrivilegeScope; privileges: string[] }
  | { action: 'role'; user: DbUserRef; role: DbRoleRef; member: boolean }
  /** SQL Server: give the login a user in the connection's database. */
  | { action: 'map'; user: DbUserRef };

export type ScopeLevel = 'server' | 'database' | 'table';

export function scopeLevel(scope: PrivilegeScope): ScopeLevel {
  return scope.table ? 'table' : scope.database ? 'database' : 'server';
}

const MYSQL_TABLE = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'REFERENCES',
  'TRIGGER',
  'CREATE VIEW',
  'SHOW VIEW',
];
const MYSQL_DATABASE = [
  ...MYSQL_TABLE,
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EXECUTE',
  'EVENT',
  'LOCK TABLES',
  'CREATE TEMPORARY TABLES',
];
const MYSQL_SERVER = [
  ...MYSQL_DATABASE,
  'CREATE USER',
  'PROCESS',
  'RELOAD',
  'SHOW DATABASES',
  'FILE',
  'SUPER',
  'SHUTDOWN',
  'REPLICATION CLIENT',
  'REPLICATION SLAVE',
];
const PG_TABLE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
/** Role attributes: what PostgreSQL has instead of server-wide privileges. */
const PG_SERVER = ['LOGIN', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'SUPERUSER'];
/** On the schema itself; the rest of a schema row is granted on all its tables. */
const PG_SCHEMA_OWN = ['USAGE', 'CREATE'];
const MSSQL_TABLE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'ALTER'];
const MSSQL_SCHEMA = [...MSSQL_TABLE, 'EXECUTE', 'VIEW DEFINITION', 'CONTROL'];

/** The privileges a level can show as checkboxes, in this order. */
export function privilegeOptions(dialect: UserDialect, level: ScopeLevel): string[] {
  switch (dialect) {
    case 'mysql':
      return [
        ...(level === 'server'
          ? MYSQL_SERVER
          : level === 'database'
            ? MYSQL_DATABASE
            : MYSQL_TABLE),
        'GRANT OPTION',
      ];
    case 'postgres':
      return level === 'server'
        ? PG_SERVER
        : level === 'database'
          ? [...PG_SCHEMA_OWN, ...PG_TABLE]
          : PG_TABLE;
    case 'mssql':
      return level === 'server' ? [] : level === 'database' ? MSSQL_SCHEMA : MSSQL_TABLE;
  }
}

/** One-click sets for a scope: read only, read and write, everything. */
export function quickSets(
  dialect: UserDialect,
  level: ScopeLevel,
): { label: string; privileges: string[] }[] {
  if (level === 'server' && dialect !== 'mysql') return [];
  const read = dialect === 'postgres' && level === 'database' ? ['USAGE', 'SELECT'] : ['SELECT'];
  const write = [...read, 'INSERT', 'UPDATE', 'DELETE'];
  const all = privilegeOptions(dialect, level).filter((p) => p !== 'GRANT OPTION');
  return [
    { label: 'Alleen lezen', privileges: read },
    { label: 'Lezen en schrijven', privileges: write },
    { label: 'Alles', privileges: all },
  ];
}

/** SQL Server database roles offered as quick choices. */
export const MSSQL_COMMON_ROLES = ['db_datareader', 'db_datawriter', 'db_ddladmin', 'db_owner'];

/** "stijn@%" for MySQL, the name elsewhere. */
export function userLabel(user: DbUserRef): string {
  return user.host !== undefined ? `${user.name}@${user.host}` : user.name;
}

function account(dialect: UserDialect, user: DbUserRef): string {
  return dialect === 'mysql'
    ? `${stringLiteral(user.name, 'mysql')}@${stringLiteral(user.host ?? '%', 'mysql')}`
    : quoteIdent(user.name, dialect);
}

const HIDDEN = "'••••••••'";

/**
 * The statements of a change, in order. With `mask`, the password shows as dots: that is what
 * the confirmation shows; the real one only goes to the server.
 */
export function userChangeStatements(
  dialect: UserDialect,
  change: UserChange,
  mask = false,
): string[] {
  const who = account(dialect, change.user);
  const pw = (p: string) =>
    mask ? (dialect === 'mssql' ? `N${HIDDEN}` : HIDDEN) : stringLiteral(p, dialect);
  switch (change.action) {
    case 'create':
      if (dialect === 'mysql') return [`CREATE USER ${who} IDENTIFIED BY ${pw(change.password)}`];
      if (dialect === 'postgres')
        return [`CREATE ROLE ${who} WITH LOGIN PASSWORD ${pw(change.password)}`];
      return [
        `CREATE LOGIN ${who} WITH PASSWORD = ${pw(change.password)}`,
        `CREATE USER ${who} FOR LOGIN ${who}`,
      ];
    case 'drop':
      if (dialect === 'mysql') return [`DROP USER ${who}`];
      // A role with privileges or objects cannot be dropped: its objects go to the current login,
      // its privileges are revoked (in this database), then it goes.
      if (dialect === 'postgres')
        return [
          `REASSIGN OWNED BY ${who} TO CURRENT_USER`,
          `DROP OWNED BY ${who}`,
          `DROP ROLE ${who}`,
        ];
      return [`DROP USER IF EXISTS ${who}`, `DROP LOGIN ${who}`];
    case 'password':
      if (dialect === 'mysql') return [`ALTER USER ${who} IDENTIFIED BY ${pw(change.password)}`];
      if (dialect === 'postgres') return [`ALTER ROLE ${who} WITH PASSWORD ${pw(change.password)}`];
      return [`ALTER LOGIN ${who} WITH PASSWORD = ${pw(change.password)}`];
    case 'map':
      if (dialect !== 'mssql') throw new Error('Alleen bij SQL Server.');
      return [`CREATE USER ${who} FOR LOGIN ${who}`];
    case 'role': {
      const role = quoteIdent(change.role.name, dialect);
      if (dialect === 'mysql')
        return [change.member ? `GRANT ${role} TO ${who}` : `REVOKE ${role} FROM ${who}`];
      if (dialect === 'postgres')
        return [change.member ? `GRANT ${role} TO ${who}` : `REVOKE ${role} FROM ${who}`];
      const kind = change.role.server ? 'SERVER ROLE' : 'ROLE';
      return [`ALTER ${kind} ${role} ${change.member ? 'ADD' : 'DROP'} MEMBER ${who}`];
    }
    case 'grant':
    case 'revoke':
      return grantStatements(dialect, change, who);
  }
}

function grantStatements(
  dialect: UserDialect,
  change: Extract<UserChange, { action: 'grant' | 'revoke' }>,
  who: string,
): string[] {
  const { scope, privileges } = change;
  const grant = change.action === 'grant';
  if (privileges.length === 0) return [];
  const verb = grant ? 'GRANT' : 'REVOKE';
  const to = grant ? 'TO' : 'FROM';
  const level = scopeLevel(scope);

  if (dialect === 'mysql') {
    const on =
      level === 'server'
        ? '*.*'
        : level === 'database'
          ? `${quoteIdent(scope.database!, 'mysql')}.*`
          : qualifiedName(scope.database!, scope.table!, 'mysql');
    const withOption = grant && privileges.includes('GRANT OPTION');
    const list = grant ? privileges.filter((p) => p !== 'GRANT OPTION') : privileges;
    const what = list.length ? list.join(', ') : 'USAGE';
    return [`${verb} ${what} ON ${on} ${to} ${who}${withOption ? ' WITH GRANT OPTION' : ''}`];
  }

  if (dialect === 'postgres') {
    if (level === 'server') {
      // Role attributes: CREATEDB or NOCREATEDB, …
      return [`ALTER ROLE ${who} WITH ${privileges.map((p) => (grant ? p : `NO${p}`)).join(' ')}`];
    }
    if (level === 'table')
      return [
        `${verb} ${privileges.join(', ')} ON ${qualifiedName(scope.database!, scope.table!, 'postgres')} ${to} ${who}`,
      ];
    const schema = quoteIdent(scope.database!, 'postgres');
    const own = privileges.filter((p) => PG_SCHEMA_OWN.includes(p));
    const tables = privileges.filter((p) => !PG_SCHEMA_OWN.includes(p));
    const out: string[] = [];
    if (own.length) out.push(`${verb} ${own.join(', ')} ON SCHEMA ${schema} ${to} ${who}`);
    if (tables.length) {
      out.push(`${verb} ${tables.join(', ')} ON ALL TABLES IN SCHEMA ${schema} ${to} ${who}`);
      // Tables made later (by this login) get the same.
      out.push(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} ${verb} ${tables.join(', ')} ON TABLES ${to} ${who}`,
      );
    }
    return out;
  }

  // SQL Server
  if (level === 'server') throw new Error('SQL Server: gebruik serverrollen.');
  const on =
    level === 'database'
      ? `SCHEMA::${quoteIdent(scope.database!, 'mssql')}`
      : qualifiedName(scope.database!, scope.table!, 'mssql');
  return [`${verb} ${privileges.join(', ')} ON ${on} ${to} ${who}`];
}

/** The whole change as one text, for the confirmation. */
export function userChangeSql(dialect: UserDialect, change: UserChange): string {
  const statements = userChangeStatements(dialect, change, true);
  return statements.length === 1 ? statements[0]! : statements.map((s) => s + ';').join('\n');
}

/**
 * From what is granted now to what is ticked: the grants and revokes that get there, per scope.
 */
export function diffPrivileges(
  scope: PrivilegeScope,
  before: string[],
  after: string[],
  user: DbUserRef,
): Extract<UserChange, { action: 'grant' | 'revoke' }>[] {
  const add = after.filter((p) => !before.includes(p));
  const remove = before.filter((p) => !after.includes(p));
  const out: Extract<UserChange, { action: 'grant' | 'revoke' }>[] = [];
  if (remove.length) out.push({ action: 'revoke', user, scope, privileges: remove });
  if (add.length) out.push({ action: 'grant', user, scope, privileges: add });
  return out;
}

// ── Reading MySQL's SHOW GRANTS ──────────────────────────────────────

/** Splits "SELECT, INSERT (`a`, `b`), UPDATE" on the commas outside parentheses. */
function splitPrivileges(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function unquote(name: string): string {
  const n = name.trim();
  if (n.startsWith('`') && n.endsWith('`')) return n.slice(1, -1).replace(/``/g, '`');
  return n;
}

/**
 * One line of MySQL's SHOW GRANTS as a privilege set; a role grant as a role; anything else
 * (column grants, PROXY) as null, shown as text.
 */
export function parseMysqlGrant(
  line: string,
): { kind: 'privileges'; set: PrivilegeSet } | { kind: 'role'; role: string } | null {
  const m =
    /^GRANT (.+?) ON (?:TABLE |PROCEDURE |FUNCTION )?(\*|`(?:[^`]|``)*`)\.(\*|`(?:[^`]|``)*`) TO .+?( WITH GRANT OPTION)?$/s.exec(
      line.replace(/ IDENTIFIED BY PASSWORD '[^']*'/, '').replace(/ REQUIRE .*?(?= WITH|$)/, ''),
    );
  if (!m) {
    const role = /^GRANT ((?:`(?:[^`]|``)*`|[\w$]+)(?:\s*,\s*(?:`(?:[^`]|``)*`|[\w$]+))*) TO /.exec(
      line,
    );
    if (role && !/ ON /.test(line)) return { kind: 'role', role: unquote(role[1]!.split(',')[0]!) };
    return null;
  }
  const [, privs, db, table, option] = m;
  const list = splitPrivileges(privs!);
  if (list.some((p) => p.includes('('))) return null; // column grants: shown as text
  let privileges = list
    .map((p) => p.toUpperCase())
    .map((p) => (p === 'ALL' ? 'ALL PRIVILEGES' : p))
    .filter((p) => p !== 'USAGE');
  const scope: PrivilegeScope =
    db === '*'
      ? {}
      : table === '*'
        ? { database: unescapeLike(unquote(db!)) }
        : { database: unescapeLike(unquote(db!)), table: unquote(table!) };
  if (privileges.includes('ALL PRIVILEGES')) {
    const level = scopeLevel(scope);
    privileges = privilegeOptions('mysql', level).filter((p) => p !== 'GRANT OPTION');
  }
  if (option) privileges.push('GRANT OPTION');
  return { kind: 'privileges', set: { scope, privileges } };
}

/** MySQL writes `app\_dev` for a database grant (a LIKE pattern): the name is app_dev. */
function unescapeLike(name: string): string {
  return name.replace(/\\([_%\\])/g, '$1');
}
