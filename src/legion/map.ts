// 軍團戰地圖：以幾何形狀（橢圓、折線、河道）在格子上繪製地形；上半部繪製後，下半部以 180° 旋轉複製，保證雙方對稱。
// 每一格另有高度階（0～5）：高度效果全部依高低差計算（規格書 v0.2 第七節）。原型只有一張「河谷」。
import { hashInts } from '../shared/hash.ts';
import { idiv } from '../shared/intmath.ts';
import { T, TILE, walkable, RULES } from './config.ts';
import { isin } from './geom.ts';

export interface DeployZone {
  /** 格座標，含 x0、y0，不含 x1、y1 */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface FlagPoint {
  readonly name: string;
  /** 單位座標 */
  readonly x: number;
  readonly y: number;
}

export interface LegionMap {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  /** 高度階（0～5） */
  readonly heights: Uint8Array;
  /** 依 playerId */
  readonly deploy: readonly DeployZone[];
  /** 潰散時撤離的地圖邊緣（單位 x 座標）：依 playerId */
  readonly rearX: readonly number[];
  readonly flags: readonly FlagPoint[];
  /** 地標（解說用的地名），單位座標 */
  readonly landmarks: readonly FlagPoint[];
  /** 不可通行格 → 最近的可通行格（可通行格對應自己） */
  readonly snap: Int32Array;
  /** 1 = 緊鄰不可通行格（尋路加成本，讓隊形走在橋與淺灘的中間） */
  readonly edge: Uint8Array;
}

type Painter = (x: number, y: number) => boolean;

/** 橢圓（格中心），邊緣以雜湊加一點不規則 */
function ellipse(cx: number, cy: number, rx: number, ry: number, salt: number): Painter {
  return (x, y) => {
    const lhs = (x - cx) * (x - cx) * ry * ry + (y - cy) * (y - cy) * rx * rx;
    const j = (hashInts([x, y, salt]) >>> 0) % 31;
    return lhs * 100 <= rx * rx * ry * ry * (85 + j);
  };
}

/** 折線（格座標的頂點），寬度為半寬（半格單位）的平方上限 */
function polyline(pts: readonly (readonly [number, number])[], halfWidth2: number): Painter {
  return (x, y) => {
    // 半格單位：格中心 = 2x + 1
    const px = 2 * x + 1;
    const py = 2 * y + 1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = 2 * pts[i][0] + 1;
      const ay = 2 * pts[i][1] + 1;
      const bx = 2 * pts[i + 1][0] + 1;
      const by = 2 * pts[i + 1][1] + 1;
      const vx = bx - ax;
      const vy = by - ay;
      const wx = px - ax;
      const wy = py - ay;
      const len2 = vx * vx + vy * vy;
      const dot = wx * vx + wy * vy;
      let d2: number;
      if (dot <= 0) d2 = wx * wx + wy * wy;
      else if (dot >= len2) d2 = (px - bx) * (px - bx) + (py - by) * (py - by);
      else {
        const cross = wx * vy - wy * vx;
        if (cross * cross <= halfWidth2 * len2) return true;
        continue;
      }
      if (d2 <= halfWidth2) return true;
    }
    return false;
  };
}

function paint(terrain: Uint8Array, w: number, h: number, t: number, p: Painter, only?: (cur: number) => boolean): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (only !== undefined && !only(terrain[i])) continue;
      if (p(x, y)) terrain[i] = t;
    }
  }
}

/** 上半部（列優先索引的前一半）旋轉 180° 複製到下半部 */
function rotateHalf(terrain: Uint8Array): void {
  const n = terrain.length;
  for (let i = idiv(n, 2); i < n; i++) terrain[i] = terrain[n - 1 - i];
}

function buildEdge(terrain: Uint8Array, w: number, h: number): Uint8Array {
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!walkable(terrain[y * w + x])) continue;
      for (let dy = -1; dy <= 1 && edge[y * w + x] === 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!walkable(terrain[ny * w + nx])) {
            edge[y * w + x] = 1;
            break;
          }
        }
      }
    }
  }
  return edge;
}

function buildSnap(terrain: Uint8Array, w: number, h: number): Int32Array {
  const snap = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < w * h; i++) {
    if (walkable(terrain[i])) {
      snap[i] = i;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || snap[j] >= 0) continue;
      snap[j] = snap[i];
      queue[tail++] = j;
    }
  }
  return snap;
}

