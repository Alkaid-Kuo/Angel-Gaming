// 戰鬥：射程判定、目標選擇、單位 AI（步驟 6）、攻擊（步驟 8）、傷害結算與淘汰（步驟 9）。
import {
  BUILDING_STATS,
  DAMAGE_MULTIPLIER,
  RULES,
  TILE_SIZE,
  UNIT_STATS,
  type TargetClass,
} from '../config/index.ts';
import { applyPercent } from '../shared/intmath.ts';
import { chasePoint, isPathTo, moveToPoint, moveToRect, stopMoving } from './movement.ts';
import type { Building, MatchState, Player, Unit } from './state.ts';
import { emitTowerChanged } from './tower.ts';
import {
  assetScore,
  buildingCenterX,
  buildingCenterY,
  buildingVisibleTo,
  distSqToBuilding,
  emit,
  removeBuilding,
  removeUnit,
  setIdle,
  unitVisibleTo,
} from './world.ts';

type Entity = { kind: 'unit'; u: Unit } | { kind: 'building'; b: Building };

const MAX_RADIUS = Math.max(...Object.values(UNIT_STATS).map((s) => s.radius));
const candidateBuf: Unit[] = [];

function lookup(state: MatchState, id: number): Entity | null {
  const u = state.unitById.get(id);
  if (u !== undefined) return { kind: 'unit', u };
  const b = state.buildingById.get(id);
  if (b !== undefined) return { kind: 'building', b };
  return null;
}

function targetClass(e: Entity): TargetClass {
  return e.kind === 'unit' ? e.u.type : 'building';
}

function ownerOf(e: Entity): number {
  return e.kind === 'unit' ? e.u.owner : e.b.owner;
}

function visibleTo(state: MatchState, p: Player, e: Entity): boolean {
  return e.kind === 'unit' ? unitVisibleTo(state, p, e.u) : buildingVisibleTo(state, p, e.b);
}

/** 單位攻擊方的射程判定（決策 Q1A）：雙方邊緣之間的距離 ≤ 射程 */
function unitInRange(a: Unit, e: Entity): boolean {
  const st = UNIT_STATS[a.type];
  if (e.kind === 'unit') {
    const reach = st.range + st.radius + UNIT_STATS[e.u.type].radius;
    const dx = e.u.x - a.x;
    const dy = e.u.y - a.y;
    return dx * dx + dy * dy <= reach * reach;
  }
  const reach = st.range + st.radius;
  return distSqToBuilding(a.x, a.y, e.b) <= reach * reach;
}

/** 防禦塔射程：塔中心到目標邊緣 */
function towerInRange(t: Building, target: Unit): boolean {
  const reach = BUILDING_STATS.tower.weapon!.range + UNIT_STATS[target.type].radius;
  const dx = target.x - buildingCenterX(t);
  const dy = target.y - buildingCenterY(t);
  return dx * dx + dy * dy <= reach * reach;
}

function multiplier(attacker: Unit['type'] | 'tower', target: TargetClass): number | null {
  return DAMAGE_MULTIPLIER[attacker][target];
}

export function damageOf(attacker: Unit['type'] | 'tower', target: TargetClass): number {
  const mult = multiplier(attacker, target);
  if (mult === null) throw new Error(`${attacker} 不能攻擊 ${target}`);
  const base = attacker === 'tower' ? BUILDING_STATS.tower.weapon!.attack : UNIT_STATS[attacker].attack;
  return Math.max(RULES.combat.minDamage, applyPercent(base, mult));
}

// ───────── 目標選擇 ─────────

interface Candidate {
  readonly id: number;
  readonly attackingMe: number;
  readonly category: number;
  readonly advantage: number;
  readonly dist: number;
}

/** 依序比較：正在攻擊自己 > 類別（戰鬥 > 工人 > 建築）> 倍率優勢 > 距離 > id */
function better(a: Candidate, b: Candidate): boolean {
  if (a.attackingMe !== b.attackingMe) return a.attackingMe < b.attackingMe;
  if (a.category !== b.category) return a.category < b.category;
  if (a.advantage !== b.advantage) return a.advantage < b.advantage;
  if (a.dist !== b.dist) return a.dist < b.dist;
  return a.id < b.id;
}

function isAttacking(state: MatchState, attacker: { lastHitTarget: number; lastHitTick: number }, cooldown: number, myId: number): boolean {
  return attacker.lastHitTarget === myId && state.tick - attacker.lastHitTick <= cooldown + 1;
}

