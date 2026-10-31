// CS 射擊可玩版（步驟 4）：開局畫面 → Worker 跑比賽（30 TPS）→ 主執行緒每個 rAF 畫最新的觀察資料（前後 tick 插值）。
// 主執行緒不持有引擎；玩家模式的畫面只來自觀察資料，觀戰模式才有全狀態。
// 經營層觀戰（web/shooter.html#watch）：讀正式版寫的觀戰票（watch.ts），請 Worker 用請求單重跑那一場；外框換天使金、結束時對照存檔成績單、可回經營。
// 回放下載：比賽結束後向 Worker 要回放（ShooterReplay JSON），可用 npx tsx src/cli/main.ts shooter replay 檔名 核對雜湊。
// 兩隊等級：設定卡的兩個下拉 → setup.lineup；基準 Bot 第一次用到時在 Worker 裡編譯，等 meta 回來前顯示「載入基準 Bot…」。
import type { BuyItem, ShooterCommand } from '../../shooter/api.ts';
import { DEFAULT_MAP_ID, MAPS } from '../../shooter/map.ts';
import { BAKE_PX, bakeMap } from './bake.ts';
import { BuyMenu } from './buy.ts';
import { SPEEDS, ShooterHud, roundBanner } from './hud.ts';
import { ShooterInput } from './input.ts';
import type { BotLevel, FromShooterWorker, Lineup, ShooterFrame, ShooterMeta, ShooterSetup, ShooterSummary, ToShooterWorker } from './protocol.ts';
import type { ShooterReplay } from '../../shooter/runner.ts';
import { WATCH_HASH, readTicket, type WatchTicket } from './watch.ts';
import { DAMAGE_MS, HURT_MS, ShooterRenderer, SOUND_MS, TRACER_MS, type ActiveSound, type Corpse, type DamagePop, type DrawInput, type HurtMark, type OtherTracer, type Tracer } from './render.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
/** 縮放倍率：短邊的一半是 24 格 ÷ 倍率；預設 1.2（1080p 時 27 px／格），滑鼠推到畫面邊緣剛好看到 30 格視野 */
const ZOOMS = [0.55, 0.7, 0.85, 1, 1.2, 1.45];
const ZOOM_PLAY = 4;
const ZOOM_SPECTATE = 3;
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let worker: Worker | null = null;
let game: Game | null = null;
/** 經營層觀戰的票（#watch 開啟時才有） */
let ticket: WatchTicket | null = null;

/** 下拉的選項（value：practice 或版本號） */
const LEVELS: readonly { readonly value: string; readonly name: string; readonly hint: string }[] = [
  { value: 'practice', name: '陪練 v5', hint: '對照組：會買槍打包，但沒有指揮與輪轉；反應固定最短，對上基準 Bot 不算弱' },
  { value: '1', name: '基準 v1', hint: '有指揮、喊話與輪轉，基準裡瞄準與反應最慢' },
  { value: '2', name: '基準 v2', hint: '屬性比角色基準低一級' },
  { value: '3', name: '基準 v3', hint: '角色基準屬性，中段選手' },
  { value: '4', name: '基準 v4', hint: '屬性比角色基準高一級' },
  { value: '5', name: '基準 v5', hint: '基準裡反應最快，經營層的頂級選手' },
];

function levelOf(value: string | null): BotLevel {
  const v = Number(value);
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? { kind: 'baseline', version: v } : { kind: 'practice' };
}

function selectedLineup(): Lineup {
  return { team: levelOf($<HTMLSelectElement>('level-team').value), enemy: levelOf($<HTMLSelectElement>('level-enemy').value) };
}

/** 設定卡跟著選項：標題（觀戰時是 T 側／CT 側）、每個下拉的說明、種子旁那行 */
function syncLineupCard(): void {
  const spectate = $<HTMLInputElement>('spectate').checked;
  const [teamName, enemyName] = spectate ? ['T 側（0～4）', 'CT 側（5～9）'] : ['我方隊友', '對手'];
  const level = (id: string): (typeof LEVELS)[number] => LEVELS.find((l) => l.value === $<HTMLSelectElement>(id).value) ?? LEVELS[0];
  $('level-team-label').textContent = teamName;
  $('level-enemy-label').textContent = enemyName;
  $('level-team-hint').textContent = level('level-team').hint;
  $('level-enemy-hint').textContent = level('level-enemy').hint;
  $('lineup-note').textContent = `${teamName} ${level('level-team').name}、${enemyName} ${level('level-enemy').name}；同一個種子＋同樣的操作，結果一樣`;
}

