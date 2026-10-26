// 設計稿 B：黃昏商店街（橫向捲軸街機的街景）。480×270 像素畫布放大 4 倍：
// 天空、雲、遠景競技場、街屋、地面、人物、前景路燈各一層，滑鼠視差時以整數像素錯開，每格疊進同一張 ImageData。
// 顏色全部取自暮色限色盤；光暈、探照燈、燈下光圈用「亮一階」對照表加抖色，不用半透明。
import { initStage, onFrame, still } from './stage.ts';

initStage();

const W = 480;
const H = 270;
const GY = 178; // 街屋牆腳＝人行道後緣

const HEX = {
  K: '#0f1020', I: '#1b1d33', J: '#2a2b4a', G: '#3b3552', U: '#5a5070', V: '#7a6a9a', S: '#8a8aa0', T: '#b9b4c0',
  C: '#e8dcc4', W: '#fff6e0', R: '#e8735a', D: '#b5503f', A: '#f2a65a', M: '#7cc4a8', N: '#3f7f78', P: '#c9a1b4', E: '#d9a487',
} as const;
type Key = keyof typeof HEX;
const pack = (h: string): number => (0xff000000 | (parseInt(h.slice(5, 7), 16) << 16) | (parseInt(h.slice(3, 5), 16) << 8) | parseInt(h.slice(1, 3), 16)) >>> 0;
const C = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, pack(v)])) as Record<Key, number>;
const UP = new Map<number, number>(
  ([['K', 'I'], ['I', 'J'], ['J', 'G'], ['G', 'U'], ['U', 'V'], ['V', 'P'], ['P', 'C'], ['S', 'T'], ['T', 'C'], ['A', 'C'], ['C', 'W'], ['N', 'M'], ['M', 'C'], ['D', 'R'], ['R', 'A'], ['E', 'C']] as [Key, Key][]).map(([a, b]) => [C[a], C[b]]),
);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bay = (x: number, y: number): number => BAYER[(y & 3) * 4 + (x & 3)];

let seed = 5;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

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
/** 由上往下在兩色之間抖色（t0→t1） */
function grad(L: Layer, x: number, y: number, w: number, h: number, a: number, b: number, t0: number, t1: number): void {
  for (let yy = 0; yy < h; yy++) {
    const t = t0 + ((t1 - t0) * yy) / Math.max(1, h - 1);
    for (let xx = 0; xx < w; xx++) pset(L, x + xx, y + yy, t * 16 > bay(x + xx, y + yy) ? b : a);
  }
}
function disc(L: Layer, cx: number, cy: number, r: number, c: number): void {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r * 0.8) pset(L, cx + dx, cy + dy, c);
}
function line(L: Layer, x0: number, y0: number, x1: number, y1: number, c: number): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) pset(L, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
}
/** 下垂的繩子：回傳每一點，給掛燈泡用 */
function rope(L: Layer, x0: number, y0: number, x1: number, y1: number, sag: number, c: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let x = x0; x <= x1; x++) {
    const u = (x - x0) / (x1 - x0);
    const y = Math.round(y0 + (y1 - y0) * u + sag * 4 * u * (1 - u));
    pset(L, x, y, c);
    pts.push([x, y]);
  }
  return pts;
}

