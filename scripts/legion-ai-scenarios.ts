// 軍團戰 AI 情境測試：各 AI 在固定戰術情境中的表現。
// 用法：node scripts/legion-ai-scenarios.ts [AI=commander,push,ambush,ranged] [情境編號,…]
import { readFileSync } from 'node:fs';
import { AI_SCENARIOS, runAiScenarios, type Ctx } from '../src/legion/ai-scenarios.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const bots = (process.argv[2] ?? 'commander,push,ambush,ranged').split(',');
const only = process.argv[3]?.split(',');
const table = new Map<string, string[]>();
for (const b of bots) {
  const bot = compileBot(readFileSync(`bots/legion-${b}.js`, 'utf8'), `legion-${b}.js`);
  // TRACE=20：每 2 秒印出各團位置、狀態與意圖
  const every = Number(process.env.TRACE ?? 0);
  const trace = every > 0
    ? (c: Ctx): void => {
        if (c.m.tick % every !== 0) return;
        console.log(`--- ${c.m.tick / 10}s 「${c.m.players[0].plan}」`);
        for (const r of c.m.regiments) {
          if (r.destroyed) continue;
          console.log(`  ${r.owner} ${r.kind.padEnd(8)} (${((r.x - c.cx) / 1000).toFixed(0).padStart(4)},${((r.y - c.cy) / 1000).toFixed(0).padStart(4)}) f${String(r.facing).padStart(4)} ${String(r.slots.length).padStart(2)}人 ${c.m.regimentStatus(r).padEnd(10)} ${r.order.padEnd(8)}「${r.intent}」`);
        }
      }
    : undefined;
  const res = runAiScenarios(bot, b, only ? (id) => only.includes(id) : undefined, trace);
  console.log(`\n=== ${b}：通過 ${res.filter((r) => r.pass).length} / ${res.length} ===`);
  for (const r of res) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)}${r.name}　${r.detail}`);
    table.set(r.id, [...(table.get(r.id) ?? []), r.pass ? '○' : '×']);
  }
}
console.log(`\n情境      ${bots.map((b) => b.padEnd(10)).join('')}`);
for (const s of AI_SCENARIOS) if (table.has(s.id)) console.log(`${s.id.padEnd(10)}${table.get(s.id)!.map((x) => x.padEnd(10)).join('')}${s.name}`);
