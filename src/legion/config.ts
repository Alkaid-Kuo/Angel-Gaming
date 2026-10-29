// 軍團戰的規則數值（規格書 v0.4；引擎 0.4 起加上攻城戰，見選手規格書 v0.5）。所有數值都是整數：座標單位 1 格 = 1000、時間單位 tick（每秒 10 tick）、
// 血量與攻擊 ×10、倍率與減免為百分比。對照規格書：docs/軍團戰 規格書 v0.4（草案）.md。

export const LEGION_ENGINE_VERSION = '0.4.2';
export const TPS = 10;
export const TILE = 1000;

/** 全域速度倍率（百分比）：遊戲內速度 = 規格刻度 × 倍率 */
export const SPEED_SCALE = 140;

/** 規格刻度的速度（格／秒）→ 遊戲內的單位／tick */
function spd(tilesPerSec: number): number {
  return Math.round((tilesPerSec * TILE * SPEED_SCALE) / (TPS * 100));
}

export type UnitKind = 'spear' | 'sword' | 'shield' | 'archer' | 'light' | 'lightCav' | 'heavyCav';
export const UNIT_KINDS: readonly UnitKind[] = ['spear', 'sword', 'shield', 'archer', 'light', 'lightCav', 'heavyCav'];

export type FormationKind = 'line' | 'square' | 'wedge' | 'circle';
export const FORMATION_KINDS: readonly FormationKind[] = ['line', 'square', 'wedge', 'circle'];
export const FORMATION_NAMES: Readonly<Record<FormationKind, string>> = { line: '橫陣', square: '方陣', wedge: '楔形陣', circle: '圓陣' };

export type SkillKind = 'brace' | 'assault' | 'shield' | 'volley' | 'infiltrate' | 'charge';
export type DashKind = 'assault' | 'infiltrate' | 'charge';
export type ShieldStance = 'carry' | 'raise' | 'wall';

export interface UnitDef {
  readonly name: string;
  readonly men: number;
  readonly cost: number;
  /** 單兵血量（×10） */
  readonly hp: number;
  /** 主要攻擊（弓兵是弓）與間隔（tick） */
  readonly attack: number;
  readonly cooldown: number;
  /** 近戰攻擊（只有弓兵和主要攻擊不同） */
  readonly meleeAttack: number;
  /** 遠程射程（單位）；0 為近戰 */
  readonly range: number;
  /** 近戰觸及距離（士兵中心距離，單位） */
  readonly reach: number;
  /** 移動速度（單位／tick） */
  readonly speed: number;
  /** 視野（單位） */
  readonly sight: number;
  /** 傷害減免（百分比） */
  readonly meleeDR: number;
  readonly rangedDR: number;
  /** 橫陣、方陣的預設橫寬（人） */
  readonly lineWidth: number;
  readonly squareWidth: number;
  readonly spacingX: number;
  readonly spacingY: number;
  /** 轉向速度（度／tick） */
  readonly turn: number;
  readonly cavalry: boolean;
  /** 可用陣形（第一個是預設） */
  readonly formations: readonly FormationKind[];
  readonly skill: SkillKind;
}

