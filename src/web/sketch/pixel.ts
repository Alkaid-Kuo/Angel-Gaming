// 設計稿 B：霓虹雨巷（賽博像素）。480×270 像素畫布放大 4 倍，一點透視看向巷底的競技場。
// 牆面與地面都由透視反推每一格的世界座標再上色；濕路面的倒影以每一欄的牆腳為鏡線，從畫面上半部取樣。
// 色票只有三個色系：靛藍中性色、霓虹粉、青，另加白色高光；光暈、倒影、雨絲、蒸氣都用換色表加抖色，不用半透明。
import { initStage, onFrame, still } from './stage.ts';

initStage();

const W = 480;
const H = 270;
const F = 150; // 焦距（像素）
const VX = 240; // 消失點
const VY = 120;
const EYE = 1.7; // 眼高（公尺）
const XW = 6.5; // 兩側牆面離巷子中線
const ZEND = 30; // 巷底；再過去是競技場前的廣場
const ZARENA = 60;

// 靛藍 K～S；粉 a～R；青 c～T；白 W
const HEX = {
  K: '#060515', I: '#0b0a1f', J: '#141838', G: '#1e2552', U: '#2b3472', V: '#3e4a96', S: '#6670c0',
  a: '#3d0f3f', b: '#7a1a5c', m: '#c4286c', P: '#ff3d7f', R: '#ff9ec4',
  c: '#0c3550', d: '#1580a0', e: '#22b8d0', Q: '#3ff0ff', T: '#b8fbff',
  W: '#f4f0ff',
} as const;
type Key = keyof typeof HEX;
const pack = (h: string): number => (0xff000000 | (parseInt(h.slice(5, 7), 16) << 16) | (parseInt(h.slice(3, 5), 16) << 8) | parseInt(h.slice(1, 3), 16)) >>> 0;
const C = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, pack(v)])) as Record<Key, number>;
const LUM = new Map<number, number>(Object.values(HEX).map((h) => [pack(h), parseInt(h.slice(1, 3), 16) * 0.3 + parseInt(h.slice(3, 5), 16) * 0.59 + parseInt(h.slice(5, 7), 16) * 0.11]));
const swap = (pairs: string): Map<number, number> => new Map(pairs.split(' ').map((s) => [C[s[0] as Key], C[s[1] as Key]] as [number, number]));
/** 被粉光照到 */
const TP = swap('KJ Ia Ja Gb Ub Vm Sm ab bm mP PR RW cU dV eR QT TW');
/** 被青光照到 */
const TC = swap('KJ Ic Jc Gd Ud Ve Se cd de eQ QT TW aU bV mR PR RW');
/** 亮一階（雨絲、蒸氣） */
const UP = swap('KI IJ JG GU UV VS SW ab bm mP PR RW cd de eQ QT TW');
/** 暗一階（倒影） */
const DN = swap('KK IK JI GJ UG VU SV WS aI ba mb Pm RP cI dc ed Qe TQ');
const tone = (m: Map<number, number>, c: number): number => m.get(c) ?? c;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bay = (x: number, y: number): number => BAYER[(y & 3) * 4 + (x & 3)];

const hash = (x: number, y: number): number => {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const sx = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const sy = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
/** 世界座標 → 畫面（x 為離巷子中線的公尺，y 為離地高度，z 為深度） */
const px = (x: number, z: number): number => VX + (F * x) / z;
const py = (y: number, z: number): number => VY - (F * (y - EYE)) / z;

interface Layer {
  w: number;
  h: number;
  px: Uint32Array;
}
const layer = (w: number, h: number): Layer => ({ w, h, px: new Uint32Array(w * h) });
function pset(L: Layer, x: number, y: number, c: number): void {
  x = Math.round(x);
  y = Math.round(y);
  if (x >= 0 && y >= 0 && x < L.w && y < L.h) L.px[y * L.w + x] = c;
}
function rect(L: Layer, x: number, y: number, w: number, h: number, c: number): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) pset(L, xx, yy, c);
}
function line(L: Layer, x0: number, y0: number, x1: number, y1: number, c: number): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) pset(L, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
}
function poly(L: Layer, pts: [number, number][], c: number): void {
  const ys = pts.map((p) => p[1]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= y + 0.5 && y1 > y + 0.5) || (y1 <= y + 0.5 && y0 > y + 0.5)) xs.push(x0 + ((y + 0.5 - y0) * (x1 - x0)) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) pset(L, x, y, c);
  }
}
/** 在圖層上以換色表抖色出一圈光（只染已經有顏色的格） */
function haloL(L: Layer, m: Map<number, number>, cx: number, cy: number, rx: number, ry: number, s: number): void {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      if (x < 0 || y < 0 || x >= L.w || y >= L.h) continue;
      const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      const p = y * L.w + x;
      if (d < 1 && L.px[p] && s * (1 - d) * 16 > bay(x, y)) L.px[p] = tone(m, L.px[p]);
    }
  }
}

// 5×5 的偽漢字（招牌字），橫豎筆畫隨機組合
const GLYPHS = Array.from({ length: 64 }, (_, i) => {
  let m = 0;
  const set = (x: number, y: number): void => {
    m |= 1 << (y * 5 + x);
  };
  const r = (k: number): number => hash(i * 31 + k, 91);
  for (let k = 0; k < 1 + Math.floor(r(0) * 2); k++) {
    const y = [0, 2, 4][Math.floor(r(2 + k) * 3)];
    for (let x = Math.floor(r(5 + k) * 2); x <= 3 + Math.floor(r(8 + k) * 2); x++) set(x, y);
  }
  for (let k = 0; k < 1 + Math.floor(r(1) * 2); k++) {
    const x = [0, 2, 4][Math.floor(r(11 + k) * 3)];
    for (let y = Math.floor(r(14 + k) * 2); y <= 3 + Math.floor(r(17 + k) * 2); y++) set(x, y);
  }
  if (r(20) < 0.5) set(1 + Math.floor(r(21) * 3), 1 + Math.floor(r(22) * 3));
  return m;
});
const ink = (g: number, x: number, y: number): boolean => ((GLYPHS[g & 63] >> (y * 5 + x)) & 1) === 1;

