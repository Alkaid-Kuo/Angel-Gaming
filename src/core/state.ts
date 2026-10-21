// 引擎內部狀態型別。所有數值皆為整數；實體陣列一律依 id 由小到大排列。
import type { GameEvent, KnobValues } from '../api/types.ts';
import type { BuildingType, MatchMode, RejectReason, Stance, UnitType } from '../config/index.ts';
import type { PathCache, PathFinder } from '../path/index.ts';
import type { Prng } from '../shared/prng.ts';
import type { GeneratedMap } from '../mapgen/index.ts';
import type { SpatialIndex } from './spatial.ts';

export type UnitOrder =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'attackMove'; x: number; y: number }
  | { kind: 'attack'; targetId: number }
  | { kind: 'gather'; nodeId: number }
  | { kind: 'build'; building: BuildingType; tileX: number; tileY: number }
  | { kind: 'construct'; buildingId: number };

/** 採集循環階段 */
export const GATHER = {
  none: 0,
  toNode: 1,
  waiting: 2,
  mining: 3,
  toDepot: 4,
} as const;
export type GatherPhase = 0 | 1 | 2 | 3 | 4;

export interface Unit {
  readonly id: number;
  readonly owner: number;
  readonly type: UnitType;
  x: number;
  y: number;
  hp: number;
  stance: Stance;
  /** 編隊 0～9；-1 為無 */
  group: number;
  order: UnitOrder;
  /** 駐守點 */
  guardX: number;
  guardY: number;

  // ── 移動 ──
  /** 路徑點 [x0, y0, x1, y1, ...]（單位座標）；null 表示沒有路徑 */
  path: number[] | null;
  pathIdx: number;
  /** 路徑對應的目的地鍵值（目的地改變即重算） */
  pathKey: number;
  /** 計算路徑時的建築版本 */
  pathBlockVersion: number;
  pathTick: number;
  /** 目的地：點（destRectSize = 0）或接近某個矩形（礦點、建築） */
  destX: number;
  destY: number;
  destRectX: number;
  destRectY: number;
  destRectSize: number;
  /** 本 tick 是否要移動（由單位 AI 或採集狀態機設定） */
  wantMove: boolean;
  /** 本 tick 已走完路徑 */
  arrived: boolean;
  /** 移動受阻連續 tick 數 */
  stuckTicks: number;

  // ── 戰鬥 ──
  /** 自動交戰的目標（0 為無） */
  targetId: number;
  /** 追擊起點／防守駐守點 */
  chaseX: number;
  chaseY: number;
  /** 放棄追擊、正在返回 chaseX/chaseY */
  returning: boolean;
  /** 冷卻結束的 tick */
  nextAttackTick: number;
  /** 本 tick 要攻擊的目標（單位 AI 決定，攻擊階段結算） */
  attackTarget: number;
  /** 最近一次實際攻擊的目標與 tick（用於「正在攻擊自己的敵人」判定） */
  lastHitTarget: number;
  lastHitTick: number;

  // ── 工人 ──
  carry: number;
  /** carry 中來自富礦的部分 */
  carryRich: number;
  gatherNodeId: number;
  gatherPhase: GatherPhase;
  mineEndTick: number;

  // ── 視野／統計 ──
  visTile: number;
  visRadius: number;
  /** 目前位於哪些敵方起點偵察範圍內（以 playerId 為位元） */
  scoutMask: number;
}

export interface QueueItem {
  readonly unit: UnitType;
  progress: number;
}

export interface Building {
  readonly id: number;
  readonly owner: number;
  readonly type: BuildingType;
  readonly tileX: number;
  readonly tileY: number;
  readonly size: number;
  hp: number;
  readonly maxHp: number;
  complete: boolean;
  /** 已建造 tick 數 */
  progress: number;
  /** 正在建造的工人 id（0 為暫停） */
  builderId: number;
  queue: QueueItem[];
  hasRally: boolean;
  rallyX: number;
  rallyY: number;
  // 防禦塔
  targetId: number;
  attackTarget: number;
  nextAttackTick: number;
  lastHitTarget: number;
  lastHitTick: number;
  // 視野
  visTile: number;
  visRadius: number;
  visCorner: boolean;
}

