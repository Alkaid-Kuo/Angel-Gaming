// 赤岩（暖土色沙盤）：地圖 theme 為 'redrock' 的調色盤與畫法。新風格＝照這個檔新增一個 theme，在 themes/index.ts 登錄，地圖 JSON 指定 theme，不改引擎也不改 bake.ts。
// 畫法搬自樣張 A（src/web/sketch/shooter/a.ts、world.ts）；座標都是格。
import type { MapDecor } from '../../../shooter/map.ts';
import { LOW_H, WALL_H, hash2, rng, type Zone } from '../materials.ts';
import { cellAt, isWall, type BakeMap, type CellRect, type LowKind } from '../outline.ts';
import type { MapTheme } from './theme.ts';

/** 世界全部在暖土色內，隊色才有飽和度；陰影是偏紫的暖灰，不用黑 */
const WORLD = {
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
  curb: '#d9cdb8',
  curbEdge: 'rgba(96, 74, 62, 0.55)',
  spawnLine: 'rgba(96, 74, 62, 0.5)',
  label: 'rgba(62, 44, 40, 0.74)',
  labelGlow: 'rgba(255, 248, 235, 0.55)',
} as const;

function strip(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

function paintStone(g: CanvasRenderingContext2D, r: CellRect): void {
  g.fillStyle = WORLD.mortar;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  const rowH = 0.8;
  for (let row = Math.floor(r.y0 / rowH); row * rowH < r.y1; row++) {
    const rand = rng(row * 7919 + 11);
    let x = -3 - rand() * 2;
    while (x < r.x1) {
      const len = 1.1 + rand() * 1.1;
      const tone = rand();
      if (x + len > r.x0) {
        g.fillStyle = WORLD.stone[Math.floor(tone * 4)];
        strip(g, x + 0.04, row * rowH + 0.04, len - 0.08, rowH - 0.08, 0.16);
      }
      x += len;
    }
  }
}

function paintDirt(g: CanvasRenderingContext2D, r: CellRect, m: BakeMap): void {
  g.fillStyle = WORLD.dirt;
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
    g.fillStyle = tone < 0.5 ? WORLD.dirtDark : WORLD.dirtLight;
    g.beginPath();
    g.ellipse(x, y, s * sx, s, rot, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function paintWood(g: CanvasRenderingContext2D, r: CellRect): void {
  g.fillStyle = WORLD.woodSeam;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  for (let col = Math.floor(r.x0); col < r.x1; col++) {
    const rand = rng(col * 6133 + 5);
    let y = -6 * rand();
    while (y < r.y1 + 8) {
      const len = 4 + rand() * 6;
      const tone = rand();
      const grain = rand();
      if (y + len > r.y0 && y < r.y1) {
        g.fillStyle = WORLD.wood[Math.floor(tone * 4)];
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
  g.fillStyle = WORLD.mortar;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  for (let y = Math.floor(r.y0 / size); y * size < r.y1; y++) {
    for (let x = Math.floor(r.x0 / size) - 1; x * size < r.x1; x++) {
      const ox = y % 2 === 0 ? 0 : size / 2;
      g.fillStyle = tones[Math.floor(hash2(x, y, 7) * tones.length)];
      strip(g, x * size + ox + 0.03, y * size + 0.03, size - 0.06, size - 0.06, 0.1);
    }
  }
}

function paintTarps(g: CanvasRenderingContext2D, m: BakeMap, decor: MapDecor): void {
  // 市集的帆布攤：平鋪在地上的布；地圖改過、壓到牆或箱子的就不鋪
  for (const { x0: x, y0: y, x1, y1 } of decor.tarps ?? []) {
    const w = x1 - x;
    const h = y1 - y;
    let clear = true;
    for (let j = y; j < y + h && clear; j++) for (let i = x; i < x + w; i++) if (cellAt(m, i, j) !== 0) clear = false;
    if (!clear) continue;
    g.fillStyle = 'rgba(120, 90, 90, 0.25)';
    g.fillRect(x + 0.15, y + 0.2, w, h);
    g.fillStyle = '#e7dcc8';
    g.fillRect(x, y, w, h);
    g.fillStyle = WORLD.paint;
    for (let i = 0; i < w; i += 2) g.fillRect(x + i, y, 1, h);
    g.fillStyle = 'rgba(255, 255, 255, 0.14)';
    g.fillRect(x, y, w, 0.4);
  }
}

/** 屋頂：牆其實是一棟棟房子的屋頂，陶瓦、女兒牆、通風口；玩家走不到，所以壓低對比 */
function paintRoof(g: CanvasRenderingContext2D, m: BakeMap): void {
  g.fillStyle = WORLD.roof;
  g.fillRect(-2, -2, m.width + 4, m.height + 4);
  g.globalAlpha = 0.3;
  g.strokeStyle = WORLD.rimLine;
  g.lineWidth = 0.05;
  g.beginPath();
  for (let y = -2; y < m.height + 2; y += 0.5) {
    g.moveTo(-2, y);
    g.lineTo(m.width + 2, y);
  }
  g.stroke();
  g.globalAlpha = 1;
  // 通風口：遠離牆邊的屋頂才放
  for (let y = 5; y < m.height - 3; y += 5) {
    for (let x = 7; x < m.width - 3; x += 7) {
      if (hash2(x, y, 3) > 0.34) continue;
      let deep = true;
      for (let dy = -8; dy <= 8 && deep; dy++) for (let dx = -8; dx <= 8; dx++) if (!isWall(m, x + dx, y + dy)) deep = false;
      if (!deep) continue;
      g.fillStyle = 'rgba(70, 40, 40, 0.3)';
      g.fillRect(x + 0.16, y + 0.2, 1.4, 1.4);
      g.fillStyle = WORLD.rim;
      g.fillRect(x, y, 1.4, 1.4);
      g.fillStyle = WORLD.side;
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

/** 井：碰撞是牆方塊（decor 的矩形），畫成方形石台裡的圓井；地圖改過、矩形不全是牆就不畫 */
function paintWell(g: CanvasRenderingContext2D, m: BakeMap, r: CellRect): void {
  const { x0: x, y0: y } = r;
  const s = r.x1 - x;
  for (let j = y; j < r.y1; j++) for (let i = x; i < r.x1; i++) if (!isWall(m, i, j)) return;
  g.fillStyle = '#c9bca9';
  strip(g, x, y, s, s - WALL_H * 0.6, 0.25);
  g.fillStyle = '#e3d9c9';
  strip(g, x + 0.06, y + 0.06, s - 0.12, s - WALL_H * 0.6 - 0.2, 0.22);
  const cx = x + s / 2;
  const cy = y + s / 2 - 0.2;
  g.fillStyle = WORLD.rimLine;
  g.beginPath();
  g.arc(cx, cy, (s * 1.08) / 3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2f4a5c';
  g.beginPath();
  g.arc(cx, cy, (s * 0.86) / 3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(190, 225, 240, 0.35)';
  g.beginPath();
  g.ellipse(cx - 0.22, cy - 0.28, 0.34, 0.14, -0.6, 0, Math.PI * 2);
  g.fill();
}

function paintZone(g: CanvasRenderingContext2D, z: Zone, r: CellRect, m: BakeMap, decor: MapDecor): void {
  if (z === 'stone') paintStone(g, r);
  else if (z === 'dirt') paintDirt(g, r, m);
  else if (z === 'wood') paintWood(g, r);
  else if (z === 'plaza') paintSlabs(g, r, WORLD.plaza, 1.8);
  else if (z === 'site') paintSlabs(g, r, WORLD.site, 2.4);
  else {
    paintDirt(g, r, m);
    paintTarps(g, m, decor);
  }
}

function paintLowProp(g: CanvasRenderingContext2D, kind: LowKind, x: number, y: number, w: number, h: number): void {
  if (kind === 'crate') {
    const nx = w >= h ? Math.max(1, Math.round(w / h)) : 1;
    const ny = h > w ? Math.max(1, Math.round(h / w)) : 1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) crate(g, x + (i * w) / nx, y + (j * h) / ny, w / nx, h / ny);
  } else if (kind === 'sand') sandbags(g, x, y, w, h);
  else barrels(g, x, y, w, h);
}

/** 牆邊道具：依材質區挑種類 */
function paintWallProp(g: CanvasRenderingContext2D, z: Zone, x: number, y: number): void {
  if (z === 'wood') barrels(g, x + 0.02, y - 0.1, 1.9, 1.1);
  else if (z === 'stone' || z === 'site') sandbags(g, x, y - 0.1, 2, 1.1);
  else crate(g, x + 0.1, y - 0.1, 1.2, 1.1);
}

export const REDROCK_THEME: MapTheme = {
  id: 'redrock',
  pal: WORLD,
  paintZone,
  paintRoof,
  paintLowProp,
  paintSlopeLow: (g, x, y) => crate(g, x, y, 1, 1),
  paintWallProp,
  paintWell,
};
