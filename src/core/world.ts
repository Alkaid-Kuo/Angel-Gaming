// 狀態操作的共用工具：座標換算、可見性、實體新增／移除、人口、事件。
import type { GameEvent } from '../api/types.ts';
import { BUILDING_STATS, RULES, TERRAIN, TILE_SIZE, UNIT_STATS, type BuildingType, type UnitType } from '../config/index.ts';
import { idiv, pointRectDistSq } from '../shared/intmath.ts';
import { WALK_BLOCKED, WALK_FOREST, WALK_PLAIN } from '../path/index.ts';
import { applyVision } from './vision.ts';
import { GATHER, type Building, type MatchState, type Player, type Unit } from './state.ts';

export const HALF_TILE = TILE_SIZE >> 1;

export function toTile(u: number): number {
  return idiv(u, TILE_SIZE);
}

export function tileIndex(state: MatchState, x: number, y: number): number {
  return toTile(y) * state.width + toTile(x);
}

export function inMap(state: MatchState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width * TILE_SIZE && y < state.height * TILE_SIZE;
}

/** 該位置（單位座標）是否可站立：界內且所在格可通行 */
export function standable(state: MatchState, x: number, y: number): boolean {
  if (!inMap(state, x, y)) return false;
  return state.walk[tileIndex(state, x, y)] !== WALK_BLOCKED;
}

export function terrainWalk(code: number): number {
  return code === TERRAIN.blocked ? WALK_BLOCKED : code === TERRAIN.forest ? WALK_FOREST : WALK_PLAIN;
}

// ───────── 建築幾何 ─────────

export function buildingRectX0(b: Building): number {
  return b.tileX * TILE_SIZE;
}
export function buildingRectY0(b: Building): number {
  return b.tileY * TILE_SIZE;
}
export function buildingRectX1(b: Building): number {
  return (b.tileX + b.size) * TILE_SIZE - 1;
}
export function buildingRectY1(b: Building): number {
  return (b.tileY + b.size) * TILE_SIZE - 1;
}

export function buildingCenterX(b: Building): number {
  return b.tileX * TILE_SIZE + idiv(b.size * TILE_SIZE, 2);
}
export function buildingCenterY(b: Building): number {
  return b.tileY * TILE_SIZE + idiv(b.size * TILE_SIZE, 2);
}

/** 點到建築矩形的距離平方 */
export function distSqToBuilding(x: number, y: number, b: Building): number {
  return pointRectDistSq(x, y, buildingRectX0(b), buildingRectY0(b), buildingRectX1(b), buildingRectY1(b));
}

/** 點到 1 格矩形（礦點）的距離平方 */
export function distSqToTileRect(x: number, y: number, tileX: number, tileY: number, size: number): number {
  return pointRectDistSq(x, y, tileX * TILE_SIZE, tileY * TILE_SIZE, (tileX + size) * TILE_SIZE - 1, (tileY + size) * TILE_SIZE - 1);
}

// ───────── 可見性 ─────────

export function unitVisibleTo(state: MatchState, p: Player, u: Unit): boolean {
  return p.vis[tileIndex(state, u.x, u.y)] > 0;
}

/** 建築任一佔用格可見即視為可見 */
export function buildingVisibleTo(state: MatchState, p: Player, b: Building): boolean {
  const w = state.width;
  for (let y = b.tileY; y < b.tileY + b.size; y++) {
    for (let x = b.tileX; x < b.tileX + b.size; x++) {
      if (p.vis[y * w + x] > 0) return true;
    }
  }
  return false;
}

// ───────── 事件 ─────────

export function emit(state: MatchState, playerId: number, ev: GameEvent): void {
  if (!state.recordEvents) return;
  const p = state.players[playerId];
  if (!p.alive) return;
  p.events.push(ev);
  state.eventTap?.(playerId, ev);
}

export function emitAll(state: MatchState, ev: GameEvent): void {
  for (const p of state.players) emit(state, p.id, ev);
}

// ───────── 人口 ─────────

