// 軍團戰觀戰頁入口：選雙方 AI 與模式、建立引擎 Worker、切換畫面。
import type { LegionMode } from '../../legion/config.ts';
import type { BotKey, FromLegionWorker, ToLegionWorker } from './protocol.ts';
import { LegionScreen } from './ui.ts';

const setupEl = document.getElementById('setup')!;
const gameEl = document.getElementById('game')!;
const seedInput = document.getElementById('seed') as HTMLInputElement;
const BOT_KEYS: BotKey[] = ['push', 'ambush', 'ranged'];

let worker: Worker | null = null;
let screen: LegionScreen | null = null;

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);
seedInput.value = String(randomSeed());
document.getElementById('reroll')!.addEventListener('click', () => {
  seedInput.value = String(randomSeed());
});

function exitToMenu(): void {
  screen?.dispose();
  screen = null;
  worker?.terminate();
  worker = null;
  gameEl.classList.add('hidden');
  setupEl.classList.remove('hidden');
}

function pick(name: string): BotKey {
  const v = (document.querySelector(`select[name=${name}]`) as HTMLSelectElement).value;
  return v === 'random' ? BOT_KEYS[Math.floor(Math.random() * BOT_KEYS.length)] : (v as BotKey);
}

function launch(): void {
  const seed = Number(seedInput.value);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    alert('Seed 必須是非負整數');
    return;
  }
  const mode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as LegionMode;
  worker?.terminate();
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker = w;
  w.onmessage = (ev: MessageEvent<FromLegionWorker>) => {
    const msg = ev.data;
    if (msg.type === 'meta') {
      if (screen !== null) return;
      setupEl.classList.add('hidden');
      screen = new LegionScreen(gameEl, w, msg.meta, exitToMenu);
    } else if (msg.type === 'error') {
      console.error(msg.message);
      alert(`引擎錯誤：\n${msg.message}`);
    } else screen?.handle(msg);
  };
  w.onerror = (e) => alert(`Worker 錯誤：${e.message}`);
  const start: ToLegionWorker = { type: 'start', setup: { bots: [pick('blue'), pick('red')], mode, seed } };
  w.postMessage(start);
}

document.getElementById('start')!.addEventListener('click', launch);
