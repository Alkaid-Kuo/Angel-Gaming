// 步驟 2：指令驗證與套用。每個指令消耗 1 點額度（NO_BUDGET 除外），依陣列順序處理。
import {
  BUILDING_STATS,
  BUILDING_TYPES,
  RULES,
  STANCES,
  UNIT_STATS,
  UNIT_TYPES,
  type BuildingType,
  type RejectReason,
  type Stance,
  type UnitType,
} from '../config/index.ts';
import { applyPercent } from '../shared/intmath.ts';
import { leaveNode, placementKnown, startGather } from './economy.ts';
import type { MatchState, Player, Unit } from './state.ts';
import { buildingVisibleTo, emit, inMap, removeBuilding, setIdle, unitVisibleTo } from './world.ts';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isOneOf<T extends string>(v: unknown, list: readonly T[]): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** 解析單位集合：id 陣列或編隊代號 0～9。格式錯誤回傳 null；不屬於自己或已死亡者略過 */
function resolveUnits(state: MatchState, p: Player, v: unknown): Unit[] | null {
  if (isInt(v)) {
    if (v < 0 || v > 9) return null;
    return state.units.filter((u) => u.owner === p.id && u.group === v);
  }
  if (!Array.isArray(v)) return null;
  const ids = new Set<number>();
  for (const x of v) {
    if (!isInt(x)) return null;
    ids.add(x);
  }
  const out: Unit[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const u = state.unitById.get(id);
    if (u !== undefined && u.owner === p.id) out.push(u);
  }
  return out;
}

/** 中斷單位目前的工作（採集、建造、交戰），保留攜帶的礦 */
function interrupt(state: MatchState, u: Unit): void {
  if (u.type === 'worker') {
    leaveNode(state, u);
    if (u.order.kind === 'construct') {
      const b = state.buildingById.get(u.order.buildingId);
      if (b !== undefined && b.builderId === u.id) b.builderId = 0;
    }
  }
  u.targetId = 0;
  u.returning = false;
  u.path = null;
  u.pathKey = -1;
}

export function applyCommands(state: MatchState, playerId: number, raw: unknown): void {
  const p = state.players[playerId];
  if (!p.alive) return;
  if (!Array.isArray(raw)) {
    reject(state, p, -1, 'BAD_FORMAT');
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    if (p.budget <= 0) {
      reject(state, p, i, 'NO_BUDGET');
      continue;
    }
    p.budget -= 1;
    p.stats.commandsIssued += 1;
    const reason = applyOne(state, p, raw[i]);
    if (reason !== null) reject(state, p, i, reason);
  }
}

function reject(state: MatchState, p: Player, index: number, reason: RejectReason): void {
  p.stats.rejections[reason] += 1;
  emit(state, p.id, { type: 'commandRejected', tick: state.tick, index, reason });
}

function applyOne(state: MatchState, p: Player, cmd: unknown): RejectReason | null {
  if (!isObj(cmd) || typeof cmd.type !== 'string') return 'BAD_FORMAT';
  switch (cmd.type) {
    case 'gather':
      return cmdGather(state, p, cmd);
    case 'build':
      return cmdBuild(state, p, cmd);
    case 'resume':
      return cmdResume(state, p, cmd);
    case 'train':
      return cmdTrain(state, p, cmd);
    case 'cancel':
      return cmdCancel(state, p, cmd);
    case 'rally':
      return cmdRally(state, p, cmd);
    case 'move':
    case 'attackMove':
      return cmdMove(state, p, cmd, cmd.type);
    case 'attack':
      return cmdAttack(state, p, cmd);
    case 'hold':
      return cmdHold(state, p, cmd);
    case 'stance':
      return cmdStance(state, p, cmd);
    case 'group':
      return cmdGroup(state, p, cmd);
    default:
      return 'BAD_FORMAT';
  }
}

function cmdGather(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  const units = resolveUnits(state, p, cmd.units);
  if (units === null || !isInt(cmd.nodeId)) return 'BAD_FORMAT';
  const node = state.nodeById.get(cmd.nodeId);
  if (node === undefined) return 'INVALID_TARGET';
  for (const u of units) {
    if (u.type !== 'worker') continue;
    interrupt(state, u);
    startGather(state, u, node);
  }
  return null;
}

function ownWorker(state: MatchState, p: Player, id: number): Unit | RejectReason {
  const u = state.unitById.get(id);
  if (u === undefined || u.owner !== p.id) return 'NOT_OWNED';
  if (u.type !== 'worker') return 'INVALID_TARGET';
  return u;
}

function cmdBuild(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  if (!isInt(cmd.workerId) || !isOneOf<BuildingType>(cmd.building, BUILDING_TYPES) || !isInt(cmd.tileX) || !isInt(cmd.tileY)) return 'BAD_FORMAT';
  const w = ownWorker(state, p, cmd.workerId);
  if (typeof w === 'string') return w;
  if (!placementKnown(state, p, cmd.building, cmd.tileX, cmd.tileY)) return 'BAD_PLACEMENT';
  interrupt(state, w);
  w.order = { kind: 'build', building: cmd.building, tileX: cmd.tileX, tileY: cmd.tileY };
  return null;
}

