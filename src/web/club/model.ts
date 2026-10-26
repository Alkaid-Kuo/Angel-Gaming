// 由「已知層」視圖推導畫面要用的資料：名單、戰績、走勢、資金曲線、隊徽。只讀 KnownView。
import type { ContentPack, KnownFixture, KnownPlayer, KnownView, LedgerCategory } from '../../manage/index.ts';
import type { CrestSpec } from './art.ts';
import { npcCrest } from './art.ts';
import type { Prefs } from './prefs.ts';

export interface ClubUi {
  market: 'free' | 'teams';
  pickSlot: number | null;
  scrim: { playerId: string; opponentId: string; games: number };
  research: { playerId: string; target: string; games: number };
  slip: { fixtureId: string; side: 'home' | 'away'; stake: number } | null;
  leagueWeek: number | null;
  ledgerOpen: boolean;
}

export function newClubUi(): ClubUi {
  return {
    market: 'free',
    pickSlot: null,
    scrim: { playerId: '', opponentId: '', games: 50 },
    research: { playerId: '', target: 'generic', games: 50 },
    slip: null,
    leagueWeek: null,
    ledgerOpen: false,
  };
}

export interface Ctx {
  v: KnownView;
  c: ContentPack;
  ui: ClubUi;
  prefs: Prefs;
  pm: Map<string, KnownPlayer>;
}

export const DEFAULT_CREST: CrestSpec = { shape: 0, primary: '#3b82f6', secondary: '#d4a017', emblem: 'wings' };

export function crestOf(ctx: Ctx, teamId: string | null): CrestSpec {
  if (teamId === null) return { shape: 1, primary: '#64748b', secondary: '#e2e8f0', emblem: 'star' };
  if (teamId === ctx.v.me.teamId) return ctx.prefs.crest ?? DEFAULT_CREST;
  return npcCrest(teamName(ctx, teamId));
}

export function teamColor(ctx: Ctx, teamId: string | null): string {
  return crestOf(ctx, teamId).primary;
}

export function teamName(ctx: Ctx, teamId: string | null): string {
  if (teamId === null) return '自由球員';
  return ctx.v.teams.find((t) => t.id === teamId)?.name ?? teamId;
}

export function rosterOf(ctx: Ctx, teamId: string): KnownPlayer[] {
  const ids = ctx.v.teams.find((t) => t.id === teamId)?.roster ?? [];
  return ids.map((id) => ctx.pm.get(id) as KnownPlayer);
}

/** 目前的出賽名單；沒排或無效時是「自動」＝公開 Elo 最高的 3 人（與引擎補名單的規則相同） */
export function lineupOf(ctx: Ctx): { ids: string[]; auto: boolean } {
  const { v } = ctx;
  const mine = new Set(v.me.roster);
  if (v.me.lineup.length === 3 && new Set(v.me.lineup).size === 3 && v.me.lineup.every((id) => mine.has(id))) return { ids: [...v.me.lineup], auto: false };
  const top = rosterOf(ctx, v.me.teamId)
    .sort((a, b) => b.elo - a.elo || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((p) => p.id);
  return { ids: top, auto: true };
}

export function myFixture(v: KnownView): KnownFixture | undefined {
  return v.fixtures.find((f) => f.week === v.week && f.score === null && (f.home === v.me.teamId || f.away === v.me.teamId));
}

export function opponentOf(f: KnownFixture, me: string): string {
  return f.home === me ? f.away : f.home;
}

export function publicRating(ctx: Ctx, teamId: string): number {
  const elos = rosterOf(ctx, teamId)
    .map((p) => p.elo)
    .sort((a, b) => b - a)
    .slice(0, 3);
  return elos.length ? Math.round(elos.reduce((s, x) => s + x, 0) / elos.length) : 0;
}

export function playerRecords(v: KnownView): Map<string, { w: number; l: number }> {
  const m = new Map<string, { w: number; l: number }>();
  const add = (id: string, win: boolean): void => {
    const r = m.get(id) ?? { w: 0, l: 0 };
    if (win) r.w++;
    else r.l++;
    m.set(id, r);
  };
  for (const f of v.fixtures) {
    for (const s of f.slots) {
      if (s.winner === 'draw') continue;
      add(s.home, s.winner === 'a');
      add(s.away, s.winner === 'b');
    }
  }
  return m;
}

/** 最近幾場的勝負（W／D／L），由舊到新 */
export function teamForm(v: KnownView, teamId: string, n = 5): ('W' | 'D' | 'L')[] {
  return v.fixtures
    .filter((f) => f.score !== null && (f.home === teamId || f.away === teamId))
    .sort((a, b) => a.week - b.week)
    .slice(-n)
    .map((f) => {
      const s = f.score as { home: number; away: number };
      const mine = f.home === teamId ? s.home : s.away;
      const theirs = f.home === teamId ? s.away : s.home;
      return mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
    });
}

export function rankOf(v: KnownView, teamId: string): number {
  return v.standings.findIndex((r) => r.teamId === teamId) + 1;
}

export function startCash(v: KnownView): number {
  return v.me.cash - v.ledger.reduce((s, e) => s + e.amount, 0);
}

/** 每週結束時的現金與本週淨額（第 0 週＝休賽期） */
export function cashSeries(v: KnownView): { week: number; net: number; cash: number }[] {
  const last = v.phase === 'season' ? v.week - 1 : v.week;
  let cash = startCash(v);
  const out: { week: number; net: number; cash: number }[] = [];
  for (let w = 0; w <= Math.max(0, last); w++) {
    const net = v.ledger.filter((e) => e.week === w).reduce((s, e) => s + e.amount, 0);
    cash += net;
    out.push({ week: w, net, cash });
  }
  return out;
}

export function weekBreakdown(v: KnownView, week: number): { cat: LedgerCategory; amount: number }[] {
  const m = new Map<LedgerCategory, number>();
  for (const e of v.ledger) if (e.week === week) m.set(e.category, (m.get(e.category) ?? 0) + e.amount);
  return [...m.entries()].map(([cat, amount]) => ({ cat, amount })).filter((x) => x.amount !== 0);
}

export function maxVersionOf(c: ContentPack, lineageId: string): number {
  return c.lineages.find((l) => l.id === lineageId)?.power.length ?? 1;
}
