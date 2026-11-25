import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type {
  CsvEncoding,
  DataFileFormat,
  DataFileOptions,
  DataPreview,
} from '../../shared/models';
import type { ImportCell } from '../../shared/import-sql';
import { AppError } from '../ipc/errors';
import { extractEntry, isArchive, listArchive } from './archive';
import { openSource, type Source } from './sql-import';

/**
 * Readers for CSV, JSON and Excel files: each gives the column names and then the rows, one by
 * one. CSV and Excel are streamed, so a file of millions of rows never sits in memory; JSON is
 * parsed whole (it has to be, to know all keys).
 */

export interface DataReader {
  format: DataFileFormat;
  columns: string[];
  rows: AsyncIterable<ImportCell[]>;
  /** Bytes (or a share of them) read, towards `total`. */
  read(): number;
  total: number | null;
  rowCount?: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  sheets?: string[];
  sheet?: string;
  close(): Promise<void>;
}

/** The largest JSON file read (it is parsed in memory). */
export const JSON_MAX_BYTES = 512 * 1024 * 1024;
const PREVIEW_ROWS = 20;
const PREVIEW_CHARS = 300;

export function formatOf(name: string): DataFileFormat | null {
  if (/\.(csv|tsv|txt)(\.gz)?$/i.test(name)) return 'csv';
  if (/\.(json|jsonl|ndjson)(\.gz)?$/i.test(name)) return 'json';
  if (/\.xlsx$/i.test(name)) return 'xlsx';
  return null;
}

export async function openDataFile(options: DataFileOptions): Promise<DataReader> {
  const name = options.entry ?? options.file;
  const format = options.format ?? formatOf(name);
  if (!format) {
    throw new AppError(
      'DATA_FORMAT_UNKNOWN',
      'Dit is geen CSV-, JSON- of Excel-bestand.',
      'Kies een bestand dat eindigt op .csv, .tsv, .txt, .json, .jsonl of .xlsx.',
    );
  }
  if (format === 'xlsx') return openXlsx(options);
  const source = await openSource(options);
  try {
    return format === 'csv' ? await openCsv(source, options) : await openJson(source);
  } catch (err) {
    source.close();
    throw err;
  }
}

/** The first rows, for the dialog. */
export async function previewDataFile(options: DataFileOptions): Promise<DataPreview> {
  const reader = await openDataFile(options);
  const rows: (string | null)[][] = [];
  try {
    for await (const row of reader.rows) {
      rows.push(row.map(previewText));
      if (rows.length >= PREVIEW_ROWS) break;
    }
  } finally {
    await reader.close();
  }
  return {
    format: reader.format,
    columns: reader.columns,
    rows,
    ...(reader.rowCount !== undefined && { rowCount: reader.rowCount }),
    ...(reader.delimiter !== undefined && { delimiter: reader.delimiter }),
    ...(reader.encoding && { encoding: reader.encoding }),
    ...(reader.sheets && { sheets: reader.sheets, sheet: reader.sheet }),
  };
}

function previewText(value: ImportCell): string | null {
  if (value === null) return null;
  const text = String(value);
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text;
}

