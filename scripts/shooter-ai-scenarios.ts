// CS 射擊基準 Bot 情境測試（src/shooter/ai-scenarios.ts）：每個情境 5 個種子，印出每個種子的結果（T9 另外用陪練 Bot 當對手補樣本）。
// 用法：node scripts/shooter-ai-scenarios.ts [選手檔=bots/shooter-baseline.js] [情境編號,…] [--maps redrock,dust]（團隊情境跑哪幾張圖）[--solo-map dust]（單兵情境的地圖）[--freeze 3]（凍結秒數，預設 Bot 對打的 3 秒）
import { readFileSync } from 'node:fs';
import { compileBot } from '../src/sandbox/compile.ts';
import { ticks } from '../src/shooter/config.ts';
import { runAiScenarios } from '../src/shooter/ai-scenarios.ts';

const flags = ['--maps', '--solo-map', '--freeze'];
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const skip = new Set(flags.flatMap((f) => (process.argv.includes(f) ? [process.argv.indexOf(f), process.argv.indexOf(f) + 1] : [])));
const args = process.argv.filter((_, i) => !skip.has(i));
const maps = flag('--maps')?.split(',');
const freeze = flag('--freeze');
const file = args[2] ?? 'bots/shooter-baseline.js';
const only = args[3]?.split(',');
const bot = compileBot(readFileSync(file, 'utf8'), file);
const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'bots/shooter-practice.js');
const res = runAiScenarios(bot, only ? (id) => only.includes(id) : undefined, practice, maps, { soloMap: flag('--solo-map'), ...(freeze !== undefined ? { freezeTicks: ticks(Number(freeze)) } : {}) });
for (const r of res) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)}${r.name}`);
  for (const part of r.detail.split('｜')) console.log(`        ${part}`);
}
console.log(`\n通過 ${res.filter((r) => r.pass).length} / ${res.length}`);
