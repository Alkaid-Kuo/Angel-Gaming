// CS 射擊可玩版的畫面：Canvas 2D 俯視。畫面資料只來自觀察資料（觀戰模式另有全狀態）。
// 視錐迷霧：從所看選手的位置對視錐內打一圈射線，遇牆或看得見的煙霧就停，射線扇形之外全部壓暗。
import type { AreaEffect, GrenadeId, MapInfo, ShooterObservation, SoundEvent, SoundKind, Team, WeaponId } from '../../shooter/api.ts';
import type { FullState, ShooterFrame, ShooterMeta } from './protocol.ts';

/** 隊伍色（兩個對比色）；其餘一律灰階 */
export const TEAM_COLOR: Readonly<Record<Team, string>> = { T: '#f59e0b', CT: '#38bdf8' };
export const TEAM_DIM: Readonly<Record<Team, string>> = { T: 'rgba(245, 158, 11, 0.10)', CT: 'rgba(56, 189, 248, 0.10)' };
export const WEAPON_TAG: Readonly<Record<WeaponId, string>> = { pistol: 'P', deagle: 'DE', smg: 'SMG', shotgun: 'SG', ak: 'AK', m4: 'M4', awp: 'AWP', knife: '刀' };
export const GRENADE_TAG: Readonly<Record<GrenadeId, string>> = { flash: '閃', smoke: '煙', he: '雷', molotov: '火', incendiary: '火' };

const UNIT = 1000;
/** 地圖預先繪製的解析度（px／格） */
const MAP_PX = 16;
const RAYS_PER_DEG = 2;
const FOG = 'rgba(4, 6, 10, 0.68)';
/** 自己身邊一點點不壓暗（只是讓自己的圖示不被蓋住；不代表看得見背後） */
const SELF_REVEAL = 0.7;
export const SOUND_MS = 500;

export interface Camera {
  /** 畫面中心（座標單位） */
  readonly cx: number;
  readonly cy: number;
  /** px／座標單位 */
  readonly scale: number;
  readonly w: number;
  readonly h: number;
}

export const toScreen = (c: Camera, x: number, y: number): [number, number] => [(x - c.cx) * c.scale + c.w / 2, (y - c.cy) * c.scale + c.h / 2];
export const toWorld = (c: Camera, sx: number, sy: number): [number, number] => [(sx - c.w / 2) / c.scale + c.cx, (sy - c.h / 2) / c.scale + c.cy];

export interface ActiveSound {
  readonly ev: SoundEvent;
  /** 收到時間（performance.now） */
  readonly t: number;
}

export interface ThrowPreview {
  readonly grenade: GrenadeId;
  /** 0～100 */
  readonly power: number;
}

