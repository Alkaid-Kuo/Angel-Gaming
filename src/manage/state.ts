// 狀態查詢小工具與記帳。這裡的函式都不亂數、不呼叫對戰閘道。
import type { ContentPack, Lineage, RaritySpec } from './content.ts';
import type { SideSpec } from './gateway.ts';
import type { GamePlan, GameState, LedgerCategory, Message, Player, PlayerId, Rarity, Team, TeamId } from './types.ts';

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

export function raritySpec(content: ContentPack, id: Rarity): RaritySpec {
  const r = content.rarities.find((x) => x.id === id);
  if (!r) throw new Error(`未知品階 ${id}`);
  return r;
}

/** 選手個人版本上限：品階上限與流派上限取小 */
export function playerMaxVersion(content: ContentPack, p: Player): number {
  return Math.min(raritySpec(content, p.rarity).maxVersion, maxVersion(content, p.lineageId));
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

/** 本週練習賽／排練還能排幾格（練習賽一場一格、排練一節一格） */
export function capacityLeft(state: GameState, content: ContentPack, team: Team): number {
  const used = state.jobs.reduce((s, j) => (j.teamId !== team.id ? s : j.kind === 'scrim' ? s + j.games : j.kind === 'rehearse' ? s + j.sessions : s), 0);
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

/** 熟練度的存法：0～100、小數一位 */
export function proficiency(v: number): number {
  return Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
}

/** 遞減式成長：cur += gain × (1 − cur/100)（M5 規格 3.3） */
export function grow(cur: number, gain: number): number {
  return proficiency(cur + gain * (1 - cur / 100));
}

/** 執行熟練度（M5 規格 3.3）：round(0.5 × 隊伍默契 ＋ 0.5 × 出賽名單個人熟練度平均) */
export function effectiveTactics(content: ContentPack, team: Team, lineup: readonly Player[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of content.tactics) {
    const avg = lineup.length === 0 ? 0 : lineup.reduce((s, p) => s + (p.tactics[t.id] ?? 0), 0) / lineup.length;
    out[t.id] = Math.round(0.5 * (team.playbook[t.id] ?? 0) + 0.5 * avg);
  }
  return out;
}

/** 預設比賽計畫：每個戰術 0、經濟標準 */
export function defaultGamePlan(content: ContentPack): GamePlan {
  return { pref: Object.fromEntries(content.tactics.map((t) => [t.id, 0])), economy: 0 };
}

/**
 * 組出送給對戰閘道的一方名單。每人的 config 是「習慣」＋個人熟練度 p_<戰術>（整數）；
 * 內容包有戰術手冊時，team 帶執行熟練度 q_<戰術>、比賽計畫 pref_<戰術> 與 economy（閘道轉成開局資料與教練指令）。
 */
export function buildSide(content: ContentPack, team: Team, players: readonly Player[]): SideSpec {
  const side: SideSpec = {
    players: players.map((p) => {
      const config: Record<string, number> = { habit: p.habit };
      for (const t of content.tactics) config[`p_${t.id}`] = Math.round(p.tactics[t.id] ?? 0);
      return { lineageId: p.lineageId, version: p.version, config };
    }),
  };
  if (content.tactics.length === 0) return side;
  const eff = effectiveTactics(content, team, players);
  const bag: Record<string, number> = { economy: team.gamePlan.economy };
  for (const t of content.tactics) {
    bag[`q_${t.id}`] = eff[t.id];
    bag[`pref_${t.id}`] = team.gamePlan.pref[t.id] ?? 0;
  }
  return { ...side, team: bag };
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
