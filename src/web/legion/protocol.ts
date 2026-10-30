// 軍團戰觀戰：主執行緒與引擎 Worker 之間的訊息格式。
import type { LegionEvent, RegimentStatus, Structures } from '../../legion/api.ts';
import type { DashKind, FormationKind, LegionMode, ShieldStance, UnitKind } from '../../legion/config.ts';
import type { MapGate } from '../../legion/map.ts';
import type { LegionResult } from '../../legion/sim.ts';

export type BotKey = 'push' | 'ambush' | 'ranged' | 'commander' | 'marshal' | 'general2' | 'marshal2' | 'baseline168' | 'baseline114' | 'siege';

/** 玩家的陣容：場上、後備（佔點模式）各幾團 */
export interface PlayerArmy {
  readonly field: readonly UnitKind[];
  readonly reserve: readonly UnitKind[];
}

export interface MatchSetup {
  readonly kind?: 'match';
  /** 'player' = 玩家指揮（只能是藍方） */
  readonly bots: readonly [BotKey | 'player', BotKey];
  readonly mode: LegionMode;
  /** 地圖（沒給就用模式的預設地圖） */
  readonly mapId?: string;
  readonly seed: number;
  readonly army?: PlayerArmy;
}

/** 自訂對戰（沙盒）裡一方由誰指揮：玩家（只能是藍方）、待命不動、直接進攻，或用現有 AI 指揮指定的兵團 */
export type SandboxRole = 'player' | 'idle' | 'attack' | BotKey;

/** 沙盒布陣：一團的位置（單位座標）、朝向、陣形 */
export interface SandboxUnit {
  readonly kind: UnitKind;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly formation: FormationKind;
}

/** 自訂對戰：平地測試場、不限點數、開打前可以拖曳布陣 */
export interface SandboxSetup {
  readonly kind: 'sandbox';
  readonly seed: number;
  readonly roles: readonly [SandboxRole, SandboxRole];
  /** 依 playerId 的兵團 */
  readonly armies: readonly [readonly UnitKind[], readonly UnitKind[]];
  /** 自動面對面擺放時，雙方前排相距幾格 */
  readonly distance: number;
  /** 依 playerId 的布陣（順序同 armies）；沒有就自動面對面 */
  readonly placement?: readonly [readonly SandboxUnit[], readonly SandboxUnit[]];
}

export type LegionSetup = MatchSetup | SandboxSetup;

export interface RegStatic {
  readonly id: number;
  readonly owner: number;
  readonly kind: UnitKind;
  readonly men0: number;
  readonly cost: number;
  /** 例如「劍士 2」 */
  readonly name: string;
}

export interface PlayerMeta {
  readonly id: number;
  /** 藍方／紅方 */
  readonly side: string;
  readonly color: string;
  readonly bot: string;
  readonly style: string;
  readonly cost: number;
  readonly knobs: Readonly<Record<string, number>>;
}

export interface LegionMeta {
  readonly mapName: string;
  readonly mapDescription: string;
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  readonly heights: Uint8Array;
  /** 旗點（佔點模式）：points = 佔領後每秒得幾分 */
  readonly flags: readonly { readonly name: string; readonly x: number; readonly y: number; readonly points: number }[];
  readonly deploy: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  /** 依 playerId：不是矩形的布陣區（攻城圖的城內）；null = 整個矩形 */
  readonly deployMask: readonly (Uint8Array | null)[];
  /** 佔點模式：依 playerId 的出生點、補給站（歸 flag 那面旗的佔領者） */
  readonly spawns: readonly { readonly x: number; readonly y: number }[];
  readonly supplies: readonly { readonly x: number; readonly y: number; readonly flag: number }[];
  /** 攻城地圖：城門（格座標範圍）與守方座位（-1 = 沒有城） */
  readonly gates: readonly MapGate[];
  readonly defender: number;
  readonly mode: LegionMode;
  readonly timeLimitTicks: number;
  readonly seed: number;
  readonly players: readonly PlayerMeta[];
  readonly regs: readonly RegStatic[];
  readonly soldierCount: number;
  /** 布陣被拒絕的軍團（顯示在陣容畫面） */
  readonly rejected: readonly { readonly player: number; readonly reason: string }[];
  /** 玩家指揮的一方（-1 = 純觀戰；自訂對戰一律 -1＝上帝視角） */
  readonly playerSide: number;
  /** 玩家可以下指令的各方（一般對戰同 playerSide；自訂對戰是「玩家」與「待命」的那幾方） */
  readonly controlSides: readonly number[];
  /** 重播剛才玩家打的那一場（照錄下來的指令重建） */
  readonly replay: boolean;
  /** 自訂對戰（沙盒）：開打前可以拖曳布陣 */
  readonly sandbox: boolean;
}

