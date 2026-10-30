// 對戰閘道：經營層與對戰遊戲之間唯一的縫。
//
// 契約：
// 1. 請求單只含「賽制代號、雙方出賽名單、種子」；經營層不解讀賽制內容，也不寫任何與具體賽制有關的規則。
// 2. 成績單只含勝負與各回合累計比分（只供顯示）。
// 3. 同一張請求單永遠得到同一張成績單（確定性）；回放可由請求單重跑重現：存檔保存每場送出的請求單（FixtureResult.request），不存回放。
// 4. 攻守與座位的公平由賽制自己處理（每方輪到各個角色），經營層不管。
// 5. 賽制自報每場回合數、估計耗時與名單人數，經營層才估得出「推進一週要等多久」、開局時才查得出內容包配不配。
// 6. 賽制自報能不能觀戰（watchable）；經營層不解讀，只透傳給畫面決定要不要放「觀戰」。
import type { Winner } from './types.ts';

export interface MatchFormat {
  readonly id: string;
  readonly name: string;
  /** 一場比賽大約打幾回合 */
  readonly rounds: number;
  /** 每回合估計耗時（毫秒），供估算整週模擬量 */
  readonly estMsPerRound: number;
  /** 每方出賽名單人數；內容包的 lineupSize 必須相同 */
  readonly lineupSize: number;
  /** 打完的比賽能不能用請求單重播觀戰（真引擎 true、假比賽 false） */
  readonly watchable: boolean;
}

/** 一位出賽選手。config 對經營層是不透明的一包資料，內容由內容包的 schema 決定。 */
export interface PlayerSpec {
  readonly lineageId: string;
  readonly version: number;
  readonly config: Readonly<Record<string, number | string>>;
}

/** 一方的出賽名單：順序＝出賽名單順序＝隊內序號 */
export interface SideSpec {
  readonly players: readonly PlayerSpec[];
}

export interface MatchRequest {
  readonly formatId: string;
  readonly a: SideSpec;
  readonly b: SideSpec;
  readonly seed: number;
}

/** 一回合；scoreA／scoreB 是打完這回合後的累計比分 */
export interface MatchRound {
  readonly label: string;
  readonly winner: Winner;
  readonly scoreA: number;
  readonly scoreB: number;
  /** 賽段標籤（例如「上半場」「下半場」「加時 1」）；有給時畫面在標籤改變處畫分隔，經營層不解讀 */
  readonly phase?: string;
}

export interface MatchOutcome {
  readonly winner: Winner;
  readonly rounds: readonly MatchRound[];
}

export interface BattleGateway {
  readonly formats: readonly MatchFormat[];
  /** 批次模擬：真引擎在 Web Worker 裡跑，所以是非同步。onProgress：每完成一場回報一次（已完成、總數） */
  simulateBatch(requests: readonly MatchRequest[], onProgress?: (done: number, total: number) => void): Promise<MatchOutcome[]>;
}

/** 最終比分（最後一回合的累計比分；沒有回合＝0:0） */
export function finalScore(out: MatchOutcome): { a: number; b: number } {
  const last = out.rounds[out.rounds.length - 1];
  return last ? { a: last.scoreA, b: last.scoreB } : { a: 0, b: 0 };
}

/** 內容包與閘道是否配得起來：賽制存在、名單人數相同。不符時丟例外（拒絕開局／推進）。 */
export function assertFormat(gateway: BattleGateway, formatId: string, lineupSize: number): MatchFormat {
  const f = gateway.formats.find((x) => x.id === formatId);
  if (!f) throw new Error(`閘道沒有賽制 ${formatId}`);
  if (f.lineupSize !== lineupSize) throw new Error(`賽制 ${formatId} 每方 ${f.lineupSize} 人，內容包是 ${lineupSize} 人`);
  return f;
}
