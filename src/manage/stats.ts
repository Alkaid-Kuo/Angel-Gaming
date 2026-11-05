// 個人統計（M5 第三批）：賽季累計、評分（Rating）、MVP。統計由閘道算好放在成績單（MatchOutcome.players），經營層只存、只累計、只顯示；
// 評分只給畫面用，不進任何規則（賠率、強度、成長都不看它）。
import type { PlayerStat } from './gateway.ts';
import type { SeasonStat } from './types.ts';

const KEYS = ['kills', 'deaths', 'damage', 'firstKills', 'firstDeaths', 'survived', 'plants', 'defuses', 'clutches', 'rounds'] as const;

export function emptySeason(): SeasonStat {
  return { games: 0, kills: 0, deaths: 0, damage: 0, firstKills: 0, firstDeaths: 0, survived: 0, plants: 0, defuses: 0, clutches: 0, rounds: 0 };
}

/** 一場的統計加進賽季累計（場數 +1） */
export function addMatch(season: SeasonStat, s: PlayerStat): void {
  season.games += 1;
  for (const k of KEYS) season[k] += s[k];
}

/**
 * 評分（規格 5.2，平衡初值）：0.4 × KPR／0.68 ＋ 0.3 × (1 − DPR)／0.32 ＋ 0.2 × ADR／75 ＋ 0.1 × 首殺差。
 * 首殺差＝(首殺 − 首死)／回合 ÷ 0.1（每回合十人只有一個首殺，平均每人約 0.1）；平均水準約 0.9。沒有回合＝0。取到小數兩位。
 */
export function ratingOf(s: Pick<PlayerStat, 'kills' | 'deaths' | 'damage' | 'firstKills' | 'firstDeaths' | 'rounds'>): number {
  if (s.rounds <= 0) return 0;
  const kpr = s.kills / s.rounds;
  const dpr = s.deaths / s.rounds;
  const adr = s.damage / s.rounds;
  const fk = (s.firstKills - s.firstDeaths) / s.rounds / 0.1;
  return Math.round((0.4 * (kpr / 0.68) + 0.3 * ((1 - dpr) / 0.32) + 0.2 * (adr / 75) + 0.1 * fk) * 100) / 100;
}

/** 一隊這場的 MVP：評分最高的那位（同分取名單前面的）；沒有統計＝−1 */
export function mvpIndex(stats: readonly PlayerStat[]): number {
  let best = -1;
  let score = -Infinity;
  stats.forEach((s, i) => {
    const r = ratingOf(s);
    if (r > score) {
      score = r;
      best = i;
    }
  });
  return best;
}
