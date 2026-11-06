// M5 第一批驗收工具（scripts/shooter-coach-lib.ts）：
// 1. 不讀 tactics、不喊 K: 的 Bot（陪練 Bot；基準 Bot 2.8 起會讀、會喊，見下一項）跑完全部情境不崩，依賴標籤與戰術資料的判定都是「無資料」，不是 0%、也不是未過；
//    現行基準 Bot（2.8）讀戰術資料、每回合都有標籤；
// 2. 假 Bot（test/coach-stub.ts）跑通注入 → 標籤 → 統計，判定照實算出過／未過；
// 3. 驅動層 ordersOf：每回合一份、深凍結、蓋過 orders。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ShooterDeclaration, ShooterInitData, ShooterObservation, TeamOrders } from '../src/shooter/api.ts';
import { formatOptions } from '../src/shooter/gateway.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterBatchController, ShooterDriver, type CallOutcome, type ShooterController } from '../src/shooter/runner.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { BANNED, SCENARIOS, evaluate, overall, playGame, readsTactics, scenarioById, type Check, type ControllerFactory, type GameRow, type RoundRow } from '../scripts/shooter-coach-lib.ts';
import { stubFactory } from './coach-stub.ts';

const fmt = formatOptions('shooter-short');
const byId = (checks: readonly Check[], id: string): Check => {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`沒有判定 ${id}：${checks.map((x) => x.id).join('、')}`);
  return c;
};
const run = (id: string, make: ControllerFactory, seeds: readonly number[], reads: boolean | null): { games: GameRow[]; checks: Check[] } => {
  const sc = scenarioById(id);
  const games = seeds.map((s, i) => playGame(sc, s, (i % 2) as 0 | 1, make, fmt));
  return { games, checks: evaluate(sc, games, reads) };
};

describe('M5 驗收工具：不讀戰術資料的 Bot（陪練）回報無資料', () => {
  // 測試前提變更：原本用現行基準 Bot，Bot 2.8 起它會讀 tactics、喊 K:，改用同樣不讀不喊的陪練 Bot 測工具的「無資料」路徑
  const bot = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'practice');
  const make: ControllerFactory = (seed) => ({ controllers: Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(bot, 'baseline', seed, pid, MAPS.redrock(), { timeLimits: false })) });

  it('八個情境都跑完；讀戰術資料＝否；每個判定都是無資料（不是 0%、不是未過）；整體結論是無資料', () => {
    const reads = readsTactics(make, 3, fmt);
    expect(reads).toBe(false);
    const all: Check[] = [];
    for (const sc of SCENARIOS) {
      const games = [playGame(sc, 3, 0, make, fmt)];
      expect(games[0].rows.length).toBe(2 * (games[0].score[0] + games[0].score[1]));
      expect(games[0].rows.every((r) => r.tag === null)).toBe(true);
      const checks = evaluate(sc, games, reads);
      expect(checks.length).toBeGreaterThan(0);
      all.push(...checks);
    }
    for (const c of all) {
      expect(c.verdict, `${c.id}：${c.value}`).toBe('noData');
      expect(c.value.startsWith('無資料：')).toBe(true);
      expect(c.value).not.toMatch(/\d%/);
    }
    // 每個情境的專屬判定都在（不是被略過）
    const ids = new Set(all.map((c) => c.id));
    for (const id of ['coverage', 'diversity', 'star3', 'ecoDefault', 'effSkewT', 'effSkewCT', 'ban', 'call', 'strength']) expect(ids.has(id), id).toBe(true);
    const o = overall(all);
    expect(o.verdict).toBe('noData');
    expect(o.text).toContain('無資料');
  }, 180_000);
});

describe('M5 驗收工具：現行基準 Bot（2.8）', () => {
  const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
  const make: ControllerFactory = (seed) => ({ controllers: Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(bot, 'baseline', seed, pid, MAPS.redrock(), { timeLimits: false })) });

  it('讀戰術資料＝是；每回合兩方都有戰術標籤', () => {
    expect(readsTactics(make, 3, fmt)).toBe(true);
    const g = playGame(scenarioById('plan0'), 3, 0, make, fmt);
    expect(g.rows.length).toBe(2 * (g.score[0] + g.score[1]));
    expect(g.rows.every((r) => r.tag !== null)).toBe(true);
  }, 120_000);
});

