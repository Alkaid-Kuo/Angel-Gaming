// 遊戲主流程：開新局、週推進。
// 一週的順序：補出賽名單 → 比賽日（經對戰閘道）→ 開獎 → 背景工作 → 週結算 → 升版完成 → 破產檢查 → 換階段。
import { settleBets } from './betting.ts';
import { applyCommand } from './commands.ts';
import type { ContentPack, RaritySpec } from './content.ts';
import type { BattleGateway, MatchOutcome, MatchRequest, PlayerStat } from './gateway.ts';
import { assertFormat, finalScore } from './gateway.ts';
import { processJobs } from './jobs.ts';
import { createFinals, createRegularSeason, createSemis, finalRanks } from './league.ts';
import { npcLineup, npcOffseason, npcPlaybook, npcTraining } from './npc.ts';
import { PORTRAITS } from './portraits.ts';
import { eloDelta } from './rating.ts';
import { gauss, rngFor, STREAM } from './rng.ts';
import {
  buildSide,
  defaultGamePlan,
  grow,
  proficiency,
  humanTeam,
  lineupValid,
  notify,
  playerOf,
  post,
  publicPrior,
  raritySpec,
  rosterOf,
  salaryForVersion,
  teamOf,
  weeklySalaries,
  weeklySponsor,
} from './state.ts';
import type { Command, Fixture, GameState, Persona, Player, PlayerId, Rarity, RoundResult, TacticRecord, Team, TeamId } from './types.ts';
import { addMatch, emptySeason } from './stats.ts';
import { attrsAt, stageOf, startCaps } from './attrs.ts';
import { REGULAR_WEEKS, SAVE_VERSION, TOTAL_WEEKS } from './types.ts';
import { knownView } from './view.ts';
import type { Prng } from '../shared/prng.ts';

export interface NewGameOptions {
  humanName?: string;
  /** 有給就在開局時檢查內容包與賽制配不配（名單人數不符拒絕開局）；推進時一律會再檢查 */
  gateway?: BattleGateway;
}

export interface AdvanceOptions {
  /** 比賽日與練習賽的模擬進度（已完成場數、總場數），由閘道回報 */
  onProgress?: (done: number, total: number) => void;
}

export interface AdvanceSummary {
  /** 推進前的週數 */
  week: number;
  results: { fixtureId: string; stage: Fixture['stage']; home: TeamId; away: TeamId; homeScore: number; awayScore: number; winner: TeamId | null }[];
}

/** 7 支 NPC 戰隊的個性 */
const NPC_PERSONAS: readonly Persona[] = ['whale', 'youth', 'youth', 'data', 'data', 'miser', 'miser'];

function assertContent(content: ContentPack): void {
  if (content.slotNames.length !== content.lineupSize) throw new Error(`內容包 ${content.id} 的出賽位名稱數與名單人數不符`);
  const e = content.economy;
  if (e.humanStartRarities.length !== content.lineupSize) throw new Error(`內容包 ${content.id} 的玩家起手品階數與名單人數不符`);
  for (const r of e.humanStartRarities) {
    if (raritySpec(content, r).capVersion < e.humanVersions[1]) throw new Error(`內容包 ${content.id} 的玩家起手版本可能超過 ${r} 階上限`);
  }
  const dup = content.handles.find((h, i) => content.handles.indexOf(h) !== i);
  if (dup !== undefined) throw new Error(`內容包 ${content.id} 的名字庫有重複：${dup}`);
  const need = (NPC_PERSONAS.length + 1) * content.lineupSize + e.freeAgentCount;
  if (content.handles.length < need) throw new Error(`內容包 ${content.id} 的名字庫只有 ${content.handles.length} 個，開局需要 ${need} 個`);
}

/**
 * 依權重抽品階：只從上限 ≥ version、而且立繪池還有剩的品階裡抽，所以開局版本範圍不受品階影響。
 * 池都還有剩時抽法與沒有立繪前完全相同（同種子同結果）；只有某階快發完的那一局才會把它排除。
 */
