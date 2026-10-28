import { defineConfig } from 'vite';

// 瀏覽器版：人類對戰、回放播放器、觀戰。開發時開 http://localhost:5173/web/
export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: { main: 'web/index.html', legion: 'web/legion.html', manage: 'web/manage.html', club: 'web/club.html', game: 'web/game.html', shooter: 'web/shooter.html' } },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
    // 其他工作階段的 worktree 在 .claude/worktrees 底下，改檔不要觸發這裡的整頁重載
    watch: { ignored: ['**/.claude/worktrees/**', '**/out/**'] },
  },
});
