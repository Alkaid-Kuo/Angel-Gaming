// CS 射擊可玩版（步驟 4）：開局畫面 → Worker 跑比賽（30 TPS）→ 主執行緒每個 rAF 畫最新的觀察資料（前後 tick 插值）。
// 主執行緒不持有引擎；玩家模式的畫面只來自觀察資料，觀戰模式才有全狀態。
// 經營層觀戰（web/shooter.html#watch）：讀正式版寫的觀戰票（watch.ts），請 Worker 用請求單重跑那一場；外框換天使金、結束時對照存檔成績單、可回經營。
// 觀戰的鏡頭、滑鼠、選手列表、回合時間軸在 spectate.ts；跳回合由 Worker 重跑（seek.ts）。
// 回放下載：比賽結束後向 Worker 要回放（ShooterReplay JSON），可用 npx tsx src/cli/main.ts shooter replay 檔名 核對雜湊。
// 兩隊等級：設定卡的兩個下拉 → setup.lineup；基準 Bot 第一次用到時在 Worker 裡編譯，等 meta 回來前顯示「載入基準 Bot…」。
import type { BuyItem, ShooterCommand } from '../../shooter/api.ts';
import { DEFAULT_MAP_ID, MAPS } from '../../shooter/map.ts';
import { BAKE_PX, bakeMap } from './bake.ts';
import type { CamMode, CamView } from './camera.ts';
import { hidesCursor } from './cursor.ts';
import { BuyMenu } from './buy.ts';
import { SPEEDS, ShooterHud, roundBanner } from './hud.ts';
import { ShooterInput } from './input.ts';
import type { BotLevel, FromShooterWorker, FullPlayer, Lineup, ShooterFrame, ShooterMeta, ShooterSetup, ShooterSummary, ToShooterWorker } from './protocol.ts';
import { DEFAULT_LEVEL } from './lineup.ts';
import type { ShooterReplay } from '../../shooter/runner.ts';
import { seesAll } from './hudinfo.ts';
import { BUY_CLOSED_NOTE, buyToggle } from './shop.ts';
import { SpectateUi } from './spectate.ts';
import { COACH_HASH, EMBED, WATCH_HASH, loadLiveSpeed, readCoachTicket, readTicket, saveLiveSpeed, tellManage, tellManageCoach, ticketVersionError, type CoachTicket, type WatchTicket } from './watch.ts';
import { CoachUi } from './coach-ui.ts';
import type { CoachStop } from '../../shooter/live-coach.ts';
import type { CoachEvent } from '../../manage/gateway.ts';
import type { CoachStatus } from './protocol.ts';
import { DAMAGE_MS, HURT_MS, ShooterRenderer, SOUND_MS, TRACER_MS, type ActiveSound, type Corpse, type DamagePop, type DrawInput, type HurtMark, type OtherTracer, type Tracer } from './render.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
/** 縮放倍率：短邊的一半是 24 格 ÷ 倍率；預設 1.2（1080p 時 27 px／格），滑鼠推到畫面邊緣剛好看到 30 格視野 */
const ZOOMS = [0.55, 0.7, 0.85, 1, 1.2, 1.45];
const ZOOM_PLAY = 4;
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let worker: Worker | null = null;
let game: Game | null = null;
/** 經營層觀戰的票（#watch 開啟時才有） */
let ticket: WatchTicket | null = null;
/** 教練身分即時看的票（M5 第四批 4b） */
let coachTicket: CoachTicket | null = null;

/** 下拉的選項（value：版本號；預設 v3，陪練 Bot 已拿掉） */
const LEVELS: readonly { readonly value: string; readonly name: string; readonly hint: string }[] = [
  { value: '1', name: '基準 v1', hint: '有指揮、喊話與輪轉，基準裡瞄準與反應最慢' },
  { value: '2', name: '基準 v2', hint: '屬性比角色基準低一級' },
  { value: '3', name: '基準 v3', hint: '角色基準屬性，中段選手' },
  { value: '4', name: '基準 v4', hint: '屬性比角色基準高一級' },
  { value: '5', name: '基準 v5', hint: '基準裡反應最快，經營層的頂級選手' },
];