describe('M5 驗收工具：判定規則（合成資料）', () => {
  const row = (p: Partial<RoundRow>): RoundRow => ({ round: 1, group: 0, setup: 'a', side: 'T', tag: null, buy: null, fullBuy: true, call: null, won: false, ...p });
  const game = (rows: RoundRow[], winner: GameRow['winner'] = null): GameRow => ({ seed: 1, aGroup: 0, winner, score: [0, 0], finalHash: '', rows });

  it('沒有任何標籤：覆蓋率是無資料，不是 0%', () => {
    const c = evaluate(scenarioById('null'), [game([row({}), row({ group: 1, setup: 'b', side: 'CT' })])], null);
    expect(byId(c, 'coverage').verdict).toBe('noData');
  });

  it('有標籤但不夠：覆蓋率照實算成未過', () => {
    const rows = [row({ tag: 'rushA' }), row({ group: 1, setup: 'b', side: 'CT' })];
    const c = byId(evaluate(scenarioById('null'), [game(rows)], null), 'coverage');
    expect(c.verdict).toBe('fail');
    expect(c.value).toContain('50.0%');
  });

  it('有標籤、但 Bot 不讀戰術資料（reads＝false）：依賴戰術資料的判定是無資料，覆蓋率照算', () => {
    const rows = [row({ tag: 'rushA' }), row({ group: 1, setup: 'b', side: 'CT', tag: 'ct212' })];
    const c = evaluate(scenarioById('ban'), [game(rows)], false);
    expect(byId(c, 'coverage').verdict).toBe('pass');
    expect(byId(c, 'ban').verdict).toBe('noData');
    expect(overall(c).verdict).toBe('noData');
  });

  it('強度：Bot 不讀戰術資料時是無資料，即使勝率剛好落在窗口內', () => {
    const g = (w: GameRow['winner']): GameRow => game([row({ tag: 'rushA' })], w);
    const games = [...Array.from({ length: 58 }, () => g('a')), ...Array.from({ length: 42 }, () => g('b'))];
    expect(byId(evaluate(scenarioById('strength'), games, false), 'strength').verdict).toBe('noData');
    const ok = byId(evaluate(scenarioById('strength'), games, true), 'strength');
    expect(ok.verdict).toBe('pass');
    expect(ok.value).toContain('58.0%');
  });

  it('命令回合沒喊標籤算不符；陣營不對的標籤算不合法', () => {
    const rows = [row({ round: 1, call: 'rushB', tag: 'rushB' }), row({ round: 2, call: 'fake', tag: null }), row({ round: 3, side: 'CT', call: 'stackB', tag: 'rushA' })];
    const c = evaluate(scenarioById('call'), [game(rows)], true);
    expect(byId(c, 'call').verdict).toBe('fail');
    expect(byId(c, 'call').value).toContain('1/3');
    expect(byId(c, 'validTags').verdict).toBe('fail');
  });
});

