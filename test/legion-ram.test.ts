// 引擎 0.4 步驟 4：衝車（附上才動、同速、正面擋箭、撞門破門）。測試圖見 legion-castle-map.ts（衝車起點在藍方 (12.5, 11.5)）。
import { describe, expect, it } from 'vitest';
import { RAM, RULES } from '../src/legion/config.ts';
import { castleMap, castleMatch, hpOf, rejected, run } from './legion-castle-map.ts';

castleMap('test-ram', { ram: { x: 12500, y: 11500, facing: 0 } });
const M = 'test-ram';
// 藍方劍士在衝車後面 2 格、朝東
const crew = { type: 'sword', x: 10500, y: 11500, facing: 0 };
const farRed = { type: 'light', x: 35000, y: 22500 };

describe('軍團戰 0.4：衝車', () => {
  it('攻城地圖才有衝車：只有一台、歸攻方、起點在地圖資料；obs 雙方可見', () => {
    const { m } = castleMatch(M, [crew], [farRed]);
    for (const p of [0, 1]) expect(m.observe(p).structures.ram).toEqual({ id: 0, owner: 0, x: 12500, y: 11500, facing: 0, crew: null, gate: null, nextHit: 0 });
    const { m: m2 } = castleMatch('test-castle-noram', [crew], [farRed]);
    expect(m2.observe(0).structures.ram).toBeNull();
  });

  it('沒人附上衝車不動；附上的兵團跟衝車同速，卸下後恢復', () => {
    const { m } = castleMatch(M, [crew], [farRed]);
    run(m, 100, () => [[0, [{ type: 'move', id: 0, x: 10500, y: 3500 }]]]);
    expect([m.ram!.x, m.ram!.y]).toEqual([12500, 11500]);
    const { m: m2 } = castleMatch(M, [crew], [farRed]);
    m2.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    expect(m2.ram!.crew).toBe(0);
    const r = m2.regiments[0];
    run(m2, 20, () => [[0, [{ type: 'move', id: 0, x: 16500, y: 11500 }]]]);
    const x0 = r.x;
    run(m2, 20, () => [[0, [{ type: 'move', id: 0, x: 16500, y: 11500 }]]]);
    expect(r.x - x0).toBe(20 * RAM.speed);
    // 衝車在兵團正前方
    expect(m2.ram!.x).toBeGreaterThan(r.x);
    expect(m2.observe(1).structures.ram!.crew).toBe(0);
    m2.applyCommands(0, [{ type: 'unman', id: 0 }]);
    expect(m2.ram!.crew).toBe(-1);
    const rx = m2.ram!.x;
    const x1 = r.x;
    run(m2, 10, () => [[0, [{ type: 'move', id: 0, x: 3500, y: 11500 }]]]);
    expect(m2.ram!.x).toBe(rx);
    expect(Math.abs(r.x - x1)).toBeGreaterThan(5 * RAM.speed);
  });

  it('附上的條件：攻方、步兵、地面、4～5 格內、只有一團；推衝車中不能架槍林、盾牆、雲梯、也不能衝刺', () => {
    const { m, events } = castleMatch(M, [crew, { type: 'lightCav', x: 12500, y: 4500, facing: 0 }, { type: 'spear', x: 4500, y: 19500, facing: 0 }, { type: 'sword', x: 13500, y: 18500 }], [{ type: 'sword', x: 24500, y: 11500 }]);
    m.applyCommands(0, [
      { type: 'man', id: 1, target: 0 },
      { type: 'man', id: 2, target: 0 },
      { type: 'man', id: 0, target: 3 },
      { type: 'man', id: 0, target: 0 },
      { type: 'man', id: 3, target: 0 },
      { type: 'brace', id: 0 },
      { type: 'assault', id: 0, facing: 0 },
    ]);
    m.applyCommands(1, [{ type: 'man', id: 4, target: 0 }]);
    expect(rejected(events)).toEqual([
      [0, 'man', '騎兵不能推衝車'],
      [0, 'man', '離衝車太遠'],
      [0, 'man', '沒有這台衝車'],
      [0, 'man', '衝車已經有人推'],
      [0, 'brace', '推衝車中不能這樣做，先卸下（unman）'],
      [0, 'assault', '現在不能衝刺（地形、陣形或姿態）'],
      [1, 'man', '只有攻方能推衝車'],
    ]);
    // 長槍推衝車時不能架槍林
    const { m: m2, events: ev2 } = castleMatch(M, [{ type: 'spear', x: 10500, y: 11500, facing: 0 }], [farRed]);
    m2.applyCommands(0, [{ type: 'man', id: 0, target: 0 }, { type: 'brace', id: 0 }]);
    expect(rejected(ev2)).toEqual([[0, 'brace', '推衝車中不能這樣做，先卸下（unman）']]);
  });

  it('正面擋箭：守方弓兵從衝車正面射來無效；兵團轉身背對城牆就中箭', () => {
    // 紅方弓兵在正門門樓頂（層 1）
    const archer = { type: 'archer', x: 20500, y: 11500, layer: 1, facing: 180 };
    const { m } = castleMatch(M, [crew], [archer]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    run(m, 150);
    expect(m.projectiles.length + m.regiments[1].lastShot).toBeGreaterThan(0);
    expect(m.regiments[1].lastShot).toBeGreaterThan(0);
    expect(hpOf(m, 0)).toBe(24 * 1200);
    m.applyCommands(0, [{ type: 'face', id: 0, facing: 180 }]);
    run(m, 150);
    expect(m.ram!.facing).toBe(180);
    expect(hpOf(m, 0)).toBeLessThan(24 * 1200);
  });

  it('撞門：貼著正門每 3 秒一下、6 下（18 秒）破門；側門 3 下；砲擊、士兵攻擊都不扣門血', () => {
    const { m, events } = castleMatch(M, [crew], [farRed]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    let since = -1;
    for (let i = 0; i < 600 && m.gates[0].state !== 'broken'; i++) {
      if (m.isDecisionTick()) m.applyCommands(0, [{ type: 'move', id: 0, x: 19500, y: 11500 }]);
      m.step();
      if (since < 0 && m.ram!.gate === 0) since = m.ram!.contactSince;
    }
    expect(since).toBeGreaterThan(0);
    expect(m.gates[0].state).toBe('broken');
    const hits = events.flatMap((e) => (e.type === 'ramHit' ? [[e.tick, e.gate, e.hp]] : []));
    expect(hits.map((h) => h[0] - since)).toEqual([30, 60, 90, 120, 150, 180]);
    expect(hits.at(-1)![2]).toBe(0);
    expect(6 * RAM.hit).toBeGreaterThanOrEqual(RULES.gate.mainHp);
    expect(5 * RAM.hit).toBeLessThan(RULES.gate.mainHp);
    // 側門：3 下
    expect(3 * RAM.hit).toBeGreaterThanOrEqual(RULES.gate.sideHp);
    expect(2 * RAM.hit).toBeLessThan(RULES.gate.sideHp);
    const { m: m2, events: ev2 } = castleMatch(M, [{ ...crew, y: 17500 }], [farRed]);
    m2.ram!.y = 18500;
    m2.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    run(m2, 600, (t) => (m2.gates[1].state === 'broken' && t > 0 ? [] : [[0, [{ type: 'move', id: 0, x: 19500, y: 18500 }]]]));
    expect(m2.gates[1].state).toBe('broken');
    expect(ev2.filter((e) => e.type === 'ramHit' && e.gate === 1).length).toBe(3);
  });

  it('沒人推就不撞：衝車停在門前、兵團卸下後計時歸零', () => {
    const { m, events } = castleMatch(M, [crew], [farRed]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    for (let i = 0; i < 400 && m.ram!.gate < 0; i++) {
      if (m.isDecisionTick()) m.applyCommands(0, [{ type: 'move', id: 0, x: 19500, y: 11500 }]);
      m.step();
    }
    expect(m.ram!.gate).toBe(0);
    m.applyCommands(0, [{ type: 'unman', id: 0 }]);
    run(m, 200);
    expect(events.filter((e) => e.type === 'ramHit').length).toBeLessThanOrEqual(1);
    expect(m.gates[0].state).toBe('closed');
    expect(m.ram!.contactSince).toBe(-1);
  });
});

castleMap('test-castle-noram');
