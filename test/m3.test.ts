import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { BASE_UPGRADES, BUILDING_STATS, RESEARCH, TILE_SIZE, UNIT_STATS } from '../src/config/index.ts';
import { damageWith } from '../src/core/combat.ts';
import { createBuilding } from '../src/core/world.ts';
import { BatchController, resolveKnobs } from '../src/sandbox/controller.ts';
import { loadBotFile } from '../src/sandbox/node-loader.ts';
import { runMatch } from '../src/sandbox/runner.ts';
import { alignToDecision, newMatch, playerAtSlot, run, spawn, testMap } from './helpers.ts';

describe('主堡升級（M3 提案）', () => {
  it('扣款、升級期間生產暫停、完成後等級與血量提升並發出事件', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const base = m.state.buildings.find((b) => b.owner === p.id && b.type === 'base')!;
    p.minerals = 1000;
    run(m, 1, { [p.id]: [{ type: 'upgrade', buildingId: base.id }, { type: 'train', buildingId: base.id, unit: 'worker' }] });
    expect(p.minerals).toBe(1000 - BASE_UPGRADES[0].cost - UNIT_STATS.worker.cost);
    expect(base.task?.kind).toBe('upgrade');
    const ev = run(m, BASE_UPGRADES[0].ticks + 5);
    expect(base.level).toBe(2);
    expect(base.maxHp).toBe(BASE_UPGRADES[0].maxHp);
    expect(base.hp).toBe(BASE_UPGRADES[0].maxHp);
    expect(ev.get(p.id)!.some((e) => e.type === 'upgradeComplete' && e.level === 2)).toBe(true);
    // 升級期間工人沒有生產完成；升級結束後才開始計算生產時間
    expect(ev.get(p.id)!.some((e) => e.type === 'unitTrained')).toBe(false);
    const ev2 = run(m, UNIT_STATS.worker.trainTicks);
    expect(ev2.get(p.id)!.some((e) => e.type === 'unitTrained')).toBe(true);
  });

  it('鍛造所與攻城工坊需要主堡 Lv2（NO_TECH）', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    const w = m.state.units.find((u) => u.owner === p.id)!;
    p.minerals = 1000;
    run(m, 1, { [p.id]: [{ type: 'build', workerId: w.id, building: 'forge', tileX: 10, tileY: 10 }] });
    expect(p.stats.rejections.NO_TECH).toBe(1);
    const base = m.state.buildings.find((b) => b.owner === p.id && b.type === 'base')!;
    base.level = 2;
    alignToDecision(m);
    run(m, 1, { [p.id]: [{ type: 'build', workerId: w.id, building: 'forge', tileX: 10, tileY: 10 }] });
    expect(p.stats.rejections.NO_TECH).toBe(1);
    expect(w.order.kind).toBe('build');
  });
});