export function recomputeSupplyCap(state: MatchState, p: Player): void {
  let cap = 0;
  for (const b of state.buildings) {
    if (b.owner === p.id && b.complete) cap += BUILDING_STATS[b.type].supplyProvided;
  }
  p.supplyCap = Math.min(cap, RULES.supply.hardCap);
}

// ───────── 實體新增 ─────────

export function createUnit(state: MatchState, owner: number, type: UnitType, x: number, y: number): Unit {
  const id = state.nextId++;
  const u: Unit = {
    id,
    owner,
    type,
    x,
    y,
    hp: UNIT_STATS[type].hp,
    stance: 'aggressive',
    group: -1,
    order: { kind: 'idle' },
    guardX: x,
    guardY: y,
    path: null,
    pathIdx: 0,
    pathKey: -1,
    pathBlockVersion: 0,
    pathTick: 0,
    destX: x,
    destY: y,
    destRectX: 0,
    destRectY: 0,
    destRectSize: 0,
    wantMove: false,
    arrived: false,
    stuckTicks: 0,
    targetId: 0,
    chaseX: x,
    chaseY: y,
    returning: false,
    nextAttackTick: 0,
    attackTarget: 0,
    lastHitTarget: 0,
    lastHitTick: -1000,
    carry: 0,
    carryRich: 0,
    gatherNodeId: 0,
    gatherPhase: GATHER.none,
    mineEndTick: 0,
    visTile: -1,
    visRadius: 0,
    scoutMask: 0,
  };
  state.units.push(u);
  state.unitById.set(id, u);
  return u;
}

export function createBuilding(state: MatchState, owner: number, type: BuildingType, tileX: number, tileY: number, complete: boolean): Building {
  const st = BUILDING_STATS[type];
  const id = state.nextId++;
  const b: Building = {
    id,
    owner,
    type,
    tileX,
    tileY,
    size: st.size,
    hp: complete ? st.hp : constructionHp(type, 0),
    maxHp: st.hp,
    complete,
    progress: complete ? st.buildTicks : 0,
    builderId: 0,
    queue: [],
    hasRally: false,
    rallyX: 0,
    rallyY: 0,
    targetId: 0,
    attackTarget: 0,
    nextAttackTick: 0,
    lastHitTarget: 0,
    lastHitTick: -1000,
    visTile: -1,
    visRadius: 0,
    visCorner: st.size % 2 === 0,
  };
  state.buildings.push(b);
  state.buildingById.set(id, b);
  const w = state.width;
  for (let y = tileY; y < tileY + st.size; y++) {
    for (let x = tileX; x < tileX + st.size; x++) {
      const i = y * w + x;
      state.buildingAt[i] = id;
      state.walk[i] = WALK_BLOCKED;
    }
  }
  state.blockVersion += 1;
  state.pathCache.clear();
  pushUnitsOutOfBuilding(state, b);
  if (complete) recomputeSupplyCap(state, state.players[owner]);
  return b;
}

/** 建造進度 p tick 時的血量：從 10% 線性增加到 100% */
export function constructionHp(type: BuildingType, progress: number): number {
  const st = BUILDING_STATS[type];
  const startPct = RULES.construction.startHpPercent;
  return idiv(st.hp * (startPct * st.buildTicks + (100 - startPct) * progress), 100 * st.buildTicks);
}

/** 新建築佔用格上的單位推到最近的可站立格中心 */
function pushUnitsOutOfBuilding(state: MatchState, b: Building): void {
  for (const u of state.units) {
    if (state.buildingAt[tileIndex(state, u.x, u.y)] !== b.id) continue;
    const spot = nearestFreeTileAround(state, b.tileX, b.tileY, b.size, u.x, u.y);
    if (spot >= 0) {
      const tx = spot % state.width;
      u.x = tx * TILE_SIZE + HALF_TILE;
      u.y = ((spot - tx) / state.width) * TILE_SIZE + HALF_TILE;
      u.path = null;
    }
  }
}

