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
  const ti = (x: number, y: number): number => y * m.width + x;
  const tt = (x: number, y: number): number => m.terrain[ti(x, y)];

  it('背靠大河的方城、守方是紅方；正門朝攻方（西牆）、北牆側門、南牆缺口；衝車與砲擊來向在地圖資料', () => {
    expect([m.width, m.height, m.defender, m.symmetric]).toEqual([200, 140, 1, false]);
    expect(m.gates.map((g) => g.kind)).toEqual(['main', 'side']);
    expect(m.bombardFrom).toBe(180);
    const [rx] = tileXY(m.ram!.x, m.ram!.y, m.width, m.height);
    expect(rx).toBeLessThan(m.deploy[0].x1);
    // 旗：A 在正門、B 在衙署院落（高一階）
    expect(tileAt(m, m.flags[0].x, m.flags[0].y)).toBe(T.Gatehouse);
    expect(tileAt(m, m.flags[1].x, m.flags[1].y)).toBe(T.Paved);
    expect(m.heights[ti(171, 69)]).toBe(3);
    // 東牆臨河，城的背後沒有路
    for (let y = 31; y < 109; y++) expect([T.River, T.Wall]).toContain(tt(189, y));
  });

  it('城牆四格厚（牆頂站得下方陣）、角樓 8 × 8、正門外有甕城（入口在西面）', () => {
    for (const x of [130, 160]) for (let y = 30; y <= 33; y++) expect(tt(x, y)).toBe(T.Wall);
    for (let x = 110; x <= 113; x++) expect(tt(x, 50)).toBe(T.Wall);
    for (let y = 28; y <= 35; y++) for (let x = 108; x <= 115; x++) expect(tt(x, y)).toBe(T.Wall);
    // 甕城：三面三格厚的牆、西面北段的入口、裡面鋪石
    expect(tt(97, 70)).toBe(T.Wall);
    expect(tt(97, 62)).toBe(T.Paved);
    expect(tt(104, 70)).toBe(T.Paved);
  });

  it('城內全部鋪石（沒有草地），缺口是瓦礫；護城河繞西北南三面，過河處只有西橋、北橋、南淺灘', () => {
    const mask = m.deployMask![1]!;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1) expect(m.terrain[i]).not.toBe(T.Plain);
    expect(tt(148, 107)).toBe(T.Rubble);
    expect(tt(100, 40)).toBe(T.River);
    expect(tt(140, 22)).toBe(T.River);
    expect(tt(140, 117)).toBe(T.River);
    expect(tt(90, 70)).toBe(T.River);
    expect(tt(90, 62)).toBe(T.Bridge);
    expect(tt(150, 22)).toBe(T.Bridge);
    expect(tt(148, 117)).toBe(T.Shallow);
    // 護城堤（城牆與護城河之間）是地面，可以架雲梯
    expect(tt(140, 26)).toBe(T.Plain);
    expect(tt(140, 113)).toBe(T.Plain);
    expect(tt(105, 45)).toBe(T.Plain);
  });

  it('守方布陣區：城內、甕城、城牆；護城堤、護城河不行', () => {
    const mask = m.deployMask![1]!;
    expect(m.deployMask![0]).toBeNull();
    expect(mask[ti(150, 69)]).toBe(1);
    expect(mask[ti(111, 50)]).toBe(1);
    expect(mask[ti(104, 70)]).toBe(1);
    expect(mask[ti(140, 26)]).toBe(0);
    expect(mask[ti(100, 40)]).toBe(0);
    const d = legionInitData(m, 'siege', 1, {}, 100);
    expect(d.map.deployMask[1]![ti(150, 69)]).toBe(1);
    expect(d.map.deployMask[0]).toBeNull();
  });

  it('features 與地形一致：城門在門樓上、馬道在樓梯格且貼著城牆、隘口含兩座橋、淺灘、兩座城門、兩個門洞與缺口', () => {
    expect(f.gates.length).toBe(2);
    for (const g of f.gates) for (let y = g.y0; y < g.y1; y++) for (let x = g.x0; x < g.x1; x++) expect(tt(x, y)).toBe(T.Gatehouse);
    expect(f.stairs.length).toBeGreaterThanOrEqual(30);
    for (const s of f.stairs) {
      const [tx, ty] = tileXY(s.x, s.y, m.width, m.height);
      expect(tt(tx, ty)).toBe(T.Stair);
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => tt(tx + dx, ty + dy));
      expect(nb).not.toContain(T.Gatehouse);
    }
    expect(f.chokes.map((c) => [c.kind, c.width])).toEqual([
      ['bridge', 2],
      ['bridge', 4],
      ['ford', 5],
      ['gate', 3],
      ['gate', 2],
      ['arch', 4],
      ['arch', 5],
      ['breach', 5],
    ]);
    for (const wseg of f.walls) {
      expect(wseg.height).toBe(5);
      expect(wseg.x0 === wseg.x1 || wseg.y0 === wseg.y1).toBe(true);
    }
    expect(f.highs.some((q) => q.height === 3 && Math.abs(q.x - m.flags[1].x) < 4000 && Math.abs(q.y - m.flags[1].y) < 4000)).toBe(true);
    // 城外西北的樹林（給攻方藏兵）
    expect(f.covers.some((c) => c.x < 95000 && c.y < 45000)).toBe(true);
  });

  it('從攻方布陣區到衙署至少兩條路線：門都關著走南牆缺口，正門開著走甕城與正門；北側門開著從北邊進城', () => {
    const [sx, sy] = [10500, 63500];
    const [gx, gy] = [m.flags[1].x, m.flags[1].y];
    const none = (): Uint8Array => new Uint8Array(m.width * m.height);
    const closed = findPath(m, sx, sy, gx, gy, false, 0, false, { open: none(), links: null, linkCost: 0 });
    const open = none();
    const g = m.gates[0];
    for (let y = g.y0; y < g.y1; y++) for (let x = g.x0; x < g.x1; x++) open[ti(x, y)] = 1;
    const viaGate = findPath(m, sx, sy, gx, gy, false, 0, false, { open, links: null, linkCost: 0 });
    expect(closed).not.toBeNull();
    expect(viaGate).not.toBeNull();
    const a = tilesAlong(m, sx, sy, closed!);
    const b = tilesAlong(m, sx, sy, viaGate!);
    const breach = m.breaches![0];
    const arch = m.archways![0];
    const inRect = (set: Set<number>, r: { x0: number; y0: number; x1: number; y1: number }): boolean => [...set].some((i) => i % m.width >= r.x0 && i % m.width < r.x1 && Math.floor(i / m.width) >= r.y0 && Math.floor(i / m.width) < r.y1);
    expect(inRect(a, breach)).toBe(true);
    expect(inRect(a, g)).toBe(false);
    expect(inRect(b, g)).toBe(true);
    expect(inRect(b, arch)).toBe(true);
    expect(inRect(b, breach)).toBe(false);
    const side = none();
    const sg = m.gates[1];
    for (let y = sg.y0; y < sg.y1; y++) for (let x = sg.x0; x < sg.x1; x++) side[ti(x, y)] = 1;
    const viaSide = findPath(m, 151000, 10500, 151000, 45500, false, 0, false, { open: side, links: null, linkCost: 0 });
    const around = findPath(m, 151000, 10500, 151000, 45500, false, 0, false, { open: none(), links: null, linkCost: 0 });
    expect(viaSide).not.toBeNull();
    expect(inRect(tilesAlong(m, 151000, 10500, viaSide!), sg)).toBe(true);
    expect(around).not.toBeNull();
    expect(inRect(tilesAlong(m, 151000, 10500, around!), breach)).toBe(true);
  });

  it('開局資料帶 features、守方座位、衝車與砲擊來向', () => {
    const d = legionInitData(m, 'siege', 0, {}, 100);
    expect(d.map.features).toBe(f);
    expect([d.map.defender, d.map.bombardFrom]).toEqual([1, 180]);
    expect(d.map.ram).toEqual({ x: m.ram!.x, y: m.ram!.y, facing: 0 });
    expect(d.map.terrain.filter((t) => t === T.Stair).length).toBe(f.stairs.length);
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
