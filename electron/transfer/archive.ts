import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { path7za } from '7zip-bin';
import { AppError } from '../ipc/errors';

/**
 * Zip and 7z archives, also password-protected (AES or ZipCrypto), through the 7-Zip binary that
 * ships with the app. Nothing is unpacked to disk: a file is streamed out of the archive.
 */

export interface ArchiveEntry {
  path: string;
  /** Uncompressed size in bytes; null when the archive doesn't say. */
  size: number | null;
  encrypted: boolean;
}

export interface ArchiveListing {
  entries: ArchiveEntry[];
  /** Some entry needs a password to unpack. */
  encrypted: boolean;
}

/** File extensions treated as archives. */
export const ARCHIVE_EXTENSIONS = ['zip', '7z'];

export function isArchive(file: string): boolean {
  return ARCHIVE_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());
}

/** The bundled 7za: inside app.asar it can't run, so electron-builder unpacks it next to it. */
export function sevenZip(): string {
  const bin = path7za.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (process.platform !== 'win32') {
    try {
      accessSync(bin, constants.X_OK);
    } catch {
      try {
        chmodSync(bin, 0o755);
      } catch {
        // Not ours to change; spawn will report it.
      }
    }
  }
  return bin;
}

/**
 * Common switches: no progress output, UTF-8 names, `-spd` so names with * or ? are taken
 * literally. The password always goes as -p (an empty one too), so 7-Zip never waits for typing.
 */
function args(
  command: string,
  password: string | undefined,
  switches: string[],
  files: string[],
): string[] {
  return [
    command,
    '-bd',
    '-sccUTF-8',
    '-spd',
    `-p${password ?? ''}`,
    '-y',
    ...switches,
    '--',
    ...files,
  ];
}

/** Lists the files in an archive. Encrypted file names (7z -mhe) need the password first. */
export async function listArchive(file: string, password?: string): Promise<ArchiveListing> {
  const { code, stdout, stderr } = await run(args('l', password, ['-slt'], [file]));
  const output = `${stdout}\n${stderr}`;
  if (code !== 0) throw archiveError(output, password);

  // -slt prints one "Key = Value" block per item, after a line of dashes.
  const body = stdout
    .split(/^-{10,}$/m)
    .slice(1)
    .join('\n');
  const entries: ArchiveEntry[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const m = /^([^=]+?) = (.*)$/.exec(line);
      if (m) fields.set(m[1]!, m[2]!);
    }
    const name = fields.get('Path');
    if (!name || fields.get('Folder') === '+' || /D/.test(fields.get('Attributes') ?? '')) continue;
    const size = Number(fields.get('Size'));
    entries.push({
      path: name,
      size: Number.isFinite(size) && fields.get('Size') !== '' ? size : null,
      encrypted: fields.get('Encrypted') === '+',
    });
  }
  return { entries, encrypted: entries.some((e) => e.encrypted) };
}

export interface Extraction {
  stream: Readable;
  /** Resolves when 7-Zip finished without errors; rejects with a translated error. */
  done: Promise<void>;
  kill(): void;
}

/**
 * Streams one file out of an archive (`7za x -so`). A name that is not in the archive gives an empty
 * stream without an error, so callers check the name against `listArchive` first.
 */
export function extractEntry(file: string, entry: string, password?: string): Extraction {
  const child = spawn(sevenZip(), args('x', password, ['-so'], [file, entry]), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (stderr += d));
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (err) => reject(spawnError(err)));
    child.once('close', (code, signal) => {
      if (signal) reject(new AppError('CANCELLED', 'Gestopt.'));
      else if (code === 0) resolve();
      else reject(archiveError(stderr, password));
    });
  });
  // Errors surface through `done`; the stream itself just ends.
  done.catch(() => undefined);
  return { stream: child.stdout, done, kill: () => kill(child) };
}

function kill(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip(), argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.once('error', (err) => reject(spawnError(err)));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function spawnError(err: Error): AppError {
  return new AppError(
    'ARCHIVE_TOOL',
    '7-Zip kan niet worden gestart.',
    `De meegeleverde 7-Zip ontbreekt of mag niet worden uitgevoerd (${err.message}).`,
  );
}

/** 7-Zip's messages, translated. A wrong password and a missing one are told apart. */
export function archiveError(output: string, password: string | undefined): AppError {
  if (/Wrong password|Can not open encrypted archive|encrypted file/i.test(output)) {
    return password
      ? new AppError(
          'ARCHIVE_PASSWORD_WRONG',
          'Het wachtwoord van het archief klopt niet.',
          'Let op hoofdletters en spaties.',
        )
      : new AppError('ARCHIVE_PASSWORD_REQUIRED', 'Dit archief is versleuteld: wachtwoord nodig.');
  }
  if (/Can not open the file as|Unexpected end of archive|Is not archive/i.test(output)) {
    return new AppError(
      'ARCHIVE_INVALID',
      'Dit bestand is geen leesbaar zip- of 7z-archief.',
      'Het kan beschadigd zijn of een ander formaat hebben.',
    );
  }
  if (/No files to process|cannot find the file/i.test(output)) {
    return new AppError('ARCHIVE_ENTRY_MISSING', 'Dat bestand staat niet in het archief.');
  }
  if (/CRC Failed|Data Error/i.test(output)) {
    return new AppError(
      'ARCHIVE_CORRUPT',
      'Het archief is beschadigd.',
      password ? 'Of het wachtwoord klopt niet.' : undefined,
    );
  }
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^ERROR:/i.test(l));
  return new AppError('ARCHIVE_FAILED', 'Uitpakken mislukt.', line?.replace(/^ERROR:\s*/i, ''));
}