// ── 天空（靜態）：靛藍 → 灰紫 → 淡紫 → 粉 → 杏 → 米白，夕陽落在競技場後方 ──
const SKY = layer(W, H);
{
  const bands: [number, Key][] = [[0, 'I'], [40, 'J'], [66, 'G'], [90, 'U'], [110, 'V'], [128, 'P'], [146, 'A'], [164, 'C'], [271, 'C']];
  for (let y = 0; y < H; y++) {
    const i = bands.findIndex((b, k) => y >= b[0] && y < bands[k + 1][0]);
    const t = Math.max(0, (y - (bands[i + 1][0] - 6)) / 6);
    for (let x = 0; x < W; x++) pset(SKY, x, y, t * 16 > bay(x, y) ? C[bands[i + 1][1]] : C[bands[i][1]]);
  }
  const sx = 240;
  const sy = 146;
  for (let dy = -30; dy <= 30; dy++) {
    for (let dx = -30; dx <= 30; dx++) {
      const d = Math.hypot(dx, dy);
      const p = (sy + dy) * W + sx + dx;
      if (d <= 14) SKY.px[p] = C.W;
      else if (d <= 19) SKY.px[p] = C.C;
      else if (d <= 22) SKY.px[p] = C.A;
      else if (d <= 26 && bay(sx + dx, sy + dy) < 5) SKY.px[p] = UP.get(SKY.px[p]) ?? SKY.px[p];
    }
  }
  for (const [y, half] of [[sy - 7, 34], [sy - 4, 26], [sy + 3, 40]]) rect(SKY, sx - half, y, half * 2, 1, C.P);
}
const stars = Array.from({ length: 46 }, (_, i) => ({ x: (i * 137 + 11) % W, y: 26 + ((i * 53) % 44), p: i % 9 }));

// ── 雲（橫向循環，慢慢飄）：頂暗、腹部被夕陽打亮 ──
const CLOUD = layer(960, 140);
function cloud(cx: number, cy: number, len: number, th: number): void {
  for (let i = 0; i < len / 7; i++) {
    const ex = cx - len / 2 + i * 7 + rnd() * 4;
    const rx = 8 + rnd() * 9;
    const ry = th * (0.55 + rnd() * 0.6);
    const ey = cy + rnd() * 3;
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) continue;
        const rel = (dy + ry) / (2 * ry);
        const x = Math.round(ex + dx);
        const y = Math.round(ey + dy);
        const k = cy > 80 ? (rel > 0.72 ? 'A' : rel > 0.42 ? 'P' : 'V') : rel > 0.7 ? 'P' : rel > 0.38 ? 'V' : 'U';
        pset(CLOUD, ((x % 960) + 960) % 960, y, C[k]);
      }
    }
  }
}
cloud(120, 40, 120, 6);
cloud(330, 62, 80, 5);
cloud(520, 34, 150, 7);
cloud(700, 88, 110, 5);
cloud(860, 54, 90, 6);
cloud(60, 100, 70, 4);

// ── 遠景：霧色天際線＋競技場圓頂（夕陽在它後面，邊緣一圈輪廓光） ──
const FAR = layer(520, H); // 畫面 x = 層 x − 20
const DOME = { x: 260, y: 172, rx: 50, ry: 22 };
{
  let x = 0;
  while (x < 520) {
    const w = 6 + Math.floor(rnd() * 14);
    const nearDome = Math.abs(x + w / 2 - DOME.x) < 70;
    const h = (nearDome ? 3 : 8) + Math.floor(rnd() * (nearDome ? 8 : 20));
    rect(FAR, x, 172 - h, w, h, C.U);
    for (let wy = 172 - h + 3; wy < 170; wy += 4) for (let wx = x + 2; wx < x + w - 1; wx += 3) if (rnd() < 0.12) pset(FAR, wx, wy, C.P);
    x += w;
  }
  const { x: dx0, y: dy0, rx, ry } = DOME;
  for (let y = dy0 - ry; y <= dy0; y++) {
    for (let x2 = dx0 - rx; x2 <= dx0 + rx; x2++) {
      const e = ((x2 - dx0) / rx) ** 2 + ((y - dy0) / ry) ** 2;
      if (e > 1) continue;
      const edge = 1 - e;
      pset(FAR, x2, y, edge < 0.05 ? C.A : edge < 0.1 ? (bay(x2, y) < 8 ? C.P : C.G) : C.G);
    }
  }
  for (const k of [0.4, 0.78]) {
    for (let y = dy0 - ry; y <= dy0; y++) {
      const half = rx * k * Math.sqrt(Math.max(0, 1 - ((y - dy0) / ry) ** 2));
      pset(FAR, dx0 - half, y, C.U);
      pset(FAR, dx0 + half, y, C.U);
    }
  }
  for (let y = dy0 - ry + 8; y <= dy0 - 8; y += 20) {
    const half = rx * Math.sqrt(Math.max(0, 1 - ((y - dy0) / ry) ** 2));
    line(FAR, dx0 - half + 2, y, dx0 + half - 2, y, C.U);
  }
  rect(FAR, dx0 - rx - 4, dy0 - 10, rx * 2 + 9, 11, C.J);
  rect(FAR, dx0 - rx - 4, dy0 - 10, rx * 2 + 9, 1, C.V);
  for (const fx of [dx0 - 20, dx0 + 20]) {
    line(FAR, fx, dy0 - ry - 2, fx, dy0 - ry - 12, C.I);
    rect(FAR, fx + 1, dy0 - ry - 12, 5, 3, C.C);
  }
}
const domeLights = Array.from({ length: 26 }, (_, i) => ({ x: DOME.x - DOME.rx + i * 4, p: i % 5 }));

