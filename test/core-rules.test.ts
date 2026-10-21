import { describe, expect, it } from 'vitest';
import { BUILDING_STATS, RULES, TILE_SIZE, UNIT_STATS } from '../src/config/index.ts';
import { acquireForUnit, damageOf } from '../src/core/combat.ts';
import { GATHER } from '../src/core/state.ts';
import { removeBuilding } from '../src/core/world.ts';
import { alignToDecision, newMatch, playerAtSlot, run, spawn, tc, testMap } from './helpers.ts';

describe('傷害計算', () => {
  it('所有攻擊方 × 目標組合符合倍率表', () => {
    // 攻擊方 → [對長槍, 對弓, 對騎, 對工人, 對建築]（規格書數值）
    const expected: Record<string, (number | null)[]> = {
      worker: [4, 4, 4, 4, 4],
      spear: [10, 10, 20, 10, 10],
      archer: [8, 8, 8, 8, 4],
      cavalry: [12, 18, 12, 12, 12],
      tower: [12, 12, 12, 12, null],
    };
    const targets = ['spear', 'archer', 'cavalry', 'worker', 'building'] as const;
    for (const [attacker, row] of Object.entries(expected)) {
      targets.forEach((t, i) => {
        const want = row[i];
        if (want === null) expect(() => damageOf(attacker as 'tower', t)).toThrow();
        else expect(damageOf(attacker as 'spear', t)).toBe(want);
      });
    }
  });

  it('近戰單位推擠後仍能互相攻擊（決策 Q1A：邊緣距離）', () => {
    const m = newMatch(testMap());
    const a = spawn(m, 0, 'spear', 30000, 30000);
    const b = spawn(m, 1, 'spear', 30600, 30000);
    run(m, 30);
    expect(a.hp).toBeLessThan(UNIT_STATS.spear.hp);
    expect(b.hp).toBeLessThan(UNIT_STATS.spear.hp);
  });

  it('同一 tick 的傷害全部結算後才移除死亡者（可同歸於盡）', () => {
    const m = newMatch(testMap());
    const a = spawn(m, 0, 'spear', 30000, 30000);
    const b = spawn(m, 1, 'spear', 30700, 30000);
    a.hp = 5;
    b.hp = 5;
    run(m, 3);
    expect(m.state.unitById.has(a.id)).toBe(false);
    expect(m.state.unitById.has(b.id)).toBe(false);
  });
});

describe('採集', () => {
  it('單一工人在已知距離下，每分鐘產量符合計算值', () => {
    // 主堡 (5,5)～(7,7)，礦點 (15,6)：主堡右緣 x=8000，礦點左緣 x=15000
    const map = testMap({ nodes: [[15, 6, 0], [62, 57, 1]] });
    const m = newMatch(map);
    const p = playerAtSlot(m, 0);
    const node = m.state.nodes.find((n) => n.tileX === 15)!;
    const worker = m.state.units.find((u) => u.owner === p.id)!;
    // 其他工人移開避免干擾
    for (const u of m.state.units) if (u.owner === p.id && u !== worker) u.x = 2500;
    worker.x = 8300;
    worker.y = tc(6);
    run(m, 1, { [p.id]: [{ type: 'gather', units: [worker.id], nodeId: node.id }] });
    run(m, 200);
    const before = p.stats.gathered;
    run(m, 600);
    const perMinute = p.stats.gathered - before;
    const leg = Math.ceil((7000 - 2 * RULES.economy.interactRange) / UNIT_STATS.worker.speed);
    const cycle = 2 * leg + RULES.economy.mineTicks;
    const expected = Math.floor(600 / cycle) * RULES.economy.mineAmount;
    expect(Math.abs(perMinute - expected)).toBeLessThanOrEqual(RULES.economy.mineAmount);
  });

  it('每個礦點同時只能有 1 名工人開採，其他排隊', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const node = m.state.nodes.find((n) => n.areaId === p.mainAreaId)!;
    const ids = m.state.units.filter((u) => u.owner === p.id).map((u) => u.id);
    run(m, 1, { [p.id]: [{ type: 'gather', units: ids, nodeId: node.id }] });
    let maxMining = 0;
    for (let i = 0; i < 600; i++) {
      run(m, 1);
      const mining = m.state.units.filter((u) => u.gatherPhase === GATHER.mining && u.gatherNodeId === node.id).length;
      maxMining = Math.max(maxMining, mining);
    }
    expect(maxMining).toBe(1);
    // 礦點飽和：每 20 tick 最多 5 礦
    expect(p.stats.gathered).toBeLessThanOrEqual(Math.ceil(601 / RULES.economy.mineTicks) * RULES.economy.mineAmount);
    expect(p.stats.gathered).toBeGreaterThan(100);
  });

  it('礦點枯竭時改採同礦區最近的礦點；整區枯竭則閒置並發出事件', () => {
    const map = testMap({ nodes: [[12, 6, 0], [12, 9, 0], [62, 57, 1]] });
    const m = newMatch(map);
    const p = playerAtSlot(m, 0);
    const [n1, n2] = m.state.nodes.filter((n) => n.areaId === 0);
    n1.reserve = 5;
    n2.reserve = 5;
    const w = m.state.units.find((u) => u.owner === p.id)!;
    run(m, 1, { [p.id]: [{ type: 'gather', units: [w.id], nodeId: n1.id }] });
    const ev = run(m, 120);
    expect(n1.reserve).toBe(0);
    expect(ev.get(p.id)!.some((e) => e.type === 'nodeDepleted' && e.nodeId === n1.id)).toBe(true);
    expect(w.gatherNodeId === n2.id || n2.reserve === 0).toBe(true);
    run(m, 200);
    expect(n2.reserve).toBe(0);
    expect(w.order.kind).toBe('idle');
    expect(p.stats.gathered).toBe(10);
  });
});

