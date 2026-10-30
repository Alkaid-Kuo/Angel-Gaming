// 方向 A：俯視戰術沙盤。正俯視、固定西北光，靠牆的側面帶、落影、接觸陰影與分區材質做出厚度；
// 迷霧不是塗黑：視線外換成一張預先烘好的「記憶圖」（去飽和、偏冷的同一張地面）。
// 圖層：地面烘焙 → 記憶圖遮罩 → 牆烘焙 → 單位 → 煙 → 彈道與回饋。烘焙層只在地圖變動時重畫。
import { CALLOUTS, SCENE, UNITS, camRect, makeCanvas, toScreen, worldTransform, type Cam, type Unit } from './scene.ts';
import { mountPage, radarBase, type Direction } from './shell.ts';
import { LOW_RECTS, MAP, hash2, isWall, regionLabels, rng, wallPath, zoneAt, zonePath, type Pt, type Zone } from './world.ts';

/** 調色盤：世界全部在暖土色內，隊色才有飽和度；陰影是偏紫的暖灰，不用黑 */
const PAL = {
  table: '#34292a',
  mortar: '#c3b6a3',
  stone: ['#dcd2c1', '#d5cab7', '#e0d7c8', '#cec2ae'],
  dirt: '#d9c3a0',
  dirtDark: '#c4a97f',
  dirtLight: '#e5d3b5',
  wood: ['#b78f62', '#ad8558', '#c0996c', '#a57c50'],
  woodSeam: '#6d4e39',
  plaza: ['#ddd1bc', '#d6c9b3', '#e2d7c4'],
  site: ['#e4d8c2', '#dfd2ba', '#e9dfcb'],
  paint: '#a2402c',
  roof: '#957063',
  roofMid: '#a4806f',
  roofOuter: '#b3907c',
  rim: '#d6b7a0',
  rimLine: '#6f5048',
  side: '#6f4c4b',
  sideLine: '#56393d',
  shadow: '#a292ab',
  ao: '#8d7b92',
  gold: '#f0b54a',
  goldLight: '#ffd98a',
  goldDark: '#a8742a',
  blue: '#2f8fe0',
  blueLight: '#8fd0ff',
  blueDark: '#17558f',
  ink: '#1d1a22',
  warn: '#e5484d',
} as const;

const SUN = { x: 0.62, y: 0.78 };
const WALL_H = 0.72;
const LOW_H = 0.3;