function pickRarity(content: ContentPack, rng: Prng, version: number, portraits: PortraitDeck): Rarity {
  const pool = content.rarities.filter((r) => r.capVersion >= version && portraitsLeft(portraits, r.id) > 0);
  const total = pool.reduce((s, r) => s + r.weight, 0);
  if (total === 0) throw new Error(`沒有品階的上限到得了 v${version}，或那些品階的立繪已經發完`);
  let roll = rng.nextInt(total);
  const hit = pool.find((r) => {
    roll -= r.weight;
    return roll < 0;
  });
  return (hit as RaritySpec).id;
}

/** 這局洗好的立繪池：每個品階一池，依序發放；reserved＝玩家起手指定品階還沒發的張數 */
type PortraitDeck = Record<Rarity, { readonly ids: readonly string[]; next: number; reserved: number }>;

/** 每個品階的立繪池各洗牌一次（rarities 順序固定，同種子同結果）；先替玩家起手的指定品階留位 */
function portraitDeck(content: ContentPack, rng: Prng): PortraitDeck {
  const deck = {} as PortraitDeck;
  for (const r of content.rarities) {
    const ids = rng.shuffle(PORTRAITS.filter((p) => p.rarity === r.id).map((p) => p.id));
    deck[r.id] = { ids, next: 0, reserved: content.economy.humanStartRarities.filter((x) => x === r.id).length };
  }
  return deck;
}

/** 隨機抽品階時還能用的張數（扣掉替玩家留的） */
function portraitsLeft(deck: PortraitDeck, rarity: Rarity): number {
  const d = deck[rarity];
  return d.ids.length - d.next - d.reserved;
}

function dealPortrait(deck: PortraitDeck, rarity: Rarity, reserved: boolean): string {
  const d = deck[rarity];
  if (reserved) d.reserved--;
  if (d.next >= d.ids.length) throw new Error(`${rarity} 階立繪只有 ${d.ids.length} 張，這局已經發完`);
  return d.ids[d.next++];
}

/** handles：這局洗好的名字庫，依序發放（第 n 位選手拿第 n 個，數量由 assertContent 保證）；portraits：同品階不重複發；rarity：不給就依權重抽 */
function makePlayer(state: GameState, content: ContentPack, rng: Prng, handles: readonly string[], portraits: PortraitDeck, teamId: TeamId | null, version: number, rarity?: Rarity): PlayerId {
  const name = handles[state.players.length];
  const picked = rarity ?? pickRarity(content, rng, version, portraits);
  const portraitId = dealPortrait(portraits, picked, rarity !== undefined);
  const candidates = content.lineages.filter((l) => l.power.length >= version);
  const lineage = candidates[rng.nextInt(candidates.length)];
  const habit = Math.max(-60, Math.min(60, Math.round(gauss(rng) * 25)));
  const salary = Math.max(1, Math.round((salaryForVersion(content, version) * (90 + rng.nextInt(21))) / 100));
  const n = state.nextId++;
  const id = `p${n}`;
  const attrs = attrsAt(content, lineage.id, version);
  state.players.push({
    id,
    name,
    lineageId: lineage.id,
    rarity: picked,
    portraitId,
    // 版本只當開局生成參數（M5 第二批）：屬性＝該版本的流派屬性，上限由品階與習慣定
    attrs,
    progress: Object.fromEntries(content.attributes.trainable.map((k) => [k, 0])),
    caps: startCaps(content, lineage.id, picked, habit, attrs),
    habit,
    elo: publicPrior(stageOf(content, lineage.id, attrs)),
    games: 0,
    weeklySalary: salary,
    teamId,
    contractSeasons: 1,
    tactics: startTactics(content, state.seed, n, lineage.id),
    newFace: false,
    season: emptySeason(),
  });
  return id;
}