export const UNITS: Readonly<Record<UnitKind, UnitDef>> = {
  spear: { name: '長槍方陣', men: 30, cost: 38, hp: 1000, attack: 100, cooldown: 20, meleeAttack: 100, range: 0, reach: 2500, speed: spd(1.2), sight: 14000, meleeDR: 15, rangedDR: 15, lineWidth: 15, squareWidth: 6, spacingX: 700, spacingY: 800, turn: 6, cavalry: false, formations: ['square', 'line', 'circle'], skill: 'brace' },
  sword: { name: '劍士', men: 24, cost: 48, hp: 1200, attack: 140, cooldown: 10, meleeAttack: 140, range: 0, reach: 1500, speed: spd(1.4), sight: 14000, meleeDR: 30, rangedDR: 15, lineWidth: 12, squareWidth: 5, spacingX: 700, spacingY: 800, turn: 8, cavalry: false, formations: ['line', 'square', 'wedge'], skill: 'assault' },
  shield: { name: '盾兵', men: 30, cost: 50, hp: 1400, attack: 60, cooldown: 12, meleeAttack: 60, range: 0, reach: 1000, speed: spd(1.1), sight: 14000, meleeDR: 30, rangedDR: 50, lineWidth: 15, squareWidth: 6, spacingX: 700, spacingY: 800, turn: 6, cavalry: false, formations: ['line', 'square', 'circle'], skill: 'shield' },
  archer: { name: '弓兵', men: 24, cost: 44, hp: 700, attack: 150, cooldown: 15, meleeAttack: 40, range: 16000, reach: 1000, speed: spd(1.4), sight: 18000, meleeDR: 0, rangedDR: 15, lineWidth: 12, squareWidth: 6, spacingX: 800, spacingY: 900, turn: 9, cavalry: false, formations: ['line', 'square'], skill: 'volley' },
  light: { name: '輕步兵', men: 16, cost: 19, hp: 700, attack: 80, cooldown: 9, meleeAttack: 80, range: 0, reach: 1500, speed: spd(2.0), sight: 18000, meleeDR: 0, rangedDR: 15, lineWidth: 8, squareWidth: 5, spacingX: 1200, spacingY: 1500, turn: 12, cavalry: false, formations: ['line', 'wedge'], skill: 'infiltrate' },
  lightCav: { name: '輕騎兵', men: 16, cost: 60, hp: 1100, attack: 100, cooldown: 10, meleeAttack: 100, range: 0, reach: 1500, speed: spd(3.5), sight: 18000, meleeDR: 15, rangedDR: 15, lineWidth: 8, squareWidth: 4, spacingX: 1200, spacingY: 1600, turn: 8, cavalry: true, formations: ['line', 'wedge'], skill: 'charge' },
  heavyCav: { name: '重騎兵', men: 12, cost: 80, hp: 1800, attack: 140, cooldown: 12, meleeAttack: 140, range: 0, reach: 1800, speed: spd(2.8), sight: 12000, meleeDR: 45, rangedDR: 45, lineWidth: 6, squareWidth: 3, spacingX: 1300, spacingY: 1700, turn: 6, cavalry: true, formations: ['wedge', 'line'], skill: 'charge' },
};

/** 相剋加成（攻擊方 → 目標，百分比；只有加成，未列出為 100）。也套用在衝鋒撞擊 */
export const VERSUS: Readonly<Record<UnitKind, Partial<Record<UnitKind, number>>>> = {
  spear: { lightCav: 125, heavyCav: 125 },
  sword: {},
  shield: {},
  archer: {},
  light: { archer: 150 },
  lightCav: { archer: 150, light: 150 },
  heavyCav: { archer: 150, light: 150 },
};

export interface DashDef {
  readonly kind: DashKind;
  /** 最遠距離（單位） */
  readonly dist: number;
  /** 衝刺速度（單位／tick）；騎兵要助跑才達到 */
  readonly speed: number;
  /** 助跑距離（0 = 立刻達到衝刺速度） */
  readonly runup: number;
  /** 衝刺中的轉向上限（度／tick） */
  readonly turn: number;
  readonly cooldown: number;
  /** 衝勁（×100）：每撞到一個士兵扣掉對方的阻擋值 */
  readonly momentum: number;
  /** 撞擊傷害（×10）；0 = 沒有撞擊 */
  readonly impact: number;
  /** 衝刺對撞時的衝擊力（沒有撞擊的衝刺用這個） */
  readonly power: number;
  /** 衝刺中霸體 */
  readonly superArmor: boolean;
}

/** 衝刺類技能（騎兵依兵種、劍士突擊、輕步兵切入） */
export const DASH: Readonly<Record<'assault' | 'infiltrate' | 'lightCav' | 'heavyCav', DashDef>> = {
  assault: { kind: 'assault', dist: 8000, speed: spd(2.8), runup: 0, turn: 3, cooldown: 300, momentum: 300, impact: 0, power: 400, superArmor: false },
  infiltrate: { kind: 'infiltrate', dist: 10000, speed: spd(3.6), runup: 0, turn: 4, cooldown: 200, momentum: 200, impact: 0, power: 200, superArmor: false },
  lightCav: { kind: 'charge', dist: 25000, speed: spd(5.0), runup: 4000, turn: 3, cooldown: 200, momentum: 400, impact: 800, power: 800, superArmor: false },
  heavyCav: { kind: 'charge', dist: 30000, speed: spd(4.5), runup: 4000, turn: 1, cooldown: 300, momentum: 600, impact: 2000, power: 2000, superArmor: true },
};