describe('生產與建造', () => {
  it('生產：立即扣款與人口、120 tick 完成、取消全額退還', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const base = m.state.buildings.find((b) => b.owner === p.id)!;
    const t0 = m.tick;
    run(m, 1, { [p.id]: [{ type: 'train', buildingId: base.id, unit: 'worker' }, { type: 'train', buildingId: base.id, unit: 'worker' }] });
    expect(p.minerals).toBe(0);
    expect(p.supplyUsed).toBe(6);
    alignToDecision(m);
    run(m, 1, { [p.id]: [{ type: 'cancel', buildingId: base.id }] });
    expect(p.minerals).toBe(50);
    expect(p.supplyUsed).toBe(5);
    const ev = run(m, 130);
    const trained = ev.get(p.id)!.find((e) => e.type === 'unitTrained');
    expect(trained?.tick).toBe(t0 + UNIT_STATS.worker.trainTicks - 1);
    expect(m.state.units.filter((u) => u.owner === p.id).length).toBe(5);
  });

  it('生產拒絕：WRONG_PRODUCER、NO_MINERALS、NO_SUPPLY、QUEUE_FULL', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const base = m.state.buildings.find((b) => b.owner === p.id)!;
    const train = { type: 'train' as const, buildingId: base.id, unit: 'worker' as const };
    p.minerals = 0;
    const reasons: string[] = [];
    const collect = (ev: ReturnType<typeof run>): void => {
      for (const e of ev.get(p.id)!) if (e.type === 'commandRejected') reasons.push(e.reason);
    };
    collect(run(m, 1, { [p.id]: [{ type: 'train', buildingId: base.id, unit: 'spear' }, train] }));
    alignToDecision(m);
    p.minerals = 10000;
    p.supplyUsed = 10;
    collect(run(m, 1, { [p.id]: [train] }));
    alignToDecision(m);
    p.supplyUsed = 0;
    p.budget = 5;
    collect(run(m, 1, { [p.id]: [train, train, train, train, train] }));
    alignToDecision(m);
    p.budget = 5;
    collect(run(m, 1, { [p.id]: [train] }));
    alignToDecision(m);
    collect(run(m, 1));
    expect(reasons).toEqual(['WRONG_PRODUCER', 'NO_MINERALS', 'NO_SUPPLY', 'QUEUE_FULL']);
    expect(p.stats.rejections.QUEUE_FULL).toBe(1);
  });

  it('建造：抵達開工才扣款、完工才提供人口、工人完工後閒置', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const w = m.state.units.find((u) => u.owner === p.id)!;
    run(m, 1, { [p.id]: [{ type: 'build', workerId: w.id, building: 'supply', tileX: 10, tileY: 10 }] });
    expect(p.minerals).toBe(100);
    let ticks = 1;
    while (m.state.buildings.length < 3 && ticks < 200) {
      run(m, 1);
      ticks++;
    }
    const b = m.state.buildings.find((x) => x.type === 'supply')!;
    expect(b).toBeDefined();
    expect(p.minerals).toBe(100 - BUILDING_STATS.supply.cost);
    expect(b.hp).toBe(Math.floor(BUILDING_STATS.supply.hp * 10 / 100));
    expect(p.supplyCap).toBe(10);
    const ev = run(m, BUILDING_STATS.supply.buildTicks + 2);
    expect(b.complete).toBe(true);
    expect(b.hp).toBe(BUILDING_STATS.supply.hp);
    expect(p.supplyCap).toBe(18);
    expect(ev.get(p.id)!.some((e) => e.type === 'buildingComplete' && e.id === b.id)).toBe(true);
    expect(w.order.kind).toBe('idle');
  });

  it('建造：取消退還 75%、抵達時礦不足發出 buildFailed、不可放在未探索區域', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const [w1, w2] = m.state.units.filter((u) => u.owner === p.id);
    run(m, 1, { [p.id]: [{ type: 'build', workerId: w1.id, building: 'supply', tileX: 10, tileY: 10 }, { type: 'build', workerId: w2.id, building: 'barracks', tileX: 2, tileY: 10 }, { type: 'build', workerId: w2.id, building: 'barracks', tileX: 40, tileY: 40 }] });
    const ev = run(m, 60);
    const failed = ev.get(p.id)!.find((e) => e.type === 'buildFailed');
    expect(failed).toMatchObject({ type: 'buildFailed', workerId: w2.id, reason: 'NO_MINERALS' });
    expect(p.stats.rejections.BAD_PLACEMENT).toBe(1);
    const b = m.state.buildings.find((x) => x.type === 'supply')!;
    alignToDecision(m);
    const before = p.minerals;
    run(m, 1, { [p.id]: [{ type: 'cancel', buildingId: b.id }] });
    expect(p.minerals - before).toBe(Math.floor(BUILDING_STATS.supply.cost * 75 / 100));
    expect(m.state.buildingById.has(b.id)).toBe(false);
  });
});

