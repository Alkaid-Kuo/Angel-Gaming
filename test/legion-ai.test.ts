import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AI_SCENARIOS, runAiScenario } from '../src/legion/ai-scenarios.ts';
import { compileBot } from '../src/sandbox/compile.ts';

// 官方基準 AI（統帥）要通過全部 AI 情境測試：不正面衝槍林、錘砧、弓兵集火、護弓兵、不送頭、佔點、搶高地、搜敵……
describe('軍團戰：AI 情境測試（官方基準 AI）', () => {
  const bot = compileBot(readFileSync('bots/legion-commander.js', 'utf8'), 'legion-commander.js');
  for (const sc of AI_SCENARIOS) {
    it(`${sc.id} ${sc.name}`, () => {
      const r = runAiScenario(sc, bot, 'commander');
      expect(r.pass, `${r.expect}；結果：${r.detail}`).toBe(true);
    });
  }
});
