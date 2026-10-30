// 遊戲主流程：開新局、週推進。
// 一週的順序：補出賽名單 → 比賽日（經對戰閘道）→ 開獎 → 背景工作 → 週結算 → 升版完成 → 破產檢查 → 換階段。
import { settleBets } from './betting.ts';
import { applyCommand } from './commands.ts';
import type { ContentPack } from './content.ts';
import type { BattleGateway, MatchRequest } from './gateway.ts';
import { processJobs } from './jobs.ts';
import { createFinals, createRegularSeason, createSemis, finalRanks } from './league.ts';
import { npcLineup, npcOffseason } from './npc.ts';
import { updateElo } from './rating.ts';
import { gauss, rngFor, STREAM } from './rng.ts';
import {
  buildSide,
  findPlayer,
  humanTeam,
  maxVersion,
  notify,
  playerOf,
  post,
  publicPrior,
  rosterOf,
  salaryForVersion,
  teamOf,
  weeklySalaries,
  weeklySponsor,
} from './state.ts';
import type { Command, Fixture, GameState, Persona, PlayerId, Team, TeamId } from './types.ts';
import { LINEUP_SIZE, REGULAR_WEEKS, SAVE_VERSION, TOTAL_WEEKS } from './types.ts';
import { knownView } from './view.ts';
import type { Prng } from '../shared/prng.ts';

export interface NewGameOptions {
  humanName?: string;
}

export interface AdvanceSummary {
  /** 推進前的週數 */
  week: number;
  results: { fixtureId: string; stage: Fixture['stage']; home: TeamId; away: TeamId; homeWins: number; awayWins: number }[];
}

function makePlayer(state: GameState, content: ContentPack, rng: Prng, teamId: TeamId | null, version: number): PlayerId {
  const used = new Set(state.players.map((p) => p.name));
  const pickName = (): string => content.surnames[rng.nextInt(content.surnames.length)] + content.givenNames[rng.nextInt(content.givenNames.length)];
  let name = pickName();
  while (used.has(name)) name = pickName();
  const candidates = content.lineages.filter((l) => l.power.length >= version);
  const lineage = candidates[rng.nextInt(candidates.length)];
  const habit = Math.max(-60, Math.min(60, Math.round(gauss(rng) * 25)));
  const salary = Math.max(1, Math.round((salaryForVersion(content, version) * (90 + rng.nextInt(21))) / 100));
  const id = `p${state.nextId++}`;
  state.players.push({
    id,
    name,
    lineageId: lineage.id,
    version,
    habit,
    elo: publicPrior(version),
    games: 0,
    weeklySalary: salary,
    teamId,
    contractSeasons: 1,
    upgradeUntilWeek: null,
    presets: [],
  });
  return id;
}

export function newGame(seed: number, content: ContentPack, opts: NewGameOptions = {}): GameState {
  const e = content.economy;
  const rng = rngFor(seed, STREAM.newGame);
  const state: GameState = {
    version: SAVE_VERSION,
    contentId: content.id,
    formatId: content.formatId,
    seed,
    week: 0,
    phase: 'offseason',
    teams: [],
    players: [],
    fixtures: [],
    bets: [],
    jobs: [],
    inbox: [],
    nextId: 1,
    humanTeamId: '',
    seasonResult: null,
  };
  const personas: Persona[] = ['whale', 'youth', 'youth', 'data', 'data', 'miser', 'miser'];
  const npcNames = rng.shuffle([...content.teamNames]);
  const humanSeat = rng.nextInt(personas.length + 1);
  let npcIndex = 0;
  for (let i = 0; i < personas.length + 1; i++) {
    const id = `t${i + 1}`;
    if (i === humanSeat) {
      state.humanTeamId = id;
      state.teams.push({
        id,
        name: opts.humanName ?? content.humanTeamName,
        human: true,
        persona: null,
        cash: e.humanStartCash,
        fame: e.startFame,
        trainingLevel: 1,
        lineup: [],
        ledger: [],
        intel: [],
        scrims: [],
      });
      for (let k = 0; k < LINEUP_SIZE; k++) makePlayer(state, content, rng, id, rng.range(e.humanVersions[0], e.humanVersions[1]));
    } else {
      const persona = personas[npcIndex];
      const spec = content.personas[persona];
      state.teams.push({
        id,
        name: npcNames[npcIndex],
        human: false,
        persona,
        cash: spec.startCash,
        fame: e.startFame,
        trainingLevel: 1,
        lineup: [],
        ledger: [],
        intel: [],
        scrims: [],
      });
      for (let k = 0; k < LINEUP_SIZE; k++) makePlayer(state, content, rng, id, rng.range(spec.versions[0], spec.versions[1]));
      npcIndex++;
    }
  }
  for (let i = 0; i < e.freeAgentCount; i++) makePlayer(state, content, rng, null, rng.range(1, 3));
  createRegularSeason(state);
  state.inbox.push({ week: 0, kind: 'system', text: `${humanTeam(state).name} 成立。休賽期：簽選手、排訓練，準備好就推進到第 1 週。` });
  return state;
}

