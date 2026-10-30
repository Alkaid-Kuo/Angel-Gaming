// 資訊分層的「已知層」：畫面、NPC、自動玩家只能讀這裡產生的視圖。
// 真實層（隱藏的習慣、戰術預設的真實加成、流派真實強度）不會出現在視圖裡；
// 玩家要知道，只能靠公開戰績、花錢買的情報、練習賽樣本。
import { fixtureOdds } from './betting.ts';
import type { ContentPack } from './content.ts';
import type { StandingRow } from './league.ts';
import { standings } from './league.ts';
import { capacityLeft, rosterOf, teamOf, weeklyFixedCost, weeklySponsor } from './state.ts';
import type { Bet, FixtureId, GameState, IntelReport, Job, LedgerEntry, Message, Phase, PlayerId, ScrimReport, SeasonResult, Stage, TeamId, Winner } from './types.ts';
import { TOTAL_WEEKS } from './types.ts';

export interface KnownPlayer {
  id: PlayerId;
  name: string;
  lineageId: string;
  version: number;
  elo: number;
  games: number;
  weeklySalary: number;
  teamId: TeamId | null;
  upgrading: boolean;
}

export interface KnownFixture {
  id: FixtureId;
  week: number;
  stage: Stage;
  home: TeamId;
  away: TeamId;
  /** 最終比分，打完才有 */
  score: { home: number; away: number } | null;
  /** 比賽內容（公開戰績）：雙方出賽名單、勝方（null＝平手）、逐回合累計比分（a＝主隊）；打完才有 */
  match: {
    home: PlayerId[];
    away: PlayerId[];
    winner: TeamId | null;
    rounds: { label: string; winner: Winner; home: number; away: number }[];
  } | null;
}

export interface KnownPreset {
  playerId: PlayerId;
  id: string;
  target: string;
  /** 研發報告上的估計值（帶誤差） */
  reportedBonus: number;
  valid: boolean;
}

export interface KnownView {
  week: number;
  totalWeeks: number;
  phase: Phase;
  me: {
    teamId: TeamId;
    name: string;
    cash: number;
    fame: number;
    trainingLevel: number;
    lineup: PlayerId[];
    roster: PlayerId[];
    capacityLeft: number;
    weeklyFixedCost: number;
    weeklySponsor: number;
    /** 現金還撐得幾週（固定支出 − 贊助 ≤ 0 時為 null＝不燒錢） */
    runwayWeeks: number | null;
  };
  players: KnownPlayer[];
  teams: { id: TeamId; name: string; fame: number; roster: PlayerId[] }[];
  fixtures: KnownFixture[];
  /** 本週尚未開打的賽事賠率 */
  odds: { fixtureId: FixtureId; homeX100: number; awayX100: number }[];
  standings: StandingRow[];
  intel: IntelReport[];
  scrims: ScrimReport[];
  presets: KnownPreset[];
  bets: Bet[];
  jobs: Job[];
  /** 我方帳本與收件匣（玩家的戰隊才有收件匣） */
  ledger: LedgerEntry[];
  inbox: Message[];
  seasonResult: SeasonResult | null;
}

export function knownView(state: GameState, content: ContentPack, teamId: TeamId): KnownView {
  const team = teamOf(state, teamId);
  const fixed = weeklyFixedCost(state, content, team);
  const sponsor = weeklySponsor(content, team);
  const burn = fixed - sponsor;
  const mine = rosterOf(state, teamId);
  return {
    week: state.week,
    totalWeeks: TOTAL_WEEKS,
    phase: state.phase,
    me: {
      teamId,
      name: team.name,
      cash: team.cash,
      fame: team.fame,
      trainingLevel: team.trainingLevel,
      lineup: [...team.lineup],
      roster: mine.map((p) => p.id),
      capacityLeft: capacityLeft(state, content, team),
      weeklyFixedCost: fixed,
      weeklySponsor: sponsor,
      runwayWeeks: burn <= 0 ? null : Math.max(0, Math.floor(team.cash / burn)),
    },
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      lineageId: p.lineageId,
      version: p.version,
      elo: p.elo,
      games: p.games,
      weeklySalary: p.weeklySalary,
      teamId: p.teamId,
      upgrading: p.upgradeUntilWeek !== null,
    })),
    teams: state.teams.map((t) => ({ id: t.id, name: t.name, fame: t.fame, roster: rosterOf(state, t.id).map((p) => p.id) })),
    fixtures: state.fixtures.map((f) => ({
      id: f.id,
      week: f.week,
      stage: f.stage,
      home: f.home,
      away: f.away,
      score: f.result ? { home: f.result.scoreA, away: f.result.scoreB } : null,
      match: f.result
        ? {
            home: [...f.result.lineupA],
            away: [...f.result.lineupB],
            winner: f.result.winner,
            rounds: f.result.rounds.map((r) => ({ label: r.label, winner: r.winner, home: r.scoreA, away: r.scoreB })),
          }
        : null,
    })),
    odds: state.fixtures
      .filter((f) => f.week === state.week && f.result === null)
      .map((f) => {
        const o = fixtureOdds(state, content, f);
        return { fixtureId: f.id, homeX100: o.homeX100, awayX100: o.awayX100 };
      }),
    standings: standings(state),
    intel: team.intel.map((i) => ({ ...i })),
    scrims: team.scrims.map((s) => ({ ...s })),
    presets: mine.flatMap((p) =>
      p.presets.map((pr) => ({ playerId: p.id, id: pr.id, target: pr.target, reportedBonus: pr.reportedBonus, valid: pr.version === p.version })),
    ),
    bets: state.bets.filter((b) => b.teamId === teamId).map((b) => ({ ...b })),
    jobs: state.jobs.filter((j) => j.teamId === teamId).map((j) => ({ ...j })),
    ledger: team.ledger.map((e) => ({ ...e })),
    inbox: teamId === state.humanTeamId ? state.inbox.map((m) => ({ ...m })) : [],
    seasonResult: state.seasonResult ? { ranks: [...state.seasonResult.ranks], humanRank: state.seasonResult.humanRank } : null,
  };
}
