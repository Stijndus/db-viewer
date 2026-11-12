/**
 * Schema objects for the tree's context menu: definitions (CREATE statements), routine parameters
 * and the actions that empty or drop objects. Reads use the session's pool; actions run on a
 * dedicated editor connection, like SQL typed by the user, and never on a read-only connection.
 */
import { randomUUID } from 'node:crypto';
import { qualifiedName } from '../../shared/dialect';
import type { DbType, ObjectAction, ObjectKind, RoutineParam } from '../../shared/models';
import { actionSql, canDropContainer } from '../../shared/object-sql';
import { AppError } from '../ipc/errors';
import { refuseReadOnly } from './common';
import type { DbSession } from './driver';

/**
 * A row's values in column order, whether the driver returns arrays or objects. Every query here
 * names its columns: SQL Server puts unnamed columns together under one empty key.
 */
function values(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  return row && typeof row === 'object' ? Object.values(row) : [];
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return null;
}

function notFound(kind: ObjectKind, name: string): AppError {
  const what = { table: 'Tabel', view: 'View', procedure: 'Procedure', function: 'Functie' }[kind];
  return new AppError(
    'OBJECT_DEFINITION_UNAVAILABLE',
    `${what} ${name} niet gevonden, of de definitie is niet leesbaar.`,
    'Het object kan verwijderd zijn (vernieuw de lijst), of deze gebruiker mag de definitie niet zien.',
  );
}

/** The CREATE statement of a table, view, procedure or function. */
export async function objectDefinition(
  session: DbSession,
  type: DbType,
  database: string,
  kind: ObjectKind,
  name: string,
): Promise<string> {
  if (kind === 'table' || (type === 'sqlite' && kind === 'view')) {
    return session.tableDdl(database, name);
  }
  const target = qualifiedName(database, name, type);
  let sql: string;
  let params: unknown[] = [];
  let column = 0;
  switch (type) {
    case 'mysql':
      sql =
        kind === 'view'
          ? `SHOW CREATE VIEW ${target}`
          : `SHOW CREATE ${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} ${target}`;
      // View: View, Create View, …; routine: name, sql_mode, Create Procedure/Function, …
      column = kind === 'view' ? 1 : 2;
      break;
    case 'postgres':
      sql =
        kind === 'view'
          ? `SELECT 'CREATE OR REPLACE ' || CASE c.relkind WHEN 'm' THEN 'MATERIALIZED ' ELSE '' END
                    || 'VIEW ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname)
                    || E' AS\\n' || pg_get_viewdef(c.oid, true) AS definition
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`
          : `SELECT pg_get_functiondef(p.oid) AS definition
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
              ORDER BY p.oid LIMIT 1`;
      params =
        kind === 'view' ? [database, name] : [database, name, kind === 'procedure' ? 'p' : 'f'];
      break;
    case 'mssql':
      sql = 'SELECT OBJECT_DEFINITION(OBJECT_ID(@p1)) AS definition';
      params = [target];
      break;
    case 'sqlite':
      throw notFound(kind, name); // SQLite has no stored routines
  }
  const res = await session.query(sql, params);
  const definition = text(values(res.rows[0])[column]);
  if (!definition) throw notFound(kind, name);
  return definition;
}

/** The parameters of a procedure or function, in order (without a function's return value). */
export async function routineParams(
  session: DbSession,
  type: DbType,
  database: string,
  kind: 'procedure' | 'function',
  name: string,
): Promise<RoutineParam[]> {
  let sql: string;
  let params: unknown[];
  switch (type) {
    case 'mysql':
      sql = `SELECT PARAMETER_NAME AS name, PARAMETER_MODE AS mode, DTD_IDENTIFIER AS type
               FROM information_schema.PARAMETERS
              WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ?
                AND ORDINAL_POSITION > 0
              ORDER BY ORDINAL_POSITION`;
      params = [database, name, kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'];
      break;
    case 'postgres':
      // Overloaded routines: the parameters of the first one, like the definition.
      sql = `SELECT COALESCE(a.name, '') AS name,
                    CASE a.mode WHEN 'o' THEN 'OUT' WHEN 'b' THEN 'INOUT' ELSE 'IN' END AS mode,
                    format_type(a.type, NULL) AS type
               FROM (SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
                      ORDER BY p.oid LIMIT 1) p,
                    unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]),
                           p.proargnames,
                           COALESCE(p.proargmodes, array_fill('i'::"char", ARRAY[p.pronargs])))
                      WITH ORDINALITY AS a(type, name, mode, pos)
              WHERE a.mode IN ('i', 'o', 'b', 'v')
              ORDER BY a.pos`;
      params = [database, name, kind === 'procedure' ? 'p' : 'f'];
      break;
    case 'mssql':
      sql = `SELECT SUBSTRING(name, 2, 128) AS name,
                    CASE WHEN is_output = 1 THEN 'INOUT' ELSE 'IN' END AS mode,
                    TYPE_NAME(user_type_id) AS type
               FROM sys.parameters
              WHERE object_id = OBJECT_ID(@p1) AND parameter_id > 0
              ORDER BY parameter_id`;
      params = [qualifiedName(database, name, type)];
      break;
    case 'sqlite':
      return [];
  }
  const res = await session.query(sql, params);
  return res.rows.map((row) => {
    const [n, mode, t] = values(row);
    const m = String(mode ?? 'IN').toLowerCase();
    return {
      name: text(n) ?? '',
      mode: m === 'out' ? 'out' : m === 'inout' ? 'inout' : 'in',
      type: text(t) ?? '',
    };
  });
}

/** Empties or drops an object, on its own editor connection that is closed afterwards. */
export async function runObjectAction(
  session: DbSession,
  type: DbType,
  readOnly: boolean,
  action: ObjectAction,
): Promise<void> {
  refuseReadOnly(readOnly);
  if (action.action === 'drop-container' && !canDropContainer(type)) {
    throw new AppError('NOT_SUPPORTED', 'Dit kan niet bij dit soort database.');
  }
  if (
    action.action === 'drop' &&
    type === 'sqlite' &&
    action.kind !== 'table' &&
    action.kind !== 'view'
  ) {
    throw new AppError('NOT_SUPPORTED', 'SQLite heeft geen procedures of functies.');
  }
  const tab = `manage-${randomUUID()}`;
  try {
    const result = await session.runScript(tab, {
      statements: [actionSql(type, action)],
      maxRows: 1,
    });
    const first = result.results[0];
    if (first?.kind === 'error')
      throw new AppError(first.error.code, first.error.message, first.error.hint);
  } finally {
    await session.closeEditor(tab).catch(() => undefined);
  }
}
