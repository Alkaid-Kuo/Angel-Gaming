// 攻防戰地圖編輯器：矩形與多邊形直接對應 MapLayout，畫面上的格子由引擎的 buildMap 算出來，所見即引擎所得。
import { UNIT, type Team } from '../../shooter/config.ts';
import { DUST_LAYOUT, REDROCK_LAYOUT, SLOPE_LOW, buildMap, cellOf, slopeCorner, type MapLayout, type ShooterMap } from '../../shooter/map.ts';
import { DRAFT_LAYOUT } from '../sketch/shooter/map-draft.ts';
import { RUN_CELLS_PER_SEC, analyze, pathField, tracePath, visibleCells, type Check } from './checks.ts';
import { formatDoc, parseDoc, sameRef, toDoc, type EditDoc, type MPoly, type MRect, type MSpawn, type Ref } from './doc.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const AUTOSAVE_KEY = 'shooter-map-editor';
const FILES_API = '/__shooter-maps';
const DEFAULT_FILE = 'redrock2';
const HANDLE_PX = 7;

const COLOR = {
  bg: '#0d0f14',
  wall: [20, 22, 27],
  floor: [205, 197, 182],
  low: [214, 150, 48],
  grid: 'rgb(0 0 0 / 14%)',
  grid10: 'rgb(0 0 0 / 34%)',
  area: 'rgb(60 70 100 / 55%)',
  label: '#2a2c33',
  block: '#8d93a3',
  gold: '#f0b54a',
  T: '#e0913a',
  CT: '#4a9be0',
  site: '#c8473c',
  polyWall: '#8d93a3',
  polyOpen: '#3f9e7d',
  mark: 'rgb(239 106 94 / 70%)',
} as const;

const PRESETS: Record<string, { label: string; layout: MapLayout }> = {
  redrock: { label: '赤岩鎮（現行）', layout: REDROCK_LAYOUT },
  draft: { label: '赤岩舊城第一版草案', layout: DRAFT_LAYOUT },
  dust: { label: '沙城（測試圖）', layout: DUST_LAYOUT },
};

type Tool = 'select' | 'area' | 'block' | 'low' | 'poly' | 'measure' | 'sight';
const TOOLS: readonly { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'select', label: '選取', key: 'V', hint: '點物件選取，同一格再點一次換下一層。拖曳移動，拖角落或邊縮放；Shift 加選或框選。方向鍵微調，Shift 一次 5 格。' },
  { id: 'area', label: '開路', key: 'A', hint: '拖曳挖開一塊可走區域。走道、門洞、房間都用它。' },
  { id: 'block', label: '實心牆', key: 'B', hint: '拖曳填回一塊實心牆，擋移動、視線與子彈。' },
  { id: 'low', label: '矮掩體', key: 'L', hint: '拖曳放矮掩體：擋移動，蹲著貼近時才擋視線。' },
  { id: 'poly', label: '斜角', key: 'P', hint: '逐點點擊畫多邊形，邊會吸到水平、垂直或 45°，點回起點或按 Enter 結束，Esc 取消。屬性可切填牆、填矮牆或挖開。' },
  { id: 'measure', label: '量路程', key: 'M', hint: '點兩個位置，顯示最短路線、格數與跑步秒數。' },
  { id: 'sight', label: '看視線', key: 'E', hint: '滑鼠所在位置看得到的範圍，點一下固定，再點解除。用引擎的視線判定。' },
];

const POLY_MODE: Record<MPoly['mode'], string> = { wall: '填牆', low: '填矮牆', open: '挖開' };

const LAYERS = { areas: '區域框', labels: '名稱', blocks: '實心牆', low: '矮掩體', polys: '斜角', sites: '包點', spawns: '出生', grid: '格線' } as const;
type Layer = keyof typeof LAYERS;
const layers: Record<Layer, boolean> = { areas: true, labels: true, blocks: true, low: true, polys: true, sites: true, spawns: true, grid: true };

