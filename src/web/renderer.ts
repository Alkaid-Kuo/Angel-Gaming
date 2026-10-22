// Canvas 2D 繪圖：地形、礦點、瞭望塔、建築、單位、迷霧、選取與放置提示、小地圖。只讀取狀態。
import { BUILDING_STATS, RULES, TILE_SIZE, UNIT_STATS, type BuildingType } from '../config/index.ts';
import type { BuildingFrame, FrameView, StaticMapView, UnitFrame } from '../view/snapshot.ts';
import { BUILDING_GLYPH, TEAM_COLORS } from './labels.ts';

export const TILE_PX = 16;
/** 指令位置提示的顯示時間（毫秒） */
const MARKER_MS = 600;

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

const TERRAIN_COLORS = ['#5f7a45', '#2a2d34', '#2f5228'];

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

  private paintTerrain(): void {
    const c = this.terrain.getContext('2d')!;
    const { width, height, tiles } = this.map;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = tiles[y * width + x];
        c.fillStyle = TERRAIN_COLORS[t];
        c.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        if (t === 2) {
          c.fillStyle = '#23401f';
          c.beginPath();
          c.arc(x * TILE_PX + 5, y * TILE_PX + 6, 3, 0, Math.PI * 2);
          c.arc(x * TILE_PX + 11, y * TILE_PX + 11, 3, 0, Math.PI * 2);
          c.fill();
        } else if (t === 1) {
          c.fillStyle = '#34383f';
          c.fillRect(x * TILE_PX + 2, y * TILE_PX + 2, TILE_PX - 4, TILE_PX - 4);
        }
      }
    }
    // 淡淡的格線
    c.strokeStyle = 'rgba(0,0,0,0.06)';
    c.lineWidth = 1;
    for (let x = 0; x <= width; x++) {
      c.beginPath();
      c.moveTo(x * TILE_PX + 0.5, 0);
      c.lineTo(x * TILE_PX + 0.5, height * TILE_PX);
      c.stroke();
    }
    for (let y = 0; y <= height; y++) {
      c.beginPath();
      c.moveTo(0, y * TILE_PX + 0.5);
      c.lineTo(width * TILE_PX, y * TILE_PX + 0.5);
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

  clampCamera(cam: Camera): void {
    const s = this.scale(cam);
    const viewW = this.canvas.clientWidth / s;
    const viewH = this.canvas.clientHeight / s;
    const mapW = this.map.width * TILE_SIZE;
    const mapH = this.map.height * TILE_SIZE;
    const margin = 4 * TILE_SIZE;
    cam.x = Math.max(-margin, Math.min(mapW - viewW + margin, cam.x));
    cam.y = Math.max(-margin, Math.min(mapH - viewH + margin, cam.y));
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

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrain, wx(0), wy(0), this.map.width * tilePx, this.map.height * tilePx);

    // 礦點
    this.map.nodes.forEach((n, i) => {
      const reserve = cur.nodes[i];
      const cx = wx(n.tileX * TILE_SIZE + 500);
      const cy = wy(n.tileY * TILE_SIZE + 500);
      const r = tilePx * 0.42;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fillStyle = reserve <= 0 ? '#4b5563' : n.rich ? '#fbbf24' : '#7dd3fc';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // 瞭望塔與佔領範圍
    this.map.towers.forEach((t, i) => {
      const owner = cur.towers[i]?.owner ?? -1;
      const cx = wx(t.x);
      const cy = wy(t.y);
      ctx.beginPath();
      ctx.arc(cx, cy, RULES.watchtower.captureRadiusTiles * tilePx, 0, Math.PI * 2);
      ctx.strokeStyle = owner >= 0 ? teamColor(owner) : 'rgba(255,255,255,0.35)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(cx, cy, tilePx * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = owner >= 0 ? teamColor(owner) : owner === -2 ? '#6b7280' : '#e5e7eb';
      ctx.fill();
      ctx.strokeStyle = '#111827';
      ctx.stroke();
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

  private drawBuilding(b: BuildingFrame, vm: ViewModel, wx: (x: number) => number, wy: (y: number) => number, tilePx: number): void {
    const ctx = this.ctx;
    const x = wx(b.tileX * TILE_SIZE);
    const y = wy(b.tileY * TILE_SIZE);
    const w = b.size * tilePx;
    ctx.globalAlpha = b.remembered ? 0.55 : b.complete ? 0.92 : 0.5;
    ctx.fillStyle = teamColor(b.owner);
    ctx.fillRect(x + 1, y + 1, w - 2, w - 2);
    ctx.globalAlpha = 1;
    const selected = vm.selectedBuilding === b.id;
    ctx.strokeStyle = selected ? '#ffffff' : '#0f172a';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x + 1, y + 1, w - 2, w - 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(9, Math.round(tilePx * (b.size === 1 ? 0.7 : 1)))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(BUILDING_GLYPH[b.type] + (b.level > 1 ? String(b.level) : ''), x + w / 2, y + w / 2);
    if (b.task !== null) this.bar(x + 2, y + w - 6, w - 4, 4, b.task.progress / 100, '#a78bfa');
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    if (!b.complete) this.bar(x + 2, y + w - 6, w - 4, 4, b.progress / 100, '#facc15');
    if (b.hp < b.maxHp || selected) this.bar(x + 2, y + 2, w - 4, 3, b.hp / b.maxHp, '#22c55e');
    if (b.type === 'tower' && b.complete && selected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(x + w / 2, y + w / 2, (BUILDING_STATS.tower.weapon!.range / TILE_SIZE) * tilePx, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawUnit(u: UnitFrame, p: { x: number; y: number }, vm: ViewModel, wx: (x: number) => number, wy: (y: number) => number, s: number): void {
    const ctx = this.ctx;
    const cx = wx(p.x);
    const cy = wy(p.y);
    const r = Math.max(3, UNIT_STATS[u.type].radius * s);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = teamColor(u.owner);
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 兵種記號：工人小點、長槍兵直線、弓兵圓環、騎兵大圓
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    switch (u.type) {
      case 'worker':
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r * 0.3), 0, Math.PI * 2);
        ctx.fill();
        if (u.carrying > 0) {
          ctx.fillStyle = '#7dd3fc';
          ctx.fillRect(cx + r * 0.3, cy - r, r * 0.6, r * 0.6);
        }
        break;
      case 'spear':
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.6, cy + r * 0.6);
        ctx.lineTo(cx + r * 0.6, cy - r * 0.6);
        ctx.stroke();
        break;
      case 'archer':
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'cavalry':
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.25, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'siege':
        ctx.strokeRect(cx - r * 0.5, cy - r * 0.5, r, r);
        break;
    }
    const selected = vm.selection.has(u.id);
    if (selected) {
      ctx.strokeStyle = '#86efac';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (u.hp < u.maxHp || selected) this.bar(cx - r, cy - r - 6, r * 2, 3, u.hp / u.maxHp, u.hp / u.maxHp > 0.5 ? '#22c55e' : u.hp / u.maxHp > 0.25 ? '#eab308' : '#ef4444');
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
