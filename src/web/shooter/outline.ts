// 攻防戰地圖的輪廓幾何（烘焙用，沒有 DOM，測試可以直接跑）：斜切格是真正的 45° 邊，
// 鋸齒階梯才收斜線（Douglas-Peucker 0.8 格），而且收斜線不准蓋到任何可走格。矮牆併矩形、選型、路標與包點塗裝的擺位也在這裡。
import type { MapInfo } from '../../shooter/api.ts';
import { SLOPE_LOW, SLOPE_WALL, slopeCorner } from '../../shooter/map.ts';
import { hash2 } from './materials.ts';

/** 烘焙只需要這些欄位（設定卡背景用 MAPS 的 ShooterMap，對局用 MapInfo） */
export type BakeMap = Pick<MapInfo, 'id' | 'name' | 'width' | 'height' | 'sites' | 'spawnZones' | 'regions'> & { readonly solid: ArrayLike<number> };
export type Pt = readonly [number, number];

export interface CellRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const cellAt = (m: BakeMap, x: number, y: number): number => (x < 0 || y < 0 || x >= m.width || y >= m.height ? 1 : m.solid[y * m.width + x]);
/** 整格的牆 */
export const isWall = (m: BakeMap, x: number, y: number): boolean => cellAt(m, x, y) === 1;
const isSlopeWall = (v: number): boolean => v >= SLOPE_WALL && v < SLOPE_LOW;

/** 格的四個角（順時針，從西北起）相對左上角的位置 */
export const CORNER_X = [0, 1, 1, 0];
export const CORNER_Y = [0, 0, 1, 1];
const STEP = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** 牆蓋滿這格的 side 邊（0 北、1 東、2 南、3 西）：斜切牆只蓋滿貼著實心角的兩條邊；矮牆不算牆 */
function covers(m: BakeMap, x: number, y: number, side: number): boolean {
  const v = cellAt(m, x, y);
  if (v === 1) return true;
  if (!isSlopeWall(v)) return false;
  const c = slopeCorner(v);
  return side === c || side === (c + 3) % 4;
}

/** 格可走那一邊裡的代表點：一般格是中心，斜切牆是可走三角形裡的點 */
export function freePoint(m: BakeMap, x: number, y: number): Pt | null {
  const v = cellAt(m, x, y);
  if (v === 1) return null;
  if (!isSlopeWall(v)) return [x + 0.5, y + 0.5];
  const c = slopeCorner(v);
  return [x + (c === 0 || c === 3 ? 0.75 : 0.25), y + (c === 0 || c === 1 ? 0.75 : 0.25)];
}

export interface Loop {
  readonly pts: readonly Pt[];
  /** pts[i]→pts[i+1] 是不是斜切格的斜邊 */
  readonly slope: readonly boolean[];
}

/** 把可走區（含矮牆）的外框描成封閉折線，可走區在行進方向右側；斜切格的斜邊是真正的 45° 邊 */
export function traceLoops(m: BakeMap): Loop[] {
  const w = m.width + 2;
  const key = (x: number, y: number): number => (y + 1) * w + x + 1;
  const out = new Map<number, { x: number; y: number; slope: boolean }[]>();
  const add = (ax: number, ay: number, bx: number, by: number, slope: boolean): void => {
    const k = key(ax, ay);
    const list = out.get(k);
    if (list === undefined) out.set(k, [{ x: bx, y: by, slope }]);
    else list.push({ x: bx, y: by, slope });
  };
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (cellAt(m, x, y) === 1) continue;
      for (let side = 0; side < 4; side++) {
        if (covers(m, x, y, side) || !covers(m, x + STEP[side][0], y + STEP[side][1], (side + 2) % 4)) continue;
        const end = (side + 1) % 4;
        add(x + CORNER_X[side], y + CORNER_Y[side], x + CORNER_X[end], y + CORNER_Y[end], false);
      }
      const v = cellAt(m, x, y);
      if (isSlopeWall(v)) {
        // 可走三角形順時針的第三邊：實心角的逆時針鄰角 → 順時針鄰角
        const c = slopeCorner(v);
        const a = (c + 3) % 4;
        const b = (c + 1) % 4;
        add(x + CORNER_X[a], y + CORNER_Y[a], x + CORNER_X[b], y + CORNER_Y[b], true);
      }
    }
  }
  const loops: Loop[] = [];
  for (const [k, list] of out) {
    while (list.length > 0) {
      const x0 = (k % w) - 1;
      const y0 = Math.floor(k / w) - 1;
      const pts: Pt[] = [[x0, y0]];
      const slope: boolean[] = [];
      let cur = list.pop() as { x: number; y: number; slope: boolean };
      slope.push(cur.slope);
      while (cur.x !== x0 || cur.y !== y0) {
        pts.push([cur.x, cur.y]);
        const l = out.get(key(cur.x, cur.y)) as { x: number; y: number; slope: boolean }[];
        cur = l.pop() as { x: number; y: number; slope: boolean };
        slope.push(cur.slope);
      }
      loops.push({ pts, slope });
    }
  }
  return loops;
}

function pointLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** 點在多邊形內（射線奇偶） */
export function inPolygon(x: number, y: number, pts: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 折線與其弦圍起來的範圍裡有沒有可走點：有就不能收成直線 */
function coversFree(m: BakeMap, pts: readonly Pt[]): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(m.height, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(m.width, Math.ceil(x1)); x++) {
      const p = freePoint(m, x, y);
      if (p !== null && inPolygon(p[0], p[1], pts)) return true;
    }
  }
  return false;
}

function dp(m: BakeMap, pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length < 3) return [...pts];
  let best = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointLine(pts[i], pts[0], pts[pts.length - 1]);
    if (d > best) {
      best = d;
      at = i;
    }
  }
  if (best === 0) return [pts[0], pts[pts.length - 1]];
  if (best <= tol && !coversFree(m, pts)) return [pts[0], pts[pts.length - 1]];
  return [...dp(m, pts.slice(0, at + 1), tol).slice(0, -1), ...dp(m, pts.slice(at), tol)];
}

/**
 * 鋸齒階梯收成直線：格子階梯離直線最多約 0.7 格，門檻 0.8 只會吃掉階梯、留下真正的轉角。
 * 斜切格的斜邊原樣留下（那就是碰撞的形狀），只有兩段斜邊之間的鋸齒才收；蓋到可走點的那一段不收。
 */
export function simplifyLoop(m: BakeMap, loop: Loop, tol = 0.8): Pt[] {
  const { pts, slope } = loop;
  const n = pts.length;
  // 頂點從斜邊的起點開始，環才不會切在一段鋸齒中間
  let start = slope.findIndex((s, i) => s && !slope[(i + n - 1) % n]);
  if (start < 0) {
    // 沒有斜邊：從離第一點最遠的點切成兩半
    let best = -1;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > best) {
        best = d;
        start = i;
      }
    }
    return [...dp(m, pts.slice(0, start + 1), tol).slice(0, -1), ...dp(m, [...pts.slice(start), pts[0]], tol).slice(0, -1)];
  }
  const out: Pt[] = [];
  let run: Pt[] = [];
  const flush = (): void => {
    if (run.length > 0) out.push(...dp(m, run, tol).slice(0, -1));
    run = [];
  };
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (slope[i]) {
      flush();
      // 同方向的斜邊併成一段
      const d = (a: number): Pt => [pts[(a + 1) % n][0] - pts[a][0], pts[(a + 1) % n][1] - pts[a][1]];
      const prev = (i + n - 1) % n;
      if (!(slope[prev] && d(prev)[0] === d(i)[0] && d(prev)[1] === d(i)[1])) out.push(pts[i]);
    } else {
      if (run.length === 0) run.push(pts[i]);
      run.push(pts[(i + 1) % n]);
    }
  }
  flush();
  return out;
}

function area(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

/** 可走區（含矮牆）的外框：圈內是地面、圈外是牆 */
export function openLoops(m: BakeMap): Pt[][] {
  return traceLoops(m).map((l) => {
    const s = simplifyLoop(m, l);
    // 小柱子、單格斜切牆收完會塌掉：面積差太多就用原本的折線
    return s.length < 3 || Math.abs(area(s)) < Math.abs(area(l.pts)) * 0.6 ? [...l.pts] : s;
  });
}

/** 這個點在牆裡嗎（evenodd，圈外是牆）：烘焙用的牆路徑跟這個判斷同一組折線 */
export const pointInWall = (loops: readonly (readonly Pt[])[], x: number, y: number): boolean => loops.reduce((n, l) => n + (inPolygon(x, y, l) ? 1 : 0), 0) % 2 === 0;

/** 把連在一起的矮牆格併成矩形（道具的形狀就是碰撞矩形；斜切矮牆另畫） */
export function lowRects(m: BakeMap): CellRect[] {
  const used = new Uint8Array(m.width * m.height);
  const free = (x: number, y: number): boolean => x < m.width && y < m.height && m.solid[y * m.width + x] === 2 && used[y * m.width + x] === 0;
  const out: CellRect[] = [];
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (!free(x, y)) continue;
      let x1 = x + 1;
      while (free(x1, y)) x1++;
      let y1 = y + 1;
      for (;;) {
        let full = true;
        for (let i = x; i < x1 && full; i++) full = free(i, y1);
        if (!full) break;
        y1++;
      }
      for (let j = y; j < y1; j++) for (let i = x; i < x1; i++) used[j * m.width + i] = 1;
      out.push({ x0: x, y0: y, x1, y1 });
    }
  }
  return out;
}

