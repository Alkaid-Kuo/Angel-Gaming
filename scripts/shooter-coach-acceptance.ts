// M5 第一批驗收（規格 3.10 第 5、6 條）：同一支 Bot 鏡像對打，九個情境量回合戰術標籤與強度。判定與「無資料」規則在 scripts/shooter-coach-lib.ts。
// 用法：node scripts/shooter-coach-acceptance.ts [--bot bots/shooter-baseline.js] [--scenarios all|null,plan0,…] [--games 200] [--seeds 1,1001]
//       [--lineup 3]（兩隊都用均衡陣容的該版本，屬性與角色旋鈕同閘道；--lineup none＝全 50、Bot 預設旋鈕）[--format shooter-mr6] [--jobs 10]
//       [--no-limits]（關掉 decide 牆鐘逾時，結果只由程式與種子決定）[--json out.json]
// 每個情境、每組種子跑 --games 場（第 i 場種子＝起始＋i，a 方偶數場坐組 0、奇數場坐組 1）。開跑前先用第一個種子量「Bot 讀不讀戰術資料」，
// 不讀時依賴戰術資料的判定標成無資料。
// 3.10 第 5 條最後一項「coach、tactics 都是 null 時與 Bot 2.7 的鏡像勝率差 ≤ 1.5 點」用既有的 scripts/shooter-eval.ts 量（新舊 Bot 各自鏡像），不在這裡。
import { writeFileSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { TEAM_SIZE } from '../src/shooter/config.ts';
import { LEAGUE_FORMAT_ID, formatOptions } from '../src/shooter/gateway.ts';
import { MAPS } from '../src/shooter/map.ts';
import { balancedLineup, derivePlayer } from '../src/shooter/players.ts';
import { ShooterBatchController } from '../src/shooter/runner.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import { SCENARIOS, evaluate, overall, playGame, readsTactics, scenarioById, tagMix, type Check, type ControllerFactory, type GameRow, type ScenarioId } from './shooter-coach-lib.ts';

interface Opts {
  readonly bot: string;
  readonly lineup: number | null;
  readonly format: string;
  readonly noLimits: boolean;
  readonly map: string;
}

interface Job {
  readonly scenario: ScenarioId;
  readonly seed: number;
  readonly aGroup: 0 | 1;
}

function factory(o: Opts): ControllerFactory {
  const compiled = compileBot(readFileSync(o.bot, 'utf8'), o.bot);
  const seats = o.lineup === null ? null : balancedLineup(o.lineup).map(derivePlayer);
  return (seed) => {
    const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(compiled, o.bot, seed, pid, MAPS[o.map](), { timeLimits: !o.noLimits }));
    if (seats === null) return { controllers };
    const knobs = controllers.map((c, pid) => resolveKnobs(c.declaration, Object.fromEntries(Object.entries(seats[pid % TEAM_SIZE].knobs).filter(([k]) => c.declaration.knobs.some((d) => d.key === k))), c.label));
    return { controllers, knobs, attributes: controllers.map((_, pid) => seats[pid % TEAM_SIZE].attributes) };
  };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

if (!isMainThread) {
  const { opts, jobs, probe } = workerData as { opts: Opts; jobs: Job[]; probe: number | null };
  const make = factory(opts);
  const fmt = formatOptions(opts.format);
  if (probe !== null) parentPort!.postMessage({ probe: readsTactics(make, probe, fmt, opts.map) });
  for (const j of jobs) parentPort!.postMessage({ scenario: j.scenario, game: playGame(scenarioById(j.scenario), j.seed, j.aGroup, make, fmt, opts.map) });
} else {
  const games = Number(arg('games', '200'));
  const seeds = arg('seeds', '1,1001').split(',').map(Number);
  const jobsN = Number(arg('jobs', String(Math.max(1, Math.min(10, cpus().length - 2)))));
  const list = arg('scenarios', 'all');
  const scenarios = list === 'all' ? SCENARIOS : list.split(',').map(scenarioById);
  const lineup = arg('lineup', '3');
  const opts: Opts = { bot: arg('bot', 'bots/shooter-baseline.js'), lineup: lineup === 'none' ? null : Number(lineup), format: arg('format', LEAGUE_FORMAT_ID), noLimits: process.argv.includes('--no-limits'), map: arg('map', 'redrock') };
  const all: Job[] = [];
  for (const sc of scenarios) for (const s0 of seeds) for (let i = 0; i < games; i++) all.push({ scenario: sc.id, seed: s0 + i, aGroup: (i % 2) as 0 | 1 });
  const buckets: Job[][] = Array.from({ length: Math.max(1, Math.min(jobsN, all.length)) }, () => []);
  all.forEach((j, i) => buckets[i % buckets.length].push(j));
  const got = new Map<ScenarioId, GameRow[]>(scenarios.map((s) => [s.id, []]));
  let reads: boolean | null = null;
  const t0 = performance.now();
  await Promise.all(
    buckets.map(
      (jobs, b) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { opts, jobs, probe: b === 0 ? seeds[0] : null } });
          w.on('message', (m: { probe?: boolean; scenario?: ScenarioId; game?: GameRow }) => {
            if (m.probe !== undefined) reads = m.probe;
            if (m.scenario !== undefined && m.game !== undefined) got.get(m.scenario)?.push(m.game);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  const report = scenarios.map((sc) => {
    const gs = (got.get(sc.id) ?? []).sort((x, y) => x.seed - y.seed);
    const checks = evaluate(sc, gs, reads);
    return { scenario: sc.id, title: sc.title, games: gs.length, checks, mix: tagMix(sc, gs) };
  });
  const checks: Check[] = report.flatMap((r) => r.checks.map((c) => ({ ...c, id: `${r.scenario}.${c.id}` })));
  const verdict = overall(checks);
  const mark = { pass: '過', fail: '未過', noData: '無資料' } as const;
  console.log(`Bot：${opts.bot}　賽制：${opts.format}　陣容：${opts.lineup ?? '全 50'}　種子：${seeds.join('、')} 各 ${games} 場　讀戰術資料：${reads === null ? '沒量' : reads ? '是' : '否'}`);
  for (const r of report) {
    console.log(`\n【${r.scenario}】${r.title}（${r.games} 場）`);
    for (const c of r.checks) console.log(`  ${mark[c.verdict].padEnd(4, '　')}${c.title}：${c.value}　目標 ${c.target}`);
    const mixText = (['T', 'CT'] as const).map((side) => `${side} ${Object.entries(r.mix[side]).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join('、') || '-'}`).join('｜');
    if (r.scenario !== 'null') console.log(`  分布：${mixText}`);
  }
  console.log(`\n結論：${verdict.text}　（${Math.round((performance.now() - t0) / 1000)} 秒）`);
  const out = arg('json', '');
  if (out !== '') writeFileSync(out, JSON.stringify({ opts, seeds, games, readsTactics: reads, verdict, report }, null, 1));
}
