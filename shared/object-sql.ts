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

/** A new database (MySQL) or schema (PostgreSQL, SQL Server); SQLite has one file per database. */
export function canCreateContainer(type: DbType): boolean {
  return type !== 'sqlite';
}

/**
 * The checkbox that gets an action past foreign keys, or null where there is none: MySQL turns
 * the checks off for that one statement; PostgreSQL has no such switch, so it uses CASCADE, which
 * goes further (it also empties or drops what depends on it) and says so. SQLite does not check
 * foreign keys here, and SQL Server can only drop the constraints themselves.
 */
export function forceOption(
  type: DbType,
  action: ObjectAction,
): { label: string; hint: string } | null {
  if (action.action === 'create-container') return null;
  if (type === 'mysql') {
    return {
      label: 'Foreign key checks uitzetten',
      hint: 'Voert het uit met FOREIGN_KEY_CHECKS = 0, ook als andere tabellen hiernaar verwijzen. Die verwijzingen kloppen daarna niet meer.',
    };
  }
  if (type === 'postgres' && action.action === 'truncate') {
    return {
      label: 'Ook de tabellen die hiernaar verwijzen leegmaken (CASCADE)',
      hint: 'PostgreSQL kan foreign keys niet uitzetten. Met CASCADE worden ook alle tabellen met een foreign key naar deze tabel leeggemaakt.',
    };
  }
  if (
    type === 'postgres' &&
    action.action === 'drop' &&
    (action.kind === 'table' || action.kind === 'view')
  ) {
    return {
      label: 'Ook wat hiervan afhangt verwijderen (CASCADE)',
      hint: 'PostgreSQL kan foreign keys niet uitzetten. Met CASCADE verdwijnen ook de foreign keys van andere tabellen naar deze tabel, en views die ervan afhangen; de andere tabellen en hun rijen blijven.',
    };
  }
  return null;
}

/** The statements an action runs, in order. */
export function actionStatements(type: DbType, action: ObjectAction): string[] {
  const force = action.action !== 'create-container' && action.force === true;
  const cascade = force && type === 'postgres' ? ' CASCADE' : '';
  let main: string;
  switch (action.action) {
    case 'truncate': {
      const table = qualifiedName(action.database, action.name, type);
      // SQLite has no TRUNCATE; DELETE without WHERE uses its fast "truncate optimization".
      main = type === 'sqlite' ? `DELETE FROM ${table}` : `TRUNCATE TABLE ${table}${cascade}`;
      break;
    }
    case 'drop':
      main = `DROP ${DROP_KEYWORD[action.kind]} ${qualifiedName(action.database, action.name, type)}${
        action.kind === 'table' || action.kind === 'view' ? cascade : ''
      }`;
      break;
    case 'drop-container':
      if (type === 'mysql') main = `DROP DATABASE ${quoteIdent(action.database, type)}`;
      else if (type === 'postgres')
        main = `DROP SCHEMA ${quoteIdent(action.database, type)} CASCADE`;
      else
        throw new Error(
          `Een ${type === 'mssql' ? 'schema' : 'database'} verwijderen kan hier niet.`,
        );
      break;
    case 'create-container':
      if (type === 'mysql') main = `CREATE DATABASE ${quoteIdent(action.database, type)}`;
      else if (type === 'postgres' || type === 'mssql')
        main = `CREATE SCHEMA ${quoteIdent(action.database, type)}`;
      else throw new Error('SQLite heeft één database per bestand.');
      break;
  }
  return force && type === 'mysql'
    ? ['SET FOREIGN_KEY_CHECKS = 0', main, 'SET FOREIGN_KEY_CHECKS = 1']
    : [main];
}

/** The statements of an action as shown before it runs. */
export function actionSql(type: DbType, action: ObjectAction): string {
  const statements = actionStatements(type, action);
  return statements.length === 1 ? statements[0]! : statements.join(';\n') + ';';
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