function levelOf(value: string | null): BotLevel {
  const v = Number(value);
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? { kind: 'baseline', version: v } : DEFAULT_LEVEL;
}

function selectedLineup(): Lineup {
  return { team: levelOf($<HTMLSelectElement>('level-team').value), enemy: levelOf($<HTMLSelectElement>('level-enemy').value) };
}

/** 設定卡跟著選項：標題（觀戰時是 T 側／CT 側）、每個下拉的說明、種子旁那行 */
function syncLineupCard(): void {
  const spectate = $<HTMLInputElement>('spectate').checked;
  const [teamName, enemyName] = spectate ? ['T 側（0～4）', 'CT 側（5～9）'] : ['我方隊友', '對手'];
  const level = (id: string): (typeof LEVELS)[number] => LEVELS.find((l) => l.value === $<HTMLSelectElement>(id).value) ?? LEVELS[DEFAULT_LEVEL.version - 1];
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
  /** 觀戰介面（鏡頭、面板、滑鼠）；玩家模式沒有 */
  private readonly spec: SpectateUi | null;
  private readonly post: (m: ToShooterWorker) => void;
  private cur: ShooterFrame | null = null;
  private prev: ShooterFrame | null = null;
  private recvAt = 0;
  private sounds: ActiveSound[] = [];
  /** 所看選手的子彈與受傷（觀察資料有上一次決策以來的紀錄，依 tick 去重） */
  private tracers: Tracer[] = [];
  private hurts: HurtMark[] = [];
  private others: OtherTracer[] = [];
  /** 全狀態的所有子彈（全圖與自由鏡頭畫） */
  private allShots: OtherTracer[] = [];
  private pops: DamagePop[] = [];
  private lastOtherTick = -1;
  private lastShotTick = -1;
  private lastHurtTick = -1;
  private zoomIdx: number = ZOOM_PLAY;
  private speedIdx = 1;
  /** 觀戰：使用者開的透視（全圖一律看全部，見 seeAll）；經營層觀戰預設開，看的是整場比賽不是某個人 */
  private xray: boolean;
  /** 這回合看著倒下的敵人 */
  private corpses: Corpse[] = [];
  /** 每幀畫面毫秒（最近 60 幀平均，除錯掛勾讀）；frameMs 含面板更新 */
  private drawMs = 0;
  private frameMs = 0;
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
  /** 教練模式（M5 第四批 4b）：狀態列與教練面板 */
  private readonly coachUi: CoachUi | null;
  private coachStatus: CoachStatus | null = null;

  constructor(meta: ShooterMeta, post: (m: ToShooterWorker) => void) {
    this.meta = meta;
    this.post = post;
    this.xray = meta.watch !== undefined;
    this.root = $('game');
    this.root.innerHTML = `<canvas class="sg-canvas"></canvas><div class="sg-radar"><canvas class="sg-mini"></canvas><div class="rz"><b></b></div></div><div class="sg-buy hidden"></div>`;
    this.root.classList.remove('hidden');
    $('setup').classList.add('hidden');
    this.canvas = this.root.querySelector('.sg-canvas')!;
    this.mini = this.root.querySelector('.sg-mini')!;
    // 教練模式的渲染當觀戰：鏡頭不跟滑鼠偏、不畫準星與開鏡（視野仍由 teamFog 決定）
    const specLike = meta.spectate || meta.coach !== undefined;
    this.renderer = new ShooterRenderer(this.canvas, specLike ? { ...meta, spectate: true } : meta);
    // 別隊的比賽：外框不用金（金只給我方）
    this.root.classList.toggle('neutral', meta.watch !== undefined && meta.watch.mine === null);
    this.root.classList.toggle('spectate', specLike);
    this.hud = new ShooterHud(this.root, meta, ticket);
    this.buy = new BuyMenu(this.root.querySelector('.sg-buy')!, meta, (items: BuyItem[]) => this.send([{ type: 'buy', items }]));
    this.coachUi =
      meta.coach !== undefined
        ? new CoachUi(this.root, meta.coach, SPEEDS, this.speedIdx, {
            pause: (on) => this.post({ type: 'coachPause', on }),
            resolve: (plan, call) => this.post({ type: 'coachResolve', plan, call }),
            leave: () => this.post({ type: 'coachLeave' }),
            speed: (i) => this.setSpeed(i),
          })
        : null;
    this.root.classList.toggle('coach', meta.coach !== undefined);
    // 教練模式：同一套觀戰介面，選手資料從教練 frame 拼（己方＝觀察資料、對手＝計分板），只能跟隨己方
    const ownGroup: 0 | 1 = meta.groups[meta.playerId];
    this.spec = specLike
      ? new SpectateUi(this.root, this.canvas, this.mini, meta, this.hud, {
          view: (id) => this.post({ type: 'view', id }),
          seek: (round) => this.seek(round),
          frame: () => this.cur,
          ...(meta.coach !== undefined ? { players: () => this.coachPlayers(), followOnly: ownGroup } : {}),
        })
      : null;
    this.input = new ShooterInput(this.canvas, {
      // 教練模式的輸入當觀戰：不瞄準、不開火，空白鍵是教練暫停、← → 換跟隨的隊友
      meta: specLike ? { ...meta, spectate: true } : meta,
      self: () => this.cur?.self ?? null,
      camera: () => this.renderer.camera,
      send: (cmds) => this.send(cmds),
      throwCooling: () => this.cur !== null && this.cur.tick < this.throwCdUntil,
      buyOpen: () => this.buy.isOpen(),
      buyKey: (code) => this.buy.key(code),
      toggleBuy: () => {
        if (meta.spectate || meta.coach !== undefined) return;
        const act = buyToggle(this.buy.isOpen(), this.cur?.self.round.canBuy === true);
        if (act === 'deny') this.hud.cue(BUY_CLOSED_NOTE, performance.now());
        else this.buy.setOpen(act === 'open');
      },
      closeBuy: () => {
        if (this.spec?.helpOpen() === true) {
          this.spec.setHelp(false);
          return true;
        }
        if (!this.buy.isOpen()) return false;
        this.buy.setOpen(false);
        return true;
      },
      setBoard: (show) => {
        this.hud.setBoard(show);
        this.root.classList.toggle('board-on', show);
      },
      togglePause: () => this.togglePause(),
      cycleView: (step) => {
        this.spec?.cam.follow();
        this.post({ type: 'view', step });
      },
      zoom: (step) => {
        if (this.spec !== null) this.spec.zoomStep(step);
        else this.zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIdx + step));
      },
      toggleXray: () => this.toggleMap('xray'),
      toggleOverview: () => this.toggleMap('overview'),
      speed: (step) => this.setSpeed(this.speedIdx + step),
      skipRound: () => this.skipRound(),
      prevRound: () => this.prevRound(),
      toggleHelp: () => this.spec?.setHelp(!this.spec.helpOpen()),
      toggleFullscreen,
    });
    this.hud.ctl?.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b === null || b.disabled) return;
      const act = b.dataset.act;
      if (act === 'menu') this.hud.toggleMenu(b.dataset.m === 'speed' ? 'speed' : 'cam');
      else this.hud.closeMenu();
      if (act === 'pause') this.togglePause();
      else if (act === 'speed') this.setSpeed(Number(b.dataset.i));
      else if (act === 'skip') this.skipRound();
      else if (act === 'cam-follow') this.spec?.cam.follow();
      else if (act === 'cam-free') this.spec?.cam.free();
      else if (act === 'cam-map') this.spec?.cam.overview();
      else if (act === 'help') this.spec?.setHelp(!this.spec.helpOpen());
      else if (act === 'xray') this.toggleMap('xray');
      else if (act === 'fullscreen') toggleFullscreen();
      else if (act === 'quit') home();
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
      else if (act === 'review') this.hud.hideEnd();
      else if (act === 'replay') this.post({ type: 'getReplay' });
    });
    const liveSpeed = EMBED ? loadLiveSpeed() : null;
    if (liveSpeed !== null) this.setSpeed(liveSpeed);
    this.raf = requestAnimationFrame((t) => this.frame(t));
    // 切到別的分頁：玩家模式自動暫停（Worker 不會停，回來時不要已經被打死）
    document.addEventListener('visibilitychange', this.onHidden);
    // 不小心按到 Esc／被瀏覽器踢出全螢幕：玩家模式自動暫停
    document.addEventListener('fullscreenchange', this.onFullscreen);
    // 比賽中關分頁、重新整理、上一頁：瀏覽器先問一次
    window.addEventListener('beforeunload', this.onUnload);
    // 除錯掛勾（瀏覽器驗收用，開發模式或網址帶 ?debug）：只有主執行緒本來就有的畫面資料，沒有引擎
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__sg = { meta, frame: () => this.cur, camera: () => this.renderer.camera, fx: () => ({ tracers: this.tracers.length, pops: this.pops.map((p) => p.amount), others: this.others.length, allShots: this.allShots.length }), perf: () => ({ drawMs: this.drawMs, frameMs: this.frameMs, bakeMs: this.renderer.baked.ms, bakePx: BAKE_PX }), baked: () => this.renderer.baked, patch: (fn: ((f: ShooterFrame) => ShooterFrame) | null) => (this.patch = fn), bench: (n: number) => this.bench(n), stage: (v: Partial<DrawInput> | null) => (this.staged = v), hud: this.hud, spec: this.spec, buy: this.buy };
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

  /** 觀戰的全圖與透視開關；全圖一律看全部，透視在全圖時不作用。教練模式沒有透視（視野只有己方） */
  private toggleMap(which: 'xray' | 'overview'): void {
    const cam = this.spec?.cam;
    if (cam === undefined) return;
    if (which === 'overview') {
      if (cam.mode === 'overview') cam.follow();
      else cam.overview();
    } else if (cam.mode !== 'overview' && this.coachUi === null) this.xray = !this.xray;
  }

  /**
   * 教練模式的選手列表資料（UI 審核 #6）：只用教練 frame 已經有的東西，不另外向引擎要。
   * 己方：所看隊友（view.me）與其他隊友（view.teammates）的血量、金錢、武器、炸彈、下包／拆包；對手：計分板的存活、擊殺、死亡，位置不給（NaN，點不到）。
   */
  private coachPlayers(): readonly FullPlayer[] | null {
    const f = this.cur;
    if (f === null) return null;
    const own = this.meta.groups[this.meta.playerId];
    const me = f.view.me;
    const mine = new Map<number, FullPlayer>();
    mine.set(me.id, { id: me.id, team: me.team, alive: me.alive, x: me.x, y: me.y, facing: me.facing, hp: me.hp, weapon: me.weapon, hasBomb: me.hasBomb, blind: me.blindTicks > 0, scoped: me.scoped, firing: false, crouching: me.crouching, armor: me.loadout.armor, kit: me.loadout.kit, money: me.money, primary: me.loadout.primary, secondary: me.loadout.secondary, grenades: me.loadout.grenades, ammoMag: me.ammoMag, ammoReserve: me.ammoReserve, reloading: me.reloadTicksLeft > 0, plantTicks: me.plantTicks, defuseTicks: me.defuseTicks });
    for (const t of f.view.teammates) mine.set(t.id, { id: t.id, team: me.team, alive: t.alive, x: t.x, y: t.y, facing: t.facing, hp: t.hp, weapon: t.weapon, hasBomb: t.hasBomb, blind: t.blind, scoped: false, firing: t.firing, money: t.money, plantTicks: t.planting ? Infinity : 0, defuseTicks: t.defusing ? Infinity : 0 });
    return f.board.map((b) => (this.meta.groups[b.id] === own ? (mine.get(b.id) ?? { id: b.id, team: b.team, alive: b.alive, x: NaN, y: NaN, facing: 0, hp: 0, weapon: 'knife', hasBomb: false, blind: false, scoped: false, firing: false, money: b.money ?? 0 }) : { id: b.id, team: b.team, alive: b.alive, x: NaN, y: NaN, facing: 0, hp: 0, weapon: 'knife', hasBomb: false, blind: false, scoped: false, firing: false }));
  }

  private seeAll(): boolean {
    return this.spec !== null && seesAll(this.xray, this.spec.mode);
  }

  private togglePause(): void {
    if (this.over !== null) return;
    // 教練模式：暫停鍵是教練暫停（扣次數、停在下一回合前），不是把模擬停住；切走分頁時自動停住的模擬照常用這裡繼續
    if (this.coachUi !== null && !this.paused) {
      this.coachUi.togglePause();
      return;
    }
    this.paused = !this.paused;
    this.post({ type: 'pause', paused: this.paused });
    // 觀戰有控制列，暫停時不蓋選單（畫面要看得到）；玩家模式照舊開暫停選單
    this.hud.setPaused(this.paused && !this.meta.spectate);
    if (this.paused) this.input.releaseAll();
  }

  /** 觀戰速度（SPEEDS 的索引） */
  private setSpeed(i: number): void {
    if ((!this.meta.spectate && this.coachUi === null) || !Number.isFinite(i)) return;
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
    this.coachUi?.setSpeed(this.speedIdx);
    if (EMBED) saveLiveSpeed(this.speedIdx);
    this.post({ type: 'speed', speed: SPEEDS[this.speedIdx] });
  }

  /** 觀戰：跳到下一回合（Worker 同步推進，暫停中也可以） */
  private skipRound(): void {
    if (!this.meta.spectate || this.over !== null) return;
    this.post({ type: 'skipRound' });
  }

  /** 觀戰：回到第 round 回合開始（Worker 重跑，等它回 frame）；教練模式是即時打的，不能倒帶 */
  private seek(round: number): void {
    const spec = this.spec;
    if (spec === null || spec.busy || this.cur === null || this.coachUi !== null) return;
    spec.seeking(this.cur.view.round.number, round);
    this.post({ type: 'seek', round });
  }

  private prevRound(): void {
    if (this.cur !== null) this.seek(Math.max(1, this.cur.view.round.number - 1));
  }

  onSeeking(at: number, target: number): void {
    this.spec?.seeking(at, target);
  }

  /** 跳回合後第一個 frame 之前：tick 可能倒退，逐幀累積的都清掉 */
  private rewind(): void {
    this.cur = null;
    this.prev = null;
    this.corpses = [];
    this.sounds = [];
    this.tracers = [];
    this.hurts = [];
    this.others = [];
    this.allShots = [];
    this.pops = [];
    this.lastOtherTick = -1;
    this.lastShotTick = -1;
    this.lastHurtTick = -1;
    this.over = null;
    this.hud.reset();
    this.renderer.resetRound();
    this.spec?.seekDone();
  }

  private send(cmds: ShooterCommand[]): void {
    if (cmds.length > 0 && !this.meta.spectate && this.coachUi === null && this.over === null && !this.paused) this.post({ type: 'cmd', cmds });
  }

  onFrame(f: ShooterFrame): void {
    if (f.rewound === true) this.rewind();
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
    if (banner !== null) {
      this.hud.showBanner(banner, now);
      this.buy.setRound(banner);
    }
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
    // 購買選單：凍結時自動開一次；不能買了自動關（教練模式沒有購買）
    if (!this.meta.spectate && this.coachUi === null) {
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
    for (const s of f.full?.shots ?? []) this.allShots.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, friendly: false, t: now });
    this.allShots = this.allShots.filter((t) => now - t.t < TRACER_MS);
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

  onCoachStop(stop: CoachStop): void {
    this.coachUi?.showStop(stop);
    this.input.releaseAll();
  }

  onCoachStatus(s: CoachStatus): void {
    this.coachStatus = s;
    this.coachUi?.setStatus(s);
  }

  /** 教練模式中途離開（回經營頁、關框）：先告訴經營頁打到第幾回合（停著等指令＝上一回合），經營頁照離席處理 */
  coachQuit(): void {
    if (this.coachUi === null || this.coachStatus?.left === true || this.over !== null) return;
    const round = this.cur?.view.round.number ?? 1;
    tellManageCoach({ event: 'left', round: this.coachUi.waiting ? round - 1 : round });
  }

  onOver(summary: ShooterSummary): void {
    this.over = summary;
    this.buy.setOpen(false);
    this.input.releaseAll();
    if (EMBED) {
      // 留一下最後一回合的畫面，再回經營頁看結果
      setTimeout(() => tellManage('over'), 2500);
      return;
    }
    const myGroup = this.meta.groups[this.meta.playerId];
    this.hud.showEnd(summary, this.cur?.board ?? [], myGroup);
  }

  private lastInput(f: ShooterFrame): DrawInput {
    // 教練模式：透視永遠關（seeAll 在沒有全狀態時本來就不會成立，這裡再擋一層）
    return { cur: f, prev: this.prev, alpha: 1, mouse: this.input.mouse, zoom: ZOOMS[this.zoomIdx], xray: this.coachUi === null && this.seeAll(), teamFog: this.coachUi !== null, tags: this.spec?.mode === 'overview', camera: this.spec?.cam.view ?? null, pov: this.spec === null || this.spec.mode === 'follow', hover: this.spec?.hover ?? null, charge: null, sounds: this.sounds, now: 0, throwCd: 0, tracers: this.tracers, hurts: this.hurts, others: this.others, allShots: this.allShots, pops: this.pops, corpses: this.corpses };
  }

  private updateCursor(f: ShooterFrame): void {
    const aiming = hidesCursor({ spectate: this.meta.spectate || this.coachUi !== null, over: this.over !== null, paused: this.paused, buyOpen: this.buy.isOpen(), alive: f.self.me.alive, focused: document.hasFocus() });
    this.canvas.classList.toggle('aiming', aiming);
  }

  private frame(t: number): void {
    this.raf = requestAnimationFrame((x) => this.frame(x));
    const f = this.patch !== null && this.cur !== null ? this.patch(this.cur) : this.cur;
    if (f === null) return;
    this.updateCursor(f);
    const start = performance.now();
    const tickMs = 1000 / this.meta.rules.ticksPerSecond / (this.meta.spectate || this.coachUi !== null ? SPEEDS[this.speedIdx] : 1);
    const alpha = this.paused ? 1 : Math.min(1, (t - this.recvAt) / tickMs);
    const camera: CamView | null = this.spec?.update(f, this.prev, alpha, t, SPEEDS[this.speedIdx]) ?? null;
    this.input.update(t);
    const cdTicks = this.meta.rules.grenadeRules.throwCooldownTicks;
    const throwCd = f.tick < this.throwCdUntil ? (this.throwCdUntil - f.tick) / cdTicks : 0;
    const input = { ...this.lastInput(f), alpha, camera, charge: this.input.charge(t), now: t, throwCd, ...this.staged };
    const t0 = performance.now();
    this.renderer.draw(input);
    this.drawMs += (performance.now() - t0 - this.drawMs) / 60;
    this.renderer.drawMinimap(this.mini, input);
    const cam: CamMode = this.spec?.mode ?? 'follow';
    this.hud.update(f, t, { throwCdFrac: throwCd, grenade: this.input.grenade, bomb: this.input.bomb, speed: SPEEDS[this.speedIdx], xray: this.seeAll(), cam, buyOpen: this.buy.isOpen() });
    this.hud.updateCtl(SPEEDS[this.speedIdx], this.paused, this.over !== null, { xray: this.seeAll(), cam });
    this.frameMs += (performance.now() - start - this.frameMs) / 60;
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
    // 觀戰隨時可以離開（重播不會丟東西）；教練模式離開＝離席，經營頁照離席處理
    if (this.over !== null || this.meta.spectate || this.coachUi !== null) return;
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

/** 自己按 F11／選單離開全螢幕時不自動暫停 */
let leavingFullscreen = false;

/**
 * 全螢幕。對局要鎖鍵盤（Chrome 系）：Ctrl＋W 等組合鍵交給網頁，Ctrl 蹲著前進不會關分頁，代價是 Esc 要長按才離開全螢幕。
 * 觀戰不用打字移動，不鎖，Esc 直接離開。
 */
function enterFullscreen(lockKeys: boolean): void {
  if (document.fullscreenElement !== null) return;
  void document.documentElement
    .requestFullscreen()
    .then(() => (lockKeys ? (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.() : undefined))
    .catch(() => undefined);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement !== null) {
    leavingFullscreen = true;
    void document.exitFullscreen();
    return;
  }
  enterFullscreen(game?.meta.spectate !== true);
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
      case 'seeking':
        game?.onSeeking(msg.at, msg.target);
        break;
      case 'coachStop':
        game?.onCoachStop(msg.stop);
        break;
      case 'coachStatus':
        game?.onCoachStatus(msg.status);
        break;
      case 'coachCall':
        tellManageCoach({ event: 'call', call: msg.event satisfies CoachEvent });
        break;
      case 'coachLeft':
        tellManageCoach({ event: 'left', round: msg.round });
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

/** 設定卡背後的沙盤：預設地圖的 A 包點一帶（視窗不超出地圖）；烘焙結果留著，開局同一張圖不用再烘 */
function paintBackdrop(): void {
  const c = document.getElementById('backdrop') as HTMLCanvasElement | null;
  if (c === null) return;
  const map = MAPS[DEFAULT_MAP_ID]();
  const b = bakeMap(map);
  const a = map.sites.find((s) => s.id === 'A') ?? map.sites[0];
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const ppc = (Math.max(c.width / 1920, c.height / 1080) * 22) / BAKE_PX;
  const fit = (center: number, view: number, size: number): number => Math.max(0, Math.min(size * BAKE_PX - view, center * BAKE_PX - view / 2));
  const sx = fit((a.x0 + a.x1) / 2, c.width / ppc, map.width);
  const sy = fit((a.y0 + a.y1) / 2, c.height / ppc, map.height);
  g.drawImage(b.floor, sx, sy, c.width / ppc, c.height / ppc, 0, 0, c.width, c.height);
  g.drawImage(b.walls, sx, sy, c.width / ppc, c.height / ppc, 0, 0, c.width, c.height);
  c.classList.add('on');
}

/** 經營層觀戰：Worker 用請求單重跑那一場（基準 Bot 第一次觀戰時在 Worker 裡編譯，會停一下） */
function startWatch(t: WatchTicket): void {
  void fontsReady.then(() => setTimeout(paintBackdrop, 30));
  const stale = ticketVersionError(t);
  if (stale !== null) {
    if (EMBED) {
      tellManage('skip');
      return;
    }
    $('setup').innerHTML = `<section class="card sg-loading"><h2>無法觀戰</h2><p class="muted">${esc(stale)}</p><div class="row"><a class="primary" href="./game.html">回經營頁</a></div></section>`;
    return;
  }
  $('setup').innerHTML = `<section class="card sg-loading"><h2>比賽即將開始</h2><p class="muted">${esc(t.teams[0])} VS ${esc(t.teams[1])}・${esc(t.title)}</p></section>`;
  ensureWorker().postMessage({ type: 'watch', watch: { request: t.request, names: t.names, tags: t.tags, teams: t.teams, mine: t.mine, portraits: t.portraits } } satisfies ToShooterWorker);
}

/**
 * 回經營頁：由經營頁開的新分頁就關掉（原分頁的演出與畫面還在）；
 * 同分頁開的（新分頁被擋）回上一頁；直接開網址的導到 game.html。
 */
function backToManage(): void {
  if (EMBED) tellManage('skip');
  else if (window.opener !== null) {
    window.close();
    // 關不掉時（瀏覽器不允許）退回導頁
    setTimeout(() => {
      location.href = './game.html';
    }, 300);
  } else if (document.referrer.includes('/game.html') && history.length > 1) history.back();
  else location.href = './game.html';
}

function home(): void {
  if (ticket !== null || coachTicket !== null) {
    game?.coachQuit();
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

/** 教練身分即時看（M5 第四批 4b）：Worker 用開打前的請求單即時打，教練可以暫停下指令；畫面只有己方視野 */
function startCoach(t: CoachTicket): void {
  void fontsReady.then(() => setTimeout(paintBackdrop, 30));
  const stale = ticketVersionError({ ...t, outcome: { winner: 'draw', rounds: [] } });
  if (stale !== null) {
    if (EMBED) tellManage('skip');
    else $('setup').innerHTML = `<section class="card sg-loading"><h2>無法開始</h2><p class="muted">${esc(stale)}</p></section>`;
    return;
  }
  $('setup').innerHTML = `<section class="card sg-loading"><h2>比賽即將開始</h2><p class="muted">${esc(t.teams[0])} VS ${esc(t.teams[1])}・${esc(t.title)}・教練身分</p></section>`;
  ensureWorker().postMessage({ type: 'coach', coach: { request: t.request, names: t.names, tags: t.tags, teams: t.teams, mine: t.mine, portraits: t.portraits, coach: t.coach } } satisfies ToShooterWorker);
}

function init(): void {
  if (location.hash === COACH_HASH) {
    document.title = '天使戰隊 攻防戰 教練';
    coachTicket = readCoachTicket();
    if (coachTicket !== null) startCoach(coachTicket);
    else if (EMBED) tellManage('skip');
    else $('setup').innerHTML = '<section class="card"><h2>沒有進行中的比賽</h2><p class="muted">從經營頁比賽日選「以教練身分看」會在這裡開打。</p><div class="row"><a class="primary" href="./game.html">回經營頁</a></div></section>';
    return;
  }
  if (location.hash === WATCH_HASH) {
    document.title = '天使戰隊 攻防戰 觀戰';
    ticket = readTicket();
    if (ticket !== null) startWatch(ticket);
    else if (EMBED) tellManage('skip');
    else $('setup').innerHTML = '<section class="card"><h2>沒有要觀戰的比賽</h2><p class="muted">從經營頁（web/game.html）比賽日的結果畫面或聯賽頁點「觀戰」，會在這裡重播那一場。</p><div class="row"><a class="primary" href="./game.html">回經營頁</a><a href="./shooter.html">攻防戰試玩</a></div></section>';
    return;
  }
  for (const id of ['level-team', 'level-enemy']) {
    const sel = $<HTMLSelectElement>(id);
    sel.innerHTML = LEVELS.map((l) => `<option value="${l.value}">${l.name}</option>`).join('');
    sel.value = String(DEFAULT_LEVEL.version);
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
    if ($<HTMLInputElement>('fullscreen').checked) enterFullscreen(!$<HTMLInputElement>('spectate').checked);
    const team = (document.querySelector('input[name="team"]:checked') as HTMLInputElement | null)?.value === 'CT' ? 'CT' : 'T';
    const n = Number(seed.value);
    start({ team, seed: Number.isFinite(n) && n >= 0 ? Math.floor(n) : randomSeed(), spectate: $<HTMLInputElement>('spectate').checked, lineup: selectedLineup(), mapId: $<HTMLSelectElement>('map').value });
  });
  // 頁面先出來，沙盤下一拍才烘（約半秒）
  if (new URLSearchParams(location.search).get('auto') === null) void fontsReady.then(() => setTimeout(paintBackdrop, 30));
  // 除錯與自動驗收用：網址帶 ?auto=T|CT&seed=N 直接開局；&loadout=awp 讓雙方開局拿該武器（測狙擊鏡用）；&mate=3&foe=5 選基準版本（不帶＝v3）；&map=代號 換地圖
  const q = new URLSearchParams(location.search);
  const auto = q.get('auto');
  const loadout = q.get('loadout');
  const weapon = loadout === 'awp' || loadout === 'ak' || loadout === 'm4' || loadout === 'smg' || loadout === 'shotgun' ? loadout : undefined;
  if (auto === 'T' || auto === 'CT' || auto === 'spectate') start({ team: auto === 'CT' ? 'CT' : 'T', seed: Number(q.get('seed') ?? randomSeed()), spectate: auto === 'spectate', loadout: weapon, lineup: { team: levelOf(q.get('mate')), enemy: levelOf(q.get('foe')) }, mapId: q.get('map') ?? undefined });
}

init();