function unitCandidate(state: MatchState, me: Unit | Building, attackerType: Unit['type'] | 'tower', v: Unit, dist: number): Candidate {
  const mult = multiplier(attackerType, v.type) ?? 100;
  return {
    id: v.id,
    attackingMe: isAttacking(state, v, UNIT_STATS[v.type].cooldown, me.id) ? 0 : 1,
    category: v.type === 'worker' ? 1 : 0,
    advantage: mult > 100 ? 0 : 1,
    dist,
  };
}

/**
 * 為單位選擇新目標。radius：積極姿態為視野範圍（中心距離），否則為射程（邊緣距離）。
 */
export function acquireForUnit(state: MatchState, u: Unit, useSight: boolean): number {
  const p = state.players[u.owner];
  const st = UNIT_STATS[u.type];
  const sightR = st.sight * TILE_SIZE;
  const queryR = useSight ? sightR : st.range + st.radius + MAX_RADIUS;
  let best: Candidate | null = null;
  for (const v of state.spatial.query(u.x, u.y, queryR, candidateBuf)) {
    if (v.owner === u.owner || !state.unitById.has(v.id)) continue;
    if (!unitVisibleTo(state, p, v)) continue;
    const e: Entity = { kind: 'unit', u: v };
    if (!useSight && !unitInRange(u, e)) continue;
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const c = unitCandidate(state, u, u.type, v, dx * dx + dy * dy);
    if (best === null || better(c, best)) best = c;
  }
  // 已有「正在攻擊自己的戰鬥單位」時，建築不可能勝出
  if (best !== null && best.attackingMe === 0 && best.category === 0) return best.id;
  // 建築（類別最低，只有在沒有戰鬥單位候選時才可能勝出）
  for (const b of state.buildings) {
    if (b.owner === u.owner) continue;
    const d = distSqToBuilding(u.x, u.y, b);
    if (useSight ? d > sightR * sightR : !unitInRange(u, { kind: 'building', b })) continue;
    if (!buildingVisibleTo(state, p, b)) continue;
    const mult = multiplier(u.type, 'building') ?? 100;
    const towerAttacking = b.type === 'tower' && isAttacking(state, b, BUILDING_STATS.tower.weapon!.cooldown, u.id);
    const c: Candidate = { id: b.id, attackingMe: towerAttacking ? 0 : 1, category: 2, advantage: mult > 100 ? 0 : 1, dist: d };
    if (best === null || better(c, best)) best = c;
  }
  return best === null ? 0 : best.id;
}

function acquireForTower(state: MatchState, t: Building): number {
  const p = state.players[t.owner];
  const cx = buildingCenterX(t);
  const cy = buildingCenterY(t);
  let best: Candidate | null = null;
  for (const v of state.spatial.query(cx, cy, BUILDING_STATS.tower.weapon!.range + MAX_RADIUS, candidateBuf)) {
    if (v.owner === t.owner || !state.unitById.has(v.id)) continue;
    if (!towerInRange(t, v) || !unitVisibleTo(state, p, v)) continue;
    const dx = v.x - cx;
    const dy = v.y - cy;
    const c = unitCandidate(state, t, 'tower', v, dx * dx + dy * dy);
    if (best === null || better(c, best)) best = c;
  }
  return best === null ? 0 : best.id;
}

// ───────── 步驟 6：單位 AI ─────────

function validEnemyTarget(state: MatchState, p: Player, id: number): Entity | null {
  const e = lookup(state, id);
  if (e === null || ownerOf(e) === p.id) return null;
  if (!visibleTo(state, p, e)) return null;
  return e;
}

function chaseEntity(state: MatchState, u: Unit, e: Entity): void {
  if (e.kind === 'unit') chasePoint(state, u, e.u.x, e.u.y);
  else moveToRect(u, e.b.tileX, e.b.tileY, e.b.size, state.width);
}

const RETURN_EPS_SQ = 100 * 100;

/**
 * 依姿態自動交戰。回傳 true 表示本 tick 由交戰邏輯接管（攻擊、追擊或返回）。
 */
