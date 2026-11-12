import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { qualifiedName, quoteIdent, stringLiteral } from '../../shared/dialect';
import {
  CLIPBOARD_MAX_BYTES,
  CLIPBOARD_MAX_ROWS,
  type DbType,
  type ExportRequest,
  type TransferProgress,
} from '../../shared/models';
import type { DbSession, RowBatch, RowSource } from '../db/driver';
import { AppError } from '../ipc/errors';
import { archiveError, sevenZip } from './archive';
import { XlsxWriter, type XlsxValue } from './xlsx';

const PROGRESS_MS = 200;

/** A value as text: dates without time zone games, binary as 0x… hex. Null stays null. */
export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  if (value instanceof Uint8Array)
    return '0x' + Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  return JSON.stringify(value);
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** CSV per RFC 4180 (CRLF): NULL is an empty field, an empty string is "". */
export function csvField(value: unknown, delimiter: string): string {
  const text = asText(value);
  if (text === null) return '';
  if (text === '' || text.includes(delimiter) || /["\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** JSON keeps numbers that are numbers; big integers and decimals stay exact as strings. */
export function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return asText(value);
}

/** A literal for the connection's dialect: strings quoted, numbers bare, binary as hex literal. */
export function sqlLiteral(value: unknown, dialect: DbType): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return dialect === 'postgres' ? String(value) : value ? '1' : '0';
  if (isBinary(value)) {
    const hex = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
    if (dialect === 'mssql') return `0x${hex}`;
    if (dialect === 'postgres') return `'\\x${hex}'`;
    return `X'${hex}'`;
  }
  return stringLiteral(asText(value)!, dialect);
}

/** Excel: numbers as numbers when they survive the trip (15 digits); everything else as text. */
function xlsxValue(value: unknown): XlsxValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = asText(value)!;
  if (/^-?(0|[1-9]\d{0,14})(\.\d{1,15})?$/.test(text) && text.replace(/[-.]/g, '').length <= 15)
    return Number(text);
  return text.length > 32767 ? text.slice(0, 32767) : text; // Excel's cell limit
}

/**
 * A Markdown table cell: pipes and backslashes escaped, line breaks as <br>, NULL in italics so it
 * differs from the text "NULL".
 */
export function markdownCell(value: unknown): string {
  const text = asText(value);
  if (text === null) return '*NULL*';
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

interface Output {
  stream: Writable;
  written(): number;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Where the bytes go: the file itself, through gzip, or into an archive. A 7z is written by 7-Zip
 * straight from the stream (encrypted, names hidden); a zip needs a temporary file first, which is
 * removed afterwards.
 */
async function openOutput(request: ExportRequest, innerName: string): Promise<Output> {
  const target = request.file;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const archive = request.archive;
  let written = 0;
  const count = new PassThrough();
  count.on('data', (d: Buffer) => (written += d.length));

  if (!archive) {
    const file = createWriteStream(target);
    count.pipe(file);
    return {
      stream: count,
      written: () => written,
      finish: () => endAndWait(count, file),
      abort: async () => {
        count.destroy();
        await destroyAndWait(file);
        await fs.rm(target, { force: true });
      },
    };
  }
  if (archive.kind === 'gzip') {
    const gzip = createGzip();
    const file = createWriteStream(target);
    count.pipe(gzip).pipe(file);
    return {
      stream: count,
      written: () => written,
      finish: () => endAndWait(count, file),
      abort: async () => {
        count.destroy();
        await destroyAndWait(file);
        await fs.rm(target, { force: true });
      },
    };
  }

  await fs.rm(target, { force: true }); // 7-Zip would add to an existing archive
  const password = archive.password
    ? [`-p${archive.password}`, ...(archive.kind === '7z' ? ['-mhe=on'] : ['-mem=AES256'])]
    : [];
  if (archive.kind === '7z') {
    const child = spawn(
      sevenZip(),
      ['a', '-bd', '-y', '-t7z', `-si${innerName}`, ...password, '--', target],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(archiveError(stderr, archive.password)),
      );
    });
    exited.catch(() => undefined);
    count.pipe(child.stdin);
    return {
      stream: count,
      written: () => written,
      finish: async () => {
        count.end();
        await exited;
      },
      abort: async () => {
        count.destroy();
        child.kill();
        await exited.catch(() => undefined);
        await fs.rm(target, { force: true });
      },
    };
  }

  // zip: 7-Zip cannot read zip input from a stream, so via a private temporary folder.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-export-'));
  const tmpFile = path.join(tmpDir, innerName);
  const file = createWriteStream(tmpFile, { mode: 0o600 });
  count.pipe(file);
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true });
  return {
    stream: count,
    written: () => written,
    finish: async () => {
      try {
        await endAndWait(count, file);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            sevenZip(),
            ['a', '-bd', '-y', '-tzip', ...password, '--', target, tmpFile],
            {
              stdio: ['ignore', 'ignore', 'pipe'],
              windowsHide: true,
            },
          );
          let stderr = '';
          child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
          child.once('error', reject);
          child.once('close', (code) =>
            code === 0 ? resolve() : reject(archiveError(stderr, archive.password)),
          );
        });
      } finally {
        await cleanup();
      }
    },
    abort: async () => {
      count.destroy();
      await destroyAndWait(file);
      await cleanup();
      await fs.rm(target, { force: true });
    },
  };
}

