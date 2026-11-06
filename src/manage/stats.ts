// 個人統計（M5 第三批）：賽季累計、評分（Rating）、MVP。統計由閘道算好放在成績單（MatchOutcome.players），經營層只存、只累計、只顯示；
// 評分只給畫面用，不進任何規則（賠率、強度、成長都不看它）。
// 球探對戰隊報告（5.3）也在這裡：由已打比賽的回合戰術標籤整理。
import type { ContentPack } from './content.ts';
import type { PlayerStat } from './gateway.ts';
import type { GameState, SeasonStat, TacticTally, TeamId, TeamIntelReport } from './types.ts';

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

/** 球探對戰隊看幾場（M5 5.3） */
export const TEAM_SCOUT_GAMES = 3;
/** 每個陣營列幾個常用戰術 */
export const TEAM_SCOUT_TOP = 3;

/**
 * 球探對戰隊報告（M5 5.3）：targetId 最近 TEAM_SCOUT_GAMES 場已打比賽（週次新到舊；同週以賽程順序）的回合戰術標籤，
 * 依陣營（內容包的 side）各取次數最多的前 TEAM_SCOUT_TOP 個（同數依內容包順序）。只整理公開事實，不讀熟練度與計畫。
 */
export function teamTacticReport(state: GameState, content: ContentPack, targetId: TeamId): TeamIntelReport {
  const sideOf = new Map(content.tactics.map((t, i) => [t.id, { side: t.side, i }]));
  const played = state.fixtures.filter((f) => f.result !== null && (f.home === targetId || f.away === targetId));
  const recent = played.map((f, i) => ({ f, i })).sort((x, y) => y.f.week - x.f.week || y.i - x.i).slice(0, TEAM_SCOUT_GAMES).map((x) => x.f);
  const tally = new Map<string, TacticTally>();
  const rounds = { T: 0, CT: 0 };
  for (const f of recent) {
    const side = f.home === targetId ? 'a' : 'b';
    for (const r of (f.result as NonNullable<typeof f.result>).rounds) {
      const t = r.tactics?.[side];
      const spec = t === undefined || t === null ? undefined : sideOf.get(t);
      if (spec === undefined) continue;
      rounds[spec.side] += 1;
      const rec = tally.get(t as string) ?? { tactic: t as string, played: 0, won: 0 };
      rec.played += 1;
      if (r.winner === side) rec.won += 1;
      tally.set(rec.tactic, rec);
    }
  }
  const top = (side: 'T' | 'CT'): TacticTally[] =>
    [...tally.values()]
      .filter((x) => sideOf.get(x.tactic)?.side === side)
      .sort((a, b) => b.played - a.played || (sideOf.get(a.tactic)?.i ?? 0) - (sideOf.get(b.tactic)?.i ?? 0))
      .slice(0, TEAM_SCOUT_TOP);
  return { teamId: targetId, week: state.week, weeks: recent.map((f) => f.week), rounds, top: { T: top('T'), CT: top('CT') } };
}
