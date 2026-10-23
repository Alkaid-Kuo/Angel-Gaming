// 軍團戰模擬核心（規格書 v0.2；確定性、全整數）。
// 每 tick：軍團決策 → 隊形位置 → 士兵移動（雙緩衝）→ 戰鬥（衝刺碰撞、近戰、射擊；傷害同時結算）→ 箭矢落地
// → 傷亡整理（補位、潰散、老兵）→ 視野（含高度遮蔽）→ 旗點 → 勝負。
import { Hasher } from '../shared/hash.ts';
import { idiv, isqrt, roundHalfEven, tdiv } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import type { EnemyRegiment, Flank, FlagState, LegionCommand, LegionEvent, LegionInitData, LegionObservation, OwnRegiment, RegimentStatus } from './api.ts';
import {
  RULES,
  T,
  TPS,
  TILE,
  UNIT_KINDS,
  UNITS,
  VERSUS,
  dashDefOf,
  stopsCavalry,
  terrainSpeed,
  walkable,
  type DashDef,
  type DashKind,
  type FormationKind,
  type LegionMode,
  type ShieldStance,
  type UnitDef,
  type UnitKind,
} from './config.ts';
import { formationShape, grid, type FormationShape } from './formation.ts';
import { angleDiff, iatan2, icos, isin, normDeg, offset, stepToward, turnToward } from './geom.ts';
import { MAPS, defaultMapId, defaultTimeLimit, heightAt, sightBlocked, tileXY, type LegionMap } from './map.ts';
import { clearLine, findPath, snapPoint } from './path.ts';

export type { Flank };
export type OrderType = 'idle' | 'move' | 'attackMove' | 'attack' | 'hold' | 'follow';

/** 架陣、盾牆的狀態：0 無、1 架起中、2 已架好、3 收起中 */
export type SetState = 0 | 1 | 2 | 3;

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
  /** 隊形中的序號（0 = 最前面） */
  ord: number;
  /** 本 tick 的隊形位置 */
  sx: number;
  sy: number;
  /** 直線前往隊形位置被地形擋住 */
  blocked: boolean;
  /** 上一 tick 移動的距離（槍林速度加成用） */
  spd: number;
  /** 倒地到這個 tick 為止 */
  downUntil: number;
  /** 還在衝刺中（衝勁沒用完、沒被擋下或打斷） */
  dashing: boolean;
  /** 剩餘衝勁（×100） */
  mom: number;
  /** 本次衝刺已經撞過的敵兵（同一個人不會被同一騎撞兩次） */
  struck: number[];
  /** 突擊後的第一擊加倍 */
  firstHit: boolean;
  /** 輕騎兵被打斷：視窗內累積的傷害與視窗開始的 tick */
  dmgWin: number;
  dmgWinStart: number;
  /** 槍林迎擊：下一次可以迎擊的 tick */
  counterAt: number;
}

export interface DashState {
  readonly def: DashDef;
  /** 目標方向（可用 steer 微調） */
  dir: number;
  /** 還在對準方向（還沒起步） */
  aligning: boolean;
  left: number;
  travel: number;
  speed: number;
  /** 高度造成的速度與衝勁加成（百分比） */
  boost: number;
  mom0: number;
  firstTarget: number;
  flank: Flank;
  contacted: boolean;
  kills: number;
  downed: number;
  braced: boolean;
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
  formation: FormationKind;
  /** 橫陣的橫寬（人） */
  width: number;
  /** 方陣要保住的排數 */
  depth: number;
  /** 換陣形到這個 tick 為止（期間不能攻擊） */
  switchUntil: number;
  /** 依地形自動縮窄後的實際橫寬（0 = 不縮窄） */
  corridor: number;
  shape: FormationShape;
  shapeKey: string;
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
  followId: number;
  followFwd: number;
  followRight: number;
  path: [number, number][];
  pathIdx: number;
  pathGoalX: number;
  pathGoalY: number;
  repathAt: number;
  /** 槍林 */
  brace: SetState;
  braceTimer: number;
  braceFacing: number;
  /** 盾兵姿態與盾牆 */
  stance: ShieldStance | null;
  stanceNext: ShieldStance | null;
  stanceAt: number;
  wall: SetState;
  wallTimer: number;
  /** 收陣、收盾牆後要執行的指令 */
  pending: LegionCommand | null;
  dash: DashState | null;
  /** 衝刺中收到的指令（衝完再執行） */
  queued: LegionCommand | null;
  /** 招牌技能可以再用的 tick */
  skillReadyAt: number;
  /** 突擊接觸後可以擠進敵陣到這個 tick */
  penetrateUntil: number;
  volley: { x: number; y: number; until: number } | null;
  /** v0.3 起拿掉潰散：一律 false（保留欄位相容舊程式） */
  routed: boolean;
  destroyed: boolean;
  /** 佔點模式：在後備（不在場上，士兵暫存在 parked）；排定入場的 tick（-1 = 沒有）與入場位置 */
  reserve: boolean;
  parked: number[];
  enterAt: number;
  enterX: number;
  enterY: number;
  level: number;
  dmgDealt: number;
  revealedUntil: number;
  spottedSince: number;
  lastHidden: number;
  lastMelee: number;
  lastHit: number;
  fireTarget: number;
  fireSince: number;
  lastShot: number;
  moved: boolean;
  nearEnemy: boolean;
  lag: number;
  halfW: number;
  halfD: number;
  rad: number;
  kills: number;
  escaped: number;
  /** AI 意圖（只顯示用，不影響模擬） */
  intent: string;
  intentAt: number;
}

export interface Projectile {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly t0: number;
  readonly t1: number;
  /** 命中的士兵 id；-1 落空；-2 齊射（落點附近的敵兵中箭） */
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
  readonly points: number;
  owner: number;
  capturer: number;
  progress: number;
  contested: boolean;
}

export interface PlayerState {
  readonly id: number;
  readonly cost: number;
  /** 佔點分數（分 × TPS：每 tick 加旗點的分數） */
  score: number;
  /** 戰略意圖（plan 指令）與下達的 tick；不影響模擬 */
  plan: string;
  planAt: number;
  active: boolean;
  kills: number;
  losses: number;
}

