// 軍團戰繪製（Canvas 2D）：地形預先畫成一張圖；每格畫面依兩個 tick 之間插值畫士兵、箭矢、軍團旗標與特效。
import { RULES, T, TILE, UNITS, type UnitKind } from '../../legion/config.ts';
import { hashInts } from '../../shared/hash.ts';
import { drawUnitIcon } from './icons.ts';
import { ATTACKED_BIT, REG_MASK, type LegionFrame, type LegionMeta, type RegFrame } from './protocol.ts';

/** 地形圖每格的像素 */
const TPX = 10;

export interface Camera {
  /** 畫面中心（格） */
  x: number;
  y: number;
  /** 每格像素 */
  scale: number;
}

export interface DrawOptions {
  /** -1 上帝視角；0／1 該方視角（看不到的敵軍不畫） */
  readonly viewer: number;
  readonly selected: number;
  readonly hovered: number;
  readonly showRanges: boolean;
}

interface Effect {
  kind: 'ring' | 'text';
  x: number;
  y: number;
  t0: number;
  life: number;
  color: string;
  text?: string;
  size?: number;
}

interface Corpse {
  x: number;
  y: number;
  owner: number;
  t: number;
}

const TEAM = ['#3b82f6', '#ef4444'];
const TEAM_LIGHT = ['#bfdbfe', '#fecaca'];
const TEAM_DARK = ['#1e3a8a', '#7f1d1d'];
const ROUTED = ['#64748b', '#78716c'];

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number): number => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function rnd(x: number, y: number, s: number): number {
  return (hashInts([x, y, s]) >>> 0) / 4294967296;
}

