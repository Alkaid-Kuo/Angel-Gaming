// 方向 C：極簡幾何。八色以內、只用直線與圓，語言是建築平面圖＋戰術圖：牆是填色的剖面（poché）、地面留白、資訊靠線寬分級。
// 「太空像原型」的解法不是加材質，而是加精度：三級線寬（牆 2.5 px、結構 1.5 px、輔助 1 px）、固定 5 格的十字點陣、
// 視錐上的距離環與刻度、單位旁的引線標註。迷霧＝換成淺一階的底色加細斜線。
import { CALLOUTS, SCENE, UNITS, camRect, makeCanvas, toScreen, worldTransform, type Cam, type Unit } from './scene.ts';
import { mountPage, radarBase, type Direction } from './shell.ts';
import { LOW_RECTS, MAP, isWall, regionLabels, wallPath, zoneAt, type Pt } from './world.ts';

/** 顏色職責：每個顏色只做一件事 */
const PAL = {
  /** 看得見的地面 */
  paper: '#f7f4ec',
  /** 看不見的地面、輔助線 */
  tone: '#e3ded2',
  /** 牆 */
  stone: '#b7b2a6',
  /** 墨線與文字 */
  ink: '#2a2d34',
  /** 我方 */
  gold: '#eca61f',
  /** 對手 */
  blue: '#1f6fc4',
  /** 危險與傷害 */
  red: '#dd4148',
  /** 煙、面板底 */
  white: '#ffffff',
} as const;

const LABEL = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
const NUM = '"Barlow Condensed", "Noto Sans TC", sans-serif';

/** 線寬用螢幕像素，鏡頭比例換算成世界單位 */
const lw = (cam: Cam, px: number): number => px / cam.ppc;

