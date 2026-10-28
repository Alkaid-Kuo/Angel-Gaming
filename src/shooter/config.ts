// CS 射擊：規則常數、武器表、經濟表、道具表。
// 全部數值參照 CS2，標「待審」者在步驟 5 試玩後凍結。
// 單位約定：
//   長度　1 格 = 1 公尺 = UNIT（1000）個座標單位；所有位置、半徑、距離都是座標單位的整數。
//   時間　tick；TPS = 30。秒數換 tick 一律 ticks(sec)。
//   角度　整數度；0 = +x（東）、90 = +y（畫面下＝南）。
//   速度　座標單位／tick（已由 CS 的 units／秒換算：1 格 ≈ 52.5 units）。

export const SHOOTER_ENGINE_VERSION = '0.1.0';

export const TPS = 30;
export const UNIT = 1000;
/** 選手每幾個 tick 決策一次（10 Hz）；指令持續到下一次決策 */
export const DECISION_INTERVAL = 3;

export type Team = 'T' | 'CT';
export const TEAMS: readonly Team[] = ['T', 'CT'];
export const TEAM_SIZE = 5;

export function ticks(seconds: number): number {
  return Math.round(seconds * TPS);
}

/** CS 的 units／秒 → 座標單位／tick（1 格 = 52.5 units；四捨五入） */
export function speedFromUnits(unitsPerSec: number): number {
  return Math.round((unitsPerSec * UNIT * 10) / (525 * TPS));
}

// ───────── 視野、聲音、轉身（公平規則，引擎強制） ─────────

export const VISION = {
  /** 水平視角（度，待審）。視錐外一律看不見 */
  fovDeg: 100,
  /** 開鏡時的視角 */
  scopedFovDeg: 30,
  /** 轉身速度上限（度／秒，待審）。玩家與 Bot 都受限 */
  turnDegPerSec: 720,
  /** 角色碰撞半徑（座標單位）＝ 0.3 格 */
  bodyRadius: 300,
  /** 隊友雷達：隊友此刻看見的敵人只給座標點 */
  radarSharesFacing: false,
} as const;

export const SOUND = {
  /** 跑步腳步可聽見的距離（格，待審）；靜步無聲 */
  footstepRange: 20,
  /** 手槍、衝鋒槍、霰彈槍聲可聽見的距離（格）；步槍、狙擊全圖 */
  lightGunRange: 60,
  /** 方向量化（度）：聲音只給粗略方向 */
  directionStepDeg: 30,
  /** 距離等級分界（格）：near < 12、mid < 30、其餘 far */
  nearRange: 12,
  midRange: 30,
  /** 換彈、下包、拆包、丟雷落地可聽見的距離（格） */
  actionRange: 15,
} as const;

// ───────── 回合與賽制 ─────────

export const ROUND = {
  /** MR12：先到 13 勝；12 回合後換邊；12:12 平手（加時待審） */
  roundsPerHalf: 12,
  winRounds: 13,
  freezeTicks: ticks(15),
  buyTicks: ticks(20),
  roundTicks: ticks(115),
  bombTicks: ticks(40),
  plantTicks: ticks(3.2),
  defuseTicks: ticks(10),
  defuseKitTicks: ticks(5),
  /** 回合結束後的展示時間（下一回合開始前） */
  roundEndTicks: ticks(5),
  /** 炸彈引爆範圍：中心全額、邊緣歸零（格） */
  bombBlastRadius: 17,
  bombBlastDamage: 500,
  startHp: 100,
  maxArmor: 100,
} as const;

// ───────── 武器 ─────────

export type WeaponId = 'pistol' | 'deagle' | 'smg' | 'shotgun' | 'ak' | 'm4' | 'awp' | 'knife';
export const WEAPON_IDS: readonly WeaponId[] = ['pistol', 'deagle', 'smg', 'shotgun', 'ak', 'm4', 'awp', 'knife'];
export type WeaponSlot = 'primary' | 'secondary' | 'knife';

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  readonly slot: WeaponSlot;
  /** 可購買的陣營；空陣列＝不可購買（開局配發或刀） */
  readonly teams: readonly Team[];
  readonly price: number;
  /** 每發（霰彈為每顆彈丸）基礎傷害 */
  readonly damage: number;
  /** 霰彈彈丸數；其他為 1 */
  readonly pellets: number;
  /** 兩發間隔（tick），由 rpm 換算 */
  readonly fireTicks: number;
  /** 是否可按住連射 */
  readonly automatic: boolean;
  readonly magazine: number;
  readonly reserve: number;
  readonly reloadTicks: number;
  /** 穿甲率（%）：護甲只擋 (100 − pen)% 的傷害 */
  readonly armorPen: number;
  /** 每 10 格的傷害衰減（%） */
  readonly falloffPer10: number;
  /** 有效射程（格）：超過後只剩 20% 傷害（霰彈 8 格外幾乎無傷） */
  readonly range: number;
  readonly killReward: number;
  /** 持槍移動速度（座標單位／tick） */
  readonly speed: number;
  /**
   * 散佈（度 ×100）：站立靜止的基礎值；蹲 ×0.7、靜步 ×1.2、跑 ×movingMul、開鏡 ×0.1；
   * 連射每發加 recoilStep，停火後每 tick 回復 recoilDecay
   */
  readonly spread: number;
  readonly movingMul: number;
  readonly recoilStep: number;
  readonly recoilDecay: number;
  /** 狙擊鏡：開鏡後的移動速度；null = 無鏡 */
  readonly scopedSpeed: number | null;
}

