// 攻防戰的離屏烘焙：地面、記憶圖、牆與道具三張整圖（24 px／格），載入時畫一次，之後每幀貼圖；另烘一張小地圖底。
// 這裡只有流程與結構；調色盤與材質畫法在 themes/（地圖 JSON 的 theme 決定），輪廓在 outline.ts，直接讀 MapInfo。
import { SLOPE_LOW, mapVisualOf, slopeCorner, type MapDecor, type MapVisual } from '../../shooter/map.ts';
import { WALL_H, ZONES, rng, zoneGrid, hash2, type Zone } from './materials.ts';
import { CORNER_X, CORNER_Y, cellAt, isWall, lowKind, lowRects, openLoops, regionLabels, siteSpot, type BakeMap, type Callout, type CellRect, type Pt } from './outline.ts';
import { themeOf } from './themes/index.ts';
import type { MapTheme } from './themes/theme.ts';

/** 烘焙解析度（px／格） */
export const BAKE_PX = 24;
const RADAR_PX = 4;

const SUN = { x: 0.62, y: 0.78 };
const FONT_ZH = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
const FONT_EN = '"Barlow Condensed", "Noto Sans TC", sans-serif';

function makeCanvas(w: number, h: number, alpha = true): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d', { alpha }) as CanvasRenderingContext2D };
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
function paintCurbs(g: CanvasRenderingContext2D, m: BakeMap, grid: readonly Zone[], t: MapTheme): void {
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
  g.strokeStyle = t.pal.curbEdge;
  g.lineWidth = 0.3;
  g.stroke(p);
  g.strokeStyle = t.pal.curb;
  g.lineWidth = 0.17;
  g.stroke(p);
}

