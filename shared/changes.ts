/**
 * Edits made in the data grid, and how they become SQL. Shared so the main process executes
 * exactly the statements the user previewed in the app.
 */
import { placeholder, qualifiedName, quoteIdent, stringLiteral } from './dialect';
import type { DbType } from './models';

/** Primary key column → the row's original value, as text. Identifies one row. */
export type RowKey = Record<string, string>;

/** Column → new value. `null` is SQL NULL; a column left out keeps its value (or its DEFAULT on insert). */
export type RowValues = Record<string, string | null>;

export interface ChangeSet {
  /** The table's primary key columns, as the UI understood them; the server checks this. */
  primaryKey: string[];
  deletes: { key: RowKey }[];
  updates: { key: RowKey; values: RowValues }[];
  inserts: { values: RowValues }[];
}

export interface ChangeStatement {
  kind: 'delete' | 'update' | 'insert';
  /** Index within its kind in the change set. */
  index: number;
  sql: string;
  params: (string | null)[];
  /** The same statement with the values written out, for showing to the user (never executed). */
  preview: string;
}

export interface ApplyResult {
  deleted: number;
  updated: number;
  inserted: number;
}

export { quoteIdent };

export function changeCount(changes: ChangeSet): number {
  return changes.deletes.length + changes.updates.length + changes.inserts.length;
}

/**
 * The statements for a change set, in a safe order: deletes, then updates, then inserts (so a key
 * freed by a delete can be reused). Every UPDATE and DELETE must hit exactly one row; MySQL also
 * gets LIMIT 1 (the others have no such clause; the driver checks the row count and rolls back).
 */
export function changeStatements(
  database: string,
  table: string,
  changes: ChangeSet,
  dialect: DbType = 'mysql',
): ChangeStatement[] {
  const target = qualifiedName(database, table, dialect);
  const q = (name: string) => quoteIdent(name, dialect);
  const limit = dialect === 'mysql' ? ' LIMIT 1' : '';
  const out: ChangeStatement[] = [];

  /** Builds the SQL twice: with placeholders to execute, and with literals to show. */
  const add = (
    kind: ChangeStatement['kind'],
    index: number,
    params: (string | null)[],
    build: (value: (i: number) => string) => string,
  ) => {
    out.push({
      kind,
      index,
      params,
      sql: build((i) => placeholder(i, dialect)),
      preview: build((i) => literal(params[i] ?? null, dialect)),
    });
  };
  const where = (key: RowKey, first: number, value: (i: number) => string) =>
    changes.primaryKey.map((c, i) => `${q(c)} = ${value(first + i)}`).join(' AND ');
  const keyParams = (key: RowKey) => changes.primaryKey.map((c) => key[c] ?? null);

  changes.deletes.forEach((d, index) => {
    add(
      'delete',
      index,
      keyParams(d.key),
      (v) => `DELETE FROM ${target} WHERE ${where(d.key, 0, v)}${limit}`,
    );
  });

  changes.updates.forEach((u, index) => {
    const columns = Object.keys(u.values);
    if (columns.length === 0) return;
    const params = [...columns.map((c) => u.values[c] ?? null), ...keyParams(u.key)];
    add(
      'update',
      index,
      params,
      (v) =>
        `UPDATE ${target} SET ${columns.map((c, i) => `${q(c)} = ${v(i)}`).join(', ')} WHERE ${where(u.key, columns.length, v)}${limit}`,
    );
  });

  changes.inserts.forEach((ins, index) => {
    const columns = Object.keys(ins.values);
    const params = columns.map((c) => ins.values[c] ?? null);
    add('insert', index, params, (v) =>
      columns.length === 0
        ? dialect === 'mysql'
          ? `INSERT INTO ${target} () VALUES ()`
          : `INSERT INTO ${target} DEFAULT VALUES`
        : `INSERT INTO ${target} (${columns.map(q).join(', ')}) VALUES (${columns.map((_, i) => v(i)).join(', ')})`,
    );
  });

  return out;
}

/** A statement with its `?` parameters filled in as literals (MySQL), for showing to the user. */
export function inlineParams(sql: string, params: (string | null)[]): string {
  let next = 0;
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === quote) quote = sql[i + 1] === quote ? ((out += sql[++i]!), quote) : null;
    } else if (ch === '`' || ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      out += literal(params[next++] ?? null, 'mysql');
    } else {
      out += ch;
    }
  }
  return out;
}

function literal(value: string | null, dialect: DbType): string {
  return value === null ? 'NULL' : stringLiteral(value, dialect);
}

/** A short, readable description of one row key, e.g. `id = 42`. */
export function describeKey(key: RowKey): string {
  return Object.entries(key)
    .map(([c, v]) => `${c} = ${v}`)
    .join(', ');
}
