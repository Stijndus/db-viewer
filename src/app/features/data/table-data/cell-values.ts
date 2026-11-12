/**
 * Values for "Waarde invoegen" in the grid menu, like HeidiSQL's Insert value: the current date and
 * time (local and UTC), a UNIX timestamp, GUIDs, SQL functions per dialect, and a file as a
 * binary literal.
 */
import type { SqlValue } from '../../../../../shared/changes';
import type { DbType } from '../../../../../shared/models';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export interface InsertValue {
  /** Menu label, with the value it inserts. */
  label: string;
  /** The value, made when chosen (a GUID per cell). */
  make: () => string;
}

/** The date and time values, as text the databases read as dates. */
export function dateValues(now: Date = new Date()): { local: InsertValue[]; utc: InsertValue[] } {
  const parts = (utc: boolean) => ({
    y: utc ? now.getUTCFullYear() : now.getFullYear(),
    mo: pad((utc ? now.getUTCMonth() : now.getMonth()) + 1),
    d: pad(utc ? now.getUTCDate() : now.getDate()),
    h: pad(utc ? now.getUTCHours() : now.getHours()),
    mi: pad(utc ? now.getUTCMinutes() : now.getMinutes()),
    s: pad(utc ? now.getUTCSeconds() : now.getSeconds()),
  });
  const l = parts(false);
  const u = parts(true);
  const unix = String(Math.floor(now.getTime() / 1000));
  const item = (label: string, value: string): InsertValue => ({
    label: `${label}: ${value}`,
    make: () => value,
  });
  return {
    local: [
      item('Datum en tijd', `${l.y}-${l.mo}-${l.d} ${l.h}:${l.mi}:${l.s}`),
      item('Datum', `${l.y}-${l.mo}-${l.d}`),
      item('Tijd', `${l.h}:${l.mi}:${l.s}`),
      item('Jaar', String(l.y)),
      item('UNIX-tijd', unix),
    ],
    utc: [
      item('UTC datum en tijd', `${u.y}-${u.mo}-${u.d} ${u.h}:${u.mi}:${u.s}`),
      item('UTC datum', `${u.y}-${u.mo}-${u.d}`),
      item('UTC tijd', `${u.h}:${u.mi}:${u.s}`),
    ],
  };
}

/** GUIDs in HeidiSQL's four forms; each cell gets its own. */
export function guidValues(example: string = crypto.randomUUID()): InsertValue[] {
  const forms: [string, (g: string) => string][] = [
    ['GUID', (g) => `{${g.toUpperCase()}}`],
    ['GUID zonder accolades', (g) => g.toUpperCase()],
    ['GUID kleine letters', (g) => `{${g}}`],
    ['GUID kleine letters zonder accolades', (g) => g],
  ];
  return forms.map(([label, format]) => ({
    label: `${label}: ${format(example)}`,
    make: () => format(crypto.randomUUID()),
  }));
}

/** Common functions to pick from in the SQL function prompt. */
export function sqlFunctionSuggestions(dialect: DbType): string[] {
  switch (dialect) {
    case 'mysql':
      return ['NOW()', 'CURRENT_DATE()', 'UTC_TIMESTAMP()', 'UUID()', 'UNIX_TIMESTAMP()', 'NULL'];
    case 'postgres':
      return ['now()', 'CURRENT_DATE', "timezone('utc', now())", 'gen_random_uuid()', 'NULL'];
    case 'mssql':
      return ['GETDATE()', 'SYSDATETIME()', 'GETUTCDATE()', 'NEWID()', 'NULL'];
    case 'sqlite':
      return ["datetime('now')", "datetime('now', 'localtime')", "date('now')", 'NULL'];
  }
}

/** Column types that hold bytes: a loaded file goes in as a binary literal. */
export function isBinaryType(type: string): boolean {
  return /blob|binary|bytea|image|varbinary/i.test(type);
}

/** A file's bytes as a binary literal for the dialect, labelled with its name and size. */
export function binaryValue(bytes: Uint8Array, name: string, dialect: DbType): SqlValue {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  hex = hex.toUpperCase();
  const sql =
    dialect === 'mssql'
      ? `0x${hex || '0'}`.replace(/^0x0$/, '0x')
      : dialect === 'postgres'
        ? `'\\x${hex}'::bytea`
        : `X'${hex}'`;
  return { sql, label: `${name} (${fileSize(bytes.length)})` };
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Bytes as text when they are valid UTF-8 (a file loaded into a text column), else null. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function base64Bytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesBase64(bytes: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
}