// ── 遠景（天空、高樓、競技場；隨滑鼠小幅視差）：層 x = 畫面 x + FX ──
const FX = 10;
const FAR = layer(500, 125);
const RING = { x: 240, y: 76, r: 43 }; // 競技場上空的光環（畫面座標）
const holoAd: number[] = []; // 左邊高樓的直式全像廣告（層內索引）
{
  const bands: [number, Key][] = [[0, 'K'], [24, 'I'], [54, 'J'], [126, 'J']];
  for (let y = 0; y < FAR.h; y++) {
    const i = bands.findIndex((b, k) => y >= b[0] && y < bands[k + 1][0]);
    const t = Math.max(0, (y - (bands[i + 1][0] - 8)) / 8);
    for (let x = 0; x < FAR.w; x++) FAR.px[y * FAR.w + x] = t * 16 > bay(x, y) ? C[bands[i + 1][1]] : C[bands[i][1]];
  }
  for (let i = 0; i < 26; i++) pset(FAR, 170 + hash(i, 1) * 160, hash(i, 2) * 40, i % 3 ? C.V : C.S);
  const tower = (x0: number, x1: number, top: number, body: Key, edge: number, seed: number): void => {
    rect(FAR, x0, top, x1 - x0, FAR.h - top, C[body]);
    for (let y = top; y < FAR.h; y++) pset(FAR, edge, y, C.G);
    for (let y = top + 3; y < FAR.h; y += 4) {
      for (let x = x0 + 2; x < x1 - 1; x += 3) {
        const h = hash(x * 7 + seed, y);
        if (h < 0.13) pset(FAR, x, y, [C.d, C.b, C.V][Math.floor(h * 23) % 3]);
      }
    }
  };
  tower(150, 206, 0, 'I', 205, 1);
  tower(196, 218, 40, 'J', 217, 2);
  tower(294, 352, 4, 'I', 294, 3);
  tower(282, 300, 50, 'J', 282, 4);
  for (let x = 200; x < 300;) {
    const w = 6 + Math.floor(hash(x, 9) * 9);
    const top = 86 + Math.floor(hash(x, 10) * 12);
    rect(FAR, x, top, w, FAR.h - top, hash(x, 11) < 0.5 ? C.J : C.G);
    for (let y = top + 2; y < 104; y += 3) for (let xx = x + 1; xx < x + w - 1; xx += 2) if (hash(xx, y) < 0.1) pset(FAR, xx, y, C.V);
    x += w;
  }
  // 左樓的全像廣告：粉底、掃描線、三個直排招牌字
  for (let y = 2; y < 46; y++) {
    for (let x = 188; x < 204; x++) {
      const gx = x - 193;
      const gy = (y - 6) % 9;
      const gi = Math.floor((y - 6) / 9);
      let c = y % 2 ? C.b : C.a;
      if (x === 188 || x === 203) c = C.m;
      else if (gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && gi >= 0 && gi < 4 && ink(17 + gi * 5, gx, gy)) c = C.R;
      FAR.px[y * FAR.w + x] = c;
      holoAd.push(y * FAR.w + x);
    }
  }
  // 競技場：兩層量體、青色鰭片、正中央的大門最亮；上層一排粉色燈帶
  const ax = (sx: number): number => sx + FX;
  rect(FAR, ax(160), 106, 160, 19, C.J);
  rect(FAR, ax(160), 106, 160, 1, C.G);
  rect(FAR, ax(196), 100, 88, 6, C.I);
  rect(FAR, ax(196), 100, 88, 1, C.U);
  for (let x = 165; x < 316; x += 7) line(FAR, ax(x), 108, ax(x), 122, C.c);
  for (let y = 110; y < 125; y++) {
    for (let x = 228; x < 253; x++) {
      const d = Math.abs(x + 0.5 - 240.5);
      pset(FAR, ax(x), y, y === 110 ? C.K : d < 4 ? C.W : d < 7 ? C.T : d < 10 ? C.Q : C.e);
    }
  }
  for (const sx of [196, 278]) rect(FAR, ax(sx), 116, 6, 9, C.d);
  haloL(FAR, TP, ax(240), 118, 150, 66, 0.7);
  haloL(FAR, TC, ax(240), 117, 44, 14, 0.95);
}

// ── 兩側街屋：每一欄是一個深度，逐格反推牆面上的位置（u＝深度、v＝高度）再上色 ──
type Shop = 'p' | 'c' | 'shut' | 'dark';
interface Bld {
  z0: number;
  z1: number;
  h: number;
  body: Key;
  shop: Shop;
  strip?: 'p' | 'c';
}
const LEFT: Bld[] = [
  { z0: 3.5, z1: 8.6, h: 22, body: 'J', shop: 'dark' },
  { z0: 8.6, z1: 12.8, h: 18, body: 'I', shop: 'c', strip: 'p' },
  { z0: 12.8, z1: 19, h: 14, body: 'J', shop: 'shut', strip: 'c' },
  { z0: 19, z1: 24.5, h: 11, body: 'G', shop: 'p', strip: 'p' },
  { z0: 24.5, z1: ZEND, h: 8.5, body: 'J', shop: 'c' },
];
const RIGHT: Bld[] = [
  { z0: 3.5, z1: 7, h: 24, body: 'I', shop: 'shut' },
  { z0: 7, z1: 11.5, h: 16, body: 'J', shop: 'p' }, // 拉麵店，雨遮下冒蒸氣
  { z0: 11.5, z1: 16, h: 15, body: 'G', shop: 'dark', strip: 'p' },
  { z0: 16, z1: 23, h: 10, body: 'J', shop: 'c', strip: 'c' },
  { z0: 23, z1: ZEND, h: 9, body: 'I', shop: 'p' },
];
function bldAt(side: number, z: number): [Bld, number] {
  const list = side < 0 ? LEFT : RIGHT;
  for (let i = 0; i < list.length; i++) if (z < list[i].z1) return [list[i], i];
  return [list[list.length - 1], list.length - 1];
}

/** 會依序亮起的窗（每扇窗一組像素） */
interface Lamp {
  px: number[];
  c: number[];
  on: number;
  fl: boolean;
}
const lamps = new Map<number, Lamp>();
function lampPx(id: number, p: number, c: number): void {
  let L = lamps.get(id);
  if (!L) {
    L = { px: [], c: [], on: 0.3 + hash(id, 5) * 2.6, fl: hash(id, 6) < 0.07 };
    lamps.set(id, L);
  }
  L.px.push(p);
  L.c.push(c);
}

