import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_ID, MAPS, cellOf, dumpAscii, inRect, isSolidCell, reachable, regionsAt } from '../src/shooter/map.ts';
import { TEAM_SIZE, UNIT } from '../src/shooter/config.ts';

const map = MAPS[DEFAULT_MAP_ID]();

describe('沙城地圖', () => {
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
        expect(isSolidCell(map, cx, cy)).toBe(false);
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
          if (isSolidCell(map, x, y)) continue;
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
      if (map.solid[i] === 1) continue;
      open += 1;
      if (seen[i] === 1) reached += 1;
    }
    expect(reached).toBe(open);
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
});
