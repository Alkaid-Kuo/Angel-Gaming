// 經營頁 v2 入口：畫面切換、HUD、底部導覽、視窗、比賽日演出、事件處理。
// 遊戲狀態與存檔沿用 ../manage/store.ts（同一份 localStorage 存檔，新舊介面可以互通）。
import type { Command } from '../../manage/index.ts';
import { esc, wan } from '../manage/format.ts';
import { ManageGame } from '../manage/store.ts';
import type { CrestSpec, EmblemName } from './art.ts';
import { SLOT_NAMES, crestSvg, icon, type IconName } from './art.ts';
import { hubScreen } from './hub.ts';
import { financeScreen, inboxScreen, leagueScreen } from './info.ts';
import { buildScenes, snapshot, type Scene } from './matchday.ts';
import type { ClubUi, Ctx } from './model.ts';
import { DEFAULT_CREST, lineupOf, newClubUi } from './model.ts';
import { bettingScreen, trainingScreen } from './ops.ts';
import { loadPrefs, savePrefs } from './prefs.ts';
import { cardModal, marketScreen, squadScreen } from './squad.ts';
import { createScreen, titleScreen, type Draft } from './title.ts';

type Screen = 'title' | 'create' | 'hub' | 'squad' | 'market' | 'training' | 'league' | 'betting' | 'finance' | 'inbox';

const DOCK: { id: Screen; ic: IconName; label: string }[] = [
  { id: 'hub', ic: 'home', label: '基地' },
  { id: 'squad', ic: 'users', label: '戰隊' },
  { id: 'market', ic: 'contract', label: '市場' },
  { id: 'training', ic: 'target', label: '訓練' },
  { id: 'league', ic: 'trophy', label: '聯賽' },
  { id: 'betting', ic: 'ticket', label: '賭盤' },
  { id: 'finance', ic: 'chart', label: '財務' },
  { id: 'inbox', ic: 'mail', label: '信件' },
];

const app = document.getElementById('app')!;
const cineEl = document.getElementById('cine')!;
const toastEl = document.getElementById('toasts')!;

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);
const prefs = loadPrefs();
let game: ManageGame | null = null;
let screen: Screen = 'title';
let lastScreen: Screen | null = null;
let ui: ClubUi = newClubUi();
let draft: Draft = { name: '天使戰隊', crest: { ...(prefs.crest ?? DEFAULT_CREST) }, seed: randomSeed() };
let modal: { kind: 'card'; pid: string } | { kind: 'menu' } | { kind: 'confirm'; title: string; text: string; ok: string; fn: () => void } | null = null;
let busy = false;
let lastCash: number | null = null;
let cine: { scenes: Scene[]; i: number } | null = null;
let cineTimer = 0;

const speed = (): number => (prefs.fast ? 0.5 : 1);

function toast(msg: string, bad = false): void {
  const el = document.createElement('div');
  el.className = `toast ${bad ? 'bad' : ''}`;
  el.innerHTML = `${icon(bad ? 'warn' : 'check', 16)}<span>${esc(msg)}</span>`;
  toastEl.append(el);
  setTimeout(() => el.classList.add('out'), 2300);
  setTimeout(() => el.remove(), 2700);
}

function context(): Ctx {
  const g = game as ManageGame;
  const v = g.view();
  const ctx: Ctx = { v, c: g.content, ui, prefs, pm: new Map(v.players.map((p) => [p.id, p])) };
  // 表單預設值落在有效選項上
  const mine = v.me.roster;
  const others = v.players.filter((p) => p.teamId !== v.me.teamId).map((p) => p.id);
  if (!mine.includes(ui.scrim.playerId)) ui.scrim.playerId = mine[0] ?? '';
  if (!others.includes(ui.scrim.opponentId)) ui.scrim.opponentId = v.players.find((p) => p.teamId !== null && p.teamId !== v.me.teamId)?.id ?? others[0] ?? '';
  if (!mine.includes(ui.research.playerId)) ui.research.playerId = mine[0] ?? '';
  return ctx;
}

function unread(ctx: Ctx): number {
  return Math.max(0, ctx.v.inbox.length - prefs.inboxSeen);
}

