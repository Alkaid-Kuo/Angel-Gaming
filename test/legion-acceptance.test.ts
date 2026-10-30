import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/legion/acceptance.ts';

// 規格書 v0.2 第十二節的驗收測試：一團對一團、平地、不經過 AI
describe('軍團戰驗收測試（規格書 v0.2）', () => {
  for (const s of SCENARIOS) {
    it(`${s.id} ${s.name}：${s.expect}`, () => {
      const r = s.run();
      expect(r.pass, r.detail).toBe(true);
    });
  }
});
