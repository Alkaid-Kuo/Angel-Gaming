// 資訊分層的「已知層」：畫面、NPC、自動玩家只能讀這裡產生的視圖。
// 真實層（隱藏的習慣、流派真實強度、別隊的戰術手冊）不會出現在視圖裡；
// 玩家要知道，只能靠公開戰績、花錢買的情報、練習賽樣本。
import { fixtureOdds } from './betting.ts';
import type { ContentPack } from './content.ts';
import type { MatchFormat } from './gateway.ts';
import type { StandingRow } from './league.ts';
import { standings } from './league.ts';
import { capacityLeft, effectiveLineup, effectiveTactics, playerMaxVersion, playerOf, rosterOf, teamOf, weeklyFixedCost, weeklySponsor } from './state.ts';
import type { Bet, FixtureId, GamePlan, GameState, IntelReport, Job, LedgerEntry, Message, Phase, PlayerId, Rarity, RoundResult, ScrimReport, SeasonResult, SeasonStat, Stage, TacticRecord, TeamId, Winner } from './types.ts';
import type { PlayerStat } from './gateway.ts';
import { TOTAL_WEEKS } from './types.ts';

export interface KnownPlayer {
  id: PlayerId;
  name: string;
  lineageId: string;
  rarity: Rarity;
  /** 立繪代號（圖檔在 public/portraits/） */
  portraitId: string;
  version: number;
  /** 個人版本上限（品階與流派取小） */
  maxVersion: number;
  elo: number;
  games: number;
  weeklySalary: number;
  teamId: TeamId | null;
  upgrading: boolean;
  /** 個人戰術熟練度（M5，整數）：只有自己隊的人有 */
  tactics?: Record<string, number>;
  /** 本季個人統計（M5 第三批，公開：每個人都有） */
  season: SeasonStat;
}

export interface KnownFixture {
  id: FixtureId;
  week: number;
  stage: Stage;
  home: TeamId;
  away: TeamId;
  /** 最終比分，打完才有 */
  score: { home: number; away: number } | null;
  /** 比賽內容（公開戰績）：雙方出賽名單、勝方（null＝平手）、逐回合累計比分（a＝主隊）、能不能觀戰；打完才有 */
  match: {
    home: PlayerId[];
    away: PlayerId[];
    winner: TeamId | null;
    /** phase：閘道給的賽段標籤（上半場、加時等），沒有就不畫分隔 */
    /** tactic：我方本回合打的戰術（M5；只有我方的比賽、只給我方那一半，對方的不給） */
    rounds: { label: string; winner: Winner; home: number; away: number; phase?: string; tactic?: string | null }[];
    /** 賽制自報能觀戰（knownView 有傳賽制時才可能 true；請求單本身含隱藏資料，不放進視圖） */
    watchable: boolean;
    /** 雙方個人統計（M5 第三批，公開；各依名單順序）；沒有統計的比賽沒有這欄 */
    stats?: { home: PlayerStat[]; away: PlayerStat[] };
  } | null;
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
    /** 隊伍默契（M5，整數） */
    playbook: Record<string, number>;
    /** 執行熟練度（M5）：依目前會出賽的名單算 */
    effective: Record<string, number>;
    /** 賽前比賽計畫（M5） */
    gamePlan: GamePlan;
    /** 本季戰術紀錄（M5 第三批；只有自己隊） */
    tacticLog: Record<string, TacticRecord>;
  };
  players: KnownPlayer[];
  teams: { id: TeamId; name: string; fame: number; roster: PlayerId[] }[];
  fixtures: KnownFixture[];
  /** 本週尚未開打的賽事賠率 */
  odds: { fixtureId: FixtureId; homeX100: number; awayX100: number }[];
  standings: StandingRow[];
  intel: IntelReport[];
  scrims: ScrimReport[];
  bets: Bet[];
  jobs: Job[];
  /** 我方帳本與收件匣（玩家的戰隊才有收件匣） */
  ledger: LedgerEntry[];
  inbox: Message[];
  seasonResult: SeasonResult | null;
}

/** 回合戰術標籤只給我方那一半（對方打什麼是隱藏的） */
function ownTactic(r: RoundResult, side: 'a' | 'b' | null): { tactic?: string | null } {
  return side === null || r.tactics === undefined ? {} : { tactic: r.tactics[side] };
}

/** format：目前賽制（只拿 watchable 透傳給畫面；NPC、自動玩家不傳＝不能觀戰） */
export function knownView(state: GameState, content: ContentPack, teamId: TeamId, format?: MatchFormat): KnownView {
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
      playbook: Object.fromEntries(Object.entries(team.playbook).map(([k, v]) => [k, Math.round(v)])),
      effective: effectiveTactics(content, team, effectiveLineup(state, content, team).map((id) => playerOf(state, id))),
      gamePlan: { pref: { ...team.gamePlan.pref }, economy: team.gamePlan.economy },
      tacticLog: Object.fromEntries(Object.entries(team.tacticLog).map(([k, v]) => [k, { ...v }])),
    },
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      lineageId: p.lineageId,
      rarity: p.rarity,
      portraitId: p.portraitId,
      version: p.version,
      maxVersion: playerMaxVersion(content, p),
      elo: p.elo,
      games: p.games,
      weeklySalary: p.weeklySalary,
      teamId: p.teamId,
      upgrading: p.upgradeUntilWeek !== null,
      ...(p.teamId === teamId ? { tactics: Object.fromEntries(Object.entries(p.tactics).map(([k, v]) => [k, Math.round(v)])) } : {}),
      season: { ...p.season },
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
            rounds: f.result.rounds.map((r) => ({ label: r.label, winner: r.winner, home: r.scoreA, away: r.scoreB, ...(r.phase !== undefined ? { phase: r.phase } : {}), ...ownTactic(r, f.home === teamId ? 'a' : f.away === teamId ? 'b' : null) })),
            watchable: format?.watchable === true,
            ...(f.result.stats !== undefined ? { stats: { home: f.result.stats[0].map((s) => ({ ...s })), away: f.result.stats[1].map((s) => ({ ...s })) } } : {}),
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
    bets: state.bets.filter((b) => b.teamId === teamId).map((b) => ({ ...b })),
    jobs: state.jobs.filter((j) => j.teamId === teamId).map((j) => ({ ...j })),
    ledger: team.ledger.map((e) => ({ ...e })),
    inbox: teamId === state.humanTeamId ? state.inbox.map((m) => ({ ...m })) : [],
    seasonResult: state.seasonResult ? { ranks: [...state.seasonResult.ranks], humanRank: state.seasonResult.humanRank } : null,
  };
}