describe('研究（M3 提案）', () => {
  it('武器與護甲改變傷害：max(1, (攻擊＋加成) × 倍率 − 護甲)', () => {
    expect(damageWith('spear', 'cavalry', 0, 0)).toBe(20);
    expect(damageWith('spear', 'cavalry', 1, 0)).toBe(22);
    expect(damageWith('spear', 'cavalry', 2, 2)).toBe(22);
    expect(damageWith('archer', 'spear', 0, 1)).toBe(7);
    expect(damageWith('worker', 'spear', 2, 0)).toBe(4); // 工人不吃武器研究
    expect(damageWith('archer', 'building', 0, 0)).toBe(4);
    expect(damageWith('worker', 'spear', 0, 10)).toBe(1); // 最低 1
  });

  it('研究需要科技等級、同一研究不可同時進行、完成後等級提升', () => {
    const m = newMatch(testMap());
    const p = playerAtSlot(m, 0);
    p.minerals = 2000;
    const forge = createBuilding(m.state, p.id, 'forge', 12, 12, true);
    const forge2 = createBuilding(m.state, p.id, 'forge', 16, 12, true);
    run(m, 1, { [p.id]: [{ type: 'research', buildingId: forge.id, research: 'weapons' }] });
    expect(p.stats.rejections.NO_TECH).toBe(1);
    const base = m.state.buildings.find((b) => b.owner === p.id && b.type === 'base')!;
    base.level = 2;
    alignToDecision(m);
    run(m, 1, { [p.id]: [{ type: 'research', buildingId: forge.id, research: 'weapons' }, { type: 'research', buildingId: forge2.id, research: 'weapons' }, { type: 'research', buildingId: forge2.id, research: 'armor' }] });
    expect(p.stats.rejections.INVALID_TARGET).toBe(1);
    const ev = run(m, RESEARCH.weapons.levels[0].ticks + 5);
    expect(p.research.weapons).toBe(1);
    expect(p.research.armor).toBe(1);
    expect(ev.get(p.id)!.filter((e) => e.type === 'researchComplete').length).toBe(2);
    // 第二級需要 Lv3
    alignToDecision(m);
    run(m, 1, { [p.id]: [{ type: 'research', buildingId: forge.id, research: 'weapons' }] });
    expect(p.stats.rejections.NO_TECH).toBe(2);
  });
});

describe('攻城車（M3 提案）', () => {
  it('只攻擊建築，對建築 400%；指定攻擊單位會被忽略', () => {
    const m = newMatch(testMap());
    const p1 = playerAtSlot(m, 1);
    const p0 = playerAtSlot(m, 0);
    const base = m.state.buildings.find((b) => b.owner === p1.id && b.type === 'base')!;
    const siege = spawn(m, p0.id, 'siege', base.tileX * TILE_SIZE - 600, base.tileY * TILE_SIZE + 1500);
    const enemy = spawn(m, p1.id, 'worker', siege.x - 800, siege.y);
    run(m, 1, { [p0.id]: [{ type: 'attack', units: [siege.id], targetId: enemy.id }] });
    expect(siege.order.kind).toBe('idle');
    const hp0 = base.hp;
    run(m, UNIT_STATS.siege.cooldown + 2);
    expect(enemy.hp).toBe(UNIT_STATS.worker.hp);
    expect(hp0 - base.hp).toBeGreaterThanOrEqual(UNIT_STATS.siege.attack * 4);
    expect(BUILDING_STATS.workshop.produces).toContain('siege');
  });
});

describe('8 人局（M3 提案）', () => {
  it('8 隻基準 Bot 可正常完成比賽', async () => {
    const f = loadBotFile(resolve('bots/baseline.js'));
    const controllers = Array.from({ length: 8 }, () => new BatchController(f.compiled, f.label));
    const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
    const out = await runMatch({ mode: 'ffa8', seed: 3, controllers, knobs, record: false });
    for (const rt of out.runtime) expect(rt.exceptions).toBe(0);
    expect(out.result.players.length).toBe(8);
    expect(new Set(out.result.players.map((p) => p.rank)).size).toBe(8);
  });
});