type Drag =
  | { t: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { t: 'move'; cx: number; cy: number; orig: unknown[]; moved: boolean; cycle: Ref | null }
  | { t: 'resize'; ref: Ref; hx: number; hy: number; orig: MRect }
  | { t: 'vertex'; poly: number; v: number }
  | { t: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean; top: Ref | null }
  | { t: 'rect'; kind: 'area' | 'block' | 'low'; x0: number; y0: number; x1: number; y1: number };

const cv = $<HTMLCanvasElement>('cv');
const ctx = cv.getContext('2d')!;
const stage = $('stage');

let doc: EditDoc = toDoc(DRAFT_LAYOUT);
let map: ShooterMap = buildMap(doc);
let buildError = '';
let tool: Tool = 'select';
let selection: Ref[] = [];
let drag: Drag | null = null;
let draftPoly: [number, number][] = [];
const view = { scale: 7, ox: 0, oy: 0 };
/** 使用者動過鏡頭後，視窗變大小就不再自動置中 */
let viewTouched = false;
let cursor: { x: number; y: number } | null = null;
let spaceDown = false;
let overlay = 'none';
let checks: Check[] = [];
let activeCheck = -1;
let marks: readonly number[] = [];
let measure: { a: [number, number] | null; b: [number, number] | null; path: [number, number][]; cells: number } = { a: null, b: null, path: [], cells: 0 };
let sightFrom: [number, number] | null = null;
let sightPinned = false;
let sightCrouch = false;
let sightCells: Uint8Array | null = null;
let undoStack: string[] = [];
let redoStack: string[] = [];
let snapshot = JSON.stringify(doc);
let savedSnapshot = snapshot;
let checkTimer = 0;
let drawQueued = false;

const raster = document.createElement('canvas');
const overlayCanvas = document.createElement('canvas');

// ---------- 文件操作 ----------

function objectOf(r: Ref): MRect | MPoly | MSpawn {
  switch (r.kind) {
    case 'area':
      return doc.areas[r.i];
    case 'block':
      return doc.blocks[r.i];
    case 'low':
      return doc.low[r.i];
    case 'poly':
      return doc.polys[r.i];
    case 'site':
      return doc.sites[r.i];
    case 'zone':
      return doc.spawnZones[r.team];
    case 'spawn':
      return doc.spawns[r.team][r.i];
  }
}

function rectOf(r: Ref): MRect | null {
  return r.kind === 'poly' || r.kind === 'spawn' ? null : (objectOf(r) as MRect);
}

function bboxOf(r: Ref): MRect {
  if (r.kind === 'poly') {
    const pts = doc.polys[r.i].pts;
    return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
  }
  if (r.kind === 'spawn') {
    const s = doc.spawns[r.team][r.i];
    const cx = cellOf(s.x);
    const cy = cellOf(s.y);
    return { x0: cx, y0: cy, x1: cx + 1, y1: cy + 1 };
  }
  return rectOf(r)!;
}

function allRefs(): Ref[] {
  const out: Ref[] = [];
  if (layers.spawns) for (const team of ['T', 'CT'] as const) doc.spawns[team].forEach((_, i) => out.push({ kind: 'spawn', team, i }));
  if (layers.low) doc.low.forEach((_, i) => out.push({ kind: 'low', i }));
  if (layers.blocks) doc.blocks.forEach((_, i) => out.push({ kind: 'block', i }));
  if (layers.polys) doc.polys.forEach((_, i) => out.push({ kind: 'poly', i }));
  if (layers.sites) doc.sites.forEach((_, i) => out.push({ kind: 'site', i }));
  if (layers.spawns) for (const team of ['T', 'CT'] as const) out.push({ kind: 'zone', team });
  if (layers.areas) doc.areas.forEach((_, i) => out.push({ kind: 'area', i }));
  return out;
}

function inPoly(pts: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 這個位置底下的物件，最上層（最小）的在前 */
function hitsAt(x: number, y: number): Ref[] {
  const hit = allRefs().filter((r) => {
    if (r.kind === 'poly') return inPoly(doc.polys[r.i].pts, x, y);
    if (r.kind === 'spawn') {
      const s = doc.spawns[r.team][r.i];
      return Math.hypot(s.x / UNIT - x, s.y / UNIT - y) < 1.1;
    }
    const b = rectOf(r)!;
    return x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
  });
  const tier = (r: Ref): number => (r.kind === 'spawn' ? 0 : r.kind === 'low' ? 1 : r.kind === 'block' ? 2 : r.kind === 'poly' ? 3 : 4);
  const size = (r: Ref): number => {
    const b = bboxOf(r);
    return (b.x1 - b.x0) * (b.y1 - b.y0);
  };
  return hit.sort((a, b) => tier(a) - tier(b) || size(a) - size(b));
}

function uniqueAreaId(base: string): string {
  const used = new Set(doc.areas.map((a) => a.id));
  for (let n = 1; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

function clampMove(refs: readonly Ref[], dx: number, dy: number): [number, number] {
  let x = dx;
  let y = dy;
  for (const r of refs) {
    const b = bboxOf(r);
    x = Math.max(-b.x0, Math.min(doc.width - b.x1, x));
    y = Math.max(-b.y0, Math.min(doc.height - b.y1, y));
  }
  return [x, y];
}

function shift(o: unknown, dx: number, dy: number, target: unknown): void {
  if (typeof o !== 'object' || o === null) return;
  if ('pts' in o) {
    (target as MPoly).pts = (o as MPoly).pts.map(([x, y]) => [x + dx, y + dy]);
  } else if ('facing' in o) {
    (target as MSpawn).x = (o as MSpawn).x + dx * UNIT;
    (target as MSpawn).y = (o as MSpawn).y + dy * UNIT;
  } else {
    const r = o as MRect;
    Object.assign(target as MRect, { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });
  }
}

function removeSelection(): void {
  const lists = { area: doc.areas, block: doc.blocks, low: doc.low, poly: doc.polys } as const;
  const gone = selection.flatMap((r) => (r.kind === 'area' || r.kind === 'block' || r.kind === 'low' || r.kind === 'poly' ? [{ list: lists[r.kind] as unknown[], i: r.i }] : []));
  if (gone.length === 0) return;
  for (const r of [...gone].sort((a, b) => b.i - a.i)) r.list.splice(r.i, 1);
  selection = [];
  commit();
}

function duplicateSelection(): void {
  const made: Ref[] = [];
  const offset = (o: object): object => {
    const c = JSON.parse(JSON.stringify(o)) as object;
    shift(o, 2, 2, c);
    return c;
  };
  for (const r of selection) {
    if (r.kind === 'area') {
      const a = offset(doc.areas[r.i]) as (typeof doc.areas)[number];
      a.id = uniqueAreaId(doc.areas[r.i].id.replace(/\d+$/, ''));
      made.push({ kind: 'area', i: doc.areas.push(a) - 1 });
    } else if (r.kind === 'block') made.push({ kind: 'block', i: doc.blocks.push(offset(doc.blocks[r.i]) as MRect) - 1 });
    else if (r.kind === 'low') made.push({ kind: 'low', i: doc.low.push(offset(doc.low[r.i]) as MRect) - 1 });
    else if (r.kind === 'poly') made.push({ kind: 'poly', i: doc.polys.push(offset(doc.polys[r.i]) as MPoly) - 1 });
  }
  if (made.length === 0) return;
  selection = made;
  commit();
}

/** 實心牆與矮掩體互換 */
function swapCover(): void {
  const r = selection[0];
  if (selection.length !== 1 || (r.kind !== 'block' && r.kind !== 'low')) return;
  const [from, to, kind] = r.kind === 'block' ? [doc.blocks, doc.low, 'low' as const] : [doc.low, doc.blocks, 'block' as const];
  const [o] = from.splice(r.i, 1);
  selection = [{ kind, i: to.push(o) - 1 }];
  commit();
}

/** 一次編輯結束：進復原堆疊、自動存、排檢查 */
function commit(): void {
  const now = JSON.stringify(doc);
  if (now !== snapshot) {
    undoStack.push(snapshot);
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    snapshot = now;
    autosave();
  }
  refresh();
}

function autosave(): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, formatDoc(doc));
  } catch {
    // 瀏覽器不給存就算了，手動存檔不受影響
  }
}

function restore(text: string): void {
  doc = JSON.parse(text) as EditDoc;
  snapshot = text;
  selection = [];
  autosave();
  refresh();
}

function undo(): void {
  const prev = undoStack.pop();
  if (prev === undefined) return;
  redoStack.push(snapshot);
  restore(prev);
}

function redo(): void {
  const next = redoStack.pop();
  if (next === undefined) return;
  undoStack.push(snapshot);
  restore(next);
}

function loadDoc(d: EditDoc): void {
  doc = d;
  snapshot = JSON.stringify(doc);
  savedSnapshot = snapshot;
  undoStack = [];
  redoStack = [];
  selection = [];
  measure = { a: null, b: null, path: [], cells: 0 };
  sightPinned = false;
  sightFrom = null;
  autosave();
  refresh();
  fit();
}

// ---------- 地圖重算 ----------

function rebuild(): void {
  try {
    map = buildMap(doc);
    buildError = '';
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }
  paintRaster();
  if (sightFrom !== null) sightCells = visibleCells(map, sightFrom[0], sightFrom[1], sightCrouch);
  requestDraw();
}

function paintRaster(): void {
  raster.width = map.width;
  raster.height = map.height;
  const g = raster.getContext('2d')!;
  const img = g.createImageData(map.width, map.height);
  for (let i = 0; i < map.solid.length; i++) {
    const c = map.solid[i] === 1 ? COLOR.wall : map.solid[i] === 2 ? COLOR.low : COLOR.floor;
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  g.putImageData(img, 0, 0);
}

/** 描出格 (x, y) 貼著 corner 角的三角形 */
function cellTriangle(x: number, y: number, corner: number): void {
  ctx.beginPath();
  for (const c of [corner, (corner + 1) % 4, (corner + 3) % 4]) ctx.lineTo(sx(x + (c === 1 || c === 2 ? 1 : 0)), sy(y + (c === 2 || c === 3 ? 1 : 0)));
  ctx.closePath();
}

/** 底圖是一格一像素，斜切格的實心半邊另外畫 */
function drawSlopes(): void {
  for (let i = 0; i < map.solid.length; i++) {
    const corner = slopeCorner(map.solid[i]);
    if (corner < 0) continue;
    const c = map.solid[i] >= SLOPE_LOW ? COLOR.low : COLOR.wall;
    const x = i % map.width;
    ctx.fillStyle = `rgb(${c[0]} ${c[1]} ${c[2]})`;
    cellTriangle(x, (i - x) / map.width, corner);
    ctx.fill();
  }
}

function paintOverlay(): void {
  overlayCanvas.width = map.width;
  overlayCanvas.height = map.height;
  if (overlay === 'none') return;
  const g = overlayCanvas.getContext('2d')!;
  const img = g.createImageData(map.width, map.height);
  const fieldOf = (t: Team): Float64Array => {
    const s = map.spawns[t][Math.min(2, map.spawns[t].length - 1)];
    return pathField(map, cellOf(s.x), cellOf(s.y));
  };
  const put = (i: number, c: readonly number[], a: number): void => img.data.set([c[0], c[1], c[2], a], i * 4);
  const T = [224, 145, 58];
  const CT = [74, 155, 224];
  if (overlay === 'race') {
    const ft = fieldOf('T');
    const fc = fieldOf('CT');
    for (let i = 0; i < ft.length; i++) {
      if (!Number.isFinite(ft[i]) || !Number.isFinite(fc[i])) continue;
      const lead = (ft[i] - fc[i]) / RUN_CELLS_PER_SEC;
      if (Math.abs(lead) < 1) put(i, [255, 255, 255], 190);
      else put(i, lead > 0 ? CT : T, 70 + Math.min(150, Math.abs(lead) * 8));
    }
  } else {
    const f = fieldOf(overlay as Team);
    for (let i = 0; i < f.length; i++) {
      if (!Number.isFinite(f[i])) continue;
      const sec = f[i] / RUN_CELLS_PER_SEC;
      const band = Math.floor(sec / 5) % 2 === 0 ? 1 : 0.62;
      put(i, overlay === 'T' ? T : CT, 200 * band * Math.max(0.3, 1 - sec / 40));
    }
  }
  g.putImageData(img, 0, 0);
}

function scheduleChecks(): void {
  clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => {
    if (buildError === '') {
      checks = analyze(doc, map);
      paintOverlay();
    }
    if (activeCheck >= 0) marks = checks[activeCheck]?.cells ?? [];
    renderChecks();
    requestDraw();
  }, 160);
}

/** 文件變了以後，畫面與面板全部跟上 */
function refresh(): void {
  rebuild();
  scheduleChecks();
  renderObjects();
  renderInspector();
  renderTop();
}

// ---------- 繪製 ----------

function requestDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

const sx = (x: number): number => view.ox + x * view.scale;
const sy = (y: number): number => view.oy + y * view.scale;

function strokeRect(r: MRect, color: string, width = 1, dash: number[] = []): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeRect(sx(r.x0) + 0.5, sy(r.y0) + 0.5, (r.x1 - r.x0) * view.scale, (r.y1 - r.y0) * view.scale);
  ctx.setLineDash([]);
}

