// 正式版經營介面（天使金規格）入口：畫面切換、外框、視窗、比賽日演出、事件處理。
// 版面是 1920×1080 的舞台，等比縮放到視窗（stage.ts）。遊戲狀態與存檔沿用 ../manage/store.ts，跟舊介面同一份存檔。
// 開新局時選項目（攻防戰／軍團戰暫代）；攻防戰的比賽在 Worker 池裡真打，推進時顯示「模擬中 n／m 場」。
// 觀戰：賽制自報能觀戰時，結果幕與聯賽頁的比賽有「觀戰」，把存檔裡的請求單寫成觀戰票、開新分頁 web/shooter.html#watch 重播。
import type { Command } from '../../manage/index.ts';
import { GAME_KINDS, ManageGame } from '../manage/store.ts';
import { EMBLEM_NAMES, type EmblemName } from '../club/art.ts';
import { lineupOf, newClubUi } from '../club/model.ts';
import { lineageName } from '../manage/format.ts';
import { WATCH_HASH, writeTicket } from '../shooter/watch.ts';
import { loadPrefs, savePrefs } from '../club/prefs.ts';
import { mountCity, type CityView } from '../sketch/city.ts';
import { dust, initStage, still } from '../sketch/stage.ts';
import { hubPanels, hubTags } from './hub.ts';
import { financeScreen, inboxScreen, leagueScreen } from './info.ts';
import type { Ctx, GameUi, Screen } from './kit.ts';
import { STANDALONE, esc, icon, myCrest, newGameUi, runStep, slotName, teamName, wan } from './kit.ts';
import { bettingScreen, trainingScreen } from './ops.ts';
import { rail, topBar } from './shell.ts';
import { buildScenes, snapshot, stageName, type Scene } from './show.ts';
import { marketScreen, playerScreen, squadScreen } from './squad.ts';
import { createScreen, titleScreen, type Draft } from './title.ts';

initStage();
const app = document.getElementById('app') as HTMLElement;
const cineEl = document.getElementById('cine') as HTMLElement;
const toastEl = document.getElementById('toasts') as HTMLElement;
const citySec = document.getElementById('city') as HTMLElement;
const cityTags = document.getElementById('city-tags') as HTMLElement;

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);
const prefs = loadPrefs();
let game: ManageGame | null = null;
let screen: Screen = 'title';
let lastScreen: Screen | null = null;
/** 換畫面後這段時間內的重畫仍算「剛進場」（同一次操作常連畫兩次，例如確認視窗關掉後又重畫） */
let freshUntil = 0;
let ui: GameUi = newGameUi(newClubUi());
let draft: Draft = { name: '天使戰隊', crest: { ...myCrest(prefs) }, seed: randomSeed(), contentId: GAME_KINDS[0].content.id };
let modal: { kind: 'menu' } | { kind: 'confirm'; title: string; text: string; ok: string; fn: () => void } | null = null;
let busy = false;
/** 推進中的模擬進度（null＝沒有在模擬） */
let progress: { done: number; total: number; estMs: number } | null = null;
let lastCash: number | null = null;
let cine: { scenes: Scene[]; i: number } | null = null;
let cineTimer = 0;
const city: CityView = mountCity(document.getElementById('city-cv') as HTMLCanvasElement, document.getElementById('fx-cv') as HTMLCanvasElement, document.getElementById('rain-cv') as HTMLCanvasElement);
dust(document.getElementById('dust') as HTMLCanvasElement, ['rgba(255,217,138,.5)', 'rgba(220,235,255,.3)'], 60);
const bgWord = document.querySelector('.bgx .word') as HTMLElement;
const WORD: Partial<Record<Screen, string>> = { title: 'ANGEL', create: 'NEW TEAM', squad: 'SQUAD', player: 'PLAYER', market: 'RECRUIT', training: 'TRAINING', league: 'LEAGUE', betting: 'BETTING', finance: 'FINANCE', inbox: 'INBOX' };

const speed = (): number => (prefs.fast ? 0.5 : 1);