function strip(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

interface Rc {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function paintStone(g: CanvasRenderingContext2D, r: Rc): void {
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

function paintDirt(g: CanvasRenderingContext2D, r: Rc): void {
  g.fillStyle = PAL.dirt;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  const rand = rng(4242);
  // 大塊低對比色斑 + 細碎石：全圖固定位置，鏡頭內才畫
  for (let i = 0; i < 1600; i++) {
    const x = rand() * 120;
    const y = rand() * 120;
    const big = i % 8 === 0;
    const s = big ? 1.5 + rand() * 3 : 0.05 + rand() * 0.09;
    const tone = rand();
    if (x + s < r.x0 || x - s > r.x1 || y + s < r.y0 || y - s > r.y1) continue;
    g.globalAlpha = big ? 0.22 : 0.55;
    g.fillStyle = tone < 0.5 ? PAL.dirtDark : PAL.dirtLight;
    g.beginPath();
    g.ellipse(x, y, s * (0.8 + rand() * 0.6), s, rand() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function paintWood(g: CanvasRenderingContext2D, r: Rc): void {
  g.fillStyle = PAL.woodSeam;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  const pw = 1;
  for (let col = Math.floor(r.x0 / pw); col * pw < r.x1; col++) {
    const rand = rng(col * 6133 + 5);
    let y = -6 * rand();
    while (y < r.y1 + 8) {
      const len = 4 + rand() * 6;
      const tone = rand();
      const grain = rand();
      if (y + len > r.y0 && y < r.y1) {
        g.fillStyle = PAL.wood[Math.floor(tone * 4)];
        g.fillRect(col * pw + 0.03, y + 0.03, pw - 0.06, len - 0.06);
        // 木紋與釘子
        g.strokeStyle = 'rgba(92, 62, 40, 0.22)';
        g.lineWidth = 0.03;
        g.beginPath();
        g.moveTo(col * pw + 0.3 + grain * 0.4, y + 0.3);
        g.lineTo(col * pw + 0.26 + grain * 0.4, y + len - 0.4);
        g.stroke();
        g.fillStyle = 'rgba(60, 40, 30, 0.45)';
        for (const nx of [0.2, 0.8]) {
          g.beginPath();
          g.arc(col * pw + nx, y + 0.22, 0.04, 0, Math.PI * 2);
          g.fill();
        }
      }
      y += len;
    }
  }
}

function paintSlabs(g: CanvasRenderingContext2D, r: Rc, tones: readonly string[], size: number): void {
  g.fillStyle = PAL.mortar;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  for (let y = Math.floor(r.y0 / size); y * size < r.y1; y++) {
    for (let x = Math.floor(r.x0 / size); x * size < r.x1; x++) {
      const ox = y % 2 === 0 ? 0 : size / 2;
      g.fillStyle = tones[Math.floor(hash2(x, y, 7) * tones.length)];
      strip(g, x * size + ox + 0.03, y * size + 0.03, size - 0.06, size - 0.06, 0.1);
    }
  }
}

function paintMarket(g: CanvasRenderingContext2D, r: Rc): void {
  paintDirt(g, r);
  // 市集的帆布攤：平鋪在地上的布，不是棚頂，才不會蓋住人
  const tarps: readonly (readonly [number, number, number, number])[] = [
    [22, 97, 6, 4],
    [31, 100, 5, 5],
    [16, 105, 7, 4],
    [27, 107, 8, 3],
  ];
  for (const [x, y, w, h] of tarps) {
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

const ZONE_PAINT: Readonly<Record<Zone, (g: CanvasRenderingContext2D, r: Rc) => void>> = {
  stone: paintStone,
  dirt: paintDirt,
  wood: paintWood,
  market: paintMarket,
  plaza: (g, r) => paintSlabs(g, r, PAL.plaza, 1.8),
  site: (g, r) => paintSlabs(g, r, PAL.site, 2.4),
};

/** 不同材質交界的路緣 */
function paintCurbs(g: CanvasRenderingContext2D, r: Rc): void {
  const p = new Path2D();
  for (let y = Math.max(0, r.y0); y < Math.min(MAP.height, r.y1); y++) {
    for (let x = Math.max(0, r.x0); x < Math.min(MAP.width, r.x1); x++) {
      const z = zoneAt(x, y);
      if (z === null || isWall(x, y)) continue;
      const e = zoneAt(x + 1, y);
      const s = zoneAt(x, y + 1);
      if (e !== null && e !== z && !isWall(x + 1, y)) {
        p.moveTo(x + 1, y);
        p.lineTo(x + 1, y + 1);
      }
      if (s !== null && s !== z && !isWall(x, y + 1)) {
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
function paintSites(g: CanvasRenderingContext2D, cam: Cam): void {
  const { c, g: p } = makeCanvas(cam.w, cam.h);
  worldTransform(p, cam);
  p.strokeStyle = PAL.paint;
  p.fillStyle = PAL.paint;
  for (const s of MAP.sites) {
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    // 圓環避開井與石柱
    const cx = s.x0 + w / 2 + (s.id === 'B' ? 3 : -2);
    const cy = s.y0 + h / 2 + (s.id === 'B' ? 2 : 2);
    p.lineWidth = 0.28;
    p.strokeRect(s.x0, s.y0, w, h);
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
    p.lineWidth = 0.42;
    p.beginPath();
    p.arc(cx, cy, 6.4, 0, Math.PI * 2);
    p.stroke();
    p.lineWidth = 0.12;
    p.beginPath();
    p.arc(cx, cy, 5.7, 0, Math.PI * 2);
    p.stroke();
    p.font = '900 8.4px "Barlow Condensed", "Noto Sans TC", sans-serif';
    p.textAlign = 'center';
    p.textBaseline = 'middle';
    p.fillText(s.id, cx, cy + 0.3);
  }
  p.globalCompositeOperation = 'destination-out';
  const rand = rng(90210);
  for (let i = 0; i < 26000; i++) {
    p.globalAlpha = 0.4 + rand() * 0.6;
    p.beginPath();
    p.arc(rand() * 120, rand() * 120, 0.03 + rand() * rand() * 0.34, 0, Math.PI * 2);
    p.fill();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 0.72;
  g.globalCompositeOperation = 'multiply';
  g.drawImage(c, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

/** 地面上的區域名：像噴在地上的路標，壓在記憶圖裡也讀得到 */
function paintCallouts(g: CanvasRenderingContext2D, list: readonly { readonly name: string; readonly x: number; readonly y: number }[], px: number): void {
  g.font = `700 ${px}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const c of list) {
    const label = [...c.name].join(' ');
    g.fillStyle = 'rgba(255, 248, 235, 0.55)';
    g.fillText(label, c.x + 0.05, c.y + 0.06);
    g.fillStyle = 'rgba(62, 44, 40, 0.74)';
    g.fillText(label, c.x, c.y);
  }
}

/** 落影與接觸遮蔽：低解析畫完放大，邊緣自然變柔；牆高與矮牆高用不同投影長度 */
function paintShadows(g: CanvasRenderingContext2D, cam: Cam, wall: Path2D): void {
  const soft = 3;
  const sc: Cam = { ...cam, ppc: cam.ppc / soft, w: Math.ceil(cam.w / soft), h: Math.ceil(cam.h / soft) };
  const { c, g: p } = makeCanvas(sc.w, sc.h);
  p.fillStyle = '#ffffff';
  p.fillRect(0, 0, sc.w, sc.h);
  worldTransform(p, sc);
  p.fillStyle = PAL.shadow;
  for (let i = 1; i <= 10; i++) {
    p.save();
    p.translate(SUN.x * 1.9 * (i / 10), SUN.y * 1.9 * (i / 10));
    p.fill(wall, 'evenodd');
    p.restore();
  }
  for (const r of LOW_RECTS) {
    for (let i = 1; i <= 5; i++) p.fillRect(r.x0 + SUN.x * 0.7 * (i / 5), r.y0 + SUN.y * 0.7 * (i / 5), r.x1 - r.x0, r.y1 - r.y0);
  }
  const ao = 8;
  const ac: Cam = { ...cam, ppc: cam.ppc / ao, w: Math.ceil(cam.w / ao), h: Math.ceil(cam.h / ao) };
  const { c: c2, g: q } = makeCanvas(ac.w, ac.h);
  q.fillStyle = '#ffffff';
  q.fillRect(0, 0, ac.w, ac.h);
  worldTransform(q, ac);
  q.strokeStyle = PAL.ao;
  q.lineWidth = 1.1;
  q.stroke(wall);
  q.fillStyle = PAL.ao;
  q.fill(wall, 'evenodd');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.globalCompositeOperation = 'multiply';
  g.drawImage(c2, 0, 0, cam.w, cam.h);
  g.drawImage(c, 0, 0, cam.w, cam.h);
  g.globalCompositeOperation = 'source-over';
}

function paintFloor(cam: Cam, labels: Parameters<typeof paintCallouts>[1], labelPx: number): HTMLCanvasElement {
  const { c, g } = makeCanvas(cam.w, cam.h);
  worldTransform(g, cam);
  const r = camRect(cam);
  g.fillStyle = PAL.dirt;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  for (const z of ['stone', 'dirt', 'wood', 'market', 'plaza', 'site'] as const) {
    g.save();
    g.clip(zonePath(z));
    ZONE_PAINT[z](g, r);
    g.restore();
  }
  paintCurbs(g, r);
  paintSites(g, cam);
  worldTransform(g, cam);
  paintCallouts(g, labels, labelPx);
  paintShadows(g, cam, wallPath(0.3));
  return c;
}

/** 記憶圖：同一張地面去飽和再乘上偏冷的淡灰。還是白天，只是「現在沒看著」 */
function memoryOf(floor: HTMLCanvasElement): HTMLCanvasElement {
  const { c, g } = makeCanvas(floor.width, floor.height);
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
function paintRoof(g: CanvasRenderingContext2D, r: Rc): void {
  g.fillStyle = PAL.roof;
  g.fillRect(r.x0 - 2, r.y0 - 2, r.x1 - r.x0 + 4, r.y1 - r.y0 + 4);
  g.globalAlpha = 0.3;
  g.strokeStyle = PAL.rimLine;
  g.lineWidth = 0.05;
  g.beginPath();
  for (let y = Math.floor(r.y0 * 2) / 2; y < r.y1 + 2; y += 0.5) {
    g.moveTo(r.x0 - 2, y);
    g.lineTo(r.x1 + 2, y);
  }
  g.stroke();
  g.globalAlpha = 1;
  // 通風口：遠離牆邊的屋頂才放
  for (let y = Math.max(0, r.y0); y < Math.min(MAP.height, r.y1); y += 5) {
    for (let x = Math.max(0, r.x0); x < Math.min(MAP.width, r.x1); x += 7) {
      if (hash2(x, y, 3) > 0.34) continue;
      let deep = true;
      for (let dy = -8; dy <= 8 && deep; dy++) for (let dx = -8; dx <= 8; dx++) if (!isWall(x + dx, y + dy)) deep = false;
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
  g.fillStyle = '#7b5a3e';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#b88d5a';
  g.fillRect(x, y, w, h - LOW_H);
  g.fillStyle = '#cda674';
  g.fillRect(x + 0.1, y + 0.1, w - 0.2, h - LOW_H - 0.2);
  g.strokeStyle = '#8d6a44';
  g.lineWidth = 0.07;
  g.beginPath();
  g.moveTo(x + 0.1, y + 0.1);
  g.lineTo(x + w - 0.1, y + h - LOW_H - 0.1);
  g.moveTo(x + w - 0.1, y + 0.1);
  g.lineTo(x + 0.1, y + h - LOW_H - 0.1);
  g.stroke();
  g.strokeStyle = '#ecd4a8';
  g.lineWidth = 0.05;
  g.beginPath();
  g.moveTo(x + 0.02, y + h - LOW_H - 0.02);
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

/** 矮牆：依位置固定配成箱、沙袋、桶；形狀就是碰撞矩形 */
function paintLow(g: CanvasRenderingContext2D): void {
  LOW_RECTS.forEach((r, i) => {
    const kind = ['crate', 'sand', 'crate', 'barrel', 'sand', 'crate', 'sand', 'crate', 'barrel', 'sand'][i];
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (kind === 'crate') {
      const n = w >= h ? Math.max(1, Math.round(w / h)) : 1;
      for (let k = 0; k < n; k++) crate(g, r.x0 + (k * w) / n, r.y0, w / n, h);
    } else if (kind === 'sand') sandbags(g, r.x0, r.y0, w, h);
    else barrels(g, r.x0, r.y0, w, h);
  });
}

/** 牆邊道具：全部畫在牆格裡（走不到），長在牆腳上；依材質區挑種類 */
function paintWallProps(g: CanvasRenderingContext2D, r: Rc): void {
  for (let y = Math.max(1, r.y0); y < Math.min(MAP.height - 1, r.y1); y++) {
    for (let x = Math.max(1, r.x0); x < Math.min(MAP.width - 2, r.x1); x++) {
      if (!isWall(x, y) || !isWall(x + 1, y) || isWall(x, y + 1) || isWall(x + 1, y + 1)) continue;
      if (hash2(x, y, 77) > 0.13) continue;
      const z = zoneAt(x, y + 1);
      if (z === 'wood') barrels(g, x + 0.02, y - 0.1, 1.9, 1.1);
      else if (z === 'stone' || z === 'site') sandbags(g, x, y - 0.1, 2, 1.1);
      else crate(g, x + 0.1, y - 0.1, 1.2, 1.1);
    }
  }
}

/** B 包點的井：碰撞是 3×3 的方塊，畫成方形石台裡的圓井 */
function paintWell(g: CanvasRenderingContext2D): void {
  const x = 16;
  const y = 18;
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

function paintWalls(cam: Cam): HTMLCanvasElement {
  const { c, g } = makeCanvas(cam.w, cam.h);
  worldTransform(g, cam);
  const r = camRect(cam);
  const wall = wallPath(0.3);
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
  paintRoof(g, r);
  // 一階一階往內退的台地：赤岩鎮的屋頂像層層堆起的土台
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
  paintWell(g);
  paintWallProps(g, r);
  paintLow(g);
  // 地圖外是放沙盤的桌面
  g.fillStyle = PAL.table;
  g.fillRect(r.x0 - 1, r.y0 - 1, -r.x0 + 1, r.y1 - r.y0 + 2);
  g.fillRect(MAP.width, r.y0 - 1, r.x1 - MAP.width + 1, r.y1 - r.y0 + 2);
  g.fillRect(r.x0 - 1, r.y0 - 1, r.x1 - r.x0 + 2, -r.y0 + 1);
  g.fillRect(r.x0 - 1, MAP.height, r.x1 - r.x0 + 2, r.y1 - MAP.height + 1);
  return c;
}

/** 迷霧：低解析遮罩放大取得柔邊，再用它把記憶圖貼上來 */
function paintFog(g: CanvasRenderingContext2D, cam: Cam, memory: HTMLCanvasElement, poly: readonly Pt[]): void {
  const k = 2;
  const low: Cam = { ...cam, ppc: cam.ppc / k, w: cam.w / k, h: cam.h / k };
  const { c: mask, g: m } = makeCanvas(low.w, low.h);
  m.fillStyle = '#000';
  m.fillRect(0, 0, low.w, low.h);
  m.globalCompositeOperation = 'destination-out';
  worldTransform(m, low);
  m.beginPath();
  poly.forEach(([x, y], i) => (i === 0 ? m.moveTo(x, y) : m.lineTo(x, y)));
  m.closePath();
  m.fill();
  const { c: tmp, g: t } = makeCanvas(cam.w, cam.h);
  t.imageSmoothingQuality = 'high';
  t.drawImage(mask, 0, 0, cam.w, cam.h);
  t.globalCompositeOperation = 'source-in';
  t.drawImage(memory, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(tmp, 0, 0);
  // 視線邊界一條細亮線，像日光切過地面
  worldTransform(g, cam);
  g.beginPath();
  poly.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.closePath();
  g.strokeStyle = 'rgba(255, 246, 222, 0.5)';
  g.lineWidth = 0.07;
  g.lineJoin = 'round';
  g.stroke();
}

const LIGHT = { x: -SUN.x, y: -SUN.y };
/** 模型放大倍率：碰撞半徑 0.3 格在畫面上才 8 px，放大到肩寬約 1 格才讀得出姿態（命中判定不變） */
const BODY = 1.36;

/** 模型兵：底座＋肩膀＋手臂與槍＋頭。隊色在底座環與肩膀，明暗永遠跟著世界的西北光，不跟著身體轉 */
function paintSoldier(g: CanvasRenderingContext2D, u: Unit): void {
  const us = u.team === 'T';
  const main = us ? PAL.gold : PAL.blue;
  const dark = us ? PAL.goldDark : PAL.blueDark;
  const light = us ? PAL.goldLight : PAL.blueLight;
  const cloth = us ? '#6d4c22' : '#0f3050';
  const shadeOf = us ? '#c98f33' : '#2271b8';
  const helmet = us ? '#fff3d9' : '#e3f1fb';
  const helmetDark = us ? '#d3b98c' : '#9fc0d8';
  const a = (u.facing * Math.PI) / 180;
  // 接觸陰影
  g.save();
  const sr = 0.72 * BODY;
  const sg = g.createRadialGradient(u.x + 0.18, u.y + 0.24, 0.1, u.x + 0.18, u.y + 0.24, sr);
  sg.addColorStop(0, 'rgba(58, 38, 62, 0.6)');
  sg.addColorStop(0.65, 'rgba(58, 38, 62, 0.34)');
  sg.addColorStop(1, 'rgba(58, 38, 62, 0)');
  g.fillStyle = sg;
  g.beginPath();
  g.arc(u.x + 0.18, u.y + 0.24, sr, 0, Math.PI * 2);
  g.fill();
  // 底座：比身體大一圈的隊色圓盤，側面一圈暗色當厚度
  g.fillStyle = cloth;
  g.beginPath();
  g.arc(u.x, u.y + 0.08, 0.5 * BODY, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = dark;
  g.beginPath();
  g.arc(u.x, u.y, 0.5 * BODY, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = main;
  g.lineWidth = 0.09;
  g.beginPath();
  g.arc(u.x, u.y, 0.47 * BODY, 0, Math.PI * 2);
  g.stroke();
  // 身體座標：+x 朝前
  g.translate(u.x, u.y);
  g.rotate(a);
  g.scale(BODY, BODY);
  const lx = LIGHT.x * Math.cos(-a) - LIGHT.y * Math.sin(-a);
  const ly = LIGHT.x * Math.sin(-a) + LIGHT.y * Math.cos(-a);
  const shade = (path: Path2D, color: string): void => {
    // 背光的一半壓暗：用一條跟世界光垂直的直線切開
    g.save();
    g.clip(path);
    g.fillStyle = color;
    g.beginPath();
    g.rect(-1.5, -1.5, 3, 3);
    g.rect(-1.5 + lx * 1.55, -1.5 + ly * 1.55, 3, 3);
    g.fill('evenodd');
    g.restore();
  };
  // 背包
  const pack = new Path2D();
  pack.roundRect(-0.36, -0.2, 0.26, 0.4, 0.07);
  g.fillStyle = cloth;
  g.fill(pack);
  // 炸彈揹在背上
  if (u.bomb === true) {
    g.fillStyle = PAL.warn;
    g.fill(pack);
  }
  // 槍：槍身粗、槍管細，長度分武器
  const tip = 0.5 + u.gun * 0.72;
  g.fillStyle = '#25222a';
  strip(g, 0.1, 0.0, 0.5, 0.15, 0.04);
  g.fillRect(0.5, 0.04, tip - 0.5, 0.07);
  g.fillStyle = '#6d6875';
  g.fillRect(0.16, 0.025, 0.4, 0.03);
  // 手臂與手
  g.lineCap = 'round';
  g.strokeStyle = shadeOf;
  g.lineWidth = 0.15;
  g.beginPath();
  g.moveTo(0, -0.33);
  g.lineTo(0.5, 0.04);
  g.moveTo(0, 0.33);
  g.lineTo(0.2, 0.1);
  g.stroke();
  g.fillStyle = helmetDark;
  for (const [hx, hy] of [
    [0.51, 0.05],
    [0.21, 0.09],
  ] as const) {
    g.beginPath();
    g.arc(hx, hy, 0.085, 0, Math.PI * 2);
    g.fill();
  }
  // 肩膀兩階明暗
  const body = new Path2D();
  body.roundRect(-0.17, -0.41, 0.34, 0.82, 0.16);
  g.fillStyle = main;
  g.fill(body);
  shade(body, shadeOf);
  g.strokeStyle = light;
  g.lineWidth = 0.035;
  g.stroke(body);
  // 頭：淺色頭盔，和深色身體分開，朝向一眼看得出
  const head = new Path2D();
  head.ellipse(0.05, 0, 0.215, 0.195, 0, 0, Math.PI * 2);
  g.fillStyle = helmet;
  g.fill(head);
  shade(head, helmetDark);
  g.fillStyle = 'rgba(255, 255, 255, 0.8)';
  g.beginPath();
  g.arc(0.05 + lx * 0.1, ly * 0.1, 0.05, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function paintTag(g: CanvasRenderingContext2D, cam: Cam, u: Unit): void {
  const [sx, sy] = toScreen(cam, u.x, u.y);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (u.self === true) {
    g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    g.lineWidth = 2;
    g.setLineDash([6, 5]);
    g.beginPath();
    g.arc(sx, sy, 27, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  } else if (u.team === 'T') {
    g.font = '700 14px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.lineJoin = 'round';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(29, 26, 34, 0.75)';
    g.strokeText(u.name, sx, sy - 30);
    g.fillStyle = '#fff6e2';
    g.fillText(u.name, sx, sy - 30);
    const bw = 30;
    g.fillStyle = 'rgba(29, 26, 34, 0.75)';
    g.fillRect(sx - bw / 2 - 1, sy - 29, bw + 2, 5);
    g.fillStyle = PAL.gold;
    g.fillRect(sx - bw / 2, sy - 28, (bw * u.hp) / 100, 3);
  }
}

/** 煙：一團不透明的體積，上面堆一層層亮面朝西北的團塊 */
function paintSmoke(g: CanvasRenderingContext2D, cam: Cam): void {
  worldTransform(g, cam);
  const s = SCENE.smoke;
  const sg = g.createRadialGradient(s.x + 0.8, s.y + 1, s.r * 0.5, s.x + 0.8, s.y + 1, s.r * 1.35);
  sg.addColorStop(0, 'rgba(70, 58, 82, 0.5)');
  sg.addColorStop(1, 'rgba(70, 58, 82, 0)');
  g.fillStyle = sg;
  g.beginPath();
  g.arc(s.x + 0.8, s.y + 1, s.r * 1.35, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#d7d5da';
  g.beginPath();
  g.arc(s.x, s.y, s.r * 0.96, 0, Math.PI * 2);
  g.fill();
  const rand = rng(1234);
  const puffs: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 64; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * s.r * 0.9;
    puffs.push({ x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d, r: 0.62 + rand() * 0.72 });
  }
  puffs.sort((p, q) => p.y + p.x - (q.y + q.x));
  for (const p of puffs) {
    const pg = g.createRadialGradient(p.x - p.r * 0.34, p.y - p.r * 0.42, p.r * 0.05, p.x, p.y, p.r);
    pg.addColorStop(0, '#fbfaf8');
    pg.addColorStop(0.55, '#ecebed');
    pg.addColorStop(0.92, '#c6c4cf');
    pg.addColorStop(1, 'rgba(190, 187, 200, 0)');
    g.fillStyle = pg;
    g.beginPath();
    g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    g.fill();
  }
}

function paintGrenade(g: CanvasRenderingContext2D, cam: Cam): void {
  const n = SCENE.grenade;
  worldTransform(g, cam);
  // 落地揚起的塵
  const rand = rng(77);
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2;
    const d = 0.3 + rand() * 0.55;
    g.fillStyle = `rgba(232, 218, 195, ${0.25 + rand() * 0.45})`;
    g.beginPath();
    g.arc(n.x + Math.cos(a) * d, n.y + Math.sin(a) * d, 0.08 + rand() * 0.12, 0, Math.PI * 2);
    g.fill();
  }
  for (const [r, al] of [
    [0.62, 0.95],
    [0.95, 0.5],
    [1.3, 0.22],
  ] as const) {
    g.strokeStyle = `rgba(229, 72, 77, ${al})`;
    g.lineWidth = 0.075;
    g.beginPath();
    g.arc(n.x, n.y, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = 'rgba(58, 38, 62, 0.5)';
  g.beginPath();
  g.arc(n.x + 0.1, n.y + 0.13, 0.3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#34402f';
  g.beginPath();
  g.arc(n.x, n.y, 0.28, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#c8ccc4';
  g.fillRect(n.x - 0.08, n.y - 0.4, 0.16, 0.18);
  g.fillStyle = 'rgba(255, 255, 255, 0.55)';
  g.beginPath();
  g.arc(n.x - 0.09, n.y - 0.09, 0.08, 0, Math.PI * 2);
  g.fill();
}

function muzzle(g: CanvasRenderingContext2D, x: number, y: number, a: number, s: number): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  const glow = g.createRadialGradient(x, y, 0, x, y, s * 3.2);
  glow.addColorStop(0, 'rgba(255, 225, 150, 0.75)');
  glow.addColorStop(1, 'rgba(255, 190, 90, 0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(x, y, s * 3.2, 0, Math.PI * 2);
  g.fill();
  g.translate(x, y);
  g.rotate(a);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const b = (i * Math.PI) / 5;
    const r = i === 0 ? s * 2 : i % 2 === 0 ? s * 0.95 : s * 0.36;
    if (i === 0) g.moveTo(Math.cos(b) * r, Math.sin(b) * r);
    else g.lineTo(Math.cos(b) * r, Math.sin(b) * r);
  }
  g.closePath();
  g.fillStyle = '#ffd27a';
  g.fill();
  g.scale(0.55, 0.55);
  g.fillStyle = '#fffbe9';
  g.fill();
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function paintFire(g: CanvasRenderingContext2D, cam: Cam): void {
  const t = SCENE.tracer;
  const [ax, ay] = toScreen(cam, t.x0, t.y0);
  const [bx, by] = toScreen(cam, t.x1, t.y1);
  const a = Math.atan2(by - ay, bx - ax);
  const start = 44;
  const len = Math.hypot(bx - ax, by - ay);
  const headD = start + (len - start) * t.head;
  const tailD = Math.max(start, headD - 230);
  const hx = ax + Math.cos(a) * headD;
  const hy = ay + Math.sin(a) * headD;
  const tx = ax + Math.cos(a) * tailD;
  const ty = ay + Math.sin(a) * tailD;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.lineCap = 'round';
  // 亮地面上亮線看不清楚，底下先壓一道暗影
  const under = g.createLinearGradient(tx, ty, hx, hy);
  under.addColorStop(0, 'rgba(70, 40, 40, 0)');
  under.addColorStop(1, 'rgba(60, 30, 30, 0.72)');
  g.strokeStyle = under;
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(tx, ty);
  g.lineTo(hx, hy);
  g.stroke();
  const core = g.createLinearGradient(tx, ty, hx, hy);
  core.addColorStop(0, 'rgba(255, 130, 40, 0)');
  core.addColorStop(0.45, 'rgba(255, 150, 50, 0.95)');
  core.addColorStop(0.8, '#ffd27a');
  core.addColorStop(1, '#fffbe9');
  g.strokeStyle = core;
  g.lineWidth = 4;
  g.stroke();
  const hg = g.createRadialGradient(hx, hy, 0, hx, hy, 14);
  hg.addColorStop(0, 'rgba(255, 244, 205, 0.95)');
  hg.addColorStop(1, 'rgba(255, 200, 110, 0)');
  g.fillStyle = hg;
  g.beginPath();
  g.arc(hx, hy, 14, 0, Math.PI * 2);
  g.fill();
  muzzle(g, ax + Math.cos(a) * 44, ay + Math.sin(a) * 44, a, 12);
  // 鐵壁的回擊
  const foe = UNITS.find((u) => u.name === '鐵壁') as Unit;
  const [fx, fy] = toScreen(cam, foe.x, foe.y);
  const fa = (foe.facing * Math.PI) / 180;
  muzzle(g, fx + Math.cos(fa) * 44, fy + Math.sin(fa) * 44, fa, 10);
  // 傷害數字：打中的地方往上飄
  const [px, py] = toScreen(cam, SCENE.pop.x, SCENE.pop.y);
  g.font = '800 italic 30px "Barlow Condensed", sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(29, 26, 34, 0.85)';
  g.strokeText(String(SCENE.pop.amount), px + 22, py - 18);
  g.fillStyle = '#ffffff';
  g.fillText(String(SCENE.pop.amount), px + 22, py - 18);
}

function paintCrosshair(g: CanvasRenderingContext2D, cam: Cam): void {
  const [x, y] = toScreen(cam, SCENE.aim.x + 0.2, SCENE.aim.y + 0.1);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.beginPath();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    g.moveTo(x + dx * 24, y + dy * 24);
    g.lineTo(x + dx * 36, y + dy * 36);
  }
  g.strokeStyle = '#ffffff';
  g.lineWidth = 4;
  g.stroke();
  g.strokeStyle = PAL.ink;
  g.lineWidth = 2;
  g.stroke();
}

function vignette(g: CanvasRenderingContext2D, cam: Cam): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  const v = g.createRadialGradient(cam.w / 2, cam.h / 2, cam.h * 0.62, cam.w / 2, cam.h / 2, cam.w * 0.64);
  v.addColorStop(0, 'rgba(50, 34, 44, 0)');
  v.addColorStop(1, 'rgba(50, 34, 44, 0.34)');
  g.fillStyle = v;
  g.fillRect(0, 0, cam.w, cam.h);
}

const direction: Direction = {
  id: 'a',
  paintScene(g) {
    const cam = SCENE.cam;
    const floor = paintFloor(cam, CALLOUTS, 0.72);
    const walls = paintWalls(cam);
    g.drawImage(floor, 0, 0);
    paintFog(g, cam, memoryOf(floor), SCENE.vision);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(walls, 0, 0);
    paintGrenade(g, cam);
    for (const u of UNITS) {
      worldTransform(g, cam);
      paintSoldier(g, u);
      paintTag(g, cam, u);
    }
    paintSmoke(g, cam);
    paintFire(g, cam);
    paintCrosshair(g, cam);
    vignette(g, cam);
  },
  paintOverview(g) {
    const cam: Cam = { cx: 60, cy: 60, ppc: 9, w: 1920, h: 1080 };
    g.drawImage(paintFloor(cam, regionLabels(), 1.6), 0, 0);
    g.drawImage(paintWalls(cam), 0, 0);
  },
  paintRadar(g, size) {
    radarBase(g, size, '#141821', '#3a4252', 'rgba(240, 181, 74, 0.2)');
    const k = size / MAP.width;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.fillStyle = 'rgba(238, 242, 246, 0.2)';
    g.beginPath();
    SCENE.vision.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(238, 242, 246, 0.55)';
    g.beginPath();
    g.arc(SCENE.smoke.x, SCENE.smoke.y, SCENE.smoke.r, 0, Math.PI * 2);
    g.fill();
    for (const u of UNITS) {
      g.fillStyle = u.team === 'T' ? PAL.gold : PAL.blueLight;
      g.beginPath();
      g.arc(u.x, u.y, u.self === true ? 2.1 : 1.6, 0, Math.PI * 2);
      g.fill();
      if (u.self === true) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 0.6;
        g.stroke();
      }
    }
    g.fillStyle = '#eef2f6';
    g.font = '900 7px "Barlow Condensed", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const s of MAP.sites) g.fillText(s.id, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
  },
};

void mountPage(direction, ['900 20px "Barlow Condensed"', '700 20px "Noto Sans TC"']);
