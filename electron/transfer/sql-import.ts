import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type {
  DbType,
  SqlImportRequest,
  StatementResult,
  TransferProgress,
} from '../../shared/models';
import { ScriptSplitter } from '../../shared/sql';
import type { DbSession } from '../db/driver';
import { AppError } from '../ipc/errors';
import { extractEntry, isArchive, listArchive } from './archive';

/** Statements sent to the server per round trip, and roughly how much SQL text at most. */
const BATCH_STATEMENTS = 200;
const BATCH_CHARS = 2_000_000;
/** Errors remembered when "skip errors" is on; the count goes on. */
const MAX_ERRORS = 100;
/** How often progress is reported, at most. */
const PROGRESS_MS = 200;

interface Source {
  stream: Readable;
  /** Bytes the progress counts towards; null when unknown. */
  total: number | null;
  /** Bytes read so far, against `total`. */
  read(): number;
  done: Promise<void>;
  close(): void;
}

/**
 * Runs a SQL script on a connection: a .sql file, a .sql.gz, or a file inside a zip or 7z archive
 * (also password-protected). The script is read and split piece by piece, so a dump of gigabytes
 * never sits in memory, and runs on its own editor session (like a SQL tab).
 */
export async function importSql(
  session: DbSession,
  dialect: DbType,
  readOnly: boolean,
  request: SqlImportRequest,
  jobId: string,
  report: (progress: TransferProgress) => void,
  signal: AbortSignal,
): Promise<TransferProgress> {
  const progress: TransferProgress = {
    jobId,
    kind: 'import',
    phase: 'running',
    bytes: 0,
    totalBytes: null,
    statements: 0,
    failed: 0,
    errors: [],
  };
  if (readOnly) {
    throw new AppError(
      'READ_ONLY_CONNECTION',
      'Deze verbinding is alleen-lezen.',
      'Importeren wijzigt de database. Gebruik een verbinding zonder alleen-lezen.',
    );
  }

  const source = await openSource(request);
  progress.totalBytes = source.total;
  const tab = `import-${jobId}`;
  let lastReport = 0;
  const tick = (force = false) => {
    progress.bytes = source.read();
    const now = Date.now();
    if (force || now - lastReport >= PROGRESS_MS) {
      lastReport = now;
      report({ ...progress, errors: [...progress.errors] });
    }
  };
  const onAbort = () => {
    source.close();
    void session.cancelScript(tab).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const splitter = new ScriptSplitter(dialect);
  let batch: string[] = [];
  let batchChars = 0;
  let first = true;

  /** Runs statements; with "skip errors" it goes on after a failing one. */
  const flush = async () => {
    let pending = batch;
    batch = [];
    batchChars = 0;
    while (pending.length > 0) {
      if (signal.aborted) throw cancelled();
      const run = await session.runScript(tab, {
        statements: pending,
        // The chosen database only for the first batch: a USE in the dump must win after that.
        ...(first && request.database && { database: request.database }),
        maxRows: null,
      });
      first = false;
      const failedAt = run.results.findIndex((r) => r.kind === 'error');
      if (failedAt < 0) {
        progress.statements += run.results.length;
        return;
      }
      progress.statements += failedAt;
      progress.failed++;
      const failed = run.results[failedAt] as Extract<StatementResult, { kind: 'error' }>;
      if (progress.errors.length < MAX_ERRORS) {
        progress.errors.push({
          statement: progress.statements + progress.failed,
          sql: pending[failedAt]!.slice(0, 300),
          message: failed.error.message,
        });
      }
      if (signal.aborted) throw cancelled();
      if (request.onError === 'stop') throw new StopAtError();
      pending = pending.slice(failedAt + 1);
    }
  };

  try {
    const decoder = await textDecoderFor(source.stream);
    for await (const chunk of decoder) {
      if (signal.aborted) throw cancelled();
      for (const sql of splitter.push(chunk as string)) {
        batch.push(sql);
        batchChars += sql.length;
        if (batch.length >= BATCH_STATEMENTS || batchChars >= BATCH_CHARS) {
          await flush();
          tick();
        }
      }
    }
    await source.done;
    batch.push(...splitter.end());
    await flush();
    progress.phase = progress.failed > 0 ? 'done-with-errors' : 'done';
  } catch (err) {
    if (err instanceof StopAtError) progress.phase = 'stopped-at-error';
    else if (signal.aborted) progress.phase = 'cancelled';
    else {
      // A read error (wrong password, broken archive) says more than the stream's end.
      const readError = await source.done.then(
        () => null,
        (e: unknown) => e,
      );
      throw readError ?? err;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    source.close();
    // Closing the session rolls back a transaction the script left open (on stop or error).
    await session.closeEditor(tab).catch(() => undefined);
  }
  tick(true);
  return progress;
}

class StopAtError extends Error {}

function cancelled(): AppError {
  return new AppError('CANCELLED', 'Import gestopt.');
}

async function openSource(request: SqlImportRequest): Promise<Source> {
  const file = request.file;
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new AppError('FILE_NOT_FOUND', 'Bestand niet gevonden.', file);
  }

  if (isArchive(file)) {
    const listing = await listArchive(file, request.password);
    const entry = listing.entries.find((e) => e.path === request.entry);
    if (!request.entry || !entry) {
      throw new AppError(
        'ARCHIVE_ENTRY_MISSING',
        'Kies welk bestand uit het archief je wilt importeren.',
      );
    }
    if (entry.encrypted && !request.password) {
      throw new AppError(
        'ARCHIVE_PASSWORD_REQUIRED',
        'Dit archief is versleuteld: wachtwoord nodig.',
      );
    }
    const x = extractEntry(file, entry.path, request.password);
    let read = 0;
    x.stream.on('data', (d: Buffer) => (read += d.length));
    return {
      stream: x.stream,
      total: entry.size,
      read: () => read,
      done: x.done,
      close: x.kill,
    };
  }

  const raw = createReadStream(file, { highWaterMark: 256 * 1024 });
  let read = 0;
  raw.on('data', (d: Buffer | string) => (read += d.length));
  const ended = new Promise<void>((resolve, reject) => {
    raw.once('end', resolve);
    raw.once('close', resolve);
    raw.once('error', (err) =>
      reject(new AppError('FILE_READ', 'Bestand kan niet worden gelezen.', err.message)),
    );
  });
  if (/\.gz$/i.test(file)) {
    const gunzip = createGunzip();
    const done = new Promise<void>((resolve, reject) => {
      gunzip.once('end', resolve);
      gunzip.once('error', () =>
        reject(new AppError('GZIP_INVALID', 'Dit .gz-bestand is beschadigd of geen gzip.')),
      );
    });
    raw.pipe(gunzip);
    return {
      stream: gunzip,
      total: stat.size, // progress follows the compressed bytes read
      read: () => read,
      done: Promise.all([ended, done]).then(() => undefined),
      close: () => {
        raw.destroy();
        gunzip.destroy();
      },
    };
  }
  return {
    stream: raw,
    total: stat.size,
    read: () => read,
    done: ended,
    close: () => raw.destroy(),
  };
}

/**
 * Decodes the bytes: UTF-8 (with or without BOM) or UTF-16 with a BOM, as SSMS writes scripts.
 * The first 64 KiB must be text: binary data, or what a wrong 7z password unpacks to, is refused
 * before anything runs.
 */
async function textDecoderFor(stream: Readable): Promise<AsyncIterable<string>> {
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const head: Buffer[] = [];
  let headSize = 0;
  let finished = false;
  while (headSize < 64 * 1024) {
    const next = await iterator.next();
    if (next.done) {
      finished = true;
      break;
    }
    head.push(next.value);
    headSize += next.value.length;
  }
  const first = Buffer.concat(head);
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  if (first[0] === 0xff && first[1] === 0xfe) encoding = 'utf-16le';
  else if (first[0] === 0xfe && first[1] === 0xff) encoding = 'utf-16be';
  const decoder = new TextDecoder(encoding); // drops a BOM
  const check = new TextDecoder(encoding, { fatal: true });
  try {
    // A multi-byte character cut at the end of the sample is fine.
    const sample = check.decode(first.subarray(0, Math.max(0, first.length - 4)), { stream: true });
    if (sample.includes('\u0000')) throw new Error('nul');
  } catch {
    throw new AppError(
      'NOT_SQL_TEXT',
      'Dit bestand is geen SQL-tekst.',
      'Is het een binair bestand, of klopt het wachtwoord van het archief niet?',
    );
  }
  return (async function* () {
    yield decoder.decode(first, { stream: true });
    if (!finished) {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        yield decoder.decode(next.value, { stream: true });
      }
    }
    yield decoder.decode();
  })();
}

/** What the import dialog shows after choosing a file: a plain script, or an archive's contents. */
export async function inspectImportFile(
  file: string,
  password?: string,
): Promise<import('../../shared/models').ImportFileInfo> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new AppError('FILE_NOT_FOUND', 'Bestand niet gevonden.', file);
  }
  const name = path.basename(file);
  if (!isArchive(file)) {
    return {
      file,
      name,
      size: stat.size,
      kind: /\.gz$/i.test(file) ? 'gzip' : 'script',
      entries: [],
    };
  }
  const listing = await listArchive(file, password);
  return {
    file,
    name,
    size: stat.size,
    kind: 'archive',
    encrypted: listing.encrypted,
    entries: listing.entries.map((e) => ({ ...e, script: /\.(sql|txt)$/i.test(e.path) })),
  };
}