function polyPath(pts: readonly (readonly [number, number])[]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(sx(x), sy(y)) : ctx.lineTo(sx(x), sy(y))));
  ctx.closePath();
}

function label(text: string, cx: number, cy: number, size: number, color: string): void {
  ctx.font = `600 ${size}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
}

function handlesOf(r: MRect): { x: number; y: number; hx: number; hy: number }[] {
  const out: { x: number; y: number; hx: number; hy: number }[] = [];
  for (let hy = 0; hy < 3; hy++) {
    for (let hx = 0; hx < 3; hx++) {
      if (hx === 1 && hy === 1) continue;
      out.push({ x: sx(r.x0 + ((r.x1 - r.x0) * hx) / 2), y: sy(r.y0 + ((r.y1 - r.y0) * hy) / 2), hx, hy });
    }
  }
  return out;
}

function draw(): void {
  const dpr = devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  const W = map.width * view.scale;
  const H = map.height * view.scale;
  ctx.drawImage(raster, view.ox, view.oy, W, H);
  drawSlopes();
  if (overlay !== 'none') ctx.drawImage(overlayCanvas, view.ox, view.oy, W, H);

  if (sightCells !== null && sightFrom !== null && tool === 'sight') {
    // 看不到的地方壓暗，疊圖開著也看得清楚
    ctx.fillStyle = 'rgb(13 15 20 / 72%)';
    for (let i = 0; i < map.solid.length; i++) {
      if (map.solid[i] === 1 || sightCells[i] === 1) continue;
      const x = i % map.width;
      const y = (i - x) / map.width;
      const corner = slopeCorner(map.solid[i]);
      if (corner < 0) ctx.fillRect(sx(x), sy(y), view.scale, view.scale);
      else {
        cellTriangle(x, y, (corner + 2) % 4);
        ctx.fill();
      }
    }
    ctx.fillStyle = COLOR.gold;
    ctx.beginPath();
    ctx.arc(sx(sightFrom[0] + 0.5), sy(sightFrom[1] + 0.5), 5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (layers.grid && view.scale >= 6) {
    ctx.lineWidth = 1;
    for (let i = 0; i <= map.width; i++) {
      ctx.strokeStyle = i % 10 === 0 ? COLOR.grid10 : COLOR.grid;
      ctx.beginPath();
      ctx.moveTo(sx(i) + 0.5, view.oy);
      ctx.lineTo(sx(i) + 0.5, view.oy + H);
      ctx.stroke();
    }
    for (let i = 0; i <= map.height; i++) {
      ctx.strokeStyle = i % 10 === 0 ? COLOR.grid10 : COLOR.grid;
      ctx.beginPath();
      ctx.moveTo(view.ox, sy(i) + 0.5);
      ctx.lineTo(view.ox + W, sy(i) + 0.5);
      ctx.stroke();
    }
  }

  if (layers.areas) for (const a of doc.areas) strokeRect(a, COLOR.area, 1, [4, 3]);
  if (layers.blocks) for (const b of doc.blocks) strokeRect(b, COLOR.block);
  if (layers.polys) {
    for (const p of doc.polys) {
      polyPath(p.pts);
      ctx.strokeStyle = p.mode === 'open' ? COLOR.polyOpen : COLOR.polyWall;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  if (layers.sites) {
    for (const s of doc.sites) {
      strokeRect(s, COLOR.site, 2);
      label(s.id, sx((s.x0 + s.x1) / 2), sy((s.y0 + s.y1) / 2), Math.max(16, view.scale * 5), 'rgb(200 71 60 / 55%)');
    }
  }
  if (layers.spawns) {
    for (const t of ['T', 'CT'] as const) {
      const c = t === 'T' ? COLOR.T : COLOR.CT;
      strokeRect(doc.spawnZones[t], c, 2, [8, 4]);
      for (const s of doc.spawns[t]) {
        const x = sx(s.x / UNIT);
        const y = sy(s.y / UNIT);
        const a = (s.facing * Math.PI) / 180;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3.5, view.scale * 0.8), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = c;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * view.scale * 2.2, y + Math.sin(a) * view.scale * 2.2);
        ctx.stroke();
      }
    }
  }
  if (layers.labels) {
    const size = Math.max(10, Math.min(14, view.scale * 1.5));
    for (const a of doc.areas) {
      if ((a.x1 - a.x0) * view.scale < a.name.length * size * 0.9) continue;
      label(a.name, sx((a.x0 + a.x1) / 2), sy((a.y0 + a.y1) / 2), size, COLOR.label);
    }
  }

  ctx.fillStyle = COLOR.mark;
  for (const i of marks) {
    const x = i % map.width;
    ctx.fillRect(sx(x), sy((i - x) / map.width), view.scale, view.scale);
  }

  if (measure.path.length > 1) {
    ctx.strokeStyle = '#d43f8d';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    measure.path.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(sx(x + 0.5), sy(y + 0.5)) : ctx.lineTo(sx(x + 0.5), sy(y + 0.5))));
    ctx.stroke();
  }
  for (const p of [measure.a, measure.b]) {
    if (p === null) continue;
    ctx.fillStyle = '#d43f8d';
    ctx.beginPath();
    ctx.arc(sx(p[0] + 0.5), sy(p[1] + 0.5), 5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const r of selection) {
    const b = bboxOf(r);
    strokeRect(b, COLOR.gold, 2);
  }
  if (selection.length === 1) drawHandles(selection[0]);

  if (drag?.t === 'rect' || drag?.t === 'box') {
    const b = { x0: Math.min(drag.x0, drag.x1), y0: Math.min(drag.y0, drag.y1), x1: Math.max(drag.x0, drag.x1), y1: Math.max(drag.y0, drag.y1) };
    strokeRect(b, COLOR.gold, 1.5, [5, 3]);
    if (drag.t === 'rect') label(`${b.x1 - b.x0}×${b.y1 - b.y0}`, sx((b.x0 + b.x1) / 2), sy((b.y0 + b.y1) / 2), 14, COLOR.gold);
  }
  if (draftPoly.length > 0) {
    ctx.strokeStyle = COLOR.gold;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    draftPoly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(sx(x), sy(y)) : ctx.lineTo(sx(x), sy(y))));
    if (cursor !== null) ctx.lineTo(sx(Math.round(cursor.x)), sy(Math.round(cursor.y)));
    ctx.stroke();
    for (const [x, y] of draftPoly) {
      ctx.fillStyle = COLOR.gold;
      ctx.fillRect(sx(x) - 3, sy(y) - 3, 6, 6);
    }
  }
  renderStatus();
}

function drawHandles(r: Ref): void {
  ctx.fillStyle = COLOR.gold;
  if (r.kind === 'poly') {
    for (const [x, y] of doc.polys[r.i].pts) ctx.fillRect(sx(x) - 4, sy(y) - 4, 8, 8);
    return;
  }
  const b = rectOf(r);
  if (b !== null) for (const h of handlesOf(b)) ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
}

function regionName(cx: number, cy: number): string {
  const hit = doc.areas.filter((a) => cx >= a.x0 && cx < a.x1 && cy >= a.y0 && cy < a.y1);
  hit.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
  return hit[0]?.name ?? '';
}

function renderStatus(): void {
  const parts: string[] = [];
  if (buildError !== '') parts.push(buildError);
  if (cursor !== null) {
    const cx = Math.floor(cursor.x);
    const cy = Math.floor(cursor.y);
    parts.push(`(${cx}, ${cy})`, regionName(cx, cy));
  }
  if (measure.path.length > 1) parts.push(`路程 ${measure.cells.toFixed(0)} 格、${(measure.cells / RUN_CELLS_PER_SEC).toFixed(1)} 秒`);
  else if (measure.a !== null && measure.b !== null) parts.push('兩點不連通');
  parts.push(`${Math.round(view.scale * 10) / 10} px／格`);
  $('status').textContent = parts.filter((p) => p !== '').join('　');
}

// ---------- 面板 ----------

function renderTop(): void {
  const name = $<HTMLInputElement>('map-name');
  const id = $<HTMLInputElement>('map-id');
  if (document.activeElement !== name) name.value = doc.name;
  if (document.activeElement !== id) id.value = doc.id;
  $<HTMLButtonElement>('undo').disabled = undoStack.length === 0;
  $<HTMLButtonElement>('redo').disabled = redoStack.length === 0;
  const dirty = snapshot !== savedSnapshot;
  const el = $('dirty');
  el.textContent = dirty ? '尚未存檔' : '已存檔';
  el.classList.toggle('on', dirty);
}

function renderTools(): void {
  const box = $('tools');
  box.replaceChildren(
    ...TOOLS.map((t) => {
      const b = document.createElement('button');
      b.className = t.id === tool ? 'on' : '';
      b.innerHTML = `<span>${t.label}</span><kbd>${t.key}</kbd>`;
      b.addEventListener('click', () => setTool(t.id));
      return b;
    }),
  );
  $('tool-hint').textContent = TOOLS.find((t) => t.id === tool)!.hint;
}

function setTool(t: Tool): void {
  tool = t;
  draftPoly = [];
  if (t !== 'sight') {
    sightPinned = false;
    sightFrom = null;
    sightCells = null;
  }
  renderTools();
  renderInspector();
  cv.style.cursor = t === 'select' ? 'default' : 'crosshair';
  requestDraw();
}

function renderLayers(): void {
  $('layers').replaceChildren(
    ...(Object.keys(LAYERS) as Layer[]).map((k) => {
      const l = document.createElement('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = layers[k];
      c.addEventListener('change', () => {
        layers[k] = c.checked;
        selection = [];
        renderInspector();
        requestDraw();
      });
      l.append(c, LAYERS[k]);
      return l;
    }),
  );
}

function objectButton(text: string, sub: string, ref: Ref): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = selection.some((r) => sameRef(r, ref)) ? 'on' : '';
  const name = document.createElement('b');
  name.style.fontWeight = '400';
  name.textContent = text;
  const size = document.createElement('span');
  size.textContent = sub;
  b.append(name, size);
  b.addEventListener('click', () => {
    selection = [ref];
    refreshSelection();
  });
  return b;
}

function renderObjects(): void {
  const q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  const size = (r: MRect): string => `${r.x1 - r.x0}×${r.y1 - r.y0}`;
  const group = (title: string, items: HTMLButtonElement[]): HTMLElement[] => {
    if (items.length === 0) return [];
    const h = document.createElement('h3');
    h.textContent = `${title}（${items.length}）`;
    return [h, ...items];
  };
  const match = (s: string): boolean => q === '' || s.toLowerCase().includes(q);
  const out: HTMLElement[] = [];
  out.push(...group('區域', doc.areas.flatMap((a, i) => (match(`${a.name} ${a.id}`) ? [objectButton(a.name, size(a), { kind: 'area', i })] : []))));
  if (q === '') {
    out.push(...group('實心牆', doc.blocks.map((b, i) => objectButton(`牆 ${b.x0},${b.y0}`, size(b), { kind: 'block', i }))));
    out.push(...group('矮掩體', doc.low.map((b, i) => objectButton(`掩體 ${b.x0},${b.y0}`, size(b), { kind: 'low', i }))));
    out.push(...group('斜角', doc.polys.map((p, i) => objectButton(POLY_MODE[p.mode], `${p.slope === true ? '斜切' : '鋸齒'}・${p.pts.length} 點`, { kind: 'poly', i }))));
    out.push(...group('包點', doc.sites.map((s, i) => objectButton(`${s.id} 可下包區`, size(s), { kind: 'site', i }))));
    out.push(...group('出生區', (['T', 'CT'] as const).map((team) => objectButton(`${team} 出生區`, size(doc.spawnZones[team]), { kind: 'zone', team }))));
  }
  $('objects').replaceChildren(...out);
}

function field(labelText: string, value: string | number, on: (v: string) => void, opts: { type?: string; wide?: boolean } = {}): HTMLLabelElement {
  const l = document.createElement('label');
  if (opts.wide === true) l.className = 'wide';
  l.textContent = labelText;
  const i = document.createElement('input');
  i.type = opts.type ?? 'number';
  i.value = String(value);
  i.autocomplete = 'off';
  i.addEventListener('input', () => {
    if (i.type === 'number' && !Number.isFinite(i.valueAsNumber)) return;
    on(i.value);
    rebuild();
  });
  i.addEventListener('change', commit);
  l.append(i);
  return l;
}

function actionButton(text: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', on);
  return b;
}

function renderInspector(): void {
  const box = $('inspector');
  if (tool === 'sight') {
    const l = document.createElement('label');
    l.className = 'row';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = sightCrouch;
    c.addEventListener('change', () => {
      sightCrouch = c.checked;
      rebuild();
    });
    l.append(c, '蹲姿（矮掩體貼近時擋視線）');
    box.replaceChildren(l);
    return;
  }
  if (selection.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '沒有選取物件';
    box.replaceChildren(p);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const r = selection[0];
  if (selection.length > 1) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = `已選 ${selection.length} 個物件`;
    box.replaceChildren(p, actions);
  } else {
    box.replaceChildren(grid, actions);
    if (r.kind === 'area') {
      const a = doc.areas[r.i];
      grid.append(field('名稱', a.name, (v) => (a.name = v), { type: 'text' }), field('代號', a.id, (v) => (a.id = v), { type: 'text' }));
    }
    const rect = rectOf(r);
    if (rect !== null) {
      const num = (k: keyof MRect, name: string): HTMLLabelElement => field(name, rect[k], (v) => (rect[k] = Math.round(Number(v))));
      grid.append(num('x0', '左 x0'), num('y0', '上 y0'), num('x1', '右 x1'), num('y1', '下 y1'));
    }
    if (r.kind === 'spawn') {
      const s = doc.spawns[r.team][r.i];
      grid.append(
        field('格 x', cellOf(s.x), (v) => (s.x = Math.round(Number(v)) * UNIT + UNIT / 2)),
        field('格 y', cellOf(s.y), (v) => (s.y = Math.round(Number(v)) * UNIT + UNIT / 2)),
        field('朝向（度）', s.facing, (v) => (s.facing = Number(v)), { wide: true }),
      );
    }
    if (r.kind === 'poly') {
      const p = doc.polys[r.i];
      const choice = (name: string, options: string, value: string, set: (v: string) => void): void => {
        const l = document.createElement('label');
        l.className = 'wide';
        l.textContent = name;
        const s = document.createElement('select');
        s.innerHTML = options;
        s.value = value;
        s.addEventListener('change', () => {
          set(s.value);
          commit();
        });
        l.append(s);
        grid.append(l);
      };
      choice('作用', '<option value="wall">填牆</option><option value="low">填矮牆</option><option value="open">挖開</option>', p.mode, (v) => (p.mode = v as MPoly['mode']));
      choice('斜邊', '<option value="slope">斜切（只能 45°）</option><option value="jagged">鋸齒（舊圖用）</option>', p.slope === true ? 'slope' : 'jagged', (v) => {
        if (v === 'slope') p.slope = true;
        else delete p.slope;
      });
    }
    if (r.kind === 'block' || r.kind === 'low') actions.append(actionButton(r.kind === 'block' ? '改成矮掩體' : '改成實心牆', swapCover));
  }
  if (selection.some((s) => s.kind === 'area' || s.kind === 'block' || s.kind === 'low' || s.kind === 'poly')) {
    actions.append(actionButton('複製', duplicateSelection), actionButton('刪除', removeSelection));
  }
}

function renderChecks(): void {
  const icon = { ok: '✓', fail: '✕', warn: '!', info: '·' } as const;
  $('checks').replaceChildren(
    ...checks.map((c, i) => {
      const clickable = c.cells !== undefined && c.cells.length > 0;
      const b = document.createElement(clickable ? 'button' : 'div');
      b.className = `check ${c.level}${clickable ? ' clickable' : ''}${i === activeCheck ? ' active' : ''}`;
      const mark = document.createElement('i');
      mark.textContent = icon[c.level];
      const name = document.createElement('span');
      name.textContent = c.label;
      const detail = document.createElement('small');
      detail.textContent = c.detail;
      b.append(mark, name, detail);
      if (clickable) {
        b.addEventListener('click', () => {
          activeCheck = activeCheck === i ? -1 : i;
          marks = activeCheck < 0 ? [] : checks[i].cells!;
          renderChecks();
          requestDraw();
        });
      }
      return b;
    }),
  );
}

function refreshSelection(): void {
  renderObjects();
  renderInspector();
  requestDraw();
}

// ---------- 滑鼠 ----------

function cellAt(e: PointerEvent | WheelEvent): { x: number; y: number } {
  const b = cv.getBoundingClientRect();
  return { x: (e.clientX - b.left - view.ox) / view.scale, y: (e.clientY - b.top - view.oy) / view.scale };
}

const clampX = (v: number): number => Math.max(0, Math.min(doc.width, v));
const clampY = (v: number): number => Math.max(0, Math.min(doc.height, v));

function handleAt(e: PointerEvent): Drag | null {
  if (selection.length !== 1) return null;
  const b = cv.getBoundingClientRect();
  const px = e.clientX - b.left;
  const py = e.clientY - b.top;
  const r = selection[0];
  if (r.kind === 'poly') {
    const v = doc.polys[r.i].pts.findIndex(([x, y]) => Math.hypot(sx(x) - px, sy(y) - py) <= HANDLE_PX);
    return v >= 0 ? { t: 'vertex', poly: r.i, v } : null;
  }
  const rect = rectOf(r);
  if (rect === null) return null;
  const h = handlesOf(rect).find((p) => Math.hypot(p.x - px, p.y - py) <= HANDLE_PX);
  return h === undefined ? null : { t: 'resize', ref: r, hx: h.hx, hy: h.hy, orig: { ...rect } };
}

function pointerSelect(e: PointerEvent, x: number, y: number): void {
  const grip = handleAt(e);
  if (grip !== null) {
    drag = grip;
    return;
  }
  const hits = hitsAt(x, y);
  if (e.shiftKey) {
    drag = { t: 'box', x0: x, y0: y, x1: x, y1: y, additive: true, top: hits[0] ?? null };
    return;
  }
  if (hits.length === 0) {
    selection = [];
    refreshSelection();
    drag = { t: 'box', x0: x, y0: y, x1: x, y1: y, additive: false, top: null };
    return;
  }
  const held = selection.find((s) => hits.some((h) => sameRef(h, s)));
  let cycle: Ref | null = null;
  if (held === undefined) {
    selection = [hits[0]];
    refreshSelection();
  } else if (selection.length === 1) {
    // 再點一次沒拖動，就換到底下那一層
    const at = hits.findIndex((h) => sameRef(h, held));
    cycle = hits[(at + 1) % hits.length];
  }
  drag = { t: 'move', cx: x, cy: y, orig: selection.map((r) => JSON.parse(JSON.stringify(objectOf(r)))), moved: false, cycle };
}

/** 從上一點出發，把落點吸到最接近的水平、垂直或 45° 方向 */
function snapPoly(from: readonly [number, number], p: [number, number]): [number, number] {
  const dx = p[0] - from[0];
  const dy = p[1] - from[1];
  if (Math.abs(dx) * 2 < Math.abs(dy)) return [from[0], p[1]];
  if (Math.abs(dy) * 2 < Math.abs(dx)) return [p[0], from[1]];
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx) * d, from[1] + Math.sign(dy) * d];
}

function pointerPoly(x: number, y: number): void {
  const p: [number, number] = [Math.round(x), Math.round(y)];
  const [fx, fy] = draftPoly[0] ?? [Infinity, Infinity];
  if (draftPoly.length >= 3 && p[0] === fx && p[1] === fy) finishPoly();
  else draftPoly.push(draftPoly.length === 0 ? p : snapPoly(draftPoly[draftPoly.length - 1], p));
  requestDraw();
}

function finishPoly(): void {
  if (draftPoly.length >= 3) {
    selection = [{ kind: 'poly', i: doc.polys.push({ mode: 'wall', slope: true, pts: draftPoly }) - 1 }];
    draftPoly = [];
    setTool('select');
    commit();
  }
}

function pointerMeasure(x: number, y: number): void {
  const p: [number, number] = [Math.floor(x), Math.floor(y)];
  if (measure.a === null || measure.b !== null) measure = { a: p, b: null, path: [], cells: 0 };
  else {
    const f = pathField(map, measure.a[0], measure.a[1]);
    measure = { a: measure.a, b: p, path: tracePath(map, f, p[0], p[1]), cells: f[p[1] * map.width + p[0]] };
  }
  requestDraw();
}

function updateSight(x: number, y: number): void {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return;
  if (sightFrom?.[0] === cx && sightFrom[1] === cy) return;
  sightFrom = [cx, cy];
  sightCells = visibleCells(map, cx, cy, sightCrouch);
  requestDraw();
}

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const { x, y } = cellAt(e);
  if (e.button === 1 || e.button === 2 || spaceDown) {
    drag = { t: 'pan', sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
    return;
  }
  switch (tool) {
    case 'select':
      pointerSelect(e, x, y);
      break;
    case 'area':
    case 'block':
    case 'low':
      drag = { t: 'rect', kind: tool, x0: clampX(Math.round(x)), y0: clampY(Math.round(y)), x1: clampX(Math.round(x)), y1: clampY(Math.round(y)) };
      break;
    case 'poly':
      pointerPoly(x, y);
      break;
    case 'measure':
      pointerMeasure(x, y);
      break;
    case 'sight':
      sightPinned = !sightPinned;
      updateSight(x, y);
      break;
  }
});

cv.addEventListener('pointermove', (e) => {
  const { x, y } = cellAt(e);
  cursor = { x, y };
  if (tool === 'sight' && !sightPinned) updateSight(x, y);
  if (drag === null) {
    requestDraw();
    return;
  }
  switch (drag.t) {
    case 'pan':
      viewTouched = true;
      view.ox = drag.ox + e.clientX - drag.sx;
      view.oy = drag.oy + e.clientY - drag.sy;
      break;
    case 'move':
      moveTo(drag, Math.round(x - drag.cx), Math.round(y - drag.cy));
      break;
    case 'resize': {
      const r = rectOf(drag.ref)!;
      const o = drag.orig;
      const cx = clampX(Math.round(x));
      const cy = clampY(Math.round(y));
      if (drag.hx === 0) r.x0 = Math.min(cx, o.x1 - 1);
      if (drag.hx === 2) r.x1 = Math.max(cx, o.x0 + 1);
      if (drag.hy === 0) r.y0 = Math.min(cy, o.y1 - 1);
      if (drag.hy === 2) r.y1 = Math.max(cy, o.y0 + 1);
      rebuild();
      break;
    }
    case 'vertex':
      doc.polys[drag.poly].pts[drag.v] = [clampX(Math.round(x)), clampY(Math.round(y))];
      rebuild();
      break;
    case 'box':
      drag.x1 = x;
      drag.y1 = y;
      break;
    case 'rect':
      drag.x1 = clampX(Math.round(x));
      drag.y1 = clampY(Math.round(y));
      break;
  }
  requestDraw();
});

function moveTo(d: Extract<Drag, { t: 'move' }>, dx: number, dy: number): void {
  // 先還原再算，邊界夾住時物件之間不會錯位
  selection.forEach((r, i) => shift(d.orig[i], 0, 0, objectOf(r)));
  const [mx, my] = clampMove(selection, dx, dy);
  selection.forEach((r, i) => shift(d.orig[i], mx, my, objectOf(r)));
  if (mx !== 0 || my !== 0) d.moved = true;
  rebuild();
}

function finishBox(d: Extract<Drag, { t: 'box' }>): void {
  const b = { x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) };
  if (b.x1 - b.x0 < 0.5 && b.y1 - b.y0 < 0.5) {
    if (d.additive && d.top !== null) {
      const top = d.top;
      const had = selection.some((r) => sameRef(r, top));
      selection = had ? selection.filter((r) => !sameRef(r, top)) : [...selection, top];
    }
  } else {
    const inside = allRefs().filter((r) => {
      const o = bboxOf(r);
      return o.x0 >= b.x0 && o.y0 >= b.y0 && o.x1 <= b.x1 && o.y1 <= b.y1;
    });
    selection = d.additive ? [...selection, ...inside.filter((r) => !selection.some((s) => sameRef(s, r)))] : inside;
  }
  refreshSelection();
}

function finishRect(d: Extract<Drag, { t: 'rect' }>): void {
  const r: MRect = { x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) };
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
  if (d.kind === 'area') {
    const id = uniqueAreaId('area');
    selection = [{ kind: 'area', i: doc.areas.push({ id, name: '新區域', ...r }) - 1 }];
  } else if (d.kind === 'block') selection = [{ kind: 'block', i: doc.blocks.push(r) - 1 }];
  else selection = [{ kind: 'low', i: doc.low.push(r) - 1 }];
  commit();
}

cv.addEventListener('pointerup', () => {
  const d = drag;
  drag = null;
  if (d === null) return;
  if (d.t === 'move') {
    if (d.moved) commit();
    else if (d.cycle !== null) {
      selection = [d.cycle];
      refreshSelection();
    }
  } else if (d.t === 'resize' || d.t === 'vertex') commit();
  else if (d.t === 'box') finishBox(d);
  else if (d.t === 'rect') finishRect(d);
  requestDraw();
});

cv.addEventListener('dblclick', () => {
  if (tool === 'poly') finishPoly();
});
cv.addEventListener('pointerleave', () => {
  cursor = null;
  requestDraw();
});
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    viewTouched = true;
    const { x, y } = cellAt(e);
    const b = cv.getBoundingClientRect();
    view.scale = Math.max(3, Math.min(48, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    view.ox = e.clientX - b.left - x * view.scale;
    view.oy = e.clientY - b.top - y * view.scale;
    requestDraw();
  },
  { passive: false },
);

function fit(): void {
  viewTouched = false;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  view.scale = Math.max(3, (Math.min(w, h) - 16) / Math.max(doc.width, doc.height));
  view.ox = (w - doc.width * view.scale) / 2;
  view.oy = (h - doc.height * view.scale) / 2;
  requestDraw();
}

// ---------- 鍵盤 ----------

function nudge(dx: number, dy: number): void {
  if (selection.length === 0) return;
  const [mx, my] = clampMove(selection, dx, dy);
  for (const r of selection) {
    const o = objectOf(r);
    shift(JSON.parse(JSON.stringify(o)), mx, my, o);
  }
  commit();
}

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
    return;
  }
  if (typing) return;
  if (ctrl && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelection();
    return;
  }
  if (ctrl) return;
  const step = e.shiftKey ? 5 : 1;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      spaceDown = true;
      cv.style.cursor = 'grab';
      return;
    case 'Delete':
    case 'Backspace':
      removeSelection();
      return;
    case 'Enter':
      finishPoly();
      return;
    case 'Escape':
      draftPoly = [];
      selection = [];
      measure = { a: null, b: null, path: [], cells: 0 };
      setTool('select');
      refreshSelection();
      return;
    case 'ArrowLeft':
      e.preventDefault();
      nudge(-step, 0);
      return;
    case 'ArrowRight':
      e.preventDefault();
      nudge(step, 0);
      return;
    case 'ArrowUp':
      e.preventDefault();
      nudge(0, -step);
      return;
    case 'ArrowDown':
      e.preventDefault();
      nudge(0, step);
      return;
  }
  const k = e.key.toUpperCase();
  if (k === 'F') fit();
  const t = TOOLS.find((o) => o.key === k);
  if (t !== undefined) setTool(t.id);
});

window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  spaceDown = false;
  cv.style.cursor = tool === 'select' ? 'default' : 'crosshair';
});

// ---------- 存檔與開啟 ----------

const fileName = (): string => doc.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'map';

function download(): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([formatDoc(doc)], { type: 'application/json' }));
  a.download = `${fileName()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 開發伺服器上存進 maps/shooter/；沒有伺服器時退回下載 */
async function save(): Promise<void> {
  const el = $('dirty');
  try {
    const res = await fetch(`${FILES_API}/${fileName()}`, { method: 'POST', body: formatDoc(doc) });
    if (!res.ok) throw new Error(await res.text());
    savedSnapshot = snapshot;
    renderTop();
    el.textContent = `已存到 maps/shooter/${fileName()}.json`;
    void listFiles();
  } catch {
    download();
    savedSnapshot = snapshot;
    renderTop();
    el.textContent = '沒有開發伺服器，已改用下載';
  }
}

async function listFiles(): Promise<void> {
  const box = $<HTMLSelectElement>('open');
  let files: string[] = [];
  try {
    const res = await fetch(FILES_API);
    if (res.ok) files = (await res.json()) as string[];
  } catch {
    files = [];
  }
  const option = (value: string, text: string): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  box.replaceChildren(option('', '開啟地圖…'), ...files.map((f) => option(`file:${f}`, `${f}.json`)), ...Object.entries(PRESETS).map(([k, p]) => option(`preset:${k}`, p.label)));
}

async function fetchFile(name: string): Promise<EditDoc> {
  const res = await fetch(`${FILES_API}/${name}`);
  if (!res.ok) throw new Error(`讀不到 ${name}.json`);
  return parseDoc(await res.json());
}

async function openChoice(value: string): Promise<void> {
  if (value === '') return;
  if (snapshot !== savedSnapshot && !confirm('目前的修改還沒存檔，要放棄並開啟別的地圖嗎？')) return;
  try {
    if (value.startsWith('preset:')) loadDoc(toDoc(PRESETS[value.slice(7)].layout));
    else loadDoc(await fetchFile(value.slice(5)));
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}

function wirePanels(): void {
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('save').addEventListener('click', () => void save());
  $('download').addEventListener('click', download);
  $('import').addEventListener('click', () => $('import-file').click());
  const file = $<HTMLInputElement>('import-file');
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (f === undefined) return;
    try {
      loadDoc(parseDoc(JSON.parse(await f.text())));
      savedSnapshot = '';
      renderTop();
    } catch (e) {
      alert(`匯入失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const open = $<HTMLSelectElement>('open');
  open.addEventListener('change', () => {
    const v = open.value;
    open.value = '';
    void openChoice(v);
  });
  const name = $<HTMLInputElement>('map-name');
  const id = $<HTMLInputElement>('map-id');
  name.addEventListener('change', () => {
    doc.name = name.value;
    commit();
  });
  id.addEventListener('change', () => {
    doc.id = id.value;
    commit();
  });
  $('filter').addEventListener('input', renderObjects);
  const overlayBox = $<HTMLSelectElement>('overlay');
  overlayBox.addEventListener('change', () => {
    overlay = overlayBox.value;
    $('overlay-hint').textContent = overlay === 'race' ? '橘色 T 先到、藍色 CT 先到，白色是雙方 1 秒內同時到的交戰線。' : overlay === 'none' ? '' : '每 5 秒一道色帶，從中間那位出生點起算。';
    paintOverlay();
    requestDraw();
  });
  new ResizeObserver(() => (viewTouched ? requestDraw() : fit())).observe(stage);
}

async function start(): Promise<void> {
  wirePanels();
  renderTools();
  renderLayers();
  await listFiles();
  let first: EditDoc | null = null;
  let restored = false;
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (text !== null) {
      first = parseDoc(JSON.parse(text));
      restored = true;
    }
  } catch {
    first = null;
  }
  if (first === null) {
    try {
      first = await fetchFile(DEFAULT_FILE);
    } catch {
      first = toDoc(DRAFT_LAYOUT);
    }
  }
  loadDoc(first);
  if (restored) {
    savedSnapshot = '';
    renderTop();
    $('dirty').textContent = '已還原上次的編輯，尚未存檔';
  }
}

void start();
