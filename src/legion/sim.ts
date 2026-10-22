// 軍團戰模擬核心（確定性、全整數）。
// 每 tick：軍團決策 → 隊形位置 → 士兵移動 → 戰鬥（近戰、衝鋒撞擊、弓兵齊射、箭矢落地）→ 傷亡整理（補位、潰散、老兵）→ 視野 → 旗點 → 勝負。
import { Hasher } from '../shared/hash.ts';
import { idiv, isqrt, tdiv } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import type { EnemyRegiment, FlagState, LegionCommand, LegionEvent, LegionInitData, LegionObservation, OwnRegiment, RegimentStatus } from './api.ts';
import { IMPACT_VERSUS, RULES, T, TILE, UNIT_KINDS, UNITS, VERSUS, terrainSpeed, walkable, type LegionMode, type UnitDef, type UnitKind } from './config.ts';
import { angleDiff, iatan2, icos, isin, normDeg, offset, stepToward, turnToward } from './geom.ts';
import { MAPS, tileCoord, type LegionMap } from './map.ts';
import { clearLine, findPath, snapPoint } from './path.ts';

export type OrderType = 'idle' | 'move' | 'attackMove' | 'attack' | 'hold';
export type Flank = 'front' | 'side' | 'rear';

/** 架陣狀態：0 無、1 架陣中、2 已架陣、3 收陣中 */
export type BraceState = 0 | 1 | 2 | 3;

export interface Soldier {
  readonly id: number;
  readonly reg: number;
  readonly owner: number;
  /** 在己方士兵中的序號（錯開週期性檢查用；雙方對稱） */
  readonly k: number;
  x: number;
  y: number;
  hp: number;
  cd: number;
  /** 近戰目標（士兵 id）；-1 無 */
  target: number;
  nextRetarget: number;
  alive: boolean;
  /** 隊形中的序號（0 = 第一排最左） */
  ord: number;
  /** 本 tick 的隊形位置 */
  sx: number;
  sy: number;
  /** 本次衝鋒已撞擊 */
  impacted: boolean;
  /** 直線前往隊形位置被地形擋住 */
  blocked: boolean;
}

export interface Regiment {
  readonly id: number;
  readonly owner: number;
  /** 在己方軍團中的序號 */
  readonly k: number;
  readonly kind: UnitKind;
  readonly def: UnitDef;
  readonly men0: number;
  x: number;
  y: number;
  facing: number;
  /** tick 開始時的位置與朝向：軍團決策讀取其他軍團時一律用這組，處理順序不影響結果 */
  px: number;
  py: number;
  pf: number;
  width: number;
  /** 依地形自動縮窄後的實際橫寬 */
  effWidth: number;
  /** 依序號排列的士兵 id */
  slots: number[];
  order: OrderType;
  tx: number;
  ty: number;
  /** 抵達後的朝向；-1 不指定 */
  tFacing: number;
  /** 攻擊目標（軍團 id）；-1 無 */
  target: number;
  lastSeenX: number;
  lastSeenY: number;
  path: [number, number][];
  pathIdx: number;
  pathGoalX: number;
  pathGoalY: number;
  repathAt: number;
  brace: BraceState;
  braceTimer: number;
  /** 收陣後要執行的指令 */
  pending: LegionCommand | null;
  charging: boolean;
  chargeTravel: number;
  chargeSpeedCur: number;
  chargeTarget: number;
  /** 撞擊視窗結束的 tick；-1 尚未撞擊 */
  impactUntil: number;
  chargeHitReg: number;
  chargeKills: number;
  chargeBraced: boolean;
  chargeFlank: Flank;
  needDisengage: boolean;
  routed: boolean;
  destroyed: boolean;
  level: number;
  dmgDealt: number;
  /** 被看見到這個 tick 為止（隱蔽中的軍團主動攻擊後） */
  revealedUntil: number;
  /** 敵方從這個 tick 起連續看得到它；-1 = 目前沒被看見 */
  spottedSince: number;
  /** 最後一次在樹林中隱蔽（敵方看不到）的 tick */
  lastHidden: number;
  lastMelee: number;
  lastHit: number;
  /** 弓兵的射擊目標（軍團 id） */
  fireTarget: number;
  /** 設定目前射擊目標的 tick、最後一次放箭的 tick */
  fireSince: number;
  lastShot: number;
  moved: boolean;
  nearEnemy: boolean;
  /** 士兵與隊形位置的平均距離（上一 tick） */
  lag: number;
  halfW: number;
  halfD: number;
  rad: number;
  kills: number;
  escaped: number;
}

export interface Projectile {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly t0: number;
  readonly t1: number;
  /** 命中的士兵 id；-1 落空 */
  readonly target: number;
  readonly dmg: number;
  readonly reg: number;
  readonly owner: number;
}

export interface FlagRuntime {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  owner: number;
  value: number;
  capturer: number;
}

export interface PlayerState {
  readonly id: number;
  readonly cost: number;
  domination: number;
  active: boolean;
  kills: number;
  losses: number;
}

export interface LegionResult {
  /** null = 平手 */
  readonly winner: number | null;
  readonly reason: 'annihilation' | 'domination' | 'time';
  readonly durationTicks: number;
  /** 剩餘兵力（點數 × 剩餘人數比例） */
  readonly strength: readonly number[];
  readonly flagsHeld: readonly number[];
}

export interface LegionSetup {
  readonly seed: number;
  readonly mode: LegionMode;
  readonly mapId?: string;
  /** 依 playerId：選手 deploy() 的原始回傳 */
  readonly deployments: readonly unknown[];
  readonly timeLimitTicks?: number;
}

const FLANK_PCT: Readonly<Record<Flank, number>> = { front: 100, side: RULES.flank.side, rear: RULES.flank.rear };

/** 士兵空間索引：1 格一個桶 */
class Grid {
  readonly w: number;
  readonly h: number;
  readonly head: Int32Array;
  next: Int32Array;
  private touched: Int32Array;
  private nTouched = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.head = new Int32Array(w * h).fill(-1);
    this.next = new Int32Array(0);
    this.touched = new Int32Array(w * h);
  }

  cell(x: number, y: number): number {
    let cx = tileCoord(x, this.w);
    let cy = tileCoord(y, this.h);
    if (cx < 0) cx = 0;
    else if (cx >= this.w) cx = this.w - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.h) cy = this.h - 1;
    return cy * this.w + cx;
  }

  build(soldiers: readonly Soldier[]): void {
    for (let k = 0; k < this.nTouched; k++) this.head[this.touched[k]] = -1;
    this.nTouched = 0;
    if (this.next.length < soldiers.length) this.next = new Int32Array(soldiers.length);
    for (const s of soldiers) {
      if (!s.alive) continue;
      const c = this.cell(s.x, s.y);
      if (this.head[c] === -1) this.touched[this.nTouched++] = c;
      this.next[s.id] = this.head[c];
      this.head[c] = s.id;
    }
  }
}

export class LegionMatch {
  readonly map: LegionMap;
  readonly mode: LegionMode;
  readonly seed: number;
  readonly timeLimitTicks: number;
  tick = 0;
  readonly rng: Prng;
  readonly soldiers: Soldier[] = [];
  readonly regiments: Regiment[] = [];
  readonly players: PlayerState[] = [];
  readonly flags: FlagRuntime[] = [];
  projectiles: Projectile[] = [];
  /** visible[p][regId]：p 看得到該軍團 */
  readonly visible: Uint8Array[] = [];
  /** 本 tick 的事件（全部） */
  events: LegionEvent[] = [];
  /** 依 playerId：自上次觀察後累積的事件 */
  private inbox: LegionEvent[][] = [];
  /** 事件監聽（觀戰解說用） */
  eventTap: ((ev: LegionEvent) => void) | null = null;
  over = false;
  private resultValue: LegionResult | null = null;
  private readonly grid: Grid;
  private flankMemo = new Map<number, Flank>();
  /** 士兵移動的緩衝區 */
  private nx = new Int32Array(0);
  private ny = new Int32Array(0);
  /** 本 tick 的傷害佇列：[士兵 id, 傷害, 攻擊方軍團 id, 擊退 x, 擊退 y] */
  private hits: number[] = [];
  /** 近戰接觸事件：軍團對 → 上次發出的 tick */
  private contactAt = new Map<number, number>();

