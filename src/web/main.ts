// 瀏覽器版入口：對局設定、建立引擎 Worker、切換畫面。
import { TUTORIAL, type MatchMode } from '../config/index.ts';
import type { ReplayFile } from '../replay/index.ts';
import { GameScreen } from './game-ui.ts';
import { helpSections } from './help.ts';
import type { FromWorker, LiveSetup, OpponentKind, ToWorker } from './protocol.ts';

const setupEl = document.getElementById('setup')!;
const gameEl = document.getElementById('game')!;
const seedInput = document.getElementById('seed') as HTMLInputElement;
const limitInput = document.getElementById('limit') as HTMLInputElement;

let worker: Worker | null = null;
let screen: GameScreen | null = null;

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

seedInput.value = String(randomSeed());
document.getElementById('reroll')!.addEventListener('click', () => {
  seedInput.value = String(randomSeed());
});

function exitToMenu(): void {
  screen?.dispose();
  screen = null;
  worker?.terminate();
  worker = null;
  setupEl.classList.remove('hidden');
}

function launch(first: ToWorker): void {
  worker?.terminate();
  const w = new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' });
  worker = w;
  w.onmessage = (ev: MessageEvent<FromWorker>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      screen?.dispose();
      setupEl.classList.add('hidden');
      screen = new GameScreen(gameEl, w, msg.meta, exitToMenu);
    } else if (msg.type === 'error') {
      console.error(msg.message);
      alert(`引擎錯誤：\n${msg.message}`);
    } else {
      screen?.handle(msg);
    }
  };
  w.onerror = (e) => {
    alert(`Worker 錯誤：${e.message}`);
  };
  w.postMessage(first);
}

const PRESETS: Record<string, { mode: MatchMode; seats: (OpponentKind | 'human')[] }> = {
  h1v1: { mode: '1v1', seats: ['human', 'baseline'] },
  h4: { mode: 'ffa4', seats: ['human', 'baseline', 'baseline', 'baseline'] },
  s1v1: { mode: '1v1', seats: ['baseline', 'baseline'] },
  s1v1r: { mode: '1v1', seats: ['baseline', 'random'] },
  s4: { mode: 'ffa4', seats: ['baseline', 'baseline', 'baseline', 'baseline'] },
  h8: { mode: 'ffa8', seats: ['human', 'baseline', 'baseline', 'baseline', 'baseline', 'baseline', 'baseline', 'baseline'] },
  s8: { mode: 'ffa8', seats: ['baseline', 'baseline', 'baseline', 'baseline', 'baseline', 'baseline', 'baseline', 'baseline'] },
};

document.getElementById('start')!.addEventListener('click', () => {
  const choice = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value;
  const preset = PRESETS[choice];
  const seed = Number(seedInput.value);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    alert('Seed 必須是非負整數');
    return;
  }
  const humanIdx = preset.seats.indexOf('human');
  const setup: LiveSetup = { mode: preset.mode, seed, human: humanIdx >= 0 ? humanIdx : null, seats: preset.seats, limitBudget: limitInput.checked, tutorial: false };
  launch({ type: 'startLive', setup });
});

document.getElementById('tutorial')!.addEventListener('click', () => {
  launch({
    type: 'startLive',
    setup: { mode: '1v1', seed: TUTORIAL.seed, human: 0, seats: ['human', 'dummy'], limitBudget: false, tutorial: true, timeLimitTicks: TUTORIAL.timeLimitTicks },
  });
});

// 首頁的遊戲說明（分頁）
{
  const card = document.getElementById('helpCard')!;
  const tabs = card.querySelector<HTMLElement>('.help-tabs')!;
  const content = card.querySelector<HTMLElement>('.help-content')!;
  const sections = helpSections();
  const buttons = sections.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.title;
    b.addEventListener('click', () => show(s.id));
    tabs.append(b);
    return b;
  });
  const show = (id: string): void => {
    const i = Math.max(0, sections.findIndex((s) => s.id === id));
    content.innerHTML = sections[i].html;
    buttons.forEach((b, j) => b.classList.toggle('active', j === i));
  };
  show('rules');
}

document.getElementById('replayFile')!.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  void file.text().then((text) => {
    let data: ReplayFile;
    try {
      data = JSON.parse(text) as ReplayFile;
    } catch {
      alert('不是合法的回放檔（JSON 解析失敗）');
      return;
    }
    launch({ type: 'startReplay', file: data });
    input.value = '';
  });
});