function toast(msg: string, bad = false): void {
  const el = document.createElement('div');
  el.className = `toast ${bad ? 'bad' : ''}`;
  el.innerHTML = `${icon(bad ? 'warn' : 'check', 18)}<span>${esc(msg)}</span>`;
  toastEl.append(el);
  setTimeout(() => el.classList.add('out'), 2300);
  setTimeout(() => el.remove(), 2700);
}

function context(): Ctx {
  const g = game as ManageGame;
  const v = g.view();
  const ctx: Ctx = { v, c: g.content, ui, prefs, pm: new Map(v.players.map((p) => [p.id, p])) };
  const mine = v.me.roster;
  // 練習賽對手是戰隊（ui.scrim.opponentId 存戰隊 id）：預設本週對手，沒有就第一支別隊
  const others = v.teams.filter((t) => t.id !== v.me.teamId).map((t) => t.id);
  if (!mine.includes(ui.scrim.playerId)) ui.scrim.playerId = mine[0] ?? '';
  if (!others.includes(ui.scrim.opponentId)) {
    const f = v.fixtures.find((x) => x.week === v.week && x.score === null && (x.home === v.me.teamId || x.away === v.me.teamId));
    ui.scrim.opponentId = f ? (f.home === v.me.teamId ? f.away : f.home) : (others[0] ?? '');
  }
  if (!mine.includes(ui.research.playerId)) ui.research.playerId = mine[0] ?? '';
  return ctx;
}

const unread = (ctx: Ctx): number => Math.max(0, ctx.v.inbox.length - prefs.inboxSeen);

function screenHtml(ctx: Ctx, seen: number): string {
  switch (screen) {
    case 'squad':
      return squadScreen(ctx);
    case 'player':
      return playerScreen(ctx);
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
      return hubPanels(ctx, busy);
  }
}

function modalHtml(): string {
  if (!modal) return '';
  let inner: string;
  if (modal.kind === 'menu')
    inner = `<div class="pt"><span class="no">MENU</span><b>選單</b></div><div class="menu-list">
      ${STANDALONE ? '' : `<button data-act="export">${icon('download', 22)}<b>匯出存檔</b><small>下載成 .json 備份</small></button>`}
      <button data-act="speed">${icon('skip', 22)}<b>演出速度：${prefs.fast ? '快速' : '一般'}</b><small>點一下切換</small></button>
      <button data-act="to-title">${icon('exit', 22)}<b>回到標題畫面</b><small>進度已自動存檔</small></button>
      ${STANDALONE ? '' : `<a href="./club.html">${icon('chart', 22)}<b>舊版介面</b><small>同一份存檔</small></a>`}</div>
      <div class="foot"><button class="btn ghost sm" data-act="close-modal"><b>關閉</b></button></div>`;
  else
    inner = `<div class="pt"><span class="no">CONFIRM</span><b>${esc(modal.title)}</b></div><p>${esc(modal.text)}</p><div class="foot"><button class="btn ghost" data-act="close-modal"><b>取消</b></button><button class="btn" data-act="confirm-ok"><b>${esc(modal.ok)}</b></button></div>`;
  return `<div class="modal-bg" data-act="close-modal"><div class="pn g modal ${modal.kind}" data-act="noop">${inner}</div></div>`;
}

