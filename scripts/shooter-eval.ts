// CS 射擊選手評測：A 對 B 雙邊對打（每個種子 A 當玩家 0～4 一場、當 5～9 一場），平行跑。
// 輸出 A 的整場勝負、當 T／當 CT 的回合勝率、回合結果分布、A 的 decide 平均與最大耗時、例外與超時、init 耗時。
// 用法：node scripts/shooter-eval.ts [--a bots/shooter-baseline.js] [--b bots/shooter-practice.js] [--map redrock] [--games 20] [--seed 1] [--jobs 10]
//       [--attrs aim=80,aggression=20]（只套在 A 身上；預設全部 50）[--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Attributes, ShooterInitData } from '../src/shooter/api.ts';
import { ATTRIBUTE_KEYS, TEAM_SIZE, type AttributeKey } from '../src/shooter/config.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterBatchController, runShooterMatch, shooterHelpers, type CallOutcome } from '../src/shooter/runner.ts';
import { PLAYER_COUNT, shooterInitData } from '../src/shooter/sim.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';

interface Job {
  readonly seed: number;
  /** A 當玩家 0～4 */
  readonly aFirst: boolean;
}

interface GameOut {
  readonly seed: number;
  readonly aFirst: boolean;
  /** 1 = A 勝、0 = 平手、−1 = A 敗 */
  readonly result: number;
  readonly score: readonly number[];
  readonly overtimes: number;
  /** A 當 T／CT 的回合勝敗 */
  readonly aT: [number, number];
  readonly aCT: [number, number];
  readonly reasons: Record<string, number>;
  readonly decideMs: number;
  readonly decisions: number;
  readonly decideMax: number;
  readonly exceptions: number;
  readonly timeouts: number;
  readonly errors: string[];
  readonly wallMs: number;
}

interface Opts {
  readonly a: string;
  readonly b: string;
  readonly map: string;
  readonly attrs: Partial<Record<AttributeKey, number>>;
}

/** 屬性覆寫：在 init 資料裡換掉 attributes（只給評測用，不經過引擎） */
class AttrController extends ShooterBatchController {
  private readonly attrs: Attributes;

  constructor(compiled: ReturnType<typeof compileBot>, label: string, seed: number, pid: number, mapId: string, attrs: Attributes) {
    super(compiled, label, seed, pid, MAPS[mapId]());
    this.attrs = attrs;
  }

  override init(data: ShooterInitData): CallOutcome<null> {
    return super.init({ ...data, attributes: this.attrs });
  }
}

