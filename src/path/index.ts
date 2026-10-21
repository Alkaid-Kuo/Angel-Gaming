// 8 方向整數成本 A*、路徑平滑、線段通行檢查。
// 只依賴「通行格網」：walk[idx] = 0 阻擋、1 平地、2 樹林（樹林成本較高）。
import { PATH_COST, TILE_SIZE } from '../config/index.ts';
import { idiv } from '../shared/intmath.ts';

export const WALK_BLOCKED = 0;
export const WALK_PLAIN = 1;
export const WALK_FOREST = 2;

export interface WalkGrid {
  readonly width: number;
  readonly height: number;
  readonly walk: Uint8Array;
}

/** 目標矩形（格座標，含端點）。抵達矩形內任一格即完成。 */
export interface GoalRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface FindPathOptions {
  /** 允許進入目標矩形內的阻擋格（例如 pathDistance 的終點被建築佔據） */
  readonly allowBlockedGoal?: boolean;
}

export interface PathResult {
  /** 由起點（不含）到終點（含）的格索引 */
  readonly tiles: number[];
  /** 是否真的抵達目標；否則為最接近目標的可到達點 */
  readonly reached: boolean;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
// 優先佇列鍵值 = f × 2^34 ＋ h × 2^15 ＋ 格索引（格數 ≤ 2^15、f 與 h < 2^19，總和 < 2^53）
const KEY_F = 2 ** 34;
const KEY_H = 2 ** 15;

export function octile(dx: number, dy: number): number {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const mn = ax < ay ? ax : ay;
  const mx = ax < ay ? ay : ax;
  return PATH_COST.diagonal * mn + PATH_COST.straight * (mx - mn);
}

export function rectPoint(x: number, y: number): GoalRect {
  return { x0: x, y0: y, x1: x, y1: y };
}

/** 可重複使用緩衝區的 A* 尋路器（每個地圖尺寸一個實例） */
export class PathFinder {
  readonly width: number;
  readonly height: number;
  private readonly g: Int32Array;
  private readonly parent: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private gen = 0;
  private heap: Int32Array;
  private heapKey: Float64Array;
  private heapSize = 0;
  /** 統計：A* 呼叫次數與展開節點數 */
  searches = 0;
  expanded = 0;

  constructor(width: number, height: number) {
    const n = width * height;
    if (n >= KEY_H) throw new Error(`PathFinder: 地圖過大 ${width}x${height}`);
    this.width = width;
    this.height = height;
    this.g = new Int32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Int32Array(n * 2);
    this.heapKey = new Float64Array(n * 2);
  }

  findPath(grid: WalkGrid, startIdx: number, goal: GoalRect, options: FindPathOptions = {}): PathResult {
    if (grid.width !== this.width || grid.height !== this.height) throw new Error('PathFinder: 格網尺寸不符');
    const w = this.width;
    const h = this.height;
    const walk = grid.walk;
    const allowBlockedGoal = options.allowBlockedGoal === true;
    this.searches += 1;
    this.gen += 1;
    if (this.gen === 0xffffffff) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.gen = 1;
    }
    const gen = this.gen;
    this.heapSize = 0;

    const sx = startIdx % w;
    const sy = (startIdx - sx) / w;
    const hStart = this.heuristic(sx, sy, goal);
    this.g[startIdx] = 0;
    this.parent[startIdx] = -1;
    this.stamp[startIdx] = gen;
    this.push(startIdx, hStart * KEY_F + hStart * KEY_H + startIdx);

    let bestIdx = startIdx;
    let bestH = hStart;
    let bestG = 0;