describe('指令額度', () => {
  it('令牌桶：容量 5、每 2 tick 回補 1、超出以 NO_BUDGET 拒絕', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const holds = Array.from({ length: 7 }, () => ({ type: 'hold' as const, units: [] as number[] }));
    const ev = run(m, 5, { [p.id]: holds });
    const rejected = ev.get(p.id)!.filter((e) => e.type === 'commandRejected');
    expect(rejected.map((e) => (e.type === 'commandRejected' ? [e.index, e.reason] : null))).toEqual([[5, 'NO_BUDGET'], [6, 'NO_BUDGET']]);
    // tick 5 決策時：tick 2、4 回補 → 2
    m.beginTick();
    expect(m.observe(p.id).obs.commandBudget).toBe(2);
    m.applyCommands(p.id, []);
    m.endTick();
    run(m, 4);
    // tick 10：再回補 6、8、10 → 5
    m.beginTick();
    expect(m.observe(p.id).obs.commandBudget).toBe(5);
    m.endTick();
  });
});

describe('單位 AI', () => {
  it('積極：最多追擊 8 格，超過則放棄並返回', () => {
    const m = newMatch(testMap());
    // 同速的長槍兵逃跑：一直在視野內，追擊者追滿 8 格後放棄
    const s = spawn(m, 0, 'spear', 20000, 30000);
    const c = spawn(m, 1, 'spear', 24000, 30000);
    run(m, 1, { 1: [{ type: 'move', units: [c.id], x: 60000, y: 30000 }] });
    let maxX = 0;
    for (let i = 0; i < 300; i++) {
      run(m, 1);
      maxX = Math.max(maxX, s.x);
    }
    expect(maxX).toBeGreaterThan(24000);
    expect(maxX - 20000).toBeLessThanOrEqual(8 * TILE_SIZE + UNIT_STATS.spear.speed);
    expect(Math.abs(s.x - 20000)).toBeLessThan(TILE_SIZE);
    expect(s.targetId).toBe(0);
  });

  it('防守：只攻擊射程內敵人，離駐守點不超過 3 格', () => {
    const m = newMatch(testMap());
    const s = spawn(m, 0, 'spear', 20000, 30000);
    const far = spawn(m, 1, 'spear', 25000, 30000);
    run(m, 1, { 0: [{ type: 'stance', units: [s.id], stance: 'defensive' }], 1: [{ type: 'hold', units: [far.id] }, { type: 'stance', units: [far.id], stance: 'hold' }] });
    run(m, 20);
    expect(s.x).toBe(20000); // 射程外的敵人不理
    const c = spawn(m, 1, 'cavalry', 20900, 30000);
    alignToDecision(m);
    run(m, 1, { 1: [{ type: 'move', units: [c.id], x: 60000, y: 30000 }] });
    let maxX = 0;
    for (let i = 0; i < 100; i++) {
      run(m, 1);
      maxX = Math.max(maxX, s.x);
    }
    expect(maxX).toBeGreaterThan(20000);
    expect(maxX - 20000).toBeLessThanOrEqual(3 * TILE_SIZE + UNIT_STATS.spear.speed);
  });

  it('堅守：原地不動，只攻擊射程內敵人', () => {
    const m = newMatch(testMap());
    const s = spawn(m, 0, 'spear', 20000, 30000);
    spawn(m, 1, 'archer', 24000, 30000);
    run(m, 1, { 0: [{ type: 'stance', units: [s.id], stance: 'hold' }] });
    run(m, 60);
    expect(s.x).toBe(20000);
    expect(s.y).toBe(30000);
    expect(s.hp).toBeLessThan(UNIT_STATS.spear.hp);
  });

  it('撤退：不自動攻擊', () => {
    const m = newMatch(testMap());
    const s = spawn(m, 0, 'spear', 20000, 30000);
    const e = spawn(m, 1, 'worker', 20700, 30000);
    run(m, 1, { 0: [{ type: 'stance', units: [s.id], stance: 'retreat' }] });
    run(m, 30);
    expect(e.hp).toBe(UNIT_STATS.worker.hp);
  });

  it('工人被攻擊不反擊；工人的 attackMove 視同 move（決策 Q8A）', () => {
    const m = newMatch(testMap());
    const w = spawn(m, 0, 'worker', 20000, 30000);
    const e = spawn(m, 1, 'worker', 20500, 30000);
    run(m, 1, { 1: [{ type: 'attack', units: [e.id], targetId: w.id }], 0: [{ type: 'attackMove', units: [w.id], x: 20000, y: 32000 }] });
    expect(w.order.kind).toBe('move');
    run(m, 20);
    expect(e.hp).toBe(UNIT_STATS.worker.hp);
    expect(w.hp).toBeLessThan(UNIT_STATS.worker.hp);
  });

  it('目標選擇五層順序', () => {
    const m = newMatch(testMap());
    const st = m.state;
    // 1. 正在攻擊自己的敵人優先（即使是工人）
    const a = spawn(m, 0, 'archer', 30000, 30000);
    const atkWorker = spawn(m, 1, 'worker', 34000, 30000);
    spawn(m, 1, 'spear', 32000, 30000);
    atkWorker.lastHitTarget = a.id;
    atkWorker.lastHitTick = st.tick;
    expect(acquireForUnit(st, a, true)).toBe(atkWorker.id);
    atkWorker.lastHitTarget = 0;
    // 2. 戰鬥單位 > 工人
    const spear2 = st.units.find((u) => u.type === 'spear' && u.owner === 1)!;
    expect(acquireForUnit(st, a, true)).toBe(spear2.id);
    // 3. 倍率優勢：長槍兵優先打騎兵（較遠）而非弓兵（較近）
    const sp = spawn(m, 0, 'spear', 10000, 50000);
    const arc = spawn(m, 1, 'archer', 12000, 50000);
    const cav = spawn(m, 1, 'cavalry', 15000, 50000);
    expect(acquireForUnit(st, sp, true)).toBe(cav.id);
    cav.x = 60000;
    st.spatial.rebuild(st.units);
    expect(acquireForUnit(st, sp, true)).toBe(arc.id);
    // 4. 距離較近者優先；5. 同距離 id 較小者優先
    const sp2 = spawn(m, 0, 'spear', 40000, 10000);
    const n1 = spawn(m, 1, 'spear', 43000, 10000);
    const n2 = spawn(m, 1, 'spear', 37000, 10000);
    expect(acquireForUnit(st, sp2, true)).toBe(Math.min(n1.id, n2.id));
    n2.x = 38000;
    st.spatial.rebuild(st.units);
    expect(acquireForUnit(st, sp2, true)).toBe(n2.id);
  });

  it('攻擊需要目標在己方視野內（樹林）', () => {
    const forest: [number, number][] = [];
    for (let x = 33; x <= 40; x++) for (let y = 27; y <= 33; y++) forest.push([x, y]);
    const m = newMatch(testMap({ forest }));
    const a = spawn(m, 0, 'archer', 30500, 30500);
    const hidden = spawn(m, 1, 'spear', 35500, 30500);
    run(m, 1, { 1: [{ type: 'hold', units: [hidden.id] }, { type: 'stance', units: [hidden.id], stance: 'hold' }], 0: [{ type: 'stance', units: [a.id], stance: 'hold' }] });
    run(m, 30);
    expect(hidden.hp).toBe(UNIT_STATS.spear.hp);
    expect(a.hp).toBe(UNIT_STATS.archer.hp);
  });
});

