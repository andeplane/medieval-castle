import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022', chunkSizeWarningLimit: 6000,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), props: resolve(__dirname, 'props.html') } },
  },
  server: { host: true },
});
