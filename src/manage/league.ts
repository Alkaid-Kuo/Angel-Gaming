// 聯賽：賽程、積分榜、季後賽。
import type { Fixture, GameState, Stage, TeamId } from './types.ts';
import { REGULAR_WEEKS } from './types.ts';

/** 圓桌法單循環賽程（隊數需為偶數）：回傳每一輪的 [主, 客] 配對 */
export function roundRobin(ids: readonly string[]): [string, string][][] {
  const n = ids.length;
  if (n < 2 || n % 2 !== 0) throw new Error('roundRobin：隊數需為偶數');
  const arr = [...ids];
  const rounds: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop() as string);
  }
  return rounds;
}

export interface StandingRow {
  teamId: TeamId;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  /** 對位勝場差 */
  slotDiff: number;
}

/** 例行賽積分榜（勝 3、平 1、敗 0；同分比對位勝場差、勝場、隊伍代號） */
export function standings(state: GameState): StandingRow[] {
  const rows = new Map<TeamId, StandingRow>();
  for (const t of state.teams) rows.set(t.id, { teamId: t.id, played: 0, wins: 0, draws: 0, losses: 0, points: 0, slotDiff: 0 });
  for (const f of state.fixtures) {
    if (f.stage !== 'regular' || f.result === null) continue;
    const h = rows.get(f.home) as StandingRow;
    const a = rows.get(f.away) as StandingRow;
    h.played++;
    a.played++;
    h.slotDiff += f.result.homeWins - f.result.awayWins;
    a.slotDiff += f.result.awayWins - f.result.homeWins;
    if (f.result.winner === null) {
      h.draws++;
      a.draws++;
      h.points += 1;
      a.points += 1;
    } else {
      const win = f.result.winner === f.home ? h : a;
      const lose = win === h ? a : h;
      win.wins++;
      win.points += 3;
      lose.losses++;
    }
  }
  return [...rows.values()].sort((x, y) => y.points - x.points || y.slotDiff - x.slotDiff || y.wins - x.wins || (x.teamId < y.teamId ? -1 : 1));
}

function newFixture(state: GameState, week: number, stage: Stage, home: TeamId, away: TeamId): Fixture {
  const f: Fixture = { id: `f${state.nextId++}`, week, stage, home, away, result: null };
  state.fixtures.push(f);
  return f;
}

export function createRegularSeason(state: GameState): void {
  const rounds = roundRobin(state.teams.map((t) => t.id));
  rounds.forEach((pairs, r) => {
    for (const [h, a] of pairs) newFixture(state, r + 1, 'regular', h, a);
  });
}

/** 比賽打平時由例行賽名次較高者晉級（M4 的暫代賽制不會平手，真引擎可能會） */
export function playoffWinner(state: GameState, f: Fixture): TeamId {
  if (f.result === null) throw new Error('賽事尚未打完');
  if (f.result.winner !== null) return f.result.winner;
  const order = standings(state).map((r) => r.teamId);
  return order.indexOf(f.home) < order.indexOf(f.away) ? f.home : f.away;
}

function playoffLoser(state: GameState, f: Fixture): TeamId {
  return playoffWinner(state, f) === f.home ? f.away : f.home;
}

/** 例行賽結束後：前 4 名打準決賽（1v4、2v3） */
export function createSemis(state: GameState): void {
  const top = standings(state).map((r) => r.teamId);
  newFixture(state, REGULAR_WEEKS + 1, 'semi', top[0], top[3]);
  newFixture(state, REGULAR_WEEKS + 1, 'semi', top[1], top[2]);
}

/** 準決賽結束後：勝者爭冠、敗者爭季軍 */
export function createFinals(state: GameState): void {
  const semis = state.fixtures.filter((f) => f.stage === 'semi');
  newFixture(state, REGULAR_WEEKS + 2, 'final', playoffWinner(state, semis[0]), playoffWinner(state, semis[1]));
  newFixture(state, REGULAR_WEEKS + 2, 'third', playoffLoser(state, semis[0]), playoffLoser(state, semis[1]));
}

/** 最終名次：決賽勝負、季軍戰勝負，其餘依例行賽名次 */
export function finalRanks(state: GameState): TeamId[] {
  const final = state.fixtures.find((f) => f.stage === 'final') as Fixture;
  const third = state.fixtures.find((f) => f.stage === 'third') as Fixture;
  const top4 = [playoffWinner(state, final), playoffLoser(state, final), playoffWinner(state, third), playoffLoser(state, third)];
  const rest = standings(state)
    .map((r) => r.teamId)
    .filter((id) => !top4.includes(id));
  return [...top4, ...rest];
}