function applyAll(state: GameState, content: ContentPack, teamId: TeamId, cmds: Command[]): void {
  for (const c of cmds) applyCommand(state, content, teamId, c);
}

function lineupValid(state: GameState, team: Team): boolean {
  const l = team.lineup;
  if (l.length !== LINEUP_SIZE || new Set(l).size !== LINEUP_SIZE) return false;
  return l.every((id) => findPlayer(state, id)?.teamId === team.id);
}

/** 開賽前補出賽名單：NPC 每週依個性重排；玩家名單無效時退回公開 Elo 最高的 3 人 */
function ensureLineups(state: GameState, content: ContentPack): void {
  for (const team of state.teams) {
    if (team.persona !== null) {
      const rng = rngFor(state.seed, STREAM.npc, state.week, Number(team.id.slice(1)));
      applyAll(state, content, team.id, npcLineup(knownView(state, content, team.id), content.personas[team.persona], rng));
    } else if (!lineupValid(state, team)) {
      const top = rosterOf(state, team.id)
        .sort((a, b) => b.elo - a.elo || (a.id < b.id ? -1 : 1))
        .slice(0, LINEUP_SIZE)
        .map((p) => p.id);
      team.lineup = top;
    }
  }
}

async function playMatchDay(state: GameState, content: ContentPack, gateway: BattleGateway, summary: AdvanceSummary): Promise<void> {
  const e = content.economy;
  const fixtures = state.fixtures.filter((f) => f.week === state.week && f.result === null);
  const reqs: MatchRequest[] = [];
  fixtures.forEach((f, fi) => {
    const h = teamOf(state, f.home).lineup;
    const a = teamOf(state, f.away).lineup;
    for (let s = 0; s < LINEUP_SIZE; s++) {
      const ph = playerOf(state, h[s]);
      const pa = playerOf(state, a[s]);
      reqs.push({ formatId: state.formatId, a: buildSide(ph, pa), b: buildSide(pa, ph), seed: rngFor(state.seed, STREAM.match, state.week, fi, s).nextU32() });
    }
  });
  const outs = await gateway.simulateBatch(reqs);
  let k = 0;
  for (const f of fixtures) {
    const home = teamOf(state, f.home);
    const away = teamOf(state, f.away);
    const slots = [];
    let hw = 0;
    let aw = 0;
    for (let s = 0; s < LINEUP_SIZE; s++) {
      const out = outs[k++];
      const ph = playerOf(state, home.lineup[s]);
      const pa = playerOf(state, away.lineup[s]);
      slots.push({ a: ph.id, b: pa.id, winner: out.winner, rounds: out.rounds.map((r) => ({ ...r })) });
      if (out.winner === 'a') hw++;
      else if (out.winner === 'b') aw++;
      [ph.elo, pa.elo] = updateElo(ph.elo, pa.elo, out.winner === 'a' ? 1000 : out.winner === 'b' ? 0 : 500, e.eloK);
      ph.games++;
      pa.games++;
    }
    const winner = hw > aw ? f.home : aw > hw ? f.away : null;
    f.result = { slots, homeWins: hw, awayWins: aw, winner };
    for (const [team, wins, loses] of [
      [home, hw, aw],
      [away, aw, hw],
    ] as const) {
      const won = wins > loses;
      const lost = wins < loses;
      const prize = (won ? e.matchWinPrize : e.matchLossPrize) + wins * e.slotWinBonus;
      post(state, team, 'prize', prize, `${f.stage === 'regular' ? '例行賽' : '季後賽'} ${wins}:${loses}`);
      team.fame = Math.max(1, team.fame + (won ? e.fameWin : lost ? -e.fameLoss : 0));
    }
    notify(state, f.home, 'result', `第 ${state.week} 週 ${home.name} ${hw}:${aw} ${away.name}`);
    notify(state, f.away, 'result', `第 ${state.week} 週 ${home.name} ${hw}:${aw} ${away.name}`);
    summary.results.push({ fixtureId: f.id, stage: f.stage, home: f.home, away: f.away, homeWins: hw, awayWins: aw });
  }
}

