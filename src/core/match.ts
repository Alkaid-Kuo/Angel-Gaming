// 比賽主流程：建立狀態、固定順序的 tick 更新、結果與名次。
import type { InitData, KnobValues } from '../api/types.ts';
import {
  BUILDING_STATS,
  BUILDING_TYPES,
  DAMAGE_MULTIPLIER,
  MAP_MODES,
  REJECT_REASONS,
  RULES,
  TILE_SIZE,
  UNIT_STATS,
  UNIT_TYPES,
  type BuildingType,
  type MatchMode,
  type RejectReason,
  type UnitType,
} from '../config/index.ts';
import { generateMap, type GeneratedMap } from '../mapgen/index.ts';
import { PathCache, PathFinder } from '../path/index.ts';
import { hashInts } from '../shared/hash.ts';
import { idiv } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import { applyCommands } from './commands.ts';
import { resolveDamage, stepAttacks, stepUnitAI } from './combat.ts';
import { stepConstruction, stepProduction, stepWorkers } from './economy.ts';
import { hashState } from './hash.ts';
import { updateKnowledge, updateScouting, updateVision } from './knowledge.ts';
import { moveUnits, resolveCollisions } from './movement.ts';
import { buildObservation, discardObservation, type ObservationPacket } from './observe.ts';
import { SpatialIndex } from './spatial.ts';
import type { MatchState, MineNode, Player, PlayerStats, Watchtower } from './state.ts';
import { stepWatchtowers } from './tower.ts';
import { assetScore, createBuilding, createUnit, HALF_TILE, terrainWalk } from './world.ts';

export interface MatchPlayerSetup {
  readonly knobs: KnobValues;
}

export interface MatchSetup {
  readonly mode: MatchMode;
  readonly seed: number;
  readonly players: readonly MatchPlayerSetup[];
  /** 測試用：指定地圖（否則依 seed 生成） */
  readonly map?: GeneratedMap;
}

export interface PlayerResult {
  readonly playerId: number;
  readonly slot: number;
  readonly rank: number;
  /** 淘汰 tick；存活到最後為 -1 */
  readonly eliminatedTick: number;
  /** 資產分數（淘汰者為淘汰當下） */
  readonly score: number;
  readonly stats: PlayerStats;
}

export interface MatchResult {
  readonly durationTicks: number;
  /** 依名次排列的 playerId */
  readonly ranking: readonly number[];
  readonly players: readonly PlayerResult[];
}

const ENGINE_RNG_TAG = 0x454e47;
const LOTTERY_TAG = 0x4c4f54;

function emptyStats(): PlayerStats {
  const unitsProduced = {} as Record<UnitType, number>;
  for (const t of UNIT_TYPES) unitsProduced[t] = 0;
  const buildingsBuilt = {} as Record<BuildingType, number>;
  for (const t of BUILDING_TYPES) buildingsBuilt[t] = 0;
  const rejections = {} as Record<RejectReason, number>;
  for (const r of REJECT_REASONS) rejections[r] = 0;
  return {
    gathered: 0,
    richGathered: 0,
    unitsProduced,
    unitsLost: 0,
    unitKills: 0,
    workerKills: 0,
    buildingKills: 0,
    buildingsBuilt,
    firstExpansionTick: -1,
    firstDamageTick: -1,
    commandsIssued: 0,
    rejections,
    scoutCount: 0,
    towerHeldTicks: 0,
  };
}

export class Match {
  readonly state: MatchState;

