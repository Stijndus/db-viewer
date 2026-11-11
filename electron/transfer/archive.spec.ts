import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractEntry, isArchive, listArchive, sevenZip } from './archive';

const SQL = 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1), (2);\n-- naïef: één\n';
let dir: string;
const file = (name: string) => path.join(dir, name);

/** Builds test archives with the same 7-Zip the app uses. */
function pack(archive: string, extra: string[]): void {
  execFileSync(
    sevenZip(),
    ['a', '-bd', '-y', ...extra, file(archive), 'dump.sql', 'map/ander.sql'],
    {
      cwd: dir,
      stdio: 'ignore',
    },
  );
}

describe('archives', () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-archive-'));
    await fs.writeFile(file('dump.sql'), SQL);
    await fs.mkdir(file('map'));
    await fs.writeFile(file('map/ander.sql'), 'SELECT 1;');
    pack('plain.zip', ['-tzip']);
    pack('aes.zip', ['-tzip', '-pgeheim', '-mem=AES256']);
    pack('crypto.zip', ['-tzip', '-pgeheim', '-mem=ZipCrypto']);
    pack('plain.7z', []);
    pack('aes.7z', ['-pgeheim']);
    pack('hidden.7z', ['-pgeheim', '-mhe=on']);
    await fs.writeFile(file('kapot.zip'), 'dit is geen zip');
  });

  it('recognises archives by extension', () => {
    expect(isArchive('a/dump.ZIP')).toBe(true);
    expect(isArchive('dump.7z')).toBe(true);
    expect(isArchive('dump.sql.gz')).toBe(false);
  });

  it('lists files with size and whether they are encrypted', async () => {
    const plain = await listArchive(file('plain.zip'));
    expect(plain.encrypted).toBe(false);
    expect(plain.entries.map((e) => e.path).sort()).toEqual([
      'dump.sql',
      path.join('map', 'ander.sql'),
    ]);
    expect(plain.entries.find((e) => e.path === 'dump.sql')?.size).toBe(Buffer.byteLength(SQL));
    // Zip names are readable without the password; the contents are not.
    const aes = await listArchive(file('aes.zip'));
    expect(aes.encrypted).toBe(true);
  });

  it('asks for the password of a 7z with hidden names, and refuses a wrong one', async () => {
    await expect(listArchive(file('hidden.7z'))).rejects.toMatchObject({
      code: 'ARCHIVE_PASSWORD_REQUIRED',
    });
    await expect(listArchive(file('hidden.7z'), 'fout')).rejects.toMatchObject({
      code: 'ARCHIVE_PASSWORD_WRONG',
    });
    const listing = await listArchive(file('hidden.7z'), 'geheim');
    expect(listing.encrypted).toBe(true);
    expect(listing.entries).toHaveLength(2);
  });

  it.each(['plain.zip', 'aes.zip', 'crypto.zip', 'plain.7z', 'aes.7z', 'hidden.7z'])(
    'streams one file out of %s',
    async (name) => {
      const x = extractEntry(
        file(name),
        'dump.sql',
        name.startsWith('plain') ? undefined : 'geheim',
      );
      const [content] = await Promise.all([text(x.stream), x.done]);
      expect(content).toBe(SQL);
    },
  );

  it('says when the password is missing or wrong while unpacking', async () => {
    const missing = extractEntry(file('aes.zip'), 'dump.sql');
    await text(missing.stream);
    await expect(missing.done).rejects.toMatchObject({ code: 'ARCHIVE_PASSWORD_REQUIRED' });
    for (const name of ['aes.zip', 'aes.7z']) {
      const wrong = extractEntry(file(name), 'dump.sql', 'fout');
      await text(wrong.stream);
      await expect(wrong.done).rejects.toMatchObject({ code: 'ARCHIVE_PASSWORD_WRONG' });
    }
  });

  it('explains a file that is no archive', async () => {
    await expect(listArchive(file('kapot.zip'))).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });
  });
});