function render(): void {
  if (lastScreen !== screen) freshUntil = performance.now() + 50;
  const changed = performance.now() < freshUntil;
  bgWord.textContent = WORD[screen] ?? '';
  if (screen === 'title' || screen === 'create' || !game) {
    citySec.hidden = true;
    app.innerHTML = `<div class="scr v-${screen} ${changed ? 'fresh' : ''}">${screen === 'create' ? createScreen(draft) : titleScreen(ManageGame.peek(), myCrest(prefs), ManageGame.saveProblem())}</div>${modalHtml()}`;
    lastScreen = screen;
    return;
  }
  const ctx = context();
  const seen = prefs.inboxSeen;
  // 打開信件就算已讀（未讀標記用進來前的數字畫）
  if (screen === 'inbox' && prefs.inboxSeen !== ctx.v.inbox.length) {
    prefs.inboxSeen = ctx.v.inbox.length;
    if (game.persist !== false) savePrefs(prefs);
  }
  const hub = screen === 'hub';
  citySec.hidden = !hub;
  if (hub) cityTags.innerHTML = hubTags(ctx);
  app.innerHTML = `<div class="scr v-${screen} ${changed ? 'fresh' : ''}">${screenHtml(ctx, seen)}</div>${topBar(ctx, unread(ctx), game.persist === false)}${hub ? '' : rail(ctx, screen, unread(ctx), busy)}${modalHtml()}${progressHtml()}`;
  lastScreen = screen;
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
      el.closest('.funds')?.append(fl);
    }
  }
  lastCash = cash;
}

// ───── 模擬進度 ─────
function progressText(): string {
  if (!progress) return '';
  if (progress.total === 0) return '準備中…';
  return `模擬中 ${progress.done}／${progress.total} 場`;
}

function progressHtml(): string {
  if (!progress) return '';
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const est = progress.estMs >= 3000 ? `預估約 ${Math.max(1, Math.round(progress.estMs / 1000))} 秒` : '';
  return `<div class="sim-prog"><div class="box"><span class="en">SIMULATING // 比賽進行中</span><b id="sim-prog-text">${progressText()}</b><div class="meter g" style="--v:${pct}%"><i id="sim-prog-bar"></i></div><small>${est}</small></div></div>`;
}

function onProgress(done: number, total: number): void {
  if (!progress) return;
  progress.done = done;
  progress.total = total;
  const t = document.getElementById('sim-prog-text');
  if (t) t.textContent = progressText();
  const bar = document.getElementById('sim-prog-bar')?.parentElement;
  if (bar) bar.style.setProperty('--v', `${total ? Math.round((done / total) * 100) : 0}%`);
}

// ───── 比賽日演出 ─────
function showScene(): void {
  clearTimeout(cineTimer);
  if (!cine) {
    cineEl.innerHTML = '';
    cineEl.hidden = true;
    return;
  }
  cineEl.hidden = false;
  const sc = cine.scenes[cine.i];
  const hasStop = !sc.stop && cine.scenes.slice(cine.i + 1).some((s) => s.stop);
  cineEl.innerHTML = `<div class="cine" style="--sp:${speed()}">${sc.html}<div class="cine-bar">${hasStop ? `<button class="btn ghost sm" data-act="cine-skip"><b>跳過演出</b><span>SKIP</span></button>` : ''}<button class="btn ghost sm" data-act="speed"><b>${prefs.fast ? '一般速度' : '加速 ×2'}</b></button></div></div>`;
  sc.enter?.(cineEl, speed());
  if (sc.auto) cineTimer = window.setTimeout(nextScene, sc.auto * speed());
}

function nextScene(): void {
  if (!cine) return;
  cine.i++;
  if (cine.i >= cine.scenes.length) {
    cine = null;
    showScene();
    screen = 'hub';
    render();
    return;
  }
  showScene();
}

