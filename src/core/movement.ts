// 移動：A* 路徑（拉直轉角）、追擊時視線無阻擋則直接朝目標走（決策 Q7C）、碰撞推擠。
import { RULES, TERRAIN, TILE_SIZE, UNIT_STATS } from '../config/index.ts';
import { applyPercent, clamp, isqrt, tdiv } from '../shared/intmath.ts';
import { segmentClear, smoothPath, type GoalRect } from '../path/index.ts';
import { GATHER, type MatchState, type Unit } from './state.ts';
import { HALF_TILE, standable, tileIndex, toTile } from './world.ts';

const KEY_POINT_SCALE = 131072;
/** 追擊時直接朝目標移動的路徑鍵值 */
const KEY_DIRECT = -2;
const STUCK_REPATH_TICKS = 10;
const MAX_RADIUS = Math.max(...Object.values(UNIT_STATS).map((s) => s.radius));

/** 要求單位本 tick 朝某點移動；目的地改變時重算路徑 */
export function moveToPoint(u: Unit, x: number, y: number): void {
  const key = x * KEY_POINT_SCALE + y;
  if (u.pathKey !== key || pathFinished(u)) {
    u.pathKey = key;
    u.path = null;
    u.destX = x;
    u.destY = y;
    u.destRectSize = 0;
  }
  u.wantMove = true;
}

/** 路徑已走完但仍要求移動（例如被推離終點）：需重算 */
function pathFinished(u: Unit): boolean {
  return u.path !== null && u.pathIdx >= u.path.length;
}

/** 要求單位本 tick 走向某個矩形（礦點、建築）旁 */
export function moveToRect(u: Unit, tileX: number, tileY: number, size: number, mapWidth: number): void {
  const key = -((tileY * mapWidth + tileX) * 8 + size) - 10;
  if (u.pathKey !== key || pathFinished(u)) {
    u.pathKey = key;
    u.path = null;
    u.destRectX = tileX;
    u.destRectY = tileY;
    u.destRectSize = size;
  }
  u.wantMove = true;
}

/** 追擊移動中的目標：視線無阻擋就直線前進，否則依 A* 並限制重算頻率 */
export function chasePoint(state: MatchState, u: Unit, x: number, y: number): void {
  u.wantMove = true;
  if (segmentClear(gridOf(state), u.x, u.y, x, y, true)) {
    u.pathKey = KEY_DIRECT;
    u.path = [x, y];
    u.pathIdx = 0;
    u.pathBlockVersion = state.blockVersion;
    return;
  }
  const key = -(1_000_000_000 + toTile(y) * state.width + toTile(x));
  const stale = u.path === null || u.pathKey === KEY_DIRECT || (u.pathKey !== key && state.tick - u.pathTick >= RULES.movement.chaseRepathTicks);
  if (stale) {
    u.pathKey = key;
    u.path = null;
    u.destX = x;
    u.destY = y;
    u.destRectSize = 0;
  }
}

/** 單位目前的路徑是否就是前往點 (x, y) */
export function isPathTo(u: Unit, x: number, y: number): boolean {
  return u.pathKey === x * KEY_POINT_SCALE + y;
}

export function stopMoving(u: Unit): void {
  u.wantMove = false;
}

function gridOf(state: MatchState): { width: number; height: number; walk: Uint8Array } {
  return { width: state.width, height: state.height, walk: state.walk };
}

function computePath(state: MatchState, u: Unit): void {
  const w = state.width;
  const h = state.height;
  const startIdx = tileIndex(state, u.x, u.y);
  let goal: GoalRect;
  let targetX: number;
  let targetY: number;
  if (u.destRectSize > 0) {
    goal = {
      x0: clamp(u.destRectX - 1, 0, w - 1),
      y0: clamp(u.destRectY - 1, 0, h - 1),
      x1: clamp(u.destRectX + u.destRectSize, 0, w - 1),
      y1: clamp(u.destRectY + u.destRectSize, 0, h - 1),
    };
    targetX = clamp(u.x, u.destRectX * TILE_SIZE, (u.destRectX + u.destRectSize) * TILE_SIZE - 1);
    targetY = clamp(u.y, u.destRectY * TILE_SIZE, (u.destRectY + u.destRectSize) * TILE_SIZE - 1);
  } else {
    const gx = toTile(u.destX);
    const gy = toTile(u.destY);
    const blocked = state.walk[gy * w + gx] === 0;
    goal = blocked
      ? { x0: clamp(gx - 1, 0, w - 1), y0: clamp(gy - 1, 0, h - 1), x1: clamp(gx + 1, 0, w - 1), y1: clamp(gy + 1, 0, h - 1) }
      : { x0: gx, y0: gy, x1: gx, y1: gy };
    targetX = u.destX;
    targetY = u.destY;
  }
  const res = state.pathCache.find(state.pathFinder, gridOf(state), startIdx, goal);
  const endIdx = res.tiles.length > 0 ? res.tiles[res.tiles.length - 1] : startIdx;
  const ex = endIdx % w;
  const ey = (endIdx - ex) / w;
  let finalX: number;
  let finalY: number;
  if (res.reached && u.destRectSize === 0 && state.walk[toTile(u.destY) * w + toTile(u.destX)] !== 0) {
    finalX = u.destX;
    finalY = u.destY;
  } else if (res.reached) {
    // 終點格內最接近目標的點
    finalX = clamp(targetX, ex * TILE_SIZE, ex * TILE_SIZE + TILE_SIZE - 1);
    finalY = clamp(targetY, ey * TILE_SIZE, ey * TILE_SIZE + TILE_SIZE - 1);
  } else {
    finalX = ex * TILE_SIZE + HALF_TILE;
    finalY = ey * TILE_SIZE + HALF_TILE;
  }
  u.path = res.tiles.length === 0 ? [finalX, finalY] : smoothPath(gridOf(state), u.x, u.y, res.tiles, finalX, finalY);
  u.pathIdx = 0;
  u.pathBlockVersion = state.blockVersion;
  u.pathTick = state.tick;
  u.stuckTicks = 0;
}