describe('瞭望塔', () => {
  it('佔領 100 tick；他人開始累積時原佔領者立即失去；有多方時進度不變；工人不算', () => {
    const m = newMatch(testMap());
    const t = m.state.towers[0];
    const s0 = spawn(m, 0, 'spear', t.x - 500, t.y);
    spawn(m, 1, 'worker', t.x + 500, t.y);
    run(m, 1, { 0: [{ type: 'hold', units: [s0.id] }, { type: 'stance', units: [s0.id], stance: 'hold' }] });
    const ev = run(m, 99);
    expect(t.owner).toBe(0);
    expect(ev.get(0)!.some((e) => e.type === 'towerChanged' && e.owner === 0)).toBe(true);
    // 多方在場：進度不變
    const s1 = spawn(m, 1, 'spear', t.x, t.y + 2000);
    alignToDecision(m);
    run(m, 1, { 1: [{ type: 'hold', units: [s1.id] }, { type: 'stance', units: [s1.id], stance: 'hold' }] });
    run(m, 5);
    expect(t.owner).toBe(0);
    expect(t.progress[1]).toBe(0);
    // 原佔領者離開，對手開始累積 → 立即失去
    alignToDecision(m);
    s0.x = 5000;
    s0.y = 50000;
    m.state.spatial.rebuild(m.state.units);
    run(m, 1, { 0: [{ type: 'hold', units: [s0.id] }] });
    expect(t.owner).toBe(-1);
    expect(t.progress[0]).toBe(0);
    expect(t.progress[1]).toBe(1);
    run(m, 99);
    expect(t.owner).toBe(1);
  });
});

