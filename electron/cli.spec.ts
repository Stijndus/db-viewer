import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCli, userArgs, type CliContext } from './cli';

const cwd = path.resolve('/home/stijn/werk');
const ctx = (env: Record<string, string> = {}, files: string[] = []): CliContext => ({
  cwd,
  env,
  isFile: (p) => files.includes(p),
});
const parse = (args: string[], c: CliContext = ctx()) => parseCli(args, c);

describe('parseCli', () => {
  it('does nothing without arguments, and skips Chromium switches', () => {
    expect(parse([])).toEqual({ kind: 'none' });
    expect(parse(['--no-sandbox', '--user-data-dir=/tmp/x', '--inspect=0'])).toEqual({
      kind: 'none',
    });
  });

  it('opens a saved connection by name, with a password from the environment', () => {
    expect(parse(['Productie'], ctx({ DBV_PASSWORD: 'geheim' }))).toEqual({
      kind: 'saved',
      name: 'Productie',
      secrets: { password: 'geheim' },
    });
    expect(parse(['-c', 'Lokaal dev', '--ssh-password', 'x'])).toEqual({
      kind: 'saved',
      name: 'Lokaal dev',
      secrets: { sshSecret: 'x' },
    });
  });

  it('builds a connection from options, with defaults per type', () => {
    const cmd = parse([
      '--db-type',
      'postgres',
      '--host',
      'db.example.com',
      '-d',
      'app',
      '-p',
      'pw',
    ]);
    expect(cmd).toMatchObject({
      kind: 'connect',
      save: false,
      input: {
        type: 'postgres',
        host: 'db.example.com',
        port: 5432,
        user: 'postgres',
        database: 'app',
        password: 'pw',
        name: 'postgres@db.example.com/app',
        ssh: null,
      },
    });
    expect(parse(['--db-type=mssql'])).toMatchObject({
      input: { host: 'localhost', port: 1433, user: 'sa' },
    });
  });

  it('reads a URL, and lets options override it', () => {
    const cmd = parse([
      'mysql://stijn:p%40ss@db.example.com:3307/shop?ssl=true&read-only=1&name=Shop',
      '--port',
      '3308',
    ]);
    expect(cmd).toMatchObject({
      kind: 'connect',
      input: {
        type: 'mysql',
        host: 'db.example.com',
        port: 3308,
        user: 'stijn',
        password: 'p@ss',
        database: 'shop',
        ssl: true,
        readOnly: true,
        name: 'Shop',
      },
    });
    expect(parse(['mariadb://root@localhost'])).toMatchObject({ input: { type: 'mysql' } });
    expect(parse(['postgresql://u@h/db?sslmode=disable'])).toMatchObject({ input: { ssl: false } });
  });

  it('describes an SSH tunnel with options or in the URL', () => {
    const viaOptions = parse(
      [
        '-t',
        'mysql',
        '--ssh-host',
        'server',
        '--ssh-user',
        'stijn',
        '--ssh-key',
        '../.ssh/id_ed25519',
      ],
      ctx({ DBV_SSH_PASSWORD: 'zin' }),
    );
    expect(viaOptions).toMatchObject({
      input: {
        host: 'localhost',
        name: 'root@server',
        ssh: {
          host: 'server',
          port: 22,
          user: 'stijn',
          auth: 'key',
          keyFile: path.resolve(cwd, '../.ssh/id_ed25519'),
          hostKey: '',
        },
        sshSecret: 'zin',
      },
    });
    const viaUrl = parse([
      'postgres://app@localhost/app?ssh=stijn@server.example.com:2222&ssh-agent=1',
    ]);
    expect(viaUrl).toMatchObject({
      input: { ssh: { host: 'server.example.com', port: 2222, user: 'stijn', auth: 'agent' } },
    });
  });

  it('opens SQLite files: a bare path, a URL, or --db-type sqlite', () => {
    expect(parse(['data/app.db'])).toMatchObject({
      kind: 'connect',
      input: { type: 'sqlite', database: path.resolve(cwd, 'data/app.db'), name: 'app' },
    });
    expect(parse(['sqlite:///var/lib/x.sqlite3'])).toMatchObject({
      input: { type: 'sqlite', database: path.resolve('/var/lib/x.sqlite3') },
    });
    const noExt = path.resolve(cwd, 'data/archief');
    expect(parse(['./data/archief'], ctx({}, [noExt]))).toMatchObject({
      input: { type: 'sqlite', database: noExt },
    });
    expect(parse(['--db-type', 'sqlite', '--file', 'x.db', '--save', '--read-only'])).toMatchObject(
      {
        save: true,
        input: { readOnly: true },
      },
    );
  });

  it('explains mistakes', () => {
    expect(parse(['--hots', 'x'])).toMatchObject({
      kind: 'error',
      message: 'Onbekende optie: --hots',
    });
    expect(parse(['--host'])).toMatchObject({
      kind: 'error',
      message: 'Optie --host mist een waarde.',
    });
    expect(parse(['--host', 'x'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--db-type'),
    });
    expect(parse(['--type', 'mysql'])).toMatchObject({
      kind: 'error',
      message: 'Gebruik --db-type in plaats van --type.',
    });
    expect(parse(['-t', 'oracle'])).toMatchObject({ message: 'Onbekend databasetype: oracle.' });
    expect(parse(['-t', 'mysql', '-P', '99999'])).toMatchObject({
      message: 'Ongeldige poort: 99999.',
    });
    expect(parse(['-t', 'mysql', '--ssh-user', 'x'])).toMatchObject({
      message: expect.stringContaining('--ssh-host'),
    });
    expect(
      parse(['-t', 'mysql', '--ssh-host', 's', '--ssh-user', 'u', '--ssh-agent', '--ssh-key', 'k']),
    ).toMatchObject({
      message: expect.stringContaining('één manier'),
    });
    expect(parse(['Mijn', 'verbinding'])).toMatchObject({
      message: expect.stringContaining('Te veel'),
    });
    expect(parse(['oracle://x'])).toMatchObject({ message: 'Onbekend URL-type: oracle://' });
    expect(parse(['app.db', '--ssh-host', 's'])).toMatchObject({
      message: expect.stringContaining('SQLite'),
    });
  });

  it('knows --help and --version', () => {
    expect(parse(['--help'])).toEqual({ kind: 'help' });
    expect(parse(['/?'])).toEqual({ kind: 'help' });
    expect(parse(['--version'])).toEqual({ kind: 'version' });
  });
});

describe('userArgs', () => {
  it('drops the executable, and in development the app path wherever it sits', () => {
    expect(userArgs(['C:\\DB Viewer.exe', 'Productie'], true, '')).toEqual(['Productie']);
    expect(userArgs(['electron', '.', '-c', 'x'], false, process.cwd())).toEqual(['-c', 'x']);
    expect(userArgs(['electron', '--no-sandbox', '/app', 'mysql://u@h'], false, '/app')).toEqual([
      '--no-sandbox',
      'mysql://u@h',
    ]);
  });

  it('leaves out the flags the installer adds after an update', () => {
    expect(userArgs(['C:\\DB Viewer.exe', '--updated'], true, '')).toEqual([]);
    expect(
      userArgs(['C:\\DB Viewer.exe', '--updated', '--force-run', 'Productie'], true, ''),
    ).toEqual(['Productie']);
  });
});
