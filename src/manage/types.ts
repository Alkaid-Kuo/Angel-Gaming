// M4 經營層：狀態與指令型別。
// 狀態是純 JSON（可直接存檔）：不放函式、Map、Date。標「隱藏」的欄位屬於真實層，不可經 view.ts 以外的路徑給畫面或 NPC。
import type { MatchRequest, PlayerStat } from './gateway.ts';

export const SAVE_VERSION = 7;
/** 例行賽週數（8 隊單循環） */
export const REGULAR_WEEKS = 7;
/** 賽段總週數＝例行賽 7 週＋季後賽 2 週（第 8 週準決賽、第 9 週決賽與季軍戰） */
export const TOTAL_WEEKS = 9;

export type TeamId = string;
export type PlayerId = string;
export type FixtureId = string;

export type Persona = 'whale' | 'youth' | 'data' | 'miser';
/** 選手品階：只決定版本上限，不影響薪資與當下強度（數值在內容包的 rarities） */
export type Rarity = 'N' | 'R' | 'SR' | 'SSR';
export type Phase = 'offseason' | 'season' | 'ended' | 'bankrupt';
export type Stage = 'regular' | 'semi' | 'third' | 'final';
export type Side = 'home' | 'away';
export type Winner = 'a' | 'b' | 'draw';

export type LedgerCategory = 'prize' | 'sponsor' | 'bet' | 'salary' | 'facility' | 'signing' | 'scout' | 'training' | 'bailout';

export interface LedgerEntry {
  week: number;
  category: LedgerCategory;
  amount: number;
  memo: string;
}

/** 戰術代號（內容包 tactics[].id；M5） */
export type TacticId = string;

/** 比賽計畫（M5）：Bot 自己選戰術時的權重；暫停（第四批）可改 */
export interface GamePlan {
  /** 每個戰術的偏好：-1 禁用、0 不偏好、1～3 星（內容包的每個戰術都有一筆） */
  pref: Record<TacticId, number>;
  /** 經濟風格：0 標準、1 保守、2 積極 */
  economy: 0 | 1 | 2;
}

export interface Player {
  id: PlayerId;
  name: string;
  lineageId: string;
  /** 公開：品階，開局決定、之後不變 */
  rarity: Rarity;
  /** 公開：立繪代號（例 SR_007，清單在 portraits.ts），開局從同品階的池不重複發 */
  portraitId: string;
  version: number;
  /** 隱藏：個人習慣，對真實強度的小偏移 */
  habit: number;
  /** 公開：戰績 Elo */
  elo: number;
  games: number;
  /** 單位：千元／週 */
  weeklySalary: number;
  /** null＝自由選手 */
  teamId: TeamId | null;
  /** 剩餘賽季（M4 固定 1，留給 M5 的合約續約） */
  contractSeasons: number;
  upgradeUntilWeek: number | null;
  /** 個人戰術熟練度（M5；0～100，存到小數一位）：跟著選手走，轉會帶走。自己的選手公開，別隊隱藏 */
  tactics: Record<TacticId, number>;
  /** 新面孔（M5）：簽約時設 true，第一次為本隊出賽後清掉；出賽名單有新面孔的那場開打前，隊伍默契打折 */
  newFace: boolean;
  /** 公開：本季個人統計累計（M5 第三批；一個存檔一季，不必換季歸零） */
  season: SeasonStat;
}

/** 賽季累計的個人統計：PlayerStat 各欄加總＋場數 */
export interface SeasonStat {
  games: number;
  kills: number;
  deaths: number;
  damage: number;
  firstKills: number;
  firstDeaths: number;
  survived: number;
  plants: number;
  defuses: number;
  clutches: number;
  rounds: number;
}

/** 一個戰術本季打了幾回合、贏了幾回合 */
export interface TacticRecord {
  played: number;
  won: number;
}

export interface IntelReport {
  playerId: PlayerId;
  week: number;
  estPower: number;
  sd: number;
}

/** 練習賽報告：雙方當週的出賽名單隊對隊 */
export interface ScrimReport {
  week: number;
  opponentTeamId: TeamId;
  games: number;
  wins: number;
}