export const RULES = {
  budget: 500,
  timeLimitTicks: 5 * 60 * TPS,
  decisionInterval: 5,
  commandsPerDecision: 10,
  /** 布陣區寬（格） */
  deployDepthTiles: 20,
  /** AI 意圖文字的長度上限 */
  intentMax: 20,
  /** 戰略意圖（plan 指令）的長度上限 */
  planMax: 30,
  flank: {
    /** 正面、背面的半角（度）；楔形陣的正面較窄 */
    frontHalf: 60,
    wedgeFrontHalf: 45,
    rearHalf: 60,
    side: 150,
    rear: 200,
  },
  ranged: {
    /** 箭速（單位／tick；不受全域速度倍率影響） */
    arrowSpeed: 3000,
    hitChance: 60,
    missSpread: 1500,
    /** 被貼身：這個距離內有敵兵的弓兵拉不開弓，不能射箭（含齊射），只能上前近戰；離敵人遠的後排照射 */
    pinned: 2000,
  },
  /** 長槍：槍林 */
  brace: {
    setTicks: 30,
    unsetTicks: 20,
    /** 正面額外減免、正面攻速（百分比） */
    frontDR: 50,
    attackSpeed: 170,
    /** 速度加成：目標速度超過門檻後，每多規格刻度 1 格／秒，傷害 +coef% */
    speedThreshold: spd(1.5),
    speedUnit: spd(1.0),
    speedCoef: 115,
    /** 每刺中衝刺中的敵人一次，扣掉對方的衝勁 */
    stab: 60,
    /** 迎擊（不管攻擊冷卻）的間隔：每個長槍兵每這麼多 tick 最多迎擊一次 */
    counterTicks: 5,
    /** 迎擊與扣衝勁的距離（士兵中心）：只有貼近的前排擋得住衝勁（近戰觸及距離 2.5 格，這裡維持 1.5 格） */
    counterReach: 1500,
    /** 圓陣的槍林：槍頭朝向分散、厚度不足——沒有迎擊，速度加成與扣衝勁打折（百分比） */
    circlePct: 50,
  },
  /** 盾兵三種姿態 */
  shield: {
    switchTicks: 10,
    wallSetTicks: 20,
    wallUnsetTicks: 10,
    carry: { speed: spd(1.1), meleeDR: 30, rangedDR: 50 },
    raise: { speed: spd(0.8), meleeDR: 30, rangedDR: 80 },
    /** 盾牆：只算正面 */
    wall: { meleeDR: 75, rangedDR: 90 },
    /**
     * 掩護區：盾兵隊形正後方、同寬、往後 depth 的長方形。友軍士兵站在裡面，而且攻擊來自盾兵正面（±frontHalf），
     * 就依盾兵姿態減免（不疊加，取最好的一團）
     */
    cover: {
      depth: 4000,
      frontHalf: 60,
      carry: { rangedDR: 50, meleeDR: 0 },
      raise: { rangedDR: 85, meleeDR: 30 },
      wall: { rangedDR: 90, meleeDR: 50 },
    },
  },
  /** 弓兵：齊射 */
  volley: {
    radius: 3000,
    duration: 60,
    cooldown: 300,
    /** 射擊間隔縮短為 1/rateDiv */
    rateDiv: 3,
    /** 箭落點這個距離內的敵兵中箭 */
    hitRadius: 500,
  },
  /** 輕步兵切入時被箭射中的機率 */
  evadeHitChance: 25,
  dash: {
    /** 楔形陣的衝勁加成 */
    wedgeMomentum: 150,
    /** 阻擋值（×100） */
    block: 100,
    braceBlock: 100,
    /** 盾牆正面對騎兵；對步兵衝刺是完全擋下 */
    wallBlockCavalry: 100,
    /** 突擊：擠開距離、接觸後可擠進敵陣的時間、第一擊倍率 */
    pushAside: 800,
    penetrateTicks: 30,
    firstHit: 200,
    /** 騎兵撞到人的側推距離（讓騎兵穿過） */
    shove: 400,
    /** 輕騎兵被打斷：這段時間內累積受到超過血量上限的這個百分比 */
    interruptWindow: 10,
    interruptPct: 30,
    /** 衝刺對撞：衝擊力相差這個百分比以內兩邊都停 */
    clashTie: 20,
    /** 接觸距離（士兵中心） */
    contact: 750,
  },
  knockdownTicks: 20,
  formationSwitchTicks: 30,
  terrain: {
    /** 樹林中受到的遠程傷害減免 */
    forestRangedDR: 50,
    /** 淺灘中受到的近戰傷害 */
    shallowMeleeTaken: 120,
  },
  height: {
    /** 自己所在高度每 1 階（從 1 階起算）視野 +2 格 */
    sightPerLevel: 2000,
    rangePerLevel: 1000,
    rangedPerLevel: 10,
    meleePerLevel: 10,
    /** 高低差上限（階） */
    clamp: 3,
    uphillSpeed: 85,
    downhillSpeed: 110,
    /** 衝刺：每下降 1 階 +10%、每上升 1 階 −15%，限制在 70～130% */
    dashDown: 10,
    dashUp: 15,
    dashMin: 70,
    dashMax: 130,
  },
  vision: {
    concealDetect: 3000,
    concealDetectLight: 5000,
    revealTicks: 100,
  },
  veteran: {
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
  ambushHiddenTicks: 80,
  ambushTicks: 50,
  routSpeed: 110,
  soldier: {
    catchUp: 140,
    friendGap: 550,
    enemyGap: 650,
    engageAttack: 3000,
    engageIdle: 1500,
    leash: 6000,
    retarget: 10,
  },
  /** 佔點：有人在圈內（且沒有敵人）進度條就增加，滿了才佔領成功；沒佔成前離開，進度倒退到零。
   * 佔領後每秒得旗點的分數（圈內有敵人時暫停）；先到目標分獲勝 */
  capture: {
    radius: 5000,
    captureTicks: 15 * TPS,
    scoreTarget: 400,
    timeLimitTicks: 8 * 60 * TPS,
    /** 後備兵力（規格書 v0.3）：總點數、場上同時最多幾點（算全額點數）；後備入場要準備幾個 tick */
    budget: 1500,
    fieldCap: 500,
    enterTicks: 10 * TPS,
    /** 出生點、補給站的範圍（單位）：範圍內可以換兵、撤回後備，沒受傷一陣子會回血 */
    spawnRadius: 8000,
    supplyRadius: 6000,
    /** 回血：每秒補單兵血量上限的幾 %；最近 quietTicks 內受過傷就不回 */
    healPct: 2,
    healQuietTicks: 5 * TPS,
  },
  /**
   * 城門（引擎 0.4）：有血量的物件，掛在門樓格上，只有衝車能扣血。血量沿用「×10」慣例（儲存值）。
   * 開門、關門各要 openTicks／closeTicks（待審）；門洞地面還有士兵時關不上。
   */
  gate: {
    mainHp: 4000,
    sideHp: 2000,
    openTicks: 3 * TPS,
    closeTicks: 3 * TPS,
  },
  /**
   * 雲梯（引擎 0.4）：攻方劍士、盾兵、長槍、輕步兵對相鄰城牆格架設；架好後雙方都能用。
   * 一把梯每 entryTicks 上一人、爬到頂 climbTicks（待審）；推倒讀條 toppleTicks（待審），梯上的人摔落，
   * 傷害 ＝ 單兵血量上限 × fallPct% × 爬升高度比例（待審）。
   */
  ladder: {
    buildTicks: 8 * TPS,
    entryTicks: 5,
    climbTicks: 3 * TPS,
    toppleTicks: 3 * TPS,
    fallPct: 30,
    /** 下令時軍團中心離梯腳多遠以內（單位） */
    reach: 4000,
    /** 推倒：守方士兵離梯口這個距離內才算站在梯口；梯口這個距離內有攻方士兵就推不了 */
    mouth: 1500,
    clear: 1000,
    /** 士兵離梯腳（梯口）這個距離內才能上梯 */
    mountDist: 600,
    /** 尋路：走雲梯的成本（平地一格 = 100） */
    pathCost: 600,
  },
} as const;

/**
 * 衝車（引擎 0.4）：攻方免費一台、不計點、不可摧毀，只沿地圖的軌道（map.ramTrack）往前走、不能倒退。
 * 步兵團下 man 就由引擎帶到車尾的推車位置（車中心往後「半厚 ＋ front」），中心離衝車 attach 以內就附上；
 * 附上後衝車每 tick 沿軌道前進 speed（待審），車頭每 tick 最多轉 turn 度；推車那團由引擎排在車後跟著走，落後推車位置超過 slack 衝車就等；
 * 車頭正面 ±blockHalf 度、block 以內有敵方地面士兵就推不動。貼著關閉的城門（contact 以內）每 hitTicks 撞一下、每下扣 hit（正門 6 下、側門 3 下破門，已定先測）。
 * 正面 blockHalf×2 度內射來的箭對附上的兵團無效。
 */
export const RAM = {
  speed: spd(0.7),
  turn: 6,
  hit: 667,
  hitTicks: 3 * TPS,
  contact: 1500,
  attach: 5000,
  front: 1500,
  slack: 1000,
  block: 2000,
  blockHalf: 90,
} as const;

/**
 * 砲擊支援（引擎 0.4，數字待審）：攻方每場 shells 發、冷卻 cooldown；下令後 delay 落地，半徑 radius 內敵我不分每人扣 damage；
 * 不打城門、不打牆。陰影：從落點往砲擊來向走 shadow 距離內碰到城牆或門樓（落點那一格不算）就打不到。
 * damage 規格沒有給，暫定 500（長槍兵血量的一半），待試打。
 */
export const BOMBARD = {
  shells: 3,
  cooldown: 60 * TPS,
  delay: 5 * TPS,
  radius: 3000,
  damage: 500,
  shadow: 4000,
} as const;

/** 能架雲梯的兵種 */
export const LADDER_KINDS: readonly UnitKind[] = ['sword', 'shield', 'spear', 'light'];

/** 模式：攻城戰 siege、佔點 capture；殲滅戰 annihilation 只保留給引擎內部測試（不進聯賽、參賽包、觀戰選單） */
export type LegionMode = 'annihilation' | 'capture' | 'siege';
export const MODE_NAMES: Readonly<Record<LegionMode, string>> = { annihilation: '殲滅戰', capture: '佔點', siege: '攻城戰' };
/** 聯賽、參賽包、觀戰網頁用的模式（三場制：攻城、攻城、佔點） */
export const LEAGUE_MODES: readonly LegionMode[] = ['siege', 'capture'];

/**
 * 攻城戰（引擎 0.4，規格 1.2）：兩面旗依序佔——A（地圖 flags[0]，城門）15 秒、B（flags[1]，本陣）30 秒；A 未佔下前 B 不能佔，
 * 守方不能把 A 佔回去。A 佔下：正門永久開啟、時限延長 extendTicks（試打後定）。B 佔下攻方勝；時間到守方勝；全滅仍算勝利。
 * 攻守各 600 點、場上 600、沒有後備；後備開關（attackerReserve／defenderReserve）先關（試打後才開）。
 * 旗圈只算地面層的士兵（牆頂、爬梯中的不算佔旗也不算阻擋）。
 */
export const SIEGE = {
  budget: 600,
  fieldCap: 600,
  timeLimitTicks: 8 * 60 * TPS,
  extendTicks: 3 * 60 * TPS,
  radius: 5000,
  captureA: 15 * TPS,
  captureB: 30 * TPS,
  attackerReserve: false,
  defenderReserve: false,
  /** 後備開關打開時的總點數（場上仍是 fieldCap） */
  reserveBudget: 900,
} as const;

/** 地形（「高地」只是高度 3 階以上的平地標籤，效果全部依高度計算） */
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
  /** 樓梯：城內側與牆相鄰的格，進入即切換層（0↔1），速度 ×50%；騎兵不可進 */
  Stair: 9,
  /** 門樓：牆頂（層 1）永遠可走；地面（層 0）由城門狀態決定 */
  Gatehouse: 10,
  /** 石板地：城內鋪石的街道、廣場與院落，移動 ×1 */
  Paved: 11,
  /** 瓦礫：坍塌城牆的碎石堆，移動 ×0.6，擋得住騎兵衝鋒 */
  Rubble: 12,
} as const;