export interface RegFrame {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly men: number;
  readonly hp: number;
  readonly hpMax: number;
  readonly status: RegimentStatus;
  readonly order: string;
  readonly level: number;
  /** 在樹林中且還沒被敵人發現 */
  readonly concealed: boolean;
  /** 敵方看得到它 */
  readonly seen: boolean;
  readonly target: number;
  readonly fireTarget: number;
  readonly rad: number;
  readonly halfW: number;
  readonly halfD: number;
  readonly kills: number;
  readonly formation: FormationKind;
  readonly stance: ShieldStance | null;
  readonly dashing: DashKind | null;
  /** 衝刺中：目標方向（度）、還剩多遠（單位）、還在對準方向（還沒起步） */
  readonly dash: { readonly dir: number; readonly left: number; readonly aligning: boolean } | null;
  /** 槍林的朝向（度） */
  readonly braceFacing: number;
  /** 齊射中：落點與結束的 tick */
  readonly volley: { readonly x: number; readonly y: number; readonly until: number } | null;
  /** 換陣形還要幾個 tick */
  readonly switchLeft: number;
  /** 招牌技能還要冷卻幾個 tick */
  readonly skillCd: number;
  /** AI 意圖（最近 6 秒內下的） */
  readonly intent: string;
  /** 佔點模式：在後備（不畫在地圖上）；還要幾個 tick 入場（-1 = 沒有排定） */
  readonly reserve: boolean;
  readonly enterIn: number;
}

export interface Caption {
  readonly tick: number;
  readonly text: string;
  /** 重大時刻：畫面中央大字 */
  readonly big?: boolean;
  /** 解說提到的位置（導播可以帶過去） */
  readonly x?: number;
  readonly y?: number;
}

export interface LegionFrame {
  readonly tick: number;
  /** [id, x, y, 旗標] × n；旗標低 12 位為軍團 id，第 12 位 = 本 tick 有出手，第 13 位 = 倒地 */
  readonly soldiers: Int32Array;
  readonly regs: readonly RegFrame[];
  /** [x0, y0, x1, y1, t0, t1] × n：飛行中的箭 */
  readonly arrows: Int32Array;
  /** 旗點：佔領者、正在佔領的一方與進度（tick）、佔領者的圈內有敵人；need ＝ 佔滿要幾 tick、open ＝ 現在能不能佔（攻城戰 B 要等 A） */
  readonly flags: readonly { readonly owner: number; readonly capturer: number; readonly progress: number; readonly contested: boolean; readonly need: number; readonly open: boolean }[];
  /** 城門、雲梯、衝車、砲擊 */
  readonly structures: Structures;
  /** 佔點分數 */
  readonly score: readonly number[];
  /** 依 playerId：AI 的戰略意圖（plan 指令；沒有就是空字串） */
  readonly plans: readonly string[];
  readonly strength: readonly number[];
  readonly kills: readonly number[];
  /** 戰果：擊殺敵兵的點數價值（時間到的判定依據） */
  readonly killValue: readonly number[];
  /** 依 playerId：看得到的軍團（軍團 id 為索引） */
  readonly visible: readonly Uint8Array[];
  readonly events: readonly LegionEvent[];
  readonly captions: readonly Caption[];
  readonly over: boolean;
  readonly result: LegionResult | null;
}

export type ToLegionWorker =
  | { readonly type: 'start'; readonly setup: LegionSetup }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'speed'; readonly speed: number }
  | { readonly type: 'skip' }
  /** 重看／重來；沙盒的 edit = 回到布陣階段 */
  | { readonly type: 'restart'; readonly edit?: boolean }
  /** 沙盒布陣：把一團擺到指定位置、朝向、陣形（開戰前才有效） */
  | { readonly type: 'place'; readonly id: number; readonly x: number; readonly y: number; readonly facing: number; readonly formation: FormationKind }
  /** 沙盒布陣：全部擺回自動面對面 */
  | { readonly type: 'autoPlace' }
  | { readonly type: 'replay' }
  /** 玩家下的指令（下一個決策 tick 交給引擎，每次最多 10 個，多的排到下一次） */
  | { readonly type: 'command'; readonly cmds: readonly unknown[] };

export type FromLegionWorker =
  | { readonly type: 'meta'; readonly meta: LegionMeta }
  | { readonly type: 'frame'; readonly frame: LegionFrame }
  | { readonly type: 'skipped'; readonly x: number; readonly y: number }
  | { readonly type: 'replayFile'; readonly json: string }
  /** 給畫面的短提示（例如沙盒布陣的位置不合法） */
  | { readonly type: 'toast'; readonly text: string }
  | { readonly type: 'error'; readonly message: string };

export const ATTACKED_BIT = 1 << 12;
export const DOWN_BIT = 1 << 13;
export const REG_MASK = (1 << 12) - 1;
/** 士兵旗標的第 14～15 位：層（0 地面、1 牆頂、2 爬梯中） */
export const LAYER_SHIFT = 14;
