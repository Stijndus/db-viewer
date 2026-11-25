import { randomUUID } from 'node:crypto';
import { stringLiteral } from '../../shared/dialect';
import type { Cell, StatementResult } from '../../shared/models';
import {
  parseMysqlGrant,
  userChangeStatements,
  type DbRoleRef,
  type DbUserRef,
  type DbUserSummary,
  type PrivilegeSet,
  type UserChange,
  type UserDetails,
  type UserDialect,
} from '../../shared/user-sql';
import { AppError } from '../ipc/errors';
import type { DbSession } from './driver';

/**
 * Database users, read and changed with plain SQL on a connection of its own (closed after).
 * Every value in that SQL is a quoted literal: names come from the user list or the form.
 */
async function run(session: DbSession, statements: string[]): Promise<StatementResult[]> {
  const tab = `users-${randomUUID()}`;
  try {
    const result = await session.runScript(tab, { statements, maxRows: 100_000 });
    return result.results;
  } finally {
    await session.closeEditor(tab).catch(() => undefined);
  }
}

type Row = Cell[];

/** Rows of one query; a refusal by the server becomes a clear message. */
async function rows(session: DbSession, sql: string): Promise<Row[]> {
  const [r] = await run(session, [sql]);
  if (!r) return [];
  if (r.kind === 'error') {
    if (/denied|permission|privilege|not allowed/i.test(r.error.message))
      throw new AppError(
        'ACCESS_DENIED',
        'Deze verbinding mag de gebruikers van de server niet bekijken.',
        `De server zegt: ${r.error.message}`,
      );
    throw new AppError(r.error.code, r.error.message, r.error.hint);
  }
  return r.kind === 'rows' ? r.rows : [];
}

const text = (c: Cell | undefined) =>
  c === null || c === undefined ? '' : typeof c === 'string' ? c : '';
const truthy = (c: Cell | undefined) => ['1', 't', 'true', 'Y', 'y'].includes(text(c));

export async function listUsers(
  session: DbSession,
  dialect: UserDialect,
): Promise<DbUserSummary[]> {
  if (dialect === 'mysql') {
    // MariaDB keeps roles in mysql.user with an empty host: those are roles, not accounts.
    const all = await rows(
      session,
      // Compared here, not in SQL: mysql.user's collation differs from the session's in MariaDB.
      'SELECT User, Host, Super_priv FROM mysql.user ORDER BY User, Host',
    );
    return all
      .filter((r) => text(r[1]) !== '')
      .map((r) => ({
        name: text(r[0]),
        host: text(r[1]),
        canLogin: true,
        superuser: truthy(r[2]),
      }));
  }
  if (dialect === 'postgres') {
    const all = await rows(
      session,
      "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname",
    );
    return all.map((r) => ({ name: text(r[0]), canLogin: truthy(r[1]), superuser: truthy(r[2]) }));
  }
  const all = await rows(
    session,
    `SELECT sp.name, CASE WHEN sp.is_disabled = 1 THEN 0 ELSE 1 END,
            CASE WHEN IS_SRVROLEMEMBER('sysadmin', sp.name) = 1 THEN 1 ELSE 0 END
       FROM sys.server_principals sp
      WHERE sp.type IN ('S', 'U', 'G') AND sp.name NOT LIKE '##%' AND sp.name NOT LIKE 'NT %'
      ORDER BY sp.name`,
  );
  return all.map((r) => ({ name: text(r[0]), canLogin: truthy(r[1]), superuser: truthy(r[2]) }));
}

export async function userDetails(
  session: DbSession,
  dialect: UserDialect,
  user: DbUserRef,
): Promise<UserDetails> {
  if (dialect === 'mysql') return mysqlDetails(session, user);
  if (dialect === 'postgres') return postgresDetails(session, user);
  return mssqlDetails(session, user);
}