describe('M3 新內容的確定性', () => {
  it('使用升級、研究、攻城車的對局，回放連跑 3 次雜湊一致', async () => {
    const { compileBot } = await import('../src/sandbox/compile.ts');
    const { runReplay } = await import('../src/replay/index.ts');
    // 測試選手：採礦 → 升級主堡 → 鍛造所＋攻城工坊 → 研究 → 攻城車進攻
    const src = `
export default class TechBot {
  constructor() { this.data = null; this.step = 0; }
  declare() { return { name: 'Tech', style: '', knobs: [
    { key: 'a', name: 'a', description: '', min: 0, max: 1, default: 0, integer: true },
    { key: 'b', name: 'b', description: '', min: 0, max: 1, default: 0, integer: true },
    { key: 'c', name: 'c', description: '', min: 0, max: 1, default: 0, integer: true }] }; }
  init(data, helpers) { this.data = data; this.h = helpers; }
  decide(obs) {
    const cmds = [];
    const push = (c) => { if (cmds.length < obs.commandBudget) cmds.push(c); };
    const main = this.data.mineAreas.find((a) => a.kind === 'main' && a.owner === this.data.me);
    const nodes = this.data.mineNodes.filter((n) => n.areaId === main.areaId);
    const workers = obs.myUnits.filter((u) => u.type === 'worker');
    const idle = workers.filter((u) => u.order.type === 'idle');
    if (idle.length > 0) push({ type: 'gather', units: idle.map((u) => u.id), nodeId: nodes[obs.tick % nodes.length].id });
    const base = obs.myBuildings.find((b) => b.type === 'base' && b.complete);
    if (!base) return cmds;
    if (base.level < 3 && base.task === null && obs.minerals >= 250) push({ type: 'upgrade', buildingId: base.id });
    if (workers.length < 10 && base.queue.length === 0 && base.task === null && obs.minerals >= 50) push({ type: 'train', buildingId: base.id, unit: 'worker' });
    const s = this.data.startSlots.find((x) => x.playerId === this.data.me);
    const building = workers.some((w) => w.order.type === 'build' || w.order.type === 'construct');
    for (const type of building ? [] : ['forge', 'workshop', 'supply']) {
      const have = type !== 'supply' ? obs.myBuildings.some((b) => b.type === type) : obs.supplyCap - obs.supplyUsed > 3;
      if (have || obs.tech.level < (type === 'supply' ? 1 : 2) || obs.minerals < 150) continue;
      let placed = false;
      for (let dy = -7; dy <= 7 && !placed; dy++) {
        for (let dx = -7; dx <= 7 && !placed; dx++) {
          const x = s.tileX + dx, y = s.tileY + dy;
          if (Math.abs(dx) < 4 && Math.abs(dy) < 4) continue;
          if (workers[0] && this.h.canPlace(type, x, y)) { push({ type: 'build', workerId: workers[0].id, building: type, tileX: x, tileY: y }); placed = true; }
        }
      }
      if (placed) break;
    }
    const forge = obs.myBuildings.find((b) => b.type === 'forge' && b.complete);
    if (forge && forge.task === null && obs.minerals >= 100) push({ type: 'research', buildingId: forge.id, research: obs.tech.armor <= obs.tech.weapons ? 'armor' : 'weapons' });
    const shop = obs.myBuildings.find((b) => b.type === 'workshop' && b.complete);
    if (shop && shop.queue.length < 2 && obs.minerals >= 150) push({ type: 'train', buildingId: shop.id, unit: 'siege' });
    const sieges = obs.myUnits.filter((u) => u.type === 'siege' && u.order.type === 'idle');
    const enemy = this.data.startSlots.find((x) => x.playerId !== this.data.me);
    if (sieges.length >= 2) push({ type: 'attackMove', units: sieges.map((u) => u.id), x: enemy.tileX * 1000 + 1500, y: enemy.tileY * 1000 + 1500 });
    return cmds;
  }
}`;
    const compiled = compileBot(src, 'tech.js');
    const controllers = [new BatchController(compiled, 'tech.js'), new BatchController(compiled, 'tech.js')];
    const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
    const live = await runMatch({ mode: '1v1', seed: 17, controllers, knobs, record: true });
    for (const rt of live.runtime) expect(rt.exceptions).toBe(0);
    const stats = live.result.players.map((p) => p.stats);
    expect(stats.some((s) => s.upgrades > 0)).toBe(true);
    expect(stats.some((s) => s.researches > 0)).toBe(true);
    expect(stats.some((s) => s.unitsProduced.siege > 0)).toBe(true);
    for (let i = 0; i < 3; i++) {
      const r = runReplay(live.replay!, true);
      expect(r.hashes).toEqual(live.replay!.hashes);
      expect(r.finalHash).toBe(live.finalHash);
    }
  });
});
