// 引擎 0.4 步驟 6：攻城模式規則（依序佔旗、A 佔下的效果、時限延長、三種勝因、點數與布陣、後備開關關閉）。
import { describe, expect, it } from 'vitest';
import { RULES, SIEGE } from '../src/legion/config.ts';
import { legionInitData, LegionMatch } from '../src/legion/sim.ts';
import { MAPS } from '../src/legion/map.ts';
import { castleMap, castleMatch, rejected, run, teleport } from './legion-castle-map.ts';

castleMap('test-siege', {
  flags: [
    { name: '城門', x: 20500, y: 11500, points: 0 },
    { name: '本陣', x: 33500, y: 11500, points: 0 },
  ],
  ram: { x: 12500, y: 11500, facing: 0 },
  bombardFrom: 180,
});
const M = 'test-siege';
// 藍方（攻方）劍士在正門外 4.5 格；紅方（守方）劍士在城內角落
const nearA = { type: 'sword', x: 16000, y: 11500, facing: 0 };
const redCorner = { type: 'sword', x: 36500, y: 2500, facing: 180 };
const farBlue = { type: 'light', x: 2500, y: 22500 };

describe('軍團戰 0.4：攻城戰的旗', () => {
  it('依序佔旗：A 未佔下前 B 不能佔；A 15 秒佔下 → 正門永久開啟、時限延長 3 分鐘；B 30 秒佔下 → 攻方勝（capture）', () => {
    const { m, events } = castleMatch(M, [nearA, { type: 'light', x: 2500, y: 20500 }], [redCorner], 'siege');
    expect(m.timeLimitTicks).toBe(SIEGE.timeLimitTicks);
    expect(m.flags.map((f) => [f.name, f.owner, f.need])).toEqual([
      ['城門', 1, SIEGE.captureA],
      ['本陣', 1, SIEGE.captureB],
    ]);
    // 輕步兵直接放進本陣：A 還沒佔下，B 的進度不動
    teleport(m, 1, 33500, 11500);
    expect(m.observe(0).flags.map((f) => f.open)).toEqual([true, false]);
    run(m, SIEGE.captureA - 1);
    expect(m.flags[0].progress).toBe(SIEGE.captureA - 1);
    expect(m.flags[1].progress).toBe(0);
    expect(m.gates[0].state).toBe('closed');
    m.step();
    expect(m.flags[0].owner).toBe(0);
    expect(m.gates[0].state).toBe('broken');
    expect(m.gates[1].state).toBe('closed');
    expect(m.timeLimitTicks).toBe(SIEGE.timeLimitTicks + SIEGE.extendTicks);
    expect(events.some((e) => e.type === 'flag' && e.flag === 0 && e.owner === 0)).toBe(true);
    expect(m.observe(1).flags.map((f) => f.open)).toEqual([false, true]);
    run(m, SIEGE.captureB + 5);
    expect(m.over).toBe(true);
    expect(m.result()).toMatchObject({ winner: 0, reason: 'capture' });
    // A 佔下的那一 tick 本陣就開始累積
    expect(m.result().durationTicks).toBe(SIEGE.captureA + SIEGE.captureB - 1);
  });

  it('守方不能把 A 佔回去；雙方都在圈內進度不動；牆頂的守軍不算阻擋', () => {
    const { m } = castleMatch(M, [nearA, farBlue], [{ type: 'sword', x: 23500, y: 11500, facing: 180 }, { type: 'archer', x: 20500, y: 7500, layer: 1, facing: 180 }], 'siege');
    run(m, 60);
    expect(m.flags[0].contested).toBe(true);
    expect(m.flags[0].progress).toBe(0);
    // 守方地面那一團離開：只剩牆頂弓兵，不算阻擋
    teleport(m, 2, 36500, 20500);
    run(m, SIEGE.captureA + 2);
    expect(m.flags[0].owner).toBe(0);
    // 攻方離開、守方進圈：A 還是攻方的
    teleport(m, 0, 3500, 3500);
    teleport(m, 2, 23500, 11500);
    run(m, 200);
    expect(m.flags[0].owner).toBe(0);
  });

  it('時間到：守方勝（time）；全滅仍是勝利條件', () => {
    const m = new LegionMatch({ seed: 3, mode: 'siege', mapId: M, deployments: [[farBlue], [redCorner]], timeLimitTicks: 100 });
    run(m, 200);
    expect(m.result()).toMatchObject({ winner: 1, reason: 'time', durationTicks: 100 });
    const { m: m2 } = castleMatch(M, [farBlue], [redCorner], 'siege');
    for (const s of m2.soldiers) if (s.owner === 1) s.alive = false;
    m2.step();
    expect(m2.result()).toMatchObject({ winner: 0, reason: 'annihilation' });
  });
});

