import { describe, expect, it } from 'vitest';
import { UNIT, VISION } from '../src/shooter/config.ts';
import { MAPS, SLOPE_LOW, SLOPE_WALL, blocksMove, buildMap, isLowCell, isSolidCell, reachable, slopeAt, slopeDistSq, slopeEntry, type MapLayout, type ShooterMap } from '../src/shooter/map.ts';
import { circleHitsWall, findPath, slopeSlide } from '../src/shooter/path.ts';
import { burnCells } from '../src/shooter/sim.ts';
import { lineOfSight, lowCoverBlocks, rayWallDistance } from '../src/shooter/vision.ts';

type Pts = [number, number][];
const spawn = (x: number): { x: number; y: number; facing: number } => ({ x: x * UNIT + 500, y: 2500, facing: 0 });

/** 60×60 的空地，放進指定的多邊形 */
function field(polys: { mode: 'open' | 'wall' | 'low'; slope?: boolean; pts: Pts }[], extra: Partial<MapLayout> = {}): ShooterMap {
  return buildMap({
    id: 't',
    name: 't',
    width: 60,
    height: 60,
    areas: [{ id: 'a', name: 'a', x0: 1, y0: 1, x1: 59, y1: 59 }],
    blocks: [],
    polys,
    sites: [
      { id: 'A', x0: 1, y0: 1, x1: 5, y1: 5 },
      { id: 'B', x0: 6, y0: 1, x1: 10, y1: 5 },
    ],
    spawnZones: { T: { x0: 1, y0: 1, x1: 5, y1: 5 }, CT: { x0: 6, y0: 1, x1: 10, y1: 5 } },
    spawns: { T: [2, 3, 4, 5, 6].map(spawn), CT: [2, 3, 4, 5, 6].map(spawn) },
    ...extra,
  });
}

/** 45° 斜牆：(15,50)–(45,20) 的東南側都是牆 */
const SLOPE: Pts = [[15, 50], [45, 20], [45, 50]];
const wall = (): ShooterMap => field([{ mode: 'wall', slope: true, pts: SLOPE }]);

/** 點是否在斜牆的實心部分（暴力解）：幾何上 x + y ≥ 65 且在三角形內 */
const inWedge = (x: number, y: number): boolean => x + y >= 65 * UNIT && x <= 45 * UNIT && y <= 50 * UNIT;

describe('斜切格的格子資料', () => {
  it('斜邊經過的格變成斜切牆，內部是整格牆，外面不動', () => {
    const m = wall();
    // (30,34) 這格 x + y 從 64 到 66，斜邊切過：實心在東南角
    expect(slopeAt(m, 30, 34)).toBe(2);
    expect(m.solid[34 * m.width + 30]).toBe(SLOPE_WALL + 2);
    expect(m.solid[40 * m.width + 35]).toBe(1);
    expect(m.solid[20 * m.width + 20]).toBe(0);
  });

  it('斜切格在格子層算整格：擋路、算牆', () => {
    const m = wall();
    expect(blocksMove(m, 30, 34)).toBe(true);
    expect(isSolidCell(m, 30, 34)).toBe(true);
    expect(isLowCell(m, 30, 34)).toBe(false);
  });

  it('矮牆也能斜切，材質是矮牆', () => {
    const m = field([{ mode: 'low', slope: true, pts: SLOPE }]);
    expect(m.solid[34 * m.width + 30]).toBe(SLOPE_LOW + 2);
    expect(isLowCell(m, 30, 34)).toBe(true);
    expect(isSolidCell(m, 30, 34)).toBe(false);
    expect(m.solid[40 * m.width + 35]).toBe(2);
  });

  it('挖開的多邊形在牆裡切出斜邊', () => {
    const m = field([{ mode: 'open', slope: true, pts: [[10, 10], [20, 20], [10, 20]] }], { blocks: [{ x0: 5, y0: 5, x1: 30, y1: 30 }] });
    // 被挖開的是西南半邊，所以 (14,14) 這格留下東北角的牆
    expect(slopeAt(m, 14, 14)).toBe(1);
    expect(m.solid[18 * m.width + 12]).toBe(0);
    expect(m.solid[12 * m.width + 18]).toBe(1);
  });

  it('沒標 slope 的多邊形維持鋸齒，舊圖沒有斜切格', () => {
    const m = field([{ mode: 'wall', pts: SLOPE }]);
    expect([...m.solid].every((v) => v <= 2)).toBe(true);
    for (const id of ['dust', 'redrock']) expect([...MAPS[id]().solid].every((v) => v <= 2)).toBe(true);
  });
});

