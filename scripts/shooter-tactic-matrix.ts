// 戰術相剋矩陣（M5 戰術說明的依據）：同一支 Bot 鏡像對打，每回合用教練命令（驅動層 ordersOf）指定 T 打 X、CT 打 Y，
// 量 T 六個 × CT 四個每一格的 T 回合勝率（95% 區間以比賽為群集）。熟練度全 50、計畫全 0、經濟交給選手（命令只指定戰術，buy＝null）。
// 用法：node scripts/shooter-tactic-matrix.ts [--bot bots/shooter-baseline.js] [--games 100] [--seeds 1,1001] [--lineup 3] [--format shooter-mr6] [--jobs 10] [--no-limits] [--json out.json]
//       [--log games.jsonl]（每場打完就附加一行；重跑時跳過檔裡已有的場次＝可續跑）[--report games.jsonl]（不打，只從檔裡已有的場次出表）
// 場次依「第 i 場 → 種子組 → 格子」交錯排，任何時間點每格的場數都差不多，跑到一半就能先出表。
// 每格、每組種子跑 --games 場（第 i 場種子＝起始＋i，a 方偶數場坐組 0、奇數場坐組 1）；兩組都套同一個命令，所以每一回合都是這一格的樣本。
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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
import { CT_TACTICS, T_TACTICS, playGame, type ControllerFactory, type GameRow, type Scenario, type TeamSetup } from './shooter-coach-lib.ts';

interface Opts {
  readonly bot: string;
  readonly lineup: number | null;
  readonly format: string;
  readonly noLimits: boolean;
  readonly map: string;
}

interface Job {
  readonly t: string;
  readonly ct: string;
  readonly seed: number;
  readonly aGroup: 0 | 1;
}

const ALL = [...T_TACTICS, ...CT_TACTICS];
const each = (v: number): Record<string, number> => Object.fromEntries(ALL.map((id) => [id, v]));

/** 這一格的情境：雙方熟練度全 50、計畫全 0，每回合命令 T 打 t、CT 打 ct */
function cell(t: string, ct: string): Scenario {
  const s: TeamSetup = {
    team: each(50),
    personal: each(50),
    pref: each(0),
    economy: 0,
    call: (_round, side) => (side === 'T' ? t : ct),
  };
  return { id: 'call', title: `${t} 對 ${ct}`, a: s, b: s };
}

