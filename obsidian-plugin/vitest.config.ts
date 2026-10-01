import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The public obsidian npm package contains declarations, not its desktop runtime.
export default defineConfig({ resolve: { alias: {
  obsidian: fileURLToPath(new URL('./test/obsidian-stub.ts', import.meta.url)),
} } });