/** 開始後等 Worker 回 meta：基準 Bot 第一次要編譯，不讓畫面看起來卡住，也不讓人重按 */
function setLoading(on: boolean): void {
  // 觀戰頁的設定卡已經換成載入訊息，沒有這兩個元素
  document.getElementById('start-status')?.classList.toggle('hidden', !on);
  const start = document.getElementById('start') as HTMLButtonElement | null;
  if (start !== null) start.disabled = on;
}

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
  private zoomIdx: number = ZOOM_PLAY;
  private speedIdx = 1;
  private xray = false;
  /** 觀戰：全圖鏡頭、戰術疊層 */
  private overview = false;
  private tactical = false;
  /** 這回合看著倒下的敵人 */
  private corpses: Corpse[] = [];
  /** 每幀畫面毫秒（最近 60 幀平均，除錯掛勾讀） */
  private drawMs = 0;
  private paused = false;
  private over: ShooterSummary | null = null;
  /** 本機投擲冷卻：從自己的道具數減少的那個 tick 起算（觀察資料推得出來，不讀引擎） */
  private throwCdUntil = -1;
  private raf = 0;
  /** 除錯：蓋掉畫面輸入（凍結時間、擺彈道，瀏覽器驗收用） */
  private staged: Partial<DrawInput> | null = null;
  /** 除錯：畫之前改一下 frame（瀏覽器驗收擺場景用，不影響 Worker） */
  private patch: ((f: ShooterFrame) => ShooterFrame) | null = null;
  /** 開過購買選單的回合（凍結時自動開一次） */
  private autoBuyRound = 0;

  constructor(meta: ShooterMeta, post: (m: ToShooterWorker) => void) {
    this.meta = meta;
    this.post = post;
    this.root = $('game');
    this.root.innerHTML = `<canvas class="sg-canvas"></canvas><div class="sg-radar"><canvas class="sg-mini"></canvas><div class="rz"><b></b><span>${esc(meta.map.name)}</span></div></div><div class="sg-buy hidden"></div>`;
    this.root.classList.remove('hidden');
    $('setup').classList.add('hidden');
    this.canvas = this.root.querySelector('.sg-canvas')!;
    this.mini = this.root.querySelector('.sg-mini')!;
    this.renderer = new ShooterRenderer(this.canvas, meta);
    // 別隊的比賽：外框不用金（金只給我方）
    this.root.classList.toggle('neutral', meta.watch !== undefined && meta.watch.mine === null);
    this.root.classList.toggle('spectate', meta.spectate);
    this.hud = new ShooterHud(this.root, meta, ticket);
    this.buy = new BuyMenu(this.root.querySelector('.sg-buy')!, meta, (items: BuyItem[]) => this.send([{ type: 'buy', items }]));
    this.zoomIdx = meta.spectate ? ZOOM_SPECTATE : ZOOM_PLAY;
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
      toggleXray: () => this.toggleMap('xray'),
      toggleOverview: () => this.toggleMap('overview'),
      toggleTactical: () => this.toggleMap('tactical'),
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
      else if (b.dataset.act === 'xray' || b.dataset.act === 'overview' || b.dataset.act === 'tactical') this.toggleMap(b.dataset.act);
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
        else start({ team: meta.spectate ? 'T' : meta.playerId < 5 ? 'T' : 'CT', seed: randomSeed(), spectate: meta.spectate, lineup: meta.lineup, mapId: meta.map.id });
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
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__sg = { meta, frame: () => this.cur, camera: () => this.renderer.camera, fx: () => ({ tracers: this.tracers.length, pops: this.pops.map((p) => p.amount), others: this.others.length }), perf: () => ({ drawMs: this.drawMs, bakeMs: this.renderer.baked.ms, bakePx: BAKE_PX }), baked: () => this.renderer.baked, patch: (fn: ((f: ShooterFrame) => ShooterFrame) | null) => (this.patch = fn), bench: (n: number) => this.bench(n), stage: (v: Partial<DrawInput> | null) => (this.staged = v), hud: this.hud };
  }

  /** 除錯：同步連畫 n 幀量每幀毫秒（最後讀一個像素，逼畫布把指令畫完）；分頁在背景時 rAF 不跑也量得到 */
  private bench(n: number): { frameMs: number; n: number } | null {
    const f = this.patch !== null && this.cur !== null ? this.patch(this.cur) : this.cur;
    if (f === null) return null;
    const input = { ...this.lastInput(f), prev: f, alpha: 1, ...this.staged };
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.renderer.draw({ ...input, now: (this.staged?.now ?? t0) + (this.staged?.now === undefined ? i * 16 : 0) });
    this.canvas.getContext('2d')?.getImageData(0, 0, 1, 1);
    return { frameMs: (performance.now() - t0) / n, n };
  }

  /** 觀戰的全圖開關：全圖鏡頭與戰術疊層都是看全狀態，開了就帶上透視 */
  private toggleMap(which: 'xray' | 'overview' | 'tactical'): void {
    if (!this.meta.spectate) return;
    this[which] = !this[which];
    if (which === 'xray' && !this.xray) {
      this.overview = false;
      this.tactical = false;
    } else if (which !== 'xray' && this[which]) this.xray = true;
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
    // 敵人倒下的位置：擊殺訊息公開，只有前一刻看得見的人才留屍體（看不見的人還是看不見）
    if (old !== null) {
      if (old.view.round.number !== f.view.round.number || old.viewId !== f.viewId) this.corpses = [];
      for (const k of f.feed) {
        const e = old.view.enemies.find((q) => q.id === k.victim);
        if (e !== undefined) this.corpses.push({ id: e.id, x: e.x, y: e.y });
      }
    }
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

  private lastInput(f: ShooterFrame): DrawInput {
    return { cur: f, prev: this.prev, alpha: 1, mouse: this.input.mouse, zoom: ZOOMS[this.zoomIdx], xray: this.xray, tactical: this.tactical, overview: this.overview, charge: null, sounds: this.sounds, now: 0, throwCd: 0, tracers: this.tracers, hurts: this.hurts, others: this.others, pops: this.pops, corpses: this.corpses };
  }

  private frame(t: number): void {
    this.raf = requestAnimationFrame((x) => this.frame(x));
    const f = this.patch !== null && this.cur !== null ? this.patch(this.cur) : this.cur;
    if (f === null) return;
    const tickMs = 1000 / this.meta.rules.ticksPerSecond / (this.meta.spectate ? SPEEDS[this.speedIdx] : 1);
    const alpha = this.paused ? 1 : Math.min(1, (t - this.recvAt) / tickMs);
    this.input.update(t);
    const cdTicks = this.meta.rules.grenadeRules.throwCooldownTicks;
    const throwCd = f.tick < this.throwCdUntil ? (this.throwCdUntil - f.tick) / cdTicks : 0;
    const input = { ...this.lastInput(f), alpha, charge: this.input.charge(t), now: t, throwCd, ...this.staged };
    const t0 = performance.now();
    this.renderer.draw(input);
    this.drawMs += (performance.now() - t0 - this.drawMs) / 60;
    this.renderer.drawMinimap(this.mini, input);
    this.hud.update(f, t, { throwCdFrac: throwCd, grenade: this.input.grenade, bomb: this.input.bomb, speed: SPEEDS[this.speedIdx], xray: this.xray });
    this.hud.updateCtl(SPEEDS[this.speedIdx], this.paused, this.over !== null, { xray: this.xray, overview: this.overview, tactical: this.tactical });
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
        setLoading(false);
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
        setLoading(false);
        console.error(msg.message);
        alert(`引擎錯誤：${msg.message}`);
        break;
    }
  };
  w.onerror = (e) => console.error('worker error', e.message);
  worker = w;
  return w;
}