function weeklyFinance(state: GameState, content: ContentPack): void {
  const e = content.economy;
  for (const team of state.teams) {
    post(state, team, 'salary', -weeklySalaries(state, team.id), '週薪資');
    post(state, team, 'facility', -e.facilityMaintenance[team.trainingLevel - 1], `訓練中心 Lv${team.trainingLevel} 維護`);
    post(state, team, 'sponsor', weeklySponsor(content, team), `贊助（名氣 ${team.fame}）`);
    const net = team.ledger.filter((x) => x.week === state.week).reduce((s, x) => s + x.amount, 0);
    notify(state, team.id, 'finance', `第 ${state.week} 週結算：本週淨收支 ${net >= 0 ? '+' : ''}${net}，現金 ${team.cash}`);
  }
}

function completeUpgrades(state: GameState, content: ContentPack): void {
  const e = content.economy;
  for (const p of state.players) {
    if (p.teamId === null || p.upgradeUntilWeek === null || state.week < p.upgradeUntilWeek) continue;
    if (p.version < maxVersion(content, p.lineageId)) {
      p.version++;
      p.weeklySalary = Math.round((p.weeklySalary * e.salaryGrowthPct) / 100);
      p.presets = [];
      notify(state, p.teamId, 'report', `${p.name} 升到 v${p.version}，週薪調整為 ${p.weeklySalary}（原有戰術預設失效）`);
    }
    p.upgradeUntilWeek = null;
  }
}

/** NPC 不會破產：赤字由金主補到 0（M4 暫代） */
function bailoutNpcs(state: GameState): void {
  for (const team of state.teams) {
    if (!team.human && team.cash < 0) post(state, team, 'bailout', -team.cash, '金主補貼');
  }
}

function finishSeason(state: GameState, content: ContentPack): void {
  const e = content.economy;
  const ranks = finalRanks(state);
  ranks.forEach((id, i) => {
    const team = teamOf(state, id);
    post(state, team, 'prize', e.seasonPrizes[i], `賽段第 ${i + 1} 名獎金`);
    team.fame += e.fameRank[i];
  });
  const humanRank = ranks.indexOf(state.humanTeamId) + 1;
  state.seasonResult = { ranks, humanRank };
  bailoutNpcs(state);
  const me = humanTeam(state);
  if (me.cash < 0) {
    state.phase = 'bankrupt';
    notify(state, me.id, 'system', `賽段結束（第 ${humanRank} 名），但現金 ${me.cash} 為負：破產。`);
  } else {
    state.phase = 'ended';
    notify(state, me.id, 'system', `賽段結束：第 ${humanRank} 名，現金 ${me.cash}。`);
  }
}

export async function advance(state: GameState, content: ContentPack, gateway: BattleGateway): Promise<AdvanceSummary> {
  if (state.phase === 'ended' || state.phase === 'bankrupt') throw new Error('賽段已結束');
  const summary: AdvanceSummary = { week: state.week, results: [] };

  if (state.phase === 'offseason') {
    for (const team of state.teams) {
      if (team.persona === null) continue;
      applyAll(state, content, team.id, npcOffseason(knownView(state, content, team.id), team.persona, content.personas[team.persona], content));
    }
    await processJobs(state, content, gateway);
    state.phase = 'season';
    state.week = 1;
    notify(state, state.humanTeamId, 'system', '賽季開始：第 1 週。');
    return summary;
  }

  ensureLineups(state, content);
  await playMatchDay(state, content, gateway, summary);
  settleBets(state);
  await processJobs(state, content, gateway);
  weeklyFinance(state, content);
  completeUpgrades(state, content);
  bailoutNpcs(state);

  const w = state.week;
  if (w === TOTAL_WEEKS) {
    finishSeason(state, content);
    return summary;
  }
  const me = humanTeam(state);
  if (me.cash < 0) {
    state.phase = 'bankrupt';
    notify(state, me.id, 'system', `第 ${w} 週結算後現金 ${me.cash} 為負：破產，遊戲結束。`);
    return summary;
  }
  if (w === REGULAR_WEEKS) createSemis(state);
  else if (w === REGULAR_WEEKS + 1) createFinals(state);
  state.week = w + 1;
  return summary;
}
