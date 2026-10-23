// 軍團戰地圖：以幾何形狀（橢圓、折線、河道）在格子上繪製地形；上半部繪製後，下半部以 180° 旋轉複製，保證雙方對稱。
// 每一格另有高度階（0～5）：高度效果全部依高低差計算（規格書 v0.2 第七節）。殲滅戰用「河谷」，佔點用「大河谷」。
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

export interface CaptureFlag extends FlagPoint {
  /** 佔領後每秒得幾分 */
  readonly points: number;
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
  readonly flags: readonly CaptureFlag[];
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
      { name: '西南高地', x: 64500, y: 59500, points: 1 },
      { name: '中央淺灘', x: 80000, y: 50000, points: 2 },
      { name: '東北高地', x: 95500, y: 40500, points: 1 },
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

/** 佔點地圖「大河谷」：240 × 150 格。三個渡口（北橋、中央淺灘、南橋）相隔約 48 格，各有一面旗 */
export function grandValley(): LegionMap {
  const w = 240;
  const h = 150;
  const half = idiv(h, 2);
  const terrain = new Uint8Array(w * h);
  /** 河道中心（半格單位）：S 形，振幅 8 格 */
  const riverX2 = (y: number): number => 239 + idiv(16 * isin(idiv(y * 180, half)), 10000);
  // 樹林：北橋兩岸、淺灘側翼、雙方後方
  paint(terrain, w, h, T.Forest, ellipse(104, 15, 8, 6, 11));
  paint(terrain, w, h, T.Forest, ellipse(151, 17, 9, 6, 12));
  paint(terrain, w, h, T.Forest, ellipse(96, 60, 6, 4, 13));
  paint(terrain, w, h, T.Forest, ellipse(148, 47, 6, 4, 14));
  paint(terrain, w, h, T.Forest, ellipse(46, 28, 7, 5, 15));
  paint(terrain, w, h, T.Forest, ellipse(62, 62, 5, 4, 16));
  paint(terrain, w, h, T.Forest, ellipse(192, 40, 6, 5, 17));
  // 高地：東岸俯瞰淺灘、西岸俯瞰北橋、後方一座
  paint(terrain, w, h, T.Hill, ellipse(143, 64, 8, 5, 18), (c) => c === T.Plain);
  paint(terrain, w, h, T.Hill, ellipse(101, 36, 7, 5, 19), (c) => c === T.Plain);
  paint(terrain, w, h, T.Hill, ellipse(40, 54, 6, 4, 20), (c) => c === T.Plain);
  // 道路：布陣區通往北橋（旋轉後成為通往南橋的道路），以及通往淺灘的小路
  paint(terrain, w, h, T.Road, polyline([[0, 46], [40, 38], [82, 30], [127, 27]], 5), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[125, 27], [166, 30], [206, 40], [239, 47]], 5), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[20, 73], [60, 71], [112, 73]], 3), (c) => c !== T.Hill);
  // 村莊：北橋東岸（旋轉後在南橋西岸）
  for (const [bx, by] of [[157, 31], [158, 31], [161, 33], [161, 34], [155, 35], [156, 35]] as const) terrain[by * w + bx] = T.Building;
  // 河流：寬 6 格
  for (let y = 0; y < half; y++) {
    const xc2 = riverX2(y);
    for (let x = 0; x < w; x++) if (Math.abs(2 * x + 1 - xc2) <= 6) terrain[y * w + x] = T.River;
  }
  // 北橋（3 格寬）與中央淺灘（旋轉後共 12 格寬）
  for (let y = 26; y <= 28; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Bridge;
  for (let y = half - 6; y < half; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Shallow;
  // 高度：河道 0、河谷 1、兩岸高處 2、高地 3、高地頂 4
  const heights = new Uint8Array(w * h);
  const tops = [ellipse(143, 64, 4, 3, 21), ellipse(101, 36, 3, 2, 22), ellipse(40, 54, 3, 2, 23)];
  for (let y = 0; y < half; y++) {
    const xc2 = riverX2(y);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t === T.River || t === T.Shallow) heights[i] = 0;
      else if (t === T.Bridge) heights[i] = 1;
      else if (t === T.Hill) heights[i] = tops.some((p) => p(x, y)) ? 4 : 3;
      else heights[i] = Math.abs(2 * x + 1 - xc2) <= 2 * (30 + ((hashInts([x, y, 7]) >>> 0) % 3)) ? 1 : 2;
    }
  }
  rotateHalf(terrain);
  rotateHalf(heights);
  const depth = RULES.deployDepthTiles;
  const W = w * TILE;
  const H = h * TILE;
  const north = { x: riverX2(27) * 500, y: 27500 };
  const rot = (p: { x: number; y: number }, name: string): FlagPoint => ({ name, x: W - p.x, y: H - p.y });
  return {
    id: 'grand-valley',
    name: '大河谷',
    description: '縱貫中央的 S 形大河，北橋、中央淺灘、南橋三個渡口相隔約 48 格，各插一面旗；兩岸有樹林、高地與村莊，雙方必須分兵。',
    width: w,
    height: h,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: depth, y1: h },
      { x0: w - depth, y0: 0, x1: w, y1: h },
    ],
    rearX: [0, W],
    flags: [
      { name: '北橋', x: north.x, y: north.y, points: 1 },
      { name: '中央淺灘', x: W / 2, y: H / 2, points: 2 },
      { ...rot(north, '南橋'), points: 1 },
    ],
    landmarks: [
      { name: '北橋', x: north.x, y: north.y },
      { name: '中央淺灘', x: W / 2, y: H / 2 },
      rot(north, '南橋'),
      { name: '淺灘東岸的高地', x: 143500, y: 64500 },
      rot({ x: 143500, y: 64500 }, '淺灘西岸的高地'),
      { name: '北橋西岸的高地', x: 101500, y: 36500 },
      rot({ x: 101500, y: 36500 }, '南橋東岸的高地'),
      { name: '北橋東岸的村莊', x: 158000, y: 33000 },
      rot({ x: 158000, y: 33000 }, '南橋西岸的村莊'),
      { name: '北橋西側的樹林', x: 104500, y: 15500 },
      rot({ x: 104500, y: 15500 }, '南橋東側的樹林'),
      { name: '北橋東側的樹林', x: 151500, y: 17500 },
      rot({ x: 151500, y: 17500 }, '南橋西側的樹林'),
      { name: '淺灘西北的樹林', x: 96500, y: 60500 },
      rot({ x: 96500, y: 60500 }, '淺灘東南的樹林'),
      { name: '淺灘東北的樹林', x: 148500, y: 47500 },
      rot({ x: 148500, y: 47500 }, '淺灘西南的樹林'),
      { name: '藍方陣地', x: 10000, y: H / 2 },
      { name: '紅方陣地', x: W - 10000, y: H / 2 },
    ],
    snap: buildSnap(terrain, w, h),
    edge: buildEdge(terrain, w, h),
  };
}

/** 各模式預設的地圖：殲滅戰用「河谷」，佔點用「大河谷」 */
export function defaultMapId(mode: string): string {
  return mode === 'capture' ? 'grand-valley' : 'river-valley';
}

/** 各模式預設的時間上限（tick） */
export function defaultTimeLimit(mode: string): number {
  return mode === 'capture' ? RULES.capture.timeLimitTicks : RULES.timeLimitTicks;
}

/** 地圖不會變，產生一次後共用 */
function once(make: () => LegionMap): () => LegionMap {
  let cached: LegionMap | null = null;
  return () => (cached ??= make());
}

export const MAPS: Readonly<Record<string, () => LegionMap>> = {
  'river-valley': once(riverValley),
  'grand-valley': once(grandValley),
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