function shopPx(side: number, bi: number, b: Bld, du: number, v: number): number {
  if (v < 0.12) return C.K;
  if (b.shop === 'shut') {
    if (v < 0.22) return hash(Math.floor(du * 6), side) < 0.5 ? C.c : C.d; // 鐵捲門下緣漏出來的光
    return Math.floor(v / 0.14) % 2 ? C.G : C.J;
  }
  if (b.shop === 'dark') return (du + v * 0.6) % 2.2 < 0.06 ? (Math.floor((du + v * 0.6) / 2.2) % 3 ? C.J : side < 0 ? C.a : C.c) : (du - 0.3) % 1.6 < 0.07 ? C.K : C.I; // 沒開燈的玻璃，偶爾映著對街的霓虹
  const pink = b.shop === 'p';
  const mu = (du - 0.3) % 1.6;
  if (mu < 0.07) return C.K; // 窗框
  if (v > 0.85 && v < 1.0) return C.K; // 櫃台
  const pane = Math.floor((du - 0.3) / 1.6);
  const hs = hash(side * 5 + bi * 3, pane);
  if (hs < 0.65) {
    // 店裡的人影
    const dx = mu - (0.45 + hs * 1.0);
    if (Math.abs(dx) < 0.2 && v > 1.0 && v < 1.56) return C.K;
    if ((dx * dx) / 0.017 + ((v - 1.72) * (v - 1.72)) / 0.024 < 1) return C.K;
  }
  if (v > 2.12 && v < 2.32 && (mu * 4) % 1 < 0.55) return pink ? C.R : C.T; // 吊掛的菜單燈
  if (v < 0.85) return pink ? C.a : C.c;
  if (v < 1.9) return pink ? C.m : C.e;
  return pink ? C.b : C.d;
}

function bandPx(side: number, bi: number, b: Bld, du: number, v: number, z: number): number {
  if (b.shop === 'shut' || b.shop === 'dark') return v < 2.82 || v > 3.24 ? C.G : C.J;
  const pink = b.shop === 'p';
  if (v < 2.8 || v > 3.26) return pink ? C.b : C.d;
  if (z > 13) return (du * 3) % 1 < 0.5 ? (pink ? C.m : C.e) : C.K;
  const cw = 0.42;
  const ci = Math.floor((du - 0.4) / cw);
  const gx = Math.floor((((du - 0.4) % cw) / cw) * 6);
  const gy = Math.floor(((v - 2.84) / 0.4) * 5);
  if (ci >= 0 && gx < 5 && gy >= 0 && gy < 5 && ink(Math.floor(hash(side * 11 + bi, ci) * 64), gx, 4 - gy)) return pink ? C.m : C.e;
  return C.K;
}

function facade(side: number, bi: number, b: Bld, z: number, v: number, p: number): number {
  const body = C[b.body];
  const du = z - b.z0;
  const len = b.z1 - b.z0;
  if (v > b.h - 0.12) return C.U; // 屋簷
  if (v > b.h - 0.45) return C.G;
  if (du < 0.05) return C.K; // 兩棟之間的縫
  if (du < 0.17 && v > 2.75) return du < 0.1 ? C.U : C.G; // 落水管
  if (v < 2.55) return du < 0.3 || du > len - 0.3 ? body : shopPx(side, bi, b, du, v);
  if (v < 2.75) return C.K; // 雨遮
  if (v < 3.3) return bandPx(side, bi, b, du, v, z);
  const lit = b.shop === 'p' ? TP : b.shop === 'c' ? TC : null;
  if (lit && v < 3.75 && (1 - (v - 3.3) / 0.45) * 9 > bay(p % W, Math.floor(p / W))) return tone(lit, body); // 店招打在牆上的光
  // 牆面直式霓虹
  if (b.strip && du > 0.5 && du < 1.1 && v > 3.6 && v < Math.min(b.h - 1, 10.5)) {
    const pink = b.strip === 'p';
    if (du < 0.57 || du > 1.03 || v < 3.68 || v > Math.min(b.h - 1, 10.5) - 0.08) return pink ? C.m : C.e;
    const gx = Math.floor(((du - 0.6) / 0.4) * 5);
    const cell = (v - 3.8) / 0.55;
    const gy = Math.floor((cell % 1) * 6);
    if (gx >= 0 && gx < 5 && gy < 5 && ink(bi * 7 + Math.floor(cell) + side * 13, gx, 4 - gy)) return pink ? C.P : C.Q;
    return C.K;
  }
  const fv = (v - 3.3) % 3;
  const fl = Math.floor((v - 3.3) / 3);
  if (fv < 0.12) return C.G; // 樓板線
  const unit = 1.8;
  const ui = Math.floor((du - 0.3) / unit);
  const uu = du - 0.3 - ui * unit;
  if (ui < 0 || (ui + 1) * unit + 0.3 > len) return body;
  if (uu > 0.4 && uu < 1.4 && fv > 0.6 && fv < 2.2) {
    if (uu < 0.47 || uu > 1.33 || fv < 0.68 || fv > 2.12) return C.G;
    const h = hash(side * 97 + bi * 13 + fl * 7, ui);
    if (h < 0.36) {
      const col = [C.V, C.d, C.b][Math.floor(h * 100) % 3];
      lampPx(((side + 1) * 10 + bi) * 10000 + fl * 100 + ui, p, uu < 0.7 ? tone(DN, col) : col);
      return C.I;
    }
    return C.K;
  }
  // 冷氣機
  if (hash(side * 31 + bi, fl * 17 + ui) < 0.4 && uu > 0.5 && uu < 1.2 && fv > 0.18 && fv < 0.52) return Math.floor(uu / 0.07) % 2 ? C.J : C.G;
  return body;
}