// ── 街屋（中景）：六間店面＋兩側填空，畫面 x = 層 x − 40 ──
const MID = layer(560, H);
interface Light {
  x: number;
  y: number;
  w: number;
  h: number;
  c: number;
  on: number;
  fl: boolean;
}
const lights: Light[] = [];
function shell(x0: number, x1: number, top: number, body: Key, trim: Key, rim: Key): void {
  rect(MID, x0, top, x1 - x0, GY - top, C[body]);
  rect(MID, x0, top, x1 - x0, 3, C[trim]);
  rect(MID, x0, top + 3, x1 - x0, 1, C.I);
  rect(MID, x0, top, x1 - x0, 1, C[rim]);
  for (let y = top; y < GY; y++) pset(MID, x0, y, C.I);
  grad(MID, x0 + 1, GY - 40, x1 - x0 - 1, 40, C[body], C.I, 0, 0.35);
}
function windowsGrid(x0: number, x1: number, y0: number, y1: number, px: number, py: number, ww: number, wh: number, lit: number): void {
  for (let y = y0; y + wh <= y1; y += py) {
    for (let x = x0; x + ww <= x1; x += px) {
      rect(MID, x - 1, y - 1, ww + 2, wh + 2, C.I);
      rect(MID, x, y, ww, wh, C.J);
      pset(MID, x, y, C.G);
      if (rnd() < lit) lights.push({ x, y, w: ww, h: wh, c: rnd() < 0.7 ? C.A : C.C, on: 0.4 + rnd() * 2.4, fl: rnd() < 0.06 });
    }
  }
}
function shopfront(x0: number, x1: number, glass: Key, aw: [Key, Key] | null): void {
  const y0 = GY - 24;
  rect(MID, x0 + 2, y0 - 1, x1 - x0 - 4, 24, C.K);
  rect(MID, x0 + 3, y0, x1 - x0 - 6, 22, C[glass]);
  for (let x = x0 + 5; x < x1 - 5; x += 9) {
    rect(MID, x, y0 + 9, 4, 13, C.G);
    rect(MID, x + 1, y0 + 7, 2, 2, C.G);
  }
  line(MID, x0 + 6, y0 + 2, x0 + 12, y0 + 8, C.W);
  const dx = Math.round((x0 + x1) / 2) - 5;
  rect(MID, dx, y0 + 4, 10, 18, C.I);
  rect(MID, dx + 1, y0 + 5, 8, 17, C.G);
  pset(MID, dx + 7, y0 + 13, C.A);
  rect(MID, x0 + 1, GY - 1, x1 - x0 - 2, 1, C.T);
  if (aw) {
    for (let r = 0; r < 6; r++) {
      for (let x = x0 + 1 - Math.floor(r / 2); x < x1 - 1 + Math.floor(r / 2); x++) {
        pset(MID, x, y0 - 7 + r, ((x - x0) >> 2) % 2 === 0 ? C[aw[0]] : C[aw[1]]);
      }
    }
    rect(MID, x0 - 2, y0 - 1, x1 - x0 + 4, 1, C.I);
  }
}
// 左填空
shell(0, 48, 100, 'G', 'U', 'P');
windowsGrid(6, 44, 108, 146, 9, 11, 5, 6, 0.3);
shopfront(0, 48, 'A', null);
// 財務（銀行）：淺色石材、柱廊、山牆上的金幣徽
shell(48, 116, 86, 'U', 'T', 'A');
windowsGrid(54, 112, 94, 114, 10, 12, 6, 8, 0.35);
{
  const y0 = GY - 34;
  for (let r = 0; r < 8; r++) rect(MID, 82 - 6 - r * 3, y0 - 8 + r, 12 + r * 6, 1, r === 0 ? C.T : C.S);
  rect(MID, 54, y0 + 2, 56, 30, C.J);
  rect(MID, 52, y0, 60, 2, C.T);
  for (let x = 56; x < 112; x += 11) {
    rect(MID, x, y0 + 2, 4, 30, C.T);
    rect(MID, x + 3, y0 + 2, 1, 30, C.S);
  }
  rect(MID, 50, GY - 2, 64, 2, C.T);
  disc(MID, 82, y0 - 4, 2, C.A);
  for (let x = 61; x < 108; x += 11) lights.push({ x, y: y0 + 4, w: 6, h: 26, c: C.A, on: 0.2, fl: false });
}
// 市場：條紋雨棚、板書、蔬果箱
shell(116, 176, 108, 'G', 'U', 'P');
shopfront(116, 176, 'A', ['C', 'P']);
{
  rect(MID, 120, GY - 15, 8, 14, C.K);
  rect(MID, 121, GY - 14, 6, 9, C.J);
  line(MID, 122, GY - 12, 125, GY - 12, C.C);
  line(MID, 122, GY - 9, 124, GY - 9, C.C);
  for (const [x, k] of [[160, 'A'], [166, 'M'], [172, 'P']] as const) {
    rect(MID, x - 1, GY - 7, 6, 6, C.E);
    rect(MID, x, GY - 9, 4, 2, C[k]);
  }
}
// 戰隊（我方基地）：深靛藍、圓窗隊徽、車庫門、屋頂隊旗
shell(176, 228, 74, 'J', 'G', 'P');
windowsGrid(182, 224, 104, 114, 8, 9, 5, 6, 0.4);
{
  disc(MID, 202, 90, 9, C.K);
  disc(MID, 202, 90, 8, C.T);
  disc(MID, 202, 90, 6, C.N);
  line(MID, 198, 88, 202, 93, C.M);
  line(MID, 206, 88, 202, 93, C.M);
  line(MID, 197, 87, 199, 88, C.M);
  line(MID, 207, 87, 205, 88, C.M);
  rect(MID, 182, GY - 26, 40, 26, C.K);
  for (let y = GY - 25; y < GY; y += 3) rect(MID, 183, y, 38, 2, C.S);
  rect(MID, 183, GY - 25, 38, 1, C.T);
  line(MID, 220, 74, 220, 56, C.I);
  rect(MID, 210, 56, 10, 6, C.M);
  rect(MID, 210, 61, 10, 1, C.N);
}
// 聯賽塔：最高、尖頂、時鐘（外圈九段＝賽季週次，每格畫）
const CLOCK = { x: 358, y: 62, r: 11 };
shell(332, 384, 100, 'U', 'T', 'P');
rect(MID, 342, 36, 32, 64, C.V);
rect(MID, 342, 36, 32, 1, C.A);
rect(MID, 342, 37, 32, 2, C.T);
for (let y = 36; y < 100; y++) pset(MID, 342, y, C.I);
for (let r = 0; r < 14; r++) rect(MID, 358 - Math.floor((r + 1) / 1.2), 22 + r, Math.max(1, Math.floor(((r + 1) / 1.2) * 2)), 1, r < 2 ? C.A : r % 4 === 3 ? C.U : C.G);
line(MID, 358, 14, 358, 22, C.I);
pset(MID, 358, 13, C.A);
disc(MID, CLOCK.x, CLOCK.y, CLOCK.r + 4, C.I);
disc(MID, CLOCK.x, CLOCK.y, CLOCK.r, C.C);
for (const [dx, dy] of [[0, -9], [9, 0], [0, 9], [-9, 0]]) pset(MID, CLOCK.x + dx, CLOCK.y + dy, C.K);
line(MID, CLOCK.x, CLOCK.y, CLOCK.x, CLOCK.y - 7, C.K);
line(MID, CLOCK.x, CLOCK.y, CLOCK.x + 5, CLOCK.y + 2, C.K);
windowsGrid(346, 372, 80, 96, 7, 8, 4, 5, 0.5);
windowsGrid(338, 380, 104, 146, 8, 11, 5, 7, 0.35);
shopfront(332, 384, 'C', null);
// 訓練（健身房）：大片亮窗，窗裡是跑步機剪影
shell(384, 448, 94, 'J', 'G', 'P');
{
  for (const y0 of [102, 124]) {
    rect(MID, 390, y0, 52, 16, C.K);
    rect(MID, 391, y0 + 1, 50, 14, C.J);
    lights.push({ x: 391, y: y0 + 1, w: 50, h: 14, c: C.A, on: 0.6 + (y0 - 102) * 0.02, fl: false });
    for (let x = 394; x < 438; x += 12) {
      rect(MID, x, y0 + 12, 9, 2, C.K);
      line(MID, x + 8, y0 + 12, x + 9, y0 + 6, C.K);
      rect(MID, x + 3, y0 + 5, 2, 2, C.K);
      rect(MID, x + 3, y0 + 7, 2, 4, C.K);
      pset(MID, x + 2, y0 + 11, C.K);
      pset(MID, x + 5, y0 + 11, C.K);
    }
  }
  rect(MID, 404, 88, 24, 3, C.I);
  rect(MID, 402, 86, 3, 7, C.T);
  rect(MID, 427, 86, 3, 7, C.T);
}
shopfront(384, 448, 'A', ['M', 'C']);
// 賭盤（賭場）：跑馬燈雨棚、圓形籌碼招牌
shell(448, 512, 82, 'G', 'U', 'P');
windowsGrid(454, 508, 110, 140, 9, 10, 5, 6, 0.3);
{
  disc(MID, 480, 96, 10, C.K);
  disc(MID, 480, 96, 9, C.P);
  disc(MID, 480, 96, 6, C.C);
  disc(MID, 480, 96, 4, C.P);
  for (const [dx, dy] of [[0, -8], [8, 0], [0, 8], [-8, 0], [6, 6], [-6, -6], [6, -6], [-6, 6]]) pset(MID, 480 + dx, 96 + dy, C.C);
  rect(MID, 448, GY - 34, 64, 8, C.J);
  rect(MID, 448, GY - 34, 64, 1, C.V);
}
shopfront(448, 512, 'P', null);
const bulbs = Array.from({ length: 16 }, (_, i) => ({ x: 450 + i * 4, y: GY - 31 }));
// 右填空
shell(512, 560, 96, 'U', 'T', 'P');
windowsGrid(518, 556, 104, 146, 9, 11, 5, 6, 0.3);
shopfront(512, 560, 'C', null);
// 街口：掛布條的繩子、上方一串小燈泡
rope(MID, 227, 80, 333, 70, 6, C.I);
const bunting = rope(MID, 227, 60, 333, 52, 7, C.I).filter((_, i) => i % 6 === 3);

