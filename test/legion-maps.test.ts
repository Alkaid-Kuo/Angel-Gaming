// 引擎 0.4 步驟 7：石關城、大草原與公開的地圖特徵（features）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { T, TILE } from '../src/legion/config.ts';
import { LEAGUE_MAPS, MAPS, mapFeatures, tileXY, type LegionMap } from '../src/legion/map.ts';
import { findPath } from '../src/legion/path.ts';
import { LegionBatchController, runLegionMatch } from '../src/legion/runner.ts';
import { legionInitData } from '../src/legion/sim.ts';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';

const tileAt = (m: LegionMap, x: number, y: number): number => {
  const [tx, ty] = tileXY(x, y, m.width, m.height);
  return m.terrain[ty * m.width + tx];
};

/** 路徑沿途經過的格（每 250 單位取樣） */
function tilesAlong(m: LegionMap, sx: number, sy: number, pts: [number, number][]): Set<number> {
  const out = new Set<number>();
  let px = sx;
  let py = sy;
  for (const [x, y] of pts) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x - px), Math.abs(y - py)) / 250));
    for (let k = 0; k <= n; k++) {
      const [tx, ty] = tileXY(px + Math.round(((x - px) * k) / n), py + Math.round(((y - py) * k) / n), m.width, m.height);
      out.add(ty * m.width + tx);
    }
    px = x;
    py = y;
  }
  return out;
}

describe('軍團戰 0.4：石關城', () => {
  const m = MAPS['stone-pass']();
  const f = mapFeatures(m);

  it('城池在東側、守方是紅方；正門朝攻方（西牆）、北牆側門、南牆缺口；衝車與砲擊來向在地圖資料', () => {
    expect([m.width, m.height, m.defender, m.symmetric]).toEqual([180, 120, 1, false]);
    expect(m.gates.map((g) => g.kind)).toEqual(['main', 'side']);
    expect(m.gates[0].x0).toBeLessThan(m.gates[1].x0);
    expect(m.bombardFrom).toBe(180);
    expect(tileAt(m, m.ram!.x, m.ram!.y)).not.toBe(T.Wall);
    const [rx] = tileXY(m.ram!.x, m.ram!.y, m.width, m.height);
    expect(rx).toBeLessThan(m.deploy[0].x1);
    // 旗：A 在正門、B 在本陣高台
    expect(tileAt(m, m.flags[0].x, m.flags[0].y)).toBe(T.Gatehouse);
    expect(m.heights[Math.floor(m.flags[1].y / TILE) * m.width + Math.floor(m.flags[1].x / TILE)]).toBe(4);
  });

  it('features 與地形一致：每座城門都在門樓上、每座樓梯都在樓梯格、樓梯貼著城牆、隘口含兩座門與一處缺口', () => {
    expect(f.gates.length).toBe(2);
    for (const g of f.gates) for (let y = g.y0; y < g.y1; y++) for (let x = g.x0; x < g.x1; x++) expect(m.terrain[y * m.width + x]).toBe(T.Gatehouse);
    expect(f.stairs.length).toBe(9);
    for (const s of f.stairs) {
      expect(tileAt(m, s.x, s.y)).toBe(T.Stair);
      const [tx, ty] = tileXY(s.x, s.y, m.width, m.height);
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => m.terrain[(ty + dy) * m.width + tx + dx]);
      expect(nb).toContain(T.Wall);
      expect(nb).not.toContain(T.Gatehouse);
    }
    expect(f.chokes.map((c) => [c.kind, c.width])).toEqual([
      ['gate', 3],
      ['gate', 2],
      ['breach', 3],
    ]);
    for (const c of f.chokes.filter((q) => q.kind === 'breach')) expect(tileAt(m, c.x, c.y)).toBe(T.Plain);
    expect(f.walls.length).toBeGreaterThanOrEqual(5);
    for (const wseg of f.walls) {
      expect(wseg.height).toBe(4);
      expect(wseg.x0 === wseg.x1 || wseg.y0 === wseg.y1).toBe(true);
      for (const [x, y] of [[wseg.x0, wseg.y0], [wseg.x1, wseg.y1]]) expect([T.Wall, T.Gatehouse]).toContain(tileAt(m, x, y));
    }
    expect(f.highs.some((q) => q.height === 4 && Math.abs(q.x - m.flags[1].x) < 2000 && Math.abs(q.y - m.flags[1].y) < 2000)).toBe(true);
    expect(f.covers.length).toBe(1);
    expect(tileAt(m, f.covers[0].x, f.covers[0].y)).toBe(T.Forest);
  });

  it('從攻方布陣區到本陣至少兩條路線：門都關著走南牆缺口，正門開著走正門', () => {
    const [sx, sy] = [10500, 60500];
    const [gx, gy] = [m.flags[1].x, m.flags[1].y];
    const closed = findPath(m, sx, sy, gx, gy, false, 0, false, { open: new Uint8Array(m.width * m.height), links: null, linkCost: 0 });
    const open = new Uint8Array(m.width * m.height);
    const g = m.gates[0];
    for (let y = g.y0; y < g.y1; y++) for (let x = g.x0; x < g.x1; x++) open[y * m.width + x] = 1;
    const viaGate = findPath(m, sx, sy, gx, gy, false, 0, false, { open, links: null, linkCost: 0 });
    expect(closed).not.toBeNull();
    expect(viaGate).not.toBeNull();
    const a = tilesAlong(m, sx, sy, closed!);
    const b = tilesAlong(m, sx, sy, viaGate!);
    const breach = m.breaches![0];
    const inRect = (set: Set<number>, r: { x0: number; y0: number; x1: number; y1: number }): boolean => [...set].some((i) => i % m.width >= r.x0 && i % m.width < r.x1 && Math.floor(i / m.width) >= r.y0 && Math.floor(i / m.width) < r.y1);
    expect(inRect(a, breach)).toBe(true);
    expect(inRect(a, g)).toBe(false);
    expect(inRect(b, g)).toBe(true);
    expect(inRect(b, breach)).toBe(false);
    // 側門開著也走得到
    const side = new Uint8Array(m.width * m.height);
    const sg = m.gates[1];
    for (let y = sg.y0; y < sg.y1; y++) for (let x = sg.x0; x < sg.x1; x++) side[y * m.width + x] = 1;
    expect(findPath(m, 136500, 10500, 136500, 30500, false, 0, false, { open: side, links: null, linkCost: 0 })).not.toBeNull();
    expect(findPath(m, 136500, 10500, 136500, 30500, false, 0, false, { open: new Uint8Array(m.width * m.height), links: null, linkCost: 0 })?.length ?? 0).toBeGreaterThan(1);
  });

  it('開局資料帶 features、守方座位、衝車與砲擊來向', () => {
    const d = legionInitData(m, 'siege', 0, {}, 100);
    expect(d.map.features).toBe(f);
    expect([d.map.defender, d.map.bombardFrom]).toEqual([1, 180]);
    expect(d.map.ram).toEqual({ x: m.ram!.x, y: m.ram!.y, facing: 0 });
    expect(d.map.terrain.filter((t) => t === T.Stair).length).toBe(9);
  });
});

