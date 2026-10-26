// 軍團戰觀戰頁入口：選雙方 AI 與模式、建立引擎 Worker、切換畫面。
import { RULES, UNITS, type LegionMode, type UnitKind } from '../../legion/config.ts';
import { unitSvg } from './icons.ts';
import type { BotKey, FromLegionWorker, PlayerArmy, SandboxRole, ToLegionWorker } from './protocol.ts';
import { LegionScreen } from './ui.ts';

const setupEl = document.getElementById('setup')!;
const gameEl = document.getElementById('game')!;
const seedInput = document.getElementById('seed') as HTMLInputElement;
const BOT_KEYS: BotKey[] = ['push', 'ambush', 'ranged', 'commander', 'marshal', 'general2', 'marshal2', 'baseline168'];

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

// ───── 玩家的軍隊（藍方選「玩家」時） ─────
const KINDS: UnitKind[] = ['spear', 'sword', 'shield', 'archer', 'light', 'lightCav', 'heavyCav'];
// 預設陣容：場上 497 點；後備是場上的兩倍（佔點共 1491 點）
const DEFAULT_FIELD: Record<UnitKind, number> = { spear: 3, sword: 2, shield: 2, archer: 2, light: 1, lightCav: 0, heavyCav: 1 };
const DEFAULT_RESERVE: Record<UnitKind, number> = { spear: 6, sword: 4, shield: 4, archer: 4, light: 2, lightCav: 0, heavyCav: 2 };
const army = { field: { ...DEFAULT_FIELD }, reserve: { ...DEFAULT_RESERVE } };
const armyEl = document.getElementById('army')!;
const rowsEl = document.getElementById('army-rows')!;
const totalEl = document.getElementById('army-total')!;
const blueSel = document.querySelector('select[name=blue]') as HTMLSelectElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;

