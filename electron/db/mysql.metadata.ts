import type { Pool, RowDataPacket } from 'mysql2/promise';
import type {
  ColumnInfo,
  ColumnKey,
  DatabaseInfo,
  ObjectKind,
  SchemaObject,
} from '../../shared/models';

/**
 * Schema metadata for MySQL and MariaDB, read from information_schema.
 * Every query is parameterised: database and table names never end up in the SQL text.
 */

export const SYSTEM_DATABASES = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
]);

export async function listDatabases(pool: Pool): Promise<DatabaseInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
  );
  return rows.map((r) => {
    const name = String(r['name']);
    return { name, system: SYSTEM_DATABASES.has(name.toLowerCase()) };
  });
}

export async function listObjects(pool: Pool, database: string): Promise<SchemaObject[]> {
  const [tables] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS row_estimate, TABLE_COMMENT AS comment
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME`,
    [database],
  );
  const [routines] = await pool.query<RowDataPacket[]>(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, ROUTINE_COMMENT AS comment
       FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ?
      ORDER BY ROUTINE_NAME`,
    [database],
  );
  return [
    ...tables.map((r) => mapTableRow(r)),
    ...routines.map((r) => ({
      name: String(r['name']),
      kind: (String(r['type']).toUpperCase() === 'FUNCTION'
        ? 'function'
        : 'procedure') as ObjectKind,
      rowEstimate: null,
      comment: String(r['comment'] ?? ''),
    })),
  ];
}

export async function listColumns(
  pool: Pool,
  database: string,
  table: string,
  isMariaDb: boolean,
): Promise<ColumnInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS col_key,
            COLUMN_DEFAULT AS default_value, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [database, table],
  );
  return rows.map((r) => mapColumnRow(r, isMariaDb));
}

/** Every column name per table of one database, for autocompletion in the SQL editor. */
export async function listAllColumns(
  pool: Pool,
  database: string,
): Promise<Record<string, string[]>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[String(r['t'])] ??= []).push(String(r['c']));
  return out;
}

export function mapTableRow(r: RowDataPacket | Record<string, unknown>): SchemaObject {
  const type = String(r['type'] ?? '').toUpperCase();
  const isView = type === 'VIEW' || type === 'SYSTEM VIEW';
  const estimate = r['row_estimate'];
  return {
    name: String(r['name']),
    kind: isView ? 'view' : 'table',
    rowEstimate: isView || estimate === null || estimate === undefined ? null : Number(estimate),
    comment: String(r['comment'] ?? ''),
  };
}

export function mapColumnRow(
  r: RowDataPacket | Record<string, unknown>,
  isMariaDb: boolean,
): ColumnInfo {
  return {
    name: String(r['name']),
    type: String(r['type']),
    nullable: String(r['nullable']).toUpperCase() === 'YES',
    key: mapKey(r['col_key']),
    defaultValue: normalizeDefault(r['default_value'], isMariaDb),
    extra: normalizeExtra(r['extra']),
    comment: String(r['comment'] ?? ''),
  };
}

function mapKey(value: unknown): ColumnKey {
  switch (String(value ?? '').toUpperCase()) {
    case 'PRI':
      return 'primary';
    case 'UNI':
      return 'unique';
    case 'MUL':
      return 'index';
    default:
      return null;
  }
}

/**
 * MySQL and MariaDB report defaults differently. MySQL: NULL for "no default" and literals unquoted.
 * MariaDB 10.2.7+: the text 'NULL' for "no default", string literals quoted ('abc'), expressions bare.
 * We return MySQL's form: null, or the literal value / expression as text.
 */
export function normalizeDefault(value: unknown, isMariaDb: boolean): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!isMariaDb) return text;
  if (text === 'NULL') return null;
  const quoted = /^'(.*)'$/s.exec(text);
  return quoted ? quoted[1]!.replace(/''/g, "'") : text;
}

/** MySQL 8 adds DEFAULT_GENERATED to every expression default; it says nothing useful to a reader. */
function normalizeExtra(value: unknown): string {
  return String(value ?? '')
    .replace(/\bDEFAULT_GENERATED\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
