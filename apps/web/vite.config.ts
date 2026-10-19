import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.OPENTRADIE_API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // "localhost" matches the default APP_ORIGIN (http://localhost:5173) the API checks on mutations.
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/health': api },
  },
  preview: {
    host: 'localhost',
    port: 4173,
    strictPort: true,
    proxy: { '/api': api, '/health': api },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
