// 軍團戰驗收測試（規格書 v0.2 第十二節）：印出每個情境的結果與一團對一團的對決矩陣。
// 用法：node scripts/legion-acceptance.ts [情境編號,…]
import { UNIT_KINDS, UNITS } from '../src/legion/config.ts';
import { duelMatrix, runAcceptance } from '../src/legion/acceptance.ts';

const only = process.argv[2]?.split(',');
const results = runAcceptance(only ? (id) => only.includes(id) : undefined);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)}${r.name}\n        預期：${r.expect}\n        結果：${r.detail}`);
console.log(`\n通過 ${results.filter((r) => r.pass).length} / ${results.length}`);
if (only === undefined) {
  console.log('\n一團對一團正面對決（列＝攻方，欄＝守方；勝者 攻方剩%/守方剩%）');
  const m = duelMatrix(UNIT_KINDS);
  console.log('      ' + UNIT_KINDS.map((k) => UNITS[k].name.slice(0, 4).padEnd(10)).join(''));
  m.forEach((row, i) => console.log(UNITS[UNIT_KINDS[i]].name.slice(0, 4).padEnd(6) + row.map((c) => c.padEnd(10)).join('')));
}