/** 快取的路徑是否被之後新蓋的建築擋住 */
function pathStillClear(state: MatchState, u: Unit): boolean {
  const path = u.path!;
  let ax = u.x;
  let ay = u.y;
  for (let i = u.pathIdx; i < path.length; i += 2) {
    if (!segmentClear(gridOf(state), ax, ay, path[i], path[i + 1], true)) return false;
    ax = path[i];
    ay = path[i + 1];
  }
  return true;
}

export function unitSpeed(state: MatchState, u: Unit): number {
  const speed = UNIT_STATS[u.type].speed;
  return state.map.tiles[tileIndex(state, u.x, u.y)] === TERRAIN.forest ? applyPercent(speed, RULES.movement.forestSpeedPercent) : speed;
}

/** 移動階段：所有 wantMove 的單位沿路徑前進 */
export function moveUnits(state: MatchState): void {
  for (const u of state.units) {
    u.arrived = false;
    if (!u.wantMove) {
      u.stuckTicks = 0;
      continue;
    }
    if (u.path !== null && u.pathBlockVersion !== state.blockVersion) {
      if (pathStillClear(state, u)) u.pathBlockVersion = state.blockVersion;
      else u.path = null;
    }
    if (u.path === null || u.stuckTicks >= STUCK_REPATH_TICKS) computePath(state, u);
    const path = u.path!;
    let remaining = unitSpeed(state, u);
    while (remaining > 0 && u.pathIdx < path.length) {
      const wx = path[u.pathIdx];
      const wy = path[u.pathIdx + 1];
      const dx = wx - u.x;
      const dy = wy - u.y;
      const d = isqrt(dx * dx + dy * dy);
      let nx: number;
      let ny: number;
      let reached = false;
      if (d <= remaining) {
        nx = wx;
        ny = wy;
        remaining -= d;
        reached = true;
      } else {
        nx = u.x + tdiv(dx * remaining, d);
        ny = u.y + tdiv(dy * remaining, d);
        remaining = 0;
      }
      if (standable(state, nx, ny)) {
        u.x = nx;
        u.y = ny;
        if (reached) u.pathIdx += 2;
        u.stuckTicks = 0;
      } else {
        // 沿軸滑動；都不行就停下
        if (standable(state, nx, u.y)) u.x = nx;
        else if (standable(state, u.x, ny)) u.y = ny;
        else u.stuckTicks += 1;
        break;
      }
    }
    if (u.pathIdx >= path.length) u.arrived = true;
  }
}

function immovable(state: MatchState, u: Unit): boolean {
  if (u.type !== 'worker') return false;
  if (u.gatherPhase === GATHER.mining) return true;
  if (u.order.kind === 'construct') {
    const b = state.buildingById.get(u.order.buildingId);
    return b !== undefined && b.builderId === u.id;
  }
  return false;
}

const neighborBuf: Unit[] = [];

/** 碰撞推擠：重疊的兩單位各被推開重疊量的一半，依 id 由小到大依序處理 */
export function resolveCollisions(state: MatchState): void {
  state.spatial.rebuild(state.units);
  for (const u of state.units) {
    const ru = UNIT_STATS[u.type].radius;
    const uFixed = immovable(state, u);
    const neighbors = state.spatial.query(u.x, u.y, ru + MAX_RADIUS * 2, neighborBuf);
    for (const v of neighbors) {
      if (v.id <= u.id) continue;
      const rv = UNIT_STATS[v.type].radius;
      const rsum = ru + rv;
      let dx = v.x - u.x;
      let dy = v.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rsum * rsum) continue;
      const vFixed = immovable(state, v);
      if (uFixed && vFixed) continue;
      let d = isqrt(d2);
      if (d === 0) {
        dx = 1;
        dy = 0;
        d = 1;
      }
      const overlap = rsum - isqrt(d2);
      let pu: number;
      let pv: number;
      if (uFixed) {
        pu = 0;
        pv = overlap;
      } else if (vFixed) {
        pu = overlap;
        pv = 0;
      } else {
        pu = tdiv(overlap, 2);
        pv = overlap - pu;
      }
      if (pu > 0) {
        const nx = u.x - tdiv(dx * pu, d);
        const ny = u.y - tdiv(dy * pu, d);
        if (standable(state, nx, ny)) {
          u.x = nx;
          u.y = ny;
        }
      }
      if (pv > 0) {
        const nx = v.x + tdiv(dx * pv, d);
        const ny = v.y + tdiv(dy * pv, d);
        if (standable(state, nx, ny)) {
          v.x = nx;
          v.y = ny;
        }
      }
    }
  }
  state.spatial.rebuild(state.units);
}
