import { defineConfig } from 'tsup';
export default defineConfig({ entry:['apps/api/src/server.ts'],format:['esm'],target:'node24',outDir:'dist/api',clean:true,splitting:false,sourcemap:true,noExternal:[/^@opentradie\//],external:['pg-native'],banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"} });
