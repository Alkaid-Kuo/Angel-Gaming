// CS 射擊可玩版（步驟 4）：開局畫面 → Worker 跑比賽（30 TPS）→ 主執行緒每個 rAF 畫最新的觀察資料（前後 tick 插值）。
// 主執行緒不持有引擎；玩家模式的畫面只來自觀察資料，觀戰模式才有全狀態。
// 經營層觀戰（web/shooter.html#watch）：讀正式版寫的觀戰票（watch.ts），請 Worker 用請求單重跑那一場；外框換天使金、結束時對照存檔成績單、可回經營。
// 回放下載：比賽結束後向 Worker 要回放（ShooterReplay JSON），可用 npx tsx src/cli/main.ts shooter replay 檔名 核對雜湊。
import type { BuyItem, ShooterCommand } from '../../shooter/api.ts';
import { BuyMenu } from './buy.ts';
import { SPEEDS, ShooterHud, roundBanner } from './hud.ts';
import { ShooterInput } from './input.ts';
import type { FromShooterWorker, ShooterFrame, ShooterMeta, ShooterSetup, ShooterSummary, ToShooterWorker } from './protocol.ts';
import type { ShooterReplay } from '../../shooter/runner.ts';
import { WATCH_HASH, readTicket, type WatchTicket } from './watch.ts';
import { DAMAGE_MS, HURT_MS, ShooterRenderer, SOUND_MS, TRACER_MS, type ActiveSound, type DamagePop, type HurtMark, type OtherTracer, type Tracer } from './render.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
/** 縮放倍率（1 = 剛好看得到 30 格視野距離） */
const ZOOMS = [0.55, 0.7, 0.85, 1, 1.2, 1.45];
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let worker: Worker | null = null;
let game: Game | null = null;
/** 經營層觀戰的票（#watch 開啟時才有） */
let ticket: WatchTicket | null = null;

class Game {
  readonly meta: ShooterMeta;
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly mini: HTMLCanvasElement;
  private readonly renderer: ShooterRenderer;
  private readonly hud: ShooterHud;
  private readonly buy: BuyMenu;
  private readonly input: ShooterInput;
  private readonly post: (m: ToShooterWorker) => void;
  private cur: ShooterFrame | null = null;
  private prev: ShooterFrame | null = null;
  private recvAt = 0;
  private sounds: ActiveSound[] = [];
  /** 所看選手的子彈與受傷（觀察資料有上一次決策以來的紀錄，依 tick 去重） */
  private tracers: Tracer[] = [];
  private hurts: HurtMark[] = [];
  private others: OtherTracer[] = [];
  private pops: DamagePop[] = [];
  private lastOtherTick = -1;
  private lastShotTick = -1;
  private lastHurtTick = -1;
  private zoomIdx = 3;
  private speedIdx = 1;
  private xray = false;
  private paused = false;
  private over: ShooterSummary | null = null;
  /** 本機投擲冷卻：從自己的道具數減少的那個 tick 起算（觀察資料推得出來，不讀引擎） */
  private throwCdUntil = -1;
  private raf = 0;
  /** 開過購買選單的回合（凍結時自動開一次） */
  private autoBuyRound = 0;

