// Canvas 2D 繪圖：地形、礦點、瞭望塔、建築、單位、迷霧、選取與放置提示、小地圖。只讀取狀態。
import { BUILDING_STATS, CONQUEST, RULES, TILE_SIZE, UNIT_STATS, type BuildingType } from '../config/index.ts';
import type { BuildingFrame, FrameView, StaticMapView, UnitFrame } from '../view/snapshot.ts';
import { drawIcon } from './icons.ts';
import { TEAM_COLORS } from './labels.ts';

export const TILE_PX = 16;
/** 指令位置提示的顯示時間（毫秒） */
const MARKER_MS = 600;
/** 縮放範圍（看全圖時可以縮到更小） */
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 3;

export interface Camera {
  /** 畫面左上角的世界座標（單位） */
  x: number;
  y: number;
  zoom: number;
}

export interface Ghost {
  readonly type: BuildingType;
  readonly tileX: number;
  readonly tileY: number;
  readonly valid: boolean;
}

export interface ViewModel {
  readonly map: StaticMapView;
  prev: FrameView | null;
  cur: FrameView | null;
  frameAt: number;
  frameInterval: number;
  camera: Camera;
  selection: Set<number>;
  selectedBuilding: number | null;
  drag: { x0: number; y0: number; x1: number; y1: number } | null;
  ghost: Ghost | null;
  mode: 'normal' | 'attackMove' | 'move' | 'place';
  /** 下指令的位置提示（短暫的擴散圓圈） */
  markers: { x: number; y: number; color: string; at: number }[];
  /** 教學提示的位置（地圖與小地圖上閃爍） */
  beacon: { x: number; y: number } | null;
  /** 受攻擊提示（小地圖閃爍） */
  alerts: { x: number; y: number; until: number }[];
  /** 交戰熱點（觀戰時於小地圖標示） */
  hotspots: readonly { readonly x: number; readonly y: number; readonly hits: number }[];
  /** 人類玩家 id（觀戰／回放為 null） */
  human: number | null;
}

/** 選取時最多畫幾個單位的範圍圈 */
const MAX_RANGE_RINGS = 24;

