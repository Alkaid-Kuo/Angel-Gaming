// 經濟：生產（步驟 3）、建造進度（步驟 4）、工人狀態機——採集、開工、接續建造（步驟 5）。
import { BASE_UPGRADES, BUILDING_STATS, RULES, TERRAIN, TILE_SIZE, UNIT_STATS, type BuildingType } from '../config/index.ts';
import { moveToRect, stopMoving } from './movement.ts';
import { GATHER, type Building, type MatchState, type MineNode, type Player, type Unit } from './state.ts';
import {
  buildingCenterX,
  buildingCenterY,
  buildingVisibleTo,
  constructionHp,
  createBuilding,
  createUnit,
  distSqToBuilding,
  distSqToTileRect,
  emit,
  HALF_TILE,
  nearestFreeTileAround,
  recomputeSupplyCap,
  setIdle,
} from './world.ts';

const INTERACT_SQ = RULES.economy.interactRange * RULES.economy.interactRange;

// ───────── 步驟 3：生產 ─────────

export function stepProduction(state: MatchState): void {
  const center = state.width * HALF_TILE;
  for (const b of state.buildings) {
    if (!b.complete) continue;
    if (b.task !== null) {
      // 升級／研究進行中：生產佇列暫停
      b.task.progress += 1;
      if (b.task.progress >= b.task.total) finishTask(state, b);
      continue;
    }
    if (b.queue.length === 0) continue;
    const head = b.queue[0];
    const need = UNIT_STATS[head.unit].trainTicks;
    if (head.progress < need) head.progress += 1;
    if (head.progress < need) continue;
    const tx = b.hasRally ? b.rallyX : center;
    const ty = b.hasRally ? b.rallyY : center;
    const spot = nearestFreeTileAround(state, b.tileX, b.tileY, b.size, tx, ty);
    if (spot < 0) continue; // 四周被封住：暫停，等有空位
    b.queue.shift();
    const sx = spot % state.width;
    const sy = (spot - sx) / state.width;
    const u = createUnit(state, b.owner, head.unit, sx * TILE_SIZE + HALF_TILE, sy * TILE_SIZE + HALF_TILE);
    if (b.hasRally) {
      u.order = { kind: 'move', x: b.rallyX, y: b.rallyY };
    }
    const p = state.players[b.owner];
    p.stats.unitsProduced[head.unit] += 1;
    emit(state, b.owner, { type: 'unitTrained', tick: state.tick, id: u.id, unitType: head.unit });
  }
}

function finishTask(state: MatchState, b: Building): void {
  const task = b.task!;
  b.task = null;
  const p = state.players[b.owner];
  if (task.kind === 'upgrade') {
    const up = BASE_UPGRADES[b.level - 1];
    b.level += 1;
    b.hp += up.maxHp - b.maxHp;
    b.maxHp = up.maxHp;
    p.stats.upgrades += 1;
    emit(state, b.owner, { type: 'upgradeComplete', tick: state.tick, buildingId: b.id, level: b.level });
  } else {
    p.research[task.research] += 1;
    p.stats.researches += 1;
    emit(state, b.owner, { type: 'researchComplete', tick: state.tick, research: task.research, level: p.research[task.research] });
  }
}

// ───────── 步驟 4：建造進度 ─────────

export function stepConstruction(state: MatchState): void {
  for (const b of state.buildings) {
    if (b.complete || b.builderId === 0) continue;
    const worker = state.unitById.get(b.builderId);
    if (worker === undefined || worker.order.kind !== 'construct' || worker.order.buildingId !== b.id) {
      b.builderId = 0;
      continue;
    }
    const st = BUILDING_STATS[b.type];
    b.hp += constructionHp(b.type, b.progress + 1) - constructionHp(b.type, b.progress);
    b.progress += 1;
    if (b.progress >= st.buildTicks) {
      b.complete = true;
      b.builderId = 0;
      const p = state.players[b.owner];
      recomputeSupplyCap(state, p);
      p.stats.buildingsBuilt[b.type] += 1;
      emit(state, b.owner, { type: 'buildingComplete', tick: state.tick, id: b.id, buildingType: b.type });
      setIdle(worker);
    }
  }
}

// ───────── 步驟 5：工人狀態機 ─────────

export function stepWorkers(state: MatchState): void {
  for (const u of state.units) {
    if (u.type !== 'worker') continue;
    switch (u.order.kind) {
      case 'gather':
        gatherTick(state, u);
        break;
      case 'build':
        buildTick(state, u, u.order.building, u.order.tileX, u.order.tileY);
        break;
      case 'construct':
        constructTick(state, u, u.order.buildingId);
        break;
      default:
        break;
    }
  }
}

function inRangeOfNode(u: Unit, node: MineNode): boolean {
  return distSqToTileRect(u.x, u.y, node.tileX, node.tileY, 1) <= INTERACT_SQ;
}

