// 觀察資料：每次決策時為選手建立全新的物件（等同深拷貝，選手修改不影響引擎）。
import type {
  EnemyBuildingView,
  EnemyUnitView,
  MyBuildingView,
  MyUnitView,
  Observation,
  RememberedBuildingView,
  UnitOrderView,
} from '../api/types.ts';
import { BUILDING_STATS, UNIT_STATS } from '../config/index.ts';
import { idiv } from '../shared/intmath.ts';
import type { MatchState, Unit } from './state.ts';
import { buildingVisibleTo, tileIndex, unitVisibleTo } from './world.ts';

function orderView(u: Unit): UnitOrderView {
  const o = u.order;
  switch (o.kind) {
    case 'idle':
      return { type: 'idle' };
    case 'move':
      return { type: 'move', x: o.x, y: o.y };
    case 'attackMove':
      return { type: 'attackMove', x: o.x, y: o.y };
    case 'attack':
      return { type: 'attack', targetId: o.targetId };
    case 'gather':
      return { type: 'gather', nodeId: o.nodeId };
    case 'build':
      return { type: 'build', building: o.building, tileX: o.tileX, tileY: o.tileY };
    case 'construct':
      return { type: 'construct', buildingId: o.buildingId };
  }
}

export interface ObservationPacket {
  readonly obs: Observation;
  /** 上次觀察後新探索的格（供輔助工具 canPlace 使用） */
  readonly exploredDelta: number[];
}

export function buildObservation(state: MatchState, playerId: number): ObservationPacket {
  const p = state.players[playerId];
  const myUnits: MyUnitView[] = [];
  const enemyUnits: EnemyUnitView[] = [];
  for (const u of state.units) {
    if (u.owner === playerId) {
      myUnits.push({
        id: u.id,
        type: u.type,
        x: u.x,
        y: u.y,
        hp: u.hp,
        stance: u.stance,
        group: u.group >= 0 ? u.group : null,
        order: orderView(u),
        carrying: u.carry,
        gatherNodeId: u.gatherNodeId !== 0 ? u.gatherNodeId : null,
      });
    } else if (unitVisibleTo(state, p, u)) {
      enemyUnits.push({ id: u.id, owner: u.owner, type: u.type, x: u.x, y: u.y, hp: u.hp });
    }
  }
  const myBuildings: MyBuildingView[] = [];
  const enemyBuildings: EnemyBuildingView[] = [];
  for (const b of state.buildings) {
    const progress = b.complete ? 100 : idiv(b.progress * 100, BUILDING_STATS[b.type].buildTicks);
    if (b.owner === playerId) {
      myBuildings.push({
        id: b.id,
        type: b.type,
        tileX: b.tileX,
        tileY: b.tileY,
        hp: b.hp,
        complete: b.complete,
        progress,
        queue: b.queue.map((q) => ({ unit: q.unit, progress: idiv(q.progress * 100, UNIT_STATS[q.unit].trainTicks) })),
        rally: b.hasRally ? { x: b.rallyX, y: b.rallyY } : null,
      });
    } else if (buildingVisibleTo(state, p, b)) {
      enemyBuildings.push({ id: b.id, owner: b.owner, type: b.type, tileX: b.tileX, tileY: b.tileY, hp: b.hp, complete: b.complete, progress });
    }
  }
  const rememberedBuildings: RememberedBuildingView[] = [];
  for (const m of p.memory.values()) {
    if (m.visibleNow) continue;
    rememberedBuildings.push({
      id: m.id,
      owner: m.owner,
      type: m.type,
      tileX: m.tileX,
      tileY: m.tileY,
      hp: m.hp,
      complete: m.complete,
      progress: m.progressPercent,
      lastSeenTick: m.lastSeenTick,
    });
  }
  rememberedBuildings.sort((a, b) => a.id - b.id);
  const obs: Observation = {
    tick: state.tick,
    minerals: p.minerals,
    supplyUsed: p.supplyUsed,
    supplyCap: p.supplyCap,
    myUnits,
    myBuildings,
    enemyUnits,
    enemyBuildings,
    rememberedBuildings,
    mineNodes: state.nodes.map((n) => ({ id: n.id, reserve: p.nodeKnown[n.index] })),
    watchtowers: state.towers.map((t) => {
      const visible = p.vis[tileIndex(state, t.x, t.y)] > 0;
      return { id: t.id, visible, owner: visible && t.owner >= 0 ? t.owner : null, myProgress: t.progress[playerId] };
    }),
    alivePlayers: state.players.filter((q) => q.alive).map((q) => q.id),
    events: p.events,
    knobs: { ...p.knobs },
    commandBudget: p.budget,
  };
  p.events = [];
  const exploredDelta = p.exploredDelta;
  p.exploredDelta = [];
  return { obs, exploredDelta };
}

/** 回放重建時不需要觀察資料：只清掉累積的事件與探索增量 */
export function discardObservation(state: MatchState, playerId: number): void {
  const p = state.players[playerId];
  p.events = [];
  p.exploredDelta = [];
}