function skipScenes(): void {
  if (!cine) return;
  const cur = cine.i;
  const j = cine.scenes.findIndex((s, k) => k > cur && s.stop);
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
  progress = { done: 0, total: 0, estMs: game.estimateWeekMs() };
  render();
  try {
    const summary = await game.advance(onProgress);
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
  progress = null;
  render();
}

// ───── 觀戰 ─────
/**
 * 開新分頁重播一場打完的比賽（新分頁：比賽日演出與經營畫面留在原分頁，看完關掉就回來）。
 * 被瀏覽器擋掉新分頁時改在本分頁開（回經營要按「繼續」讀檔）。
 */
function openWatch(fixtureId: string): void {
  if (!game) return;
  const ctx = context();
  const f = ctx.v.fixtures.find((x) => x.id === fixtureId);
  const t = game.watchTicket(fixtureId);
  if (!t || !f?.match) {
    toast('這場比賽不能觀戰', true);
    return;
  }
  const me = ctx.v.me.teamId;
  const specs = [...t.request.a.players, ...t.request.b.players];
  const ok = writeTicket({
    v: 1,
    request: t.request,
    outcome: t.outcome,
    names: [...f.match.home, ...f.match.away].map((id) => ctx.pm.get(id)?.name ?? id),
    // 打那場時的版本（之後升版不影響）
    tags: specs.map((s) => `${lineageName(ctx.c, s.lineageId)} v${s.version}`),
    teams: [teamName(ctx.v, f.home), teamName(ctx.v, f.away)],
    mine: f.home === me ? 0 : f.away === me ? 1 : null,
    title: stageName(f),
  });
  if (!ok) {
    toast('無法寫入觀戰資料（瀏覽器儲存空間不可用）', true);
    return;
  }
  const url = `./shooter.html${WATCH_HASH}`;
  if (!window.open(url, '_blank')) location.href = url;
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
  run({ type: 'setLineup', lineup: ids }, `${ctx.pm.get(pid)?.name ?? ''} 擔任${slotName(ctx, slot)}`);
}

function confirmThen(title: string, text: string, ok: string, fn: () => void): void {
  modal = { kind: 'confirm', title, text, ok, fn };
  render();
}

function startGame(g: ManageGame): void {
  game = g;
  ui = newGameUi(newClubUi());
  prefs.inboxSeen = 0;
  savePrefs(prefs);
  lastCash = null;
  modal = null;
  screen = 'hub';
  render();
}

/** 場數夾到滑桿級距的倍數、至少一級 */
function clampRuns(n: number): number {
  if (!game) return n;
  const c = game.content.economy;
  const lvl = game.state.teams.find((t) => t.human)?.trainingLevel ?? 1;
  const step = runStep(c.scrimCapacity[lvl - 1] ?? c.scrimCapacity[0]);
  return Math.max(step, Math.round(n / step) * step);
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
const go = (s: Screen): void => {
  screen = s;
  ui.pickSlot = null;
  modal = null;
  render();
};

const actions: Record<string, (el: HTMLElement) => unknown> = {
  noop: () => undefined,
  go: (el) => go(el.dataset.to as Screen),
  advance: () => doAdvance(),
  player: (el) => {
    ui.player = el.dataset.pid as string;
    go('player');
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
  sign: (el) => run({ type: 'sign', playerId: id(el) }, '簽約成功！歡迎加入戰隊'),
  scout: (el) => run({ type: 'scout', playerId: id(el) }, '球探出發了，推進一週後回報'),
  upgrade: (el) => run({ type: 'upgradeVersion', playerId: id(el) }, '開始升版培訓'),
  release: (el) => {
    const name = game?.view().players.find((p) => p.id === id(el))?.name ?? '';
    confirmThen('解約', `確定要和 ${name} 解約嗎？他會回到自由市場，已付的簽約金不退。`, '解約', () => {
      if (run({ type: 'release', playerId: id(el) }, `已和 ${name} 解約`)) go('squad');
    });
  },
  upfac: () => run({ type: 'upgradeTraining' }, '訓練中心升級完成！'),
  'train-with': (el) => {
    ui.scrim.playerId = id(el);
    ui.research.playerId = id(el);
    go('training');
  },
  'scrim-vs': (el) => {
    const t = game?.view().players.find((p) => p.id === id(el))?.teamId;
    if (t) ui.scrim.opponentId = t;
    ui.trainMode = 'scrim';
    go('training');
  },
  'pick-fa': (el) => {
    ui.marketPick = el.dataset.pid as string;
    render();
  },
  mtab: (el) => {
    ui.marketTab = el.dataset.t as GameUi['marketTab'];
    render();
  },
  tmode: (el) => {
    ui.trainMode = el.dataset.m as GameUi['trainMode'];
    render();
  },
  tpick: (el) => {
    ui.scrim.playerId = el.dataset.pid as string;
    ui.research.playerId = el.dataset.pid as string;
    render();
  },
  target: (el) => {
    ui.research.target = el.dataset.t as string;
    render();
  },
  scrim: () => run({ type: 'queueScrim', opponentTeamId: ui.scrim.opponentId, games: clampRuns(ui.scrim.games) }, '練習賽排好了，推進一週後出報告'),
  research: () => run({ type: 'queueResearch', playerId: ui.research.playerId, target: ui.research.target, games: clampRuns(ui.research.games) }, '研發排好了，推進一週後出報告'),
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
  mail: (el) => {
    ui.mailSel = Number(el.dataset.i);
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
    go('title');
  },
  'to-create': () => {
    draft = { name: draft.name || '天使戰隊', crest: { ...myCrest(prefs) }, seed: randomSeed(), contentId: draft.contentId };
    go('create');
  },
  kind: (el) => {
    draft.contentId = el.dataset.k as string;
    render();
  },
  'clear-save': () => {
    confirmThen('清掉存檔', '這份存檔讀不了（版本不符或項目不明），清掉之後標題畫面不會再提示。確定嗎？', '清掉', () => {
      ManageGame.clearBrokenSave();
      toast('已清掉讀不了的存檔');
    });
  },
  crest: (el) => {
    const k = el.dataset.k;
    if (k === 'shape') draft.crest.shape = Number(el.dataset.v);
    else if (k === 'emblem' && EMBLEM_NAMES.includes(el.dataset.v as EmblemName)) draft.crest.emblem = el.dataset.v as EmblemName;
    render();
  },
  scheme: (el) => {
    draft.crest.primary = el.dataset.p as string;
    draft.crest.secondary = el.dataset.s as string;
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
      startGame(ManageGame.create(draft.seed, draft.name.trim() || '天使戰隊', draft.contentId));
      toast(`${draft.name.trim() || '天使戰隊'} 成立了！`);
    };
    if (ManageGame.peek()) confirmThen('覆蓋存檔', '已經有一份進行中的存檔，創立新戰隊會把它覆蓋掉。確定嗎？', '覆蓋並創立', make);
    else make();
  },
  continue: () => {
    const g = ManageGame.load();
    if (!g) {
      toast(ManageGame.saveProblem() ?? '讀不到存檔', true);
      return;
    }
    startGame(g);
  },
  'new-season': () => {
    cine = null;
    showScene();
    actions['to-create'](document.body);
  },
  watch: (el) => openWatch(el.dataset.f as string),
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
cityTags.addEventListener('click', dispatch);
cityTags.addEventListener('mouseover', (e) => city.setHot((e.target as Element).closest<HTMLElement>('.tag')?.dataset.at ?? ''));
cityTags.addEventListener('mouseleave', () => city.setHot(''));
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
    case 'scrim.opponentId':
      ui.scrim.opponentId = raw;
      render();
      return;
    case 'scrim.games':
    case 'research.games': {
      const k = path === 'scrim.games' ? ui.scrim : ui.research;
      k.games = clampRuns(n);
      document.querySelectorAll(`[data-out="${path}"]`).forEach((x) => (x.textContent = String(k.games)));
      return;
    }
    case 'slip.stake': {
      if (!ui.slip || !game) return;
      ui.slip.stake = Math.min(n, maxStake());
      const ctx = context();
      const o = ctx.v.odds.find((x) => x.fixtureId === ui.slip?.fixtureId);
      const odds = o ? (ui.slip.side === 'home' ? o.homeX100 : o.awayX100) : 0;
      document.querySelectorAll('[data-out="slip.pay"]').forEach((x) => (x.textContent = wan(Math.floor(((ui.slip?.stake ?? 0) * 10 * odds) / 100))));
      return;
    }
  }
}

app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset?.field && t.type !== 'select-one') setField(t.dataset.field, t.value);
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
  } else if (t instanceof HTMLSelectElement && t.dataset.field) {
    setField(t.dataset.field, t.value);
  }
});