/** 設定頁選的模式：殲滅戰、佔點，或自訂對戰（沙盒，引擎用殲滅戰） */
const modeRaw = (): LegionMode | 'sandbox' => (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as LegionMode | 'sandbox';
const mode = (): LegionMode => (modeRaw() === 'capture' ? 'capture' : 'annihilation');
const pts = (c: Record<UnitKind, number>): number => KINDS.reduce((t, k) => t + c[k] * UNITS[k].cost, 0);
const limits = (): { field: number; total: number } => (mode() === 'capture' ? { field: RULES.capture.fieldCap, total: RULES.capture.budget } : { field: RULES.budget, total: RULES.budget });

/** 超出點數上限的原因（空字串 = 合格） */
function armyProblem(): string {
  const lim = limits();
  const f = pts(army.field);
  const r = mode() === 'capture' ? pts(army.reserve) : 0;
  if (f === 0) return '場上至少要有一團';
  if (f > lim.field) return `場上 ${f} 點，超過上限 ${lim.field}`;
  if (f + r > lim.total) return `總共 ${f + r} 點，超過上限 ${lim.total}`;
  return '';
}

function renderArmy(): void {
  if (modeRaw() === 'sandbox') {
    armyEl.classList.add('hidden');
    renderSandbox();
    return;
  }
  const player = blueSel.value === 'player';
  armyEl.classList.toggle('hidden', !player);
  startBtn.textContent = player ? '開始指揮' : '開始觀戰';
  startBtn.disabled = false;
  if (!player) return;
  const cap = mode() === 'capture';
  const lim = limits();
  rowsEl.classList.toggle('no-reserve', !cap);
  document.getElementById('army-note')!.textContent = cap
    ? `場上最多 ${lim.field} 點，加上後備共 ${lim.total} 點。後備從出生點入場，或把場上的團帶到出生點／自己的補給站換下來。`
    : `共 ${lim.field} 點，全部上場（殲滅戰沒有後備）。`;
  const cnt = (side: 'field' | 'reserve', k: UnitKind): string =>
    `<span class="cnt ${side === 'reserve' ? 'rs' : ''}"><button type="button" data-side="${side}" data-kind="${k}" data-d="-1">−</button><b>${army[side][k]}</b><button type="button" data-side="${side}" data-kind="${k}" data-d="1">＋</button></span>`;
  rowsEl.innerHTML =
    `<span></span><span></span><span class="hd">場上</span><span class="hd rs">後備</span>` +
    KINDS.map((k) => `<span class="u">${unitSvg(k, 20)}${UNITS[k].name}</span><span class="cost">${UNITS[k].cost} 點／${UNITS[k].men} 人</span>${cnt('field', k)}${cnt('reserve', k)}`).join('');
  const f = pts(army.field);
  const r = pts(army.reserve);
  const bad = armyProblem();
  totalEl.textContent = (cap ? `場上 ${f} / ${lim.field}　後備 ${r}　總計 ${f + r} / ${lim.total}` : `${f} / ${lim.field} 點`) + (bad ? `　⚠ ${bad}` : '');
  totalEl.classList.toggle('over', bad !== '');
  startBtn.disabled = bad !== '';
}

rowsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]');
  if (b === null) return;
  const side = b.dataset.side as 'field' | 'reserve';
  const k = b.dataset.kind as UnitKind;
  const lim = limits();
  const maxCount = Math.floor((side === 'field' ? lim.field : lim.total) / UNITS[k].cost);
  army[side][k] = Math.max(0, Math.min(maxCount, army[side][k] + Number(b.dataset.d)));
  renderArmy();
});
document.getElementById('army-reset')!.addEventListener('click', () => {
  army.field = { ...DEFAULT_FIELD };
  army.reserve = { ...DEFAULT_RESERVE };
  renderArmy();
});
// ───── 自訂對戰（沙盒） ─────
const sandboxEl = document.getElementById('sandbox')!;
const pickEl = document.querySelector('.lg-pick') as HTMLElement;
const sbRoleSel = [0, 1].map((i) => document.getElementById(`sb-role${i}`) as HTMLSelectElement);
const sbDist = document.getElementById('sb-dist') as HTMLSelectElement;
const SB_MAX = 20;
const none = (): Record<UnitKind, number> => ({ spear: 0, sword: 0, shield: 0, archer: 0, light: 0, lightCav: 0, heavyCav: 0 });
/** 預設：一團重騎兵對一團長槍 */
const sbArmy: [Record<UnitKind, number>, Record<UnitKind, number>] = [{ ...none(), heavyCav: 1 }, { ...none(), spear: 1 }];
// 指揮方式：藍方多一個「玩家」；現有 AI 沿用觀戰選單的名稱
const aiOptions = [...blueSel.options].filter((o) => o.value !== 'player' && o.value !== 'random').map((o) => `<option value="${o.value}">${o.text}（指揮指定兵團）</option>`).join('');
const basicOptions = '<option value="idle">待命（自己不動，你可以替它下指令）</option><option value="attack">直接進攻（全軍打最近的敵人）</option>';
sbRoleSel[0].innerHTML = `<option value="player">玩家（你來指揮）</option>${basicOptions}${aiOptions}`;
sbRoleSel[1].innerHTML = `${basicOptions}${aiOptions}`;

function renderSandbox(): void {
  for (const i of [0, 1]) {
    const a = sbArmy[i];
    const cnt = (k: UnitKind): string => `<span class="cnt"><button type="button" data-sb="${i}" data-kind="${k}" data-d="-1">−</button><b>${a[k]}</b><button type="button" data-sb="${i}" data-kind="${k}" data-d="1">＋</button></span>`;
    document.getElementById(`sb-rows${i}`)!.innerHTML = KINDS.map((k) => `<span class="u">${unitSvg(k, 20)}${UNITS[k].name}</span><span class="cost">${UNITS[k].cost} 點／${UNITS[k].men} 人</span>${cnt(k)}`).join('');
    const n = KINDS.reduce((t, k) => t + a[k], 0);
    document.getElementById(`sb-total${i}`)!.textContent = `${n} 團・${pts(a)} 點`;
  }
  const empty = [0, 1].some((i) => KINDS.every((k) => sbArmy[i][k] === 0));
  startBtn.textContent = empty ? '雙方都至少要一團' : '開始布陣';
  startBtn.disabled = empty;
}

sandboxEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const clear = t.closest<HTMLButtonElement>('button[data-sb-clear]');
  if (clear !== null) {
    sbArmy[Number(clear.dataset.sbClear)] = none();
    renderSandbox();
    return;
  }
  const b = t.closest<HTMLButtonElement>('button[data-sb]');
  if (b === null) return;
  const a = sbArmy[Number(b.dataset.sb)];
  const k = b.dataset.kind as UnitKind;
  a[k] = Math.max(0, Math.min(SB_MAX, a[k] + Number(b.dataset.d)));
  renderSandbox();
});

