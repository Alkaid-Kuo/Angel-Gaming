// 軍團戰選手 API 的公開型別（規格書 v0.2）：開局資料、布陣、觀察資料、指令、事件。
import type { KnobDef, KnobValues } from '../api/types.ts';
import type { DashKind, FormationKind, LegionMode, ShieldStance, SkillKind, UnitKind } from './config.ts';
import type { MapFeatures } from './map.ts';

export type { MapFeatures };

export type { DashKind, FormationKind, KnobDef, KnobValues, LegionMode, ShieldStance, SkillKind, UnitKind };

export interface LegionDeclaration {
  readonly name: string;
  readonly version?: string;
  readonly style: string;
  readonly knobs: readonly KnobDef[];
}

export interface UnitInfo {
  readonly kind: UnitKind;
  readonly name: string;
  readonly men: number;
  readonly cost: number;
  readonly hp: number;
  readonly attack: number;
  readonly cooldown: number;
  readonly meleeAttack: number;
  readonly range: number;
  readonly reach: number;
  /** 移動速度（單位／tick）；盾兵是持盾的速度 */
  readonly speed: number;
  readonly sight: number;
  readonly meleeDR: number;
  readonly rangedDR: number;
  readonly lineWidth: number;
  readonly squareWidth: number;
  readonly spacingX: number;
  readonly spacingY: number;
  readonly cavalry: boolean;
  readonly formations: readonly FormationKind[];
  readonly skill: SkillKind;
  /** 衝刺類技能的參數（沒有就是 null） */
  readonly dash: { readonly kind: DashKind; readonly dist: number; readonly speed: number; readonly turn: number; readonly cooldown: number } | null;
}