export const TERRAIN_NAMES = ['平地', '道路', '樹林', '高地', '淺灘', '河流', '橋', '建築', '城牆', '樓梯', '門樓', '石板地', '瓦礫'] as const;

/** 地面層的一般地形（地面層之間走動不涉及換層）：1 = 是。尋路與士兵移動的快速路徑用 */
export const GROUND_FAST: Uint8Array = (() => {
  const a = new Uint8Array(256);
  for (const t of [T.Plain, T.Road, T.Forest, T.Hill, T.Shallow, T.Bridge, T.Paved, T.Rubble]) a[t] = 1;
  return a;
})();

/** 層：0 地面、1 牆頂（之後塔樓可擴）。牆頂高度 ＝ 地面高度 ＋ WALL_LEVELS 階 */
export const GROUND_LAYER = 0;
export const WALL_LAYER = 1;
/** 爬雲梯中的士兵所在的層：不和任何人近戰、推擠（只有箭與砲擊打得到），高度算地面 */
export const LADDER_LAYER = 2;
export const WALL_LEVELS = 3;

/**
 * 城門狀態佔位（引擎 0.4 步驟 2 才做城門物件）：門關著時門樓格在地面層不可走。
 * 這一步所有門樓都用這個預設值。
 */
export const GATE_OPEN_DEFAULT = false;