  constructor(meta: ShooterMeta, post: (m: ToShooterWorker) => void) {
    this.meta = meta;
    this.post = post;
    this.root = $('game');
    this.root.innerHTML = '<canvas class="sg-canvas"></canvas><canvas class="sg-mini"></canvas><div class="sg-buy hidden"></div>';
    this.root.classList.remove('hidden');
    $('setup').classList.add('hidden');
    this.canvas = this.root.querySelector('.sg-canvas')!;
    this.mini = this.root.querySelector('.sg-mini')!;
    this.renderer = new ShooterRenderer(this.canvas, meta);
    // 經營層觀戰：外框（頂列、計分板、結束畫面）換天使金
    this.root.classList.toggle('angel', meta.watch !== undefined);
    // 別隊的比賽：外框不用金（金只給我方）
    this.root.classList.toggle('neutral', meta.watch !== undefined && meta.watch.mine === null);
    this.hud = new ShooterHud(this.root, meta, ticket);
    this.buy = new BuyMenu(this.root.querySelector('.sg-buy')!, meta, (items: BuyItem[]) => this.send([{ type: 'buy', items }]));
    this.zoomIdx = meta.spectate ? 2 : 3;
    this.input = new ShooterInput(this.canvas, {
      meta,
      self: () => this.cur?.self ?? null,
      camera: () => this.renderer.camera,
      send: (cmds) => this.send(cmds),
      throwCooling: () => this.cur !== null && this.cur.tick < this.throwCdUntil,
      buyOpen: () => this.buy.isOpen(),
      buyKey: (code) => this.buy.key(code),
      toggleBuy: () => {
        if (!meta.spectate) this.buy.setOpen(!this.buy.isOpen());
      },
      closeBuy: () => {
        if (!this.buy.isOpen()) return false;
        this.buy.setOpen(false);
        return true;
      },
      setBoard: (show) => this.hud.setBoard(show),
      togglePause: () => this.togglePause(),
      cycleView: (step) => this.post({ type: 'view', step }),
      zoom: (step) => {
        this.zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIdx + step));
      },
      toggleXray: () => {
        // 全圖透視只在觀戰模式有
        if (meta.spectate) this.xray = !this.xray;
      },
      speed: (step) => this.setSpeed(this.speedIdx + step),
      skipRound: () => this.skipRound(),
      toggleFullscreen,
    });
    this.hud.ctl?.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b === null || b.disabled) return;
      if (b.dataset.act === 'pause') this.togglePause();
      else if (b.dataset.act === 'speed') this.setSpeed(Number(b.dataset.i));
      else if (b.dataset.act === 'skip') this.skipRound();
      else if (b.dataset.act === 'quit') home();
      // 按鈕不留焦點：空白鍵是暫停，不要再觸發一次按鈕
      b.blur();
    });
    this.hud.pause.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'resume') this.togglePause();
      else if (act === 'fullscreen') toggleFullscreen();
      else if (act === 'quit') home();
    });
    this.hud.end.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'again') {
        if (ticket !== null) startWatch(ticket);
        else start({ team: meta.spectate ? 'T' : meta.playerId < 5 ? 'T' : 'CT', seed: randomSeed(), spectate: meta.spectate });
      } else if (act === 'home') home();
      else if (act === 'replay') this.post({ type: 'getReplay' });
    });
    this.raf = requestAnimationFrame((t) => this.frame(t));
    // 切到別的分頁：玩家模式自動暫停（Worker 不會停，回來時不要已經被打死）
    document.addEventListener('visibilitychange', this.onHidden);
    // 不小心按到 Esc／被瀏覽器踢出全螢幕：玩家模式自動暫停
    document.addEventListener('fullscreenchange', this.onFullscreen);
    // 比賽中關分頁、重新整理、上一頁：瀏覽器先問一次
    window.addEventListener('beforeunload', this.onUnload);
    // 除錯掛勾（瀏覽器驗收用，開發模式或網址帶 ?debug）：只有主執行緒本來就有的畫面資料，沒有引擎
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__sg = { meta, frame: () => this.cur, camera: () => this.renderer.camera, fx: () => ({ tracers: this.tracers.length, pops: this.pops.map((p) => p.amount), others: this.others.length }) };
  }

  private togglePause(): void {
    if (this.over !== null) return;
    this.paused = !this.paused;
    this.post({ type: 'pause', paused: this.paused });
    // 觀戰有控制列，暫停時不蓋選單（畫面要看得到）；玩家模式照舊開暫停選單
    this.hud.setPaused(this.paused && !this.meta.spectate);
    if (this.paused) this.input.releaseAll();
  }

  /** 觀戰速度（SPEEDS 的索引） */
  private setSpeed(i: number): void {
    if (!this.meta.spectate || !Number.isFinite(i)) return;
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
    this.post({ type: 'speed', speed: SPEEDS[this.speedIdx] });
  }

  /** 觀戰：跳到下一回合（Worker 同步推進，暫停中也可以） */
  private skipRound(): void {
    if (!this.meta.spectate || this.over !== null) return;
    this.post({ type: 'skipRound' });
  }

  private send(cmds: ShooterCommand[]): void {
    if (cmds.length > 0 && !this.meta.spectate && this.over === null && !this.paused) this.post({ type: 'cmd', cmds });
  }

  onFrame(f: ShooterFrame): void {
    const now = performance.now();
    const old = this.cur;
    // 回合提示、回合紀錄
    const banner = roundBanner(old?.view ?? null, f.view, this.meta);
    if (banner !== null) this.hud.showBanner(banner, now);
    // 跳回合略過的回合先補上（它們的結束 frame 沒送過來）
    for (const r of f.skipped ?? []) this.hud.rounds.push(r);
    if (old !== null && old.view.round.ended === null && f.view.round.ended !== null) {
      const w = f.view.round.ended.winner;
      const row = f.board.find((b) => b.team === w);
      this.hud.rounds.push({ number: f.view.round.number, winner: w, reason: f.view.round.ended.reason, ...(row !== undefined ? { winnerGroup: this.meta.groups[row.id] } : {}) });
    }
    if (old !== null && old.self.round.number !== f.self.round.number) {
      this.throwCdUntil = -1;
      this.input.resync();
    }
    // 投擲冷卻：自己的道具在非凍結時間少了一顆＝剛丟出（回合交接時引擎會清掉，見上）
    if (old !== null && old.self.round.number === f.self.round.number && f.self.me.loadout.grenades.length < old.self.me.loadout.grenades.length && f.self.round.phase !== 'freeze') {
      this.throwCdUntil = f.tick + this.meta.rules.grenadeRules.throwCooldownTicks;
    }
    // 購買選單：凍結時自動開一次；不能買了自動關
    if (!this.meta.spectate) {
      if (f.self.round.canBuy && f.self.round.phase === 'freeze' && this.autoBuyRound !== f.self.round.number && f.self.me.alive) {
        this.autoBuyRound = f.self.round.number;
        this.buy.setOpen(true);
      }
      if (!f.self.round.canBuy && this.buy.isOpen()) this.buy.setOpen(false);
      this.buy.update(f.self);
    }
    // 聲音
    for (const ev of f.sounds) this.sounds.push({ ev, t: now });
    this.sounds = this.sounds.filter((s) => now - s.t < SOUND_MS);
    if (old !== null && old.viewId !== f.viewId) {
      this.sounds = [];
      this.tracers = [];
      this.hurts = [];
      this.others = [];
      this.pops = [];
    }
    for (const s of f.view.tracers) if (s.tick > this.lastOtherTick) this.others.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, friendly: s.friendly, t: now });
    this.lastOtherTick = Math.max(this.lastOtherTick, ...f.view.tracers.map((s) => s.tick));
    this.others = this.others.filter((t) => now - t.t < TRACER_MS);
    // 子彈與受傷：觀察資料給的是上一次決策以來的紀錄，同一筆會出現在好幾個 frame，依 tick 去重
    // 傷害數字：同一個 tick 的彈丸（霰彈）合成一個數字，畫在最後一顆打中的位置
    const dmgByTick = new Map<number, { x: number; y: number; amount: number; kill: boolean }>();
    for (const s of f.view.me.shots) {
      if (s.tick <= this.lastShotTick) continue;
      this.tracers.push({ x: s.x, y: s.y, hit: s.hit, kill: s.kill, t: now });
      if (s.damage <= 0) continue;
      const g = dmgByTick.get(s.tick);
      dmgByTick.set(s.tick, { x: s.x, y: s.y, amount: (g?.amount ?? 0) + s.damage, kill: (g?.kill ?? false) || s.kill });
    }
    for (const g of dmgByTick.values()) this.pops.push({ ...g, t: now });
    this.pops = this.pops.filter((p) => now - p.t < DAMAGE_MS);
    for (const h of f.view.me.hurt) if (h.tick > this.lastHurtTick) this.hurts.push({ dirDeg: h.dirDeg, t: now });
    this.lastShotTick = Math.max(this.lastShotTick, ...f.view.me.shots.map((s) => s.tick));
    this.lastHurtTick = Math.max(this.lastHurtTick, ...f.view.me.hurt.map((h) => h.tick));
    this.tracers = this.tracers.filter((t) => now - t.t < Math.max(TRACER_MS, 600));
    this.hurts = this.hurts.filter((h) => now - h.t < HURT_MS);
    this.hud.addFeed(f.feed, now);
    // 插值：同一個 tick 的重送（暫停、切換視角）不推進
    if (old === null || f.tick !== old.tick) {
      this.prev = old;
      this.recvAt = now;
    }
    this.cur = f;
  }

  onOver(summary: ShooterSummary): void {
    this.over = summary;
    this.buy.setOpen(false);
    this.input.releaseAll();
    const myGroup = this.meta.groups[this.meta.playerId];
    this.hud.showEnd(summary, this.cur?.board ?? [], myGroup);
  }

  private frame(t: number): void {
    this.raf = requestAnimationFrame((x) => this.frame(x));
    const f = this.cur;
    if (f === null) return;
    const tickMs = 1000 / this.meta.rules.ticksPerSecond / (this.meta.spectate ? SPEEDS[this.speedIdx] : 1);
    const alpha = this.paused ? 1 : Math.min(1, (t - this.recvAt) / tickMs);
    this.input.update(t);
    const cdTicks = this.meta.rules.grenadeRules.throwCooldownTicks;
    const throwCd = f.tick < this.throwCdUntil ? (this.throwCdUntil - f.tick) / cdTicks : 0;
    const input = { cur: f, prev: this.prev, alpha, mouse: this.input.mouse, zoom: ZOOMS[this.zoomIdx], xray: this.xray, charge: this.input.charge(t), sounds: this.sounds, now: t, throwCd, tracers: this.tracers, hurts: this.hurts, others: this.others, pops: this.pops };
    this.renderer.draw(input);
    this.renderer.drawMinimap(this.mini, input);
    this.hud.update(f, t, { throwCdFrac: throwCd, grenade: this.input.grenade, bomb: this.input.bomb, speed: SPEEDS[this.speedIdx], xray: this.xray });
    this.hud.updateCtl(SPEEDS[this.speedIdx], this.paused, this.over !== null);
  }

  /** Worker 送來的回放 → 下載 JSON */
  saveReplay(replay: ShooterReplay): void {
    const name = ticket !== null ? `angel-watch-${replay.header.seed}.json` : `shooter-replay-${replay.header.seed}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(replay)], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private readonly onHidden = (): void => {
    if (document.hidden && !this.meta.spectate && !this.paused && this.over === null) {
      this.paused = true;
      this.post({ type: 'pause', paused: true });
      this.hud.setPaused(true);
      this.input.releaseAll();
    }
  };

  private readonly onFullscreen = (): void => {
    if (document.fullscreenElement === null && !leavingFullscreen && !this.meta.spectate && !this.paused && this.over === null) this.togglePause();
    leavingFullscreen = false;
  };

  private readonly onUnload = (e: BeforeUnloadEvent): void => {
    // 觀戰隨時可以離開（重播不會丟東西）
    if (this.over !== null || this.meta.spectate) return;
    e.preventDefault();
    e.returnValue = '';
  };

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onHidden);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    window.removeEventListener('beforeunload', this.onUnload);
    cancelAnimationFrame(this.raf);
    this.input.dispose();
    this.root.innerHTML = '';
  }
}

/** 自己按 F／選單離開全螢幕時不自動暫停 */
let leavingFullscreen = false;

/** 全螢幕＋鎖鍵盤（Chrome 系）：Ctrl＋W 等組合鍵交給網頁，Ctrl 蹲著前進不會關分頁 */
function enterFullscreen(): void {
  if (document.fullscreenElement !== null) return;
  void document.documentElement
    .requestFullscreen()
    .then(() => (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.())
    .catch(() => undefined);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement !== null) {
    leavingFullscreen = true;
    void document.exitFullscreen();
    return;
  }
  enterFullscreen();
}

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<FromShooterWorker>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'meta':
        game?.dispose();
        game = new Game(msg.meta, (m) => w.postMessage(m));
        break;
      case 'frame':
        game?.onFrame(msg.frame);
        break;
      case 'over':
        game?.onOver(msg.summary);
        break;
      case 'replay':
        game?.saveReplay(msg.replay);
        break;
      case 'error':
        console.error(msg.message);
        alert(`引擎錯誤：${msg.message}`);
        break;
    }
  };
  w.onerror = (e) => console.error('worker error', e.message);
  worker = w;
  return w;
}

function start(s: ShooterSetup): void {
  ensureWorker().postMessage({ type: 'start', setup: s } satisfies ToShooterWorker);
}

/** 經營層觀戰：Worker 用請求單重跑那一場（基準 Bot 第一次觀戰時在 Worker 裡編譯，會停一下） */
function startWatch(t: WatchTicket): void {
  $('setup').innerHTML = `<section class="card sg-loading"><h2>準備觀戰</h2><p class="muted">${esc(t.teams[0])} VS ${esc(t.teams[1])}・${esc(t.title)}：載入基準 Bot、用存檔的請求單重跑這一場…</p></section>`;
  ensureWorker().postMessage({ type: 'watch', watch: { request: t.request, names: t.names, tags: t.tags, teams: t.teams, mine: t.mine } } satisfies ToShooterWorker);
}

/**
 * 回經營頁：由經營頁開的新分頁就關掉（原分頁的演出與畫面還在）；
 * 同分頁開的（新分頁被擋）回上一頁；直接開網址的導到 game.html。
 */
function backToManage(): void {
  if (window.opener !== null) {
    window.close();
    // 關不掉時（瀏覽器不允許）退回導頁
    setTimeout(() => {
      location.href = './game.html';
    }, 300);
  } else if (document.referrer.includes('/game.html') && history.length > 1) history.back();
  else location.href = './game.html';
}

function home(): void {
  if (ticket !== null) {
    backToManage();
    return;
  }
  worker?.postMessage({ type: 'stop' } satisfies ToShooterWorker);
  game?.dispose();
  game = null;
  $('game').classList.add('hidden');
  $('setup').classList.remove('hidden');
  $<HTMLInputElement>('seed').value = String(randomSeed());
}

function init(): void {
  if (location.hash === WATCH_HASH) {
    document.title = '天使戰隊 攻防戰 觀戰';
    ticket = readTicket();
    if (ticket !== null) startWatch(ticket);
    else $('setup').innerHTML = '<section class="card"><h2>沒有要觀戰的比賽</h2><p class="muted">從經營頁（web/game.html）比賽日的結果畫面或聯賽頁點「觀戰」，會在這裡重播那一場。</p><div class="row"><a class="primary" href="./game.html">回經營頁</a><a href="./shooter.html">攻防戰試玩</a></div></section>';
    return;
  }
  const seed = $<HTMLInputElement>('seed');
  seed.value = String(randomSeed());
  $('reroll').addEventListener('click', () => {
    seed.value = String(randomSeed());
  });
  $('start').addEventListener('click', () => {
    // 開始是使用者點擊，可以直接進全螢幕並鎖鍵盤（Ctrl＋W 不會關分頁）
    if ($<HTMLInputElement>('fullscreen').checked) enterFullscreen();
    const team = (document.querySelector('input[name="team"]:checked') as HTMLInputElement | null)?.value === 'CT' ? 'CT' : 'T';
    const n = Number(seed.value);
    start({ team, seed: Number.isFinite(n) && n >= 0 ? Math.floor(n) : randomSeed(), spectate: $<HTMLInputElement>('spectate').checked });
  });
  // 除錯與自動驗收用：網址帶 ?auto=T|CT&seed=N 直接開局；&loadout=awp 讓雙方開局拿該武器（測狙擊鏡用）
  const q = new URLSearchParams(location.search);
  const auto = q.get('auto');
  const loadout = q.get('loadout');
  const weapon = loadout === 'awp' || loadout === 'ak' || loadout === 'm4' || loadout === 'smg' || loadout === 'shotgun' ? loadout : undefined;
  if (auto === 'T' || auto === 'CT' || auto === 'spectate') start({ team: auto === 'CT' ? 'CT' : 'T', seed: Number(q.get('seed') ?? randomSeed()), spectate: auto === 'spectate', loadout: weapon });
}

init();
