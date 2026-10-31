// 攻防戰的離屏烘焙：地面、記憶圖、牆與道具三張整圖（24 px／格），載入時畫一次，之後每幀貼圖；另烘一張小地圖底。
// 畫法搬自樣張 A（src/web/sketch/shooter/a.ts、world.ts）。輪廓直接讀 MapInfo：斜切格是真正的 45° 邊，
// 鋸齒階梯才收斜線（Douglas-Peucker 0.8 格），而且收斜線不准蓋到任何可走格。上半部的幾何函式沒有 DOM，測試可以直接跑。
import type { MapInfo } from '../../shooter/api.ts';
import { SLOPE_LOW, SLOPE_WALL, slopeCorner } from '../../shooter/map.ts';
import { PAL, ZONES, decorOf, hash2, rng, zoneGrid, type MapDecor, type Zone } from './materials.ts';

/** 烘焙解析度（px／格） */
export const BAKE_PX = 24;
const RADAR_PX = 4;

/** 烘焙只需要這些欄位（設定卡背景用 MAPS 的 ShooterMap，對局用 MapInfo） */
export type BakeMap = Pick<MapInfo, 'id' | 'name' | 'width' | 'height' | 'sites' | 'spawnZones' | 'regions'> & { readonly solid: ArrayLike<number> };
export type Pt = readonly [number, number];

export interface CellRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

// ───────── 幾何（沒有 DOM） ─────────

const cellAt = (m: BakeMap, x: number, y: number): number => (x < 0 || y < 0 || x >= m.width || y >= m.height ? 1 : m.solid[y * m.width + x]);
/** 整格的牆 */
export const isWall = (m: BakeMap, x: number, y: number): boolean => cellAt(m, x, y) === 1;
const isSlopeWall = (v: number): boolean => v >= SLOPE_WALL && v < SLOPE_LOW;

/** 格的四個角（順時針，從西北起）相對左上角的位置 */
const CORNER_X = [0, 1, 1, 0];
const CORNER_Y = [0, 0, 1, 1];
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
      const c = clear(x, y);
      const v = Math.min(c, 7) - Math.hypot(x - mx, y - my) * 0.12;
      if (v > score) {
        score = v;
        best = { x, y, r: c };
      }
    }
  }
  return { x: best.x, y: best.y, r: Math.max(3.4, Math.min(6.4, best.r - 0.6)) };
}

// ───────── 畫法（要有 canvas） ─────────

const SUN = { x: 0.62, y: 0.78 };
const WALL_H = 0.72;
const LOW_H = 0.3;
const FONT_ZH = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
const FONT_EN = '"Barlow Condensed", "Noto Sans TC", sans-serif';

function makeCanvas(w: number, h: number, alpha = true): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d', { alpha }) as CanvasRenderingContext2D };
}

