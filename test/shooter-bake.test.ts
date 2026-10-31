// 攻防戰烘焙層的幾何（src/web/shooter/outline.ts、materials.ts）。不需要 DOM：牆路徑用同一組折線做點在多邊形內的判斷，
// 跟瀏覽器裡 isPointInPath(wall, x, y, 'evenodd') 是同一個定義（倒圓角只會讓轉角多蓋 0.12 格，到不了格中心）。
// 真正的 Path2D 與 canvas：有 OffscreenCanvas 的環境才跑，Node 底下略過；瀏覽器驗收見交付報告。
import { describe, expect, it } from 'vitest';
import { MAPS, OLD_TOWN_LAYOUT, mapVisual, mapVisualOf } from '../src/shooter/map.ts';
import { SLOPE_WALL, slopeCorner } from '../src/shooter/map.ts';
import { shooterInitData } from '../src/shooter/sim.ts';
import { freePoint, inPolygon, lowKind, lowRects, openLoops, pointInWall, regionLabels, siteSpot, traceLoops, type BakeMap } from '../src/web/shooter/outline.ts';
import { ZONES, hash2, rng, zoneGrid, zoneOfRegion } from '../src/web/shooter/materials.ts';

/** 手工小圖：. 可走、# 牆、= 矮牆、1～4 斜切牆（實心角 西北、東北、東南、西南） */
function grid(rows: readonly string[]): BakeMap {
  const height = rows.length;
  const width = rows[0].length;
  const solid: number[] = [];
  for (const row of rows) {
    for (const ch of row) solid.push(ch === '#' ? 1 : ch === '=' ? 2 : ch >= '1' && ch <= '4' ? SLOPE_WALL + Number(ch) - 1 : 0);
  }
  const zone = { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { id: 'test', name: '測試', width, height, solid, sites: [], spawnZones: { T: zone, CT: zone }, regions: [] };
}

function expectNothingCovered(m: BakeMap): number {
  const loops = openLoops(m);
  let checked = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const p = freePoint(m, x, y);
      if (p === null) continue;
      checked++;
      if (pointInWall(loops, p[0], p[1])) throw new Error(`${m.id}：可走格 (${x}, ${y}) 被牆路徑蓋住`);
    }
  }
  return checked;
}

