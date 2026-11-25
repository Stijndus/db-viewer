import { qualifiedName, quoteIdent, stringLiteral } from './dialect';
import type { ColumnInfo, DbType } from './models';

/**
 * The SQL of a CSV, JSON or Excel import: one multi-row INSERT per batch (or the dialect's upsert),
 * with every value written as a string literal so the server converts it to the column's type.
 * Quoting numbers too keeps the rows of one VALUES list the same type, which SQL Server needs.
 */

export type ImportMode = 'append' | 'replace' | 'upsert';

/** A value as a file gives it: text, or a number or boolean from JSON or Excel. */
export type ImportCell = string | number | boolean | null;

/** Rows per INSERT; SQL Server allows at most 1,000 in one VALUES list. */
export const IMPORT_BATCH_ROWS = 500;
/** And roughly this much SQL text at most per statement. */
export const IMPORT_BATCH_CHARS = 1_000_000;

/** Columns whose empty value is a real value; anywhere else "" can only mean NULL. */
export function isTextColumn(type: string): boolean {
  return /char|text|clob|string|^enum\b|^set\b|citext/i.test(type);
}

function isBooleanColumn(type: string): boolean {
  return /^bool/i.test(type);
}

/** Generated and computed columns can't be written; they are not offered as targets. */
export function isWritableColumn(column: ColumnInfo): boolean {
  return !/generated|computed|virtual|stored/i.test(column.extra);
}

/** SQL Server: an identity column takes explicit values only with IDENTITY_INSERT on. */
export function isIdentityColumn(column: ColumnInfo, dialect: DbType): boolean {
  return dialect === 'mssql' && /identity/i.test(column.extra);
}

/** One value as SQL: NULL, or a string literal the server converts. */
export function importLiteral(
  value: ImportCell,
  column: ColumnInfo,
  dialect: DbType,
  emptyAsNull: boolean,
): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') {
    const text = isBooleanColumn(column.type) ? String(value) : value ? '1' : '0';
    return stringLiteral(text, dialect);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return stringLiteral(String(value), dialect);
  }
  if (value === '' && (emptyAsNull || !isTextColumn(column.type))) return 'NULL';
  return stringLiteral(value, dialect);
}

export function beginSql(dialect: DbType): string {
  if (dialect === 'mysql') return 'START TRANSACTION';
  if (dialect === 'mssql') return 'BEGIN TRANSACTION';
  return 'BEGIN';
}

export function commitSql(dialect: DbType): string {
  return dialect === 'mssql' ? 'COMMIT TRANSACTION' : 'COMMIT';
}

/** "Tabel eerst leegmaken": DELETE, so it is undone with the rest when the import rolls back. */
export function deleteAllSql(dialect: DbType, database: string, table: string): string {
  return `DELETE FROM ${qualifiedName(database, table, dialect)}`;
}

/** Statements that turn foreign key checks off (and on again) for the import's session. */
export function foreignKeySql(dialect: DbType, on: boolean): string | null {
  if (dialect === 'mysql') return `SET FOREIGN_KEY_CHECKS = ${on ? 1 : 0}`;
  if (dialect === 'sqlite') return `PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`;
  return null;
}

/** Where turning foreign key checks off is possible for one session. */
export function canDisableForeignKeys(dialect: DbType): boolean {
  return foreignKeySql(dialect, false) !== null;
}

export function identityInsertSql(
  dialect: DbType,
  database: string,
  table: string,
  on: boolean,
): string {
  return `SET IDENTITY_INSERT ${qualifiedName(database, table, dialect)} ${on ? 'ON' : 'OFF'}`;
}

/**
 * One statement for a batch of rows (already literals, in `columns` order). Upsert matches on
 * `keyColumns` (the primary key) and updates the other imported columns; with only key columns
 * imported, an existing row is left as it is.
 */
export function insertRowsSql(
  dialect: DbType,
  database: string,
  table: string,
  columns: string[],
  rows: string[][],
  mode: ImportMode,
  keyColumns: string[] = [],
): string {
  const q = (n: string) => quoteIdent(n, dialect);
  const target = qualifiedName(database, table, dialect);
  const list = columns.map(q).join(', ');
  const values = rows.map((r) => `(${r.join(', ')})`).join(',\n');
  const insert = `INSERT INTO ${target} (${list}) VALUES\n${values}`;
  if (mode !== 'upsert') return insert;

  if (keyColumns.length === 0)
    throw new Error('Bijwerken op sleutel vraagt om een primaire sleutel.');
  const missing = keyColumns.filter((k) => !columns.includes(k));
  if (missing.length > 0) {
    throw new Error(
      `De sleutelkolom ${missing.join(', ')} moet worden geïmporteerd om bij te werken.`,
    );
  }
  const rest = columns.filter((c) => !keyColumns.includes(c));

  switch (dialect) {
    case 'mysql':
      return rest.length === 0
        ? insert.replace(/^INSERT INTO/, 'INSERT IGNORE INTO')
        : `${insert}\nON DUPLICATE KEY UPDATE ${rest.map((c) => `${q(c)} = VALUES(${q(c)})`).join(', ')}`;
    case 'postgres':
    case 'sqlite': {
      const conflict = `ON CONFLICT (${keyColumns.map(q).join(', ')})`;
      return rest.length === 0
        ? `${insert}\n${conflict} DO NOTHING`
        : `${insert}\n${conflict} DO UPDATE SET ${rest.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`;
    }
    case 'mssql': {
      const on = keyColumns.map((k) => `t.${q(k)} = s.${q(k)}`).join(' AND ');
      const update =
        rest.length === 0
          ? ''
          : `\nWHEN MATCHED THEN UPDATE SET ${rest.map((c) => `t.${q(c)} = s.${q(c)}`).join(', ')}`;
      return (
        `MERGE INTO ${target} WITH (HOLDLOCK) AS t\nUSING (VALUES\n${values}\n) AS s (${list})\n` +
        `ON ${on}${update}\nWHEN NOT MATCHED THEN INSERT (${list}) VALUES (${columns.map((c) => `s.${q(c)}`).join(', ')});`
      );
    }
  }
}

/** Matches file columns to table columns by name: exact, then ignoring case, spaces and _ or -. */
export function autoMap(sourceColumns: string[], targets: string[]): (string | null)[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, '');
  const used = new Set<string>();
  const pick = (find: (t: string) => boolean) => {
    const hit = targets.find((t) => !used.has(t) && find(t));
    if (hit) used.add(hit);
    return hit ?? null;
  };
  const result: (string | null)[] = sourceColumns.map((s) => pick((t) => t === s));
  return result.map((r, i) => r ?? pick((t) => norm(t) === norm(sourceColumns[i]!)));
}