async function mysqlDetails(session: DbSession, user: DbUserRef): Promise<UserDetails> {
  const who = `${stringLiteral(user.name, 'mysql')}@${stringLiteral(user.host ?? '%', 'mysql')}`;
  const lines = (await rows(session, `SHOW GRANTS FOR ${who}`)).map((r) => text(r[0]));
  const grants: PrivilegeSet[] = [];
  const roles: DbRoleRef[] = [];
  const other: string[] = [];
  for (const line of lines) {
    const parsed = parseMysqlGrant(line);
    if (!parsed) other.push(line);
    else if (parsed.kind === 'role') roles.push({ name: parsed.role, server: false });
    else if (parsed.set.privileges.length || !parsed.set.scope.database) {
      const same = grants.find(
        (g) =>
          g.scope.database === parsed.set.scope.database &&
          g.scope.table === parsed.set.scope.table,
      );
      if (same) same.privileges = [...new Set([...same.privileges, ...parsed.set.privileges])];
      else grants.push(parsed.set);
    }
  }
  // MariaDB roles (empty host); MySQL 8 roles are accounts that cannot log in: not listed here.
  const available = await rows(session, 'SELECT User, Host FROM mysql.user')
    .then((r) =>
      r
        .filter((x) => text(x[1]) === '' && text(x[0]) !== '')
        .map((x) => ({ name: text(x[0]), server: false })),
    )
    .catch(() => []);
  return {
    grants: grants.filter((g) => g.privileges.length || !g.scope.database),
    roles,
    availableRoles: available,
    other,
  };
}

async function postgresDetails(session: DbSession, user: DbUserRef): Promise<UserDetails> {
  const name = stringLiteral(user.name, 'postgres');
  const oid = `(SELECT oid FROM pg_roles WHERE rolname = ${name})`;
  const [attrs] = await rows(
    session,
    `SELECT rolcanlogin, rolcreatedb, rolcreaterole, rolreplication, rolsuper FROM pg_roles WHERE rolname = ${name}`,
  );
  if (!attrs) throw new AppError('NOT_FOUND', `De rol ${user.name} bestaat niet (meer).`);
  const server = ['LOGIN', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'SUPERUSER'].filter((_, i) =>
    truthy(attrs[i]),
  );
  const schemaRows = await rows(
    session,
    `SELECT n.nspname, a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE a.grantee = ${oid} ORDER BY n.nspname`,
  );
  const tableRows = await rows(
    session,
    `SELECT n.nspname, c.relname, a.privilege_type
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
      WHERE a.grantee = ${oid} AND c.relkind IN ('r', 'p', 'v', 'm')
      ORDER BY n.nspname, c.relname`,
  );
  const counts = await rows(
    session,
    `SELECT n.nspname, count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      GROUP BY n.nspname`,
  );
  const tablesIn = new Map(counts.map((r) => [text(r[0]), Number(text(r[1]))]));

  const bySchema = new Map<string, Set<string>>();
  for (const r of schemaRows) {
    const s = bySchema.get(text(r[0])) ?? new Set<string>();
    s.add(text(r[1]));
    bySchema.set(text(r[0]), s);
  }
  // A table privilege on every table of a schema is shown on the schema (ALL TABLES IN SCHEMA).
  const perTable = new Map<string, Map<string, Set<string>>>();
  for (const r of tableRows) {
    const schema = text(r[0]);
    const tables = perTable.get(schema) ?? new Map<string, Set<string>>();
    const set = tables.get(text(r[1])) ?? new Set<string>();
    set.add(text(r[2]));
    tables.set(text(r[1]), set);
    perTable.set(schema, tables);
  }
  const grants: PrivilegeSet[] = [{ scope: {}, privileges: server }];
  const schemas = new Set([...bySchema.keys(), ...perTable.keys()]);
  for (const schema of [...schemas].sort()) {
    const tables = perTable.get(schema) ?? new Map<string, Set<string>>();
    const total = tablesIn.get(schema) ?? 0;
    const everywhere = [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ].filter((p) => total > 0 && [...tables.values()].filter((s) => s.has(p)).length >= total);
    const own = [...(bySchema.get(schema) ?? [])];
    if (own.length || everywhere.length)
      grants.push({ scope: { database: schema }, privileges: [...own, ...everywhere] });
    for (const [table, set] of tables) {
      const rest = [...set].filter((p) => !everywhere.includes(p));
      if (rest.length) grants.push({ scope: { database: schema, table }, privileges: rest });
    }
  }
  const memberOf = await rows(
    session,
    `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = ${oid} ORDER BY 1`,
  );
  const available = await rows(
    session,
    `SELECT rolname FROM pg_roles
      WHERE rolname <> ${name}
        AND (rolname !~ '^pg_' OR rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_monitor'))
      ORDER BY 1`,
  );
  return {
    grants,
    roles: memberOf.map((r) => ({ name: text(r[0]), server: false })),
    availableRoles: available.map((r) => ({ name: text(r[0]), server: false })),
    other: [],
  };
}

