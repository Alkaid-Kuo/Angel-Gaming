// 繪圖用的唯讀快照：從引擎狀態擷取某位觀看者（或上帝視角）看得到的內容。不修改狀態。
import { BUILDING_STATS, COMBAT_UNIT_TYPES, UNIT_STATS, type BuildingType, type MatchMode, type Stance, type UnitType } from '../config/index.ts';
import type { Match } from '../core/match.ts';
import type { MatchState, Player, Unit } from '../core/state.ts';
import { buildingVisibleTo, tileIndex, unitVisibleTo } from '../core/world.ts';
import { idiv } from '../shared/intmath.ts';

export const GOD_VIEW = -1;

export interface StaticMapView {
  readonly mode: MatchMode;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly tiles: number[];
  readonly nodes: { readonly id: number; readonly tileX: number; readonly tileY: number; readonly rich: boolean }[];
  readonly towers: { readonly id: number; readonly x: number; readonly y: number }[];
  readonly players: { readonly id: number; readonly name: string; readonly startTileX: number; readonly startTileY: number }[];
}

export interface UnitFrame {
  readonly id: number;
  readonly owner: number;
  readonly type: UnitType;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly stance: Stance;
  readonly group: number;
  readonly order: string;
  readonly carrying: number;
  /** 本 tick 正在攻擊的目標（繪製攻擊線用） */
  readonly attacking: number;
}

export interface BuildingFrame {
  readonly id: number;
  readonly owner: number;
  readonly type: BuildingType;
  readonly tileX: number;
  readonly tileY: number;
  readonly size: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly complete: boolean;
  readonly progress: number;
  readonly queue: { readonly unit: UnitType; readonly progress: number }[];
  readonly rally: { readonly x: number; readonly y: number } | null;
  /** 迷霧中的記憶（不是目前狀態） */
  readonly remembered: boolean;
  readonly attacking: number;
}

export interface PlayerFrame {
  readonly id: number;
  readonly alive: boolean;
  readonly minerals: number;
  readonly supplyUsed: number;
  readonly supplyCap: number;
  readonly budget: number;
  readonly workers: number;
  /** 兵力值：存活戰鬥單位成本總和 */
  readonly army: number;
  readonly gathered: number;
}

export interface FrameView {
  readonly tick: number;
  readonly over: boolean;
  readonly viewer: number;
  readonly players: PlayerFrame[];
  readonly units: UnitFrame[];
  readonly buildings: BuildingFrame[];
  /** 各礦點（依 nodes 順序）的儲量：觀看者已知值 */
  readonly nodes: number[];
  readonly towers: { readonly owner: number; readonly progress: number[] }[];
  /** 迷霧：0 未探索、1 已探索不可見、2 目前可見；上帝視角為 null */
  readonly fog: Uint8Array | null;
}

export function staticMapView(m: Match, names: readonly string[]): StaticMapView {
  const s = m.state;
  return {
    mode: s.mode,
    seed: s.seed,
    width: s.width,
    height: s.height,
    tiles: Array.from(s.map.tiles),
    nodes: s.nodes.map((n) => ({ id: n.id, tileX: n.tileX, tileY: n.tileY, rich: n.rich })),
    towers: s.towers.map((t) => ({ id: t.id, x: t.x, y: t.y })),
    players: s.players.map((p) => ({ id: p.id, name: names[p.id] ?? `P${p.id}`, startTileX: s.map.slots[p.slot].tileX, startTileY: s.map.slots[p.slot].tileY })),
  };
}

function unitFrame(u: Unit, attacking: number): UnitFrame {
  return {
    id: u.id,
    owner: u.owner,
    type: u.type,
    x: u.x,
    y: u.y,
    hp: u.hp,
    maxHp: UNIT_STATS[u.type].hp,
    stance: u.stance,
    group: u.group,
    order: u.order.kind,
    carrying: u.carry,
    attacking,
  };
}

function playerFrame(s: MatchState, p: Player): PlayerFrame {
  let workers = 0;
  let army = 0;
  for (const u of s.units) {
    if (u.owner !== p.id) continue;
    if (u.type === 'worker') workers += 1;
    else if ((COMBAT_UNIT_TYPES as readonly string[]).includes(u.type)) army += UNIT_STATS[u.type].cost;
  }
  return { id: p.id, alive: p.alive, minerals: p.minerals, supplyUsed: p.supplyUsed, supplyCap: p.supplyCap, budget: p.budget, workers, army, gathered: p.stats.gathered };
}

/** viewer = GOD_VIEW 時顯示全部 */
export function frameView(m: Match, viewer: number): FrameView {
  const s = m.state;
  const god = viewer === GOD_VIEW;
  const vp = god ? null : s.players[viewer];
  const recent = (lastTick: number): boolean => s.tick - lastTick <= 2;
  const units: UnitFrame[] = [];
  for (const u of s.units) {
    if (vp !== null && u.owner !== viewer && !unitVisibleTo(s, vp, u)) continue;
    units.push(unitFrame(u, recent(u.lastHitTick) ? u.lastHitTarget : 0));
  }
  const buildings: BuildingFrame[] = [];
  for (const b of s.buildings) {
    if (vp !== null && b.owner !== viewer && !buildingVisibleTo(s, vp, b)) continue;
    const st = BUILDING_STATS[b.type];
    buildings.push({
      id: b.id,
      owner: b.owner,
      type: b.type,
      tileX: b.tileX,
      tileY: b.tileY,
      size: b.size,
      hp: b.hp,
      maxHp: b.maxHp,
      complete: b.complete,
      progress: b.complete ? 100 : idiv(b.progress * 100, st.buildTicks),
      queue: b.queue.map((q) => ({ unit: q.unit, progress: idiv(q.progress * 100, UNIT_STATS[q.unit].trainTicks) })),
      rally: b.hasRally ? { x: b.rallyX, y: b.rallyY } : null,
      remembered: false,
      attacking: recent(b.lastHitTick) ? b.lastHitTarget : 0,
    });
  }
  if (vp !== null) {
    for (const mem of vp.memory.values()) {
      if (mem.visibleNow) continue;
      buildings.push({
        id: mem.id,
        owner: mem.owner,
        type: mem.type,
        tileX: mem.tileX,
        tileY: mem.tileY,
        size: mem.size,
        hp: mem.hp,
        maxHp: BUILDING_STATS[mem.type].hp,
        complete: mem.complete,
        progress: mem.progressPercent,
        queue: [],
        rally: null,
        remembered: true,
        attacking: 0,
      });
    }
  }
  let fog: Uint8Array | null = null;
  if (vp !== null) {
    fog = new Uint8Array(s.width * s.height);
    for (let i = 0; i < fog.length; i++) fog[i] = vp.vis[i] > 0 ? 2 : vp.explored[i] !== 0 ? 1 : 0;
  }
  return {
    tick: s.tick,
    over: s.over,
    viewer,
    players: s.players.map((p) => playerFrame(s, p)),
    units,
    buildings,
    nodes: s.nodes.map((n) => (vp === null ? n.reserve : vp.nodeKnown[n.index])),
    // 佔領者：看不到瞭望塔時為 -2（未知）
    towers: s.towers.map((t) => ({ owner: vp === null || vp.vis[tileIndex(s, t.x, t.y)] > 0 ? t.owner : -2, progress: Array.from(t.progress) })),
    fog,
  };
}
