// CS 射擊模擬核心（規格書 v0.2；確定性、全整數）。步驟 1：移動碰撞、視錐視線、槍械、炸彈、回合流程、換邊、雜湊。
// 步驟 2：友軍傷害、經濟（金錢、購買、回合結算）。道具在步驟 3（本步驟只做購買與攜帶）。
//
// 每 tick：（決策 tick 先由驅動層套用指令）→ 轉身（上限）→ 移動（圓對格碰撞、沿牆滑動）→ 開火（hitscan；傷害同時結算）
// → 換彈、冷卻、後座力回復 → 下包、拆包 → 撿炸彈 → 腳步聲 → 炸彈倒數 → 回合判定。
// 角度：內部朝向用百分度（0.01°），給選手的觀察資料是整數度。
import { Hasher } from '../shared/hash.ts';
import { cdegDiff, iatan2C, icosC, isinC, normCdeg, stepToward } from '../shared/geom.ts';
import { applyPercent, clamp, idiv, roundHalfEven, tdiv } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import type {
  Attributes,
  BombInfo,
  BombState,
  DroppedItem,
  EnemyInfo,
  KnobValues,
  RadarContact,
  RoundEndReason,
  RoundPhase,
  ShooterInitData,
  ShooterObservation,
  SoundEvent,
  SoundKind,
  TeammateInfo,
  TeamMessage,
} from './api.ts';
import {
  ARMOR,
  ATTRIBUTE_KEYS,
  DECISION_INTERVAL,
  DEFUSE_KIT,
  ECONOMY,
  FRIENDLY_FIRE_PCT,
  GRENADES,
  GRENADE_IDS,
  GRENADE_RULES,
  MOVE,
  ROUND,
  SOUND,
  TEAM_SIZE,
  TPS,
  UNIT,
  VISION,
  WEAPONS,
  WEAPON_IDS,
  type GrenadeId,
  type Team,
  type WeaponDef,
  type WeaponId,
  type WeaponSlot,
} from './config.ts';
import { DEFAULT_MAP_ID, MAPS, cellOf, inRect, mapInfo, type Rect, type ShooterMap } from './map.ts';
import { circleHitsWall, findPath } from './path.ts';
import { distance, inCone, lineOfSight, quantizeDir, rayWallDistance, soundRange } from './vision.ts';

export const PLAYER_COUNT = TEAM_SIZE * 2;
/** 回放雜湊間隔（tick；沿用 RTS／軍團戰） */
export const HASH_INTERVAL = 100;
/** 每 tick 最多轉幾百分度：720°／秒 → 24°／tick */
export const TURN_STEP_C = idiv(VISION.turnDegPerSec * 100, TPS);
/** 子彈射線最長距離（座標單位） */
const MAX_RAY = 180 * UNIT;
/** 撿東西的距離；走過炸彈自動撿起的距離 */
const PICKUP_RANGE = 1200;
const BOMB_AUTO_PICKUP = 600;
/** 拆包要貼近炸彈 1.5 格 */
export const DEFUSE_RANGE = 1500;
/** 跑步每幾 tick 發一次腳步聲 */
const FOOTSTEP_INTERVAL = 9;
/** 自己腳邊多近的掉落物不在視錐內也看得見 */
const NEAR_ITEM = 2 * UNIT;
const MAX_COMMANDS = 32;
/** 一次 buy 指令最多處理幾項 */
const MAX_BUY_ITEMS = 16;
/** 全買判定：步槍級主武器（價格 ≥ AK）＋護甲的人數達到幾人 */
const FULL_BUY_PLAYERS = TEAM_SIZE - 1;
const MAX_SAY = 120;
/** 卡住偵測：連續多少 tick 幾乎沒前進就重新尋路 */
const STUCK_TICKS = 15;

/** 散佈倍率（%）：蹲、靜步、跑的倍率由武器表的小數換成整數百分比 */
const CROUCH_SPREAD = 70;
const WALK_SPREAD = 120;
const MOVING_PCT: Readonly<Record<WeaponId, number>> = Object.fromEntries(WEAPON_IDS.map((id) => [id, Math.round(WEAPONS[id].movingMul * 100)])) as Record<WeaponId, number>;

export interface WeaponState {
  readonly id: WeaponId;
  mag: number;
  reserve: number;
}

export type MoveKind = 'none' | 'path' | 'dir';

export interface Player {
  readonly id: number;
  /** 0 = 玩家 0～4（上半場 T）、1 = 玩家 5～9（上半場 CT） */
  readonly group: 0 | 1;
  readonly slot: number;
  team: Team;
  alive: boolean;
  x: number;
  y: number;
  /** 朝向（百分度） */
  facing: number;
  hp: number;
  armor: number;
  kit: boolean;
  /** 金錢（0～maxMoney） */
  money: number;
  /** 攜帶的道具（依購買順序；投擲在步驟 3） */
  grenades: GrenadeId[];
  primary: WeaponState | null;
  secondary: WeaponState | null;
  active: WeaponSlot;
  cooldown: number;
  reloadLeft: number;
  /** 後座力累積（度 ×100） */
  recoil: number;
  fireHeld: boolean;
  firePending: boolean;
  walking: boolean;
  crouching: boolean;
  scoped: boolean;
  moveKind: MoveKind;
  path: [number, number][];
  pathIdx: number;
  goalX: number;
  goalY: number;
  /** moveDir 的方向（百分度） */
  moveDeg: number;
  stuck: number;
  /** 瞄準點；null = 維持朝向 */
  aimX: number | null;
  aimY: number | null;
  vx: number;
  vy: number;
  hasBomb: boolean;
  plantTicks: number;
  defuseTicks: number;
  blindTicks: number;
  kills: number;
  deaths: number;
}

export interface BombEntity {
  state: 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';
  carrier: number;
  x: number;
  y: number;
  site: 'A' | 'B' | null;
  explodeTick: number;
  planter: number;
  defuser: number;
}

export interface Item {
  readonly kind: 'weapon' | 'bomb' | 'kit';
  readonly weapon: WeaponState | null;
  readonly x: number;
  readonly y: number;
}

interface Sound {
  readonly tick: number;
  readonly kind: SoundKind;
  readonly x: number;
  readonly y: number;
  readonly source: number;
  readonly weapon: WeaponId | null;
  /** 可聽見距離（座標單位）；-1 = 全圖 */
  readonly range: number;
}

interface Chat {
  readonly tick: number;
  readonly from: number;
  readonly text: string;
}

export interface RoundRecord {
  readonly number: number;
  readonly winner: Team;
  /** 勝方組別（0 = 玩家 0～4、1 = 玩家 5～9） */
  readonly winnerGroup: 0 | 1;
  readonly reason: RoundEndReason;
  readonly endTick: number;
  /** 本回合 T 是哪一組 */
  readonly tGroup: 0 | 1;
  /** 各組回合開始時（結算與重置之後）的平均金錢 */
  readonly money: readonly [number, number];
  /** 各組在購買時間結束時是否全買（≥ 4 人有步槍級主武器＋護甲） */
  readonly fullBuy: readonly [boolean, boolean];
}

export interface KillRecord {
  readonly tick: number;
  readonly round: number;
  readonly killer: number;
  readonly victim: number;
  readonly weapon: WeaponId | 'bomb';
}

export interface ShooterResult {
  /** 勝方組別；null = 平手 */
  readonly winner: 0 | 1 | null;
  readonly score: readonly [number, number];
  readonly rounds: readonly RoundRecord[];
  readonly ticks: number;
  readonly stats: readonly { readonly kills: number; readonly deaths: number }[];
}

