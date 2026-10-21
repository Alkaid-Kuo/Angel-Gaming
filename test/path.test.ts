import { describe, expect, it } from 'vitest';
import { PathFinder, pathLength, rectPoint, segmentClear, smoothPath, WALK_BLOCKED, WALK_FOREST, WALK_PLAIN, type WalkGrid } from '../src/path/index.ts';

function gridFrom(rows: string[]): WalkGrid {
  const height = rows.length;
  const width = rows[0].length;
  const walk = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      walk[y * width + x] = ch === '#' ? WALK_BLOCKED : ch === 'T' ? WALK_FOREST : WALK_PLAIN;
    }
  }
  return { width, height, walk };
}

describe('A*', () => {
  it('開闊地直線與斜線距離', () => {
    const g = gridFrom(['.....', '.....', '.....', '.....', '.....']);
    const pf = new PathFinder(5, 5);
    const r = pf.findPath(g, 0, rectPoint(4, 0));
    expect(r.reached).toBe(true);
    expect(pathLength(5, 0, r.tiles)).toBe(4000);
    const r2 = pf.findPath(g, 0, rectPoint(4, 4));
    expect(pathLength(5, 0, r2.tiles)).toBe(4 * 1414);
  });

  it('繞過牆', () => {
    const g = gridFrom([
      '.#...',
      '.#.#.',
      '.#.#.',
      '...#.',
    ]);
    const pf = new PathFinder(5, 4);
    const r = pf.findPath(g, 0, rectPoint(4, 0));
    expect(r.reached).toBe(true);
    for (const t of r.tiles) expect(g.walk[t]).not.toBe(WALK_BLOCKED);
  });

  it('禁止斜向穿過兩個阻擋格之間的縫隙', () => {
    const g = gridFrom([
      '.#',
      '#.',
    ]);
    const pf = new PathFinder(2, 2);
    const r = pf.findPath(g, 0, rectPoint(1, 1));
    expect(r.reached).toBe(false);
    expect(r.tiles.length).toBe(0);
  });

  it('只有一側阻擋時允許斜走', () => {
    const g = gridFrom([
      '.#',
      '..',
    ]);
    const pf = new PathFinder(2, 2);
    const r = pf.findPath(g, 0, rectPoint(1, 1));
    expect(r.reached).toBe(true);
    expect(r.tiles).toEqual([3]);
  });

  it('樹林成本較高，會繞路', () => {
    const g = gridFrom([
      '.....',
      '.TTT.',
      '.....',
    ]);
    const pf = new PathFinder(5, 3);
    // 從 (0,1) 到 (4,1)：穿越樹林成本 17*3+10=61；繞行 14+10+10+14=48
    const r = pf.findPath(g, 5, rectPoint(4, 1));
    for (const t of r.tiles) expect(g.walk[t]).not.toBe(WALK_FOREST);
  });

  it('不可達時走到最接近點', () => {
    const g = gridFrom([
      '..#..',
      '..#..',
      '..#..',
    ]);
    const pf = new PathFinder(5, 3);
    const r = pf.findPath(g, 0, rectPoint(4, 1));
    expect(r.reached).toBe(false);
    const last = r.tiles[r.tiles.length - 1];
    expect(last % 5).toBe(1);
    expect(Math.floor(last / 5)).toBe(1);
  });

  it('目標為阻擋格時可用 allowBlockedGoal', () => {
    const g = gridFrom(['...#.']);
    const pf = new PathFinder(5, 1);
    expect(pf.findPath(g, 0, rectPoint(3, 0)).reached).toBe(false);
    expect(pf.findPath(g, 0, rectPoint(3, 0), { allowBlockedGoal: true }).reached).toBe(true);
  });

  it('同分時結果確定（多次相同）', () => {
    const g = gridFrom(['........', '........', '........', '........']);
    const pf = new PathFinder(8, 4);
    const a = pf.findPath(g, 0, rectPoint(7, 3)).tiles;
    for (let i = 0; i < 5; i++) expect(pf.findPath(g, 0, rectPoint(7, 3)).tiles).toEqual(a);
  });
});

describe('segmentClear / smoothPath', () => {
  it('線段檢查', () => {
    const g = gridFrom([
      '....',
      '.#..',
      '....',
    ]);
    expect(segmentClear(g, 500, 500, 3500, 500, true)).toBe(true);
    expect(segmentClear(g, 500, 1500, 3500, 1500, true)).toBe(false);
    // 恰好穿過格角：(1000,1000) 是阻擋格 (1,1) 的左上角
    expect(segmentClear(g, 500, 500, 1500, 1500, true)).toBe(false);
  });

  it('開闊地平滑成一段', () => {
    const g = gridFrom(['......', '......', '......']);
    const pf = new PathFinder(6, 3);
    const r = pf.findPath(g, 0, rectPoint(5, 2));
    const pts = smoothPath(g, 500, 500, r.tiles, 5500, 2500);
    expect(pts).toEqual([5500, 2500]);
  });
});
