import { quoteIdent, stringLiteral } from '../../../../../shared/dialect';
import type { DbType, ExportSource } from '../../../../../shared/models';
import type { GridCell } from './data-grid';

/** How a block of cells can be copied. */
export type CopyFormat = 'tsv' | 'csv' | 'json' | 'sql' | 'markdown';

export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: 'Tab (Excel)',
  csv: 'CSV',
  json: 'JSON',
  sql: 'SQL INSERT',
  markdown: 'Markdown',
};

export interface CopyBlock {
  columns: { name: string; numeric: boolean }[];
  rows: GridCell[][];
}

export interface CopyOptions {
  header: boolean;
  dialect: DbType;
  /** Table name for SQL INSERTs (a query result has none: `export`). */
  table: string;
}

const DEFAULT = Symbol('default');

/** A cell's value as text; null for SQL NULL; DEFAULT for an untouched new-row cell. */
function value(cell: GridCell): string | null | typeof DEFAULT {
  if (cell === null) return null;
  if (typeof cell === 'string') return cell;
  if (cell.kind === 'default') return DEFAULT;
  if (cell.kind === 'sql') return cell.sql;
  if (cell.kind === 'binary') return `0x${cell.hex.toUpperCase()}`;
  return cell.text;
}

/** Values the grid only shows in part: long text cut off, binary beyond 32 bytes. */
export function incompleteCount(rows: GridCell[][]): number {
  let n = 0;
  for (const row of rows)
    for (const cell of row) {
      if (cell && typeof cell === 'object') {
        if (cell.kind === 'truncated') n++;
        else if (cell.kind === 'binary' && cell.hex.length / 2 < cell.bytes) n++;
      }
    }
  return n;
}

/** Quoted like a spreadsheet expects when the text holds the separator, quotes or line breaks. */
function delimited(text: string | null, delimiter: string): string {
  if (text === null) return '';
  if (text.includes(delimiter) || /["\r\n]/.test(text) || (delimiter === ',' && text === ''))
    return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function markdown(text: string | null): string {
  if (text === null) return '*NULL*';
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** A number in JSON when it is one and survives the trip (15 digits); else the exact text. */
function jsonValue(text: string | null, numeric: boolean): unknown {
  if (text === null) return null;
  if (numeric && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) && text.replace(/[-.]/g, '').length <= 15)
    return Number(text);
  return text;
}

function sqlValue(cell: GridCell, numeric: boolean, dialect: DbType): string {
  const text = value(cell);
  if (text === DEFAULT) return 'DEFAULT';
  if (text === null) return 'NULL';
  if (cell && typeof cell === 'object' && cell.kind === 'binary') {
    const hex = cell.hex.toUpperCase();
    return dialect === 'mssql' ? `0x${hex}` : dialect === 'postgres' ? `'\\x${hex}'` : `X'${hex}'`;
  }
  if (numeric && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return text;
  return stringLiteral(text, dialect);
}

/** The block of cells as text in the chosen format. */
export function formatBlock(block: CopyBlock, format: CopyFormat, options: CopyOptions): string {
  const { columns } = block;
  const rows = block.rows.map((r) => r.map(value));
  const plain = (v: string | null | typeof DEFAULT) => (v === DEFAULT ? '' : v);

  switch (format) {
    case 'tsv':
    case 'csv': {
      const sep = format === 'tsv' ? '\t' : ',';
      const lines = rows.map((r) => r.map((v) => delimited(plain(v), sep)).join(sep));
      if (options.header) lines.unshift(columns.map((c) => delimited(c.name, sep)).join(sep));
      // Tab-separated like Excel puts it on the clipboard: CRLF between rows, none at the end.
      return format === 'tsv' ? lines.join('\r\n') : lines.join('\r\n') + '\r\n';
    }
    case 'markdown': {
      const lines = [
        `| ${columns.map((c) => markdown(c.name)).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map((v) => markdown(plain(v))).join(' | ')} |`),
      ];
      return lines.join('\n') + '\n';
    }
    case 'json': {
      const objects = rows.map((r) =>
        Object.fromEntries(
          columns.map((c, i) => [c.name, jsonValue(plain(r[i] ?? null), c.numeric)]),
        ),
      );
      return JSON.stringify(objects, null, 2);
    }
    case 'sql': {
      const names = columns.map((c) => quoteIdent(c.name, options.dialect)).join(', ');
      const values = block.rows
        .map(
          (r) =>
            `(${r.map((cell, i) => sqlValue(cell, columns[i]?.numeric ?? false, options.dialect)).join(', ')})`,
        )
        .join(',\n');
      return `INSERT INTO ${quoteIdent(options.table, options.dialect)} (${names}) VALUES\n${values};`;
    }
  }
}

/** Rows as the grid shows them, for an export: binary as 0x… hex, cut-off text as far as loaded. */
export function gridValues(
  columns: { name: string; numeric: boolean }[],
  rows: GridCell[][],
): Extract<ExportSource, { kind: 'values' }> {
  return {
    kind: 'values',
    columns: columns.map((c) => c.name),
    numeric: columns.map((c) => c.numeric),
    rows: rows.map((row) =>
      row.map((cell) => {
        if (cell === null || typeof cell === 'string') return cell;
        if (cell.kind === 'default') return null;
        if (cell.kind === 'sql') return cell.sql;
        if (cell.kind === 'binary') return `0x${cell.hex.toUpperCase()}`;
        return cell.text;
      }),
    ),
  };
}