const WALL = layer(W, H);
const CL = new Float32Array(W); // 每欄的倒影鏡線（牆腳；巷底那幾欄是競技場的地基）
const GTOP = new Int16Array(W); // 每欄地面從哪一列開始
{
  const slot = (F * XW) / ZEND;
  for (let x = 0; x < W; x++) {
    const cx = x + 0.5 - VX;
    if (Math.abs(cx) <= slot) {
      CL[x] = VY + (F * EYE) / ZARENA;
      GTOP[x] = Math.ceil(CL[x] - 0.5);
      continue;
    }
    const side = Math.sign(cx);
    const z = (F * XW) / Math.abs(cx);
    const [b, bi] = bldAt(side, z);
    CL[x] = py(0, z);
    GTOP[x] = Math.min(H, Math.ceil(CL[x] - 0.5));
    for (let y = Math.max(0, Math.ceil(py(b.h, z) - 0.5)); y < GTOP[x]; y++) {
      const v = EYE + ((VY - (y + 0.5)) * z) / F;
      WALL.px[y * W + x] = facade(side, bi, b, z, v, y * W + x);
    }
  }
}
// 遠處的小招牌（垂直於牆、正對鏡頭），一格一個字畫素
interface Decor {
  side: number;
  z: number;
  k: 'p' | 'c';
  fl?: boolean;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
}
const DECOR: Decor[] = [
  { side: -1, z: 14.5, k: 'c' },
  { side: -1, z: 17.8, k: 'p', fl: true },
  { side: -1, z: 21.5, k: 'c' },
  { side: -1, z: 26.5, k: 'p' },
  { side: 1, z: 13.8, k: 'p' },
  { side: 1, z: 17.2, k: 'c' },
  { side: 1, z: 20.8, k: 'p' },
  { side: 1, z: 25.8, k: 'c', fl: true },
];
DECOR.forEach((d, i) => {
  let x0 = Math.round(px(d.side * 6.2, d.z));
  let x1 = Math.round(px(d.side * 5.0, d.z));
  if (x0 > x1) [x0, x1] = [x1, x0];
  const y0 = Math.round(py(4.9, d.z));
  const y1 = Math.round(py(2.9, d.z));
  Object.assign(d, { x0, x1, y0, y1 });
  const pink = d.k === 'p';
  haloL(WALL, pink ? TP : TC, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 6, (y1 - y0) / 2 + 5, 0.75);
  const xw = Math.round(px(d.side * XW, d.z));
  line(WALL, d.side < 0 ? xw : x1, y0 + 2, d.side < 0 ? x0 : xw, y0 + 2, C.G);
  line(WALL, d.side < 0 ? xw : x1, y1 - 2, d.side < 0 ? x0 : xw, y1 - 2, C.G);
  rect(WALL, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pink ? C.b : C.d);
  rect(WALL, x0 + 1, y0 + 1, x1 - x0 - 1, y1 - y0 - 1, C.K);
  const iw = x1 - x0 - 1;
  if (iw < 5) return;
  for (let k = 0; k < Math.floor((y1 - y0 - 2) / 6); k++) {
    const gi = Math.floor(hash(i, k) * 64);
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) if (ink(gi, gx, gy)) pset(WALL, x0 + 1 + Math.floor((iw - 5) / 2) + gx, y0 + 2 + k * 6 + gy, pink ? C.m : C.e);
  }
});
// 橫過巷子的電線；最近那條掛著燈籠
interface Cable {
  a: [number, number];
  b: [number, number];
  sag: number;
}
const cable = (za: number, ya: number, zb: number, yb: number, sag: number): Cable => ({ a: [px(-XW, za), py(ya, za)], b: [px(XW, zb), py(yb, zb)], sag });
const cableAt = (cb: Cable, u: number): [number, number] => [cb.a[0] + (cb.b[0] - cb.a[0]) * u, cb.a[1] + (cb.b[1] - cb.a[1]) * u + cb.sag * 4 * u * (1 - u)];
const LANTERN_CABLE = cable(7, 6.4, 7, 6.4, 9);
for (const cb of [LANTERN_CABLE, cable(6, 5.6, 10, 7, 6), cable(11, 8, 8.2, 6.8, 5)]) {
  for (let i = 0; i <= 400; i++) {
    const [x, y] = cableAt(cb, i / 400);
    pset(WALL, x, y, C.K);
  }
}

// ── 地面：人行道、路緣、柏油路、巷底廣場；記下每格多濕（0 乾、1 濕、2 水窪） ──
const GB = new Uint32Array(W * H);
const GW = new Uint8Array(W * H);
for (let x = 0; x < W; x++) {
  for (let y = GTOP[x]; y < H; y++) {
    const z = (F * EYE) / (y + 0.5 - VY);
    const gx = ((x + 0.5 - VX) * z) / F;
    const ax = Math.abs(gx);
    const pud = noise(gx * 0.9 + 3, z * 0.35) > 0.64;
    let c: number;
    let wet: number;
    if (z > ZEND) {
      c = ax % 3 < 0.1 || z % 4 < 0.2 ? C.I : C.J;
      wet = 2;
    } else if (ax >= 3.6) {
      c = ax % 0.75 < 0.05 || z % 0.75 < 0.06 ? C.I : C.J;
      wet = pud ? 2 : 1;
      const [b] = bldAt(Math.sign(gx), z);
      const dist = XW - ax;
      if ((b.shop === 'p' || b.shop === 'c') && dist < 1.8 && bay(x, y) < 16 * 0.45 * (1 - dist / 1.8)) c = tone(b.shop === 'p' ? TP : TC, c);
    } else if (ax >= 3.42) {
      c = ax > 3.52 ? C.G : C.U;
      wet = 0;
    } else {
      c = hash(x, y) < 0.06 ? C.J : C.I;
      if (ax < 0.07 && z % 4 < 2) c = C.V; // 中線
      if (z > 11 && z < 13.5 && ax < 3.2 && (gx + 3.2) % 0.8 < 0.45) c = C.G; // 斑馬線
      wet = pud ? 2 : 1;
    }
    GB[y * W + x] = c;
    GW[y * W + x] = wet;
  }
}

