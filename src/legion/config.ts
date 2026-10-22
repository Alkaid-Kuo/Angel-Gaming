// 軍團戰（原型）的規則數值。所有數值都是整數：座標單位 1 格 = 1000、時間單位 tick（每秒 10 tick）、
// 血量與攻擊 ×10、倍率為百分比。對照規格書：docs/軍團戰 規格書 v0.1（草案）.md。

export const LEGION_ENGINE_VERSION = '0.1.0';
export const TPS = 10;
export const TILE = 1000;

export type UnitKind = 'spear' | 'sword' | 'shield' | 'archer' | 'light' | 'lightCav' | 'heavyCav';
export const UNIT_KINDS: readonly UnitKind[] = ['spear', 'sword', 'shield', 'archer', 'light', 'lightCav', 'heavyCav'];

export interface UnitDef {
  readonly name: string;
  /** 每團人數 */
  readonly men: number;
  readonly cost: number;
  /** 單兵血量（×10） */
  readonly hp: number;
  /** 單次攻擊（×10） */
  readonly attack: number;
  /** 攻擊間隔（tick） */
  readonly cooldown: number;
  /** 遠程射程（單位）；0 為近戰 */
  readonly range: number;
  /** 近戰觸及距離（士兵中心距離，單位） */
  readonly reach: number;
  /** 移動速度（單位／tick） */
  readonly speed: number;
  /** 衝鋒速度（單位／tick）；0 為不能衝鋒 */
  readonly chargeSpeed: number;
  /** 衝鋒撞擊傷害（×10） */
  readonly impact: number;
  /** 視野（單位） */
  readonly sight: number;
  /** 隊形：預設橫寬（人）、左右間距、前後間距（單位） */
  readonly width: number;
  readonly spacingX: number;
  readonly spacingY: number;
  /** 轉向速度（度／tick） */
  readonly turn: number;
  readonly cavalry: boolean;
}

export const UNITS: Readonly<Record<UnitKind, UnitDef>> = {
  spear: { name: '長槍方陣', men: 40, cost: 50, hp: 1000, attack: 100, cooldown: 12, range: 0, reach: 1000, speed: 170, chargeSpeed: 0, impact: 0, sight: 10000, width: 10, spacingX: 700, spacingY: 800, turn: 6, cavalry: false },
  sword: { name: '劍士', men: 30, cost: 60, hp: 1200, attack: 140, cooldown: 10, range: 0, reach: 800, speed: 190, chargeSpeed: 0, impact: 0, sight: 10000, width: 10, spacingX: 700, spacingY: 800, turn: 8, cavalry: false },
  shield: { name: '盾兵', men: 30, cost: 50, hp: 1400, attack: 60, cooldown: 12, range: 0, reach: 800, speed: 140, chargeSpeed: 0, impact: 0, sight: 10000, width: 10, spacingX: 700, spacingY: 800, turn: 6, cavalry: false },
  archer: { name: '弓兵', men: 30, cost: 55, hp: 700, attack: 80, cooldown: 15, range: 12000, reach: 800, speed: 190, chargeSpeed: 0, impact: 0, sight: 12000, width: 15, spacingX: 800, spacingY: 900, turn: 9, cavalry: false },
  light: { name: '輕步兵', men: 25, cost: 30, hp: 700, attack: 80, cooldown: 9, range: 0, reach: 800, speed: 280, chargeSpeed: 0, impact: 0, sight: 16000, width: 13, spacingX: 1000, spacingY: 1000, turn: 12, cavalry: false },
  lightCav: { name: '輕騎兵', men: 16, cost: 60, hp: 1100, attack: 100, cooldown: 10, range: 0, reach: 1000, speed: 480, chargeSpeed: 680, impact: 250, sight: 14000, width: 8, spacingX: 1200, spacingY: 1600, turn: 8, cavalry: true },
  heavyCav: { name: '重騎兵', men: 12, cost: 80, hp: 1800, attack: 140, cooldown: 12, range: 0, reach: 1000, speed: 400, chargeSpeed: 620, impact: 500, sight: 10000, width: 6, spacingX: 1300, spacingY: 1700, turn: 6, cavalry: true },
};

/** 相剋倍率（攻擊方 → 目標，百分比；未列出為 100） */
export const VERSUS: Readonly<Record<UnitKind, Partial<Record<UnitKind, number>>>> = {
  spear: { lightCav: 200, heavyCav: 200 },
  sword: { spear: 150, shield: 120 },
  shield: { light: 120 },
  archer: { shield: 25 },
  light: { archer: 150 },
  lightCav: { archer: 150, light: 150 },
  heavyCav: { sword: 120, archer: 150, light: 150 },
};

/** 衝鋒撞擊的相剋倍率（未列出為 100） */
export const IMPACT_VERSUS: Readonly<Partial<Record<UnitKind, Partial<Record<UnitKind, number>>>>> = {
  lightCav: { archer: 150, light: 150 },
  heavyCav: { sword: 150, archer: 150, light: 150 },
};

