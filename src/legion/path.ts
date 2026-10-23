// 軍團尋路：格子上的 A*（八方向、不可切角），結果以直線可達性平滑成少數轉折點。
import { idiv } from '../shared/intmath.ts';
import { TILE, terrainCost, walkable } from './config.ts';
import { tileXY, type LegionMap } from './map.ts';

const SQRT2 = 141;
const MIN_COST = 80;
/** 緊鄰不可通行格的額外成本 */
const EDGE_COST = 60;

function tileCost(map: LegionMap, i: number): number {
  return terrainCost(map.terrain[i]) + (map.edge[i] === 1 ? EDGE_COST : 0);
}

/** A* 的工作陣列（每張地圖共用一份；以世代戳記避免每次清空） */
class Scratch {
  readonly g: Int32Array;
  readonly parent: Int32Array;
  readonly stamp: Uint32Array;
  readonly closed: Uint32Array;
  gen = 0;
  heapNode: Int32Array;
  heapF: Int32Array;
  size = 0;

  constructor(n: number) {
    this.g = new Int32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heapNode = new Int32Array(1024);
    this.heapF = new Int32Array(1024);
  }

  push(node: number, f: number): void {
    if (this.size === this.heapNode.length) {
      const nn = new Int32Array(this.size * 2);
      nn.set(this.heapNode);
      this.heapNode = nn;
      const nf = new Int32Array(this.size * 2);
      nf.set(this.heapF);
      this.heapF = nf;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(f, node, this.heapF[p], this.heapNode[p])) {
        this.heapNode[i] = this.heapNode[p];
        this.heapF[i] = this.heapF[p];
        i = p;
      } else break;
    }
    this.heapNode[i] = node;
    this.heapF[i] = f;
  }

  pop(): number {
    const top = this.heapNode[0];
    const n = --this.size;
    if (n > 0) {
      const node = this.heapNode[n];
      const f = this.heapF[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && this.less(this.heapF[r], this.heapNode[r], this.heapF[l], this.heapNode[l]) ? r : l;
        if (this.less(this.heapF[c], this.heapNode[c], f, node)) {
          this.heapNode[i] = this.heapNode[c];
          this.heapF[i] = this.heapF[c];
          i = c;
        } else break;
      }
      this.heapNode[i] = node;
      this.heapF[i] = f;
    }
    return top;
  }

  private less(fa: number, na: number, fb: number, nb: number): boolean {
    return fa < fb || (fa === fb && na < nb);
  }
}

const scratch = new WeakMap<LegionMap, Scratch>();

function tileOf(map: LegionMap, x: number, y: number): number {
  const [cx, cy] = tileXY(x, y, map.width, map.height);
  const tx = Math.min(map.width - 1, Math.max(0, cx));
  const ty = Math.min(map.height - 1, Math.max(0, cy));
  return map.snap[ty * map.width + tx];
}

function center(map: LegionMap, i: number): [number, number] {
  const x = i % map.width;
  return [x * TILE + TILE / 2, ((i - x) / map.width) * TILE + TILE / 2];
}

/** 線段上取樣檢查可通行；回傳沿途最高的尋路成本（不可通行回傳 -1） */
export function lineCost(map: LegionMap, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(Math.abs(dx), Math.abs(dy));
  const steps = Math.max(1, idiv(len, 300) + 1);
  let worst = 0;
  for (let k = 0; k <= steps; k++) {
    const x = ax + idiv(dx * k, steps);
    const y = ay + idiv(dy * k, steps);
    const [tx, ty] = tileXY(x, y, map.width, map.height);
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return -1;
    const i = ty * map.width + tx;
    if (!walkable(map.terrain[i])) return -1;
    const c = tileCost(map, i);
    if (c > worst) worst = c;
  }
  return worst;
}

export function clearLine(map: LegionMap, ax: number, ay: number, bx: number, by: number): boolean {
  return lineCost(map, ax, ay, bx, by) >= 0;
}

/**
 * 最近的可通行點（不可通行時移到最近可通行格的中心）。
 * flip = true 時在旋轉 180° 的座標系計算再轉回來：地圖是旋轉對稱的，這樣雙方得到互為鏡像的結果（同分時的取捨不偏向任何一方）。
 */