// ── 選單招牌（垂直於牆、正對鏡頭；字是 DOM，招牌框畫在畫布上才有倒影） ──
interface Sign {
  side: number;
  z: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  d: number;
  on: boolean;
}
const SIGN_AT: [number, number][] = [[-1, 5], [-1, 7.5], [-1, 11], [1, 5], [1, 7.5], [1, 11]];
const signEls = [...document.querySelectorAll<HTMLElement>('.sign')];
let hot = -1;
const signs: Sign[] = SIGN_AT.map(([side, z], i) => {
  let x0 = Math.round(px(side * 6.3, z));
  let x1 = Math.round(px(side * 4.9, z));
  if (x0 > x1) [x0, x1] = [x1, x0];
  const s: Sign = { side, z, x0, x1, y0: Math.round(py(4.8, z)), y1: Math.round(py(2.3, z)), d: 0.5 + i * 0.13, on: false };
  const el = signEls[i];
  if (el) {
    s.on = el.classList.contains('on');
    Object.assign(el.style, { left: `${x0 * 4}px`, top: `${s.y0 * 4}px`, width: `${(x1 - x0 + 1) * 4}px`, height: `${(s.y1 - s.y0 + 1) * 4}px` });
    el.style.setProperty('--d', `${s.d}s`);
    el.addEventListener('mouseenter', () => (hot = i));
    el.addEventListener('mouseleave', () => (hot = -1));
  }
  return s;
});
/** 霓虹管通電時的閃爍（跟 CSS 的 neon 動畫同一組時間點） */
function neonOn(t: number, d: number): boolean {
  const k = (t - d) / 1.2;
  return k >= 0.45 || (k >= 0.1 && k < 0.15) || (k >= 0.3 && k < 0.34);
}

// ── 人物：我方三人背對鏡頭站在路中間（20×40，左半邊畫好再鏡射），輪廓加上競技場打來的青色逆光 ──
const HALVES = [
  // 先鋒：刺蝟頭、飛行夾克、袖子青色條紋
  ['......K..K', '.....KHKKH', '.....KHHHH', '....KHHHHH', '....KHHHHH', '....KHHHHH', '.....KHHHH', '.....KHHHH', '......KKSS', '....KKKJJJ',
    '..KKJJJJJJ', '.KJJJJJJJJ', '.KGJJJJJJJ', '.KqJJJJJJJ', '.KqJKJJJJJ', '.KJJKJJJJJ', '.KqJKJJJJJ', '.KqJKJJjJJ', '.KJJKJJjJJ', '.KJJKJJjJJ',
    '.KJJKJJjJJ', '.KSSKJJjJJ', '.KSSKJJJJJ', '..KK.Kqqqq', '.....KPPPP', '.....KPPPP', '.....KPPPK', '.....KPpPK', '.....KPpPK', '.....KPpPK',
    '.....KPpPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '....KBBBBK', '....KBBBBK', '....KbbbbK', '....KKKKKK'],
  // 中堅：連帽長大衣、手插口袋，背上是隊徽
  ['..........', '......KKKK', '.....KJJJJ', '....KJJJJJ', '....KJJJJJ', '....KJGJJJ', '....KJGJJJ', '....KJJJJJ', '.....KJJJJ', '...KKJJJJJ',
    '..KJJJJJJJ', '.KJJJJJJJJ', '.KJJJJJJJJ', '.KJJKJJJJJ', '.KJJKJJJJq', '.KGJKJJJqJ', '.KJJKJjJJJ', '..KJJKjJJJ', '..KJJKjJJJ', '...KKJjJJJ',
    '...KJJjJJJ', '...KJJjJJJ', '...KqJjJJJ', '...KqJjJJJ', '...KqJjJJK', '...KJJjJJK', '...KJJJJJK', '...KKKKKKK', '.....KPPPK', '.....KPPPK',
    '.....KPpPK', '.....KPpPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '....KBBBBK', '....KBBBBK', '....KbbbbK', '....KKKKKK'],
  // 大將：馬尾、耳機、短夾克
  ['..........', '......KKKK', '.....KHHHH', '....KHHHHH', '....KqHHHH', '....KqHHHH', '....KHHHHH', '.....KHHHH', '......KHHH', '...KKKJKHH',
    '..KJJJJKHH', '.KJJJJJKHH', '.KJJJJJKHH', '.KqJKJJKHH', '.KqJKJJJKH', '.KJJKJJJKH', '.KJJKJJJJK', '.KJJKGJJJJ', '.KJJKKKKKK', '.KSSKjjjjj',
    '.KSSKjjjjj', '..KK.KqqKq', '.....KPPPP', '.....KPPPP', '.....KPPPK', '.....KPpPK', '.....KPpPK', '.....KPpPK', '.....KPpPK', '.....KPPPK',
    '.....KPPPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '.....KPPPK', '....KBBBBK', '....KBBBBK', '....KbbbbK', '....KKKKKK'],
];
const SPR_MAP: Record<string, Key> = { K: 'K', H: 'I', J: 'J', j: 'I', G: 'G', q: 'Q', S: 'b', P: 'I', p: 'J', B: 'K', b: 'U' };
const crew = HALVES.map((half) => {
  const L = layer(20, 40);
  half.forEach((row, y) => {
    const full = row + [...row].reverse().join('');
    for (let x = 0; x < 20; x++) if (full[x] !== '.') L.px[y * 20 + x] = C[SPR_MAP[full[x]]];
  });
  const solid = (x: number, y: number): boolean => x >= 0 && x < 20 && y >= 0 && L.px[y * 20 + x] !== 0;
  const rim = L.px.slice();
  for (let y = 0; y < 36; y++) {
    for (let x = 0; x < 20; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1)) rim[y * 20 + x] = y < 10 ? C.e : y < 24 ? C.d : C.c;
    }
  }
  L.px.set(rim);
  return L;
});
const CREW_FOOT = Math.round(py(0, 6.5));
const CREW_X = [-1.15, 0, 1.15].map((x) => Math.round(px(x, 6.5) - 10));

// ── 機車：停在左側人行道，側面朝鏡頭，輪框是一圈青色霓虹 ──
const BIKE = layer(60, 26);
const BIKE_AT = { x: Math.round(px(-5.6, 6)), y: Math.round(py(0, 6)) - 25 };
{
  // 車身：上緣被路燈與霓虹打亮，下半暗
  poly(BIKE, [[2, 12], [8, 7], [21, 7], [31, 4], [43, 5], [53, 9], [58, 13], [51, 16], [39, 17], [22, 17], [11, 15]], C.G);
  for (let x = 0; x < 60; x++) {
    let first = true;
    for (let y = 0; y < 26; y++) {
      const p = y * 60 + x;
      if (BIKE.px[p] !== C.G) continue;
      if (first) BIKE.px[p] = C.S;
      else if (y > 13) BIKE.px[p] = C.J;
      else if (y === 13 || (y === 12 && x > 6 && x < 52)) BIKE.px[p] = y === 12 ? C.Q : C.d;
      first = false;
    }
  }
  rect(BIKE, 14, 5, 12, 2, C.K); // 座墊
  line(BIKE, 15, 5, 24, 5, C.U);
  poly(BIKE, [[40, 6], [45, 1], [49, 1], [46, 6]], C.d); // 風鏡
  line(BIKE, 45, 1, 48, 1, C.T);
  rect(BIKE, 55, 10, 3, 2, C.T); // 頭燈
  pset(BIKE, 58, 11, C.W);
  rect(BIKE, 1, 11, 2, 2, C.P); // 尾燈
  line(BIKE, 6, 17, 16, 17, C.U); // 排氣管
  for (const [wx, wy] of [[10, 17], [48, 17]]) {
    for (let y = -9; y <= 9; y++) {
      for (let x = -9; x <= 9; x++) {
        const d = Math.hypot(x, y);
        if (d > 8.5) continue;
        pset(BIKE, wx + x, wy + y, d > 7.6 ? C.K : d > 6.4 ? C.Q : d > 5.4 ? C.d : d > 2 ? (Math.abs(x) === Math.abs(y) || x === 0 || y === 0 ? C.G : C.I) : C.U);
      }
    }
  }
}
const BIKE_FOOT = BIKE_AT.y + 25;

// 拉麵店雨遮下的排氣口（蒸氣從這裡冒出來）
const VENT = { x: px(XW, 8.2) - 3, y: py(2.6, 8.2) };

// ── 每格合成 ──
const cv = document.getElementById('bg') as HTMLCanvasElement;
const g = cv.getContext('2d') as CanvasRenderingContext2D;
const img = g.createImageData(W, H);
const fb = new Uint32Array(img.data.buffer);
function fset(x: number, y: number, c: number): void {
  x = Math.round(x);
  y = Math.round(y);
  if (x >= 0 && y >= 0 && x < W && y < H) fb[y * W + x] = c;
}
function ftone(m: Map<number, number>, x: number, y: number): void {
  x = Math.round(x);
  y = Math.round(y);
  if (x >= 0 && y >= 0 && x < W && y < H) fb[y * W + x] = tone(m, fb[y * W + x]);
}
/** 以換色表抖色出一圈光，s 是中心強度 0～1 */
function halo(m: Map<number, number>, cx: number, cy: number, rx: number, ry: number, s: number, y1 = H): void {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(y1 - 1, cy + ry); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, cx + rx); x++) {
      const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      if (d < 1 && s * (1 - d) * 16 > bay(x, y)) fb[y * W + x] = tone(m, fb[y * W + x]);
    }
  }
}
function blit(L: Layer, dx: number, dy: number): void {
  for (let y = 0; y < L.h; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= H) continue;
    for (let x = Math.max(0, -dx); x < L.w && x + dx < W; x++) {
      const c = L.px[y * L.w + x];
      if (c) fb[ty * W + x + dx] = c;
    }
  }
}