function play(o: Opts, job: Job): GameOut {
  const ca = compileBot(readFileSync(o.a, 'utf8'), o.a);
  const cb = compileBot(readFileSync(o.b, 'utf8'), o.b);
  const attrs = Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, o.attrs[k] ?? 50])) as Attributes;
  const isA = (pid: number): boolean => (pid < TEAM_SIZE) === job.aFirst;
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => (isA(pid) ? new AttrController(ca, o.a, job.seed, pid, o.map, attrs) : new ShooterBatchController(cb, o.b, job.seed, pid, MAPS[o.map]())));
  const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const run = runShooterMatch({ seed: job.seed, mapId: o.map, controllers, knobs, record: false });
  const r = run.result;
  const aGroup = job.aFirst ? 0 : 1;
  const aT: [number, number] = [0, 0];
  const aCT: [number, number] = [0, 0];
  const reasons: Record<string, number> = {};
  for (const x of r.rounds) {
    const aIsT = x.tGroup === aGroup;
    const win = x.winnerGroup === aGroup ? 0 : 1;
    (aIsT ? aT : aCT)[win] += 1;
    const key = `${aIsT ? 'A當T' : 'A當CT'}:${x.winnerGroup === aGroup ? '勝' : '敗'}:${x.reason}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  let decideMs = 0;
  let decisions = 0;
  let decideMax = 0;
  let exceptions = 0;
  let timeouts = 0;
  const errors: string[] = [];
  run.runtime.forEach((rt, pid) => {
    if (!isA(pid)) return;
    decideMs += rt.decideMsTotal;
    decisions += rt.decisions;
    decideMax = Math.max(decideMax, rt.decideMsMax);
    exceptions += rt.exceptions;
    timeouts += rt.timeouts;
    errors.push(...rt.errors);
  });
  for (const rt of run.runtime) if (rt.exceptions > 0 && errors.length < 5) errors.push(...rt.errors);
  return { seed: job.seed, aFirst: job.aFirst, result: r.winner === null ? 0 : r.winner === aGroup ? 1 : -1, score: r.score, overtimes: r.overtimes, aT, aCT, reasons, decideMs, decisions, decideMax, exceptions, timeouts, errors, wallMs: Math.round(run.wallMs) };
}

/** A 的 init 耗時（毫秒）：直接建立選手類別、計時 init */
function initMs(o: Opts): number {
  const ca = compileBot(readFileSync(o.a, 'utf8'), o.a);
  const map = MAPS[o.map]();
  let worst = 0;
  for (let pid = 0; pid < 3; pid++) {
    const Bot = ca.createClass() as unknown as new () => { declare(): unknown; init?(d: ShooterInitData, h: ReturnType<typeof shooterHelpers>): void };
    const bot = new Bot();
    const data = shooterInitData(map, pid, {});
    const t0 = performance.now();
    bot.init?.(data, shooterHelpers(map, 1, pid));
    worst = Math.max(worst, performance.now() - t0);
  }
  return worst;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

if (!isMainThread) {
  const { opts, jobs } = workerData as { opts: Opts; jobs: Job[] };
  for (const j of jobs) parentPort!.postMessage(play(opts, j));
} else {
  const games = Number(arg('games', '20'));
  const seed = Number(arg('seed', '1'));
  const jobsN = Number(arg('jobs', String(Math.max(1, Math.min(10, cpus().length - 2)))));
  const attrs: Partial<Record<AttributeKey, number>> = {};
  for (const kv of arg('attrs', '').split(',').filter((s) => s !== '')) {
    const [k, v] = kv.split('=');
    attrs[k as AttributeKey] = Number(v);
  }
  const opts: Opts = { a: arg('a', 'bots/shooter-baseline.js'), b: arg('b', 'bots/shooter-practice.js'), map: arg('map', 'redrock'), attrs };
  const all: Job[] = [];
  for (let i = 0; i < games; i++) for (const aFirst of [true, false]) all.push({ seed: seed + i, aFirst });
  const buckets: Job[][] = Array.from({ length: Math.min(jobsN, all.length) }, () => []);
  all.forEach((j, i) => buckets[i % buckets.length].push(j));
  const outs: GameOut[] = [];
  const t0 = performance.now();
  await Promise.all(
    buckets.map(
      (jobs) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { opts, jobs } });
          w.on('message', (m: GameOut) => outs.push(m));
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  outs.sort((x, y) => x.seed - y.seed || Number(y.aFirst) - Number(x.aFirst));
  const sum = (f: (g: GameOut) => number): number => outs.reduce((s, g) => s + f(g), 0);
  const pct = (a: number, b: number): string => (b === 0 ? '-' : `${((a / b) * 100).toFixed(1)}%`);
  const wins = outs.filter((g) => g.result === 1).length;
  const draws = outs.filter((g) => g.result === 0).length;
  const tW = sum((g) => g.aT[0]);
  const tL = sum((g) => g.aT[1]);
  const cW = sum((g) => g.aCT[0]);
  const cL = sum((g) => g.aCT[1]);
  const reasons: Record<string, number> = {};
  for (const g of outs) for (const [k, v] of Object.entries(g.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
  const summary = {
    map: opts.map,
    a: opts.a,
    b: opts.b,
    attrs: opts.attrs,
    games: outs.length,
    aMatchWinRate: pct(wins, outs.length),
    aMatch: { win: wins, draw: draws, loss: outs.length - wins - draws },
    aAsFirst: { win: outs.filter((g) => g.aFirst && g.result === 1).length, of: outs.filter((g) => g.aFirst).length },
    aRoundWinT: `${pct(tW, tW + tL)}（${tW}/${tW + tL}）`,
    aRoundWinCT: `${pct(cW, cW + cL)}（${cW}/${cW + cL}）`,
    aRoundWin: pct(tW + cW, tW + tL + cW + cL),
    overtimeGames: outs.filter((g) => g.overtimes > 0).length,
    reasons: Object.fromEntries(Object.entries(reasons).sort()),
    decideAvgMs: Number((sum((g) => g.decideMs) / Math.max(1, sum((g) => g.decisions))).toFixed(3)),
    decideMaxMs: Number(Math.max(...outs.map((g) => g.decideMax)).toFixed(2)),
    initMaxMs: Number(initMs(opts).toFixed(1)),
    exceptions: sum((g) => g.exceptions),
    timeouts: sum((g) => g.timeouts),
    errors: outs.flatMap((g) => g.errors).slice(0, 5),
    wallSec: Math.round((performance.now() - t0) / 1000),
    perGame: outs.map((g) => `${g.seed}${g.aFirst ? 'a' : 'b'}:${g.result === 1 ? 'W' : g.result === 0 ? 'D' : 'L'} ${g.score.join('-')}`).join(' '),
  };
  console.log(JSON.stringify(summary, null, 1));
  const out = arg('json', '');
  if (out !== '') writeFileSync(out, JSON.stringify({ summary, games: outs }, null, 1));
}
