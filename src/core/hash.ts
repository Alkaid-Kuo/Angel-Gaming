// 狀態雜湊：涵蓋所有會影響後續模擬的狀態（事件佇列與觀察用的增量除外）。
import { BUILDING_TYPES, RESEARCH_TYPES, STANCES, UNIT_TYPES } from '../config/index.ts';
import { Hasher } from '../shared/hash.ts';
import type { MatchState, UnitOrder } from './state.ts';

const ORDER_CODE: Record<UnitOrder['kind'], number> = { idle: 0, move: 1, attackMove: 2, attack: 3, gather: 4, build: 5, construct: 6 };

function hashOrder(h: Hasher, o: UnitOrder): void {
  h.int(ORDER_CODE[o.kind]);
  switch (o.kind) {
    case 'move':
    case 'attackMove':
      h.int(o.x).int(o.y);
      break;
    case 'attack':
      h.int(o.targetId);
      break;
    case 'gather':
      h.int(o.nodeId);
      break;
    case 'build':
      h.int(BUILDING_TYPES.indexOf(o.building)).int(o.tileX).int(o.tileY);
      break;
    case 'construct':
      h.int(o.buildingId);
      break;
    case 'idle':
      break;
  }
}

export function hashState(state: MatchState): string {
  const h = new Hasher();
  h.int(state.tick).int(state.nextId).int(state.blockVersion).bool(state.over);
  for (const v of state.rng.getState()) h.int(v);
  for (const p of state.players) {
    h.int(p.id).int(p.slot).int(p.minerals).int(p.supplyUsed).int(p.supplyCap).int(p.budget).bool(p.unlimitedBudget);
    h.bool(p.alive).int(p.eliminatedTick).int(p.eliminationScore);
    for (const r of RESEARCH_TYPES) h.int(p.research[r]);
    let explored = 0;
    for (let i = 0; i < p.explored.length; i++) explored += p.explored[i];
    h.int(explored).int(p.memory.size);
  }
  h.int(state.units.length);
  for (const u of state.units) {
    h.int(u.id).int(u.owner).int(UNIT_TYPES.indexOf(u.type)).int(u.x).int(u.y).int(u.hp);
    h.int(STANCES.indexOf(u.stance)).int(u.group);
    hashOrder(h, u.order);
    h.int(u.guardX).int(u.guardY).int(u.targetId).int(u.chaseX).int(u.chaseY).bool(u.returning);
    h.int(u.nextAttackTick).int(u.lastHitTarget).int(u.lastHitTick);
    h.int(u.carry).int(u.carryRich).int(u.gatherNodeId).int(u.gatherPhase).int(u.mineEndTick);
    h.int(u.path === null ? -1 : u.path.length).int(u.pathIdx).int(u.stuckTicks).int(u.moveKey).int(u.moveBest).int(u.moveStall);
  }
  h.int(state.buildings.length);
  for (const b of state.buildings) {
    h.int(b.id).int(b.owner).int(BUILDING_TYPES.indexOf(b.type)).int(b.tileX).int(b.tileY).int(b.hp);
    h.bool(b.complete).int(b.progress).int(b.builderId).int(b.queue.length);
    for (const q of b.queue) h.int(UNIT_TYPES.indexOf(q.unit)).int(q.progress);
    h.bool(b.hasRally).int(b.rallyX).int(b.rallyY).int(b.targetId).int(b.nextAttackTick);
    h.int(b.level).int(b.maxHp);
    if (b.task === null) h.int(-1);
    else h.int(b.task.kind === 'upgrade' ? 0 : 1 + RESEARCH_TYPES.indexOf(b.task.research)).int(b.task.progress).int(b.task.total).int(b.task.cost);
  }
  for (const n of state.nodes) {
    h.int(n.id).int(n.reserve).int(n.minerId).int(n.queue.length);
    for (const q of n.queue) h.int(q);
  }
  for (const t of state.towers) {
    h.int(t.id).int(t.owner);
    for (const v of t.progress) h.int(v);
  }
  return h.digest();
}