function drawRing(t: number, of: number): void {
  const cx = RING.x + of;
  const cy = RING.y;
  for (let y = cy - 53; y <= cy + 53; y++) {
    if (y < 0 || y >= 125) continue;
    for (let x = cx - 53; x <= cx + 53; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const p = y * W + x;
      if (d > 41 && d <= 44) fb[p] = d > 42 && d <= 43 ? C.Q : C.e;
      else if (d > 36.3 && d <= 37.5) {
        if (((Math.floor(((ang + t * 0.25) * 18) / Math.PI) % 3) + 3) % 3 !== 0) fb[p] = C.d;
      } else if (d > 47 && d <= 48.2) {
        if (((Math.floor(((ang - t * 0.15) * 40) / Math.PI) % 4) + 4) % 4 === 0) fb[p] = C.d;
      } else if (d > 44 && d < 53) {
        if ((1 - (d - 44) / 9) * 0.6 * 16 > bay(x, y)) fb[p] = tone(TC, fb[p]);
      } else if (d > 31 && d <= 41 && (1 - (41 - d) / 10) * 0.4 * 16 > bay(x, y)) fb[p] = tone(TC, fb[p]);
    }
  }
  for (let k = 0; k < 3; k++) {
    const a = t * 0.4 + k * 2.094;
    const nx = Math.round(cx + Math.cos(a) * 42.5 - 0.5);
    const ny = Math.round(cy + Math.sin(a) * 42.5 - 0.5);
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) fset(nx + ox, ny + oy, C.W);
  }
}

function drawBeams(t: number, of: number): void {
  for (const [bx, ph, m] of [[226, 0, TC], [254, 2.4, TP]] as const) {
    const a = Math.sin(t * 0.5 + ph) * 0.45 + (bx < 240 ? -0.22 : 0.22);
    for (let dist = 0; dist < 100; dist++) {
      const y = 101 - dist;
      const xc = bx + of + Math.tan(a) * dist;
      const hw = 0.8 + dist * 0.08;
      const s = 0.55 * (1 - dist / 100);
      for (let x = Math.floor(xc - hw); x <= xc + hw; x++) if (s * 16 > bay(x, y)) ftone(m, x, y);
    }
  }
}

function drawCars(t: number, of: number): void {
  for (const [y, v, x0, dir] of [[16, 22, 0, 1], [29, 15, 90, -1]] as const) {
    const u = ((t * v + x0) % 300) / 300;
    const x = Math.round(dir > 0 ? 150 + u * 180 : 330 - u * 180) + of;
    for (let k = 1; k < 10; k++) if ((10 - k) * 1.2 > bay(x - dir * (k + 3), y)) ftone(UP, x - dir * (k + 3), y);
    for (let k = -2; k <= 3; k++) fset(x + dir * k, y, C.K);
    for (let k = -1; k <= 2; k++) fset(x + dir * k, y - 1, C.G);
    fset(x + dir * 3, y, C.T);
    fset(x - dir * 2, y, C.P);
  }
}

function drawSign(s: Sign, i: number, t: number): void {
  const lit = neonOn(t, s.d);
  const cy = s.on || hot === i;
  const xw = Math.round(px(s.side * XW, s.z));
  if (lit) halo(cy ? TC : TP, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, (s.x1 - s.x0) / 2 + 9, (s.y1 - s.y0) / 2 + 9, 0.75);
  for (const by of [s.y0 + 3, s.y1 - 3]) {
    for (let x = Math.min(xw, s.x0); x <= Math.max(xw, s.x1); x++) fset(x, by, C.G);
  }
  for (let y = s.y0; y <= s.y1; y++) {
    for (let x = s.x0; x <= s.x1; x++) {
      const edge = Math.min(x - s.x0, s.x1 - x, y - s.y0, s.y1 - y);
      fset(x, y, edge === 0 ? (lit ? (cy ? C.Q : C.P) : cy ? C.d : C.b) : edge === 1 ? (lit ? (cy ? C.d : C.b) : C.I) : C.K);
    }
  }
}