export interface DrawInput {
  readonly cur: ShooterFrame;
  readonly prev: ShooterFrame | null;
  /** 前一個 tick 到目前 tick 的插值 0～1 */
  readonly alpha: number;
  /** 滑鼠的畫面座標（CSS px） */
  readonly mouse: { readonly x: number; readonly y: number };
  /** 縮放：px／格 */
  readonly zoom: number;
  /** 觀戰模式的全圖透視 */
  readonly xray: boolean;
  readonly charge: ThrowPreview | null;
  /** 在畫面上蓄力中的道具選擇（顯示準心旁的字） */
  readonly sounds: readonly ActiveSound[];
  readonly now: number;
  /** 本機投擲冷卻剩餘（0～1），只用來畫準心 */
  readonly throwCd: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
function lerpDeg(a: number, b: number, t: number): number {
  // 照最短方向轉
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** 依 id 在前一個 frame 找同一個人插值位置 */
function interp<T extends { readonly id: number; readonly x: number; readonly y: number; readonly facing: number }>(cur: T, prev: readonly T[] | undefined, a: number): { x: number; y: number; facing: number } {
  const p = prev?.find((q) => q.id === cur.id);
  if (p === undefined || Math.abs(p.x - cur.x) > 3 * UNIT || Math.abs(p.y - cur.y) > 3 * UNIT) return { x: cur.x, y: cur.y, facing: cur.facing };
  return { x: lerp(p.x, cur.x, a), y: lerp(p.y, cur.y, a), facing: lerpDeg(p.facing, cur.facing, a) };
}

/** 格子射線（浮點 DDA）：回傳從 (ox, oy) 沿 (dx, dy) 到第一個牆格的距離（格）；最多 maxT */
function castRay(map: MapInfo, ox: number, oy: number, dx: number, dy: number, maxT: number): number {
  let cx = Math.floor(ox);
  let cy = Math.floor(oy);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tdx = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tdy = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tx = dx === 0 ? Infinity : (dx > 0 ? cx + 1 - ox : ox - cx) * tdx;
  let ty = dy === 0 ? Infinity : (dy > 0 ? cy + 1 - oy : oy - cy) * tdy;
  for (let guard = 0; guard < 400; guard++) {
    let t: number;
    if (tx < ty) {
      t = tx;
      tx += tdx;
      cx += sx;
    } else {
      t = ty;
      ty += tdy;
      cy += sy;
    }
    if (t >= maxT) return maxT;
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height || map.solid[cy * map.width + cx] === 1) return t;
  }
  return maxT;
}

/** 射線與圓（煙霧）的第一個交點距離；沒交到回傳 Infinity；起點在圓內回傳 0 */
function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const fx = ox - cx;
  const fy = oy - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const b = fx * dx + fy * dy;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

/**
 * 預估道具落點（只畫參考線用）：直線飛、碰牆反彈一次、第二次停，同引擎的規則（浮點近似）。
 * 回傳路徑點（格座標）
 */
export function predictThrow(map: MapInfo, x: number, y: number, deg: number, distCells: number): [number, number][] {
  const pts: [number, number][] = [[x, y]];
  let dx = Math.cos(rad(deg));
  let dy = Math.sin(rad(deg));
  let px = x;
  let py = y;
  let left = distCells;
  let bounces = 0;
  const step = 0.05;
  const r = 0.1;
  const solid = (cx: number, cy: number): boolean => cx < 0 || cy < 0 || cx >= map.width || cy >= map.height || map.solid[Math.floor(cy) * map.width + Math.floor(cx)] === 1;
  while (left > 0) {
    const s = Math.min(step, left);
    const nx = px + dx * s;
    const ny = py + dy * s;
    const hitX = solid(nx + Math.sign(dx) * r, py);
    const hitY = solid(px, ny + Math.sign(dy) * r);
    if (hitX || hitY) {
      if (bounces >= 1) break;
      bounces += 1;
      if (hitX) dx = -dx;
      if (hitY) dy = -dy;
      pts.push([px, py]);
      continue;
    }
    px = nx;
    py = ny;
    left -= s;
  }
  pts.push([px, py]);
  return pts;
}

export class ShooterRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly meta: ShooterMeta;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly fog: HTMLCanvasElement;
  private readonly fctx: CanvasRenderingContext2D;
  camera: Camera = { cx: 0, cy: 0, scale: 0.02, w: 1, h: 1 };