export function snapPoint(map: LegionMap, x: number, y: number, flip = false): [number, number] {
  if (flip) {
    const W = map.width * TILE;
    const H = map.height * TILE;
    const [fx, fy] = snapPoint(map, W - x, H - y, false);
    return [W - fx, H - fy];
  }
  const [tx, ty] = tileXY(x, y, map.width, map.height);
  if (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height && walkable(map.terrain[ty * map.width + tx])) return [x, y];
  return center(map, tileOf(map, x, y));
}

/**
 * 從 (sx, sy) 到 (gx, gy) 的路徑（單位座標的轉折點，不含起點、含終點）。
 * 終點不可通行時改到最近的可通行格。找不到路徑回傳 null。
 */
export function findPath(map: LegionMap, sx: number, sy: number, gx: number, gy: number, flip = false): [number, number][] | null {
  if (flip) {
    const W = map.width * TILE;
    const H = map.height * TILE;
    const p = findPath(map, W - sx, H - sy, W - gx, H - gy, false);
    return p === null ? null : p.map(([x, y]) => [W - x, H - y]);
  }
  const [ex, ey] = snapPoint(map, gx, gy);
  const cost0 = lineCost(map, sx, sy, ex, ey);
  if (cost0 >= 0 && cost0 <= tileCost(map, tileOf(map, sx, sy))) return [[ex, ey]];
  const w = map.width;
  const n = w * map.height;
  let s = scratch.get(map);
  if (s === undefined) {
    s = new Scratch(n);
    scratch.set(map, s);
  }
  s.gen += 1;
  s.size = 0;
  const gen = s.gen;
  const start = tileOf(map, sx, sy);
  const goal = tileOf(map, ex, ey);
  const gxT = goal % w;
  const gyT = (goal - gxT) / w;
  const h = (i: number): number => {
    const x = i % w;
    const y = (i - x) / w;
    const dx = Math.abs(x - gxT);
    const dy = Math.abs(y - gyT);
    const lo = dx < dy ? dx : dy;
    const hi = dx < dy ? dy : dx;
    return idiv((100 * (hi - lo) + SQRT2 * lo) * MIN_COST, 100);
  };
  s.g[start] = 0;
  s.parent[start] = -1;
  s.stamp[start] = gen;
  s.push(start, h(start));
  let found = false;
  while (s.size > 0) {
    const cur = s.pop();
    if (s.closed[cur] === gen) continue;
    s.closed[cur] = gen;
    if (cur === goal) {
      found = true;
      break;
    }
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
        const ni = ny * w + nx;
        const t = map.terrain[ni];
        if (!walkable(t) || s.closed[ni] === gen) continue;
        const diag = dx !== 0 && dy !== 0;
        if (diag && (!walkable(map.terrain[cy * w + nx]) || !walkable(map.terrain[ny * w + cx]))) continue;
        const g = s.g[cur] + idiv(tileCost(map, ni) * (diag ? SQRT2 : 100), 100);
        if (s.stamp[ni] === gen && s.g[ni] <= g) continue;
        s.stamp[ni] = gen;
        s.g[ni] = g;
        s.parent[ni] = cur;
        s.push(ni, g + h(ni));
      }
    }
  }
  if (!found) return null;
  const tiles: number[] = [];
  for (let i = goal; i !== -1 && i !== start; i = s.parent[i]) tiles.push(i);
  tiles.reverse();
  // 平滑：從目前點盡量往後連直線（沿途成本不超過原路徑那段的最高成本）
  const pts = tiles.map((i) => center(map, i));
  pts[pts.length - 1] = [ex, ey];
  const out: [number, number][] = [];
  let px = sx;
  let py = sy;
  let i = 0;
  while (i < pts.length) {
    let best = i;
    let segMax = tileCost(map, tiles[i]);
    for (let j = i + 1; j < pts.length; j++) {
      const c = tileCost(map, tiles[j]);
      if (c > segMax) segMax = c;
      const lc = lineCost(map, px, py, pts[j][0], pts[j][1]);
      if (lc < 0 || lc > segMax) break;
      best = j;
    }
    out.push(pts[best]);
    [px, py] = pts[best];
    i = best + 1;
  }
  return out;
}