/**
 * 開局個人熟練度（M5 規格 3.3）：每個戰術 10～40，角色傾向 +10，夾 0～100。
 * 用獨立串流（STREAM.tactics, 選手序號），不吃開局主序列的亂數：既有種子的名單、品階、流派、立繪不變。
 */
export function startTactics(content: ContentPack, seed: number, n: number, lineageId: string): Record<string, number> {
  const rng = rngFor(seed, STREAM.tactics, n);
  return Object.fromEntries(content.tactics.map((t) => [t.id, Math.min(100, 10 + rng.nextInt(31) + (t.affinity.includes(lineageId) ? 10 : 0))]));
}

/** 開局隊伍默契：每個戰術相同（內容包 economy.playbookStart） */
export function startPlaybook(content: ContentPack, who: Persona | 'human'): Record<string, number> {
  return Object.fromEntries(content.tactics.map((t) => [t.id, content.economy.playbookStart[who]]));
}

export function newGame(seed: number, content: ContentPack, opts: NewGameOptions = {}): GameState {
  assertContent(content);
  if (opts.gateway) assertFormat(opts.gateway, content.formatId, content.lineupSize);
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
  const npcNames = rng.shuffle([...content.teamNames]);
  const humanSeat = rng.nextInt(NPC_PERSONAS.length + 1);
  const handles = rng.shuffle([...content.handles]);
  // 立繪池用開局串流的子序列洗：不吃主序列的亂數，既有種子的開局（名單、品階、流派）不變
  const portraits = portraitDeck(content, rngFor(seed, STREAM.newGame, 1));
  let npcIndex = 0;
  for (let i = 0; i < NPC_PERSONAS.length + 1; i++) {
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
        playbook: startPlaybook(content, 'human'),
        gamePlan: defaultGamePlan(content),
        tacticLog: {},
      });
      for (let k = 0; k < content.lineupSize; k++) makePlayer(state, content, rng, handles, portraits, id, rng.range(e.humanVersions[0], e.humanVersions[1]), e.humanStartRarities[k]);
    } else {
      const persona = NPC_PERSONAS[npcIndex];
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
        playbook: startPlaybook(content, persona),
        gamePlan: defaultGamePlan(content),
        tacticLog: {},
      });
      for (let k = 0; k < content.lineupSize; k++) makePlayer(state, content, rng, handles, portraits, id, rng.range(spec.versions[0], spec.versions[1]));
      npcIndex++;
    }
  }
  for (let i = 0; i < e.freeAgentCount; i++) makePlayer(state, content, rng, handles, portraits, null, rng.range(1, 3));
  createRegularSeason(state);
  // NPC 開局先簽一輪：玩家看到的是已被挑過的市場，不能零成本把高品階自由選手撿光
  for (const team of state.teams) {
    if (team.persona === null) continue;
    applyAll(state, content, team.id, npcOffseason(knownView(state, content, team.id), team.persona, content.personas[team.persona], content));
  }
  state.inbox.push({ week: 0, kind: 'system', text: `${humanTeam(state).name} 成立。休賽期：簽選手、排訓練，準備好就推進到第 1 週。` });
  return state;
}

function applyAll(state: GameState, content: ContentPack, teamId: TeamId, cmds: Command[]): void {
  for (const c of cmds) applyCommand(state, content, teamId, c);
}

/** 開賽前補出賽名單：NPC 每週依個性重排、設比賽計畫、排練（M5）；玩家名單無效時退回公開 Elo 最高的 lineupSize 人 */
function ensureLineups(state: GameState, content: ContentPack): void {
  for (const team of state.teams) {
    if (team.persona !== null) {
      const rng = rngFor(state.seed, STREAM.npc, state.week, Number(team.id.slice(1)));
      applyAll(state, content, team.id, npcLineup(knownView(state, content, team.id), content.personas[team.persona], content.lineupSize, rng));
      applyAll(state, content, team.id, npcPlaybook(knownView(state, content, team.id), team.persona, content));
      const v = knownView(state, content, team.id);
      applyAll(state, content, team.id, npcTraining(v, team.persona, content, v.me.slotsLeft));
    } else if (!lineupValid(state, content, team)) {
      team.lineup = rosterOf(state, team.id)
        .sort((a, b) => b.elo - a.elo || (a.id < b.id ? -1 : 1))
        .slice(0, content.lineupSize)
        .map((p) => p.id);
    }
  }
}