export interface Team {
  id: TeamId;
  name: string;
  human: boolean;
  persona: Persona | null;
  /** 單位：千元 */
  cash: number;
  fame: number;
  trainingLevel: number;
  /** 出賽名單（依隊內序號，人數＝內容包的 lineupSize）；空或無效時開賽前自動補 */
  lineup: PlayerId[];
  ledger: LedgerEntry[];
  intel: IntelReport[];
  scrims: ScrimReport[];
  /** 隊伍默契（M5；0～100，存到小數一位）：自己公開、別隊隱藏 */
  playbook: Record<TacticId, number>;
  /** 賽前比賽計畫（M5）：自己公開、別隊隱藏 */
  gamePlan: GamePlan;
  /** 本季戰術紀錄（M5 第三批）：由我方回合戰術標籤累計；自己公開、別隊隱藏 */
  tacticLog: Record<TacticId, TacticRecord>;
}

export interface RoundResult {
  label: string;
  winner: Winner;
  scoreA: number;
  scoreB: number;
  /** 賽段標籤（閘道給的，只供顯示） */
  phase?: string;
  /** 雙方本回合打的戰術（M5；a＝主隊）；隱藏：對方的那一半不進別隊的已知層 */
  tactics?: { a: string | null; b: string | null };
}

/** 一場戰隊賽（名單對名單一場比賽）。A＝主隊、B＝客隊 */
export interface FixtureResult {
  lineupA: PlayerId[];
  lineupB: PlayerId[];
  /** null＝平手 */
  winner: TeamId | null;
  /** 最終比分 */
  scoreA: number;
  scoreB: number;
  /** 逐回合（累計比分，只供顯示） */
  rounds: RoundResult[];
  /** 公開：雙方個人統計 [A 名單, B 名單]（各依名單順序；閘道沒給統計、或第 7 版以前打的比賽＝沒有） */
  stats?: [PlayerStat[], PlayerStat[]];
  /** 隱藏：當時送出的請求單原樣（雙方 PlayerSpec 快照＋種子＋賽制）；觀戰回放由它重跑，含習慣與預設加成，不進已知層視圖 */
  request: MatchRequest;
}

export interface Fixture {
  id: FixtureId;
  week: number;
  stage: Stage;
  home: TeamId;
  away: TeamId;
  result: FixtureResult | null;
}

export interface Bet {
  id: number;
  teamId: TeamId;
  fixtureId: FixtureId;
  side: Side;
  stake: number;
  /** 賠率 ×100，下注時鎖定 */
  oddsX100: number;
  week: number;
}

export type Job =
  | { kind: 'scrim'; id: number; teamId: TeamId; opponentTeamId: TeamId; games: number }
  | { kind: 'rehearse'; id: number; teamId: TeamId; tactic: TacticId; sessions: number }
  | { kind: 'scout'; id: number; teamId: TeamId; playerId: PlayerId };

export interface Message {
  week: number;
  kind: 'result' | 'finance' | 'report' | 'system';
  text: string;
}

export interface SeasonResult {
  /** 最終名次（第 1 名在前） */
  ranks: TeamId[];
  humanRank: number;
}

export interface GameState {
  version: number;
  contentId: string;
  formatId: string;
  /** 主種子：每場比賽與每次隨機都由（主種子, 週, 序號）導出，讀檔重來結果不變 */
  seed: number;
  /** 0＝休賽期；1～TOTAL_WEEKS 為賽程週 */
  week: number;
  phase: Phase;
  teams: Team[];
  players: Player[];
  fixtures: Fixture[];
  bets: Bet[];
  jobs: Job[];
  inbox: Message[];
  nextId: number;
  humanTeamId: TeamId;
  seasonResult: SeasonResult | null;
}

export type Command =
  | { type: 'sign'; playerId: PlayerId }
  | { type: 'release'; playerId: PlayerId }
  | { type: 'setLineup'; lineup: PlayerId[] }
  | { type: 'upgradeTraining' }
  | { type: 'upgradeVersion'; playerId: PlayerId }
  | { type: 'bet'; fixtureId: FixtureId; side: Side; stake: number }
  | { type: 'queueScrim'; opponentTeamId: TeamId; games: number }
  | { type: 'queueRehearse'; tactic: TacticId; sessions: number }
  | { type: 'setGamePlan'; plan: GamePlan }
  | { type: 'scout'; playerId: PlayerId };

export type CommandResult = { ok: true } | { ok: false; reason: string };