// ───── 外框 ─────
function hud(ctx: Ctx): string {
  const { v } = ctx;
  const nodes = ['休', '1', '2', '3', '4', '5', '6', '7', '準', '決'];
  const cur = v.phase === 'offseason' ? 0 : v.phase === 'season' ? v.week : 10;
  const over = v.phase === 'ended' || v.phase === 'bankrupt';
  const label = busy ? '進行中…' : over ? (v.phase === 'bankrupt' ? '已破產' : '賽季結束') : v.phase === 'offseason' ? '賽季開幕' : '比賽日';
  const runway = v.me.runwayWeeks;
  return `<header class="hud">
    <button class="hud-team" data-act="go" data-to="hub">${crestSvg(prefs.crest ?? DEFAULT_CREST, 40)}<span><b>${esc(v.me.name)}</b><small>${game?.persist === false ? '展示模式・不存檔' : '新創聯賽'}</small></span></button>
    <div class="hud-cal" title="賽程進度">${nodes.map((n, i) => `<i class="${i < cur ? 'done' : i === cur && !over ? 'now' : ''} ${i >= 8 ? 'po' : ''}">${n}</i>`).join('')}</div>
    <div class="hud-res">
      <span class="res cash ${v.me.cash < 0 ? 'neg' : ''}" title="現金">${icon('coins', 18)}<b id="hud-cash">${wan(v.me.cash)}</b><small>萬</small></span>
      <span class="res" title="名氣：每點每週贊助 ${wan(ctx.c.economy.sponsorPerFame)} 萬">${icon('star', 18)}<b>${v.me.fame}</b></span>
      <span class="res ${runway !== null && runway < 3 ? 'warn' : ''}" title="只靠固定收支還撐幾週">${icon('hourglass', 18)}<b>${runway === null ? '∞' : runway}</b><small>週</small></span>
    </div>
    <button class="hud-next ${over ? '' : 'glow'}" data-act="advance" ${busy || over ? 'disabled' : ''}>${icon('play', 16)}<span>${label}</span></button>
    <button class="hud-menu" data-act="menu" aria-label="選單">${icon('menu', 22)}</button></header>`;
}

function dock(ctx: Ctx): string {
  const n = unread(ctx);
  return `<nav class="dock">${DOCK.map((d) => `<button class="${d.id === screen ? 'on' : ''}" data-act="go" data-to="${d.id}">${icon(d.ic, 22)}<span>${d.label}</span>${d.id === 'inbox' && n ? `<em>${n}</em>` : ''}</button>`).join('')}</nav>`;
}

function screenHtml(ctx: Ctx, seen: number): string {
  switch (screen) {
    case 'squad':
      return squadScreen(ctx);
    case 'market':
      return marketScreen(ctx);
    case 'training':
      return trainingScreen(ctx);
    case 'league':
      return leagueScreen(ctx);
    case 'betting':
      return bettingScreen(ctx);
    case 'finance':
      return financeScreen(ctx);
    case 'inbox':
      return inboxScreen(ctx, seen);
    default:
      return hubScreen(ctx, unread(ctx));
  }
}

function modalHtml(ctx: Ctx | null): string {
  if (!modal) return '';
  let inner = '';
  if (modal.kind === 'card' && ctx) inner = `<button class="modal-x" data-act="close-modal">${icon('close', 20)}</button>${cardModal(ctx, modal.pid)}`;
  else if (modal.kind === 'menu')
    inner = `<h3>${icon('menu', 20)}選單</h3><div class="menu-list">
      <button data-act="export">${icon('download', 18)}匯出存檔<small>下載成 .json 備份</small></button>
      <button data-act="speed">${icon('skip', 18)}演出速度：${prefs.fast ? '快速' : '一般'}<small>點一下切換</small></button>
      <button data-act="to-title">${icon('exit', 18)}回到標題畫面<small>進度已自動存檔</small></button>
      <a href="./manage.html">${icon('chart', 18)}舊版介面<small>同一份存檔</small></a></div>`;
  else if (modal.kind === 'confirm')
    inner = `<h3>${icon('warn', 20)}${esc(modal.title)}</h3><p>${esc(modal.text)}</p><div class="confirm-btns"><button class="btn-sub" data-act="close-modal">取消</button><button class="btn-main" data-act="confirm-ok">${esc(modal.ok)}</button></div>`;
  return `<div class="modal-bg" data-act="close-modal"><div class="modal ${modal.kind}" data-act="noop">${inner}</div></div>`;
}