/**
 * Destroys a file stream and waits until its handle is closed. A stream that is still opening
 * would otherwise create the file after we removed it.
 */
/** Collects the export in memory for the clipboard; stops counting past the size limit. */
function memoryOutput(): Output & { text(): string } {
  const chunks: string[] = [];
  let bytes = 0;
  const stream = new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, done) {
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes <= CLIPBOARD_MAX_BYTES) chunks.push(text);
      done();
    },
  });
  return {
    stream,
    written: () => bytes,
    finish: () => new Promise((resolve) => stream.end(resolve)),
    abort: async () => {
      stream.destroy();
      chunks.length = 0;
    },
    text: () => chunks.join(''),
  };
}

function tooLargeForClipboard(): AppError {
  return new AppError(
    'CLIPBOARD_TOO_LARGE',
    `Te groot voor het klembord (meer dan ${CLIPBOARD_MAX_ROWS.toLocaleString('nl-NL')} rijen of ${CLIPBOARD_MAX_BYTES / 1024 / 1024} MB).`,
    'Exporteer naar een bestand, of beperk de rijen met een filter.',
  );
}

function destroyAndWait(file: Writable): Promise<void> {
  return new Promise((resolve) => {
    if (file.closed) return resolve();
    file.once('close', () => resolve());
    file.destroy();
  });
}

function endAndWait(stream: Writable, file: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    file.once('finish', resolve);
    file.once('error', reject);
    stream.end();
  });
}

function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.write(text)) resolve();
    else {
      stream.once('drain', resolve);
      stream.once('error', reject);
    }
  });
}