export type LowKind = 'crate' | 'sand' | 'barrel';
/** 矮牆選型：位置的固定雜湊，同地圖永遠同一個長相 */
export function lowKind(r: CellRect): LowKind {
  const h = hash2(r.x0, r.y0, 41);
  return h < 0.45 ? 'crate' : h < 0.8 ? 'sand' : 'barrel';
}

export interface Callout {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** 字高（格） */
  readonly size: number;
}

/** 地上的區域名：放在區域裡最寬的一段可走地面上；放不下、離別的字太近就不標。包點已有塗裝 */
export function regionLabels(m: BakeMap): Callout[] {
  const seen = new Set<string>();
  const out: Callout[] = [];
  for (const r of m.regions) {
    if (seen.has(r.name) || r.id.endsWith('Site') || r.id.endsWith('Door')) continue;
    seen.add(r.name);
    const chars = [...r.name].length + 0.6 * ([...r.name].length - 1);
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (cellAt(m, x, y) !== 0) continue;
        sumX += x + 0.5;
        sumY += y + 0.5;
        n++;
      }
    }
    if (n < 18) continue;
    const cx = sumX / n;
    const cy = sumY / n;
    let best: Callout | null = null;
    let bestScore = -Infinity;
    for (let y = r.y0; y < r.y1; y++) {
      let x = r.x0;
      while (x < r.x1) {
        if (cellAt(m, x, y) !== 0 || cellAt(m, x, y - 1) !== 0 || cellAt(m, x, y + 1) !== 0) {
          x++;
          continue;
        }
        let e = x;
        while (e < r.x1 && cellAt(m, e, y) === 0 && cellAt(m, e, y - 1) === 0 && cellAt(m, e, y + 1) === 0) e++;
        const size = Math.min(0.8, (e - x - 0.6) / chars);
        const mx = (x + e) / 2;
        const score = size * 12 - Math.hypot(mx - cx, y + 0.5 - cy) * 0.25;
        if (size >= 0.5 && score > bestScore) {
          bestScore = score;
          best = { name: r.name, x: mx, y: y + 0.5, size };
        }
        x = e;
      }
    }
    if (best === null) continue;
    const b = best;
    if (out.some((o) => Math.abs(o.x - b.x) < 8 && Math.abs(o.y - b.y) < 3)) continue;
    out.push(b);
  }
  return out;
}

/** 包點塗裝的圓環放在離障礙最遠的地方（避開井與石柱）；回傳圓心與半徑 */
export function siteSpot(m: BakeMap, s: CellRect): { x: number; y: number; r: number } {
  const clear = (px: number, py: number): number => {
    let d = 8;
    for (let y = Math.floor(py - 8); y <= py + 8; y++) {
      for (let x = Math.floor(px - 8); x <= px + 8; x++) {
        if (cellAt(m, x, y) === 0) continue;
        d = Math.min(d, Math.hypot(Math.max(x - px, 0, px - x - 1), Math.max(y - py, 0, py - y - 1)));
      }
    }
    return d;
  };
  const mx = (s.x0 + s.x1) / 2;
  const my = (s.y0 + s.y1) / 2;
  let best = { x: mx, y: my, r: 0 };
  let score = -Infinity;
  for (let y = s.y0 + 3; y <= s.y1 - 3; y++) {
    for (let x = s.x0 + 3; x <= s.x1 - 3; x++) {
      // 圓要留在包點框裡，也要離障礙遠
      const c = Math.min(clear(x, y), x - s.x0, y - s.y0, s.x1 - x, s.y1 - y);
      const v = Math.min(c, 7) - Math.hypot(x - mx, y - my) * 0.12;
      if (v > score) {
        score = v;
        best = { x, y, r: c };
      }
    }
  }
  return { x: best.x, y: best.y, r: Math.max(3.4, Math.min(6.4, best.r - 0.6)) };
}
