// 引擎 0.4 步驟 5：砲擊支援（次數與冷卻、延遲、敵我不分、陰影區、牆頂打得到）。測試圖見 legion-castle-map.ts（砲擊從西邊來）。
import { describe, expect, it } from 'vitest';
import { BOMBARD } from '../src/legion/config.ts';
import { castleMap, castleMatch, hpOf, rejected, run } from './legion-castle-map.ts';

castleMap('test-bombard', { bombardFrom: 180 });
const M = 'test-bombard';
const farBlue = { type: 'light', x: 2500, y: 22500 };
const farRed = { type: 'light', x: 37500, y: 22500 };

describe('軍團戰 0.4：砲擊支援', () => {
  it('每場 3 發、冷卻 60 秒；守方、沒有砲擊的地圖、地圖外都被拒；obs 雙方可見剩餘發數與冷卻', () => {
    const { m, events } = castleMatch(M, [farBlue], [farRed]);
    const shot = { type: 'bombard', x: 10500, y: 6500 };
    m.applyCommands(1, [shot]);
    m.applyCommands(0, [shot, shot, { type: 'bombard', x: -500, y: 6500 }]);
    expect(m.observe(1).structures.bombardsLeft).toBe(BOMBARD.shells - 1);
    expect(m.observe(1).structures.bombardReadyIn).toBe(BOMBARD.cooldown);
    expect(m.observe(1).structures.bombards).toEqual([{ x: 10500, y: 6500, landIn: BOMBARD.delay, radius: BOMBARD.radius }]);
    run(m, BOMBARD.cooldown - 1);
    m.applyCommands(0, [shot]);
    m.step();
    m.applyCommands(0, [shot]);
    run(m, BOMBARD.cooldown);
    m.applyCommands(0, [shot]);
    run(m, BOMBARD.cooldown);
    m.applyCommands(0, [shot]);
    expect(rejected(events)).toEqual([
      [1, 'bombard', '只有攻方有砲擊支援'],
      [0, 'bombard', '砲擊冷卻中'],
      [0, 'bombard', '砲擊冷卻中'],
      [0, 'bombard', '砲擊冷卻中'],
      [0, 'bombard', '砲擊用完了'],
    ]);
    expect(m.bombardsLeft).toBe(0);
    const { m: m2, events: ev2 } = castleMatch('test-castle-noshell', [farBlue], [farRed]);
    m2.applyCommands(0, [shot]);
    expect(rejected(ev2)).toEqual([[0, 'bombard', '這張地圖沒有砲擊支援']]);
    expect(m2.observe(0).structures).toMatchObject({ bombards: [], bombardsLeft: 0, bombardReadyIn: 0 });
  });

  it('下令後 5 秒落地；半徑 3 格內敵我不分，每人扣固定傷害', () => {
    // 藍方劍士貼著城牆西側（地面），紅方劍士在正上方的牆頂（層 1）：不同層不會近戰，只有砲擊會扣血
    const { m, events } = castleMatch(M, [{ type: 'sword', x: 18500, y: 6500, facing: 0 }, farBlue], [{ type: 'sword', x: 20500, y: 6500, layer: 1, facing: 270 }]);
    m.applyCommands(0, [{ type: 'bombard', x: 19800, y: 6500 }]);
    const far0 = hpOf(m, 1);
    run(m, BOMBARD.delay);
    expect(events.some((e) => e.type === 'bombard' && e.state === 'landed')).toBe(false);
    const b1 = hpOf(m, 0);
    const r1 = hpOf(m, 2);
    m.step();
    const landed = events.find((e) => e.type === 'bombard' && e.state === 'landed');
    expect(landed).toBeDefined();
    expect(landed!.tick).toBe(BOMBARD.delay);
    const lostB = b1 - hpOf(m, 0);
    const lostR = r1 - hpOf(m, 2);
    expect(lostB).toBeGreaterThan(0);
    expect(lostR).toBeGreaterThan(0);
    expect(lostB % BOMBARD.damage).toBe(0);
    expect(lostR % BOMBARD.damage).toBe(0);
    expect(hpOf(m, 1)).toBe(far0);
    expect(landed!.type === 'bombard' && landed!.hit).toBe((lostB + lostR) / BOMBARD.damage);
    expect(m.observe(0).structures.bombards).toEqual([]);
  });

  it('陰影區：門洞內側、緊貼城牆東側打不到；牆頂、門樓頂、城內深處打得到', () => {
    const { m, events } = castleMatch(M, [farBlue], [farRed]);
    expect(m.bombardShadowed(21500, 11500)).toBe(true);
    expect(m.bombardShadowed(23500, 6500)).toBe(true);
    expect(m.bombardShadowed(25500, 6500)).toBe(false);
    expect(m.bombardShadowed(20500, 6500)).toBe(false);
    expect(m.bombardShadowed(20500, 11500)).toBe(false);
    expect(m.bombardShadowed(30500, 11500)).toBe(false);
    m.applyCommands(0, [{ type: 'bombard', x: 21500, y: 11500 }]);
    expect(rejected(events)).toEqual([[0, 'bombard', '落點在城牆的砲擊陰影裡']]);
    expect(m.bombardsLeft).toBe(BOMBARD.shells);
  });

  it('牆頂的守軍被打得到；城門不扣血', () => {
    const { m } = castleMatch(M, [farBlue], [{ type: 'archer', x: 20500, y: 6500, layer: 1 }]);
    const h0 = hpOf(m, 1);
    m.applyCommands(0, [{ type: 'bombard', x: 20500, y: 10500 }]);
    run(m, BOMBARD.delay + 1);
    expect(hpOf(m, 1)).toBeLessThan(h0);
    expect(m.gates.map((g) => g.hp)).toEqual([m.gates[0].hpMax, m.gates[1].hpMax]);
  });
});

castleMap('test-castle-noshell');