export const RULES = {
  budget: 500,
  timeLimitTicks: 5 * 60 * TPS,
  decisionInterval: 5,
  commandsPerDecision: 10,
  /** 布陣區寬（格） */
  deployDepthTiles: 20,
  flank: {
    /** 正面、背面的半角（度） */
    frontHalf: 60,
    rearHalf: 60,
    side: 150,
    rear: 200,
  },
  ranged: {
    /** 箭速（單位／tick） */
    arrowSpeed: 3000,
    /** 命中率（百分比） */
    hitChance: 60,
    /** 未命中時落點的最大偏移（單位） */
    missSpread: 1500,
    /** 盾兵自身受到的遠程傷害、周圍友軍受到的遠程傷害（百分比） */
    shieldSelf: 25,
    shieldAura: 50,
    shieldAuraRange: 3000,
    /** 弓兵近戰倍率 */
    archerMelee: 50,
  },
  terrain: {
    hillSight: 4000,
    hillRange: 2000,
    hillRangedDamage: 120,
    /** 由下往上的近戰 */
    uphillMelee: 85,
    /** 在淺灘中受到的近戰傷害 */
    shallowMeleeTaken: 120,
  },
  charge: {
    /** 助跑距離（單位） */
    runup: 4000,
    /** 衝鋒中的轉向（度／tick） */
    turn: 2,
    /** 撞擊後的視窗（tick）：期間碰到敵人的騎兵都會撞擊 */
    impactWindow: 5,
    /** 撞擊的濺射半徑與倍率 */
    splashRadius: 700,
    splash: 50,
    /** 擊退距離（單位） */
    knockback: 900,
    /** 撞擊後要脫離這個距離才能再衝鋒 */
    disengage: 6000,
  },
  brace: {
    setTicks: 30,
    unsetTicks: 20,
    /** 正面受到的騎兵撞擊（百分比）與反彈比例 */
    impactTaken: 20,
    reflect: 50,
    /** 正面對騎兵的倍率（取代一般相剋） */
    vsCavalry: 300,
  },
  vision: {
    /** 樹林隱蔽：一般察覺距離、輕步兵察覺距離（邊緣到邊緣） */
    concealDetect: 3000,
    concealDetectLight: 5000,
    /** 隱蔽的軍團主動攻擊後被看見的時間 */
    revealTicks: 100,
  },
  veteran: {
    /** 累積傷害門檻（本團初始總血量的百分比）、攻擊與血量上限加成 */
    levels: [
      { threshold: 0, attack: 100, hp: 100 },
      { threshold: 50, attack: 110, hp: 110 },
      { threshold: 120, attack: 120, hp: 120 },
    ],
  },
  /** 步兵要轉超過這個角度時直接向後轉（度） */
  aboutFace: 120,
  /** 步兵往後挪不超過這個距離時直接倒退，不轉身（單位） */
  backStep: 3000,
  /** 新的移動指令與目前目的地相距這個距離內，視為同一個目的地（單位） */
  sameGoal: 1500,
  /** 人數低於初始的這個百分比就潰散 */
  routPercent: 20,
  /** 全軍潰敗：未潰散軍團的剩餘兵力低於開場點數的這個百分比即判負（原型新增，待確認） */
  collapsePercent: 20,
  /** 埋伏：最近這麼多 tick 內還隱蔽在樹林裡，而且敵方在接觸前這麼多 tick 內才第一次看到它 */
  ambushHiddenTicks: 80,
  ambushTicks: 50,
  /** 潰散時的移動速度倍率 */
  routSpeed: 110,
  soldier: {
    /** 士兵趕回隊形位置的最高速度倍率 */
    catchUp: 140,
    /** 友軍、敵軍之間的最小距離（單位） */
    friendGap: 550,
    enemyGap: 650,
    /** 近戰找目標的半徑：攻擊中、待命、防守（被近身才反擊） */
    engageAttack: 3000,
    engageIdle: 1500,
    /** 離開隊形位置太遠就放棄目標 */
    leash: 6000,
    /** 重新找目標的週期（tick） */
    retarget: 10,
  },
  capture: {
    radius: 4000,
    /** 佔領值上限；單方在圈內時每 tick ＋1（約 10 秒佔領） */
    target: 100,
    /** 控制超過半數的旗點持續這麼久即獲勝 */
    dominationTicks: 45 * TPS,
  },
} as const;

export type LegionMode = 'annihilation' | 'capture';
export const MODE_NAMES: Readonly<Record<LegionMode, string>> = { annihilation: '殲滅戰', capture: '佔點' };

/** 地形 */
export const T = {
  Plain: 0,
  Road: 1,
  Forest: 2,
  Hill: 3,
  Shallow: 4,
  River: 5,
  Bridge: 6,
  Building: 7,
  Wall: 8,
} as const;

export const TERRAIN_NAMES = ['平地', '道路', '樹林', '高地', '淺灘', '河流', '橋', '建築', '城牆'] as const;

export function walkable(t: number): boolean {
  return t !== T.River && t !== T.Building && t !== T.Wall;
}

/** 地形移動倍率（百分比） */
export function terrainSpeed(t: number, kind: UnitKind): number {
  switch (t) {
    case T.Road:
    case T.Bridge:
      return 125;
    case T.Forest:
      return kind === 'light' ? 100 : 60;
    case T.Shallow:
      return 50;
    default:
      return 100;
  }
}

/** 尋路成本（每格，平地 = 100） */
export function terrainCost(t: number): number {
  switch (t) {
    case T.Road:
    case T.Bridge:
      return 80;
    case T.Forest:
      return 170;
    case T.Shallow:
      return 200;
    default:
      return 100;
  }
}