/** 地圖卡片跟著模式換（殲滅戰：河谷；佔點：大河谷；沙盒：平地測試場） */
const SANDBOX_TEXT: [string, string] = [
  '地圖：平地測試場',
  '160 × 100 格（只有自訂對戰用）。中央一整片平地；北側由西到東是高地（高 3，頂 4）、樹林、一段有橋與淺灘渡口的河；南側是有房舍擋視線的村莊、緩坡（只高 1 階）與淺水池。布陣時可以把軍團拖到這些地形上測試。',
];
const MAP_TEXT: Record<LegionMode, [string, string]> = {
  annihilation: [
    '地圖：河谷',
    '160 × 100 格。中央一條 S 形河流，南北各一座 3 格寬的窄橋、中央一處淺灘（走得慢、受到的近戰傷害較高）；兩岸都有樹林可以埋伏，淺灘兩側各有一座高地（視野與射程加成）。藍方從西邊、紅方從東邊出發。',
  ],
  capture: [
    '地圖：大河谷',
    '240 × 150 格。縱貫中央的 S 形大河，北橋、中央淺灘、南橋三個渡口相隔約 48 格，各插一面旗（淺灘 2 分、橋 1 分）；兩座橋旁各有一個補給站，歸佔著那座橋的一方。兩岸有樹林、高地與村莊，雙方必須分兵。藍方出生點在西邊、紅方在東邊。',
  ],
};
function renderMode(): void {
  const sandbox = modeRaw() === 'sandbox';
  sandboxEl.classList.toggle('hidden', !sandbox);
  pickEl.classList.toggle('hidden', sandbox);
  const [name, desc] = sandbox ? SANDBOX_TEXT : MAP_TEXT[mode()];
  document.getElementById('map-name')!.textContent = name;
  document.getElementById('map-desc')!.textContent = desc;
  renderArmy();
}

blueSel.addEventListener('change', renderArmy);
for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', renderMode);
renderMode();

function playerArmy(): PlayerArmy {
  const list = (c: Record<UnitKind, number>): UnitKind[] => KINDS.flatMap((k) => Array<UnitKind>(c[k]).fill(k));
  return { field: list(army.field), reserve: mode() === 'capture' ? list(army.reserve) : [] };
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
  const sandbox = modeRaw() === 'sandbox';
  if (sandbox && startBtn.disabled) return;
  const m = mode();
  const blue = blueSel.value === 'player' ? 'player' : pick('blue');
  if (!sandbox && blue === 'player' && armyProblem() !== '') return;
  worker?.terminate();
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker = w;
  w.onmessage = (ev: MessageEvent<FromLegionWorker>) => {
    const msg = ev.data;
    if (msg.type === 'meta') {
      // 重看：同一種畫面（觀戰／玩家）沿用；玩家打完改成重播（觀戰畫面）就換新的
      if (screen !== null) {
        if (screen.playerSide === msg.meta.playerSide && !msg.meta.replay) return;
        screen.dispose();
      }
      setupEl.classList.add('hidden');
      screen = new LegionScreen(gameEl, w, msg.meta, exitToMenu);
    } else if (msg.type === 'error') {
      console.error(msg.message);
      alert(`引擎錯誤：\n${msg.message}`);
    } else screen?.handle(msg);
  };
  w.onerror = (e) => alert(`Worker 錯誤：${e.message}`);
  const list = (c: Record<UnitKind, number>): UnitKind[] => KINDS.flatMap((k) => Array<UnitKind>(c[k]).fill(k));
  const start: ToLegionWorker = sandbox
    ? {
        type: 'start',
        setup: {
          kind: 'sandbox',
          seed,
          roles: [sbRoleSel[0].value as SandboxRole, sbRoleSel[1].value as SandboxRole],
          armies: [list(sbArmy[0]), list(sbArmy[1])],
          distance: Number(sbDist.value),
        },
      }
    : { type: 'start', setup: { bots: [blue, pick('red')], mode: m, seed, army: blue === 'player' ? playerArmy() : undefined } };
  w.postMessage(start);
}

document.getElementById('start')!.addEventListener('click', launch);
