// 主執行緒與引擎 Worker 之間的訊息格式。
import type { Command, GameEvent } from '../api/types.ts';
import type { MatchMode } from '../config/index.ts';
import type { MatchResult } from '../core/match.ts';
import type { ReplayFile } from '../replay/index.ts';
import type { Hotspot } from '../view/broadcast.ts';
import type { ScoreRow } from '../view/scoreboard.ts';
import type { FrameView, StaticMapView } from '../view/snapshot.ts';
import type { Comment } from './commentary.ts';

export type OpponentKind = 'baseline' | 'random' | 'dummy';

export interface LiveSetup {
  readonly mode: MatchMode;
  readonly seed: number;
  /** 人類玩家的 playerId；觀戰時為 null */
  readonly human: number | null;
  /** 依 playerId 排列；人類位置填 'human' */
  readonly seats: readonly (OpponentKind | 'human')[];
  /** 人類是否套用與選手相同的指令額度限制 */
  readonly limitBudget: boolean;
  /** 新手教學 */
  readonly tutorial: boolean;
  /** 非預設時限（教學） */
  readonly timeLimitTicks?: number;
}

export type ToWorker =
  | { readonly type: 'startLive'; readonly setup: LiveSetup }
  | { readonly type: 'startReplay'; readonly file: ReplayFile }
  | { readonly type: 'command'; readonly cmds: Command[] }
  | { readonly type: 'speed'; readonly speed: number }
  | { readonly type: 'pause'; readonly paused: boolean }
  | { readonly type: 'seek'; readonly tick: number }
  | { readonly type: 'viewer'; readonly viewer: number }
  /** 精華模式：沒有交戰時自動快轉 */
  | { readonly type: 'highlight'; readonly on: boolean }
  /** 快轉到下一次交戰／直接看結果 */
  | { readonly type: 'skip'; readonly to: 'fight' | 'end' }
  | { readonly type: 'getReplay' };

export interface MatchMeta {
  readonly kind: 'live' | 'replay';
  readonly map: StaticMapView;
  readonly human: number | null;
  readonly limitBudget: boolean;
  readonly tutorial: boolean;
  /** 回放總長（tick）；對局中為 null */
  readonly durationTicks: number | null;
}

export type FromWorker =
  | { readonly type: 'ready'; readonly meta: MatchMeta }
  | {
      readonly type: 'frame';
      readonly frame: FrameView;
      /** 事件與收到該事件的選手 */
      readonly events: { readonly to: number; readonly ev: GameEvent }[];
      readonly speed: number;
      readonly paused: boolean;
      readonly desyncTick: number | null;
      readonly combat: { readonly level: number; readonly hotspots: readonly Hotspot[] };
      readonly highlight: boolean;
      readonly skipping: 'fight' | 'end' | null;
      /** 觀戰與回放才有：數據面板與自動解說 */
      readonly analysis: { readonly scoreboard: ScoreRow[]; readonly comments: Comment[] } | null;
    }
  | { readonly type: 'end'; readonly result: MatchResult }
  | { readonly type: 'replay'; readonly file: ReplayFile }
  | { readonly type: 'error'; readonly message: string };