const rpm = (n: number): number => Math.max(1, Math.round((TPS * 60) / n));

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = {
  pistol: { id: 'pistol', name: '手槍', slot: 'secondary', teams: [], price: 0, damage: 30, pellets: 1, fireTicks: rpm(400), automatic: false, magazine: 20, reserve: 120, reloadTicks: ticks(2.2), armorPen: 50, falloffPer10: 8, range: 40, killReward: 300, speed: speedFromUnits(240), spread: 120, movingMul: 3, recoilStep: 60, recoilDecay: 12, scopedSpeed: null },
  deagle: { id: 'deagle', name: '沙漠之鷹', slot: 'secondary', teams: ['T', 'CT'], price: 700, damage: 54, pellets: 1, fireTicks: rpm(267), automatic: false, magazine: 7, reserve: 35, reloadTicks: ticks(2.2), armorPen: 93, falloffPer10: 6, range: 50, killReward: 300, speed: speedFromUnits(230), spread: 90, movingMul: 5, recoilStep: 150, recoilDecay: 10, scopedSpeed: null },
  smg: { id: 'smg', name: '衝鋒槍', slot: 'primary', teams: ['T', 'CT'], price: 1250, damage: 26, pellets: 1, fireTicks: rpm(857), automatic: true, magazine: 30, reserve: 120, reloadTicks: ticks(2.1), armorPen: 60, falloffPer10: 10, range: 30, killReward: 600, speed: speedFromUnits(240), spread: 150, movingMul: 1.6, recoilStep: 25, recoilDecay: 10, scopedSpeed: null },
  shotgun: { id: 'shotgun', name: '霰彈槍', slot: 'primary', teams: ['T', 'CT'], price: 1050, damage: 26, pellets: 8, fireTicks: rpm(68), automatic: false, magazine: 8, reserve: 32, reloadTicks: ticks(0.6), armorPen: 50, falloffPer10: 30, range: 8, killReward: 900, speed: speedFromUnits(220), spread: 700, movingMul: 1.2, recoilStep: 0, recoilDecay: 20, scopedSpeed: null },
  ak: { id: 'ak', name: 'AK', slot: 'primary', teams: ['T'], price: 2700, damage: 36, pellets: 1, fireTicks: rpm(600), automatic: true, magazine: 30, reserve: 90, reloadTicks: ticks(2.5), armorPen: 77, falloffPer10: 2, range: 70, killReward: 300, speed: speedFromUnits(215), spread: 80, movingMul: 6, recoilStep: 45, recoilDecay: 8, scopedSpeed: null },
  m4: { id: 'm4', name: 'M4', slot: 'primary', teams: ['CT'], price: 3100, damage: 33, pellets: 1, fireTicks: rpm(666), automatic: true, magazine: 30, reserve: 90, reloadTicks: ticks(3.1), armorPen: 70, falloffPer10: 2, range: 70, killReward: 300, speed: speedFromUnits(215), spread: 70, movingMul: 6, recoilStep: 35, recoilDecay: 9, scopedSpeed: null },
  awp: { id: 'awp', name: '狙擊槍', slot: 'primary', teams: ['T', 'CT'], price: 4750, damage: 115, pellets: 1, fireTicks: rpm(41), automatic: false, magazine: 10, reserve: 30, reloadTicks: ticks(3.7), armorPen: 97, falloffPer10: 1, range: 120, killReward: 100, speed: speedFromUnits(200), spread: 2500, movingMul: 8, recoilStep: 0, recoilDecay: 100, scopedSpeed: speedFromUnits(100) },
  knife: { id: 'knife', name: '刀', slot: 'knife', teams: [], price: 0, damage: 40, pellets: 1, fireTicks: rpm(90), automatic: false, magazine: 0, reserve: 0, reloadTicks: 0, armorPen: 85, falloffPer10: 0, range: 1, killReward: 1500, speed: speedFromUnits(250), spread: 0, movingMul: 1, recoilStep: 0, recoilDecay: 0, scopedSpeed: null },
};

export const MOVE = {
  /** 靜步、蹲下的速度倍率（%） */
  walkPct: 52,
  crouchPct: 34,
  /** 開鏡時視錐縮小；見 VISION.scopedFovDeg */
} as const;

