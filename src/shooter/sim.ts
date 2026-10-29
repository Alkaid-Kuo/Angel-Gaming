// CS 射擊模擬核心（規格書 v0.4；確定性、全整數）。步驟 1：移動碰撞、視錐視線、槍械、炸彈、回合流程、換邊、雜湊。
// 步驟 2：友軍傷害、經濟（金錢、購買、回合結算）。步驟 3：道具（投擲、煙霧、閃光、手雷、燃燒）。
//
// 每 tick：（決策 tick 先由驅動層套用指令）→ 轉身（上限）→ 移動（圓對格碰撞、沿牆滑動）→ 致盲與投擲冷卻倒數
// → 投射物飛行與生效（閃光、煙霧、手雷、燃燒點火）→ 煙霧撲滅火 → 開火（hitscan；傷害同時結算）
// → 換彈、冷卻、後座力回復 → 火焰結算 → 下包、拆包 → 撿炸彈 → 腳步聲 → 炸彈倒數 → 回合判定。
// 角度：內部朝向用百分度（0.01°），給選手的觀察資料是整數度。
import { Hasher } from '../shared/hash.ts';
import { cdegDiff, iatan2C, icosC, isinC, normCdeg, stepToward } from '../shared/geom.ts';
import { applyPercent, clamp, idiv, isqrt, roundHalfEven, tdiv } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import type {
  Attributes,
  BombInfo,
  BombState,
  DroppedItem,
  AreaEffect,
  EnemyInfo,
  HurtEvent,
  ShotTrace,
  TracerInfo,
  KnobValues,
  OvertimeRules,
  ProjectileInfo,
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
  AMMO,
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
import { DEFAULT_MAP_ID, MAPS, blocksMove, cellOf, inRect, isSolidCell, mapInfo, type Rect, type ShooterMap } from './map.ts';
import { circleHitsWall, findPath } from './path.ts';
import { distance, inCone, lineOfSight, lowCoverBlocks, quantizeDir, rayWallDistance, soundRange, type SightBlocker } from './vision.ts';

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
  /** 攜帶的道具（依購買順序；投出後移除） */
  grenades: GrenadeId[];
  /** 投擲冷卻剩餘 tick */
  throwCd: number;
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
  /** 最後一次開火的 tick（v0.5；觀察資料的 firing） */
  lastShotTick: number;
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

/** 還沒生效的道具（飛行中或已落地等引信） */
export interface Projectile {
  readonly kind: GrenadeId;
  readonly owner: number;
  x: number;
  y: number;
  /** 飛行方向（×10000） */
  dx: number;
  dy: number;
  /** 剩餘飛行距離（座標單位） */
  left: number;
  bounces: number;
  moving: boolean;
  /** 生效 tick（燃燒為上限） */
  readonly fuseTick: number;
}

export interface Smoke {
  readonly x: number;
  readonly y: number;
  readonly owner: number;
  readonly startTick: number;
  readonly endTick: number;
}

export interface Fire {
  readonly x: number;
  readonly y: number;
  readonly owner: number;
  readonly kind: GrenadeId;
  readonly startTick: number;
  readonly endTick: number;
  /** 燒得到的格子（列優先索引，由小到大；v0.5：半徑內、跟火焰中心之間沒有牆的格子，見 burnCells） */
  readonly cells: readonly number[];
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
  /** 各組本回合投出的道具數 */
  readonly throws: readonly [number, number];
  /** 各組的閃光讓敵人致盲的總 tick 數（每人取實際增加的量） */
  readonly flashEnemyTicks: readonly [number, number];
  /** 各組的閃光讓自己隊（含自己）致盲的總 tick 數 */
  readonly flashTeamTicks: readonly [number, number];
}

export interface KillRecord {
  readonly tick: number;
  readonly round: number;
  readonly killer: number;
  readonly victim: number;
  readonly weapon: WeaponId | GrenadeId | 'bomb';
}

export interface ShooterResult {
  /** 勝方組別；null = 平手 */
  readonly winner: 0 | 1 | null;
  readonly score: readonly [number, number];
  readonly rounds: readonly RoundRecord[];
  readonly ticks: number;
  readonly stats: readonly { readonly kills: number; readonly deaths: number }[];
  /** 打了幾段加時（0 = 正規結束） */
  readonly overtimes: number;
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
  /** 加時規則（預設 ROUND.overtime）；false = 不加時，正規平手就平手結束（短賽制測試用） */
  readonly overtime?: false | OvertimeRules;
}

/** 該半場玩家 0～4（組 0）是否為 T：上半場 T、下半場 CT；每段加時開始不換邊、段內換邊（半場 1 T、2 CT、3 CT、4 T、5 T、6 CT…） */
export function firstGroupIsT(half: number): boolean {
  return idiv(half, 2) % 2 === 0;
}

/** 子彈紀錄（每顆一筆，v0.5）：給開槍的人畫彈道與命中提示 */
interface ShotRec {
  readonly tick: number;
  readonly shooter: number;
  /** 開槍位置 */
  readonly sx: number;
  readonly sy: number;
  /** 子彈停下的位置：打中人為該人位置，否則撞牆處 */
  readonly ex: number;
  readonly ey: number;
  /** 撞牆處（打中看不見的人時，觀察資料改給這個，不洩漏位置） */
  readonly wx: number;
  readonly wy: number;
  readonly victim: number;
  /** 開槍當下誰看得見開槍的人、誰看得見中彈的人（第 i 位 = 選手 i；同隊一律算看得見） */
  readonly seeShooter: number;
  readonly seeVictim: number;
  kill: boolean;
  /** 這一發實際扣的血（v0.5，跳傷害數字用；超過剩餘血量的部分不算） */
  damage: number;
}

/** 受傷紀錄（v0.5）：給被打的人畫受傷方向 */
interface HurtRec {
  readonly tick: number;
  readonly victim: number;
  readonly fx: number;
  readonly fy: number;
}

interface PendingHit {
  /** 對應的子彈紀錄（扣血後回填實際傷害） */
  readonly rec: ShotRec;
  readonly attacker: number;
  readonly victim: number;
  readonly damage: number;
  readonly pen: number;
  readonly weapon: WeaponId;
}

const weaponState = (id: WeaponId): WeaponState => ({ id, mag: WEAPONS[id].magazine, reserve: WEAPONS[id].reserve });
const isGrenade = (v: unknown): v is GrenadeId => typeof v === 'string' && (GRENADE_IDS as readonly string[]).includes(v);

/** 煙霧在 tick 時的實際半徑：生效後 smokeBloomTicks 內從 0 線性長到 radius */
/**
 * 火圈燒得到的格子（v0.5）：格中心在半徑內、不是牆／矮牆，而且跟火焰中心之間沒有牆（矮牆不擋火）。
 * 回傳列優先索引，由小到大
 */
export function burnCells(map: ShooterMap, x: number, y: number, radius: number): number[] {
  const out: number[] = [];
  const c0 = cellOf(x - radius);
  const c1 = cellOf(x + radius);
  const r0 = cellOf(y - radius);
  const r1 = cellOf(y + radius);
  for (let cy = Math.max(0, r0); cy <= Math.min(map.height - 1, r1); cy++) {
    for (let cx = Math.max(0, c0); cx <= Math.min(map.width - 1, c1); cx++) {
      if (map.solid[cy * map.width + cx] !== 0) continue;
      const px = cx * UNIT + UNIT / 2;
      const py = cy * UNIT + UNIT / 2;
      if ((px - x) * (px - x) + (py - y) * (py - y) >= radius * radius) continue;
      if (!lineOfSight(map, x, y, px, py)) continue;
      out.push(cy * map.width + cx);
    }
  }
  return out;
}

export function smokeRadius(s: Smoke, tick: number): number {
  const t = clamp(tick - s.startTick, 0, GRENADE_RULES.smokeBloomTicks);
  return idiv(GRENADES.smoke.radius * t, GRENADE_RULES.smokeBloomTicks);
}

/** 閃光致盲時間（tick）：依朝向夾角取基礎值，再乘 1 − d／(2R)（外緣剩 flashEdgePct%） */
export function flashTicks(facingC: number, px: number, py: number, fx: number, fy: number): number {
  const R = GRENADES.flash.radius;
  const d = distance(px, py, fx, fy);
  if (d > R) return 0;
  const off = d === 0 ? 0 : Math.abs(cdegDiff(iatan2C(fy - py, fx - px), facingC));
  const base = off <= GRENADE_RULES.flashFrontDeg * 100 ? GRENADE_RULES.flashFrontTicks : off <= GRENADE_RULES.flashSideDeg * 100 ? GRENADE_RULES.flashSideTicks : GRENADE_RULES.flashBackTicks;
  return idiv(base * (100 * R - (100 - GRENADE_RULES.flashEdgePct) * d), 100 * R);
}

/** HE 在距離 d 的傷害（護甲、友傷前）：中心 damage，線性衰減到半徑外緣 0 */
export function heDamageAt(distUnits: number): number {
  const g = GRENADES.he;
  if (distUnits >= g.radius) return 0;
  return idiv(g.damage * (g.radius - distUnits), g.radius);
}

/** 燃燒每次結算的傷害 */
export const FIRE_TICK_DAMAGE = idiv(GRENADES.molotov.damage * GRENADE_RULES.fireTickInterval, TPS);

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

/** 沿單一軸移動，碰牆時退到最遠不重疊的位置（二分）；overLow = 飛越矮牆（道具） */
function slideAxis(map: ShooterMap, x: number, y: number, d: number, axis: 0 | 1, r: number, overLow = false): number {
  if (d === 0) return 0;
  const blocks = overLow ? isSolidCell : blocksMove;
  const at = (k: number): boolean => (axis === 0 ? circleHitsWall(map, x + k, y, r, blocks) : circleHitsWall(map, x, y + k, r, blocks));
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

/** 角色碰撞（v1.0）：兩個活人圓心距離的下限（2 × bodyRadius）的平方 */
const BODY_GAP_SQ = 4 * VISION.bodyRadius * VISION.bodyRadius;

/**
 * 移動處理順序（v1.0）：起點 tick % 10 輪轉；每 10 tick 順逆向交替。
 * 20 tick 一個週期內，任兩人誰先走恰好各半（只輪轉起點的話，相鄰 id 仍有 9 成是低 id 先走）
 */
export function moveOrder(tick: number): readonly number[] {
  return MOVE_ORDERS[tick % MOVE_ORDERS.length];
}
const MOVE_ORDERS: readonly (readonly number[])[] = Array.from({ length: PLAYER_COUNT * 2 }, (_, t) => {
  const start = t % PLAYER_COUNT;
  const reverse = t >= PLAYER_COUNT;
  return Array.from({ length: PLAYER_COUNT }, (_, i) => (reverse ? (start - i + PLAYER_COUNT) % PLAYER_COUNT : (start + i) % PLAYER_COUNT));
});

/**
 * 沿單一軸移動 d 時，不和其他活人重疊（圓心距 ≥ 2r）的最遠位移：對每個人解出擋住的區間，取最近的邊界（不推人、不彈開）。
 * 起點已經和某人重疊（瞬移、情境測試）：朝他靠近的那個方向不能動，遠離照走，讓人能分開
 */
function slideBodies(players: readonly Player[], self: Player, x: number, y: number, d: number, axis: 0 | 1): number {
  if (d === 0) return 0;
  let limit = Math.abs(d);
  for (const q of players) {
    if (q === self || !q.alive) continue;
    const across = axis === 0 ? y - q.y : x - q.x;
    const c = BODY_GAP_SQ - across * across;
    if (c <= 0) continue;
    // 沿軸距離 < w 就重疊（w = ⌈√c⌉）
    let w = isqrt(c);
    if (w * w < c) w += 1;
    const rel = axis === 0 ? x - q.x : y - q.y;
    if (Math.abs(rel) < w) {
      if (rel !== 0 && (rel > 0) !== (d > 0)) limit = 0;
    } else if (d > 0 && rel < 0) limit = Math.min(limit, -w - rel);
    else if (d < 0 && rel > 0) limit = Math.min(limit, rel - w);
    if (limit === 0) return 0;
  }
  return d > 0 ? limit : -limit;
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
    throwCd: 0,
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
    lastShotTick: -1000,
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
export function shooterInitData(map: ShooterMap, playerId: number, knobs: KnobValues, opts: Pick<ShooterMatchOptions, 'roundsPerHalf' | 'winRounds' | 'startMoney' | 'overtime'> = {}, attributes: Attributes = DEFAULT_ATTRIBUTES): ShooterInitData {
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
      viewRange: VISION.viewRange,
      scopedViewRange: VISION.scopedViewRange,
      lowCoverRange: VISION.lowCoverRange,
      turnDegPerSec: VISION.turnDegPerSec,
      bodyRadius: VISION.bodyRadius,
      footstepRange: SOUND.footstepRange,
      friendlyFirePct: FRIENDLY_FIRE_PCT,
      roundsPerHalf: opts.roundsPerHalf ?? ROUND.roundsPerHalf,
      winRounds: opts.winRounds ?? ROUND.winRounds,
      overtime: opts.overtime === false ? false : { ...(opts.overtime ?? ROUND.overtime) },
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
      ammoPrice: AMMO.price,
      kitPrice: DEFUSE_KIT.price,
      grenadeSlots: GRENADE_RULES.totalSlots,
      grenadeRules: {
        maxThrowRange: GRENADE_RULES.maxThrowRange,
        flySpeed: GRENADE_RULES.flySpeed,
        throwCooldownTicks: GRENADE_RULES.throwCooldownTicks,
        smokeBloomTicks: GRENADE_RULES.smokeBloomTicks,
        flashFrontTicks: GRENADE_RULES.flashFrontTicks,
        flashSideTicks: GRENADE_RULES.flashSideTicks,
        flashBackTicks: GRENADE_RULES.flashBackTicks,
        flashFrontDeg: GRENADE_RULES.flashFrontDeg,
        flashSideDeg: GRENADE_RULES.flashSideDeg,
        flashEdgePct: GRENADE_RULES.flashEdgePct,
        heArmorPct: GRENADE_RULES.heArmorPct,
        fireTickInterval: GRENADE_RULES.fireTickInterval,
      },
      economy: {
        startMoney: opts.startMoney ?? ECONOMY.startMoney,
        overtimeMoney: ECONOMY.overtimeMoney,
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
      return { id, name: g.name, teams: g.teams, price: g.price, maxCarry: g.maxCarry, fuseTicks: g.fuseTicks, radius: g.radius, durationTicks: g.durationTicks, damage: g.damage };
    }),
  };
}

export class ShooterMatch {
  readonly map: ShooterMap;
  readonly seed: number;
  readonly roundsPerHalf: number;
  readonly winRounds: number;
  /** 加時規則；null = 不加時 */
  readonly overtimeRule: OvertimeRules | null;
  readonly defaultLoadout: Partial<Record<Team, WeaponId>>;
  readonly defaultArmor: number;
  readonly startMoney: number;
  readonly roundMoney: readonly [number | null, number | null];
  readonly players: Player[];
  readonly bomb: BombEntity = { state: 'carried', carrier: -1, x: 0, y: 0, site: null, explodeTick: 0, planter: -1, defuser: -1 };
  items: Item[] = [];
  projectiles: Projectile[] = [];
  smokes: Smoke[] = [];
  fires: Fire[] = [];
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
  /** 目前這段加時開始時的比分（雙方相同；段內勝場以此為基準）；正規為 0 */
  overtimeBase = 0;
  /** 依組別的連敗補償階梯（0 = 沒有連敗；輸一場 +1、贏一場 −1；半場歸零） */
  readonly lossLevel: [number, number] = [0, 0];
  /** 本回合開始時各組平均金錢、購買時間結束時是否全買（寫進 RoundRecord） */
  private roundMoneyAvg: [number, number] = [0, 0];
  private fullBuy: [boolean, boolean] | null = null;
  /** 本回合各組的投擲數、閃光讓敵人／自己隊致盲的 tick 數（寫進 RoundRecord） */
  private roundThrows: [number, number] = [0, 0];
  private roundFlashEnemy: [number, number] = [0, 0];
  private roundFlashTeam: [number, number] = [0, 0];
  over = false;
  winner: 0 | 1 | null = null;
  private readonly prng: Prng;
  private sounds: Sound[] = [];
  private shotLog: ShotRec[] = [];
  private hurtLog: HurtRec[] = [];
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
    this.overtimeRule = opts.overtime === false ? null : (opts.overtime ?? ROUND.overtime);
    this.defaultLoadout = opts.defaultLoadout ?? {};
    this.defaultArmor = opts.defaultArmor ?? 0;
    this.startMoney = opts.startMoney ?? ECONOMY.startMoney;
    this.roundMoney = opts.roundMoney ?? [null, null];
    this.prng = Prng.fromInts(opts.seed, 0x5407);
    this.players = Array.from({ length: PLAYER_COUNT }, (_, i) => newPlayer(i));
    this.startRound();
  }

  /** 正規回合數（兩個半場） */
  get regulationRounds(): number {
    return this.roundsPerHalf * 2;
  }

  /** 半場：正規 1、2；加時每個半場遞增（第一段 3、4，第二段 5、6…） */
  get half(): number {
    const ot = this.overtimeRule;
    const n = this.roundNumber - this.regulationRounds;
    if (ot === null || n <= 0) return this.roundNumber <= this.roundsPerHalf ? 1 : 2;
    return 3 + idiv(n - 1, ot.roundsPerHalf);
  }

  /** 0 = 正規；1 起 = 第幾段加時 */
  get overtime(): number {
    const ot = this.overtimeRule;
    const n = this.roundNumber - this.regulationRounds;
    if (ot === null || n <= 0) return 0;
    return idiv(n - 1, ot.roundsPerHalf * 2) + 1;
  }

  /** 該陣營目前是哪一組 */
  groupOf(team: Team): 0 | 1 {
    return (team === 'T') === firstGroupIsT(this.half) ? 0 : 1;
  }

  /** 本回合是不是半場首回合（正規兩個半場與每個加時半場） */
  private isFirstOfHalf(): boolean {
    const n = this.roundNumber;
    if (n === 1 || n === this.roundsPerHalf + 1) return true;
    const ot = this.overtimeRule;
    const k = n - this.regulationRounds;
    return ot !== null && k > 0 && (k - 1) % ot.roundsPerHalf === 0;
  }

  isDecisionTick(): boolean {
    return this.tick % DECISION_INTERVAL === 0;
  }

  // ───────── 回合 ─────────

  private startRound(): void {
    this.roundNumber += 1;
    const firstOfHalf = this.isFirstOfHalf();
    if (firstOfHalf) this.lossLevel.fill(0);
    const halfMoney = this.overtime > 0 ? ECONOMY.overtimeMoney : this.startMoney;
    const g0T = firstGroupIsT(this.half);
    for (const p of this.players) {
      p.team = (p.group === 0) === g0T ? 'T' : 'CT';
      if (firstOfHalf) p.money = clamp(halfMoney, 0, ECONOMY.maxMoney);
      const fixed = this.roundMoney[p.group];
      if (fixed !== null) p.money = clamp(fixed, 0, ECONOMY.maxMoney);
      // 存活者保留武器、彈藥（不自動補，要買）、甲值、道具、拆彈器；死亡者（與半場首回合，含加時半場）重發手槍＋刀
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
      p.throwCd = 0;
    }
    const ts = this.players.filter((p) => p.team === 'T');
    const carrier = ts[this.prng.nextInt(ts.length)];
    carrier.hasBomb = true;
    Object.assign(this.bomb, { state: 'carried', carrier: carrier.id, x: carrier.x, y: carrier.y, site: null, explodeTick: 0, planter: -1, defuser: -1 });
    // 掉落物、還沒生效的道具、煙霧、火在回合交接時清除
    this.items = [];
    this.projectiles = [];
    this.smokes = [];
    this.fires = [];
    this.roundThrows = [0, 0];
    this.roundFlashEnemy = [0, 0];
    this.roundFlashTeam = [0, 0];
    this.sounds = [];
    this.shotLog = [];
    this.hurtLog = [];
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
    this.rounds.push({ number: this.roundNumber, winner, winnerGroup: g, reason, endTick: this.tick, tGroup: this.groupOf('T'), money: [this.roundMoneyAvg[0], this.roundMoneyAvg[1]], fullBuy: [this.fullBuy[0], this.fullBuy[1]], throws: [this.roundThrows[0], this.roundThrows[1]], flashEnemyTicks: [this.roundFlashEnemy[0], this.roundFlashEnemy[1]], flashTeamTicks: [this.roundFlashTeam[0], this.roundFlashTeam[1]] });
    this.ended = { winner, reason };
    this.phase = 'over';
    this.phaseEnd = this.tick + ROUND.roundEndTicks;
    for (const p of this.players) {
      p.plantTicks = 0;
      p.defuseTicks = 0;
    }
    this.judgeMatch(g);
  }

  /** 比賽結束判定：正規先到 winRounds 或打滿分勝負；平手進加時（段內以 overtimeBase 為基準）；加時打滿 maxBlocks 段仍平手則平手 */
  private judgeMatch(g: 0 | 1): void {
    const ot = this.overtimeRule;
    const block = this.overtime;
    const leader = this.score[0] === this.score[1] ? null : this.score[0] > this.score[1] ? 0 : 1;
    if (block === 0) {
      if (this.score[g] >= this.winRounds) this.finish(g);
      else if (this.roundNumber >= this.regulationRounds) {
        if (leader !== null || ot === null) this.finish(leader);
        else this.overtimeBase = this.score[0];
      }
      return;
    }
    if (ot === null) return;
    if (this.score[g] - this.overtimeBase >= ot.winRounds) this.finish(g);
    else if (this.roundNumber - this.regulationRounds >= block * ot.roundsPerHalf * 2) {
      // 這段打滿：標準 MR3 必為 3:3；自訂規則若分出高下就以比分定勝負
      if (leader !== null || block >= ot.maxBlocks) this.finish(leader);
      else this.overtimeBase = this.score[0];
    }
  }

  private finish(winner: 0 | 1 | null): void {
    this.over = true;
    this.winner = winner;
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
      case 'throw':
        if (!isGrenade(cmd.grenade) || !isNum(cmd.deg) || !isNum(cmd.power)) return;
        this.throwGrenade(p, cmd.grenade, roundHalfEven(cmd.deg), clamp(roundHalfEven(cmd.power), 0, 100));
        return;
      default:
      // 未知指令：忽略
    }
  }

  /**
   * 投擲：手上要有該道具、不在凍結時間與投擲冷卻內；投出後從背包移除，停火、冷卻內不能開火。
   * 方向夾在視錐內（v0.4）：與朝向的夾角超過 fov／2 時夾到邊界，要往背後丟得先轉身
   */
  private throwGrenade(p: Player, kind: GrenadeId, deg: number, power: number): void {
    if (this.phase === 'freeze' || p.throwCd > 0) return;
    const idx = p.grenades.indexOf(kind);
    if (idx < 0) return;
    const half = (p.scoped ? VISION.scopedFovDeg : VISION.fovDeg) * 50;
    const off = cdegDiff(normCdeg(deg * 100), p.facing);
    const c = Math.abs(off) <= half ? normCdeg(deg * 100) : normCdeg(p.facing + (off < 0 ? -half : half));
    p.grenades.splice(idx, 1);
    this.cancelAction(p);
    p.fireHeld = false;
    p.firePending = false;
    p.scoped = false;
    p.throwCd = GRENADE_RULES.throwCooldownTicks;
    p.cooldown = Math.max(p.cooldown, GRENADE_RULES.throwCooldownTicks);
    const left = idiv(power * GRENADE_RULES.maxThrowRange * UNIT, 100);
    this.projectiles.push({ kind, owner: p.id, x: p.x, y: p.y, dx: icosC(c), dy: isinC(c), left, bounces: 0, moving: true, fuseTick: this.tick + GRENADES[kind].fuseTicks });
    this.roundThrows[p.group] += 1;
  }

  /** 買一項；不合法（錢不夠、陣營不符、已有、超過攜帶上限、未知）就跳過 */
  private buyOne(p: Player, item: string): void {
    if (item === 'armor') {
      if (p.armor >= ARMOR.points || p.money < ARMOR.price) return;
      p.money -= ARMOR.price;
      p.armor = ARMOR.points;
      return;
    }
    if (item === 'ammo') {
      const guns = [p.primary, p.secondary].filter((w): w is WeaponState => w !== null && w.reserve < WEAPONS[w.id].reserve);
      if (guns.length === 0 || p.money < AMMO.price) return;
      p.money -= AMMO.price;
      for (const w of guns) w.reserve = WEAPONS[w.id].reserve;
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

  private die(p: Player, killer: number, weapon: WeaponId | GrenadeId | 'bomb'): void {
    p.alive = false;
    p.hp = 0;
    p.deaths += 1;
    this.cancelAction(p);
    this.clearMove(p);
    p.fireHeld = false;
    p.firePending = false;
    p.vx = 0;
    p.vy = 0;
    // 擊殺獎金當下發（道具為 grenadeKillReward）；隊殺 −300；道具炸死自己、T 被自己的炸彈炸死算自殺 −300；炸死的 CT 不算誰的擊殺
    if (killer >= 0 && weapon !== 'bomb') {
      const k = this.players[killer];
      if (k.team !== p.team) {
        k.kills += 1;
        this.addMoney(k, isGrenade(weapon) ? ECONOMY.grenadeKillReward : WEAPONS[weapon].killReward);
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
    if (this.shotLog.length > 0 && this.shotLog[0].tick < keep) this.shotLog = this.shotLog.filter((s) => s.tick >= keep);
    if (this.hurtLog.length > 0 && this.hurtLog[0].tick < keep) this.hurtLog = this.hurtLog.filter((s) => s.tick >= keep);
    for (const p of this.players) if (p.alive) this.turn(p);
    // 角色碰撞讓移動有先後之分：處理順序輪轉，不偏袒低 id
    for (const i of moveOrder(this.tick)) if (this.players[i].alive) this.move(this.players[i]);
    for (const p of this.players) {
      if (p.blindTicks > 0) p.blindTicks -= 1;
      if (p.throwCd > 0) p.throwCd -= 1;
    }
    if (this.projectiles.length > 0) this.flyAll();
    if (this.smokes.length > 0) this.smokeTick();
    if (this.phase !== 'freeze') this.fireAll();
    for (const p of this.players) if (p.alive) this.weaponTick(p);
    if (this.fires.length > 0) this.fireTick();
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
    // 先對牆滑動，再對其他活人：會重疊的那一軸退到最遠不重疊的位置（v1.0）
    p.x += slideBodies(this.players, p, p.x, p.y, slideAxis(this.map, p.x, p.y, dx, 0, r), 0);
    p.y += slideBodies(this.players, p, p.x, p.y, slideAxis(this.map, p.x, p.y, dy, 1, r), 1);
    if (this.phase === 'freeze') {
      const z: Rect = this.map.spawnZones[p.team];
      p.x = clamp(p.x, z.x0 * UNIT + r, z.x1 * UNIT - r);
      p.y = clamp(p.y, z.y0 * UNIT + r, z.y1 * UNIT - r);
      // 夾回出生區後若和人重疊，退回這個 tick 的原位
      if ((p.x !== ox || p.y !== oy) && this.overlapsBody(p)) {
        p.x = ox;
        p.y = oy;
      }
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

  /** 是否和任一活人重疊（圓心距 < 2 × bodyRadius） */
  private overlapsBody(p: Player): boolean {
    for (const q of this.players) {
      if (q === p || !q.alive) continue;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      if (dx * dx + dy * dy < BODY_GAP_SQ) return true;
    }
    return false;
  }

  /** 所有人同時開火：先算出全部命中，再一起扣血（處理順序不影響結果） */
  private fireAll(): void {
    const hits: PendingHit[] = [];
    const fired = new Uint8Array(PLAYER_COUNT);
    let smokes: readonly SightBlocker[] | undefined;
    const victimMasks: (number | undefined)[] = [];
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
      p.lastShotTick = this.tick;
      fired[p.id] = 1;
      const spread = spreadOf(p);
      const maxLen = wid === 'knife' ? def.range * UNIT + VISION.bodyRadius : MAX_RAY;
      smokes ??= this.smokeBlockers();
      const seeShooter = this.seenMask(p, smokes);
      for (let k = 0; k < def.pellets; k++) {
        const off = spread > 0 ? this.prng.range(-spread, spread) : 0;
        const ang = normCdeg(p.facing + off);
        const dx = icosC(ang);
        const dy = isinC(ang);
        const tr = this.trace(p, dx, dy, maxLen);
        const wx = p.x + tdiv(dx * tr.wall, 10000);
        const wy = p.y + tdiv(dy * tr.wall, 10000);
        const hit = tr.victim < 0 ? null : tr;
        const vq = hit === null ? null : this.players[hit.victim];
        const seeVictim = vq === null ? 0 : (victimMasks[vq.id] ??= this.seenMask(vq, smokes));
        const rec: ShotRec = { tick: this.tick, shooter: p.id, sx: p.x, sy: p.y, ex: vq?.x ?? wx, ey: vq?.y ?? wy, wx, wy, victim: hit?.victim ?? -1, seeShooter, seeVictim, kill: false, damage: 0 };
        this.shotLog.push(rec);
        if (hit === null) continue;
        const dmg = damageAt(def, hit.dist);
        const friendly = this.players[hit.victim].team === p.team;
        hits.push({ rec, attacker: p.id, victim: hit.victim, damage: friendly ? applyPercent(dmg, FRIENDLY_FIRE_PCT) : dmg, pen: def.armorPen, weapon: wid });
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
      const a = this.players[h.attacker];
      this.hurtLog.push({ tick: this.tick, victim: v.id, fx: a.x, fy: a.y });
      const { hpLoss, armorLoss } = armorSplit(h.damage, v.armor, h.pen);
      v.armor -= armorLoss;
      const wasAlive = v.hp > 0;
      h.rec.damage = Math.min(hpLoss, Math.max(0, v.hp));
      v.hp -= hpLoss;
      if (wasAlive && v.hp <= 0) {
        killedBy[v.id] = h.attacker;
        killWeapon[v.id] = h.weapon;
      }
    }
    for (const s of this.shotLog) if (s.tick === this.tick && s.victim >= 0 && killedBy[s.victim] === s.shooter) s.kill = true;
    for (const p of this.players) if (p.alive && p.hp <= 0) this.die(p, killedBy[p.id], killWeapon[p.id] ?? 'knife');
  }

  /**
   * 子彈射線：牆前第一個人，不分敵我（隊友會擋子彈；傷害打 FRIENDLY_FIRE_PCT 折扣由呼叫端處理）。
   * 矮牆（v0.5）：開槍的人蹲著時貼近他的矮牆擋子彈；蹲在矮牆後的人打不到，子彈繼續往後飛。
   * 回傳 victim = -1 表示沒打中人；wall = 撞牆距離
   */
  private trace(p: Player, cx: number, cy: number, maxLen: number): { victim: number; dist: number; wall: number } {
    const wall = rayWallDistance(this.map, p.x, p.y, cx, cy, maxLen, p.crouching ? VISION.lowCoverRange * UNIT : 0);
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
      if (q.crouching && lowCoverBlocks(this.map, p.x, p.y, q.x, q.y, false, true)) continue;
      best = q.id;
      bestT = t;
    }
    return { victim: best, dist: best < 0 ? 0 : distance(p.x, p.y, this.players[best].x, this.players[best].y), wall };
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

  // ───────── 道具 ─────────

  /** 投射物：到引信時間就在當下位置生效；否則直線飛行一步，燃燒落地（含第二次碰牆）即生效 */
  private flyAll(): void {
    const keep: Projectile[] = [];
    for (const g of this.projectiles) {
      const incendiary = g.kind === 'molotov' || g.kind === 'incendiary';
      if (this.tick >= g.fuseTick) {
        this.detonate(g);
        continue;
      }
      if (g.moving) this.fly(g);
      if (incendiary && !g.moving) this.detonate(g);
      else keep.push(g);
    }
    this.projectiles = keep;
  }

  /**
   * 飛一步（最多 flySpeed）：x、y 分軸移動，碰牆的軸把方向分量反號（軸對齊牆面的法線鏡射，整數）；
   * 剩餘距離扣實際移動量。已反彈 maxBounces 次後再碰牆、或走完距離就停（落地）。反彈與落地發 grenadeLand
   */
  private fly(g: Projectile): void {
    const step = Math.min(GRENADE_RULES.flySpeed, g.left);
    const r = GRENADE_RULES.projectileRadius;
    const wx = tdiv(g.dx * step, 10000);
    const wy = tdiv(g.dy * step, 10000);
    const mx = slideAxis(this.map, g.x, g.y, wx, 0, r, true);
    g.x += mx;
    const my = slideAxis(this.map, g.x, g.y, wy, 1, r, true);
    g.y += my;
    const hitX = mx !== wx;
    const hitY = my !== wy;
    const range = SOUND.actionRange * UNIT;
    if (hitX || hitY) {
      g.left = Math.max(0, g.left - distance(0, 0, mx, my));
      if (g.bounces >= GRENADE_RULES.maxBounces) {
        g.moving = false;
        g.left = 0;
      } else {
        g.bounces += 1;
        if (hitX) g.dx = -g.dx;
        if (hitY) g.dy = -g.dy;
      }
      this.emit('grenadeLand', g.x, g.y, g.owner, null, range);
      return;
    }
    g.left -= step;
    if (g.left <= 0) {
      g.left = 0;
      g.moving = false;
      this.emit('grenadeLand', g.x, g.y, g.owner, null, range);
    }
  }

  private detonate(g: Projectile): void {
    switch (g.kind) {
      case 'smoke':
        this.smokes.push({ x: g.x, y: g.y, owner: g.owner, startTick: this.tick, endTick: this.tick + GRENADES.smoke.durationTicks });
        this.emit('grenadeLand', g.x, g.y, g.owner, null, SOUND.actionRange * UNIT);
        return;
      case 'flash':
        this.flash(g);
        return;
      case 'he':
        this.heBlast(g);
        return;
      default:
        this.ignite(g);
    }
  }

  /** 閃光：所有活著的人（含隊友與自己），15 格內且有視線（牆與煙霧都擋）才致盲；取較大值不累加 */
  private flash(g: Projectile): void {
    this.emit('explosion', g.x, g.y, g.owner, null, SOUND.explosionRange * UNIT);
    const smokes = GRENADE_RULES.flashBlockedBySmoke ? this.smokeBlockers() : [];
    const owner = this.players[g.owner];
    for (const p of this.players) {
      if (!p.alive) continue;
      const t = flashTicks(p.facing, p.x, p.y, g.x, g.y);
      if (t <= p.blindTicks || !lineOfSight(this.map, p.x, p.y, g.x, g.y, smokes)) continue;
      if (p.team === owner.team) this.roundFlashTeam[owner.group] += t - p.blindTicks;
      else this.roundFlashEnemy[owner.group] += t - p.blindTicks;
      p.blindTicks = t;
    }
  }

  /** 道具傷害的敵我倍率：自己 selfDamagePct、隊友 FRIENDLY_FIRE_PCT、敵人全額 */
  private grenadeDamagePct(owner: Player, p: Player): number {
    if (p.id === owner.id) return GRENADE_RULES.selfDamagePct;
    return p.team === owner.team ? FRIENDLY_FIRE_PCT : 100;
  }

  /** 手雷：半徑內線性衰減、有視線才算（牆擋；蹲在矮牆後也擋，v0.5）；護甲吸收 heArmorPct% 並扣甲；傷害同時結算，擊殺歸投擲者 */
  private heBlast(g: Projectile): void {
    this.emit('explosion', g.x, g.y, g.owner, null, SOUND.explosionRange * UNIT);
    const smokes = GRENADE_RULES.heBlockedBySmoke ? this.smokeBlockers() : [];
    const owner = this.players[g.owner];
    for (const p of this.players) {
      if (!p.alive) continue;
      const raw = heDamageAt(distance(p.x, p.y, g.x, g.y));
      if (raw <= 0 || !lineOfSight(this.map, g.x, g.y, p.x, p.y, smokes, false, p.crouching)) continue;
      this.hurtLog.push({ tick: this.tick, victim: p.id, fx: g.x, fy: g.y });
      const { hpLoss, armorLoss } = armorSplit(applyPercent(raw, this.grenadeDamagePct(owner, p)), p.armor, 100 - GRENADE_RULES.heArmorPct);
      p.armor -= armorLoss;
      p.hp -= hpLoss;
    }
    for (const p of this.players) if (p.alive && p.hp <= 0) this.die(p, g.owner, 'he');
  }

  /** 燃燒點火：與任何煙霧重疊就不點燃；到引信上限才在空中點火時發 grenadeLand（落地時已發過） */
  private ignite(g: Projectile): void {
    if (g.moving) this.emit('grenadeLand', g.x, g.y, g.owner, null, SOUND.actionRange * UNIT);
    const R = GRENADES[g.kind].radius;
    for (const s of this.smokes) if (distance(s.x, s.y, g.x, g.y) < smokeRadius(s, this.tick) + R) return;
    this.fires.push({ x: g.x, y: g.y, owner: g.owner, kind: g.kind, startTick: this.tick, endTick: this.tick + GRENADES[g.kind].durationTicks, cells: burnCells(this.map, g.x, g.y, R) });
  }

  /** 煙霧到時消失；生效中（含擴散中）與火圈重疊（圓心距 < 兩半徑和）就撲滅該火 */
  private smokeTick(): void {
    this.smokes = this.smokes.filter((sm) => this.tick < sm.endTick);
    if (this.fires.length === 0) return;
    this.fires = this.fires.filter((f) => !this.smokes.some((sm) => distance(sm.x, sm.y, f.x, f.y) < smokeRadius(sm, this.tick) + GRENADES[f.kind].radius));
  }

  /** 火焰結算：點火後每 fireTickInterval 對站在燒得到的格子（burnCells，牆擋火）上活著的人扣 FIRE_TICK_DAMAGE（不吃護甲；隊友 30%）；到時熄滅 */
  private fireTick(): void {
    const interval = GRENADE_RULES.fireTickInterval;
    const killedBy = new Int32Array(PLAYER_COUNT).fill(-1);
    const killKind: GrenadeId[] = new Array<GrenadeId>(PLAYER_COUNT).fill('molotov');
    for (const f of this.fires) {
      const el = this.tick - f.startTick;
      if (el <= 0 || el % interval !== 0) continue;
      const owner = this.players[f.owner];
      for (const p of this.players) {
        if (!p.alive || p.hp <= 0 || !f.cells.includes(cellOf(p.y) * this.map.width + cellOf(p.x))) continue;
        p.hp -= applyPercent(FIRE_TICK_DAMAGE, this.grenadeDamagePct(owner, p));
        if (p.hp <= 0) {
          killedBy[p.id] = f.owner;
          killKind[p.id] = f.kind;
        }
      }
    }
    for (const p of this.players) if (p.alive && p.hp <= 0) this.die(p, killedBy[p.id], killKind[p.id]);
    this.fires = this.fires.filter((f) => this.tick < f.endTick);
  }

  /** 目前擋視線的煙霧（當下實際半徑） */
  private smokeBlockers(): SightBlocker[] {
    const out: SightBlocker[] = [];
    for (const sm of this.smokes) {
      if (this.tick < sm.startTick || this.tick >= sm.endTick) continue;
      const radius = smokeRadius(sm, this.tick);
      if (radius > 0) out.push({ x: sm.x, y: sm.y, radius });
    }
    return out;
  }

  // ───────── 觀察 ─────────

  /** 視野矩陣：vis[i × 10 + j] = 1 表示 i 此刻看得見敵人 j（視錐內、有視線、i 沒被致盲） */
  private visibility(): Uint8Array {
    if (this.visTick === this.tick) return this.vis;
    this.visTick = this.tick;
    this.vis.fill(0);
    const smokes = this.smokeBlockers();
    for (const a of this.players) {
      if (!a.alive || a.blindTicks > 0) continue;
      const fov = a.scoped ? VISION.scopedFovDeg : VISION.fovDeg;
      for (const b of this.players) {
        if (!b.alive || b.team === a.team) continue;
        if (this.sees(a, fov, b.x, b.y, smokes, b.crouching)) this.vis[a.id * PLAYER_COUNT + b.id] = 1;
      }
    }
    return this.vis;
  }

  /**
   * 視錐內、視野距離內（開鏡另計，v0.5）且有視線（牆與煙霧都擋；任一方蹲著時貼近他的矮牆也擋）。
   * targetLow = 目標是蹲著的人
   */
  private sees(a: Player, fov: number, x: number, y: number, smokes: readonly SightBlocker[], targetLow = false): boolean {
    const range = a.scoped ? VISION.scopedViewRange : VISION.viewRange;
    if (range !== null) {
      const r = range * UNIT;
      if ((x - a.x) * (x - a.x) + (y - a.y) * (y - a.y) > r * r) return false;
    }
    return inCone(a.facing, fov, a.x, a.y, x, y) && lineOfSight(this.map, a.x, a.y, x, y, smokes, a.crouching, targetLow);
  }

  /** 此刻誰看得見 target（位元遮罩，第 i 位 = 選手 i）：同隊一律算；敵人要活著、沒被致盲、視錐內有視線（v0.5，彈道顯示用） */
  private seenMask(target: Player, smokes: readonly SightBlocker[]): number {
    let mask = 0;
    for (const q of this.players) {
      if (q.team === target.team) mask |= 1 << q.id;
      else if (q.alive && q.blindTicks === 0 && this.sees(q, q.scoped ? VISION.scopedFovDeg : VISION.fovDeg, target.x, target.y, smokes, target.crouching)) mask |= 1 << q.id;
    }
    return mask;
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
          enemies.push({ id: e.id, x: e.x, y: e.y, facing: this.deg(e.facing), weapon: activeWeaponId(e), crouching: e.crouching, planting: e.plantTicks > 0, defusing: e.defuseTicks > 0, hasBomb: e.hasBomb, firing: this.tick - e.lastShotTick <= DECISION_INTERVAL });
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
      firing: this.tick - m.lastShotTick <= DECISION_INTERVAL,
    }));
    const smokes = this.smokeBlockers();
    const canLook = me.alive && !blind;
    const items: DroppedItem[] = [];
    for (const it of this.items) {
      const known = it.kind === 'bomb' && me.team === 'T';
      if (known || (canLook && this.itemVisible(me, it.x, it.y, smokes))) items.push({ kind: it.kind, weapon: it.weapon?.id ?? null, x: it.x, y: it.y });
    }
    const effects: AreaEffect[] = [];
    const projectiles: ProjectileInfo[] = [];
    if (canLook) {
      const fov = me.scoped ? VISION.scopedFovDeg : VISION.fovDeg;
      // 煙霧：貼近（半徑＋2 格內）或視錐內對煙霧中心有牆的視線（煙霧本身是大物體，不再被其他煙擋）
      for (const sm of this.smokes) {
        const radius = smokeRadius(sm, this.tick);
        if (this.tick >= sm.endTick || radius <= 0) continue;
        if (distance(me.x, me.y, sm.x, sm.y) <= radius + NEAR_ITEM || this.sees(me, fov, sm.x, sm.y, [])) effects.push({ kind: 'smoke', x: sm.x, y: sm.y, radius, ticksLeft: sm.endTick - this.tick });
      }
      for (const f of this.fires) {
        const radius = GRENADES[f.kind].radius;
        if (distance(me.x, me.y, f.x, f.y) <= radius + NEAR_ITEM || this.sees(me, fov, f.x, f.y, smokes)) effects.push({ kind: 'fire', x: f.x, y: f.y, radius, ticksLeft: f.endTick - this.tick, cells: f.cells });
      }
      for (const g of this.projectiles) {
        if (distance(me.x, me.y, g.x, g.y) <= GRENADE_RULES.nearProjectile || this.sees(me, fov, g.x, g.y, smokes)) projectiles.push({ kind: g.kind, x: g.x, y: g.y });
      }
    }
    // 自己的子彈與受傷（v0.5）：上一次決策以來；打中看不見的人時終點改給撞牆處，不洩漏位置
    const from = this.tick - DECISION_INTERVAL;
    const shots: ShotTrace[] = [];
    for (const s of this.shotLog) {
      if (s.tick < from || s.tick >= this.tick || s.shooter !== pid) continue;
      const v = s.victim < 0 ? null : this.players[s.victim];
      // 打中自己看不見的人：當作沒打中（不給命中、傷害、擊殺，終點是撞牆處；擊殺訊息另外公開）
      const shown = v !== null && (s.seeVictim & (1 << pid)) !== 0;
      shots.push(shown ? { tick: s.tick, x: s.ex, y: s.ey, hit: v.team === me.team ? 'teammate' : 'enemy', kill: s.kill, damage: s.damage } : { tick: s.tick, x: s.wx, y: s.wy, hit: null, kill: false, damage: 0 });
    }
    // 別人的子彈（v0.5）：隊友的、或開槍當下自己看得見的敵人的；終點同上，打中自己看不見的人只畫到撞牆處
    const tracers: TracerInfo[] = [];
    if (me.alive && !blind) {
      for (const s of this.shotLog) {
        if (s.tick < from || s.tick >= this.tick || s.shooter === pid || (s.seeShooter & (1 << pid)) === 0) continue;
        const shown = s.victim >= 0 && (s.seeVictim & (1 << pid)) !== 0;
        tracers.push({ tick: s.tick, x0: s.sx, y0: s.sy, x1: shown ? s.ex : s.wx, y1: shown ? s.ey : s.wy, friendly: this.players[s.shooter].team === me.team });
      }
    }
    const hurt: HurtEvent[] = [];
    for (const r of this.hurtLog) {
      if (r.tick < from || r.tick >= this.tick || r.victim !== pid) continue;
      hurt.push({ tick: r.tick, dirDeg: r.fx === me.x && r.fy === me.y ? 0 : quantizeDir(me.x, me.y, r.fx, r.fy) });
    }
    const w = activeState(me);
    return {
      tick: this.tick,
      round: {
        number: this.roundNumber,
        half: this.half,
        overtime: this.overtime,
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
        shots,
        hurt,
      },
      teammates,
      enemies,
      radar,
      tracers,
      sounds,
      bomb: this.bombInfo(me, enemies, smokes),
      effects,
      items,
      projectiles,
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

  private itemVisible(me: Player, x: number, y: number, smokes: readonly SightBlocker[]): boolean {
    if (distance(me.x, me.y, x, y) <= NEAR_ITEM) return true;
    return this.sees(me, me.scoped ? VISION.scopedFovDeg : VISION.fovDeg, x, y, smokes);
  }

  private deg(c: number): number {
    return idiv(c + 50, 100) % 360;
  }

  /** 炸彈資訊依觀察者的隊伍與視野而定（CT 在下包前看不見就不知道炸彈在哪） */
  private bombInfo(me: Player, enemies: readonly EnemyInfo[], smokes: readonly SightBlocker[]): BombInfo {
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
    if (me.alive && me.blindTicks === 0 && this.itemVisible(me, b.x, b.y, smokes)) return { state: 'dropped', x: b.x, y: b.y, site: null, ticksLeft: null };
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
      overtimes: this.overtime,
    };
  }

  hash(): string {
    const h = new Hasher();
    h.int(this.tick).int(this.roundNumber).int(PHASE_CODE[this.phase]).int(this.phaseEnd).int(this.score[0]).int(this.score[1]).bool(this.over).int(this.lossLevel[0]).int(this.lossLevel[1]);
    h.int(this.half).int(this.overtime).int(this.overtimeBase);
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
      h.bool(p.walking).bool(p.crouching).bool(p.scoped).int(p.lastShotTick).str(p.moveKind).int(p.path.length).int(p.pathIdx).int(p.goalX).int(p.goalY).int(p.moveDeg).int(p.stuck);
      h.int(p.aimX ?? -1).int(p.aimY ?? -1).int(p.vx).int(p.vy).bool(p.hasBomb).int(p.plantTicks).int(p.defuseTicks).int(p.blindTicks).int(p.throwCd).int(p.kills).int(p.deaths);
    }
    const b = this.bomb;
    h.int(BOMB_CODE[b.state]).int(b.carrier).int(b.x).int(b.y).str(b.site ?? '').int(b.explodeTick).int(b.planter).int(b.defuser);
    h.int(this.items.length);
    for (const it of this.items) {
      h.str(it.kind).int(it.x).int(it.y);
      ws(it.weapon);
    }
    h.int(this.projectiles.length);
    for (const g of this.projectiles) h.int(GRENADE_IDS.indexOf(g.kind)).int(g.owner).int(g.x).int(g.y).int(g.dx).int(g.dy).int(g.left).int(g.bounces).bool(g.moving).int(g.fuseTick);
    h.int(this.smokes.length);
    for (const sm of this.smokes) h.int(sm.x).int(sm.y).int(sm.owner).int(sm.startTick).int(sm.endTick);
    h.int(this.fires.length);
    for (const f of this.fires) h.int(f.x).int(f.y).int(f.owner).int(GRENADE_IDS.indexOf(f.kind)).int(f.startTick).int(f.endTick);
    h.int(this.sounds.length).int(this.chat.length).int(this.shotLog.length).int(this.hurtLog.length);
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