function paintFloor(cam: Cam): HTMLCanvasElement {
  const { c, g } = makeCanvas(cam.w, cam.h);
  worldTransform(g, cam);
  const r = camRect(cam);
  g.fillStyle = PAL.paper;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  // 5 格十字點陣：這張圖有比例尺
  g.strokeStyle = PAL.stone;
  g.lineWidth = lw(cam, 1);
  const p = new Path2D();
  const arm = 0.22;
  for (let y = Math.floor(r.y0 / 5) * 5; y < r.y1; y += 5) {
    for (let x = Math.floor(r.x0 / 5) * 5; x < r.x1; x += 5) {
      p.moveTo(x - arm, y);
      p.lineTo(x + arm, y);
      p.moveTo(x, y - arm);
      p.lineTo(x, y + arm);
    }
  }
  g.stroke(p);
  // 區域交界：一條細虛線，材質差異交給標註
  const seam = new Path2D();
  for (let y = Math.max(0, r.y0); y < Math.min(MAP.height, r.y1); y++) {
    for (let x = Math.max(0, r.x0); x < Math.min(MAP.width, r.x1); x++) {
      const z = zoneAt(x, y);
      if (z === null || isWall(x, y)) continue;
      const e = zoneAt(x + 1, y);
      const s = zoneAt(x, y + 1);
      if (e !== null && e !== z && !isWall(x + 1, y)) {
        seam.moveTo(x + 1, y);
        seam.lineTo(x + 1, y + 1);
      }
      if (s !== null && s !== z && !isWall(x, y + 1)) {
        seam.moveTo(x, y + 1);
        seam.lineTo(x + 1, y + 1);
      }
    }
  }
  g.strokeStyle = PAL.stone;
  g.lineWidth = lw(cam, 1.5);
  g.setLineDash([0.5, 0.5]);
  g.stroke(seam);
  g.setLineDash([]);
  // 包點：同心圓與十字定位，字母是唯一的大字
  for (const s of MAP.sites) {
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    const cx = s.x0 + w / 2 + (s.id === 'B' ? 3 : -2);
    const cy = s.y0 + h / 2 + 2;
    g.strokeStyle = PAL.ink;
    g.lineWidth = lw(cam, 1.5);
    g.strokeRect(s.x0, s.y0, w, h);
    g.lineWidth = lw(cam, 1);
    for (const rr of [3.6, 5.4, 7.2]) {
      g.beginPath();
      g.arc(cx, cy, rr, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      g.moveTo(cx + dx * 3.6, cy + dy * 3.6);
      g.lineTo(cx + dx * 8, cy + dy * 8);
    }
    g.stroke();
    g.fillStyle = PAL.ink;
    g.font = `600 6.4px ${NUM}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.id, cx, cy + 0.2);
  }
  return c;
}

function paintWalls(cam: Cam): HTMLCanvasElement {
  const { c, g } = makeCanvas(cam.w, cam.h);
  worldTransform(g, cam);
  const r = camRect(cam);
  const wall = wallPath(0);
  g.lineJoin = 'miter';
  g.fillStyle = PAL.stone;
  g.fill(wall, 'evenodd');
  // 內縮的兩圈淺色線：牆的剖面有厚度，靠線不靠陰影
  g.save();
  g.clip(wall, 'evenodd');
  g.strokeStyle = PAL.tone;
  for (const w of [1.6, 4.8]) {
    g.lineWidth = w + lw(cam, 1);
    g.stroke(wall);
    g.lineWidth = w;
    g.strokeStyle = PAL.stone;
    g.stroke(wall);
    g.strokeStyle = PAL.tone;
  }
  g.restore();
  g.strokeStyle = PAL.ink;
  g.lineWidth = lw(cam, 2.5);
  g.stroke(wall);
  // 矮牆：白底空心框加一條對角線。和牆「填滿」相對，一眼知道比牆低
  g.fillStyle = PAL.white;
  g.strokeStyle = PAL.ink;
  for (const b of LOW_RECTS) {
    g.lineWidth = lw(cam, 2);
    g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    g.lineWidth = lw(cam, 1);
    g.beginPath();
    g.moveTo(b.x0, b.y1);
    g.lineTo(b.x1, b.y0);
    g.stroke();
  }
  // 井
  g.fillStyle = PAL.white;
  g.lineWidth = lw(cam, 2);
  g.fillRect(16, 18, 3, 3);
  g.strokeRect(16, 18, 3, 3);
  g.lineWidth = lw(cam, 1);
  g.beginPath();
  g.arc(17.5, 19.5, 1.1, 0, Math.PI * 2);
  g.stroke();
  // 地圖外退成底色
  g.fillStyle = PAL.ink;
  g.fillRect(r.x0 - 1, r.y0 - 1, -r.x0 + 1, r.y1 - r.y0 + 2);
  g.fillRect(MAP.width, r.y0 - 1, r.x1 - MAP.width + 1, r.y1 - r.y0 + 2);
  g.fillRect(r.x0 - 1, r.y0 - 1, r.x1 - r.x0 + 2, -r.y0 + 1);
  g.fillRect(r.x0 - 1, MAP.height, r.x1 - r.x0 + 2, r.y1 - MAP.height + 1);
  return c;
}

/** 迷霧：底色換 tone、加斜線，視線內挖開 */
function paintFog(g: CanvasRenderingContext2D, cam: Cam, poly: readonly Pt[]): void {
  const size = 10;
  const { c: tile, g: t } = makeCanvas(size, size);
  t.fillStyle = PAL.tone;
  t.fillRect(0, 0, size, size);
  t.strokeStyle = PAL.stone;
  t.lineWidth = 1;
  t.beginPath();
  for (let i = -size; i <= size; i += size) {
    t.moveTo(i, size);
    t.lineTo(i + size, 0);
  }
  t.stroke();
  const { c: fog, g: f } = makeCanvas(cam.w, cam.h);
  f.fillStyle = f.createPattern(tile, 'repeat') as CanvasPattern;
  f.globalAlpha = 0.82;
  f.fillRect(0, 0, cam.w, cam.h);
  f.globalAlpha = 1;
  f.globalCompositeOperation = 'destination-out';
  worldTransform(f, cam);
  const path = new Path2D();
  poly.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  path.closePath();
  f.fill(path);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(fog, 0, 0);
  worldTransform(g, cam);
  g.strokeStyle = PAL.ink;
  g.lineWidth = lw(cam, 1.5);
  g.lineJoin = 'miter';
  g.stroke(path);
  // 距離環：10、20 格，只畫在視線內
  g.save();
  g.clip(path);
  g.strokeStyle = PAL.stone;
  g.lineWidth = lw(cam, 1);
  g.setLineDash([0.28, 0.28]);
  for (const r of [10, 20]) {
    g.beginPath();
    g.arc(SCENE.me.x, SCENE.me.y, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);
  g.restore();
}

function angleTip(g: CanvasRenderingContext2D, x: number, y: number, a: number, r: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x + Math.cos(a) * (r + 0.46), y + Math.sin(a) * (r + 0.46));
  g.lineTo(x + Math.cos(a + 0.62) * (r + 0.04), y + Math.sin(a + 0.62) * (r + 0.04));
  g.lineTo(x + Math.cos(a - 0.62) * (r + 0.04), y + Math.sin(a - 0.62) * (r + 0.04));
  g.closePath();
  g.fill();
}

/** 我方：金色實心圓；對手：藍色實心方（轉 45°）。形狀本身就是第二辨識通道，色覺障礙也分得出 */
function paintMark(g: CanvasRenderingContext2D, cam: Cam, u: Unit): void {
  const us = u.team === 'T';
  const a = (u.facing * Math.PI) / 180;
  const color = us ? PAL.gold : PAL.blue;
  const r = 0.56;
  worldTransform(g, cam);
  // 武器：一條線，長度即武器
  g.strokeStyle = PAL.ink;
  g.lineWidth = lw(cam, 2.5);
  g.lineCap = 'butt';
  g.beginPath();
  g.moveTo(u.x + Math.cos(a) * r, u.y + Math.sin(a) * r);
  g.lineTo(u.x + Math.cos(a) * (r + 0.46 + u.gun * 0.9), u.y + Math.sin(a) * (r + 0.46 + u.gun * 0.9));
  g.stroke();
  angleTip(g, u.x, u.y, a, r, color);
  g.fillStyle = color;
  g.strokeStyle = PAL.white;
  g.lineWidth = lw(cam, 2);
  g.beginPath();
  if (us) g.arc(u.x, u.y, r, 0, Math.PI * 2);
  else {
    const k = r * 1.18;
    g.moveTo(u.x + k, u.y);
    g.lineTo(u.x, u.y + k);
    g.lineTo(u.x - k, u.y);
    g.lineTo(u.x, u.y - k);
    g.closePath();
  }
  g.fill();
  g.stroke();
  if (u.bomb === true) {
    g.fillStyle = PAL.ink;
    g.fillRect(u.x - 0.19, u.y - 0.19, 0.38, 0.38);
  }
  if (u.self === true) {
    g.strokeStyle = PAL.ink;
    g.lineWidth = lw(cam, 1.5);
    g.beginPath();
    g.arc(u.x, u.y, r + 0.3, 0, Math.PI * 2);
    g.stroke();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (us && u.self !== true) annotate(g, cam, u.x, u.y, 1, u.name, String(u.hp));
}

/** 引線標註：從點拉一條 45° 線到文字 */
function annotate(g: CanvasRenderingContext2D, cam: Cam, x: number, y: number, dir: 1 | -1, text: string, value: string, color: string = PAL.ink): void {
  const [sx, sy] = toScreen(cam, x, y);
  const ex = sx + dir * 24;
  const ey = sy - 24;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 1;
  g.font = `500 13px ${LABEL}`;
  const w = g.measureText(text).width;
  g.font = `600 16px ${NUM}`;
  const vw = value === '' ? 0 : g.measureText(value).width + 6;
  const lineTo = ex + dir * (w + vw + 8);
  g.beginPath();
  g.moveTo(sx + dir * 12, sy - 12);
  g.lineTo(ex, ey);
  g.lineTo(lineTo, ey);
  g.stroke();
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const tx = dir === 1 ? ex + 4 : lineTo + 4;
  g.fillStyle = PAL.white;
  g.fillRect(tx - 3, ey - 18, w + vw + 6, 17);
  g.font = `500 13px ${LABEL}`;
  g.fillStyle = PAL.ink;
  g.fillText(text, tx, ey - 4);
  g.font = `600 16px ${NUM}`;
  g.fillStyle = color;
  g.fillText(value, tx + w + 6, ey - 4);
}

function paintSmoke(g: CanvasRenderingContext2D, cam: Cam): void {
  const s = SCENE.smoke;
  worldTransform(g, cam);
  g.fillStyle = PAL.white;
  g.beginPath();
  g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = PAL.stone;
  g.lineWidth = lw(cam, 1);
  g.beginPath();
  for (let y = s.y - s.r; y < s.y + s.r; y += 0.42) {
    g.moveTo(s.x - s.r, y);
    g.lineTo(s.x + s.r, y);
  }
  g.stroke();
  g.restore();
  g.strokeStyle = PAL.ink;
  g.lineWidth = lw(cam, 2);
  g.beginPath();
  g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
  g.stroke();
  annotate(g, cam, s.x + s.r * 0.72, s.y - s.r * 0.72, 1, '煙霧', '14s');
}

function paintGrenade(g: CanvasRenderingContext2D, cam: Cam): void {
  const n = SCENE.grenade;
  worldTransform(g, cam);
  g.strokeStyle = PAL.red;
  g.lineWidth = lw(cam, 2);
  g.beginPath();
  g.arc(n.x, n.y, 0.62, -Math.PI / 2, Math.PI * 1.1);
  g.stroke();
  g.fillStyle = PAL.red;
  g.beginPath();
  g.arc(n.x, n.y, 0.22, 0, Math.PI * 2);
  g.fill();
  g.setLineDash([0.2, 0.28]);
  g.lineWidth = lw(cam, 1);
  g.beginPath();
  g.arc(n.x, n.y, 3.5, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  annotate(g, cam, n.x - 0.4, n.y - 0.4, -1, '手雷', '', PAL.red);
}

function paintFire(g: CanvasRenderingContext2D, cam: Cam): void {
  const t = SCENE.tracer;
  const [ax, ay] = toScreen(cam, t.x0, t.y0);
  const [bx, by] = toScreen(cam, t.x1, t.y1);
  const a = Math.atan2(by - ay, bx - ax);
  const len = Math.hypot(bx - ax, by - ay);
  const start = 46;
  const head = start + (len - start) * t.head;
  g.setTransform(1, 0, 0, 1, ax, ay);
  g.rotate(a);
  // 彈道：實線彈頭＋往後變短的節拍，靠節奏表現速度
  g.fillStyle = PAL.ink;
  g.fillRect(head - 72, -1.5, 72, 3);
  let x = head - 82;
  for (const w of [34, 20, 10, 5]) {
    g.fillRect(x - w, -1, w, 2);
    x -= w + 10;
  }
  g.fillStyle = PAL.gold;
  g.fillRect(head - 10, -2.5, 16, 5);
  // 槍口：三條放射短線
  g.strokeStyle = PAL.ink;
  g.lineWidth = 2;
  g.beginPath();
  for (const b of [-0.6, 0, 0.6]) {
    g.moveTo(start - 6 + Math.cos(b) * 8, Math.sin(b) * 8);
    g.lineTo(start - 6 + Math.cos(b) * 20, Math.sin(b) * 20);
  }
  g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0);
  // 命中：紅色 X 與數字
  const [px, py] = toScreen(cam, SCENE.pop.x, SCENE.pop.y);
  g.strokeStyle = PAL.red;
  g.lineWidth = 3;
  g.beginPath();
  for (const [dx, dy] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    g.moveTo(px + dx * 21, py + dy * 21);
    g.lineTo(px + dx * 30, py + dy * 30);
  }
  g.stroke();
  annotate(g, cam, SCENE.pop.x + 0.9, SCENE.pop.y - 0.9, 1, '命中', `−${SCENE.pop.amount}`, PAL.red);
}

function paintCaptions(g: CanvasRenderingContext2D, cam: Cam, list: readonly { readonly name: string; readonly x: number; readonly y: number }[], px: number): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.font = `500 ${px}px ${LABEL}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const c of list) {
    const [sx, sy] = toScreen(cam, c.x, c.y);
    const label = [...c.name].join(' ');
    const w = g.measureText(label).width + 10;
    g.fillStyle = PAL.paper;
    g.fillRect(sx - w / 2, sy - px * 0.72, w, px * 1.44);
    g.fillStyle = PAL.ink;
    g.fillText(label, sx, sy + 1);
  }
}

/** 比例尺：這張圖量得出距離 */
function paintScale(g: CanvasRenderingContext2D, cam: Cam): void {
  const w = cam.ppc * 10;
  const x = cam.w / 2 - w / 2;
  const y = cam.h - 30;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = PAL.white;
  g.fillRect(x - 12, y - 18, w + 24, 30);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(x, y - 5);
  g.lineTo(x, y + 2);
  g.lineTo(x + w, y + 2);
  g.lineTo(x + w, y - 5);
  g.moveTo(x + w / 2, y - 3);
  g.lineTo(x + w / 2, y + 2);
  g.stroke();
  g.fillStyle = PAL.ink;
  g.font = `600 13px ${NUM}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText('10 格', x + w / 2, y - 6);
}

const direction: Direction = {
  id: 'c',
  paintScene(g) {
    const cam = SCENE.cam;
    g.drawImage(paintFloor(cam), 0, 0);
    paintFog(g, cam, SCENE.vision);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(paintWalls(cam), 0, 0);
    paintCaptions(g, cam, CALLOUTS, 14);
    paintGrenade(g, cam);
    for (const u of UNITS) paintMark(g, cam, u);
    paintSmoke(g, cam);
    paintFire(g, cam);
    paintScale(g, cam);
  },
  paintOverview(g) {
    const cam: Cam = { cx: 60, cy: 60, ppc: 9, w: 1920, h: 1080 };
    g.drawImage(paintFloor(cam), 0, 0);
    g.drawImage(paintWalls(cam), 0, 0);
    paintCaptions(g, cam, regionLabels(), 12);
  },
  paintRadar(g, size) {
    radarBase(g, size, PAL.stone, PAL.paper, PAL.tone);
    const k = size / MAP.width;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.strokeStyle = PAL.ink;
    g.lineWidth = 0.5;
    g.beginPath();
    SCENE.vision.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
    g.closePath();
    g.stroke();
    g.beginPath();
    g.arc(SCENE.smoke.x, SCENE.smoke.y, SCENE.smoke.r, 0, Math.PI * 2);
    g.fillStyle = PAL.white;
    g.fill();
    g.stroke();
    for (const u of UNITS) {
      g.fillStyle = u.team === 'T' ? PAL.gold : PAL.blue;
      if (u.team === 'T') {
        g.beginPath();
        g.arc(u.x, u.y, u.self === true ? 2.3 : 1.8, 0, Math.PI * 2);
        g.fill();
      } else g.fillRect(u.x - 1.5, u.y - 1.5, 3, 3);
    }
    g.fillStyle = PAL.ink;
    g.font = `600 9px ${NUM}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const s of MAP.sites) g.fillText(s.id, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
  },
};

void mountPage(direction, [`600 20px "Barlow Condensed"`, `500 20px "Noto Sans TC"`]);