describe('牆路徑不蓋可走格', () => {
  it('赤岩舊城（斜切格與鋸齒階梯）', () => {
    expect(expectNothingCovered(MAPS.redrock())).toBeGreaterThan(5000);
  });

  it('沙城', () => {
    expect(expectNothingCovered(MAPS.dust())).toBeGreaterThan(100);
  });

  it('階梯：一格一階的鋸齒能收、但不蓋到可走格', () => {
    const rows = Array.from({ length: 24 }, (_, y) => Array.from({ length: 24 }, (_, x) => (x + y > 23 ? '#' : '.')).join(''));
    const m = grid(rows);
    expectNothingCovered(m);
    const n = openLoops(m).reduce((a, l) => a + l.length, 0);
    expect(n).toBeLessThan(traceLoops(m).reduce((a, l) => a + l.pts.length, 0));
  });

  it('斜切格：斜邊是真正的 45° 邊，可走半邊不蓋、實心半邊要蓋', () => {
    const m = grid(['######', '#....#', '#...3#', '#..3##', '#.3###', '######']);
    expectNothingCovered(m);
    const loops = openLoops(m);
    // (4, 2) 斜切格：實心角東南；斜邊貫穿三個斜切格，只留兩端
    expect(pointInWall(loops, 4.75, 2.75)).toBe(true);
    expect(pointInWall(loops, 4.25, 2.25)).toBe(false);
    const edge = loops[0].some((p, i) => {
      const q = loops[0][(i + 1) % loops[0].length];
      return Math.abs(p[0] - q[0]) === 3 && Math.abs(p[1] - q[1]) === 3;
    });
    expect(edge).toBe(true);
  });

  it('四個方向的斜切格都算對', () => {
    for (const [c, solidAt, freeAt] of [
      ['1', [1.2, 1.2], [1.8, 1.8]],
      ['2', [1.8, 1.2], [1.2, 1.8]],
      ['3', [1.8, 1.8], [1.2, 1.2]],
      ['4', [1.2, 1.8], [1.8, 1.2]],
    ] as const) {
      const m = grid(['.....', `.${c}...`, '.....', '.....', '.....']);
      expectNothingCovered(m);
      const loops = openLoops(m);
      expect(pointInWall(loops, solidAt[0], solidAt[1])).toBe(true);
      expect(pointInWall(loops, freeAt[0], freeAt[1])).toBe(false);
      expect(slopeCorner(m.solid[6])).toBe(Number(c) - 1);
    }
  });

  it('點在多邊形內', () => {
    const sq = [[0, 0], [2, 0], [2, 2], [0, 2]] as const;
    expect(inPolygon(1, 1, sq)).toBe(true);
    expect(inPolygon(3, 1, sq)).toBe(false);
  });

  it.skipIf(!('OffscreenCanvas' in globalThis))('有 canvas 的環境：isPointInPath 與折線判斷一致', () => {
    // Node 沒有 Path2D／OffscreenCanvas，這段略過；瀏覽器驗收另外跑過同樣的判斷（交付報告的「牆輪廓」一列）
    const g = globalThis as unknown as { OffscreenCanvas: new (w: number, h: number) => { getContext(t: '2d'): { isPointInPath(p: unknown, x: number, y: number, r: 'evenodd'): boolean } }; Path2D: new () => { rect(x: number, y: number, w: number, h: number): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void } };
    const m = MAPS.redrock();
    const path = new g.Path2D();
    path.rect(-8, -8, m.width + 16, m.height + 16);
    for (const l of openLoops(m)) {
      l.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
      path.closePath();
    }
    const ctx = new g.OffscreenCanvas(16, 16).getContext('2d');
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        const p = freePoint(m, x, y);
        if (p !== null) expect(ctx.isPointInPath(path, p[0], p[1], 'evenodd')).toBe(false);
      }
    }
  });
});

