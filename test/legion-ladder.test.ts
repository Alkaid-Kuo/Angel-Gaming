// 引擎 0.4 步驟 3：雲梯（架設、通過量、推倒、摔傷、再架）。測試圖見 legion-castle-map.ts。
import { describe, expect, it } from 'vitest';
import { LADDER_LAYER, RULES, T, UNITS, WALL_LAYER } from '../src/legion/config.ts';
import { WALL_X, castleMap, castleMatch, hpOf, rejected, run, tileAt } from './legion-castle-map.ts';

const map = castleMap('test-ladder');
const M = 'test-ladder';
const L = RULES.ladder;
// 藍方劍士在牆西側 2.5 格、朝東；梯子架在 (20, 6) 這格城牆，梯腳是 (19, 6)
const sword = { type: 'sword', x: 17000, y: 6500, facing: 0 };
const ladderAt = { x: 20500, y: 6500 };
const farRed = { type: 'light', x: 35000, y: 22500 };

describe('軍團戰 0.4：架雲梯', () => {
  it('架設 80 tick：期間兵團停在原地、狀態 laddering；架好後雙方都看得到', () => {
    const { m, events } = castleMatch(M, [sword], [farRed]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    const r = m.regiments[0];
    expect(m.regimentStatus(r)).toBe('laddering');
    const x0 = r.x;
    run(m, L.buildTicks - 1);
    expect(m.ladders[0].built).toBe(false);
    expect(m.ladders[0].progress).toBe(L.buildTicks - 1);
    expect(r.x).toBe(x0);
    m.step();
    expect(m.ladders[0].built).toBe(true);
    expect(r.building).toBe(-1);
    for (const p of [0, 1]) {
      const ls = m.observe(p).structures.ladders;
      expect(ls).toEqual([{ id: 0, owner: 0, x: 20500, y: 6500, footX: 19500, footY: 6500, progress: L.buildTicks, buildTicks: L.buildTicks, built: true, climbers: 0, topple: -1 }]);
    }
    expect(events.flatMap((e) => (e.type === 'ladder' ? [e.state] : []))).toEqual(['building', 'built']);
  });

  it('只有攻方的劍、盾、槍、輕步能架；騎兵、弓兵、守方被拒；只能架在城牆格、要靠近、一格一座、一團一次一座', () => {
    /** 開一場只有這一團的比賽，下一串架梯指令，回傳被拒的原因 */
    const tryOn = (p: number, dep: object, cmds: object[]): string[] => {
      const blue = p === 0 ? [dep] : [{ type: 'light', x: 3000, y: 22500 }];
      const red = p === 1 ? [dep] : [farRed];
      const { m, events } = castleMatch(M, blue as never, red as never);
      // 藍方的團是 0 號；紅方的團排在藍方一團之後，是 1 號
      m.applyCommands(p, cmds.map((c) => ({ type: 'ladder', id: p, ...c })));
      return rejected(events).map((e) => e[2]);
    };
    expect(tryOn(0, { type: 'lightCav', x: 17000, y: 6500, facing: 0 }, [ladderAt])).toEqual(['只有劍士、盾兵、長槍、輕步兵能架雲梯']);
    expect(tryOn(0, { type: 'archer', x: 17000, y: 6500, facing: 0 }, [ladderAt])).toEqual(['只有劍士、盾兵、長槍、輕步兵能架雲梯']);
    expect(tryOn(1, { type: 'sword', x: 23000, y: 6500, facing: 180 }, [ladderAt])).toEqual(['只有攻方能架雲梯']);
    for (const kind of ['sword', 'shield', 'spear', 'light']) expect(tryOn(0, { type: kind, x: 17000, y: 6500, facing: 0 }, [ladderAt])).toEqual([]);
    // 門樓、地面不是城牆格；太遠；同一團第二座
    expect(tryOn(0, sword, [{ x: 20500, y: 11500 }, { x: 19500, y: 6500 }, { x: 20500, y: 16500 }, ladderAt, { x: 20500, y: 7500 }])).toEqual(['只能架在城牆格', '只能架在城牆格', '離城牆太遠', '這一團正在架另一座雲梯']);
    // 同一格第二座（另一團）
    const { m, events } = castleMatch(M, [sword, { type: 'light', x: 16000, y: 15500, facing: 0 }], [farRed]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    teleportTo(m, 1, 17500, 7500);
    m.applyCommands(0, [{ type: 'ladder', id: 1, ...ladderAt }]);
    expect(rejected(events).map((e) => e[2])).toEqual(['這格城牆已經有雲梯']);
    expect(m.ladders.length).toBe(1);
  });

  it('架設中下移動指令：放下雲梯（取消）', () => {
    const { m, events } = castleMatch(M, [sword], [farRed]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    run(m, 20);
    m.applyCommands(0, [{ type: 'move', id: 0, x: 10500, y: 6500 }]);
    expect(m.ladders.length).toBe(0);
    expect(m.regiments[0].building).toBe(-1);
    expect(events.flatMap((e) => (e.type === 'ladder' ? [e.state] : []))).toEqual(['building', 'cancelled']);
  });
});

describe('軍團戰 0.4：爬雲梯', () => {
  it('通過量：一次一人、每 5 tick 上一人、爬 30 tick；24 人約 15 秒全上牆頂，梯上最多 6 人', () => {
    const { m } = castleMatch(M, [sword], [farRed]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    run(m, L.buildTicks);
    expect(m.ladders[0].built).toBe(true);
    const r = m.regiments[0];
    let first = -1;
    let last = -1;
    let maxOn = 0;
    for (let i = 0; i < 400 && last < 0; i++) {
      if (m.isDecisionTick()) m.applyCommands(0, [{ type: 'move', id: 0, x: 20500, y: 2500 }]);
      m.step();
      const on = r.slots.filter((sid) => m.soldiers[sid].climb >= 0).length;
      maxOn = Math.max(maxOn, on);
      if (on > 0 && first < 0) first = m.tick;
      if (r.slots.every((sid) => m.soldiers[sid].layer === WALL_LAYER)) last = m.tick;
    }
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(0);
    // 第一人上梯到最後一人爬到頂：(24 − 1) × 5 ＋ 30 ＝ 145 tick
    const span = last - first;
    expect(span).toBeGreaterThanOrEqual((UNITS.sword.men - 1) * L.entryTicks + L.climbTicks - 1);
    expect(span).toBeLessThanOrEqual(170);
    expect(maxOn).toBe(L.climbTicks / L.entryTicks);
    expect(r.layer).toBe(WALL_LAYER);
    for (const sid of r.slots) expect([T.Wall, T.Gatehouse]).toContain(tileAt(map, m.soldiers[sid].x, m.soldiers[sid].y));
  });

  it('爬梯上牆、再走樓梯下到城裡：中心先下去，還在梯腳排隊的人照順序爬梯、走同一座樓梯下來，整團都進城', () => {
    const { m } = castleMatch(M, [sword], [farRed]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    run(m, L.buildTicks);
    const r = m.regiments[0];
    // 城內地面 (25, 4)：路徑是梯腳 → 梯口 → 牆頂往北 → 樓梯 (21, 4) → 城內
    const inside = { x: 25500, y: 4500 };
    let wasUp = false;
    let leftOutside = -1;
    for (let i = 0; i < 600; i++) {
      if (m.isDecisionTick()) m.applyCommands(0, [{ type: 'move', id: 0, ...inside }]);
      m.step();
      if (r.layer === WALL_LAYER) wasUp = true;
      // 中心剛下到城裡的那一刻：還在牆外（地面或梯上）的人數
      if (wasUp && leftOutside < 0 && r.layer === 0) leftOutside = r.slots.filter((sid) => m.soldiers[sid].x < WALL_X * 1000 || m.soldiers[sid].climb >= 0).length;
    }
    expect(leftOutside).toBeGreaterThan(0);
    expect(r.xseq).toBe(2);
    expect(r.layer).toBe(0);
    for (const sid of r.slots) {
      const s = m.soldiers[sid];
      expect(s.layer).toBe(0);
      expect(s.x).toBeGreaterThan((WALL_X + 1) * 1000);
    }
  });

  it('爬梯中的人不和任何人近戰（層 2）；obs 的 climbers 計數', () => {
    const { m } = castleMatch(M, [sword], [farRed]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    run(m, L.buildTicks);
    run(m, 40, () => [[0, [{ type: 'move', id: 0, x: 20500, y: 2500 }]]]);
    const climbers = m.soldiers.filter((s) => s.climb >= 0);
    expect(climbers.length).toBeGreaterThan(0);
    for (const s of climbers) expect(s.layer).toBe(LADDER_LAYER);
    expect(m.observe(1).structures.ladders[0].climbers).toBe(climbers.length);
  });
});

describe('軍團戰 0.4：推倒雲梯', () => {
  // 紅方劍士在牆頂（層 1），縱隊沿牆、中心在梯口南方 1 格
  const redTop = { type: 'sword', x: 20500, y: 7500, layer: 1, facing: 270 };

  it('守方站在梯口：讀條 30 tick 推倒；梯上的人摔到梯腳，傷害 ＝ 血量 × 30% × 爬升比例', () => {
    const { m, events } = castleMatch(M, [sword], [redTop]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    run(m, L.buildTicks);
    m.applyCommands(1, [{ type: 'topple', id: 1, ladder: 0 }]);
    expect(m.regiments[1].toppling).toBe(0);
    expect(m.regimentStatus(m.regiments[1])).toBe('toppling');
    let before: { id: number; hp: number; h: number }[] = [];
    for (let i = 0; i < L.toppleTicks + 5 && m.ladders.length > 0; i++) {
      if (m.isDecisionTick()) m.applyCommands(0, [{ type: 'move', id: 0, x: 20500, y: 2500 }]);
      before = m.soldiers.filter((s) => s.alive && s.climb === 0).map((s) => ({ id: s.id, hp: s.hp, h: s.climbUp ? s.climbT : L.climbTicks - s.climbT }));
      m.step();
    }
    expect(m.ladders.length).toBe(0);
    const ev = events.find((e) => e.type === 'ladder' && e.state === 'toppled');
    expect(ev).toBeDefined();
    expect(before.length).toBeGreaterThan(0);
    expect(ev!.type === 'ladder' && ev!.fell).toBe(before.length);
    const full = UNITS.sword.hp;
    for (const b of before) {
      const s = m.soldiers[b.id];
      expect(s.climb).toBe(-1);
      expect(s.layer).toBe(0);
      expect(b.hp - s.hp).toBe(Math.floor((Math.floor((full * L.fallPct) / 100) * b.h) / L.climbTicks));
    }
    // 大部分人還在地面：軍團中心退回地面梯腳；推倒後可以再架
    const r = m.regiments[0];
    expect(r.layer).toBe(0);
    expect(r.xferLadder).toBe(-1);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    expect(rejected(events)).toEqual([]);
    expect(m.ladders.length).toBe(1);
    expect(m.ladders[0].id).toBe(1);
  });

  it('推不了：不在牆頂、離梯口太遠、梯口有敵兵、攻方下令、雲梯不存在或還沒架好', () => {
    const { m, events } = castleMatch(
      M,
      [sword, { type: 'light', x: 17000, y: 15500, facing: 0 }],
      [redTop, { type: 'sword', x: 24500, y: 6500, facing: 180 }, { type: 'sword', x: 20500, y: 20500, layer: 1, facing: 90 }],
    );
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    m.applyCommands(1, [{ type: 'topple', id: 2, ladder: 0 }]);
    run(m, L.buildTicks);
    m.applyCommands(1, [
      { type: 'topple', id: 3, ladder: 0 },
      { type: 'topple', id: 4, ladder: 0 },
      { type: 'topple', id: 2, ladder: 7 },
    ]);
    m.applyCommands(0, [{ type: 'topple', id: 1, ladder: 0 }]);
    expect(rejected(events)).toEqual([
      [1, 'topple', '雲梯還沒架好'],
      [1, 'topple', '要在牆頂才能推倒雲梯'],
      [1, 'topple', '要站在梯口才能推倒雲梯'],
      [1, 'topple', '沒有這座雲梯'],
      [0, 'topple', '只有守方能推倒雲梯'],
    ]);
  });

  it('梯口有攻方士兵就推不了；讀條中被攻擊就中斷', () => {
    const { m, events } = castleMatch(M, [sword, { type: 'archer', x: 8500, y: 16500, facing: 0 }], [redTop]);
    m.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    run(m, L.buildTicks);
    // 弓兵開始射牆頂的紅方：推倒讀條會被打斷
    m.applyCommands(1, [{ type: 'topple', id: 2, ladder: 0 }]);
    expect(m.regiments[2].toppling).toBe(0);
    run(m, L.toppleTicks + 10, (t) => (t % 10 === 0 ? [[0, [{ type: 'attack', id: 1, target: 2 }]]] : []));
    expect(m.regiments[2].lastHit).toBeGreaterThan(L.buildTicks);
    expect(m.regiments[2].toppling).toBe(-1);
    expect(m.ladders.length).toBe(1);
    expect(events.some((e) => e.type === 'ladder' && e.state === 'toppled')).toBe(false);
    // 把藍方劍士送上牆、站到梯口：推不了
    const { m: m2, events: ev2 } = castleMatch(M, [sword], [{ ...redTop, y: 10500 }]);
    m2.applyCommands(0, [{ type: 'ladder', id: 0, ...ladderAt }]);
    run(m2, L.buildTicks);
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      if (m2.isDecisionTick()) m2.applyCommands(0, [{ type: 'move', id: 0, x: 20500, y: 3500 }]);
      m2.step();
      up = m2.soldiers.some((s) => s.reg === 0 && s.layer === WALL_LAYER && Math.abs(s.y - 6500) <= 800);
    }
    expect(up).toBe(true);
    teleportRedToMouth(m2);
    m2.applyCommands(1, [{ type: 'topple', id: 1, ladder: 0 }]);
    expect(rejected(ev2).at(-1)).toEqual([1, 'topple', '梯口有敵兵']);
    expect(hpOf(m2, 1)).toBeGreaterThan(0);
  });
});

function teleportTo(m: ReturnType<typeof castleMatch>['m'], reg: number, x: number, y: number): void {
  const r = m.regiments[reg];
  const dx = x - r.x;
  const dy = y - r.y;
  r.x = x;
  r.y = y;
  for (const sid of r.slots) {
    m.soldiers[sid].x += dx;
    m.soldiers[sid].y += dy;
  }
}

/** 把紅方牆頂劍士移到梯口南邊 1 格（只動中心，士兵下一 tick 跟上；這裡只需要有人在梯口 1.5 格內） */
function teleportRedToMouth(m: ReturnType<typeof castleMatch>['m']): void {
  const r = m.regiments[1];
  for (const sid of r.slots) {
    const s = m.soldiers[sid];
    s.x = 20500;
    s.y = 7500;
  }
}
