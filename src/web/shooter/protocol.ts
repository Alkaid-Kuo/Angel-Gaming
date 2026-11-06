// CS 射擊可玩版：主執行緒與引擎 Worker 之間的訊息格式。
// 公平原則：玩家模式下 Worker 只送觀察資料（ShooterObservation）與計分板的公開資訊，主執行緒不持有引擎；
// 只有開局勾選「觀戰模式」才另送引擎全狀態快照（FullState）。
// 經營層觀戰（watch）：用存檔的請求單、經 src/shooter/gateway.ts 的 gatewayDriverOptions 建驅動重跑那一場，畫面同觀戰模式。
import type { CoachCall, CoachEvent, CoachPlan, MatchOutcome, MatchRequest } from '../../manage/gateway.ts';
import type { CoachStop } from '../../shooter/live-coach.ts';
import type { ShooterReplay } from '../../shooter/runner.ts';
import type { GrenadeInfo, MapInfo, RoundEndReason, RulesInfo, ShooterCommand, ShooterObservation, SoundEvent, Team, WeaponInfo, WeaponId, GrenadeId } from '../../shooter/api.ts';

/** 一隊 Bot 的等級：基準 Bot 的版本 1～5（陪練 Bot 已從試玩拿掉，只留給測試與情境當對手） */
export type BotLevel = { readonly kind: 'baseline'; readonly version: 1 | 2 | 3 | 4 | 5 };

/** 試玩的兩隊等級。team：人類那一隊的隊友、enemy：對手；觀戰模式 team 是 T 側（0～4）、enemy 是 CT 側（5～9） */
export interface Lineup {
  readonly team: BotLevel;
  readonly enemy: BotLevel;
}

export interface ShooterSetup {
  /** 玩家開局的陣營（T = playerId 0、CT = playerId 5；半場換邊後陣營互換） */
  readonly team: Team;
  readonly seed: number;
  /** 觀戰模式：不參賽，10 隻 Bot 互打，畫面讀引擎全狀態 */
  readonly spectate: boolean;
  /** 沒帶＝兩邊基準 v3 */
  readonly lineup?: Lineup;
  /** 地圖（試玩頁選；沒給用預設地圖） */
  readonly mapId?: string;
  /** 除錯用（只有網址 ?auto=…&loadout=awp 會帶）：雙方開局主武器 */
  readonly loadout?: WeaponId;
}

/** 經營層觀戰的顯示資訊（Worker 原樣放回 meta.watch） */
export interface WatchInfo {
  /** 依組別：0＝請求單 A（主隊、上半場 T）、1＝B */
  readonly teams: readonly [string, string];
  /** 依 playerId：角色與版本（例如「突破 v3」） */
  readonly tags: readonly string[];
  /** 我方是哪一組（別隊的比賽＝null）：天使金外框依此上色 */
  readonly mine: 0 | 1 | null;
  /** 依 playerId：立繪代號（舊票沒有這欄，頭像改依名字挑） */
  readonly portraits?: readonly string[];
}

export interface WatchSetup extends WatchInfo {
  readonly request: MatchRequest;
  /** 依 playerId 的選手名（A 名單 0～4、B 名單 5～9） */
  readonly names: readonly string[];
}

/** 教練模式（M5 第四批 4b）：戰術清單（面板用）、我方是哪一方、有沒有請助理教練 */
export interface CoachInfo {
  readonly side: 'a' | 'b';
  readonly assistant: boolean;
  readonly tactics: readonly { readonly id: string; readonly name: string; readonly side: Team }[];
}

export interface CoachSetup extends WatchSetup {
  readonly coach: CoachInfo;
}

/** 教練模式的狀態列（剩幾次暫停、暫停已排定、打到第幾回合、是不是已離席） */
export interface CoachStatus {
  readonly round: number;
  readonly timeoutsLeft: number;
  readonly pending: boolean;
  readonly left: boolean;
}