function strip(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

function paintStone(g: CanvasRenderingContext2D, r: CellRect): void {
  g.fillStyle = PAL.mortar;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  const rowH = 0.8;
  for (let row = Math.floor(r.y0 / rowH); row * rowH < r.y1; row++) {
    const rand = rng(row * 7919 + 11);
    let x = -3 - rand() * 2;
    while (x < r.x1) {
      const len = 1.1 + rand() * 1.1;
      const tone = rand();
      if (x + len > r.x0) {
        g.fillStyle = PAL.stone[Math.floor(tone * 4)];
        strip(g, x + 0.04, row * rowH + 0.04, len - 0.08, rowH - 0.08, 0.16);
      }
      x += len;
    }
  }
}

function paintDirt(g: CanvasRenderingContext2D, r: CellRect, m: BakeMap): void {
  g.fillStyle = PAL.dirt;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  const rand = rng(4242);
  // 大塊低對比色斑 + 細碎石：全圖固定位置，範圍內才畫
  const count = Math.round((m.width * m.height) / 9);
  for (let i = 0; i < count; i++) {
    const x = rand() * m.width;
    const y = rand() * m.height;
    const big = i % 8 === 0;
    const s = big ? 1.5 + rand() * 3 : 0.05 + rand() * 0.09;
    const tone = rand();
    const sx = 0.8 + rand() * 0.6;
    const rot = rand() * 3;
    if (x + s < r.x0 || x - s > r.x1 || y + s < r.y0 || y - s > r.y1) continue;
    g.globalAlpha = big ? 0.22 : 0.55;
    g.fillStyle = tone < 0.5 ? PAL.dirtDark : PAL.dirtLight;
    g.beginPath();
    g.ellipse(x, y, s * sx, s, rot, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function paintWood(g: CanvasRenderingContext2D, r: CellRect): void {
  g.fillStyle = PAL.woodSeam;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  for (let col = Math.floor(r.x0); col < r.x1; col++) {
    const rand = rng(col * 6133 + 5);
    let y = -6 * rand();
    while (y < r.y1 + 8) {
      const len = 4 + rand() * 6;
      const tone = rand();
      const grain = rand();
      if (y + len > r.y0 && y < r.y1) {
        g.fillStyle = PAL.wood[Math.floor(tone * 4)];
        g.fillRect(col + 0.03, y + 0.03, 0.94, len - 0.06);
        // 木紋與釘子
        g.strokeStyle = 'rgba(92, 62, 40, 0.22)';
        g.lineWidth = 0.03;
        g.beginPath();
        g.moveTo(col + 0.3 + grain * 0.4, y + 0.3);
        g.lineTo(col + 0.26 + grain * 0.4, y + len - 0.4);
        g.stroke();
        g.fillStyle = 'rgba(60, 40, 30, 0.45)';
        for (const nx of [0.2, 0.8]) {
          g.beginPath();
          g.arc(col + nx, y + 0.22, 0.04, 0, Math.PI * 2);
          g.fill();
        }
      }
      y += len;
    }
  }
}

function paintSlabs(g: CanvasRenderingContext2D, r: CellRect, tones: readonly string[], size: number): void {
  g.fillStyle = PAL.mortar;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  for (let y = Math.floor(r.y0 / size); y * size < r.y1; y++) {
    for (let x = Math.floor(r.x0 / size) - 1; x * size < r.x1; x++) {
      const ox = y % 2 === 0 ? 0 : size / 2;
      g.fillStyle = tones[Math.floor(hash2(x, y, 7) * tones.length)];
      strip(g, x * size + ox + 0.03, y * size + 0.03, size - 0.06, size - 0.06, 0.1);
    }
  }
}

function paintTarps(g: CanvasRenderingContext2D, decor: MapDecor): void {
  // 市集的帆布攤：平鋪在地上的布
  for (const [x, y, w, h] of decor.tarps) {
    g.fillStyle = 'rgba(120, 90, 90, 0.25)';
    g.fillRect(x + 0.15, y + 0.2, w, h);
    g.fillStyle = '#e7dcc8';
    g.fillRect(x, y, w, h);
    g.fillStyle = PAL.paint;
    for (let i = 0; i < w; i += 2) g.fillRect(x + i, y, 1, h);
    g.fillStyle = 'rgba(255, 255, 255, 0.14)';
    g.fillRect(x, y, w, 0.4);
  }
}

/** 材質區塊的路徑與範圍（一列一列併成矩形） */
function zoneShape(m: BakeMap, grid: readonly Zone[], z: Zone): { path: Path2D; box: CellRect } | null {
  const path = new Path2D();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < m.height; y++) {
    let run = -1;
    for (let x = 0; x <= m.width; x++) {
      const hit = x < m.width && grid[y * m.width + x] === z && cellAt(m, x, y) !== 1;
      if (hit && run < 0) run = x;
      if (!hit && run >= 0) {
        path.rect(run, y, x - run, 1);
        x0 = Math.min(x0, run);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y + 1);
        run = -1;
      }
    }
  }
  return x1 < 0 ? null : { path, box: { x0, y0, x1, y1 } };
}

/** 不同材質交界的路緣 */
function paintCurbs(g: CanvasRenderingContext2D, m: BakeMap, grid: readonly Zone[]): void {
  const p = new Path2D();
  const open = (x: number, y: number): boolean => cellAt(m, x, y) !== 1;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (!open(x, y)) continue;
      const z = grid[y * m.width + x];
      if (x + 1 < m.width && open(x + 1, y) && grid[y * m.width + x + 1] !== z) {
        p.moveTo(x + 1, y);
        p.lineTo(x + 1, y + 1);
      }
      if (y + 1 < m.height && open(x, y + 1) && grid[(y + 1) * m.width + x] !== z) {
        p.moveTo(x, y + 1);
        p.lineTo(x + 1, y + 1);
      }
    }
  }
  g.lineCap = 'square';
  g.strokeStyle = 'rgba(96, 74, 62, 0.55)';
  g.lineWidth = 0.3;
  g.stroke(p);
  g.strokeStyle = '#d9cdb8';
  g.lineWidth = 0.17;
  g.stroke(p);
}

