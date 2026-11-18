import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

const configs = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  // Standalone CLI (no vscode dependency): format / check from the shell or CI.
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' },
];

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
