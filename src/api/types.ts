// 選手 API 的公開型別：開局資料、輔助工具、觀察資料、指令、事件。
// 選手（bots）只依賴本檔；引擎內部型別不對外。
import type { BuildingStats, BuildingType, MatchMode, RejectReason, Stance, TargetClass, UnitStats, UnitType } from '../config/index.ts';

export type { BuildingType, MatchMode, RejectReason, Stance, UnitType } from '../config/index.ts';

// ───────── 宣告與旋鈕 ─────────

export interface KnobDef {
  /** 代碼（同一流派所有版本保持一致） */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  /** true = 整數；false = 小數 */
  readonly integer: boolean;
}

export interface BotDeclaration {
  /** 流派名稱 */
  readonly name: string;
  /** 版本（例如 v1；選填） */
  readonly version?: string;
  /** 風格描述 */
  readonly style: string;
  readonly knobs: readonly KnobDef[];
}

export type KnobValues = Readonly<Record<string, number>>;

// ───────── 開局資料與輔助工具 ─────────

export type MineAreaKind = 'main' | 'expansion' | 'rich';

export interface InitMineNode {
  readonly id: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly rich: boolean;
  readonly areaId: number;
  readonly reserve: number;
}

export interface InitMineArea {
  readonly areaId: number;
  readonly kind: MineAreaKind;
  /** 所屬起點的 playerId；中立礦區為 null */
  readonly owner: number | null;
}

export interface InitStartSlot {
  readonly playerId: number;
  /** 主堡左上角格 */
  readonly tileX: number;
  readonly tileY: number;
}

export interface InitWatchtower {
  readonly id: number;
  /** 單位座標 */
  readonly x: number;
  readonly y: number;
}

export interface GameStats {
  readonly units: Readonly<Record<UnitType, UnitStats>>;
  readonly buildings: Readonly<Record<BuildingType, BuildingStats>>;
  /** 兵種倍率（攻擊方 → 目標類別，整數百分比；null = 不可攻擊） */
  readonly multipliers: Readonly<Record<UnitType | 'tower', Readonly<Record<TargetClass, number | null>>>>;
}

export interface InitData {
  readonly mode: MatchMode;
  readonly width: number;
  readonly height: number;
  /** 地形陣列，長度 width × height，索引 = tileY × width + tileX；0 平地、1 阻擋、2 樹林 */
  readonly tiles: readonly number[];
  readonly mineNodes: readonly InitMineNode[];
  readonly mineAreas: readonly InitMineArea[];
  readonly startSlots: readonly InitStartSlot[];
  readonly watchtowers: readonly InitWatchtower[];
  readonly me: number;
  readonly players: readonly number[];
  readonly stats: GameStats;
  readonly matchSeed: number;
  /** 開局時的旋鈕值（規格補充：開局規劃也需要旋鈕） */
  readonly knobs: KnobValues;
}

export interface Helpers {
  /** 依尋路規則計算的路徑長度（單位），只考慮地形與目前已知建築；不可達回傳 -1。參數為格座標。 */
  pathDistance(fromTileX: number, fromTileY: number, toTileX: number, toTileY: number): number;
  /** 依地形與目前已知資訊（礦點、已知建築、已探索區域）判斷可否放置 */
  canPlace(building: BuildingType, tileX: number, tileY: number): boolean;
  /** 地形代碼（0 平地、1 阻擋、2 樹林）；超出地圖回傳 1 */
  terrainAt(tileX: number, tileY: number): number;
  /** 以 matchSeed 與 playerId 初始化的確定性亂數，回傳 [0, 1)；選手唯一可用的亂數來源 */
  random(): number;
}

// ───────── 觀察資料 ─────────

export type UnitOrderView =
  | { readonly type: 'idle' }
  | { readonly type: 'move'; readonly x: number; readonly y: number }
  | { readonly type: 'attackMove'; readonly x: number; readonly y: number }
  | { readonly type: 'attack'; readonly targetId: number }
  | { readonly type: 'gather'; readonly nodeId: number }
  | { readonly type: 'build'; readonly building: BuildingType; readonly tileX: number; readonly tileY: number }
  | { readonly type: 'construct'; readonly buildingId: number };

export interface MyUnitView {
  readonly id: number;
  readonly type: UnitType;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly stance: Stance;
  /** 編隊代號 0～9；無則 null */
  readonly group: number | null;
  readonly order: UnitOrderView;
  /** 攜帶的礦量 */
  readonly carrying: number;
  /** 正在採的礦點 id；無則 null */
  readonly gatherNodeId: number | null;
}

export interface QueueItemView {
  readonly unit: UnitType;
  /** 生產進度（0～100，%） */
  readonly progress: number;
}

export interface MyBuildingView {
  readonly id: number;
  readonly type: BuildingType;
  readonly tileX: number;
  readonly tileY: number;
  readonly hp: number;
  readonly complete: boolean;
  /** 建造進度（0～100，%） */
  readonly progress: number;
  readonly queue: readonly QueueItemView[];
  readonly rally: { readonly x: number; readonly y: number } | null;
}

