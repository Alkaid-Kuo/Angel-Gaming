// CS 射擊尋路：格子 A*（八方向、不可切角、貼牆加成本），結果以「角色圓掃過不碰牆」的直線平滑成少數轉折點。
// 角色半徑 0.3 格、走廊最窄 2 格，不膨脹地圖；路徑點取格中心，平滑時檢查掃過的圓，因此不會貼著格角走。
import { idiv, pointRectDistSq } from '../shared/intmath.ts';
import { UNIT, VISION } from './config.ts';
import { cellOf, isSolidCell, type ShooterMap } from './map.ts';

const STRAIGHT = 100;
const DIAG = 141;
/** 緊鄰牆（八方向）的格子額外成本：路徑偏好走廊中央 */
const EDGE_COST = 60;
/** 平滑檢查用的半徑：比身體大一點，留出餘裕 */
const CLEARANCE = VISION.bodyRadius + 80;

interface Grid {
  readonly edge: Uint8Array;
  readonly g: Int32Array;
  readonly parent: Int32Array;
  readonly stamp: Uint32Array;
  readonly closed: Uint32Array;
  gen: number;
  heapNode: Int32Array;
  heapF: Int32Array;
  size: number;
}

const grids = new WeakMap<ShooterMap, Grid>();

function gridOf(map: ShooterMap): Grid {
  let g = grids.get(map);
  if (g !== undefined) return g;
  const n = map.width * map.height;
  const edge = new Uint8Array(n);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (isSolidCell(map, x, y)) continue;
      let near = 0;
      for (let dy = -1; dy <= 1 && near === 0; dy++) for (let dx = -1; dx <= 1; dx++) if (isSolidCell(map, x + dx, y + dy)) near = 1;
      edge[y * map.width + x] = near;
    }
  }
  g = { edge, g: new Int32Array(n), parent: new Int32Array(n), stamp: new Uint32Array(n), closed: new Uint32Array(n), gen: 0, heapNode: new Int32Array(1024), heapF: new Int32Array(1024), size: 0 };
  grids.set(map, g);
  return g;
}

function less(fa: number, na: number, fb: number, nb: number): boolean {
  return fa < fb || (fa === fb && na < nb);
}

function push(s: Grid, node: number, f: number): void {
  if (s.size === s.heapNode.length) {
    const nn = new Int32Array(s.size * 2);
    nn.set(s.heapNode);
    s.heapNode = nn;
    const nf = new Int32Array(s.size * 2);
    nf.set(s.heapF);
    s.heapF = nf;
  }
  let i = s.size++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!less(f, node, s.heapF[p], s.heapNode[p])) break;
    s.heapNode[i] = s.heapNode[p];
    s.heapF[i] = s.heapF[p];
    i = p;
  }
  s.heapNode[i] = node;
  s.heapF[i] = f;
}

function pop(s: Grid): number {
  const top = s.heapNode[0];
  const n = --s.size;
  if (n > 0) {
    const node = s.heapNode[n];
    const f = s.heapF[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && less(s.heapF[r], s.heapNode[r], s.heapF[l], s.heapNode[l]) ? r : l;
      if (!less(s.heapF[c], s.heapNode[c], f, node)) break;
      s.heapNode[i] = s.heapNode[c];
      s.heapF[i] = s.heapF[c];
      i = c;
    }
    s.heapNode[i] = node;
    s.heapF[i] = f;
  }
  return top;
}

/** 半徑 r 的圓（中心座標單位）是否與任何牆格重疊 */
export function circleHitsWall(map: ShooterMap, x: number, y: number, r: number): boolean {
  const x0 = cellOf(x - r);
  const x1 = cellOf(x + r);
  const y0 = cellOf(y - r);
  const y1 = cellOf(y + r);
  const r2 = r * r;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (!isSolidCell(map, cx, cy)) continue;
      if (pointRectDistSq(x, y, cx * UNIT, cy * UNIT, (cx + 1) * UNIT, (cy + 1) * UNIT) < r2) return true;
    }
  }
  return false;
}

