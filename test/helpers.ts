// 測試用：自訂地圖、建立比賽、推進 tick。
import { MAP_MODES, RULES, TILE_SIZE, type MatchMode, type UnitType } from '../src/config/index.ts';
import { Match } from '../src/core/match.ts';
import type { Player, Unit } from '../src/core/state.ts';
import { createUnit } from '../src/core/world.ts';
import { updateKnowledge, updateVision } from '../src/core/knowledge.ts';
import { UNIT_STATS } from '../src/config/index.ts';
import type { GeneratedMap, MapAreaDef, MapNodeDef, StartSlotDef } from '../src/mapgen/index.ts';
import type { Command, GameEvent } from '../src/api/types.ts';

export interface TestMapOptions {
  readonly mode?: MatchMode;
  /** 各起點主堡左上角格 */
  readonly slots?: readonly [number, number][];
  /** 礦點：[tileX, tileY, areaIndex, rich?] */
  readonly nodes?: readonly [number, number, number, boolean?][];
  /** 礦區：[kind, slot | null] */
  readonly areas?: readonly [MapAreaDef['kind'], number | null][];
  readonly blocked?: readonly [number, number][];
  readonly forest?: readonly [number, number][];
}

/** 全平地的測試地圖（預設 1v1：起點在 (5,5) 與 (56,56)，各一個主礦區） */
export function testMap(opts: TestMapOptions = {}): GeneratedMap {
  const mode = opts.mode ?? '1v1';
  const n = MAP_MODES[mode].size;
  const tiles = new Uint8Array(n * n);
  for (const [x, y] of opts.blocked ?? []) tiles[y * n + x] = 1;
  for (const [x, y] of opts.forest ?? []) tiles[y * n + x] = 2;
  const slotPos = opts.slots ?? (mode === '1v1' ? [[5, 5], [56, 56]] : [[5, 5], [88, 5], [88, 88], [5, 88]]);
  const slots: StartSlotDef[] = slotPos.map(([x, y], slot) => ({ slot, tileX: x, tileY: y }));
  const areaDefs = opts.areas ?? slots.map((s) => ['main', s.slot] as [MapAreaDef['kind'], number | null]);
  const areas: MapAreaDef[] = areaDefs.map(([kind, slot], areaId) => ({ areaId, kind, slot }));
  const nodeDefs = opts.nodes ?? slots.map((s, i) => [s.tileX + 6, s.tileY + 1, i] as [number, number, number]);
  const nodes: MapNodeDef[] = nodeDefs.map(([x, y, a, rich]) => ({
    tileX: x,
    tileY: y,
    rich: rich === true,
    areaId: a,
    reserve: rich === true ? RULES.economy.richNodeReserve : RULES.economy.nodeReserve,
  }));
  return { mode, seed: 0, attempt: 0, width: n, height: n, tiles, nodes, areas, slots, watchtowers: [{ x: n * 500, y: n * 500 }] };
}

export function newMatch(map: GeneratedMap, seed = 1): Match {
  const players = Array.from({ length: MAP_MODES[map.mode].players }, () => ({ knobs: {} }));
  return new Match({ mode: map.mode, seed, players, map });
}

/** 找出佔用某槽位的選手 */
export function playerAtSlot(m: Match, slot: number): Player {
  return m.state.players.find((p) => p.slot === slot)!;
}

/** 直接生成單位（含人口），位置為格中心或指定單位座標 */
export function spawn(m: Match, owner: number, type: UnitType, x: number, y: number): Unit {
  const u = createUnit(m.state, owner, type, x, y);
  m.state.players[owner].supplyUsed += UNIT_STATS[type].supply;
  m.state.spatial.rebuild(m.state.units);
  updateVision(m.state);
  updateKnowledge(m.state);
  return u;
}

export function tc(tile: number): number {
  return tile * TILE_SIZE + TILE_SIZE / 2;
}

/**
 * 推進 n 個 tick。commands 在第一個決策 tick 套用（key 為 playerId）。
 * 回傳期間各選手收到的事件。
 */
export function run(m: Match, n: number, commands?: Record<number, Command[]>): Map<number, GameEvent[]> {
  const events = new Map<number, GameEvent[]>();
  for (const p of m.state.players) events.set(p.id, []);
  let pending = commands;
  for (let i = 0; i < n && !m.over; i++) {
    m.beginTick();
    if (m.isDecisionTick()) {
      for (const p of m.state.players) {
        if (!p.alive) continue;
        const { obs } = m.observe(p.id);
        events.get(p.id)!.push(...obs.events);
        const cmds = pending?.[p.id] ?? [];
        m.applyCommands(p.id, cmds);
      }
      pending = undefined;
    }
    m.endTick();
  }
  for (const p of m.state.players) {
    events.get(p.id)!.push(...p.events);
    p.events = [];
  }
  return events;
}

/** 推進到下一個決策 tick 之前（使下一次 run 的第一個 tick 為決策 tick） */
export function alignToDecision(m: Match): void {
  while (m.tick % RULES.match.decisionInterval !== 0) {
    m.beginTick();
    m.endTick();
  }
}
