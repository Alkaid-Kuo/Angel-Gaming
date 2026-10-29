import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AI_SCENARIOS, runAiScenario, scenarioSeats } from '../src/legion/ai-scenarios.ts';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';

const bot = (name: string): CompiledBot => compileBot(readFileSync(`bots/legion-${name}.js`, 'utf8'), `legion-${name}.js`);

// 冒煙測試：S1～S42 每個情境、每個座位都能跑完、不丟例外、判定回傳布林。不斷言 AI 通過（S19～S42 預期多數不過）。
// 攻城情境用攻城陪練、其餘用統帥；種子用預設的 11。
describe('軍團戰：AI 情境冒煙測試', () => {
  const commander = bot('commander');
  const siege = bot('siege');
  for (const sc of AI_SCENARIOS) {
    for (const seat of scenarioSeats(sc)) {
      it(`${sc.id} ${sc.name}（座位 ${seat}）`, () => {
        const r = runAiScenario(sc, sc.mode === 'siege' ? siege : commander, 'smoke', { seat });
        expect(typeof r.pass).toBe('boolean');
        expect(r.detail.length).toBeGreaterThan(0);
        expect(r.seat).toBe(seat);
        expect(r.seed).toBe(11);
      });
    }
  }

  it('情境編號連續 S1～S42、S38～S42 標待審、攻城情境只有一個座位', () => {
    expect(AI_SCENARIOS.map((s) => s.id)).toEqual(Array.from({ length: 42 }, (_, i) => `S${i + 1}`));
    expect(AI_SCENARIOS.filter((s) => s.pending).map((s) => s.id)).toEqual(['S38', 'S39', 'S40', 'S41', 'S42']);
    for (const s of AI_SCENARIOS) expect(scenarioSeats(s).length).toBe(s.mode === 'siege' ? 1 : 2);
  });
});