/** The file name inside an archive: the export's name without the archive extension. */
function innerFileName(request: ExportRequest): string {
  const base = path.basename(request.file).replace(/\.(gz|zip|7z)$/i, '');
  const ext = request.format === 'markdown' ? '.md' : `.${request.format}`;
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

/**
 * Writes an export to disk: a table or query result as CSV, JSON, SQL INSERTs or Excel, or several
 * tables of a database as one SQL script. Rows stream from the server batch by batch.
 */
export async function exportData(
  session: DbSession,
  dialect: DbType,
  request: ExportRequest,
  jobId: string,
  report: (progress: TransferProgress) => void,
  signal: AbortSignal,
  writeClipboard: (text: string) => void = () => undefined,
): Promise<TransferProgress> {
  const toClipboard = request.destination === 'clipboard';
  const progress: TransferProgress = {
    jobId,
    kind: 'export',
    phase: 'running',
    bytes: 0,
    totalBytes: null,
    statements: 0,
    failed: 0,
    errors: [],
    ...(toClipboard ? { clipboard: true } : { file: request.file }),
  };
  if (toClipboard && (request.format === 'xlsx' || request.archive)) {
    throw new AppError(
      'EXPORT_FORMAT',
      'Excel en ingepakte bestanden kunnen niet naar het klembord.',
    );
  }
  const { source, format } = request;
  if (source.kind === 'database' && format !== 'sql') {
    throw new AppError('EXPORT_FORMAT', 'Een hele database wordt als SQL-script geëxporteerd.');
  }
  if (request.archive?.kind === 'gzip' && request.archive.password) {
    throw new AppError('EXPORT_GZIP_PASSWORD', 'Gzip kan geen wachtwoord hebben; kies 7z of zip.');
  }

  const memory = toClipboard ? memoryOutput() : null;
  const out = memory ?? (await openOutput(request, innerFileName(request)));
  let last = 0;
  const tick = (force = false) => {
    progress.bytes = out.written();
    if (
      memory &&
      (progress.bytes > CLIPBOARD_MAX_BYTES || progress.statements > CLIPBOARD_MAX_ROWS)
    )
      throw tooLargeForClipboard();
    const now = Date.now();
    if (force || now - last >= PROGRESS_MS) {
      last = now;
      report({ ...progress });
    }
  };

  try {
    if (format === 'xlsx')
      await writeXlsx(session, source as RowSource, out.stream, request, progress, tick, signal);
    else if (format === 'csv')
      await writeCsv(session, source as RowSource, out.stream, request, progress, tick, signal);
    else if (format === 'json')
      await writeJson(session, source as RowSource, out.stream, request, progress, tick, signal);
    else if (format === 'markdown')
      await writeMarkdown(session, source as RowSource, out.stream, progress, tick, signal);
    else await writeSql(session, dialect, out.stream, request, progress, tick, signal);
    if (signal.aborted) throw new AppError('CANCELLED', 'Export gestopt.');
    await out.finish();
    if (memory) {
      // Statements written outside a batch (SQL header, DDL) can still pass the limit at the end.
      if (out.written() > CLIPBOARD_MAX_BYTES) throw tooLargeForClipboard();
      writeClipboard(memory.text());
    }
    progress.phase = 'done';
  } catch (err) {
    await out.abort();
    if (signal.aborted) {
      progress.phase = 'cancelled';
      tick(true);
      return progress;
    }
    throw err;
  }
  tick(true);
  return progress;
}

type Tick = () => void;

async function writeCsv(
  session: DbSession,
  source: RowSource,
  out: Writable,
  request: ExportRequest,
  progress: TransferProgress,
  tick: Tick,
  signal: AbortSignal,
) {
  const { delimiter, header, bom } = request.csv ?? { delimiter: ',', header: true, bom: false };
  let first = true;
  if (bom) await write(out, '﻿');
  await session.streamRows(
    source,
    async ({ columns, rows }) => {
      let text = '';
      if (first && header)
        text += columns.map((c) => csvField(c, delimiter)).join(delimiter) + '\r\n';
      first = false;
      for (const row of rows)
        text += row.map((v) => csvField(v, delimiter)).join(delimiter) + '\r\n';
      await write(out, text);
      progress.statements += rows.length;
      tick();
    },
    signal,
  );
}

async function writeMarkdown(
  session: DbSession,
  source: RowSource,
  out: Writable,
  progress: TransferProgress,
  tick: Tick,
  signal: AbortSignal,
) {
  let first = true;
  await session.streamRows(
    source,
    async ({ columns, rows }) => {
      let text = '';
      if (first) {
        text += `| ${columns.map(markdownCell).join(' | ')} |\n`;
        text += `| ${columns.map(() => '---').join(' | ')} |\n`;
      }
      first = false;
      for (const row of rows) text += `| ${row.map(markdownCell).join(' | ')} |\n`;
      await write(out, text);
      progress.statements += rows.length;
      tick();
    },
    signal,
  );
}

async function writeJson(
  session: DbSession,
  source: RowSource,
  out: Writable,
  request: ExportRequest,
  progress: TransferProgress,
  tick: Tick,
  signal: AbortSignal,
) {
  const lines = request.json?.style === 'lines';
  let first = true;
  if (!lines) await write(out, '[');
  await session.streamRows(
    source,
    async ({ columns, rows }: RowBatch) => {
      let text = '';
      for (const row of rows) {
        const obj: Record<string, unknown> = {};
        columns.forEach((c, i) => (obj[c] = jsonValue(row[i])));
        text += lines
          ? JSON.stringify(obj) + '\n'
          : (first ? '\n  ' : ',\n  ') + JSON.stringify(obj);
        first = false;
      }
      await write(out, text);
      progress.statements += rows.length;
      tick();
    },
    signal,
  );
  if (!lines) await write(out, first ? ']\n' : '\n]\n');
}

async function writeXlsx(
  session: DbSession,
  source: RowSource,
  out: Writable,
  request: ExportRequest,
  progress: TransferProgress,
  tick: Tick,
  signal: AbortSignal,
) {
  const name =
    source.kind === 'table'
      ? source.table
      : path.basename(request.file).replace(/\.[^.]+$/, '') || 'Export';
  const xlsx = new XlsxWriter(out, name);
  let started = false;
  await session.streamRows(
    source,
    async ({ columns, rows }) => {
      if (!started) await xlsx.start(columns);
      started = true;
      for (const row of rows) await xlsx.row(row.map(xlsxValue));
      progress.statements += rows.length;
      tick();
    },
    signal,
  );
  if (!started) await xlsx.start([]);
  await xlsx.finish();
}

/** INSERT statements (and for a database or on request: DROP/CREATE TABLE), in the connection's dialect. */
async function writeSql(
  session: DbSession,
  dialect: DbType,
  out: Writable,
  request: ExportRequest,
  progress: TransferProgress,
  tick: Tick,
  signal: AbortSignal,
) {
  const opts = request.sql ?? { rowsPerInsert: 100 };
  // SQL Server takes at most 1000 rows in one VALUES list.
  const perInsert = Math.max(
    1,
    Math.min(opts.rowsPerInsert || 100, dialect === 'mssql' ? 1000 : 10_000),
  );
  const go = dialect === 'mssql' ? '\nGO\n' : '\n';
  const end = dialect === 'mssql' ? '' : ';';
  const source = request.source;

  await write(
    out,
    `-- Export uit DB Viewer, ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n`,
  );
  const tables: { source: RowSource; name: string; ddl: boolean }[] = [];
  if (source.kind === 'database') {
    for (const table of source.tables) {
      tables.push({
        source: { kind: 'table', database: source.database, table, orderBy: [] },
        name: table,
        ddl: source.structure,
      });
    }
  } else if (source.kind === 'table') {
    tables.push({ source, name: source.table, ddl: Boolean(opts.createTable) });
  } else {
    tables.push({ source, name: opts.tableName || 'export', ddl: false });
  }
  const withData = source.kind !== 'database' || source.data;
  const dropFirst = source.kind === 'database' ? source.structure : Boolean(opts.dropTable);

  // Load order doesn't follow foreign keys: switch their checks off where a script can.
  if (dialect === 'mysql')
    await write(out, '/*!40101 SET NAMES utf8mb4 */;\nSET FOREIGN_KEY_CHECKS = 0;\n');
  if (dialect === 'sqlite') await write(out, 'PRAGMA foreign_keys = OFF;\nBEGIN;\n');

  for (const t of tables) {
    if (signal.aborted) return;
    const name = quoteIdent(t.name, dialect);
    await write(out, `\n-- ${t.name}\n`);
    if (t.ddl && t.source.kind === 'table') {
      if (dropFirst) await write(out, `DROP TABLE IF EXISTS ${name}${end}${go}`);
      const ddl = await session.tableDdl(t.source.database, t.source.table);
      // The DDL names the table with its schema; scripts load into the chosen database.
      await write(out, unqualify(ddl, t.source.database, t.source.table, dialect) + end + go);
    }
    if (!withData) continue;
    let identity = false;
    if (dialect === 'mssql' && t.source.kind === 'table') {
      const cols = await session.listColumns(t.source.database, t.source.table);
      identity = cols.some((c) => /identity/i.test(c.extra));
      if (identity) await write(out, `SET IDENTITY_INSERT ${name} ON${go}`);
    }
    await session.streamRows(
      t.source,
      async ({ columns, rows }) => {
        let text = '';
        const head = `INSERT INTO ${name} (${columns.map((c) => quoteIdent(c, dialect)).join(', ')}) VALUES\n`;
        for (let i = 0; i < rows.length; i += perInsert) {
          const chunk = rows.slice(i, i + perInsert);
          text +=
            head +
            chunk.map((r) => `(${r.map((v) => sqlLiteral(v, dialect)).join(', ')})`).join(',\n') +
            end +
            go;
        }
        if (text) await write(out, text);
        progress.statements += rows.length;
        tick();
      },
      signal,
    );
    if (identity) await write(out, `SET IDENTITY_INSERT ${name} OFF${go}`);
  }

  if (dialect === 'mysql') await write(out, '\nSET FOREIGN_KEY_CHECKS = 1;\n');
  if (dialect === 'sqlite') await write(out, '\nCOMMIT;\n');
}

/** `CREATE TABLE "public"."t"` → `CREATE TABLE "t"`; MySQL's SHOW CREATE TABLE has no schema. */
function unqualify(ddl: string, database: string, table: string, dialect: DbType): string {
  return ddl.replace(qualifiedName(database, table, dialect), quoteIdent(table, dialect));
}
