// CS 射擊基準 Bot 情境測試（src/shooter/ai-scenarios.ts）：每個情境 5 個種子，印出每個種子的結果（T9 另外用陪練 Bot 當對手補樣本）。
// 用法：node scripts/shooter-ai-scenarios.ts [選手檔=bots/shooter-baseline.js] [情境編號,…] [--maps redrock2,redrock]（團隊情境跑哪幾張圖）
import { readFileSync } from 'node:fs';
import { compileBot } from '../src/sandbox/compile.ts';
import { runAiScenarios } from '../src/shooter/ai-scenarios.ts';

const at = process.argv.indexOf('--maps');
const maps = at >= 0 ? process.argv[at + 1]?.split(',') : undefined;
const args = process.argv.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
const file = args[2] ?? 'bots/shooter-baseline.js';
const only = args[3]?.split(',');
const bot = compileBot(readFileSync(file, 'utf8'), file);
const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'bots/shooter-practice.js');
const res = runAiScenarios(bot, only ? (id) => only.includes(id) : undefined, practice, maps);
for (const r of res) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)}${r.name}`);
  for (const part of r.detail.split('｜')) console.log(`        ${part}`);
}
console.log(`\n通過 ${res.filter((r) => r.pass).length} / ${res.length}`);