// ── 前景：兩支路燈（視差最大） ──
const FG = layer(528, H); // 畫面 x = 層 x − 24
const LAMPS = [100, 432];
for (const lx of LAMPS) {
  rect(FG, lx - 1, 92, 3, H - 92, C.K);
  rect(FG, lx - 3, H - 30, 7, 30, C.K);
  rect(FG, lx - 2, H - 31, 5, 1, C.I);
  rect(FG, lx - 4, 90, 9, 2, C.K);
  rect(FG, lx - 3, 82, 7, 8, C.K);
  rect(FG, lx - 2, 83, 5, 6, C.A);
  rect(FG, lx - 1, 84, 3, 4, C.W);
  rect(FG, lx - 4, 80, 9, 2, C.K);
  pset(FG, lx, 79, C.K);
}

// ── 人物：我方三人背對鏡頭站在街口（16×26） ──
const SPRITE = [
  '......KKKK......', '....KKPPPPKK....', '...KHPHHHHPHK...', '..KHHHHHHHHHHK..', '..KHHHHHHHHHHK..', '.KCKHHHHHHHHKCK.', '.KCKHHHHHHHHKCK.',
  '.KCKhHHHHHHhKCK.', '..K.KhhhhhhK.K..', '.....KSSSSK.....', '...KKJJJJJJKK...', '..KJJJJJJJJJJK..', '.KJJJJNNNNJJJJK.', '.KJJJJJNNJJJJJK.',
  '.KJjJJJJJJJJjJK.', '.KJjJJJJJJJJjJK.', '.KSjJJJJJJJJjSK.', '..KKJJJJJJJJKK..', '...KLLLLLLLLK...', '...KLLLllLLLK...', '...KLLlKKlLLK...',
  '...KLLK..KLLK...', '...KLLK..KLLK...', '...KLlK..KlLK...', '...KBBK..KBBK...', '..KBBBK..KBBBK..',
];
const crew: { x: number; p: number; map: Record<string, Key> }[] = [
  { x: 219, p: 0, map: { H: 'I', h: 'K', S: 'E', L: 'G', l: 'J', B: 'T' } },
  { x: 240, p: 0.35, map: { H: 'T', h: 'S', S: 'E', L: 'J', l: 'I', B: 'C' } },
  { x: 261, p: 0.7, map: { H: 'U', h: 'G', S: 'E', L: 'G', l: 'J', B: 'T' } },
];
const BASE: Record<string, Key> = { K: 'K', P: 'S', C: 'M', J: 'J', j: 'I', N: 'M' };