/** 包點地面塗裝：模板噴漆的框、角標、圓環與字母，再用固定雜訊磨舊 */
function paintSites(g: CanvasRenderingContext2D, m: BakeMap, t: MapTheme, decor: MapDecor): void {
  for (const s of m.sites) {
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    const { c, g: p } = makeCanvas(w * BAKE_PX, h * BAKE_PX);
    p.setTransform(BAKE_PX, 0, 0, BAKE_PX, -s.x0 * BAKE_PX, -s.y0 * BAKE_PX);
    p.strokeStyle = t.pal.paint;
    p.fillStyle = t.pal.paint;
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
    const spot = decor.sitePaint?.find((d) => d.id === s.id) ?? siteSpot(m, s);
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
function paintSpawns(g: CanvasRenderingContext2D, m: BakeMap, t: MapTheme): void {
  g.strokeStyle = t.pal.spawnLine;
  g.lineWidth = 0.14;
  g.setLineDash([0.9, 0.7]);
  for (const z of [m.spawnZones.T, m.spawnZones.CT]) g.strokeRect(z.x0 + 0.3, z.y0 + 0.3, z.x1 - z.x0 - 0.6, z.y1 - z.y0 - 0.6);
  g.setLineDash([]);
}

/** 地面上的區域名：像噴在地上的路標，壓在記憶圖裡也讀得到 */
function paintCallouts(g: CanvasRenderingContext2D, list: readonly Callout[], t: MapTheme): void {
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const c of list) {
    g.font = `700 ${c.size}px ${FONT_ZH}`;
    const label = [...c.name].join(' ');
    g.fillStyle = t.pal.labelGlow;
    g.fillText(label, c.x + 0.05, c.y + 0.06);
    g.fillStyle = t.pal.label;
    g.fillText(label, c.x, c.y);
  }
}

/** 落影與接觸遮蔽：低解析畫完放大，邊緣自然變柔；牆高與矮牆高用不同投影長度 */
function paintShadows(g: CanvasRenderingContext2D, m: BakeMap, wall: Path2D, lows: readonly CellRect[], t: MapTheme): void {
  const pw = m.width * BAKE_PX;
  const ph = m.height * BAKE_PX;
  const soft = 3;
  const { c, g: p } = makeCanvas(Math.ceil(pw / soft), Math.ceil(ph / soft), false);
  p.fillStyle = '#ffffff';
  p.fillRect(0, 0, c.width, c.height);
  p.setTransform(BAKE_PX / soft, 0, 0, BAKE_PX / soft, 0, 0);
  p.fillStyle = t.pal.shadow;
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
  q.strokeStyle = t.pal.ao;
  q.lineWidth = 1.1;
  q.stroke(wall);
  q.fillStyle = t.pal.ao;
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

function paintFloor(m: BakeMap, wall: Path2D, lows: readonly CellRect[], t: MapTheme, v: MapVisual): HTMLCanvasElement {
  const { c, g } = makeCanvas(m.width * BAKE_PX, m.height * BAKE_PX, false);
  g.setTransform(BAKE_PX, 0, 0, BAKE_PX, 0, 0);
  g.fillStyle = t.pal.dirt;
  g.fillRect(0, 0, m.width, m.height);
  const grid = zoneGrid(m, v.materials);
  for (const z of ZONES) {
    const shape = zoneShape(m, grid, z);
    if (shape === null) continue;
    g.save();
    g.clip(shape.path);
    t.paintZone(g, z, shape.box, m, v.decor);
    g.restore();
  }
  paintCurbs(g, m, grid, t);
  paintSpawns(g, m, t);
  paintSites(g, m, t, v.decor);
  paintCallouts(g, regionLabels(m), t);
  paintShadows(g, m, wall, lows, t);
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

/** 矮牆：形狀就是碰撞矩形，道具組由 theme 畫 */
function paintLow(g: CanvasRenderingContext2D, m: BakeMap, lows: readonly CellRect[], t: MapTheme): void {
  for (const r of lows) t.paintLowProp(g, lowKind(r), r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  // 斜切矮牆：同樣的道具面，裁成實心三角形
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
      t.paintSlopeLow(g, x, y);
      g.restore();
    }
  }
}

/** 牆邊道具：全部畫在牆格裡（走不到），長在牆腳上；依材質區挑種類 */
function paintWallProps(g: CanvasRenderingContext2D, m: BakeMap, grid: readonly Zone[], t: MapTheme): void {
  for (let y = 1; y < m.height - 1; y++) {
    for (let x = 1; x < m.width - 2; x++) {
      if (!isWall(m, x, y) || !isWall(m, x + 1, y) || cellAt(m, x, y + 1) !== 0 || cellAt(m, x + 1, y + 1) !== 0) continue;
      if (hash2(x, y, 77) > 0.13) continue;
      t.paintWallProp(g, grid[(y + 1) * m.width + x], x, y);
    }
  }
}

function paintWalls(m: BakeMap, wall: Path2D, lows: readonly CellRect[], t: MapTheme, v: MapVisual): HTMLCanvasElement {
  const { c, g } = makeCanvas(m.width * BAKE_PX, m.height * BAKE_PX);
  g.setTransform(BAKE_PX, 0, 0, BAKE_PX, 0, 0);
  g.lineJoin = 'round';
  g.fillStyle = t.pal.side;
  g.fill(wall, 'evenodd');
  g.save();
  g.clip(wall, 'evenodd');
  // 側面的石層
  g.strokeStyle = t.pal.sideLine;
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
  t.paintRoof(g, m);
  // 一階一階往內退的台地：屋頂像層層堆起的土台
  for (const [w, tone] of [
    [13, t.pal.roofMid],
    [7.4, t.pal.roofOuter],
  ] as const) {
    g.strokeStyle = t.pal.rimLine;
    g.lineWidth = w + 0.16;
    g.stroke(wall);
    g.strokeStyle = tone;
    g.lineWidth = w;
    g.stroke(wall);
  }
  g.strokeStyle = t.pal.rimLine;
  g.lineWidth = 1.5;
  g.stroke(wall);
  g.strokeStyle = t.pal.rim;
  g.lineWidth = 1.26;
  g.stroke(wall);
  g.strokeStyle = 'rgba(255, 235, 215, 0.5)';
  g.lineWidth = 0.1;
  g.stroke(wall);
  g.restore();
  g.restore();
  for (const w of v.decor.wells ?? []) t.paintWell(g, m, w);
  paintWallProps(g, m, zoneGrid(m, v.materials), t);
  paintLow(g, m, lows, t);
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
  /** 地圖外的桌面色（theme 的） */
  readonly table: string;
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

/** 烘焙（同一張地圖只烘一次；換地圖重烘並釋放舊圖）。theme、擺設、材質不走 MapInfo，依地圖代號查 */
export function bakeMap(m: BakeMap, visual: MapVisual = mapVisualOf(m.id)): Baked {
  const key = keyOf(m);
  if (cached !== null && cached.key === key) return cached;
  if (cached !== null) for (const c of [cached.floor, cached.memory, cached.walls, cached.radar]) c.width = 0;
  const t0 = performance.now();
  const loops = openLoops(m);
  const wall = wallPathOf(m, loops, 0.3);
  const lows = lowRects(m);
  const t = themeOf(visual.theme);
  const floor = paintFloor(m, wall, lows, t, visual);
  const memory = memoryOf(floor);
  const walls = paintWalls(m, wall, lows, t, visual);
  const radar = paintRadar(m, loops);
  // 讀一個像素逼畫布把排隊的指令畫完，毫秒數才是真的
  for (const c of [memory, walls]) c.getContext('2d')?.getImageData(0, 0, 1, 1);
  cached = { key, floor, memory, walls, radar, table: t.pal.table, wall, loops, labels: regionLabels(m), ms: performance.now() - t0 };
  return cached;
}