/** Column names for a file without a header row, or with blank names. */
function columnNames(header: string[] | null, width: number): string[] {
  const names: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    let name = header?.[i]?.trim() || `Kolom ${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    names.push(name);
  }
  return names;
}

// ── Bytes to text ──────────────────────────────────────────────────

/** Reads the first bytes of a stream and hands them back with an iterator for the rest. */
async function head(
  stream: Readable,
  size: number,
): Promise<{ first: Buffer; rest: AsyncIterator<Buffer>; finished: boolean }> {
  const rest = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const parts: Buffer[] = [];
  let length = 0;
  let finished = false;
  while (length < size) {
    const next = await rest.next();
    if (next.done) {
      finished = true;
      break;
    }
    const chunk = typeof next.value === 'string' ? Buffer.from(next.value) : next.value;
    parts.push(chunk);
    length += chunk.length;
  }
  return { first: Buffer.concat(parts), rest, finished };
}

/** BOM first; then UTF-8 if the bytes are valid UTF-8, else Windows-1252 (Excel's CSV). */
export function detectEncoding(bytes: Buffer): CsvEncoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  try {
    // Streaming: a multi-byte character cut at the end of the sample is fine.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

function decoderFor(encoding: CsvEncoding): TextDecoder {
  // Node's TextDecoder has no "iso-8859-1" of its own: it maps the label to windows-1252.
  return new TextDecoder(encoding === 'iso-8859-1' ? 'latin1' : encoding);
}

async function* decode(
  first: Buffer,
  rest: AsyncIterator<Buffer>,
  finished: boolean,
  encoding: CsvEncoding,
): AsyncGenerator<string> {
  const decoder = decoderFor(encoding); // drops a BOM
  yield decoder.decode(first, { stream: true });
  if (!finished) {
    for (;;) {
      const next = await rest.next();
      if (next.done) break;
      yield decoder.decode(next.value, { stream: true });
    }
  }
  yield decoder.decode();
}

function assertText(text: string): void {
  if (text.slice(0, 65536).includes('\u0000')) {
    throw new AppError(
      'NOT_TEXT',
      'Dit bestand is geen tekst.',
      'Is het een binair bestand, of klopt het wachtwoord van het archief niet?',
    );
  }
}

// ── CSV ────────────────────────────────────────────────────────────

/** A streaming CSV parser (RFC 4180): quoted fields with "" inside, CRLF or LF line ends. */
export class CsvParser {
  private field = '';
  private row: string[] = [];
  private quoted = false;
  /** Inside a quoted field. */
  private inQuotes = false;
  /** A quote just ended a quoted part: a second one is a literal quote. */
  private quoteEnd = false;

  constructor(private readonly delimiter: string) {}

  push(text: string): string[][] {
    const rows: string[][] = [];
    const d = this.delimiter;
    let field = this.field;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (this.inQuotes) {
        if (ch === '"') {
          this.inQuotes = false;
          this.quoteEnd = true;
        } else field += ch;
        continue;
      }
      if (this.quoteEnd) {
        this.quoteEnd = false;
        if (ch === '"') {
          field += '"';
          this.inQuotes = true;
          continue;
        }
      }
      if (ch === '"' && field === '' && !this.quoted) {
        this.inQuotes = true;
        this.quoted = true;
      } else if (ch === d) {
        this.row.push(field);
        field = '';
        this.quoted = false;
      } else if (ch === '\n') {
        this.row.push(field.endsWith('\r') && !this.quoted ? field.slice(0, -1) : field);
        field = '';
        this.quoted = false;
        const row = this.row;
        this.row = [];
        if (!(row.length === 1 && row[0] === '')) rows.push(row);
      } else if (ch === '\r' && this.quoted) {
        // After a closing quote: the \n follows.
      } else field += ch;
    }
    this.field = field;
    return rows;
  }

  end(): string[][] {
    const rows = this.push('\n');
    this.inQuotes = false;
    return rows;
  }
}

/** The delimiter that splits the first lines into the same number of fields, most often. */
export function detectDelimiter(sample: string): string {
  const lines = sample
    .split(/\r?\n/)
    .slice(0, 21)
    .filter((l) => l.trim() !== '');
  if (lines.length > 1 && !sample.endsWith('\n')) lines.pop(); // the last line may be cut off
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const firstCount = counts[0] ?? 0;
    if (firstCount === 0) continue;
    const same = counts.filter((c) => c === firstCount).length;
    const score = same * 1000 + firstCount;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}

async function openCsv(source: Source, options: DataFileOptions): Promise<DataReader> {
  const { first, rest, finished } = await head(source.stream, 64 * 1024);
  const encoding = options.encoding ?? detectEncoding(first);
  const chunks = decode(first, rest, finished, encoding);
  const firstText = (await chunks.next()).value ?? '';
  assertText(firstText);
  const name = options.entry ?? options.file;
  const delimiter =
    options.delimiter || (/\.tsv(\.gz)?$/i.test(name) ? '\t' : detectDelimiter(firstText));
  const parser = new CsvParser(delimiter);
  const header = options.header !== false;

  // The first row decides the columns: read until it is complete.
  const pending: string[][] = parser.push(firstText);
  let ended = false;
  while (pending.length === 0 && !ended) {
    const next = await chunks.next();
    if (next.done) {
      pending.push(...parser.end());
      ended = true;
    } else pending.push(...parser.push(next.value));
  }
  const firstRow = pending[0] ?? [];
  const columns = columnNames(header ? firstRow : null, firstRow.length);
  if (header) pending.shift();
  const width = columns.length;
  const fit = (row: string[]): ImportCell[] =>
    row.length === width
      ? row
      : row.length > width
        ? row.slice(0, width)
        : [...row, ...Array<string | null>(width - row.length).fill(null)];

  async function* rows(): AsyncGenerator<ImportCell[]> {
    for (const row of pending.splice(0)) yield fit(row);
    if (ended) return;
    for (;;) {
      const next = await chunks.next();
      if (next.done) break;
      for (const row of parser.push(next.value)) yield fit(row);
    }
    for (const row of parser.end()) yield fit(row);
    await source.done;
  }

  return {
    format: 'csv',
    columns,
    rows: rows(),
    read: source.read,
    total: source.total,
    delimiter,
    encoding,
    close: async () => source.close(),
  };
}

// ── JSON ───────────────────────────────────────────────────────────

async function openJson(source: Source): Promise<DataReader> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of source.stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > JSON_MAX_BYTES) {
      source.close();
      throw new AppError(
        'JSON_TOO_LARGE',
        'Dit JSON-bestand is te groot (meer dan 512 MB).',
        'Gebruik JSON Lines (één object per regel) of CSV voor zulke hoeveelheden.',
      );
    }
    parts.push(chunk);
  }
  await source.done;
  const bytes = Buffer.concat(parts);
  const text = decoderFor(detectEncoding(bytes)).decode(bytes);
  assertText(text);
  const records = parseJsonRecords(text);
  const columns: string[] = [];
  const known = new Set<string>();
  const arrays = records.length > 0 && records.every(Array.isArray);
  if (arrays) {
    const width = Math.max(0, ...records.map((r) => (r as unknown[]).length));
    columns.push(...columnNames(null, width));
  } else {
    for (const r of records) {
      for (const key of Object.keys(r as object)) {
        if (!known.has(key)) {
          known.add(key);
          columns.push(key);
        }
      }
    }
  }
  let done = 0;
  async function* rows(): AsyncGenerator<ImportCell[]> {
    for (const r of records) {
      done++;
      yield arrays
        ? columns.map((_, i) => jsonCell((r as unknown[])[i]))
        : columns.map((c) => jsonCell((r as Record<string, unknown>)[c]));
    }
  }
  return {
    format: 'json',
    columns,
    rows: rows(),
    read: () => (records.length ? Math.round((bytes.length * done) / records.length) : 0),
    total: bytes.length,
    rowCount: records.length,
    close: async () => undefined,
  };
}

/** An array of objects, an object holding one such array, or JSON Lines. */
export function parseJsonRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    // JSON Lines: one value per line.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length > 1) {
      try {
        value = lines.map((l) => JSON.parse(l) as unknown);
      } catch {
        throw jsonError(err);
      }
    } else throw jsonError(err);
  }
  if (!Array.isArray(value) && value && typeof value === 'object') {
    const arrays = Object.values(value).filter(Array.isArray);
    value = arrays.length === 1 ? arrays[0] : [value];
  }
  if (!Array.isArray(value)) {
    throw new AppError(
      'JSON_SHAPE',
      'Dit JSON-bestand bevat geen lijst met rijen.',
      'Verwacht: een array van objecten, bijvoorbeeld [{"id": 1, "naam": "…"}].',
    );
  }
  const records = value.filter((v) => v !== null && typeof v === 'object');
  if (records.length !== value.length) {
    throw new AppError(
      'JSON_SHAPE',
      'Niet elk element van de JSON-array is een object.',
      'Verwacht: een array van objecten, bijvoorbeeld [{"id": 1, "naam": "…"}].',
    );
  }
  return records;
}

function jsonError(err: unknown): AppError {
  return new AppError(
    'JSON_INVALID',
    'Dit is geen geldige JSON.',
    err instanceof Error ? err.message : undefined,
  );
}

function jsonCell(value: unknown): ImportCell {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return JSON.stringify(value);
}

// ── Excel ──────────────────────────────────────────────────────────

async function readEntry(file: string, entry: string): Promise<string> {
  const x = extractEntry(file, entry);
  const parts: Buffer[] = [];
  for await (const chunk of x.stream as AsyncIterable<Buffer>) parts.push(chunk);
  await x.done;
  return Buffer.concat(parts).toString('utf8');
}

export function xmlText(s: string): string {
  return s
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
      switch (e.toLowerCase()) {
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'amp':
          return '&';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
      }
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? xmlText(m[1]!) : undefined;
}

/** All <t> text of a shared string or inline string; phonetic runs left out. */
function richText(xml: string): string {
  let text = '';
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g))
    text += xmlText(m[1] ?? '');
  return text;
}

export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) =>
    richText(m[1] ?? ''),
  );
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Per cell style (the `s` attribute): what a number means, date, time or both. */
export function parseDateStyles(xml: string): ('date' | 'time' | 'datetime' | null)[] {
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1]!, 'numFmtId'));
    const code = attr(m[1]!, 'formatCode');
    if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  return [...xfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => {
    const id = Number(attr(m[1]!, 'numFmtId') ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id))
      return id === 18 || id === 19 || id === 20 || id === 21 || id === 45 || id === 46 || id === 47
        ? 'time'
        : id === 22
          ? 'datetime'
          : 'date';
    const code = custom.get(id);
    return code === undefined ? null : dateKind(code);
  });
}

/** What a custom number format shows: quoted text, [colors] and escapes don't count. */
function dateKind(code: string): 'date' | 'time' | 'datetime' | null {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .split(';')[0]!;
  const date = /[dy]/i.test(bare) || /m{3,}/i.test(bare);
  const time = /[hs]/i.test(bare);
  if (date && time) return 'datetime';
  if (date) return 'date';
  if (time) return 'time';
  // "m" alone or "mm/…": a month, unless next to hours or seconds.
  return /m/i.test(bare) ? 'date' : null;
}

/** An Excel serial number as text: 2024-03-01, 13:45:00 or 2024-03-01 13:45:00. */
export function excelDate(
  serial: number,
  kind: 'date' | 'time' | 'datetime',
  date1904 = false,
): string {
  const days = serial + (date1904 ? 1462 : 0);
  // 25569 = days from 1899-12-30 to 1970-01-01; rounded to the second like Excel shows it.
  const ms = Math.round((days - 25569) * 86400) * 1000;
  const iso = new Date(ms).toISOString();
  const d = iso.slice(0, 10);
  const t = iso.slice(11, 19);
  if (kind === 'time' && serial < 1) return t;
  if (kind === 'date' && Number.isInteger(serial)) return d;
  return `${d} ${t}`;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** Excel stores 15 significant digits; the XML can hold binary noise past that. */
function excelNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(15)));
}

interface XlsxBook {
  sheets: { name: string; path: string }[];
  date1904: boolean;
}

async function xlsxBook(file: string): Promise<XlsxBook> {
  let listing;
  try {
    listing = await listArchive(file);
  } catch {
    throw notXlsx();
  }
  const names = new Set(listing.entries.map((e) => e.path.replace(/\\/g, '/')));
  if (!names.has('xl/workbook.xml')) throw notXlsx();
  const workbook = await readEntry(file, 'xl/workbook.xml');
  const rels = names.has('xl/_rels/workbook.xml.rels')
    ? await readEntry(file, 'xl/_rels/workbook.xml.rels')
    : '';
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id && target) {
      targets.set(id, target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target));
    }
  }
  const sheets: XlsxBook['sheets'] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1]!, 'name') ?? `Blad${sheets.length + 1}`;
    const rid = /\br:id="([^"]*)"|\bid="([^"]*)"/.exec(m[1]!);
    const target = targets.get(rid?.[1] ?? rid?.[2] ?? '');
    if (target && names.has(target)) sheets.push({ name, path: target });
  }
  if (sheets.length === 0) throw notXlsx();
  return { sheets, date1904: /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook) };
}

function notXlsx(): AppError {
  return new AppError(
    'XLSX_INVALID',
    'Dit is geen leesbaar Excel-bestand (.xlsx).',
    'Oudere .xls-bestanden kun je in Excel opslaan als .xlsx of CSV.',
  );
}

async function openXlsx(options: DataFileOptions): Promise<DataReader> {
  // Inside an archive: unpack the .xlsx to a temporary file first (it is a zip itself).
  let file = options.file;
  let temp: string | null = null;
  if (isArchive(options.file) && options.entry) {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-xlsx-'));
    file = path.join(temp, 'book.xlsx');
    const x = extractEntry(options.file, options.entry, options.password);
    await pipeline(x.stream, createWriteStream(file));
    await x.done;
  }
  const cleanup = async () => {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const book = await xlsxBook(file);
    const sheet = book.sheets.find((s) => s.name === options.sheet) ?? book.sheets[0]!;
    const listing = await listArchive(file);
    const entryNames = new Set(listing.entries.map((e) => e.path.replace(/\\/g, '/')));
    const strings = entryNames.has('xl/sharedStrings.xml')
      ? parseSharedStrings(await readEntry(file, 'xl/sharedStrings.xml'))
      : [];
    const styles = entryNames.has('xl/styles.xml')
      ? parseDateStyles(await readEntry(file, 'xl/styles.xml'))
      : [];
    const size =
      listing.entries.find((e) => e.path.replace(/\\/g, '/') === sheet.path)?.size ?? null;

    const x = extractEntry(file, sheet.path);
    let read = 0;
    x.stream.on('data', (d: Buffer) => (read += d.length));
    const rowIter = sheetRows(x.stream, strings, styles, book.date1904);

    const header = options.header !== false;
    let first: ImportCell[] | undefined;
    const firstNext = await rowIter.next();
    if (!firstNext.done) first = firstNext.value;
    const width = first?.length ?? 0;
    const columns = columnNames(
      header && first ? first.map((v) => (v === null ? '' : String(v))) : null,
      width,
    );
    const fit = (row: ImportCell[]) =>
      row.length >= width
        ? row.slice(0, width)
        : [...row, ...Array<null>(width - row.length).fill(null)];

    async function* rows(): AsyncGenerator<ImportCell[]> {
      if (first && !header) yield fit(first);
      for (;;) {
        const next = await rowIter.next();
        if (next.done) break;
        yield fit(next.value);
      }
      await x.done;
    }
    return {
      format: 'xlsx',
      columns,
      rows: rows(),
      read: () => read,
      total: size,
      sheets: book.sheets.map((s) => s.name),
      sheet: sheet.name,
      close: async () => {
        x.kill();
        await cleanup();
      },
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** The rows of a worksheet's XML, streamed: empty rows are left out. */
export async function* sheetRows(
  stream: AsyncIterable<Buffer | string> | Iterable<string>,
  strings: string[],
  styles: ('date' | 'time' | 'datetime' | null)[],
  date1904 = false,
): AsyncGenerator<ImportCell[]> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  const take = function* (final: boolean): Generator<ImportCell[]> {
    rowRe.lastIndex = 0;
    let consumed = 0;
    for (;;) {
      const m = rowRe.exec(buffer);
      if (!m) break;
      consumed = rowRe.lastIndex;
      const row = parseRow(m[1] ?? '', strings, styles, date1904);
      if (row.some((v) => v !== null && v !== '')) yield row;
    }
    buffer = buffer.slice(consumed);
    // Keep only what may be the start of the next row.
    if (!final) {
      const start = buffer.lastIndexOf('<row');
      buffer = start >= 0 ? buffer.slice(start) : buffer.slice(-8);
    }
  };
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* take(false);
  }
  buffer += decoder.decode();
  yield* take(true);
}

function parseRow(
  xml: string,
  strings: string[],
  styles: ('date' | 'time' | 'datetime' | null)[],
  date1904: boolean,
): ImportCell[] {
  const row: ImportCell[] = [];
  let next = 0;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1]!;
    const body = m[2] ?? '';
    const ref = attr(attrs, 'r');
    const index = ref ? columnIndex(ref) : next;
    next = index + 1;
    const type = attr(attrs, 't') ?? 'n';
    const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
    let value: ImportCell = null;
    switch (type) {
      case 's':
        value = v === undefined ? null : (strings[Number(v)] ?? null);
        break;
      case 'inlineStr':
        value = richText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
        break;
      case 'str':
        value = v === undefined ? null : xmlText(v);
        break;
      case 'b':
        value = v === undefined ? null : v === '1' || v === 'true';
        break;
      case 'e':
        value = null; // #N/A, #DIV/0! and the like
        break;
      case 'd':
        value = v === undefined ? null : xmlText(v).replace('T', ' ').replace(/Z$/, '');
        break;
      default: {
        if (v === undefined) break;
        const kind = styles[Number(attr(attrs, 's') ?? 0)] ?? null;
        const n = Number(v);
        value = kind && Number.isFinite(n) ? excelDate(n, kind, date1904) : excelNumber(v);
      }
    }
    while (row.length < index) row.push(null);
    row[index] = value;
  }
  return row;
}
