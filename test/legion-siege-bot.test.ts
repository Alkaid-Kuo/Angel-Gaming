// 攻城陪練（bots/legion-siege.js）：石關城攻守兩邊都能正常布陣、開打，攻城器械真的會用上。
// 只斷言事件有發生、不斷言誰贏（勝負看兩邊的平衡，試打時再調）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LegionEvent } from '../src/legion/api.ts';
import { SIEGE } from '../src/legion/config.ts';
import { MAPS } from '../src/legion/map.ts';
import { LegionBatchController, LegionDriver } from '../src/legion/runner.ts';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';

const bot = (name: string): CompiledBot => compileBot(readFileSync(`bots/legion-${name}.js`, 'utf8'), `legion-${name}.js`);

/** 石關城攻城戰：藍方（0）攻、紅方（1）守；打到 ticks 或比賽結束，回傳全部事件 */
function play(attacker: string, defender: string, seed: number, ticks = Infinity): { d: LegionDriver; events: LegionEvent[] } {
  const map = MAPS['stone-pass']();
  const ctrls = [attacker, defender].map((n, i) => new LegionBatchController(bot(n), n, map, seed, i));
  const d = new LegionDriver({ seed, mode: 'siege', mapId: 'stone-pass', controllers: ctrls, knobs: ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label)), record: false });
  const events: LegionEvent[] = [...d.match.events];
  while (!d.match.over && d.match.tick < ticks) {
    d.step();
    events.push(...d.match.events);
  }
  return { d, events };
}

const rejectedDeploys = (events: LegionEvent[], p: number): LegionEvent[] => events.filter((e) => e.type === 'deployRejected' && e.player === p);

describe('攻城陪練', () => {
  it('攻城陪練對攻城陪練：攻守兩邊布陣零拒絕；時限內結束；破門、雲梯架上、A 被佔至少一件', () => {
    for (const seed of [3, 7]) {
      const { d, events } = play('siege', 'siege', seed);
      expect(rejectedDeploys(events, 0)).toEqual([]);
      expect(rejectedDeploys(events, 1)).toEqual([]);
      for (const rt of d.runtime) {
        expect(rt.errors).toEqual([]);
        expect(rt.exceptions).toBe(0);
      }
      expect(d.match.over).toBe(true);
      expect(d.match.result().durationTicks).toBeLessThanOrEqual(SIEGE.timeLimitTicks + SIEGE.extendTicks);
      const gateBroken = events.some((e) => e.type === 'gate' && e.state === 'broken');
      const ladderBuilt = events.some((e) => e.type === 'ladder' && e.state === 'built');
      const aTaken = events.some((e) => e.type === 'flag' && e.flag === 0 && e.owner === 0);
      expect(gateBroken || ladderBuilt || aTaken).toBe(true);
    }
  });

  it('攻城陪練當攻方、三隻舊陪練當守方：正常開打不出錯，攻方布陣零拒絕、會撞門與架雲梯', () => {
    for (const def of ['push', 'ambush', 'ranged']) {
      const { d, events } = play('siege', def, 7, 1500);
      expect(rejectedDeploys(events, 0)).toEqual([]);
      for (const rt of d.runtime) expect(rt.errors).toEqual([]);
      expect(d.runtime[0].exceptions).toBe(0);
      expect(events.some((e) => e.type === 'ramHit')).toBe(true);
      expect(events.some((e) => e.type === 'ladder' && e.state === 'built')).toBe(true);
      expect(events.some((e) => e.type === 'contact')).toBe(true);
    }
  });

  it('不是攻城地圖（佔點）也不會當機', () => {
    const map = MAPS['grand-valley']();
    const ctrls = ['siege', 'push'].map((n, i) => new LegionBatchController(bot(n), n, map, 5, i));
    const d = new LegionDriver({ seed: 5, mode: 'capture', mapId: 'grand-valley', controllers: ctrls, knobs: ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label)), record: false });
    while (!d.match.over && d.match.tick < 600) d.step();
    expect(d.runtime[0].exceptions).toBe(0);
    expect(d.runtime[0].errors).toEqual([]);
  });
});
