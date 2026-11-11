/**
 * Edits made in the data grid, and how they become SQL. Shared so the main process executes
 * exactly the statements the user previewed in the app.
 */

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
}

export interface ApplyResult {
  deleted: number;
  updated: number;
  inserted: number;
}

/** Quotes a MySQL identifier: wraps in backticks and doubles any backtick inside. */
export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

export function changeCount(changes: ChangeSet): number {
  return changes.deletes.length + changes.updates.length + changes.inserts.length;
}

/**
 * The statements for a change set, in a safe order: deletes, then updates, then inserts (so a key
 * freed by a delete can be reused). UPDATE and DELETE carry LIMIT 1 and must hit exactly one row.
 */
export function changeStatements(
  database: string,
  table: string,
  changes: ChangeSet,
): ChangeStatement[] {
  const target = `${quoteIdent(database)}.${quoteIdent(table)}`;
  const where = (key: RowKey) => {
    const columns = changes.primaryKey;
    return {
      sql: columns.map((c) => `${quoteIdent(c)} = ?`).join(' AND '),
      params: columns.map((c) => key[c] ?? null),
    };
  };
  const out: ChangeStatement[] = [];

  changes.deletes.forEach((d, index) => {
    const w = where(d.key);
    out.push({
      kind: 'delete',
      index,
      sql: `DELETE FROM ${target} WHERE ${w.sql} LIMIT 1`,
      params: w.params,
    });
  });

  changes.updates.forEach((u, index) => {
    const columns = Object.keys(u.values);
    if (columns.length === 0) return;
    const w = where(u.key);
    out.push({
      kind: 'update',
      index,
      sql: `UPDATE ${target} SET ${columns.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE ${w.sql} LIMIT 1`,
      params: [...columns.map((c) => u.values[c] ?? null), ...w.params],
    });
  });

  changes.inserts.forEach((ins, index) => {
    const columns = Object.keys(ins.values);
    out.push({
      kind: 'insert',
      index,
      sql:
        columns.length === 0
          ? `INSERT INTO ${target} () VALUES ()`
          : `INSERT INTO ${target} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      params: columns.map((c) => ins.values[c] ?? null),
    });
  });

  return out;
}

/** A statement with its parameters filled in as literals, for showing to the user (never executed). */
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
      out += literal(params[next++] ?? null);
    } else {
      out += ch;
    }
  }
  return out;
}

function literal(value: string | null): string {
  if (value === null) return 'NULL';
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

/** A short, readable description of one row key, e.g. `id = 42`. */
export function describeKey(key: RowKey): string {
  return Object.entries(key)
    .map(([c, v]) => `${c} = ${v}`)
    .join(', ');
}