/** 包點地面塗裝：模板噴漆的框、角標、圓環與字母，再用固定雜訊磨舊 */
function paintSites(g: CanvasRenderingContext2D, m: BakeMap): void {
  for (const s of m.sites) {
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    const { c, g: p } = makeCanvas(w * BAKE_PX, h * BAKE_PX);
    p.setTransform(BAKE_PX, 0, 0, BAKE_PX, -s.x0 * BAKE_PX, -s.y0 * BAKE_PX);
    p.strokeStyle = PAL.paint;
    p.fillStyle = PAL.paint;
    p.lineWidth = 0.28;
    p.strokeRect(s.x0 + 0.14, s.y0 + 0.14, w - 0.28, h - 0.28);
    p.lineWidth = 0.09;
    p.strokeRect(s.x0 + 0.5, s.y0 + 0.5, w - 1, h - 1);
    // 四角斜紋
    for (const [ax, ay, sx, sy] of [
      [s.x0, s.y0, 1, 1],
      [s.x1, s.y0, -1, 1],
      [s.x0, s.y1, 1, -1],
      [s.x1, s.y1, -1, -1],
    ] as const) {
      for (let i = 0; i < 4; i++) {
        p.beginPath();
        p.moveTo(ax + sx * (0.5 + i * 0.9), ay + sy * 0.5);
        p.lineTo(ax + sx * (0.95 + i * 0.9), ay + sy * 0.5);
        p.lineTo(ax + sx * 0.5, ay + sy * (0.95 + i * 0.9));
        p.lineTo(ax + sx * 0.5, ay + sy * (0.5 + i * 0.9));
        p.closePath();
        p.fill();
      }
    }
    const spot = siteSpot(m, s);
    p.lineWidth = 0.42;
    p.beginPath();
    p.arc(spot.x, spot.y, spot.r, 0, Math.PI * 2);
    p.stroke();
    p.lineWidth = 0.12;
    p.beginPath();
    p.arc(spot.x, spot.y, spot.r - 0.7, 0, Math.PI * 2);
    p.stroke();
    p.font = `900 ${(spot.r * 1.31).toFixed(2)}px ${FONT_EN}`;
    p.textAlign = 'center';
    p.textBaseline = 'middle';
    p.fillText(s.id, spot.x, spot.y + 0.3);
    p.globalCompositeOperation = 'destination-out';
    const rand = rng(90210 + s.x0 * 31 + s.y0);
    const specks = w * h * 2;
    for (let i = 0; i < specks; i++) {
      p.globalAlpha = 0.4 + rand() * 0.6;
      p.beginPath();
      p.arc(s.x0 + rand() * w, s.y0 + rand() * h, 0.03 + rand() * rand() * 0.34, 0, Math.PI * 2);
      p.fill();
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 0.72;
    g.globalCompositeOperation = 'multiply';
    g.drawImage(c, s.x0 * BAKE_PX, s.y0 * BAKE_PX);
    g.restore();
  }
}

/** 出生區的地面虛線框：購買只能在這裡，兩邊一樣的色，不跟著隊色跑 */
function paintSpawns(g: CanvasRenderingContext2D, m: BakeMap): void {
  g.strokeStyle = 'rgba(96, 74, 62, 0.5)';
  g.lineWidth = 0.14;
  g.setLineDash([0.9, 0.7]);
  for (const z of [m.spawnZones.T, m.spawnZones.CT]) g.strokeRect(z.x0 + 0.3, z.y0 + 0.3, z.x1 - z.x0 - 0.6, z.y1 - z.y0 - 0.6);
  g.setLineDash([]);
}

/** 地面上的區域名：像噴在地上的路標，壓在記憶圖裡也讀得到 */
function paintCallouts(g: CanvasRenderingContext2D, list: readonly Callout[]): void {
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const c of list) {
    g.font = `700 ${c.size}px ${FONT_ZH}`;
    const label = [...c.name].join(' ');
    g.fillStyle = 'rgba(255, 248, 235, 0.55)';
    g.fillText(label, c.x + 0.05, c.y + 0.06);
    g.fillStyle = 'rgba(62, 44, 40, 0.74)';
    g.fillText(label, c.x, c.y);
  }
}