export type ToShooterWorker =
  /** 經營層教練身分即時看我方比賽（M5 第四批 4b） */
  | { readonly type: 'coach'; readonly coach: CoachSetup }
  /** 教練：按暫停（本回合照打，下一回合開始前停）／取消 */
  | { readonly type: 'coachPause'; readonly on: boolean }
  /** 教練：停下時下完指令、繼續 */
  | { readonly type: 'coachResolve'; readonly plan: CoachPlan | null; readonly call: CoachCall | null }
  /** 教練：離席（轉一般觀戰），之後不能再下指令 */
  | { readonly type: 'coachLeave' }
  | { readonly type: 'start'; readonly setup: ShooterSetup }
  /** 經營層觀戰：重跑一場打完的比賽 */
  | { readonly type: 'watch'; readonly watch: WatchSetup }
  /** 觀戰：以最高速推進到下一回合開始（凍結時間），中間不送畫面 */
  | { readonly type: 'skipRound' }
  /** 觀戰：回到第 round 回合的凍結開始（同設定同種子重跑，確定性；往後跳直接推進） */
  | { readonly type: 'seek'; readonly round: number }
  /** 比賽結束後要回放（下載用；比賽中不給） */
  | { readonly type: 'getReplay' }
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
  /** 開鏡的移動速度（座標單位／tick）：開局資料 WeaponInfo 沒有這欄，Worker 從規則表補上給商店顯示 */
  readonly scopedSpeeds?: Readonly<Partial<Record<WeaponId, number>>>;
  /** 經營層觀戰才有 */
  readonly watch?: WatchInfo;
  /** 教練身分即時看才有（不能透視：沒有全狀態，畫面是己方視野聯集） */
  readonly coach?: CoachInfo;
  /** 試玩有選等級才有（「再來一場」沿用） */
  readonly lineup?: Lineup;
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
  /** 模型兵的姿勢（畫面用） */
  readonly crouching?: boolean;
  readonly working?: boolean;
  /** 觀戰的選手列表用 */
  readonly armor?: number;
  readonly kit?: boolean;
  readonly money?: number;
  readonly primary?: WeaponId | null;
  readonly secondary?: WeaponId | null;
  readonly grenades?: readonly GrenadeId[];
  readonly ammoMag?: number;
  readonly ammoReserve?: number;
  readonly reloading?: boolean;
  readonly plantTicks?: number;
  readonly defuseTicks?: number;
}

/** 一顆子彈（全狀態：不管誰看得見） */
export interface FullShot {
  readonly tick: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface FullState {
  readonly players: readonly FullPlayer[];
  /** 上一個 frame 之後新開的子彈（全圖與自由鏡頭畫） */
  readonly shots?: readonly FullShot[];
  readonly smokes: readonly { readonly x: number; readonly y: number; readonly radius: number }[];
  readonly fires: readonly { readonly x: number; readonly y: number; readonly radius: number; readonly cells: readonly number[] }[];
  readonly projectiles: readonly { readonly kind: GrenadeId; readonly x: number; readonly y: number }[];
  readonly items: readonly { readonly kind: 'weapon' | 'bomb' | 'kit'; readonly weapon: WeaponId | null; readonly x: number; readonly y: number }[];
  readonly bomb: { readonly state: string; readonly x: number; readonly y: number; readonly ticksLeft: number | null; readonly site?: 'A' | 'B' | null; readonly carrier?: number };
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
  /** 跳回合時略過的回合結果（畫面沒看到它們的結束 frame，回合紀錄靠這個補） */
  readonly skipped?: readonly { readonly number: number; readonly winner: Team; readonly winnerGroup: 0 | 1; readonly reason: RoundEndReason }[];
  /** 跳回合後的第一個 frame：tick 可能倒退，主執行緒的逐幀狀態要清掉；skipped 是到這一刻為止打完的全部回合 */
  readonly rewound?: boolean;
}

export interface ShooterSummary {
  /** 勝方組別（0 = 上半場 T 的那一組）；平手為 null */
  readonly winnerGroup: 0 | 1 | null;
  /** 依組別（0 = 上半場 T） */
  readonly score: readonly [number, number];
  readonly rounds: readonly { readonly number: number; readonly winner: Team; readonly winnerGroup: 0 | 1; readonly reason: string }[];
  readonly players: readonly { readonly id: number; readonly kills: number; readonly deaths: number; readonly money: number }[];
  /** 打了幾段加時（v1.0） */
  readonly overtimes: number;
  readonly finalHash: string;
  /** 經營層觀戰才有：照閘道的換算得到的成績單（與存檔的成績單對照） */
  readonly outcome?: MatchOutcome;
}

/** 下載的回放：頂層多一欄依 playerId 的等級（「你」「基準 v3」）；重播用不到 */
export type TrialReplay = ShooterReplay & { readonly lineup?: readonly string[] };

export type FromShooterWorker =
  | { readonly type: 'meta'; readonly meta: ShooterMeta }
  | { readonly type: 'frame'; readonly frame: ShooterFrame }
  | { readonly type: 'over'; readonly summary: ShooterSummary }
  | { readonly type: 'replay'; readonly replay: TrialReplay }
  /** 跳回合進行中（重跑到第 at 回合，目標 target） */
  | { readonly type: 'seeking'; readonly at: number; readonly target: number }
  | { readonly type: 'error'; readonly message: string }
  /** 教練模式：停下來等指令 */
  | { readonly type: 'coachStop'; readonly stop: CoachStop }
  /** 教練模式：一則指令生效了（經營頁要存檔） */
  | { readonly type: 'coachCall'; readonly event: CoachEvent }
  /** 教練模式：狀態列 */
  | { readonly type: 'coachStatus'; readonly status: CoachStatus }
  /** 教練離席（打到第 round 回合），之後是一般觀戰 */
  | { readonly type: 'coachLeft'; readonly round: number };