  constructor(setup: MatchSetup) {
    const cfg = MAP_MODES[setup.mode];
    if (setup.players.length !== cfg.players) {
      throw new Error(`${setup.mode} 需要 ${cfg.players} 位選手，收到 ${setup.players.length}`);
    }
    const map = setup.map ?? generateMap(setup.mode, setup.seed);
    const w = map.width;
    const h = map.height;
    const rng = Prng.fromInts(setup.seed, ENGINE_RNG_TAG);
    // 以引擎 PRNG 對起點槽位洗牌，依序分配給 playerId
    const slotOf = rng.shuffle(map.slots.map((s) => s.slot));
    const walk = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) walk[i] = terrainWalk(map.tiles[i]);
    const state: MatchState = {
      mode: setup.mode,
      seed: setup.seed,
      map,
      width: w,
      height: h,
      tick: 0,
      nextId: 1,
      rng,
      players: [],
      units: [],
      buildings: [],
      nodes: [],
      towers: [],
      unitById: new Map(),
      buildingById: new Map(),
      nodeById: new Map(),
      walk,
      buildingAt: new Int32Array(w * h),
      nodeAt: new Int32Array(w * h),
      blockVersion: 0,
      pathFinder: new PathFinder(w, h),
      pathCache: new PathCache(),
      spatial: new SpatialIndex(w, h),
      over: false,
      recordEvents: true,
    };
    this.state = state;
    // 礦點 → 瞭望塔 → 各選手主堡與工人，共用 id 計數器
    map.nodes.forEach((nd, index) => {
      const node: MineNode = { id: state.nextId++, index, tileX: nd.tileX, tileY: nd.tileY, rich: nd.rich, areaId: nd.areaId, reserve: nd.reserve, minerId: 0, queue: [] };
      state.nodes.push(node);
      state.nodeById.set(node.id, node);
      const ti = nd.tileY * w + nd.tileX;
      state.nodeAt[ti] = node.id;
      state.walk[ti] = 0;
    });
    for (const wt of map.watchtowers) {
      const t: Watchtower = { id: state.nextId++, x: wt.x, y: wt.y, owner: -1, progress: new Int32Array(cfg.players), visOwner: -1 };
      state.towers.push(t);
    }
    for (let pid = 0; pid < cfg.players; pid++) {
      const slot = map.slots[slotOf[pid]];
      const mainArea = map.areas.find((a) => a.kind === 'main' && a.slot === slot.slot)!;
      const p: Player = {
        id: pid,
        slot: slot.slot,
        startX: slot.tileX * TILE_SIZE + 1500,
        startY: slot.tileY * TILE_SIZE + 1500,
        mainAreaId: mainArea.areaId,
        minerals: RULES.economy.startMinerals,
        supplyUsed: 0,
        supplyCap: 0,
        budget: RULES.budget.initial,
        alive: true,
        eliminatedTick: -1,
        eliminationScore: 0,
        knobs: { ...setup.players[pid].knobs },
        vis: new Uint16Array(w * h),
        explored: new Uint8Array(w * h),
        exploredDelta: [],
        memory: new Map(),
        nodeKnown: Int32Array.from(state.nodes.map((n) => n.reserve)),
        events: [],
        stats: emptyStats(),
      };
      state.players.push(p);
    }
    for (const p of state.players) {
      const slot = map.slots[p.slot];
      const base = createBuilding(state, p.id, 'base', slot.tileX, slot.tileY, true);
      // 開局工人：主堡外圈最接近主礦區的格
      const mainNodes = state.nodes.filter((n) => n.areaId === p.mainAreaId);
      let mx = 0;
      let my = 0;
      for (const n of mainNodes) {
        mx += n.tileX * TILE_SIZE + HALF_TILE;
        my += n.tileY * TILE_SIZE + HALF_TILE;
      }
      mx = idiv(mx, mainNodes.length);
      my = idiv(my, mainNodes.length);
      const spots: { i: number; d: number }[] = [];
      for (let y = base.tileY - 1; y <= base.tileY + base.size; y++) {
        for (let x = base.tileX - 1; x <= base.tileX + base.size; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          if (state.walk[i] === 0) continue;
          const cx = x * TILE_SIZE + HALF_TILE;
          const cy = y * TILE_SIZE + HALF_TILE;
          spots.push({ i, d: (cx - mx) ** 2 + (cy - my) ** 2 });
        }
      }
      spots.sort((a, b) => a.d - b.d || a.i - b.i);
      for (let k = 0; k < RULES.economy.startWorkers; k++) {
        const s = spots[k % spots.length];
        const x = s.i % w;
        createUnit(state, p.id, 'worker', x * TILE_SIZE + HALF_TILE, ((s.i - x) / w) * TILE_SIZE + HALF_TILE);
        p.supplyUsed += UNIT_STATS.worker.supply;
      }
    }
    state.spatial.rebuild(state.units);
    updateVision(state);
    updateKnowledge(state);
  }

  get tick(): number {
    return this.state.tick;
  }

  get over(): boolean {
    return this.state.over;
  }

  get playerCount(): number {
    return this.state.players.length;
  }

  isAlive(playerId: number): boolean {
    return this.state.players[playerId].alive;
  }

  /** 回放重建時關閉事件記錄 */
  setRecordEvents(on: boolean): void {
    this.state.recordEvents = on;
  }

  /** 步驟 1：指令額度回補 */
  beginTick(): void {
    if (this.state.over) throw new Error('比賽已結束');
    if (this.state.tick % RULES.budget.refillInterval === 0) {
      for (const p of this.state.players) {
        if (p.alive && p.budget < RULES.budget.capacity) p.budget += 1;
      }
    }
  }

  isDecisionTick(): boolean {
    return this.state.tick % RULES.match.decisionInterval === 0;
  }

  /** 步驟 2a：建立觀察資料（反映上一 tick 結束時的狀態） */
  observe(playerId: number): ObservationPacket {
    return buildObservation(this.state, playerId);
  }

  discardObservation(playerId: number): void {
    discardObservation(this.state, playerId);
  }

  /** 步驟 2b：驗證並套用指令；必須依 playerId 順序呼叫 */
  applyCommands(playerId: number, commands: unknown): void {
    applyCommands(this.state, playerId, commands);
  }

  setKnobs(playerId: number, knobs: KnobValues): void {
    this.state.players[playerId].knobs = { ...knobs };
  }

  /** 步驟 3～12 */
  endTick(): void {
    const s = this.state;
    stepProduction(s); // 3
    stepConstruction(s); // 4
    stepWorkers(s); // 5
    stepUnitAI(s); // 6
    moveUnits(s); // 7
    resolveCollisions(s);
    const hits = stepAttacks(s); // 8
    resolveDamage(s, hits); // 9
    stepWatchtowers(s); // 10
    updateVision(s); // 11
    updateKnowledge(s);
    updateScouting(s);
    // 12 結束判定
    const alive = s.players.filter((p) => p.alive).length;
    if (alive <= 1 || s.tick + 1 >= RULES.match.timeLimitTicks) s.over = true;
    s.tick += 1;
  }

  hash(): string {
    return hashState(this.state);
  }

  initData(playerId: number): InitData {
    const s = this.state;
    const slotOwner = new Map<number, number>();
    for (const p of s.players) slotOwner.set(p.slot, p.id);
    return {
      mode: s.mode,
      width: s.width,
      height: s.height,
      tiles: Array.from(s.map.tiles),
      mineNodes: s.nodes.map((n) => ({ id: n.id, tileX: n.tileX, tileY: n.tileY, rich: n.rich, areaId: n.areaId, reserve: s.map.nodes[n.index].reserve })),
      mineAreas: s.map.areas.map((a) => ({ areaId: a.areaId, kind: a.kind, owner: a.slot === null ? null : slotOwner.get(a.slot)! })),
      startSlots: s.players.map((p) => ({ playerId: p.id, tileX: s.map.slots[p.slot].tileX, tileY: s.map.slots[p.slot].tileY })),
      watchtowers: s.towers.map((t) => ({ id: t.id, x: t.x, y: t.y })),
      me: playerId,
      players: s.players.map((p) => p.id),
      stats: JSON.parse(JSON.stringify({ units: UNIT_STATS, buildings: BUILDING_STATS, multipliers: DAMAGE_MULTIPLIER })) as InitData['stats'],
      matchSeed: s.seed,
      knobs: { ...s.players[playerId].knobs },
    };
  }

  result(): MatchResult {
    const s = this.state;
    const lottery = (pid: number): number => hashInts([s.seed, LOTTERY_TAG, pid]);
    const alive = s.players.filter((p) => p.alive).map((p) => ({ p, score: assetScore(s, p.id) }));
    alive.sort((a, b) => b.score - a.score || lottery(a.p.id) - lottery(b.p.id));
    const dead = s.players.filter((p) => !p.alive).map((p) => ({ p, score: p.eliminationScore }));
    dead.sort((a, b) => b.p.eliminatedTick - a.p.eliminatedTick || b.score - a.score || lottery(a.p.id) - lottery(b.p.id));
    const ordered = alive.concat(dead);
    const players: PlayerResult[] = ordered.map((x, i) => ({
      playerId: x.p.id,
      slot: x.p.slot,
      rank: i + 1,
      eliminatedTick: x.p.eliminatedTick,
      score: x.score,
      stats: structuredClone(x.p.stats),
    }));
    players.sort((a, b) => a.playerId - b.playerId);
    return { durationTicks: s.tick, ranking: ordered.map((x) => x.p.id), players };
  }
}
