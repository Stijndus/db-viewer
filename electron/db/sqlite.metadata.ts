import { groupForeignKeys, groupModelTables } from './common';
import type { DatabaseModel } from '../../shared/models';
import { quoteIdent } from '../../shared/dialect';
import type { ColumnInfo, ColumnKey, DatabaseInfo, SchemaObject } from '../../shared/models';
import type { EditTarget } from './common';
import type { SqliteConnection } from './sqlite.connection';

/**
 * Schema metadata for SQLite, from sqlite_master and the pragma table functions. The first tree
 * level is the attached databases (`main`, plus anything ATTACHed). Table names are bound as
 * parameters; only the database name is quoted into the SQL (pragma functions need it as text).
 */

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

export async function listDatabases(conn: SqliteConnection): Promise<DatabaseInfo[]> {
  const res = await conn.query('SELECT name FROM pragma_database_list ORDER BY seq');
  return res.rows
    .map((r) => String(r[0]))
    .filter((name) => name !== 'temp')
    .map((name) => ({ name, system: false }));
}

const master = (database: string) => `${quoteIdent(database, 'sqlite')}.sqlite_master`;

export async function listObjects(
  conn: SqliteConnection,
  database: string,
): Promise<SchemaObject[]> {
  const res = await conn.query(
    `SELECT name, type FROM ${master(database)}
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY name`,
  );
  return res.rows.map((r) => ({
    name: String(r[0]),
    kind: r[1] === 'view' ? 'view' : 'table',
    rowEstimate: null,
    comment: '',
  }));
}

export async function listColumns(
  conn: SqliteConnection,
  database: string,
  table: string,
): Promise<ColumnInfo[]> {
  // table_xinfo also lists generated columns (hidden = 2 virtual, 3 stored).
  const cols = await conn.query(
    'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid',
    [table, database],
  );
  const indexes = await conn.query(
    `SELECT il."unique", ii.name, (SELECT count(*) FROM pragma_index_info(il.name, ?)) AS width
       FROM pragma_index_list(?, ?) il, pragma_index_info(il.name, ?) ii`,
    [database, table, database, database],
  );
  const unique = new Set<string>();
  const indexed = new Set<string>();
  for (const [isUnique, name, width] of indexes.rows) {
    if (name === null) continue;
    indexed.add(String(name));
    if (Number(isUnique) === 1 && Number(width) === 1) unique.add(String(name));
  }
  const pkCount = cols.rows.filter((r) => Number(r[4]) > 0).length;
  return cols.rows.map((r) => {
    const name = String(r[0]);
    const type = String(r[1] ?? '');
    const pk = Number(r[4]) > 0;
    const hidden = Number(r[5]);
    const key: ColumnKey = pk
      ? 'primary'
      : unique.has(name)
        ? 'unique'
        : indexed.has(name)
          ? 'index'
          : null;
    let extra = '';
    if (hidden === 2 || hidden === 3) extra = hidden === 3 ? 'generated (stored)' : 'generated';
    // INTEGER PRIMARY KEY is the rowid: a new row gets the next number automatically.
    else if (pk && pkCount === 1 && type.toUpperCase() === 'INTEGER') extra = 'rowid';
    return {
      name,
      type: type.toLowerCase(),
      nullable: Number(r[2]) === 0 && !pk,
      key,
      defaultValue: text(r[3]),
      extra,
      comment: '',
    };
  });
}

export async function listAllColumns(
  conn: SqliteConnection,
  database: string,
): Promise<Record<string, string[]>> {
  const res = await conn.query(
    `SELECT m.name, p.name FROM ${master(database)} m, pragma_table_info(m.name, ?) p
      WHERE m.type IN ('table', 'view')
      ORDER BY m.name, p.cid`,
    [database],
  );
  const out: Record<string, string[]> = {};
  for (const [t, c] of res.rows) (out[String(t)] ??= []).push(String(c));
  return out;
}

export async function databaseModel(
  conn: SqliteConnection,
  database: string,
): Promise<DatabaseModel> {
  const cols = await conn.query(
    `SELECT m.name, p.name, p.type, p.pk FROM ${master(database)} m, pragma_table_info(m.name, ?) p
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY m.name, p.cid`,
    [database],
  );
  const tables = groupModelTables(
    cols.rows.map((r) => ({
      table: String(r[0]),
      name: String(r[1]),
      type: String(r[2] ?? '').toLowerCase(),
      primary: Number(r[3]) > 0,
    })),
  );
  const keys = await conn.query(
    `SELECT m.name, f.id, f."table", f."from", f."to"
       FROM ${master(database)} m, pragma_foreign_key_list(m.name, ?) f
      WHERE m.type = 'table'
      ORDER BY m.name, f.id, f.seq`,
    [database],
  );
  // A key without "to" columns points to the primary key of its table.
  const primaryOf = (table: string) =>
    tables
      .find((t) => t.name.toLowerCase() === table.toLowerCase())
      ?.columns.filter((c) => c.primary)
      .map((c) => c.name) ?? [];
  const seq = new Map<string, number>();
  return {
    tables,
    foreignKeys: groupForeignKeys(
      keys.rows.map((r) => {
        const id = `${String(r[0])}\u0000${String(r[1])}`;
        const n = seq.get(id) ?? 0;
        seq.set(id, n + 1);
        const refTable = String(r[2]);
        return {
          name: `fk_${String(r[0])}_${String(r[1])}`,
          database,
          table: String(r[0]),
          column: String(r[3]),
          refDatabase: database,
          refTable,
          refColumn: r[4] === null ? (primaryOf(refTable)[n] ?? '') : String(r[4]),
        };
      }),
    ),
  };
}

export async function readTarget(
  conn: SqliteConnection,
  database: string,
  table: string,
): Promise<EditTarget> {
  const type = await conn.query(`SELECT type FROM ${master(database)} WHERE name = ?`, [table]);
  const kind = type.rows[0]?.[0];
  if (kind === undefined) return { type: null, columns: [], primaryKey: [] };
  const cols = await conn.query('SELECT name, pk FROM pragma_table_info(?, ?) ORDER BY pk, cid', [
    table,
    database,
  ]);
  return {
    type: kind === 'table' ? 'table' : 'view',
    columns: cols.rows.map((r) => String(r[0])),
    primaryKey: cols.rows.filter((r) => Number(r[1]) > 0).map((r) => String(r[0])),
  };
}