export interface LegionInitData {
  readonly playerId: number;
  readonly mode: LegionMode;
  readonly knobs: KnobValues;
  readonly budget: number;
  readonly timeLimitTicks: number;
  readonly ticksPerSecond: number;
  readonly decisionInterval: number;
  readonly commandsPerDecision: number;
  /** 1 格 = tileSize 單位；所有座標都是單位 */
  readonly tileSize: number;
  readonly map: {
    readonly id: string;
    readonly name: string;
    readonly width: number;
    readonly height: number;
    /**
     * 列優先的地形代碼：0 平地、1 道路、2 樹林、3 高地（高度 3 階以上的平地）、4 淺灘、5 河流、6 橋、7 建築、8 城牆、
     * 9 樓梯（進入即在地面與牆頂之間換層，速度 ×0.5，騎兵不可）、10 門樓（牆頂永遠可走；地面在城門開啟時可走）、
     * 11 石板地（城內鋪石的地面，同平地）、12 瓦礫（坍塌城牆，速度 ×0.6，擋騎兵衝鋒）
     */
    readonly terrain: readonly number[];
    /** 列優先的高度階（0～5） */
    readonly heights: readonly number[];
    /** 依 playerId 的布陣區（格座標，含 x0/y0、不含 x1/y1） */
    readonly deploy: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
    /** 依 playerId：布陣區不是整個矩形時，列優先的格遮罩（1 = 可以布陣）；null = 整個矩形都可以（攻城圖守方的城內是遮罩） */
    readonly deployMask: readonly (readonly number[] | null)[];
    /** 旗點（佔點模式）：points = 佔領後每秒得幾分 */
    readonly flags: readonly { readonly id: number; readonly name: string; readonly x: number; readonly y: number; readonly points: number }[];
    /** 依 playerId 的出生點；補給站（歸 flag 那面旗的佔領者） */
    readonly spawns: readonly { readonly x: number; readonly y: number }[];
    readonly supplies: readonly { readonly id: number; readonly x: number; readonly y: number; readonly flag: number }[];
    /** 公開的地形要點：牆段、城門、樓梯、隘口、高地、樹林（所有地圖都有；沒有城的地圖 walls／gates／stairs 是空的） */
    readonly features: MapFeatures;
    /** 攻城地圖：守方座位（-1 = 沒有城）、衝車起點、砲擊來向（度，-1 = 沒有） */
    readonly defender: number;
    readonly ram: { readonly x: number; readonly y: number; readonly facing: number } | null;
    readonly bombardFrom: number;
  };
  /**
   * 佔點規則：圈的半徑（單位）、從零佔滿要幾個 tick、目標分數；
   * 後備：總點數 budget、場上上限 fieldCap（算全額點數）、入場準備 enterTicks、出生點與補給站範圍、回血（每秒 healPct %，受傷後 healQuietTicks 內不回）
   */
  readonly capture: {
    readonly radius: number;
    readonly captureTicks: number;
    readonly scoreTarget: number;
    readonly budget: number;
    readonly fieldCap: number;
    readonly enterTicks: number;
    readonly spawnRadius: number;
    readonly supplyRadius: number;
    readonly healPct: number;
    readonly healQuietTicks: number;
  };
  /**
   * 攻城戰的規則（其他模式為 null）：攻守座位、時限延長、兩面旗（A = map.flags[0] 城門、B = map.flags[1] 本陣）、
   * 點數、後備開關，以及城門、雲梯、衝車、砲擊的數值
   */
  readonly siege: SiegeRules | null;
  readonly units: readonly UnitInfo[];
  /** 相剋加成（百分比）：versus[攻擊方][目標] */
  readonly versus: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface SiegeRules {
  readonly attacker: number;
  readonly defender: number;
  readonly extendTicks: number;
  readonly radius: number;
  readonly captureA: number;
  readonly captureB: number;
  readonly budget: number;
  readonly fieldCap: number;
  readonly attackerReserve: boolean;
  readonly defenderReserve: boolean;
  readonly gate: { readonly mainHp: number; readonly sideHp: number; readonly openTicks: number; readonly closeTicks: number };
  readonly ladder: { readonly kinds: readonly UnitKind[]; readonly buildTicks: number; readonly entryTicks: number; readonly climbTicks: number; readonly toppleTicks: number; readonly fallPct: number; readonly reach: number; readonly mouth: number; readonly clear: number };
  readonly ram: { readonly speed: number; readonly hit: number; readonly hitTicks: number; readonly contact: number; readonly attach: number; readonly blockHalf: number };
  readonly bombard: { readonly shells: number; readonly cooldown: number; readonly delay: number; readonly radius: number; readonly damage: number; readonly shadow: number; readonly from: number };
}

export interface Deployment {
  readonly type: UnitKind;
  readonly x: number;
  readonly y: number;
  /** 角度（度）：0 朝東（+x）、90 朝南（+y） */
  readonly facing?: number;
  /** 橫寬（人）：橫陣、方陣 */
  readonly width?: number;
  readonly formation?: FormationKind;
  /** 盾兵姿態（持盾或舉盾） */
  readonly stance?: ShieldStance;
  /** 層（預設 0 地面）：1 = 牆頂，位置必須在城牆、門樓或樓梯格上，騎兵不可 */
  readonly layer?: number;
  /** 佔點模式：放在後備（不用給位置）。場上超過上限的也會自動轉成後備 */
  readonly reserve?: boolean;
}

export type RegimentStatus =
  | 'idle'
  | 'moving'
  | 'attacking'
  | 'engaged'
  | 'charging'
  | 'assaulting'
  | 'infiltrating'
  | 'bracing'
  | 'braced'
  | 'unbracing'
  | 'walling'
  | 'walled'
  | 'reforming'
  | 'volleying'
  /** 攻城：架雲梯中、推倒雲梯中 */
  | 'laddering'
  | 'toppling'
  /** 佔點模式：在後備、準備入場中 */
  | 'reserve'
  | 'entering'
  /** v0.3 起拿掉潰散，不會再出現 */
  | 'routed';

export interface OwnRegiment {
  readonly id: number;
  readonly kind: UnitKind;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly width: number;
  readonly formation: FormationKind;
  /** 盾兵姿態；其他兵種為 null */
  readonly stance: ShieldStance | null;
  readonly men: number;
  readonly men0: number;
  /** 全團剩餘血量、上限 */
  readonly hp: number;
  readonly hpMax: number;
  readonly status: RegimentStatus;
  /** 目前的指令 */
  readonly order: string;
  readonly target: number | null;
  readonly level: number;
  readonly engaged: boolean;
  /** 招牌技能還要冷卻幾個 tick（0 = 可以用） */
  readonly skillCooldown: number;
  /** 衝刺中（突擊、切入、衝鋒）就是種類；否則 null */
  readonly dashing: DashKind | null;
  /** 正在倒地的人數 */
  readonly down: number;
  readonly routed: boolean;
  /** 所在地形代碼與高度階（高度含層：牆頂 ＝ 地面 ＋ 3 階） */
  readonly terrain: number;
  readonly height: number;
  /** 所在層：0 地面、1 牆頂。近戰、衝刺、碰撞只發生在同層；射擊可跨層 */
  readonly layer: number;
  /** 半徑（單位）：中心到最遠士兵 */
  readonly radius: number;
  /** 佔點模式：在後備（不在場上；位置是出生點）；還要幾個 tick 入場（-1 = 沒有排定） */
  readonly reserve: boolean;
  readonly enterIn: number;
}

export interface EnemyRegiment {
  readonly id: number;
  readonly owner: number;
  readonly kind: UnitKind;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly width: number;
  readonly formation: FormationKind;
  readonly stance: ShieldStance | null;
  readonly men: number;
  readonly men0: number;
  readonly status: RegimentStatus;
  readonly engaged: boolean;
  readonly dashing: DashKind | null;
  readonly routed: boolean;
  readonly terrain: number;
  /** 高度含層（牆頂 ＝ 地面 ＋ 3 階） */
  readonly height: number;
  /** 所在層：0 地面、1 牆頂 */
  readonly layer: number;
  readonly radius: number;
}

/** 城門狀態：closed 關、opening 開門中（還不能過）、open 開、closing 關門中（還能過）、broken 被破壞或永久開啟 */
export type GateStatus = 'closed' | 'opening' | 'open' | 'closing' | 'broken';

export interface GateInfo {
  readonly id: number;
  readonly kind: 'main' | 'side';
  /** 門洞中心（單位座標）與範圍（格座標，含 x0／y0、不含 x1／y1） */
  readonly x: number;
  readonly y: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** 歸誰開關（守方） */
  readonly owner: number;
  readonly hp: number;
  readonly hpMax: number;
  readonly state: GateStatus;
  /** 開門中、關門中還要幾個 tick（其他狀態為 0） */
  readonly timer: number;
}

export interface LadderInfo {
  readonly id: number;
  /** 架梯的一方 */
  readonly owner: number;
  /** 梯口（城牆格中心）與梯腳（城牆外的地面格中心），單位座標 */
  readonly x: number;
  readonly y: number;
  readonly footX: number;
  readonly footY: number;
  /** 架設進度（tick，滿了 = buildTicks）與是否已架好 */
  readonly progress: number;
  readonly buildTicks: number;
  readonly built: boolean;
  /** 梯上正在爬的人數 */
  readonly climbers: number;
  /** 正在被推倒：讀條進度（tick；-1 = 沒有） */
  readonly topple: number;
}

export interface RamInfo {
  readonly id: number;
  readonly owner: number;
  readonly x: number;
  readonly y: number;
  /** 衝車正面朝向（度）；正面 ±90° 射來的箭對附上的兵團無效 */
  readonly facing: number;
  /** 附上的兵團（null = 沒有人推，衝車不動；下了 man 還在走過來的團不算，它自己的 order 是 'man'） */
  readonly crew: number | null;
  /** 沿軌道（data.map.features.ramTrack）的進度：0 ＝ 起點、1 ＝ 終點（正門外的撞擊點） */
  readonly t: number;
  /** 正在撞的城門（null = 沒貼著關閉的城門）與下一撞還要幾個 tick */
  readonly gate: number | null;
  readonly nextHit: number;
}

/** 砲擊落點（雙方都看得到） */
export interface BombardInfo {
  readonly x: number;
  readonly y: number;
  /** 還要幾個 tick 落地 */
  readonly landIn: number;
  readonly radius: number;
}

/** 城池上的物件（雙方都看得到） */
export interface Structures {
  readonly gates: readonly GateInfo[];
  readonly ladders: readonly LadderInfo[];
  /** 衝車（攻城地圖才有，只有一台） */
  readonly ram: RamInfo | null;
  /** 飛行中的砲擊、攻方剩餘發數與冷卻（沒有砲擊支援的地圖：[]、0、0） */
  readonly bombards: readonly BombardInfo[];
  readonly bombardsLeft: number;
  readonly bombardReadyIn: number;
}

export interface FlagState {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** 佔領者；-1 = 還沒有人佔領 */
  readonly owner: number;
  /** 正在佔領的一方（-1 = 沒有）與進度（0～captureTicks，滿了就換成它佔領） */
  readonly capturer: number;
  readonly progress: number;
  /** 佔領者的圈內有敵人：暫停得分 */
  readonly contested: boolean;
  /** 佔領後每秒得幾分（攻城戰為 0） */
  readonly points: number;
  /** 從零佔滿要幾個 tick（佔點各旗相同；攻城戰 A 15 秒、B 30 秒） */
  readonly captureTicks: number;
  /** 攻城戰：這面旗現在能不能佔（B 要等 A 佔下） */
  readonly open: boolean;
}

export type Flank = 'front' | 'side' | 'rear';

export type LegionEvent =
  | { readonly type: 'deployRejected'; readonly tick: number; readonly player: number; readonly index: number; readonly reason: string }
  | { readonly type: 'contact'; readonly tick: number; readonly a: number; readonly b: number; readonly flank: Flank }
  /** 衝刺結束：撞到的第一個敵團、擊殺、擊倒、是否被槍林擋下 */
  | { readonly type: 'impact'; readonly tick: number; readonly reg: number; readonly kind: DashKind; readonly target: number; readonly kills: number; readonly downed: number; readonly braced: boolean; readonly flank: Flank }
  | { readonly type: 'ambush'; readonly tick: number; readonly reg: number }
  | { readonly type: 'routed'; readonly tick: number; readonly reg: number }
  | { readonly type: 'destroyed'; readonly tick: number; readonly reg: number; readonly escaped: boolean }
  | { readonly type: 'levelUp'; readonly tick: number; readonly reg: number; readonly level: number }
  | { readonly type: 'skill'; readonly tick: number; readonly reg: number; readonly skill: string }
  /** 旗點易手（佔領成功） */
  | { readonly type: 'flag'; readonly tick: number; readonly flag: number; readonly owner: number }
  /** 佔點模式：後備入場、撤回後備（at = 出生點 -1 或補給站 id） */
  | { readonly type: 'enter'; readonly tick: number; readonly reg: number; readonly at: number }
  | { readonly type: 'withdraw'; readonly tick: number; readonly reg: number; readonly at: number }
  /** 城門狀態改變（開門中、開、關門中、關、被破壞） */
  | { readonly type: 'gate'; readonly tick: number; readonly gate: number; readonly state: GateStatus }
  /** 砲擊：下令（fired）與落地（landed，hit = 被打到的人數） */
  | { readonly type: 'bombard'; readonly tick: number; readonly x: number; readonly y: number; readonly state: 'fired' | 'landed'; readonly hit: number }
  /** 衝車撞了城門一下（hp = 撞完剩下的血量） */
  | { readonly type: 'ramHit'; readonly tick: number; readonly gate: number; readonly hp: number }
  /** 雲梯：開始架、架好、架設取消、被推倒（fell = 摔下來的人數） */
  | { readonly type: 'ladder'; readonly tick: number; readonly ladder: number; readonly owner: number; readonly state: 'building' | 'built' | 'cancelled' | 'toppled'; readonly fell: number }
  | { readonly type: 'rejected'; readonly tick: number; readonly player: number; readonly command: string; readonly reason: string };

export interface LegionObservation {
  readonly tick: number;
  readonly timeLeft: number;
  readonly me: number;
  readonly regiments: readonly OwnRegiment[];
  /** 只有看得到的敵軍 */
  readonly enemies: readonly EnemyRegiment[];
  readonly flags: readonly FlagState[];
  /** 依 playerId：佔點分數（佔點模式；殲滅戰都是 0） */
  readonly score: readonly number[];
  /** 自己場上的點數（含準備入場中的，算全額）與上限 */
  readonly fieldCost: number;
  readonly fieldCap: number;
  /** 城門、雲梯、衝車、砲擊（雙方都看得到；沒有城的地圖都是空的） */
  readonly structures: Structures;
  /** 自上次決策後與自己有關的事件 */
  readonly events: readonly LegionEvent[];
}

/** 衝刺的方向：facing（度）、地點（x, y）或敵團（target，取它目前的位置）擇一 */
interface DashAim {
  readonly facing?: number;
  readonly x?: number;
  readonly y?: number;
  readonly target?: number;
}

interface Base {
  readonly id: number;
  /** AI 意圖（選填，最多 20 字，觀戰畫面顯示） */
  readonly intent?: string;
}

export type LegionCommand =
  | (Base & { readonly type: 'move'; readonly x: number; readonly y: number; readonly facing?: number })
  | (Base & { readonly type: 'attackMove'; readonly x: number; readonly y: number })
  | (Base & { readonly type: 'attack'; readonly target: number })
  | (Base & { readonly type: 'hold' })
  | (Base & { readonly type: 'face'; readonly facing: number })
  | (Base & { readonly type: 'formation'; readonly formation?: FormationKind; readonly width?: number })
  | (Base & { readonly type: 'follow'; readonly target: number; readonly forward?: number; readonly right?: number })
  | (Base & { readonly type: 'brace'; readonly facing?: number })
  | (Base & { readonly type: 'unbrace' })
  | (Base & { readonly type: 'shield'; readonly mode: 'carry' | 'raise' | 'wall' | 'unwall' })
  | (Base & { readonly type: 'volley'; readonly x: number; readonly y: number })
  | (Base & DashAim & { readonly type: 'charge' | 'assault' | 'infiltrate' })
  | (Base & { readonly type: 'steer'; readonly facing: number })
  /** 攻城：攻方步兵（劍、盾、槍、輕步）對相鄰城牆格架雲梯（x, y 是城牆格裡的點），架設期間停在原地 */
  | (Base & { readonly type: 'ladder'; readonly x: number; readonly y: number })
  /** 攻城：守方在牆頂的兵團推倒雲梯（要站在梯口、梯口附近沒有攻方士兵；讀條期間被攻擊就中斷） */
  | (Base & { readonly type: 'topple'; readonly ladder: number })
  /** 攻城：攻方步兵團附上衝車（target = 衝車 id，目前只有 0）；附上後跟衝車同速 */
  | (Base & { readonly type: 'man'; readonly target: number })
  /** 攻城：從衝車卸下 */
  | (Base & { readonly type: 'unman' })
  /** 佔點模式：後備從出生點入場（場上點數 + 它 ≤ 上限）；入場要準備 enterTicks */
  | (Base & { readonly type: 'summon' })
  /** 佔點模式：場上的這一團在出生點或自己的補給站，換成後備的 with（撤回的血量補滿、人數不變；with 在原地準備入場） */
  | (Base & { readonly type: 'swap'; readonly with: number })
  /** 佔點模式：在出生點或自己的補給站撤回後備 */
  | (Base & { readonly type: 'withdraw' })
  /** 整體戰略意圖（不對某一團；最多 30 字，觀戰畫面顯示在計分條；不佔指令額度） */
  | { readonly type: 'plan'; readonly text: string };

/**
 * 對整個陣營的指令（不對某一團，沒有 id；各佔一條指令額度）。和 LegionCommand 分開定義，
 * 讓「扣掉 plan 就一定有 id」的既有選手型別不受影響。
 */
export type LegionSideCommand =
  /** 守方開門、關門 */
  | { readonly type: 'gate'; readonly gate: number; readonly action: 'open' | 'close' }
  /** 攻方砲擊支援：落點 (x, y)；5 秒後落地、半徑 3 格敵我不分；每場 3 發、冷卻 60 秒；落點在城牆陰影裡會被拒絕 */
  | { readonly type: 'bombard'; readonly x: number; readonly y: number };

/** decide() 可以回傳的所有指令 */
export type LegionOrder = LegionCommand | LegionSideCommand;

export interface LegionHelpers {
  /** 確定性亂數 [0, 1) */
  random(): number;
  /** 單位座標的地形代碼（地圖外回傳 5 河流） */
  terrainAt(x: number, y: number): number;
  /** 單位座標的高度階 */
  heightAt(x: number, y: number): number;
  dist(ax: number, ay: number, bx: number, by: number): number;
  /** 從 a 指向 b 的角度（度） */
  angleTo(ax: number, ay: number, bx: number, by: number): number;
  /** 從 (x, y) 往 deg 方向走 dist 單位後的座標（整數三角函數，與平台無關） */
  offset(x: number, y: number, deg: number, dist: number): [number, number];
}

export interface LegionBot {
  declare(): LegionDeclaration;
  init?(data: LegionInitData, helpers: LegionHelpers): void;
  deploy(data: LegionInitData, helpers: LegionHelpers): Deployment[];
  decide(obs: LegionObservation): LegionOrder[];
}