describe('軍團戰 0.4：攻城戰的點數、布陣與後備', () => {
  it('攻守各 600 點；沒有後備（布陣標後備、summon、swap、withdraw 都被拒）', () => {
    const cav = (i: number): object => ({ type: 'heavyCav', x: 4500 + (i % 2) * 9000, y: 1500 + Math.floor(i / 2) * 5500 });
    const { m, events } = castleMatch(M, Array.from({ length: 8 }, (_, i) => cav(i)) as never, [redCorner, { type: 'light', reserve: true, x: 0, y: 0 } as never], 'siege');
    const dep = m.events.filter((e) => e.type === 'deployRejected');
    expect(dep.map((e) => e.type === 'deployRejected' && [e.player, e.index, e.reason])).toEqual([
      [0, 7, `點數超過 ${SIEGE.budget}`],
      [1, 1, '攻城戰沒有後備'],
    ]);
    expect(m.players[0].cost).toBe(7 * 80);
    m.applyCommands(0, [{ type: 'withdraw', id: 0 }, { type: 'swap', id: 0, with: 1 }, { type: 'summon', id: 0 }]);
    expect(rejected(events)).toEqual([
      [0, 'withdraw', '攻城戰沒有後備'],
      [0, 'swap', '攻城戰沒有後備'],
      [0, 'summon', '攻城戰沒有後備'],
    ]);
    expect(m.observe(0).fieldCap).toBe(SIEGE.fieldCap);
    expect(SIEGE.attackerReserve).toBe(false);
    expect(SIEGE.defenderReserve).toBe(false);
  });

  it('布陣：攻方只能在城外布陣區；守方城內與牆頂皆可', () => {
    const { m } = castleMatch(M, [{ type: 'sword', x: 25500, y: 6500 }, farBlue], [{ type: 'archer', x: 20500, y: 4500, layer: 1 }, { type: 'spear', x: 30500, y: 16500 }], 'siege');
    const dep = m.events.flatMap((e) => (e.type === 'deployRejected' ? [[e.player, e.index, e.reason]] : []));
    expect(dep).toEqual([[0, 0, '不在布陣區內']]);
    expect(m.regiments.filter((r) => r.owner === 1).map((r) => r.layer)).toEqual([1, 0]);
  });

  it('攻城戰要用有城的地圖；開局資料帶攻城規則（其他模式為 null）', () => {
    expect(() => new LegionMatch({ seed: 1, mode: 'siege', mapId: 'grand-valley', deployments: [[], []] })).toThrow();
    const map = MAPS[M]();
    const d = legionInitData(map, 'siege', 0, {}, SIEGE.timeLimitTicks);
    expect(d.budget).toBe(SIEGE.budget);
    expect(d.siege).toMatchObject({ attacker: 0, defender: 1, captureA: SIEGE.captureA, captureB: SIEGE.captureB, extendTicks: SIEGE.extendTicks, budget: SIEGE.budget, fieldCap: SIEGE.fieldCap, attackerReserve: false, defenderReserve: false });
    expect(d.siege!.bombard.from).toBe(180);
    expect(d.siege!.gate.mainHp).toBe(RULES.gate.mainHp);
    expect(legionInitData(MAPS['grand-valley'](), 'capture', 0, {}, 100).siege).toBeNull();
  });
});
