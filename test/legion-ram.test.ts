// 引擎 0.4：衝車沿地圖的軌道走（下 man 由引擎帶過去附上、沿軌道前進不倒退、前方有敵兵就停、卸下後別團接手、到終點撞門）、正面擋箭。
// 測試圖見 legion-castle-map.ts：軌道從藍方 (6.5, 5.5) 斜向東南到 (12.5, 11.5)，再往東到正門外的撞擊點 (18.5, 11.5)（離正門 1.5 格）。
import { describe, expect, it } from 'vitest';
import { RAM, RULES, T, terrainSpeed } from '../src/legion/config.ts';
import { finishMap, mapFeatures, MAPS, registerMap } from '../src/legion/map.ts';
import { legionInitData, type LegionMatch } from '../src/legion/sim.ts';
import { castleMap, castleMatch, castleSpec, CW, hpOf, rejected, run, teleport } from './legion-castle-map.ts';

const TRACK = [
  { x: 6500, y: 5500 },
  { x: 12500, y: 11500 },
  { x: 18500, y: 11500 },
];
const LEN = 8485 + 6000;
castleMap('test-ram', { ramTrack: TRACK });
// 往側門（y = 18）的軌道、往西背對城牆的軌道（擋箭只擋正面）
castleMap('test-ram-side', { ramTrack: [{ x: 8500, y: 18500 }, { x: 18500, y: 18500 }] });
castleMap('test-ram-west', { ramTrack: [{ x: 16500, y: 11500 }, { x: 4500, y: 11500 }] });
// 只有起點沒有軌道：沒有衝車
castleMap('test-ram-notrack', { ram: { x: 12500, y: 11500, facing: 0 } });
// 整條軌道都在樹林裡（x 6～17、y 3～14）：推車團在樹林走得慢，車速要跟著慢
{
  const spec = castleSpec('test-ram-forest', { ramTrack: TRACK });
  for (let y = 3; y <= 14; y++) for (let x = 6; x <= 17; x++) if (spec.terrain[y * CW + x] === T.Plain) spec.terrain[y * CW + x] = T.Forest;
  registerMap(finishMap(spec));
}
const M = 'test-ram';
// 藍方劍士在軌道起點後方、朝東南
const crew = { type: 'sword', x: 4500, y: 3500, facing: 45 };
const farRed = { type: 'light', x: 35000, y: 22500 };

/** (x, y) 到軌道折線的最短距離 */
function offTrack(track: readonly { x: number; y: number }[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < track.length; i++) {
    const a = track[i];
    const b = track[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const u = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy)));
    best = Math.min(best, Math.hypot(a.x + u * vx - x, a.y + u * vy - y));
  }
  return best;
}

/** 附上之後推 ticks 個 tick：每一 tick 衝車都在軌道上、不倒退 */
function push(m: LegionMatch, ticks: number, track = TRACK): void {
  for (let i = 0; i < ticks && !m.over; i++) {
    const d0 = m.ram!.dist;
    m.step();
    expect(m.ram!.dist).toBeGreaterThanOrEqual(d0);
    expect(offTrack(track, m.ram!.x, m.ram!.y)).toBeLessThanOrEqual(2);
  }
}

