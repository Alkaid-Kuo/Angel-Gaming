// 對戰閘道：經營層與對戰遊戲之間唯一的縫。
//
// 契約：
// 1. 請求單只含「賽制代號、雙方選手資料、種子」；經營層不解讀賽制內容，也不寫任何與具體賽制有關的規則。
// 2. 成績單只含勝負與各回合比分（只供顯示）。
// 3. 同一張請求單永遠得到同一張成績單（確定性）；回放可由請求單重跑重現，存檔不必存回放。
// 4. 攻守與座位的公平由賽制自己處理（每方輪到各個角色），經營層不管。
// 5. 賽制自報每場回合數與估計耗時，經營層才估得出「推進一週要等多久」。
import type { Winner } from './types.ts';

export interface MatchFormat {
  readonly id: string;
  readonly name: string;
  /** 一場比賽打幾回合 */
  readonly rounds: number;
  /** 每回合估計耗時（毫秒），供估算整週模擬量 */
  readonly estMsPerRound: number;
}

/** 一方的選手資料。config 對經營層是不透明的一包資料，內容由內容包的 schema 決定。 */
export interface SideSpec {
  readonly lineageId: string;
  readonly version: number;
  readonly config: Readonly<Record<string, number | string>>;
}

export interface MatchRequest {
  readonly formatId: string;
  readonly a: SideSpec;
  readonly b: SideSpec;
  readonly seed: number;
}

export interface MatchRound {
  readonly label: string;
  readonly winner: Winner;
  readonly scoreA: number;
  readonly scoreB: number;
}

export interface MatchOutcome {
  readonly winner: Winner;
  readonly rounds: readonly MatchRound[];
}

export interface BattleGateway {
  readonly formats: readonly MatchFormat[];
  /** 批次模擬：真引擎在 Web Worker 裡跑，所以是非同步 */
  simulateBatch(requests: readonly MatchRequest[]): Promise<MatchOutcome[]>;
}