/** 預先畫好的地形圖 */
function paintTerrain(meta: LegionMeta): HTMLCanvasElement {
  const w = meta.width;
  const h = meta.height;
  const c = document.createElement('canvas');
  c.width = w * TPX;
  c.height = h * TPX;
  const g = c.getContext('2d')!;
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? -1 : meta.terrain[y * w + x]);
  const base: Record<number, [number, number, number]> = {
    [T.Plain]: [92, 120, 66],
    [T.Road]: [160, 140, 104],
    [T.Forest]: [52, 82, 46],
    [T.Hill]: [128, 124, 82],
    [T.Shallow]: [104, 150, 170],
    [T.River]: [44, 86, 128],
    [T.Bridge]: [120, 92, 62],
    [T.Building]: [90, 90, 90],
    [T.Wall]: [70, 70, 70],
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = at(x, y);
      const [r, gg, b] = base[t];
      const j = (rnd(x, y, 1) - 0.5) * 14;
      g.fillStyle = `rgb(${r + j},${gg + j},${b + j * 0.6})`;
      g.fillRect(x * TPX, y * TPX, TPX, TPX);
    }
  }
  // 草地細節
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = at(x, y);
      if (t !== T.Plain && t !== T.Hill) continue;
      for (let k = 0; k < 2; k++) {
        const px = (x + rnd(x, y, 10 + k)) * TPX;
        const py = (y + rnd(x, y, 20 + k)) * TPX;
        g.fillStyle = rnd(x, y, 30 + k) < 0.5 ? 'rgba(255,255,220,0.06)' : 'rgba(0,30,0,0.08)';
        g.fillRect(px, py, 2, 2);
      }
    }
  }
  // 道路圓角
  g.fillStyle = 'rgb(160,140,104)';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== T.Road) continue;
      g.beginPath();
      g.arc((x + 0.5) * TPX, (y + 0.5) * TPX, TPX * 0.75, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 河流與淺灘邊緣、水紋
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = at(x, y);
      if (t !== T.River && t !== T.Shallow) continue;
      if (rnd(x, y, 40) < 0.35) {
        g.strokeStyle = t === T.River ? 'rgba(160,200,235,0.18)' : 'rgba(230,245,255,0.25)';
        g.lineWidth = 1;
        const px = (x + rnd(x, y, 41) * 0.6) * TPX;
        const py = (y + 0.3 + rnd(x, y, 42) * 0.4) * TPX;
        g.beginPath();
        g.moveTo(px, py);
        g.quadraticCurveTo(px + TPX * 0.25, py - 2, px + TPX * 0.5, py);
        g.stroke();
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = at(x + dx, y + dy);
        if (n === T.River || n === T.Shallow || n === T.Bridge || n === -1) continue;
        g.fillStyle = 'rgba(20,40,30,0.35)';
        g.fillRect(x * TPX + (dx === 1 ? TPX - 2 : 0), y * TPX + (dy === 1 ? TPX - 2 : 0), dx === 0 ? TPX : 2, dy === 0 ? TPX : 2);
      }
    }
  }
  // 橋：木板
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== T.Bridge) continue;
      g.strokeStyle = 'rgba(40,25,10,0.55)';
      g.lineWidth = 1;
      for (let k = 1; k < 4; k++) {
        g.beginPath();
        g.moveTo(x * TPX + (k * TPX) / 4, y * TPX);
        g.lineTo(x * TPX + (k * TPX) / 4, (y + 1) * TPX);
        g.stroke();
      }
      if (at(x, y - 1) !== T.Bridge || at(x, y + 1) !== T.Bridge) {
        g.fillStyle = 'rgba(60,40,20,0.9)';
        g.fillRect(x * TPX, at(x, y - 1) !== T.Bridge ? y * TPX : (y + 1) * TPX - 2, TPX, 2);
      }
    }
  }
  // 高地：邊緣等高線
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== T.Hill) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (at(x + dx, y + dy) === T.Hill) continue;
        g.fillStyle = 'rgba(70,55,25,0.55)';
        g.fillRect(x * TPX + (dx === 1 ? TPX - 2 : 0), y * TPX + (dy === 1 ? TPX - 2 : 0), dx === 0 ? TPX : 2, dy === 0 ? TPX : 2);
      }
      g.fillStyle = 'rgba(255,240,190,0.08)';
      g.fillRect(x * TPX, y * TPX, TPX, TPX / 2);
    }
  }
  // 樹林：樹冠
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== T.Forest) continue;
      for (let k = 0; k < 3; k++) {
        const px = (x + 0.15 + rnd(x, y, 50 + k) * 0.7) * TPX;
        const py = (y + 0.15 + rnd(x, y, 60 + k) * 0.7) * TPX;
        const r = TPX * (0.32 + rnd(x, y, 70 + k) * 0.22);
        g.fillStyle = 'rgba(10,25,10,0.35)';
        g.beginPath();
        g.arc(px + 1.5, py + 2, r, 0, Math.PI * 2);
        g.fill();
        const v = Math.round(rnd(x, y, 80 + k) * 30);
        g.fillStyle = `rgb(${38 + v},${74 + v},${36 + v / 2})`;
        g.beginPath();
        g.arc(px, py, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  return c;
}

export class LegionRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly meta: LegionMeta;
  private readonly terrain: HTMLCanvasElement;
  readonly cam: Camera = { x: 80, y: 50, scale: 8 };
  private prev: LegionFrame | null = null;
  private cur: LegionFrame | null = null;
  private prevX: Int32Array;
  private prevY: Int32Array;
  private hasPrev: Uint8Array;
  private effects: Effect[] = [];
  private corpses: Corpse[] = [];
  private regById = new Map<number, RegFrame>();
  private prevRegById = new Map<number, RegFrame>();
  private kindOf: UnitKind[];
  private ownerOf: number[];

  constructor(canvas: HTMLCanvasElement, meta: LegionMeta) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.meta = meta;
    this.terrain = paintTerrain(meta);
    this.prevX = new Int32Array(meta.soldierCount);
    this.prevY = new Int32Array(meta.soldierCount);
    this.hasPrev = new Uint8Array(meta.soldierCount);
    this.kindOf = meta.regs.map((r) => r.kind);
    this.ownerOf = meta.regs.map((r) => r.owner);
  }

  get frame(): LegionFrame | null {
    return this.cur;
  }

  reg(id: number): RegFrame | undefined {
    return this.regById.get(id);
  }

  /** 新的一格：上一格成為插值起點；死亡的士兵留下屍體，事件產生特效 */
  push(f: LegionFrame, now: number): void {
    if (this.cur !== null) {
      this.prev = this.cur;
      this.hasPrev.fill(0);
      const s = this.cur.soldiers;
      for (let i = 0; i < s.length; i += 4) {
        this.prevX[s[i]] = s[i + 1];
        this.prevY[s[i]] = s[i + 2];
        this.hasPrev[s[i]] = 1;
      }
      // 屍體：上一格在、這一格不在（但不是潰散撤離出地圖）
      const alive = new Uint8Array(this.meta.soldierCount);
      for (let i = 0; i < f.soldiers.length; i += 4) alive[f.soldiers[i]] = 1;
      for (let i = 0; i < s.length; i += 4) {
        const id = s[i];
        if (alive[id] === 1) continue;
        const reg = s[i + 3] & REG_MASK;
        const x = s[i + 1];
        if (x < 1200 || x > this.meta.width * TILE - 1200) continue;
        this.corpses.push({ x, y: s[i + 2], owner: this.ownerOf[reg], t: now });
      }
      if (this.corpses.length > 2500) this.corpses.splice(0, this.corpses.length - 2500);
    }
    this.prevRegById = this.regById;
    this.cur = f;
    this.regById = new Map(f.regs.map((r) => [r.id, r]));
    for (const ev of f.events) this.effectFor(ev, now);
  }

  /** 重新開始時清掉 */
  reset(): void {
    this.prev = null;
    this.cur = null;
    this.effects = [];
    this.corpses = [];
    this.regById = new Map();
    this.prevRegById = new Map();
  }

  private regPos(id: number): { x: number; y: number } | null {
    const r = this.regById.get(id) ?? this.prevRegById.get(id);
    return r === undefined ? null : { x: r.x, y: r.y };
  }

  private effectFor(ev: LegionFrame['events'][number], now: number): void {
    switch (ev.type) {
      case 'impact': {
        const p = this.regPos(ev.target) ?? this.regPos(ev.reg);
        if (p === null) return;
        this.effects.push({ kind: 'ring', x: p.x, y: p.y, t0: now, life: 900, color: ev.braced ? '#e2e8f0' : '#fb923c', size: 3.2 });
        this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 1800, color: ev.braced ? '#e2e8f0' : '#fdba74', text: ev.braced ? '擋下衝鋒！' : `衝鋒！-${ev.kills}` });
        return;
      }
      case 'ambush': {
        const p = this.regPos(ev.reg);
        if (p === null) return;
        this.effects.push({ kind: 'ring', x: p.x, y: p.y, t0: now, life: 1200, color: '#facc15', size: 5 });
        this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 2200, color: '#fde047', text: '伏兵！' });
        return;
      }
      case 'routed': {
        const p = this.regPos(ev.reg);
        if (p !== null) this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 2000, color: '#cbd5e1', text: '潰散' });
        return;
      }
      case 'levelUp': {
        const p = this.regPos(ev.reg);
        if (p !== null) this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 2000, color: '#fbbf24', text: `★ 老兵 ${ev.level}` });
        return;
      }
      case 'contact': {
        if (ev.flank === 'front') return;
        const p = this.regPos(ev.b);
        if (p !== null) this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 1600, color: '#f87171', text: ev.flank === 'rear' ? '背擊！' : '側擊！' });
        return;
      }
      case 'flag': {
        const f = this.meta.flags[ev.flag];
        this.effects.push({ kind: 'ring', x: f.x, y: f.y, t0: now, life: 1200, color: ev.owner >= 0 ? TEAM[ev.owner] : '#e2e8f0', size: RULES.capture.radius / TILE });
        return;
      }
      default:
        return;
    }
  }

  fit(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.cam.scale = Math.min(w / this.meta.width, h / this.meta.height);
    this.cam.x = this.meta.width / 2;
    this.cam.y = this.meta.height / 2;
  }

  get fitScale(): number {
    return Math.min(this.canvas.clientWidth / this.meta.width, this.canvas.clientHeight / this.meta.height);
  }

  clamp(): void {
    const minS = this.fitScale * 0.9;
    this.cam.scale = Math.max(minS, Math.min(60, this.cam.scale));
    const halfW = this.canvas.clientWidth / 2 / this.cam.scale;
    const halfH = this.canvas.clientHeight / 2 / this.cam.scale;
    const clampAxis = (v: number, half: number, size: number): number => (half * 2 >= size ? size / 2 : Math.max(half, Math.min(size - half, v)));
    this.cam.x = clampAxis(this.cam.x, halfW, this.meta.width);
    this.cam.y = clampAxis(this.cam.y, halfH, this.meta.height);
  }

  /** 螢幕像素 → 世界單位 */
  toWorld(px: number, py: number): { x: number; y: number } {
    const c = this.cam;
    return { x: ((px - this.canvas.clientWidth / 2) / c.scale + c.x) * TILE, y: ((py - this.canvas.clientHeight / 2) / c.scale + c.y) * TILE };
  }

  private sx(x: number): number {
    return (x / TILE - this.cam.x) * this.cam.scale + this.canvas.clientWidth / 2;
  }

  private sy(y: number): number {
    return (y / TILE - this.cam.y) * this.cam.scale + this.canvas.clientHeight / 2;
  }

  /** 插值後的軍團位置（世界單位） */
  regAt(id: number, alpha: number): { x: number; y: number; facing: number } | null {
    const a = this.prevRegById.get(id);
    const b = this.regById.get(id);
    if (b === undefined) return null;
    if (a === undefined) return { x: b.x, y: b.y, facing: b.facing };
    let df = b.facing - a.facing;
    if (df > 180) df -= 360;
    if (df < -180) df += 360;
    return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha, facing: a.facing + df * alpha };
  }

  /** 該視角看得到這個軍團嗎 */
  shown(id: number, viewer: number): boolean {
    if (viewer < 0 || this.cur === null) return true;
    if (this.ownerOf[id] === viewer) return true;
    return this.cur.visible[viewer][id] === 1;
  }

  /** 螢幕座標下的軍團（點選、滑鼠提示） */
  pick(px: number, py: number, viewer: number, alpha: number): number {
    if (this.cur === null) return -1;
    const w = this.toWorld(px, py);
    let best = -1;
    let bestD = Infinity;
    for (const r of this.cur.regs) {
      if (!this.shown(r.id, viewer)) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      const lim = Math.max(r.rad + 800, 12 / this.cam.scale * TILE);
      if (d < lim && d < bestD) {
        bestD = d;
        best = r.id;
      }
    }
    return best;
  }

  draw(alpha: number, now: number, opt: DrawOptions): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, cw, ch);
    const s = this.cam.scale;
    ctx.imageSmoothingEnabled = s < TPX;
    ctx.drawImage(this.terrain, this.sx(0), this.sy(0), this.meta.width * s, this.meta.height * s);
    const f = this.cur;
    if (f === null) return;
    // 開戰前標出布陣區
    if (f.tick < 30) {
      this.meta.deploy.forEach((z, p) => {
        ctx.fillStyle = p === 0 ? 'rgba(59,130,246,0.12)' : 'rgba(239,68,68,0.12)';
        ctx.fillRect(this.sx(z.x0 * TILE), this.sy(z.y0 * TILE), (z.x1 - z.x0) * s, (z.y1 - z.y0) * s);
      });
    }
    if (this.meta.mode === 'capture') this.drawFlags(f);
    this.drawCorpses(now);
    if (opt.selected >= 0) this.drawSelection(opt.selected, alpha);
    this.drawSoldiers(alpha, opt);
    this.drawArrows(f, alpha);
    this.drawBanners(alpha, opt);
    this.drawEffects(now);
  }

  private drawFlags(f: LegionFrame): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const rad = (RULES.capture.radius / TILE) * s;
    this.meta.flags.forEach((fl, i) => {
      const st = f.flags[i];
      const x = this.sx(fl.x);
      const y = this.sy(fl.y);
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = st.owner >= 0 ? (st.owner === 0 ? 'rgba(59,130,246,0.16)' : 'rgba(239,68,68,0.16)') : 'rgba(226,232,240,0.07)';
      ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = st.owner >= 0 ? TEAM[st.owner] : 'rgba(226,232,240,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      // 佔領進度環
      const who = st.owner >= 0 ? st.owner : st.capturer;
      if (who >= 0 && st.value > 0) {
        ctx.beginPath();
        ctx.arc(x, y, rad, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * st.value) / RULES.capture.target);
        ctx.strokeStyle = TEAM[who];
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      // 旗桿與旗
      const k = Math.max(0.8, s / 8);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + 6 * k);
      ctx.lineTo(x, y - 14 * k);
      ctx.stroke();
      ctx.fillStyle = st.owner >= 0 ? TEAM[st.owner] : '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(x, y - 14 * k);
      ctx.lineTo(x + 11 * k, y - 10 * k);
      ctx.lineTo(x, y - 6 * k);
      ctx.fill();
      ctx.font = `600 ${Math.round(11 * Math.min(1.4, k))}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(fl.name, x + 1, y + 20 * k + 1);
      ctx.fillStyle = '#f1f5f9';
      ctx.fillText(fl.name, x, y + 20 * k);
    });
  }

  private drawCorpses(now: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const r = Math.max(1, s * 0.16);
    for (const c of this.corpses) {
      const age = (now - c.t) / 1000;
      const a = age < 25 ? 0.55 : Math.max(0, 0.55 - (age - 25) * 0.02);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = TEAM_DARK[c.owner];
      ctx.fillRect(this.sx(c.x) - r, this.sy(c.y) - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  private drawSoldiers(alpha: number, opt: DrawOptions): void {
    const f = this.cur!;
    const ctx = this.ctx;
    const s = this.cam.scale;
    const sol = f.soldiers;
    const simple = s < 5;
    const sparks: number[] = [];
    // 依（陣營、兵種、狀態）分組，一次填色
    const groups = new Map<string, number[]>();
    for (let i = 0; i < sol.length; i += 4) {
      const id = sol[i];
      const regId = sol[i + 3] & REG_MASK;
      if (!this.shown(regId, opt.viewer)) continue;
      const r = this.regById.get(regId);
      let x = sol[i + 1];
      let y = sol[i + 2];
      if (this.hasPrev[id] === 1) {
        x = this.prevX[id] + (x - this.prevX[id]) * alpha;
        y = this.prevY[id] + (y - this.prevY[id]) * alpha;
      }
      const owner = this.ownerOf[regId];
      const key = `${owner}|${this.kindOf[regId]}|${r?.status === 'routed' ? 1 : 0}|${r?.concealed ? 1 : 0}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = [];
        groups.set(key, g);
      }
      g.push(x, y, r?.facing ?? 0);
      if ((sol[i + 3] & ATTACKED_BIT) !== 0) sparks.push(x, y, r?.facing ?? 0);
    }
    for (const [key, pts] of groups) {
      const [ownerS, kind, routedS, concS] = key.split('|');
      const owner = Number(ownerS);
      const routed = routedS === '1';
      const color = routed ? ROUTED[owner] : TEAM[owner];
      ctx.globalAlpha = concS === '1' ? 0.55 : 1;
      if (simple) {
        ctx.fillStyle = color;
        const r = Math.max(1, s * 0.3);
        for (let i = 0; i < pts.length; i += 3) ctx.fillRect(this.sx(pts[i]) - r, this.sy(pts[i + 1]) - r, r * 2, r * 2);
        continue;
      }
      this.drawGlyphs(kind as UnitKind, pts, color, routed ? '#cbd5e1' : TEAM_LIGHT[owner], owner);
    }
    ctx.globalAlpha = 1;
    // 出手的火花
    if (s >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.beginPath();
      for (let i = 0; i < sparks.length; i += 3) {
        const a = (sparks[i + 2] * Math.PI) / 180;
        const x = this.sx(sparks[i]) + Math.cos(a) * s * 0.45;
        const y = this.sy(sparks[i + 1]) + Math.sin(a) * s * 0.45;
        const d = s * 0.16;
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d);
        ctx.lineTo(x - d, y + d);
      }
      ctx.stroke();
    }
  }

  /** 各兵種的士兵造型：身體（隊伍色）＋ 武器或坐騎（淺色） */
  private drawGlyphs(kind: UnitKind, pts: number[], color: string, light: string, owner: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const body = new Path2D();
    const detail = new Path2D();
    const cav = kind === 'lightCav' || kind === 'heavyCav';
    const br = Math.max(1.3, s * (kind === 'light' ? 0.2 : 0.25));
    for (let i = 0; i < pts.length; i += 3) {
      const x = this.sx(pts[i]);
      const y = this.sy(pts[i + 1]);
      const a = (pts[i + 2] * Math.PI) / 180;
      const c = Math.cos(a);
      const n = Math.sin(a);
      if (cav) {
        // 馬身：沿朝向的橢圓；騎士：中間一點
        const L = s * (kind === 'heavyCav' ? 0.62 : 0.52);
        const W = s * (kind === 'heavyCav' ? 0.27 : 0.21);
        body.moveTo(x + c * L, y + n * L);
        body.ellipse(x, y, L, W, a, 0, Math.PI * 2);
        detail.moveTo(x + br * 0.7, y);
        detail.arc(x, y, br * 0.7, 0, Math.PI * 2);
        if (kind === 'heavyCav') {
          detail.moveTo(x + c * L * 0.2, y + n * L * 0.2);
          detail.lineTo(x + c * L * 1.25, y + n * L * 1.25);
        }
        continue;
      }
      body.moveTo(x + br, y);
      body.arc(x, y, br, 0, Math.PI * 2);
      switch (kind) {
        case 'spear':
          detail.moveTo(x - c * s * 0.15, y - n * s * 0.15);
          detail.lineTo(x + c * s * 0.75, y + n * s * 0.75);
          break;
        case 'sword':
          detail.moveTo(x + c * br - n * br, y + n * br + c * br);
          detail.lineTo(x + c * s * 0.48 + n * s * 0.1, y + n * s * 0.48 - c * s * 0.1);
          break;
        case 'shield': {
          const fx = x + c * s * 0.3;
          const fy = y + n * s * 0.3;
          detail.moveTo(fx - n * s * 0.3, fy + c * s * 0.3);
          detail.lineTo(fx + n * s * 0.3, fy - c * s * 0.3);
          break;
        }
        case 'archer':
          detail.moveTo(x + c * s * 0.3 - n * s * 0.25, y + n * s * 0.3 + c * s * 0.25);
          detail.quadraticCurveTo(x + c * s * 0.55, y + n * s * 0.55, x + c * s * 0.3 + n * s * 0.25, y + n * s * 0.3 - c * s * 0.25);
          break;
        default:
          break;
      }
    }
    ctx.fillStyle = color;
    ctx.fill(body);
    ctx.strokeStyle = shade(TEAM[owner], 0.45);
    ctx.lineWidth = Math.max(0.6, s * 0.05);
    ctx.stroke(body);
    ctx.strokeStyle = light;
    ctx.lineWidth = Math.max(0.8, s * (kind === 'shield' ? 0.16 : 0.08));
    ctx.lineCap = 'round';
    ctx.stroke(detail);
    if (cav) {
      ctx.fillStyle = light;
      ctx.fill(detail);
    }
  }

  private drawArrows(f: LegionFrame, alpha: number): void {
    const a = f.arrows;
    if (a.length === 0) return;
    const ctx = this.ctx;
    const s = this.cam.scale;
    const t = f.tick - 1 + alpha;
    ctx.strokeStyle = 'rgba(250,240,215,0.85)';
    ctx.lineWidth = Math.max(0.7, s * 0.07);
    ctx.beginPath();
    for (let i = 0; i < a.length; i += 6) {
      const [x0, y0, x1, y1, t0, t1] = [a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]];
      const p = Math.max(0, Math.min(1, (t - t0) / Math.max(1, t1 - t0)));
      const q = Math.max(0, p - 0.12);
      const len = Math.hypot(x1 - x0, y1 - y0) / TILE;
      const lift = (u: number): number => Math.sin(Math.PI * u) * len * 0.18 * s;
      ctx.moveTo(this.sx(x0 + (x1 - x0) * q), this.sy(y0 + (y1 - y0) * q) - lift(q));
      ctx.lineTo(this.sx(x0 + (x1 - x0) * p), this.sy(y0 + (y1 - y0) * p) - lift(p));
    }
    ctx.stroke();
  }

  private drawSelection(id: number, alpha: number): void {
    const r = this.regById.get(id);
    const p = this.regAt(id, alpha);
    if (r === undefined || p === null) return;
    const ctx = this.ctx;
    const s = this.cam.scale;
    const owner = this.ownerOf[id];
    const kind = this.kindOf[id];
    const x = this.sx(p.x);
    const y = this.sy(p.y);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((p.facing * Math.PI) / 180);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    const hw = (r.halfD / TILE) * s + 3;
    const hh = (r.halfW / TILE) * s + 3;
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.setLineDash([]);
    ctx.restore();
    {
      const u = UNITS[kind];
      if (u.range > 0) {
        ctx.beginPath();
        ctx.arc(x, y, ((u.range + (this.terrainAt(p.x, p.y) === T.Hill ? RULES.terrain.hillRange : 0)) / TILE) * s, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(250,204,21,0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, ((u.sight + (this.terrainAt(p.x, p.y) === T.Hill ? RULES.terrain.hillSight : 0)) / TILE) * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(148,163,184,0.45)';
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const tgt = r.target >= 0 ? r.target : r.fireTarget;
    const tp = tgt >= 0 ? this.regAt(tgt, alpha) : null;
    if (tp !== null) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(this.sx(tp.x), this.sy(tp.y));
      ctx.strokeStyle = TEAM[owner];
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private terrainAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.meta.width || ty >= this.meta.height) return T.River;
    return this.meta.terrain[ty * this.meta.width + tx];
  }

  private drawBanners(alpha: number, opt: DrawOptions): void {
    const f = this.cur!;
    const ctx = this.ctx;
    const s = this.cam.scale;
    const k = Math.max(0.75, Math.min(1.25, s / 9));
    const font = getComputedStyle(document.body).fontFamily;
    const w = 46 * k;
    const h = 15 * k;
    // 先排好每個旗標的位置：與已放好的重疊就往上移，選中的軍團優先
    const order = [...f.regs].sort((a, b) => (b.id === opt.selected ? 1 : 0) - (a.id === opt.selected ? 1 : 0) || b.y - a.y);
    const placed: [number, number][] = [];
    const spot = new Map<number, [number, number, number]>();
    for (const r of order) {
      if (!this.shown(r.id, opt.viewer)) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const bx = this.sx(p.x);
      const by0 = this.sy(p.y) - (r.rad / TILE) * s - 12 * k;
      let by = by0;
      for (let tries = 0; tries < 6; tries++) {
        if (!placed.some(([px, py]) => Math.abs(px - bx) < w + 6 && Math.abs(py - by) < h + 3)) break;
        by -= h + 4;
      }
      placed.push([bx, by]);
      spot.set(r.id, [bx, by, by0]);
    }
    for (const r of f.regs) {
      const sp = spot.get(r.id);
      if (sp === undefined) continue;
      const p = this.regAt(r.id, alpha)!;
      const owner = this.ownerOf[r.id];
      const st = this.meta.regs[r.id];
      const [x, y, y0] = sp;
      if (y !== y0) {
        ctx.strokeStyle = 'rgba(226,232,240,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + h / 2);
        ctx.lineTo(x, y0 + h / 2);
        ctx.stroke();
      }
      // 朝向箭頭（陣型前方）
      if (s >= 4 && r.status !== 'routed') {
        const a = (p.facing * Math.PI) / 180;
        const d = (r.halfD / TILE) * s + 5;
        const fx = this.sx(p.x) + Math.cos(a) * d;
        const fy = this.sy(p.y) + Math.sin(a) * d;
        ctx.beginPath();
        ctx.moveTo(fx + Math.cos(a) * 5 * k, fy + Math.sin(a) * 5 * k);
        ctx.lineTo(fx + Math.cos(a + 2.4) * 4 * k, fy + Math.sin(a + 2.4) * 4 * k);
        ctx.lineTo(fx + Math.cos(a - 2.4) * 4 * k, fy + Math.sin(a - 2.4) * 4 * k);
        ctx.fillStyle = 'rgba(248,250,252,0.85)';
        ctx.fill();
      }
      // 隱蔽中（上帝視角）：虛線框
      if (r.concealed && opt.viewer < 0) {
        ctx.save();
        ctx.translate(this.sx(p.x), this.sy(p.y));
        ctx.rotate((p.facing * Math.PI) / 180);
        ctx.strokeStyle = '#facc15';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.5;
        const hw = (r.halfD / TILE) * s + 4;
        const hh = (r.halfW / TILE) * s + 4;
        ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
        ctx.restore();
        ctx.setLineDash([]);
      }
      const hover = opt.hovered === r.id || opt.selected === r.id;
      ctx.globalAlpha = r.status === 'routed' ? 0.6 : 1;
      ctx.fillStyle = hover ? '#0f172a' : 'rgba(8,12,20,0.82)';
      ctx.strokeStyle = r.status === 'routed' ? '#64748b' : TEAM[owner];
      ctx.lineWidth = hover ? 2 : 1.2;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 4 * k);
      ctx.fill();
      ctx.stroke();
      // 兵種色塊與圖示
      ctx.fillStyle = r.status === 'routed' ? '#475569' : TEAM[owner];
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, h, h, [4 * k, 0, 0, 4 * k]);
      ctx.fill();
      drawUnitIcon(ctx, st.kind, x - w / 2 + h / 2, y, h * 0.86, '#fff', 2);
      ctx.font = `700 ${Math.round(10 * k)}px ${font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(String(r.men), x - w / 2 + h + 3 * k, y + 0.5);
      if (r.level > 1) {
        ctx.fillStyle = '#fbbf24';
        ctx.fillText('★'.repeat(r.level - 1), x - w / 2 + h + 19 * k, y + 0.5);
      }
      // 人數條
      const frac = r.men / st.men0;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x - w / 2, y + h / 2 + 1.5, w, 2.5 * k);
      ctx.fillStyle = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#f87171';
      ctx.fillRect(x - w / 2, y + h / 2 + 1.5, w * frac, 2.5 * k);
      // 狀態標籤
      const tag = r.status === 'routed' ? '潰散' : r.status === 'braced' ? '架陣' : r.status === 'bracing' ? '架陣中' : r.status === 'unbracing' ? '收陣' : r.status === 'charging' ? '衝鋒' : r.concealed && opt.viewer < 0 ? '埋伏中' : '';
      if (tag !== '') {
        ctx.font = `700 ${Math.round(9 * k)}px ${font}`;
        const tw = ctx.measureText(tag).width + 6 * k;
        ctx.fillStyle = tag === '衝鋒' ? '#f97316' : tag === '埋伏中' ? '#a16207' : tag === '潰散' ? '#334155' : '#0e7490';
        ctx.beginPath();
        ctx.roundRect(x + w / 2 + 2, y - h / 2, tw, h, 3 * k);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(tag, x + w / 2 + 2 + 3 * k, y + 0.5);
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawEffects(now: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const font = getComputedStyle(document.body).fontFamily;
    this.effects = this.effects.filter((e) => now - e.t0 < e.life);
    for (const e of this.effects) {
      const p = (now - e.t0) / e.life;
      const x = this.sx(e.x);
      const y = this.sy(e.y);
      if (e.kind === 'ring') {
        ctx.beginPath();
        ctx.arc(x, y, (e.size ?? 3) * s * (0.3 + p * 0.9), 0, Math.PI * 2);
        ctx.strokeStyle = e.color;
        ctx.globalAlpha = 1 - p;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = p < 0.8 ? 1 : (1 - p) / 0.2;
        ctx.font = `800 ${Math.round(14 + Math.min(6, s * 0.4))}px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const ty = y - 26 - p * 24;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(e.text ?? '', x, ty);
        ctx.fillStyle = e.color;
        ctx.fillText(e.text ?? '', x, ty);
        ctx.globalAlpha = 1;
      }
    }
  }
}
