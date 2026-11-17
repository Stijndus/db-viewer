/**
 * What kind of value a column holds, from its declared type in any of the dialects (MySQL,
 * PostgreSQL, SQL Server, SQLite). Used to colour values and to fill in the current time.
 */
export type TypeCategory =
  | 'number'
  | 'text'
  | 'date'
  | 'datetime'
  | 'time'
  | 'year'
  | 'json'
  | 'enum'
  | 'bool'
  | 'binary'
  | 'other';

export function typeCategory(type: string): TypeCategory {
  const t = type.toLowerCase().trim();
  if (/^(json|jsonb)\b/.test(t)) return 'json';
  if (/^(bool|boolean)\b/.test(t) || /^bit(\(1\))?$/.test(t) || /^tinyint\(1\)/.test(t))
    return 'bool';
  if (
    /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|money|smallmoney|serial|bigserial|smallserial|number|int2|int4|int8|float4|float8)\b/.test(
      t,
    )
  )
    return 'number';
  if (/^year\b/.test(t)) return 'year';
  if (/^date$/.test(t)) return 'date';
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset|timestamp)\b/.test(t)) return 'datetime';
  if (/^time\b/.test(t)) return 'time';
  if (/^(enum|set)\b/.test(t)) return 'enum';
  if (/(blob|binary|bytea|image|varbinary)/.test(t)) return 'binary';
  if (
    /(char|text|clob|string|uuid|uniqueidentifier|citext|xml|name)/.test(t) ||
    t === '' // SQLite columns without a type
  )
    return t === '' ? 'other' : 'text';
  return 'other';
}

const pad = (n: number, size = 2) => String(n).padStart(size, '0');

/**
 * The current local time as the column stores it: `2026-11-17 12:13:05` for DATETIME and
 * TIMESTAMP, `2026-11-17` for DATE, `12:13:05` for TIME, `2026` for YEAR; null for other types.
 */
export function nowFor(category: TypeCategory, now = new Date()): string | null {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  switch (category) {
    case 'datetime':
      return `${date} ${time}`;
    case 'date':
      return date;
    case 'time':
      return time;
    case 'year':
      return String(now.getFullYear());
    default:
      return null;
  }
}
