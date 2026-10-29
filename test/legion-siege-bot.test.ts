// 攻城陪練（bots/legion-siege.js）：石關城攻守兩邊都能正常布陣、開打，攻城器械真的會用上。
// 只斷言事件有發生、不斷言誰贏（勝負看兩邊的平衡，試打時再調）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LegionEvent } from '../src/legion/api.ts';
import { SIEGE, type LegionMode } from '../src/legion/config.ts';
import { MAPS } from '../src/legion/map.ts';
import { LegionBatchController, LegionDriver } from '../src/legion/runner.ts';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';

const bot = (name: string): CompiledBot => compileBot(readFileSync(`bots/legion-${name}.js`, 'utf8'), `legion-${name}.js`);

interface Game {
  d: LegionDriver;
  /** 從布陣起的全部事件（用 eventTap 收：決策時下的指令產生的事件不在 match.events 裡） */
  events: LegionEvent[];
}

/** 開一場；mode／mapId 不給就是石關城攻城戰：藍方（0）攻、紅方（1）守 */
function start(attacker: string, defender: string, seed: number, mode: LegionMode = 'siege', mapId = 'stone-pass'): Game {
  const map = MAPS[mapId]();
  const ctrls = [attacker, defender].map((n, i) => new LegionBatchController(bot(n), n, map, seed, i));
  const d = new LegionDriver({ seed, mode, mapId, controllers: ctrls, knobs: ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label)), record: false });
  const events: LegionEvent[] = [...d.match.events];
  d.match.eventTap = (e) => events.push(e);
  return { d, events };
}

/** 打到 ticks 或比賽結束；each 每個 tick 結束呼叫一次 */
function play(d: LegionDriver, ticks = Infinity, each?: () => void): void {
  while (!d.match.over && d.match.tick < ticks) {
    d.step();
    each?.();
  }
}

const rejectedDeploys = (events: LegionEvent[], p: number): LegionEvent[] => events.filter((e) => e.type === 'deployRejected' && e.player === p);

/** 場上（不含後備、已消滅）某方的團，依兵種數 */
function fielded(d: LegionDriver, p: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of d.match.regiments) if (r.owner === p && !r.reserve && !r.destroyed) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

describe('攻城陪練', () => {
  it('石關城布陣：攻守各 14 團全部排進去（不少團）、守方牆頂 5 團、零拒絕', () => {
    const { d, events } = start('siege', 'siege', 7);
    expect(rejectedDeploys(events, 0)).toEqual([]);
    expect(rejectedDeploys(events, 1)).toEqual([]);
    // 攻方：劍士 4（推衝車 1、架雲梯 2、主力 1）、盾兵 2（護送）、長槍 3、弓兵 3、輕步兵 2
    expect(fielded(d, 0)).toEqual({ sword: 4, shield: 2, spear: 3, archer: 3, light: 2 });
    // 守方：弓兵 3（牆頂）、長槍 4（牆頂 2、正門內 2）、盾兵 2、劍士 4、輕步兵 1
    expect(fielded(d, 1)).toEqual({ archer: 3, spear: 4, shield: 2, sword: 4, light: 1 });
    expect(d.match.regiments.filter((r) => r.owner === 1 && r.layer === 1).length).toBe(5);
    expect(d.match.regiments.filter((r) => r.owner === 0 && r.layer === 1).length).toBe(0);
  });

  it('攻城陪練對攻城陪練：時限內結束；破門、雲梯架上、A 被佔至少一件；守方會推雲梯', () => {
    for (const seed of [3, 7]) {
      const { d, events } = start('siege', 'siege', seed);
      let toppling = false;
      play(d, Infinity, () => {
        if (d.match.regiments.some((r) => r.owner === 1 && r.toppling >= 0)) toppling = true;
      });
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
      // 攻方雲梯架好後，守方有牆頂的團開始推倒它（推到倒不一定：讀條會被打斷）
      expect(ladderBuilt).toBe(true);
      expect(toppling).toBe(true);
    }
  });

  it('守方的門被打開（開著或正在開）：陪練下令關上', () => {
    const { d, events } = start('siege', 'siege', 7);
    play(d, 200);
    const gate = d.match.gates.find((g) => g.kind === 'main')!;
    expect(gate.state).toBe('closed');
    d.match.applyCommands(1, [{ type: 'gate', gate: gate.id, action: 'open' }]);
    expect(['opening', 'open']).toContain(gate.state);
    // 開門中就改關：直接回到關閉（引擎規則）；已經開了的就走關門中
    const before = events.length;
    play(d, 500);
    expect(events.slice(before).some((e) => e.type === 'gate' && e.gate === gate.id && e.state === 'closed')).toBe(true);
    expect(['closing', 'closed']).toContain(gate.state);
  });

  it('攻城陪練當攻方、三隻舊陪練當守方：正常開打不出錯，攻方布陣零拒絕、會撞門與架雲梯', () => {
    for (const def of ['push', 'ambush', 'ranged']) {
      const { d, events } = start('siege', def, 7);
      play(d, 1500);
      expect(rejectedDeploys(events, 0)).toEqual([]);
      for (const rt of d.runtime) expect(rt.errors).toEqual([]);
      expect(d.runtime[0].exceptions).toBe(0);
      expect(events.some((e) => e.type === 'ramHit')).toBe(true);
      expect(events.some((e) => e.type === 'ladder' && e.state === 'built')).toBe(true);
      expect(events.some((e) => e.type === 'contact')).toBe(true);
    }
  });

  it('不是攻城地圖（佔點、殲滅）：用一般陣容布陣，場上有團、零拒絕、不出錯、真的打起來', () => {
    for (const [mode, mapId] of [['capture', 'grand-valley'], ['capture', 'grassland'], ['annihilation', 'river-valley']] as const) {
      const { d, events } = start('siege', 'push', 5, mode, mapId);
      expect(rejectedDeploys(events, 0)).toEqual([]);
      // 場上有團，而且包含前線的近戰團與弓兵（不是整隊被丟掉）
      const mine = fielded(d, 0);
      expect(Object.values(mine).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(8);
      expect(mine.archer).toBeGreaterThan(0);
      expect((mine.sword ?? 0) + (mine.spear ?? 0)).toBeGreaterThan(0);
      play(d, 3000);
      for (const rt of d.runtime) expect(rt.errors).toEqual([]);
      expect(d.runtime[0].exceptions).toBe(0);
      // 陪練的團有往前走、也有跟對方接觸
      expect(events.some((e) => e.type === 'contact')).toBe(true);
    }
  });
});