const LANTERN = ['..KKK..', '.bPPPb.', 'bPPRPPb', 'PPRRRPP', 'PPRRRPP', 'PPRRRPP', 'bPPRPPb', '.bPPPb.', '..KKK..', '...K...'];
function drawLanterns(t: number): void {
  for (let k = 1; k <= 5; k++) {
    const [cx, cy] = cableAt(LANTERN_CABLE, k / 6);
    const sw = Math.round(Math.sin(t * 1.3 + k * 1.7) * 0.7);
    const x0 = Math.round(cx) - 3 + sw;
    const y0 = Math.round(cy) + 2;
    const on = t > 0.2 + k * 0.1;
    fset(Math.round(cx), Math.round(cy) + 1, C.K);
    if (on) halo(TP, x0 + 3.5, y0 + 4.5, 11, 10, 0.65);
    LANTERN.forEach((row, j) => {
      for (let i = 0; i < 7; i++) {
        const ch = row[i];
        if (ch === '.') continue;
        const c = C[ch as Key];
        fset(x0 + i, y0 + j, on ? c : tone(DN, tone(DN, c)));
      }
    });
  }
}

function drawGround(t: number): void {
  const ph = Math.floor(t * 9);
  for (let x = 0; x < W; x++) {
    const cl = CL[x];
    for (let y = GTOP[x]; y < H; y++) {
      const p = y * W + x;
      const base = GB[p];
      const wet = GW[p];
      let c = base;
      if (wet) {
        const wob = (y * 7 + ph) % 9 === 0 ? 1 : (y * 5 + ph) % 11 === 0 ? -1 : 0;
        const sy = Math.floor(2 * cl - y - 0.5);
        if (sy >= 0) {
          const src = fb[sy * W + Math.min(W - 1, Math.max(0, x + wob))];
          // 水窪整片映出來；濕柏油只映亮的霓虹，而且抖掉一半
          if (wet === 2) {
            const r = tone(DN, src);
            if ((LUM.get(r) as number) > (LUM.get(base) as number)) c = r;
          } else if ((LUM.get(src) as number) > 90 && bay(x, y) < 8) c = tone(DN, tone(DN, src));
        }
      }
      fb[p] = c;
    }
  }
}

function drawSpr(S: Layer, x0: number, y0: number): void {
  for (let j = 0; j < S.h; j++) {
    for (let i = 0; i < S.w; i++) {
      const c = S.px[j * S.w + i];
      if (c) fset(x0 + i, y0 + j, c);
    }
  }
}
/** 人與車在濕地上的倒影：以腳底為鏡線上下翻轉、暗一階 */
function reflectSpr(S: Layer, x0: number, y0: number, t: number): void {
  const foot = y0 + S.h - 1;
  for (let j = 0; j < S.h; j++) {
    const ry = 2 * foot - (y0 + j) + 1;
    if (ry < 0 || ry >= H) continue;
    const wob = (ry + Math.floor(t * 8)) % 6 < 3 ? 0 : 1;
    for (let i = 0; i < S.w; i++) {
      const c = S.px[j * S.w + i];
      const x = x0 + i + wob;
      if (!c || x < 0 || x >= W || ry < GTOP[x]) continue;
      const p = ry * W + x;
      const wet = GW[p];
      if (!wet || (wet === 1 && bay(x, ry) >= 9)) continue;
      fb[p] = wet === 2 ? tone(DN, c) : tone(DN, tone(DN, c));
    }
  }
}

function reflectRect(x0: number, y0: number, x1: number, y1: number, foot: number, t: number): void {
  for (let y = y0; y <= y1; y++) {
    const ry = Math.floor(2 * foot - y - 0.5);
    if (ry < 0 || ry >= H) continue;
    const wob = (ry + Math.floor(t * 8)) % 6 < 3 ? 0 : 1;
    for (let x = x0; x <= x1; x++) {
      const tx = x + wob;
      if (tx < 0 || tx >= W || ry < GTOP[tx]) continue;
      const p = ry * W + tx;
      const wet = GW[p];
      if (!wet || (wet === 1 && bay(tx, ry) >= 9)) continue;
      const c = fb[y * W + x];
      const r = wet === 2 ? tone(DN, c) : tone(DN, tone(DN, c));
      if ((LUM.get(r) as number) > (LUM.get(fb[p]) as number)) fb[p] = r;
    }
  }
}

const drops = Array.from({ length: 260 }, (_, i) => ({ x: hash(i, 1) * 540 - 40, y: hash(i, 2) * 300, v: 190 + hash(i, 3) * 140, len: 3 + Math.floor(hash(i, 4) * 4), near: hash(i, 5) < 0.18 }));
const splashes = Array.from({ length: 46 }, (_, i) => {
  const x = Math.floor(hash(i, 21) * W);
  return { x, y: GTOP[x] + 3 + Math.floor(hash(i, 22) * Math.max(1, H - GTOP[x] - 4)), per: 0.5 + hash(i, 23) * 0.8, ph: hash(i, 24) };
});
const ripples: { x: number; y: number; per: number; ph: number }[] = [];
for (let i = 0; ripples.length < 16 && i < 4000; i++) {
  const x = Math.floor(hash(i, 31) * W);
  const y = Math.floor(140 + hash(i, 32) * 120);
  if (y >= GTOP[x] && GW[y * W + x] === 2) ripples.push({ x, y, per: 0.9 + hash(i, 33) * 0.9, ph: hash(i, 34) });
}

