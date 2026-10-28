// 軍團尋路：格子上的 A*（八方向、不可切角），結果以直線可達性平滑成少數轉折點。
// 引擎 0.4 起分層：搜尋狀態是（格, 層），索引 = 格 + 層 × 格數；地面層不經樓梯不會進入牆頂層，
// 沒有城牆的地圖（大河谷）搜尋範圍與結果和單層版完全相同。
import { idiv } from '../shared/intmath.ts';
import { GROUND_FAST, T, TILE, stepLayer, terrainCost, walkableAny, walkableAt } from './config.ts';
import { tileXY, type LegionMap } from './map.ts';

const SQRT2 = 141;
const MIN_COST = 80;
/** 緊鄰不可通行格的額外成本 */
const EDGE_COST = 60;

function tileCost(map: LegionMap, i: number): number {
  return terrainCost(map.terrain[i]) + (map.edge[i] === 1 ? EDGE_COST : 0);
}

/**
 * 比賽中會變的通行狀態（沒有城的地圖傳 null，行為與單層版相同）：
 * open[格] = 1 表示這格門樓的城門開著（地面層可走）；links 是雲梯之類的額外連結（狀態索引 → 可到的狀態索引），每條成本 linkCost。
 */
export interface PathEnv {
  readonly open: Uint8Array | null;
  readonly links: ReadonlyMap<number, readonly number[]> | null;
  readonly linkCost: number;
}

/** 地面層的快速路徑：地面層的一般地形（平地、道路、樹林、高地、淺灘、橋、石板地、瓦礫）之間移動不用查 stepLayer */
function groundFast(layer: number, t: number): boolean {
  return layer === 0 && GROUND_FAST[t] === 1;
}

/** 從地形 fromT（層 layer）踏進 toT 後的層；-1 不能走。open = 目的格的城門開著 */
function stepTo(layer: number, fromT: number, toT: number, cavalry: boolean, open: boolean): number {
  if (groundFast(layer, toT)) return 0;
  if (toT === T.River || toT === T.Building) return -1;
  return stepLayer(layer, fromT, toT, cavalry, open);
}

function isOpen(env: PathEnv | null, i: number): boolean {
  return env !== null && env.open !== null && env.open[i] === 1;
}

/** A* 的工作陣列（每張地圖共用一份；以世代戳記避免每次清空）；大小為兩層 */
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

function clampTile(map: LegionMap, x: number, y: number): number {
  const [cx, cy] = tileXY(x, y, map.width, map.height);
  const tx = Math.min(map.width - 1, Math.max(0, cx));
  const ty = Math.min(map.height - 1, Math.max(0, cy));
  return ty * map.width + tx;
}

/** 所在格（不可通行時取該層最近的可通行格；牆頂層在沒有牆的地圖退回地面；開著的城門在地面層算自己） */
function tileOf(map: LegionMap, x: number, y: number, layer = 0, env: PathEnv | null = null): number {
  const i = clampTile(map, x, y);
  if (layer !== 0) {
    const top = map.snapTop[i];
    if (top >= 0) return top;
  }
  if (isOpen(env, i)) return i;
  return map.snap[i];
}

function center(map: LegionMap, i: number): [number, number] {
  const x = i % map.width;
  return [x * TILE + TILE / 2, ((i - x) / map.width) * TILE + TILE / 2];
}

/** 上一次 lineCost 走到終點時的層 */
let lineEndLayer = 0;

/**
 * 線段上取樣檢查可通行；回傳沿途最高的尋路成本（不可通行回傳 -1）。
 * 從 layer 層出發，沿途逐格套用 stepLayer（經過樓梯會換層）；終點的層留在 lineEndLayer。
 */
export function lineCost(map: LegionMap, ax: number, ay: number, bx: number, by: number, layer = 0, cavalry = false, env: PathEnv | null = null): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(Math.abs(dx), Math.abs(dy));
  const steps = Math.max(1, idiv(len, 300) + 1);
  let worst = 0;
  let prev = -1;
  let lv = layer;
  for (let k = 0; k <= steps; k++) {
    const x = ax + idiv(dx * k, steps);
    const y = ay + idiv(dy * k, steps);
    const [tx, ty] = tileXY(x, y, map.width, map.height);
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return -1;
    const i = ty * map.width + tx;
    if (i !== prev) {
      const t = map.terrain[i];
      if (prev === -1) {
        if (!walkableAt(t, lv, isOpen(env, i))) return -1;
      } else if (!groundFast(lv, t)) {
        if (t === T.River || t === T.Building) return -1;
        lv = stepLayer(lv, map.terrain[prev], t, cavalry, isOpen(env, i));
        if (lv < 0) return -1;
      }
      prev = i;
    }
    const c = tileCost(map, i);
    if (c > worst) worst = c;
  }
  lineEndLayer = lv;
  return worst;
}

export function clearLine(map: LegionMap, ax: number, ay: number, bx: number, by: number, layer = 0, cavalry = false, env: PathEnv | null = null): boolean {
  return lineCost(map, ax, ay, bx, by, layer, cavalry, env) >= 0;
}

/**
 * 最近的可通行點（該層不可通行時移到該層最近可通行格的中心）。
 * flip = true 時在旋轉 180° 的座標系計算再轉回來：地圖是旋轉對稱的，這樣雙方得到互為鏡像的結果（同分時的取捨不偏向任何一方）。
 */
export function snapPoint(map: LegionMap, x: number, y: number, flip = false, layer = 0, env: PathEnv | null = null): [number, number] {
  if (flip) {
    const W = map.width * TILE;
    const H = map.height * TILE;
    const [fx, fy] = snapPoint(map, W - x, H - y, false, layer, env);
    return [W - fx, H - fy];
  }
  const [tx, ty] = tileXY(x, y, map.width, map.height);
  if (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height) {
    const i = ty * map.width + tx;
    if (walkableAt(map.terrain[i], layer, isOpen(env, i))) return [x, y];
  }
  return center(map, tileOf(map, x, y, layer, env));
}

