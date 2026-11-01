// CS 射擊試玩 Bot 等級階梯（Bot 2.2 任務書）：走試玩頁同一條路（trialRunOptions：MR6、觀戰 3 秒、陪練混打 8 tick），陪練對基準 v1～v5，種子互換側。
// 用法：node scripts/shooter-trial-ladder.ts [--games 12] [--seed 1] [--jobs 10] [--bot bots/shooter-baseline.js]
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { compileBot } from '../src/sandbox/compile.ts';
import { runShooterMatch } from '../src/shooter/runner.ts';
import { trialRunOptions } from '../src/web/shooter/lineup.ts';
import type { BotLevel } from '../src/web/shooter/protocol.ts';
import { arg } from './shooter-lab.ts';

interface Job {
  readonly version: number;
  readonly seed: number;
  /** 基準 Bot 在 0～4 號 */
  readonly baseFirst: boolean;
  readonly bot: string;
}

const PRACTICE: BotLevel = { kind: 'practice' };

function play(j: Job): { version: number; won: number; rounds: number; baseRounds: number; exceptions: number } {
  const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'shooter-practice.js');
  const baseline = compileBot(readFileSync(j.bot, 'utf8'), 'shooter-baseline.js');
  const base: BotLevel = { kind: 'baseline', version: j.version as 1 | 2 | 3 | 4 | 5 };
  const o = trialRunOptions({ team: 'T', seed: j.seed, spectate: true, lineup: j.baseFirst ? { team: base, enemy: PRACTICE } : { team: PRACTICE, enemy: base } }, { practice, baseline: () => baseline }, null);
  const run = runShooterMatch({ ...o, record: false });
  const g = j.baseFirst ? 0 : 1;
  const r = run.result;
  return { version: j.version, won: r.winner === null ? 0.5 : r.winner === g ? 1 : 0, rounds: r.rounds.length, baseRounds: r.rounds.filter((x) => x.winnerGroup === g).length, exceptions: run.runtime.reduce((s, x) => s + x.exceptions, 0) };
}

if (!isMainThread && (workerData as { ladder?: boolean } | null)?.ladder === true) {
  for (const j of (workerData as { jobs: Job[] }).jobs) parentPort!.postMessage(play(j));
} else if (isMainThread) {
  const games = Number(arg('games', '12'));
  const seed = Number(arg('seed', '1'));
  const jobsN = Number(arg('jobs', '10'));
  const bot = arg('bot', 'bots/shooter-baseline.js');
  const list: Job[] = [];
  for (let v = 1; v <= 5; v++) for (let i = 0; i < games; i++) list.push({ version: v, seed: seed + Math.floor(i / 2), baseFirst: i % 2 === 0, bot });
  const buckets: Job[][] = Array.from({ length: Math.min(jobsN, list.length) }, () => []);
  list.forEach((x, k) => buckets[k % buckets.length].push(x));
  const out: ReturnType<typeof play>[] = [];
  await Promise.all(buckets.map((b) => new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { ladder: true, jobs: b } });
    w.on('message', (x: ReturnType<typeof play>) => out.push(x));
    w.on('error', reject);
    w.on('exit', () => resolve());
  })));
  for (let v = 1; v <= 5; v++) {
    const gs = out.filter((x) => x.version === v);
    const w = gs.reduce((s, x) => s + x.won, 0);
    const br = gs.reduce((s, x) => s + x.baseRounds, 0);
    const rr = gs.reduce((s, x) => s + x.rounds, 0);
    console.log(`基準 v${v} 對陪練：${w} 勝 ${gs.length - w} 敗（${((100 * w) / gs.length).toFixed(1)}%）；回合 ${((100 * br) / rr).toFixed(1)}%；例外 ${gs.reduce((s, x) => s + x.exceptions, 0)}`);
  }
}