export interface LegionResult {
  /** null = 平手 */
  readonly winner: number | null;
  readonly reason: 'annihilation' | 'score' | 'time';
  readonly durationTicks: number;
  /** 剩餘兵力（點數 × 剩餘人數比例） */
  readonly strength: readonly number[];
  readonly flagsHeld: readonly number[];
  /** 佔點分數 */
  readonly score: readonly number[];
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
const HIT_FIELDS = 7;

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
    let [cx, cy] = tileXY(x, y, this.w, this.h);
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

function clampLevel(d: number): number {
  const c = RULES.height.clamp;
  return d > c ? c : d < -c ? -c : d;
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
  /** 本 tick 的效果佇列：[士兵 id, 傷害, 攻擊方軍團 id, 推移 x, 推移 y, 倒地（0/1）, 扣衝勁] */
  private hits: number[] = [];
  /** 近戰接觸事件：軍團對 → 上次發出的 tick */
  private contactAt = new Map<number, number>();
  /** 戰鬥開始時誰還在衝刺（讀取別人的衝刺狀態一律用這份，處理順序不影響結果） */
  private dash0 = new Uint8Array(0);

  constructor(setup: LegionSetup) {
    const mapFactory = MAPS[setup.mapId ?? defaultMapId(setup.mode)];
    if (mapFactory === undefined) throw new Error(`沒有地圖 ${setup.mapId}`);
    this.map = mapFactory();
    this.mode = setup.mode;
    this.seed = setup.seed;
    this.timeLimitTicks = setup.timeLimitTicks ?? defaultTimeLimit(setup.mode);
    this.rng = Prng.fromInts(setup.seed, 0x1e9);
    this.grid = new Grid(this.map.width, this.map.height);
    const n = setup.deployments.length;
    for (let p = 0; p < n; p++) this.inbox.push([]);
    for (let p = 0; p < n; p++) {
      const cost = this.deploy(p, setup.deployments[p]);
      this.players.push({ id: p, cost, score: 0, plan: '', planAt: -1, active: true, kills: 0, losses: 0 });
    }
    for (let p = 0; p < n; p++) this.visible.push(new Uint8Array(this.regiments.length));
    if (this.mode === 'capture') this.map.flags.forEach((f, i) => this.flags.push({ id: i, name: f.name, x: f.x, y: f.y, points: f.points, owner: -1, capturer: -1, progress: 0, contested: false }));
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
    const capture = this.mode === 'capture';
    const budget = capture ? RULES.capture.budget : RULES.budget;
    const cap = capture ? RULES.capture.fieldCap : RULES.budget;
    let spent = 0;
    let onField = 0;
    const placed: Regiment[] = [];
    raw.forEach((d: unknown, i) => {
      if (typeof d !== 'object' || d === null) return reject(i, '不是物件');
      const o = d as Record<string, unknown>;
      const kind = o.type as UnitKind;
      if (!UNIT_KINDS.includes(kind)) return reject(i, `沒有兵種 ${String(o.type)}`);
      const def = UNITS[kind];
      if (spent + def.cost > budget) return reject(i, `點數超過 ${budget}`);
      // 後備：佔點模式才有；自己標成後備、或場上已經超過上限的
      if (o.reserve === true && !capture) return reject(i, '只有佔點模式有後備');
      if (capture && (o.reserve === true || onField + def.cost > cap)) {
        const formation = typeof o.formation === 'string' && def.formations.includes(o.formation as FormationKind) ? (o.formation as FormationKind) : def.formations[0];
        const sp = this.map.spawns[p];
        const reg = this.newRegiment(p, kind, sp.x, sp.y, p === 0 ? 0 : 180, this.regiments.length - regBase, formation, null);
        reg.reserve = true;
        spent += def.cost;
        this.regiments.push(reg);
        for (let k = 0; k < def.men; k++) {
          const id = this.soldiers.length;
          this.soldiers.push({ id, reg: reg.id, owner: p, k: id - base, x: sp.x, y: sp.y, hp: def.hp, cd: 0, target: -1, nextRetarget: 0, alive: false, ord: k, sx: sp.x, sy: sp.y, blocked: false, spd: 0, downUntil: -1, dashing: false, mom: 0, struck: [], firstHit: false, dmgWin: 0, dmgWinStart: 0, counterAt: 0 });
          reg.parked.push(id);
        }
        return undefined;
      }
      if (typeof o.x !== 'number' || typeof o.y !== 'number' || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return reject(i, '座標不合法');
      const x = roundHalfEven(o.x);
      const y = roundHalfEven(o.y);
      const [tx, ty] = tileXY(x, y, this.map.width, this.map.height);
      if (tx < zone.x0 || tx >= zone.x1 || ty < zone.y0 || ty >= zone.y1) return reject(i, '不在布陣區內');
      if (!walkable(this.map.terrain[ty * this.map.width + tx])) return reject(i, '位置不可通行');
      const formation = typeof o.formation === 'string' && def.formations.includes(o.formation as FormationKind) ? (o.formation as FormationKind) : def.formations[0];
      const widthIn = typeof o.width === 'number' && Number.isFinite(o.width) ? Math.max(1, Math.min(def.men, Math.round(o.width))) : null;
      const facing = typeof o.facing === 'number' && Number.isFinite(o.facing) ? normDeg(Math.round(o.facing)) : p === 0 ? 0 : 180;
      const reg = this.newRegiment(p, kind, x, y, facing, this.regiments.length - regBase, formation, widthIn);
      if (kind === 'shield' && (o.stance === 'raise' || o.stance === 'carry')) reg.stance = o.stance;
      for (const q of placed) {
        const d2 = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y);
        const lim = idiv((q.rad + reg.rad) * 55, 100);
        if (d2 < lim * lim) return reject(i, `與第 ${placed.indexOf(q)} 個軍團重疊`);
      }
      spent += def.cost;
      onField += def.cost;
      placed.push(reg);
      this.regiments.push(reg);
      for (let k = 0; k < def.men; k++) {
        const id = this.soldiers.length;
        this.soldiers.push({ id, reg: reg.id, owner: p, k: id - base, x, y, hp: def.hp, cd: 0, target: -1, nextRetarget: 0, alive: true, ord: k, sx: x, sy: y, blocked: false, spd: 0, downUntil: -1, dashing: false, mom: 0, struck: [], firstHit: false, dmgWin: 0, dmgWinStart: 0, counterAt: 0 });
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

  private newRegiment(owner: number, kind: UnitKind, x: number, y: number, facing: number, k: number, formation: FormationKind, widthIn: number | null): Regiment {
    const def = UNITS[kind];
    const width = formation === 'line' && widthIn !== null ? widthIn : def.lineWidth;
    const depth = Math.max(2, Math.ceil(def.men / (formation === 'square' && widthIn !== null ? widthIn : def.squareWidth)));
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
      formation,
      width,
      depth,
      switchUntil: -1,
      corridor: 0,
      shape: formationShape(formation, def.men, width, depth, def.spacingX, def.spacingY),
      shapeKey: '',
      slots: [],
      order: 'idle',
      tx: x,
      ty: y,
      tFacing: -1,
      target: -1,
      lastSeenX: 0,
      lastSeenY: 0,
      followId: -1,
      followFwd: 0,
      followRight: 0,
      path: [],
      pathIdx: 0,
      pathGoalX: x,
      pathGoalY: y,
      repathAt: 0,
      brace: 0,
      braceTimer: 0,
      braceFacing: facing,
      stance: kind === 'shield' ? 'carry' : null,
      stanceNext: null,
      stanceAt: 0,
      wall: 0,
      wallTimer: 0,
      pending: null,
      dash: null,
      queued: null,
      skillReadyAt: 0,
      penetrateUntil: -1,
      volley: null,
      routed: false,
      destroyed: false,
      reserve: false,
      parked: [],
      enterAt: -1,
      enterX: x,
      enterY: y,
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
      intent: '',
      intentAt: -1000,
    };
    r.halfW = r.shape.halfW;
    r.halfD = r.shape.halfD;
    r.rad = r.shape.rad;
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
    if (r.reserve) return r.enterAt >= 0 ? 'entering' : 'reserve';
    if (r.routed) return 'routed';
    if (r.dash !== null) return r.dash.def.kind === 'charge' ? 'charging' : r.dash.def.kind === 'assault' ? 'assaulting' : 'infiltrating';
    if (r.brace === 1) return 'bracing';
    if (r.brace === 2) return 'braced';
    if (r.brace === 3) return 'unbracing';
    if (r.wall === 1 || r.wall === 3) return 'walling';
    if (r.wall === 2) return 'walled';
    if (this.tick < r.switchUntil) return 'reforming';
    if (r.volley !== null) return 'volleying';
    if (this.tick - r.lastMelee <= 10) return 'engaged';
    if (r.order === 'attack' || ((r.order === 'attackMove' || r.order === 'hold' || r.order === 'idle') && (r.target >= 0 || r.fireTarget >= 0))) return 'attacking';
    if (r.moved) return 'moving';
    return 'idle';
  }

  /** 招牌技能是衝刺，而且現在可以用 */
  canDash(r: Regiment): boolean {
    const d = dashDefOf(r.kind);
    if (d === null || r.routed || r.dash !== null || r.brace !== 0 || r.wall !== 0 || this.tick < r.skillReadyAt || r.formation === 'circle') return false;
    return !(d.kind === 'charge' && stopsCavalry(this.terrainAt(r.x, r.y)));
  }

  heightOf(x: number, y: number): number {
    return heightAt(this.map, x, y);
  }

  observe(p: number): LegionObservation {
    const regiments: OwnRegiment[] = [];
    const enemies: EnemyRegiment[] = [];
    for (const r of this.regiments) {
      if (r.destroyed) continue;
      if (r.reserve) {
        if (r.owner !== p) continue;
        let hp = 0;
        for (const sid of r.parked) hp += this.soldiers[sid].hp;
        const x = r.enterAt >= 0 ? r.enterX : this.map.spawns[p].x;
        const y = r.enterAt >= 0 ? r.enterY : this.map.spawns[p].y;
        regiments.push({ id: r.id, kind: r.kind, x, y, facing: r.facing, width: r.formation === 'square' ? r.shape.files : r.width, formation: r.formation, stance: r.stance, men: r.parked.length, men0: r.men0, hp, hpMax: this.hpMaxOf(r, r.parked.length), status: this.regimentStatus(r), order: 'idle', target: null, level: r.level, engaged: false, skillCooldown: 0, dashing: null, down: 0, routed: false, terrain: this.terrainAt(x, y), height: this.heightOf(x, y), radius: r.rad, reserve: true, enterIn: r.enterAt >= 0 ? r.enterAt - this.tick : -1 });
        continue;
      }
      if (r.owner === p) {
        let hp = 0;
        let down = 0;
        for (const sid of r.slots) {
          const s = this.soldiers[sid];
          hp += s.hp;
          if (s.downUntil > this.tick) down += 1;
        }
        regiments.push({
          id: r.id,
          kind: r.kind,
          x: r.x,
          y: r.y,
          facing: r.facing,
          width: r.formation === 'square' ? r.shape.files : r.width,
          formation: r.formation,
          stance: r.stance,
          men: r.slots.length,
          men0: r.men0,
          hp,
          hpMax: this.hpMaxOf(r, r.slots.length),
          status: this.regimentStatus(r),
          order: r.dash !== null ? r.dash.def.kind : r.order,
          target: r.target >= 0 ? r.target : null,
          level: r.level,
          engaged: this.tick - r.lastMelee <= 10,
          skillCooldown: Math.max(0, r.skillReadyAt - this.tick),
          dashing: r.dash !== null ? r.dash.def.kind : null,
          down,
          routed: r.routed,
          terrain: this.terrainAt(r.x, r.y),
          height: this.heightOf(r.x, r.y),
          radius: r.rad,
          reserve: false,
          enterIn: -1,
        });
      } else if (this.visible[p][r.id] === 1) {
        enemies.push({
          id: r.id,
          owner: r.owner,
          kind: r.kind,
          x: r.x,
          y: r.y,
          facing: r.facing,
          width: r.formation === 'square' ? r.shape.files : r.width,
          formation: r.formation,
          stance: r.stance,
          men: r.slots.length,
          men0: r.men0,
          status: this.regimentStatus(r),
          engaged: this.tick - r.lastMelee <= 10,
          dashing: r.dash !== null ? r.dash.def.kind : null,
          routed: r.routed,
          terrain: this.terrainAt(r.x, r.y),
          height: this.heightOf(r.x, r.y),
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
      flags: this.flags.map((f): FlagState => ({ id: f.id, name: f.name, x: f.x, y: f.y, owner: f.owner, capturer: f.capturer, progress: f.progress, contested: f.contested, points: f.points })),
      score: this.players.map((q) => this.scoreOf(q.id)),
      fieldCost: this.fieldCost(p),
      fieldCap: this.mode === 'capture' ? RULES.capture.fieldCap : RULES.budget,
      events,
    };
  }

  /** n 人時的血量上限（含老兵加成） */
  private hpMaxOf(r: Regiment, n: number): number {
    return idiv(n * r.def.hp * RULES.veteran.levels[r.level - 1].hp, 100);
  }

  /** 場上（含準備入場中）的點數：算全額 */
  fieldCost(p: number): number {
    let c = 0;
    for (const r of this.regiments) if (r.owner === p && !r.destroyed && (!r.reserve || r.enterAt >= 0)) c += r.def.cost;
    return c;
  }

  /** 不在場上：已覆滅或在後備（含準備入場中） */
  private gone(r: Regiment): boolean {
    return r.destroyed || r.reserve;
  }

  // ───────── 指令 ─────────

  applyCommands(p: number, raw: unknown): void {
    if (!Array.isArray(raw)) return;
    // 戰略意圖不佔指令額度；其餘指令依序最多 commandsPerDecision 個
    let n = 0;
    for (const c of raw) {
      if (typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'plan') {
        const text = (c as { text?: unknown }).text;
        if (typeof text === 'string') {
          this.players[p].plan = text.slice(0, RULES.planMax);
          this.players[p].planAt = this.tick;
        }
        continue;
      }
      if (n >= RULES.commandsPerDecision) break;
      n += 1;
      this.applyCommand(p, c, false);
    }
  }

  // ───────── 後備（佔點模式） ─────────

  /** r 所在的出生點（-1）或自己的補給站 id；都不在就是 null */
  private depotOf(r: Regiment): number | null {
    const sp = this.map.spawns[r.owner];
    const sr = RULES.capture.spawnRadius;
    if ((r.x - sp.x) * (r.x - sp.x) + (r.y - sp.y) * (r.y - sp.y) <= sr * sr) return -1;
    const rr = RULES.capture.supplyRadius;
    for (let i = 0; i < this.map.supplies.length; i++) {
      const su = this.map.supplies[i];
      if (this.flags[su.flag]?.owner !== r.owner) continue;
      if ((r.x - su.x) * (r.x - su.x) + (r.y - su.y) * (r.y - su.y) <= rr * rr) return i;
    }
    return null;
  }

  private reserveCommand(p: number, r: Regiment, type: string, c: Record<string, unknown>): void {
    if (this.mode !== 'capture') return this.rejectCmd(p, type, '只有佔點模式有後備');
    const cap = RULES.capture.fieldCap;
    if (type === 'summon') {
      if (!r.reserve || r.enterAt >= 0) return this.rejectCmd(p, type, '不是待命的後備');
      if (this.fieldCost(p) + r.def.cost > cap) return this.rejectCmd(p, type, `場上超過 ${cap} 點，要在出生點或補給站換兵`);
      const sp = this.map.spawns[p];
      const [x, y] = this.freeSpot(p, sp.x, sp.y, r);
      this.scheduleEnter(r, x, y);
      return;
    }
    // swap、withdraw：場上的團要在出生點或自己的補給站，而且沒在交戰、沒在衝刺
    if (r.reserve) return this.rejectCmd(p, type, '在後備');
    const at = this.depotOf(r);
    if (at === null) return this.rejectCmd(p, type, '不在出生點或自己的補給站');
    if (this.tick - r.lastMelee <= 30 || r.dash !== null) return this.rejectCmd(p, type, '交戰中不能撤回');
    if (type === 'swap') {
      const w = typeof c.with === 'number' ? this.regiments[c.with] : undefined;
      if (w === undefined || w.owner !== p || w.destroyed || !w.reserve || w.enterAt >= 0) return this.rejectCmd(p, type, '要換上的不是待命的後備');
      if (this.fieldCost(p) - r.def.cost + w.def.cost > cap) return this.rejectCmd(p, type, `換上後超過 ${cap} 點`);
      const x = r.x;
      const y = r.y;
      this.withdraw(r, at);
      this.scheduleEnter(w, x, y);
      return;
    }
    this.withdraw(r, at);
  }

  /** 撤回後備：血量補滿、人數不變 */
  private withdraw(r: Regiment, at: number): void {
    const full = idiv(r.def.hp * RULES.veteran.levels[r.level - 1].hp, 100);
    for (const sid of r.slots) {
      const so = this.soldiers[sid];
      so.hp = full;
      so.alive = false;
    }
    r.parked = r.slots;
    r.slots = [];
    r.reserve = true;
    r.enterAt = -1;
    this.resetOrders(r);
    this.emit({ type: 'withdraw', tick: this.tick, reg: r.id, at });
  }

  private scheduleEnter(r: Regiment, x: number, y: number): void {
    r.enterAt = this.tick + RULES.capture.enterTicks;
    r.enterX = x;
    r.enterY = y;
  }

  private resetOrders(r: Regiment): void {
    r.order = 'idle';
    r.target = -1;
    r.fireTarget = -1;
    r.followId = -1;
    r.brace = 0;
    r.wall = 0;
    r.volley = null;
    r.pending = null;
    r.queued = null;
    r.path = [];
    r.tFacing = -1;
    r.lastMelee = -1000;
  }

  /** 入場位置：從 (x, y) 開始往兩側找，避開自己場上與準備入場的團 */
  private freeSpot(p: number, x: number, y: number, me: Regiment): [number, number] {
    const offsets = [0, 8, -8, 16, -16, 24, -24, 32, -32];
    for (const oy of offsets) {
      for (const ox of [0, p === 0 ? 7 : -7]) {
        const cx = x + ox * TILE;
        const cy = y + (p === 0 ? oy : -oy) * TILE;
        if (cy < TILE || cy > this.map.height * TILE - TILE || !walkable(this.terrainAt(cx, cy))) continue;
        let ok = true;
        for (const o of this.regiments) {
          if (o === me || o.owner !== p || o.destroyed || (o.reserve && o.enterAt < 0)) continue;
          const qx = o.reserve ? o.enterX : o.x;
          const qy = o.reserve ? o.enterY : o.y;
          const lim = o.rad + me.rad;
          if ((qx - cx) * (qx - cx) + (qy - cy) * (qy - cy) < lim * lim) ok = false;
        }
        if (ok) return [cx, cy];
      }
    }
    return [x, y];
  }

  /** 準備好的後備入場；出生點、自己的補給站裡沒受傷一陣子的團回血 */
  private stepReserves(): void {
    for (const r of this.regiments) {
      if (r.destroyed || !r.reserve || r.enterAt < 0 || this.tick < r.enterAt) continue;
      r.reserve = false;
      r.enterAt = -1;
      r.x = r.enterX;
      r.y = r.enterY;
      r.px = r.x;
      r.py = r.y;
      r.facing = r.owner === 0 ? 0 : 180;
      r.pf = r.facing;
      r.tx = r.x;
      r.ty = r.y;
      r.slots = r.parked;
      r.parked = [];
      this.resetOrders(r);
      r.slots.forEach((sid, i) => {
        const so = this.soldiers[sid];
        so.alive = true;
        so.ord = i;
        so.cd = 0;
        so.target = -1;
        so.downUntil = -1;
        so.dashing = false;
        so.mom = 0;
        so.struck = [];
      });
      this.layout(r, true);
      for (const sid of r.slots) {
        const so = this.soldiers[sid];
        so.x = so.sx;
        so.y = so.sy;
      }
      const at = this.depotOf(r);
      this.emit({ type: 'enter', tick: this.tick, reg: r.id, at: at ?? -1 });
    }
    if (this.tick % TPS !== 0) return;
    for (const r of this.regiments) {
      if (this.gone(r) || this.tick - r.lastHit <= RULES.capture.healQuietTicks || this.depotOf(r) === null) continue;
      const full = idiv(r.def.hp * RULES.veteran.levels[r.level - 1].hp, 100);
      const add = Math.max(1, idiv(full * RULES.capture.healPct, 100));
      for (const sid of r.slots) {
        const so = this.soldiers[sid];
        so.hp = Math.min(full, so.hp + add);
      }
    }
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
    if (typeof c.intent === 'string' && c.intent.length > 0) {
      r.intent = c.intent.slice(0, RULES.intentMax);
      r.intentAt = this.tick;
    }
    if (type === 'summon' || type === 'swap' || type === 'withdraw') return this.reserveCommand(p, r, type, c);
    if (r.reserve) return this.rejectCmd(p, type, '在後備，要先入場');
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? roundHalfEven(v) : null);
    // 衝刺中：只接受微調方向，其他指令等衝完再執行
    if (r.dash !== null) {
      if (type === 'steer') {
        const f = num(c.facing);
        if (f === null) return this.rejectCmd(p, type, '角度不合法');
        r.dash.dir = normDeg(f);
        return;
      }
      r.queued = raw as LegionCommand;
      return;
    }
    const enemy = (): Regiment | null => {
      const t = num(c.target);
      const tr = t === null ? undefined : this.regiments[t];
      if (tr === undefined || tr.owner === p || this.gone(tr) || this.visible[p][tr.id] !== 1) return null;
      return tr;
    };
    // 槍林、盾牆中：先收起，收完再執行（槍林、盾兵姿態、陣形、意圖例外）
    const needsFree = type === 'move' || type === 'attackMove' || type === 'attack' || type === 'face' || type === 'follow' || type === 'charge' || type === 'assault' || type === 'infiltrate';
    if (needsFree && !fromPending && (r.brace !== 0 || r.wall !== 0)) {
      if (r.brace === 1 || r.brace === 2) {
        r.brace = 3;
        r.braceTimer = RULES.brace.unsetTicks;
      }
      if (r.wall === 1 || r.wall === 2) {
        r.wall = 3;
        r.wallTimer = RULES.shield.wallUnsetTicks;
      }
      r.pending = raw as LegionCommand;
      return;
    }
    const moving = type === 'move' || type === 'attackMove' || type === 'attack' || type === 'follow';
    if (moving && r.formation === 'circle') return this.rejectCmd(p, type, '圓陣不能移動，先換陣形');
    switch (type) {
      case 'move':
      case 'attackMove': {
        const x = num(c.x);
        const y = num(c.y);
        if (x === null || y === null) return this.rejectCmd(p, type, '座標不合法');
        const tx = Math.max(0, Math.min(this.map.width * TILE - 1, x));
        const ty = Math.max(0, Math.min(this.map.height * TILE - 1, y));
        const f = num(c.facing);
        const near = (tx - r.tx) * (tx - r.tx) + (ty - r.ty) * (ty - r.ty) <= RULES.sameGoal * RULES.sameGoal;
        r.tFacing = type === 'move' && f !== null ? normDeg(f) : -1;
        r.volley = null;
        // 與目前目的地幾乎相同的同類指令：只更新目的地（避免反覆重新規劃造成原地打轉）
        if (r.order === type && near) {
          r.tx = tx;
          r.ty = ty;
          return;
        }
        r.order = type;
        r.tx = tx;
        r.ty = ty;
        r.target = -1;
        r.fireTarget = -1;
        r.path = [];
        return;
      }
      case 'attack': {
        const t = enemy();
        if (t === null) return this.rejectCmd(p, type, '目標不存在或看不到');
        r.order = 'attack';
        r.target = t.id;
        r.lastSeenX = t.x;
        r.lastSeenY = t.y;
        r.fireTarget = -1;
        r.volley = null;
        r.path = [];
        return;
      }
      case 'follow': {
        const t = num(c.target);
        const tr = t === null ? undefined : this.regiments[t];
        if (tr === undefined || tr.owner !== p || this.gone(tr) || tr.id === r.id) return this.rejectCmd(p, type, '跟隨的對象必須是自己的另一團');
        r.order = 'follow';
        r.followId = tr.id;
        r.followFwd = num(c.forward) ?? 0;
        r.followRight = num(c.right) ?? 0;
        r.target = -1;
        r.volley = null;
        r.path = [];
        return;
      }
      case 'hold':
        if (r.brace === 3 || r.wall === 3) r.pending = null;
        r.order = 'hold';
        r.target = -1;
        r.path = [];
        return;
      case 'face': {
        const f = num(c.facing);
        if (f === null) return this.rejectCmd(p, type, '角度不合法');
        r.order = 'idle';
        r.target = -1;
        r.path = [];
        r.tFacing = normDeg(f);
        return;
      }
      case 'formation': {
        const f = c.formation;
        if (typeof f === 'string' && f !== r.formation) {
          if (!r.def.formations.includes(f as FormationKind)) return this.rejectCmd(p, type, `${r.def.name}不能用這個陣形`);
          if (r.brace !== 0 || r.wall !== 0) return this.rejectCmd(p, type, '槍林、盾牆中不能換陣形');
          r.formation = f as FormationKind;
          r.switchUntil = this.tick + RULES.formationSwitchTicks;
          if (r.formation === 'circle') {
            r.order = 'hold';
            r.path = [];
          }
        }
        const w = num(c.width);
        if (w !== null) {
          if (r.formation === 'line') r.width = Math.max(1, Math.min(r.men0, w));
          else if (r.formation === 'square') r.depth = Math.max(2, Math.ceil(r.slots.length / Math.max(1, w)));
        }
        return;
      }
      case 'brace': {
        if (r.kind !== 'spear') return this.rejectCmd(p, type, '只有長槍方陣能用槍林');
        if (r.brace === 1 || r.brace === 2) return undefined;
        const f = num(c.facing);
        r.brace = 1;
        r.braceTimer = RULES.brace.setTicks;
        r.braceFacing = f !== null ? normDeg(f) : r.facing;
        r.order = 'hold';
        r.path = [];
        r.pending = null;
        this.emit({ type: 'skill', tick: this.tick, reg: r.id, skill: 'brace' });
        return;
      }
      case 'unbrace':
        if (r.brace === 1 || r.brace === 2) {
          r.brace = 3;
          r.braceTimer = RULES.brace.unsetTicks;
        }
        r.pending = null;
        return;
      case 'shield': {
        if (r.kind !== 'shield') return this.rejectCmd(p, type, '只有盾兵能換姿態');
        const mode = c.mode;
        if (mode === 'wall') {
          if (r.wall === 1 || r.wall === 2) return undefined;
          if (r.formation === 'circle' || this.tick < r.switchUntil) return this.rejectCmd(p, type, '換陣形中不能架盾牆');
          r.wall = 1;
          r.wallTimer = RULES.shield.wallSetTicks;
          r.order = 'hold';
          r.path = [];
          r.pending = null;
          this.emit({ type: 'skill', tick: this.tick, reg: r.id, skill: 'wall' });
          return;
        }
        if (mode === 'unwall') {
          if (r.wall === 1 || r.wall === 2) {
            r.wall = 3;
            r.wallTimer = RULES.shield.wallUnsetTicks;
          }
          r.pending = null;
          return;
        }
        if (mode !== 'carry' && mode !== 'raise') return this.rejectCmd(p, type, '姿態只有 carry、raise、wall、unwall');
        if (r.stance !== mode) {
          r.stanceNext = mode;
          r.stanceAt = this.tick + RULES.shield.switchTicks;
        }
        return;
      }
      case 'volley': {
        if (r.kind !== 'archer') return this.rejectCmd(p, type, '只有弓兵能齊射');
        if (this.tick < r.skillReadyAt) return this.rejectCmd(p, type, '齊射冷卻中');
        const x = num(c.x);
        const y = num(c.y);
        if (x === null || y === null) return this.rejectCmd(p, type, '座標不合法');
        const range = r.def.range + RULES.height.rangePerLevel * clampLevel(this.heightOf(r.x, r.y) - this.heightOf(x, y));
        if ((x - r.x) * (x - r.x) + (y - r.y) * (y - r.y) > range * range) return this.rejectCmd(p, type, '落點超出射程');
        r.volley = { x, y, until: this.tick + RULES.volley.duration };
        r.skillReadyAt = this.tick + RULES.volley.cooldown;
        r.order = 'hold';
        r.fireTarget = -1;
        r.path = [];
        this.emit({ type: 'skill', tick: this.tick, reg: r.id, skill: 'volley' });
        return;
      }
      case 'charge':
      case 'assault':
      case 'infiltrate': {
        const d = dashDefOf(r.kind);
        if (d === null || d.kind !== type) return this.rejectCmd(p, type, `${r.def.name}沒有這個技能`);
        if (!this.canDash(r)) return this.rejectCmd(p, type, this.tick < r.skillReadyAt ? '技能冷卻中' : '現在不能衝刺（地形、陣形或姿態）');
        let dir: number | null = null;
        const f = num(c.facing);
        const x = num(c.x);
        const y = num(c.y);
        const t = c.target !== undefined ? enemy() : null;
        if (t !== null) dir = iatan2(t.y - r.y, t.x - r.x);
        else if (x !== null && y !== null && (x !== r.x || y !== r.y)) dir = iatan2(y - r.y, x - r.x);
        else if (f !== null) dir = normDeg(f);
        if (dir === null) return this.rejectCmd(p, type, '要指定方向、地點或目標');
        this.startDash(r, d, dir);
        return;
      }
      case 'steer':
        return this.rejectCmd(p, type, '不在衝刺中');
      default:
        return this.rejectCmd(p, type, '沒有這個指令');
    }
  }

  private startDash(r: Regiment, def: DashDef, dir: number): void {
    const mom = idiv(def.momentum * (r.formation === 'wedge' ? RULES.dash.wedgeMomentum : 100), 100);
    r.dash = { def, dir, aligning: true, left: def.dist, travel: 0, speed: this.baseSpeed(r), boost: 100, mom0: mom, firstTarget: -1, flank: 'front', contacted: false, kills: 0, downed: 0, braced: false };
    r.skillReadyAt = this.tick + def.cooldown;
    r.queued = null;
    r.path = [];
    r.volley = null;
    r.penetrateUntil = -1;
    for (const sid of r.slots) {
      const s = this.soldiers[sid];
      s.dashing = true;
      s.mom = mom;
      s.struck = [];
      s.firstHit = def.kind === 'assault';
      s.dmgWin = 0;
    }
    this.emit({ type: 'skill', tick: this.tick, reg: r.id, skill: def.kind });
  }

  private endDash(r: Regiment): void {
    const d = r.dash;
    if (d === null) return;
    r.dash = null;
    for (const sid of r.slots) this.soldiers[sid].dashing = false;
    if (d.contacted) this.emit({ type: 'impact', tick: this.tick, reg: r.id, kind: d.def.kind, target: d.firstTarget, kills: d.kills, downed: d.downed, braced: d.braced, flank: d.flank });
    r.path = [];
    const q = r.queued;
    r.queued = null;
    const hit = this.alive(d.firstTarget);
    if (d.def.kind !== 'charge' && hit !== null) {
      r.order = 'attack';
      r.target = hit.id;
      r.lastSeenX = hit.x;
      r.lastSeenY = hit.y;
    } else {
      r.order = 'idle';
      r.target = -1;
    }
    r.tFacing = -1;
    if (q !== null) this.applyCommand(r.owner, q, false);
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
    if (this.mode === 'capture') this.stepReserves();
    for (const r of this.regiments) if (!this.gone(r)) this.think(r);
    for (const r of this.regiments) if (!this.gone(r)) this.layout(r, false);
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
      const dx = this.nx[so.id] - so.x;
      const dy = this.ny[so.id] - so.y;
      so.spd = dx === 0 && dy === 0 ? 0 : isqrt(dx * dx + dy * dy);
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
    const [tx, ty] = tileXY(x, y, this.map.width, this.map.height);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return T.River;
    return this.map.terrain[ty * this.map.width + tx];
  }

  private alive(id: number): Regiment | null {
    const r = id >= 0 ? this.regiments[id] : undefined;
    return r === undefined || this.gone(r) ? null : r;
  }

  /** 平常的移動速度（盾兵依姿態） */
  private baseSpeed(r: Regiment): number {
    if (r.stance === 'raise') return RULES.shield.raise.speed;
    if (r.stance === 'carry') return RULES.shield.carry.speed;
    return r.def.speed;
  }

  /** 依高低差調整移動速度 */
  private slope(speed: number, x0: number, y0: number, x1: number, y1: number): number {
    const dh = this.heightOf(x1, y1) - this.heightOf(x0, y0);
    if (dh > 0) return idiv(speed * RULES.height.uphillSpeed, 100);
    if (dh < 0) return idiv(speed * RULES.height.downhillSpeed, 100);
    return speed;
  }

  private think(r: Regiment): void {
    r.moved = false;
    if (r.routed) {
      const ex = this.map.rearX[r.owner] === 0 ? 300 : this.map.width * TILE - 300;
      this.moveTo(r, ex, r.y, 0, idiv(this.baseSpeed(r) * RULES.routSpeed, 100), true);
      return;
    }
    if (r.stanceNext !== null && this.tick >= r.stanceAt) {
      r.stance = r.stanceNext;
      r.stanceNext = null;
    }
    if (r.volley !== null && this.tick >= r.volley.until) r.volley = null;
    if (r.brace === 1) {
      if (Math.abs(angleDiff(r.braceFacing, r.facing)) > 2) this.turnTo(r, r.braceFacing);
      else if (--r.braceTimer <= 0) r.brace = 2;
    } else if (r.brace === 3 && --r.braceTimer <= 0) this.unset(r, 'brace');
    if (r.wall === 1 && --r.wallTimer <= 0) r.wall = 2;
    else if (r.wall === 3 && --r.wallTimer <= 0) this.unset(r, 'wall');
    if (r.dash !== null) return this.thinkDash(r);
    if (r.brace !== 0 || r.wall !== 0) return;
    if (r.volley !== null) {
      const v = r.volley;
      if (v.x !== r.x || v.y !== r.y) this.turnTo(r, iatan2(v.y - r.y, v.x - r.x));
      return;
    }
    if (r.def.range > 0 && this.tick % 5 === 0 && r.order !== 'attack' && r.order !== 'move' && r.order !== 'follow') this.setFire(r, this.acquire(r, r.def.range));
    const speed = this.baseSpeed(r);
    switch (r.order) {
      case 'idle':
      case 'hold':
        if (r.tFacing >= 0) this.turnTo(r, r.tFacing);
        if (r.def.range === 0 && r.order === 'idle') r.target = -1;
        return;
      case 'move':
        if (this.moveTo(r, r.tx, r.ty, 0, speed, false)) r.order = 'idle';
        return;
      case 'follow': {
        const t = this.alive(r.followId);
        if (t === null || t.routed) {
          r.order = 'idle';
          return;
        }
        const c = icos(t.pf);
        const s = isin(t.pf);
        const gx = t.px + tdiv(r.followFwd * c - r.followRight * s, 10000);
        const gy = t.py + tdiv(r.followFwd * s + r.followRight * c, 10000);
        if (this.moveTo(r, gx, gy, 0, speed, false)) this.turnTo(r, t.pf);
        return;
      }
      case 'attackMove': {
        if (this.tick % 5 === 0 && this.alive(r.target) === null) r.target = r.def.range > 0 ? -1 : this.acquire(r, r.def.sight);
        const t = this.alive(r.target);
        if (r.def.range > 0) {
          if (r.fireTarget >= 0) return this.approach(r, this.regiments[r.fireTarget]);
        } else if (t !== null && this.visible[r.owner][t.id] === 1) return this.approach(r, t);
        if (this.moveTo(r, r.tx, r.ty, 0, speed, false)) r.order = 'idle';
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
        if (this.moveTo(r, r.lastSeenX, r.lastSeenY, 0, speed, false)) {
          r.order = 'idle';
          r.target = -1;
        }
        return;
      }
    }
  }

  /** 收完槍林或盾牆：執行等待中的指令 */
  private unset(r: Regiment, what: 'brace' | 'wall'): void {
    if (what === 'brace') r.brace = 0;
    else r.wall = 0;
    if (r.brace !== 0 || r.wall !== 0) return;
    const pend = r.pending;
    r.pending = null;
    if (pend !== null) this.applyCommand(r.owner, pend, true);
  }

  private thinkDash(r: Regiment): void {
    const d = r.dash!;
    if (d.aligning) {
      // 起步前先轉到衝刺方向（一般的轉向速度）
      if (Math.abs(angleDiff(d.dir, r.facing)) > 10) {
        this.turnTo(r, d.dir);
        return;
      }
      d.aligning = false;
    }
    r.facing = turnToward(r.facing, d.dir, d.def.turn);
    const base = this.baseSpeed(r);
    let speed = d.def.runup > 0 ? base + idiv((d.def.speed - base) * Math.min(d.travel, d.def.runup), d.def.runup) : d.def.speed;
    speed = idiv(speed * d.boost, 100);
    const [ox, oy] = offset(r.facing, speed);
    const nx = r.x + ox;
    const ny = r.y + oy;
    const t = this.terrainAt(nx, ny);
    const blocked = d.def.kind === 'charge' ? stopsCavalry(t) : !walkable(t);
    let anyone = false;
    for (const sid of r.slots) if (this.soldiers[sid].dashing) anyone = true;
    if (blocked || d.left <= 0 || !anyone) {
      this.endDash(r);
      return;
    }
    const dh = this.heightOf(nx, ny) - this.heightOf(r.x, r.y);
    if (dh < 0) d.boost = Math.min(RULES.height.dashMax, d.boost - dh * RULES.height.dashDown);
    else if (dh > 0) d.boost = Math.max(RULES.height.dashMin, d.boost - dh * RULES.height.dashUp);
    r.x = nx;
    r.y = ny;
    d.travel += speed;
    d.left -= speed;
    d.speed = speed;
    r.moved = true;
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
    if (t.px !== r.x || t.py !== r.y) this.turnTo(r, iatan2(t.py - r.y, t.px - r.x));
  }

  /** 轉向：沒在接戰的步兵要轉超過 120° 時直接向後轉（士兵原地轉身），其餘依轉向速度慢慢轉 */
  private turnTo(r: Regiment, want: number): void {
    if (!r.def.cavalry && r.formation !== 'circle' && this.tick - r.lastMelee > 10 && Math.abs(angleDiff(want, r.facing)) > RULES.aboutFace) this.aboutFace(r);
    r.facing = turnToward(r.facing, want, r.def.turn);
  }

  /** 向後轉：朝向翻轉 180°，隊形序號反轉，士兵不用穿過自己的隊伍 */
  private aboutFace(r: Regiment): void {
    r.facing = normDeg(r.facing + 180);
    r.slots.reverse();
    r.slots.forEach((sid, i) => (this.soldiers[sid].ord = i));
  }

  /** 射程（依自己與目標位置的高低差） */
  private rangeTo(r: Regiment, x: number, y: number, fromX = r.x, fromY = r.y): number {
    return r.def.range + RULES.height.rangePerLevel * clampLevel(this.heightOf(fromX, fromY) - this.heightOf(x, y));
  }

  /** 目標在 t 方向上的伸展：沿 t 朝向為 halfD、側向為 halfW */
  private extentToward(t: Regiment, fromX: number, fromY: number): number {
    const a = angleDiff(iatan2(fromY - t.py, fromX - t.px), t.pf);
    return idiv(Math.abs(icos(a)) * t.halfD + Math.abs(isin(a)) * t.halfW, 10000);
  }

  private approach(r: Regiment, t: Regiment): void {
    const d = isqrt((t.px - r.x) * (t.px - r.x) + (t.py - r.y) * (t.py - r.y));
    const speed = this.baseSpeed(r);
    if (r.def.range > 0) {
      const range = this.rangeTo(r, t.px, t.py);
      if (d - idiv(t.rad, 2) <= range - 1000) {
        this.setFire(r, t.id);
        if (!this.fireStalled(r)) {
          this.faceTo(r, t);
          return;
        }
      } else this.setFire(r, -1);
      this.moveTo(r, t.px, t.py, 0, speed, false);
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
    this.moveTo(r, t.px, t.py, contact, speed, false);
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
        if (r.tFacing >= 0 && !routed) this.turnTo(r, r.tFacing);
        return true;
      }
      r.pathIdx += 1;
      return false;
    }
    const want = iatan2(dy, dx);
    let diff = Math.abs(angleDiff(want, r.facing));
    // 步兵短距離往後挪：面向不變、倒退走（速度減半）
    const backing = !routed && !r.def.cavalry && last && diff > RULES.aboutFace && remain <= RULES.backStep;
    if (routed) r.facing = want;
    else if (!backing) {
      this.turnTo(r, want);
      diff = Math.abs(angleDiff(want, r.facing));
    }
    // 轉向太大時先原地轉再走：騎兵 60°、步兵 90°（潰散與倒退不受限）
    if (!routed && !backing && diff > (r.def.cavalry ? 60 : 90)) return false;
    let speed = idiv(baseSpeed * terrainSpeed(this.terrainAt(r.x, r.y), r.kind), 100);
    if (backing) speed = idiv(speed, 2);
    // 隊形散開時放慢，等士兵跟上
    if (r.lag > 2000) speed = idiv(speed, 2);
    const step = Math.min(speed, remain);
    const [nx0, ny0] = stepToward(r.x, r.y, wx, wy, step);
    const step2 = this.slope(step, r.x, r.y, nx0, ny0);
    const [nx, ny] = step2 === step ? [nx0, ny0] : stepToward(r.x, r.y, wx, wy, Math.min(step2, remain));
    r.x = nx;
    r.y = ny;
    r.moved = true;
    if (remain - step <= 0 && !last) r.pathIdx += 1;
    return false;
  }

  /** 看得到的最近敵軍（中心距離 − 半個半徑 ≤ range，依高低差調整）；沒有回傳 -1 */
  private acquire(r: Regiment, range: number): number {
    let best = -1;
    let bestD = Infinity;
    for (const t of this.regiments) {
      if (this.gone(t) || t.owner === r.owner || this.visible[r.owner][t.id] !== 1) continue;
      const lim = r.def.range > 0 ? this.rangeTo(r, t.px, t.py) : range;
      const d = isqrt((t.px - r.x) * (t.px - r.x) + (t.py - r.y) * (t.py - r.y)) - idiv(t.rad, 2);
      if (d <= lim && d < bestD) {
        bestD = d;
        best = t.id;
      }
    }
    return best;
  }

  // ───────── 隊形 ─────────

  /** 依陣形算出形狀（人數、橫寬、厚度或縮窄改變時才重算） */
  private shapeOf(r: Regiment, n: number): FormationShape {
    const narrow = r.corridor > 0 && r.formation !== 'circle';
    const key = `${r.formation}|${n}|${r.width}|${r.depth}|${narrow ? r.corridor : 0}`;
    if (key === r.shapeKey) return r.shape;
    const natural = formationShape(r.formation, n, r.width, r.depth, r.def.spacingX, r.def.spacingY);
    // 過窄處：改成縱隊（橫寬依可通行寬度）
    r.shape = narrow && r.corridor < natural.files ? grid(n, r.corridor, r.def.spacingX, r.def.spacingY) : natural;
    r.shapeKey = key;
    return r.shape;
  }

  /** 隊形縮窄：橫排兩端連線可通行的最大寬度（移動中多看前方）；最窄步兵 3 人、騎兵 2 騎；0 = 不用縮 */
  private corridorWidth(r: Regiment, want: number): number {
    if (r.formation === 'circle') return 0;
    const floor = Math.min(want, r.def.cavalry ? 2 : 3);
    const ahead = r.moved ? [0, 2000, 4000] : [0];
    const c = icos(r.facing);
    const s = isin(r.facing);
    for (let w = want; w > floor; w = w > 8 ? w - 2 : w - 1) {
      const half = idiv((w - 1) * r.def.spacingX, 2) + 300;
      let ok = true;
      for (const a of ahead) {
        const mx = r.x + tdiv(c * a, 10000);
        const my = r.y + tdiv(s * a, 10000);
        if (!clearLine(this.map, mx + tdiv(s * half, 10000), my - tdiv(c * half, 10000), mx - tdiv(s * half, 10000), my + tdiv(c * half, 10000))) {
          ok = false;
          break;
        }
      }
      if (ok) return w === want ? 0 : w;
    }
    return floor;
  }

  private layout(r: Regiment, force: boolean): void {
    const n = r.slots.length;
    if (n === 0) return;
    if (force || r.moved || (this.tick + r.k) % 10 === 0) {
      const natural = formationShape(r.formation, n, r.width, r.depth, r.def.spacingX, r.def.spacingY);
      r.corridor = this.corridorWidth(r, natural.files);
    }
    const shape = this.shapeOf(r, n);
    r.halfW = shape.halfW;
    r.halfD = shape.halfD;
    r.rad = shape.rad;
    const c = icos(r.facing);
    const s = isin(r.facing);
    const off = shape.offsets;
    let lag = 0;
    for (let ord = 0; ord < n; ord++) {
      const sol = this.soldiers[r.slots[ord]];
      const fwd = off[ord * 2];
      const lat = off[ord * 2 + 1];
      let x = r.x + tdiv(fwd * c - lat * s, 10000);
      let y = r.y + tdiv(fwd * s + lat * c, 10000);
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
      if (this.gone(a)) continue;
      for (let j = i + 1; j < regs.length; j++) {
        const b = regs[j];
        if (this.gone(b) || b.owner === a.owner) continue;
        const lim = a.rad + b.rad + 4000;
        if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= lim * lim) {
          a.nearEnemy = true;
          b.nearEnemy = true;
        }
      }
    }
  }

  // ───────── 士兵 ─────────

  private nearestEnemy(s: Soldier, radius: number, skipDown = false): number {
    const g = this.grid;
    const k = Math.ceil(radius / TILE);
    const [sx0, sy0] = tileXY(s.x, s.y, g.w, g.h);
    const cx = Math.min(g.w - 1, Math.max(0, sx0));
    const cy = Math.min(g.h - 1, Math.max(0, sy0));
    let best = -1;
    let bestD = radius * radius;
    for (let y = Math.max(0, cy - k); y <= Math.min(g.h - 1, cy + k); y++) {
      for (let x = Math.max(0, cx - k); x <= Math.min(g.w - 1, cx + k); x++) {
        for (let id = g.head[y * g.w + x]; id !== -1; id = g.next[id]) {
          const o = this.soldiers[id];
          if (o.owner === s.owner || !o.alive) continue;
          if (skipDown && (o.downUntil > this.tick || s.struck.includes(id))) continue;
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
    if (!r.nearEnemy || r.routed || r.brace !== 0 || r.wall !== 0 || r.dash !== null || r.volley !== null) return 0;
    if (r.def.range > 0 && r.fireTarget >= 0) return 0;
    if (r.order === 'move' || r.order === 'follow') return 0;
    if (r.order === 'attack' || r.target >= 0 || this.tick - r.lastMelee <= 10) return RULES.soldier.engageAttack;
    return RULES.soldier.engageIdle;
  }

  /**
   * 士兵移動：只讀取 tick 開始時的位置，結果寫入緩衝區，全部算完才一起套用（處理順序不影響結果）。
   */
  private moveSoldier(s: Soldier): void {
    const r = this.regiments[s.reg];
    if (s.downUntil > this.tick) {
      this.nx[s.id] = s.x;
      this.ny[s.id] = s.y;
      return;
    }
    let speed = idiv(this.baseSpeed(r) * terrainSpeed(this.terrainAt(s.x, s.y), r.kind), 100);
    if (r.routed) speed = idiv(speed * RULES.routSpeed, 100);
    const dashing = r.dash !== null && s.dashing;
    if (dashing && r.dash!.speed > speed) speed = r.dash!.speed;
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
          const stop = r.def.reach - 150;
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
      const [px, py] = stepToward(x, y, gx, gy, speed);
      const sp = dashing ? speed : this.slope(speed, x, y, px, py);
      const [nx, ny] = sp === speed ? [px, py] : stepToward(x, y, gx, gy, sp);
      [x, y] = this.slide(x, y, nx, ny);
    }
    // 槍林、盾牆：原地不動、不被推開（霸體）；衝刺中、突擊擠進敵陣時不和敵兵互推
    const hold = r.brace === 2 || r.wall === 2;
    if (r.nearEnemy && !hold) [x, y] = this.separate(s, x, y, dashing || r.penetrateUntil > this.tick);
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

  /** 推擠：以自己移動後的位置對其他士兵 tick 開始時的位置；倒地的人不擋路 */
  private separate(s: Soldier, x: number, y: number, ignoreEnemy: boolean): [number, number] {
    const g = this.grid;
    const [qx, qy] = tileXY(x, y, g.w, g.h);
    const cx = Math.min(g.w - 1, Math.max(0, qx));
    const cy = Math.min(g.h - 1, Math.max(0, qy));
    const side = s.owner === 0 ? 1 : -1;
    let px = 0;
    let py = 0;
    for (let ty = Math.max(0, cy - 1); ty <= Math.min(g.h - 1, cy + 1); ty++) {
      for (let tx = Math.max(0, cx - 1); tx <= Math.min(g.w - 1, cx + 1); tx++) {
        for (let id = g.head[ty * g.w + tx]; id !== -1; id = g.next[id]) {
          if (id === s.id) continue;
          const o = this.soldiers[id];
          if (!o.alive || o.downUntil > this.tick) continue;
          const friend = o.owner === s.owner;
          if (!friend && ignoreEnemy) continue;
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

  // ───────── 傷害計算 ─────────

  flankOf(a: Regiment, t: Regiment): Flank {
    const key = a.id * 4096 + t.id;
    const memo = this.flankMemo.get(key);
    if (memo !== undefined) return memo;
    let f: Flank = 'front';
    if (t.formation !== 'circle' && (a.x !== t.x || a.y !== t.y)) {
      const d = Math.abs(angleDiff(iatan2(a.y - t.y, a.x - t.x), t.facing));
      const front = t.formation === 'wedge' ? RULES.flank.wedgeFrontHalf : RULES.flank.frontHalf;
      f = d <= front ? 'front' : d >= 180 - RULES.flank.rearHalf ? 'rear' : 'side';
    }
    this.flankMemo.set(key, f);
    return f;
  }

  /** 衝刺中的方向判定：看衝刺的行進方向（從哪一面撞進來），不看兩團中心的相對位置——穿過敵陣時後面的騎兵仍是從正面撞 */
  dashFlank(a: Regiment, t: Regiment): Flank {
    if (t.formation === 'circle') return 'front';
    const d = Math.abs(angleDiff(normDeg(a.facing + 180), t.facing));
    const front = t.formation === 'wedge' ? RULES.flank.wedgeFrontHalf : RULES.flank.frontHalf;
    return d <= front ? 'front' : d >= 180 - RULES.flank.rearHalf ? 'rear' : 'side';
  }

  private vetPct(r: Regiment): number {
    return RULES.veteran.levels[r.level - 1].attack;
  }

  /** 槍林正面、盾牆正面 */
  private bracedFront(t: Regiment, fl: Flank): boolean {
    return t.brace === 2 && fl === 'front';
  }

  private walledFront(t: Regiment, fl: Flank): boolean {
    return t.wall === 2 && fl === 'front';
  }

  private wasDashing(e: Soldier): boolean {
    return this.dash0[e.id] === 1;
  }

  /** 霸體：免疫擊倒、擠開、推擠 */
  private superArmor(t: Regiment, e: Soldier, fl: Flank, byCavalry: boolean): boolean {
    if (t.brace === 2) return true;
    if (t.dash !== null && this.wasDashing(e) && t.dash.def.superArmor) return true;
    return this.walledFront(t, fl) && !byCavalry;
  }

  /** 受到傷害的百分比（所有減免相乘）；fl = 攻擊方在目標的哪一面 */
  private takenPct(e: Soldier, t: Regiment, fl: Flank, ranged: boolean): number {
    let dr: number;
    if (t.kind === 'shield') {
      if (this.walledFront(t, fl)) dr = ranged ? RULES.shield.wall.rangedDR : RULES.shield.wall.meleeDR;
      else {
        const st = t.stance === 'raise' ? RULES.shield.raise : RULES.shield.carry;
        dr = ranged ? st.rangedDR : st.meleeDR;
      }
    } else dr = ranged ? t.def.rangedDR : t.def.meleeDR;
    let pct = 100 - dr;
    if (this.bracedFront(t, fl)) pct = idiv(pct * (100 - RULES.brace.frontDR), 100);
    const terrain = this.terrainAt(e.x, e.y);
    if (ranged) {
      if (terrain === T.Forest) pct = idiv(pct * (100 - RULES.terrain.forestRangedDR), 100);
      if (t.kind !== 'shield' && this.shieldedBy(e)) pct = idiv(pct * (100 - RULES.shield.auraDR), 100);
    } else if (terrain === T.Shallow) pct = idiv(pct * RULES.terrain.shallowMeleeTaken, 100);
    return pct;
  }

  /** 有舉盾或盾牆的友軍盾兵罩著（不疊加） */
  private shieldedBy(e: Soldier): boolean {
    for (const sh of this.regiments) {
      if (this.gone(sh) || sh.routed || sh.kind !== 'shield' || sh.owner !== e.owner) continue;
      if (sh.stance !== 'raise' && sh.wall !== 2) continue;
      const lim = sh.rad + RULES.shield.auraRange;
      if ((sh.x - e.x) * (sh.x - e.x) + (sh.y - e.y) * (sh.y - e.y) <= lim * lim) return true;
    }
    return false;
  }

  private heightPct(ax: number, ay: number, bx: number, by: number, per: number): number {
    return 100 + per * clampLevel(this.heightOf(ax, ay) - this.heightOf(bx, by));
  }

  private damage(e: Soldier, amount: number, by: Regiment): void {
    if (!e.alive || amount <= 0) return;
    const before = e.hp;
    e.hp -= amount;
    by.dmgDealt += Math.min(amount, before);
    const t = this.regiments[e.reg];
    t.lastHit = this.tick;
    // 輕騎兵（沒有霸體的衝鋒）：短時間內受到大量傷害就被打斷
    if (e.dashing && t.dash !== null && t.dash.def.kind === 'charge' && !t.dash.def.superArmor) {
      if (this.tick - e.dmgWinStart > RULES.dash.interruptWindow) {
        e.dmgWinStart = this.tick;
        e.dmgWin = 0;
      }
      e.dmgWin += amount;
      if (e.dmgWin * 100 >= idiv(t.def.hp * RULES.veteran.levels[t.level - 1].hp, 100) * RULES.dash.interruptPct) e.dashing = false;
    }
    if (e.hp <= 0) {
      e.alive = false;
      e.target = -1;
      by.kills += 1;
      this.players[by.owner].kills += 1;
      this.players[e.owner].losses += 1;
      if (by.dash !== null) by.dash.kills += 1;
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

  // ───────── 戰鬥 ─────────

  /** 戰鬥：先依 tick 開始時的狀態決定所有攻擊與碰撞，再一起套用（同時結算，處理順序不影響結果） */
  private combat(): void {
    this.hits.length = 0;
    if (this.dash0.length < this.soldiers.length) this.dash0 = new Uint8Array(this.soldiers.length);
    for (const s of this.soldiers) this.dash0[s.id] = s.alive && s.dashing ? 1 : 0;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      const r = this.regiments[s.reg];
      if (s.downUntil > this.tick) continue;
      if (r.dash !== null && s.dashing && !r.dash.aligning) this.collide(s, r);
      // 槍林迎擊：衝進觸及範圍的敵人（正面、衝刺中）不管冷卻都會被刺
      if (r.brace === 2 && r.nearEnemy && this.counterStrike(s, r)) {
        if (s.cd > 0) s.cd -= 1;
        continue;
      }
      if (s.cd > 0) {
        s.cd -= 1;
        continue;
      }
      if (this.tick < r.switchUntil) continue;
      if (!r.nearEnemy && r.fireTarget < 0 && r.volley === null) continue;
      // 衝鋒中的騎兵不近戰（撞擊另外算）
      if (r.dash !== null && s.dashing && r.dash.def.kind === 'charge') continue;
      if (r.nearEnemy) {
        let e = s.target >= 0 ? this.soldiers[s.target] : null;
        const reach2 = r.def.reach * r.def.reach;
        if (e === null || !e.alive || (e.x - s.x) * (e.x - s.x) + (e.y - s.y) * (e.y - s.y) > reach2) {
          const id = this.nearestEnemy(s, r.def.reach);
          e = id >= 0 ? this.soldiers[id] : null;
        }
        if (e !== null) {
          s.cd = this.melee(s, r, e);
          continue;
        }
      }
      if (r.def.range > 0 && !r.moved && !r.routed) {
        if (r.volley !== null) s.cd = this.volleyShot(s, r);
        else if (r.fireTarget >= 0) s.cd = this.shoot(s, r) ? r.def.cooldown : 3;
      }
    }
    const h = this.hits;
    for (let i = 0; i < h.length; i += HIT_FIELDS) {
      const e = this.soldiers[h[i]];
      if (!e.alive) continue;
      if (h[i + 1] > 0) this.damage(e, h[i + 1], this.regiments[h[i + 2]]);
      if (!e.alive) continue;
      if (h[i + 3] !== 0 || h[i + 4] !== 0) this.place(e, e.x + h[i + 3], e.y + h[i + 4]);
      if (h[i + 5] === 1 && e.downUntil <= this.tick) {
        e.downUntil = this.tick + RULES.knockdownTicks;
        e.dashing = false;
        e.target = -1;
        const by = this.regiments[h[i + 2]];
        if (by.dash !== null) by.dash.downed += 1;
      }
      if (h[i + 6] > 0 && e.dashing) {
        e.mom -= h[i + 6];
        if (e.mom <= 0) e.dashing = false;
      }
    }
  }

  private queue(e: Soldier, dmg: number, by: Regiment, kx: number, ky: number, down: boolean, mom: number): void {
    this.hits.push(e.id, dmg, by.id, kx, ky, down ? 1 : 0, mom);
  }

  /** 衝刺中的士兵碰到敵兵：撞擊、擠開、扣衝勁、衝刺對撞 */
  private collide(s: Soldier, r: Regiment): void {
    const d = r.dash!;
    const id = this.nearestEnemy(s, RULES.dash.contact, true);
    if (id < 0) return;
    const e = this.soldiers[id];
    const t = this.regiments[e.reg];
    const fl = this.dashFlank(r, t);
    const cav = d.def.kind === 'charge';
    s.struck.push(e.id);
    if (!d.contacted) {
      d.contacted = true;
      d.firstTarget = t.id;
      d.flank = fl;
      this.revealOnAttack(r);
    }
    // 突擊：接觸後一段時間內可以擠進敵陣（每次接觸都延長）
    if (d.def.kind === 'assault') r.penetrateUntil = this.tick + RULES.dash.penetrateTicks;
    r.lastMelee = this.tick;
    const ratio = idiv(idiv(d.speed * 100, d.def.speed) * s.mom, d.mom0);
    // 衝刺對撞：比衝擊力
    const clash = t.dash !== null && this.wasDashing(e) && !t.dash.aligning;
    if (clash) {
      const mine = idiv(d.def.power * ratio, 100);
      const td = t.dash!;
      const theirs = idiv(idiv(td.def.power * idiv(td.speed * 100, td.def.speed), 100) * e.mom, td.mom0);
      const big = Math.max(mine, theirs, 1);
      // 打平或輸了：整團的衝刺停下（輸的一方被撞翻）
      if (Math.abs(mine - theirs) * 100 <= big * RULES.dash.clashTie) {
        s.dashing = false;
        d.left = 0;
      } else if (mine < theirs) {
        s.dashing = false;
        d.left = 0;
        if (!d.def.superArmor) this.queue(s, 0, t, 0, 0, true, 0);
      }
    }
    // 對被撞者的效果
    const immune = this.superArmor(t, e, fl, cav);
    const [px, py] = this.shoveVector(r, s, e, cav ? RULES.dash.shove : d.def.kind === 'assault' ? RULES.dash.pushAside : 0);
    if (cav) {
      const vs = VERSUS[r.kind][t.kind] ?? 100;
      let pct = idiv(idiv(this.vetPct(r) * vs, 100) * FLANK_PCT[fl], 100);
      pct = idiv(pct * this.heightPct(s.x, s.y, e.x, e.y, RULES.height.meleePerLevel), 100);
      pct = idiv(pct * d.boost, 100);
      const dmg = idiv(idiv(d.def.impact * ratio, 100) * idiv(pct * this.takenPct(e, t, fl, false), 100), 100);
      this.queue(e, dmg, r, immune ? 0 : px, immune ? 0 : py, !immune, 0);
    } else if (d.def.kind === 'assault' && !immune) {
      this.queue(e, 0, r, px, py, false, 0);
    }
    // 扣衝勁：阻擋值依對方姿態
    let block: number = RULES.dash.block;
    if (this.bracedFront(t, fl)) {
      block = RULES.dash.braceBlock;
      d.braced = true;
    } else if (this.walledFront(t, fl)) block = cav ? RULES.dash.wallBlockCavalry : 1_000_000;
    s.mom -= idiv(block * 100, d.boost);
    if (s.mom <= 0) s.dashing = false;
  }

  private counterStrike(s: Soldier, r: Regiment): boolean {
    if (this.tick < s.counterAt) return false;
    const id = this.nearestEnemy(s, RULES.brace.counterReach);
    if (id < 0) return false;
    const e = this.soldiers[id];
    if (!this.wasDashing(e)) return false;
    const t = this.regiments[e.reg];
    if (t.dash === null || this.dashFlank(t, r) !== 'front') return false;
    // 圓陣：槍頭朝向分散、厚度不足，沒有迎擊（只有一般出手，速度加成也打折）
    if (r.formation === 'circle') return false;
    this.melee(s, r, e);
    s.counterAt = this.tick + RULES.brace.counterTicks;
    return true;
  }

  /** 把被撞的人往衝刺方向的側邊推開 */
  private shoveVector(r: Regiment, s: Soldier, e: Soldier, dist: number): [number, number] {
    if (dist === 0) return [0, 0];
    const c = icos(r.facing);
    const n = isin(r.facing);
    // 右手方向 (−sin, cos)；看被撞的人在哪一側
    const side = (e.x - s.x) * -n + (e.y - s.y) * c >= 0 ? 1 : -1;
    return [tdiv(-n * dist * side, 10000), tdiv(c * dist * side, 10000)];
  }

  /** 近戰一擊；回傳冷卻 */
  private melee(s: Soldier, r: Regiment, e: Soldier): number {
    const t = this.regiments[e.reg];
    const fl = this.flankOf(r, t);
    const vs = VERSUS[r.kind][t.kind] ?? 100;
    let pct = idiv(idiv(this.vetPct(r) * vs, 100) * FLANK_PCT[fl], 100);
    pct = idiv(pct * this.heightPct(s.x, s.y, e.x, e.y, RULES.height.meleePerLevel), 100);
    let cd = r.def.cooldown;
    let mom = 0;
    // 槍林：正面撞來的敵人越快傷害越高；正面攻速加成；刺中衝刺中的人扣衝勁
    if (r.brace === 2 && (t.dash !== null && this.wasDashing(e) ? this.dashFlank(t, r) : this.flankOf(t, r)) === 'front') {
      const circle = r.formation === 'circle' ? RULES.brace.circlePct : 100;
      if (e.spd > RULES.brace.speedThreshold) pct = idiv(pct * (100 + idiv(idiv((e.spd - RULES.brace.speedThreshold) * RULES.brace.speedCoef, RULES.brace.speedUnit) * circle, 100)), 100);
      cd = idiv(cd * 100, RULES.brace.attackSpeed);
      // 扣衝勁只算貼近的前排（迎擊距離內）：長槍觸及距離較長，但後排刺到的不擋衝勁，兩排槍林仍可被衝穿
      const dx = e.x - s.x;
      const dy = e.y - s.y;
      if (this.wasDashing(e) && dx * dx + dy * dy <= RULES.brace.counterReach * RULES.brace.counterReach) mom = idiv(RULES.brace.stab * circle, 100);
    }
    if (s.firstHit) {
      pct = idiv(pct * RULES.dash.firstHit, 100);
      s.firstHit = false;
    }
    const dmg = idiv(idiv(r.def.meleeAttack * pct, 100) * this.takenPct(e, t, fl, false), 100);
    this.queue(e, Math.max(1, dmg), r, 0, 0, false, mom);
    this.revealOnAttack(r);
    r.lastMelee = this.tick;
    const key = Math.min(r.id, t.id) * 4096 + Math.max(r.id, t.id);
    const last = this.contactAt.get(key);
    if (last === undefined || this.tick - last > 300) this.emit({ type: 'contact', tick: this.tick, a: r.id, b: t.id, flank: fl });
    this.contactAt.set(key, this.tick);
    return cd;
  }

  /** 一般射擊（指定敵團） */
  private shoot(s: Soldier, r: Regiment): boolean {
    const t = this.alive(r.fireTarget);
    if (t === null || t.slots.length === 0 || this.visible[r.owner][t.id] !== 1) {
      this.setFire(r, -1);
      return false;
    }
    const e = this.soldiers[t.slots[this.rng.nextInt(t.slots.length)]];
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const range = this.rangeTo(r, e.x, e.y, s.x, s.y);
    if (dx * dx + dy * dy > range * range) return false;
    r.lastShot = this.tick;
    const d = isqrt(dx * dx + dy * dy);
    const chance = t.dash !== null && t.dash.def.kind === 'infiltrate' && e.dashing ? RULES.evadeHitChance : RULES.ranged.hitChance;
    const hit = this.rng.nextInt(100) < chance;
    let x1 = e.x;
    let y1 = e.y;
    if (!hit) {
      x1 += this.rng.range(-RULES.ranged.missSpread, RULES.ranged.missSpread);
      y1 += this.rng.range(-RULES.ranged.missSpread, RULES.ranged.missSpread);
    }
    this.projectiles.push({ x0: s.x, y0: s.y, x1, y1, t0: this.tick, t1: this.tick + Math.max(2, idiv(d, RULES.ranged.arrowSpeed)), target: hit ? e.id : -1, dmg: this.arrowDamage(r, s, e.x, e.y), reg: r.id, owner: r.owner });
    if (this.terrainAt(r.x, r.y) === T.Forest) r.revealedUntil = this.tick + RULES.vision.revealTicks;
    return true;
  }

  /** 齊射：箭落在圈內隨機一點；回傳冷卻 */
  private volleyShot(s: Soldier, r: Regiment): number {
    const v = r.volley!;
    const R = RULES.volley.radius;
    let ox = 0;
    let oy = 0;
    for (let k = 0; k < 4; k++) {
      ox = this.rng.range(-R, R);
      oy = this.rng.range(-R, R);
      if (ox * ox + oy * oy <= R * R) break;
    }
    const x1 = v.x + ox;
    const y1 = v.y + oy;
    const dx = x1 - s.x;
    const dy = y1 - s.y;
    const d = isqrt(dx * dx + dy * dy);
    r.lastShot = this.tick;
    this.projectiles.push({ x0: s.x, y0: s.y, x1, y1, t0: this.tick, t1: this.tick + Math.max(2, idiv(d, RULES.ranged.arrowSpeed)), target: -2, dmg: this.arrowDamage(r, s, x1, y1), reg: r.id, owner: r.owner });
    if (this.terrainAt(r.x, r.y) === T.Forest) r.revealedUntil = this.tick + RULES.vision.revealTicks;
    return Math.max(1, idiv(r.def.cooldown, RULES.volley.rateDiv));
  }

  /** 箭的傷害（減免在落地時算） */
  private arrowDamage(r: Regiment, s: Soldier, x: number, y: number): number {
    const pct = idiv(this.vetPct(r) * this.heightPct(s.x, s.y, x, y, RULES.height.rangedPerLevel), 100);
    return idiv(r.def.attack * pct, 100);
  }

  private resolveProjectiles(): void {
    if (this.projectiles.length === 0) return;
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      if (p.t1 > this.tick) {
        keep.push(p);
        continue;
      }
      let e: Soldier | null = null;
      if (p.target >= 0) e = this.soldiers[p.target];
      else if (p.target === -2) {
        // 齊射：落點附近最近的敵兵（看不到的也打得到）
        const probe = { x: p.x1, y: p.y1, owner: p.owner } as Soldier;
        const id = this.nearestEnemy(probe, RULES.volley.hitRadius);
        if (id >= 0) {
          e = this.soldiers[id];
          const t = this.regiments[e.reg];
          if (t.dash !== null && t.dash.def.kind === 'infiltrate' && e.dashing && this.rng.nextInt(RULES.ranged.hitChance) >= RULES.evadeHitChance) e = null;
        }
      }
      if (e === null || !e.alive) continue;
      const by = this.regiments[p.reg];
      const t = this.regiments[e.reg];
      const fl = this.flankOf(by, t);
      const vs = VERSUS[by.kind][t.kind] ?? 100;
      const pct = idiv(idiv(vs * FLANK_PCT[fl], 100) * this.takenPct(e, t, fl, true), 100);
      this.damage(e, Math.max(1, idiv(p.dmg * pct, 100)), by);
    }
    this.projectiles = keep;
  }

  // ───────── 傷亡整理 ─────────

  private cleanup(): void {
    const lvls = RULES.veteran.levels;
    for (const r of this.regiments) {
      if (this.gone(r)) continue;
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
        if (r.dash !== null) this.endDash(r);
        r.destroyed = true;
        this.emit({ type: 'destroyed', tick: this.tick, reg: r.id, escaped: r.escaped > 0 });
        continue;
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
          vis[t.id] = this.gone(t) ? 0 : 1;
          continue;
        }
        if (this.gone(t)) {
          vis[t.id] = 0;
          continue;
        }
        const conc = this.concealed(t);
        let v = 0;
        for (const o of this.regiments) {
          if (o.owner !== p || this.gone(o)) continue;
          const d = isqrt((o.x - t.x) * (o.x - t.x) + (o.y - t.y) * (o.y - t.y));
          if (conc) {
            const det = o.kind === 'light' ? RULES.vision.concealDetectLight : RULES.vision.concealDetect;
            if (d - o.rad - t.rad <= det) v = 1;
          } else {
            const sight = o.def.sight + RULES.height.sightPerLevel * Math.max(0, this.heightOf(o.x, o.y) - 1);
            if (d - t.rad <= sight && !sightBlocked(this.map, o.x, o.y, t.x, t.y)) v = 1;
          }
          if (v === 1) break;
        }
        vis[t.id] = v;
      }
    }
    for (const r of this.regiments) {
      if (this.gone(r)) continue;
      let seen = false;
      for (let p = 0; p < this.players.length; p++) if (p !== r.owner && this.visible[p][r.id] === 1) seen = true;
      if (!seen) r.spottedSince = -1;
      else if (r.spottedSince < 0) r.spottedSince = this.tick;
      if (!seen && this.concealed(r)) r.lastHidden = this.tick;
    }
  }

  /** 依目前位置重算視野（測試把軍團瞬移到定位後用） */
  refreshVision(): void {
    this.computeVision();
  }

  // ───────── 旗點與勝負 ─────────

  private stepFlags(): void {
    const n = this.players.length;
    const r2 = RULES.capture.radius * RULES.capture.radius;
    const full = RULES.capture.captureTicks;
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
      // 只有一方在圈內、而且不是佔領者：它的進度增加（別人留下的進度要先倒退到零）；滿了就換它佔領
      if (count === 1 && who !== f.owner) {
        if (f.capturer === who || f.capturer < 0) {
          f.capturer = who;
          f.progress += 1;
          if (f.progress >= full) {
            f.owner = who;
            f.capturer = -1;
            f.progress = 0;
            this.emit({ type: 'flag', tick: this.tick, flag: f.id, owner: who });
          }
        } else this.decayFlag(f);
      } else if (count === 0 || (count === 1 && who === f.owner)) this.decayFlag(f);
      // 雙方都在圈內：進度不動
      f.contested = false;
      if (f.owner >= 0) {
        for (let p = 0; p < n; p++) if (p !== f.owner && present[p] === 1) f.contested = true;
        if (!f.contested) this.players[f.owner].score += f.points;
      }
    }
  }

  /** 沒人在佔：進度倒退，到零就清掉正在佔領的一方 */
  private decayFlag(f: FlagRuntime): void {
    if (f.progress > 0) f.progress -= 1;
    if (f.progress === 0) f.capturer = -1;
  }

  /** 佔點分數（分） */
  scoreOf(p: number): number {
    return idiv(this.players[p].score, TPS);
  }

  strength(p: number): number {
    let s = 0;
    for (const r of this.regiments) {
      if (r.owner !== p || r.destroyed) continue;
      s += idiv(r.def.cost * 100 * (r.reserve ? r.parked.length : r.slots.length), r.men0);
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
      for (const r of this.regiments) if (r.owner === p.id && !r.destroyed) p.active = true;
    }
    const strength = this.players.map((p) => this.strength(p.id));
    const flagsHeld = this.players.map((p) => this.flagsHeld(p.id));
    const score = this.players.map((p) => this.scoreOf(p.id));
    const finish = (winner: number | null, reason: LegionResult['reason']): void => {
      this.over = true;
      this.resultValue = { winner, reason, durationTicks: this.tick, strength, flagsHeld, score };
    };
    const active = this.players.filter((p) => p.active);
    if (active.length < n) {
      finish(active.length === 1 ? active[0].id : null, 'annihilation');
      return;
    }
    if (this.mode === 'capture') {
      // 先到目標分獲勝（同一 tick 一起到：分數高的贏，一樣高就平手）
      const done = this.players.filter((p) => score[p.id] >= RULES.capture.scoreTarget);
      if (done.length > 0) {
        const best = Math.max(...done.map((p) => p.score));
        const top = done.filter((p) => p.score === best);
        finish(top.length === 1 ? top[0].id : null, 'score');
        return;
      }
    }
    if (this.tick >= this.timeLimitTicks) {
      // 時間到：佔點先比分數、再比剩餘兵力；殲滅戰比剩餘兵力
      const order = this.players
        .map((p) => p.id)
        .sort((a, b) => (this.mode === 'capture' ? this.players[b].score - this.players[a].score : 0) || strength[b] - strength[a]);
      const a = order[0];
      const b = order[1];
      const tie = (this.mode !== 'capture' || this.players[a].score === this.players[b].score) && strength[a] === strength[b];
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
      case 'skill':
        return mineOrSeen(ev.reg);
      case 'levelUp':
      case 'enter':
      case 'withdraw':
        return this.regiments[ev.reg]?.owner === p;
      case 'flag':
        return true;
    }
  }

  hash(): string {
    const h = new Hasher();
    h.int(this.tick);
    for (const v of this.rng.getState()) h.int(v);
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      h.int(s.id).int(s.x).int(s.y).int(s.hp).int(s.cd).int(s.target).int(s.downUntil).bool(s.dashing).int(s.mom).bool(s.firstHit).int(s.counterAt);
    }
    for (const r of this.regiments) {
      h.int(r.x).int(r.y).int(r.facing).str(r.formation).int(r.width).int(r.depth).int(r.switchUntil).int(r.corridor).int(r.slots.length).int(r.target).int(r.fireTarget);
      h.int(r.brace).int(r.braceTimer).int(r.wall).int(r.wallTimer).str(r.stance ?? '').int(r.skillReadyAt).int(r.penetrateUntil).int(r.level).int(r.dmgDealt);
      h.bool(r.routed).bool(r.destroyed).bool(r.reserve).int(r.enterAt).int(r.enterX).int(r.enterY).int(r.parked.length).int(r.revealedUntil).int(r.spottedSince).int(r.lastHidden).str(r.order).int(r.followId);
      if (r.dash !== null) h.int(r.dash.dir).int(r.dash.left).int(r.dash.speed).int(r.dash.boost).bool(r.dash.aligning);
      if (r.volley !== null) h.int(r.volley.x).int(r.volley.y).int(r.volley.until);
    }
    for (const p of this.projectiles) h.int(p.t1).int(p.target).int(p.dmg).int(p.x1).int(p.y1);
    for (const f of this.flags) h.int(f.owner).int(f.capturer).int(f.progress).int(f.contested ? 1 : 0);
    for (const p of this.players) h.int(p.score);
    return h.digest();
  }
}

/** 開局資料（布陣前就要給選手，所以不依賴比賽物件） */
export function legionInitData(m: LegionMap, mode: LegionMode, p: number, knobs: Readonly<Record<string, number>>, timeLimitTicks: number): LegionInitData {
  return {
    playerId: p,
    mode,
    knobs,
    budget: mode === 'capture' ? RULES.capture.budget : RULES.budget,
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
      heights: Array.from(m.heights),
      deploy: m.deploy.map((z) => ({ x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 })),
      flags: m.flags.map((f, i) => ({ id: i, name: f.name, x: f.x, y: f.y, points: f.points })),
      spawns: m.spawns.map((q) => ({ x: q.x, y: q.y })),
      supplies: m.supplies.map((q, i) => ({ id: i, x: q.x, y: q.y, flag: q.flag })),
    },
    capture: {
      radius: RULES.capture.radius,
      captureTicks: RULES.capture.captureTicks,
      scoreTarget: RULES.capture.scoreTarget,
      budget: RULES.capture.budget,
      fieldCap: RULES.capture.fieldCap,
      enterTicks: RULES.capture.enterTicks,
      spawnRadius: RULES.capture.spawnRadius,
      supplyRadius: RULES.capture.supplyRadius,
      healPct: RULES.capture.healPct,
      healQuietTicks: RULES.capture.healQuietTicks,
    },
    units: UNIT_KINDS.map((k) => {
      const u = UNITS[k];
      const d = dashDefOf(k);
      return {
        kind: k,
        name: u.name,
        men: u.men,
        cost: u.cost,
        hp: u.hp,
        attack: u.attack,
        cooldown: u.cooldown,
        meleeAttack: u.meleeAttack,
        range: u.range,
        reach: u.reach,
        speed: u.speed,
        sight: u.sight,
        meleeDR: u.meleeDR,
        rangedDR: u.rangedDR,
        lineWidth: u.lineWidth,
        squareWidth: u.squareWidth,
        spacingX: u.spacingX,
        spacingY: u.spacingY,
        cavalry: u.cavalry,
        formations: u.formations,
        skill: u.skill,
        dash: d === null ? null : { kind: d.kind, dist: d.dist, speed: d.speed, turn: d.turn, cooldown: d.cooldown },
      };
    }),
    versus: Object.fromEntries(UNIT_KINDS.map((k) => [k, Object.fromEntries(UNIT_KINDS.map((t) => [t, VERSUS[k][t] ?? 100]))])),
  };
}

export type { DashKind };
