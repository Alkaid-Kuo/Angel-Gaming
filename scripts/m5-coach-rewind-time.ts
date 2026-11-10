// M5 規格 6.12：教練往回看的最壞耗時。即時打到比賽的最後一個 MR6 正規回合開始，回到第 1 回合，再推回現場，量兩段的毫秒。
// Worker 裡是分段推進（每段 30 ms），總耗時與這裡同一量級；這裡量的是純重跑。
// 用法：node scripts/m5-coach-rewind-time.ts [--seed 4242] [--round 0（0＝打到比賽結束前的最後一回合）]
import { readFileSync } from 'node:fs';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import type { MatchRequest, SideSpec } from '../src/manage/gateway.ts';
import { LiveCoach } from '../src/shooter/live-coach.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const args = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
const ALL = SHOOTER_TACTICS.map((t) => t.id);
const side = (): SideSpec => ({
  players: ['entry', 'support', 'anchor', 'lurk', 'awp'].map((lineageId) => ({ lineageId, version: 3, config: { habit: 0, ...Object.fromEntries(ALL.map((t) => [`p_${t}`, 50])) } })),
  team: { ...Object.fromEntries(ALL.map((t) => [`q_${t}`, 50])), ...Object.fromEntries(ALL.map((t) => [`pref_${t}`, 0])), economy: 0 },
});
const req: MatchRequest = { formatId: 'shooter-mr6', a: side(), b: side(), seed: Number(arg('seed', '4242')), coachAi: { a: null, b: 1 } };
const play = (lc: LiveCoach, until: (lc: LiveCoach) => boolean): void => {
  while (!until(lc)) {
    const s = lc.step();
    if (s !== null) lc.resolve(null, null);
  }
};

// 先打一場看最後一回合是第幾回合
let last = Number(arg('round', '0'));
if (last === 0) {
  const probe = new LiveCoach({ request: req, bot, side: 'a', assistant: false });
  play(probe, (x) => x.driver.match.over);
  last = probe.driver.match.rounds.length;
}
const lc = new LiveCoach({ request: req, bot, side: 'a', assistant: false });
const t0 = performance.now();
play(lc, (x) => x.driver.match.roundNumber >= last);
const liveMs = performance.now() - t0;
const ticks = lc.driver.match.tick;
const r0 = performance.now();
lc.rewind(1);
while (!lc.seekStep(500));
const backMs = performance.now() - r0;
const l0 = performance.now();
lc.backToLive();
while (!lc.seekStep(500));
const forwardMs = performance.now() - l0;
console.log(JSON.stringify({ seed: req.seed, liveRound: last, liveTicks: ticks, liveMs: Math.round(liveMs), rewindTo1Ms: Math.round(backMs), backToLiveMs: Math.round(forwardMs), msPerRound: Math.round(forwardMs / (last - 1)) }));
