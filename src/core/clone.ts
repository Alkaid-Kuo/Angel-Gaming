// 狀態深拷貝：回放播放器跳轉用的快照。地圖資料不可變，直接共用；路徑快取不拷貝（對結果透明）。
import { PathCache, PathFinder } from '../path/index.ts';
import { Prng } from '../shared/prng.ts';
import { SpatialIndex } from './spatial.ts';
import type { Building, BuildingMemory, MatchState, MineNode, Player, Unit, Watchtower } from './state.ts';

function cloneUnit(u: Unit): Unit {
  return { ...u, order: { ...u.order }, path: u.path === null ? null : u.path.slice() };
}

function cloneBuilding(b: Building): Building {
  return { ...b, queue: b.queue.map((q) => ({ ...q })), task: b.task === null ? null : { ...b.task } };
}

function clonePlayer(p: Player): Player {
  const memory = new Map<number, BuildingMemory>();
  for (const [id, m] of p.memory) memory.set(id, { ...m });
  return {
    ...p,
    knobs: { ...p.knobs },
    research: { ...p.research },
    vis: p.vis.slice(),
    explored: p.explored.slice(),
    exploredDelta: p.exploredDelta.slice(),
    memory,
    nodeKnown: p.nodeKnown.slice(),
    events: p.events.slice(),
    stats: structuredClone(p.stats),
  };
}

export function cloneState(s: MatchState): MatchState {
  const units = s.units.map(cloneUnit);
  const buildings = s.buildings.map(cloneBuilding);
  const nodes: MineNode[] = s.nodes.map((n) => ({ ...n, queue: n.queue.slice() }));
  const towers: Watchtower[] = s.towers.map((t) => ({ ...t, progress: t.progress.slice() }));
  const out: MatchState = {
    ...s,
    rng: Prng.fromState(s.rng.getState()),
    players: s.players.map(clonePlayer),
    units,
    buildings,
    nodes,
    towers,
    unitById: new Map(units.map((u) => [u.id, u])),
    buildingById: new Map(buildings.map((b) => [b.id, b])),
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    walk: s.walk.slice(),
    buildingAt: s.buildingAt.slice(),
    nodeAt: s.nodeAt.slice(),
    pathFinder: new PathFinder(s.width, s.height),
    pathCache: new PathCache(),
    spatial: new SpatialIndex(s.width, s.height),
  };
  out.spatial.rebuild(out.units);
  return out;
}
