// 軍團戰觀戰：主執行緒與引擎 Worker 之間的訊息格式。
import type { LegionEvent, RegimentStatus } from '../../legion/api.ts';
import type { LegionMode, UnitKind } from '../../legion/config.ts';
import type { LegionResult } from '../../legion/sim.ts';

export type BotKey = 'push' | 'ambush' | 'ranged';

export interface LegionSetup {
  readonly bots: readonly [BotKey, BotKey];
  readonly mode: LegionMode;
  readonly seed: number;
}

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
  readonly flags: readonly { readonly name: string; readonly x: number; readonly y: number }[];
  readonly deploy: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  readonly mode: LegionMode;
  readonly timeLimitTicks: number;
  readonly seed: number;
  readonly players: readonly PlayerMeta[];
  readonly regs: readonly RegStatic[];
  readonly soldierCount: number;
  /** 布陣被拒絕的軍團（顯示在陣容畫面） */
  readonly rejected: readonly { readonly player: number; readonly reason: string }[];
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
  readonly needDisengage: boolean;
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
  /** [id, x, y, 旗標] × n；旗標低 12 位為軍團 id，第 12 位 = 本 tick 有出手 */
  readonly soldiers: Int32Array;
  readonly regs: readonly RegFrame[];
  /** [x0, y0, x1, y1, t0, t1] × n：飛行中的箭 */
  readonly arrows: Int32Array;
  readonly flags: readonly { readonly owner: number; readonly value: number; readonly capturer: number }[];
  readonly domination: readonly number[];
  readonly strength: readonly number[];
  readonly kills: readonly number[];
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
  | { readonly type: 'restart' }
  | { readonly type: 'replay' };

export type FromLegionWorker =
  | { readonly type: 'meta'; readonly meta: LegionMeta }
  | { readonly type: 'frame'; readonly frame: LegionFrame }
  | { readonly type: 'skipped'; readonly x: number; readonly y: number }
  | { readonly type: 'replayFile'; readonly json: string }
  | { readonly type: 'error'; readonly message: string };

export const ATTACKED_BIT = 1 << 12;
export const REG_MASK = (1 << 12) - 1;