export const ARMOR = { price: 650, points: 100 } as const;
export const DEFUSE_KIT = { price: 400, team: 'CT' as Team } as const;

// ───────── 經濟 ─────────

export const ECONOMY = {
  startMoney: 800,
  maxMoney: 16000,
  /** 殲滅／時間到 */
  winElimination: 3250,
  winTimeout: 3250,
  /** 引爆／拆彈 */
  winBomb: 3500,
  winDefuse: 3500,
  /** 連敗補償（第 1～5 敗）；勝一場後退一階 */
  lossBonus: [1400, 1900, 2400, 2900, 3400] as readonly number[],
  /** T 敗但有下包：全隊加發 */
  plantedLossBonus: 800,
  planterBonus: 300,
  defuserBonus: 300,
  grenadeKillReward: 300,
  teamKillPenalty: -300,
} as const;

// ───────── 道具 ─────────

export type GrenadeId = 'flash' | 'smoke' | 'he' | 'molotov' | 'incendiary';
export const GRENADE_IDS: readonly GrenadeId[] = ['flash', 'smoke', 'he', 'molotov', 'incendiary'];

export interface GrenadeDef {
  readonly id: GrenadeId;
  readonly name: string;
  readonly teams: readonly Team[];
  readonly price: number;
  /** 同種最多攜帶 */
  readonly maxCarry: number;
  /** 投擲後幾 tick 生效（落地或引信） */
  readonly fuseTicks: number;
  /** 效果半徑（座標單位） */
  readonly radius: number;
  /** 效果持續（tick）；瞬間效果為 0 */
  readonly durationTicks: number;
  /** 傷害：HE 為中心傷害；燃燒為每秒傷害；其他 0 */
  readonly damage: number;
}

export const GRENADES: Readonly<Record<GrenadeId, GrenadeDef>> = {
  flash: { id: 'flash', name: '閃光彈', teams: ['T', 'CT'], price: 200, maxCarry: 2, fuseTicks: ticks(1.5), radius: 15 * UNIT, durationTicks: 0, damage: 0 },
  smoke: { id: 'smoke', name: '煙霧彈', teams: ['T', 'CT'], price: 300, maxCarry: 1, fuseTicks: ticks(1.5), radius: 3 * UNIT, durationTicks: ticks(18), damage: 0 },
  he: { id: 'he', name: '手雷', teams: ['T', 'CT'], price: 300, maxCarry: 1, fuseTicks: ticks(1.5), radius: 3500, durationTicks: 0, damage: 98 },
  molotov: { id: 'molotov', name: '燃燒瓶', teams: ['T'], price: 400, maxCarry: 1, fuseTicks: ticks(1.0), radius: 3 * UNIT, durationTicks: ticks(7), damage: 40 },
  incendiary: { id: 'incendiary', name: '燃燒彈', teams: ['CT'], price: 600, maxCarry: 1, fuseTicks: ticks(1.0), radius: 3 * UNIT, durationTicks: ticks(7), damage: 40 },
};

export const GRENADE_RULES = {
  /** 道具總格數 */
  totalSlots: 4,
  /** 投擲最遠距離（格）；力道 0～100 線性 */
  maxThrowRange: 25,
  /** 飛行速度（座標單位／tick） */
  flySpeed: speedFromUnits(900),
  /** 煙霧擴散時間 */
  smokeBloomTicks: ticks(1),
  /** 閃光：正對／側向／背對的最長致盲時間（tick），再依距離線性遞減 */
  flashFrontTicks: ticks(2.0),
  flashSideTicks: ticks(1.0),
  flashBackTicks: ticks(0.3),
  /** HE 對護甲的傷害折半 */
  heArmorPct: 50,
  /** 燃燒每幾 tick 結算一次 */
  fireTickInterval: ticks(0.2),
} as const;

// ───────── 選手程式的時間限制（沿用 RTS／軍團戰） ─────────

export const TIMING = {
  initMs: 1000,
  decideHardMs: 50,
  /** 同一回合連續超時幾次視為閒置 */
  idleAfterTimeouts: 10,
} as const;

// ───────── 選手屬性（基準 Bot 讀；外部選手可忽略） ─────────

export type AttributeKey = 'aim' | 'reaction' | 'awareness' | 'aggression' | 'discipline' | 'movement';
export const ATTRIBUTE_KEYS: readonly AttributeKey[] = ['aim', 'reaction', 'awareness', 'aggression', 'discipline', 'movement'];
export const ATTRIBUTE_NAMES: Readonly<Record<AttributeKey, string>> = {
  aim: '瞄準',
  reaction: '反應',
  awareness: '警覺',
  aggression: '侵略',
  discipline: '紀律',
  movement: '走位',
};
/** Bot 反應延遲下限（毫秒）：屬性只能讓它更慢 */
export const MIN_REACTION_MS = 150;
