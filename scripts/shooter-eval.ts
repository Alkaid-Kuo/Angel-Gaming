// CS 射擊選手評測：A 對 B 雙邊對打（每個種子 A 當玩家 0～4 一場、當 5～9 一場），平行跑。
// 輸出 A 的整場勝負、當 T／當 CT 的回合勝率、回合結果分布、A 的 decide 平均與最大耗時、例外與超時、init 耗時；
// 以及 A 的行為指標（從 A 的喊話與回合紀錄算，只記錄不當門檻）：T 計畫使用與勝率、每回合道具數、閃光致盲敵我秒數、
// 首次接觸時間、換血率、下包率、回防成功率。
// 用法：node scripts/shooter-eval.ts [--a bots/shooter-baseline.js] [--b bots/shooter-practice.js] [--map redrock] [--games 20] [--seed 1] [--jobs 10]
//       [--attrs aim=80,aggression=20]（只套在 A 身上；預設全部 50）[--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Attributes, ShooterInitData, ShooterObservation } from '../src/shooter/api.ts';
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
  /** 行為指標（A 的視角） */
  readonly beh: Beh;
}

interface Beh {
  /** T 計畫種類 → [回合, 勝] */
  plans: Record<string, [number, number]>;
  /** A 投出的道具、A 的閃光讓敵人／自己隊致盲的 tick */
  throws: number;
  flashEnemy: number;
  flashTeam: number;
  rounds: number;
  /** 首次接觸（開打後秒數）的總和與次數 */
  contactSec: number;
  contacts: number;
  /** A 陣亡數、3 秒內被換掉的數 */
  deaths: number;
  traded: number;
  /** A 當 T：回合數、有下包的回合；A 當 CT：對方下包的回合、其中贏的 */
  tRounds: number;
  planted: number;
  retakes: number;
  retakeWins: number;
}

/** A 的喊話紀錄：回合 → 計畫、首次接觸 tick、開打 tick、有沒有下包 */
interface SayLog {
  plan: string;
  contact: number;
  live: number;
  planted: boolean;
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

  /** 每回合的喊話紀錄（所有 A 共用） */
  log: Map<number, SayLog> | null = null;

