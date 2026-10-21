// 所有遊戲數值與常數集中於此（規格書 v0.2 初始值）。
// 長度單位：「單位」（1 格 = 1000 單位）；時間單位：tick（1 秒 = 10 tick）。

export const ENGINE_VERSION = '0.1.0';
export const SPEC_VERSION = '0.2';

export type UnitType = 'worker' | 'spear' | 'archer' | 'cavalry';
export type BuildingType = 'base' | 'depot' | 'supply' | 'barracks' | 'tower';
export type Stance = 'aggressive' | 'defensive' | 'hold' | 'retreat';
export type MatchMode = '1v1' | 'ffa4';
/** 倍率表的目標類別 */
export type TargetClass = UnitType | 'building';

export const UNIT_TYPES: readonly UnitType[] = ['worker', 'spear', 'archer', 'cavalry'];
export const COMBAT_UNIT_TYPES: readonly UnitType[] = ['spear', 'archer', 'cavalry'];
export const BUILDING_TYPES: readonly BuildingType[] = ['base', 'depot', 'supply', 'barracks', 'tower'];
export const STANCES: readonly Stance[] = ['aggressive', 'defensive', 'hold', 'retreat'];
export const MATCH_MODES: readonly MatchMode[] = ['1v1', 'ffa4'];

export interface UnitStats {
  readonly producer: BuildingType;
  readonly cost: number;
  readonly supply: number;
  readonly trainTicks: number;
  readonly hp: number;
  readonly attack: number;
  readonly cooldown: number;
  /** 射程（單位）。依決策 Q1A：攻擊方邊緣到目標邊緣的距離 */
  readonly range: number;
  /** 每 tick 移動單位 */
  readonly speed: number;
  /** 視野（格） */
  readonly sight: number;
  /** 碰撞半徑（單位） */
  readonly radius: number;
}

export interface BuildingStats {
  readonly size: number;
  readonly cost: number;
  readonly buildTicks: number;
  readonly hp: number;
  readonly sight: number;
  readonly supplyProvided: number;
  readonly isDropoff: boolean;
  readonly produces: readonly UnitType[];
  /** 防禦塔的攻擊數值；非攻擊建築為 null */
  readonly weapon: { readonly attack: number; readonly cooldown: number; readonly range: number } | null;
}

export const TICKS_PER_SECOND = 10;
export const TILE_SIZE = 1000;

export const UNIT_STATS: Readonly<Record<UnitType, UnitStats>> = {
  worker: { producer: 'base', cost: 50, supply: 1, trainTicks: 120, hp: 40, attack: 4, cooldown: 10, range: 200, speed: 250, sight: 6, radius: 300 },
  spear: { producer: 'barracks', cost: 60, supply: 1, trainTicks: 150, hp: 120, attack: 10, cooldown: 12, range: 200, speed: 200, sight: 6, radius: 350 },
  archer: { producer: 'barracks', cost: 70, supply: 1, trainTicks: 180, hp: 60, attack: 8, cooldown: 15, range: 5000, speed: 220, sight: 8, radius: 350 },
  cavalry: { producer: 'barracks', cost: 100, supply: 2, trainTicks: 220, hp: 150, attack: 12, cooldown: 12, range: 200, speed: 400, sight: 8, radius: 450 },
};

export const BUILDING_STATS: Readonly<Record<BuildingType, BuildingStats>> = {
  base: { size: 3, cost: 400, buildTicks: 600, hp: 1500, sight: 9, supplyProvided: 10, isDropoff: true, produces: ['worker'], weapon: null },
  depot: { size: 2, cost: 100, buildTicks: 200, hp: 400, sight: 5, supplyProvided: 0, isDropoff: true, produces: [], weapon: null },
  supply: { size: 1, cost: 80, buildTicks: 200, hp: 300, sight: 5, supplyProvided: 8, isDropoff: false, produces: [], weapon: null },
  barracks: { size: 2, cost: 150, buildTicks: 300, hp: 800, sight: 5, supplyProvided: 0, isDropoff: false, produces: ['spear', 'archer', 'cavalry'], weapon: null },
  tower: { size: 1, cost: 120, buildTicks: 300, hp: 600, sight: 9, supplyProvided: 0, isDropoff: false, produces: [], weapon: { attack: 12, cooldown: 15, range: 6000 } },
};

/** 兵種倍率（攻擊方 → 目標類別），整數百分比；防禦塔不攻擊建築（null） */
export const DAMAGE_MULTIPLIER: Readonly<Record<UnitType | 'tower', Readonly<Record<TargetClass, number | null>>>> = {
  worker: { spear: 100, archer: 100, cavalry: 100, worker: 100, building: 100 },
  spear: { spear: 100, archer: 100, cavalry: 200, worker: 100, building: 100 },
  archer: { spear: 100, archer: 100, cavalry: 100, worker: 100, building: 50 },
  cavalry: { spear: 100, archer: 150, cavalry: 100, worker: 100, building: 100 },
  tower: { spear: 100, archer: 100, cavalry: 100, worker: 100, building: null },
};