/** 地面層（層 0、城門關閉）可走：沿用 0.3 的語意，給布陣檢查、吸附與觀戰網頁用 */
export function walkable(t: number): boolean {
  return t !== T.River && t !== T.Building && t !== T.Wall && t !== T.Gatehouse;
}

/** 牆頂層（層 1）可走：城牆、門樓、樓梯 */
export function walkableTop(t: number): boolean {
  return t === T.Wall || t === T.Gatehouse || t === T.Stair;
}

/** 某一層可走（門樓在地面層依城門狀態） */
export function walkableAt(t: number, layer: number, gateOpen = GATE_OPEN_DEFAULT): boolean {
  if (layer === WALL_LAYER) return walkableTop(t);
  return walkable(t) || (gateOpen && t === T.Gatehouse);
}

/** 任何一層可走（尋路終點是否合法） */
export function walkableAny(t: number): boolean {
  return walkable(t) || walkableTop(t);
}

/**
 * 從地形 fromT（所在層 layer）踏進相鄰格 toT 後的層；不能走回傳 -1。
 * 規則：踏進樓梯立即切換層；從樓梯往牆或往地面都可走，層由目的格決定；
 * 城牆只有層 1；門樓層 1 永遠可走、層 0 看城門；騎兵不得進樓梯。
 */
