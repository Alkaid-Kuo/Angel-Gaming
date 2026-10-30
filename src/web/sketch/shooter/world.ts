// 攻防戰美術樣張共用：只讀 MAPS.redrock() 的幾何，轉成繪製要用的形狀（牆輪廓、區域材質、視線多邊形、固定種子雜訊）。
// 全部以格為單位；繪製時由各方向自己乘上鏡頭比例。不用 Math.random，之後正式版可以直接搬。
import { MAPS, REDROCK_LAYOUT, type Rect } from '../../../shooter/map.ts';

export type Pt = readonly [number, number];
export const MAP = MAPS.redrock();
export const LOW_RECTS: readonly Rect[] = REDROCK_LAYOUT.low ?? [];

export const isWall = (x: number, y: number): boolean => x < 0 || y < 0 || x >= MAP.width || y >= MAP.height || MAP.solid[y * MAP.width + x] === 1;
export const isLow = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP.width && y < MAP.height && MAP.solid[y * MAP.width + x] === 2;

/** 固定種子亂數（mulberry32） */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 格座標的固定雜訊 0～1 */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 把 test 成立的格子外框描成封閉折線（格座標；格子在行進方向右側） */
export function traceLoops(test: (x: number, y: number) => boolean): Pt[][] {
  const w = MAP.width + 2;
  const key = (x: number, y: number): number => (y + 1) * w + x + 1;
  const out = new Map<number, Pt[]>();
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const k = key(ax, ay);
    const list = out.get(k);
    if (list === undefined) out.set(k, [[bx, by]]);
    else list.push([bx, by]);
  };
  for (let y = 0; y < MAP.height; y++) {
    for (let x = 0; x < MAP.width; x++) {
      if (!test(x, y)) continue;
      if (!test(x, y - 1)) add(x, y, x + 1, y);
      if (!test(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!test(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!test(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops: Pt[][] = [];
  for (const [k, list] of out) {
    while (list.length > 0) {
      const x0 = (k % w) - 1;
      const y0 = Math.floor(k / w) - 1;
      const loop: Pt[] = [[x0, y0]];
      let cur = list.pop() as Pt;
      while (cur[0] !== x0 || cur[1] !== y0) {
        loop.push(cur);
        const l = out.get(key(cur[0], cur[1])) as Pt[];
        cur = l.pop() as Pt;
      }
      loops.push(loop);
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

function dp(pts: readonly Pt[], tol: number): Pt[] {
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
  if (best <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, at + 1), tol).slice(0, -1), ...dp(pts.slice(at), tol)];
}

/** 鋸齒階梯收成直線：格子階梯離直線最多約 0.7 格，門檻 0.8 只會吃掉階梯、留下真正的轉角 */
export function simplifyLoop(pts: readonly Pt[], tol = 0.8): Pt[] {
  let far = 0;
  let best = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = pts.slice(0, far + 1);
  const b = [...pts.slice(far), pts[0]];
  return [...dp(a, tol).slice(0, -1), ...dp(b, tol).slice(0, -1)];
}

/** 可走區（含矮牆）的外框，已收成斜線；這些圈內是地面、圈外是牆 */
export const OPEN_LOOPS: readonly Pt[][] = traceLoops((x, y) => !isWall(x, y)).map((l) => simplifyLoop(l));

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

/** 牆的實心路徑（evenodd）：外面一大塊減掉可走區；bleed 是往地圖外延伸的格數，鏡頭出界時才不會露底 */
export function wallPath(r: number, bleed = 80): Path2D {
  const p = new Path2D();
  p.rect(-bleed, -bleed, MAP.width + bleed * 2, MAP.height + bleed * 2);
  for (const loop of OPEN_LOOPS) addLoop(p, loop, r);
  return p;
}

export type Zone = 'stone' | 'dirt' | 'wood' | 'market' | 'plaza' | 'site';
const ZONE_OF: Readonly<Record<string, Zone>> = {
  tSpawn: 'plaza',
  ctSpawn: 'plaza',
  market: 'market',
  eastLane: 'dirt',
  sideAlley: 'dirt',
  eastGate: 'dirt',
  longHall: 'dirt',
  nook: 'dirt',
  cellar: 'wood',
  cellarHall: 'wood',
  cellarWest: 'wood',
  cellarEast: 'wood',
  tMid: 'stone',
  mid: 'stone',
  arch: 'stone',
  belfry: 'stone',
  steps: 'stone',
  ctAlley: 'stone',
  ctRamp: 'stone',
  northSt: 'stone',
  bGate: 'stone',
  aSite: 'site',
  bSite: 'site',
};
export const ZONES: readonly Zone[] = ['stone', 'dirt', 'wood', 'market', 'plaza', 'site'];

/** 每格的地面材質；區域重疊時比照挖地圖的順序，後面的蓋前面 */
const zoneGrid: (Zone | null)[] = (() => {
  const grid = new Array<Zone | null>(MAP.width * MAP.height).fill(null);
  for (const r of MAP.regions) {
    const z = ZONE_OF[r.id] ?? 'stone';
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) grid[y * MAP.width + x] = z;
  }
  return grid;
})();

export const zoneAt = (x: number, y: number): Zone | null => (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height ? null : zoneGrid[y * MAP.width + x]);

/** 材質區塊的路徑（一列一列併成矩形） */
export function zonePath(z: Zone): Path2D {
  const p = new Path2D();
  for (let y = 0; y < MAP.height; y++) {
    let run = -1;
    for (let x = 0; x <= MAP.width; x++) {
      const hit = x < MAP.width && zoneAt(x, y) === z;
      if (hit && run < 0) run = x;
      if (!hit && run >= 0) {
        p.rect(run, y, x - run, 1);
        run = -1;
      }
    }
  }
  return p;
}

/** 全圖用的區域名：包點已經有地面塗裝，不重複標 */
export function regionLabels(): { name: string; x: number; y: number }[] {
  const seen = new Set<string>();
  return MAP.regions
    .filter((r) => r.id !== 'aSite' && r.id !== 'bSite' && !seen.has(r.name) && seen.add(r.name) !== null)
    .map((r) => ({ name: r.name, x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }));
}

export interface SmokeCircle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** 浮點格子射線（與可玩版畫面同一套算法）：回傳到第一個牆格的距離 */
function castRay(ox: number, oy: number, dx: number, dy: number, maxT: number): number {
  let cx = Math.floor(ox);
  let cy = Math.floor(oy);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tdx = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tdy = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tx = dx === 0 ? Infinity : (dx > 0 ? cx + 1 - ox : ox - cx) * tdx;
  let ty = dy === 0 ? Infinity : (dy > 0 ? cy + 1 - oy : oy - cy) * tdy;
  for (let guard = 0; guard < 400; guard++) {
    let t: number;
    if (tx < ty) {
      t = tx;
      tx += tdx;
      cx += sx;
    } else {
      t = ty;
      ty += tdy;
      cy += sy;
    }
    if (t >= maxT) return maxT;
    if (isWall(cx, cy)) return t;
  }
  return maxT;
}

function rayCircle(ox: number, oy: number, dx: number, dy: number, c: SmokeCircle): number {
  const fx = ox - c.x;
  const fy = oy - c.y;
  const k = fx * fx + fy * fy - c.r * c.r;
  if (k <= 0) return 0;
  const b = fx * dx + fy * dy;
  const disc = b * b - k;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

/**
 * 視線多邊形：從眼睛掃一圈射線，遇牆、煙、視野距離就停。
 * 打到牆的射線多走 reach 格伸進牆裡：斜牆在碰撞上是格子階梯，牆層畫在迷霧之上，邊界就只會看到收成斜線的牆。
 */
export function visionPolygon(ox: number, oy: number, facing: number, fov: number, range: number, smokes: readonly SmokeCircle[], reach = 0.6): Pt[] {
  const pts: Pt[] = [[ox, oy]];
  const n = Math.round(fov * 3);
  for (let i = 0; i <= n; i++) {
    const a = ((facing - fov / 2 + (fov * i) / n) * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const wall = castRay(ox, oy, dx, dy, range);
    let t = wall < range ? wall + reach : range;
    for (const s of smokes) t = Math.min(t, rayCircle(ox, oy, dx, dy, s));
    pts.push([ox + dx * t, oy + dy * t]);
  }
  return pts;
}
