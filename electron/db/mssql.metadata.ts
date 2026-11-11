import type sql from 'mssql';
import type { ColumnInfo, ColumnKey, DatabaseInfo, SchemaObject } from '../../shared/models';
import type { EditTarget } from './common';

/**
 * Schema metadata for SQL Server, from the sys catalog views of the connected database. The first
 * tree level is its schemas. Names travel as parameters, never as SQL text.
 */

export function isSystemSchema(name: string): boolean {
  return (
    name === 'sys' || name === 'INFORMATION_SCHEMA' || name === 'guest' || /^db_[a-z]+$/.test(name)
  );
}

export async function listSchemas(pool: sql.ConnectionPool): Promise<DatabaseInfo[]> {
  const res = await pool
    .request()
    .query<{ name: string }>('SELECT name FROM sys.schemas ORDER BY name');
  return res.recordset.map((r) => ({ name: r.name, system: isSystemSchema(r.name) }));
}

export async function listObjects(
  pool: sql.ConnectionPool,
  schema: string,
): Promise<SchemaObject[]> {
  const res = await pool
    .request()
    .input('schema', schema)
    .query<{
      name: string;
      type: string;
      estimate: number | string | null;
      comment: string | null;
    }>(
      `SELECT o.name, RTRIM(o.type) AS type,
              CASE WHEN o.type = 'U' THEN (SELECT SUM(p.rows) FROM sys.partitions p
                                            WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) END AS estimate,
              CAST(ep.value AS nvarchar(4000)) AS comment
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN sys.extended_properties ep
           ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description'
        WHERE s.name = @schema AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
        ORDER BY o.name`,
    );
  return res.recordset.map((r) => ({
    name: r.name,
    kind:
      r.type === 'U'
        ? 'table'
        : r.type === 'V'
          ? 'view'
          : r.type === 'P'
            ? 'procedure'
            : 'function',
    rowEstimate: r.estimate === null || r.estimate === undefined ? null : Number(r.estimate),
    comment: r.comment ?? '',
  }));
}

interface ColumnRow {
  name: string;
  type_name: string;
  max_length: number;
  precision: number;
  scale: number;
  is_nullable: boolean;
  is_identity: boolean;
  is_computed: boolean;
  default_value: string | null;
  computed: string | null;
  comment: string | null;
  is_primary: number;
  is_unique: number;
  is_indexed: number;
}

export async function listColumns(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const res = await pool
    .request()
    .input('schema', schema)
    .input('table', table)
    .query<ColumnRow>(
      `SELECT c.name, t.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable,
              c.is_identity, c.is_computed, dc.definition AS default_value, cc.definition AS computed,
              CAST(ep.value AS nvarchar(4000)) AS comment,
              CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic
                                  ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                                 WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id)
                   THEN 1 ELSE 0 END AS is_primary,
              CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic
                                  ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                                 WHERE i.object_id = c.object_id AND i.is_unique = 1 AND ic.column_id = c.column_id
                                   AND ic.key_ordinal > 0
                                   AND (SELECT COUNT(*) FROM sys.index_columns k
                                         WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.key_ordinal > 0) = 1)
                   THEN 1 ELSE 0 END AS is_unique,
              CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic
                                 WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id)
                   THEN 1 ELSE 0 END AS is_indexed
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.types t ON t.user_type_id = c.user_type_id
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
         LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
         LEFT JOIN sys.extended_properties ep
           ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description'
        WHERE s.name = @schema AND o.name = @table
        ORDER BY c.column_id`,
    );
  return res.recordset.map(mapColumn);
}

export function mapColumn(r: ColumnRow): ColumnInfo {
  const key: ColumnKey = r.is_primary
    ? 'primary'
    : r.is_unique
      ? 'unique'
      : r.is_indexed
        ? 'index'
        : null;
  let extra = '';
  if (r.is_identity) extra = 'identity';
  else if (r.is_computed) extra = `computed: ${unwrap(r.computed) ?? ''}`.trim();
  return {
    name: r.name,
    type: typeLabel(r),
    nullable: Boolean(r.is_nullable),
    key,
    defaultValue: unwrap(r.default_value),
    extra,
    comment: r.comment ?? '',
  };
}

/** `nvarchar(255)`, `varchar(max)`, `decimal(10,2)`, `datetime2(7)`, `int`. */
export function typeLabel(
  r: Pick<ColumnRow, 'type_name' | 'max_length' | 'precision' | 'scale'>,
): string {
  const t = r.type_name.toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) {
    return `${t}(${r.max_length === -1 ? 'max' : r.max_length})`;
  }
  if (['nvarchar', 'nchar'].includes(t))
    return `${t}(${r.max_length === -1 ? 'max' : r.max_length / 2})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${r.precision},${r.scale})`;
  if (['datetime2', 'datetimeoffset', 'time'].includes(t)) return `${t}(${r.scale})`;
  return t;
}

/** SQL Server stores defaults wrapped in parentheses: `((0))`, `('open')`, `(getdate())`. */
export function unwrap(definition: string | null): string | null {
  if (definition === null) return null;
  let d = definition.trim();
  while (d.startsWith('(') && d.endsWith(')') && balanced(d.slice(1, -1)))
    d = d.slice(1, -1).trim();
  const literal = /^N?'(.*)'$/s.exec(d);
  return literal ? literal[1]!.replace(/''/g, "'") : d;
}

function balanced(s: string): boolean {
  let depth = 0;
  let quote = false;
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    else if (!quote && ch === '(') depth++;
    else if (!quote && ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

export async function listAllColumns(
  pool: sql.ConnectionPool,
  schema: string,
): Promise<Record<string, string[]>> {
  const res = await pool
    .request()
    .input('schema', schema)
    .query<{ t: string; c: string }>(
      `SELECT o.name AS t, c.name AS c
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.type IN ('U', 'V')
        ORDER BY o.name, c.column_id`,
    );
  const out: Record<string, string[]> = {};
  for (const r of res.recordset) (out[r.t] ??= []).push(r.c);
  return out;
}

/** Column names and SQL Server types of a table or view, for building the grid's SELECT list. */
export async function columnTypes(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
): Promise<{ name: string; type: string }[]> {
  const res = await pool
    .request()
    .input('schema', schema)
    .input('table', table)
    .query<{ name: string; type: string }>(
      `SELECT c.name, t.name AS type
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.types t ON t.user_type_id = c.user_type_id
        WHERE s.name = @schema AND o.name = @table
        ORDER BY c.column_id`,
    );
  return res.recordset;
}

export async function readTarget(
  request: () => sql.Request,
  schema: string,
  table: string,
): Promise<EditTarget> {
  const obj = await request()
    .input('schema', schema)
    .input('table', table)
    .query<{ type: string; id: number }>(
      `SELECT RTRIM(o.type) AS type, o.object_id AS id FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @table AND o.type IN ('U', 'V')`,
    );
  const row = obj.recordset[0];
  if (!row) return { type: null, columns: [], primaryKey: [] };
  const cols = await request()
    .input('id', row.id)
    .query<{ name: string; pk: number }>(
      `SELECT c.name,
              CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic
                                  ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                                 WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id)
                   THEN 1 ELSE 0 END AS pk
         FROM sys.columns c WHERE c.object_id = @id ORDER BY c.column_id`,
    );
  return {
    type: row.type === 'U' ? 'table' : 'view',
    columns: cols.recordset.map((c) => c.name),
    primaryKey: cols.recordset.filter((c) => c.pk === 1).map((c) => c.name),
  };
}