const mean = (ps: readonly Player[]): number => ps.reduce((s, p) => s + p.elo, 0) / ps.length;

async function playMatchDay(state: GameState, content: ContentPack, gateway: BattleGateway, summary: AdvanceSummary, opts: AdvanceOptions): Promise<void> {
  const e = content.economy;
  const fixtures = state.fixtures.filter((f) => f.week === state.week && f.result === null);
  const lineups = fixtures.map((f) => [teamOf(state, f.home).lineup.map((id) => playerOf(state, id)), teamOf(state, f.away).lineup.map((id) => playerOf(state, id))] as const);
  // 新面孔第一次為本隊出賽：開打前隊伍默契打折（M5 規格 3.3）
  fixtures.forEach((f, fi) => {
    newFaceDiscount(teamOf(state, f.home), lineups[fi][0]);
    newFaceDiscount(teamOf(state, f.away), lineups[fi][1]);
  });
  const reqs: MatchRequest[] = fixtures.map((f, fi) => {
    const [h, a] = lineups[fi];
    return { formatId: state.formatId, a: buildSide(content, teamOf(state, f.home), h), b: buildSide(content, teamOf(state, f.away), a), seed: rngFor(state.seed, STREAM.match, state.week, fi).nextU32() };
  });
  const outs = await gateway.simulateBatch(reqs, opts.onProgress);
  fixtures.forEach((f, fi) => {
    const home = teamOf(state, f.home);
    const away = teamOf(state, f.away);
    const [hp, ap] = lineups[fi];
    const out = outs[fi];
    const sc = finalScore(out);
    const winner = out.winner === 'a' ? f.home : out.winner === 'b' ? f.away : null;
    const stats = splitStats(out, hp.length);
    f.result = { lineupA: hp.map((p) => p.id), lineupB: ap.map((p) => p.id), winner, scoreA: sc.a, scoreB: sc.b, rounds: out.rounds.map((r) => ({ ...r })), ...(stats !== null ? { stats } : {}), request: structuredClone(reqs[fi]) };
    if (stats !== null) {
      hp.forEach((p, i) => addMatch(p.season, stats[0][i]));
      ap.forEach((p, i) => addMatch(p.season, stats[1][i]));
    }
    logTactics(home.tacticLog, out.rounds, 'a');
    logTactics(away.tacticLog, out.rounds, 'b');
    // 名單平均 Elo 算期望值，名單內每人加同一個 delta（兩隊人數相同，總分守恆）
    const delta = eloDelta(mean(hp), mean(ap), out.winner === 'a' ? 1000 : out.winner === 'b' ? 0 : 500, e.eloK);
    for (const p of hp) {
      p.elo += delta;
      p.games++;
    }
    for (const p of ap) {
      p.elo -= delta;
      p.games++;
    }
    playbookFromMatch(content, home, hp, out.rounds, 'a');
    playbookFromMatch(content, away, ap, out.rounds, 'b');
    for (const [team, mine, theirs, won, lost] of [
      [home, sc.a, sc.b, winner === f.home, winner === f.away],
      [away, sc.b, sc.a, winner === f.away, winner === f.home],
    ] as const) {
      const prize = (won ? e.matchWinPrize : e.matchLossPrize) + mine * e.roundWinBonus;
      post(state, team, 'prize', prize, `${f.stage === 'regular' ? '例行賽' : '季後賽'} ${mine}:${theirs}`);
      team.fame = Math.max(1, team.fame + (won ? e.fameWin : lost ? -e.fameLoss : 0));
    }
    const line = `第 ${state.week} 週 ${home.name} ${sc.a}:${sc.b} ${away.name}${winner === null ? '（平手）' : ''}`;
    notify(state, f.home, 'result', line);
    notify(state, f.away, 'result', line);
    summary.results.push({ fixtureId: f.id, stage: f.stage, home: f.home, away: f.away, homeScore: sc.a, awayScore: sc.b, winner });
  });
}

