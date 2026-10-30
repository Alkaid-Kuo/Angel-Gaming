// M4 經營層：狀態與指令型別。
// 狀態是純 JSON（可直接存檔）：不放函式、Map、Date。標「隱藏」的欄位屬於真實層，不可經 view.ts 以外的路徑給畫面或 NPC。
import type { MatchRequest } from './gateway.ts';

export const SAVE_VERSION = 3;
/** 例行賽週數（8 隊單循環） */
export const REGULAR_WEEKS = 7;
/** 賽段總週數＝例行賽 7 週＋季後賽 2 週（第 8 週準決賽、第 9 週決賽與季軍戰） */
export const TOTAL_WEEKS = 9;

export type TeamId = string;
export type PlayerId = string;
export type FixtureId = string;

export type Persona = 'whale' | 'youth' | 'data' | 'miser';
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

/** 戰術預設（練習賽研發的產出） */
export interface Preset {
  id: string;
  /** 'generic'＝泛用；否則為針對的流派代號 */
  target: string;
  /** 建立時選手的版本；升版後失效 */
  version: number;
  /** 隱藏：真實加成 */
  bonus: number;
  /** 公開：研發報告上顯示的估計值（帶誤差） */
  reportedBonus: number;
}

export interface Player {
  id: PlayerId;
  name: string;
  lineageId: string;
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
  presets: Preset[];
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
}

export interface RoundResult {
  label: string;
  winner: Winner;
  scoreA: number;
  scoreB: number;
  /** 賽段標籤（閘道給的，只供顯示） */
  phase?: string;
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
  | { kind: 'research'; id: number; teamId: TeamId; playerId: PlayerId; target: string; games: number }
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
  | { type: 'queueResearch'; playerId: PlayerId; target: string; games: number }
  | { type: 'scout'; playerId: PlayerId };

export type CommandResult = { ok: true } | { ok: false; reason: string };