export interface ShooterMatchOptions {
  readonly seed: number;
  readonly mapId?: string;
  /** 測試用：開局主武器（依陣營）；沒指定的陣營只有手槍＋刀 */
  readonly defaultLoadout?: Partial<Record<Team, WeaponId>>;
  /** 測試用：開局甲值 */
  readonly defaultArmor?: number;
  /** 起始／每半場首回合的金錢（預設 ECONOMY.startMoney） */
  readonly startMoney?: number;
  /** 測試用：依組別（0 = 玩家 0～4、1 = 玩家 5～9）每回合開局強制設定的金錢；null = 照常結算 */
  readonly roundMoney?: readonly [number | null, number | null];
  /** 測試用短賽制 */
  readonly roundsPerHalf?: number;
  readonly winRounds?: number;
}

interface PendingHit {
  readonly attacker: number;
  readonly victim: number;
  readonly damage: number;
  readonly pen: number;
  readonly weapon: WeaponId;
}

const weaponState = (id: WeaponId): WeaponState => ({ id, mag: WEAPONS[id].magazine, reserve: WEAPONS[id].reserve });

/** 距離衰減後的傷害：每 10 格衰減 falloffPer10%，最低 20%；超過有效射程只剩 20% */
export function damageAt(w: WeaponDef, distUnits: number): number {
  if (w.falloffPer10 === 0) return w.damage;
  if (distUnits > w.range * UNIT) return applyPercent(w.damage, 20);
  const pct = Math.max(20, 100 - idiv(w.falloffPer10 * distUnits, 10 * UNIT));
  return applyPercent(w.damage, pct);
}

/** 護甲：吸收 (100 − 穿甲)% 的傷害（以剩餘甲值為上限）並扣同量甲值 */
export function armorSplit(damage: number, armor: number, pen: number): { readonly hpLoss: number; readonly armorLoss: number } {
  if (armor <= 0) return { hpLoss: damage, armorLoss: 0 };
  const absorbed = Math.min(armor, idiv(damage * (100 - pen), 100));
  return { hpLoss: damage - absorbed, armorLoss: absorbed };
}

/** 目前散佈（度 ×100）：基礎值（開鏡改用 scopedSpread）× 姿勢倍率（站立 < 蹲 ×0.7；靜步 ×1.2、跑 ×movingMul），再加後座力 */
export function spreadOf(p: Player): number {
  const w = WEAPONS[activeWeaponId(p)];
  const moving = p.vx !== 0 || p.vy !== 0;
  const mul = p.crouching ? CROUCH_SPREAD : moving ? (p.walking ? WALK_SPREAD : MOVING_PCT[w.id]) : 100;
  const base = p.scoped && w.scopedSpread !== null ? w.scopedSpread : w.spread;
  return applyPercent(base, mul) + p.recoil;
}

export function activeWeaponId(p: Player): WeaponId {
  if (p.active === 'primary' && p.primary !== null) return p.primary.id;
  if (p.active === 'secondary' && p.secondary !== null) return p.secondary.id;
  return 'knife';
}

function activeState(p: Player): WeaponState | null {
  if (p.active === 'primary') return p.primary;
  if (p.active === 'secondary') return p.secondary;
  return null;
}

export function moveSpeed(p: Player): number {
  const w = WEAPONS[activeWeaponId(p)];
  const base = p.scoped && w.scopedSpeed !== null ? w.scopedSpeed : w.speed;
  if (p.crouching) return applyPercent(base, MOVE.crouchPct);
  if (p.walking) return applyPercent(base, MOVE.walkPct);
  return base;
}

/** 沿單一軸移動，碰牆時退到最遠不重疊的位置（二分） */
function slideAxis(map: ShooterMap, x: number, y: number, d: number, axis: 0 | 1, r: number): number {
  if (d === 0) return 0;
  const at = (k: number): boolean => (axis === 0 ? circleHitsWall(map, x + k, y, r) : circleHitsWall(map, x, y + k, r));
  if (!at(d)) return d;
  // 起點就卡在牆裡（不應發生）：放行讓它脫困
  if (at(0)) return d;
  const sign = d > 0 ? 1 : -1;
  let lo = 0;
  let hi = Math.abs(d);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at(sign * mid)) hi = mid;
    else lo = mid;
  }
  return sign * lo;
}

function newPlayer(id: number): Player {
  return {
    id,
    group: id < TEAM_SIZE ? 0 : 1,
    slot: id % TEAM_SIZE,
    team: id < TEAM_SIZE ? 'T' : 'CT',
    alive: true,
    x: 0,
    y: 0,
    facing: 0,
    hp: ROUND.startHp,
    armor: 0,
    kit: false,
    money: 0,
    grenades: [],
    primary: null,
    secondary: weaponState('pistol'),
    active: 'secondary',
    cooldown: 0,
    reloadLeft: 0,
    recoil: 0,
    fireHeld: false,
    firePending: false,
    walking: false,
    crouching: false,
    scoped: false,
    moveKind: 'none',
    path: [],
    pathIdx: 0,
    goalX: 0,
    goalY: 0,
    moveDeg: 0,
    stuck: 0,
    aimX: null,
    aimY: null,
    vx: 0,
    vy: 0,
    hasBomb: false,
    plantTicks: 0,
    defuseTicks: 0,
    blindTicks: 0,
    kills: 0,
    deaths: 0,
  };
}

const PHASE_CODE: Readonly<Record<RoundPhase, number>> = { freeze: 0, live: 1, planted: 2, over: 3 };
const BOMB_CODE: Readonly<Record<BombEntity['state'], number>> = { carried: 0, dropped: 1, planted: 2, defused: 3, exploded: 4 };
const SLOT_CODE: Readonly<Record<WeaponSlot, number>> = { primary: 0, secondary: 1, knife: 2 };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;

export const DEFAULT_ATTRIBUTES: Attributes = Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, 50])) as unknown as Attributes;

