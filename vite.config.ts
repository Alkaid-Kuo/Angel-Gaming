import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** 地圖編輯器的存檔：只在開發伺服器上存在，檔案放 maps/shooter/ */
function shooterMapFiles(): Plugin {
  const dir = resolve('maps/shooter');
  return {
    name: 'shooter-map-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shooter-maps', (req, res) => {
        const send = (code: number, body: string): void => {
          res.statusCode = code;
          res.end(body);
        };
        // 擋掉其他網站對本機開發伺服器的寫入
        const origin = req.headers.origin;
        if (origin !== undefined && new URL(origin).host !== req.headers.host) return send(403, 'origin');
        mkdirSync(dir, { recursive: true });
        const name = (req.url ?? '/').replace(/^\/|\?.*$/g, '');
        if (name === '') return send(200, JSON.stringify(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()));
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return send(400, 'name');
        const file = resolve(dir, `${name}.json`);
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c: Buffer) => (body += c.toString('utf8')));
          req.on('end', () => {
            try {
              JSON.parse(body);
            } catch {
              return send(400, 'json');
            }
            writeFileSync(file, body);
            send(200, 'ok');
          });
          return undefined;
        }
        try {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return send(200, readFileSync(file, 'utf8'));
        } catch {
          return send(404, 'not found');
        }
      });
    },
  };
}

// 瀏覽器版：人類對戰、回放播放器、觀戰。開發時開 http://localhost:5173/web/
export default defineConfig({
  root: '.',
  base: './',
  plugins: [shooterMapFiles()],
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: { main: 'web/index.html', legion: 'web/legion.html', manage: 'web/manage.html', club: 'web/club.html', game: 'web/game.html', shooter: 'web/shooter.html', shooterMapEditor: 'web/shooter-map-editor.html', sketchShooterA: 'web/sketch/shooter/a-diorama.html', sketchShooterB: 'web/sketch/shooter/b-comic.html', sketchShooterC: 'web/sketch/shooter/c-minimal.html', sketchShooter: 'web/sketch/shooter/index.html' } },
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
