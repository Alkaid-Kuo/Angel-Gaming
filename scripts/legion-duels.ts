// 軍團戰兵種對打表：一團對一團正面對打（不用技能），換算成點數看「戰果比」——打掉對方的點數 ÷ 自己損失的點數。
// 大於 1 表示這個兵種花的點數划算；用來調點數。用法：node scripts/legion-duels.ts [開打距離（格），預設 9]
import { UNIT_KINDS, UNITS } from '../src/legion/config.ts';
import { duel } from '../src/legion/acceptance.ts';

const dist = Number(process.argv[2] ?? 9);
const short = (k: (typeof UNIT_KINDS)[number]): string => UNITS[k].name.slice(0, 2);
console.log(`開打距離 ${dist} 格。格子：列（攻）剩% / 行（守）剩%　戰果比（列打掉的點數 ÷ 列損失的點數）\n`);
console.log(['', ...UNIT_KINDS.map((k) => `${short(k)}${UNITS[k].cost}`)].map((s) => s.padEnd(16)).join(''));
const eff = new Map<string, number[]>();
for (const a of UNIT_KINDS) {
  const row = [`${short(a)}${UNITS[a].cost}`];
  for (const b of UNIT_KINDS) {
    if (a === b) {
      row.push('—');
      continue;
    }
    const r = duel(a, b, dist);
    const killed = ((100 - r.b) * UNITS[b].cost) / 100;
    const lost = ((100 - r.a) * UNITS[a].cost) / 100;
    const ratio = lost === 0 ? Infinity : killed / lost;
    eff.set(a, [...(eff.get(a) ?? []), Math.min(ratio, 9.99)]);
    row.push(`${r.a}/${r.b} ${ratio === Infinity ? '∞' : ratio.toFixed(2)}`);
  }
  console.log(row.map((s) => s.padEnd(16)).join(''));
}
console.log('\n各兵種戰果比的幾何平均（上限 9.99；> 1 偏划算、< 1 偏貴）：');
for (const a of UNIT_KINDS) {
  const v = eff.get(a)!;
  const g = Math.exp(v.reduce((t, x) => t + Math.log(Math.max(x, 0.01)), 0) / v.length);
  console.log(`  ${UNITS[a].name.padEnd(5)} ${String(UNITS[a].cost).padStart(3)} 點：${g.toFixed(2)}`);
}