export interface MineNode {
  readonly id: number;
  /** 在 nodes 陣列中的索引 */
  readonly index: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly rich: boolean;
  readonly areaId: number;
  reserve: number;
  /** 正在開採的工人 id（0 為無） */
  minerId: number;
  /** 排隊等候的工人 id（先到先採） */
  queue: number[];
}

export interface Watchtower {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** 佔領者 playerId；-1 為無 */
  owner: number;
  /** 各選手的佔領進度 */
  progress: Int32Array;
  /** 目前獲得瞭望塔視野的選手（-1 為無） */
  visOwner: number;
}

export interface BuildingMemory {
  readonly id: number;
  readonly owner: number;
  readonly type: BuildingType;
  readonly tileX: number;
  readonly tileY: number;
  readonly size: number;
  hp: number;
  complete: boolean;
  progressPercent: number;
  lastSeenTick: number;
  visibleNow: boolean;
}

export interface PlayerStats {
  gathered: number;
  richGathered: number;
  unitsProduced: Record<UnitType, number>;
  unitsLost: number;
  unitKills: number;
  workerKills: number;
  buildingKills: number;
  buildingsBuilt: Record<BuildingType, number>;
  firstExpansionTick: number;
  firstDamageTick: number;
  commandsIssued: number;
  rejections: Record<RejectReason, number>;
  scoutCount: number;
  towerHeldTicks: number;
}

export interface Player {
  readonly id: number;
  readonly slot: number;
  /** 起點主堡中心（單位座標） */
  readonly startX: number;
  readonly startY: number;
  /** 主礦區 areaId */
  readonly mainAreaId: number;
  minerals: number;
  supplyUsed: number;
  supplyCap: number;
  budget: number;
  alive: boolean;
  eliminatedTick: number;
  eliminationScore: number;
  knobs: KnobValues;
  /** 視野計數（每格被幾個來源看見） */
  vis: Uint16Array;
  explored: Uint8Array;
  /** 上次觀察後新探索的格 */
  exploredDelta: number[];
  memory: Map<number, BuildingMemory>;
  /** 各礦點最後已知儲量（依 node.index） */
  nodeKnown: Int32Array;
  events: GameEvent[];
  stats: PlayerStats;
}

export interface MatchState {
  readonly mode: MatchMode;
  readonly seed: number;
  readonly map: GeneratedMap;
  readonly width: number;
  readonly height: number;
  tick: number;
  nextId: number;
  readonly rng: Prng;
  readonly players: Player[];
  /** 依 id 排序 */
  units: Unit[];
  buildings: Building[];
  readonly nodes: MineNode[];
  readonly towers: Watchtower[];
  readonly unitById: Map<number, Unit>;
  readonly buildingById: Map<number, Building>;
  readonly nodeById: Map<number, MineNode>;
  /** 通行格網：0 阻擋（地形、建築、礦點）、1 平地、2 樹林 */
  readonly walk: Uint8Array;
  /** 每格的建築 id（0 為無） */
  readonly buildingAt: Int32Array;
  /** 每格的礦點 id（0 為無） */
  readonly nodeAt: Int32Array;
  /** 建築新增時遞增，用於判斷單位身上的路徑是否可能被擋 */
  blockVersion: number;
  readonly pathFinder: PathFinder;
  /** 全域路徑快取；通行格網任何改變（建築新增或移除）都會清空 */
  readonly pathCache: PathCache;
  readonly spatial: SpatialIndex;
  over: boolean;
  /** 是否記錄事件（回放重建時關閉） */
  recordEvents: boolean;
}