  constructor(canvas: HTMLCanvasElement, meta: ShooterMeta) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.meta = meta;
    this.mapCanvas = this.drawMap(meta.map);
    this.fog = document.createElement('canvas');
    this.fctx = this.fog.getContext('2d')!;
  }

  private drawMap(map: MapInfo): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = map.width * MAP_PX;
    c.height = map.height * MAP_PX;
    const g = c.getContext('2d')!;
    g.fillStyle = '#05070b';
    g.fillRect(0, 0, c.width, c.height);
    // 地板
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.solid[y * map.width + x] === 1) continue;
        g.fillStyle = (x + y) % 2 === 0 ? '#2a313b' : '#272e37';
        g.fillRect(x * MAP_PX, y * MAP_PX, MAP_PX, MAP_PX);
      }
    }
    // 出生區、炸彈點
    for (const team of ['T', 'CT'] as const) {
      const z = map.spawnZones[team];
      g.fillStyle = TEAM_DIM[team];
      g.fillRect(z.x0 * MAP_PX, z.y0 * MAP_PX, (z.x1 - z.x0) * MAP_PX, (z.y1 - z.y0) * MAP_PX);
    }
    for (const s of map.sites) {
      g.fillStyle = 'rgba(255, 255, 255, 0.05)';
      g.fillRect(s.x0 * MAP_PX, s.y0 * MAP_PX, (s.x1 - s.x0) * MAP_PX, (s.y1 - s.y0) * MAP_PX);
      g.setLineDash([MAP_PX / 2, MAP_PX / 2]);
      g.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      g.lineWidth = 2;
      g.strokeRect(s.x0 * MAP_PX + 1, s.y0 * MAP_PX + 1, (s.x1 - s.x0) * MAP_PX - 2, (s.y1 - s.y0) * MAP_PX - 2);
      g.setLineDash([]);
      g.fillStyle = 'rgba(255, 255, 255, 0.16)';
      g.font = `bold ${MAP_PX * 5}px "Segoe UI", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.id, ((s.x0 + s.x1) / 2) * MAP_PX, ((s.y0 + s.y1) / 2) * MAP_PX);
    }
    // 牆邊（牆與地板的交界畫亮線）
    g.strokeStyle = '#4a5566';
    g.lineWidth = 2;
    g.beginPath();
    const solid = (x: number, y: number): boolean => x < 0 || y < 0 || x >= map.width || y >= map.height || map.solid[y * map.width + x] === 1;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!solid(x, y)) continue;
        if (!solid(x, y - 1)) {
          g.moveTo(x * MAP_PX, y * MAP_PX);
          g.lineTo((x + 1) * MAP_PX, y * MAP_PX);
        }
        if (!solid(x, y + 1)) {
          g.moveTo(x * MAP_PX, (y + 1) * MAP_PX);
          g.lineTo((x + 1) * MAP_PX, (y + 1) * MAP_PX);
        }
        if (!solid(x - 1, y)) {
          g.moveTo(x * MAP_PX, y * MAP_PX);
          g.lineTo(x * MAP_PX, (y + 1) * MAP_PX);
        }
        if (!solid(x + 1, y)) {
          g.moveTo((x + 1) * MAP_PX, y * MAP_PX);
          g.lineTo((x + 1) * MAP_PX, (y + 1) * MAP_PX);
        }
      }
    }
    g.stroke();
    return c;
  }

  /** 調整畫布大小（含高 DPI）；回傳 CSS 尺寸 */
  private fit(): { w: number; h: number; dpr: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    if (this.fog.width !== pw || this.fog.height !== ph) {
      this.fog.width = pw;
      this.fog.height = ph;
    }
    return { w, h, dpr };
  }

  draw(d: DrawInput): void {
    const { w, h, dpr } = this.fit();
    const ctx = this.ctx;
    const view = d.cur.view;
    const prev = d.prev?.view;
    const meNow = interp(view.me, prev !== undefined && prev.me.id === view.me.id ? [prev.me] : undefined, d.alpha);
    const full = d.cur.full;
    // 鏡頭：跟隨所看的選手，往滑鼠方向偏一點（玩家模式）
    const scale = d.zoom / UNIT;
    const lead = this.meta.spectate ? 0 : 0.3;
    const cx = meNow.x + ((d.mouse.x - w / 2) * lead) / scale;
    const cy = meNow.y + ((d.mouse.y - h / 2) * lead) / scale;
    const cam: Camera = { cx, cy, scale, w, h };
    this.camera = cam;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, w, h);
    // 地圖
    const [mx, my] = toScreen(cam, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mapCanvas, mx, my, this.meta.map.width * UNIT * scale, this.meta.map.height * UNIT * scale);
    this.drawRegionLabels(cam);

    const effects: readonly AreaEffect[] = full !== null && d.xray ? [...full.fires.map((f) => ({ kind: 'fire' as const, x: f.x, y: f.y, radius: f.radius, ticksLeft: 0 })), ...full.smokes.map((s) => ({ kind: 'smoke' as const, x: s.x, y: s.y, radius: s.radius, ticksLeft: 0 }))] : view.effects;
    for (const e of effects) if (e.kind === 'fire') this.drawFire(cam, e, d.now);
    this.drawItems(cam, full !== null && d.xray ? full.items : view.items);
    this.drawBomb(cam, view, full, d.xray, d.now);
    for (const e of effects) if (e.kind === 'smoke') this.drawSmoke(cam, e);

    // 迷霧
    if (!(full !== null && d.xray)) this.drawFog(cam, view, meNow, dpr);

    // 人
    if (full !== null) {
      this.drawFullPlayers(cam, full, d.prev?.full ?? null, d.alpha, view.me.id);
    } else {
      for (const t of view.teammates) {
        if (!t.alive) continue;
        const p = interp(t, prev?.teammates, d.alpha);
        this.drawPlayer(cam, p.x, p.y, p.facing, view.me.team, { weapon: t.weapon, hp: t.hp, hasBomb: t.hasBomb, blind: t.blind, label: this.meta.names[t.id], dim: false, planting: t.planting || t.defusing });
      }
      if (view.me.alive) this.drawPlayer(cam, meNow.x, meNow.y, meNow.facing, view.me.team, { weapon: view.me.weapon, hp: view.me.hp, hasBomb: view.me.hasBomb, blind: view.me.blindTicks > 0, label: view.me.id === this.meta.playerId && !this.meta.spectate ? null : this.meta.names[view.me.id], self: true, dim: false, planting: view.me.plantTicks > 0 || view.me.defuseTicks > 0 });
      const foe: Team = view.me.team === 'T' ? 'CT' : 'T';
      for (const e of view.enemies) {
        const p = interp(e, prev?.enemies, d.alpha);
        this.drawPlayer(cam, p.x, p.y, p.facing, foe, { weapon: e.weapon, hp: null, hasBomb: e.hasBomb, blind: false, label: null, dim: false, crouch: e.crouching, planting: e.planting || e.defusing });
        this.drawOffscreen(cam, p.x, p.y, TEAM_COLOR[foe]);
      }
      // 雷達紅點：隊友看見、自己沒看見的敵人（只有座標）
      for (const r of view.radar) {
        const [sx, sy] = toScreen(cam, r.x, r.y);
        ctx.strokeStyle = TEAM_COLOR[foe];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(5, 0.35 * UNIT * scale), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = TEAM_COLOR[foe];
        ctx.font = 'bold 11px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', sx, sy);
      }
    }
    // 道具（飛行中、落地等引信）
    for (const g of full !== null && d.xray ? full.projectiles : view.projectiles) {
      const [sx, sy] = toScreen(cam, g.x, g.y);
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(GRENADE_TAG[g.kind], sx, sy - 5);
    }
    // 投擲預估與準心（玩家模式、活著）
    if (!this.meta.spectate && view.me.id === this.meta.playerId && view.me.alive) {
      if (d.charge !== null) this.drawThrowPreview(cam, meNow, view, d);
      this.drawCrosshair(d, view, meNow);
    }
    this.drawSoundArrows(cam, meNow, d.sounds, d.now);
    // 致盲：全白，最後 0.8 秒淡出
    const blind = view.me.blindTicks;
    if (blind > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, blind / 24)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /** 看得見但在畫面外的敵人：畫面邊緣畫一個指向它的三角形（資料仍是觀察資料裡的 enemies） */
  private drawOffscreen(cam: Camera, x: number, y: number, color: string): void {
    const [sx, sy] = toScreen(cam, x, y);
    const m = 18;
    if (sx >= m && sy >= m && sx <= cam.w - m && sy <= cam.h - m) return;
    const cx = cam.w / 2;
    const cy = cam.h / 2;
    const a = Math.atan2(sy - cy, sx - cx);
    const k = Math.min((cam.w / 2 - m) / Math.max(1e-6, Math.abs(Math.cos(a))), (cam.h / 2 - m) / Math.max(1e-6, Math.abs(Math.sin(a))));
    const ex = cx + Math.cos(a) * k;
    const ey = cy + Math.sin(a) * k;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(a) * 10, ey + Math.sin(a) * 10);
    ctx.lineTo(ex + Math.cos(a + 2.4) * 9, ey + Math.sin(a + 2.4) * 9);
    ctx.lineTo(ex + Math.cos(a - 2.4) * 9, ey + Math.sin(a - 2.4) * 9);
    ctx.closePath();
    ctx.fill();
  }

  private drawRegionLabels(cam: Camera): void {
    const ctx = this.ctx;
    ctx.font = '12px "Segoe UI", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(203, 213, 225, 0.30)';
    const seen = new Set<string>();
    for (const r of this.meta.map.regions) {
      if (seen.has(r.name) || r.x1 - r.x0 > 40 || r.y1 - r.y0 > 40) continue;
      seen.add(r.name);
      const [sx, sy] = toScreen(cam, ((r.x0 + r.x1) / 2) * UNIT, ((r.y0 + r.y1) / 2) * UNIT);
      if (sx < -50 || sy < -20 || sx > cam.w + 50 || sy > cam.h + 20) continue;
      ctx.fillText(r.name, sx, sy);
    }
  }

  private drawFog(cam: Camera, view: ShooterObservation, me: { x: number; y: number; facing: number }, dpr: number): void {
    const f = this.fctx;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.globalCompositeOperation = 'source-over';
    f.clearRect(0, 0, this.fog.width, this.fog.height);
    f.fillStyle = FOG;
    f.fillRect(0, 0, this.fog.width, this.fog.height);
    if (view.me.alive && view.me.blindTicks === 0) {
      f.setTransform(dpr, 0, 0, dpr, 0, 0);
      f.globalCompositeOperation = 'destination-out';
      const ox = me.x / UNIT;
      const oy = me.y / UNIT;
      const fov = view.me.scoped ? this.meta.rules.scopedFovDeg : this.meta.rules.fovDeg;
      const smokes = view.effects.filter((e) => e.kind === 'smoke').map((e) => ({ x: e.x / UNIT, y: e.y / UNIT, r: e.radius / UNIT }));
      const n = Math.max(2, Math.round(fov * RAYS_PER_DEG));
      const maxT = Math.hypot(this.meta.map.width, this.meta.map.height);
      f.beginPath();
      const [sx0, sy0] = toScreen(cam, me.x, me.y);
      f.moveTo(sx0, sy0);
      for (let i = 0; i <= n; i++) {
        const a = rad(me.facing - fov / 2 + (fov * i) / n);
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let t = castRay(this.meta.map, ox, oy, dx, dy, maxT);
        for (const s of smokes) t = Math.min(t, rayCircle(ox, oy, dx, dy, s.x, s.y, s.r));
        const [sx, sy] = toScreen(cam, (ox + dx * t) * UNIT, (oy + dy * t) * UNIT);
        f.lineTo(sx, sy);
      }
      f.closePath();
      f.fill();
      f.beginPath();
      f.arc(sx0, sy0, SELF_REVEAL * UNIT * cam.scale, 0, Math.PI * 2);
      f.fill();
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.fog, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private drawSmoke(cam: Camera, e: AreaEffect): void {
    const ctx = this.ctx;
    const [sx, sy] = toScreen(cam, e.x, e.y);
    const r = e.radius * cam.scale;
    const g = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, r);
    g.addColorStop(0, 'rgba(148, 158, 170, 0.97)');
    g.addColorStop(0.85, 'rgba(120, 130, 142, 0.95)');
    g.addColorStop(1, 'rgba(110, 120, 132, 0.6)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFire(cam: Camera, e: AreaEffect, now: number): void {
    const ctx = this.ctx;
    const [sx, sy] = toScreen(cam, e.x, e.y);
    const r = e.radius * cam.scale;
    const flick = 0.85 + 0.15 * Math.sin(now / 70 + e.x);
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0, `rgba(253, 186, 116, ${0.75 * flick})`);
    g.addColorStop(0.7, `rgba(234, 88, 12, ${0.55 * flick})`);
    g.addColorStop(1, 'rgba(234, 88, 12, 0.15)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawItems(cam: Camera, items: readonly { readonly kind: 'weapon' | 'bomb' | 'kit'; readonly weapon: WeaponId | null; readonly x: number; readonly y: number }[]): void {
    const ctx = this.ctx;
    for (const it of items) {
      if (it.kind === 'bomb') continue;
      const [sx, sy] = toScreen(cam, it.x, it.y);
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(sx - 7, sy - 3, 14, 6);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(it.kind === 'kit' ? '拆彈器' : WEAPON_TAG[it.weapon ?? 'pistol'], sx, sy + 4);
    }
  }

  private drawBomb(cam: Camera, view: ShooterObservation, full: FullState | null, xray: boolean, now: number): void {
    const ctx = this.ctx;
    let x: number | null = null;
    let y: number | null = null;
    let state: string = view.bomb.state;
    let left = view.bomb.ticksLeft;
    if (full !== null && xray) {
      if (full.bomb.state !== 'carried') {
        x = full.bomb.x;
        y = full.bomb.y;
      }
      state = full.bomb.state;
      left = full.bomb.ticksLeft;
    } else if (view.bomb.x !== null && view.bomb.y !== null && state !== 'carried' && state !== 'planting') {
      x = view.bomb.x;
      y = view.bomb.y;
    }
    if (x === null || y === null) return;
    const [sx, sy] = toScreen(cam, x, y);
    const planted = state === 'planted' || state === 'defusing';
    if (planted) {
      const pulse = (now % 1000) / 1000;
      ctx.strokeStyle = `rgba(245, 158, 11, ${1 - pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 8 + pulse * 18, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = state === 'exploded' ? '#475569' : '#f59e0b';
    ctx.fillRect(sx - 6, sy - 4, 12, 8);
    ctx.strokeStyle = '#0b0e13';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - 6, sy - 4, 12, 8);
    if (planted && left !== null) {
      ctx.fillStyle = '#fef3c7';
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${(left / this.meta.rules.ticksPerSecond).toFixed(1)}`, sx, sy - 8);
    }
  }

  private drawPlayer(
    cam: Camera,
    x: number,
    y: number,
    facing: number,
    team: Team,
    o: { weapon: WeaponId; hp: number | null; hasBomb: boolean; blind: boolean; label: string | null; self?: boolean; dim: boolean; crouch?: boolean; planting?: boolean },
  ): void {
    const ctx = this.ctx;
    const [sx, sy] = toScreen(cam, x, y);
    const r = Math.max(5, this.meta.rules.bodyRadius * cam.scale) * (o.crouch === true ? 0.85 : 1);
    const a = rad(facing);
    ctx.globalAlpha = o.dim ? 0.45 : 1;
    // 槍管（朝向）
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sx + Math.cos(a) * r * 0.6, sy + Math.sin(a) * r * 0.6);
    ctx.lineTo(sx + Math.cos(a) * r * 2.1, sy + Math.sin(a) * r * 2.1);
    ctx.stroke();
    ctx.fillStyle = TEAM_COLOR[team];
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = o.self === true ? 2.5 : 1.5;
    ctx.strokeStyle = o.self === true ? '#ffffff' : '#0b0e13';
    ctx.stroke();
    if (o.hasBomb) {
      ctx.fillStyle = '#0b0e13';
      ctx.fillRect(sx - r * 0.45, sy - r * 0.3, r * 0.9, r * 0.6);
    }
    if (o.planting === true) {
      ctx.strokeStyle = '#fef3c7';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.blind) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const b = (i * Math.PI) / 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(b) * (r + 2), sy + Math.sin(b) * (r + 2));
        ctx.lineTo(sx + Math.cos(b) * (r + 7), sy + Math.sin(b) * (r + 7));
        ctx.stroke();
      }
    }
    // 武器、名字、血條
    ctx.font = '10px "Segoe UI", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(WEAPON_TAG[o.weapon], sx, sy + r + 3);
    if (o.hp !== null) {
      const bw = 22;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(sx - bw / 2, sy - r - 7, bw, 3);
      ctx.fillStyle = o.hp > 30 ? '#e2e8f0' : TEAM_COLOR[team];
      ctx.fillRect(sx - bw / 2, sy - r - 7, (bw * Math.max(0, o.hp)) / 100, 3);
    }
    if (o.label !== null) {
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.fillText(o.label, sx, sy - r - 9);
    }
    ctx.globalAlpha = 1;
  }

  private drawFullPlayers(cam: Camera, full: FullState, prev: FullState | null, alpha: number, viewId: number): void {
    for (const p of full.players) {
      if (!p.alive) continue;
      const q = interp(p, prev?.players, alpha);
      this.drawPlayer(cam, q.x, q.y, q.facing, p.team, { weapon: p.weapon, hp: p.hp, hasBomb: p.hasBomb, blind: p.blind, label: this.meta.names[p.id], self: p.id === viewId, dim: false });
    }
  }

  private drawThrowPreview(cam: Camera, me: { x: number; y: number; facing: number }, view: ShooterObservation, d: DrawInput): void {
    const ctx = this.ctx;
    const charge = d.charge!;
    const [wx, wy] = toWorld(cam, d.mouse.x, d.mouse.y);
    let deg = (Math.atan2(wy - me.y, wx - me.x) * 180) / Math.PI;
    // 與引擎相同：方向夾在視錐內
    const half = (view.me.scoped ? this.meta.rules.scopedFovDeg : this.meta.rules.fovDeg) / 2;
    const off = ((((deg - me.facing) % 360) + 540) % 360) - 180;
    if (Math.abs(off) > half) deg = me.facing + Math.sign(off) * half;
    const dist = (charge.power / 100) * this.meta.rules.grenadeRules.maxThrowRange;
    const path = predictThrow(this.meta.map, me.x / UNIT, me.y / UNIT, deg, dist);
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    path.forEach(([px, py], i) => {
      const [sx, sy] = toScreen(cam, px * UNIT, py * UNIT);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    const [lx, ly] = path[path.length - 1];
    const [sx, sy] = toScreen(cam, lx * UNIT, ly * UNIT);
    const info = this.meta.grenades.find((g) => g.id === charge.grenade);
    const rr = charge.grenade === 'flash' ? 1.2 * UNIT : (info?.radius ?? UNIT);
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.6)';
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(6, rr * cam.scale), 0, Math.PI * 2);
    ctx.stroke();
    // 蓄力條（準心下方）
    const bx = d.mouse.x - 30;
    const by = d.mouse.y + 22;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(bx, by, 60, 6);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(bx, by, (60 * charge.power) / 100, 6);
    ctx.font = '11px "Segoe UI", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${info?.name ?? ''} ${Math.round(charge.power)}%`, d.mouse.x, by + 8);
  }

  private drawCrosshair(d: DrawInput, view: ShooterObservation, me: { x: number; y: number }): void {
    const ctx = this.ctx;
    const [px, py] = toScreen(this.camera, me.x, me.y);
    const dist = Math.hypot(d.mouse.x - px, d.mouse.y - py);
    // 散佈（度 ×100）換算成準心開口
    const gap = Math.max(3, Math.min(70, dist * Math.tan(rad(view.me.spread / 100))));
    const x = d.mouse.x;
    const y = d.mouse.y;
    ctx.strokeStyle = view.me.reloadTicksLeft > 0 || d.throwCd > 0 ? 'rgba(248, 250, 252, 0.35)' : '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      ctx.moveTo(x + dx * gap, y + dy * gap);
      ctx.lineTo(x + dx * (gap + 7), y + dy * (gap + 7));
    }
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }

  private drawSoundArrows(cam: Camera, me: { x: number; y: number }, sounds: readonly ActiveSound[], now: number): void {
    const ctx = this.ctx;
    const [px, py] = toScreen(cam, me.x, me.y);
    for (const s of sounds) {
      const age = now - s.t;
      if (age > SOUND_MS) continue;
      const a = rad(s.ev.dirDeg);
      const size = s.ev.range === 'near' ? 13 : s.ev.range === 'mid' ? 10 : 7;
      const dist = s.ev.range === 'near' ? 48 : s.ev.range === 'mid' ? 64 : 80;
      const x = px + Math.cos(a) * dist;
      const y = py + Math.sin(a) * dist;
      ctx.globalAlpha = 1 - age / SOUND_MS;
      drawSoundGlyph(ctx, x, y, a, size, s.ev.kind, s.ev.friendly);
      ctx.globalAlpha = 1;
    }
  }

  /** 小地圖：整張圖、隊友、雷達紅點、看得見的敵人、聲音箭頭、已下包位置 */
  drawMinimap(mini: HTMLCanvasElement, d: DrawInput): void {
    const dpr = window.devicePixelRatio || 1;
    const size = mini.clientWidth;
    if (mini.width !== Math.round(size * dpr)) {
      mini.width = Math.round(size * dpr);
      mini.height = Math.round(size * dpr);
    }
    const g = mini.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.globalAlpha = 0.9;
    g.drawImage(this.mapCanvas, 0, 0, size, size);
    g.globalAlpha = 1;
    const k = size / (this.meta.map.width * UNIT);
    const view = d.cur.view;
    const dot = (x: number, y: number, color: string, r: number, ring = false): void => {
      g.beginPath();
      g.arc(x * k, y * k, r, 0, Math.PI * 2);
      if (ring) {
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.stroke();
      } else {
        g.fillStyle = color;
        g.fill();
      }
    };
    const foe: Team = view.me.team === 'T' ? 'CT' : 'T';
    if (d.cur.full !== null) {
      for (const p of d.cur.full.players) if (p.alive) dot(p.x, p.y, TEAM_COLOR[p.team], 3);
    } else {
      for (const t of view.teammates) if (t.alive) dot(t.x, t.y, TEAM_COLOR[view.me.team], 3);
      for (const e of view.enemies) dot(e.x, e.y, TEAM_COLOR[foe], 3);
      for (const r of view.radar) dot(r.x, r.y, TEAM_COLOR[foe], 3, true);
    }
    if (view.bomb.x !== null && view.bomb.y !== null && (view.bomb.state === 'planted' || view.bomb.state === 'defusing' || view.bomb.state === 'dropped')) {
      g.fillStyle = '#f59e0b';
      g.fillRect(view.bomb.x * k - 3, view.bomb.y * k - 2, 6, 4);
    }
    if (view.me.alive) {
      const a = rad(view.me.facing);
      dot(view.me.x, view.me.y, '#ffffff', 3.5);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(view.me.x * k, view.me.y * k);
      g.lineTo(view.me.x * k + Math.cos(a) * 9, view.me.y * k + Math.sin(a) * 9);
      g.stroke();
      for (const s of d.sounds) {
        const age = d.now - s.t;
        if (age > SOUND_MS) continue;
        const b = rad(s.ev.dirDeg);
        const dist = s.ev.range === 'near' ? 12 : s.ev.range === 'mid' ? 18 : 24;
        g.globalAlpha = 1 - age / SOUND_MS;
        drawSoundGlyph(g, view.me.x * k + Math.cos(b) * dist, view.me.y * k + Math.sin(b) * dist, b, s.ev.range === 'near' ? 7 : s.ev.range === 'mid' ? 5.5 : 4, s.ev.kind, s.ev.friendly);
        g.globalAlpha = 1;
      }
    }
  }
}