/** 尋路終點：任何一層可走的格都算合法（牆頂也可以當目的地）；都不行就吸到地面最近的可通行格 */
function snapGoal(map: LegionMap, x: number, y: number): [number, number] {
  const [tx, ty] = tileXY(x, y, map.width, map.height);
  if (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height && walkableAny(map.terrain[ty * map.width + tx])) return [x, y];
  return center(map, map.snap[clampTile(map, x, y)]);
}

/**
 * 從 (sx, sy)（在 layer 層）到 (gx, gy) 的路徑（單位座標的轉折點，不含起點、含終點）。
 * 終點不可通行時改到最近的可通行格；終點在牆頂時路徑會經過樓梯。找不到路徑回傳 null。
 */
export function findPath(map: LegionMap, sx: number, sy: number, gx: number, gy: number, flip = false, layer = 0, cavalry = false, env: PathEnv | null = null): [number, number][] | null {
  if (flip) {
    // 翻轉只用在旋轉對稱、沒有城的地圖（env 為 null）
    const W = map.width * TILE;
    const H = map.height * TILE;
    const p = findPath(map, W - sx, H - sy, W - gx, H - gy, false, layer, cavalry, env);
    return p === null ? null : p.map(([x, y]) => [W - x, H - y]);
  }
  const [ex, ey] = snapGoal(map, gx, gy);
  const cost0 = lineCost(map, sx, sy, ex, ey, layer, cavalry, env);
  if (cost0 >= 0 && cost0 <= tileCost(map, tileOf(map, sx, sy, layer, env))) return [[ex, ey]];
  const w = map.width;
  const n = w * map.height;
  let s = scratch.get(map);
  if (s === undefined) {
    s = new Scratch(2 * n);
    scratch.set(map, s);
  }
  s.gen += 1;
  s.size = 0;
  const gen = s.gen;
  const terrain = map.terrain;
  const startTile = tileOf(map, sx, sy, layer, env);
  const open = env !== null ? env.open : null;
  const links = env !== null ? env.links : null;
  const start = startTile + layer * n;
  const goal = clampTile(map, ex, ey);
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
  s.push(start, h(startTile));
  let found = -1;
  while (s.size > 0) {
    const cur = s.pop();
    if (s.closed[cur] === gen) continue;
    s.closed[cur] = gen;
    const cl = cur < n ? 0 : 1;
    const ci = cur - cl * n;
    if (ci === goal) {
      found = cur;
      break;
    }
    const ct = terrain[ci];
    const cx = ci % w;
    const cy = (ci - cx) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
        const ni = ny * w + nx;
        const nl = stepTo(cl, ct, terrain[ni], cavalry, open !== null && open[ni] === 1);
        if (nl < 0) continue;
        const ns = ni + nl * n;
        if (s.closed[ns] === gen) continue;
        const diag = dx !== 0 && dy !== 0;
        if (diag) {
          const ai = cy * w + nx;
          const bi = ny * w + cx;
          if (stepTo(cl, ct, terrain[ai], cavalry, open !== null && open[ai] === 1) < 0 || stepTo(cl, ct, terrain[bi], cavalry, open !== null && open[bi] === 1) < 0) continue;
        }
        const g = s.g[cur] + idiv(tileCost(map, ni) * (diag ? SQRT2 : 100), 100);
        if (s.stamp[ns] === gen && s.g[ns] <= g) continue;
        s.stamp[ns] = gen;
        s.g[ns] = g;
        s.parent[ns] = cur;
        s.push(ns, g + h(ni));
      }
    }
    // 額外連結（雲梯）：騎兵不能用
    const ext = links !== null && !cavalry ? links.get(cur) : undefined;
    if (ext !== undefined) {
      for (const ns of ext) {
        if (s.closed[ns] === gen) continue;
        const ni = ns < n ? ns : ns - n;
        const g = s.g[cur] + env!.linkCost;
        if (s.stamp[ns] === gen && s.g[ns] <= g) continue;
        s.stamp[ns] = gen;
        s.g[ns] = g;
        s.parent[ns] = cur;
        s.push(ns, g + h(ni));
      }
    }
  }
  if (found < 0) return null;
  const tiles: number[] = [];
  const layers: number[] = [];
  for (let i = found; i !== -1 && i !== start; i = s.parent[i]) {
    const l = i < n ? 0 : 1;
    tiles.push(i - l * n);
    layers.push(l);
  }
  tiles.reverse();
  layers.reverse();
  // 平滑：從目前點盡量往後連直線（沿途成本不超過原路徑那段的最高成本，而且直線走到那一點時在同一層）
  const pts = tiles.map((i) => center(map, i));
  pts[pts.length - 1] = [ex, ey];
  const out: [number, number][] = [];
  let px = sx;
  let py = sy;
  let pl = layer;
  let i = 0;
  while (i < pts.length) {
    let best = i;
    let segMax = tileCost(map, tiles[i]);
    for (let j = i + 1; j < pts.length; j++) {
      const c = tileCost(map, tiles[j]);
      if (c > segMax) segMax = c;
      const lc = lineCost(map, px, py, pts[j][0], pts[j][1], pl, cavalry, env);
      if (lc < 0 || lc > segMax || lineEndLayer !== layers[j]) break;
      best = j;
    }
    out.push(pts[best]);
    [px, py] = pts[best];
    pl = layers[best];
    i = best + 1;
  }
  return out;
}
