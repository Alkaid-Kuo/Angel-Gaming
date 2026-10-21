// 主執行緒與引擎 Worker 之間的訊息格式。
import type { Command, GameEvent } from '../api/types.ts';
import type { MatchMode } from '../config/index.ts';
import type { MatchResult } from '../core/match.ts';
import type { ReplayFile } from '../replay/index.ts';
import type { FrameView, StaticMapView } from '../view/snapshot.ts';

export type OpponentKind = 'baseline' | 'random';

export interface LiveSetup {
  readonly mode: MatchMode;
  readonly seed: number;
  /** 人類玩家的 playerId；觀戰時為 null */
  readonly human: number | null;
  /** 依 playerId 排列；人類位置填 'human' */
  readonly seats: readonly (OpponentKind | 'human')[];
  /** 人類是否套用與選手相同的指令額度限制 */
  readonly limitBudget: boolean;
}

export type ToWorker =
  | { readonly type: 'startLive'; readonly setup: LiveSetup }
  | { readonly type: 'startReplay'; readonly file: ReplayFile }
  | { readonly type: 'command'; readonly cmds: Command[] }
  | { readonly type: 'speed'; readonly speed: number }
  | { readonly type: 'pause'; readonly paused: boolean }
  | { readonly type: 'seek'; readonly tick: number }
  | { readonly type: 'viewer'; readonly viewer: number }
  | { readonly type: 'getReplay' };

export interface MatchMeta {
  readonly kind: 'live' | 'replay';
  readonly map: StaticMapView;
  readonly human: number | null;
  readonly limitBudget: boolean;
  /** 回放總長（tick）；對局中為 null */
  readonly durationTicks: number | null;
}

export type FromWorker =
  | { readonly type: 'ready'; readonly meta: MatchMeta }
  | { readonly type: 'frame'; readonly frame: FrameView; readonly events: GameEvent[]; readonly speed: number; readonly paused: boolean; readonly desyncTick: number | null }
  | { readonly type: 'end'; readonly result: MatchResult }
  | { readonly type: 'replay'; readonly file: ReplayFile }
  | { readonly type: 'error'; readonly message: string };
