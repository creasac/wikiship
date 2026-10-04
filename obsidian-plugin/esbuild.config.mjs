import * as esbuild from 'esbuild';
const options = {
  entryPoints: ['src/main.ts'], bundle: true, format: 'cjs', target: 'es2022',
  loader: { '.svg': 'text' },
  outfile: 'main.js', sourcemap: 'external', platform: 'node',
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', '@codemirror/language'],
  logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
