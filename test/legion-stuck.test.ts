// 引擎 0.4.1：攻城地圖上卡住的士兵回得了團（調查報告 docs/2026-10-30_殘兵卡住根因調查報告.md 的 F1′～F4 與斜跨樓梯角）。
// 測試城池見 legion-castle-map.ts：x = 20 一整列城牆，正門 y = 10～12、側門 y = 18，城內 (21, 4) 一格樓梯。
import { describe, expect, it } from 'vitest';
import { TILE } from '../src/legion/config.ts';
import type { LegionMatch, Regiment, Soldier } from '../src/legion/sim.ts';
import { castleMap, castleMatch, run } from './legion-castle-map.ts';

castleMap('test-stuck');
const M = 'test-stuck';
const farBlue = { type: 'light', x: 2500, y: 22500 };

/** 引擎內部（測試直接驅動單一士兵或中心的一步） */
interface Inner {
  moveSoldier(s: Soldier): void;
  moveCenter(r: Regiment, nx: number, ny: number): void;
  nx: Int32Array;
  ny: Int32Array;
  nl: Int8Array | Int32Array | Uint8Array;
}
const inner = (m: LegionMatch): Inner => m as unknown as Inner;

/** 把一團的一個士兵搬到 (x, y)、指定層，其他人不動 */
function put(m: LegionMatch, sid: number, x: number, y: number, layer: number): Soldier {
  const s = m.soldiers[sid];
  s.x = x;
  s.y = y;
  s.layer = layer;
  s.owe = -1;
  s.blocked = false;
  return s;
}

const dist = (s: Soldier, r: Regiment): number => Math.hypot(s.x - r.x, s.y - r.y);

describe('軍團戰 0.4.1：卡住的士兵回團', () => {
  it('F1′ 直線被牆擋住：沿尋路繞過城門回團（舊規則直線貼著關閉的側門不動）', () => {
    // 紅方（守方）劍士在城內側門東邊；一個人被擠到城外、正對關閉的側門，正門打開
    const { m } = castleMatch(M, [farBlue], [{ type: 'sword', x: 30500, y: 18500, facing: 180 }]);
    const r = m.regiments[1];
    const s = put(m, r.slots[0], 18800, 18500, 0);
    m.applyCommands(1, [{ type: 'gate', gate: 0, action: 'open' }]);
    run(m, 400);
    expect(m.gates[1].state).toBe('closed');
    expect(s.x).toBeGreaterThan(21 * TILE);
    expect(dist(s, r)).toBeLessThan(r.rad + 3 * TILE);
    expect(s.wpAt).toBeGreaterThanOrEqual(0);
  });

  it('F1′ 層與團不同又沒有換層紀錄（雲梯倒了留在牆頂）：沿尋路走樓梯下來', () => {
    const { m } = castleMatch(M, [farBlue], [{ type: 'sword', x: 30500, y: 6500, facing: 180 }]);
    const r = m.regiments[1];
    const s = put(m, r.slots[0], 20500, 7500, 1);
    expect([r.layer, r.xseq, r.xferLadder]).toEqual([0, 0, -1]);
    run(m, 400);
    expect(s.layer).toBe(0);
    expect(dist(s, r)).toBeLessThan(r.rad + 3 * TILE);
  });

  it('F2 欠著樓梯換層、人已經站在那座樓梯上：直接換到目的層（舊規則目標就是腳下，原地不動）', () => {
    const { m } = castleMatch(M, [farBlue], [{ type: 'sword', x: 30500, y: 4500, facing: 180 }]);
    const r = m.regiments[1];
    // 團剛從樓梯 (21, 4) 走下來（換到地面），這個人還在樓梯格上、層是牆頂
    r.xfers = [{ seq: 0, ladder: -1, x: 21500, y: 4500, to: 0 }];
    r.xseq = 1;
    const s = put(m, r.slots[0], 21500, 4500, 1);
    s.owe = 0;
    m.step();
    expect([s.layer, s.owe]).toEqual([0, -1]);
    run(m, 300);
    expect(dist(s, r)).toBeLessThan(r.rad + 3 * TILE);
  });

  it('F3 站在樓梯邊上、這一步會走下樓梯：改試單一軸（沿樓梯邊滑向牆頂），不再整步作廢', () => {
    // 紅方弓兵在牆頂；一個人站在樓梯格 (21, 4) 的北緣、層 1，隊形位置在西北的牆頂：斜著走會先踩到北邊的地面格 (21, 3)
    const { m } = castleMatch(M, [farBlue], [{ type: 'archer', x: 20500, y: 1500, layer: 1, facing: 270 }]);
    const r = m.regiments[1];
    expect(r.layer).toBe(1);
    while ((m.tick + m.soldiers[r.slots[0]].k) % 10 === 0) m.step();
    const s = put(m, r.slots[0], 21300, 4100, 1);
    s.sx = 20800;
    s.sy = 3000;
    inner(m).moveSoldier(s);
    const [nx, ny, nl] = [inner(m).nx[s.id], inner(m).ny[s.id], inner(m).nl[s.id]];
    expect(nl).toBe(1);
    expect(ny).toBe(4100);
    expect(nx).toBeLessThan(21300);
  });

  it('F4 從樓梯格走出去才換層：換層紀錄記樓梯格，不是踏出去的那一格地面（牆頂的人走不進地面格）', () => {
    const { m } = castleMatch(M, [farBlue], [{ type: 'sword', x: 30500, y: 4500, facing: 180 }]);
    const r = m.regiments[1];
    // 中心從城內地面 (22, 4) 踏上樓梯 (21, 4)：踏進樓梯就換到牆頂層，紀錄在樓梯格
    r.x = 22200;
    r.y = 4500;
    inner(m).moveCenter(r, 21800, 4500);
    expect(r.layer).toBe(1);
    // 原路踏回地面：走出樓梯格的那一步才換回地面層，紀錄也要記樓梯格
    inner(m).moveCenter(r, 22200, 4500);
    expect(r.layer).toBe(0);
    expect(r.xfers.map((q) => [q.x, q.y, q.to])).toEqual([
      [21500, 4500, 1],
      [21500, 4500, 0],
    ]);
  });

  it('中心斜跨樓梯角：一步從牆頂格斜到地面格、中間擦過樓梯格，照經過的樓梯換層（舊規則留在牆頂層）', () => {
    const { m } = castleMatch(M, [farBlue], [{ type: 'sword', x: 20500, y: 4500, layer: 1, facing: 0 }]);
    const r = m.regiments[1];
    // 牆頂 (20, 4) 的東南角 → 地面 (21, 5)；線段先跨過 x = 21000（進樓梯格 (21, 4)）再跨過 y = 5000
    r.x = 20950;
    r.y = 4900;
    inner(m).moveCenter(r, 21100, 5100);
    expect(r.layer).toBe(0);
    expect([r.stairX, r.stairY]).toEqual([21500, 4500]);
    expect(r.xfers.at(-1)).toEqual({ seq: r.xseq - 1, ladder: -1, x: 21500, y: 4500, to: 0 });
  });
});
