// 方向 B：粗線漫畫。世界只有奶油色地面與紫色牆兩大色塊，隊色、危險色才飽和；線寬分三級（外框粗、結構中、紋理細），陰影一律硬邊。
// 迷霧用漫畫網點：視線外蓋一層斜 45° 的紫色網點，顏色不變暗、資訊也不多給。
// 圖層：地面烘焙 → 網點遮罩 → 牆烘焙 → 單位 → 煙 → 彈道與爆形。單位與特效的線寬用螢幕像素固定，牆與地面烘焙時以格為單位。
import { CALLOUTS, SCENE, UNITS, camRect, makeCanvas, toScreen, worldTransform, type Cam, type Unit } from './scene.ts';
import { mountPage, radarBase, type Direction } from './shell.ts';
import { LOW_RECTS, MAP, hash2, isWall, regionLabels, rng, wallPath, zoneAt, zonePath, type Pt, type Zone } from './world.ts';

const PAL = {
  ink: '#1f1536',
  shadow: '#c9b6dc',
  street: '#f8ead0',
  streetLine: '#d9bf9c',
  dirt: '#f0d6a6',
  dirtLine: '#c99f68',
  wood: '#eab97f',
  woodLine: '#a96f3f',
  plaza: '#f6e3c0',
  site: '#fdf3df',
  wall: '#6346a0',
  wallLight: '#7f61bf',
  wallDark: '#4b3384',
  side: '#2f1f5c',
  gold: '#ffc22e',
  goldShade: '#e8891a',
  cyan: '#19b9ee',
  cyanShade: '#0c7fc4',
  red: '#ee3350',
  white: '#fffdf6',
} as const;

const WALL_H = 0.62;
const SUN = { x: 0.62, y: 0.78 };
const BODY = 1.72;

interface Rc {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 手繪感的短線：同一條線分成兩段、中間留白 */
function brokenLine(p: Path2D, x0: number, y0: number, x1: number, y1: number, gap: number): void {
  p.moveTo(x0, y0);
  p.lineTo(x0 + (x1 - x0) * gap, y0 + (y1 - y0) * gap);
  p.moveTo(x0 + (x1 - x0) * (gap + 0.14), y0 + (y1 - y0) * (gap + 0.14));
  p.lineTo(x1, y1);
}

function stoneMarks(g: CanvasRenderingContext2D, r: Rc, salt: number, color: string): void {
  // 大膽留白：只在四散的小區塊畫幾顆石頭
  const p = new Path2D();
  for (let y = Math.floor(r.y0 / 4); y * 4 < r.y1; y++) {
    for (let x = Math.floor(r.x0 / 4); x * 4 < r.x1; x++) {
      if (hash2(x, y, salt) > 0.5) continue;
      const ox = x * 4 + hash2(x, y, salt + 1) * 2.2;
      const oy = y * 4 + hash2(x, y, salt + 2) * 2.4;
      p.roundRect(ox, oy, 1.1, 0.6, 0.12);
      p.roundRect(ox + 1.2, oy, 0.8, 0.6, 0.12);
      p.roundRect(ox + 0.4, oy + 0.7, 1.2, 0.6, 0.12);
    }
  }
  g.strokeStyle = color;
  g.lineWidth = 0.07;
  g.stroke(p);
}

const ZONE_FILL: Readonly<Record<Zone, string>> = { stone: PAL.street, dirt: PAL.dirt, wood: PAL.wood, market: PAL.dirt, plaza: PAL.plaza, site: PAL.site };

function paintZone(g: CanvasRenderingContext2D, z: Zone, r: Rc): void {
  g.fillStyle = ZONE_FILL[z];
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  if (z === 'stone' || z === 'plaza' || z === 'site') stoneMarks(g, r, z === 'stone' ? 11 : 23, PAL.streetLine);
  if (z === 'dirt' || z === 'market') {
    const rand = rng(303);
    const p = new Path2D();
    for (let i = 0; i < 2400; i++) {
      const x = rand() * 120;
      const y = rand() * 120;
      const len = 0.25 + rand() * 0.5;
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1 || hash2(Math.floor(x / 5), Math.floor(y / 5), 9) > 0.55) continue;
      p.moveTo(x, y);
      p.lineTo(x + len, y);
    }
    g.strokeStyle = PAL.dirtLine;
    g.lineWidth = 0.07;
    g.lineCap = 'round';
    g.stroke(p);
  }
  if (z === 'wood') {
    const p = new Path2D();
    for (let x = Math.floor(r.x0); x < r.x1; x++) {
      for (let y = Math.floor(r.y0 / 7) * 7; y < r.y1; y += 7) brokenLine(p, x, y + hash2(x, y, 4) * 3, x, y + 7, 0.3 + hash2(x, y, 5) * 0.4);
      if (hash2(x, 0, 6) < 0.5) {
        for (let y = Math.floor(r.y0 / 7) * 7 + 3; y < r.y1; y += 7) {
          p.moveTo(x, y + hash2(x, y, 8) * 4);
          p.lineTo(x + 1, y + hash2(x, y, 8) * 4);
        }
      }
    }
    g.strokeStyle = PAL.woodLine;
    g.lineWidth = 0.08;
    g.stroke(p);
  }
  if (z === 'market') {
    for (const [x, y, w, h] of [
      [22, 97, 6, 4],
      [31, 100, 5, 5],
      [16, 105, 7, 4],
      [27, 107, 8, 3],
    ] as const) {
      g.fillStyle = PAL.white;
      g.fillRect(x, y, w, h);
      g.fillStyle = PAL.red;
      for (let i = 0; i < w; i += 2) g.fillRect(x + i, y, 1, h);
      g.strokeStyle = PAL.ink;
      g.lineWidth = 0.14;
      g.strokeRect(x, y, w, h);
    }
  }
}