    while (this.heapSize > 0) {
      const cur = this.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      this.expanded += 1;
      const cx = cur % w;
      const cy = (cur - cx) / w;
      if (cx >= goal.x0 && cx <= goal.x1 && cy >= goal.y0 && cy <= goal.y1) {
        return { tiles: this.reconstruct(cur), reached: true };
      }
      const gCur = this.g[cur];
      const hCur = this.heuristic(cx, cy, goal);
      if (hCur < bestH || (hCur === bestH && (gCur < bestG || (gCur === bestG && cur < bestIdx)))) {
        bestIdx = cur;
        bestH = hCur;
        bestG = gCur;
      }
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (this.closed[ni] === gen) continue;
        let wv = walk[ni];
        if (wv === WALK_BLOCKED) {
          if (!(allowBlockedGoal && nx >= goal.x0 && nx <= goal.x1 && ny >= goal.y0 && ny <= goal.y1)) continue;
          wv = WALK_PLAIN;
        }
        const diagonal = d >= 4;
        if (diagonal) {
          // 禁止斜向穿過兩個阻擋格之間的縫隙
          if (walk[cy * w + nx] === WALK_BLOCKED && walk[ny * w + cx] === WALK_BLOCKED) continue;
        }
        const step = wv === WALK_FOREST
          ? (diagonal ? PATH_COST.forestDiagonal : PATH_COST.forestStraight)
          : (diagonal ? PATH_COST.diagonal : PATH_COST.straight);
        const ng = gCur + step;
        if (this.stamp[ni] === gen && this.g[ni] <= ng) continue;
        this.stamp[ni] = gen;
        this.g[ni] = ng;
        this.parent[ni] = cur;
        const hn = this.heuristic(nx, ny, goal);
        this.push(ni, (ng + hn) * KEY_F + hn * KEY_H + ni);
      }
    }
    return { tiles: this.reconstruct(bestIdx), reached: false };
  }

  private heuristic(x: number, y: number, goal: GoalRect): number {
    const dx = x < goal.x0 ? goal.x0 - x : x > goal.x1 ? x - goal.x1 : 0;
    const dy = y < goal.y0 ? goal.y0 - y : y > goal.y1 ? y - goal.y1 : 0;
    return octile(dx, dy);
  }

  private reconstruct(end: number): number[] {
    const out: number[] = [];
    let cur = end;
    while (this.parent[cur] !== -1) {
      out.push(cur);
      cur = this.parent[cur];
    }
    out.reverse();
    return out;
  }

  private push(idx: number, key: number): void {
    if (this.heapSize >= this.heap.length) {
      const nh = new Int32Array(this.heap.length * 2);
      nh.set(this.heap);
      this.heap = nh;
      const nk = new Float64Array(this.heapKey.length * 2);
      nk.set(this.heapKey);
      this.heapKey = nk;
    }
    let i = this.heapSize++;
    const heap = this.heap;
    const keys = this.heapKey;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      heap[i] = heap[p];
      keys[i] = keys[p];
      i = p;
    }
    heap[i] = idx;
    keys[i] = key;
  }

  private pop(): number {
    const heap = this.heap;
    const keys = this.heapKey;
    const top = heap[0];
    const n = --this.heapSize;
    if (n > 0) {
      const lastIdx = heap[n];
      const lastKey = keys[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        heap[i] = heap[c];
        keys[i] = keys[c];
        i = c;
      }
      heap[i] = lastIdx;
      keys[i] = lastKey;
    }
    return top;
  }
}

/** 路徑的幾何長度（單位）：直線段 1000、斜向段 1414 */
export function pathLength(width: number, startIdx: number, tiles: readonly number[]): number {
  let total = 0;
  let prev = startIdx;
  for (const t of tiles) {
    const diagonal = (t % width) !== (prev % width) && idiv(t, width) !== idiv(prev, width);
    total += diagonal ? PATH_COST.diagonalLength : PATH_COST.straightLength;
    prev = t;
  }
  return total;
}

export function tileCenter(tile: number): number {
  return tile * TILE_SIZE + (TILE_SIZE >> 1);
}

/**
 * 線段 (x0,y0)→(x1,y1)（單位座標）經過的每一格是否都可通行。
 * 恰好穿過格角時，兩側的格都要檢查（保守判定）。
 * allowForest = false 時，經過樹林格也視為不通。
 */
