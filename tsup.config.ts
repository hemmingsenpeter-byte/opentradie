import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'api/server': 'apps/api/src/server.ts', 'worker/index': 'apps/worker/src/index.ts' },
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // Workspace packages are bundled; third-party packages stay in node_modules.
  noExternal: [/^@opentradie\//],
  external: ['pg-native'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // The database package resolves ../migrations relative to the bundle (dist/<app>/), i.e. dist/migrations.
  onSuccess: async () => {
    await cp('packages/database/migrations', 'dist/migrations', { recursive: true });
  },
});