describe('斜面碰撞', () => {
  const r = VISION.bodyRadius;

  it('圓碰得到斜面，碰撞範圍照實際斜線，不是整格', () => {
    const m = wall();
    // 斜切格 (30,34)：實心在東南，西北半邊站得進去
    expect(circleHitsWall(m, 30200, 34200, r)).toBe(false);
    expect(circleHitsWall(m, 30900, 34900, r)).toBe(true);
  });

  /** 一路推著牆走 n tick，回傳每 tick 的平均速度比例 */
  function push(m: ShooterMap, x0: number, y0: number, deg: number, speed = 215, n = 200): number {
    const dx = Math.round(Math.cos((deg * Math.PI) / 180) * speed);
    const dy = Math.round(Math.sin((deg * Math.PI) / 180) * speed);
    let x = x0;
    let y = y0;
    let sum = 0;
    let count = 0;
    for (let t = 0; t < n; t++) {
      const s = slopeSlide(m, x, y, dx, dy, r);
      if (s === null) {
        expect(circleHitsWall(m, x + dx, y + dy, r)).toBe(false);
        x += dx;
        y += dy;
        continue;
      }
      x += s[0];
      y += s[1];
      expect(circleHitsWall(m, x, y, r)).toBe(false);
      sum += Math.hypot(s[0], s[1]);
      count++;
    }
    return sum / count / speed;
  }

  it('水平直推 45° 牆會沿斜面滑，速度約 71%', () => {
    expect(push(wall(), 20500, 40500, 0)).toBeGreaterThan(0.69);
    expect(push(wall(), 20500, 40500, 0)).toBeLessThan(0.73);
  });

  it('偏 15° 推牆約 87%、偏 30° 約 97%', () => {
    expect(push(wall(), 20500, 40500, -15)).toBeGreaterThan(0.84);
    expect(push(wall(), 15500, 40500, -30)).toBeGreaterThan(0.94);
  });

  it('垂直撞上斜面會貼住停下，不穿牆', () => {
    const m = wall();
    let x = 25000;
    let y = 30000;
    for (let t = 0; t < 100; t++) {
      const s = slopeSlide(m, x, y, 152, 152, r);
      if (s === null) {
        x += 152;
        y += 152;
      } else {
        x += s[0];
        y += s[1];
      }
    }
    expect(circleHitsWall(m, x, y, r)).toBe(false);
    expect(slopeDistSq(30, 34, 2, x, y)).toBeLessThan((r + 300) * (r + 300));
  });

  it('尋路繞得過斜牆，路徑不碰牆', () => {
    const m = wall();
    const p = findPath(m, 20500, 45500, 40500, 15500);
    expect(p).not.toBeNull();
    for (const [x, y] of p ?? []) expect(circleHitsWall(m, x, y, r)).toBe(false);
  });

  it('站在斜切格可走半邊也尋得到路', () => {
    expect(findPath(wall(), 30200, 34200, 20500, 20500)).not.toBeNull();
  });
});