/** 開局資料（JSON 安全） */
export function shooterInitData(map: ShooterMap, playerId: number, knobs: KnobValues, opts: Pick<ShooterMatchOptions, 'roundsPerHalf' | 'winRounds' | 'startMoney'> = {}, attributes: Attributes = DEFAULT_ATTRIBUTES): ShooterInitData {
  const group = playerId < TEAM_SIZE ? 0 : 1;
  const ids = Array.from({ length: PLAYER_COUNT }, (_, i) => i);
  return {
    playerId,
    startTeam: group === 0 ? 'T' : 'CT',
    slot: playerId % TEAM_SIZE,
    teammateIds: ids.filter((i) => i !== playerId && (i < TEAM_SIZE ? 0 : 1) === group),
    enemyIds: ids.filter((i) => (i < TEAM_SIZE ? 0 : 1) !== group),
    knobs,
    attributes,
    rules: {
      ticksPerSecond: TPS,
      decisionInterval: DECISION_INTERVAL,
      unit: UNIT,
      teamSize: TEAM_SIZE,
      fovDeg: VISION.fovDeg,
      scopedFovDeg: VISION.scopedFovDeg,
      turnDegPerSec: VISION.turnDegPerSec,
      bodyRadius: VISION.bodyRadius,
      footstepRange: SOUND.footstepRange,
      friendlyFirePct: FRIENDLY_FIRE_PCT,
      roundsPerHalf: opts.roundsPerHalf ?? ROUND.roundsPerHalf,
      winRounds: opts.winRounds ?? ROUND.winRounds,
      freezeTicks: ROUND.freezeTicks,
      buyTicks: ROUND.buyTicks,
      roundTicks: ROUND.roundTicks,
      bombTicks: ROUND.bombTicks,
      plantTicks: ROUND.plantTicks,
      defuseTicks: ROUND.defuseTicks,
      defuseKitTicks: ROUND.defuseKitTicks,
      startHp: ROUND.startHp,
      maxArmor: ROUND.maxArmor,
      armorPrice: ARMOR.price,
      kitPrice: DEFUSE_KIT.price,
      grenadeSlots: GRENADE_RULES.totalSlots,
      economy: {
        startMoney: opts.startMoney ?? ECONOMY.startMoney,
        maxMoney: ECONOMY.maxMoney,
        winElimination: ECONOMY.winElimination,
        winTimeout: ECONOMY.winTimeout,
        winBomb: ECONOMY.winBomb,
        winDefuse: ECONOMY.winDefuse,
        lossBonus: ECONOMY.lossBonus,
        plantedLossBonus: ECONOMY.plantedLossBonus,
        planterBonus: ECONOMY.planterBonus,
        defuserBonus: ECONOMY.defuserBonus,
        grenadeKillReward: ECONOMY.grenadeKillReward,
        teamKillPenalty: ECONOMY.teamKillPenalty,
      },
    },
    map: mapInfo(map),
    weapons: WEAPON_IDS.map((id) => {
      const w = WEAPONS[id];
      return {
        id,
        name: w.name,
        slot: w.slot,
        teams: w.teams,
        price: w.price,
        damage: w.damage,
        pellets: w.pellets,
        fireTicks: w.fireTicks,
        automatic: w.automatic,
        magazine: w.magazine,
        reserve: w.reserve,
        reloadTicks: w.reloadTicks,
        armorPen: w.armorPen,
        falloffPer10: w.falloffPer10,
        range: w.range,
        killReward: w.killReward,
        speed: w.speed,
        spread: w.spread,
        movingMul: w.movingMul,
        scoped: w.scopedSpeed !== null,
        scopedSpread: w.scopedSpread,
      };
    }),
    grenades: GRENADE_IDS.map((id) => {
      const g = GRENADES[id];
      return { id, name: g.name, teams: g.teams, price: g.price, maxCarry: g.maxCarry, radius: g.radius, durationTicks: g.durationTicks, damage: g.damage };
    }),
  };
}

export class ShooterMatch {
  readonly map: ShooterMap;
  readonly seed: number;
  readonly roundsPerHalf: number;
  readonly winRounds: number;
  readonly defaultLoadout: Partial<Record<Team, WeaponId>>;
  readonly defaultArmor: number;
  readonly startMoney: number;
  readonly roundMoney: readonly [number | null, number | null];
  readonly players: Player[];
  readonly bomb: BombEntity = { state: 'carried', carrier: -1, x: 0, y: 0, site: null, explodeTick: 0, planter: -1, defuser: -1 };
  items: Item[] = [];
  readonly rounds: RoundRecord[] = [];
  readonly kills: KillRecord[] = [];
  tick = 0;
  roundNumber = 0;
  phase: RoundPhase = 'freeze';
  /** 目前階段結束的 tick（planted 階段看炸彈的 explodeTick） */
  phaseEnd = 0;
  roundStartTick = 0;
  liveStartTick = 0;
  ended: { winner: Team; reason: RoundEndReason } | null = null;
  /** 依組別的勝回合數 */
  readonly score: [number, number] = [0, 0];
  /** 依組別的連敗補償階梯（0 = 沒有連敗；輸一場 +1、贏一場 −1；半場歸零） */
  readonly lossLevel: [number, number] = [0, 0];
  /** 本回合開始時各組平均金錢、購買時間結束時是否全買（寫進 RoundRecord） */
  private roundMoneyAvg: [number, number] = [0, 0];
  private fullBuy: [boolean, boolean] | null = null;
  over = false;
  winner: 0 | 1 | null = null;
  private readonly prng: Prng;
  private sounds: Sound[] = [];
  private chat: Chat[] = [];
  private visTick = -1;
  private vis = new Uint8Array(PLAYER_COUNT * PLAYER_COUNT);

  constructor(opts: ShooterMatchOptions) {
    const mapId = opts.mapId ?? DEFAULT_MAP_ID;
    const make = MAPS[mapId];
    if (make === undefined) throw new Error(`未知地圖：${mapId}`);
    this.map = make();
    this.seed = opts.seed;
    this.roundsPerHalf = opts.roundsPerHalf ?? ROUND.roundsPerHalf;
    this.winRounds = opts.winRounds ?? ROUND.winRounds;
    this.defaultLoadout = opts.defaultLoadout ?? {};
    this.defaultArmor = opts.defaultArmor ?? 0;
    this.startMoney = opts.startMoney ?? ECONOMY.startMoney;
    this.roundMoney = opts.roundMoney ?? [null, null];
    this.prng = Prng.fromInts(opts.seed, 0x5407);
    this.players = Array.from({ length: PLAYER_COUNT }, (_, i) => newPlayer(i));
    this.startRound();
  }

  get half(): 1 | 2 {
    return this.roundNumber <= this.roundsPerHalf ? 1 : 2;
  }

  /** 該陣營目前是哪一組 */
  groupOf(team: Team): 0 | 1 {
    return (team === 'T') === (this.half === 1) ? 0 : 1;
  }

  isDecisionTick(): boolean {
    return this.tick % DECISION_INTERVAL === 0;
  }

  // ───────── 回合 ─────────

  private startRound(): void {
    this.roundNumber += 1;
    const firstOfHalf = this.roundNumber === 1 || this.roundNumber === this.roundsPerHalf + 1;
    if (firstOfHalf) this.lossLevel.fill(0);
    for (const p of this.players) {
      p.team = (p.group === 0) === (this.half === 1) ? 'T' : 'CT';
      if (firstOfHalf) p.money = clamp(this.startMoney, 0, ECONOMY.maxMoney);
      const fixed = this.roundMoney[p.group];
      if (fixed !== null) p.money = clamp(fixed, 0, ECONOMY.maxMoney);
      // 存活者保留武器、彈藥、甲值、道具、拆彈器；死亡者（與半場首回合）重發手槍＋刀
      if (firstOfHalf || !p.alive) {
        const prim = this.defaultLoadout[p.team];
        p.primary = prim !== undefined && WEAPONS[prim].slot === 'primary' ? weaponState(prim) : null;
        p.secondary = weaponState('pistol');
        p.armor = this.defaultArmor;
        p.kit = false;
        p.grenades = [];
      }
      const sp = this.map.spawns[p.team][p.slot];
      p.alive = true;
      p.hp = ROUND.startHp;
      p.x = sp.x;
      p.y = sp.y;
      p.facing = normCdeg(sp.facing * 100);
      p.active = p.primary !== null ? 'primary' : 'secondary';
      p.cooldown = 0;
      p.reloadLeft = 0;
      p.recoil = 0;
      p.fireHeld = false;
      p.firePending = false;
      p.walking = false;
      p.crouching = false;
      p.scoped = false;
      this.clearMove(p);
      p.aimX = null;
      p.aimY = null;
      p.vx = 0;
      p.vy = 0;
      p.hasBomb = false;
      p.plantTicks = 0;
      p.defuseTicks = 0;
      p.blindTicks = 0;
    }
    const ts = this.players.filter((p) => p.team === 'T');
    const carrier = ts[this.prng.nextInt(ts.length)];
    carrier.hasBomb = true;
    Object.assign(this.bomb, { state: 'carried', carrier: carrier.id, x: carrier.x, y: carrier.y, site: null, explodeTick: 0, planter: -1, defuser: -1 });
    // 掉落物在回合交接時清除
    this.items = [];
    this.sounds = [];
    this.chat = [];
    this.roundMoneyAvg = [this.groupMoneyAvg(0), this.groupMoneyAvg(1)];
    this.fullBuy = null;
    this.phase = 'freeze';
    this.roundStartTick = this.tick;
    this.phaseEnd = this.tick + ROUND.freezeTicks;
    this.ended = null;
  }