/** 矩形外圈（逐圈往外）最接近 (px, py) 的可通行格；找不到回傳 -1 */
export function nearestFreeTileAround(state: MatchState, tileX: number, tileY: number, size: number, px: number, py: number): number {
  const w = state.width;
  const h = state.height;
  for (let ring = 1; ring <= 4; ring++) {
    let best = -1;
    let bestD = Infinity;
    for (let y = tileY - ring; y < tileY + size + ring; y++) {
      for (let x = tileX - ring; x < tileX + size + ring; x++) {
        if (x > tileX - ring && x < tileX + size + ring - 1 && y > tileY - ring && y < tileY + size + ring - 1) continue;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (state.walk[i] === WALK_BLOCKED) continue;
        const cx = x * TILE_SIZE + HALF_TILE;
        const cy = y * TILE_SIZE + HALF_TILE;
        const d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
        if (d < bestD || (d === bestD && i < best)) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// ───────── 實體移除 ─────────

/** 移除單位（死亡或淘汰）：清除礦點、建造、視野、人口 */
export function removeUnit(state: MatchState, u: Unit): void {
  const p = state.players[u.owner];
  detachWorker(state, u);
  if (u.visTile >= 0) {
    applyVision(state, p, u.visTile, u.visRadius, false, -1);
    u.visTile = -1;
  }
  p.supplyUsed -= UNIT_STATS[u.type].supply;
  state.unitById.delete(u.id);
  state.units = state.units.filter((x) => x !== u);
}

/** 工人離開目前的採集或建造工作 */
export function detachWorker(state: MatchState, u: Unit): void {
  if (u.gatherNodeId !== 0) {
    const node = state.nodeById.get(u.gatherNodeId)!;
    if (node.minerId === u.id) node.minerId = 0;
    const qi = node.queue.indexOf(u.id);
    if (qi >= 0) node.queue.splice(qi, 1);
  }
  if (u.order.kind === 'construct') {
    const b = state.buildingById.get(u.order.buildingId);
    if (b !== undefined && b.builderId === u.id) b.builderId = 0;
  }
}

/** 移除建築（摧毀、取消、淘汰）：恢復通行、視野、人口、佇列人口 */
export function removeBuilding(state: MatchState, b: Building): void {
  const p = state.players[b.owner];
  const w = state.width;
  for (let y = b.tileY; y < b.tileY + b.size; y++) {
    for (let x = b.tileX; x < b.tileX + b.size; x++) {
      const i = y * w + x;
      state.buildingAt[i] = 0;
      state.walk[i] = terrainWalk(state.map.tiles[i]);
    }
  }
  state.pathCache.clear();
  if (b.visTile >= 0) {
    applyVision(state, p, b.visTile, b.visRadius, b.visCorner, -1);
    b.visTile = -1;
  }
  for (const q of b.queue) p.supplyUsed -= UNIT_STATS[q.unit].supply;
  b.queue = [];
  if (b.builderId !== 0) {
    const worker = state.unitById.get(b.builderId);
    if (worker !== undefined && worker.order.kind === 'construct') setIdle(worker);
  }
  state.buildingById.delete(b.id);
  state.buildings = state.buildings.filter((x) => x !== b);
  if (b.complete) recomputeSupplyCap(state, p);
}

/** 單位改為閒置，駐守點設為目前位置 */
export function setIdle(u: Unit): void {
  u.order = { kind: 'idle' };
  u.guardX = u.x;
  u.guardY = u.y;
  u.chaseX = u.x;
  u.chaseY = u.y;
  u.returning = false;
  u.targetId = 0;
  u.path = null;
  u.gatherPhase = GATHER.none;
}

export function isWorker(u: Unit): boolean {
  return u.type === 'worker';
}

/** 資產分數：存活單位成本 ＋ 已完工建築成本 */
export function assetScore(state: MatchState, playerId: number): number {
  let score = 0;
  for (const u of state.units) if (u.owner === playerId) score += UNIT_STATS[u.type].cost;
  for (const b of state.buildings) if (b.owner === playerId && b.complete) score += BUILDING_STATS[b.type].cost;
  return score;
}