/** 落影與接觸遮蔽：低解析畫完放大，邊緣自然變柔；牆高與矮牆高用不同投影長度 */
function paintShadows(g: CanvasRenderingContext2D, m: BakeMap, wall: Path2D, lows: readonly CellRect[]): void {
  const pw = m.width * BAKE_PX;
  const ph = m.height * BAKE_PX;
  const soft = 3;
  const { c, g: p } = makeCanvas(Math.ceil(pw / soft), Math.ceil(ph / soft), false);
  p.fillStyle = '#ffffff';
  p.fillRect(0, 0, c.width, c.height);
  p.setTransform(BAKE_PX / soft, 0, 0, BAKE_PX / soft, 0, 0);
  p.fillStyle = PAL.shadow;
  for (let i = 1; i <= 10; i++) {
    p.save();
    p.translate(SUN.x * 1.9 * (i / 10), SUN.y * 1.9 * (i / 10));
    p.fill(wall, 'evenodd');
    p.restore();
  }
  for (const r of lows) {
    for (let i = 1; i <= 5; i++) p.fillRect(r.x0 + SUN.x * 0.7 * (i / 5), r.y0 + SUN.y * 0.7 * (i / 5), r.x1 - r.x0, r.y1 - r.y0);
  }
  const ao = 8;
  const { c: c2, g: q } = makeCanvas(Math.ceil(pw / ao), Math.ceil(ph / ao), false);
  q.fillStyle = '#ffffff';
  q.fillRect(0, 0, c2.width, c2.height);
  q.setTransform(BAKE_PX / ao, 0, 0, BAKE_PX / ao, 0, 0);
  q.strokeStyle = PAL.ao;
  q.lineWidth = 1.1;
  q.stroke(wall);
  q.fillStyle = PAL.ao;
  q.fill(wall, 'evenodd');
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.globalCompositeOperation = 'multiply';
  g.drawImage(c2, 0, 0, pw, ph);
  g.drawImage(c, 0, 0, pw, ph);
  g.restore();
}

function paintFloor(m: BakeMap, wall: Path2D, lows: readonly CellRect[], decor: MapDecor): HTMLCanvasElement {
  const { c, g } = makeCanvas(m.width * BAKE_PX, m.height * BAKE_PX, false);
  g.setTransform(BAKE_PX, 0, 0, BAKE_PX, 0, 0);
  g.fillStyle = PAL.dirt;
  g.fillRect(0, 0, m.width, m.height);
  const grid = zoneGrid(m);
  for (const z of ZONES) {
    const shape = zoneShape(m, grid, z);
    if (shape === null) continue;
    g.save();
    g.clip(shape.path);
    const r = shape.box;
    if (z === 'stone') paintStone(g, r);
    else if (z === 'dirt') paintDirt(g, r, m);
    else if (z === 'wood') paintWood(g, r);
    else if (z === 'plaza') paintSlabs(g, r, PAL.plaza, 1.8);
    else if (z === 'site') paintSlabs(g, r, PAL.site, 2.4);
    else {
      paintDirt(g, r, m);
      paintTarps(g, decor);
    }
    g.restore();
  }
  paintCurbs(g, m, grid);
  paintSpawns(g, m);
  paintSites(g, m);
  paintCallouts(g, regionLabels(m));
  paintShadows(g, m, wall, lows);
  return c;
}

