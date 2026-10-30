// 下注：賠率只依公開戰績（陣容的公開 Elo）計算，莊家抽成固定。
// 玩家要贏莊家，只能靠情報（真實強度與公開 Elo 的差距）。
import type { ContentPack } from './content.ts';
import { expectedPermille } from './rating.ts';
import { notify, post, publicTeamRating, teamOf } from './state.ts';
import type { Fixture, GameState } from './types.ts';

/** 主隊勝率（千分比）：對位勝率換成三對位先勝兩場的勝率 */
export function homeWinPermille(homeRating: number, awayRating: number): number {
  const ps = expectedPermille(homeRating - awayRating);
  return Math.max(20, Math.min(980, Math.round((ps * ps * (3000 - 2 * ps)) / 1e6)));
}

/** 賠率 ×100：(1 − 抽成) ÷ 勝率 */
export function oddsX100(winPermille: number, marginPermille: number): number {
  return Math.max(105, Math.round(((1000 - marginPermille) * 100) / winPermille));
}

export interface FixtureOdds {
  homeWinPermille: number;
  homeX100: number;
  awayX100: number;
}

export function fixtureOdds(state: GameState, content: ContentPack, f: Fixture): FixtureOdds {
  const p = homeWinPermille(publicTeamRating(state, f.home), publicTeamRating(state, f.away));
  const m = content.economy.betMarginPermille;
  return { homeWinPermille: p, homeX100: oddsX100(p, m), awayX100: oddsX100(1000 - p, m) };
}

export function betLimit(content: ContentPack, fame: number): number {
  return content.economy.betLimitBase + content.economy.betLimitPerFame * fame;
}

/** 開獎：贏的拿回 注額 × 賠率，平手退注，輸的不退（注額已在下注時扣除） */
export function settleBets(state: GameState): void {
  const remaining = [];
  for (const b of state.bets) {
    const f = state.fixtures.find((x) => x.id === b.fixtureId);
    if (!f || f.result === null) {
      remaining.push(b);
      continue;
    }
    const team = teamOf(state, b.teamId);
    const winner = f.result.winner;
    if (winner === null) {
      post(state, team, 'bet', b.stake, `平手退注 ${f.id}`);
      notify(state, b.teamId, 'finance', `下注 ${b.stake}：比賽打平，退回注額`);
    } else if (winner === (b.side === 'home' ? f.home : f.away)) {
      const payout = Math.floor((b.stake * b.oddsX100) / 100);
      post(state, team, 'bet', payout, `押中 ${f.id}`);
      notify(state, b.teamId, 'finance', `下注 ${b.stake} 押中，賠率 ${(b.oddsX100 / 100).toFixed(2)}，入帳 ${payout}`);
    } else {
      notify(state, b.teamId, 'finance', `下注 ${b.stake} 沒押中`);
    }
  }
  state.bets = remaining;
}