/** 成績單的個人統計切成 [A 名單, B 名單]；沒有或長度不對＝null（不存、不累計） */
function splitStats(out: MatchOutcome, size: number): [PlayerStat[], PlayerStat[]] | null {
  const ps = out.players;
  if (ps === undefined || ps.length !== size * 2) return null;
  return [ps.slice(0, size).map((s) => ({ ...s })), ps.slice(size).map((s) => ({ ...s }))];
}

/** 本季戰術紀錄（M5 第三批）：我方有標籤的回合，該戰術 played +1、贏了 won +1 */
export function logTactics(log: Record<string, TacticRecord>, rounds: readonly RoundResult[] | MatchOutcome['rounds'], side: 'a' | 'b'): void {
  for (const r of rounds) {
    const t = r.tactics?.[side];
    if (t === undefined || t === null) continue;
    const rec = (log[t] ??= { played: 0, won: 0 });
    rec.played += 1;
    if (r.winner === side) rec.won += 1;
  }
}

/** 新面孔每人一次：隊伍默契各項 ×NEW_FACE_KEEP，然後清掉標記 */
export const NEW_FACE_KEEP = 0.95;
function newFaceDiscount(team: Team, lineup: readonly Player[]): void {
  for (const p of lineup) {
    if (!p.newFace) continue;
    p.newFace = false;
    for (const k of Object.keys(team.playbook)) team.playbook[k] = proficiency(team.playbook[k] * NEW_FACE_KEEP);
  }
}

/** 比賽使用（M5 規格 3.3）：每回合我方實際打的戰術，隊伍默契與出賽名單個人熟練度各 +0.5 × (1 − cur/100) */
export const MATCH_USE_GAIN = 0.5;
function playbookFromMatch(content: ContentPack, team: Team, lineup: readonly Player[], rounds: MatchOutcome['rounds'], side: 'a' | 'b'): void {
  const known = new Set(content.tactics.map((t) => t.id));
  for (const r of rounds) {
    const t = r.tactics?.[side];
    if (t === undefined || t === null || !known.has(t)) continue;
    team.playbook[t] = grow(team.playbook[t] ?? 0, MATCH_USE_GAIN);
    for (const p of lineup) p.tactics[t] = grow(p.tactics[t] ?? 0, MATCH_USE_GAIN);
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

export async function advance(state: GameState, content: ContentPack, gateway: BattleGateway, opts: AdvanceOptions = {}): Promise<AdvanceSummary> {
  if (state.phase === 'ended' || state.phase === 'bankrupt') throw new Error('賽段已結束');
  if (state.contentId !== content.id) throw new Error(`狀態的內容包 ${state.contentId} 與 ${content.id} 不符`);
  assertFormat(gateway, state.formatId, content.lineupSize);
  const summary: AdvanceSummary = { week: state.week, results: [] };

  if (state.phase === 'offseason') {
    await processJobs(state, content, gateway, opts.onProgress);
    state.phase = 'season';
    state.week = 1;
    notify(state, state.humanTeamId, 'system', '賽季開始：第 1 週。');
    return summary;
  }

  ensureLineups(state, content);
  await playMatchDay(state, content, gateway, summary, opts);
  settleBets(state);
  await processJobs(state, content, gateway, opts.onProgress);
  weeklyFinance(state, content);
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