function burstPath(cx: number, cy: number, r0: number, r1: number, n: number, seed: number): Path2D {
  const rand = rng(seed);
  const p = new Path2D();
  for (let i = 0; i < n * 2; i++) {
    const a = (i * Math.PI) / n + (rand() - 0.5) * 0.1;
    const rr = i % 2 === 0 ? r1 * (0.86 + rand() * 0.2) : r0;
    if (i === 0) p.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else p.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  p.closePath();
  return p;
}

function paintSites(g: CanvasRenderingContext2D): void {
  for (const s of MAP.sites) {
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    const cx = s.x0 + w / 2 + (s.id === 'B' ? 3 : -2);
    const cy = s.y0 + h / 2 + 2;
    g.strokeStyle = PAL.ink;
    g.lineWidth = 0.12;
    g.setLineDash([1.2, 0.6]);
    g.strokeRect(s.x0, s.y0, w, h);
    g.setLineDash([]);
    const b = burstPath(cx, cy, 4.2, 5.9, 13, s.id === 'A' ? 5 : 9);
    g.fillStyle = PAL.shadow;
    g.save();
    g.translate(0.34, 0.42);
    g.fill(b);
    g.restore();
    g.fillStyle = '#ddd0ec';
    g.fill(b);
    g.lineWidth = 0.22;
    g.lineJoin = 'round';
    g.stroke(b);
    g.font = '400 7px "Bangers", "Barlow Condensed", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 0.42;
    g.strokeText(s.id, cx, cy + 0.2);
    g.fillStyle = PAL.white;
    g.fillText(s.id, cx, cy + 0.2);
  }
}

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
  g.strokeStyle = PAL.ink;
  g.lineWidth = 0.1;
  g.stroke(p);
}

