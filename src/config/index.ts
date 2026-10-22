// 所有遊戲數值與常數集中於此（規格書 v0.4；M3 新增內容的數值為提案，待審）。
// 長度單位：「單位」（1 格 = 1000 單位）；時間單位：tick（1 秒 = 10 tick）。

export const ENGINE_VERSION = '0.3.0';
export const SPEC_VERSION = '0.4';

export type UnitType = 'worker' | 'spear' | 'archer' | 'cavalry' | 'siege';
export type BuildingType = 'base' | 'depot' | 'supply' | 'barracks' | 'tower' | 'forge' | 'workshop';
export type ResearchType = 'weapons' | 'armor';
export type Stance = 'aggressive' | 'defensive' | 'hold' | 'retreat';
export type MatchMode = '1v1' | 'ffa4' | 'ffa8';
/** 倍率表的目標類別 */
export type TargetClass = UnitType | 'building';

export const UNIT_TYPES: readonly UnitType[] = ['worker', 'spear', 'archer', 'cavalry', 'siege'];
export const COMBAT_UNIT_TYPES: readonly UnitType[] = ['spear', 'archer', 'cavalry', 'siege'];
export const BUILDING_TYPES: readonly BuildingType[] = ['base', 'depot', 'supply', 'barracks', 'tower', 'forge', 'workshop'];
export const RESEARCH_TYPES: readonly ResearchType[] = ['weapons', 'armor'];
export const STANCES: readonly Stance[] = ['aggressive', 'defensive', 'hold', 'retreat'];
export const MATCH_MODES: readonly MatchMode[] = ['1v1', 'ffa4', 'ffa8'];

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
  /** 建造所需的科技等級（主堡等級）；1 表示不限 */
  readonly requiresTech: number;
  /** 可在此建築進行的研究 */
  readonly researches: readonly ResearchType[];
}

export const TICKS_PER_SECOND = 10;
export const TILE_SIZE = 1000;

/** 瀏覽器版新手教學（非正式對局）：固定地圖與較長的時限，讓新手不必趕時間 */
export const TUTORIAL = {
  seed: 20261022,
  timeLimitTicks: 36000,
} as const;

export const UNIT_STATS: Readonly<Record<UnitType, UnitStats>> = {
  worker: { producer: 'base', cost: 50, supply: 1, trainTicks: 120, hp: 40, attack: 4, cooldown: 10, range: 200, speed: 250, sight: 6, radius: 300 },
  spear: { producer: 'barracks', cost: 60, supply: 1, trainTicks: 150, hp: 120, attack: 10, cooldown: 12, range: 200, speed: 200, sight: 6, radius: 350 },
  archer: { producer: 'barracks', cost: 70, supply: 1, trainTicks: 180, hp: 60, attack: 8, cooldown: 15, range: 5000, speed: 220, sight: 8, radius: 350 },
  cavalry: { producer: 'barracks', cost: 100, supply: 2, trainTicks: 220, hp: 150, attack: 12, cooldown: 12, range: 200, speed: 400, sight: 8, radius: 450 },
  // M3 提案（待審）：攻城車只攻擊建築
  siege: { producer: 'workshop', cost: 150, supply: 3, trainTicks: 300, hp: 200, attack: 30, cooldown: 30, range: 200, speed: 150, sight: 6, radius: 500 },
};

export const BUILDING_STATS: Readonly<Record<BuildingType, BuildingStats>> = {
  base: { size: 3, cost: 400, buildTicks: 600, hp: 1500, sight: 9, supplyProvided: 10, isDropoff: true, produces: ['worker'], weapon: null, requiresTech: 1, researches: [] },
  depot: { size: 2, cost: 100, buildTicks: 200, hp: 400, sight: 5, supplyProvided: 0, isDropoff: true, produces: [], weapon: null, requiresTech: 1, researches: [] },
  supply: { size: 1, cost: 80, buildTicks: 200, hp: 300, sight: 5, supplyProvided: 8, isDropoff: false, produces: [], weapon: null, requiresTech: 1, researches: [] },
  barracks: { size: 2, cost: 150, buildTicks: 300, hp: 800, sight: 5, supplyProvided: 0, isDropoff: false, produces: ['spear', 'archer', 'cavalry'], weapon: null, requiresTech: 1, researches: [] },
  tower: { size: 1, cost: 120, buildTicks: 300, hp: 600, sight: 9, supplyProvided: 0, isDropoff: false, produces: [], weapon: { attack: 12, cooldown: 15, range: 6000 }, requiresTech: 1, researches: [] },
  // M3 提案（待審）
  forge: { size: 2, cost: 150, buildTicks: 400, hp: 700, sight: 5, supplyProvided: 0, isDropoff: false, produces: [], weapon: null, requiresTech: 2, researches: ['weapons', 'armor'] },
  workshop: { size: 2, cost: 150, buildTicks: 400, hp: 800, sight: 5, supplyProvided: 0, isDropoff: false, produces: ['siege'], weapon: null, requiresTech: 2, researches: [] },
};