export interface EnemyUnitView {
  readonly id: number;
  readonly owner: number;
  readonly type: UnitType;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
}

export interface EnemyBuildingView {
  readonly id: number;
  readonly owner: number;
  readonly type: BuildingType;
  readonly tileX: number;
  readonly tileY: number;
  readonly hp: number;
  readonly complete: boolean;
  readonly progress: number;
}

export interface RememberedBuildingView extends EnemyBuildingView {
  readonly lastSeenTick: number;
}

export interface MineNodeView {
  readonly id: number;
  /** 可見時為目前儲量，不可見時為最後已知值 */
  readonly reserve: number;
}

export interface WatchtowerView {
  readonly id: number;
  /** 瞭望塔位置目前是否可見 */
  readonly visible: boolean;
  /** 佔領者（可見時才有意義；不可見時為 null） */
  readonly owner: number | null;
  /** 自己的佔領進度（0～100） */
  readonly myProgress: number;
}

export interface Observation {
  readonly tick: number;
  readonly minerals: number;
  readonly supplyUsed: number;
  readonly supplyCap: number;
  readonly myUnits: readonly MyUnitView[];
  readonly myBuildings: readonly MyBuildingView[];
  readonly enemyUnits: readonly EnemyUnitView[];
  readonly enemyBuildings: readonly EnemyBuildingView[];
  readonly rememberedBuildings: readonly RememberedBuildingView[];
  readonly mineNodes: readonly MineNodeView[];
  readonly watchtowers: readonly WatchtowerView[];
  readonly alivePlayers: readonly number[];
  readonly events: readonly GameEvent[];
  readonly knobs: KnobValues;
  readonly commandBudget: number;
}

// ───────── 事件 ─────────

export type GameEvent =
  | { readonly type: 'underAttack'; readonly tick: number; readonly targetId: number; readonly attackerId: number | null }
  | { readonly type: 'unitDied'; readonly tick: number; readonly id: number; readonly unitType: UnitType }
  | { readonly type: 'buildingDestroyed'; readonly tick: number; readonly id: number; readonly buildingType: BuildingType }
  | { readonly type: 'enemyKilled'; readonly tick: number; readonly id: number; readonly owner: number; readonly kind: 'unit' | 'building'; readonly entityType: UnitType | BuildingType }
  | { readonly type: 'buildingComplete'; readonly tick: number; readonly id: number; readonly buildingType: BuildingType }
  | { readonly type: 'unitTrained'; readonly tick: number; readonly id: number; readonly unitType: UnitType }
  | { readonly type: 'nodeDepleted'; readonly tick: number; readonly nodeId: number; readonly areaId: number }
  | { readonly type: 'towerChanged'; readonly tick: number; readonly towerId: number; readonly owner: number | null }
  | { readonly type: 'playerEliminated'; readonly tick: number; readonly playerId: number }
  | { readonly type: 'commandRejected'; readonly tick: number; readonly index: number; readonly reason: RejectReason }
  /** 規格補充（決策 Q5A）：工人抵達後開工失敗 */
  | { readonly type: 'buildFailed'; readonly tick: number; readonly workerId: number; readonly building: BuildingType; readonly tileX: number; readonly tileY: number; readonly reason: 'NO_MINERALS' | 'BAD_PLACEMENT' };

// ───────── 指令 ─────────

/** 單位 id 陣列，或編隊代號 0～9 */
export type UnitSet = readonly number[] | number;

export type Command =
  | { readonly type: 'gather'; readonly units: UnitSet; readonly nodeId: number }
  | { readonly type: 'build'; readonly workerId: number; readonly building: BuildingType; readonly tileX: number; readonly tileY: number }
  | { readonly type: 'resume'; readonly workerId: number; readonly buildingId: number }
  | { readonly type: 'train'; readonly buildingId: number; readonly unit: UnitType }
  | { readonly type: 'cancel'; readonly buildingId: number }
  | { readonly type: 'rally'; readonly buildingId: number; readonly x: number; readonly y: number }
  | { readonly type: 'move'; readonly units: UnitSet; readonly x: number; readonly y: number }
  | { readonly type: 'attackMove'; readonly units: UnitSet; readonly x: number; readonly y: number }
  | { readonly type: 'attack'; readonly units: UnitSet; readonly targetId: number }
  | { readonly type: 'hold'; readonly units: UnitSet }
  | { readonly type: 'stance'; readonly units: UnitSet; readonly stance: Stance }
  | { readonly type: 'group'; readonly group: number; readonly units: readonly number[] };

// ───────── 選手 ─────────

export interface Bot {
  declare(): BotDeclaration;
  init(data: InitData, helpers: Helpers): void;
  decide(obs: Observation): Command[];
}