  /** 回合結算（唯一結算點）：勝利獎金、連敗補償、下包敗補償；記錄回合 */
  private endRound(winner: Team, reason: RoundEndReason): void {
    const g = this.groupOf(winner);
    const lg = g === 0 ? 1 : 0;
    this.score[g] += 1;
    if (this.fullBuy === null) this.fullBuy = this.fullBuyFlags();
    const winPay = reason === 'bomb' ? ECONOMY.winBomb : reason === 'defuse' ? ECONOMY.winDefuse : reason === 'timeout' ? ECONOMY.winTimeout : ECONOMY.winElimination;
    // 連敗階梯：敗方升一階、勝方退一階（不是歸零）
    const ladder = ECONOMY.lossBonus;
    this.lossLevel[lg] = Math.min(ladder.length, this.lossLevel[lg] + 1);
    this.lossLevel[g] = Math.max(0, this.lossLevel[g] - 1);
    const lossPay = ladder[this.lossLevel[lg] - 1];
    const plantedLoss = winner === 'CT' && this.bomb.planter >= 0 ? ECONOMY.plantedLossBonus : 0;
    for (const p of this.players) this.addMoney(p, p.team === winner ? winPay : lossPay + plantedLoss);
    this.rounds.push({ number: this.roundNumber, winner, winnerGroup: g, reason, endTick: this.tick, tGroup: this.groupOf('T'), money: [this.roundMoneyAvg[0], this.roundMoneyAvg[1]], fullBuy: [this.fullBuy[0], this.fullBuy[1]] });
    this.ended = { winner, reason };
    this.phase = 'over';
    this.phaseEnd = this.tick + ROUND.roundEndTicks;
    for (const p of this.players) {
      p.plantTicks = 0;
      p.defuseTicks = 0;
    }
    if (this.score[g] >= this.winRounds) {
      this.over = true;
      this.winner = g;
    } else if (this.roundNumber >= this.roundsPerHalf * 2) {
      this.over = true;
      this.winner = this.score[0] === this.score[1] ? null : this.score[0] > this.score[1] ? 0 : 1;
    }
  }

  private addMoney(p: Player, amount: number): void {
    p.money = clamp(p.money + amount, 0, ECONOMY.maxMoney);
  }

  private groupMoneyAvg(g: 0 | 1): number {
    let sum = 0;
    for (const p of this.players) if (p.group === g) sum += p.money;
    return idiv(sum, TEAM_SIZE);
  }

  private fullBuyFlags(): [boolean, boolean] {
    const n = [0, 0];
    for (const p of this.players) {
      if (p.alive && p.armor > 0 && p.primary !== null && WEAPONS[p.primary.id].price >= WEAPONS.ak.price) n[p.group] += 1;
    }
    return [n[0] >= FULL_BUY_PLAYERS, n[1] >= FULL_BUY_PLAYERS];
  }

  private aliveCount(team: Team): number {
    let n = 0;
    for (const p of this.players) if (p.alive && p.team === team) n += 1;
    return n;
  }

  private judge(): void {
    if (this.phase === 'freeze') {
      if (this.tick >= this.phaseEnd) {
        this.phase = 'live';
        this.liveStartTick = this.tick;
        this.phaseEnd = this.tick + ROUND.roundTicks;
      }
      return;
    }
    if (this.phase === 'over') {
      if (this.tick >= this.phaseEnd && !this.over) this.startRound();
      return;
    }
    const t = this.aliveCount('T');
    const ct = this.aliveCount('CT');
    if (this.phase === 'live') {
      // 同時全滅且沒下包：守方達成目標
      if (t === 0) this.endRound('CT', 'elimination');
      else if (ct === 0) this.endRound('T', 'elimination');
      else if (this.tick >= this.phaseEnd) this.endRound('CT', 'timeout');
      return;
    }
    // planted：時間不再是勝利條件；T 全滅仍要等引爆或拆除
    if (this.bomb.state === 'defused') this.endRound('CT', 'defuse');
    else if (this.tick >= this.bomb.explodeTick) {
      this.explode();
      this.endRound('T', 'bomb');
    } else if (ct === 0) this.endRound('T', 'elimination');
  }

