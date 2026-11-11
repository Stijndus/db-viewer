import {
  changeStatements,
  describeKey,
  type ApplyResult,
  type ChangeSet,
  type ChangeStatement,
} from '../../shared/changes';
import { quoteIdent } from '../../shared/dialect';
import type { Cell, DbType, SortKey } from '../../shared/models';
import { AppError, toSqlError } from '../ipc/errors';

/** Building blocks every driver shares: value conversion, filter clauses, saving grid edits. */

/** A data query that runs longer is aborted. */
export const QUERY_TIMEOUT_MS = 30_000;
/** Longer strings are cut before they travel to the UI. */
export const MAX_TEXT_LENGTH = 2_000;
const BINARY_PREVIEW_BYTES = 32;
/** Absolute ceiling for "no limit" in the SQL editor, so one runaway SELECT can't exhaust memory. */
export const HARD_ROW_CAP = 100_000;

/** Turns a raw driver value into something small and safe to send over IPC. */
export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      kind: 'binary',
      bytes: bytes.length,
      hex: bytes.subarray(0, BINARY_PREVIEW_BYTES).toString('hex'),
    };
  }
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    text = String(value);
  else if (value instanceof Date) text = value.toISOString();
  else text = JSON.stringify(value); // JSON columns, spatial types
  return text.length > MAX_TEXT_LENGTH
    ? { kind: 'truncated', text: text.slice(0, MAX_TEXT_LENGTH), length: text.length }
    : text;
}

/**
 * The user's filter goes inside parentheses on its own lines, so a `--` comment in it can only
 * swallow the rest of its own line, never the closing parenthesis, ORDER BY or LIMIT.
 */
export function whereClause(where: string | undefined): string {
  const condition = where?.trim();
  return condition ? ` WHERE (\n${condition}\n)` : '';
}

export function orderByClause(orderBy: SortKey[], dialect: DbType = 'mysql'): string {
  if (orderBy.length === 0) return '';
  const keys = orderBy.map(
    (k) => `${quoteIdent(k.column, dialect)} ${k.direction === 'desc' ? 'DESC' : 'ASC'}`,
  );
  return ` ORDER BY ${keys.join(', ')}`;
}

/** What a driver found out about the table being edited. */
export interface EditTarget {
  /** null: no such table. */
  type: 'table' | 'view' | null;
  columns: string[];
  primaryKey: string[];
}

/**
 * Checks the change set against the real table before anything runs: it must be a table, its
 * primary key must be the one the UI used, every key must be complete, every column must exist.
 */
export function checkTarget(target: EditTarget, changes: ChangeSet): void {
  if (target.type === null) {
    throw new AppError('ER_NO_SUCH_TABLE', 'Tabel bestaat niet (meer).', 'Vernieuw het schema.');
  }
  if (target.type !== 'table') {
    throw new AppError('NOT_EDITABLE', 'Alleen tabellen kunnen worden bewerkt, geen views.');
  }
  const { primaryKey } = target;
  const samePk =
    primaryKey.length > 0 &&
    primaryKey.length === changes.primaryKey.length &&
    primaryKey.every((c) => changes.primaryKey.includes(c));
  if (!samePk) {
    throw new AppError(
      'NOT_EDITABLE',
      'Deze tabel kan niet worden bewerkt.',
      primaryKey.length === 0
        ? 'Hij heeft geen primaire sleutel, dus een rij is niet eenduidig aan te wijzen.'
        : 'De primaire sleutel is intussen veranderd. Vernieuw het schema.',
    );
  }
  const keys = [...changes.deletes.map((d) => d.key), ...changes.updates.map((u) => u.key)];
  for (const key of keys) {
    if (
      Object.keys(key).length !== primaryKey.length ||
      primaryKey.some((c) => typeof key[c] !== 'string')
    ) {
      throw new AppError('VALIDATION', 'Ongeldige rij-sleutel.');
    }
  }
  const names = new Set(target.columns);
  const valueSets = [
    ...changes.updates.map((u) => u.values),
    ...changes.inserts.map((i) => i.values),
  ];
  for (const values of valueSets) {
    const unknown = Object.keys(values).find((c) => !names.has(c));
    if (unknown)
      throw new AppError(
        'ER_BAD_FIELD_ERROR',
        `Kolom ${unknown} bestaat niet (meer).`,
        'Vernieuw het schema.',
      );
  }
}

/** One open transaction on a dedicated connection, as a driver provides it to `saveChanges`. */
export interface ChangeTransaction {
  /** Reads the table's type, columns and primary key. */
  target(): Promise<EditTarget>;
  begin(): Promise<void>;
  /** Runs one statement with its parameters and returns the number of affected rows. */
  execute(statement: ChangeStatement): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Saves grid edits in one transaction. Every UPDATE and DELETE must hit exactly one row, otherwise
 * everything is rolled back (the row was changed or removed by someone else). Errors name the row.
 */
export async function saveChanges(
  tx: ChangeTransaction,
  database: string,
  table: string,
  changes: ChangeSet,
  dialect: DbType,
): Promise<ApplyResult> {
  let inTransaction = false;
  let current: ChangeStatement | null = null;
  try {
    checkTarget(await tx.target(), changes);
    await tx.begin();
    inTransaction = true;
    const result: ApplyResult = { deleted: 0, updated: 0, inserted: 0 };
    for (const statement of changeStatements(database, table, changes, dialect)) {
      current = statement;
      const affected = await tx.execute(statement);
      if (statement.kind !== 'insert' && affected !== 1) {
        throw new AppError(
          'ROW_CHANGED',
          'Een rij is intussen gewijzigd of verwijderd.',
          'Vernieuw de data en probeer het opnieuw.',
        );
      }
      result[
        statement.kind === 'delete'
          ? 'deleted'
          : statement.kind === 'update'
            ? 'updated'
            : 'inserted'
      ]++;
    }
    await tx.commit();
    inTransaction = false;
    return result;
  } catch (err) {
    if (inTransaction) await tx.rollback().catch(() => undefined);
    const base =
      err instanceof AppError
        ? { code: err.code, message: err.message, hint: err.hint }
        : toSqlError(err);
    const where = current ? describeChange(current, changes) : null;
    throw new AppError(
      base.code,
      where ? `Opslaan mislukt bij ${where}: ${base.message}` : base.message,
      [base.hint, 'Er is niets opgeslagen.'].filter(Boolean).join(' '),
    );
  }
}

function describeChange(statement: ChangeStatement, changes: ChangeSet): string {
  const n = statement.index + 1;
  if (statement.kind === 'insert') return `nieuwe rij ${n}`;
  const key =
    statement.kind === 'delete'
      ? changes.deletes[statement.index]?.key
      : changes.updates[statement.index]?.key;
  const what = statement.kind === 'delete' ? 'verwijderen van' : 'wijzigen van';
  return `${what} de rij met ${key ? describeKey(key) : `nummer ${n}`}`;
}

/** Refuses grid edits on read-only connections, before any connection is used. */
export function refuseReadOnly(readOnly: boolean): void {
  if (readOnly) {
    throw new AppError(
      'READ_ONLY_CONNECTION',
      'Deze verbinding is alleen-lezen.',
      'Er is niets opgeslagen.',
    );
  }
}
