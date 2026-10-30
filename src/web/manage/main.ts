// 經營頁入口：開始畫面、遊戲外框、事件處理。畫面內容在 screens.ts，遊戲狀態在 store.ts。
import type { Command } from '../../manage/index.ts';
import { esc, money, weekLabel } from './format.ts';
import { TABS, lineupOf, newUi, normalizeUi, offseasonReport, pmap, renderTab, seasonEnd, weekReport, type Ctx, type Tab, type Ui } from './screens.ts';
import { ManageGame } from './store.ts';

const root = document.getElementById('app')!;
let game: ManageGame | null = null;
let ui: Ui = newUi();
let busy = false;
let dialogs: string[] = [];

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);

function toast(msg: string, bad = false): void {
  const el = document.createElement('div');
  el.className = `mg-toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

function context(): Ctx {
  const g = game as ManageGame;
  const ctx: Ctx = { v: g.view(), c: g.content, ui };
  normalizeUi(ctx);
  return ctx;
}

// ───── 開始畫面 ─────
function renderStart(): void {
  const save = ManageGame.peek();
  root.innerHTML = `<div class="setup">
    <section class="hero">
      <h1>天使戰隊 經營<small>M4 原型</small></h1>
      <p>創立一間新創電競公司：簽選手、排訓練、賭運氣、扛薪水。這一版只有經營層——比賽結果是「假比賽」（依選手隱藏強度擲骰），經濟數值也都還在待審，目的是先玩玩看整個賽段的節奏。</p>
      <div class="row"><a class="muted small" href="./index.html">← 回首頁</a></div>
    </section>
    ${
      save
        ? `<section class="card"><h2>繼續</h2><p>${esc(save.teamName)}　${save.phase === 'ended' ? '賽段已結束' : save.phase === 'bankrupt' ? '已破產' : weekLabel(save.week)}　現金 ${money(save.cash)}</p>
      <div class="row"><button class="primary" data-act="continue">繼續上次的賽段</button><span class="muted small">進度會自動存在這個瀏覽器</span></div></section>`
        : ''
    }
    <section class="card"><h2>新賽段</h2>
      <div class="row"><label>戰隊名稱 <input id="team-name" type="text" maxlength="12" value="天使戰隊" class="mg-text"></label>
        <label>Seed <input id="seed" type="number" min="0" step="1" value="${randomSeed()}"></label>
        <button type="button" data-act="reroll">隨機</button></div>
      <div class="row"><button class="primary" data-act="start">開始新賽段</button>${save ? '<span class="warn small">會覆蓋目前的存檔</span>' : ''}</div>
      <p class="muted small">同一個 Seed、同一組操作，結果每次都一樣；讀檔重來不會改變比賽結果。</p></section>
    <section class="card"><h2>匯入存檔</h2><div class="row"><input id="import" type="file" accept=".json,application/json"><span class="muted small">匯入會覆蓋目前的存檔</span></div></section>
  </div>`;
}

// ───── 遊戲外框 ─────
function renderGame(): void {
  const ctx = context();
  const { v } = ctx;
  const over = v.phase === 'ended' || v.phase === 'bankrupt';
  const lowRunway = v.me.runwayWeeks !== null && v.me.runwayWeeks < 3;
  const label = busy ? '推進中…' : over ? (v.phase === 'bankrupt' ? '已破產' : '賽段結束') : v.phase === 'offseason' ? '結束休賽期 → 第 1 週' : `進行${weekLabel(v.week)}比賽日 →`;
  const dlg = dialogs[0];
  root.innerHTML = `<header class="mg-top">
      <div class="mg-brand"><b>${esc(v.me.name)}</b><span class="muted small">天使戰隊 經營</span></div>
      <div class="mg-pills">
        <span class="pill"><span class="muted">時間</span> <b>${weekLabel(v.week)}</b></span>
        <span class="pill"><span class="muted">現金</span> <b class="${v.me.cash < 0 ? 'bad' : ''}">${money(v.me.cash)}</b></span>
        <span class="pill ${lowRunway ? 'full' : ''}"><span class="muted">跑道</span> <b>${v.me.runwayWeeks === null ? '∞' : `${v.me.runwayWeeks} 週`}</b></span>
        <span class="pill"><span class="muted">名氣</span> <b>${v.me.fame}</b></span>
      </div>
      <div class="mg-top-act">
        <button class="primary" data-act="advance" ${busy || over ? 'disabled' : ''}>${label}</button>
        <button class="ghost" data-act="export" title="把存檔下載成檔案">匯出</button>
        <button class="ghost" data-act="menu" title="回到開始畫面">選單</button>
      </div>
    </header>
    ${game?.saveError ? `<div class="mg-warnbar">⚠ 無法存檔（${esc(game.saveError)}）：重新整理後進度會消失，請用「匯出」備份。</div>` : ''}
    <nav class="mg-tabs">${TABS.map((t) => `<button class="${t.id === ui.tab ? 'active' : ''}" data-act="tab" data-tab="${t.id}">${t.label}${t.id === 'inbox' && v.inbox.length ? `<i>${v.inbox.length}</i>` : ''}</button>`).join('')}</nav>
    <main class="mg-main">${renderTab(ctx)}</main>
    ${dlg ? `<div class="mg-overlay"><div class="mg-dialog">${dlg}</div></div>` : ''}`;
}

function render(): void {
  if (game) renderGame();
  else renderStart();
}

// ───── 操作 ─────
function run(cmd: Command, okMsg: string): void {
  if (!game) return;
  const r = game.command(cmd);
  toast(r.ok ? okMsg : r.reason, !r.ok);
  render();
}

async function doAdvance(): Promise<void> {
  if (!game || busy) return;
  busy = true;
  render();
  const wasOffseason = game.state.phase === 'offseason';
  try {
    const summary = await game.advance();
    ui.scheduleWeek = null;
    const ctx = context();
    if (wasOffseason) {
      if (ctx.v.inbox.some((m) => m.week === 0 && m.kind === 'report')) dialogs.push(offseasonReport(ctx));
      else toast('賽季開始：第 1 週');
    } else {
      dialogs.push(weekReport(ctx, summary));
      if (ctx.v.phase === 'ended' || ctx.v.phase === 'bankrupt') dialogs.push(seasonEnd(ctx));
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : '推進失敗', true);
  }
  busy = false;
  render();
}

function startNew(): void {
  const nameEl = document.getElementById('team-name') as HTMLInputElement;
  const seedEl = document.getElementById('seed') as HTMLInputElement;
  if (ManageGame.peek() && !confirm('會覆蓋目前的存檔，確定要開新賽段嗎？')) return;
  const seed = Number.isInteger(Number(seedEl.value)) && seedEl.value !== '' ? Number(seedEl.value) : randomSeed();
  game = ManageGame.create(seed, nameEl.value.trim() || '天使戰隊');
  ui = newUi();
  dialogs = [];
  render();
}

function slotChange(el: HTMLSelectElement): void {
  if (!game) return;
  const v = game.view();
  const ids = [...lineupOf(v, pmap(v)).ids];
  const i = Number(el.dataset.slot);
  const j = ids.indexOf(el.value);
  if (j >= 0 && j !== i) ids[j] = ids[i];
  ids[i] = el.value;
  run({ type: 'setLineup', lineup: ids }, '出賽名單已更新');
}

function setField(path: string, value: string): void {
  const [a, b] = path.split('.');
  const n = Math.max(1, Math.floor(Number(value)) || 1);
  if (a === 'scrim') {
    if (b === 'games') ui.scrim.games = n;
    else if (b === 'playerId') ui.scrim.playerId = value;
    else if (b === 'opponentId') ui.scrim.opponentId = value;
  } else if (a === 'research') {
    if (b === 'games') ui.research.games = n;
    else if (b === 'playerId') ui.research.playerId = value;
    else if (b === 'target') ui.research.target = value;
  } else if (a === 'stake') {
    ui.stake[b] = n;
  }
}

const actions: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  tab: (el) => {
    ui.tab = el.dataset.tab as Tab;
    render();
  },
  advance: () => doAdvance(),
  'close-dialog': () => {
    dialogs.shift();
    render();
  },
  'new-season': () => {
    dialogs = [];
    game = null;
    render();
  },
  sign: (el) => run({ type: 'sign', playerId: el.dataset.id as string }, '已簽約'),
  scout: (el) => run({ type: 'scout', playerId: el.dataset.id as string }, '球探已派出，推進一週後出報告'),
  upgrade: (el) => run({ type: 'upgradeVersion', playerId: el.dataset.id as string }, '開始升版培訓'),
  release: (el) => {
    const v = game?.view();
    const p = v?.players.find((x) => x.id === el.dataset.id);
    if (p && confirm(`確定要解約 ${p.name} 嗎？他會成為自由選手，已付的簽約金不退。`)) run({ type: 'release', playerId: p.id }, '已解約');
  },
  upfac: () => run({ type: 'upgradeTraining' }, '訓練中心升級了'),
  scrim: () => run({ type: 'queueScrim', opponentTeamId: game?.view().players.find((p) => p.id === ui.scrim.opponentId)?.teamId ?? '', games: ui.scrim.games }, '練習賽已排入，推進一週後出報告'),
  research: () => run({ type: 'queueResearch', playerId: ui.research.playerId, target: ui.research.target, games: ui.research.games }, '研發已排入，推進一週後出報告'),
  bet: (el) => run({ type: 'bet', fixtureId: el.dataset.fid as string, side: el.dataset.side as 'home' | 'away', stake: (ui.stake[el.dataset.fid as string] ?? 5) * 10 }, '已下注'),
  market: (el) => {
    ui.market = el.dataset.m as 'free' | 'others';
    render();
  },
  week: (el) => {
    ui.scheduleWeek = Number(el.dataset.week);
    render();
  },
  'ledger-all': () => {
    ui.ledgerAll = !ui.ledgerAll;
    render();
  },
  continue: () => {
    game = ManageGame.load();
    ui = newUi();
    dialogs = [];
    if (!game) toast('讀不到存檔', true);
    render();
  },
  start: () => startNew(),
  reroll: () => {
    (document.getElementById('seed') as HTMLInputElement).value = String(randomSeed());
  },
  menu: () => {
    game = null;
    render();
  },
  export: () => {
    if (!game) return;
    const blob = new Blob([game.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `angel-gaming-m4-w${game.state.week}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};

root.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  void actions[el.dataset.act as string]?.(el);
});

root.addEventListener('change', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLSelectElement && t.dataset.slot !== undefined) slotChange(t);
  else if (t instanceof HTMLInputElement && t.id === 'import' && t.files?.[0]) {
    const file = t.files[0];
    void file.text().then((text) => {
      if (ManageGame.peek() && !confirm('匯入會覆蓋目前的存檔，確定嗎？')) return;
      try {
        game = ManageGame.fromJson(text);
        ui = newUi();
        dialogs = [];
        render();
      } catch (err) {
        toast(err instanceof Error ? err.message : '存檔格式不對', true);
      }
    });
  } else if ((t instanceof HTMLSelectElement || t instanceof HTMLInputElement) && t.dataset.field) {
    setField(t.dataset.field, t.value);
  }
});

root.addEventListener('input', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.dataset.field) setField(t.dataset.field, t.value);
});

render();
