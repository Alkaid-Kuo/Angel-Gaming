// 引擎 0.4 步驟 3～6 共用的最小城池測試圖與小工具。
// 「測試城池」：40 × 24 格、全高 1 階；x = 20 一整列城牆，y = 10～12 是正門（3 格門樓）、y = 18 是側門（1 格門樓），
// 城內側 (21, 4) 一格樓梯。紅方（player 1）是守方，在牆東側（城內，含牆頂）；藍方（player 0）在牆西側。
import { T, TILE } from '../src/legion/config.ts';
import { finishMap, registerMap, tileXY, type LegionMap, type LegionMapSpec } from '../src/legion/map.ts';
import { LegionMatch } from '../src/legion/sim.ts';
import type { LegionEvent } from '../src/legion/api.ts';
import type { LegionMode } from '../src/legion/config.ts';

export const CW = 40;
export const CH = 24;
export const WALL_X = 20;
export const STAIR = [21, 4] as const;

export function castleSpec(id: string, extra: Partial<LegionMapSpec> = {}): LegionMapSpec {
  const terrain = new Uint8Array(CW * CH);
  const heights = new Uint8Array(CW * CH).fill(1);
  for (let y = 0; y < CH; y++) terrain[y * CW + WALL_X] = T.Wall;
  for (let y = 10; y <= 12; y++) terrain[y * CW + WALL_X] = T.Gatehouse;
  terrain[18 * CW + WALL_X] = T.Gatehouse;
  terrain[STAIR[1] * CW + STAIR[0]] = T.Stair;
  return {
    id,
    name: '測試城池',
    description: '一整列城牆、一座三格寬的正門、一座一格寬的側門、城內一格樓梯。',
    width: CW,
    height: CH,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: WALL_X, y1: CH },
      { x0: WALL_X, y0: 0, x1: CW, y1: CH },
    ],
    rearX: [0, CW * TILE],
    flags: [],
    spawns: [
      { x: 5000, y: 12000 },
      { x: 35000, y: 12000 },
    ],
    supplies: [],
    landmarks: [],
    gates: [
      { x0: WALL_X, y0: 10, x1: WALL_X + 1, y1: 13, kind: 'main' },
      { x0: WALL_X, y0: 18, x1: WALL_X + 1, y1: 19, kind: 'side' },
    ],
    defender: 1,
    ...extra,
  };
}

export function castleMap(id = 'test-castle', extra: Partial<LegionMapSpec> = {}): LegionMap {
  const m = finishMap(castleSpec(id, extra));
  registerMap(m);
  return m;
}

export type Dep = { type: string; x: number; y: number; facing?: number; layer?: number; formation?: string; width?: number; reserve?: boolean };

export function castleMatch(mapId: string, a: Dep[], b: Dep[], mode: LegionMode = 'annihilation', seed = 11): { m: LegionMatch; events: LegionEvent[] } {
  const m = new LegionMatch({ seed, mode, mapId, deployments: [a, b] });
  const events: LegionEvent[] = [...m.events];
  m.eventTap = (e) => events.push(e);
  return { m, events };
}

export function run(m: LegionMatch, ticks: number, cmds?: (tick: number) => [number, unknown[]][]): void {
  for (let i = 0; i < ticks && !m.over; i++) {
    if (m.isDecisionTick() && cmds) for (const [p, cc] of cmds(m.tick)) m.applyCommands(p, cc);
    m.step();
  }
}

export function tileAt(map: LegionMap, x: number, y: number): number {
  const [tx, ty] = tileXY(x, y, map.width, map.height);
  return map.terrain[ty * map.width + tx];
}

/** 被拒絕的指令：[player, command, reason] */
export function rejected(events: LegionEvent[]): [number, string, string][] {
  return events.flatMap((e) => (e.type === 'rejected' ? [[e.player, e.command, e.reason] as [number, string, string]] : []));
}

/** 把整團瞬間移到 (x, y)（測試用） */
export function teleport(m: LegionMatch, reg: number, x: number, y: number): void {
  const r = m.regiments[reg];
  const dx = x - r.x;
  const dy = y - r.y;
  r.x = x;
  r.y = y;
  for (const sid of r.slots) {
    m.soldiers[sid].x += dx;
    m.soldiers[sid].y += dy;
  }
}

/** 一團的總血量 */
export function hpOf(m: LegionMatch, reg: number): number {
  return m.regiments[reg].slots.reduce((s, id) => s + m.soldiers[id].hp, 0);
}
