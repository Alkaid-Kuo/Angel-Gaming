// 狀態查詢小工具與記帳。這裡的函式都不亂數、不呼叫對戰閘道。
import type { ContentPack, Lineage } from './content.ts';
import type { SideSpec } from './gateway.ts';
import type { GameState, LedgerCategory, Message, Player, PlayerId, Team, TeamId } from './types.ts';

export function findPlayer(state: GameState, id: PlayerId): Player | undefined {
  return state.players.find((p) => p.id === id);
}

export function playerOf(state: GameState, id: PlayerId): Player {
  const p = findPlayer(state, id);
  if (!p) throw new Error(`找不到選手 ${id}`);
  return p;
}

export function teamOf(state: GameState, id: TeamId): Team {
  const t = state.teams.find((x) => x.id === id);
  if (!t) throw new Error(`找不到戰隊 ${id}`);
  return t;
}

export function humanTeam(state: GameState): Team {
  return teamOf(state, state.humanTeamId);
}

export function rosterOf(state: GameState, teamId: TeamId): Player[] {
  return state.players.filter((p) => p.teamId === teamId);
}

export function freeAgents(state: GameState): Player[] {
  return state.players.filter((p) => p.teamId === null);
}

export function lineageOf(content: ContentPack, id: string): Lineage {
  const l = content.lineages.find((x) => x.id === id);
  if (!l) throw new Error(`未知流派 ${id}`);
  return l;
}

export function maxVersion(content: ContentPack, lineageId: string): number {
  return lineageOf(content, lineageId).power.length;
}

/** 公開先驗：只看版本號給的初始 Elo（所有流派相同），真實強度要靠戰績或情報才看得出差別 */
export function publicPrior(version: number): number {
  return 1450 + 40 * (version - 1);
}

/** 真實強度（隱藏）。只給情報報告與內容層使用，畫面與 NPC 不可讀。 */
export function truePower(content: ContentPack, p: Player): number {
  const l = lineageOf(content, p.lineageId);
  return l.power[Math.min(p.version, l.power.length) - 1] + p.habit;
}

export function salaryForVersion(content: ContentPack, version: number): number {
  const e = content.economy;
  let s = e.salaryBase;
  for (let i = 1; i < version; i++) s = Math.round((s * e.salaryGrowthPct) / 100);
  return s;
}

/** 公開戰隊評分：陣容裡 Elo 最高的 lineupSize 人平均 */
export function publicTeamRating(state: GameState, content: ContentPack, teamId: TeamId): number {
  const elos = rosterOf(state, teamId)
    .map((p) => p.elo)
    .sort((a, b) => b - a)
    .slice(0, content.lineupSize);
  if (elos.length === 0) return 0;
  return Math.round(elos.reduce((s, x) => s + x, 0) / elos.length);
}

export function weeklySalaries(state: GameState, teamId: TeamId): number {
  return rosterOf(state, teamId).reduce((s, p) => s + p.weeklySalary, 0);
}

export function weeklyFixedCost(state: GameState, content: ContentPack, team: Team): number {
  return weeklySalaries(state, team.id) + content.economy.facilityMaintenance[team.trainingLevel - 1];
}

export function weeklySponsor(content: ContentPack, team: Team): number {
  return team.fame * content.economy.sponsorPerFame;
}

/** 本週練習賽／研發還能排幾場 */
export function capacityLeft(state: GameState, content: ContentPack, team: Team): number {
  const used = state.jobs.reduce((s, j) => (j.teamId === team.id && j.kind !== 'scout' ? s + j.games : s), 0);
  return content.economy.scrimCapacity[team.trainingLevel - 1] - used;
}

/** 出賽名單是否有效：人數＝lineupSize、不重複、都是自己的人 */
export function lineupValid(state: GameState, content: ContentPack, team: Team): boolean {
  const l = team.lineup;
  if (l.length !== content.lineupSize || new Set(l).size !== content.lineupSize) return false;
  return l.every((id) => findPlayer(state, id)?.teamId === team.id);
}

/** 實際會出賽的名單：存檔裡的名單有效就用它，否則是公開 Elo 最高的 lineupSize 人（不改存檔） */
export function effectiveLineup(state: GameState, content: ContentPack, team: Team): PlayerId[] {
  if (lineupValid(state, content, team)) return [...team.lineup];
  return rosterOf(state, team.id)
    .sort((a, b) => b.elo - a.elo || (a.id < b.id ? -1 : 1))
    .slice(0, content.lineupSize)
    .map((p) => p.id);
}

/**
 * 組出送給對戰閘道的一方名單。每人的 config 是「習慣」與「本場可用的戰術預設加成」：
 * 泛用預設一律可用；針對某流派的預設在對方名單裡有任何人是該流派時可用；取最高的一個。
 */
export function buildSide(players: readonly Player[], opponents: readonly Player[]): SideSpec {
  const foes = new Set(opponents.map((o) => o.lineageId));
  return {
    players: players.map((p) => {
      let best = 0;
      for (const pr of p.presets) {
        if (pr.version !== p.version) continue;
        if (pr.target === 'generic' || foes.has(pr.target)) best = Math.max(best, pr.bonus);
      }
      return { lineageId: p.lineageId, version: p.version, config: { habit: p.habit, presetBonus: best } };
    }),
  };
}

/** 記帳：所有資金進出都走這裡，team.cash ＝ 起始資金 ＋ 帳本總和 */
export function post(state: GameState, team: Team, category: LedgerCategory, amount: number, memo: string): void {
  team.cash += amount;
  team.ledger.push({ week: state.week, category, amount, memo });
}

/** 只有玩家的戰隊會收到收件匣訊息 */
export function notify(state: GameState, teamId: TeamId, kind: Message['kind'], text: string): void {
  if (teamId === state.humanTeamId) state.inbox.push({ week: state.week, kind, text });
}