// 拖曳陣容的人到出賽位
app.addEventListener('dragstart', (e) => {
  const row = (e.target as Element).closest<HTMLElement>('[draggable="true"][data-pid]');
  if (!row || !e.dataTransfer) return;
  e.dataTransfer.setData('text/plain', row.dataset.pid as string);
  e.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
  document.body.classList.add('is-dragging');
});
app.addEventListener('dragend', () => {
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.dragging, .over').forEach((x) => x.classList.remove('dragging', 'over'));
});
app.addEventListener('dragover', (e) => {
  const slot = (e.target as Element).closest<HTMLElement>('[data-drop-slot]');
  if (!slot) return;
  e.preventDefault();
  slot.classList.add('over');
});
app.addEventListener('dragleave', (e) => (e.target as Element).closest('[data-drop-slot]')?.classList.remove('over'));
app.addEventListener('drop', (e) => {
  const slot = (e.target as Element).closest<HTMLElement>('[data-drop-slot]');
  const pid = e.dataTransfer?.getData('text/plain');
  if (!slot || !pid) return;
  e.preventDefault();
  document.body.classList.remove('is-dragging');
  assign(Number(slot.dataset.dropSlot), pid);
});

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof Element && e.target.closest('input, select, textarea');
  if (e.key === 'Escape' && modal) {
    modal = null;
    render();
  } else if (cine && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    if (cine.scenes[cine.i].auto) nextScene();
    else (cineEl.querySelector('[data-act="cine-next"]') as HTMLElement | null)?.click();
  } else if (!typing && screen === 'title' && e.key === 'Enter' && ManageGame.peek()) {
    actions.continue(document.body);
  }
});