  constructor(setup: LegionSetup) {
    const mapFactory = MAPS[setup.mapId ?? 'river-valley'];
    if (mapFactory === undefined) throw new Error(`沒有地圖 ${setup.mapId}`);
    this.map = mapFactory();
    this.mode = setup.mode;
    this.seed = setup.seed;
    this.timeLimitTicks = setup.timeLimitTicks ?? RULES.timeLimitTicks;
    this.rng = Prng.fromInts(setup.seed, 0x1e9);
    this.grid = new Grid(this.map.width, this.map.height);
    const n = setup.deployments.length;
    for (let p = 0; p < n; p++) this.inbox.push([]);
    for (let p = 0; p < n; p++) {
      const cost = this.deploy(p, setup.deployments[p]);
      this.players.push({ id: p, cost, domination: 0, active: true, kills: 0, losses: 0 });
    }
    for (let p = 0; p < n; p++) this.visible.push(new Uint8Array(this.regiments.length));
    if (this.mode === 'capture') this.map.flags.forEach((f, i) => this.flags.push({ id: i, name: f.name, x: f.x, y: f.y, owner: -1, value: 0, capturer: -1 }));
    for (const r of this.regiments) this.layout(r, true);
    this.computeVision();
    this.checkVictory();
  }

  // ───────── 布陣 ─────────

  private deploy(p: number, raw: unknown): number {
    const reject = (index: number, reason: string): void => {
      this.emit({ type: 'deployRejected', tick: 0, player: p, index, reason });
    };
    if (!Array.isArray(raw)) {
      reject(-1, 'deploy() 必須回傳陣列');
      return 0;
    }
    const zone = this.map.deploy[p];
    const base = this.soldiers.length;
    const regBase = this.regiments.length;
    let spent = 0;
    const placed: Regiment[] = [];
    raw.forEach((d: unknown, i) => {
      if (typeof d !== 'object' || d === null) return reject(i, '不是物件');
      const o = d as Record<string, unknown>;
      const kind = o.type as UnitKind;
      if (!UNIT_KINDS.includes(kind)) return reject(i, `沒有兵種 ${String(o.type)}`);
      const def = UNITS[kind];
      if (spent + def.cost > RULES.budget) return reject(i, `點數超過 ${RULES.budget}`);
      if (typeof o.x !== 'number' || typeof o.y !== 'number' || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return reject(i, '座標不合法');
      const x = Math.round(o.x);
      const y = Math.round(o.y);
      const tx = tileCoord(x, this.map.width);
      const ty = tileCoord(y, this.map.height);
      if (tx < zone.x0 || tx >= zone.x1 || ty < zone.y0 || ty >= zone.y1) return reject(i, '不在布陣區內');
      if (!walkable(this.map.terrain[ty * this.map.width + tx])) return reject(i, '位置不可通行');
      const width = typeof o.width === 'number' && Number.isFinite(o.width) ? Math.max(1, Math.min(def.men, Math.round(o.width))) : def.width;
      const facing = typeof o.facing === 'number' && Number.isFinite(o.facing) ? normDeg(Math.round(o.facing)) : p === 0 ? 0 : 180;
      const reg = this.newRegiment(p, kind, x, y, facing, width, this.regiments.length - regBase);
      for (const q of placed) {
        const d2 = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y);
        const lim = idiv((q.rad + reg.rad) * 55, 100);
        if (d2 < lim * lim) return reject(i, `與第 ${placed.indexOf(q)} 個軍團重疊`);
      }
      spent += def.cost;
      placed.push(reg);
      this.regiments.push(reg);
      for (let k = 0; k < def.men; k++) {
        const id = this.soldiers.length;
        this.soldiers.push({ id, reg: reg.id, owner: p, k: id - base, x, y, hp: def.hp, cd: 0, target: -1, nextRetarget: 0, alive: true, ord: k, sx: x, sy: y, impacted: false, blocked: false });
        reg.slots.push(id);
      }
      this.layout(reg, true);
      for (const sid of reg.slots) {
        const s = this.soldiers[sid];
        s.x = s.sx;
        s.y = s.sy;
      }
      return undefined;
    });
    return spent;
  }

  private newRegiment(owner: number, kind: UnitKind, x: number, y: number, facing: number, width: number, k: number): Regiment {
    const def = UNITS[kind];
    const r: Regiment = {
      id: this.regiments.length,
      owner,
      k,
      kind,
      def,
      men0: def.men,
      x,
      y,
      facing,
      px: x,
      py: y,
      pf: facing,
      width,
      effWidth: width,
      slots: [],
      order: 'idle',
      tx: x,
      ty: y,
      tFacing: -1,
      target: -1,
      lastSeenX: 0,
      lastSeenY: 0,
      path: [],
      pathIdx: 0,
      pathGoalX: x,
      pathGoalY: y,
      repathAt: 0,
      brace: 0,
      braceTimer: 0,
      pending: null,
      charging: false,
      chargeTravel: 0,
      chargeSpeedCur: 0,
      chargeTarget: -1,
      impactUntil: -1,
      chargeHitReg: -1,
      chargeKills: 0,
      chargeBraced: false,
      chargeFlank: 'front',
      needDisengage: false,
      routed: false,
      destroyed: false,
      level: 1,
      dmgDealt: 0,
      revealedUntil: -1,
      spottedSince: -1,
      lastHidden: -1000,
      lastMelee: -1000,
      lastHit: -1000,
      fireTarget: -1,
      fireSince: 0,
      lastShot: -1000,
      moved: false,
      nearEnemy: false,
      lag: 0,
      halfW: 0,
      halfD: 0,
      rad: 0,
      kills: 0,
      escaped: 0,
    };
    this.measure(r, def.men);
    return r;
  }

  // ───────── 公開介面 ─────────

  get playerCount(): number {
    return this.players.length;
  }

  isDecisionTick(): boolean {
    return this.tick % RULES.decisionInterval === 0;
  }

  result(): LegionResult {
    if (this.resultValue === null) throw new Error('比賽尚未結束');
    return this.resultValue;
  }

  initData(p: number, knobs: Readonly<Record<string, number>>): LegionInitData {
    return legionInitData(this.map, this.mode, p, knobs, this.timeLimitTicks);
  }

  regimentStatus(r: Regiment): RegimentStatus {
    if (r.routed) return 'routed';
    if (r.brace === 1) return 'bracing';
    if (r.brace === 2) return 'braced';
    if (r.brace === 3) return 'unbracing';
    if (r.charging) return 'charging';
    if (this.tick - r.lastMelee <= 10) return 'engaged';
    if (r.order === 'attack' || ((r.order === 'attackMove' || r.order === 'hold' || r.order === 'idle') && r.target >= 0)) return 'attacking';
    if (r.moved) return 'moving';
    return 'idle';
  }

  canCharge(r: Regiment): boolean {
    if (!r.def.cavalry || r.routed || r.charging || r.needDisengage) return false;
    const t = this.terrainAt(r.x, r.y);
    return t !== T.Forest && t !== T.Shallow;
  }

  observe(p: number): LegionObservation {
    const regiments: OwnRegiment[] = [];
    const enemies: EnemyRegiment[] = [];
    for (const r of this.regiments) {
      if (r.destroyed) continue;
      if (r.owner === p) {
        let hp = 0;
        for (const sid of r.slots) hp += this.soldiers[sid].hp;
        regiments.push({
          id: r.id,
          kind: r.kind,
          x: r.x,
          y: r.y,
          facing: r.facing,
          width: r.width,
          men: r.slots.length,
          men0: r.men0,
          hp,
          hpMax: idiv(r.slots.length * r.def.hp * RULES.veteran.levels[r.level - 1].hp, 100),
          status: this.regimentStatus(r),
          order: r.charging ? 'charge' : r.order,
          target: r.charging ? r.chargeTarget : r.target >= 0 ? r.target : null,
          level: r.level,
          engaged: this.tick - r.lastMelee <= 10,
          canCharge: this.canCharge(r),
          routed: r.routed,
          terrain: this.terrainAt(r.x, r.y),
          radius: r.rad,
        });
      } else if (this.visible[p][r.id] === 1) {
        enemies.push({
          id: r.id,
          owner: r.owner,
          kind: r.kind,
          x: r.x,
          y: r.y,
          facing: r.facing,
          width: r.width,
          men: r.slots.length,
          men0: r.men0,
          status: this.regimentStatus(r),
          engaged: this.tick - r.lastMelee <= 10,
          routed: r.routed,
          terrain: this.terrainAt(r.x, r.y),
          radius: r.rad,
        });
      }
    }
    const events = this.inbox[p];
    this.inbox[p] = [];
    return {
      tick: this.tick,
      timeLeft: this.timeLimitTicks - this.tick,
      me: p,
      regiments,
      enemies,
      flags: this.flags.map((f): FlagState => ({ id: f.id, name: f.name, x: f.x, y: f.y, owner: f.owner, value: f.value, capturer: f.capturer })),
      domination: this.players.map((q) => q.domination),
      events,
    };
  }