function drawWeather(t: number, mx: number): void {
  // 雨後地面：水窪的漣漪、雨點濺起
  for (const r of ripples) {
    const k = ((t / r.per + r.ph) % 1) * 1.4;
    if (k > 1) continue;
    const rx = 1 + k * 6;
    const ry = rx * 0.32;
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2;
      ftone(UP, r.x + Math.cos(th) * rx, r.y + Math.sin(th) * ry);
    }
  }
  for (const s of splashes) {
    if ((t / s.per + s.ph) % 1 > 0.14) continue;
    ftone(UP, s.x, s.y);
    ftone(UP, s.x, s.y);
    ftone(UP, s.x - 1, s.y - 1);
    ftone(UP, s.x + 1, s.y - 1);
  }
  // 蒸氣：從拉麵店雨遮下冒出，往巷子中間飄
  for (let k = 0; k < 16; k++) {
    const age = (t * 0.3 + k / 16) % 1;
    const cx = VENT.x - age * 16 + Math.sin(age * 6 + k) * 2;
    const cy = VENT.y - age * 38;
    const r = 2 + age * 6;
    halo(UP, cx, cy, r, r * 0.8, 0.85 * (1 - age));
  }
  // 雨絲：把底下的顏色亮一階，近的長、亮兩階
  const sh = Math.round(mx * 4);
  for (const d of drops) {
    const y = ((d.y + t * d.v) % 300) - 20;
    const x0 = d.x + y * 0.14 + (d.near ? sh * 2 : sh);
    const n = d.near ? d.len + 3 : d.len;
    for (let k = 0; k < n; k++) {
      ftone(UP, x0 + k * 0.14, y + k);
      if (d.near) ftone(UP, x0 + k * 0.14, y + k);
    }
  }
}

const holo = document.querySelector<HTMLElement>('.holo');
let lastOf = 99;
function frame(t: number, mx: number): void {
  const of = Math.round(mx * 3);
  // 1. 遠景：天空、高樓、競技場、光環、探照燈、飛車
  blit(FAR, of - FX, 0);
  if (Math.floor(t * 7) % 23 === 0) for (const p of holoAd) fb[Math.floor(p / FAR.w) * W + (p % FAR.w) - FX + of] = tone(DN, FAR.px[p]);
  // 右樓的跑馬燈
  for (let x = 284; x < 302; x++) {
    const s = x + Math.floor(t * 8);
    const gx = s % 6;
    const on = gx < 5 && (ink(Math.floor(s / 6) % 64, gx, 1) || ink(Math.floor(s / 6) % 64, gx, 3));
    fset(x + of, 25, on ? C.Q : C.c);
    fset(x + of, 24, C.K);
    fset(x + of, 26, C.K);
  }
  if (Math.floor(t * 1.5) % 2) fset(300 + of, 3, C.P);
  for (let x = 197; x < 284; x += 2) fset(x + of, 102, (x + Math.floor(t * 12)) % 8 < 2 ? C.R : C.P);
  drawRing(t, of);
  drawBeams(t, of);
  drawCars(t, of);
  // 2. 街屋、窗燈、小招牌閃爍、選單招牌、燈籠
  blit(WALL, 0, 0);
  for (const L of lamps.values()) {
    if (t < L.on || (L.fl && Math.sin(t * 11 + L.on * 7) > 0.55)) continue;
    for (let i = 0; i < L.px.length; i++) fb[L.px[i]] = L.c[i];
  }
  for (const d of DECOR) {
    if (!d.fl || Math.sin(t * 2.3 + d.z) > -0.75 || Math.floor(t * 14) % 2) continue;
    for (let y = d.y0 as number; y <= (d.y1 as number); y++) for (let x = d.x0 as number; x <= (d.x1 as number); x++) ftone(DN, x, y);
  }
  drawLanterns(t);
  // 3. 濕路面倒影；選單招牌在這之後畫，倒影用招牌自己的深度當鏡線（不然會被斜的牆腳線拉歪）
  drawGround(t);
  signs.forEach((s, i) => {
    drawSign(s, i, t);
    reflectRect(s.x0, s.y0, s.x1, s.y1, py(0, s.z), t);
  });
  // 4. 機車與人（先畫倒影）
  halo(TC, BIKE_AT.x + 30, BIKE_FOOT + 1, 30, 4, 0.55 + Math.sin(t * 2) * 0.15);
  reflectSpr(BIKE, BIKE_AT.x, BIKE_AT.y, t);
  drawSpr(BIKE, BIKE_AT.x, BIKE_AT.y);
  crew.forEach((S, i) => {
    const y0 = CREW_FOOT - 39;
    reflectSpr(S, CREW_X[i], y0, t);
    const bob = Math.floor(t * 1.4 + i * 0.45) % 2;
    for (let j = 0; j < 40; j++) {
      for (let k = 0; k < 20; k++) {
        const c = S.px[j * 20 + k];
        if (c) fset(CREW_X[i] + k, y0 + j + (j < 24 ? bob : 0), c);
      }
    }
  });
  drawWeather(t, mx);
  g.putImageData(img, 0, 0);
  if (holo && of !== lastOf) {
    holo.style.translate = `${of * 4}px 0`;
    lastOf = of;
  }
}
onFrame((t, mx) => frame(still ? 9 : t, mx));

// 8×8 像素圖示：. 透明、其他字元對應色票
const ICONS: Record<string, string[]> = {
  coin: ['..QQQQ..', '.QQTTQQ.', 'QQTQQQQQ', 'QQTQQQQQ', 'QQQTTQQQ', 'QQQQQTQQ', '.QQTTQQ.', '..QQQQ..'],
  star: ['...QQ...', '...QQ...', 'QQQTTQQQ', '.QQTTQQ.', '..QQQQ..', '.QQ..QQ.', '.Q....Q.', '........'],
  glass: ['QQQQQQQQ', '.Q....Q.', '..QTTQ..', '...TT...', '...QQ...', '..Q..Q..', '.QTTTTQ.', 'QQQQQQQQ'],
  mail: ['........', 'RRRRRRRR', 'RR....RR', 'R.R..R.R', 'R..RR..R', 'R......R', 'RRRRRRRR', '........'],
  cloud: ['....PPP.....', '..PPRRRPP...', '.PRR...RPP..', 'PR..PP..RPPP', 'P..P..P..RRP', '.PPPPPPPPPP.'],
};
document.querySelectorAll<HTMLElement>('[data-px-icon]').forEach((el) => {
  const rows = ICONS[el.dataset.pxIcon as string];
  const k = Number(el.dataset.k ?? 4);
  const w = rows[0].length;
  const rects = rows.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${HEX[ch as Key]}"/>`)));
  el.innerHTML = `<svg width="${w * k}" height="${rows.length * k}" viewBox="0 0 ${w} ${rows.length}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
});