/** 字型載入逾時就照用後備字型（烘焙要用到，不能卡住開局） */
const fontsReady: Promise<unknown> = Promise.race([Promise.all(['900 20px "Barlow Condensed"', 'italic 800 20px "Barlow Condensed"', '700 20px "Noto Sans TC"'].map((f) => document.fonts.load(f, '天使B7'))).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);

function start(s: ShooterSetup): void {
  if (s.lineup?.team.kind === 'baseline' || s.lineup?.enemy.kind === 'baseline') setLoading(true);
  void fontsReady.then(() => ensureWorker().postMessage({ type: 'start', setup: s } satisfies ToShooterWorker));
}

/** 設定卡背後的沙盤：預設地圖的 A 包點一帶；烘焙結果留著，開局同一張圖不用再烘 */
function paintBackdrop(): void {
  const c = document.getElementById('backdrop') as HTMLCanvasElement | null;
  if (c === null) return;
  const b = bakeMap(MAPS[DEFAULT_MAP_ID]());
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const ppc = (Math.max(c.width / 1920, c.height / 1080) * 22) / BAKE_PX;
  const sx = 66 * BAKE_PX - c.width / 2 / ppc;
  const sy = 32 * BAKE_PX - c.height / 2 / ppc;
  g.drawImage(b.floor, sx, sy, c.width / ppc, c.height / ppc, 0, 0, c.width, c.height);
  g.drawImage(b.walls, sx, sy, c.width / ppc, c.height / ppc, 0, 0, c.width, c.height);
  c.classList.add('on');
}

/** 經營層觀戰：Worker 用請求單重跑那一場（基準 Bot 第一次觀戰時在 Worker 裡編譯，會停一下） */
function startWatch(t: WatchTicket): void {
  void fontsReady.then(() => setTimeout(paintBackdrop, 30));
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
  paintBackdrop();
}

function init(): void {
  if (location.hash === WATCH_HASH) {
    document.title = '天使戰隊 攻防戰 觀戰';
    ticket = readTicket();
    if (ticket !== null) startWatch(ticket);
    else $('setup').innerHTML = '<section class="card"><h2>沒有要觀戰的比賽</h2><p class="muted">從經營頁（web/game.html）比賽日的結果畫面或聯賽頁點「觀戰」，會在這裡重播那一場。</p><div class="row"><a class="primary" href="./game.html">回經營頁</a><a href="./shooter.html">攻防戰試玩</a></div></section>';
    return;
  }
  for (const id of ['level-team', 'level-enemy']) {
    const sel = $<HTMLSelectElement>(id);
    sel.innerHTML = LEVELS.map((l) => `<option value="${l.value}">${l.name}</option>`).join('');
    sel.addEventListener('change', syncLineupCard);
  }
  $('spectate').addEventListener('change', syncLineupCard);
  syncLineupCard();
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
    start({ team, seed: Number.isFinite(n) && n >= 0 ? Math.floor(n) : randomSeed(), spectate: $<HTMLInputElement>('spectate').checked, lineup: selectedLineup(), mapId: $<HTMLSelectElement>('map').value });
  });
  // 頁面先出來，沙盤下一拍才烘（約半秒）
  if (new URLSearchParams(location.search).get('auto') === null) void fontsReady.then(() => setTimeout(paintBackdrop, 30));
  // 除錯與自動驗收用：網址帶 ?auto=T|CT&seed=N 直接開局；&loadout=awp 讓雙方開局拿該武器（測狙擊鏡用）；&mate=3&foe=5 選基準版本（不帶＝陪練）；&map=代號 換地圖
  const q = new URLSearchParams(location.search);
  const auto = q.get('auto');
  const loadout = q.get('loadout');
  const weapon = loadout === 'awp' || loadout === 'ak' || loadout === 'm4' || loadout === 'smg' || loadout === 'shotgun' ? loadout : undefined;
  if (auto === 'T' || auto === 'CT' || auto === 'spectate') start({ team: auto === 'CT' ? 'CT' : 'T', seed: Number(q.get('seed') ?? randomSeed()), spectate: auto === 'spectate', loadout: weapon, lineup: { team: levelOf(q.get('mate')), enemy: levelOf(q.get('foe')) }, mapId: q.get('map') ?? undefined });
}

init();
