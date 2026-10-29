// CS 射擊可玩版（步驟 4）：開局畫面 → Worker 跑比賽（30 TPS）→ 主執行緒每個 rAF 畫最新的觀察資料（前後 tick 插值）。
// 主執行緒不持有引擎；玩家模式的畫面只來自觀察資料，觀戰模式才有全狀態。
import type { BuyItem, ShooterCommand } from '../../shooter/api.ts';
import { BuyMenu } from './buy.ts';
import { ShooterHud, roundBanner } from './hud.ts';
import { ShooterInput } from './input.ts';
import type { FromShooterWorker, ShooterFrame, ShooterMeta, ShooterSetup, ShooterSummary, ToShooterWorker } from './protocol.ts';
import { HURT_MS, ShooterRenderer, SOUND_MS, TRACER_MS, type ActiveSound, type HurtMark, type Tracer } from './render.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
/** 縮放倍率（1 = 剛好看得到 30 格視野距離） */
const ZOOMS = [0.55, 0.7, 0.85, 1, 1.2, 1.45];
const SPEEDS = [0.5, 1, 2, 4, 8];

let worker: Worker | null = null;
let game: Game | null = null;

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
    this.hud = new ShooterHud(this.root, meta);
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
      speed: (step) => {
        if (!meta.spectate) return;
        this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, this.speedIdx + step));
        this.post({ type: 'speed', speed: SPEEDS[this.speedIdx] });
      },
      toggleFullscreen,
    });
    this.hud.pause.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'resume') this.togglePause();
      else if (act === 'fullscreen') toggleFullscreen();
      else if (act === 'quit') home();
    });
    this.hud.end.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'again') start({ team: meta.spectate ? 'T' : meta.playerId < 5 ? 'T' : 'CT', seed: randomSeed(), spectate: meta.spectate });
      else if (act === 'home') home();
    });
    this.raf = requestAnimationFrame((t) => this.frame(t));
    // 切到別的分頁：玩家模式自動暫停（Worker 不會停，回來時不要已經被打死）
    document.addEventListener('visibilitychange', this.onHidden);
    // 除錯掛勾（瀏覽器驗收用，開發模式或網址帶 ?debug）：只有主執行緒本來就有的畫面資料，沒有引擎
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__sg = { meta, frame: () => this.cur, camera: () => this.renderer.camera };
  }

  private togglePause(): void {
    if (this.over !== null) return;
    this.paused = !this.paused;
    this.post({ type: 'pause', paused: this.paused });
    this.hud.setPaused(this.paused);
    if (this.paused) this.input.releaseAll();
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
    if (old !== null && old.view.round.ended === null && f.view.round.ended !== null) this.hud.rounds.push({ number: f.view.round.number, winner: f.view.round.ended.winner, reason: f.view.round.ended.reason });
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
    }
    // 子彈與受傷：觀察資料給的是上一次決策以來的紀錄，同一筆會出現在好幾個 frame，依 tick 去重
    for (const s of f.view.me.shots) if (s.tick > this.lastShotTick) this.tracers.push({ x: s.x, y: s.y, hit: s.hit, kill: s.kill, t: now });
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
    const input = { cur: f, prev: this.prev, alpha, mouse: this.input.mouse, zoom: ZOOMS[this.zoomIdx], xray: this.xray, charge: this.input.charge(t), sounds: this.sounds, now: t, throwCd, tracers: this.tracers, hurts: this.hurts };
    this.renderer.draw(input);
    this.renderer.drawMinimap(this.mini, input);
    this.hud.update(f, t, { throwCdFrac: throwCd, grenade: this.input.grenade, bomb: this.input.bomb, speed: SPEEDS[this.speedIdx], xray: this.xray });
  }

  private readonly onHidden = (): void => {
    if (document.hidden && !this.meta.spectate && !this.paused && this.over === null) {
      this.paused = true;
      this.post({ type: 'pause', paused: true });
      this.hud.setPaused(true);
      this.input.releaseAll();
    }
  };

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onHidden);
    cancelAnimationFrame(this.raf);
    this.input.dispose();
    this.root.innerHTML = '';
  }
}

/** 全螢幕＋鎖鍵盤（Chrome 系）：Ctrl＋W 等組合鍵交給網頁，Ctrl 蹲著前進不會關分頁 */
function toggleFullscreen(): void {
  if (document.fullscreenElement !== null) {
    void document.exitFullscreen();
    return;
  }
  void document.documentElement
    .requestFullscreen()
    .then(() => (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.())
    .catch(() => undefined);
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

function home(): void {
  worker?.postMessage({ type: 'stop' } satisfies ToShooterWorker);
  game?.dispose();
  game = null;
  $('game').classList.add('hidden');
  $('setup').classList.remove('hidden');
  $<HTMLInputElement>('seed').value = String(randomSeed());
}

function init(): void {
  const seed = $<HTMLInputElement>('seed');
  seed.value = String(randomSeed());
  $('reroll').addEventListener('click', () => {
    seed.value = String(randomSeed());
  });
  $('start').addEventListener('click', () => {
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