/** 聲音：方向箭頭＋種類圖示（腳步＝兩點、槍聲＝放射線、落地＝圓、爆炸＝星、換彈＝弧、下包／拆包／嗶聲＝方塊） */
function drawSoundGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, size: number, kind: SoundKind, friendly: boolean): void {
  const color = friendly ? 'rgba(148, 163, 184, 0.9)' : '#f8fafc';
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  // 箭頭（指向聲音的方向）
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(a) * size, y + Math.sin(a) * size);
  ctx.lineTo(x + Math.cos(a + 2.5) * size * 0.6, y + Math.sin(a + 2.5) * size * 0.6);
  ctx.lineTo(x + Math.cos(a - 2.5) * size * 0.6, y + Math.sin(a - 2.5) * size * 0.6);
  ctx.closePath();
  ctx.fill();
  // 圖示畫在箭頭內側
  const ix = x - Math.cos(a) * size * 1.2;
  const iy = y - Math.sin(a) * size * 1.2;
  const s = size * 0.45;
  ctx.beginPath();
  switch (kind) {
    case 'footstep':
      ctx.arc(ix - s * 0.5, iy, s * 0.35, 0, Math.PI * 2);
      ctx.arc(ix + s * 0.5, iy - s * 0.4, s * 0.35, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'shot':
      for (let i = 0; i < 6; i++) {
        const b = (i * Math.PI) / 3;
        ctx.moveTo(ix + Math.cos(b) * s * 0.4, iy + Math.sin(b) * s * 0.4);
        ctx.lineTo(ix + Math.cos(b) * s, iy + Math.sin(b) * s);
      }
      ctx.stroke();
      return;
    case 'grenadeLand':
      ctx.arc(ix, iy, s * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      return;
    case 'explosion':
      for (let i = 0; i < 10; i++) {
        const b = (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? s * 1.1 : s * 0.5;
        if (i === 0) ctx.moveTo(ix + Math.cos(b) * rr, iy + Math.sin(b) * rr);
        else ctx.lineTo(ix + Math.cos(b) * rr, iy + Math.sin(b) * rr);
      }
      ctx.closePath();
      ctx.fill();
      return;
    case 'reload':
      ctx.arc(ix, iy, s * 0.7, 0.3, Math.PI * 1.6);
      ctx.stroke();
      return;
    default:
      ctx.rect(ix - s * 0.6, iy - s * 0.6, s * 1.2, s * 1.2);
      ctx.fill();
  }
}