describe('M5 驗收工具：假 Bot 跑通注入 → 標籤 → 統計', () => {
  const make = stubFactory;

  it('假 Bot 讀戰術資料（給不給打出來不同）', () => {
    expect(readsTactics(make, 5, fmt)).toBe(true);
  });

  it('null 情境：覆蓋率 100%', () => {
    const { checks } = run('null', make, [1, 2], null);
    expect(byId(checks, 'coverage').verdict).toBe('pass');
    expect(byId(checks, 'coverage').value).toContain('100.0%');
  });

  it('call：命令（含禁用的戰術）一律照打，標籤 100% 等於命令', () => {
    const { games, checks } = run('call', make, [1, 2, 3], true);
    const c = byId(checks, 'call');
    expect(c.verdict).toBe('pass');
    expect(c.n).toBe(games.reduce((s, g) => s + g.rows.length, 0));
    expect(games.flatMap((g) => g.rows).some((r) => BANNED.includes(r.call as string))).toBe(true);
  });

  it('ban：禁用的戰術 0%；star3：Rush B 100%；ecoDefault：eco 回合不打 Default', () => {
    expect(byId(run('ban', make, [1, 2], true).checks, 'ban').verdict).toBe('pass');
    const s = byId(run('star3', make, [1, 2], true).checks, 'star3');
    expect(s.verdict).toBe('pass');
    expect(s.value).toContain('100.0%');
    expect(byId(run('ecoDefault', make, [1, 2], true).checks, 'ecoDefault').verdict).toBe('pass');
  });

  it('effSkew、plan0：假 Bot 永遠取最熟／清單第一個，判定照實算成未過（證明統計會抓到）', () => {
    const skew = run('effSkew', make, [1, 2], true).checks;
    expect(byId(skew, 'effSkewT').verdict).toBe('fail');
    expect(byId(skew, 'effSkewT').value).toContain('∞');
    expect(byId(run('plan0', make, [1, 2], true).checks, 'diversity').verdict).toBe('fail');
  });

  it('強度：80 對 20 的熟練度依座位送到兩邊（a 方換組也跟著走），勝率照算', () => {
    const seen: number[][] = [];
    const spy: ControllerFactory = (seed) => {
      const made = make();
      const orig = made.controllers.map((c) => c.init.bind(c));
      made.controllers.forEach((c, pid) => {
        c.init = (d: ShooterInitData): CallOutcome<null> => {
          (seen[seed] ??= [])[pid] = d.tactics?.team.rushA ?? -1;
          return orig[pid](d);
        };
      });
      return made;
    };
    const { checks } = run('strength', spy, [1, 2], true);
    expect(seen[1]).toEqual([80, 80, 80, 80, 80, 20, 20, 20, 20, 20]);
    expect(seen[2]).toEqual([20, 20, 20, 20, 20, 80, 80, 80, 80, 80]);
    const c = byId(checks, 'strength');
    expect(c.verdict).not.toBe('noData');
    expect(c.value).toContain('50.0%');
  });
});

describe('驅動層 ordersOf（量測用）', () => {
  class Probe implements ShooterController {
    readonly label = 'p';
    readonly declaration: ShooterDeclaration = { name: 'p', version: '', style: 'probe', knobs: [] };
    seen: { round: number; team: string; coach: TeamOrders | null }[] = [];
    init(): CallOutcome<null> {
      return { value: null, exception: null, timedOut: false, elapsedMs: 0 };
    }
    decide(obs: ShooterObservation): CallOutcome<unknown> {
      this.seen.push({ round: obs.round.number, team: obs.me.team, coach: obs.coach });
      return { value: [], exception: null, timedOut: false, elapsedMs: 0 };
    }
  }

  it('每組每回合取一次（依回合與陣營）、整回合同一個深凍結物件、蓋過 orders', () => {
    const probes = Array.from({ length: PLAYER_COUNT }, () => new Probe());
    const asked: string[] = [];
    const static0: TeamOrders = { pref: {}, economy: 0, call: null };
    const d = new ShooterDriver({
      seed: 4,
      mapId: 'redrock',
      ...fmt,
      controllers: probes,
      record: false,
      orders: [static0, static0],
      ordersOf: (round, g, side) => {
        asked.push(`${round}:${g}:${side}`);
        return g === 0 ? { pref: { rushA: 3 }, economy: 2, call: { tactic: side === 'T' ? 'rushB' : 'stackA', buy: null } } : null;
      },
    });
    while (!d.match.over) d.step();
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.length).toBe(4);
    for (const p of probes.slice(0, 5)) {
      for (const s of p.seen) expect(s.coach?.call?.tactic).toBe(s.team === 'T' ? 'rushB' : 'stackA');
      const r1 = p.seen.filter((s) => s.round === 1);
      expect(r1.every((s) => s.coach === r1[0].coach)).toBe(true);
      expect(Object.isFrozen(r1[0].coach?.call)).toBe(true);
    }
    for (const p of probes.slice(5)) expect(p.seen.every((s) => s.coach === null)).toBe(true);
  });
});