describe('材質查表', () => {
  it('表來自樣張：赤岩鎮的區域都有對應', () => {
    expect(zoneOfRegion('cellarHall')).toBe('wood');
    expect(zoneOfRegion('aSite')).toBe('site');
    expect(zoneOfRegion('market')).toBe('market');
    expect(zoneOfRegion('tSpawn')).toBe('plaza');
    expect(zoneOfRegion('eastLane')).toBe('dirt');
    expect(zoneOfRegion('northSt')).toBe('stone');
  });

  it('查不到預設石板', () => {
    expect(zoneOfRegion('沒有這個區域')).toBe('stone');
  });

  it('同一張表涵蓋 redrock2 各版的區域代號', () => {
    for (const id of ['bellLane', 'bellYard', 'eastStore', 'storeDoor', 'sideSouth', 'marketNorth', 'eastYard', 'tMidMouth', 'ctWestDoor', 'shopBarn', 'wineEast']) expect(ZONES).toContain(zoneOfRegion(id));
    expect(zoneOfRegion('marketNorth')).toBe('market');
    expect(zoneOfRegion('eastStore')).toBe('wood');
  });

  it('區域重疊時後面的蓋前面；不在區域裡的格子是石板', () => {
    const zone = (id: string, x0: number, x1: number): { id: string; name: string; x0: number; y0: number; x1: number; y1: number } => ({ id, name: id, x0, y0: 0, x1, y1: 1 });
    const g = zoneGrid({ width: 4, height: 1, regions: [zone('cellar', 0, 3), zone('market', 1, 2)] });
    expect(g).toEqual(['wood', 'market', 'wood', 'stone']);
  });

  it('地圖 JSON 的 material 優先，沒標的查代號表；併入的框跟主區域', () => {
    const zone = (id: string): { id: string; name: string; x0: number; y0: number; x1: number; y1: number } => ({ id, name: id, x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(zoneGrid({ width: 1, height: 1, regions: [zone('cellar')] }, ['dirt'])).toEqual(['dirt']);
    expect(zoneGrid({ width: 1, height: 1, regions: [zone('cellar')] }, [undefined])).toEqual(['wood']);
    const v = mapVisual(OLD_TOWN_LAYOUT);
    expect(v.materials).toHaveLength(MAPS.redrock().regions.length);
    expect(v.materials[OLD_TOWN_LAYOUT.areas.findIndex((a) => a.id === 'storeDoor')]).toBe('wood');
    expect(v.materials.every((m) => m !== undefined)).toBe(true);
  });

  it('theme 與擺設從地圖 JSON 來：井壓在牆上、帆布鋪在空地、包點塗裝在包點裡；沙城沒有擺設', () => {
    const m = MAPS.redrock();
    const v = mapVisualOf('redrock');
    const { wells = [], tarps = [], sitePaint = [] } = v.decor;
    expect(v.theme).toBe('redrock');
    expect(wells.length).toBeGreaterThan(0);
    expect(tarps.length).toBeGreaterThan(0);
    expect(sitePaint.map((s) => s.id)).toEqual(['A', 'B']);
    const cells = (r: { x0: number; y0: number; x1: number; y1: number }): number[] => {
      const out: number[] = [];
      for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) out.push(m.solid[y * m.width + x]);
      return out;
    };
    for (const w of wells) expect(cells(w).every((c) => c === 1)).toBe(true);
    for (const t of tarps) expect(cells(t).every((c) => c === 0)).toBe(true);
    for (const s of sitePaint) {
      const r = m.sites.find((x) => x.id === s.id)!;
      expect(s.x - s.r).toBeGreaterThanOrEqual(r.x0);
      expect(s.x + s.r).toBeLessThanOrEqual(r.x1);
    }
    expect(mapVisualOf('dust').decor).toEqual({});
    expect(mapVisualOf('沒有這張圖').theme).toBe('redrock');
  });

  it('畫面資料不進選手看得到的 MapInfo', () => {
    const data = shooterInitData(MAPS.redrock(), 0, {});
    expect(Object.keys(data.map).sort()).toEqual(['height', 'id', 'name', 'regions', 'sites', 'solid', 'spawnZones', 'spawns', 'width']);
  });
});

describe('矮牆選型與道具', () => {
  it('併成矩形後面積等於矮牆格數', () => {
    const m = MAPS.redrock();
    const area = lowRects(m).reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    expect(area).toBe(Array.from(m.solid).filter((v) => v === 2).length);
  });

  it('同輸入同輸出，三種都選得到', () => {
    const a = lowRects(MAPS.redrock()).map(lowKind);
    const b = lowRects(MAPS.redrock()).map(lowKind);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThanOrEqual(2);
    expect(lowKind({ x0: 3, y0: 9, x1: 5, y1: 10 })).toBe(lowKind({ x0: 3, y0: 9, x1: 5, y1: 10 }));
  });

  it('路標放在可走地面上', () => {
    const m = MAPS.redrock();
    const list = regionLabels(m);
    expect(list.length).toBeGreaterThan(8);
    for (const c of list) expect(m.solid[Math.floor(c.y) * m.width + Math.floor(c.x)]).toBe(0);
  });

  it('包點圓環不壓到牆方塊', () => {
    const m = MAPS.redrock();
    for (const s of m.sites) {
      const spot = siteSpot(m, s);
      expect(spot.x).toBeGreaterThanOrEqual(s.x0);
      expect(spot.x).toBeLessThanOrEqual(s.x1);
      expect(spot.r).toBeGreaterThanOrEqual(3.4);
    }
  });

  it('固定雜湊', () => {
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    expect(rng(7)()).toBe(rng(7)());
  });
});
