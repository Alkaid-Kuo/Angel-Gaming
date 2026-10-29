// CS 射擊基準 Bot 情境測試（src/shooter/ai-scenarios.ts）：每個情境 5 個種子，印出每個種子的結果。
// 用法：node scripts/shooter-ai-scenarios.ts [選手檔=bots/shooter-baseline.js] [情境編號,…]
import { readFileSync } from 'node:fs';
import { compileBot } from '../src/sandbox/compile.ts';
import { runAiScenarios } from '../src/shooter/ai-scenarios.ts';

const file = process.argv[2] ?? 'bots/shooter-baseline.js';
const only = process.argv[3]?.split(',');
const bot = compileBot(readFileSync(file, 'utf8'), file);
const res = runAiScenarios(bot, only ? (id) => only.includes(id) : undefined);
for (const r of res) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)}${r.name}`);
  for (const part of r.detail.split('｜')) console.log(`        ${part}`);
}
console.log(`\n通過 ${res.filter((r) => r.pass).length} / ${res.length}`);