  private explode(): void {
    this.bomb.state = 'exploded';
    this.emit('explosion', this.bomb.x, this.bomb.y, -1, null, -1);
    const r = ROUND.bombBlastRadius * UNIT;
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = distance(p.x, p.y, this.bomb.x, this.bomb.y);
      if (d >= r) continue;
      const dmg = idiv(ROUND.bombBlastDamage * (r - d), r);
      p.hp -= dmg;
      if (p.hp <= 0) this.die(p, -1, 'bomb');
    }
  }

  // ───────── 指令 ─────────

  private clearMove(p: Player): void {
    p.moveKind = 'none';
    p.path = [];
    p.pathIdx = 0;
    p.stuck = 0;
  }

  private cancelAction(p: Player): void {
    p.plantTicks = 0;
    if (p.defuseTicks > 0 && this.bomb.defuser === p.id) this.bomb.defuser = -1;
    p.defuseTicks = 0;
  }

  private setPath(p: Player, gx: number, gy: number): void {
    // 同一個目標（半格內）且路徑還在走：沿用，不重新尋路
    if (p.moveKind === 'path' && Math.abs(gx - p.goalX) <= 500 && Math.abs(gy - p.goalY) <= 500 && p.pathIdx < p.path.length) return;
    const path = findPath(this.map, p.x, p.y, gx, gy);
    if (path === null) {
      this.clearMove(p);
      return;
    }
    p.moveKind = 'path';
    p.path = path;
    p.pathIdx = 0;
    p.goalX = gx;
    p.goalY = gy;
    p.stuck = 0;
  }

  /** 套用選手指令（不合法的指令忽略） */
  applyCommands(pid: number, raw: unknown): void {
    if (this.over || !Array.isArray(raw)) return;
    const p = this.players[pid];
    for (const c of raw.slice(0, MAX_COMMANDS)) {
      if (typeof c !== 'object' || c === null) continue;
      const cmd = c as Record<string, unknown>;
      if (cmd.type === 'say') {
        if (typeof cmd.text === 'string' && cmd.text.length > 0) this.chat.push({ tick: this.tick, from: pid, text: cmd.text.slice(0, MAX_SAY) });
        continue;
      }
      if (!p.alive) continue;
      this.applyOne(p, cmd);
    }
  }

  private applyOne(p: Player, cmd: Record<string, unknown>): void {
    switch (cmd.type) {
      case 'move':
        if (!isNum(cmd.x) || !isNum(cmd.y)) return;
        this.cancelAction(p);
        this.setPath(p, roundHalfEven(cmd.x), roundHalfEven(cmd.y));
        return;
      case 'moveDir':
        if (!isNum(cmd.deg)) return;
        this.cancelAction(p);
        this.clearMove(p);
        p.moveKind = 'dir';
        p.moveDeg = normCdeg(roundHalfEven(cmd.deg * 100));
        return;
      case 'stop':
        this.clearMove(p);
        return;
      case 'aim':
        if (!isNum(cmd.x) || !isNum(cmd.y)) return;
        p.aimX = roundHalfEven(cmd.x);
        p.aimY = roundHalfEven(cmd.y);
        return;
      case 'fire':
        if (typeof cmd.on !== 'boolean') return;
        p.fireHeld = cmd.on;
        p.firePending = cmd.on;
        if (cmd.on) this.cancelAction(p);
        return;
      case 'switch': {
        const slot = cmd.slot;
        if (slot !== 'primary' && slot !== 'secondary' && slot !== 'knife') return;
        if ((slot === 'primary' && p.primary === null) || (slot === 'secondary' && p.secondary === null) || slot === p.active) return;
        p.active = slot;
        p.reloadLeft = 0;
        p.scoped = false;
        return;
      }
      case 'reload':
        this.startReload(p);
        return;
      case 'walk':
        if (typeof cmd.on === 'boolean') p.walking = cmd.on;
        return;
      case 'crouch':
        if (typeof cmd.on === 'boolean') p.crouching = cmd.on;
        return;
      case 'scope':
        if (typeof cmd.on !== 'boolean') return;
        p.scoped = cmd.on && WEAPONS[activeWeaponId(p)].scopedSpeed !== null && p.reloadLeft === 0;
        return;
      case 'plant':
        if (p.plantTicks > 0 || !p.hasBomb || p.team !== 'T' || this.phase !== 'live' || this.siteAt(p.x, p.y) === null) return;
        this.clearMove(p);
        p.fireHeld = false;
        p.firePending = false;
        p.plantTicks = 1;
        this.emit('plant', p.x, p.y, p.id, null, SOUND.actionRange * UNIT);
        return;
      case 'defuse':
        if (p.defuseTicks > 0 || p.team !== 'CT' || this.phase !== 'planted' || this.bomb.defuser >= 0) return;
        if (distance(p.x, p.y, this.bomb.x, this.bomb.y) > DEFUSE_RANGE) return;
        this.clearMove(p);
        p.fireHeld = false;
        p.firePending = false;
        p.defuseTicks = 1;
        this.bomb.defuser = p.id;
        this.emit('defuse', p.x, p.y, p.id, null, SOUND.actionRange * UNIT);
        return;
      case 'pickup':
        this.pickup(p);
        return;
      case 'drop':
        if (cmd.bomb === true) {
          if (p.hasBomb && p.plantTicks === 0) this.dropBomb(p);
          return;
        }
        this.dropActive(p);
        return;
      case 'buy':
        if (!Array.isArray(cmd.items) || !this.canBuy(p)) return;
        for (const it of cmd.items.slice(0, MAX_BUY_ITEMS)) if (typeof it === 'string') this.buyOne(p, it);
        return;
      default:
      // throw（步驟 3）與未知指令：忽略
    }
  }

  /** 買一項；不合法（錢不夠、陣營不符、已有、超過攜帶上限、未知）就跳過 */
  private buyOne(p: Player, item: string): void {
    if (item === 'armor') {
      if (p.armor >= ARMOR.points || p.money < ARMOR.price) return;
      p.money -= ARMOR.price;
      p.armor = ARMOR.points;
      return;
    }
    if (item === 'kit') {
      if (p.team !== DEFUSE_KIT.team || p.kit || p.money < DEFUSE_KIT.price) return;
      p.money -= DEFUSE_KIT.price;
      p.kit = true;
      return;
    }
    if ((GRENADE_IDS as readonly string[]).includes(item)) {
      const g = GRENADES[item as GrenadeId];
      if (!g.teams.includes(p.team) || p.money < g.price || p.grenades.length >= GRENADE_RULES.totalSlots) return;
      if (p.grenades.filter((x) => x === g.id).length >= g.maxCarry) return;
      p.money -= g.price;
      p.grenades.push(g.id);
      return;
    }
    if (!(WEAPON_IDS as readonly string[]).includes(item)) return;
    const w = WEAPONS[item as WeaponId];
    // teams 為空（手槍、刀）＝不可購買
    if (!w.teams.includes(p.team) || p.money < w.price || w.slot === 'knife') return;
    p.money -= w.price;
    // 同槽的舊槍丟在腳邊（可被撿）；免費配發的手槍不退錢
    const old = w.slot === 'primary' ? p.primary : p.secondary;
    if (old !== null) this.items.push({ kind: 'weapon', weapon: { ...old }, x: p.x, y: p.y });
    if (w.slot === 'primary') p.primary = weaponState(w.id);
    else p.secondary = weaponState(w.id);
    p.active = w.slot;
    p.reloadLeft = 0;
    p.scoped = false;
  }

  private siteAt(x: number, y: number): 'A' | 'B' | null {
    const cx = cellOf(x);
    const cy = cellOf(y);
    for (const s of this.map.sites) if (inRect(s, cx, cy)) return s.id;
    return null;
  }

  private startReload(p: Player): void {
    const w = activeState(p);
    if (w === null || p.reloadLeft > 0) return;
    const def = WEAPONS[w.id];
    if (w.mag >= def.magazine || w.reserve <= 0) return;
    p.reloadLeft = def.reloadTicks;
    p.scoped = false;
    this.emit('reload', p.x, p.y, p.id, null, SOUND.actionRange * UNIT);
  }

  private dropBomb(p: Player): void {
    p.hasBomb = false;
    this.items.push({ kind: 'bomb', weapon: null, x: p.x, y: p.y });
    Object.assign(this.bomb, { state: 'dropped', carrier: -1, x: p.x, y: p.y });
  }

  private dropActive(p: Player): void {
    if (p.active === 'knife') return;
    const w = activeState(p);
    if (w === null) return;
    this.items.push({ kind: 'weapon', weapon: { ...w }, x: p.x, y: p.y });
    if (p.active === 'primary') p.primary = null;
    else p.secondary = null;
    p.active = p.primary !== null ? 'primary' : p.secondary !== null ? 'secondary' : 'knife';
    p.reloadLeft = 0;
    p.scoped = false;
  }

  /** 撿起最近的掉落物（武器會換掉同槽的武器） */
  private pickup(p: Player): void {
    let best = -1;
    let bestD = PICKUP_RANGE + 1;
    this.items.forEach((it, i) => {
      if (it.kind === 'bomb' && p.team !== 'T') return;
      if (it.kind === 'kit' && (p.team !== DEFUSE_KIT.team || p.kit)) return;
      const d = distance(p.x, p.y, it.x, it.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return;
    const it = this.items[best];
    this.items.splice(best, 1);
    if (it.kind === 'bomb') {
      this.takeBomb(p);
      return;
    }
    if (it.kind === 'kit') {
      p.kit = true;
      return;
    }
    const ws = it.weapon!;
    const slot = WEAPONS[ws.id].slot;
    const old = slot === 'primary' ? p.primary : p.secondary;
    if (old !== null) this.items.push({ kind: 'weapon', weapon: { ...old }, x: p.x, y: p.y });
    if (slot === 'primary') p.primary = { ...ws };
    else p.secondary = { ...ws };
    p.active = slot === 'primary' ? 'primary' : 'secondary';
    p.reloadLeft = 0;
    p.scoped = false;
  }

  private takeBomb(p: Player): void {
    p.hasBomb = true;
    this.items = this.items.filter((it) => it.kind !== 'bomb');
    Object.assign(this.bomb, { state: 'carried', carrier: p.id, x: p.x, y: p.y });
  }

  private die(p: Player, killer: number, weapon: WeaponId | 'bomb'): void {
    p.alive = false;
    p.hp = 0;
    p.deaths += 1;
    this.cancelAction(p);
    this.clearMove(p);
    p.fireHeld = false;
    p.firePending = false;
    p.vx = 0;
    p.vy = 0;
    // 擊殺獎金當下發；隊殺 −300；T 被自己的炸彈炸死算自殺 −300；炸死的 CT 不算誰的擊殺
    if (killer >= 0 && weapon !== 'bomb') {
      const k = this.players[killer];
      if (k.team !== p.team) {
        k.kills += 1;
        this.addMoney(k, WEAPONS[weapon].killReward);
      } else this.addMoney(k, ECONOMY.teamKillPenalty);
    } else if (weapon === 'bomb' && p.team === 'T') this.addMoney(p, ECONOMY.teamKillPenalty);
    this.kills.push({ tick: this.tick, round: this.roundNumber, killer, victim: p.id, weapon });
    if (p.primary !== null) {
      this.items.push({ kind: 'weapon', weapon: { ...p.primary }, x: p.x, y: p.y });
      p.primary = null;
    }
    if (p.kit) {
      this.items.push({ kind: 'kit', weapon: null, x: p.x, y: p.y });
      p.kit = false;
    }
    if (p.hasBomb) this.dropBomb(p);
  }

  private emit(kind: SoundKind, x: number, y: number, source: number, weapon: WeaponId | null, range: number): void {
    this.sounds.push({ tick: this.tick, kind, x, y, source, weapon, range });
  }

  // ───────── 每 tick ─────────

  step(): void {
    if (this.over) return;
    // 只保留上一次決策以來的聲音與喊話
    const keep = this.tick - 2 * DECISION_INTERVAL;
    if (this.sounds.length > 0 && this.sounds[0].tick < keep) this.sounds = this.sounds.filter((s) => s.tick >= keep);
    if (this.chat.length > 0 && this.chat[0].tick < keep) this.chat = this.chat.filter((s) => s.tick >= keep);
    for (const p of this.players) if (p.alive) this.turn(p);
    for (const p of this.players) if (p.alive) this.move(p);
    if (this.phase !== 'freeze') this.fireAll();
    for (const p of this.players) if (p.alive) this.weaponTick(p);
    this.actions();
    if (this.fullBuy === null && this.tick - this.roundStartTick >= ROUND.buyTicks - 1) this.fullBuy = this.fullBuyFlags();
    this.autoPickup();
    if (this.tick % FOOTSTEP_INTERVAL === 0) {
      for (const p of this.players) {
        if (p.alive && !p.walking && !p.crouching && (p.vx !== 0 || p.vy !== 0)) this.emit('footstep', p.x, p.y, p.id, null, SOUND.footstepRange * UNIT);
      }
    }
    if (this.bomb.state === 'carried' && this.bomb.carrier >= 0) {
      const c = this.players[this.bomb.carrier];
      this.bomb.x = c.x;
      this.bomb.y = c.y;
    }
    this.judge();
    this.tick += 1;
  }

  private turn(p: Player): void {
    if (p.aimX === null || p.aimY === null) return;
    if (p.aimX === p.x && p.aimY === p.y) return;
    p.facing = this.turnToward(p.facing, iatan2C(p.aimY - p.y, p.aimX - p.x));
  }

  private turnToward(cur: number, target: number): number {
    const d = cdegDiff(target, cur);
    if (d > TURN_STEP_C) return normCdeg(cur + TURN_STEP_C);
    if (d < -TURN_STEP_C) return normCdeg(cur - TURN_STEP_C);
    return target;
  }

  private move(p: Player): void {
    const ox = p.x;
    const oy = p.y;
    let dx = 0;
    let dy = 0;
    const speed = moveSpeed(p);
    if (p.plantTicks > 0 || p.defuseTicks > 0) {
      // 下包、拆包時站著不動
    } else if (p.moveKind === 'path') {
      const [tx, ty] = p.path[p.pathIdx];
      const [nx, ny] = stepToward(p.x, p.y, tx, ty, speed);
      dx = nx - p.x;
      dy = ny - p.y;
      if (nx === tx && ny === ty) p.pathIdx += 1;
    } else if (p.moveKind === 'dir') {
      dx = tdiv(icosC(p.moveDeg) * speed, 10000);
      dy = tdiv(isinC(p.moveDeg) * speed, 10000);
    }
    const r = VISION.bodyRadius;
    p.x += slideAxis(this.map, p.x, p.y, dx, 0, r);
    p.y += slideAxis(this.map, p.x, p.y, dy, 1, r);
    if (this.phase === 'freeze') {
      const z: Rect = this.map.spawnZones[p.team];
      p.x = clamp(p.x, z.x0 * UNIT + r, z.x1 * UNIT - r);
      p.y = clamp(p.y, z.y0 * UNIT + r, z.y1 * UNIT - r);
    }
    p.vx = p.x - ox;
    p.vy = p.y - oy;
    if (p.moveKind === 'path') {
      if (p.pathIdx >= p.path.length) this.clearMove(p);
      else if (this.phase !== 'freeze' && (Math.abs(p.vx) + Math.abs(p.vy)) * 4 < speed) {
        // 幾乎沒前進：連續 STUCK_TICKS 次就重新尋路
        p.stuck += 1;
        if (p.stuck >= STUCK_TICKS) {
          const gx = p.goalX;
          const gy = p.goalY;
          this.clearMove(p);
          this.setPath(p, gx, gy);
        }
      } else p.stuck = 0;
    }
  }

  /** 所有人同時開火：先算出全部命中，再一起扣血（處理順序不影響結果） */
  private fireAll(): void {
    const hits: PendingHit[] = [];
    const fired = new Uint8Array(PLAYER_COUNT);
    for (const p of this.players) {
      if (!p.alive || p.plantTicks > 0 || p.defuseTicks > 0) continue;
      const wid = activeWeaponId(p);
      const def = WEAPONS[wid];
      const want = def.automatic ? p.fireHeld : p.firePending;
      if (!want || p.cooldown > 0) continue;
      const ws = activeState(p);
      if (ws !== null) {
        if (p.reloadLeft > 0) {
          // 逐發裝填的霰彈可以中斷換彈開火
          if (def.id !== 'shotgun' || ws.mag === 0) continue;
          p.reloadLeft = 0;
        }
        if (ws.mag === 0) {
          this.startReload(p);
          continue;
        }
        ws.mag -= 1;
      }
      p.firePending = false;
      p.cooldown = def.fireTicks;
      fired[p.id] = 1;
      const spread = spreadOf(p);
      const maxLen = wid === 'knife' ? def.range * UNIT + VISION.bodyRadius : MAX_RAY;
      for (let k = 0; k < def.pellets; k++) {
        const off = spread > 0 ? this.prng.range(-spread, spread) : 0;
        const ang = normCdeg(p.facing + off);
        const hit = this.trace(p, icosC(ang), isinC(ang), maxLen);
        if (hit === null) continue;
        const dmg = damageAt(def, hit.dist);
        const friendly = this.players[hit.victim].team === p.team;
        hits.push({ attacker: p.id, victim: hit.victim, damage: friendly ? applyPercent(dmg, FRIENDLY_FIRE_PCT) : dmg, pen: def.armorPen, weapon: wid });
      }
      p.recoil += def.recoilStep;
      const heavy = wid === 'ak' || wid === 'm4' || wid === 'awp';
      this.emit('shot', p.x, p.y, p.id, wid, wid === 'knife' ? SOUND.actionRange * UNIT : heavy ? -1 : SOUND.lightGunRange * UNIT);
      if (ws !== null && ws.mag === 0) this.startReload(p);
    }
    for (const p of this.players) if (fired[p.id] === 0) p.recoil = Math.max(0, p.recoil - WEAPONS[activeWeaponId(p)].recoilDecay);
    const killedBy = new Int32Array(PLAYER_COUNT).fill(-1);
    const killWeapon: (WeaponId | null)[] = new Array<WeaponId | null>(PLAYER_COUNT).fill(null);
    for (const h of hits) {
      const v = this.players[h.victim];
      const { hpLoss, armorLoss } = armorSplit(h.damage, v.armor, h.pen);
      v.armor -= armorLoss;
      const wasAlive = v.hp > 0;
      v.hp -= hpLoss;
      if (wasAlive && v.hp <= 0) {
        killedBy[v.id] = h.attacker;
        killWeapon[v.id] = h.weapon;
      }
    }
    for (const p of this.players) if (p.alive && p.hp <= 0) this.die(p, killedBy[p.id], killWeapon[p.id] ?? 'knife');
  }

  /** 子彈射線：牆前第一個人，不分敵我（隊友會擋子彈；傷害打 FRIENDLY_FIRE_PCT 折扣由呼叫端處理） */
  private trace(p: Player, cx: number, cy: number, maxLen: number): { victim: number; dist: number } | null {
    const wall = rayWallDistance(this.map, p.x, p.y, cx, cy, maxLen);
    let best = -1;
    let bestT = wall;
    for (const q of this.players) {
      if (!q.alive || q.id === p.id) continue;
      const rx = q.x - p.x;
      const ry = q.y - p.y;
      const t = tdiv(rx * cx + ry * cy, 10000);
      if (t <= 0 || t >= bestT) continue;
      const perp = tdiv(rx * cy - ry * cx, 10000);
      if (Math.abs(perp) >= VISION.bodyRadius) continue;
      best = q.id;
      bestT = t;
    }
    return best < 0 ? null : { victim: best, dist: distance(p.x, p.y, this.players[best].x, this.players[best].y) };
  }

  private weaponTick(p: Player): void {
    if (p.cooldown > 0) p.cooldown -= 1;
    if (p.reloadLeft > 0) {
      p.reloadLeft -= 1;
      if (p.reloadLeft === 0) {
        const ws = activeState(p);
        if (ws !== null) {
          const def = WEAPONS[ws.id];
          if (def.id === 'shotgun') {
            ws.mag += 1;
            ws.reserve -= 1;
            if (ws.mag < def.magazine && ws.reserve > 0) p.reloadLeft = def.reloadTicks;
          } else {
            const n = Math.min(def.magazine - ws.mag, ws.reserve);
            ws.mag += n;
            ws.reserve -= n;
          }
        }
      }
    }
  }

  private actions(): void {
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.plantTicks > 0) {
        if (this.phase !== 'live' || !p.hasBomb) {
          p.plantTicks = 0;
          continue;
        }
        p.plantTicks += 1;
        if (p.plantTicks > ROUND.plantTicks) {
          p.plantTicks = 0;
          p.hasBomb = false;
          Object.assign(this.bomb, { state: 'planted', carrier: -1, x: p.x, y: p.y, site: this.siteAt(p.x, p.y), explodeTick: this.tick + ROUND.bombTicks, planter: p.id });
          this.addMoney(p, ECONOMY.planterBonus);
          this.phase = 'planted';
          this.phaseEnd = this.bomb.explodeTick;
        }
      } else if (p.defuseTicks > 0) {
        if (this.phase !== 'planted') {
          p.defuseTicks = 0;
          continue;
        }
        p.defuseTicks += 1;
        if (p.defuseTicks > (p.kit ? ROUND.defuseKitTicks : ROUND.defuseTicks)) {
          p.defuseTicks = 0;
          this.bomb.state = 'defused';
          this.bomb.defuser = p.id;
          this.addMoney(p, ECONOMY.defuserBonus);
        }
      }
    }
  }

  private autoPickup(): void {
    if (this.bomb.state !== 'dropped') return;
    for (const p of this.players) {
      if (p.alive && p.team === 'T' && distance(p.x, p.y, this.bomb.x, this.bomb.y) <= BOMB_AUTO_PICKUP) {
        this.takeBomb(p);
        return;
      }
    }
  }

  // ───────── 觀察 ─────────

  /** 視野矩陣：vis[i × 10 + j] = 1 表示 i 此刻看得見敵人 j（視錐內、有視線、i 沒被致盲） */
  private visibility(): Uint8Array {
    if (this.visTick === this.tick) return this.vis;
    this.visTick = this.tick;
    this.vis.fill(0);
    for (const a of this.players) {
      if (!a.alive || a.blindTicks > 0) continue;
      const fov = a.scoped ? VISION.scopedFovDeg : VISION.fovDeg;
      for (const b of this.players) {
        if (!b.alive || b.team === a.team) continue;
        if (this.sees(a, fov, b.x, b.y)) this.vis[a.id * PLAYER_COUNT + b.id] = 1;
      }
    }
    return this.vis;
  }

  private sees(a: Player, fov: number, x: number, y: number): boolean {
    return inCone(a.facing, fov, a.x, a.y, x, y) && lineOfSight(this.map, a.x, a.y, x, y);
  }

  /** 選手 pid 是否看得見敵人 eid（測試用） */
  canSee(pid: number, eid: number): boolean {
    return this.visibility()[pid * PLAYER_COUNT + eid] === 1;
  }

  observe(pid: number): ShooterObservation {
    const me = this.players[pid];
    const vis = this.visibility();
    const mates = this.players.filter((q) => q.team === me.team && q.id !== pid);
    const foes = this.players.filter((q) => q.team !== me.team);
    const blind = me.blindTicks > 0;
    const enemies: EnemyInfo[] = [];
    const radar: RadarContact[] = [];
    if (!blind) {
      for (const e of foes) {
        if (!e.alive) continue;
        if (me.alive && vis[pid * PLAYER_COUNT + e.id] === 1) {
          enemies.push({ id: e.id, x: e.x, y: e.y, facing: this.deg(e.facing), weapon: activeWeaponId(e), crouching: e.crouching, planting: e.plantTicks > 0, defusing: e.defuseTicks > 0, hasBomb: e.hasBomb });
        } else if (mates.some((m) => m.alive && vis[m.id * PLAYER_COUNT + e.id] === 1)) {
          radar.push({ id: e.id, x: e.x, y: e.y });
        }
      }
    }
    const sounds: SoundEvent[] = [];
    if (me.alive) {
      const from = this.tick - DECISION_INTERVAL;
      for (const s of this.sounds) {
        if (s.tick < from || s.tick >= this.tick || s.source === pid) continue;
        const d = distance(me.x, me.y, s.x, s.y);
        if (s.range >= 0 && d > s.range) continue;
        const friendly = s.source >= 0 && this.players[s.source].team === me.team;
        sounds.push({ kind: s.kind, dirDeg: d === 0 ? 0 : quantizeDir(me.x, me.y, s.x, s.y), range: soundRange(d), weapon: s.weapon, friendly });
      }
    }
    const chat: TeamMessage[] = [];
    for (const c of this.chat) {
      if (c.tick < this.tick - DECISION_INTERVAL || c.tick >= this.tick || c.from === pid) continue;
      if (this.players[c.from].team === me.team) chat.push({ from: c.from, text: c.text });
    }
    const teammates: TeammateInfo[] = mates.map((m) => ({
      id: m.id,
      alive: m.alive,
      x: m.x,
      y: m.y,
      facing: this.deg(m.facing),
      hp: m.hp,
      money: m.money,
      weapon: activeWeaponId(m),
      hasBomb: m.hasBomb,
      planting: m.plantTicks > 0,
      defusing: m.defuseTicks > 0,
      blind: m.blindTicks > 0,
    }));
    const items: DroppedItem[] = [];
    for (const it of this.items) {
      const known = it.kind === 'bomb' && me.team === 'T';
      if (known || (me.alive && !blind && this.itemVisible(me, it.x, it.y))) items.push({ kind: it.kind, weapon: it.weapon?.id ?? null, x: it.x, y: it.y });
    }
    const w = activeState(me);
    return {
      tick: this.tick,
      round: {
        number: this.roundNumber,
        half: this.half,
        phase: this.phase,
        phaseTicksLeft: Math.max(0, this.phaseEnd - this.tick),
        scoreT: this.score[this.groupOf('T')],
        scoreCT: this.score[this.groupOf('CT')],
        canBuy: this.canBuy(me),
        ended: this.ended === null ? null : { winner: this.ended.winner, reason: this.ended.reason },
      },
      me: {
        id: pid,
        team: me.team,
        alive: me.alive,
        x: me.x,
        y: me.y,
        facing: this.deg(me.facing),
        hp: me.hp,
        money: me.money,
        loadout: { primary: me.primary?.id ?? null, secondary: me.secondary?.id ?? null, grenades: me.grenades.slice(), armor: me.armor, kit: me.kit },
        weapon: activeWeaponId(me),
        ammoMag: w?.mag ?? 0,
        ammoReserve: w?.reserve ?? 0,
        reloadTicksLeft: me.reloadLeft,
        spread: spreadOf(me),
        scoped: me.scoped,
        walking: me.walking,
        crouching: me.crouching,
        hasBomb: me.hasBomb,
        blindTicks: me.blindTicks,
        plantTicks: me.plantTicks,
        defuseTicks: me.defuseTicks,
        vx: me.vx,
        vy: me.vy,
      },
      teammates,
      enemies,
      radar,
      sounds,
      bomb: this.bombInfo(me, enemies),
      effects: [],
      items,
      chat,
      enemiesAlive: foes.filter((e) => e.alive).length,
    };
  }

  /** 可購買：活著、人在出生區、回合開始（凍結開始）後 buyTicks 內（CS 的 mp_buytime；凍結 15 秒＋開打後 5 秒） */
  canBuy(p: Player): boolean {
    if (!p.alive || (this.phase !== 'freeze' && this.phase !== 'live')) return false;
    if (this.tick - this.roundStartTick >= ROUND.buyTicks) return false;
    return inRect(this.map.spawnZones[p.team], cellOf(p.x), cellOf(p.y));
  }

  private itemVisible(me: Player, x: number, y: number): boolean {
    if (distance(me.x, me.y, x, y) <= NEAR_ITEM) return true;
    return this.sees(me, me.scoped ? VISION.scopedFovDeg : VISION.fovDeg, x, y);
  }

  private deg(c: number): number {
    return idiv(c + 50, 100) % 360;
  }

  /** 炸彈資訊依觀察者的隊伍與視野而定（CT 在下包前看不見就不知道炸彈在哪） */
  private bombInfo(me: Player, enemies: readonly EnemyInfo[]): BombInfo {
    const b = this.bomb;
    const none = (state: BombState): BombInfo => ({ state, x: null, y: null, site: null, ticksLeft: null });
    if (b.state === 'defused' || b.state === 'exploded') return { state: b.state, x: b.x, y: b.y, site: b.site, ticksLeft: null };
    if (b.state === 'planted') {
      const defusing = b.defuser >= 0 && (me.team === 'CT' || enemies.some((e) => e.defusing));
      return { state: defusing ? 'defusing' : 'planted', x: b.x, y: b.y, site: b.site, ticksLeft: Math.max(0, b.explodeTick - this.tick) };
    }
    if (me.team === 'T') {
      if (b.state === 'dropped') return { state: 'dropped', x: b.x, y: b.y, site: null, ticksLeft: null };
      const c = this.players[b.carrier];
      return { state: c.plantTicks > 0 ? 'planting' : 'carried', x: c.x, y: c.y, site: null, ticksLeft: null };
    }
    if (b.state === 'carried') {
      const seen = enemies.find((e) => e.hasBomb);
      if (seen === undefined) return none('unknown');
      return { state: seen.planting ? 'planting' : 'carried', x: seen.x, y: seen.y, site: null, ticksLeft: null };
    }
    if (me.alive && me.blindTicks === 0 && this.itemVisible(me, b.x, b.y)) return { state: 'dropped', x: b.x, y: b.y, site: null, ticksLeft: null };
    return none('unknown');
  }

  // ───────── 結果與雜湊 ─────────

  result(): ShooterResult {
    return {
      winner: this.winner,
      score: [this.score[0], this.score[1]],
      rounds: this.rounds.slice(),
      ticks: this.tick,
      stats: this.players.map((p) => ({ kills: p.kills, deaths: p.deaths })),
    };
  }

  hash(): string {
    const h = new Hasher();
    h.int(this.tick).int(this.roundNumber).int(PHASE_CODE[this.phase]).int(this.phaseEnd).int(this.score[0]).int(this.score[1]).bool(this.over).int(this.lossLevel[0]).int(this.lossLevel[1]);
    const ws = (w: WeaponState | null): void => {
      if (w === null) h.int(-1);
      else h.int(WEAPON_IDS.indexOf(w.id)).int(w.mag).int(w.reserve);
    };
    for (const p of this.players) {
      h.int(p.team === 'T' ? 0 : 1).bool(p.alive).int(p.x).int(p.y).int(p.facing).int(p.hp).int(p.armor).bool(p.kit).int(p.money).int(p.grenades.length);
      for (const g of p.grenades) h.int(GRENADE_IDS.indexOf(g));
      ws(p.primary);
      ws(p.secondary);
      h.int(SLOT_CODE[p.active]).int(p.cooldown).int(p.reloadLeft).int(p.recoil).bool(p.fireHeld).bool(p.firePending);
      h.bool(p.walking).bool(p.crouching).bool(p.scoped).str(p.moveKind).int(p.path.length).int(p.pathIdx).int(p.goalX).int(p.goalY).int(p.moveDeg).int(p.stuck);
      h.int(p.aimX ?? -1).int(p.aimY ?? -1).int(p.vx).int(p.vy).bool(p.hasBomb).int(p.plantTicks).int(p.defuseTicks).int(p.blindTicks).int(p.kills).int(p.deaths);
    }
    const b = this.bomb;
    h.int(BOMB_CODE[b.state]).int(b.carrier).int(b.x).int(b.y).str(b.site ?? '').int(b.explodeTick).int(b.planter).int(b.defuser);
    h.int(this.items.length);
    for (const it of this.items) {
      h.str(it.kind).int(it.x).int(it.y);
      ws(it.weapon);
    }
    h.int(this.sounds.length).int(this.chat.length);
    for (const v of this.prng.getState()) h.int(v);
    return h.digest();
  }

  // ───────── 測試與情境用 ─────────

  /** 把選手瞬移到某處（座標單位；朝向整數度） */
  teleport(pid: number, x: number, y: number, facingDeg?: number): void {
    const p = this.players[pid];
    p.x = x;
    p.y = y;
    if (facingDeg !== undefined) p.facing = normCdeg(facingDeg * 100);
    this.clearMove(p);
    this.visTick = -1;
  }

  /** 直接擊殺（情境測試用；不算擊殺者） */
  kill(pid: number): void {
    const p = this.players[pid];
    if (p.alive) this.die(p, -1, 'knife');
    this.visTick = -1;
  }
}