describe('軍團戰 0.4：衝車（軌道）', () => {
  it('有軌道才有衝車：只有一台、歸攻方、停在軌道起點；軌道在 features、起點在 data.map.ram；obs 雙方可見', () => {
    const { m } = castleMatch(M, [crew], [farRed]);
    const map = MAPS[M]();
    expect(mapFeatures(map).ramTrack).toEqual(TRACK);
    expect(m.ram!.len).toBe(LEN);
    expect(legionInitData(map, 'annihilation', 0, {}, 100).map.ram).toEqual({ x: 6500, y: 5500, facing: 45 });
    for (const p of [0, 1]) expect(m.observe(p).structures.ram).toEqual({ id: 0, owner: 0, x: 6500, y: 5500, facing: 45, crew: null, t: 0, gate: null, nextHit: 0 });
    for (const id of ['test-castle-noram', 'test-ram-notrack']) {
      const { m: m2 } = castleMatch(id, [crew], [farRed]);
      expect(m2.observe(0).structures.ram).toBeNull();
      expect(mapFeatures(MAPS[id]()).ramTrack).toEqual([]);
      expect(legionInitData(MAPS[id](), 'annihilation', 0, {}, 100).map.ram).toBeNull();
    }
    // 石關城：軌道從營地的衝車起點經西橋、甕城到正門外 1.5 格
    const sp = MAPS['stone-pass']();
    const t = mapFeatures(sp).ramTrack;
    expect(t[0]).toEqual({ x: sp.ram!.x, y: sp.ram!.y });
    const g = sp.gates.find((q) => q.kind === 'main')!;
    expect(t.at(-1)).toEqual({ x: g.x0 * 1000 - RAM.contact, y: ((g.y0 + g.y1) * 1000) / 2 });
  });

  it('沒人推衝車不動；man 從遠處下：引擎帶那一團走過來，到 5 格內附上，之後沿軌道每 tick 前進 speed', () => {
    const { m } = castleMatch(M, [{ type: 'sword', x: 3500, y: 19500, facing: 0 }], [farRed]);
    run(m, 50);
    expect([m.ram!.x, m.ram!.y, m.ram!.dist]).toEqual([6500, 5500, 0]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    const r = m.regiments[0];
    // 還在走過來：order 是 man，但還不算附上（obs 的 crew 是 null），衝車不動
    m.step();
    expect(m.observe(0).regiments[0].order).toBe('man');
    expect(m.observe(0).structures.ram!.crew).toBeNull();
    let attachAt = -1;
    for (let i = 0; i < 300 && attachAt < 0; i++) {
      m.step();
      if (m.ram!.attached) attachAt = m.tick;
      else expect(m.ram!.dist).toBe(0);
    }
    expect(attachAt).toBeGreaterThan(0);
    expect(Math.hypot(r.x - m.ram!.x, r.y - m.ram!.y)).toBeLessThanOrEqual(RAM.attach);
    expect(m.observe(1).structures.ram!.crew).toBe(0);
    // 推車那團跟上之後：衝車每 tick 前進 speed、t 隨著增加；那一團排在車後、朝車頭方向
    push(m, 40);
    const d0 = m.ram!.dist;
    push(m, 20);
    expect(m.ram!.dist - d0).toBe(20 * RAM.speed);
    expect(m.observe(0).structures.ram!.t).toBeCloseTo(m.ram!.dist / LEN, 9);
    const behind = (r.x - m.ram!.x) * Math.cos((m.ram!.facing * Math.PI) / 180) + (r.y - m.ram!.y) * Math.sin((m.ram!.facing * Math.PI) / 180);
    expect(behind).toBeLessThan(-RAM.front);
    expect(r.facing).toBe(m.ram!.facing);
    // 轉彎：車頭從 45° 慢慢轉到 0°（每 tick 最多 turn 度）
    push(m, 120);
    expect(m.ram!.facing).toBe(0);
  });

  it('附上之後只接受卸下、換陣形、盾兵姿態：移動、轉向、架槍林、衝刺都被拒絕；還在走過來時下移動就不推了', () => {
    const { m, events } = castleMatch(M, [crew, { type: 'shield', x: 3500, y: 8500, facing: 0 }], [farRed]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    run(m, 5);
    expect(m.ram!.attached).toBe(true);
    m.applyCommands(0, [
      { type: 'move', id: 0, x: 3500, y: 3500 },
      { type: 'face', id: 0, facing: 180 },
      { type: 'hold', id: 0 },
      { type: 'assault', id: 0, facing: 0 },
      { type: 'formation', id: 0, formation: 'square' },
    ]);
    expect(rejected(events)).toEqual([
      [0, 'move', '推衝車中不能這樣做，先卸下（unman）'],
      [0, 'face', '推衝車中不能這樣做，先卸下（unman）'],
      [0, 'hold', '推衝車中不能這樣做，先卸下（unman）'],
      [0, 'assault', '推衝車中不能這樣做，先卸下（unman）'],
    ]);
    expect(m.regiments[0].formation).toBe('square');
    expect(m.ram!.crew).toBe(0);
    // 盾兵還在走過來時改下移動：不推了，照常走
    const { m: m2, events: ev2 } = castleMatch(M, [{ type: 'shield', x: 3500, y: 19500, facing: 0 }], [farRed]);
    m2.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    run(m2, 3);
    m2.applyCommands(0, [{ type: 'shield', id: 0, mode: 'raise' }]);
    expect(m2.ram!.crew).toBe(0);
    m2.applyCommands(0, [{ type: 'move', id: 0, x: 3500, y: 15500 }]);
    expect(rejected(ev2)).toEqual([]);
    expect(m2.ram!.crew).toBe(-1);
    expect(m2.regiments[0].order).toBe('move');
  });

  it('man 的條件：攻方、步兵、地面、只有一團（走過來的也算）；沒有這台衝車', () => {
    const { m, events } = castleMatch(M, [crew, { type: 'lightCav', x: 12500, y: 4500, facing: 0 }, { type: 'spear', x: 4500, y: 19500, facing: 0 }], [{ type: 'sword', x: 24500, y: 11500 }]);
    m.applyCommands(0, [
      { type: 'man', id: 1, target: 0 },
      { type: 'man', id: 0, target: 3 },
      { type: 'man', id: 2, target: 0 },
      { type: 'man', id: 0, target: 0 },
    ]);
    m.applyCommands(1, [{ type: 'man', id: 3, target: 0 }]);
    expect(rejected(events)).toEqual([
      [0, 'man', '騎兵不能推衝車'],
      [0, 'man', '沒有這台衝車'],
      [0, 'man', '衝車已經有人推'],
      [1, 'man', '只有攻方能推衝車'],
    ]);
    expect(m.ram!.crew).toBe(2);
  });

  it('前方有敵兵就停：車頭 2 格內正面有敵方士兵推不動，敵兵走開就繼續', () => {
    const { m } = castleMatch(M, [crew], [{ type: 'light', x: 30500, y: 3500 }]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    push(m, 60);
    // 輕步兵整團搬到車頭正前方 1.5 格
    const q = m.ram!;
    const a = (q.facing * Math.PI) / 180;
    teleport(m, 1, Math.round(q.x + Math.cos(a) * 1500), Math.round(q.y + Math.sin(a) * 1500));
    m.applyCommands(1, [{ type: 'hold', id: 1 }]);
    const d0 = q.dist;
    const blocked = (): boolean =>
      m.soldiers.some((s) => {
        if (!s.alive || m.regiments[s.reg].owner !== 1) return false;
        const dx = s.x - q.x;
        const dy = s.y - q.y;
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI - q.facing;
        return dx * dx + dy * dy <= RAM.block * RAM.block && Math.cos((ang * Math.PI) / 180) >= -1e-9;
      });
    expect(blocked()).toBe(true);
    m.step();
    expect(q.dist).toBe(d0);
    // 輕步兵搬回城內：車繼續走
    teleport(m, 1, 30500, 3500);
    push(m, 30);
    expect(q.dist).toBeGreaterThan(d0);
  });

  it('卸下：衝車停在軌道上原地；別的團再 man 就從同一處接著推；推的團沒了也停', () => {
    const { m } = castleMatch(M, [crew, { type: 'spear', x: 3500, y: 19500, facing: 0 }], [farRed]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    push(m, 80);
    m.applyCommands(0, [{ type: 'unman', id: 0 }]);
    expect([m.ram!.crew, m.ram!.attached, m.regiments[0].order]).toEqual([-1, false, 'idle']);
    const stop = { x: m.ram!.x, y: m.ram!.y, dist: m.ram!.dist };
    expect(stop.dist).toBeGreaterThan(0);
    run(m, 30, () => [[0, [{ type: 'move', id: 0, x: 3500, y: 3500 }]]]);
    expect({ x: m.ram!.x, y: m.ram!.y, dist: m.ram!.dist }).toEqual(stop);
    // 長槍方陣接手
    m.applyCommands(0, [{ type: 'man', id: 1, target: 0 }]);
    for (let i = 0; i < 400 && !m.ram!.attached; i++) m.step();
    expect(m.ram!.crew).toBe(1);
    expect(m.ram!.dist).toBe(stop.dist);
    push(m, 60);
    expect(m.ram!.dist).toBeGreaterThan(stop.dist);
    // 推的團整團沒了：衝車停下、沒有人推
    const r = m.regiments[1];
    r.destroyed = true;
    for (const sid of r.slots) m.soldiers[sid].alive = false;
    m.step();
    const d1 = m.ram!.dist;
    run(m, 20);
    expect(m.ram!.dist).toBe(d1);
    expect(m.observe(0).structures.ram!.crew).toBeNull();
  });

  it('撞門：推到軌道終點（t = 1）貼著正門，每 3 秒一下、6 下（18 秒）破門；側門 3 下；衝車不會超過終點', () => {
    const { m, events } = castleMatch(M, [crew], [farRed]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    let since = -1;
    for (let i = 0; i < 800 && m.gates[0].state !== 'broken'; i++) {
      m.step();
      if (since < 0 && m.ram!.gate === 0) since = m.ram!.contactSince;
    }
    expect(since).toBeGreaterThan(0);
    expect(m.gates[0].state).toBe('broken');
    expect([m.ram!.x, m.ram!.y, m.ram!.dist]).toEqual([18500, 11500, LEN]);
    expect(m.observe(0).structures.ram!.t).toBe(1);
    const hits = events.flatMap((e) => (e.type === 'ramHit' ? [[e.tick, e.gate, e.hp]] : []));
    expect(hits.map((h) => h[0] - since)).toEqual([30, 60, 90, 120, 150, 180]);
    expect(hits.at(-1)![2]).toBe(0);
    expect(6 * RAM.hit).toBeGreaterThanOrEqual(RULES.gate.mainHp);
    expect(5 * RAM.hit).toBeLessThan(RULES.gate.mainHp);
    run(m, 50);
    expect(m.ram!.dist).toBe(LEN);
    // 側門：3 下
    expect(3 * RAM.hit).toBeGreaterThanOrEqual(RULES.gate.sideHp);
    expect(2 * RAM.hit).toBeLessThan(RULES.gate.sideHp);
    const { m: m2, events: ev2 } = castleMatch('test-ram-side', [{ type: 'sword', x: 5500, y: 18500, facing: 0 }], [farRed]);
    m2.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    run(m2, 600);
    expect(m2.gates[1].state).toBe('broken');
    expect(ev2.filter((e) => e.type === 'ramHit' && e.gate === 1).length).toBe(3);
  });

  it('沒人推就不撞：衝車停在門前、兵團卸下後計時歸零', () => {
    const { m, events } = castleMatch(M, [crew], [farRed]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    for (let i = 0; i < 600 && m.ram!.gate < 0; i++) m.step();
    expect(m.ram!.gate).toBe(0);
    m.applyCommands(0, [{ type: 'unman', id: 0 }]);
    run(m, 200);
    expect(events.filter((e) => e.type === 'ramHit').length).toBeLessThanOrEqual(1);
    expect(m.gates[0].state).toBe('closed');
    expect(m.ram!.contactSince).toBe(-1);
    expect(m.ram!.dist).toBe(LEN);
  });

  it('正面擋箭：守方弓兵從車頭方向射來無效；卸下之後、或背對弓兵推車就中箭', () => {
    // 紅方弓兵在正門門樓頂（層 1）；藍方推車往東、車頭對著弓兵
    const archer = { type: 'archer', x: 20500, y: 11500, layer: 1, facing: 180 };
    const { m } = castleMatch(M, [crew], [archer]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    run(m, 250);
    expect(m.ram!.attached).toBe(true);
    expect(m.regiments[1].lastShot).toBeGreaterThan(0);
    expect(hpOf(m, 0)).toBe(24 * 1200);
    m.applyCommands(0, [{ type: 'unman', id: 0 }]);
    run(m, 150);
    expect(hpOf(m, 0)).toBeLessThan(24 * 1200);
    // 往西的軌道：推車那團背對城牆，從背後射來的箭照樣中
    const { m: m2 } = castleMatch('test-ram-west', [{ type: 'sword', x: 18000, y: 11500, facing: 180 }], [archer]);
    m2.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    run(m2, 5);
    expect([m2.ram!.attached, m2.ram!.facing]).toEqual([true, 180]);
    run(m2, 100);
    expect(hpOf(m2, 0)).toBeLessThan(24 * 1200);
  });

  it('車速不會快過推車那團的步行速度：樹林裡盾兵持盾推車走樹林持盾速度，舉盾（更慢）就跟著慢；平地照衝車自己的速度', () => {
    const { m, events } = castleMatch('test-ram-forest', [{ type: 'shield', x: 4500, y: 3500, facing: 45 }], [farRed]);
    m.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    for (let i = 0; i < 300 && !m.ram!.attached; i++) m.step();
    expect(m.ram!.attached).toBe(true);
    push(m, 40);
    expect(m.map.terrain[Math.floor(m.ram!.y / 1000) * CW + Math.floor(m.ram!.x / 1000)]).toBe(T.Forest);
    const carryStep = Math.floor((RULES.shield.carry.speed * terrainSpeed(T.Forest, 'shield')) / 100);
    expect(carryStep).toBeLessThan(RAM.speed);
    const d0 = m.ram!.dist;
    push(m, 20);
    expect(m.ram!.dist - d0).toBe(20 * carryStep);
    m.applyCommands(0, [{ type: 'shield', id: 0, mode: 'raise' }]);
    expect(rejected(events)).toEqual([]);
    push(m, 60);
    expect(m.regiments[0].stance).toBe('raise');
    const d1 = m.ram!.dist;
    push(m, 20);
    expect(m.ram!.dist - d1).toBe(20 * Math.floor((RULES.shield.raise.speed * terrainSpeed(T.Forest, 'shield')) / 100));
    // 平地（原測試圖）：盾兵走得比車快，照衝車自己的速度
    const { m: m2 } = castleMatch(M, [{ type: 'shield', x: 4500, y: 3500, facing: 45 }], [farRed]);
    m2.applyCommands(0, [{ type: 'man', id: 0, target: 0 }]);
    for (let i = 0; i < 300 && !m2.ram!.attached; i++) m2.step();
    push(m2, 40);
    const d2 = m2.ram!.dist;
    push(m2, 20);
    expect(m2.ram!.dist - d2).toBe(20 * RAM.speed);
  });
});
// 沒有衝車的城池（給「有軌道才有衝車」那個測試用）
castleMap('test-castle-noram');