function paintFloor(cam: Cam, withShadow = true): HTMLCanvasElement {
  const { c, g } = makeCanvas(cam.w, cam.h);
  worldTransform(g, cam);
  const r = camRect(cam);
  g.fillStyle = PAL.street;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  for (const z of ['stone', 'dirt', 'wood', 'market', 'plaza', 'site'] as const) {
    g.save();
    g.clip(zonePath(z));
    paintZone(g, z, r);
    g.restore();
  }
  paintCurbs(g, r);
  paintSites(g);
  if (withShadow) {
    // 硬邊落影：不柔化，形狀就是牆往東南掃過去
    const { c: sc, g: s } = makeCanvas(cam.w, cam.h);
    worldTransform(s, cam);
    s.fillStyle = PAL.shadow;
    const wall = wallPath(0.15);
    for (let i = 1; i <= 14; i++) {
      s.save();
      s.translate(SUN.x * 1.6 * (i / 14), SUN.y * 1.6 * (i / 14));
      s.fill(wall, 'evenodd');
      s.restore();
    }
    for (const b of LOW_RECTS) for (let i = 1; i <= 6; i++) s.fillRect(b.x0 + SUN.x * 0.6 * (i / 6), b.y0 + SUN.y * 0.6 * (i / 6), b.x1 - b.x0, b.y1 - b.y0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(sc, 0, 0);
    g.globalCompositeOperation = 'source-over';
  }
  return c;
}

/** 牆頂：紫色平塗，邊緣一圈亮色帶；屋頂上只放幾組磚塊筆觸，其餘留白 */
function paintTop(g: CanvasRenderingContext2D, r: Rc, wall: Path2D): void {
  g.fillStyle = PAL.wall;
  g.fillRect(r.x0 - 2, r.y0 - 2, r.x1 - r.x0 + 4, r.y1 - r.y0 + 4);
  const p = new Path2D();
  for (let y = Math.floor(r.y0 / 6) - 1; y * 6 < r.y1 + 2; y++) {
    for (let x = Math.floor(r.x0 / 6) - 1; x * 6 < r.x1 + 2; x++) {
      if (hash2(x, y, 41) > 0.42) continue;
      const ox = x * 6 + hash2(x, y, 42) * 3;
      const oy = y * 6 + hash2(x, y, 43) * 4;
      p.roundRect(ox, oy, 1.4, 0.7, 0.14);
      p.roundRect(ox + 1.5, oy, 1, 0.7, 0.14);
      p.roundRect(ox + 0.5, oy + 0.8, 1.6, 0.7, 0.14);
    }
  }
  g.fillStyle = PAL.wallDark;
  g.fill(p);
  g.strokeStyle = PAL.wallLight;
  g.lineWidth = 0.9;
  g.lineJoin = 'round';
  g.stroke(wall);
}

function outlined(g: CanvasRenderingContext2D, fill: string, x: number, y: number, w: number, h: number, r: number, line: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = PAL.ink;
  g.lineWidth = line;
  g.stroke();
}

/** 矮牆：箱子剪影，下緣一條側面帶讓它看得出比牆矮 */
function paintLow(g: CanvasRenderingContext2D): void {
  LOW_RECTS.forEach((r, i) => {
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    outlined(g, PAL.woodLine, r.x0, r.y0, w, h, 0.08, 0.16);
    const top = h - 0.3;
    outlined(g, i % 3 === 1 ? '#d9c5a0' : PAL.wood, r.x0, r.y0, w, top, 0.08, 0.13);
    g.strokeStyle = PAL.ink;
    g.lineWidth = 0.08;
    g.beginPath();
    const n = Math.max(1, Math.round(w / top));
    for (let k = 0; k < n; k++) {
      const a = r.x0 + (k * w) / n;
      g.moveTo(a, r.y0);
      g.lineTo(a + w / n, r.y0 + top);
      g.moveTo(a + w / n, r.y0);
      g.lineTo(a, r.y0 + top);
    }
    g.stroke();
  });
}

function paintWell(g: CanvasRenderingContext2D): void {
  outlined(g, PAL.site, 16, 18, 3, 2.5, 0.2, 0.16);
  g.beginPath();
  g.arc(17.5, 19.25, 1, 0, Math.PI * 2);
  g.fillStyle = PAL.ink;
  g.fill();
  g.beginPath();
  g.arc(17.5, 19.25, 0.74, 0, Math.PI * 2);
  g.fillStyle = PAL.cyanShade;
  g.fill();
  g.strokeStyle = PAL.white;
  g.lineWidth = 0.1;
  g.beginPath();
  g.arc(17.5, 19.25, 0.48, 3.5, 4.6);
  g.stroke();
}

function paintWalls(cam: Cam): HTMLCanvasElement {
  const { c, g } = makeCanvas(cam.w, cam.h);
  worldTransform(g, cam);
  const r = camRect(cam);
  const wall = wallPath(0.15);
  g.lineJoin = 'round';
  g.fillStyle = PAL.side;
  g.fill(wall, 'evenodd');
  g.save();
  g.clip(wall, 'evenodd');
  // 側面的直排陰影線
  const hatch = new Path2D();
  for (let x = Math.floor(r.x0 * 2) / 2; x < r.x1; x += 0.42) {
    hatch.moveTo(x, r.y0);
    hatch.lineTo(x, r.y1);
  }
  g.strokeStyle = PAL.wallDark;
  g.lineWidth = 0.09;
  g.stroke(hatch);
  g.save();
  g.translate(-0.16, -WALL_H);
  g.clip(wall, 'evenodd');
  paintTop(g, r, wall);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 0.16;
  g.stroke(wall);
  g.restore();
  g.restore();
  // 外框：最粗的一級線
  g.strokeStyle = PAL.ink;
  g.lineWidth = 0.22;
  g.stroke(wall);
  paintWell(g);
  paintLow(g);
  g.fillStyle = PAL.ink;
  g.fillRect(r.x0 - 1, r.y0 - 1, -r.x0 + 1, r.y1 - r.y0 + 2);
  g.fillRect(MAP.width, r.y0 - 1, r.x1 - MAP.width + 1, r.y1 - r.y0 + 2);
  g.fillRect(r.x0 - 1, r.y0 - 1, r.x1 - r.x0 + 2, -r.y0 + 1);
  g.fillRect(r.x0 - 1, MAP.height, r.x1 - r.x0 + 2, r.y1 - MAP.height + 1);
  return c;
}

/** 網點迷霧：斜 45° 的圓點磚，視線內挖掉 */
function paintFog(g: CanvasRenderingContext2D, cam: Cam, poly: readonly Pt[]): void {
  const size = 11;
  const { c: tile, g: t } = makeCanvas(size, size);
  t.fillStyle = PAL.side;
  for (const [x, y] of [
    [0, 0],
    [size, 0],
    [0, size],
    [size, size],
    [size / 2, size / 2],
  ] as const) {
    t.beginPath();
    t.arc(x, y, 2.5, 0, Math.PI * 2);
    t.fill();
  }
  const { c: fog, g: f } = makeCanvas(cam.w, cam.h);
  f.fillStyle = 'rgba(133, 104, 190, 0.22)';
  f.fillRect(0, 0, cam.w, cam.h);
  f.fillStyle = f.createPattern(tile, 'repeat') as CanvasPattern;
  f.globalAlpha = 0.62;
  f.fillRect(0, 0, cam.w, cam.h);
  f.globalAlpha = 1;
  f.globalCompositeOperation = 'destination-out';
  worldTransform(f, cam);
  f.fillStyle = '#000';
  const path = new Path2D();
  poly.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  path.closePath();
  f.fill(path);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(fog, 0, 0);
  worldTransform(g, cam);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 0.13;
  g.lineJoin = 'round';
  g.stroke(path);
}

/** 單位：剪影先行。T 頭巾尾巴往後飄，CT 頭盔帶護目鏡；外框粗、肩膀一刀硬邊陰影 */
function paintHero(g: CanvasRenderingContext2D, cam: Cam, u: Unit, tag = true): void {
  const us = u.team === 'T';
  const main = us ? PAL.gold : PAL.cyan;
  const shade = us ? PAL.goldShade : PAL.cyanShade;
  const a = (u.facing * Math.PI) / 180;
  worldTransform(g, cam);
  g.fillStyle = 'rgba(74, 47, 122, 0.5)';
  g.beginPath();
  g.ellipse(u.x + 0.24, u.y + 0.32, 0.72 * BODY * 0.72, 0.62 * BODY * 0.72, 0.3, 0, Math.PI * 2);
  g.fill();
  g.translate(u.x, u.y);
  g.rotate(a);
  g.scale(BODY, BODY);
  // 封面放大時線不能細掉
  const px = Math.max(1, cam.ppc / 40) / (cam.ppc * BODY);
  const lx = -SUN.x * Math.cos(-a) + SUN.y * Math.sin(-a);
  const ly = -SUN.x * Math.sin(-a) - SUN.y * Math.cos(-a);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const ink = (p: Path2D, fill: string, line = 3.4): void => {
    g.fillStyle = fill;
    g.strokeStyle = PAL.ink;
    g.lineWidth = line * px;
    g.fill(p);
    g.stroke(p);
  };
  const cel = (p: Path2D, color: string): void => {
    g.save();
    g.clip(p);
    g.fillStyle = color;
    g.beginPath();
    g.rect(-2, -2, 4, 4);
    g.rect(-2 + lx * 2.1, -2 + ly * 2.1, 4, 4);
    g.fill('evenodd');
    g.restore();
  };
  // 頭巾尾巴
  if (us) {
    const tail = new Path2D();
    tail.moveTo(-0.08, -0.08);
    tail.quadraticCurveTo(-0.5, -0.2, -0.72, -0.08);
    tail.lineTo(-0.5, 0);
    tail.lineTo(-0.72, 0.1);
    tail.quadraticCurveTo(-0.5, 0.2, -0.08, 0.08);
    tail.closePath();
    ink(tail, PAL.side);
  }
  // 槍
  const tip = 0.5 + u.gun * 0.8;
  const gun = new Path2D();
  gun.moveTo(0.06, -0.03);
  gun.lineTo(0.62, -0.05);
  gun.lineTo(0.66, 0.0);
  gun.lineTo(tip, 0.0);
  gun.lineTo(tip, 0.1);
  gun.lineTo(0.62, 0.12);
  gun.lineTo(0.58, 0.2);
  gun.lineTo(0.44, 0.2);
  gun.lineTo(0.4, 0.13);
  gun.lineTo(0.06, 0.13);
  gun.closePath();
  ink(gun, '#3b2f63');
  // 手臂
  g.strokeStyle = PAL.ink;
  g.lineWidth = 0.15 + 5 * px;
  const arm = new Path2D();
  arm.moveTo(0.02, -0.36);
  arm.lineTo(0.56, 0.04);
  arm.moveTo(0.02, 0.36);
  arm.lineTo(0.24, 0.1);
  g.stroke(arm);
  g.strokeStyle = shade;
  g.lineWidth = 0.15;
  g.stroke(arm);
  // 身體
  const body = new Path2D();
  body.moveTo(0.16, -0.26);
  body.quadraticCurveTo(0.2, -0.48, 0, -0.48);
  body.quadraticCurveTo(-0.24, -0.46, -0.26, -0.2);
  body.lineTo(-0.26, 0.2);
  body.quadraticCurveTo(-0.24, 0.46, 0, 0.48);
  body.quadraticCurveTo(0.2, 0.48, 0.16, 0.26);
  body.closePath();
  ink(body, main);
  cel(body, shade);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 3.4 * px;
  g.stroke(body);
  if (u.bomb === true) {
    const box = new Path2D();
    box.roundRect(-0.28, -0.16, 0.2, 0.32, 0.04);
    ink(box, PAL.red, 2.4);
  }
  // 頭
  const head = new Path2D();
  head.arc(0.04, 0, 0.25, 0, Math.PI * 2);
  ink(head, us ? PAL.white : '#264a86');
  cel(head, us ? '#e6c79a' : '#142a5c');
  g.strokeStyle = PAL.ink;
  g.lineWidth = 3 * px;
  g.stroke(head);
  if (us) {
    g.strokeStyle = PAL.side;
    g.lineWidth = 0.13;
    g.beginPath();
    g.arc(0.04, 0, 0.19, 1.6, 4.7);
    g.stroke();
  } else {
    const visor = new Path2D();
    visor.roundRect(0.1, -0.15, 0.16, 0.3, 0.06);
    ink(visor, PAL.cyan, 2.4);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (!tag) return;
  // 自己：頭上一個粗箭頭；隊友：對白框名牌
  const [sx, sy] = toScreen(cam, u.x, u.y);
  g.lineJoin = 'round';
  if (u.self === true) {
    const by = sy - 44;
    g.beginPath();
    g.moveTo(sx, by + 15);
    g.lineTo(sx - 14, by);
    g.lineTo(sx - 6, by);
    g.lineTo(sx - 6, by - 10);
    g.lineTo(sx + 6, by - 10);
    g.lineTo(sx + 6, by);
    g.lineTo(sx + 14, by);
    g.closePath();
    g.fillStyle = PAL.gold;
    g.fill();
    g.strokeStyle = PAL.ink;
    g.lineWidth = 3;
    g.stroke();
  } else if (us) {
    g.font = '900 15px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const w = g.measureText(u.name).width + 14;
    const y = sy - 44;
    g.fillStyle = PAL.ink;
    g.fillRect(sx - w / 2 + 3, y - 10, w, 23);
    g.fillStyle = PAL.white;
    g.fillRect(sx - w / 2, y - 13, w, 23);
    g.strokeStyle = PAL.ink;
    g.lineWidth = 2.4;
    g.strokeRect(sx - w / 2, y - 13, w, 23);
    g.fillStyle = PAL.ink;
    g.fillText(u.name, sx, y - 1);
  }
}

function paintSmoke(g: CanvasRenderingContext2D, cam: Cam): void {
  const s = SCENE.smoke;
  worldTransform(g, cam);
  const rand = rng(88);
  const puffs: { x: number; y: number; r: number }[] = [{ x: s.x, y: s.y, r: s.r * 0.72 }];
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * Math.PI * 2 + rand() * 0.2;
    const d = s.r * (0.68 + rand() * 0.16);
    puffs.push({ x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d, r: 0.72 + rand() * 0.5 });
  }
  const union = new Path2D();
  for (const p of puffs) {
    union.moveTo(p.x + p.r, p.y);
    union.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  }
  g.fillStyle = 'rgba(74, 47, 122, 0.45)';
  g.save();
  g.translate(0.55, 0.7);
  g.fill(union);
  g.restore();
  g.strokeStyle = PAL.ink;
  g.lineWidth = 0.34;
  g.stroke(union);
  g.fillStyle = '#d9cdea';
  g.fill(union);
  g.save();
  g.clip(union);
  g.translate(-0.32, -0.4);
  g.fillStyle = PAL.white;
  g.fill(union);
  g.restore();
  g.strokeStyle = PAL.ink;
  g.lineWidth = 0.09;
  g.lineCap = 'round';
  for (const [dx, dy, r, a0, a1] of [
    [-0.9, -0.5, 0.9, 3.4, 5.2],
    [0.8, 0.4, 0.8, 4, 5.8],
    [-0.2, 1, 0.7, 0.2, 2],
  ] as const) {
    g.beginPath();
    g.arc(s.x + dx, s.y + dy, r, a0, a1);
    g.stroke();
  }
}

function paintGrenade(g: CanvasRenderingContext2D, cam: Cam): void {
  const n = SCENE.grenade;
  worldTransform(g, cam);
  const b = burstPath(n.x, n.y, 0.6, 1.08, 8, 12);
  g.fillStyle = PAL.white;
  g.fill(b);
  g.strokeStyle = PAL.red;
  g.lineWidth = 0.15;
  g.lineJoin = 'round';
  g.stroke(b);
  g.fillStyle = PAL.ink;
  g.beginPath();
  g.arc(n.x, n.y + 0.05, 0.36, 0, Math.PI * 2);
  g.fill();
  g.fillRect(n.x - 0.11, n.y - 0.46, 0.22, 0.2);
  g.fillStyle = PAL.white;
  g.beginPath();
  g.arc(n.x - 0.12, n.y - 0.06, 0.08, 0, Math.PI * 2);
  g.fill();
}

function star(g: CanvasRenderingContext2D, x: number, y: number, a: number, s: number): void {
  const p = new Path2D();
  for (let i = 0; i < 12; i++) {
    const b = a + (i * Math.PI) / 6;
    const r = i === 0 ? s * 2.3 : i % 2 === 0 ? s * (i === 2 || i === 10 ? 1.4 : 0.95) : s * 0.42;
    if (i === 0) p.moveTo(x + Math.cos(b) * r, y + Math.sin(b) * r);
    else p.lineTo(x + Math.cos(b) * r, y + Math.sin(b) * r);
  }
  p.closePath();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.lineJoin = 'round';
  g.fillStyle = PAL.gold;
  g.fill(p);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 3;
  g.stroke(p);
  g.save();
  g.translate(x, y);
  g.scale(0.5, 0.5);
  g.translate(-x, -y);
  g.fillStyle = PAL.white;
  g.fill(p);
  g.restore();
}

function paintFire(g: CanvasRenderingContext2D, cam: Cam): void {
  const t = SCENE.tracer;
  const [ax, ay] = toScreen(cam, t.x0, t.y0);
  const [bx, by] = toScreen(cam, t.x1, t.y1);
  const a = Math.atan2(by - ay, bx - ax);
  const len = Math.hypot(bx - ax, by - ay);
  const start = 56;
  const head = start + (len - start) * t.head;
  const tail = Math.max(start, head - 210);
  g.setTransform(1, 0, 0, 1, ax, ay);
  g.rotate(a);
  // 彈道是一道尖的色塊，尾細頭粗，旁邊加兩條速度線
  const bolt = new Path2D();
  bolt.moveTo(tail, 0);
  bolt.lineTo(head - 16, -6);
  bolt.lineTo(head + 12, 0);
  bolt.lineTo(head - 16, 6);
  bolt.closePath();
  g.lineJoin = 'round';
  g.fillStyle = PAL.gold;
  g.strokeStyle = PAL.ink;
  g.lineWidth = 3;
  g.fill(bolt);
  g.stroke(bolt);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 2.5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(head - 130, -15);
  g.lineTo(head - 50, -15);
  g.moveTo(head - 170, 14);
  g.lineTo(head - 90, 14);
  g.stroke();
  star(g, ax + Math.cos(a) * 58, ay + Math.sin(a) * 58, a, 11);
  const foe = UNITS.find((u) => u.name === '鐵壁') as Unit;
  const [fx, fy] = toScreen(cam, foe.x, foe.y);
  const fa = (foe.facing * Math.PI) / 180;
  star(g, fx + Math.cos(fa) * 58, fy + Math.sin(fa) * 58, fa, 10);
  // 命中爆形與傷害數字
  const [px, py] = toScreen(cam, SCENE.pop.x, SCENE.pop.y);
  const cx = px + 52;
  const cy = py - 42;
  const b = burstPath(cx, cy, 25, 40, 9, 3);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = PAL.ink;
  g.save();
  g.translate(4, 5);
  g.fill(b);
  g.restore();
  g.fillStyle = PAL.white;
  g.fill(b);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 3;
  g.stroke(b);
  g.font = '400 36px "Bangers", "Barlow Condensed", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = PAL.red;
  g.fillText(String(SCENE.pop.amount), cx, cy + 2);
}

function paintCrosshair(g: CanvasRenderingContext2D, cam: Cam): void {
  const [x, y] = toScreen(cam, SCENE.aim.x, SCENE.aim.y);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = PAL.ink;
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    g.moveTo(x + dx * 30, y + dy * 30);
    g.lineTo(x + dx * 42, y + dy * 42);
  }
  g.stroke();
  g.strokeStyle = PAL.white;
  g.lineWidth = 2.5;
  g.stroke();
}

