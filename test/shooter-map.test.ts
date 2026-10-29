import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_ID, MAPS, blocksMove, cellOf, dumpAscii, inRect, isSolidCell, reachable, regionsAt, type ShooterMap } from '../src/shooter/map.ts';
import { TEAM_SIZE, UNIT } from '../src/shooter/config.ts';
import { lineOfSight } from '../src/shooter/vision.ts';

for (const id of Object.keys(MAPS)) describe(`地圖 ${id}`, () => mapChecks(MAPS[id]()));

function mapChecks(map: ShooterMap): void {
  it('外框全是牆', () => {
    for (let x = 0; x < map.width; x++) {
      expect(isSolidCell(map, x, 0)).toBe(true);
      expect(isSolidCell(map, x, map.height - 1)).toBe(true);
    }
    for (let y = 0; y < map.height; y++) {
      expect(isSolidCell(map, 0, y)).toBe(true);
      expect(isSolidCell(map, map.width - 1, y)).toBe(true);
    }
  });

  it('雙方各有 5 個出生點，都在出生區內且不是牆', () => {
    for (const t of ['T', 'CT'] as const) {
      expect(map.spawns[t].length).toBeGreaterThanOrEqual(TEAM_SIZE);
      for (const s of map.spawns[t]) {
        const cx = cellOf(s.x);
        const cy = cellOf(s.y);
        expect(blocksMove(map, cx, cy)).toBe(false);
        expect(inRect(map.spawnZones[t], cx, cy)).toBe(true);
      }
    }
  });

  it('從 T 出生可走到 CT 出生與 A、B 兩個炸彈點', () => {
    const s = map.spawns.T[0];
    const seen = reachable(map, cellOf(s.x), cellOf(s.y));
    const c = map.spawns.CT[0];
    expect(seen[cellOf(c.y) * map.width + cellOf(c.x)]).toBe(1);
    for (const site of map.sites) {
      let open = 0;
      let reached = 0;
      for (let y = site.y0; y < site.y1; y++) {
        for (let x = site.x0; x < site.x1; x++) {
          if (blocksMove(map, x, y)) continue;
          open += 1;
          if (seen[y * map.width + x] === 1) reached += 1;
        }
      }
      expect(open).toBeGreaterThan(50);
      expect(reached).toBe(open);
    }
  });

  it('沒有孤島：所有可走格都連通', () => {
    const s = map.spawns.T[0];
    const seen = reachable(map, cellOf(s.x), cellOf(s.y));
    let open = 0;
    let reached = 0;
    for (let i = 0; i < map.solid.length; i++) {
      if (map.solid[i] !== 0) continue;
      open += 1;
      if (seen[i] === 1) reached += 1;
    }
    expect(reached).toBe(open);
  });

  it('T 出生區與 CT 出生區之間沒有任何直線視線（兩區可走格中心兩兩檢查）', () => {
    const cells = (t: 'T' | 'CT'): [number, number][] => {
      const z = map.spawnZones[t];
      const out: [number, number][] = [];
      for (let y = z.y0; y < z.y1; y++) for (let x = z.x0; x < z.x1; x++) if (!blocksMove(map, x, y)) out.push([x * UNIT + UNIT / 2, y * UNIT + UNIT / 2]);
      return out;
    };
    const ts = cells('T');
    const cts = cells('CT');
    expect(ts.length).toBeGreaterThan(100);
    expect(cts.length).toBeGreaterThan(100);
    const seen: string[] = [];
    for (const [ax, ay] of ts) for (const [bx, by] of cts) if (lineOfSight(map, ax, ay, bx, by)) seen.push(`(${ax}, ${ay}) → (${bx}, ${by})`);
    expect(seen.slice(0, 5)).toEqual([]);
  });

  it('區域查詢：T 出生點在 tSpawn，A 點中心在 aSite', () => {
    const s = map.spawns.T[0];
    expect(regionsAt(map, s.x, s.y)).toContain('tSpawn');
    const a = map.sites[0];
    expect(regionsAt(map, ((a.x0 + a.x1) / 2) * UNIT, ((a.y0 + a.y1) / 2) * UNIT)).toContain('aSite');
  });

  it('文字圖尺寸正確', () => {
    const rows = dumpAscii(map).split('\n');
    expect(rows.length).toBe(map.height);
    expect(rows[0].length).toBe(map.width);
  });
}

describe('預設地圖（赤岩鎮，v0.5）', () => {
  const map = MAPS[DEFAULT_MAP_ID]();

  it('預設是赤岩鎮；可走面積四到五成、每個包點都有矮牆', () => {
    expect(map.id).toBe('redrock');
    const open = map.solid.filter((v) => v === 0).length;
    expect(open / map.solid.length).toBeGreaterThan(0.4);
    expect(open / map.solid.length).toBeLessThan(0.55);
    for (const s of map.sites) {
      let low = 0;
      for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) if (map.solid[y * map.width + x] === 2) low += 1;
      expect(low).toBeGreaterThan(0);
    }
  });

  it('每個包點至少三個入口（包點外框一圈上的連通開口段數）', () => {
    for (const site of map.sites) {
      const id = site.id === 'A' ? 'aSite' : 'bSite';
      const r = map.regions.find((g) => g.id === id)!;
      // 沿區域外一圈走，數「可走」連續段
      const ring: [number, number][] = [];
      for (let x = r.x0 - 1; x <= r.x1; x++) ring.push([x, r.y0 - 1]);
      for (let y = r.y0; y <= r.y1; y++) ring.push([r.x1, y]);
      for (let x = r.x1 - 1; x >= r.x0 - 1; x--) ring.push([x, r.y1]);
      for (let y = r.y1 - 1; y >= r.y0; y--) ring.push([r.x0 - 1, y]);
      let segs = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i];
        const [px, py] = ring[(i + ring.length - 1) % ring.length];
        if (!blocksMove(map, x, y) && blocksMove(map, px, py)) segs += 1;
      }
      expect(segs, site.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('矮牆擋移動但不擋站姿視線', () => {
    const i = map.solid.indexOf(2);
    const cx = i % map.width;
    const cy = (i - cx) / map.width;
    expect(blocksMove(map, cx, cy)).toBe(true);
    expect(isSolidCell(map, cx, cy)).toBe(false);
    expect(dumpAscii(map)).toContain('=');
  });
});