/**
 * 展示模式（截圖、示範用）：?demo=種子&content=內容包 id（預設軍團戰暫代）&weeks=先推進幾週&to=畫面&match=1（再播一次比賽日）&scene=第幾幕&hold=1（停在那一幕）&broke=1。
 * 不讀也不寫 localStorage，不會覆蓋玩家的存檔。
 */
async function boot(): Promise<void> {
  const q = new URLSearchParams(location.search);
  if (!q.has('demo')) {
    render();
    return;
  }
  const g = ManageGame.demo(Number(q.get('demo')) || 1, '天使戰隊', q.get('content') ?? undefined);
  const v0 = g.view();
  const fa = v0.players.filter((p) => p.teamId === null).sort((a, b) => b.elo - a.elo)[0];
  if (fa) g.command({ type: 'sign', playerId: fa.id });
  const foe = v0.players.find((p) => p.teamId !== null && p.teamId !== v0.me.teamId);
  if (foe) g.command({ type: 'scout', playerId: foe.id });
  const fa2 = v0.players.filter((p) => p.teamId === null && p.id !== fa?.id)[0];
  if (fa2) g.command({ type: 'scout', playerId: fa2.id });
  g.command({ type: 'queueResearch', playerId: v0.me.roster[0], target: 'generic', games: 100 });
  const weeks = Number(q.get('weeks') ?? 0);
  for (let i = 0; i < weeks && (g.state.phase === 'offseason' || g.state.phase === 'season'); i++) await g.advance();
  if (q.has('broke')) (g.state.teams.find((t) => t.human) as { cash: number }).cash = -400;
  if (q.has('bet')) {
    const v = g.view();
    const o = v.odds[0];
    if (o) g.command({ type: 'bet', fixtureId: o.fixtureId, side: 'home', stake: 50 });
  }
  game = g;
  ui = newGameUi(newClubUi());
  screen = (q.get('to') as Screen | null) ?? 'hub';
  if (screen === 'player') ui.player = g.view().me.roster[0];
  if (screen === 'title' || screen === 'create') game = null;
  render();
  if (q.has('match')) {
    await doAdvance();
    const k = Math.min(Number(q.get('scene') ?? 0), (cine?.scenes.length ?? 1) - 1);
    if (cine && k > 0) {
      cine.i = k;
      showScene();
    }
    if (q.has('hold') || still) clearTimeout(cineTimer);
  }
}

void boot();