/** 顏色調亮（f > 0）或調暗（f < 0） */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number => Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** #rrggbb → rgba(r,g,b,a) */
function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function hpColor(frac: number): string {
  return frac > 0.5 ? '#22c55e' : frac > 0.25 ? '#eab308' : '#ef4444';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function teamColor(id: number): string {
  return TEAM_COLORS[id % TEAM_COLORS.length];
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mctx: CanvasRenderingContext2D;
  private readonly terrain: HTMLCanvasElement;
  private readonly fogCanvas: HTMLCanvasElement;
  private readonly fogCtx: CanvasRenderingContext2D;
  private readonly fogImage: ImageData;
  private readonly map: StaticMapView;
  readonly canvas: HTMLCanvasElement;
  readonly minimap: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, map: StaticMapView) {
    this.canvas = canvas;
    this.minimap = minimap;
    this.map = map;
    this.ctx = canvas.getContext('2d')!;
    this.mctx = minimap.getContext('2d')!;
    this.terrain = document.createElement('canvas');
    this.terrain.width = map.width * TILE_PX;
    this.terrain.height = map.height * TILE_PX;
    this.paintTerrain();
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = map.width;
    this.fogCanvas.height = map.height;
    this.fogCtx = this.fogCanvas.getContext('2d')!;
    this.fogImage = this.fogCtx.createImageData(map.width, map.height);
  }

  /** 地形底圖（只畫一次）：平地、岩石、樹林，依座標做細微的明暗變化 */
  private paintTerrain(): void {
    const c = this.terrain.getContext('2d')!;
    const { width, height, tiles } = this.map;
    const T = TILE_PX;
    const hash = (x: number, y: number): number => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = tiles[y * width + x];
        const h = hash(x, y);
        const px = x * T;
        const py = y * T;
        if (t === 1) {
          // 岩石：深色石塊，上緣亮、下緣暗
          c.fillStyle = '#23262c';
          c.fillRect(px, py, T, T);
          c.fillStyle = h % 3 === 0 ? '#3a3f48' : '#353a42';
          c.fillRect(px + 1, py + 1, T - 2, T - 2);
          c.fillStyle = 'rgba(255,255,255,0.08)';
          c.fillRect(px + 1, py + 1, T - 2, 2);
          c.fillStyle = 'rgba(0,0,0,0.25)';
          c.fillRect(px + 1, py + T - 3, T - 2, 2);
          continue;
        }
        // 平地與樹林的地面
        const shade = (h % 7) - 3;
        c.fillStyle = t === 2 ? `hsl(105, 30%, ${21 + shade * 0.4}%)` : `hsl(95, 26%, ${34 + shade * 0.6}%)`;
        c.fillRect(px, py, T, T);
        if (t === 0 && h % 5 === 0) {
          c.fillStyle = 'rgba(255,255,255,0.05)';
          c.fillRect(px + (h % 11), py + ((h >> 4) % 11), 2, 2);
        }
        if (t === 2) {
          // 樹冠：兩到三團
          const n = 2 + (h % 2);
          for (let i = 0; i < n; i++) {
            const tx = px + 3 + ((h >> (i * 5)) % 10);
            const ty = py + 3 + ((h >> (i * 5 + 3)) % 10);
            c.fillStyle = '#17301a';
            c.beginPath();
            c.arc(tx + 1, ty + 1, 3.6, 0, Math.PI * 2);
            c.fill();
            c.fillStyle = i % 2 === 0 ? '#2d5a2c' : '#336633';
            c.beginPath();
            c.arc(tx, ty, 3.4, 0, Math.PI * 2);
            c.fill();
          }
        }
      }
    }
    // 非常淡的格線
    c.strokeStyle = 'rgba(0,0,0,0.05)';
    c.lineWidth = 1;
    for (let x = 0; x <= width; x++) {
      c.beginPath();
      c.moveTo(x * T + 0.5, 0);
      c.lineTo(x * T + 0.5, height * T);
      c.stroke();
    }
    for (let y = 0; y <= height; y++) {
      c.beginPath();
      c.moveTo(0, y * T + 0.5);
      c.lineTo(width * T, y * T + 0.5);
      c.stroke();
    }
  }

  /** 每單位對應的螢幕像素 */
  scale(cam: Camera): number {
    return (TILE_PX * cam.zoom) / TILE_SIZE;
  }

  screenToWorld(cam: Camera, px: number, py: number): { x: number; y: number } {
    const s = this.scale(cam);
    return { x: cam.x + px / s, y: cam.y + py / s };
  }

  /** 調整畫布大小（裝置像素比） */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
  }

  /** 限制鏡頭範圍；地圖比畫面小時置中 */
  clampCamera(cam: Camera): void {
    const s = this.scale(cam);
    const viewW = this.canvas.clientWidth / s;
    const viewH = this.canvas.clientHeight / s;
    const mapW = this.map.width * TILE_SIZE;
    const mapH = this.map.height * TILE_SIZE;
    const margin = 4 * TILE_SIZE;
    cam.x = viewW >= mapW + 2 * margin ? (mapW - viewW) / 2 : Math.max(-margin, Math.min(mapW - viewW + margin, cam.x));
    cam.y = viewH >= mapH + 2 * margin ? (mapH - viewH) / 2 : Math.max(-margin, Math.min(mapH - viewH + margin, cam.y));
  }

  /** 縮放到看得到整張地圖並置中 */
  fitCamera(cam: Camera): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    cam.zoom = Math.max(MIN_ZOOM, Math.min(w / (this.map.width * TILE_PX), h / (this.map.height * TILE_PX)) * 0.96);
    this.clampCamera(cam);
  }

  /** 插值後的單位位置 */
  private positions(vm: ViewModel, now: number): Map<number, { x: number; y: number }> {
    const out = new Map<number, { x: number; y: number }>();
    const cur = vm.cur!;
    const a = vm.frameInterval > 0 ? Math.min(1, (now - vm.frameAt) / vm.frameInterval) : 1;
    const prevPos = new Map<number, UnitFrame>();
    if (vm.prev !== null) for (const u of vm.prev.units) prevPos.set(u.id, u);
    for (const u of cur.units) {
      const p = prevPos.get(u.id);
      if (p === undefined || Math.abs(p.x - u.x) > 3000 || Math.abs(p.y - u.y) > 3000) out.set(u.id, { x: u.x, y: u.y });
      else out.set(u.id, { x: p.x + (u.x - p.x) * a, y: p.y + (u.y - p.y) * a });
    }
    return out;
  }

  draw(vm: ViewModel, now: number): void {
    const cur = vm.cur;
    if (cur === null) return;
    this.resize();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const cam = vm.camera;
    const s = this.scale(cam);
    const wx = (x: number): number => (x - cam.x) * s;
    const wy = (y: number): number => (y - cam.y) * s;
    const tilePx = TILE_PX * cam.zoom;

    // 縮小時平滑取樣，避免地形閃爍；放大時保持清晰
    ctx.imageSmoothingEnabled = cam.zoom < 1;
    ctx.drawImage(this.terrain, wx(0), wy(0), this.map.width * tilePx, this.map.height * tilePx);

    // 礦點：晶體（一般淺藍、富礦金色、採光灰色）
    this.map.nodes.forEach((n, i) => {
      const reserve = cur.nodes[i];
      const cx = wx(n.tileX * TILE_SIZE + 500);
      const cy = wy(n.tileY * TILE_SIZE + 500);
      const r = tilePx * (reserve <= 0 ? 0.32 : 0.44);
      const [light, dark] = reserve <= 0 ? ['#6b7280', '#4b5563'] : n.rich ? ['#fde68a', '#d97706'] : ['#bae6fd', '#38bdf8'];
      if (n.rich && reserve > 0 && tilePx >= 8) {
        ctx.fillStyle = 'rgba(251,191,36,0.18)';
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.75, cy - r * 0.15);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.75, cy - r * 0.15);
      ctx.closePath();
      ctx.fillStyle = dark;
      ctx.fill();
      // 左側亮面
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.75, cy - r * 0.15);
      ctx.closePath();
      ctx.fillStyle = light;
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,23,42,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.75, cy - r * 0.15);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.75, cy - r * 0.15);
      ctx.closePath();
      ctx.stroke();
    });

    // 搶點模式：控制點（範圍、佔領值、佔領進度、旗幟）
    if (this.map.ruleset === 'conquest') this.drawControlPoints(cur, wx, wy, tilePx);
    // 瞭望塔：佔領範圍（虛線）、佔領進度（弧線）、塔身圖示
    else this.map.towers.forEach((t, i) => {
      const tw = cur.towers[i];
      const owner = tw?.owner ?? -1;
      const cx = wx(t.x);
      const cy = wy(t.y);
      const ring = RULES.watchtower.captureRadiusTiles * tilePx;
      ctx.beginPath();
      ctx.arc(cx, cy, ring, 0, Math.PI * 2);
      ctx.strokeStyle = owner >= 0 ? teamColor(owner) : 'rgba(255,255,255,0.35)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (tw !== undefined && owner !== -2) {
        let best = -1;
        for (let p = 0; p < tw.progress.length; p++) if (p !== owner && tw.progress[p] > 0 && (best < 0 || tw.progress[p] > tw.progress[best])) best = p;
        if (best >= 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, ring, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * tw.progress[best]) / RULES.watchtower.captureTarget);
          ctx.strokeStyle = teamColor(best);
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
      const r = Math.max(6, tilePx * 0.75);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#111827';
      ctx.fill();
      ctx.strokeStyle = owner >= 0 ? teamColor(owner) : owner === -2 ? '#6b7280' : '#e5e7eb';
      ctx.lineWidth = 2;
      ctx.stroke();
      drawIcon(ctx, 'watchtower', cx, cy, r * 1.35, owner >= 0 ? teamColor(owner) : '#e5e7eb', 1.8);
    });

    // 建築
    const byId = new Map<number, BuildingFrame>();
    for (const b of cur.buildings) {
      byId.set(b.id, b);
      this.drawBuilding(b, vm, wx, wy, tilePx);
    }

    // 單位
    const pos = this.positions(vm, now);
    const unitById = new Map<number, UnitFrame>();
    for (const u of cur.units) unitById.set(u.id, u);
    // 攻擊線
    ctx.lineWidth = 1;
    for (const u of cur.units) {
      if (u.attacking === 0) continue;
      const from = pos.get(u.id)!;
      const tu = pos.get(u.attacking);
      const tb = byId.get(u.attacking);
      const tx = tu?.x ?? (tb !== undefined ? (tb.tileX + tb.size / 2) * TILE_SIZE : null);
      const ty = tu?.y ?? (tb !== undefined ? (tb.tileY + tb.size / 2) * TILE_SIZE : null);
      if (tx === null || ty === null) continue;
      ctx.strokeStyle = u.type === 'archer' ? 'rgba(255,255,255,0.55)' : 'rgba(255,220,120,0.6)';
      ctx.beginPath();
      ctx.moveTo(wx(from.x), wy(from.y));
      ctx.lineTo(wx(tx), wy(ty));
      ctx.stroke();
    }
    for (const b of cur.buildings) {
      if (b.attacking === 0) continue;
      const tu = pos.get(b.attacking);
      if (tu === undefined) continue;
      ctx.strokeStyle = 'rgba(255,120,120,0.7)';
      ctx.beginPath();
      ctx.moveTo(wx((b.tileX + 0.5) * TILE_SIZE), wy((b.tileY + 0.5) * TILE_SIZE));
      ctx.lineTo(wx(tu.x), wy(tu.y));
      ctx.stroke();
    }
    for (const u of cur.units) this.drawUnit(u, pos.get(u.id)!, vm, wx, wy, s);
    this.drawRanges(vm, pos, wx, wy, s, tilePx);

    // 迷霧
    if (cur.fog !== null) {
      const data = this.fogImage.data;
      for (let i = 0; i < cur.fog.length; i++) {
        const f = cur.fog[i];
        data[i * 4] = 0;
        data[i * 4 + 1] = 0;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = f === 0 ? 255 : f === 1 ? 135 : 0;
      }
      this.fogCtx.putImageData(this.fogImage, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.fogCanvas, wx(0), wy(0), this.map.width * tilePx, this.map.height * tilePx);
    }

    // 選取建築的集結點
    if (vm.selectedBuilding !== null) {
      const b = byId.get(vm.selectedBuilding);
      if (b !== undefined && b.rally !== null) {
        ctx.strokeStyle = 'rgba(134,239,172,0.8)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(wx((b.tileX + b.size / 2) * TILE_SIZE), wy((b.tileY + b.size / 2) * TILE_SIZE));
        ctx.lineTo(wx(b.rally.x), wy(b.rally.y));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#86efac';
        ctx.beginPath();
        ctx.arc(wx(b.rally.x), wy(b.rally.y), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 放置提示
    if (vm.ghost !== null) {
      const size = BUILDING_STATS[vm.ghost.type].size;
      ctx.fillStyle = vm.ghost.valid ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.4)';
      ctx.strokeStyle = vm.ghost.valid ? '#22c55e' : '#ef4444';
      ctx.lineWidth = 2;
      ctx.fillRect(wx(vm.ghost.tileX * TILE_SIZE), wy(vm.ghost.tileY * TILE_SIZE), size * tilePx, size * tilePx);
      ctx.strokeRect(wx(vm.ghost.tileX * TILE_SIZE), wy(vm.ghost.tileY * TILE_SIZE), size * tilePx, size * tilePx);
    }

    // 框選
    if (vm.drag !== null) {
      const d = vm.drag;
      ctx.strokeStyle = '#86efac';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(134,239,172,0.1)';
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    // 指令位置提示
    vm.markers = vm.markers.filter((m) => now - m.at < MARKER_MS);
    for (const m of vm.markers) {
      const t = (now - m.at) / MARKER_MS;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(wx(m.x), wy(m.y), 4 + t * 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 教學提示
    if (vm.beacon !== null) {
      const pulse = (now % 1200) / 1200;
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 1 - pulse * 0.7;
      ctx.beginPath();
      ctx.arc(wx(vm.beacon.x), wy(vm.beacon.y), tilePx * (1.2 + pulse * 1.6), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (vm.mode === 'attackMove' || vm.mode === 'move') {
      ctx.fillStyle = vm.mode === 'attackMove' ? 'rgba(248,113,113,0.95)' : 'rgba(134,239,172,0.95)';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText(vm.mode === 'attackMove' ? '攻擊移動：左鍵點目的地（Esc 取消）' : '移動：左鍵點目的地（Esc 取消）', 12, this.canvas.clientHeight - 14);
    }

    this.drawMinimap(vm, pos);
  }

  private drawControlPoints(cur: FrameView, wx: (x: number) => number, wy: (y: number) => number, tilePx: number): void {
    const ctx = this.ctx;
    const arc = (x: number, y: number, r: number, frac: number, color: string, width: number): void => {
      if (frac <= 0) return;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    this.map.towers.forEach((t, i) => {
      const st = cur.towers[i];
      if (st === undefined) return;
      const cx = wx(t.x);
      const cy = wy(t.y);
      const R = CONQUEST.captureRadiusTiles * tilePx;
      const color = st.owner >= 0 ? teamColor(st.owner) : '#e5e7eb';
      // 範圍
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = st.owner >= 0 ? hexAlpha(color, 0.14) : 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.setLineDash(st.owner >= 0 ? [] : [6, 5]);
      ctx.strokeStyle = st.owner >= 0 ? hexAlpha(color, 0.75) : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = t.center ? 2.5 : 1.8;
      ctx.stroke();
      ctx.setLineDash([]);
      // 佔領值（被奪時遞減）與中立點的佔領進度
      if (st.owner >= 0 && st.hold < CONQUEST.captureTarget) arc(cx, cy, R - 4, st.hold / CONQUEST.captureTarget, color, 4);
      if (st.capturer >= 0) arc(cx, cy, R + 4, (st.progress[st.capturer] ?? 0) / CONQUEST.captureTarget, teamColor(st.capturer), 4);
      // 旗幟
      const r = Math.max(7, tilePx * (t.center ? 1.05 : 0.8));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0b1220';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = t.center ? 3 : 2;
      ctx.stroke();
      if (t.center) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = hexAlpha(color, 0.6);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      drawIcon(ctx, 'flag', cx, cy, r * 1.3, color, 2);
    });
  }

  private drawBuilding(b: BuildingFrame, vm: ViewModel, wx: (x: number) => number, wy: (y: number) => number, tilePx: number): void {
    const ctx = this.ctx;
    const x = wx(b.tileX * TILE_SIZE) + 1;
    const y = wy(b.tileY * TILE_SIZE) + 1;
    const w = b.size * tilePx - 2;
    const color = teamColor(b.owner);
    const selected = vm.selectedBuilding === b.id;
    const rad = Math.min(6, w * 0.18);
    // 陰影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, x + 2, y + 3, w, w, rad);
    ctx.fill();
    ctx.globalAlpha = b.remembered ? 0.45 : b.complete ? 1 : 0.6;
    ctx.fillStyle = shade(color, -0.35);
    roundRect(ctx, x, y, w, w, rad);
    ctx.fill();
    // 上半部較亮
    ctx.fillStyle = shade(color, -0.1);
    roundRect(ctx, x, y, w, w * 0.55, rad);
    ctx.fill();
    if (!b.complete) {
      // 建造中：斜紋
      ctx.save();
      roundRect(ctx, x, y, w, w, rad);
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = Math.max(2, w * 0.06);
      for (let d = -w; d < w; d += Math.max(6, w * 0.22)) {
        ctx.beginPath();
        ctx.moveTo(x + d, y + w);
        ctx.lineTo(x + d + w, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = selected ? '#ffffff' : shade(color, 0.25);
    ctx.lineWidth = selected ? 2.5 : 1.5;
    if (b.remembered) ctx.setLineDash([4, 3]);
    roundRect(ctx, x, y, w, w, rad);
    ctx.stroke();
    ctx.setLineDash([]);
    if (w >= 10) drawIcon(ctx, b.type, x + w / 2, y + w / 2, w * (b.size === 1 ? 0.78 : 0.6), b.remembered ? 'rgba(255,255,255,0.6)' : '#ffffff', Math.max(1.4, w * 0.045));
    // 主堡等級
    for (let i = 1; i < b.level; i++) {
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(x + w - 4 - (i - 1) * 6, y + 4, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (b.task !== null) this.bar(x + 2, y + w - 6, w - 4, 4, b.task.progress / 100, '#a78bfa');
    if (!b.complete) this.bar(x + 2, y + w - 6, w - 4, 4, b.progress / 100, '#facc15');
    if (b.hp < b.maxHp || selected) this.bar(x + 2, y - 6, w - 4, 3, b.hp / b.maxHp, hpColor(b.hp / b.maxHp));
  }

  private drawUnit(u: UnitFrame, p: { x: number; y: number }, vm: ViewModel, wx: (x: number) => number, wy: (y: number) => number, s: number): void {
    const ctx = this.ctx;
    const cx = wx(p.x);
    const cy = wy(p.y);
    const r = Math.max(3, UNIT_STATS[u.type].radius * s);
    const color = teamColor(u.owner);
    const selected = vm.selection.has(u.id);
    if (selected) {
      ctx.fillStyle = 'rgba(134,239,172,0.18)';
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = shade(color, -0.15);
    ctx.fill();
    ctx.strokeStyle = 'rgba(8,12,20,0.9)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // 兵種圖示（太小時只畫一個點）
    if (r >= 5) drawIcon(ctx, u.type, cx, cy, r * 1.5, '#ffffff', Math.max(1.3, r * 0.16));
    else {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, r * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
    if (u.carrying > 0) {
      const d = Math.max(2.5, r * 0.4);
      const bx = cx + r * 0.75;
      const by = cy - r * 0.75;
      ctx.fillStyle = '#7dd3fc';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx, by - d);
      ctx.lineTo(bx + d * 0.7, by);
      ctx.lineTo(bx, by + d);
      ctx.lineTo(bx - d * 0.7, by);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (selected) {
      ctx.strokeStyle = '#86efac';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (u.hp < u.maxHp || selected) this.bar(cx - r, cy - r - 6, r * 2, 3, u.hp / u.maxHp, hpColor(u.hp / u.maxHp));
  }

  /** 選取的單位與防禦塔：攻擊範圍（實線，到目標邊緣）與視野（虛線，只選一個時） */
  private drawRanges(vm: ViewModel, pos: Map<number, { x: number; y: number }>, wx: (x: number) => number, wy: (y: number) => number, s: number, tilePx: number): void {
    const cur = vm.cur!;
    const ctx = this.ctx;
    const units = cur.units.filter((u) => vm.selection.has(u.id)).slice(0, MAX_RANGE_RINGS);
    const circle = (x: number, y: number, r: number, color: string, dash: number[], width: number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    for (const u of units) {
      const p = pos.get(u.id)!;
      const st = UNIT_STATS[u.type];
      circle(wx(p.x), wy(p.y), (st.radius + st.range) * s, 'rgba(248,113,113,0.7)', [], 1.5);
      if (units.length === 1) circle(wx(p.x), wy(p.y), (st.sight + 0.5) * tilePx, 'rgba(226,232,240,0.45)', [5, 5], 1.2);
    }
    if (units.length === 0 && vm.selectedBuilding !== null) {
      const b = cur.buildings.find((x) => x.id === vm.selectedBuilding);
      if (b !== undefined && !b.remembered) {
        const cx = wx((b.tileX + b.size / 2) * TILE_SIZE);
        const cy = wy((b.tileY + b.size / 2) * TILE_SIZE);
        const weapon = BUILDING_STATS[b.type].weapon;
        if (weapon !== null && b.complete) circle(cx, cy, weapon.range * s, 'rgba(248,113,113,0.7)', [], 1.5);
        circle(cx, cy, (BUILDING_STATS[b.type].sight + b.size / 2) * tilePx, 'rgba(226,232,240,0.35)', [5, 5], 1.2);
      }
    }
  }

  private bar(x: number, y: number, w: number, h: number, frac: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.max(0, Math.min(1, frac)) * w, h);
  }

  private drawMinimap(vm: ViewModel, pos: Map<number, { x: number; y: number }>): void {
    const cur = vm.cur!;
    const m = this.mctx;
    const size = this.minimap.width;
    const k = size / Math.max(this.map.width, this.map.height);
    m.imageSmoothingEnabled = false;
    m.drawImage(this.terrain, 0, 0, this.map.width * k, this.map.height * k);
    for (const b of cur.buildings) {
      m.fillStyle = teamColor(b.owner);
      m.globalAlpha = b.remembered ? 0.6 : 1;
      m.fillRect(b.tileX * k, b.tileY * k, Math.max(2, b.size * k), Math.max(2, b.size * k));
    }
    m.globalAlpha = 1;
    this.map.nodes.forEach((n, i) => {
      if (cur.nodes[i] <= 0) return;
      m.fillStyle = n.rich ? '#fbbf24' : '#7dd3fc';
      m.fillRect(n.tileX * k, n.tileY * k, Math.max(1.5, k), Math.max(1.5, k));
    });
    for (const u of cur.units) {
      const p = pos.get(u.id)!;
      m.fillStyle = teamColor(u.owner);
      m.fillRect((p.x / TILE_SIZE) * k - 1, (p.y / TILE_SIZE) * k - 1, 2.5, 2.5);
    }
    if (cur.fog !== null) m.drawImage(this.fogCanvas, 0, 0, this.map.width * k, this.map.height * k);
    const now = performance.now();
    vm.alerts = vm.alerts.filter((a) => a.until > now);
    for (const a of vm.alerts) {
      m.strokeStyle = Math.floor(now / 200) % 2 === 0 ? '#ef4444' : '#fecaca';
      m.lineWidth = 2;
      m.beginPath();
      m.arc((a.x / TILE_SIZE) * k, (a.y / TILE_SIZE) * k, 6, 0, Math.PI * 2);
      m.stroke();
    }
    if (vm.beacon !== null) {
      m.strokeStyle = Math.floor(now / 300) % 2 === 0 ? '#facc15' : '#fef08a';
      m.lineWidth = 2;
      m.beginPath();
      m.arc((vm.beacon.x / TILE_SIZE) * k, (vm.beacon.y / TILE_SIZE) * k, 7, 0, Math.PI * 2);
      m.stroke();
    }
    if (this.map.ruleset === 'conquest') {
      this.map.towers.forEach((t, i) => {
        const st = cur.towers[i];
        if (st === undefined) return;
        m.fillStyle = st.owner >= 0 ? teamColor(st.owner) : '#e5e7eb';
        m.strokeStyle = '#000';
        m.lineWidth = 1;
        m.beginPath();
        m.arc((t.x / TILE_SIZE) * k, (t.y / TILE_SIZE) * k, t.center ? 4.5 : 3.5, 0, Math.PI * 2);
        m.fill();
        m.stroke();
      });
    }
    for (const h of vm.hotspots) {
      m.strokeStyle = 'rgba(250,204,21,0.9)';
      m.lineWidth = 1.5;
      m.beginPath();
      m.arc((h.x / TILE_SIZE) * k, (h.y / TILE_SIZE) * k, 4 + Math.min(6, h.hits), 0, Math.PI * 2);
      m.stroke();
    }
    const cam = vm.camera;
    const sc = this.scale(cam);
    m.strokeStyle = '#ffffff';
    m.lineWidth = 1;
    m.strokeRect((cam.x / TILE_SIZE) * k, (cam.y / TILE_SIZE) * k, (this.canvas.clientWidth / sc / TILE_SIZE) * k, (this.canvas.clientHeight / sc / TILE_SIZE) * k);
  }

  /** 小地圖像素（顯示尺寸，可能被 CSS 縮放）→ 世界座標 */
  minimapToWorld(px: number, py: number): { x: number; y: number } {
    const k = this.minimap.clientWidth / Math.max(this.map.width, this.map.height);
    return { x: (px / k) * TILE_SIZE, y: (py / k) * TILE_SIZE };
  }
}