/** 原型地圖「河谷」：160 × 100 格 */
export function riverValley(): LegionMap {
  const w = 160;
  const h = 100;
  const terrain = new Uint8Array(w * h);
  // 樹林：北橋兩岸、中央淺灘的側翼、後方
  paint(terrain, w, h, T.Forest, ellipse(64, 12, 8, 6, 1));
  paint(terrain, w, h, T.Forest, ellipse(101, 13, 7, 5, 2));
  paint(terrain, w, h, T.Forest, ellipse(34, 38, 5, 4, 3));
  paint(terrain, w, h, T.Forest, ellipse(60, 42, 5, 3, 4));
  // 高地：俯瞰中央淺灘
  paint(terrain, w, h, T.Hill, ellipse(95, 40, 7, 5, 5), (c) => c === T.Plain);
  // 道路：布陣區前方通往北橋（下半部旋轉後成為通往南橋的道路）
  paint(terrain, w, h, T.Road, polyline([[0, 40], [30, 32], [60, 23], [86, 21]], 5), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[84, 21], [110, 23], [132, 31], [159, 36]], 5), (c) => c !== T.Hill);
  // 河流：S 形，寬 6 格
  for (let y = 0; y < idiv(h, 2); y++) {
    const xc2 = 159 + idiv(12 * isin(idiv(y * 180, 50)), 10000);
    for (let x = 0; x < w; x++) {
      if (Math.abs(2 * x + 1 - xc2) <= 6) terrain[y * w + x] = T.River;
    }
  }
  // 北橋（3 格寬）與中央淺灘
  for (let y = 20; y <= 22; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Bridge;
  for (let y = 44; y < 50; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Shallow;
  // 高度：河道 0、河谷 1、兩岸高處 2、高地 3、高地頂 4
  const heights = new Uint8Array(w * h);
  const top = ellipse(95, 40, 4, 3, 6);
  for (let y = 0; y < idiv(h, 2); y++) {
    const xc2 = 159 + idiv(12 * isin(idiv(y * 180, 50)), 10000);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t === T.River || t === T.Shallow) heights[i] = 0;
      else if (t === T.Bridge) heights[i] = 1;
      else if (t === T.Hill) heights[i] = top(x, y) ? 4 : 3;
      else {
        const d2 = Math.abs(2 * x + 1 - xc2);
        heights[i] = d2 <= 2 * (22 + ((hashInts([x, y, 7]) >>> 0) % 3)) ? 1 : 2;
      }
    }
  }
  rotateHalf(terrain);
  rotateHalf(heights);
  const depth = RULES.deployDepthTiles;
  return {
    id: 'river-valley',
    name: '河谷',
    description: '中央一條 S 形河流，南北各一座窄橋、中央一處淺灘；兩岸都有樹林可以埋伏，淺灘兩側各有一座高地。',
    width: w,
    height: h,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: depth, y1: h },
      { x0: w - depth, y0: 0, x1: w, y1: h },
    ],
    rearX: [0, w * TILE],
    flags: [
      { name: '西南高地', x: 64500, y: 59500 },
      { name: '中央淺灘', x: 80000, y: 50000 },
      { name: '東北高地', x: 95500, y: 40500 },
    ],
    landmarks: [
      { name: '中央淺灘', x: 80000, y: 50000 },
      { name: '北橋', x: 85300, y: 21500 },
      { name: '南橋', x: 74700, y: 78500 },
      { name: '西南高地', x: 64500, y: 59500 },
      { name: '東北高地', x: 95500, y: 40500 },
      { name: '北橋西側的樹林', x: 64500, y: 12500 },
      { name: '北橋東側的樹林', x: 101500, y: 13500 },
      { name: '南橋東側的樹林', x: 95500, y: 87500 },
      { name: '南橋西側的樹林', x: 58500, y: 86500 },
      { name: '淺灘西北的樹林', x: 60500, y: 42500 },
      { name: '淺灘東南的樹林', x: 99500, y: 57500 },
      { name: '西側樹林', x: 34500, y: 38500 },
      { name: '東側樹林', x: 125500, y: 61500 },
      { name: '藍方陣地', x: 10000, y: 50000 },
      { name: '紅方陣地', x: 150000, y: 50000 },
    ],
    snap: buildSnap(terrain, w, h),
    edge: buildEdge(terrain, w, h),
  };
}

/** 地圖不會變，產生一次後共用 */
function once(make: () => LegionMap): () => LegionMap {
  let cached: LegionMap | null = null;
  return () => (cached ??= make());
}

export const MAPS: Readonly<Record<string, () => LegionMap>> = {
  'river-valley': once(riverValley),
};

/**
 * 座標 → 格：以地圖中心對稱（剛好落在格線上的點歸給靠近中心的那一格），
 * 讓旋轉 180° 的兩個點一定落在互相對應的兩格，雙方不會因為取整方向不同而有差異。
 */
export function tileCoord(v: number, tiles: number): number {
  const total = tiles * TILE;
  if (v * 2 < total) return Math.floor(v / TILE);
  return tiles - 1 - Math.floor((total - v) / TILE);
}

export function terrainAt(map: LegionMap, x: number, y: number): number {
  const tx = tileCoord(x, map.width);
  const ty = tileCoord(y, map.height);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return T.River;
  return map.terrain[ty * map.width + tx];
}

export function heightAt(map: LegionMap, x: number, y: number): number {
  const tx = tileCoord(x, map.width);
  const ty = tileCoord(y, map.height);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return 0;
  return map.heights[ty * map.width + tx];
}

/** 建築與城牆擋視線的高度 */
const BLOCK_HEIGHT = 9;

/**
 * 視線是否被地形擋住：沿兩點連線每格取樣，中間任何一格的地形高過視線（雙方眼睛在各自高度 + 0.5 階）就看不到。
 * 樹林不擋視線（隱蔽另外計算）；建築、城牆擋視線。
 */
export function sightBlocked(map: LegionMap, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const steps = idiv(Math.max(Math.abs(dx), Math.abs(dy)), TILE);
  if (steps < 2) return false;
  const ea = 2 * heightAt(map, ax, ay) + 1;
  const eb = 2 * heightAt(map, bx, by) + 1;
  for (let k = 1; k < steps; k++) {
    const x = ax + idiv(dx * k, steps);
    const y = ay + idiv(dy * k, steps);
    const t = terrainAt(map, x, y);
    const hgt = t === T.Building || t === T.Wall ? BLOCK_HEIGHT : heightAt(map, x, y);
    // 2 × 地形高度 > 視線高度（半階單位，乘上 steps 避免除法）
    if (2 * hgt * steps > ea * steps + (eb - ea) * k) return true;
  }
  return false;
}
