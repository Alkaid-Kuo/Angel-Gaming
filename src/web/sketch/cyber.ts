// 設計稿 A：夜城天台。無人機視角俯看城市：建築是程式算的 3D 方塊，開頁時畫一次；
// 另一張畫布每格更新會動的光（AR 地環、探照燈、車流、信標、飛行器、地標線框、停機坪弧），再加一層雨。AR 標籤釘在地標建築頂上。
import { initStage, onFrame, still } from './stage.ts';

initStage();

const CW = 2048; // 畫布比舞台大一圈（左右各 64、上下各 36），留給視差
const CH = 1152;
const F = 1150; // 焦距：水平視角約 80 度的廣角
const PITCH = (14 * Math.PI) / 180;
const SP = Math.sin(PITCH);
const CP = Math.cos(PITCH);
const CAM_Y = 360;
const ROOF = 210; // 我方屋頂高度（攝影機在屋頂上方）
const HORIZON = CH / 2 - F * Math.tan(PITCH);

interface P2 {
  x: number;
  y: number;
  d: number;
}
/** 世界座標（x 右、y 上、z 前；攝影機在 (0, CAM_Y, 0) 往下俯 15 度）→ 畫布座標與深度 */
function proj(x: number, y: number, z: number): P2 {
  const dy = y - CAM_Y;
  const d = -dy * SP + z * CP;
  return { x: CW / 2 + (F * x) / d, y: CH / 2 - (F * (dy * CP + z * SP)) / d, d };
}

let seed = 7;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, a = 1): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const rgb = (c: RGB): string => c.map((v) => Math.round(v)).join(',');
const hex = (c: RGB): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

