import type { DbType } from './models';

/**
 * What differs per database type, for code shared by the UI and the main process: how names are
 * quoted, what the first level of the schema tree is, and what the SQL editor can do.
 */
export interface DialectInfo {
  type: DbType;
  /** Product name for badges and the connection form. */
  label: string;
  /**
   * The first level of the schema tree. MySQL: databases. PostgreSQL and SQL Server: the schemas of
   * the profile's database. SQLite: the attached databases (`main`).
   */
  container: 'database' | 'schema';
  /** Plural, lower case, for texts like "3 schema's zichtbaar". */
  containerPlural: string;
  /** The SQL editor can switch the default database/schema for unqualified names. */
  editorDefaultContainer: boolean;
  /** A host/port/user server, or a local file (SQLite). */
  file: boolean;
}

export const DIALECTS: Record<DbType, DialectInfo> = {
  mysql: {
    type: 'mysql',
    label: 'MySQL',
    container: 'database',
    containerPlural: 'databases',
    editorDefaultContainer: true,
    file: false,
  },
  postgres: {
    type: 'postgres',
    label: 'PostgreSQL',
    container: 'schema',
    containerPlural: "schema's",
    editorDefaultContainer: true,
    file: false,
  },
  mssql: {
    type: 'mssql',
    label: 'SQL Server',
    container: 'schema',
    containerPlural: "schema's",
    editorDefaultContainer: false,
    file: false,
  },
  sqlite: {
    type: 'sqlite',
    label: 'SQLite',
    container: 'database',
    containerPlural: 'databases',
    editorDefaultContainer: false,
    file: true,
  },
};

/** Quotes an identifier: `name` (MySQL), "name" (PostgreSQL, SQLite), [name] (SQL Server). */
export function quoteIdent(name: string, dialect: DbType = 'mysql'): string {
  switch (dialect) {
    case 'mysql':
      return '`' + name.replace(/`/g, '``') + '`';
    case 'mssql':
      return '[' + name.replace(/]/g, ']]') + ']';
    default:
      return '"' + name.replace(/"/g, '""') + '"';
  }
}

/** `container.table`, quoted. */
export function qualifiedName(container: string, table: string, dialect: DbType = 'mysql'): string {
  return `${quoteIdent(container, dialect)}.${quoteIdent(table, dialect)}`;
}

/** A string literal for showing SQL to the user. MySQL also escapes backslashes. */
export function stringLiteral(value: string, dialect: DbType = 'mysql'): string {
  const body = dialect === 'mysql' ? value.replace(/\\/g, '\\\\') : value;
  const quoted = "'" + body.replace(/'/g, "''") + "'";
  return dialect === 'mssql' ? 'N' + quoted : quoted;
}

/** The n-th (0-based) bind placeholder in a driver's syntax. */
export function placeholder(index: number, dialect: DbType = 'mysql'): string {
  switch (dialect) {
    case 'postgres':
      return `$${index + 1}`;
    case 'mssql':
      return `@p${index + 1}`;
    default:
      return '?';
  }
}

/**
 * The first-level container to start in: the profile's own database for MySQL, otherwise the
 * usual default schema (`public`, `dbo`) or SQLite's `main`.
 */
export function defaultContainer(type: DbType, profileDatabase: string): string {
  switch (type) {
    case 'mysql':
      return profileDatabase;
    case 'postgres':
      return 'public';
    case 'mssql':
      return 'dbo';
    case 'sqlite':
      return 'main';
  }
}

/** Default port and user per database type, for the connection form. */
export const SERVER_DEFAULTS: Record<Exclude<DbType, 'sqlite'>, { port: number; user: string }> = {
  mysql: { port: 3306, user: 'root' },
  postgres: { port: 5432, user: 'postgres' },
  mssql: { port: 1433, user: 'sa' },
};
