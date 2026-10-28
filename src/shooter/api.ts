// CS 射擊選手 API 的公開型別：開局資料、觀察資料、指令、事件。
// 選手程式只依賴本檔；引擎內部型別不對外。
//
// 公平原則（規格書第二節）：觀察資料裡**沒有**視野外敵人的任何欄位。
// 敵人只會出現在 enemies（自己視錐內且有視線）、radar（隊友此刻看見的座標點）、sounds（粗略方向與距離等級）。
import type { KnobDef, KnobValues } from '../api/types.ts';
import type { AttributeKey, GrenadeId, Team, WeaponId, WeaponSlot } from './config.ts';

export type { AttributeKey, GrenadeId, KnobDef, KnobValues, Team, WeaponId, WeaponSlot };

export interface ShooterDeclaration {
  readonly name: string;
  readonly version?: string;
  readonly style: string;
  readonly knobs: readonly KnobDef[];
}

/** 選手屬性包：各 0～100。基準 Bot 以此衍生不同選手；外部選手可忽略 */
export type Attributes = Readonly<Record<AttributeKey, number>>;

// ───────── 開局資料 ─────────

export interface MapRegion {
  /** 代號（英文，給程式）與名稱（給畫面）；例：long／A 長 */
  readonly id: string;
  readonly name: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface MapInfo {
  readonly id: string;
  readonly name: string;
  /** 格數 */
  readonly width: number;
  readonly height: number;
  /** 列優先：1 = 牆（擋移動、擋子彈、擋視線），0 = 可走 */
  readonly solid: readonly number[];
  /** 炸彈點（格矩形，含 x0/y0、不含 x1/y1） */
  readonly sites: readonly { readonly id: 'A' | 'B'; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  /** 出生區（格矩形）：凍結時間只能在此活動、購買限此區 */
  readonly spawnZones: Readonly<Record<Team, { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }>>;
  /** 出生點（座標單位），依隊內序號 */
  readonly spawns: Readonly<Record<Team, readonly { readonly x: number; readonly y: number; readonly facing: number }[]>>;
  /** 命名區域（callout），供戰術層與觀戰字幕；可重疊 */
  readonly regions: readonly MapRegion[];
}

export interface WeaponInfo {
  readonly id: WeaponId;
  readonly name: string;
  readonly slot: WeaponSlot;
  readonly teams: readonly Team[];
  readonly price: number;
  readonly damage: number;
  readonly pellets: number;
  readonly fireTicks: number;
  readonly automatic: boolean;
  readonly magazine: number;
  readonly reserve: number;
  readonly reloadTicks: number;
  readonly armorPen: number;
  readonly falloffPer10: number;
  readonly range: number;
  readonly killReward: number;
  readonly speed: number;
  readonly spread: number;
  readonly movingMul: number;
  readonly scoped: boolean;
}

export interface GrenadeInfo {
  readonly id: GrenadeId;
  readonly name: string;
  readonly teams: readonly Team[];
  readonly price: number;
  readonly maxCarry: number;
  readonly radius: number;
  readonly durationTicks: number;
  readonly damage: number;
}

export interface RulesInfo {
  readonly ticksPerSecond: number;
  readonly decisionInterval: number;
  readonly unit: number;
  readonly teamSize: number;
  readonly fovDeg: number;
  readonly scopedFovDeg: number;
  readonly turnDegPerSec: number;
  readonly bodyRadius: number;
  readonly footstepRange: number;
  readonly roundsPerHalf: number;
  readonly winRounds: number;
  readonly freezeTicks: number;
  readonly buyTicks: number;
  readonly roundTicks: number;
  readonly bombTicks: number;
  readonly plantTicks: number;
  readonly defuseTicks: number;
  readonly defuseKitTicks: number;
  readonly startHp: number;
  readonly maxArmor: number;
  readonly armorPrice: number;
  readonly kitPrice: number;
  readonly economy: {
    readonly startMoney: number;
    readonly maxMoney: number;
    readonly winElimination: number;
    readonly winTimeout: number;
    readonly winBomb: number;
    readonly winDefuse: number;
    readonly lossBonus: readonly number[];
    readonly plantedLossBonus: number;
    readonly planterBonus: number;
    readonly defuserBonus: number;
  };
}

export interface ShooterInitData {
  /** 0～9；0～4 為先攻的 T、5～9 為先守的 CT。換邊後 team 會變，playerId 不變 */
  readonly playerId: number;
  /** 上半場的陣營；下半場相反。每回合的實際陣營看觀察資料 me.team */
  readonly startTeam: Team;
  /** 隊內序號 0～4 */
  readonly slot: number;
  readonly teammateIds: readonly number[];
  readonly enemyIds: readonly number[];
  readonly knobs: KnobValues;
  readonly attributes: Attributes;
  readonly rules: RulesInfo;
  readonly map: MapInfo;
  readonly weapons: readonly WeaponInfo[];
  readonly grenades: readonly GrenadeInfo[];
}

export interface ShooterHelpers {
  /** 確定性亂數 [0, 1) */
  random(): number;
  /** 格子是否為牆（格座標；出界視為牆） */
  isSolid(cx: number, cy: number): boolean;
  /** 兩點（座標單位）之間有無牆阻擋（不含煙霧） */
  clearLine(ax: number, ay: number, bx: number, by: number): boolean;
  dist(ax: number, ay: number, bx: number, by: number): number;
  /** 方位角（整數度） */
  angleTo(ax: number, ay: number, bx: number, by: number): number;
  /** 以角度前進 d 的座標 */
  offset(x: number, y: number, deg: number, d: number): [number, number];
  /** 點所在的命名區域代號（可能多個；由內而外排序） */
  regionsAt(x: number, y: number): string[];
}

// ───────── 觀察資料 ─────────

export type RoundPhase = 'freeze' | 'live' | 'planted' | 'over';
/**
 * unknown：CT 在下包前沒看見炸彈（不知道在誰身上、有沒有掉）。下包後、拆除或引爆後全員可知。
 * 下包中／拆包中只有自己隊伍或親眼看見時才會顯示，否則照「carried／unknown」與「planted」。
 */
export type BombState = 'unknown' | 'carried' | 'dropped' | 'planting' | 'planted' | 'defusing' | 'defused' | 'exploded';
export type RoundEndReason = 'elimination' | 'bomb' | 'defuse' | 'timeout';

export interface RoundInfo {
  /** 1 起算 */
  readonly number: number;
  readonly half: 1 | 2;
  readonly phase: RoundPhase;
  /** 目前階段剩餘 tick（live 為回合時間、planted 為炸彈倒數） */
  readonly phaseTicksLeft: number;
  readonly scoreT: number;
  readonly scoreCT: number;
  /** 本回合是否仍可購買（凍結或 buyTicks 內且人在出生區） */
  readonly canBuy: boolean;
  /** 回合已結束時的結果；其他為 null */
  readonly ended: { readonly winner: Team; readonly reason: RoundEndReason } | null;
}

export interface Loadout {
  readonly primary: WeaponId | null;
  readonly secondary: WeaponId | null;
  readonly grenades: readonly GrenadeId[];
  readonly armor: number;
  readonly kit: boolean;
}

export interface SelfInfo {
  readonly id: number;
  readonly team: Team;
  readonly alive: boolean;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly hp: number;
  readonly money: number;
  readonly loadout: Loadout;
  /** 手上的武器 */
  readonly weapon: WeaponId;
  readonly ammoMag: number;
  readonly ammoReserve: number;
  readonly reloadTicksLeft: number;
  /** 目前散佈（度 ×100），含後座力 */
  readonly spread: number;
  readonly scoped: boolean;
  readonly walking: boolean;
  readonly crouching: boolean;
  readonly hasBomb: boolean;
  /** 致盲剩餘 tick（> 0 時 enemies 與 radar 為空） */
  readonly blindTicks: number;
  /** 下包／拆包進度（tick）；未進行為 0 */
  readonly plantTicks: number;
  readonly defuseTicks: number;
  /** 速度向量（座標單位／tick），供選手判斷自己是否在動 */
  readonly vx: number;
  readonly vy: number;
}

export interface TeammateInfo {
  readonly id: number;
  readonly alive: boolean;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly hp: number;
  readonly weapon: WeaponId;
  readonly hasBomb: boolean;
  readonly planting: boolean;
  readonly defusing: boolean;
  readonly blind: boolean;
}

/** 自己視錐內且有視線的敵人。沒有血量、沒有金錢 */
export interface EnemyInfo {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly weapon: WeaponId;
  readonly crouching: boolean;
  readonly planting: boolean;
  readonly defusing: boolean;
  readonly hasBomb: boolean;
}

/** 隊友此刻看見、自己沒看見的敵人：只有座標 */
export interface RadarContact {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export type SoundKind = 'footstep' | 'shot' | 'reload' | 'plant' | 'defuse' | 'grenadeLand' | 'explosion' | 'bombBeep';
export type SoundRange = 'near' | 'mid' | 'far';

export interface SoundEvent {
  readonly kind: SoundKind;
  /** 量化後的方向（度，SOUND.directionStepDeg 的倍數） */
  readonly dirDeg: number;
  readonly range: SoundRange;
  /** 槍聲帶武器；其餘 null */
  readonly weapon: WeaponId | null;
  /** 是否確定來自隊友（自己隊友的動作）；敵我不明為 false */
  readonly friendly: boolean;
}

export interface BombInfo {
  readonly state: BombState;
  /** 已下包／掉落且看得見時的位置；下包後全員可知 */
  readonly x: number | null;
  readonly y: number | null;
  readonly site: 'A' | 'B' | null;
  /** 引爆倒數（planted 之後） */
  readonly ticksLeft: number | null;
}

export interface AreaEffect {
  readonly kind: 'smoke' | 'fire';
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly ticksLeft: number;
}

export interface DroppedItem {
  readonly kind: 'weapon' | 'bomb' | 'kit';
  readonly weapon: WeaponId | null;
  readonly x: number;
  readonly y: number;
}

export interface TeamMessage {
  readonly from: number;
  readonly text: string;
}

export interface ShooterObservation {
  readonly tick: number;
  readonly round: RoundInfo;
  readonly me: SelfInfo;
  readonly teammates: readonly TeammateInfo[];
  readonly enemies: readonly EnemyInfo[];
  readonly radar: readonly RadarContact[];
  /** 自上次決策以來的聲音事件 */
  readonly sounds: readonly SoundEvent[];
  readonly bomb: BombInfo;
  /** 看得見的煙霧與火（視錐內或貼近自己） */
  readonly effects: readonly AreaEffect[];
  /** 看得見的掉落物 */
  readonly items: readonly DroppedItem[];
  /** 自上次決策以來的隊內喊話 */
  readonly chat: readonly TeamMessage[];
  /** 還活著的敵人數（計分板公開資訊） */
  readonly enemiesAlive: number;
}

// ───────── 指令 ─────────

export type BuyItem = WeaponId | GrenadeId | 'armor' | 'kit';

export type ShooterCommand =
  /** 走到目標點（引擎尋路；到達後停） */
  | { readonly type: 'move'; readonly x: number; readonly y: number }
  /** 朝方向直走（不尋路；撞牆就停） */
  | { readonly type: 'moveDir'; readonly deg: number }
  | { readonly type: 'stop' }
  /** 瞄準點；轉身受速度上限 */
  | { readonly type: 'aim'; readonly x: number; readonly y: number }
  /** 開火／停火；半自動武器每次決策 on 只打一發 */
  | { readonly type: 'fire'; readonly on: boolean }
  | { readonly type: 'switch'; readonly slot: WeaponSlot }
  | { readonly type: 'reload' }
  | { readonly type: 'walk'; readonly on: boolean }
  | { readonly type: 'crouch'; readonly on: boolean }
  | { readonly type: 'scope'; readonly on: boolean }
  /** 在炸彈點內、持炸彈的 T 才有效；持續到完成或中斷 */
  | { readonly type: 'plant' }
  /** 貼近已下的炸彈的 CT 才有效 */
  | { readonly type: 'defuse' }
  /** 撿起腳邊的掉落物 */
  | { readonly type: 'pickup' }
  /** 丟掉手上武器（刀不可丟）；bomb = true 改為丟炸彈（傳給隊友用） */
  | { readonly type: 'drop'; readonly bomb?: boolean }
  | { readonly type: 'buy'; readonly items: readonly BuyItem[] }
  /** 丟雷：方向與力道（0～100，對應投擲距離） */
  | { readonly type: 'throw'; readonly grenade: GrenadeId; readonly deg: number; readonly power: number }
  /** 隊內喊話（只有隊友的下一次觀察看得到） */
  | { readonly type: 'say'; readonly text: string };

// ───────── 選手模組 ─────────

export interface ShooterBot {
  declare(): ShooterDeclaration;
  /** 開局一次（整場，換邊不重呼叫） */
  init?(data: ShooterInitData, helpers: ShooterHelpers): void;
  /** 每 DECISION_INTERVAL tick 一次；死亡與凍結時間也會呼叫（可買、可喊話） */
  decide(obs: ShooterObservation): readonly ShooterCommand[];
}
