// M5 第四批驗收 6.8 第 5 條：AI 教練（NPC 教練／助理教練）有請 vs 沒請的勝率差。
// 同一支基準 Bot 鏡像（均衡五角色、版本 3、熟練度全 50、計畫全 0），聯賽賽制 MR6；第 i 場種子＝起始＋i，有教練的一方偶數場是 a、奇數場是 b。
// 回報有教練一方的整場勝率與回合勝率（95% 區間以場為群集）、每場平均暫停與換邊次數。
// 用法：node scripts/m5-coach-ai-eval.ts [--games 200] [--seeds 1,1001] [--format shooter-mr6] [--jobs 10] [--json out/m5/coach-ai.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import type { MatchRequest, SideSpec } from '../src/manage/gateway.ts';
import { LEAGUE_FORMAT_ID, runGatewayMatch } from '../src/shooter/gateway.ts';
import { compileBot } from '../src/sandbox/compile.ts';

interface Job {
  readonly seed: number;
  readonly coach: 'a' | 'b';
}
interface Row {
  readonly seed: number;
  readonly coach: 'a' | 'b';
  readonly won: number;
  readonly rounds: number;
  readonly roundsWon: number;
  readonly timeouts: number;
  readonly halftimes: number;
}

const ROLES = ['entry', 'support', 'anchor', 'lurk', 'awp'];
const ALL = SHOOTER_TACTICS.map((t) => t.id);
const side = (): SideSpec => ({
  players: ROLES.map((lineageId) => ({ lineageId, version: 3, config: { habit: 0, ...Object.fromEntries(ALL.map((t) => [`p_${t}`, 50])) } })),
  team: { ...Object.fromEntries(ALL.map((t) => [`q_${t}`, 50])), ...Object.fromEntries(ALL.map((t) => [`pref_${t}`, 0])), economy: 0 },
});

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

if (!isMainThread) {
  const { jobs, format } = workerData as { jobs: Job[]; format: string };
  const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
  for (const j of jobs) {
    const req: MatchRequest = { formatId: format, a: side(), b: side(), seed: j.seed, coachAi: { a: j.coach === 'a' ? 1 : null, b: j.coach === 'b' ? 1 : null } };
    const o = runGatewayMatch(req, bot).outcome;
    const calls = o.calls ?? [];
    const row: Row = {
      seed: j.seed,
      coach: j.coach,
      won: o.winner === j.coach ? 1 : o.winner === 'draw' ? 0.5 : 0,
      rounds: o.rounds.length,
      roundsWon: o.rounds.filter((r) => r.winner === j.coach).length,
      timeouts: calls.filter((c) => c.kind === 'timeout').length,
      halftimes: calls.filter((c) => c.kind === 'halftime').length,
    };
    parentPort!.postMessage(row);
  }
} else {
  const games = Number(arg('games', '200'));
  const seeds = arg('seeds', '1,1001').split(',').map(Number);
  const format = arg('format', LEAGUE_FORMAT_ID);
  const jobsN = Number(arg('jobs', String(Math.max(1, Math.min(10, cpus().length - 2)))));
  const all: Job[] = [];
  for (const s0 of seeds) for (let i = 0; i < games; i++) all.push({ seed: s0 + i, coach: i % 2 === 0 ? 'a' : 'b' });
  const buckets: Job[][] = Array.from({ length: Math.min(jobsN, all.length) }, () => []);
  all.forEach((j, i) => buckets[i % buckets.length].push(j));
  const rows: Row[] = [];
  const t0 = performance.now();
  await Promise.all(buckets.map((jobs) => new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { jobs, format } });
    w.on('message', (r: Row) => rows.push(r));
    w.on('error', reject);
    w.on('exit', () => resolve());
  })));
  const n = rows.length;
  const pm = rows.reduce((s, r) => s + r.won, 0) / n;
  const pmHalf = 1.96 * Math.sqrt((pm * (1 - pm)) / n);
  const W = rows.reduce((s, r) => s + r.roundsWon, 0);
  const R = rows.reduce((s, r) => s + r.rounds, 0);
  const pr = W / R;
  const vr = (n / (n - 1)) * rows.reduce((s, r) => s + (r.roundsWon - pr * r.rounds) ** 2, 0) / R ** 2;
  const f = (x: number): string => (x * 100).toFixed(1);
  const lines = [
    `賽制 ${format}　種子 ${seeds.join('、')} 各 ${games} 場（共 ${n} 場）　耗時 ${Math.round((performance.now() - t0) / 1000)} 秒`,
    `有 AI 教練一方的整場勝率：${f(pm)}%［${f(pm - pmHalf)}, ${f(pm + pmHalf)}］`,
    `有 AI 教練一方的回合勝率：${f(pr)}%［${f(pr - 1.96 * Math.sqrt(vr))}, ${f(pr + 1.96 * Math.sqrt(vr))}］（${W}/${R} 回合）`,
    `每場平均：暫停 ${(rows.reduce((s, r) => s + r.timeouts, 0) / n).toFixed(2)} 次、換邊改計畫 ${(rows.reduce((s, r) => s + r.halftimes, 0) / n).toFixed(2)} 次`,
  ];
  console.log(lines.join('\n'));
  const out = arg('json', '');
  if (out !== '') writeFileSync(out, JSON.stringify({ format, seeds, games, rows }, null, 1));
}
