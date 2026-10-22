// 軍團戰選手 API 的公開型別：開局資料、布陣、觀察資料、指令、事件。
import type { KnobDef, KnobValues } from '../api/types.ts';
import type { LegionMode, UnitKind } from './config.ts';

export type { KnobDef, KnobValues, LegionMode, UnitKind };

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
  readonly range: number;
  readonly reach: number;
  readonly speed: number;
  readonly chargeSpeed: number;
  readonly sight: number;
  readonly width: number;
  readonly spacingX: number;
  readonly spacingY: number;
  readonly cavalry: boolean;
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
    /** 列優先的地形代碼：0 平地、1 道路、2 樹林、3 高地、4 淺灘、5 河流、6 橋、7 建築、8 城牆 */
    readonly terrain: readonly number[];
    /** 依 playerId 的布陣區（格座標，含 x0/y0、不含 x1/y1） */
    readonly deploy: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
    readonly flags: readonly { readonly id: number; readonly name: string; readonly x: number; readonly y: number }[];
  };
  readonly units: readonly UnitInfo[];
  /** 相剋倍率（百分比）：versus[攻擊方][目標] */
  readonly versus: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface Deployment {
  readonly type: UnitKind;
  readonly x: number;
  readonly y: number;
  /** 角度（度）：0 朝東（+x）、90 朝南（+y） */
  readonly facing?: number;
  /** 橫寬（人） */
  readonly width?: number;
}

export type RegimentStatus = 'idle' | 'moving' | 'attacking' | 'engaged' | 'charging' | 'bracing' | 'braced' | 'unbracing' | 'routed';

export interface OwnRegiment {
  readonly id: number;
  readonly kind: UnitKind;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly width: number;
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
  readonly canCharge: boolean;
  readonly routed: boolean;
  /** 所在地形代碼 */
  readonly terrain: number;
  /** 半徑（單位）：中心到最遠士兵 */
  readonly radius: number;
}

export interface EnemyRegiment {
  readonly id: number;
  readonly owner: number;
  readonly kind: UnitKind;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly width: number;
  readonly men: number;
  readonly men0: number;
  readonly status: RegimentStatus;
  readonly engaged: boolean;
  readonly routed: boolean;
  readonly terrain: number;
  readonly radius: number;
}

export interface FlagState {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** -1 = 中立 */
  readonly owner: number;
  /** 佔領值 0～100（中立時是 capturer 的進度） */
  readonly value: number;
  readonly capturer: number;
}

export type LegionEvent =
  | { readonly type: 'deployRejected'; readonly tick: number; readonly player: number; readonly index: number; readonly reason: string }
  | { readonly type: 'contact'; readonly tick: number; readonly a: number; readonly b: number; readonly flank: 'front' | 'side' | 'rear' }
  | { readonly type: 'impact'; readonly tick: number; readonly reg: number; readonly target: number; readonly kills: number; readonly braced: boolean; readonly flank: 'front' | 'side' | 'rear' }
  | { readonly type: 'ambush'; readonly tick: number; readonly reg: number }
  | { readonly type: 'routed'; readonly tick: number; readonly reg: number }
  | { readonly type: 'destroyed'; readonly tick: number; readonly reg: number; readonly escaped: boolean }
  | { readonly type: 'levelUp'; readonly tick: number; readonly reg: number; readonly level: number }
  | { readonly type: 'flag'; readonly tick: number; readonly flag: number; readonly owner: number }
  | { readonly type: 'domination'; readonly tick: number; readonly player: number; readonly started: boolean }
  | { readonly type: 'rejected'; readonly tick: number; readonly player: number; readonly command: string; readonly reason: string };

export interface LegionObservation {
  readonly tick: number;
  readonly timeLeft: number;
  readonly me: number;
  readonly regiments: readonly OwnRegiment[];
  /** 只有看得到的敵軍 */
  readonly enemies: readonly EnemyRegiment[];
  readonly flags: readonly FlagState[];
  /** 依 playerId：連續控制過半旗點的 tick 數 */
  readonly domination: readonly number[];
  /** 自上次決策後與自己有關的事件 */
  readonly events: readonly LegionEvent[];
}

export type LegionCommand =
  | { readonly type: 'move'; readonly id: number; readonly x: number; readonly y: number; readonly facing?: number }
  | { readonly type: 'attackMove'; readonly id: number; readonly x: number; readonly y: number }
  | { readonly type: 'attack'; readonly id: number; readonly target: number }
  | { readonly type: 'charge'; readonly id: number; readonly target: number }
  | { readonly type: 'brace'; readonly id: number }
  | { readonly type: 'unbrace'; readonly id: number }
  | { readonly type: 'hold'; readonly id: number }
  | { readonly type: 'formation'; readonly id: number; readonly width: number }
  | { readonly type: 'face'; readonly id: number; readonly facing: number };

export interface LegionHelpers {
  /** 確定性亂數 [0, 1) */
  random(): number;
  /** 單位座標的地形代碼（地圖外回傳 5 河流） */
  terrainAt(x: number, y: number): number;
  dist(ax: number, ay: number, bx: number, by: number): number;
  /** 從 a 指向 b 的角度（度） */
  angleTo(ax: number, ay: number, bx: number, by: number): number;
}

export interface LegionBot {
  declare(): LegionDeclaration;
  init?(data: LegionInitData, helpers: LegionHelpers): void;
  deploy(data: LegionInitData, helpers: LegionHelpers): Deployment[];
  decide(obs: LegionObservation): LegionCommand[];
}