  // ───────── 指令 ─────────

  applyCommands(p: number, raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const n = Math.min(raw.length, RULES.commandsPerDecision);
    for (let i = 0; i < n; i++) this.applyCommand(p, raw[i], false);
  }

  private rejectCmd(p: number, cmd: string, reason: string): void {
    this.emit({ type: 'rejected', tick: this.tick, player: p, command: cmd, reason });
  }

  private applyCommand(p: number, raw: unknown, fromPending: boolean): void {
    if (typeof raw !== 'object' || raw === null) return this.rejectCmd(p, '?', '指令不是物件');
    const c = raw as Record<string, unknown>;
    const type = String(c.type);
    const r = typeof c.id === 'number' ? this.regiments[c.id] : undefined;
    if (r === undefined || r.owner !== p || r.destroyed) return this.rejectCmd(p, type, '不是自己的軍團');
    if (r.routed) return this.rejectCmd(p, type, '軍團已潰散');
    if (r.charging) return this.rejectCmd(p, type, '衝鋒中無法改變指令');
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    const target = (): Regiment | null => {
      const t = num(c.target);
      const tr = t === null ? undefined : this.regiments[t];
      if (tr === undefined || tr.owner === p || tr.destroyed || this.visible[p][tr.id] !== 1) return null;
      return tr;
    };
    // 架陣中：先收陣，收完再執行（brace／unbrace／formation 例外）
    const needsFree = type === 'move' || type === 'attackMove' || type === 'attack' || type === 'charge' || type === 'face';
    if (needsFree && r.brace !== 0 && !fromPending) {
      if (r.brace === 1 || r.brace === 2) {
        r.brace = 3;
        r.braceTimer = RULES.brace.unsetTicks;
      }
      r.pending = raw as LegionCommand;
      return;
    }
    switch (type) {
      case 'move':
      case 'attackMove': {
        const x = num(c.x);
        const y = num(c.y);
        if (x === null || y === null) return this.rejectCmd(p, type, '座標不合法');
        r.order = type;
        r.tx = Math.max(0, Math.min(this.map.width * TILE - 1, x));
        r.ty = Math.max(0, Math.min(this.map.height * TILE - 1, y));
        const f = num(c.facing);
        r.tFacing = type === 'move' && f !== null ? normDeg(f) : -1;
        r.target = -1;
        r.fireTarget = -1;
        r.path = [];
        return;
      }
      case 'attack': {
        const t = target();
        if (t === null) return this.rejectCmd(p, type, '目標不存在或看不到');
        r.order = 'attack';
        r.target = t.id;
        r.lastSeenX = t.x;
        r.lastSeenY = t.y;
        r.fireTarget = -1;
        r.path = [];
        return;
      }
      case 'charge': {
        if (!r.def.cavalry) return this.rejectCmd(p, type, '只有騎兵能衝鋒');
        if (r.needDisengage) return this.rejectCmd(p, type, '撞擊後要先脫離 6 格才能再衝鋒');
        if (!this.canCharge(r)) return this.rejectCmd(p, type, '樹林與淺灘中不能衝鋒');
        const t = target();
        if (t === null) return this.rejectCmd(p, type, '目標不存在或看不到');
        r.charging = true;
        r.chargeTravel = 0;
        r.chargeSpeedCur = r.def.speed;
        r.chargeTarget = t.id;
        r.impactUntil = -1;
        r.chargeHitReg = -1;
        r.chargeKills = 0;
        r.chargeBraced = false;
        r.target = t.id;
        r.path = [];
        for (const sid of r.slots) this.soldiers[sid].impacted = false;
        return;
      }
      case 'brace':
        if (r.kind !== 'spear') return this.rejectCmd(p, type, '只有長槍方陣能架陣');
        if (r.brace === 1 || r.brace === 2) return undefined;
        r.brace = 1;
        r.braceTimer = RULES.brace.setTicks;
        r.order = 'hold';
        r.path = [];
        r.pending = null;
        return;
      case 'unbrace':
        if (r.brace === 1 || r.brace === 2) {
          r.brace = 3;
          r.braceTimer = RULES.brace.unsetTicks;
        }
        r.pending = null;
        return;
      case 'hold':
        if (r.brace === 3) r.pending = null;
        r.order = 'hold';
        r.target = -1;
        r.path = [];
        return;
      case 'formation': {
        const w = num(c.width);
        if (w === null) return this.rejectCmd(p, type, '寬度不合法');
        r.width = Math.max(1, Math.min(r.men0, w));
        return;
      }
      case 'face': {
        const f = num(c.facing);
        if (f === null) return this.rejectCmd(p, type, '角度不合法');
        r.order = 'idle';
        r.target = -1;
        r.path = [];
        r.tFacing = normDeg(f);
        return;
      }
      default:
        return this.rejectCmd(p, type, '沒有這個指令');
    }
  }

  // ───────── 主迴圈 ─────────

  step(): void {
    if (this.over) return;
    this.events = [];
    this.flankMemo.clear();
    for (const r of this.regiments) {
      r.px = r.x;
      r.py = r.y;
      r.pf = r.facing;
    }
    for (const r of this.regiments) if (!r.destroyed) this.think(r);
    for (const r of this.regiments) if (!r.destroyed) this.layout(r, false);
    this.computeNear();
    this.grid.build(this.soldiers);
    const sol = this.soldiers;
    if (this.nx.length < sol.length) {
      this.nx = new Int32Array(sol.length);
      this.ny = new Int32Array(sol.length);
    }
    for (const so of sol) if (so.alive) this.moveSoldier(so);
    for (const so of sol) {
      if (!so.alive) continue;
      so.x = this.nx[so.id];
      so.y = this.ny[so.id];
    }
    this.grid.build(this.soldiers);
    this.combat();
    this.resolveProjectiles();
    this.cleanup();
    this.computeVision();
    if (this.mode === 'capture') this.stepFlags();
    this.tick += 1;
    this.checkVictory();
  }

  // ───────── 軍團決策 ─────────

  private terrainAt(x: number, y: number): number {
    const tx = tileCoord(x, this.map.width);
    const ty = tileCoord(y, this.map.height);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return T.River;
    return this.map.terrain[ty * this.map.width + tx];
  }

  private alive(id: number): Regiment | null {
    const r = id >= 0 ? this.regiments[id] : undefined;
    return r === undefined || r.destroyed ? null : r;
  }