function autoEngage(state: MatchState, u: Unit): boolean {
  if (u.type === 'worker' || u.stance === 'retreat') {
    u.targetId = 0;
    u.returning = false;
    return false;
  }
  const p = state.players[u.owner];
  if (u.returning) {
    const dx = u.x - u.chaseX;
    const dy = u.y - u.chaseY;
    if (dx * dx + dy * dy > RETURN_EPS_SQ && !(u.arrived && isPathTo(u, u.chaseX, u.chaseY))) {
      moveToPoint(u, u.chaseX, u.chaseY);
      return true;
    }
    u.returning = false;
  }
  let target: Entity | null = u.targetId !== 0 ? validEnemyTarget(state, p, u.targetId) : null;
  if (target !== null) {
    const inRange = unitInRange(u, target);
    const dx = u.x - u.chaseX;
    const dy = u.y - u.chaseY;
    const fromAnchor = dx * dx + dy * dy;
    if (u.stance === 'aggressive') {
      const leash = RULES.stance.aggressiveChaseTiles * TILE_SIZE;
      if (!inRange && fromAnchor > leash * leash) target = null;
    } else if (u.stance === 'defensive') {
      const leash = RULES.stance.defensiveLeashTiles * TILE_SIZE;
      if (!inRange && fromAnchor >= leash * leash) target = null;
    } else if (!inRange) {
      target = null; // hold
    }
    if (target === null) {
      u.targetId = 0;
      if (u.stance !== 'hold') {
        u.returning = true;
        moveToPoint(u, u.chaseX, u.chaseY);
        return true;
      }
    }
  } else {
    u.targetId = 0;
  }
  if (target === null) {
    const id = acquireForUnit(state, u, u.stance === 'aggressive');
    if (id === 0) return false;
    target = lookup(state, id)!;
    u.targetId = id;
    u.chaseX = u.x;
    u.chaseY = u.y;
  }
  if (unitInRange(u, target)) {
    stopMoving(u);
    u.attackTarget = target.kind === 'unit' ? target.u.id : target.b.id;
  } else if (u.stance === 'hold') {
    stopMoving(u);
  } else {
    chaseEntity(state, u, target);
  }
  return true;
}

export function stepUnitAI(state: MatchState): void {
  for (const u of state.units) {
    u.attackTarget = 0;
    const order = u.order;
    if (u.type === 'worker' && (order.kind === 'gather' || order.kind === 'build' || order.kind === 'construct')) continue;
    switch (order.kind) {
      case 'idle':
        if (!autoEngage(state, u)) stopMoving(u);
        break;
      case 'move':
        if (u.arrived && isPathTo(u, order.x, order.y)) {
          setIdle(u);
          stopMoving(u);
        } else {
          moveToPoint(u, order.x, order.y);
        }
        break;
      case 'attackMove':
        if (autoEngage(state, u)) break;
        if (u.arrived && isPathTo(u, order.x, order.y)) {
          setIdle(u);
          stopMoving(u);
        } else {
          moveToPoint(u, order.x, order.y);
        }
        break;
      case 'attack': {
        const p = state.players[u.owner];
        const target = validEnemyTarget(state, p, order.targetId);
        if (target === null) {
          setIdle(u);
          stopMoving(u);
        } else if (unitInRange(u, target)) {
          stopMoving(u);
          u.attackTarget = order.targetId;
        } else {
          chaseEntity(state, u, target);
        }
        break;
      }
      default:
        stopMoving(u);
        break;
    }
  }
  // 防禦塔
  for (const t of state.buildings) {
    t.attackTarget = 0;
    if (t.type !== 'tower' || !t.complete) continue;
    const p = state.players[t.owner];
    if (t.targetId !== 0) {
      const v = state.unitById.get(t.targetId);
      if (v === undefined || v.owner === t.owner || !towerInRange(t, v) || !unitVisibleTo(state, p, v)) t.targetId = 0;
    }
    if (t.targetId === 0) t.targetId = acquireForTower(state, t);
    t.attackTarget = t.targetId;
  }
}

// ───────── 步驟 8：攻擊 ─────────

interface Hit {
  readonly attackerId: number;
  readonly attackerOwner: number;
  readonly targetId: number;
  readonly damage: number;
}

export function stepAttacks(state: MatchState): Hit[] {
  const hits: Hit[] = [];
  for (const u of state.units) {
    if (u.attackTarget === 0 || state.tick < u.nextAttackTick) continue;
    const p = state.players[u.owner];
    const target = validEnemyTarget(state, p, u.attackTarget);
    if (target === null || !unitInRange(u, target)) continue;
    const damage = damageOf(u.type, targetClass(target));
    hits.push({ attackerId: u.id, attackerOwner: u.owner, targetId: u.attackTarget, damage });
    u.nextAttackTick = state.tick + UNIT_STATS[u.type].cooldown;
    u.lastHitTarget = u.attackTarget;
    u.lastHitTick = state.tick;
    if (p.stats.firstDamageTick < 0) p.stats.firstDamageTick = state.tick;
  }
  for (const t of state.buildings) {
    if (t.attackTarget === 0 || state.tick < t.nextAttackTick) continue;
    const v = state.unitById.get(t.attackTarget);
    const p = state.players[t.owner];
    if (v === undefined || !towerInRange(t, v) || !unitVisibleTo(state, p, v)) continue;
    const damage = damageOf('tower', v.type);
    hits.push({ attackerId: t.id, attackerOwner: t.owner, targetId: v.id, damage });
    t.nextAttackTick = state.tick + BUILDING_STATS.tower.weapon!.cooldown;
    t.lastHitTarget = v.id;
    t.lastHitTick = state.tick;
    if (p.stats.firstDamageTick < 0) p.stats.firstDamageTick = state.tick;
  }
  return hits;
}