function nearestDropoff(state: MatchState, u: Unit): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (b.owner !== u.owner || !b.complete || !BUILDING_STATS[b.type].isDropoff) continue;
    const d = distSqToBuilding(u.x, u.y, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** 開始對礦點採集：已攜帶礦就先回卸貨點 */
export function startGather(state: MatchState, u: Unit, node: MineNode): void {
  leaveNode(state, u);
  u.order = { kind: 'gather', nodeId: node.id };
  u.gatherNodeId = node.id;
  u.gatherPhase = u.carry > 0 ? GATHER.toDepot : GATHER.toNode;
  u.targetId = 0;
  u.returning = false;
}

/** 離開目前礦點（開採中或排隊中） */
export function leaveNode(state: MatchState, u: Unit): void {
  if (u.gatherNodeId === 0) return;
  const node = state.nodeById.get(u.gatherNodeId)!;
  if (node.minerId === u.id) node.minerId = 0;
  const qi = node.queue.indexOf(u.id);
  if (qi >= 0) node.queue.splice(qi, 1);
  u.gatherNodeId = 0;
  u.gatherPhase = GATHER.none;
}

function gatherTick(state: MatchState, u: Unit): void {
  const p = state.players[u.owner];
  if (u.gatherPhase === GATHER.toDepot) {
    const depot = nearestDropoff(state, u);
    if (depot === null) {
      stopMoving(u);
      return;
    }
    if (distSqToBuilding(u.x, u.y, depot) <= INTERACT_SQ) {
      stopMoving(u);
      p.minerals += u.carry;
      p.stats.gathered += u.carry;
      p.stats.richGathered += u.carryRich;
      u.carry = 0;
      u.carryRich = 0;
      if (u.gatherNodeId === 0) setIdle(u);
      else u.gatherPhase = GATHER.toNode;
    } else {
      moveToRect(u, depot.tileX, depot.tileY, depot.size, state.width);
    }
    return;
  }
  let node = state.nodeById.get(u.gatherNodeId)!;
  if (node.reserve === 0) {
    const alt = nearestLiveNodeInArea(state, node);
    if (alt === null) {
      leaveNode(state, u);
      setIdle(u);
      return;
    }
    leaveNode(state, u);
    u.gatherNodeId = alt.id;
    u.order = { kind: 'gather', nodeId: alt.id };
    u.gatherPhase = GATHER.toNode;
    node = alt;
  }
  if (u.gatherPhase === GATHER.mining) {
    stopMoving(u);
    if (state.tick < u.mineEndTick) return;
    const amount = Math.min(node.rich ? RULES.economy.richMineAmount : RULES.economy.mineAmount, node.reserve);
    node.reserve -= amount;
    u.carry += amount;
    if (node.rich) u.carryRich += amount;
    node.minerId = 0;
    u.gatherPhase = GATHER.toDepot;
    if (node.reserve === 0) depleteNode(state, node);
    return;
  }
  // toNode／waiting
  if (!inRangeOfNode(u, node)) {
    moveToRect(u, node.tileX, node.tileY, 1, state.width);
    return;
  }
  stopMoving(u);
  if (!node.queue.includes(u.id)) node.queue.push(u.id);
  u.gatherPhase = GATHER.waiting;
  if (node.minerId !== 0) return;
  // 礦點空出：排隊順序中第一個「已在礦點旁」的工人開採（排在前面但被擠開的工人不會卡住後面的人）
  for (const qid of node.queue) {
    if (qid === u.id) break;
    const ahead = state.unitById.get(qid)!;
    if (inRangeOfNode(ahead, node)) return;
  }
  node.queue.splice(node.queue.indexOf(u.id), 1);
  node.minerId = u.id;
  u.gatherPhase = GATHER.mining;
  u.mineEndTick = state.tick + RULES.economy.mineTicks;
}

function nearestLiveNodeInArea(state: MatchState, from: MineNode): MineNode | null {
  let best: MineNode | null = null;
  let bestD = Infinity;
  for (const n of state.nodes) {
    if (n.areaId !== from.areaId || n.reserve === 0) continue;
    const d = (n.tileX - from.tileX) ** 2 + (n.tileY - from.tileY) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** 礦點枯竭：該礦點的工人改採同礦區最近的未枯竭礦點；整區枯竭則閒置 */
function depleteNode(state: MatchState, node: MineNode): void {
  const tile = node.tileY * state.width + node.tileX;
  for (const p of state.players) {
    if (!p.alive) continue;
    const hasWorker = state.units.some((w) => w.owner === p.id && w.gatherNodeId === node.id);
    if (hasWorker || p.vis[tile] > 0) emit(state, p.id, { type: 'nodeDepleted', tick: state.tick, nodeId: node.id, areaId: node.areaId });
  }
  const alt = nearestLiveNodeInArea(state, node);
  for (const w of state.units) {
    if (w.gatherNodeId !== node.id) continue;
    const phase = w.gatherPhase;
    leaveNode(state, w);
    if (alt !== null) {
      w.gatherNodeId = alt.id;
      w.order = { kind: 'gather', nodeId: alt.id };
      w.gatherPhase = phase === GATHER.toDepot ? GATHER.toDepot : GATHER.toNode;
    } else if (phase === GATHER.toDepot && w.carry > 0) {
      // 先把礦送回，送完閒置
      w.gatherPhase = GATHER.toDepot;
    } else {
      setIdle(w);
    }
  }
  node.queue = [];
  node.minerId = 0;
}

/** 真實狀態下的放置檢查（開工時） */
export function placementValid(state: MatchState, type: BuildingType, tileX: number, tileY: number): boolean {
  const size = BUILDING_STATS[type].size;
  const w = state.width;
  if (tileX < 0 || tileY < 0 || tileX + size > w || tileY + size > state.height) return false;
  for (let y = tileY; y < tileY + size; y++) {
    for (let x = tileX; x < tileX + size; x++) {
      const i = y * w + x;
      if (state.map.tiles[i] !== TERRAIN.plain || state.buildingAt[i] !== 0 || state.nodeAt[i] !== 0) return false;
    }
  }
  return true;
}

/** 依選手已知資訊的放置檢查（下指令時；也是 canPlace 輔助工具的規則） */
export function placementKnown(state: MatchState, p: Player, type: BuildingType, tileX: number, tileY: number): boolean {
  const size = BUILDING_STATS[type].size;
  const w = state.width;
  if (tileX < 0 || tileY < 0 || tileX + size > w || tileY + size > state.height) return false;
  for (let y = tileY; y < tileY + size; y++) {
    for (let x = tileX; x < tileX + size; x++) {
      const i = y * w + x;
      if (state.map.tiles[i] !== TERRAIN.plain || state.nodeAt[i] !== 0 || p.explored[i] === 0) return false;
      const bid = state.buildingAt[i];
      if (bid !== 0) {
        const b = state.buildingById.get(bid)!;
        if (b.owner === p.id || buildingVisibleTo(state, p, b)) return false;
      }
    }
  }
  // 記憶中（目前不可見）的敵方建築
  for (const m of p.memory.values()) {
    if (m.visibleNow) continue;
    if (tileX < m.tileX + m.size && tileX + size > m.tileX && tileY < m.tileY + m.size && tileY + size > m.tileY) return false;
  }
  return true;
}

function buildTick(state: MatchState, u: Unit, type: BuildingType, tileX: number, tileY: number): void {
  const st = BUILDING_STATS[type];
  if (distSqToTileRect(u.x, u.y, tileX, tileY, st.size) > INTERACT_SQ) {
    moveToRect(u, tileX, tileY, st.size, state.width);
    return;
  }
  stopMoving(u);
  const p = state.players[u.owner];
  let reason: 'NO_MINERALS' | 'BAD_PLACEMENT' | null = null;
  if (!placementValid(state, type, tileX, tileY)) reason = 'BAD_PLACEMENT';
  else if (p.minerals < st.cost) reason = 'NO_MINERALS';
  if (reason !== null) {
    emit(state, u.owner, { type: 'buildFailed', tick: state.tick, workerId: u.id, building: type, tileX, tileY, reason });
    setIdle(u);
    return;
  }
  p.minerals -= st.cost;
  const b = createBuilding(state, u.owner, type, tileX, tileY, false);
  b.builderId = u.id;
  u.order = { kind: 'construct', buildingId: b.id };
  noteExpansion(state, p, b);
}

function constructTick(state: MatchState, u: Unit, buildingId: number): void {
  const b = state.buildingById.get(buildingId);
  if (b === undefined || b.complete) {
    setIdle(u);
    return;
  }
  if (distSqToBuilding(u.x, u.y, b) > INTERACT_SQ) {
    if (b.builderId === u.id) b.builderId = 0;
    moveToRect(u, b.tileX, b.tileY, b.size, state.width);
    return;
  }
  stopMoving(u);
  if (b.builderId === 0) b.builderId = u.id;
  else if (b.builderId !== u.id) setIdle(u);
}

/** 統計：首次擴張 = 在非己方主礦區的礦點附近開始建造主堡或採集站 */
function noteExpansion(state: MatchState, p: Player, b: Building): void {
  if (p.stats.firstExpansionTick >= 0 || (b.type !== 'base' && b.type !== 'depot')) return;
  const cx = buildingCenterX(b);
  const cy = buildingCenterY(b);
  const r = RULES.stats.expansionRadiusTiles * TILE_SIZE;
  for (const n of state.nodes) {
    if (n.areaId === p.mainAreaId) continue;
    const nx = n.tileX * TILE_SIZE + HALF_TILE;
    const ny = n.tileY * TILE_SIZE + HALF_TILE;
    if ((nx - cx) ** 2 + (ny - cy) ** 2 <= r * r) {
      p.stats.firstExpansionTick = state.tick;
      return;
    }
  }
}
