// CS 射擊可玩版：主執行緒與引擎 Worker 之間的訊息格式。
// 公平原則：玩家模式下 Worker 只送觀察資料（ShooterObservation）與計分板的公開資訊，主執行緒不持有引擎；
// 只有開局勾選「觀戰模式」才另送引擎全狀態快照（FullState）。
import type { GrenadeInfo, MapInfo, RulesInfo, ShooterCommand, ShooterObservation, SoundEvent, Team, WeaponInfo, WeaponId, GrenadeId } from '../../shooter/api.ts';

export interface ShooterSetup {
  /** 玩家開局的陣營（T = playerId 0、CT = playerId 5；半場換邊後陣營互換） */
  readonly team: Team;
  readonly seed: number;
  /** 觀戰模式：不參賽，10 隻陪練 Bot 互打，畫面讀引擎全狀態 */
  readonly spectate: boolean;
  /** 除錯用（只有網址 ?auto=…&loadout=awp 會帶）：雙方開局主武器 */
  readonly loadout?: WeaponId;
}

export type ToShooterWorker =
  | { readonly type: 'start'; readonly setup: ShooterSetup }
  | { readonly type: 'cmd'; readonly cmds: readonly ShooterCommand[] }
  /** 死後看隊友（玩家模式）或觀戰模式跟隨的選手：±1 循環切換，或直接指定 */
  | { readonly type: 'view'; readonly step?: number; readonly id?: number }
  | { readonly type: 'pause'; readonly paused: boolean }
  /** 觀戰模式的播放速度 */
  | { readonly type: 'speed'; readonly speed: number }
  | { readonly type: 'stop' };

export interface ShooterMeta {
  readonly playerId: number;
  readonly spectate: boolean;
  readonly seed: number;
  readonly names: readonly string[];
  /** 依 playerId：0 = 上半場 T 的那一組、1 = 上半場 CT 的那一組 */
  readonly groups: readonly (0 | 1)[];
  readonly rules: RulesInfo;
  readonly map: MapInfo;
  readonly weapons: readonly WeaponInfo[];
  readonly grenades: readonly GrenadeInfo[];
}

/** 計分板一列（公開資訊）：敵人的金錢在比賽中為 null */
export interface BoardRow {
  readonly id: number;
  readonly team: Team;
  readonly alive: boolean;
  readonly kills: number;
  readonly deaths: number;
  readonly money: number | null;
}

export interface KillFeedItem {
  readonly tick: number;
  readonly killer: number;
  readonly victim: number;
  readonly weapon: WeaponId | GrenadeId | 'bomb';
}

/** 觀戰模式專用：引擎全狀態快照 */
export interface FullPlayer {
  readonly id: number;
  readonly team: Team;
  readonly alive: boolean;
  readonly x: number;
  readonly y: number;
  /** 整數度 */
  readonly facing: number;
  readonly hp: number;
  readonly weapon: WeaponId;
  readonly hasBomb: boolean;
  readonly blind: boolean;
  readonly scoped: boolean;
  /** 最近 3 tick 內開過火（畫槍口火光） */
  readonly firing: boolean;
}

export interface FullState {
  readonly players: readonly FullPlayer[];
  readonly smokes: readonly { readonly x: number; readonly y: number; readonly radius: number }[];
  readonly fires: readonly { readonly x: number; readonly y: number; readonly radius: number; readonly cells: readonly number[] }[];
  readonly projectiles: readonly { readonly kind: GrenadeId; readonly x: number; readonly y: number }[];
  readonly items: readonly { readonly kind: 'weapon' | 'bomb' | 'kit'; readonly weapon: WeaponId | null; readonly x: number; readonly y: number }[];
  readonly bomb: { readonly state: string; readonly x: number; readonly y: number; readonly ticksLeft: number | null };
}

export interface ShooterFrame {
  readonly tick: number;
  /** 畫面跟隨的選手：玩家活著時是自己，死後是所看的隊友；觀戰模式是所選的選手 */
  readonly viewId: number;
  /** viewId 的觀察資料（畫面唯一的資料來源；觀戰模式另有 full） */
  readonly view: ShooterObservation;
  /** 玩家自己的觀察資料（HUD 的金錢、購買用；觀戰模式等於 view） */
  readonly self: ShooterObservation;
  /** 自上一個 frame 以來 viewId 聽到的聲音（每個決策 tick 的視窗不重複） */
  readonly sounds: readonly SoundEvent[];
  readonly board: readonly BoardRow[];
  readonly feed: readonly KillFeedItem[];
  readonly full: FullState | null;
  readonly paused: boolean;
}

export interface ShooterSummary {
  /** 勝方組別（0 = 上半場 T 的那一組）；平手為 null */
  readonly winnerGroup: 0 | 1 | null;
  /** 依組別（0 = 上半場 T） */
  readonly score: readonly [number, number];
  readonly rounds: readonly { readonly number: number; readonly winner: Team; readonly winnerGroup: 0 | 1; readonly reason: string }[];
  readonly players: readonly { readonly id: number; readonly kills: number; readonly deaths: number; readonly money: number }[];
  readonly finalHash: string;
}

export type FromShooterWorker =
  | { readonly type: 'meta'; readonly meta: ShooterMeta }
  | { readonly type: 'frame'; readonly frame: ShooterFrame }
  | { readonly type: 'over'; readonly summary: ShooterSummary }
  | { readonly type: 'error'; readonly message: string };