  private think(r: Regiment): void {
    r.moved = false;
    if (r.needDisengage && this.tick % 5 === 0 && this.nearestEnemyDist(r) >= RULES.charge.disengage) r.needDisengage = false;
    if (r.routed) {
      const ex = this.map.rearX[r.owner] === 0 ? 300 : this.map.width * TILE - 300;
      this.moveTo(r, ex, r.y, 0, idiv(r.def.speed * RULES.routSpeed, 100), true);
      return;
    }
    if (r.brace === 1 || r.brace === 3) {
      r.braceTimer -= 1;
      if (r.braceTimer <= 0) {
        if (r.brace === 1) r.brace = 2;
        else {
          r.brace = 0;
          const pend = r.pending;
          r.pending = null;
          if (pend !== null) this.applyCommand(r.owner, pend, true);
        }
      }
    }
    if (r.brace !== 0) return;
    if (r.charging) return this.thinkCharge(r);
    if (r.def.range > 0 && this.tick % 5 === 0 && r.order !== 'attack' && r.order !== 'move') this.setFire(r, this.acquire(r, r.def.range + this.hillRange(r)));
    switch (r.order) {
      case 'idle':
      case 'hold':
        if (r.tFacing >= 0) r.facing = turnToward(r.facing, r.tFacing, r.def.turn);
        if (r.def.range === 0 && r.order === 'idle') r.target = -1;
        return;
      case 'move':
        if (this.moveTo(r, r.tx, r.ty, 0, r.def.speed, false)) r.order = 'idle';
        return;
      case 'attackMove': {
        if (this.tick % 5 === 0 && this.alive(r.target) === null) r.target = r.def.range > 0 ? -1 : this.acquire(r, r.def.sight);
        const t = this.alive(r.target);
        if (r.def.range > 0) {
          if (r.fireTarget >= 0) return this.approach(r, this.regiments[r.fireTarget]);
        } else if (t !== null && this.visible[r.owner][t.id] === 1) return this.approach(r, t);
        if (this.moveTo(r, r.tx, r.ty, 0, r.def.speed, false)) r.order = 'idle';
        return;
      }
      case 'attack': {
        const t = this.alive(r.target);
        if (t === null) {
          r.order = 'idle';
          r.target = -1;
          return;
        }
        if (this.visible[r.owner][t.id] === 1) {
          r.lastSeenX = t.px;
          r.lastSeenY = t.py;
          return this.approach(r, t);
        }
        r.fireTarget = -1;
        if (this.moveTo(r, r.lastSeenX, r.lastSeenY, 0, r.def.speed, false)) {
          r.order = 'idle';
          r.target = -1;
        }
        return;
      }
    }
  }

  private setFire(r: Regiment, id: number): void {
    if (r.fireTarget !== id) {
      r.fireTarget = id;
      r.fireSince = this.tick;
    }
  }

  /** 弓兵：射擊目標設定了 3 秒還沒放出任何一箭（士兵都在射程外）→ 需要再靠近 */
  private fireStalled(r: Regiment): boolean {
    return this.tick - r.fireSince > 30 && this.tick - r.lastShot > 30;
  }

  private faceTo(r: Regiment, t: Regiment): void {
    if (t.px !== r.x || t.py !== r.y) r.facing = turnToward(r.facing, iatan2(t.py - r.y, t.px - r.x), r.def.turn);
  }

  private hillRange(r: Regiment): number {
    return this.terrainAt(r.x, r.y) === T.Hill ? RULES.terrain.hillRange : 0;
  }

  /** 目標在 t 方向上的伸展：沿 t 朝向為 halfD、側向為 halfW */
  private extentToward(t: Regiment, fromX: number, fromY: number): number {
    const a = angleDiff(iatan2(fromY - t.py, fromX - t.px), t.pf);
    return idiv(Math.abs(icos(a)) * t.halfD + Math.abs(isin(a)) * t.halfW, 10000);
  }

  private approach(r: Regiment, t: Regiment): void {
    const d = isqrt((t.px - r.x) * (t.px - r.x) + (t.py - r.y) * (t.py - r.y));
    if (r.def.range > 0) {
      const range = r.def.range + this.hillRange(r);
      if (d - idiv(t.rad, 2) <= range - 1000) {
        this.setFire(r, t.id);
        if (!this.fireStalled(r)) {
          this.faceTo(r, t);
          return;
        }
      } else this.setFire(r, -1);
      this.moveTo(r, t.px, t.py, 0, r.def.speed, false);
      return;
    }
    const contact = r.halfD + this.extentToward(t, r.x, r.y) + 300;
    // 已接戰：軍團中心停下（被纏住），士兵各自找對手
    if (this.tick - r.lastMelee <= 10) {
      if (d <= contact + 3000) this.faceTo(r, t);
      return;
    }
    if (d <= contact) {
      this.faceTo(r, t);
      return;
    }
    this.moveTo(r, t.px, t.py, contact, r.def.speed, false);
  }

  /** 沿路徑移動軍團中心；抵達（距終點 stopAt 以內）回傳 true */
  private moveTo(r: Regiment, gx: number, gy: number, stopAt: number, baseSpeed: number, routed: boolean): boolean {
    const dGoal2 = (gx - r.pathGoalX) * (gx - r.pathGoalX) + (gy - r.pathGoalY) * (gy - r.pathGoalY);
    if (r.path.length === 0 || r.pathIdx >= r.path.length || dGoal2 > 2000 * 2000 || (this.tick >= r.repathAt && dGoal2 > 0)) {
      const p = findPath(this.map, r.x, r.y, gx, gy, r.owner === 1);
      r.path = p ?? [];
      r.pathIdx = 0;
      r.pathGoalX = gx;
      r.pathGoalY = gy;
      r.repathAt = this.tick + 20;
      if (r.path.length === 0) return true;
    }
    const [wx, wy] = r.path[r.pathIdx];
    const last = r.pathIdx === r.path.length - 1;
    const dx = wx - r.x;
    const dy = wy - r.y;
    const d = isqrt(dx * dx + dy * dy);
    const remain = d - (last ? stopAt : 0);
    if (remain <= 0) {
      if (last) {
        if (r.tFacing >= 0 && !routed) r.facing = turnToward(r.facing, r.tFacing, r.def.turn);
        return true;
      }
      r.pathIdx += 1;
      return false;
    }
    const want = iatan2(dy, dx);
    const diff = Math.abs(angleDiff(want, r.facing));
    if (routed) r.facing = want;
    else r.facing = turnToward(r.facing, want, r.def.turn);
    // 先原地轉向再前進（潰散不轉向）
    if (!routed && diff > 60) return false;
    let speed = idiv(baseSpeed * terrainSpeed(this.terrainAt(r.x, r.y), r.kind), 100);
    // 隊形散開時放慢，等士兵跟上
    if (r.lag > 2000) speed = idiv(speed, 2);
    const step = Math.min(speed, remain);
    const [nx, ny] = stepToward(r.x, r.y, wx, wy, step);
    r.x = nx;
    r.y = ny;
    r.moved = true;
    if (remain - step <= 0 && !last) r.pathIdx += 1;
    return false;
  }

  /** 看得到的最近敵軍（中心距離 − 半徑 ≤ range）；沒有回傳 -1 */
  private acquire(r: Regiment, range: number): number {
    let best = -1;
    let bestD = Infinity;
    for (const t of this.regiments) {
      if (t.destroyed || t.owner === r.owner || this.visible[r.owner][t.id] !== 1) continue;
      const d = isqrt((t.px - r.x) * (t.px - r.x) + (t.py - r.y) * (t.py - r.y)) - idiv(t.rad, 2);
      if (d <= range && d < bestD) {
        bestD = d;
        best = t.id;
      }
    }
    return best;
  }

  private nearestEnemyDist(r: Regiment): number {
    let best = Infinity;
    for (const t of this.regiments) {
      if (t.destroyed || t.owner === r.owner) continue;
      const d = isqrt((t.px - r.x) * (t.px - r.x) + (t.py - r.y) * (t.py - r.y)) - t.rad - r.rad;
      if (d < best) best = d;
    }
    return best;
  }

  private thinkCharge(r: Regiment): void {
    if (r.impactUntil >= 0) {
      r.chargeSpeedCur = 0;
      if (this.tick > r.impactUntil) this.endCharge(r, true);
      return;
    }
    const t = this.alive(r.chargeTarget);
    if (t !== null && (t.px !== r.x || t.py !== r.y)) r.facing = turnToward(r.facing, iatan2(t.py - r.y, t.px - r.x), RULES.charge.turn);
    const def = r.def;
    const run = Math.min(r.chargeTravel, RULES.charge.runup);
    const speed = def.speed + idiv((def.chargeSpeed - def.speed) * run, RULES.charge.runup);
    const [ox, oy] = offset(r.facing, speed);
    const nx = r.x + ox;
    const ny = r.y + oy;
    const tt = this.terrainAt(nx, ny);
    if (!walkable(tt) || tt === T.Forest || tt === T.Shallow || r.chargeTravel > 40000) {
      this.endCharge(r, false);
      return;
    }
    r.x = nx;
    r.y = ny;
    r.chargeTravel += speed;
    r.chargeSpeedCur = speed;
    r.moved = true;
  }