/** 區域名：漫畫旁白框，微微歪一點 */
function paintCaptions(g: CanvasRenderingContext2D, cam: Cam, list: readonly { readonly name: string; readonly x: number; readonly y: number }[], size: number): void {
  list.forEach((c, i) => {
    const [sx, sy] = toScreen(cam, c.x, c.y);
    g.setTransform(1, 0, 0, 1, sx, sy);
    g.rotate((i % 2 === 0 ? -1 : 1) * 0.024);
    g.font = `900 ${size}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const w = g.measureText(c.name).width + size * 1.1;
    const h = size * 1.6;
    g.fillStyle = PAL.ink;
    g.fillRect(-w / 2 + 3, -h / 2 + 3, w, h);
    g.fillStyle = PAL.white;
    g.fillRect(-w / 2, -h / 2, w, h);
    g.strokeStyle = PAL.ink;
    g.lineWidth = 2;
    g.strokeRect(-w / 2, -h / 2, w, h);
    g.fillStyle = PAL.ink;
    g.fillText(c.name, 0, 1);
  });
  g.setTransform(1, 0, 0, 1, 0, 0);
}

/** 封面：集中線，主角放大到畫面一半 */
function cover(g: CanvasRenderingContext2D, cx: number, cy: number): void {
  g.fillStyle = PAL.wall;
  g.fillRect(0, 0, 1920, 1080);
  const rand = rng(2024);
  g.fillStyle = PAL.wallDark;
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2 + rand() * 0.02;
    const w = 0.012 + rand() * 0.022;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 330, cy + Math.sin(a) * 330);
    g.lineTo(cx + Math.cos(a - w) * 2300, cy + Math.sin(a - w) * 2300);
    g.lineTo(cx + Math.cos(a + w) * 2300, cy + Math.sin(a + w) * 2300);
    g.closePath();
    g.fill();
  }
}

/** 烘焙層：只畫一次，之後每幀貼圖 */
let baked: { floor: HTMLCanvasElement; walls: HTMLCanvasElement } | null = null;

const direction: Direction = {
  id: 'b',
  paintScene(g) {
    const cam = SCENE.cam;
    baked ??= { floor: paintFloor(cam), walls: paintWalls(cam) };
    g.drawImage(baked.floor, 0, 0);
    paintFog(g, cam, SCENE.vision);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(baked.walls, 0, 0);
    paintCaptions(g, cam, CALLOUTS, 15);
    paintGrenade(g, cam);
    for (const u of UNITS) paintHero(g, cam, u);
    paintSmoke(g, cam);
    paintFire(g, cam);
    paintCrosshair(g, cam);
  },
  paintOverview(g) {
    const cam: Cam = { cx: 60, cy: 60, ppc: 9, w: 1920, h: 1080 };
    g.drawImage(paintFloor(cam), 0, 0);
    g.drawImage(paintWalls(cam), 0, 0);
    paintCaptions(g, cam, regionLabels(), 12);
  },
  paintBackdrop(g, kind) {
    const cam: Cam = { cx: 0, cy: 0, ppc: 150, w: 1920, h: 1080 };
    const hero = (x: number, y: number, team: 'T' | 'CT', facing: number): void => {
      paintHero(g, { ...cam, cx: -x / cam.ppc, cy: -y / cam.ppc }, { name: '', team, x: 0, y: 0, facing, gun: 1.25, hp: 100 }, false);
    };
    if (kind === 'setup') {
      cover(g, 330, 540);
      hero(-800, -400, 'T', 35);
      hero(-40, 440, 'CT', -150);
    } else {
      cover(g, 960, 540);
      hero(-800, 340, 'T', -40);
      hero(800, -300, 'CT', 130);
    }
  },
  paintRadar(g, size) {
    radarBase(g, size, PAL.wall, PAL.street, '#ddd0ec');
    const k = size / MAP.width;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.fillStyle = 'rgba(255, 194, 46, 0.4)';
    g.beginPath();
    SCENE.vision.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
    g.closePath();
    g.fill();
    g.fillStyle = PAL.white;
    g.strokeStyle = PAL.ink;
    g.lineWidth = 0.9;
    g.beginPath();
    g.arc(SCENE.smoke.x, SCENE.smoke.y, SCENE.smoke.r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    for (const u of UNITS) {
      g.fillStyle = u.team === 'T' ? PAL.gold : PAL.cyan;
      g.beginPath();
      g.arc(u.x, u.y, u.self === true ? 2.6 : 2, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.font = '400 11px "Bangers", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = PAL.ink;
    for (const s of MAP.sites) g.fillText(s.id, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
  },
};

void mountPage(direction, ['400 20px "Bangers"', '900 20px "Noto Sans TC"']);
