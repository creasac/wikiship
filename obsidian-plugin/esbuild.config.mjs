import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const options = {
  entryPoints: ['src/main.ts'], bundle: true, format: 'cjs', target: 'es2022',
  loader: { '.svg': 'text' },
  outfile: 'main.js', sourcemap: 'external', platform: 'node',
  external: ['obsidian', '@codemirror/state', '@codemirror/view', '@codemirror/language'],
  plugins: [{
    name: 'static-mcp-schema-validation',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/validation\/ajv-provider\.js$/ }, args => {
        if (!args.importer.includes('/@modelcontextprotocol/sdk/dist/')) return;
        return { path: resolve(root, 'src/mcp/static-validator-provider.ts') };
      });
    },
  }],
  logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
