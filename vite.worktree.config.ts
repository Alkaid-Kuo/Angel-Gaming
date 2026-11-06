// 工作樹用的 vite 設定：主設定把 .claude/worktrees 排除在監看之外（別的工作階段改檔不要觸發重載），
// 在工作樹裡跑 vite 會連自己的檔案都不監看、改了畫面不更新（連快取的舊轉譯都會一直給）。
// 這份設定沿用主設定、只把那條排除換掉（不能用 mergeConfig：陣列會合併而不是取代）。
// 用法：npx vite --config vite.worktree.config.ts --port 5216（.claude/launch.json 的 ui-audit）
import { defineConfig } from 'vite';
import base from './vite.config.ts';

export default defineConfig({ ...base, server: { ...base.server, watch: { ignored: ['**/out/**'] } } });
