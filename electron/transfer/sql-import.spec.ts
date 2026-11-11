import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunRequest, RunResult, TransferProgress } from '../../shared/models';
import type { DbSession } from '../db/driver';
import { sevenZip } from './archive';
import { importSql, inspectImportFile } from './sql-import';

/** A session that "runs" statements: anything containing FOUT fails. */
function fakeSession() {
  const runs: RunRequest[] = [];
  const closed: string[] = [];
  const session = {
    async runScript(_tab: string, request: RunRequest): Promise<RunResult> {
      runs.push(request);
      const results: RunResult['results'] = [];
      for (const [index, sql] of request.statements.entries()) {
        if (sql.includes('FOUT')) {
          results.push({
            kind: 'error',
            index,
            sql,
            durationMs: 0,
            error: { code: 'X', message: `fout in ${sql}` },
          });
          break;
        }
        results.push({
          kind: 'ok',
          index,
          sql,
          durationMs: 0,
          affectedRows: 1,
          insertId: null,
          warnings: 0,
          info: '',
        });
      }
      return { results, database: null };
    },
    async cancelScript() {},
    async closeEditor(tab: string) {
      closed.push(tab);
    },
  } as unknown as DbSession;
  const statements = () => runs.flatMap((r) => r.statements);
  return { session, runs, closed, statements };
}

let dir: string;
const write = async (name: string, content: string | Buffer) => {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
};

async function run(
  session: DbSession,
  request: Parameters<typeof importSql>[3],
  options: { readOnly?: boolean; signal?: AbortSignal; dialect?: 'mysql' | 'mssql' } = {},
) {
  const reports: TransferProgress[] = [];
  const result = await importSql(
    session,
    options.dialect ?? 'mysql',
    options.readOnly ?? false,
    request,
    'job1',
    (p) => reports.push(p),
    options.signal ?? new AbortController().signal,
  );
  return { result, reports };
}

const DUMP = [
  'CREATE TABLE t (id int);',
  ...Array.from({ length: 450 }, (_, i) => `INSERT INTO t VALUES (${i});`),
  'DELIMITER ;;',
  'CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.id = NEW.id; END ;;',
  'DELIMITER ;',
  'INSERT INTO t VALUES (999) -- laatste, zonder puntkomma',
].join('\n');

describe('importSql', () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-import-'));
  });

  it('runs a dump in batches, the database only first, and closes its session', async () => {
    const fake = fakeSession();
    const file = await write('dump.sql', '﻿' + DUMP);
    const { result } = await run(fake.session, { file, database: 'app', onError: 'stop' });
    expect(result).toMatchObject({ phase: 'done', statements: 453, failed: 0 });
    expect(fake.statements()).toHaveLength(453);
    expect(fake.statements()[0]).toBe('CREATE TABLE t (id int)');
    expect(fake.statements().at(-2)).toContain('CREATE TRIGGER x');
    expect(fake.statements().at(-1)).toBe(
      'INSERT INTO t VALUES (999) -- laatste, zonder puntkomma',
    );
    expect(fake.runs.length).toBeGreaterThan(2);
    expect(fake.runs[0]!.database).toBe('app');
    expect(fake.runs.slice(1).every((r) => r.database === undefined)).toBe(true);
    expect(fake.closed).toEqual(['import-job1']);
  });

  it('stops at the first error, or skips failing statements and lists them', async () => {
    const file = await write(
      'fout.sql',
      'SELECT 1;\nSELECT FOUT;\nSELECT 3;\nSELECT FOUT2;\nSELECT 5;',
    );
    const stop = await run(fakeSession().session, { file, onError: 'stop' });
    expect(stop.result).toMatchObject({ phase: 'stopped-at-error', statements: 1, failed: 1 });
    expect(stop.result.errors[0]).toMatchObject({
      statement: 2,
      sql: 'SELECT FOUT',
      message: 'fout in SELECT FOUT',
    });

    const fake = fakeSession();
    const skip = await run(fake.session, { file, onError: 'skip' });
    expect(skip.result).toMatchObject({ phase: 'done-with-errors', statements: 3, failed: 2 });
    expect(skip.result.errors.map((e) => e.statement)).toEqual([2, 4]);
  });

  it('reads .sql.gz and UTF-16 scripts (as SSMS writes them)', async () => {
    const gz = await write('dump.sql.gz', gzipSync(DUMP));
    expect(
      (await run(fakeSession().session, { file: gz, onError: 'stop' })).result.statements,
    ).toBe(453);

    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("SELECT 1\nGO\nSELECT N'é'\nGO\n", 'utf16le'),
    ]);
    const file = await write('ssms.sql', utf16);
    const fake = fakeSession();
    await run(fake.session, { file, onError: 'stop' }, { dialect: 'mssql' });
    expect(fake.statements()).toEqual(['SELECT 1', "SELECT N'é'"]);
  });

  it('imports a script from an encrypted zip and 7z', async () => {
    await write('dump.sql', DUMP);
    for (const [name, extra] of [
      ['d.zip', ['-tzip', '-mem=AES256']],
      ['d.7z', ['-mhe=on']],
    ] as const) {
      execFileSync(sevenZip(), ['a', '-bd', '-y', '-pgeheim', ...extra, name, 'dump.sql'], {
        cwd: dir,
        stdio: 'ignore',
      });
      const file = path.join(dir, name);
      const info = await inspectImportFile(file, 'geheim');
      expect(info).toMatchObject({
        kind: 'archive',
        encrypted: true,
        entries: [{ path: 'dump.sql', script: true }],
      });
      const fake = fakeSession();
      const { result, reports } = await run(fake.session, {
        file,
        entry: 'dump.sql',
        password: 'geheim',
        onError: 'stop',
      });
      expect(result).toMatchObject({
        phase: 'done',
        statements: 453,
        totalBytes: Buffer.byteLength(DUMP),
      });
      expect(reports.at(-1)?.bytes).toBe(Buffer.byteLength(DUMP));
      await expect(
        run(fakeSession().session, { file, entry: 'dump.sql', password: 'fout', onError: 'stop' }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/ARCHIVE_PASSWORD_WRONG|NOT_SQL_TEXT/),
      });
    }
  });

  it('refuses binary files before running anything, and read-only connections', async () => {
    const fake = fakeSession();
    const file = await write(
      'plaatje.sql',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff, 0xfe, 0xfd]),
    );
    await expect(run(fake.session, { file, onError: 'stop' })).rejects.toMatchObject({
      code: 'NOT_SQL_TEXT',
    });
    expect(fake.runs).toHaveLength(0);
    const sql = await write('ok.sql', 'SELECT 1;');
    await expect(
      run(fake.session, { file: sql, onError: 'stop' }, { readOnly: true }),
    ).rejects.toMatchObject({
      code: 'READ_ONLY_CONNECTION',
    });
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const fake = fakeSession();
    const original = fake.session.runScript.bind(fake.session);
    fake.session.runScript = async (tab, req) => {
      controller.abort();
      return original(tab, req);
    };
    const file = await write('dump.sql', DUMP);
    const { result } = await run(
      fake.session,
      { file, onError: 'stop' },
      { signal: controller.signal },
    );
    expect(result.phase).toBe('cancelled');
    expect(fake.runs).toHaveLength(1);
    expect(fake.closed).toEqual(['import-job1']);
  });
});
