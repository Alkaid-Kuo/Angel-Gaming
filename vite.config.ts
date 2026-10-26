import { defineConfig } from 'vite';

// 瀏覽器版：人類對戰、回放播放器、觀戰。開發時開 http://localhost:5173/web/
export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: { main: 'web/index.html', legion: 'web/legion.html', manage: 'web/manage.html' } },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