// ── 每格合成 ──
const cv = document.getElementById('bg') as HTMLCanvasElement;
const g = cv.getContext('2d') as CanvasRenderingContext2D;
const img = g.createImageData(W, H);
const fb = new Uint32Array(img.data.buffer);
function blit(L: Layer, dx: number, dy: number, y0 = 0, y1 = L.h): void {
  for (let y = y0; y < y1; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= H) continue;
    const row = y * L.w;
    for (let x = Math.max(0, -dx); x < L.w && x + dx < W; x++) {
      const c = L.px[row + x];
      if (c) fb[ty * W + x + dx] = c;
    }
  }
}
function fset(x: number, y: number, c: number): void {
  if (x >= 0 && y >= 0 && x < W && y < H) fb[y * W + x] = c;
}
/** 亮一階的抖色光圈（橢圓），s 是中心強度 0～1 */
function glow(cx: number, cy: number, rx: number, ry: number, s: number, y0 = 0): void {
  for (let y = Math.max(y0, Math.floor(cy - ry)); y <= Math.min(H - 1, cy + ry); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, cx + rx); x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (d < 1 && s * (1 - d) * 16 > bay(x, y)) {
        const p = y * W + x;
        fb[p] = UP.get(fb[p]) ?? fb[p];
      }
    }
  }
}
function ground(om: number): void {
  const vx = 240 + om;
  const vy = 118;
  for (let y = GY; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c: number;
      if (y < 205) {
        c = C.G;
        if (y === GY || y === 181 || y === 186 || y === 194) c = C.J;
        else {
          // 人行道磚縫：往消失點收斂
          const xb = vx + ((x - vx) * (GY - vy)) / (y - vy);
          if (((((xb - om - 2) % 14) + 14) % 14) < 1) c = C.J;
        }
      } else if (y < 208) c = y === 205 ? C.T : y === 206 ? C.S : C.K;
      else {
        c = ((x * 7 + y * 13) % 23 === 0) ? C.J : C.I;
        const xb = vx + ((x - vx) * (GY - vy)) / (y - vy) - om;
        if (y >= 210 && y <= 240 && xb > 212 && xb < 268 && Math.floor((xb - 212) / 4) % 2 === 0) c = y === 240 ? C.S : C.T;
        if (y === 246 && Math.floor((x - om * 1.6) / 12) % 2 === 0 && !(xb > 210 && xb < 270)) c = C.U;
      }
      fb[y * W + x] = c;
    }
  }
}
let car = -60;
function drawCar(x: number): void {
  const y = 236;
  const body = (xx: number, yy: number, w: number, h: number, c: number): void => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) fset(Math.round(x + xx + i), yy + j, c);
  };
  body(2, y + 4, 34, 9, C.K);
  body(3, y + 5, 32, 7, C.N);
  body(8, y, 18, 6, C.K);
  body(9, y + 1, 16, 4, C.J);
  body(10, y + 1, 2, 4, C.T);
  body(3, y + 9, 32, 1, C.I);
  body(35, y + 6, 2, 2, C.W);
  body(1, y + 6, 2, 2, C.D);
  for (const wx of [7, 27]) {
    body(wx, y + 11, 5, 4, C.K);
    body(wx + 1, y + 12, 3, 2, C.S);
  }
  glow(x + 46, y + 9, 14, 4, 0.9, 208);
}
const birds = Array.from({ length: 4 }, (_, i) => ({ x: 60 + i * 90, y: 44 + (i % 3) * 12, v: 6 + i * 1.5 }));