async function mssqlDetails(session: DbSession, user: DbUserRef): Promise<UserDetails> {
  const name = stringLiteral(user.name, 'mssql');
  const serverRoles = await rows(
    session,
    `SELECT r.name FROM sys.server_role_members m
       JOIN sys.server_principals r ON r.principal_id = m.role_principal_id
       JOIN sys.server_principals u ON u.principal_id = m.member_principal_id
      WHERE u.name = ${name}`,
  );
  const dbUser = await rows(
    session,
    `SELECT dp.name FROM sys.database_principals dp
       JOIN sys.server_principals sp ON sp.sid = dp.sid WHERE sp.name = ${name}`,
  );
  const mapped = dbUser.length > 0;
  const dbName = stringLiteral(mapped ? text(dbUser[0]![0]) : user.name, 'mssql');
  const dbRoles = mapped
    ? await rows(
        session,
        `SELECT r.name FROM sys.database_role_members m
           JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
           JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
          WHERE u.name = ${dbName}`,
      )
    : [];
  const perms = mapped
    ? await rows(
        session,
        `SELECT p.class, p.permission_name,
                CASE WHEN p.class = 3 THEN SCHEMA_NAME(p.major_id) ELSE OBJECT_SCHEMA_NAME(p.major_id) END,
                CASE WHEN p.class = 1 THEN OBJECT_NAME(p.major_id) ELSE NULL END
           FROM sys.database_permissions p
           JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
          WHERE u.name = ${dbName} AND p.state IN ('G', 'W') AND p.class IN (1, 3) AND p.minor_id = 0`,
      )
    : [];
  const grants: PrivilegeSet[] = [];
  for (const r of perms) {
    const scope =
      text(r[0]) === '3' ? { database: text(r[2]) } : { database: text(r[2]), table: text(r[3]) };
    const same = grants.find(
      (g) =>
        g.scope.database === scope.database &&
        g.scope.table === (scope as { table?: string }).table,
    );
    if (same) same.privileges.push(text(r[1]));
    else grants.push({ scope, privileges: [text(r[1])] });
  }
  const availableDb = await rows(
    session,
    "SELECT name FROM sys.database_principals WHERE type = 'R' AND name <> 'public' ORDER BY name",
  );
  const availableServer = await rows(
    session,
    "SELECT name FROM sys.server_principals WHERE type = 'R' AND name <> 'public' ORDER BY name",
  );
  return {
    grants,
    roles: [
      ...serverRoles.map((r) => ({ name: text(r[0]), server: true })),
      ...dbRoles.map((r) => ({ name: text(r[0]), server: false })),
    ],
    availableRoles: [
      ...availableServer.map((r) => ({ name: text(r[0]), server: true })),
      ...availableDb.map((r) => ({ name: text(r[0]), server: false })),
    ],
    mapped,
    other: [],
  };
}

/**
 * Runs changes in order; stops at the first statement the server refuses (what ran before stays:
 * user changes cannot be rolled back in MySQL).
 */
export async function applyUserChanges(
  session: DbSession,
  dialect: UserDialect,
  readOnly: boolean,
  changes: UserChange[],
): Promise<void> {
  if (readOnly)
    throw new AppError(
      'READ_ONLY',
      'Deze verbinding is alleen-lezen: gebruikers wijzigen kan hier niet.',
    );
  const statements = changes.flatMap((c) => userChangeStatements(dialect, c));
  if (!statements.length) return;
  const results = await run(session, statements);
  const failed = results.find((r) => r.kind === 'error');
  if (failed?.kind === 'error') {
    const done = results.indexOf(failed);
    throw new AppError(
      failed.error.code,
      failed.error.message,
      done > 0
        ? `${done} van de ${statements.length} statements waren al uitgevoerd.`
        : failed.error.hint,
    );
  }
}