  private endCharge(r: Regiment, impacted: boolean): void {
    r.charging = false;
    r.chargeSpeedCur = 0;
    r.path = [];
    if (impacted) {
      r.needDisengage = true;
      this.emit({ type: 'impact', tick: this.tick, reg: r.id, target: r.chargeHitReg, kills: r.chargeKills, braced: r.chargeBraced, flank: r.chargeFlank });
      const hit = this.alive(r.chargeHitReg);
      r.target = hit !== null ? hit.id : -1;
      r.order = hit !== null ? 'attack' : 'idle';
    } else {
      const t = this.alive(r.chargeTarget);
      r.order = t !== null ? 'attack' : 'idle';
      r.target = t !== null ? t.id : -1;
    }
    if (r.order === 'attack') {
      const t = this.regiments[r.target];
      r.lastSeenX = t.px;
      r.lastSeenY = t.py;
    }
  }

  // ───────── 隊形 ─────────

  private measure(r: Regiment, count: number): void {
    const files = Math.max(1, Math.min(r.effWidth, count));
    const ranks = Math.max(1, Math.ceil(count / files));
    r.halfW = idiv(files * r.def.spacingX, 2);
    r.halfD = idiv(ranks * r.def.spacingY, 2);
    r.rad = isqrt(r.halfW * r.halfW + r.halfD * r.halfD);
  }

  /** 隊形縮窄：橫排兩端連線可通行的最大寬度（移動中多看前方）；最窄步兵 3 人、騎兵 2 騎 */
  private corridorWidth(r: Regiment): number {
    const want = Math.max(1, Math.min(r.width, r.slots.length));
    const floor = Math.min(want, r.def.cavalry ? 2 : 3);
    const ahead = r.moved || r.charging ? [0, 2000, 4000] : [0];
    const c = icos(r.facing);
    const s = isin(r.facing);
    for (let w = want; w > floor; w = w > 8 ? w - 2 : w - 1) {
      const half = idiv((w - 1) * r.def.spacingX, 2) + 300;
      let ok = true;
      for (const a of ahead) {
        const mx = r.x + tdiv(c * a, 10000);
        const my = r.y + tdiv(s * a, 10000);
        const lx = mx + tdiv(s * half, 10000);
        const ly = my - tdiv(c * half, 10000);
        const rx = mx - tdiv(s * half, 10000);
        const ry = my + tdiv(c * half, 10000);
        if (!clearLine(this.map, lx, ly, rx, ry)) {
          ok = false;
          break;
        }
      }
      if (ok) return w;
    }
    return floor;
  }

  private layout(r: Regiment, force: boolean): void {
    const n = r.slots.length;
    if (n === 0) return;
    if (force || r.moved || r.charging || (this.tick + r.k) % 10 === 0) r.effWidth = this.corridorWidth(r);
    this.measure(r, n);
    const files = Math.max(1, Math.min(r.effWidth, n));
    const ranks = Math.ceil(n / files);
    const c = icos(r.facing);
    const s = isin(r.facing);
    const sx = r.def.spacingX;
    const sy = r.def.spacingY;
    let lag = 0;
    for (let ord = 0; ord < n; ord++) {
      const sol = this.soldiers[r.slots[ord]];
      const rank = Math.floor(ord / files);
      const f = ord - rank * files;
      const inRank = rank === ranks - 1 ? n - rank * files : files;
      const lat2 = (2 * f - (inRank - 1)) * sx;
      const fwd2 = (ranks - 1 - 2 * rank) * sy;
      let x = r.x + tdiv(fwd2 * c - lat2 * s, 20000);
      let y = r.y + tdiv(fwd2 * s + lat2 * c, 20000);
      if (!walkable(this.terrainAt(x, y))) [x, y] = snapPoint(this.map, x, y, r.owner === 1);
      sol.sx = x;
      sol.sy = y;
      lag += Math.abs(sol.x - x) + Math.abs(sol.y - y);
    }
    r.lag = idiv(lag, n);
  }