describe('軍團戰 0.4：大草原', () => {
  const m = MAPS.grassland();

  it('旋轉 180° 對稱（地形與高度）、三面旗南北拉開、開闊少障礙', () => {
    const n = m.terrain.length;
    for (let i = 0; i < n; i++) {
      expect(m.terrain[i]).toBe(m.terrain[n - 1 - i]);
      expect(m.heights[i]).toBe(m.heights[n - 1 - i]);
    }
    expect(m.symmetric).toBe(true);
    expect(m.flags.length).toBe(3);
    const W = m.width * TILE;
    const H = m.height * TILE;
    expect([m.flags[0].x, m.flags[0].y]).toEqual([W - m.flags[2].x, H - m.flags[2].y]);
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y) / TILE;
    const gv = MAPS['grand-valley']();
    expect(dist(m.flags[0], m.flags[1])).toBeGreaterThan(dist(gv.flags[0], gv.flags[1]) + 5);
    const blocked = m.terrain.filter((t) => t !== T.Plain && t !== T.Road && t !== T.Hill).length;
    expect(blocked / n).toBeLessThan(0.05);
    expect(m.terrain.some((t) => t === T.River || t === T.Wall)).toBe(false);
  });
});

describe('軍團戰 0.4：既有地圖的 features 與聯賽地圖表', () => {
  it('大河谷：兩座橋、一處淺灘、樹林與高地；沒有牆、城門、樓梯', () => {
    const f = mapFeatures(MAPS['grand-valley']());
    expect(f.walls).toEqual([]);
    expect(f.gates).toEqual([]);
    expect(f.stairs).toEqual([]);
    expect(f.chokes.filter((c) => c.kind === 'bridge').length).toBe(2);
    expect(f.chokes.filter((c) => c.kind === 'ford').length).toBe(1);
    expect(f.chokes.find((c) => c.kind === 'bridge')!.width).toBe(3);
    expect(f.covers.length).toBeGreaterThanOrEqual(10);
    expect(f.highs.length).toBeGreaterThanOrEqual(4);
  });

  it('聯賽地圖：攻城一張、佔點兩張，都註冊在 MAPS', () => {
    expect(LEAGUE_MAPS).toEqual({ siege: ['stone-pass'], capture: ['grand-valley', 'grassland'] });
    for (const id of [...LEAGUE_MAPS.siege, ...LEAGUE_MAPS.capture]) expect(MAPS[id]).toBeDefined();
  });
});

describe('軍團戰 0.4：新地圖可以完整打一場', () => {
  const bot = (name: string): CompiledBot => compileBot(readFileSync(`bots/legion-${name}.js`, 'utf8'), `legion-${name}.js`);
  const play = (mode: 'siege' | 'capture', mapId: string, seed: number): ReturnType<typeof runLegionMatch> => {
    const map = MAPS[mapId]();
    const ctrls = ['push', 'ambush'].map((n, i) => new LegionBatchController(bot(n), n, map, seed, i));
    return runLegionMatch({ seed, mode, mapId, controllers: ctrls, knobs: ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label)), record: true });
  };

  it('攻城戰（石關城）與佔點（大草原）：基準 AI 不出錯、同 seed 結果相同', () => {
    for (const [mode, mapId] of [['siege', 'stone-pass'], ['capture', 'grassland']] as const) {
      const a = play(mode, mapId, 9);
      const b = play(mode, mapId, 9);
      expect(a.finalHash).toBe(b.finalHash);
      for (const rt of a.runtime) expect(rt.errors).toEqual([]);
      expect(a.result.durationTicks).toBeGreaterThan(0);
    }
  });
});