/** 記憶圖：同一張地面去飽和再乘上偏冷的淡灰。還是白天，只是「現在沒看著」 */
function memoryOf(floor: HTMLCanvasElement): HTMLCanvasElement {
  const { c, g } = makeCanvas(floor.width, floor.height, false);
  g.drawImage(floor, 0, 0);
  g.globalCompositeOperation = 'saturation';
  g.fillStyle = 'rgba(128, 128, 128, 0.74)';
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = '#c3cadb';
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/** 屋頂：牆其實是一棟棟房子的屋頂，陶瓦、女兒牆、通風口；玩家走不到，所以壓低對比 */
function paintRoof(g: CanvasRenderingContext2D, m: BakeMap): void {
  g.fillStyle = PAL.roof;
  g.fillRect(-2, -2, m.width + 4, m.height + 4);
  g.globalAlpha = 0.3;
  g.strokeStyle = PAL.rimLine;
  g.lineWidth = 0.05;
  g.beginPath();
  for (let y = -2; y < m.height + 2; y += 0.5) {
    g.moveTo(-2, y);
    g.lineTo(m.width + 2, y);
  }
  g.stroke();
  g.globalAlpha = 1;
  // 通風口：遠離牆邊的屋頂才放
  for (let y = 0; y < m.height; y += 5) {
    for (let x = 0; x < m.width; x += 7) {
      if (hash2(x, y, 3) > 0.34) continue;
      let deep = true;
      for (let dy = -8; dy <= 8 && deep; dy++) for (let dx = -8; dx <= 8; dx++) if (!isWall(m, x + dx, y + dy)) deep = false;
      if (!deep) continue;
      g.fillStyle = 'rgba(70, 40, 40, 0.3)';
      g.fillRect(x + 0.16, y + 0.2, 1.4, 1.4);
      g.fillStyle = PAL.rim;
      g.fillRect(x, y, 1.4, 1.4);
      g.fillStyle = PAL.side;
      g.fillRect(x + 0.32, y + 0.32, 0.76, 0.76);
    }
  }
}

function crate(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const top = Math.max(0.4, h - LOW_H);
  g.fillStyle = '#7b5a3e';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#b88d5a';
  g.fillRect(x, y, w, top);
  g.fillStyle = '#cda674';
  g.fillRect(x + 0.1, y + 0.1, w - 0.2, top - 0.2);
  g.strokeStyle = '#8d6a44';
  g.lineWidth = 0.07;
  g.beginPath();
  g.moveTo(x + 0.1, y + 0.1);
  g.lineTo(x + w - 0.1, y + top - 0.1);
  g.moveTo(x + w - 0.1, y + 0.1);
  g.lineTo(x + 0.1, y + top - 0.1);
  g.stroke();
  g.strokeStyle = '#ecd4a8';
  g.lineWidth = 0.05;
  g.beginPath();
  g.moveTo(x + 0.02, y + top - 0.02);
  g.lineTo(x + 0.02, y + 0.02);
  g.lineTo(x + w - 0.02, y + 0.02);
  g.stroke();
}

function sandbags(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  g.fillStyle = '#7f6a55';
  g.fillRect(x + 0.03, y + 0.1, w - 0.06, h - 0.1);
  const rand = rng(x * 31 + y);
  const rows = Math.max(2, Math.round(h / 0.62));
  const rh = (h - LOW_H * 0.6) / rows;
  for (let i = 0; i < rows; i++) {
    const n = Math.max(2, Math.round(w / 0.9));
    const bw = w / n;
    for (let k = 0; k < n; k++) {
      g.fillStyle = rand() < 0.5 ? '#cdbb9b' : '#d8c8aa';
      strip(g, x + k * bw + (i % 2 === 0 ? 0 : 0.05), y + i * rh, bw - 0.05, rh - 0.04, 0.2);
    }
  }
}

function barrels(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const n = Math.max(1, Math.round(w / 0.95));
  const m = Math.max(1, Math.round((h - 0.1) / 0.95));
  const r = Math.min(w / n, (h - 0.1) / m) * 0.47;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const cx = x + ((i + 0.5) * w) / n;
      const cy = y + ((j + 0.5) * (h - 0.1)) / m;
      g.fillStyle = '#5f4a3e';
      g.beginPath();
      g.arc(cx, cy + 0.1, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#8c6b4c';
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#4d4347';
      g.lineWidth = 0.07;
      g.stroke();
      g.fillStyle = '#a98460';
      g.beginPath();
      g.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** 矮牆：箱、沙袋、桶，形狀就是碰撞矩形；長條的箱子拆成一個個 */
function paintLow(g: CanvasRenderingContext2D, m: BakeMap, lows: readonly CellRect[]): void {
  for (const r of lows) {
    const kind = lowKind(r);
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (kind === 'crate') {
      const nx = w >= h ? Math.max(1, Math.round(w / h)) : 1;
      const ny = h > w ? Math.max(1, Math.round(h / w)) : 1;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) crate(g, r.x0 + (i * w) / nx, r.y0 + (j * h) / ny, w / nx, h / ny);
    } else if (kind === 'sand') sandbags(g, r.x0, r.y0, w, h);
    else barrels(g, r.x0, r.y0, w, h);
  }
  // 斜切矮牆：同樣的木箱面，裁成實心三角形
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const v = cellAt(m, x, y);
      if (v < SLOPE_LOW) continue;
      const c = slopeCorner(v);
      g.save();
      g.beginPath();
      for (const k of [c, (c + 1) % 4, (c + 3) % 4]) g.lineTo(x + CORNER_X[k], y + CORNER_Y[k]);
      g.closePath();
      g.clip();
      crate(g, x, y, 1, 1);
      g.restore();
    }
  }
}