  override decide(obs: ShooterObservation): CallOutcome<unknown> {
    const out = super.decide(obs);
    if (this.log === null) return out;
    const r = obs.round.number;
    const e = this.log.get(r) ?? { plan: '', contact: -1, live: -1, planted: false };
    this.log.set(r, e);
    if (e.live < 0 && obs.round.phase !== 'freeze') e.live = obs.tick - (obs.round.phase === 'live' ? this.roundTicks - obs.round.phaseTicksLeft : 0);
    if (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing' || obs.bomb.state === 'exploded' || obs.bomb.state === 'defused') e.planted = true;
    const cmds = Array.isArray(out.value) ? (out.value as { type?: string; text?: string }[]) : [];
    for (const c of cmds) {
      if (c.type !== 'say' || typeof c.text !== 'string') continue;
      if (obs.me.team === 'T' && c.text.startsWith('P:')) e.plan = /^P:([a-z]+)/.exec(c.text)?.[1] ?? '';
      if (c.text.startsWith('E:contact') && e.contact < 0) e.contact = obs.tick;
    }
    return out;
  }

  roundTicks = 0;
}

function play(o: Opts, job: Job): GameOut {
  const ca = compileBot(readFileSync(o.a, 'utf8'), o.a);
  const cb = compileBot(readFileSync(o.b, 'utf8'), o.b);
  const attrs = Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, o.attrs[k] ?? 50])) as Attributes;
  const isA = (pid: number): boolean => (pid < TEAM_SIZE) === job.aFirst;
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => (isA(pid) ? new AttrController(ca, o.a, job.seed, pid, o.map, attrs) : new ShooterBatchController(cb, o.b, job.seed, pid, MAPS[o.map]())));
  const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const log = new Map<number, SayLog>();
  for (const c of controllers) {
    if (c instanceof AttrController) {
      c.log = log;
      c.roundTicks = shooterInitData(MAPS[o.map](), 0, {}).rules.roundTicks;
    }
  }
  const run = runShooterMatch({ seed: job.seed, mapId: o.map, controllers, knobs, record: false });
  const r = run.result;
  const beh: Beh = { plans: {}, throws: 0, flashEnemy: 0, flashTeam: 0, rounds: 0, contactSec: 0, contacts: 0, deaths: 0, traded: 0, tRounds: 0, planted: 0, retakes: 0, retakeWins: 0 };
  for (const x of r.rounds) {
    const g = job.aFirst ? 0 : 1;
    const aIsT = x.tGroup === g;
    const won = x.winnerGroup === g;
    const sl = log.get(x.number);
    beh.rounds++;
    beh.throws += x.throws[g];
    beh.flashEnemy += x.flashEnemyTicks[g];
    beh.flashTeam += x.flashTeamTicks[g];
    if (sl !== undefined && sl.contact >= 0 && sl.live >= 0) {
      beh.contactSec += (sl.contact - sl.live) / 30;
      beh.contacts++;
    }
    if (aIsT) {
      beh.tRounds++;
      if (sl?.planted === true) beh.planted++;
      const k = sl?.plan || '?';
      const st = beh.plans[k] ?? [0, 0];
      st[0]++;
      if (won) st[1]++;
      beh.plans[k] = st;
    } else if (sl?.planted === true) {
      beh.retakes++;
      if (won) beh.retakeWins++;
    }
  }
  const kills = run.match.kills;
  kills.forEach((k, i) => {
    if (!isA(k.victim) || k.killer < 0 || isA(k.killer)) return;
    beh.deaths++;
    for (let j = i + 1; j < kills.length && kills[j].tick - k.tick <= 90 && kills[j].round === k.round; j++) {
      if (kills[j].victim === k.killer && isA(kills[j].killer)) {
        beh.traded++;
        break;
      }
    }
  });
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
  return { seed: job.seed, aFirst: job.aFirst, result: r.winner === null ? 0 : r.winner === aGroup ? 1 : -1, score: r.score, overtimes: r.overtimes, aT, aCT, reasons, decideMs, decisions, decideMax, exceptions, timeouts, errors, wallMs: Math.round(run.wallMs), beh };
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
  const plans: Record<string, [number, number]> = {};
  for (const g of outs) for (const [k, v] of Object.entries(g.beh.plans)) {
    const st = plans[k] ?? [0, 0];
    st[0] += v[0];
    st[1] += v[1];
    plans[k] = st;
  }
  const B = (f: (b: Beh) => number): number => sum((g) => f(g.beh));
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
    behavior: {
      tPlans: Object.fromEntries(Object.entries(plans).sort().map(([k, v]) => [k, `${v[0]} 回合、勝 ${pct(v[1], v[0])}`])),
      throwsPerRound: Number((B((b) => b.throws) / Math.max(1, B((b) => b.rounds))).toFixed(2)),
      flashEnemySec: Number((B((b) => b.flashEnemy) / 30).toFixed(1)),
      flashTeamSec: Number((B((b) => b.flashTeam) / 30).toFixed(1)),
      flashTeamPct: pct(B((b) => b.flashTeam), B((b) => b.flashEnemy)),
      firstContactSec: Number((B((b) => b.contactSec) / Math.max(1, B((b) => b.contacts))).toFixed(1)),
      tradeRate: pct(B((b) => b.traded), B((b) => b.deaths)),
      plantRate: pct(B((b) => b.planted), B((b) => b.tRounds)),
      retakeWin: `${pct(B((b) => b.retakeWins), B((b) => b.retakes))}（${B((b) => b.retakeWins)}/${B((b) => b.retakes)}）`,
    },
    wallSec: Math.round((performance.now() - t0) / 1000),
    perGame: outs.map((g) => `${g.seed}${g.aFirst ? 'a' : 'b'}:${g.result === 1 ? 'W' : g.result === 0 ? 'D' : 'L'} ${g.score.join('-')}`).join(' '),
  };
  console.log(JSON.stringify(summary, null, 1));
  const out = arg('json', '');
  if (out !== '') writeFileSync(out, JSON.stringify({ summary, games: outs }, null, 1));
}