const signs = document.querySelector<HTMLElement>('.street');
let lastOm = 99;
function frame(t: number, mx: number): void {
  const off = (k: number): number => Math.round(-mx * k);
  const of = off(3);
  const om = off(9);
  const oc = off(12);
  const og = off(20);
  fb.set(SKY.px);
  for (const s of stars) fset(s.x, s.y, (Math.floor(t * 2.2) + s.p) % 9 < 6 ? C.C : C.V);
  // 雲
  const cx = Math.floor(t * 2.5 + of * 2) % 960;
  for (let y = 0; y < CLOUD.h; y++) {
    for (let x = 0; x < W; x++) {
      const c = CLOUD.px[y * 960 + ((x + cx + 960) % 960)];
      if (c) fb[y * W + x] = c;
    }
  }
  // 探照燈：從圓頂往上掃
  for (const [bx, ph] of [[228, 0], [292, 2.2]] as const) {
    const a = Math.sin(t * 0.45 + ph) * 0.55 + (bx < 260 ? -0.18 : 0.18);
    const ox = bx - 20 + of;
    for (let y = 150; y > 20; y--) {
      const dist = 150 - y;
      const xc = ox + Math.tan(a) * dist;
      const hw = 1 + dist * 0.07;
      const s = 0.55 * (1 - dist / 130);
      for (let x = Math.floor(xc - hw); x <= xc + hw; x++) {
        if (x < 0 || x >= W) continue;
        if (s * 16 > bay(x, y)) {
          const p = y * W + x;
          fb[p] = UP.get(fb[p]) ?? fb[p];
        }
      }
    }
  }
  blit(FAR, of - 20, 0, 90, GY);
  for (const l of domeLights) fset(l.x - 20 + of, DOME.y - 5, (Math.floor(t * 3) + l.p) % 5 === 0 ? C.W : C.A);
  for (const b of birds) {
    const x = Math.round(((b.x + t * b.v) % 520) - 20);
    const fl = Math.floor(t * 4 + b.x) % 2;
    fset(x, b.y, C.I);
    fset(x - 1, b.y - fl, C.I);
    fset(x + 1, b.y - fl, C.I);
    fset(x - 2, b.y - 1 + fl, C.I);
    fset(x + 2, b.y - 1 + fl, C.I);
  }
  blit(MID, om - 40, 0, 10, GY);
  // 窗燈依序亮起，少數會閃
  for (const l of lights) {
    if (t < l.on) continue;
    if (l.fl && Math.sin(t * 9 + l.x) > 0.6) continue;
    for (let y = l.y; y < l.y + l.h; y++) {
      for (let x = l.x; x < l.x + l.w; x++) {
        const tx = x + om - 40;
        if (tx < 0 || tx >= W) continue;
        const p = y * W + tx;
        if (fb[p] === C.J) fb[p] = l.c;
      }
    }
  }
  for (let i = 0; i < bulbs.length; i++) fset(bulbs[i].x + om - 40, bulbs[i].y, (i + Math.floor(t * 6)) % 3 === 0 ? C.W : C.A);
  for (let i = 0; i < bunting.length; i++) {
    const [x, y] = bunting[i];
    fset(x + om - 40, y + 1, (i + Math.floor(t * 1.5)) % 4 === 0 ? C.C : i % 2 ? C.A : C.P);
    fset(x + om - 40, y + 2, C.I);
  }
  // 時鐘外圈：九段週次，第 4 週閃
  for (let dy = -CLOCK.r - 3; dy <= CLOCK.r + 3; dy++) {
    for (let dx = -CLOCK.r - 3; dx <= CLOCK.r + 3; dx++) {
      const d = Math.hypot(dx, dy);
      if (d < CLOCK.r + 1.2 || d > CLOCK.r + 3.2) continue;
      const ang = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
      const seg = Math.floor(ang / ((Math.PI * 2) / 9));
      const gap = (ang / ((Math.PI * 2) / 9)) % 1 > 0.86;
      const c = gap ? C.I : seg < 3 ? C.M : seg === 3 ? (Math.floor(t * 2) % 2 ? C.W : C.A) : C.G;
      fset(CLOCK.x + dx + om - 40, CLOCK.y + dy, c);
    }
  }
  ground(om);
  // 燈下光圈、店面灑出的光
  for (const lx of LAMPS) glow(lx - 24 + og, 196, 26, 9, 0.75, GY);
  for (const sx of [82, 146, 416, 480]) glow(sx - 40 + om, GY + 4, 24, 6, 0.6, GY);
  // 人物
  for (const m of crew) {
    const bob = Math.floor(t * 1.6 + m.p) % 2;
    const x0 = m.x - 8 + oc;
    const y0 = 203 - 26 + bob;
    SPRITE.forEach((row, j) => {
      for (let i = 0; i < 16; i++) {
        const ch = row[i];
        if (ch === '.') continue;
        if (j === 25 && bob) continue;
        fset(x0 + i, y0 + j, C[m.map[ch] ?? BASE[ch]]);
      }
    });
  }
  // 路過的小車
  if (!still) {
    car += 0.9;
    if (car > 900) car = -60;
  }
  if (car < 520) drawCar(car + og);
  blit(FG, og - 24, 0, 78, H);
  for (const lx of LAMPS) glow(lx - 24 + og, 86, 16, 16, 0.85);
  g.putImageData(img, 0, 0);
  if (signs && om !== lastOm) {
    signs.style.transform = `translateX(${om * 4}px)`;
    lastOm = om;
  }
}
if (still) car = 166;
onFrame((t, mx) => frame(still ? 9 : t, mx));