/** 圓沿線段掃過時是否碰牆（每 200 單位取樣一次） */
export function sweptClear(map: ShooterMap, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(Math.abs(dx), Math.abs(dy));
  const steps = Math.max(1, idiv(len, 200) + 1);
  for (let k = 0; k <= steps; k++) {
    if (circleHitsWall(map, ax + idiv(dx * k, steps), ay + idiv(dy * k, steps), r)) return false;
  }
  return true;
}

function centerOf(map: ShooterMap, i: number): [number, number] {
  const x = i % map.width;
  return [x * UNIT + UNIT / 2, ((i - x) / map.width) * UNIT + UNIT / 2];
}

/** 最近的可走格（環狀往外找；同距離取列優先較小者） */
export function nearestOpenCell(map: ShooterMap, cx: number, cy: number): number {
  if (!isSolidCell(map, cx, cy)) return cy * map.width + cx;
  for (let r = 1; r < Math.max(map.width, map.height); r++) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        if (!isSolidCell(map, x, y)) return y * map.width + x;
      }
    }
  }
  return -1;
}

/**
 * 從 (sx, sy) 到 (gx, gy) 的路徑（座標單位的轉折點，不含起點、含終點）。
 * 終點在牆裡時改到最近可走格的中心；找不到路回傳 null。
 */
export function findPath(map: ShooterMap, sx: number, sy: number, gx: number, gy: number): [number, number][] | null {
  const w = map.width;
  const goal = nearestOpenCell(map, cellOf(gx), cellOf(gy));
  const start = nearestOpenCell(map, cellOf(sx), cellOf(sy));
  if (goal < 0 || start < 0) return null;
  let ex = gx;
  let ey = gy;
  if (goal !== cellOf(gy) * w + cellOf(gx) || circleHitsWall(map, gx, gy, VISION.bodyRadius)) [ex, ey] = centerOf(map, goal);
  if (sweptClear(map, sx, sy, ex, ey, CLEARANCE)) return [[ex, ey]];
  const s = gridOf(map);
  s.gen += 1;
  s.size = 0;
  const gen = s.gen;
  const gxT = goal % w;
  const gyT = (goal - gxT) / w;
  const h = (i: number): number => {
    const x = i % w;
    const y = (i - x) / w;
    const dx = Math.abs(x - gxT);
    const dy = Math.abs(y - gyT);
    const lo = dx < dy ? dx : dy;
    const hi = dx < dy ? dy : dx;
    return STRAIGHT * (hi - lo) + DIAG * lo;
  };
  s.g[start] = 0;
  s.parent[start] = -1;
  s.stamp[start] = gen;
  push(s, start, h(start));
  let found = false;
  while (s.size > 0) {
    const cur = pop(s);
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
        if (isSolidCell(map, nx, ny)) continue;
        const ni = ny * w + nx;
        if (s.closed[ni] === gen) continue;
        const diag = dx !== 0 && dy !== 0;
        // 不可切角：斜走時兩側都要可走
        if (diag && (isSolidCell(map, nx, cy) || isSolidCell(map, cx, ny))) continue;
        const g = s.g[cur] + (diag ? DIAG : STRAIGHT) + (s.edge[ni] === 1 ? EDGE_COST : 0);
        if (s.stamp[ni] === gen && s.g[ni] <= g) continue;
        s.stamp[ni] = gen;
        s.g[ni] = g;
        s.parent[ni] = cur;
        push(s, ni, g + h(ni));
      }
    }
  }
  if (!found) return null;
  const cells: number[] = [];
  for (let i = goal; i !== -1 && i !== start; i = s.parent[i]) cells.push(i);
  cells.reverse();
  const pts = cells.map((i) => centerOf(map, i));
  if (pts.length === 0) return [[ex, ey]];
  pts[pts.length - 1] = [ex, ey];
  // 平滑：從目前點盡量往後連直線（圓掃過不碰牆）
  const out: [number, number][] = [];
  let px = sx;
  let py = sy;
  let i = 0;
  while (i < pts.length) {
    let best = i;
    for (let j = i + 1; j < pts.length; j++) {
      if (!sweptClear(map, px, py, pts[j][0], pts[j][1], CLEARANCE)) break;
      best = j;
    }
    out.push(pts[best]);
    [px, py] = pts[best];
    i = best + 1;
  }
  return out;
}