/** 主堡升級（M3 提案，待審）：索引 0 = Lv1→Lv2、1 = Lv2→Lv3 */
export const BASE_UPGRADES: readonly { readonly cost: number; readonly ticks: number; readonly maxHp: number }[] = [
  { cost: 150, ticks: 450, maxHp: 2000 },
  { cost: 250, ticks: 600, maxHp: 2500 },
];
export const MAX_BASE_LEVEL = 1 + BASE_UPGRADES.length;

/** 鍛造所研究（M3 提案，待審）：每級的成本、時間、所需科技等級；效果作用於戰鬥單位 */
export const RESEARCH: Readonly<Record<ResearchType, { readonly levels: readonly { readonly cost: number; readonly ticks: number; readonly tech: number }[]; readonly perLevel: number }>> = {
  /** 武器：戰鬥單位攻擊 +1／級 */
  weapons: { levels: [{ cost: 100, ticks: 400, tech: 2 }, { cost: 175, ticks: 550, tech: 3 }], perLevel: 1 },
  /** 護甲：戰鬥單位護甲 +1／級（傷害 = max(1, 倍率後傷害 − 護甲)） */
  armor: { levels: [{ cost: 100, ticks: 400, tech: 2 }, { cost: 175, ticks: 550, tech: 3 }], perLevel: 1 },
};

/** 兵種倍率（攻擊方 → 目標類別），整數百分比；防禦塔不攻擊建築（null） */
export const DAMAGE_MULTIPLIER: Readonly<Record<UnitType | 'tower', Readonly<Record<TargetClass, number | null>>>> = {
  worker: { spear: 100, archer: 100, cavalry: 100, worker: 100, siege: 100, building: 100 },
  spear: { spear: 100, archer: 100, cavalry: 200, worker: 100, siege: 100, building: 100 },
  archer: { spear: 100, archer: 100, cavalry: 100, worker: 100, siege: 100, building: 50 },
  cavalry: { spear: 100, archer: 150, cavalry: 100, worker: 100, siege: 150, building: 100 },
  siege: { spear: null, archer: null, cavalry: null, worker: null, siege: null, building: 400 },
  tower: { spear: 100, archer: 100, cavalry: 100, worker: 100, siege: 200, building: null },
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
    /** 礦點被佔用時，工人在此距離內（中心到礦點邊緣）排隊等候，不再往前擠（v0.4） */
    queueRange: 700,
    /** 擁擠容許（v0.4）：交礦時被擠住（連續 crowdStallTicks 沒有進展）則在此距離內即可交付 */
    crowdDeliverRange: 1000,
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
    /** 移動抵達容許（v0.4）：離目的地此距離內即算抵達 */
    arriveRadius: 500,
    /** 移動抵達容許（v0.4）：離目的地此距離內且連續 crowdStallTicks 沒有進展（被擠住）即算抵達 */
    crowdArriveRadius: 3000,
    crowdStallTicks: 20,
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
    /** 回放播放器每隔多少 tick 存一個快照（跳轉用） */
    checkpointInterval: 600,
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
  /** 對稱的扇區數（1v1 = 2：180° 旋轉；4 人 = 4：90° 旋轉；8 人 = 8：90° 旋轉＋對角鏡射） */
  readonly sectors: number;
  readonly obstacleBlobs: number;
  /** 第 0 扇區主堡中心位置（地圖尺寸的百分比 [x, y]） */
  readonly basePercent: readonly [number, number];
  /** 第 0 扇區富礦區位置（地圖尺寸的百分比 [x, y]）；null 表示依規模預設 */
  readonly richPercent: readonly [number, number] | null;
  /** 兩個分礦相對「朝地圖中心方向」的角度範圍（度） */
  readonly expansionAngles: readonly [readonly [number, number], readonly [number, number]];
}

export const MAP_MODES: Readonly<Record<MatchMode, MapModeConfig>> = {
  '1v1': { size: 64, players: 2, sectors: 2, obstacleBlobs: 6, basePercent: [18, 18], richPercent: null, expansionAngles: [[-80, -50], [50, 80]] },
  ffa4: { size: 96, players: 4, sectors: 4, obstacleBlobs: 8, basePercent: [18, 18], richPercent: null, expansionAngles: [[-80, -50], [50, 80]] },
  // M3 提案（待審）：8 人局。相鄰起點只隔約 40 格，分礦改朝地圖中心兩側
  ffa8: { size: 128, players: 8, sectors: 8, obstacleBlobs: 10, basePercent: [32, 10], richPercent: [13, 10], expansionAngles: [[-35, -15], [15, 35]] },
};

/** 地圖生成參數（開發任務書「地圖生成演算法」） */
export const MAPGEN = {
  maxAttempts: 20,
  baseJitterTiles: 2,
  mainMine: { nodes: 4, minDistTiles: 6, maxDistTiles: 7, stepDegrees: 18 },
  ring: { minRadiusTiles: 11, maxRadiusTiles: 13, widthTiles: 2, chokeMinWidth: 3, chokeMaxWidth: 5, chokeAngleJitter: 45 },
  expansion: {
    count: 2,
    nodes: 4,
    minDistTiles: 16,
    maxDistTiles: 22,
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
  | 'NO_TECH'
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
  'NO_TECH',
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