// 8×8 像素圖示（招牌用）：. 透明、其他字元對應色票
const ICONS: Record<string, string[]> = {
  coin: ['..AAAA..', '.AACCAA.', 'AACAAAAA', 'AACAAAAA', 'AAACCAAA', 'AAAAACAA', '.AACCAA.', '..AAAA..'],
  scroll: ['.CCCCC..', 'C.....C.', '.CSSS.C.', '.C....C.', '.CSSS.C.', '.C....C.', '.CCCCC.C', '......C.'],
  flag: ['MMMMMM..', 'MNNMMM..', 'MMNNMM..', 'MMMNNM..', 'MMMMMM..', 'C.......', 'C.......', 'C.......'],
  cup: ['AAAAAAAA', 'A.AAAA.A', '.AAAAAA.', '..AAAA..', '...AA...', '...AA...', '..AAAA..', '.AAAAAA.'],
  bell: ['CC....CC', 'CC....CC', '.CCCCCC.', '.CCCCCC.', '.CCCCCC.', '.CCCCCC.', 'CC....CC', 'CC....CC'],
  dice: ['CCCCCCCC', 'C.....PC', 'C......C', 'C..PP..C', 'C..PP..C', 'C......C', 'CP.....C', 'CCCCCCCC'],
};
document.querySelectorAll<HTMLElement>('[data-px-icon]').forEach((el) => {
  const rows = ICONS[el.dataset.pxIcon as string];
  const k = Number(el.dataset.k ?? 4);
  const rects = rows.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${HEX[ch as Key]}"/>`)));
  el.innerHTML = `<svg width="${8 * k}" height="${8 * k}" viewBox="0 0 8 8" shape-rendering="crispEdges">${rects.join('')}</svg>`;
});
