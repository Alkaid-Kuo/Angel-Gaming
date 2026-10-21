import { describe, expect, it } from 'vitest';
import { MAP_MODES, MATCH_MODES, TERRAIN } from '../src/config/index.ts';
import { generateMap, renderAscii, validateMap } from '../src/mapgen/index.ts';

describe('mapgen', () => {
  it('同一 seed 產生同一張地圖', () => {
    for (const mode of MATCH_MODES) {
      const a = generateMap(mode, 123);
      const b = generateMap(mode, 123);
      expect(renderAscii(a)).toBe(renderAscii(b));
      expect(a.nodes).toEqual(b.nodes);
    }
  });

  it('不同 seed 產生不同地圖', () => {
    expect(renderAscii(generateMap('1v1', 1))).not.toBe(renderAscii(generateMap('1v1', 2)));
  });

  it('物件數量符合規格', () => {
    for (const mode of MATCH_MODES) {
      const m = generateMap(mode, 5);
      const players = MAP_MODES[mode].players;
      expect(m.width).toBe(MAP_MODES[mode].size);
      expect(m.slots.length).toBe(players);
      expect(m.areas.filter((a) => a.kind === 'main').length).toBe(players);
      expect(m.areas.filter((a) => a.kind === 'expansion').length).toBe(players * 2);
      expect(m.areas.filter((a) => a.kind === 'rich').length).toBe(players);
      expect(m.nodes.filter((n) => !n.rich).length).toBe(players * 12);
      expect(m.nodes.filter((n) => n.rich).length).toBe(players * 2);
      expect(m.watchtowers).toEqual([{ x: m.width * 500, y: m.height * 500 }]);
    }
  });

  for (const mode of MATCH_MODES) {
    it(`${mode}：1000 個 seed 全部通過驗證，且旋轉對稱`, () => {
      const attempts = new Map<number, number>();
      const n = MAP_MODES[mode].size;
      for (let seed = 0; seed < 1000; seed++) {
        const m = generateMap(mode, seed);
        expect(validateMap(m)).toBeNull();
        attempts.set(m.attempt, (attempts.get(m.attempt) ?? 0) + 1);
        // 對稱檢查：每格與其 180°／90° 旋轉對應格相同
        let asym = 0;
        const sectors = MAP_MODES[mode].sectors;
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const rx = sectors === 2 ? n - 1 - x : n - 1 - y;
            const ry = sectors === 2 ? n - 1 - y : x;
            if (m.tiles[y * n + x] !== m.tiles[ry * n + rx]) asym++;
            // 8 人局另需沿對角線鏡射對稱
            if (sectors === 8 && m.tiles[y * n + x] !== m.tiles[x * n + y]) asym++;
          }
        }
        expect(asym).toBe(0);
        expect(m.tiles.every((t) => t === TERRAIN.plain || t === TERRAIN.blocked || t === TERRAIN.forest)).toBe(true);
      }
      const dist = [...attempts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `第${k}次:${v}`).join(' ');
      console.log(`[mapgen ${mode}] 成功嘗試次數分布 ${dist}`);
    });
  }
});