function factory(o: Opts): ControllerFactory {
  const compiled = compileBot(readFileSync(o.bot, 'utf8'), o.bot);
  const seats = o.lineup === null ? null : balancedLineup(o.lineup).map(derivePlayer);
  return (seed) => {
    const controllers = Array.from(
      { length: PLAYER_COUNT },
      (_, pid) =>
        new ShooterBatchController(compiled, o.bot, seed, pid, MAPS[o.map](), {
          timeLimits: !o.noLimits,
        }),
    );
    if (seats === null) return { controllers };
    const knobs = controllers.map((c, pid) => resolveKnobs(c.declaration, Object.fromEntries(Object.entries(seats[pid % TEAM_SIZE].knobs).filter(([k]) => c.declaration.knobs.some((d) => d.key === k))), c.label));
    return {
      controllers,
      knobs,
      attributes: controllers.map((_, pid) => seats[pid % TEAM_SIZE].attributes),
    };
  };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

/** 一格的 T 回合勝率（以比賽為群集）、命令回合的標籤吻合率 */
export function cellStats(games: readonly GameRow[]): {
  p: number;
  lo: number;
  hi: number;
  wins: number;
  rounds: number;
  tagOk: number;
} {
  const per = games.map((g) => {
    const t = g.rows.filter((r) => r.side === 'T');
    return { w: t.filter((r) => r.won).length, n: t.length };
  });
  const wins = per.reduce((s, x) => s + x.w, 0);
  const rounds = per.reduce((s, x) => s + x.n, 0);
  const p = rounds === 0 ? 0 : wins / rounds;
  const G = per.length;
  const v = G < 2 || rounds === 0 ? 0 : ((G / (G - 1)) * per.reduce((s, x) => s + (x.w - p * x.n) ** 2, 0)) / rounds ** 2;
  const half = 1.96 * Math.sqrt(v);
  const rows = games.flatMap((g) => g.rows);
  const tagOk = rows.length === 0 ? 0 : rows.filter((r) => r.tag === r.call).length / rows.length;
  return { p, lo: p - half, hi: p + half, wins, rounds, tagOk };
}

if (!isMainThread) {
  const { opts, jobs } = workerData as { opts: Opts; jobs: Job[] };
  const make = factory(opts);
  const fmt = formatOptions(opts.format);
  for (const j of jobs) {
    const g = playGame(cell(j.t, j.ct), j.seed, j.aGroup, make, fmt, opts.map);
    // 只回傳統計要用的欄位（省訊息量）
    parentPort!.postMessage({
      key: `${j.t}|${j.ct}`,
      seed: j.seed,
      game: {
        seed: g.seed,
        aGroup: g.aGroup,
        winner: g.winner,
        score: g.score,
        finalHash: g.finalHash,
        rows: g.rows.map((r) => ({
          side: r.side,
          won: r.won,
          tag: r.tag,
          call: r.call,
        })),
      },
    });
  }
} else {
  const games = Number(arg('games', '100'));
  const seeds = arg('seeds', '1,1001').split(',').map(Number);
  const jobsN = Number(arg('jobs', String(Math.max(1, Math.min(10, cpus().length - 2)))));
  const lineup = arg('lineup', '3');
  const opts: Opts = {
    bot: arg('bot', 'bots/shooter-baseline.js'),
    lineup: lineup === 'none' ? null : Number(lineup),
    format: arg('format', LEAGUE_FORMAT_ID),
    noLimits: process.argv.includes('--no-limits'),
    map: arg('map', 'redrock'),
  };
  const logFile = arg('log', '');
  const reportFile = arg('report', '');
  const got = new Map<string, GameRow[]>();
  const seen = new Set<string>();
  const readLog = (f: string): void => {
    if (!existsSync(f)) return;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const m = JSON.parse(line) as {
        key: string;
        seed: number;
        game: GameRow;
      };
      if (seen.has(`${m.key}|${m.seed}`)) continue;
      seen.add(`${m.key}|${m.seed}`);
      got.set(m.key, [...(got.get(m.key) ?? []), m.game]);
    }
  };
  readLog(reportFile !== '' ? reportFile : logFile);
  const all: Job[] = [];
  if (reportFile === '') {
    for (let i = 0; i < games; i++) for (const s0 of seeds) for (const t of T_TACTICS) for (const ct of CT_TACTICS) if (!seen.has(`${t}|${ct}|${s0 + i}`)) all.push({ t, ct, seed: s0 + i, aGroup: (i % 2) as 0 | 1 });
  }
  const buckets: Job[][] = Array.from({ length: Math.max(0, Math.min(jobsN, all.length)) }, () => []);
  all.forEach((j, i) => buckets[i % buckets.length].push(j));
  let done = 0;
  const t0 = performance.now();
  await Promise.all(
    buckets.map(
      (jobs) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), {
            workerData: { opts, jobs },
          });
          w.on('message', (m: { key: string; seed: number; game: GameRow }) => {
            if (logFile !== '') appendFileSync(logFile, JSON.stringify(m) + '\n');
            const list = got.get(m.key) ?? [];
            list.push(m.game);
            got.set(m.key, list);
            if (++done % 200 === 0) console.error(`${done}/${all.length}（${Math.round((performance.now() - t0) / 1000)} 秒）`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  const pct = (x: number): string => (x * 100).toFixed(1);
  const cells: Record<string, ReturnType<typeof cellStats> & { games: number }> = {};
  for (const t of T_TACTICS)
    for (const ct of CT_TACTICS) {
      const gs = got.get(`${t}|${ct}`) ?? [];
      cells[`${t}|${ct}`] = { ...cellStats(gs), games: gs.length };
    }
  console.log(`Bot：${opts.bot}　賽制：${opts.format}　陣容：${opts.lineup ?? '全 50'}　種子：${seeds.join('、')}${reportFile !== '' ? '（從紀錄檔出表）' : ` 各 ${games} 場（每格）`}　逾時：${opts.noLimits ? '關' : '開'}`);
  console.log(`\nT 回合勝率（%，［95% 區間］，以比賽為群集）`);
  console.log(`| T ＼ CT | ${CT_TACTICS.join(' | ')} | 列平均 |`);
  console.log(`| --- |${CT_TACTICS.map(() => ' --- |').join('')} --- |`);
  for (const t of T_TACTICS) {
    const row = CT_TACTICS.map((ct) => cells[`${t}|${ct}`]);
    const avg =
      row.reduce((s, c) => s + c.wins, 0) /
      Math.max(
        1,
        row.reduce((s, c) => s + c.rounds, 0),
      );
    console.log(`| ${t} | ${row.map((c) => `${pct(c.p)}［${pct(c.lo)}, ${pct(c.hi)}］`).join(' | ')} | ${pct(avg)} |`);
  }
  const colAvg = CT_TACTICS.map((ct) => {
    const col = T_TACTICS.map((t) => cells[`${t}|${ct}`]);
    return (
      col.reduce((s, c) => s + c.wins, 0) /
      Math.max(
        1,
        col.reduce((s, c) => s + c.rounds, 0),
      )
    );
  });
  console.log(`| 欄平均 | ${colAvg.map(pct).join(' | ')} | |`);
  const minTag = Math.min(...Object.values(cells).map((c) => c.tagOk));
  const rounds = Object.values(cells).map((c) => c.rounds);
  console.log(`\n每格回合數 ${Math.min(...rounds)}～${Math.max(...rounds)}；命令回合標籤吻合率最低的一格 ${pct(minTag)}%　（${Math.round((performance.now() - t0) / 1000)} 秒）`);
  const out = arg('json', '');
  if (out !== '') writeFileSync(out, JSON.stringify({ opts, seeds, games, cells }, null, 1));
}
