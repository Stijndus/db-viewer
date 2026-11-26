import { quoteIdent, stringLiteral } from './dialect';
import type { DbType } from './models';

/**
 * Filters per column, set from the grid's header. Each becomes one condition; together (and with
 * the WHERE field) they are joined with AND. Values are always quoted literals, never pasted SQL.
 */

export type FilterOp =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'greater'
  | 'less'
  | 'between'
  | 'isNull'
  | 'notNull'
  | 'isEmpty';

export interface ColumnFilter {
  column: string;
  op: FilterOp;
  value?: string;
  /** The upper bound for 'between'. */
  value2?: string;
}

export const FILTER_OPS: { op: FilterOp; label: string; values: 0 | 1 | 2 }[] = [
  { op: 'contains', label: 'bevat', values: 1 },
  { op: 'notContains', label: 'bevat niet', values: 1 },
  { op: 'equals', label: 'is gelijk aan', values: 1 },
  { op: 'notEquals', label: 'is niet gelijk aan', values: 1 },
  { op: 'startsWith', label: 'begint met', values: 1 },
  { op: 'endsWith', label: 'eindigt op', values: 1 },
  { op: 'greater', label: 'groter dan', values: 1 },
  { op: 'less', label: 'kleiner dan', values: 1 },
  { op: 'between', label: 'tussen', values: 2 },
  { op: 'isNull', label: 'is NULL', values: 0 },
  { op: 'notNull', label: 'is niet NULL', values: 0 },
  { op: 'isEmpty', label: "is leeg ('' of NULL)", values: 0 },
];

export function filterValues(op: FilterOp): 0 | 1 | 2 {
  return FILTER_OPS.find((o) => o.op === op)?.values ?? 1;
}

/** A filter is complete when it has the values its operator needs. */
export function isComplete(f: ColumnFilter): boolean {
  const n = filterValues(f.op);
  if (n === 0) return true;
  if (f.value === undefined || f.value === '') return false;
  return n === 1 || (f.value2 !== undefined && f.value2 !== '');
}

/** The column as text, for LIKE: PostgreSQL and SQL Server only compare text with LIKE. */
function asText(col: string, dialect: DbType): string {
  if (dialect === 'postgres') return `CAST(${col} AS TEXT)`;
  if (dialect === 'mssql') return `CAST(${col} AS NVARCHAR(MAX))`;
  return col;
}

/** LIKE that ignores case everywhere (PostgreSQL's LIKE does not). */
function like(dialect: DbType, not: boolean): string {
  const op = dialect === 'postgres' ? 'ILIKE' : 'LIKE';
  return not ? `NOT ${op}` : op;
}

function likePattern(value: string, before: string, after: string, dialect: DbType): string {
  const escaped = value.replace(/[\\%_[]/g, (c) =>
    c === '[' && dialect !== 'mssql' ? c : `\\${c}`,
  );
  // The escape character as a literal: MySQL reads a lone backslash in quotes as an escape.
  return `${stringLiteral(before + escaped + after, dialect)} ESCAPE ${stringLiteral('\\', dialect)}`;
}

/** One filter as a condition. */
export function filterCondition(f: ColumnFilter, dialect: DbType): string {
  const col = quoteIdent(f.column, dialect);
  const v = (s: string | undefined) => stringLiteral(s ?? '', dialect);
  const text = asText(col, dialect);
  switch (f.op) {
    case 'contains':
    case 'notContains':
      return `${text} ${like(dialect, f.op === 'notContains')} ${likePattern(f.value ?? '', '%', '%', dialect)}`;
    case 'startsWith':
      return `${text} ${like(dialect, false)} ${likePattern(f.value ?? '', '', '%', dialect)}`;
    case 'endsWith':
      return `${text} ${like(dialect, false)} ${likePattern(f.value ?? '', '%', '', dialect)}`;
    case 'equals':
      return `${col} = ${v(f.value)}`;
    case 'notEquals':
      // Like the grid shows it: NULL is "not equal" to a value too.
      return `(${col} <> ${v(f.value)} OR ${col} IS NULL)`;
    case 'greater':
      return `${col} > ${v(f.value)}`;
    case 'less':
      return `${col} < ${v(f.value)}`;
    case 'between':
      return `${col} BETWEEN ${v(f.value)} AND ${v(f.value2)}`;
    case 'isNull':
      return `${col} IS NULL`;
    case 'notNull':
      return `${col} IS NOT NULL`;
    case 'isEmpty':
      return `(${col} IS NULL OR ${text} = '')`;
  }
}

/** The WHERE field and the column filters as one condition (empty when there is none). */
export function combinedWhere(where: string, filters: ColumnFilter[], dialect: DbType): string {
  const parts = [
    ...(where.trim() ? [`(${where.trim()})`] : []),
    ...filters.filter(isComplete).map((f) => filterCondition(f, dialect)),
  ];
  if (parts.length === 1 && where.trim() && filters.filter(isComplete).length === 0)
    return where.trim();
  return parts.join(' AND ');
}

/** A short text for the chip above the grid: `naam bevat "an"`. */
export function filterLabel(f: ColumnFilter): string {
  const op = FILTER_OPS.find((o) => o.op === f.op)?.label ?? f.op;
  const n = filterValues(f.op);
  const q = (s: string | undefined) =>
    `"${(s ?? '').length > 30 ? s!.slice(0, 30) + '…' : (s ?? '')}"`;
  if (n === 0) return `${f.column} ${op}`;
  if (n === 2) return `${f.column} ${op} ${q(f.value)} en ${q(f.value2)}`;
  return `${f.column} ${op} ${q(f.value)}`;
}