export const RULES = {
  combat: {
    minDamage: 1,
  },
  economy: {
    startMinerals: 100,
    startWorkers: 4,
    mineTicks: 20,
    mineAmount: 5,
    richMineAmount: 8,
    nodeReserve: 1000,
    richNodeReserve: 1200,
    /** 工人與礦點／卸貨點／建築互動的距離（中心到邊緣，單位） */
    interactRange: 200,
  },
  supply: {
    hardCap: 50,
  },
  production: {
    queueMax: 5,
  },
  construction: {
    startHpPercent: 10,
    cancelRefundPercent: 75,
  },
  movement: {
    forestSpeedPercent: 60,
    /** 追擊移動中目標時，重算 A* 的最小間隔（tick） */
    chaseRepathTicks: 5,
  },
  vision: {
    /** 樹林格只有觀察者距離 ≤ 此格數時可見 */
    forestSightTiles: 2,
    /** 建造中建築視野倍率（%） */
    constructingSightPercent: 50,
  },
  watchtower: {
    captureRadiusTiles: 3,
    captureTarget: 100,
    sightTiles: 12,
  },
  stance: {
    aggressiveChaseTiles: 8,
    defensiveLeashTiles: 3,
  },
  match: {
    timeLimitTicks: 6000,
    decisionInterval: 5,
  },
  budget: {
    capacity: 5,
    refillInterval: 2,
    initial: 5,
  },
  timing: {
    decideSoftMs: 5,
    hardMs: 50,
    /** 依決策 Q2A：init 只有一道 1000 ms 上限 */
    initMs: 1000,
  },
  botModule: {
    maxBytes: 200 * 1024,
    minKnobs: 3,
    maxKnobs: 6,
  },
  replay: {
    hashInterval: 100,
  },
  stats: {
    /** 偵察：單位進入敵方起點（主堡中心）此格數內記一次 */
    scoutRadiusTiles: 15,
    /** 擴張判定：在非己方主礦區礦點此格數內開始建造主堡或採集站 */
    expansionRadiusTiles: 8,
  },
  spatial: {
    bucketTiles: 4,
  },
} as const;

export const PATH_COST = {
  straight: 10,
  diagonal: 14,
  /** 樹林格成本 ×5÷3 */
  forestStraight: 17,
  forestDiagonal: 23,
  /** pathDistance 的幾何長度（單位） */
  straightLength: 1000,
  diagonalLength: 1414,
} as const;

export interface MapModeConfig {
  readonly size: number;
  readonly players: number;
  /** 旋轉對稱的扇區數（1v1 = 2：180°；4 人 = 4：90°） */
  readonly sectors: number;
  readonly obstacleBlobs: number;
}

export const MAP_MODES: Readonly<Record<MatchMode, MapModeConfig>> = {
  '1v1': { size: 64, players: 2, sectors: 2, obstacleBlobs: 6 },
  ffa4: { size: 96, players: 4, sectors: 4, obstacleBlobs: 8 },
};

/** 地圖生成參數（開發任務書「地圖生成演算法」） */
export const MAPGEN = {
  maxAttempts: 20,
  /** 主堡中心位置：N × 18 / 100，各軸偏移 ±2 格 */
  baseCenterPercent: 18,
  baseJitterTiles: 2,
  mainMine: { nodes: 4, minDistTiles: 6, maxDistTiles: 7, stepDegrees: 18 },
  ring: { minRadiusTiles: 11, maxRadiusTiles: 13, widthTiles: 2, chokeMinWidth: 3, chokeMaxWidth: 5, chokeAngleJitter: 45 },
  expansion: {
    count: 2,
    nodes: 4,
    minDistTiles: 16,
    maxDistTiles: 22,
    minSideAngle: 50,
    maxSideAngle: 80,
    nodeDistTiles: 5,
    nodeStepDegrees: 22,
    buildAreaTiles: 6,
  },
  rich: { nodes: 2, edgeMarginTiles: 3 },
  obstacles: { minRadius: 1, maxRadius: 4, blockedPercent: 60, largeForestMin: 2, largeForestMax: 3, largeForestMinRadius: 2, largeForestMaxRadius: 5 },
  protect: { nodeMarginTiles: 2, watchtowerRadiusTiles: 4, chokeExtraTiles: 4 },
  /** 地圖物件放置時，同一物件嘗試的次數 */
  placementTries: 40,
} as const;

/** 地形代碼 */
export const TERRAIN = {
  plain: 0,
  blocked: 1,
  forest: 2,
} as const;
export type TerrainCode = 0 | 1 | 2;

/** 拒絕原因代碼 */
export type RejectReason =
  | 'NO_MINERALS'
  | 'NO_SUPPLY'
  | 'BAD_PLACEMENT'
  | 'QUEUE_FULL'
  | 'WRONG_PRODUCER'
  | 'INVALID_TARGET'
  | 'NOT_OWNED'
  | 'BAD_FORMAT'
  | 'NO_BUDGET';

export const REJECT_REASONS: readonly RejectReason[] = [
  'NO_MINERALS',
  'NO_SUPPLY',
  'BAD_PLACEMENT',
  'QUEUE_FULL',
  'WRONG_PRODUCER',
  'INVALID_TARGET',
  'NOT_OWNED',
  'BAD_FORMAT',
  'NO_BUDGET',
];