  /** 軍團層級的接近判定：有敵軍在附近才做士兵層級的戰鬥與推擠 */
  private computeNear(): void {
    const regs = this.regiments;
    for (const r of regs) r.nearEnemy = false;
    for (let i = 0; i < regs.length; i++) {
      const a = regs[i];
      if (a.destroyed) continue;
      for (let j = i + 1; j < regs.length; j++) {
        const b = regs[j];
        if (b.destroyed || b.owner === a.owner) continue;
        const lim = a.rad + b.rad + 4000;
        if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= lim * lim) {
          a.nearEnemy = true;
          b.nearEnemy = true;
        }
      }
    }
  }

  // ───────── 士兵 ─────────

  private nearestEnemy(s: Soldier, radius: number): number {
    const g = this.grid;
    const k = Math.ceil(radius / TILE);
    const cx = Math.min(g.w - 1, Math.max(0, tileCoord(s.x, g.w)));
    const cy = Math.min(g.h - 1, Math.max(0, tileCoord(s.y, g.h)));
    let best = -1;
    let bestD = radius * radius;
    for (let y = Math.max(0, cy - k); y <= Math.min(g.h - 1, cy + k); y++) {
      for (let x = Math.max(0, cx - k); x <= Math.min(g.w - 1, cx + k); x++) {
        for (let id = g.head[y * g.w + x]; id !== -1; id = g.next[id]) {
          const o = this.soldiers[id];
          if (o.owner === s.owner || !o.alive) continue;
          const d = (o.x - s.x) * (o.x - s.x) + (o.y - s.y) * (o.y - s.y);
          if (d < bestD || (d === bestD && id < best)) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }

  /** 士兵本 tick 的追擊半徑（0 = 不追，只打觸及範圍內的） */
  private chaseRadius(r: Regiment): number {
    if (!r.nearEnemy || r.routed || r.brace !== 0 || r.charging) return 0;
    if (r.def.range > 0 && r.fireTarget >= 0) return 0;
    if (r.order === 'move') return 0;
    if (r.order === 'attack' || r.target >= 0 || this.tick - r.lastMelee <= 10) return RULES.soldier.engageAttack;
    return RULES.soldier.engageIdle;
  }

  /**
   * 士兵移動：只讀取 tick 開始時的位置，結果寫入緩衝區，全部算完才一起套用（處理順序不影響結果）。
   */
  private moveSoldier(s: Soldier): void {
    const r = this.regiments[s.reg];
    const def = r.def;
    let speed = idiv(def.speed * terrainSpeed(this.terrainAt(s.x, s.y), r.kind), 100);
    if (r.routed) speed = idiv(speed * RULES.routSpeed, 100);
    if (r.charging && r.chargeSpeedCur > speed) speed = r.chargeSpeedCur;
    let gx = s.sx;
    let gy = s.sy;
    const chase = this.chaseRadius(r);
    if (chase > 0) {
      let t = s.target >= 0 ? this.soldiers[s.target] : null;
      if (t === null || !t.alive || this.tick >= s.nextRetarget) {
        s.target = this.nearestEnemy(s, chase);
        s.nextRetarget = this.tick + RULES.soldier.retarget;
        t = s.target >= 0 ? this.soldiers[s.target] : null;
      }
      if (t !== null) {
        const lx = s.x - s.sx;
        const ly = s.y - s.sy;
        if (lx * lx + ly * ly > RULES.soldier.leash * RULES.soldier.leash) {
          s.target = -1;
        } else {
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const d = isqrt(dx * dx + dy * dy);
          const stop = def.reach - 150;
          if (d <= stop) {
            gx = s.x;
            gy = s.y;
          } else {
            gx = s.x + tdiv(dx * (d - stop), d);
            gy = s.y + tdiv(dy * (d - stop), d);
          }
        }
      }
    } else if (s.target >= 0) {
      s.target = -1;
    }
    // 直線被地形擋住：先往軍團中心走
    if (gx === s.sx && gy === s.sy && (this.tick + s.k) % 10 === 0) s.blocked = !clearLine(this.map, s.x, s.y, gx, gy);
    if (s.blocked && gx === s.sx && gy === s.sy) [gx, gy] = snapPoint(this.map, r.x, r.y, r.owner === 1);
    let x = s.x;
    let y = s.y;
    const dx = gx - x;
    const dy = gy - y;
    if (dx !== 0 || dy !== 0) {
      if (Math.abs(dx) + Math.abs(dy) > 1000) speed = idiv(speed * RULES.soldier.catchUp, 100);
      const [nx, ny] = stepToward(x, y, gx, gy, speed);
      [x, y] = this.slide(x, y, nx, ny);
    }
    if (r.nearEnemy) [x, y] = this.separate(s, x, y);
    this.nx[s.id] = x;
    this.ny[s.id] = y;
  }

  /** 從 (x, y) 往 (nx, ny)：不可通行就沿單一軸滑動，都不行就不動 */
  private slide(x: number, y: number, nx: number, ny: number): [number, number] {
    if (walkable(this.terrainAt(nx, ny))) return [nx, ny];
    if (walkable(this.terrainAt(nx, y))) return [nx, y];
    if (walkable(this.terrainAt(x, ny))) return [x, ny];
    return [x, y];
  }

  private place(s: Soldier, nx: number, ny: number): void {
    [s.x, s.y] = this.slide(s.x, s.y, nx, ny);
  }

  /** 推擠：以自己移動後的位置對其他士兵 tick 開始時的位置 */
  private separate(s: Soldier, x: number, y: number): [number, number] {
    const g = this.grid;
    const cx = Math.min(g.w - 1, Math.max(0, tileCoord(x, g.w)));
    const cy = Math.min(g.h - 1, Math.max(0, tileCoord(y, g.h)));
    const side = s.owner === 0 ? 1 : -1;
    let px = 0;
    let py = 0;
    for (let ty = Math.max(0, cy - 1); ty <= Math.min(g.h - 1, cy + 1); ty++) {
      for (let tx = Math.max(0, cx - 1); tx <= Math.min(g.w - 1, cx + 1); tx++) {
        for (let id = g.head[ty * g.w + tx]; id !== -1; id = g.next[id]) {
          if (id === s.id) continue;
          const o = this.soldiers[id];
          if (!o.alive) continue;
          const friend = o.owner === s.owner;
          const gap = friend ? RULES.soldier.friendGap : RULES.soldier.enemyGap;
          const dx = x - o.x;
          const dy = y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= gap * gap) continue;
          if (d2 === 0) {
            // 完全重疊：往己方那一側推（友軍依序號分兩邊）
            px -= side * idiv(gap, 4) * (friend && s.k > o.k ? -1 : 1);
            continue;
          }
          const d = isqrt(d2);
          const push = idiv(gap - d, 2);
          px += tdiv(dx * push, d);
          py += tdiv(dy * push, d);
        }
      }
    }
    if (px === 0 && py === 0) return [x, y];
    const lim = 200;
    px = Math.max(-lim, Math.min(lim, px));
    py = Math.max(-lim, Math.min(lim, py));
    return this.slide(x, y, x + px, y + py);
  }

  // ───────── 戰鬥 ─────────

  flankOf(a: Regiment, t: Regiment): Flank {
    const key = a.id * 4096 + t.id;
    const memo = this.flankMemo.get(key);
    if (memo !== undefined) return memo;
    let f: Flank = 'front';
    if (a.x !== t.x || a.y !== t.y) {
      const d = Math.abs(angleDiff(iatan2(a.y - t.y, a.x - t.x), t.facing));
      f = d <= RULES.flank.frontHalf ? 'front' : d >= 180 - RULES.flank.rearHalf ? 'rear' : 'side';
    }
    this.flankMemo.set(key, f);
    return f;
  }

  private atkPct(r: Regiment): number {
    return RULES.veteran.levels[r.level - 1].attack;
  }

  private damage(e: Soldier, amount: number, by: Regiment): void {
    if (!e.alive) return;
    const a = Math.max(1, amount);
    const before = e.hp;
    e.hp -= a;
    by.dmgDealt += Math.min(a, before);
    const t = this.regiments[e.reg];
    t.lastHit = this.tick;
    if (e.hp <= 0) {
      e.alive = false;
      e.target = -1;
      by.kills += 1;
      this.players[by.owner].kills += 1;
      this.players[e.owner].losses += 1;
      if (by.charging || by.impactUntil >= this.tick) by.chargeKills += 1;
    }
  }

  /**
   * 主動攻擊：在樹林中就被看見一段時間。
   * 埋伏：這個軍團最近 8 秒內還隱蔽在樹林裡，而且敵方在接觸前 5 秒內才第一次看到（或還沒看到）它（每次接戰只算一次）。
   */
  private revealOnAttack(r: Regiment): void {
    if (this.terrainAt(r.x, r.y) === T.Forest) r.revealedUntil = this.tick + RULES.vision.revealTicks;
    if (this.tick - r.lastMelee <= 30 && r.lastMelee >= 0) return;
    if (this.tick - r.lastHidden > RULES.ambushHiddenTicks) return;
    if (r.spottedSince < 0 || this.tick - r.spottedSince <= RULES.ambushTicks) this.emit({ type: 'ambush', tick: this.tick, reg: r.id });
  }

  /** 戰鬥：先依 tick 開始時的狀態決定所有攻擊，再一起套用傷害（同時結算，處理順序不影響結果） */
  private combat(): void {
    this.hits.length = 0;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      if (s.cd > 0) {
        s.cd -= 1;
        continue;
      }
      const r = this.regiments[s.reg];
      if (!r.nearEnemy && r.fireTarget < 0) continue;
      if (r.charging && r.impactUntil < 0) continue;
      if (r.nearEnemy) {
        let e = s.target >= 0 ? this.soldiers[s.target] : null;
        const reach2 = r.def.reach * r.def.reach;
        if (e === null || !e.alive || (e.x - s.x) * (e.x - s.x) + (e.y - s.y) * (e.y - s.y) > reach2) {
          const id = this.nearestEnemy(s, r.def.reach);
          e = id >= 0 ? this.soldiers[id] : null;
        }
        if (e !== null) {
          this.melee(s, r, e);
          s.cd = r.def.cooldown;
          continue;
        }
      }
      if (r.def.range > 0 && r.fireTarget >= 0 && !r.moved && !r.routed) {
        if (this.shoot(s, r)) s.cd = r.def.cooldown;
        else s.cd = 3;
      }
    }
    // 衝鋒撞擊
    for (const r of this.regiments) {
      if (r.destroyed || !r.charging) continue;
      if (r.impactUntil >= 0 && this.tick > r.impactUntil) continue;
      for (const sid of r.slots) {
        const s = this.soldiers[sid];
        if (!s.alive || s.impacted) continue;
        const id = this.nearestEnemy(s, r.def.reach);
        if (id >= 0) this.impact(r, s, this.soldiers[id]);
      }
    }
    const h = this.hits;
    for (let i = 0; i < h.length; i += 5) {
      const e = this.soldiers[h[i]];
      this.damage(e, h[i + 1], this.regiments[h[i + 2]]);
      if (e.alive && (h[i + 3] !== 0 || h[i + 4] !== 0)) this.place(e, e.x + h[i + 3], e.y + h[i + 4]);
    }
  }

  private queueHit(e: Soldier, amount: number, by: Regiment, kx = 0, ky = 0): void {
    this.hits.push(e.id, amount, by.id, kx, ky);
  }

  private melee(s: Soldier, r: Regiment, e: Soldier): void {
    const t = this.regiments[e.reg];
    const fl = this.flankOf(r, t);
    let vs = VERSUS[r.kind][t.kind] ?? 100;
    if (r.kind === 'spear' && t.def.cavalry && r.brace === 2 && this.flankOf(t, r) === 'front') vs = RULES.brace.vsCavalry;
    let pct = idiv(this.atkPct(r) * vs * FLANK_PCT[fl], 100);
    if (r.def.range > 0) pct = idiv(pct * RULES.ranged.archerMelee, 100);
    const et = this.terrainAt(e.x, e.y);
    if (et === T.Hill && this.terrainAt(s.x, s.y) !== T.Hill) pct = idiv(pct * RULES.terrain.uphillMelee, 100);
    if (et === T.Shallow) pct = idiv(pct * RULES.terrain.shallowMeleeTaken, 100);
    this.queueHit(e, idiv(r.def.attack * pct, 10000), r);
    this.revealOnAttack(r);
    r.lastMelee = this.tick;
    const key = Math.min(r.id, t.id) * 4096 + Math.max(r.id, t.id);
    const last = this.contactAt.get(key);
    if (last === undefined || this.tick - last > 300) this.emit({ type: 'contact', tick: this.tick, a: r.id, b: t.id, flank: fl });
    this.contactAt.set(key, this.tick);
  }

  private shoot(s: Soldier, r: Regiment): boolean {
    const t = this.alive(r.fireTarget);
    if (t === null || t.slots.length === 0 || this.visible[r.owner][t.id] !== 1) {
      this.setFire(r, -1);
      return false;
    }
    const e = this.soldiers[t.slots[this.rng.nextInt(t.slots.length)]];
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const onHill = this.terrainAt(s.x, s.y) === T.Hill;
    const range = r.def.range + (onHill ? RULES.terrain.hillRange : 0);
    if (dx * dx + dy * dy > range * range) return false;
    r.lastShot = this.tick;
    const d = isqrt(dx * dx + dy * dy);
    const hit = this.rng.nextInt(100) < RULES.ranged.hitChance;
    let x1 = e.x;
    let y1 = e.y;
    if (!hit) {
      x1 += this.rng.range(-RULES.ranged.missSpread, RULES.ranged.missSpread);
      y1 += this.rng.range(-RULES.ranged.missSpread, RULES.ranged.missSpread);
    }
    const vs = VERSUS[r.kind][t.kind] ?? 100;
    let pct = idiv(this.atkPct(r) * vs * FLANK_PCT[this.flankOf(r, t)], 100);
    if (onHill) pct = idiv(pct * RULES.terrain.hillRangedDamage, 100);
    this.projectiles.push({ x0: s.x, y0: s.y, x1, y1, t0: this.tick, t1: this.tick + Math.max(2, idiv(d, RULES.ranged.arrowSpeed)), target: hit ? e.id : -1, dmg: idiv(r.def.attack * pct, 10000), reg: r.id, owner: r.owner });
    if (this.terrainAt(r.x, r.y) === T.Forest) r.revealedUntil = this.tick + RULES.vision.revealTicks;
    return true;
  }

  private resolveProjectiles(): void {
    if (this.projectiles.length === 0) return;
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      if (p.t1 > this.tick) {
        keep.push(p);
        continue;
      }
      if (p.target < 0) continue;
      const e = this.soldiers[p.target];
      if (!e.alive) continue;
      let dmg = p.dmg;
      const t = this.regiments[e.reg];
      if (t.kind !== 'shield') {
        for (const sh of this.regiments) {
          if (sh.destroyed || sh.routed || sh.kind !== 'shield' || sh.owner !== e.owner) continue;
          const lim = sh.rad + RULES.ranged.shieldAuraRange;
          if ((sh.x - e.x) * (sh.x - e.x) + (sh.y - e.y) * (sh.y - e.y) <= lim * lim) {
            dmg = idiv(dmg * RULES.ranged.shieldAura, 100);
            break;
          }
        }
      }
      this.damage(e, dmg, this.regiments[p.reg]);
    }
    this.projectiles = keep;
  }

  private impact(r: Regiment, rider: Soldier, e: Soldier): void {
    const t = this.regiments[e.reg];
    const fl = this.flankOf(r, t);
    if (r.impactUntil < 0) {
      r.impactUntil = this.tick + RULES.charge.impactWindow;
      r.chargeHitReg = t.id;
      r.chargeFlank = fl;
    }
    rider.impacted = true;
    const spd = idiv(r.chargeSpeedCur * 100, r.def.chargeSpeed);
    const vs = IMPACT_VERSUS[r.kind]?.[t.kind] ?? 100;
    let dmg = idiv(idiv(r.def.impact * this.atkPct(r) * spd, 10000) * vs * FLANK_PCT[fl], 10000);
    const braced = t.brace === 2 && fl === 'front';
    if (braced) {
      r.chargeBraced = true;
      this.queueHit(rider, idiv(dmg * RULES.brace.reflect, 100), t);
      dmg = idiv(dmg * RULES.brace.impactTaken, 100);
    }
    const [kx, ky] = offset(r.facing, braced ? 0 : RULES.charge.knockback);
    const splash = idiv(dmg * RULES.charge.splash, 100);
    const sr2 = RULES.charge.splashRadius * RULES.charge.splashRadius;
    for (const sid of t.slots) {
      const o = this.soldiers[sid];
      if (!o.alive || o === e) continue;
      if ((o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) > sr2) continue;
      this.queueHit(o, splash, r, tdiv(kx, 2), tdiv(ky, 2));
    }
    this.queueHit(e, dmg, r, kx, ky);
    this.revealOnAttack(r);
    r.lastMelee = this.tick;
  }

  // ───────── 傷亡整理 ─────────

  private cleanup(): void {
    const lvls = RULES.veteran.levels;
    for (const r of this.regiments) {
      if (r.destroyed) continue;
      // 補位：死者的位置由最後一位補上
      const slots = r.slots;
      let dirty = false;
      for (const sid of slots) if (!this.soldiers[sid].alive) dirty = true;
      if (dirty) {
        let k = 0;
        while (k < slots.length) {
          if (this.soldiers[slots[k]].alive) {
            k += 1;
            continue;
          }
          while (slots.length > 0 && !this.soldiers[slots[slots.length - 1]].alive) slots.pop();
          if (k >= slots.length) break;
          slots[k] = slots.pop()!;
          this.soldiers[slots[k]].ord = k;
          k += 1;
        }
      }
      // 潰散撤離：抵達後方地圖邊緣的士兵離場
      if (r.routed) {
        const edge = this.map.rearX[r.owner];
        for (const sid of slots) {
          const s = this.soldiers[sid];
          if (s.alive && Math.abs(s.x - edge) <= 600) {
            s.alive = false;
            r.escaped += 1;
          }
        }
        r.slots = slots.filter((sid) => this.soldiers[sid].alive);
        r.slots.forEach((sid, i) => (this.soldiers[sid].ord = i));
      }
      if (r.slots.length === 0) {
        r.destroyed = true;
        this.emit({ type: 'destroyed', tick: this.tick, reg: r.id, escaped: r.escaped > 0 });
        continue;
      }
      if (!r.routed && r.slots.length * 100 < r.men0 * RULES.routPercent) {
        r.routed = true;
        r.order = 'idle';
        r.target = -1;
        r.fireTarget = -1;
        r.brace = 0;
        r.pending = null;
        r.charging = false;
        r.path = [];
        r.tFacing = -1;
        this.emit({ type: 'routed', tick: this.tick, reg: r.id });
      }
      // 老兵升級
      while (r.level < lvls.length && r.dmgDealt * 100 >= r.men0 * r.def.hp * lvls[r.level].threshold) {
        const before = lvls[r.level - 1].hp;
        r.level += 1;
        const add = idiv(r.def.hp * (lvls[r.level - 1].hp - before), 100);
        for (const sid of r.slots) this.soldiers[sid].hp += add;
        this.emit({ type: 'levelUp', tick: this.tick, reg: r.id, level: r.level });
      }
    }
  }

  // ───────── 視野 ─────────

  concealed(r: Regiment): boolean {
    return this.terrainAt(r.x, r.y) === T.Forest && this.tick >= r.revealedUntil;
  }

  private computeVision(): void {
    for (let p = 0; p < this.players.length; p++) {
      const vis = this.visible[p];
      for (const t of this.regiments) {
        if (t.owner === p) {
          vis[t.id] = t.destroyed ? 0 : 1;
          continue;
        }
        if (t.destroyed) {
          vis[t.id] = 0;
          continue;
        }
        const conc = this.concealed(t);
        let v = 0;
        for (const o of this.regiments) {
          if (o.owner !== p || o.destroyed) continue;
          const d = isqrt((o.x - t.x) * (o.x - t.x) + (o.y - t.y) * (o.y - t.y));
          if (conc) {
            const det = o.kind === 'light' ? RULES.vision.concealDetectLight : RULES.vision.concealDetect;
            if (d - o.rad - t.rad <= det) v = 1;
          } else {
            const sight = o.def.sight + (this.terrainAt(o.x, o.y) === T.Hill ? RULES.terrain.hillSight : 0);
            if (d - t.rad <= sight) v = 1;
          }
          if (v === 1) break;
        }
        vis[t.id] = v;
      }
    }
    for (const r of this.regiments) {
      if (r.destroyed) continue;
      let seen = false;
      for (let p = 0; p < this.players.length; p++) if (p !== r.owner && this.visible[p][r.id] === 1) seen = true;
      if (!seen) r.spottedSince = -1;
      else if (r.spottedSince < 0) r.spottedSince = this.tick;
      if (!seen && this.concealed(r)) r.lastHidden = this.tick;
    }
  }

  // ───────── 旗點與勝負 ─────────

  private stepFlags(): void {
    const n = this.players.length;
    const r2 = RULES.capture.radius * RULES.capture.radius;
    const present = new Array<number>(n);
    for (const f of this.flags) {
      present.fill(0);
      for (const s of this.soldiers) {
        if (!s.alive || this.regiments[s.reg].routed) continue;
        if ((s.x - f.x) * (s.x - f.x) + (s.y - f.y) * (s.y - f.y) <= r2) present[s.owner] = 1;
      }
      let who = -1;
      let count = 0;
      for (let p = 0; p < n; p++) {
        if (present[p] === 1) {
          who = p;
          count += 1;
        }
      }
      if (count !== 1) continue;
      const target = RULES.capture.target;
      if (f.owner === who) f.value = Math.min(target, f.value + 1);
      else if (f.owner >= 0) {
        f.value -= 1;
        if (f.value <= 0) {
          f.owner = -1;
          f.value = 0;
          f.capturer = -1;
          this.emit({ type: 'flag', tick: this.tick, flag: f.id, owner: -1 });
        }
      } else if (f.capturer === who || f.capturer === -1 || f.value === 0) {
        f.capturer = who;
        f.value += 1;
        if (f.value >= target) {
          f.owner = who;
          f.capturer = -1;
          this.emit({ type: 'flag', tick: this.tick, flag: f.id, owner: who });
        }
      } else {
        f.value -= 1;
      }
    }
    for (const p of this.players) {
      let held = 0;
      for (const f of this.flags) if (f.owner === p.id) held += 1;
      if (held * 2 > this.flags.length) {
        if (p.domination === 0) this.emit({ type: 'domination', tick: this.tick, player: p.id, started: true });
        p.domination += 1;
      } else if (p.domination > 0) {
        this.emit({ type: 'domination', tick: this.tick, player: p.id, started: false });
        p.domination = 0;
      }
    }
  }

  strength(p: number): number {
    let s = 0;
    for (const r of this.regiments) {
      if (r.owner !== p || r.destroyed || r.routed) continue;
      s += idiv(r.def.cost * 100 * r.slots.length, r.men0);
    }
    return s;
  }

  flagsHeld(p: number): number {
    let n = 0;
    for (const f of this.flags) if (f.owner === p) n += 1;
    return n;
  }

  private checkVictory(): void {
    if (this.over) return;
    const n = this.players.length;
    for (const p of this.players) {
      p.active = false;
      for (const r of this.regiments) if (r.owner === p.id && !r.destroyed && !r.routed) p.active = true;
    }
    const strength = this.players.map((p) => this.strength(p.id));
    const flagsHeld = this.players.map((p) => this.flagsHeld(p.id));
    const finish = (winner: number | null, reason: LegionResult['reason']): void => {
      this.over = true;
      this.resultValue = { winner, reason, durationTicks: this.tick, strength, flagsHeld };
    };
    for (const p of this.players) if (p.active && strength[p.id] < p.cost * RULES.collapsePercent) p.active = false;
    const active = this.players.filter((p) => p.active);
    if (active.length < n) {
      finish(active.length === 1 ? active[0].id : null, 'annihilation');
      return;
    }
    if (this.mode === 'capture') {
      const dom = this.players.find((p) => p.domination >= RULES.capture.dominationTicks);
      if (dom !== undefined) {
        finish(dom.id, 'domination');
        return;
      }
    }
    if (this.tick >= this.timeLimitTicks) {
      const order = this.players
        .map((p) => p.id)
        .sort((a, b) => (this.mode === 'capture' ? flagsHeld[b] - flagsHeld[a] : 0) || strength[b] - strength[a]);
      const a = order[0];
      const b = order[1];
      const tie = (this.mode !== 'capture' || flagsHeld[a] === flagsHeld[b]) && strength[a] === strength[b];
      finish(tie ? null : a, 'time');
    }
  }

  // ───────── 事件與雜湊 ─────────

  private emit(ev: LegionEvent): void {
    this.events.push(ev);
    this.eventTap?.(ev);
    for (let p = 0; p < this.inbox.length; p++) {
      if (this.eventFor(p, ev)) this.inbox[p].push(ev);
    }
  }

  private eventFor(p: number, ev: LegionEvent): boolean {
    const mineOrSeen = (id: number): boolean => {
      const r = this.regiments[id];
      return r !== undefined && (r.owner === p || this.visible[p]?.[id] === 1);
    };
    switch (ev.type) {
      case 'deployRejected':
      case 'rejected':
        return ev.player === p;
      case 'contact':
        return mineOrSeen(ev.a) || mineOrSeen(ev.b);
      case 'impact':
        return mineOrSeen(ev.reg) || mineOrSeen(ev.target);
      case 'ambush':
      case 'routed':
      case 'destroyed':
        return mineOrSeen(ev.reg);
      case 'levelUp':
        return this.regiments[ev.reg]?.owner === p;
      case 'flag':
      case 'domination':
        return true;
    }
  }

  hash(): string {
    const h = new Hasher();
    h.int(this.tick);
    for (const v of this.rng.getState()) h.int(v);
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      h.int(s.id).int(s.x).int(s.y).int(s.hp).int(s.cd).int(s.target);
    }
    for (const r of this.regiments) {
      h.int(r.x).int(r.y).int(r.facing).int(r.width).int(r.effWidth).int(r.slots.length).int(r.target).int(r.fireTarget);
      h.int(r.brace).int(r.braceTimer).bool(r.charging).int(r.chargeTravel).int(r.impactUntil).int(r.level).int(r.dmgDealt);
      h.bool(r.routed).bool(r.destroyed).int(r.revealedUntil).int(r.spottedSince).int(r.lastHidden).str(r.order);
    }
    for (const p of this.projectiles) h.int(p.t1).int(p.target).int(p.dmg);
    for (const f of this.flags) h.int(f.owner).int(f.value).int(f.capturer);
    for (const p of this.players) h.int(p.domination);
    return h.digest();
  }
}