export function stepLayer(layer: number, fromT: number, toT: number, cavalry: boolean, gateOpen = GATE_OPEN_DEFAULT): number {
  switch (toT) {
    case T.River:
    case T.Building:
      return -1;
    case T.Wall:
      return layer === WALL_LAYER || fromT === T.Stair ? WALL_LAYER : -1;
    case T.Stair:
      if (cavalry) return -1;
      if (fromT === T.Stair) return layer;
      return layer === WALL_LAYER ? GROUND_LAYER : WALL_LAYER;
    case T.Gatehouse:
      if (fromT === T.Stair) return layer === WALL_LAYER || !gateOpen ? WALL_LAYER : GROUND_LAYER;
      if (layer === WALL_LAYER) return WALL_LAYER;
      return gateOpen ? GROUND_LAYER : -1;
    default:
      // 牆頂（含門樓頂）不能直接走到地面；只有地面層或經過樓梯才行
      return layer === GROUND_LAYER || fromT === T.Stair ? GROUND_LAYER : -1;
  }
}

/** 擋得住騎兵衝鋒的地形（樓梯、城牆、門樓都算） */
export function stopsCavalry(t: number): boolean {
  return t === T.Forest || t === T.Shallow || t === T.Stair || t === T.Rubble || !walkable(t);
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
    case T.Stair:
      return 50;
    case T.Rubble:
      return 60;
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
    case T.Stair:
      return 200;
    case T.Rubble:
      return 170;
    default:
      return 100;
  }
}

export function dashDefOf(kind: UnitKind): DashDef | null {
  switch (kind) {
    case 'sword':
      return DASH.assault;
    case 'light':
      return DASH.infiltrate;
    case 'lightCav':
      return DASH.lightCav;
    case 'heavyCav':
      return DASH.heavyCav;
    default:
      return null;
  }
}
