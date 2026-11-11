import type pg from 'pg';
import type { ColumnInfo, ColumnKey, DatabaseInfo, SchemaObject } from '../../shared/models';

/**
 * Schema metadata for PostgreSQL, from the system catalogs. The first tree level is the schemas
 * of the connected database. All names travel as parameters, never as SQL text.
 */

export function isSystemSchema(name: string): boolean {
  return (
    name === 'pg_catalog' ||
    name === 'information_schema' ||
    name === 'pg_toast' ||
    /^pg_(toast_)?temp_\d+$/.test(name)
  );
}

export async function listSchemas(pool: pg.Pool): Promise<DatabaseInfo[]> {
  const res = await pool.query<{ name: string }>(
    `SELECT nspname AS name
       FROM pg_namespace
      WHERE has_schema_privilege(oid, 'USAGE')
      ORDER BY nspname`,
  );
  return res.rows.map((r) => ({ name: r.name, system: isSystemSchema(r.name) }));
}

export async function listObjects(pool: pg.Pool, schema: string): Promise<SchemaObject[]> {
  const relations = await pool.query<{
    name: string;
    kind: string;
    estimate: string | null;
    comment: string | null;
  }>(
    `SELECT c.relname AS name, c.relkind AS kind,
            CASE WHEN c.relkind IN ('r', 'p', 'f') AND c.reltuples >= 0 THEN c.reltuples::bigint END AS estimate,
            obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY c.relname`,
    [schema],
  );
  // prokind: f = function, p = procedure (aggregates and window functions are left out).
  const routines = await pool.query<{ name: string; kind: string; comment: string | null }>(
    `SELECT DISTINCT ON (p.proname) p.proname AS name, p.prokind AS kind,
            obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
      ORDER BY p.proname`,
    [schema],
  );
  return [
    ...relations.rows.map((r): SchemaObject => ({
      name: r.name,
      kind: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table',
      rowEstimate: r.estimate === null ? null : Number(r.estimate),
      comment: r.comment ?? '',
    })),
    ...routines.rows.map((r): SchemaObject => ({
      name: r.name,
      kind: r.kind === 'p' ? 'procedure' : 'function',
      rowEstimate: null,
      comment: r.comment ?? '',
    })),
  ];
}

/** The pool returns every value as text (see RAW_TYPES): booleans arrive as 't' / 'f'. */
type PgBool = boolean | 't' | 'f';
const bool = (v: PgBool) => v === true || v === 't';

interface ColumnRow {
  name: string;
  type: string;
  not_null: PgBool;
  default_value: string | null;
  identity: string;
  generated: string;
  comment: string | null;
  is_primary: PgBool;
  is_unique: PgBool;
  is_indexed: PgBool;
}

export async function listColumns(
  pool: pg.Pool,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const res = await pool.query<ColumnRow>(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_value,
            a.attidentity AS identity,
            a.attgenerated AS generated,
            col_description(c.oid, a.attnum) AS comment,
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS is_primary,
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum) AS is_unique,
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND a.attnum = ANY (i.indkey)) AS is_indexed
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  );
  return res.rows.map(mapColumn);
}

export function mapColumn(r: ColumnRow): ColumnInfo {
  const key: ColumnKey = bool(r.is_primary)
    ? 'primary'
    : bool(r.is_unique)
      ? 'unique'
      : bool(r.is_indexed)
        ? 'index'
        : null;
  let extra = '';
  let defaultValue = r.default_value;
  if (r.identity === 'a') extra = 'identity (always)';
  else if (r.identity === 'd') extra = 'identity';
  else if (r.generated === 's') {
    extra = `generated: ${r.default_value ?? ''}`.trim();
    defaultValue = null;
  } else if (defaultValue && /^nextval\(/i.test(defaultValue)) extra = 'serial';
  return {
    name: r.name,
    type: r.type,
    nullable: !bool(r.not_null),
    key,
    defaultValue,
    extra,
    comment: r.comment ?? '',
  };
}

export async function listAllColumns(
  pool: pg.Pool,
  schema: string,
): Promise<Record<string, string[]>> {
  const res = await pool.query<{ t: string; c: string }>(
    `SELECT c.relname AS t, a.attname AS c
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  const out: Record<string, string[]> = {};
  for (const r of res.rows) (out[r.t] ??= []).push(r.c);
  return out;
}