/** 牆邊道具：全部畫在牆格裡（走不到），長在牆腳上；依材質區挑種類 */
function paintWallProps(g: CanvasRenderingContext2D, m: BakeMap, grid: readonly Zone[]): void {
  for (let y = 1; y < m.height - 1; y++) {
    for (let x = 1; x < m.width - 2; x++) {
      if (!isWall(m, x, y) || !isWall(m, x + 1, y) || cellAt(m, x, y + 1) !== 0 || cellAt(m, x + 1, y + 1) !== 0) continue;
      if (hash2(x, y, 77) > 0.13) continue;
      const z = grid[(y + 1) * m.width + x];
      if (z === 'wood') barrels(g, x + 0.02, y - 0.1, 1.9, 1.1);
      else if (z === 'stone' || z === 'site') sandbags(g, x, y - 0.1, 2, 1.1);
      else crate(g, x + 0.1, y - 0.1, 1.2, 1.1);
    }
  }
}

/** 井：碰撞是 3×3 的牆方塊，畫成方形石台裡的圓井 */
function paintWell(g: CanvasRenderingContext2D, m: BakeMap, x: number, y: number): void {
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) if (!isWall(m, x + i, y + j)) return;
  g.fillStyle = '#c9bca9';
  strip(g, x, y, 3, 3 - WALL_H * 0.6, 0.25);
  g.fillStyle = '#e3d9c9';
  strip(g, x + 0.06, y + 0.06, 2.88, 3 - WALL_H * 0.6 - 0.2, 0.22);
  const cx = x + 1.5;
  const cy = y + 1.3;
  g.fillStyle = PAL.rimLine;
  g.beginPath();
  g.arc(cx, cy, 1.08, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2f4a5c';
  g.beginPath();
  g.arc(cx, cy, 0.86, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(190, 225, 240, 0.35)';
  g.beginPath();
  g.ellipse(cx - 0.22, cy - 0.28, 0.34, 0.14, -0.6, 0, Math.PI * 2);
  g.fill();
}

function paintWalls(m: BakeMap, wall: Path2D, lows: readonly CellRect[], decor: MapDecor): HTMLCanvasElement {
  const { c, g } = makeCanvas(m.width * BAKE_PX, m.height * BAKE_PX);
  g.setTransform(BAKE_PX, 0, 0, BAKE_PX, 0, 0);
  g.lineJoin = 'round';
  g.fillStyle = PAL.side;
  g.fill(wall, 'evenodd');
  g.save();
  g.clip(wall, 'evenodd');
  // 側面的石層
  g.strokeStyle = PAL.sideLine;
  g.lineWidth = 0.05;
  for (const k of [0.3, 0.55]) {
    g.save();
    g.translate(0, -WALL_H * k);
    g.stroke(wall);
    g.restore();
  }
  // 屋頂：往北西推一點就露出南、東兩面；被牆實心裁切，永遠不會蓋到可走區
  g.save();
  g.translate(-0.2, -WALL_H);
  g.clip(wall, 'evenodd');
  paintRoof(g, m);
  // 一階一階往內退的台地：屋頂像層層堆起的土台
  for (const [w, tone] of [
    [13, PAL.roofMid],
    [7.4, PAL.roofOuter],
  ] as const) {
    g.strokeStyle = PAL.rimLine;
    g.lineWidth = w + 0.16;
    g.stroke(wall);
    g.strokeStyle = tone;
    g.lineWidth = w;
    g.stroke(wall);
  }
  g.strokeStyle = PAL.rimLine;
  g.lineWidth = 1.5;
  g.stroke(wall);
  g.strokeStyle = PAL.rim;
  g.lineWidth = 1.26;
  g.stroke(wall);
  g.strokeStyle = 'rgba(255, 235, 215, 0.5)';
  g.lineWidth = 0.1;
  g.stroke(wall);
  g.restore();
  g.restore();
  for (const w of decor.wells) paintWell(g, m, w.x, w.y);
  paintWallProps(g, m, zoneGrid(m));
  paintLow(g, m, lows);
  return c;
}

/** 把折線加進路徑；r > 0 時轉角倒圓 */
export function addLoop(path: Path2D, pts: readonly Pt[], r: number): void {
  const n = pts.length;
  if (r <= 0) {
    pts.forEach(([x, y], i) => {
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    return;
  }
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  path.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const o = pts[(i + n - 1) % n];
    const lim = Math.min(Math.hypot(p[0] - o[0], p[1] - o[1]), Math.hypot(q[0] - p[0], q[1] - p[1])) / 2;
    path.arcTo(p[0], p[1], q[0], q[1], Math.min(r, lim));
  }
  path.closePath();
}

/** 牆的實心路徑（evenodd）：外面一大塊減掉可走區；bleed 是往地圖外延伸的格數，落影、裁切才不會在地圖邊緣斷掉 */
export function wallPathOf(m: BakeMap, loops: readonly (readonly Pt[])[], r: number, bleed = 8): Path2D {
  const p = new Path2D();
  p.rect(-bleed, -bleed, m.width + bleed * 2, m.height + bleed * 2);
  for (const loop of loops) addLoop(p, loop, r);
  return p;
}

/** 小地圖底：牆色鋪滿、可走區挖開、包點上色與字母 */
function paintRadar(m: BakeMap, loops: readonly (readonly Pt[])[]): HTMLCanvasElement {
  const { c, g } = makeCanvas(m.width * RADAR_PX, m.height * RADAR_PX, false);
  g.fillStyle = '#141821';
  g.fillRect(0, 0, c.width, c.height);
  g.setTransform(RADAR_PX, 0, 0, RADAR_PX, 0, 0);
  const p = new Path2D();
  for (const l of loops) addLoop(p, l, 0);
  g.fillStyle = '#3a4252';
  g.fill(p, 'evenodd');
  g.fillStyle = 'rgba(238, 242, 246, 0.14)';
  for (const s of m.sites) g.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  g.fillStyle = '#eef2f6';
  g.font = `900 9px ${FONT_EN}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const s of m.sites) g.fillText(s.id, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
  return c;
}

export interface Baked {
  readonly key: string;
  readonly floor: HTMLCanvasElement;
  readonly memory: HTMLCanvasElement;
  readonly walls: HTMLCanvasElement;
  readonly radar: HTMLCanvasElement;
  /** 烘焙用的牆路徑（格座標，evenodd） */
  readonly wall: Path2D;
  /** 同一組折線，測試與驗收用 */
  readonly loops: readonly (readonly Pt[])[];
  readonly labels: readonly Callout[];
  /** 這次烘焙花的毫秒（含把畫布指令畫完） */
  readonly ms: number;
}

function keyOf(m: BakeMap): string {
  let h = 2166136261;
  for (let i = 0; i < m.solid.length; i++) h = Math.imul(h ^ m.solid[i], 16777619);
  return `${m.id}:${m.width}x${m.height}:${(h >>> 0).toString(16)}`;
}

let cached: Baked | null = null;

/** 烘焙（同一張地圖只烘一次；換地圖重烘並釋放舊圖） */
export function bakeMap(m: BakeMap): Baked {
  const key = keyOf(m);
  if (cached !== null && cached.key === key) return cached;
  if (cached !== null) for (const c of [cached.floor, cached.memory, cached.walls, cached.radar]) c.width = 0;
  const t0 = performance.now();
  const loops = openLoops(m);
  const wall = wallPathOf(m, loops, 0.3);
  const lows = lowRects(m);
  const decor = decorOf(m.id);
  const floor = paintFloor(m, wall, lows, decor);
  const memory = memoryOf(floor);
  const walls = paintWalls(m, wall, lows, decor);
  const radar = paintRadar(m, loops);
  // 讀一個像素逼畫布把排隊的指令畫完，毫秒數才是真的
  for (const c of [memory, walls]) c.getContext('2d')?.getImageData(0, 0, 1, 1);
  cached = { key, floor, memory, walls, radar, wall, loops, labels: regionLabels(m), ms: performance.now() - t0 };
  return cached;
}
