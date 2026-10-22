// 軍團戰：對戰組合 × 種子 × 模式的批次量測（勝率、時長、觀賞性指標、模擬速度）。
// 用法：node scripts/legion-bench.ts [場數=10] [模式=annihilation|capture|both]
import { readFileSync } from 'node:fs';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import type { LegionMode } from '../src/legion/config.ts';
import { MAPS } from '../src/legion/map.ts';
import { LegionBatchController, LegionDriver } from '../src/legion/runner.ts';

const BOTS = ['push', 'ambush', 'ranged'] as const;
const compiled: Record<string, CompiledBot> = {};
for (const b of BOTS) compiled[b] = compileBot(readFileSync(`bots/legion-${b}.js`, 'utf8'), `legion-${b}.js`);

const games = Number(process.argv[2] ?? 10);
const modeArg = process.argv[3] ?? 'both';
const modes: LegionMode[] = modeArg === 'both' ? ['annihilation', 'capture'] : [modeArg as LegionMode];
const map = MAPS['river-valley']();

interface Metrics {
  winner: number | null;
  reason: string;
  duration: number;
  firstContact: number;
  fightShare: number;
  quietAfterContact: number;
  impacts: number;
  braced: number;
  ambushes: number;
  routs: number;
  levelUps: number;
  flanks: number;
  leadChanges: number;
  wallMs: number;
}

function play(a: string, b: string, seed: number, mode: LegionMode): Metrics {
  const t0 = performance.now();
  const ctrls = [a, b].map((n, i) => new LegionBatchController(compiled[n], n, map, seed, i));
  const knobs = ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const d = new LegionDriver({ seed, mode, controllers: ctrls, knobs, record: false });
  const m = d.match;
  let firstContact = -1;
  let impacts = 0;
  let braced = 0;
  let ambushes = 0;
  let routs = 0;
  let levelUps = 0;
  let flanks = 0;
  m.eventTap = (e) => {
    if (e.type === 'contact') {
      if (firstContact < 0) firstContact = e.tick;
      if (e.flank !== 'front') flanks += 1;
    } else if (e.type === 'impact') {
      impacts += 1;
      if (e.braced) braced += 1;
    } else if (e.type === 'ambush') ambushes += 1;
    else if (e.type === 'routed') routs += 1;
    else if (e.type === 'levelUp') levelUps += 1;
  };
  let fightTicks = 0;
  let quiet = 0;
  let afterContact = 0;
  let lead = 0;
  let leadChanges = 0;
  let lastKills = 0;
  while (!m.over) {
    d.step();
    const kills = m.players[0].kills + m.players[1].kills;
    const fighting = m.regiments.some((r) => !r.destroyed && m.tick - r.lastMelee <= 5) || m.projectiles.length > 0 || kills > lastKills;
    lastKills = kills;
    if (fighting) fightTicks += 1;
    if (firstContact >= 0) {
      afterContact += 1;
      if (!fighting) quiet += 1;
    }
    if (m.tick % 50 === 0) {
      const s0 = m.strength(0);
      const s1 = m.strength(1);
      const now = s0 > s1 * 1.08 ? 1 : s1 > s0 * 1.08 ? -1 : 0;
      if (now !== 0 && lead !== 0 && now !== lead) leadChanges += 1;
      if (now !== 0) lead = now;
    }
  }
  const r = m.result();
  return {
    winner: r.winner,
    reason: r.reason,
    duration: r.durationTicks,
    firstContact,
    fightShare: fightTicks / r.durationTicks,
    quietAfterContact: afterContact > 0 ? quiet / afterContact : 1,
    impacts,
    braced,
    ambushes,
    routs,
    levelUps,
    flanks,
    leadChanges,
    wallMs: performance.now() - t0,
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
let totalWall = 0;
let totalGames = 0;
for (const mode of modes) {
  console.log(`\n=== ${mode} ===`);
  console.log('組合            勝(A/B/平)  平均時長  首次接戰  交戰比例  接戰後安靜  衝鋒(擋下)  埋伏  側背擊  潰散  升級  領先易手  勝因');
  for (let i = 0; i < BOTS.length; i++) {
    for (let j = i; j < BOTS.length; j++) {
      const ms: Metrics[] = [];
      for (let g = 0; g < games; g++) {
        // 交換座位，抵銷先後手
        const swap = g % 2 === 1;
        const m = play(swap ? BOTS[j] : BOTS[i], swap ? BOTS[i] : BOTS[j], 1000 + g, mode);
        if (swap && m.winner !== null) m.winner = 1 - m.winner;
        ms.push(m);
      }
      const wa = ms.filter((m) => m.winner === 0).length;
      const wb = ms.filter((m) => m.winner === 1).length;
      const reasons = [...new Set(ms.map((m) => m.reason))].map((r) => `${r}×${ms.filter((m) => m.reason === r).length}`).join(' ');
      const fc = ms.filter((m) => m.firstContact >= 0).map((m) => m.firstContact / 10);
      console.log(
        `${(BOTS[i] + ' vs ' + BOTS[j]).padEnd(16)}${`${wa}/${wb}/${ms.length - wa - wb}`.padEnd(12)}${(avg(ms.map((m) => m.duration)) / 10).toFixed(0).padStart(5)} 秒  ${avg(fc).toFixed(0).padStart(5)} 秒  ${pct(avg(ms.map((m) => m.fightShare))).padStart(6)}  ${pct(avg(ms.map((m) => m.quietAfterContact))).padStart(8)}  ${avg(ms.map((m) => m.impacts)).toFixed(1).padStart(5)}(${avg(ms.map((m) => m.braced)).toFixed(1)})  ${avg(ms.map((m) => m.ambushes)).toFixed(1).padStart(4)}  ${avg(ms.map((m) => m.flanks)).toFixed(1).padStart(5)}  ${avg(ms.map((m) => m.routs)).toFixed(1).padStart(4)}  ${avg(ms.map((m) => m.levelUps)).toFixed(1).padStart(4)}  ${avg(ms.map((m) => m.leadChanges)).toFixed(1).padStart(6)}  ${reasons}`,
      );
      totalWall += ms.reduce((s, m) => s + m.wallMs, 0);
      totalGames += ms.length;
    }
  }
}
console.log(`\n模擬速度：${totalGames} 場，平均 ${(totalWall / totalGames).toFixed(0)} ms／場（${(1000 / (totalWall / totalGames)).toFixed(2)} 場／秒／核心）`);