describe('斜面的視線與子彈', () => {
  it('線段進入三角形的參數算得出來', () => {
    // 從西北往東南穿過斜切格 (30,34)（實心東南），斜邊在中點
    const e = slopeEntry(30, 34, 2, 30000, 34000, 31000, 35000);
    expect(e).not.toBeNull();
    expect(e![0] / e![1]).toBeCloseTo(0.5);
    // 擦過實心角外面
    expect(slopeEntry(30, 34, 2, 30000, 34000, 30400, 34100)).toBeNull();
  });

  it('隨機線段與逐點取樣一致，斜牆沒有漏縫', () => {
    const m = wall();
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let blocked = 0;
    let skims = 0;
    for (let k = 0; k < 4000; k++) {
      const ax = 2000 + rnd(56000);
      const ay = 2000 + rnd(56000);
      const bx = 2000 + rnd(56000);
      const by = 2000 + rnd(56000);
      if (inWedge(ax, ay) || inWedge(bx, by)) continue;
      let cross = false;
      for (let s = 0; s <= 400 && !cross; s++) cross = inWedge(ax + ((bx - ax) * s) / 400, ay + ((by - ay) * s) / 400);
      const seen = lineOfSight(m, ax, ay, bx, by);
      // 取樣碰到牆卻看得見 = 漏縫，絕對不行
      if (cross) expect(seen).toBe(false);
      // 反過來只可能是取樣跳過了擦過尖角的一小段，要很少見
      else if (!seen) skims++;
      if (cross) blocked++;
    }
    expect(blocked).toBeGreaterThan(300);
    expect(skims).toBeLessThan(10);
  });

  it('沿法線穿過相鄰斜切格的接縫也擋得住', () => {
    const m = wall();
    // 斜線 x + y = 65 上的格點 (30,35)
    expect(lineOfSight(m, 28000, 33000, 33000, 38000)).toBe(false);
  });

  it('子彈撞斜面的距離是斜線上的點，不是格子邊', () => {
    const m = wall();
    // 從 (25,30) 朝東南 45°（單位向量 7071）撞 x + y = 65：沿 x 走 5 格
    const d = rayWallDistance(m, 25000, 30000, 7071, 7071, 30000);
    expect(d).toBeGreaterThan(7000);
    expect(d).toBeLessThan(7150);
  });

  it('站在斜切格可走半邊，同格的另一半照樣擋視線', () => {
    const m = wall();
    expect(lineOfSight(m, 30200, 34200, 30900, 34900)).toBe(false);
    expect(lineOfSight(m, 30200, 34200, 20000, 20000)).toBe(true);
  });

  it('斜矮牆站著打得過去，蹲著貼近才擋', () => {
    const m = field([{ mode: 'low', slope: true, pts: SLOPE }]);
    expect(lineOfSight(m, 30000, 34000, 40000, 44000)).toBe(true);
    expect(lowCoverBlocks(m, 30000, 34000, 40000, 44000, true, false)).toBe(true);
    expect(lowCoverBlocks(m, 10000, 14000, 40000, 44000, true, false)).toBe(false);
  });

  it('火燒得到斜切格的可走半邊', () => {
    const m = wall();
    const cells = burnCells(m, 29000, 33000, 4000);
    expect(cells).toContain(34 * m.width + 30);
    expect(cells).not.toContain(38 * m.width + 34);
  });
});

describe('斜走道', () => {
  /** 一道斜牆隔開西北與東南，中間開一條寬 w（沿 x 量）的斜走道通到另一側 */
  const corridor = (w: number): ShooterMap =>
    field([
      { mode: 'wall', slope: true, pts: [[10, 30], [30, 10], [50, 30], [30, 50]] },
      { mode: 'open', slope: true, pts: [[20, 20], [20 + w, 20], [40 + w, 40], [40, 40]] },
    ]);
  const open = (m: ShooterMap): number => reachable(m, 2, 2).reduce((a, b) => a + b, 0);

  it('格子層的連通要 3 條斜線以上，太窄會被連通檢查擋下', () => {
    expect(open(corridor(4))).toBeGreaterThan(open(corridor(1)));
  });
});