describe('勝負判定', () => {
  it('主堡全毀即淘汰，1v1 結束', () => {
    const m = newMatch(testMap());
    const p1 = playerAtSlot(m, 1);
    const base = m.state.buildings.find((b) => b.owner === p1.id)!;
    base.hp = 5;
    const s = spawn(m, 1 - p1.id, 'spear', base.tileX * TILE_SIZE - 300, base.tileY * TILE_SIZE + 1500);
    run(m, 1, { [1 - p1.id]: [{ type: 'attack', units: [s.id], targetId: base.id }] });
    run(m, 5);
    expect(m.over).toBe(true);
    expect(p1.alive).toBe(false);
    const r = m.result();
    expect(r.ranking).toEqual([1 - p1.id, p1.id]);
    expect(m.state.units.some((u) => u.owner === p1.id)).toBe(false);
  });

  it('同 tick 淘汰者依資產分數排名', () => {
    const m = newMatch(testMap());
    const bases = m.state.buildings.slice();
    for (const b of bases) b.hp = 5;
    const sA = spawn(m, 1, 'spear', bases[0].tileX * TILE_SIZE - 300, bases[0].tileY * TILE_SIZE + 1500);
    const sB = spawn(m, 0, 'spear', bases[1].tileX * TILE_SIZE - 300, bases[1].tileY * TILE_SIZE + 1500);
    spawn(m, bases[0].owner, 'cavalry', 30000, 30000);
    run(m, 1, { [sA.owner]: [{ type: 'attack', units: [sA.id], targetId: bases[0].id }], [sB.owner]: [{ type: 'attack', units: [sB.id], targetId: bases[1].id }] });
    run(m, 5);
    expect(m.over).toBe(true);
    const r = m.result();
    const e0 = r.players.find((p) => p.playerId === bases[0].owner)!;
    const e1 = r.players.find((p) => p.playerId === bases[1].owner)!;
    expect(e0.eliminatedTick).toBe(e1.eliminatedTick);
    // bases[0] 的擁有者多一隻騎兵 → 資產分數較高 → 名次較前
    expect(e0.rank).toBe(1);
    expect(e0.score).toBeGreaterThan(e1.score);
  });

  it('時限到時依資產分數排名', () => {
    const m = newMatch(testMap());
    spawn(m, 1, 'spear', 30000, 30000);
    run(m, RULES.match.timeLimitTicks + 10);
    expect(m.over).toBe(true);
    const r = m.result();
    expect(r.durationTicks).toBe(RULES.match.timeLimitTicks);
    expect(r.ranking[0]).toBe(1);
  });

  it('4 人局：淘汰者名次依淘汰時間，越晚越前；剩 1 人結束', () => {
    const m = newMatch(testMap({ mode: 'ffa4' }));
    const order = [2, 0, 3];
    for (const pid of order) {
      const base = m.state.buildings.find((b) => b.owner === pid && b.type === 'base')!;
      removeBuilding(m.state, base);
      run(m, 10);
    }
    expect(m.over).toBe(true);
    expect(m.result().ranking).toEqual([1, 3, 0, 2]);
  });
});