export function segmentClear(grid: WalkGrid, x0: number, y0: number, x1: number, y1: number, allowForest: boolean): boolean {
  const w = grid.width;
  const walk = grid.walk;
  const T = TILE_SIZE;
  let tx = idiv(x0, T);
  let ty = idiv(y0, T);
  const ex = idiv(x1, T);
  const ey = idiv(y1, T);
  const ok = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx >= w || cy >= grid.height) return false;
    const v = walk[cy * w + cx];
    return v === WALK_PLAIN || (allowForest && v === WALK_FOREST);
  };
  if (!ok(tx, ty)) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  // 到下一條格線的距離（沿各軸）
  let nx = stepX > 0 ? (tx + 1) * T - x0 : stepX < 0 ? x0 - tx * T + 1 : 0;
  let ny = stepY > 0 ? (ty + 1) * T - y0 : stepY < 0 ? y0 - ty * T + 1 : 0;
  let remaining = Math.abs(ex - tx) + Math.abs(ey - ty);
  while (remaining > 0) {
    let moveX: boolean;
    let moveY: boolean;
    if (tx === ex) {
      moveX = false;
      moveY = true;
    } else if (ty === ey) {
      moveX = true;
      moveY = false;
    } else {
      const cmp = nx * ady - ny * adx;
      moveX = cmp <= 0;
      moveY = cmp >= 0;
    }
    if (moveX && moveY) {
      if (!ok(tx + stepX, ty) || !ok(tx, ty + stepY)) return false;
      tx += stepX;
      ty += stepY;
      nx += T;
      ny += T;
      remaining -= 2;
    } else if (moveX) {
      tx += stepX;
      nx += T;
      remaining -= 1;
    } else {
      ty += stepY;
      ny += T;
      remaining -= 1;
    }
    if (!ok(tx, ty)) return false;
  }
  return true;
}

/**
 * 路徑平滑（拉直轉角）：由起點出發，盡量往後找可直線抵達的路徑點。
 * 回傳路徑點陣列 [x0, y0, x1, y1, ...]（單位座標，不含起點）。
 * 樹林格不做拉直，以保留 A* 依樹林成本選擇的路線。
 */
export function smoothPath(grid: WalkGrid, startX: number, startY: number, tiles: readonly number[], endX: number, endY: number): number[] {
  const w = grid.width;
  const n = tiles.length;
  if (n === 0) return [];
  const px: number[] = new Array<number>(n);
  const py: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    const x = t % w;
    px[i] = tileCenter(x);
    py[i] = tileCenter((t - x) / w);
  }
  px[n - 1] = endX;
  py[n - 1] = endY;
  const out: number[] = [];
  let ax = startX;
  let ay = startY;
  let i = 0;
  while (i < n) {
    let k = i;
    while (k + 1 < n && segmentClear(grid, ax, ay, px[k + 1], py[k + 1], false)) k += 1;
    out.push(px[k], py[k]);
    ax = px[k];
    ay = py[k];
    i = k + 1;
  }
  return out;
}

/**
 * 路徑快取：以（起點格, 目標矩形）為鍵保存 A* 結果。
 * 通行格網改變時必須呼叫 clear()；A* 是確定性的，因此快取對結果透明。
 */
export class PathCache {
  private readonly map = new Map<number, PathResult>();
  private readonly capacity: number;
  hits = 0;
  misses = 0;

  constructor(capacity = 8192) {
    this.capacity = capacity;
  }

  private static key(start: number, goal: GoalRect, allowBlockedGoal: boolean): number {
    // 起點 < 2^14、各座標 < 2^7：總長 < 2^43
    return ((((start * 128 + goal.x0) * 128 + goal.y0) * 128 + goal.x1) * 128 + goal.y1) * 2 + (allowBlockedGoal ? 1 : 0);
  }

  find(finder: PathFinder, grid: WalkGrid, start: number, goal: GoalRect, options: FindPathOptions = {}): PathResult {
    const k = PathCache.key(start, goal, options.allowBlockedGoal === true);
    const hit = this.map.get(k);
    if (hit !== undefined) {
      this.hits += 1;
      return hit;
    }
    this.misses += 1;
    const res = finder.findPath(grid, start, goal, options);
    if (this.map.size >= this.capacity) this.map.clear();
    this.map.set(k, res);
    return res;
  }

  clear(): void {
    this.map.clear();
  }
}