// ── 配色：網址 ?pal=名稱 切換（右下角的色塊也可以點）。中性色保留原本的明暗、只換色相；主色、點綴色整組換掉 ──
interface Pal {
  name: string;
  label: string;
  main: RGB; // 主色：我方、選中、競技場、城市的光
  accent: RGB; // 點綴：開戰、對手
  hue: number; // 中性色的色相
  sat: number; // 中性色飽和度（相對冷青版的倍數）
}
const PALS: Pal[] = [
  { name: 'cyan', label: '冷青＋洋紅', main: [79, 232, 245], accent: [255, 46, 136], hue: 210, sat: 1 },
  { name: 'acid', label: '酸性黃綠＋桃紅', main: [200, 255, 46], accent: [255, 46, 99], hue: 140, sat: 0.55 },
  { name: 'red', label: '紅黑白', main: [255, 42, 61], accent: [244, 241, 236], hue: 0, sat: 0.12 },
  { name: 'teal', label: '青綠＋粉', main: [46, 242, 192], accent: [255, 95, 162], hue: 168, sat: 0.7 },
  { name: 'mono', label: '冰白＋紅', main: [214, 232, 245], accent: [255, 51, 68], hue: 215, sat: 0.25 },
  { name: 'outlaw', label: '黃＋洋紅', main: [255, 210, 63], accent: [255, 46, 136], hue: 275, sat: 0.45 },
  { name: 'violet', label: '電光紫＋青', main: [178, 107, 255], accent: [63, 240, 255], hue: 255, sat: 0.8 },
  { name: 'amber', label: '琥珀＋紅', main: [255, 176, 0], accent: [255, 59, 48], hue: 30, sat: 0.25 },
];
const PAL = PALS.find((p) => p.name === new URLSearchParams(location.search).get('pal')) ?? PALS[0];
function satLight([r, g, b]: RGB): [number, number] {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const l = (mx + mn) / 2;
  return [mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)), l];
}
function fromHsl(h: number, s: number, l: number): RGB {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
/** 中性色：保留明暗，色相換成這組的中性色相 */
const N = (c: RGB): RGB => {
  const [s, l] = satLight(c);
  return fromHsl(PAL.hue, Math.min(1, s * PAL.sat), l);
};
const FOG = N([15, 27, 39]);
const GLOW = mix(PAL.main, BLACK, 0.66);
const fogT = (d: number): number => Math.min(1, Math.max(0, (d - 400) / 7000)) ** 0.7 * 0.92;
const CY = rgb(PAL.main);
const MG = rgb(PAL.accent);
const LT = rgb(mix(PAL.main, WHITE, 0.7)); // 主色的亮光：窗燈、路燈
const LT2 = rgb(mix(PAL.main, WHITE, 0.82)); // 更亮：頂緣燈、車頭燈、信標
const NL = rgb(N([140, 180, 196])); // 中性色的燈
{
  const stage = document.getElementById('stage') as HTMLElement;
  const vars: Record<string, string> = {
    '--bg': hex(N([4, 7, 11])),
    '--bg-rgb': rgb(N([4, 7, 11])),
    '--st': hex(N([24, 38, 53])),
    '--st2': hex(N([34, 50, 70])),
    '--c': hex(PAL.main),
    '--c-rgb': CY,
    '--c2': hex(mix(PAL.main, WHITE, 0.75)),
    '--cm': hex(mix(PAL.main, BLACK, 0.4)),
    '--cl': `rgba(${CY},0.5)`,
    '--txt': hex(N([219, 231, 238])),
    '--dim': hex(N([125, 147, 163])),
    '--dim2': hex(N([77, 98, 115])),
    '--tagb': hex(N([185, 202, 212])),
    '--pn-rgb': rgb(N([10, 18, 26])),
    '--pn2-rgb': rgb(mix(mix(PAL.main, BLACK, 0.85), N([10, 18, 26]), 0.3)),
    '--mg': hex(PAL.accent),
    '--mg-rgb': MG,
    '--mg2': hex(mix(PAL.accent, WHITE, 0.45)),
    '--mg3': hex(mix(PAL.accent, WHITE, 0.3)),
    '--mg4': hex(mix(PAL.accent, BLACK, 0.15)),
    '--mgd1': hex(mix(PAL.accent, BLACK, 0.84)),
    '--mgd2': hex(mix(PAL.accent, BLACK, 0.93)),
    '--ink': hex(mix(PAL.accent, BLACK, 0.9)),
  };
  for (const [k, v] of Object.entries(vars)) stage.style.setProperty(k, v);
  // 隊徽與頭像在 fill.ts 才畫，這裡先把顏色填好
  document.querySelectorAll<HTMLElement>('[data-crest="天使戰隊"]').forEach((el) => Object.assign(el.dataset, { primary: hex(N([22, 34, 45])), secondary: hex(PAL.main) }));
  document.querySelectorAll<HTMLElement>('[data-crest="暗影工作室"]').forEach((el) => Object.assign(el.dataset, { primary: vars['--mgd1'], secondary: hex(PAL.accent) }));
  document.querySelectorAll<HTMLElement>('[data-avatar]').forEach((el) => (el.dataset.jersey = vars['--st2']));
  const note = document.querySelector('.design-note');
  if (note) note.textContent += ` · ${PAL.label}`;
  const bar = document.querySelector('.pals');
  if (bar) bar.innerHTML = PALS.map((p) => `<a href="?pal=${p.name}" title="${p.label}"${p === PAL ? ' class="on"' : ''}><i style="background:${hex(p.main)}"></i><i style="background:${hex(p.accent)}"></i></a>`).join('');
}

// ── 城市資料 ──
const ARENA = { x: 0, z: 1300, r: 250, h: 66 };
/** 依「標籤釘點在舞台上的位置」反推地標建築的世界座標（設計時直接指定畫面構圖） */
function place(sx: number, sy: number, h: number, w: number): { x: number; z: number; w: number; d: number; h: number } {
  const dy = h - CAM_Y;
  const k = (CH / 2 - (sy + 36)) / F;
  const z = (-dy * (k * SP + CP)) / (SP - k * CP);
  const d = -dy * SP + z * CP;
  return { x: ((sx + 64 - CW / 2) * d) / F, z, w, d: w, h };
}
const LAND: Record<string, { x: number; z: number; w: number; d: number; h: number }> = {
  finance: place(250, 300, 250, 150),
  market: place(650, 430, 120, 120),
  training: place(300, 640, 90, 110),
  league: place(1430, 310, 220, 140),
  betting: place(1560, 660, 100, 110),
  rival: place(1680, 430, 180, 120),
};

interface Bld {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
  lit: number;
  land?: string;
}
const blds: Bld[] = [];
const beacons: { x: number; y: number; z: number; p: number }[] = [];
for (const [id, l] of Object.entries(LAND)) {
  blds.push({ x0: l.x - l.w / 2, x1: l.x + l.w / 2, z0: l.z - l.d / 2, z1: l.z + l.d / 2, h: l.h, lit: 0.1, land: id });
  beacons.push({ x: l.x, y: l.h + 26, z: l.z, p: rnd() * 6 });
}
const BP = 120; // 街廓間距
for (let zc = 300; zc < 9000; zc += BP) {
  const n = Math.ceil((zc * 0.9 + 300) / BP);
  for (let ix = -n; ix <= n; ix++) {
    const xc = ix * BP;
    if (Math.abs(xc) < 70) continue; // 中央大道
    if (Math.hypot(xc - ARENA.x, zc - ARENA.z) < 400) continue; // 競技場廣場
    if (Object.values(LAND).some((l) => Math.abs(l.x - xc) < 140 && Math.abs(l.z - zc) < 140)) continue;
    const parts = rnd() < 0.35 ? 2 : 1;
    const inner = BP - 40;
    const down = Math.max(Math.exp(-((xc - 900) ** 2 + (zc - 3400) ** 2) / 2 / 1300 ** 2), Math.exp(-((xc + 2100) ** 2 + (zc - 4700) ** 2) / 2 / 1500 ** 2));
    for (let k = 0; k < parts; k++) {
      const w = inner / parts - 4 - rnd() * 10;
      const dd = inner - rnd() * 24;
      const x0 = xc - inner / 2 + (k * inner) / parts + 2;
      const z0 = zc - dd / 2;
      let h = 22 + rnd() ** 2.3 * 150;
      if (rnd() < 0.04 + down * 0.4) h = 170 + rnd() * 230 + down * 220;
      if (zc < 900) h = Math.min(h, 60 + rnd() * 50);
      if (zc < ARENA.z && Math.abs(xc) < ARENA.r + 260) h = Math.min(h, 26 + rnd() * 18);
      blds.push({ x0, x1: x0 + w, z0, z1: z0 + dd, h, lit: 0.015 + rnd() ** 2 * 0.09 });
      if (h > 300 && rnd() < 0.35) beacons.push({ x: x0 + w / 2, y: h + 24 + rnd() * 40, z: z0 + dd / 2, p: rnd() * 6 });
    }
  }
}
// 遠到近畫（同一排裡離中線遠的先畫）
blds.sort((a, b) => b.z0 + b.z1 - (a.z0 + a.z1) || Math.abs(b.x0 + b.x1) - Math.abs(a.x0 + a.x1));

// ── 靜態城市 ──
const city = document.getElementById('city') as HTMLCanvasElement;
const g = city.getContext('2d') as CanvasRenderingContext2D;

function poly(c: CanvasRenderingContext2D, pts: P2[]): void {
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  c.closePath();
}
function face(pts: P2[], base: RGB, t: number): void {
  const top = Math.min(...pts.map((p) => p.y));
  const bot = Math.max(...pts.map((p) => p.y));
  const gr = g.createLinearGradient(0, top, 0, bot);
  gr.addColorStop(0, css(mix(base, FOG, t)));
  gr.addColorStop(1, css(mix(mix(base, GLOW, 0.3), FOG, t)));
  g.fillStyle = gr;
  poly(g, pts);
  g.fill();
}
/** 牆面上的亮窗：沿著 (u 方向, 高度) 的格子隨機點亮 */
function windows(b: Bld, t: number, along: 'x' | 'z', fixed: number): void {
  const len = along === 'x' ? b.x1 - b.x0 : b.z1 - b.z0;
  const cols = Math.max(1, Math.floor(len / 9));
  const rows = Math.max(1, Math.floor(b.h / 10));
  const strip = Array.from({ length: rows }, () => rnd() < b.lit * 1.4);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (!strip[j] && rnd() > b.lit * 0.6) continue;
      const u = (along === 'x' ? b.x0 : b.z0) + ((i + 0.5) * len) / cols;
      const p = along === 'x' ? proj(u, ((j + 0.5) * b.h) / rows, fixed) : proj(fixed, ((j + 0.5) * b.h) / rows, u);
      const s = F / p.d;
      g.fillStyle = rnd() < 0.85 ? `rgba(${LT},${(0.35 + rnd() * 0.4) * (1 - t)})` : `rgba(${NL},${0.4 * (1 - t)})`;
      g.fillRect(p.x, p.y, Math.max(1, 2.6 * s), Math.max(1, 1.6 * s));
    }
  }
}
function drawBld(b: Bld): void {
  const c = proj((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2);
  if (c.x < -400 || c.x > CW + 400) return;
  const t = fogT(c.d);
  const lm = b.land ? 0.08 : 0;
  const front = [proj(b.x0, 0, b.z0), proj(b.x1, 0, b.z0), proj(b.x1, b.h, b.z0), proj(b.x0, b.h, b.z0)];
  if (b.x0 > 0) face([proj(b.x0, 0, b.z0), proj(b.x0, 0, b.z1), proj(b.x0, b.h, b.z1), proj(b.x0, b.h, b.z0)], mix(N([6, 11, 17]), GLOW, lm), t);
  else if (b.x1 < 0) face([proj(b.x1, 0, b.z0), proj(b.x1, 0, b.z1), proj(b.x1, b.h, b.z1), proj(b.x1, b.h, b.z0)], mix(N([6, 11, 17]), GLOW, lm), t);
  face(front, mix(N([8, 15, 22]), GLOW, lm), t);
  const roof = [proj(b.x0, b.h, b.z0), proj(b.x1, b.h, b.z0), proj(b.x1, b.h, b.z1), proj(b.x0, b.h, b.z1)];
  g.fillStyle = css(mix(mix(N([15, 25, 35]), GLOW, lm), FOG, t));
  poly(g, roof);
  g.fill();
  if (c.d < 3000) {
    g.strokeStyle = `rgba(${CY},${0.1 * (1 - t)})`;
    g.lineWidth = 1;
    poly(g, roof);
    g.stroke();
  }
  if (c.d < 3800) {
    windows(b, t, 'x', b.z0);
    if (b.x0 > 0) windows(b, t, 'z', b.x0);
    else if (b.x1 < 0) windows(b, t, 'z', b.x1);
    // 屋頂設備或小停機坪
    if (c.d < 2400 && rnd() < 0.18) {
      const ix = (b.x1 - b.x0) * 0.25;
      const iz = (b.z1 - b.z0) * 0.25;
      g.fillStyle = css(mix(N([27, 43, 58]), FOG, t));
      poly(g, [proj(b.x0 + ix, b.h, b.z0 + iz), proj(b.x1 - ix, b.h, b.z0 + iz), proj(b.x1 - ix, b.h, b.z1 - iz), proj(b.x0 + ix, b.h, b.z1 - iz)]);
      g.fill();
    }
  } else {
    const n = Math.floor((b.lit * b.h) / 8);
    g.fillStyle = `rgba(${LT},${0.4 * (1 - t)})`;
    for (let i = 0; i < n; i++) {
      const p = proj(b.x0 + rnd() * (b.x1 - b.x0), rnd() * b.h, b.z0);
      g.fillRect(p.x, p.y, 1, 1);
    }
  }
  // 高樓頂冠燈帶
  if (b.h > 200) {
    g.strokeStyle = `rgba(${CY},${0.55 * (1 - t)})`;
    g.lineWidth = Math.max(1, (2.2 * F) / c.d);
    const a = proj(b.x0, b.h - 5, b.z0);
    const e = proj(b.x1, b.h - 5, b.z0);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(e.x, e.y);
    if (b.x0 > 0) {
      const s = proj(b.x0, b.h - 5, b.z1);
      g.moveTo(a.x, a.y);
      g.lineTo(s.x, s.y);
    }
    g.stroke();
  }
}
function ring(x: number, y: number, z: number, r: number, n = 72): P2[] {
  return Array.from({ length: n }, (_, i) => proj(x + r * Math.cos((i / n) * Math.PI * 2), y, z + r * Math.sin((i / n) * Math.PI * 2)));
}
function drawArena(): void {
  const { x, z, r, h } = ARENA;
  const t = fogT(proj(x, 0, z).d);
  const bot = ring(x, 0, z, r);
  const top = ring(x, h, z, r);
  // 外牆：前半圈（離鏡頭近的那一半）
  for (let i = 0; i < bot.length; i++) {
    const j = (i + 1) % bot.length;
    const a = (i / bot.length) * Math.PI * 2;
    if (Math.sin(a) > 0.15) continue;
    g.fillStyle = css(mix(N([14, 24, 34]), FOG, t));
    poly(g, [bot[i], bot[j], top[j], top[i]]);
    g.fill();
    if (i % 4 === 0) {
      g.strokeStyle = `rgba(${CY},0.35)`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(bot[i].x, bot[i].y);
      g.lineTo(top[i].x, top[i].y);
      g.stroke();
    }
  }
  // 頂緣、看台、場地
  g.fillStyle = css(mix(N([24, 39, 54]), FOG, t));
  poly(g, top);
  g.fill();
  g.fillStyle = css(mix(N([9, 16, 23]), FOG, t));
  poly(g, ring(x, h - 8, z, r * 0.86));
  g.fill();
  for (const [k, yy, a] of [
    [0.78, h - 20, 0.22],
    [0.7, 34, 0.18],
    [0.62, 24, 0.14],
  ] as const) {
    g.strokeStyle = `rgba(${CY},${a})`;
    g.lineWidth = 1.2;
    poly(g, ring(x, yy, z, r * k));
    g.stroke();
  }
  const fieldPts = ring(x, 14, z, r * 0.5);
  g.fillStyle = css(mix(PAL.main, BLACK, 0.55), 0.85);
  poly(g, fieldPts);
  g.fill();
  g.strokeStyle = `rgba(${CY},0.6)`;
  g.lineWidth = 1.5;
  poly(g, ring(x, 14, z, r * 0.36));
  g.stroke();
  const l0 = proj(x - r * 0.5, 14, z);
  const l1 = proj(x + r * 0.5, 14, z);
  g.beginPath();
  g.moveTo(l0.x, l0.y);
  g.lineTo(l1.x, l1.y);
  g.stroke();
  // 頂緣燈
  g.fillStyle = `rgba(${LT2},0.95)`;
  top.forEach((p, i) => {
    if (i % 2 === 0) g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  });
}

{
  // 天空與遠方天際線
  const sky = g.createLinearGradient(0, 0, 0, HORIZON + 30);
  sky.addColorStop(0, hex(N([4, 7, 11])));
  sky.addColorStop(0.65, hex(N([8, 17, 26])));
  sky.addColorStop(1, hex(N([20, 38, 56])));
  g.fillStyle = sky;
  g.fillRect(0, 0, CW, HORIZON + 30);
  let x = 0;
  while (x < CW) {
    const w = 8 + rnd() * 34;
    const h = 6 + rnd() ** 2.2 * 80;
    g.fillStyle = hex(N([14, 27, 40]));
    g.fillRect(x, HORIZON - h, w, h + 30);
    x += w + 1;
  }
  // 地面
  const gd = g.createLinearGradient(0, HORIZON, 0, CH);
  gd.addColorStop(0, hex(N([19, 35, 50])));
  gd.addColorStop(0.3, hex(N([9, 19, 28])));
  gd.addColorStop(1, hex(N([4, 8, 12])));
  g.fillStyle = gd;
  g.fillRect(0, HORIZON, CW, CH - HORIZON);
  // 街道：沿 z 與沿 x 的細線，近亮遠暗
  const line = (a: P2, b: P2, alpha: number, w = 1): void => {
    const gr = g.createLinearGradient(a.x, a.y, b.x, b.y);
    gr.addColorStop(0, `rgba(${CY},${alpha})`);
    gr.addColorStop(1, `rgba(${CY},0)`);
    g.strokeStyle = gr;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  };
  for (let ix = -60; ix <= 60; ix++) {
    const sx = (ix + 0.5) * BP;
    if (Math.abs(sx) < 80) continue;
    line(proj(sx, 0, 260), proj(sx, 0, 9000), 0.24);
    if (ix % 2 === 0) {
      for (let z = 320; z < 4200; z += 40) {
        const p = proj(sx, 4, z);
        g.fillStyle = `rgba(${LT},${0.55 * (1 - fogT(p.d))})`;
        g.fillRect(p.x, p.y, Math.max(1, (2.2 * F) / p.d), Math.max(1, (2.2 * F) / p.d));
      }
    }
  }
  for (let zc = 300; zc < 9000; zc += BP) {
    const z = zc + BP / 2;
    const a = 0.2 * (1 - fogT(z));
    const wdt = z * 0.9 + 300;
    g.strokeStyle = `rgba(${CY},${a})`;
    g.lineWidth = 1;
    const l = proj(-wdt, 0, z);
    const r = proj(wdt, 0, z);
    g.beginPath();
    g.moveTo(l.x, l.y);
    g.lineTo(r.x, r.y);
    g.stroke();
  }
  // 中央大道：邊線、路燈
  for (const sx of [-72, 72]) line(proj(sx, 0, 240), proj(sx, 0, 9000), 0.5, 2);
  for (const sx of [-4, 4]) line(proj(sx, 0, 240), proj(sx, 0, 9000), 0.3, 1);
  for (let z = 300; z < 7000; z += 46) {
    for (const sx of [-64, 64]) {
      const p = proj(sx, 6, z);
      const s = Math.max(1, (3 * F) / p.d);
      g.fillStyle = `rgba(${LT2},${0.8 * (1 - fogT(p.d))})`;
      g.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
  }
  // 建築（競技場插在排序位置）
  let arenaDone = false;
  for (const b of blds) {
    if (!arenaDone && (b.z0 + b.z1) / 2 < ARENA.z) {
      drawArena();
      arenaDone = true;
    }
    drawBld(b);
  }
  for (const b of beacons) {
    const a = proj(b.x, b.y - 40, b.z);
    const e = proj(b.x, b.y, b.z);
    g.strokeStyle = `rgba(${rgb(N([120, 150, 165]))},${0.6 * (1 - fogT(a.d))})`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(e.x, e.y);
    g.stroke();
  }
  // 遠方霧帶、競技場光暈、大道光暈
  const haze = g.createLinearGradient(0, HORIZON - 30, 0, HORIZON + 200);
  const hz = N([20, 38, 54]);
  haze.addColorStop(0, css(hz, 0));
  haze.addColorStop(0.25, css(hz, 0.75));
  haze.addColorStop(1, css(hz, 0));
  g.fillStyle = haze;
  g.fillRect(0, HORIZON - 30, CW, 230);
  g.globalCompositeOperation = 'lighter';
  const ac = proj(ARENA.x, 20, ARENA.z);
  g.save();
  g.translate(ac.x, ac.y);
  g.scale(1, 0.42);
  const ag = g.createRadialGradient(0, 0, 0, 0, 0, 520);
  ag.addColorStop(0, `rgba(${CY},0.22)`);
  ag.addColorStop(1, `rgba(${CY},0)`);
  g.fillStyle = ag;
  g.beginPath();
  g.arc(0, 0, 520, 0, Math.PI * 2);
  g.fill();
  g.restore();
  const av0 = proj(-90, 0, 300);
  const av1 = proj(90, 0, 300);
  const avf = proj(0, 0, 9000);
  const avg = g.createLinearGradient(0, av0.y, 0, avf.y);
  avg.addColorStop(0, `rgba(${CY},0.07)`);
  avg.addColorStop(1, `rgba(${CY},0)`);
  g.fillStyle = avg;
  g.beginPath();
  g.moveTo(av0.x, av0.y);
  g.lineTo(av1.x, av1.y);
  g.lineTo(avf.x, avf.y);
  g.closePath();
  g.fill();
  g.globalCompositeOperation = 'source-over';
}

// ── 我方屋頂（最近的前景）──
const ROOF_Y = proj(0, ROOF, 230).y;
{
  const rg = g.createLinearGradient(0, ROOF_Y, 0, CH);
  rg.addColorStop(0, hex(N([12, 22, 32])));
  rg.addColorStop(1, hex(N([4, 7, 11])));
  g.fillStyle = rg;
  g.fillRect(0, ROOF_Y, CW, CH - ROOF_Y);
  g.strokeStyle = `rgba(${CY},0.07)`;
  g.lineWidth = 1;
  for (let x = -1600; x <= 1600; x += 60) {
    const a = proj(x, ROOF, 230);
    const b = proj(x, ROOF, 120);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }
  for (const z of [212, 192, 172]) {
    const y = proj(0, ROOF, z).y;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(CW, y);
    g.stroke();
  }
  // 玻璃欄杆
  const top = proj(0, ROOF + 14, 228).y;
  g.fillStyle = `rgba(${CY},0.035)`;
  g.fillRect(0, top, CW, ROOF_Y - top);
  g.strokeStyle = `rgba(${CY},0.3)`;
  g.beginPath();
  g.moveTo(0, top);
  g.lineTo(CW, top);
  g.stroke();
  g.strokeStyle = `rgba(${CY},0.16)`;
  for (let x = -2400; x <= 2400; x += 60) {
    const a = proj(x, ROOF, 228);
    const b = proj(x, ROOF + 14, 228);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }
  g.fillStyle = `rgba(${CY},0.4)`;
  g.fillRect(0, ROOF_Y - 1, CW, 2);
}

// ── AR 標籤與比賽卡：釘在地標頂上，近大遠小 ──
document.querySelectorAll<HTMLElement>('[data-at]').forEach((el) => {
  const id = el.dataset.at as string;
  const l = LAND[id];
  const p = l ? proj(l.x, l.h + 6, l.z) : proj(ARENA.x, 170, ARENA.z);
  el.style.left = `${p.x.toFixed(1)}px`;
  el.style.top = `${p.y.toFixed(1)}px`;
  if (l) el.style.setProperty('--k', Math.min(1, Math.max(0.66, 0.5 + 340 / p.d)).toFixed(3));
});
let hot = '';
document.querySelectorAll<HTMLElement>('.tag').forEach((el) => {
  el.addEventListener('mouseenter', () => (hot = el.dataset.at ?? ''));
  el.addEventListener('mouseleave', () => (hot = ''));
});

// 倒數
const cd = document.getElementById('cd');
if (cd && !still) {
  let s = 2 * 3600 + 14 * 60 + 37;
  setInterval(() => {
    s = Math.max(0, s - 1);
    const p2 = (n: number): string => String(n).padStart(2, '0');
    cd.textContent = `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
  }, 1000);
}

// ── 每格更新的光 ──
const fx = document.getElementById('fx') as HTMLCanvasElement;
const f = fx.getContext('2d') as CanvasRenderingContext2D;
const cars = Array.from({ length: 90 }, (_, i) => ({ lane: [-40, -20, 20, 40][i % 4], z: 600 + rnd() * 8000, v: 160 + rnd() * 140 }));
const flyers = Array.from({ length: 5 }, (_, i) => ({ y: 260 + i * 45, z: 1300 + i * 700, x: -3000 + rnd() * 6000, v: (i % 2 ? 1 : -1) * (120 + rnd() * 120) }));

function polyline(pts: P2[], close: boolean): void {
  f.beginPath();
  pts.forEach((p, i) => (i ? f.lineTo(p.x, p.y) : f.moveTo(p.x, p.y)));
  if (close) f.closePath();
}

function frame(t: number): void {
  f.clearRect(0, 0, CW, CH);
  f.save();
  f.beginPath();
  f.rect(0, 0, CW, ROOF_Y - 2);
  f.clip();
  // AR 地環
  const { x: ax, z: az } = ARENA;
  f.lineWidth = 2;
  f.setLineDash([26, 12, 4, 12]);
  f.lineDashOffset = -t * 30;
  f.strokeStyle = `rgba(${CY},0.55)`;
  polyline(ring(ax, 2, az, 330, 120), true);
  f.stroke();
  f.setLineDash([]);
  f.lineWidth = 1;
  f.strokeStyle = `rgba(${CY},0.2)`;
  polyline(ring(ax, 2, az, 380, 120), true);
  f.stroke();
  f.strokeStyle = `rgba(${CY},0.45)`;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2 - t * 0.05;
    const r0 = i % 4 === 0 ? 392 : 400;
    const p = proj(ax + r0 * Math.cos(a), 2, az + r0 * Math.sin(a));
    const q = proj(ax + 414 * Math.cos(a), 2, az + 414 * Math.sin(a));
    f.beginPath();
    f.moveTo(p.x, p.y);
    f.lineTo(q.x, q.y);
    f.stroke();
  }
  // 探照燈
  f.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const phi = t * 0.22 + i * 2.1;
    const ba = i * 2.1 + 0.6;
    const bx = ax + ARENA.r * Math.cos(ba);
    const bz = az + ARENA.r * Math.sin(ba);
    const el = 1.15;
    const L = 1500;
    const ex = bx + L * Math.cos(el) * Math.cos(phi);
    const ey = ARENA.h + L * Math.sin(el);
    const ez = bz + L * Math.cos(el) * Math.sin(phi);
    const b0 = proj(bx, ARENA.h, bz);
    const e0 = proj(ex, ey, ez);
    if (e0.d < 40) continue;
    const dx = e0.x - b0.x;
    const dy = e0.y - b0.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const w1 = (90 * F) / e0.d;
    const gr = f.createLinearGradient(b0.x, b0.y, e0.x, e0.y);
    gr.addColorStop(0, `rgba(${LT},0.2)`);
    gr.addColorStop(1, `rgba(${LT},0)`);
    f.fillStyle = gr;
    f.beginPath();
    f.moveTo(b0.x - nx * 3, b0.y - ny * 3);
    f.lineTo(b0.x + nx * 3, b0.y + ny * 3);
    f.lineTo(e0.x + nx * w1, e0.y + ny * w1);
    f.lineTo(e0.x - nx * w1, e0.y - ny * w1);
    f.closePath();
    f.fill();
  }
  // 車流（只在中央大道，正對鏡頭不會被樓擋住）
  for (const c of cars) {
    const dir = c.lane < 0 ? -1 : 1;
    c.z += dir * c.v * (still ? 0 : 1 / 60);
    if (c.z > 8600) c.z = 600;
    if (c.z < 600) c.z = 8600;
    if (c.z > ARENA.z - ARENA.r - 30 && c.z < 2300) continue;
    const a = proj(c.lane, 3, c.z);
    const b = proj(c.lane, 3, c.z - dir * 60);
    const k = 1 - fogT(a.d);
    f.strokeStyle = dir < 0 ? `rgba(${LT2},${0.85 * k})` : `rgba(${rgb(N([110, 170, 190]))},${0.6 * k})`;
    f.lineWidth = Math.max(1, Math.min(5, (6 * F) / a.d));
    f.beginPath();
    f.moveTo(a.x, a.y);
    f.lineTo(b.x, b.y);
    f.stroke();
  }
  // 信標
  for (const b of beacons) {
    const on = Math.sin(t * 2.6 + b.p) > 0.55;
    const p = proj(b.x, b.y, b.z);
    const k = 1 - fogT(p.d);
    f.fillStyle = `rgba(${LT2},${(on ? 0.95 : 0.15) * k})`;
    f.beginPath();
    f.arc(p.x, p.y, on ? 2.4 : 1.4, 0, Math.PI * 2);
    f.fill();
    if (on) {
      f.fillStyle = `rgba(${CY},${0.12 * k})`;
      f.beginPath();
      f.arc(p.x, p.y, 6, 0, Math.PI * 2);
      f.fill();
    }
  }
  // 飛行器（拖尾）
  for (const v of flyers) {
    v.x += v.v * (still ? 0 : 1 / 60);
    if (v.x > 3200) v.x = -3200;
    if (v.x < -3200) v.x = 3200;
    const a = proj(v.x, v.y, v.z);
    const b = proj(v.x - v.v * 1.6, v.y, v.z);
    const gr = f.createLinearGradient(a.x, a.y, b.x, b.y);
    gr.addColorStop(0, `rgba(${LT2},0.8)`);
    gr.addColorStop(1, `rgba(${LT2},0)`);
    f.strokeStyle = gr;
    f.lineWidth = 1.5;
    f.beginPath();
    f.moveTo(a.x, a.y);
    f.lineTo(b.x, b.y);
    f.stroke();
  }
  f.globalCompositeOperation = 'source-over';
  // 地標線框：滑鼠移到標籤上時全亮
  for (const [id, l] of Object.entries(LAND)) {
    const col = id === 'rival' ? MG : CY;
    const x0 = l.x - l.w / 2;
    const x1 = l.x + l.w / 2;
    const z0 = l.z - l.d / 2;
    const z1 = l.z + l.d / 2;
    const lit = hot === id ? 1 : id === 'rival' ? 0.75 : 0.5 + 0.12 * Math.sin(t * 2 + l.x);
    const top = [proj(x0, l.h, z0), proj(x1, l.h, z0), proj(x1, l.h, z1), proj(x0, l.h, z1)];
    f.strokeStyle = `rgba(${col},${lit})`;
    f.lineWidth = hot === id ? 2.5 : 1.6;
    polyline(top, true);
    f.stroke();
    f.fillStyle = `rgba(${col},${lit * 0.12})`;
    f.fill();
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x1 > 0 ? x0 : x1, z1]]) {
      const a = proj(cx, l.h, cz);
      const b = proj(cx, l.h * 0.35, cz);
      const gr = f.createLinearGradient(a.x, a.y, b.x, b.y);
      gr.addColorStop(0, `rgba(${col},${lit * 0.8})`);
      gr.addColorStop(1, `rgba(${col},0)`);
      f.strokeStyle = gr;
      f.beginPath();
      f.moveTo(a.x, a.y);
      f.lineTo(b.x, b.y);
      f.stroke();
    }
  }
  f.restore();
  // 屋頂停機坪弧：九段是賽季週次（第 4 週閃）
  const hc = { x: 0, z: -60, r: 272 };
  for (let w = 0; w < 9; w++) {
    const a0 = Math.PI / 2 + ((w - 4.5) * 14 + 1) * (Math.PI / 180);
    const a1 = a0 + 12 * (Math.PI / 180);
    const pts: P2[] = [];
    for (let s = 0; s <= 8; s++) {
      const a = a0 + ((a1 - a0) * s) / 8;
      pts.push(proj(hc.x + hc.r * Math.cos(a), ROOF, hc.z + hc.r * Math.sin(a)));
    }
    f.strokeStyle = w < 3 ? `rgba(${CY},0.8)` : w === 3 ? `rgba(${LT2},${0.5 + 0.5 * Math.sin(t * 5)})` : `rgba(${CY},0.14)`;
    f.lineWidth = 7;
    polyline(pts, false);
    f.stroke();
  }
}
onFrame((t) => frame(still ? 3 : t));

// 雨：細、淡，帶一點中性色相
const RAIN = rgb(N([190, 235, 245]));
const rain = document.getElementById('rain') as HTMLCanvasElement | null;
if (rain) {
  const rg = rain.getContext('2d') as CanvasRenderingContext2D;
  const drops = Array.from({ length: 170 }, (_, i) => ({ x: ((i * 811) % 2100) - 100, y: (i * 467) % 1080, z: 0.3 + ((i * 29) % 10) / 14 }));
  onFrame((_t, mx) => {
    rg.clearRect(0, 0, 1920, 1080);
    for (const d of drops) {
      if (!still) {
        d.y += 20 * d.z;
        d.x -= 4 * d.z;
      }
      if (d.y > 1090) {
        d.y = -40;
        d.x = ((d.x + 1500) % 2100) - 100;
      }
      rg.strokeStyle = `rgba(${RAIN},${0.06 + d.z * 0.08})`;
      rg.lineWidth = d.z * 0.9;
      rg.beginPath();
      rg.moveTo(d.x - mx * 30 * d.z, d.y);
      rg.lineTo(d.x - mx * 30 * d.z - 5 * d.z, d.y + 24 * d.z);
      rg.stroke();
    }
  });
}