function render(): void {
  if (screen === 'title' || screen === 'create' || !game) {
    const peek = ManageGame.peek();
    app.innerHTML = (screen === 'create' ? createScreen(draft) : titleScreen(peek, prefs.crest ?? DEFAULT_CREST)) + modalHtml(null);
    lastScreen = screen;
    return;
  }
  const ctx = context();
  const seen = prefs.inboxSeen;
  const changed = lastScreen !== screen;
  app.innerHTML = `<div class="cl">${hud(ctx)}<main class="cl-main scr-${screen} ${changed ? 'enter' : ''}">${screenHtml(ctx, seen)}</main>${dock(ctx)}</div>${modalHtml(ctx)}`;
  if (changed) window.scrollTo(0, 0);
  lastScreen = screen;
  if (screen === 'inbox' && prefs.inboxSeen !== ctx.v.inbox.length) {
    prefs.inboxSeen = ctx.v.inbox.length;
    savePrefs(prefs);
  }
  // 現金變動：數字滾動＋飄字
  const cash = ctx.v.me.cash;
  if (lastCash !== null && lastCash !== cash) {
    const el = document.getElementById('hud-cash');
    if (el) {
      const from = lastCash;
      const t0 = performance.now();
      const tick = (now: number): void => {
        const k = Math.min(1, (now - t0) / 600);
        el.textContent = wan(Math.round(from + (cash - from) * (1 - (1 - k) * (1 - k))));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const fl = document.createElement('span');
      fl.className = `float ${cash > from ? 'pos' : 'neg'}`;
      fl.textContent = `${cash > from ? '+' : '−'}${wan(Math.abs(cash - from))}`;
      el.parentElement?.append(fl);
    }
  }
  lastCash = cash;
}

// ───── 比賽日演出 ─────
function showScene(): void {
  clearTimeout(cineTimer);
  if (!cine) {
    cineEl.innerHTML = '';
    return;
  }
  const sc = cine.scenes[cine.i];
  const hasStop = cine.scenes.slice(cine.i + 1).some((s) => s.stop) && !sc.stop;
  cineEl.innerHTML = `<div class="cine" style="--sp:${speed()}"><div class="cine-bar">${hasStop ? `<button data-act="cine-skip">${icon('skip', 16)}跳過演出</button>` : ''}<button data-act="speed">${prefs.fast ? '一般速度' : '加速'}</button></div>${sc.html}${sc.auto ? `<div class="cine-tap">${icon('play', 14)}點擊畫面繼續</div>` : ''}</div>`;
  sc.enter?.(cineEl, speed());
  if (sc.auto) cineTimer = window.setTimeout(nextScene, sc.auto * speed());
}

function nextScene(): void {
  if (!cine) return;
  cine.i++;
  if (cine.i >= cine.scenes.length) {
    cine = null;
    showScene();
    render();
    return;
  }
  showScene();
}

function skipScenes(): void {
  if (!cine) return;
  const j = cine.scenes.findIndex((s, k) => k > (cine as { i: number }).i && s.stop);
  if (j > 0) {
    cine.i = j;
    showScene();
  }
}

async function doAdvance(): Promise<void> {
  if (!game || busy) return;
  const before = snapshot(context());
  const wasOff = game.state.phase === 'offseason';
  busy = true;
  modal = null;
  render();
  try {
    const summary = await game.advance();
    ui.slip = null;
    ui.leagueWeek = null;
    ui.pickSlot = null;
    const ctx = context();
    lastCash = ctx.v.me.cash;
    cine = { scenes: buildScenes(ctx, summary, before, wasOff), i: 0 };
    showScene();
  } catch (e) {
    toast(e instanceof Error ? e.message : '推進失敗', true);
  }
  busy = false;
  render();
}

// ───── 指令 ─────
function run(cmd: Command, okMsg: string): boolean {
  if (!game) return false;
  const r = game.command(cmd);
  toast(r.ok ? okMsg : r.reason, !r.ok);
  if (game.saveError) toast(`無法存檔：${game.saveError}（請用選單匯出備份）`, true);
  render();
  return r.ok;
}

function assign(slot: number, pid: string): void {
  if (!game) return;
  const ctx = context();
  const ids = lineupOf(ctx).ids.slice();
  const j = ids.indexOf(pid);
  if (j >= 0 && j !== slot) ids[j] = ids[slot];
  ids[slot] = pid;
  ui.pickSlot = null;
  run({ type: 'setLineup', lineup: ids }, `${ctx.pm.get(pid)?.name ?? ''} 擔任${SLOT_NAMES[slot]}`);
}

function confirmThen(title: string, text: string, ok: string, fn: () => void): void {
  modal = { kind: 'confirm', title, text, ok, fn };
  render();
}

function startGame(g: ManageGame): void {
  game = g;
  ui = newClubUi();
  prefs.inboxSeen = 0;
  savePrefs(prefs);
  lastCash = null;
  modal = null;
  screen = 'hub';
  render();
}

function maxStake(): number {
  if (!game || !ui.slip) return 0;
  const ctx = context();
  const e = ctx.c.economy;
  const limit = e.betLimitBase + e.betLimitPerFame * ctx.v.me.fame;
  const staked = ctx.v.bets.filter((b) => b.fixtureId === ui.slip?.fixtureId).reduce((s, b) => s + b.stake, 0);
  return Math.max(0, Math.floor(Math.min(limit - staked, ctx.v.me.cash) / 10));
}

const id = (el: HTMLElement): string => el.dataset.id as string;

const actions: Record<string, (el: HTMLElement) => unknown> = {
  noop: () => undefined,
  go: (el) => {
    screen = el.dataset.to as Screen;
    ui.pickSlot = null;
    modal = null;
    render();
  },
  advance: () => doAdvance(),
  card: (el) => {
    modal = { kind: 'card', pid: el.dataset.pid as string };
    render();
  },
  'close-modal': () => {
    modal = null;
    render();
  },
  'confirm-ok': () => {
    const m = modal;
    modal = null;
    if (m?.kind === 'confirm') m.fn();
    render();
  },
  'pick-slot': (el) => {
    const s = Number(el.dataset.slot);
    ui.pickSlot = s < 0 || ui.pickSlot === s ? null : s;
    render();
  },
  assign: (el) => {
    if (ui.pickSlot !== null) assign(ui.pickSlot, el.dataset.pid as string);
  },
  sign: (el) => {
    if (run({ type: 'sign', playerId: id(el) }, '簽約成功！歡迎加入戰隊')) modal = null;
    render();
  },
  scout: (el) => run({ type: 'scout', playerId: id(el) }, '球探出發了，推進一週後回報'),
  upgrade: (el) => run({ type: 'upgradeVersion', playerId: id(el) }, '開始升版培訓'),
  release: (el) => {
    const name = game?.view().players.find((p) => p.id === id(el))?.name ?? '';
    confirmThen('解約', `確定要和 ${name} 解約嗎？他會回到自由市場，已付的簽約金不退。`, '解約', () => {
      run({ type: 'release', playerId: id(el) }, `已和 ${name} 解約`);
    });
  },
  upfac: () => run({ type: 'upgradeTraining' }, '訓練中心升級完成！'),
  'train-with': (el) => {
    ui.scrim.playerId = id(el);
    ui.research.playerId = id(el);
    modal = null;
    screen = 'training';
    render();
  },
  'scrim-vs': (el) => {
    ui.scrim.opponentId = id(el);
    modal = null;
    screen = 'training';
    render();
  },
  market: (el) => {
    ui.market = el.dataset.m as ClubUi['market'];
    render();
  },
  target: (el) => {
    ui.research.target = el.dataset.t as string;
    render();
  },
  scrim: () => run({ type: 'queueScrim', opponentTeamId: game?.view().players.find((p) => p.id === ui.scrim.opponentId)?.teamId ?? '', games: ui.scrim.games }, '練習賽排好了，推進一週後出報告'),
  research: () => run({ type: 'queueResearch', playerId: ui.research.playerId, target: ui.research.target, games: ui.research.games }, '研發排好了，推進一週後出報告'),
  slip: (el) => {
    ui.slip = { fixtureId: el.dataset.fid as string, side: el.dataset.side as 'home' | 'away', stake: ui.slip?.stake ?? 5 };
    render();
  },
  'stake-add': (el) => {
    if (ui.slip) ui.slip.stake = Math.min(maxStake(), ui.slip.stake + Number(el.dataset.n));
    render();
  },
  'stake-max': () => {
    if (ui.slip) ui.slip.stake = maxStake();
    render();
  },
  'stake-clear': () => {
    if (ui.slip) ui.slip.stake = 0;
    render();
  },
  'slip-clear': () => {
    ui.slip = null;
    render();
  },
  'place-bet': () => {
    if (!ui.slip) return;
    const s = ui.slip;
    if (run({ type: 'bet', fixtureId: s.fixtureId, side: s.side, stake: Math.min(s.stake, maxStake()) * 10 }, '下注成功，祝你好運')) ui.slip = null;
    render();
  },
  lweek: (el) => {
    ui.leagueWeek = Number(el.dataset.w);
    render();
  },
  ledger: () => {
    ui.ledgerOpen = !ui.ledgerOpen;
    render();
  },
  menu: () => {
    modal = { kind: 'menu' };
    render();
  },
  export: () => {
    if (!game) return;
    const blob = new Blob([game.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `angel-gaming-w${game.state.week}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('存檔已匯出');
  },
  speed: () => {
    prefs.fast = !prefs.fast;
    savePrefs(prefs);
    if (cine) showScene();
    else render();
  },
  'to-title': () => {
    game = null;
    modal = null;
    screen = 'title';
    render();
  },
  'to-create': () => {
    draft = { name: draft.name || '天使戰隊', crest: { ...(prefs.crest ?? DEFAULT_CREST) }, seed: randomSeed() };
    screen = 'create';
    render();
  },
  crest: (el) => {
    const k = el.dataset.k as keyof CrestSpec;
    const val = el.dataset.v as string;
    if (k === 'shape') draft.crest.shape = Number(val);
    else if (k === 'emblem') draft.crest.emblem = val as EmblemName;
    else if (k === 'primary') draft.crest.primary = val;
    else draft.crest.secondary = val;
    render();
  },
  reroll: () => {
    draft.seed = randomSeed();
    render();
  },
  create: () => {
    const make = (): void => {
      prefs.crest = { ...draft.crest };
      savePrefs(prefs);
      startGame(ManageGame.create(draft.seed, draft.name.trim() || '天使戰隊'));
      toast(`${draft.name.trim() || '天使戰隊'} 成立了！`);
    };
    if (ManageGame.peek()) confirmThen('覆蓋存檔', '已經有一份進行中的存檔，創立新戰隊會把它覆蓋掉。確定嗎？', '覆蓋並創立', make);
    else make();
  },
  continue: () => {
    const g = ManageGame.load();
    if (!g) {
      toast('讀不到存檔', true);
      return;
    }
    startGame(g);
  },
  'new-season': () => {
    cine = null;
    showScene();
    actions['to-create'](document.body);
  },
  'cine-next': () => nextScene(),
  'cine-skip': () => skipScenes(),
};

function dispatch(e: Event): void {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const fn = actions[el.dataset.act as string];
  if (fn) void fn(el);
}

app.addEventListener('click', dispatch);
cineEl.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (el) dispatch(e);
  else if (cine && cine.scenes[cine.i].auto) nextScene();
});

function setField(path: string, raw: string): void {
  const n = Math.max(0, Math.floor(Number(raw)) || 0);
  switch (path) {
    case 'draft.name':
      draft.name = raw;
      document.querySelectorAll('[data-out="team-name"]').forEach((x) => (x.textContent = raw || '天使戰隊'));
      return;
    case 'draft.seed':
      draft.seed = n;
      return;
    case 'scrim.playerId':
      ui.scrim.playerId = raw;
      return;
    case 'scrim.opponentId':
      ui.scrim.opponentId = raw;
      return;
    case 'research.playerId':
      ui.research.playerId = raw;
      return;
    case 'scrim.games':
    case 'research.games': {
      const k = path === 'scrim.games' ? ui.scrim : ui.research;
      k.games = Math.max(10, n);
      document.querySelectorAll(`[data-out="${path}"]`).forEach((x) => (x.textContent = String(k.games)));
      return;
    }
    case 'slip.stake': {
      if (!ui.slip || !game) return;
      ui.slip.stake = Math.min(n, maxStake());
      const ctx = context();
      const o = ctx.v.odds.find((x) => x.fixtureId === ui.slip?.fixtureId);
      const odds = o ? (ui.slip.side === 'home' ? o.homeX100 : o.awayX100) : 0;
      document.querySelectorAll('[data-out="slip.pay"]').forEach((x) => (x.textContent = wan(Math.floor((ui.slip!.stake * 10 * odds) / 100))));
      return;
    }
  }
}

app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset?.field) setField(t.dataset.field, t.value);
});

app.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t instanceof HTMLInputElement && t.id === 'import' && t.files?.[0]) {
    void t.files[0].text().then((text) => {
      const load = (): void => {
        try {
          startGame(ManageGame.fromJson(text));
          toast('存檔匯入完成');
        } catch (err) {
          toast(err instanceof Error ? err.message : '存檔格式不對', true);
        }
      };
      if (ManageGame.peek()) confirmThen('覆蓋存檔', '匯入會覆蓋目前的存檔，確定嗎？', '覆蓋並匯入', load);
      else load();
    });
  } else if (t.dataset?.field) {
    setField(t.dataset.field, t.value);
  }
});

// 拖曳選手卡到出賽位
app.addEventListener('dragstart', (e) => {
  const card = (e.target as Element).closest<HTMLElement>('.pc[draggable]');
  if (!card || !e.dataTransfer) return;
  e.dataTransfer.setData('text/plain', card.dataset.pid as string);
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
  document.body.classList.add('is-dragging');
});
app.addEventListener('dragend', () => {
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.dragging, .slot.over').forEach((x) => x.classList.remove('dragging', 'over'));
});
app.addEventListener('dragover', (e) => {
  const slot = (e.target as Element).closest<HTMLElement>('[data-drop-slot]');
  if (!slot) return;
  e.preventDefault();
  slot.classList.add('over');
});
app.addEventListener('dragleave', (e) => {
  (e.target as Element).closest('[data-drop-slot]')?.classList.remove('over');
});
app.addEventListener('drop', (e) => {
  const slot = (e.target as Element).closest<HTMLElement>('[data-drop-slot]');
  const pid = e.dataTransfer?.getData('text/plain');
  if (!slot || !pid) return;
  e.preventDefault();
  document.body.classList.remove('is-dragging');
  assign(Number(slot.dataset.dropSlot), pid);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal) {
    modal = null;
    render();
  } else if (cine && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    if (cine.scenes[cine.i].auto) nextScene();
  }
});

/**
 * 展示模式（截圖、示範用）：?demo=種子&weeks=先推進幾週&to=畫面&match=1（再播一次比賽日）&scene=第幾幕&hold=1（停在那一幕）。
 * 不讀也不寫 localStorage，不會覆蓋玩家的存檔。
 */
async function boot(): Promise<void> {
  const q = new URLSearchParams(location.search);
  if (!q.has('demo')) {
    render();
    return;
  }
  const g = ManageGame.demo(Number(q.get('demo')) || 1, '天使戰隊');
  const v0 = g.view();
  const fa = v0.players.filter((p) => p.teamId === null).sort((a, b) => b.elo - a.elo)[0];
  if (fa) g.command({ type: 'sign', playerId: fa.id });
  const foe = v0.players.find((p) => p.teamId !== null && p.teamId !== v0.me.teamId);
  if (foe) g.command({ type: 'scout', playerId: foe.id });
  g.command({ type: 'queueResearch', playerId: v0.me.roster[0], target: 'generic', games: 100 });
  const weeks = Number(q.get('weeks') ?? 0);
  if (q.has('broke')) (g.state.teams.find((t) => t.human) as { cash: number }).cash = -1;
  for (let i = 0; i < weeks && (g.state.phase === 'offseason' || g.state.phase === 'season'); i++) await g.advance();
  game = g;
  ui = newClubUi();
  screen = (q.get('to') as Screen | null) ?? 'hub';
  render();
  if (q.has('match')) {
    await doAdvance();
    const k = Number(q.get('scene') ?? 0);
    if (cine && k > 0 && k < cine.scenes.length) {
      cine.i = k;
      showScene();
    }
    if (q.has('hold')) clearTimeout(cineTimer);
  }
}

void boot();