function cmdResume(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  if (!isInt(cmd.workerId) || !isInt(cmd.buildingId)) return 'BAD_FORMAT';
  const w = ownWorker(state, p, cmd.workerId);
  if (typeof w === 'string') return w;
  const b = state.buildingById.get(cmd.buildingId);
  if (b === undefined || b.owner !== p.id) return 'NOT_OWNED';
  if (b.complete || (b.builderId !== 0 && b.builderId !== w.id)) return 'INVALID_TARGET';
  interrupt(state, w);
  w.order = { kind: 'construct', buildingId: b.id };
  return null;
}

function cmdTrain(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  if (!isInt(cmd.buildingId) || !isOneOf<UnitType>(cmd.unit, UNIT_TYPES)) return 'BAD_FORMAT';
  const b = state.buildingById.get(cmd.buildingId);
  if (b === undefined || b.owner !== p.id) return 'NOT_OWNED';
  if (!b.complete || !BUILDING_STATS[b.type].produces.includes(cmd.unit)) return 'WRONG_PRODUCER';
  if (b.queue.length >= RULES.production.queueMax) return 'QUEUE_FULL';
  const st = UNIT_STATS[cmd.unit];
  if (p.minerals < st.cost) return 'NO_MINERALS';
  if (p.supplyUsed + st.supply > p.supplyCap) return 'NO_SUPPLY';
  p.minerals -= st.cost;
  p.supplyUsed += st.supply;
  b.queue.push({ unit: cmd.unit, progress: 0 });
  return null;
}

function cmdCancel(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  if (!isInt(cmd.buildingId)) return 'BAD_FORMAT';
  const b = state.buildingById.get(cmd.buildingId);
  if (b === undefined || b.owner !== p.id) return 'NOT_OWNED';
  if (!b.complete) {
    p.minerals += applyPercent(BUILDING_STATS[b.type].cost, RULES.construction.cancelRefundPercent);
    removeBuilding(state, b);
    return null;
  }
  const item = b.queue.pop();
  if (item === undefined) return 'INVALID_TARGET';
  p.minerals += UNIT_STATS[item.unit].cost;
  p.supplyUsed -= UNIT_STATS[item.unit].supply;
  return null;
}

function cmdRally(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  if (!isInt(cmd.buildingId) || !isInt(cmd.x) || !isInt(cmd.y) || !inMap(state, cmd.x, cmd.y)) return 'BAD_FORMAT';
  const b = state.buildingById.get(cmd.buildingId);
  if (b === undefined || b.owner !== p.id) return 'NOT_OWNED';
  if (BUILDING_STATS[b.type].produces.length === 0) return 'WRONG_PRODUCER';
  b.hasRally = true;
  b.rallyX = cmd.x;
  b.rallyY = cmd.y;
  return null;
}

function cmdMove(state: MatchState, p: Player, cmd: Obj, kind: 'move' | 'attackMove'): RejectReason | null {
  const units = resolveUnits(state, p, cmd.units);
  if (units === null || !isInt(cmd.x) || !isInt(cmd.y) || !inMap(state, cmd.x, cmd.y)) return 'BAD_FORMAT';
  for (const u of units) {
    interrupt(state, u);
    // 決策 Q8A：工人收到攻擊移動視同一般移動
    const k = u.type === 'worker' ? 'move' : kind;
    u.order = { kind: k, x: cmd.x, y: cmd.y };
  }
  return null;
}

function cmdAttack(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  const units = resolveUnits(state, p, cmd.units);
  if (units === null || !isInt(cmd.targetId)) return 'BAD_FORMAT';
  const tu = state.unitById.get(cmd.targetId);
  const tb = state.buildingById.get(cmd.targetId);
  if (tu !== undefined) {
    if (tu.owner === p.id || !unitVisibleTo(state, p, tu)) return 'INVALID_TARGET';
  } else if (tb !== undefined) {
    if (tb.owner === p.id || !buildingVisibleTo(state, p, tb)) return 'INVALID_TARGET';
  } else {
    return 'INVALID_TARGET';
  }
  for (const u of units) {
    interrupt(state, u);
    u.order = { kind: 'attack', targetId: cmd.targetId };
  }
  return null;
}

function cmdHold(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  const units = resolveUnits(state, p, cmd.units);
  if (units === null) return 'BAD_FORMAT';
  for (const u of units) {
    interrupt(state, u);
    setIdle(u);
  }
  return null;
}

function cmdStance(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  const units = resolveUnits(state, p, cmd.units);
  if (units === null || !isOneOf<Stance>(cmd.stance, STANCES)) return 'BAD_FORMAT';
  for (const u of units) {
    u.stance = cmd.stance;
    u.targetId = 0;
    u.returning = false;
  }
  return null;
}

function cmdGroup(state: MatchState, p: Player, cmd: Obj): RejectReason | null {
  if (!isInt(cmd.group) || cmd.group < 0 || cmd.group > 9 || !Array.isArray(cmd.units)) return 'BAD_FORMAT';
  const units = resolveUnits(state, p, cmd.units);
  if (units === null) return 'BAD_FORMAT';
  for (const u of state.units) if (u.owner === p.id && u.group === cmd.group) u.group = -1;
  for (const u of units) u.group = cmd.group;
  return null;
}