// ───────── 步驟 9：傷害結算、死亡、淘汰 ─────────

export function resolveDamage(state: MatchState, hits: readonly Hit[]): void {
  if (hits.length > 0) {
    // 依目標彙整
    const byTarget = new Map<number, Hit[]>();
    for (const h of hits) {
      const arr = byTarget.get(h.targetId);
      if (arr === undefined) byTarget.set(h.targetId, [h]);
      else arr.push(h);
    }
    const targetIds = [...byTarget.keys()].sort((a, b) => a - b);
    const dead: { e: Entity; killer: number }[] = [];
    for (const tid of targetIds) {
      const e = lookup(state, tid)!;
      const list = byTarget.get(tid)!;
      let total = 0;
      for (const h of list) total += h.damage;
      const owner = ownerOf(e);
      const op = state.players[owner];
      // 攻擊者 id：受攻擊方可見的最小 id 攻擊者
      let visibleAttacker: number | null = null;
      for (const h of [...list].sort((a, b) => a.attackerId - b.attackerId)) {
        const ae = lookup(state, h.attackerId);
        if (ae !== null && visibleTo(state, op, ae)) {
          visibleAttacker = h.attackerId;
          break;
        }
      }
      emit(state, owner, { type: 'underAttack', tick: state.tick, targetId: tid, attackerId: visibleAttacker });
      if (e.kind === 'unit') e.u.hp -= total;
      else e.b.hp -= total;
      const hp = e.kind === 'unit' ? e.u.hp : e.b.hp;
      if (hp <= 0) {
        // 擊殺歸屬：本 tick 對其傷害最高的選手；同分取 playerId 小者
        const perOwner = new Map<number, number>();
        for (const h of list) perOwner.set(h.attackerOwner, (perOwner.get(h.attackerOwner) ?? 0) + h.damage);
        let killer = -1;
        let killerDmg = -1;
        for (const [o, d] of [...perOwner.entries()].sort((a, b) => a[0] - b[0])) {
          if (d > killerDmg) {
            killer = o;
            killerDmg = d;
          }
        }
        dead.push({ e, killer });
      }
    }
    for (const { e, killer } of dead) {
      const owner = ownerOf(e);
      const kp = state.players[killer];
      if (e.kind === 'unit') {
        emit(state, owner, { type: 'unitDied', tick: state.tick, id: e.u.id, unitType: e.u.type });
        emit(state, killer, { type: 'enemyKilled', tick: state.tick, id: e.u.id, owner, kind: 'unit', entityType: e.u.type });
        state.players[owner].stats.unitsLost += 1;
        kp.stats.unitKills += 1;
        if (e.u.type === 'worker') kp.stats.workerKills += 1;
        removeUnit(state, e.u);
      } else {
        emit(state, owner, { type: 'buildingDestroyed', tick: state.tick, id: e.b.id, buildingType: e.b.type });
        emit(state, killer, { type: 'enemyKilled', tick: state.tick, id: e.b.id, owner, kind: 'building', entityType: e.b.type });
        kp.stats.buildingKills += 1;
        removeBuilding(state, e.b);
      }
    }
  }
  checkElimination(state);
}

/** 主堡（含建造中）全數被摧毀即淘汰，其餘單位與建築一併移除 */
export function checkElimination(state: MatchState): void {
  const eliminated: Player[] = [];
  for (const p of state.players) {
    if (!p.alive) continue;
    if (!state.buildings.some((b) => b.owner === p.id && b.type === 'base')) eliminated.push(p);
  }
  if (eliminated.length === 0) return;
  for (const p of eliminated) {
    p.eliminationScore = assetScore(state, p.id);
    p.eliminatedTick = state.tick;
  }
  for (const p of eliminated) {
    for (const u of state.units.filter((x) => x.owner === p.id)) removeUnit(state, u);
    for (const b of state.buildings.filter((x) => x.owner === p.id)) removeBuilding(state, b);
    p.alive = false;
    p.events.length = 0;
  }
  for (const p of eliminated) {
    for (const t of state.towers) {
      t.progress[p.id] = 0;
      if (t.owner === p.id) {
        t.owner = -1;
        emitTowerChanged(state, t, p.id);
      }
    }
    for (const q of state.players) emit(state, q.id, { type: 'playerEliminated', tick: state.tick, playerId: p.id });
  }
}