/** 開局資料（布陣前就要給選手，所以不依賴比賽物件） */
export function legionInitData(m: LegionMap, mode: LegionMode, p: number, knobs: Readonly<Record<string, number>>, timeLimitTicks: number): LegionInitData {
  return {
    playerId: p,
    mode,
    knobs,
    budget: RULES.budget,
    timeLimitTicks,
    ticksPerSecond: 10,
    decisionInterval: RULES.decisionInterval,
    commandsPerDecision: RULES.commandsPerDecision,
    tileSize: TILE,
    map: {
      id: m.id,
      name: m.name,
      width: m.width,
      height: m.height,
      terrain: Array.from(m.terrain),
      deploy: m.deploy.map((z) => ({ x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 })),
      flags: m.flags.map((f, i) => ({ id: i, name: f.name, x: f.x, y: f.y })),
    },
    units: UNIT_KINDS.map((k) => {
      const u = UNITS[k];
      return { kind: k, name: u.name, men: u.men, cost: u.cost, hp: u.hp, attack: u.attack, cooldown: u.cooldown, range: u.range, reach: u.reach, speed: u.speed, chargeSpeed: u.chargeSpeed, sight: u.sight, width: u.width, spacingX: u.spacingX, spacingY: u.spacingY, cavalry: u.cavalry };
    }),
    versus: Object.fromEntries(UNIT_KINDS.map((k) => [k, Object.fromEntries(UNIT_KINDS.map((t) => [t, VERSUS[k][t] ?? 100]))])),
  };
}
