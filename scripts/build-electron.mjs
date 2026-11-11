// Bundles the Electron main process and preload script into dist-electron/.
// The preload runs sandboxed and cannot require local files, so it must be one bundle.
import { build } from 'esbuild';

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
  // mysql2 stays external: it's a runtime dependency packaged in node_modules.
  { ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js', external: ['electron', 'mysql2', 'electron-updater'] },
  { ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js' },
];

if (watch) {
  const { context } = await import('esbuild');
  for (const config of configs) await (await context(config)).watch();
} else {
  await Promise.all(configs.map((config) => build(config)));
}
