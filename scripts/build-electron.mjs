// Bundles the Electron main process and preload script into dist-electron/.
// The preload runs sandboxed and cannot require local files, so it must be one bundle.
import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

const configs = [
  // Database drivers stay external: runtime dependencies packaged in node_modules.
  {
    ...common,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist-electron/main.js',
    external: ['electron', 'mysql2', 'pg', 'pg-cursor', 'mssql', 'ssh2', 'electron-updater'],
  },
  { ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js' },
  // SQLite runs in its own utility process (see electron/db/sqlite.connection.ts).
  {
    ...common,
    entryPoints: ['electron/db/sqlite.worker.ts'],
    outfile: 'dist-electron/sqlite-worker.js',
  },
];

/** The release notes travel with the app, so "Wat is er nieuw" works offline. Newest first. */
async function writeReleaseNotes() {
  const dir = '.github/release-notes';
  const files = (await readdir(dir)).filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f));
  const notes = await Promise.all(
    files.map(async (f) => ({
      version: f.slice(1, -3),
      markdown: await readFile(`${dir}/${f}`, 'utf8'),
    })),
  );
  const key = (v) => v.split('.').map(Number);
  notes.sort((a, b) => {
    const [x, y] = [key(a.version), key(b.version)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  await mkdir('dist-electron', { recursive: true });
  await writeFile('dist-electron/release-notes.json', JSON.stringify(notes));
}
await writeReleaseNotes();

if (watch) {
  const { context } = await import('esbuild');
  for (const config of configs) await (await context(config)).watch();
} else {
  await Promise.all(configs.map((config) => build(config)));
}
