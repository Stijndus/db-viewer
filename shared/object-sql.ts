/**
 * SQL for the schema tree's context menu, per dialect: SELECT, INSERT and CALL templates for a
 * new SQL tab, and the statements for emptying and dropping objects (shown before they run).
 */
import { qualifiedName, quoteIdent } from './dialect';
import type { ColumnInfo, DbType, ObjectAction, ObjectKind, RoutineParam } from './models';

const DROP_KEYWORD: Record<ObjectKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
};

/** MySQL drops a database, PostgreSQL a schema with everything in it. Not SQL Server or SQLite. */
export function canDropContainer(type: DbType): boolean {
  return type === 'mysql' || type === 'postgres';
}

/** The statement an action runs. */
export function actionSql(type: DbType, action: ObjectAction): string {
  switch (action.action) {
    case 'truncate': {
      const table = qualifiedName(action.database, action.name, type);
      // SQLite has no TRUNCATE; DELETE without WHERE uses its fast "truncate optimization".
      return type === 'sqlite' ? `DELETE FROM ${table}` : `TRUNCATE TABLE ${table}`;
    }
    case 'drop':
      return `DROP ${DROP_KEYWORD[action.kind]} ${qualifiedName(action.database, action.name, type)}`;
    case 'drop-container':
      if (type === 'mysql') return `DROP DATABASE ${quoteIdent(action.database, type)}`;
      if (type === 'postgres') return `DROP SCHEMA ${quoteIdent(action.database, type)} CASCADE`;
      throw new Error(`Een ${type === 'mssql' ? 'schema' : 'database'} verwijderen kan hier niet.`);
  }
}

/** `SELECT * … LIMIT 1000`, or `SELECT TOP (1000) *` for SQL Server. */
export function selectSql(type: DbType, database: string, name: string, limit = 1000): string {
  const from = qualifiedName(database, name, type);
  return type === 'mssql'
    ? `SELECT TOP (${limit}) *\nFROM ${from};`
    : `SELECT *\nFROM ${from}\nLIMIT ${limit};`;
}

/** Text for a comment in a template: no line breaks or comment ends from odd names. */
function note(text: string): string {
  return text.replace(/\*\/|[\r\n]+/g, ' ');
}

/** Columns the database fills itself (auto-increment, identity, generated, computed). */
function filledByServer(column: ColumnInfo): boolean {
  return /auto_increment|identity|generated|computed/i.test(column.extra);
}

/** INSERT with every column the user fills in, each value NULL with the column's type. */
export function insertTemplate(
  type: DbType,
  database: string,
  name: string,
  columns: ColumnInfo[],
): string {
  const cols = columns.filter((c) => !filledByServer(c));
  const target = qualifiedName(database, name, type);
  if (cols.length === 0) {
    return type === 'mysql'
      ? `INSERT INTO ${target} () VALUES ();`
      : `INSERT INTO ${target} DEFAULT VALUES;`;
  }
  const names = cols.map((c) => `  ${quoteIdent(c.name, type)}`).join(',\n');
  const values = cols
    .map((c, i) => `  NULL${i < cols.length - 1 ? ',' : ''} -- ${note(`${c.name} ${c.type}`)}`)
    .join('\n');
  return `INSERT INTO ${target} (\n${names}\n) VALUES (\n${values}\n);`;
}

/**
 * A call with a NULL per input parameter, ready to fill in. OUT parameters go into a variable
 * that is selected afterwards (MySQL, SQL Server); PostgreSQL takes NULL for them.
 */
export function callTemplate(
  type: DbType,
  database: string,
  kind: 'procedure' | 'function',
  name: string,
  params: RoutineParam[],
): string {
  const target = qualifiedName(database, name, type);
  const label = (p: RoutineParam, i: number) => p.name || `$${i + 1}`;

  if (type === 'mssql') {
    if (kind === 'function') {
      return `SELECT ${target}(${params.map((p) => `NULL /* ${note(`${p.name} ${p.type}`)} */`).join(', ')});`;
    }
    const outs = params.filter((p) => p.mode !== 'in');
    const declare = outs.map((p) => `DECLARE @${p.name} ${p.type};\n`).join('');
    const args = params
      .map((p, i) => {
        const value = p.mode === 'in' ? 'NULL' : `@${p.name} OUTPUT`;
        return `  @${p.name} = ${value}${i < params.length - 1 ? ',' : ''} -- ${note(p.type)}`;
      })
      .join('\n');
    const select = outs.length
      ? `\nSELECT ${outs.map((p) => `@${p.name} AS ${quoteIdent(p.name, type)}`).join(', ')};`
      : '';
    return `${declare}EXEC ${target}${args ? '\n' + args : ''};${select}`;
  }

  // A PostgreSQL function returns its OUT parameters as columns; they are not passed in.
  if (type === 'postgres' && kind === 'function') params = params.filter((p) => p.mode !== 'out');
  const outVar = (p: RoutineParam) => `@${p.name}`;
  const args = params.map((p, i) => {
    const value = type === 'mysql' && p.mode !== 'in' ? outVar(p) : 'NULL';
    const mode = p.mode !== 'in' ? p.mode.toUpperCase() + ' ' : '';
    return `  ${value}${i < params.length - 1 ? ',' : ''} -- ${note(`${label(p, i)} ${mode}${p.type}`)}`;
  });
  const list = args.length ? `(\n${args.join('\n')}\n)` : '()';

  if (kind === 'function') {
    return type === 'postgres' ? `SELECT * FROM ${target}${list};` : `SELECT ${target}${list};`;
  }
  const outs = type === 'mysql' ? params.filter((p) => p.mode !== 'in') : [];
  const select = outs.length ? `\nSELECT ${outs.map(outVar).join(', ')};` : '';
  return `CALL ${target}${list};${select}`;
}
