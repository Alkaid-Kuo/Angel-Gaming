// 軍團戰繪製（Canvas 2D）：地形（含高度疊板）預先畫成一張圖；每格畫面依兩個 tick 之間插值畫士兵、箭矢、軍團旗標與特效，
// 招牌技能與衝刺畫在地面層：槍林扇形、盾兵擋箭範圍與盾牆、齊射落點圈、衝刺的預定路線與走過的弧線。
import type { RegimentStatus } from '../../legion/api.ts';
import { DASH, FORMATION_NAMES, RULES, T, TERRAIN_NAMES, TILE, TPS, UNITS, stopsCavalry, walkable, type DashKind, type UnitKind } from '../../legion/config.ts';
import { hashInts } from '../../shared/hash.ts';
import { drawUnitIcon } from './icons.ts';
import { ATTACKED_BIT, DOWN_BIT, LAYER_SHIFT, REG_MASK, type LegionFrame, type LegionMeta, type RegFrame } from './protocol.ts';

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
  /** 顯示 AI 意圖（放大到一定程度才顯示；滑鼠指著或選中的軍團一律顯示） */
  readonly showIntent: boolean;
  /** 玩家操控：選取中的團、框選（螢幕座標）、右鍵拖曳中的移動方向（世界座標） */
  readonly selection?: ReadonlySet<number>;
  readonly box?: { x0: number; y0: number; x1: number; y1: number } | null;
  readonly order?: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  /** 按住技能鍵瞄準中：選取的團與滑鼠位置（世界座標） */
  readonly aim?: { ids: readonly number[]; to: { x: number; y: number } } | null;
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

/** 衝刺走過的路線（結束後淡出） */
interface Trail {
  readonly owner: number;
  readonly kind: DashKind;
  readonly pts: number[];
  end: number;
}

interface Corpse {
  x: number;
  y: number;
  owner: number;
  t: number;
}

export const TEAM = ['#3b82f6', '#ef4444'];
export const TEAM_LIGHT = ['#bfdbfe', '#fecaca'];
export const TEAM_DARK = ['#1e3a8a', '#7f1d1d'];
const ROUTED = ['#64748b', '#78716c'];
export const DASH_COLOR: Record<DashKind, string> = { charge: '#fb923c', assault: '#facc15', infiltrate: '#a3e635' };
export const DASH_NAME: Record<DashKind, string> = { charge: '衝鋒', assault: '突擊', infiltrate: '切入' };
const TRAIL_FADE = 2500;
/** 旗標右側的狀態標籤：文字、底色 */
export const TAG: Partial<Record<RegimentStatus, readonly [string, string]>> = {
  routed: ['潰散', '#334155'],
  charging: ['衝鋒', '#ea580c'],
  assaulting: ['突擊', '#ca8a04'],
  infiltrating: ['切入', '#4d7c0f'],
  braced: ['槍林', '#0e7490'],
  bracing: ['架槍林', '#155e75'],
  unbracing: ['收槍林', '#155e75'],
  walled: ['盾牆', '#0e7490'],
  walling: ['架盾牆', '#155e75'],
  volleying: ['齊射', '#b45309'],
  reforming: ['變陣', '#6d28d9'],
};

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
    [T.Building]: [124, 112, 98],
    [T.Wall]: [176, 168, 148],
    [T.Stair]: [196, 182, 146],
    [T.Gatehouse]: [150, 132, 104],
    [T.Paved]: [148, 140, 122],
    [T.Rubble]: [128, 118, 102],
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
  // 高度疊板：每高一階亮一點；高的一階在南邊、東邊露出側面（陰影帶），北邊、西邊有亮邊，像一層層疊起來的板子
  const hAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? -1 : meta.heights[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lv = hAt(x, y);
      if (lv >= 2) {
        g.fillStyle = `rgba(255,244,214,${0.04 * (lv - 1)})`;
        g.fillRect(x * TPX, y * TPX, TPX, TPX);
      }
      const up = hAt(x, y - 1);
      if (up > lv) {
        const d = Math.min(3, up - lv);
        g.fillStyle = 'rgba(38,30,14,0.45)';
        g.fillRect(x * TPX, y * TPX, TPX, 1 + d * 1.4);
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(x * TPX, y * TPX + 1 + d * 1.4, TPX, 2);
      } else if (up >= 0 && up < lv) {
        g.fillStyle = 'rgba(255,240,200,0.28)';
        g.fillRect(x * TPX, y * TPX, TPX, 1);
      }
      const left = hAt(x - 1, y);
      if (left > lv) {
        g.fillStyle = 'rgba(38,30,14,0.3)';
        g.fillRect(x * TPX, y * TPX, 1.5, TPX);
      } else if (left >= 0 && left < lv) {
        g.fillStyle = 'rgba(255,240,200,0.2)';
        g.fillRect(x * TPX, y * TPX, 1, TPX);
      }
      const right = hAt(x + 1, y);
      if (right >= 0 && right < lv) {
        g.fillStyle = 'rgba(50,40,20,0.4)';
        g.fillRect((x + 1) * TPX - 1, y * TPX, 1, TPX);
      }
    }
  }
  // 房舍：灰瓦屋頂（屋脊亮線、南側陰影；不用紅色，免得和紅方搞混）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== T.Building) continue;
      const px = x * TPX;
      const py = y * TPX;
      g.fillStyle = 'rgba(255,250,235,0.18)';
      g.fillRect(px, py + TPX / 2 - 1, TPX, 2);
      if (at(x, y + 1) !== T.Building) {
        g.fillStyle = 'rgba(20,10,5,0.45)';
        g.fillRect(px, py + TPX - 2, TPX, 2);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(px, py + TPX, TPX, 3);
      }
      if (at(x - 1, y) !== T.Building) {
        g.fillStyle = 'rgba(20,10,5,0.35)';
        g.fillRect(px, py, 1, TPX);
      }
    }
  }
  // 城牆：亮石色的牆頂、深色外框與投影、城垛；門樓：拱門；樓梯：踏階
  const wallish = (t: number): boolean => t === T.Wall || t === T.Gatehouse;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = at(x, y);
      const px = x * TPX;
      const py = y * TPX;
      if (wallish(t)) {
        g.fillStyle = 'rgba(255,255,245,0.12)';
        g.fillRect(px + 2, py + 2, TPX - 4, TPX - 4);
        // 外框：和不是牆的格相鄰的那一邊畫深色線，牆的輪廓才看得清楚
        g.fillStyle = 'rgba(40,34,26,0.9)';
        if (!wallish(at(x, y - 1))) g.fillRect(px, py, TPX, 2);
        if (!wallish(at(x, y + 1))) g.fillRect(px, py + TPX - 2, TPX, 2);
        if (!wallish(at(x - 1, y))) g.fillRect(px, py, 2, TPX);
        if (!wallish(at(x + 1, y))) g.fillRect(px + TPX - 2, py, 2, TPX);
        g.fillStyle = 'rgba(90,82,70,0.8)';
        for (let k = 0; k < 2; k++) g.fillRect(px + 2 + k * 4, py + 3, 2, 2);
      }
      // 牆的投影（往東南落在地面上）
      if (!wallish(t) && t !== T.River && (wallish(at(x - 1, y)) || wallish(at(x, y - 1)))) {
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.fillRect(px, py, wallish(at(x - 1, y)) ? 3 : TPX, wallish(at(x, y - 1)) ? 3 : TPX);
      }
      if (t === T.Gatehouse) {
        g.fillStyle = 'rgba(20,12,6,0.85)';
        g.beginPath();
        g.moveTo(px + 2, py + TPX);
        g.lineTo(px + 2, py + TPX * 0.5);
        g.arc(px + TPX / 2, py + TPX * 0.5, TPX / 2 - 2, Math.PI, 0);
        g.lineTo(px + TPX - 2, py + TPX);
        g.closePath();
        g.fill();
      }
      if (t === T.Stair) {
        g.strokeStyle = 'rgba(60,45,30,0.7)';
        g.lineWidth = 1;
        for (let k = 1; k < 4; k++) {
          g.beginPath();
          g.moveTo(px, py + (k * TPX) / 4);
          g.lineTo(px + TPX, py + (k * TPX) / 4);
          g.stroke();
        }
      }
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
  private trails = new Map<number, Trail>();
  private regById = new Map<number, RegFrame>();
  /** 在場上的軍團（不含後備） */
  private field: RegFrame[] = [];
  /** 戰爭迷霧用的離屏畫布 */
  private fogCanvas: HTMLCanvasElement | null = null;
  private prevRegById = new Map<number, RegFrame>();
  readonly kindOf: UnitKind[];
  readonly ownerOf: number[];

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
    this.field = f.regs.filter((r) => !r.reserve);
    for (const ev of f.events) this.effectFor(ev, now);
    // 衝刺軌跡：衝刺中每格記一點；結束後開始淡出
    for (const r of this.field) {
      if (r.dashing === null || r.dash === null || r.dash.aligning) continue;
      let t = this.trails.get(r.id);
      if (t === undefined || t.end > 0) {
        t = { owner: this.ownerOf[r.id], kind: r.dashing, pts: [], end: 0 };
        this.trails.set(r.id, t);
      }
      t.pts.push(r.x, r.y);
    }
    for (const [id, t] of this.trails) if (t.end === 0 && (this.regById.get(id)?.dashing ?? null) === null) t.end = now;
  }

  /** 重新開始時清掉 */
  reset(): void {
    this.prev = null;
    this.cur = null;
    this.effects = [];
    this.corpses = [];
    this.trails.clear();
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
        if (ev.target < 0 && ev.kills === 0) return;
        const p = this.regPos(ev.target) ?? this.regPos(ev.reg);
        if (p === null) return;
        const hit = [ev.kills > 0 ? `-${ev.kills}` : '', ev.downed > 0 ? `倒 ${ev.downed}` : ''].filter((x) => x !== '').join(' ');
        this.effects.push({ kind: 'ring', x: p.x, y: p.y, t0: now, life: 900, color: ev.braced ? '#e2e8f0' : DASH_COLOR[ev.kind], size: ev.kind === 'charge' ? 3.6 : 2.6 });
        this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 1800, color: ev.braced ? '#e2e8f0' : DASH_COLOR[ev.kind], text: ev.braced ? `擋下${DASH_NAME[ev.kind]}！` : `${DASH_NAME[ev.kind]}！${hit}` });
        return;
      }
      case 'skill': {
        if (ev.skill !== 'volley' && ev.skill !== 'wall' && ev.skill !== 'brace') return;
        const p = this.regPos(ev.reg);
        if (p === null) return;
        const text = ev.skill === 'volley' ? '齊射！' : ev.skill === 'wall' ? '盾牆！' : '槍林！';
        this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 1400, color: ev.skill === 'volley' ? '#fbbf24' : '#a5f3fc', text, size: 0.8 });
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
    if (b === undefined || b.reserve) return null;
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
    for (const r of this.field) {
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
    if (s >= 14) this.drawGrid(cw, ch);
    const f = this.cur;
    if (f === null) return;
    // 開戰前標出布陣區
    if (f.tick < 30) {
      this.meta.deploy.forEach((z, p) => {
        ctx.fillStyle = p === 0 ? 'rgba(59,130,246,0.12)' : 'rgba(239,68,68,0.12)';
        const mask = this.meta.deployMask[p];
        if (mask === null) {
          ctx.fillRect(this.sx(z.x0 * TILE), this.sy(z.y0 * TILE), (z.x1 - z.x0) * s, (z.y1 - z.y0) * s);
          return;
        }
        // 不是矩形的布陣區：逐列畫連續的格
        for (let y = z.y0; y < z.y1; y++) {
          for (let x = z.x0; x < z.x1; ) {
            if (mask[y * this.meta.width + x] !== 1) {
              x += 1;
              continue;
            }
            let e = x;
            while (e < z.x1 && mask[y * this.meta.width + e] === 1) e += 1;
            ctx.fillRect(this.sx(x * TILE), this.sy(y * TILE), (e - x) * s, s);
            x = e;
          }
        }
      });
    }
    if (this.meta.mode === 'capture') this.drawDepots(f);
    if (this.meta.mode === 'capture' || this.meta.mode === 'siege') this.drawFlags(f, now);
    this.drawGates(f);
    this.drawLadders(f);
    this.drawCorpses(now);
    this.drawTrails(now, opt);
    this.drawSkills(f, alpha, opt);
    if (opt.viewer >= 0) this.drawFog(opt.viewer, alpha);
    if (opt.selection && opt.selection.size > 0) {
      for (const id of opt.selection) this.drawSelection(id, alpha, opt.selection.size === 1);
    } else if (opt.selected >= 0) this.drawSelection(opt.selected, alpha, true);
    this.drawSoldiers(alpha, opt);
    this.drawRam(f);
    this.drawBombards(f);
    this.drawArrows(f, alpha);
    this.drawBanners(alpha, opt);
    this.drawEffects(now);
    this.drawOrders(opt);
    if (opt.aim) this.drawAim(opt.aim, alpha);
  }

  /** 拉近時的格線（測試用）：每格一條細線、每 10 格一條粗線並標出格座標 */
  private drawGrid(cw: number, ch: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const x0 = Math.max(0, Math.floor(this.cam.x - cw / 2 / s));
    const x1 = Math.min(this.meta.width, Math.ceil(this.cam.x + cw / 2 / s));
    const y0 = Math.max(0, Math.floor(this.cam.y - ch / 2 / s));
    const y1 = Math.min(this.meta.height, Math.ceil(this.cam.y + ch / 2 / s));
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.14)';
      ctx.lineWidth = major ? 1.2 : 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        if ((x % 10 === 0) !== major) continue;
        const px = Math.round(this.sx(x * TILE)) + 0.5;
        ctx.moveTo(px, this.sy(y0 * TILE));
        ctx.lineTo(px, this.sy(y1 * TILE));
      }
      for (let y = y0; y <= y1; y++) {
        if ((y % 10 === 0) !== major) continue;
        const py = Math.round(this.sy(y * TILE)) + 0.5;
        ctx.moveTo(this.sx(x0 * TILE), py);
        ctx.lineTo(this.sx(x1 * TILE), py);
      }
      ctx.stroke();
    }
    ctx.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) {
      for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) {
        const label = `${x},${y}`;
        const px = this.sx(x * TILE) + 3;
        const py = this.sy(y * TILE) + 2;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(px - 2, py - 1, ctx.measureText(label).width + 4, 13);
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(label, px, py);
      }
    }
  }

  /** 世界座標 → 螢幕座標 */
  toScreen(x: number, y: number): [number, number] {
    return [this.sx(x), this.sy(y)];
  }

  /** 下指令的地點閃一下 */
  ping(x: number, y: number, color: string): void {
    this.effects.push({ kind: 'ring', x, y, t0: performance.now(), life: 600, color, size: 1.6 });
  }

  /** 框選框、右鍵拖曳的移動方向 */
  private drawOrders(opt: DrawOptions): void {
    const ctx = this.ctx;
    if (opt.box) {
      const b = opt.box;
      ctx.fillStyle = 'rgba(147,197,253,0.12)';
      ctx.strokeStyle = 'rgba(191,219,254,0.85)';
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (opt.order) {
      const a = opt.order.from;
      const b = opt.order.to;
      const x0 = this.sx(a.x);
      const y0 = this.sy(a.y);
      const x1 = this.sx(b.x);
      const y1 = this.sy(b.y);
      ctx.strokeStyle = '#bfdbfe';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.fillStyle = '#bfdbfe';
      ctx.beginPath();
      ctx.moveTo(x1 + Math.cos(ang) * 9, y1 + Math.sin(ang) * 9);
      ctx.lineTo(x1 + Math.cos(ang + 2.5) * 8, y1 + Math.sin(ang + 2.5) * 8);
      ctx.lineTo(x1 + Math.cos(ang - 2.5) * 8, y1 + Math.sin(ang - 2.5) * 8);
      ctx.fill();
    }
  }

  /**
   * 技能瞄準：衝刺類畫出隊形寬度的路線帶與中線（衝刺只看方向、衝滿距離；騎兵的助跑段畫虛線），
   * 隊形裡會碰到擋衝刺地形（騎兵：樹林、淺灘、河流、建築；步兵：河流、建築）的位置打叉，那裡的人會停下；
   * 齊射畫落點圈（超出射程變紅）與射程圈；槍林畫正面扇形。冷卻中的畫成灰色並標出剩幾秒
   */
  private drawAim(aim: { ids: readonly number[]; to: { x: number; y: number } }, alpha: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const font = getComputedStyle(document.body).fontFamily;
    const label = (x: number, y: number, text: string, color: string): void => {
      ctx.font = `600 12px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(text, x + 1, y - 7);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y - 8);
    };
    for (const id of aim.ids) {
      const p = this.regAt(id, alpha);
      const r = this.regById.get(id);
      if (p === null || r === undefined) continue;
      const kind = this.kindOf[id] as UnitKind;
      const cd = r.skillCd > 0;
      const color = cd ? 'rgba(148,163,184,0.85)' : '#fde68a';
      const ang = Math.atan2(aim.to.y - p.y, aim.to.x - p.x);
      const cx = this.sx(p.x);
      const cy = this.sy(p.y);
      const dash = kind === 'sword' ? DASH.assault : kind === 'light' ? DASH.infiltrate : kind === 'lightCav' ? DASH.lightCav : kind === 'heavyCav' ? DASH.heavyCav : null;
      if (dash !== null) {
        // 地形各自判定：隊形寬度內分成幾條路線，每條碰到擋衝刺的地形，那裡的人就停下（打叉），其他人照樣衝滿距離
        const cav = dash.kind === 'charge';
        const fx = Math.cos(ang);
        const fy = Math.sin(ang);
        const hw = Math.max(500, r.halfW);
        const lanes = Math.max(3, Math.round((hw * 2) / 500) + 1);
        const stops: { d: number; l: number; t: number }[] = [];
        for (let i = 0; i < lanes; i++) {
          const l = -hw + (2 * hw * i) / (lanes - 1);
          for (let d = 250; d <= dash.dist; d += 250) {
            const t = this.terrainAt(p.x + fx * d - fy * l, p.y + fy * d + fx * l);
            if (cav ? stopsCavalry(t) : !walkable(t)) {
              stops.push({ d, l, t });
              break;
            }
          }
        }
        const scr = (d: number, l: number): [number, number] => [this.sx(p.x + fx * d - fy * l), this.sy(p.y + fy * d + fx * l)];
        // 路線帶（隊形寬度）
        ctx.beginPath();
        for (const [d, l] of [[0, -hw], [dash.dist, -hw], [dash.dist, hw], [0, hw]] as const) {
          const [x, y] = scr(d, l);
          if (d === 0 && l === -hw) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = cd ? 'rgba(148,163,184,0.1)' : 'rgba(253,230,138,0.1)';
        ctx.fill();
        // 中線：騎兵的助跑段畫虛線
        const run = Math.min(dash.dist, dash.runup);
        const [rx, ry] = scr(run, 0);
        const [ex, ey] = scr(dash.dist, 0);
        ctx.lineCap = 'round';
        if (run > 0) {
          ctx.setLineDash([4, 5]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(rx, ry);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(ex + fx * 10, ey + fy * 10);
        ctx.lineTo(ex + Math.cos(ang + 2.5) * 9, ey + Math.sin(ang + 2.5) * 9);
        ctx.lineTo(ex + Math.cos(ang - 2.5) * 9, ey + Math.sin(ang - 2.5) * 9);
        ctx.fill();
        label(ex, ey, `${(dash.dist / TILE).toFixed(0)} 格`, color);
        // 會被擋下的位置
        const k = 4;
        ctx.strokeStyle = '#f87171';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const st of stops) {
          const [x, y] = scr(st.d, st.l);
          ctx.moveTo(x - k, y - k);
          ctx.lineTo(x + k, y + k);
          ctx.moveTo(x + k, y - k);
          ctx.lineTo(x - k, y + k);
        }
        ctx.stroke();
        if (stops.length > 0) {
          const first = stops.reduce((a, b) => (a.d <= b.d ? a : b));
          const [x, y] = scr(first.d, first.l);
          label(x, y, `約 ${Math.round((stops.length * 100) / lanes)}% 的人會被${TERRAIN_NAMES[first.t]}擋下`, '#fca5a5');
        }
        if (cd) label(cx, cy - 14, `冷卻 ${Math.ceil(r.skillCd / 10)} 秒`, '#cbd5e1');
      } else if (kind === 'archer') {
        const lv = Math.max(-RULES.height.clamp, Math.min(RULES.height.clamp, this.heightAt(p.x, p.y) - this.heightAt(aim.to.x, aim.to.y)));
        const range = UNITS.archer.range + RULES.height.rangePerLevel * lv;
        const ok = Math.hypot(aim.to.x - p.x, aim.to.y - p.y) <= range;
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = 'rgba(253,230,138,0.45)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, (range / TILE) * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        const tx = this.sx(aim.to.x);
        const ty = this.sy(aim.to.y);
        const c = cd ? 'rgba(148,163,184,0.85)' : ok ? '#fde68a' : '#f87171';
        ctx.fillStyle = cd ? 'rgba(148,163,184,0.15)' : ok ? 'rgba(253,230,138,0.15)' : 'rgba(248,113,113,0.15)';
        ctx.strokeStyle = c;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(tx, ty, (RULES.volley.radius / TILE) * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        label(tx, ty - (RULES.volley.radius / TILE) * s, cd ? `冷卻 ${Math.ceil(r.skillCd / 10)} 秒` : ok ? '齊射' : '超出射程', c);
      } else if (kind === 'spear') {
        const R = ((r.halfD + UNITS.spear.reach) / TILE) * s;
        const half = (RULES.flank.frontHalf * Math.PI) / 180;
        ctx.fillStyle = cd ? 'rgba(148,163,184,0.15)' : 'rgba(253,230,138,0.18)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, ang - half, ang + half);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        label(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, r.status === 'braced' || r.status === 'bracing' ? '收槍林' : '槍林', color);
      } else if (kind === 'shield') {
        label(cx, cy - 10, r.status === 'walled' || r.status === 'walling' ? '收盾牆' : '盾牆', color);
      }
    }
  }

  /** 出生點（隊伍色的帳篷）與補給站（補給十字，顏色＝佔著那座橋的一方，沒人佔是灰色） */
  private drawDepots(f: LegionFrame): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const font = getComputedStyle(document.body).fontFamily;
    const k = Math.max(0.8, s / 8);
    const mark = (x: number, y: number, radius: number, color: string, fill: string, label: string, icon: 'tent' | 'cross'): void => {
      ctx.beginPath();
      ctx.arc(x, y, (radius / TILE) * s, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
      const r = 7 * k;
      ctx.fillStyle = 'rgba(8,12,20,0.85)';
      ctx.beginPath();
      ctx.roundRect(x - r, y - r, r * 2, r * 2, 3 * k);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      if (icon === 'tent') {
        ctx.moveTo(x, y - r * 0.65);
        ctx.lineTo(x + r * 0.7, y + r * 0.55);
        ctx.lineTo(x - r * 0.7, y + r * 0.55);
        ctx.closePath();
      } else {
        const a = r * 0.22;
        const b = r * 0.65;
        ctx.rect(x - a, y - b, a * 2, b * 2);
        ctx.rect(x - b, y - a, b * 2, a * 2);
      }
      ctx.fill();
      ctx.font = `600 ${Math.round(10 * Math.min(1.3, k))}px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(label, x + 1, y + r + 8 * k + 1);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(label, x, y + r + 8 * k);
    };
    this.meta.spawns.forEach((sp, p) => mark(this.sx(sp.x), this.sy(sp.y), RULES.capture.spawnRadius, TEAM[p], p === 0 ? 'rgba(59,130,246,0.08)' : 'rgba(239,68,68,0.08)', '出生點', 'tent'));
    for (const su of this.meta.supplies) {
      const owner = f.flags[su.flag]?.owner ?? -1;
      mark(this.sx(su.x), this.sy(su.y), RULES.capture.supplyRadius, owner >= 0 ? TEAM[owner] : '#94a3b8', owner === 0 ? 'rgba(59,130,246,0.08)' : owner === 1 ? 'rgba(239,68,68,0.08)' : 'rgba(148,163,184,0.06)', '補給站', 'cross');
    }
  }

  /** 旗點：圈（佔領者的顏色；被爭奪時黃色閃爍）、佔領進度環（正在佔領的一方的顏色）、旗、名稱與每秒分數 */
  /** 城門：關著畫木門、開門中／關門中畫一半、破壞畫碎木；正門與側門上方血量條 */
  private drawGates(f: LegionFrame): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    for (const g of f.structures.gates) {
      const x = this.sx(g.x0 * TILE);
      const y = this.sy(g.y0 * TILE);
      const w = (g.x1 - g.x0) * s;
      const h = (g.y1 - g.y0) * s;
      if (g.state === 'closed' || g.state === 'opening' || g.state === 'closing') {
        ctx.fillStyle = g.state === 'closed' ? 'rgba(120,72,30,0.95)' : 'rgba(120,72,30,0.55)';
        ctx.fillRect(x + s * 0.15, y + s * 0.15, w - s * 0.3, h - s * 0.3);
        ctx.strokeStyle = 'rgba(40,24,10,0.9)';
        ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.strokeRect(x + s * 0.15, y + s * 0.15, w - s * 0.3, h - s * 0.3);
      } else if (g.state === 'broken') {
        ctx.fillStyle = 'rgba(90,60,30,0.6)';
        for (let k = 0; k < 4; k++) ctx.fillRect(x + ((k * 37) % 10) * w * 0.08, y + ((k * 53) % 10) * h * 0.08, s * 0.25, s * 0.12);
      }
      // 血量條
      const bw = Math.max(w, h, s * 2);
      const bx = this.sx(g.x) - bw / 2;
      const by = y - s * 0.9;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, bw, Math.max(3, s * 0.3));
      ctx.fillStyle = g.hp > g.hpMax / 2 ? '#a3e635' : g.hp > g.hpMax / 4 ? '#facc15' : '#f87171';
      ctx.fillRect(bx, by, (bw * g.hp) / g.hpMax, Math.max(3, s * 0.3));
    }
  }

  /** 雲梯：梯腳到梯口一條線（架設中畫虛線與進度） */
  private drawLadders(f: LegionFrame): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    for (const l of f.structures.ladders) {
      ctx.strokeStyle = l.built ? '#d6b98c' : 'rgba(214,185,140,0.7)';
      ctx.lineWidth = Math.max(1.5, s * 0.25);
      ctx.setLineDash(l.built ? [] : [s * 0.3, s * 0.3]);
      ctx.beginPath();
      ctx.moveTo(this.sx(l.footX), this.sy(l.footY));
      ctx.lineTo(this.sx(l.x), this.sy(l.y));
      ctx.stroke();
      ctx.setLineDash([]);
      if (!l.built || l.topple >= 0) {
        const p = l.built ? l.topple / RULES.ladder.toppleTicks : l.progress / l.buildTicks;
        ctx.beginPath();
        ctx.arc(this.sx(l.footX), this.sy(l.footY), s * 0.7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
        ctx.strokeStyle = l.built ? TEAM[1 - l.owner] : TEAM[l.owner];
        ctx.lineWidth = Math.max(1.5, s * 0.15);
        ctx.stroke();
      }
    }
  }

  /** 衝車：一個朝向正面的矩形，正面一條粗邊 */
  private drawRam(f: LegionFrame): void {
    const q = f.structures.ram;
    if (q === null) return;
    const ctx = this.ctx;
    const s = this.cam.scale;
    ctx.save();
    ctx.translate(this.sx(q.x), this.sy(q.y));
    ctx.rotate((q.facing * Math.PI) / 180);
    ctx.fillStyle = q.crew !== null ? '#8b5a2b' : 'rgba(139,90,43,0.6)';
    ctx.fillRect(-s * 1.1, -s * 0.6, s * 2.2, s * 1.2);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(s * 0.9, -s * 0.6, s * 0.25, s * 1.2);
    ctx.strokeStyle = TEAM[q.owner];
    ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.strokeRect(-s * 1.1, -s * 0.6, s * 2.2, s * 1.2);
    ctx.restore();
  }

  /** 砲擊落點：圓圈與落地倒數（秒） */
  private drawBombards(f: LegionFrame): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const font = getComputedStyle(document.body).fontFamily;
    for (const b of f.structures.bombards) {
      const x = this.sx(b.x);
      const y = this.sy(b.y);
      ctx.beginPath();
      ctx.arc(x, y, (b.radius / TILE) * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(248,113,113,0.12)';
      ctx.fill();
      ctx.setLineDash([s * 0.4, s * 0.3]);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `700 ${Math.round(Math.max(12, s * 1.4))}px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fecaca';
      ctx.fillText(`${Math.ceil(b.landIn / TPS)}`, x, y + s * 0.5);
    }
  }

  private drawFlags(f: LegionFrame, now: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const rad = (RULES.capture.radius / TILE) * s;
    const font = getComputedStyle(document.body).fontFamily;
    const blink = Math.floor(now / 350) % 2 === 0;
    this.meta.flags.forEach((fl, i) => {
      const st = f.flags[i];
      const x = this.sx(fl.x);
      const y = this.sy(fl.y);
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = st.owner >= 0 ? (st.owner === 0 ? 'rgba(59,130,246,0.16)' : 'rgba(239,68,68,0.16)') : 'rgba(226,232,240,0.07)';
      ctx.fill();
      ctx.setLineDash(st.contested ? [] : [4, 4]);
      ctx.strokeStyle = st.contested ? (blink ? '#facc15' : 'rgba(250,204,21,0.45)') : st.owner >= 0 ? TEAM[st.owner] : 'rgba(226,232,240,0.55)';
      ctx.lineWidth = st.contested ? 2.5 : 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      // 佔領進度環
      if (st.capturer >= 0 && st.progress > 0) {
        ctx.beginPath();
        ctx.arc(x, y, rad + 3, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * st.progress) / st.need);
        ctx.strokeStyle = TEAM[st.capturer];
        ctx.lineWidth = 5;
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
      const label = this.meta.mode === 'siege' ? `${i === 0 ? 'A' : 'B'} ${fl.name}・佔 ${st.need / TPS} 秒${st.open ? '' : st.owner === this.meta.defender ? '・要先佔 A' : ''}${st.contested ? '・爭奪中' : ''}` : `${fl.name}・每秒 ${fl.points} 分${st.contested ? '・爭奪中' : ''}`;
      ctx.font = `600 ${Math.round(11 * Math.min(1.4, k))}px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(label, x + 1, y + 20 * k + 1);
      ctx.fillStyle = st.contested ? '#fde047' : '#f1f5f9';
      ctx.fillText(label, x, y + 20 * k);
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
    const tops: number[] = [];
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
      const down = (sol[i + 3] & DOWN_BIT) !== 0 ? 1 : 0;
      // 層：牆頂（1）描邊加陰影；爬梯中（2）與穿過門洞的地面士兵半透明
      const layer = (sol[i + 3] >> LAYER_SHIFT) & 3;
      const ghost = layer === 2 || (layer === 0 && this.terrainAt(x, y) === T.Gatehouse) ? 1 : 0;
      if (layer === 1) tops.push(x, y);
      const key = `${owner}|${this.kindOf[regId]}|${r?.status === 'routed' ? 1 : 0}|${r?.concealed ? 1 : 0}|${down}|${ghost}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = [];
        groups.set(key, g);
      }
      g.push(x, y, r?.facing ?? 0);
      if ((sol[i + 3] & ATTACKED_BIT) !== 0) sparks.push(x, y, r?.facing ?? 0);
    }
    for (const [key, pts] of groups) {
      const [ownerS, kind, routedS, concS, downS, ghostS] = key.split('|');
      const owner = Number(ownerS);
      const routed = routedS === '1';
      const down = downS === '1';
      const color = routed ? ROUTED[owner] : down ? shade(TEAM[owner], 0.6) : TEAM[owner];
      ctx.globalAlpha = (concS === '1' ? 0.55 : 1) * (ghostS === '1' ? 0.5 : 1);
      if (down && !simple) {
        this.drawProne(pts, color, owner);
        continue;
      }
      if (simple) {
        ctx.fillStyle = color;
        const r = Math.max(1, s * 0.3);
        for (let i = 0; i < pts.length; i += 3) ctx.fillRect(this.sx(pts[i]) - r, this.sy(pts[i + 1]) - r, r * 2, r * 2);
        continue;
      }
      this.drawGlyphs(kind as UnitKind, pts, color, routed ? '#cbd5e1' : TEAM_LIGHT[owner], owner);
    }
    ctx.globalAlpha = 1;
    // 牆頂的士兵：白色描邊
    if (tops.length > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(1, s * 0.08);
      const rr = Math.max(1.5, s * 0.42);
      ctx.beginPath();
      for (let i = 0; i < tops.length; i += 2) {
        const px = this.sx(tops[i]);
        const py = this.sy(tops[i + 1]);
        ctx.moveTo(px + rr, py);
        ctx.arc(px, py, rr, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
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

  /**
   * 戰爭迷霧（一方視角）：整張地圖蓋一層暗色，自己每團的視野範圍（含高地加成）挖亮、邊緣柔和；
   * 看不到的敵軍本來就不畫。第一版不算地形擋視線。
   */
  private drawFog(viewer: number, alpha: number): void {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    let fc = this.fogCanvas;
    if (fc === null) {
      fc = document.createElement('canvas');
      this.fogCanvas = fc;
    }
    if (fc.width !== Math.round(cw * dpr) || fc.height !== Math.round(ch * dpr)) {
      fc.width = Math.round(cw * dpr);
      fc.height = Math.round(ch * dpr);
    }
    const g = fc.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, cw, ch);
    g.fillStyle = 'rgba(6,9,16,0.62)';
    g.fillRect(0, 0, cw, ch);
    g.globalCompositeOperation = 'destination-out';
    const s = this.cam.scale;
    for (const r of this.field) {
      if (this.ownerOf[r.id] !== viewer) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const sight = UNITS[this.kindOf[r.id]].sight + RULES.height.sightPerLevel * Math.max(0, this.heightAt(p.x, p.y) - 1);
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      const R = ((sight + r.rad) / TILE) * s;
      const grad = g.createRadialGradient(x, y, R * 0.82, x, y, R);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(fc, 0, 0, cw, ch);
  }

  /** 倒地的士兵：橫躺的橢圓（與朝向垂直）＋頭上暈眩的小點 */
  private drawProne(pts: number[], color: string, owner: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const body = new Path2D();
    const daze = new Path2D();
    const L = s * 0.36;
    const W = s * 0.14;
    const r = Math.max(0.8, s * 0.06);
    for (let i = 0; i < pts.length; i += 3) {
      const x = this.sx(pts[i]);
      const y = this.sy(pts[i + 1]);
      const a = ((pts[i + 2] + 90) * Math.PI) / 180;
      body.moveTo(x + Math.cos(a) * L, y + Math.sin(a) * L);
      body.ellipse(x, y, L, W, a, 0, Math.PI * 2);
      daze.moveTo(x - s * 0.2 + r, y - s * 0.35);
      daze.arc(x - s * 0.2, y - s * 0.35, r, 0, Math.PI * 2);
      daze.moveTo(x + s * 0.2 + r, y - s * 0.35);
      daze.arc(x + s * 0.2, y - s * 0.35, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = color;
    ctx.fill(body);
    ctx.strokeStyle = shade(TEAM[owner], 0.4);
    ctx.lineWidth = Math.max(0.6, s * 0.05);
    ctx.stroke(body);
    if (s >= 6) {
      ctx.fillStyle = '#fde68a';
      ctx.fill(daze);
    }
  }

  /** 衝刺走過的路線：粗的半透明線，衝刺結束後淡出（看得出騎兵轉彎的弧度） */
  private drawTrails(now: number, opt: DrawOptions): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    for (const [id, t] of this.trails) {
      const a = t.end === 0 ? 1 : 1 - (now - t.end) / TRAIL_FADE;
      if (a <= 0) {
        this.trails.delete(id);
        continue;
      }
      if (!this.shown(id, opt.viewer) || t.pts.length < 4) continue;
      ctx.beginPath();
      ctx.moveTo(this.sx(t.pts[0]), this.sy(t.pts[1]));
      for (let i = 2; i < t.pts.length; i += 2) ctx.lineTo(this.sx(t.pts[i]), this.sy(t.pts[i + 1]));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.28 * a;
      ctx.strokeStyle = DASH_COLOR[t.kind];
      ctx.lineWidth = Math.max(3, s * (t.kind === 'charge' ? 1.6 : 1.1));
      ctx.stroke();
      ctx.globalAlpha = 0.7 * a;
      ctx.strokeStyle = TEAM_LIGHT[t.owner];
      ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /** 招牌技能的地面標示：槍林扇形、盾兵擋箭範圍與盾牆、齊射落點圈、衝刺的預定路線 */
  private drawSkills(f: LegionFrame, alpha: number, opt: DrawOptions): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    for (const r of this.field) {
      if (r.status === 'routed' || !this.shown(r.id, opt.viewer)) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const owner = this.ownerOf[r.id];
      const kind = this.kindOf[r.id];
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      if (r.volley !== null) this.drawVolley(r, x, y, f.tick, owner);
      if (kind === 'spear' && (r.status === 'braced' || r.status === 'bracing' || r.status === 'unbracing')) this.drawBrace(r, x, y, owner);
      if (kind === 'shield') this.drawShield(r, x, y, p.facing, owner);
      if (r.dash !== null && r.dashing !== null) {
        // 衝刺的預定路線：沿目前方向剩下的距離（對準方向中是虛點）
        const a = (r.dash.dir * Math.PI) / 180;
        const len = (Math.max(r.dash.left, 1500) / TILE) * s;
        const ex = x + Math.cos(a) * len;
        const ey = y + Math.sin(a) * len;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ex, ey);
        ctx.setLineDash(r.dash.aligning ? [2, 5] : [8, 5]);
        ctx.strokeStyle = DASH_COLOR[r.dashing];
        ctx.globalAlpha = r.dash.aligning ? 0.6 : 0.85;
        ctx.lineWidth = Math.max(1.5, s * 0.18);
        ctx.stroke();
        ctx.setLineDash([]);
        const k = Math.max(5, s * 0.7);
        ctx.beginPath();
        ctx.moveTo(ex + Math.cos(a) * k, ey + Math.sin(a) * k);
        ctx.lineTo(ex + Math.cos(a + 2.5) * k, ey + Math.sin(a + 2.5) * k);
        ctx.lineTo(ex + Math.cos(a - 2.5) * k, ey + Math.sin(a - 2.5) * k);
        ctx.fillStyle = DASH_COLOR[r.dashing];
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /** 齊射：落點圈、剩餘時間的弧、弓兵到落點的虛線 */
  private drawVolley(r: RegFrame, x: number, y: number, tick: number, owner: number): void {
    const v = r.volley!;
    const ctx = this.ctx;
    const s = this.cam.scale;
    const vx = this.sx(v.x);
    const vy = this.sy(v.y);
    const R = (RULES.volley.radius / TILE) * s;
    ctx.beginPath();
    ctx.arc(vx, vy, R, 0, Math.PI * 2);
    ctx.fillStyle = owner === 0 ? 'rgba(59,130,246,0.13)' : 'rgba(239,68,68,0.13)';
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = TEAM_LIGHT[owner];
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    const left = Math.max(0, Math.min(1, (v.until - tick) / RULES.volley.duration));
    ctx.beginPath();
    ctx.arc(vx, vy, R + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(vx, vy);
    ctx.strokeStyle = 'rgba(251,191,36,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 槍林：朝槍林方向的扇形（正面 ±60°），邊上一排槍尖；圓陣是一整圈（效果打折） */
  private drawBrace(r: RegFrame, x: number, y: number, owner: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const ready = r.status === 'braced';
    const circle = r.formation === 'circle';
    const R = ((Math.hypot(r.halfW, r.halfD) + UNITS.spear.reach + 600) / TILE) * s;
    const a0 = (r.braceFacing * Math.PI) / 180;
    const half = circle ? Math.PI : (RULES.flank.frontHalf * Math.PI) / 180;
    ctx.beginPath();
    if (circle) ctx.arc(x, y, R, 0, Math.PI * 2);
    else {
      ctx.moveTo(x, y);
      ctx.arc(x, y, R, a0 - half, a0 + half);
      ctx.closePath();
    }
    ctx.fillStyle = owner === 0 ? `rgba(147,197,253,${ready ? 0.16 : 0.07})` : `rgba(252,165,165,${ready ? 0.16 : 0.07})`;
    ctx.fill();
    if (!ready) ctx.setLineDash([4, 4]);
    ctx.strokeStyle = ready ? 'rgba(226,232,240,0.75)' : 'rgba(226,232,240,0.4)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.setLineDash([]);
    if (!ready || s < 4) return;
    // 槍尖：沿弧線每 8° 一根往外的短線
    const step = (8 * Math.PI) / 180;
    ctx.beginPath();
    for (let a = a0 - half + step / 2; a < a0 + half; a += step) {
      ctx.moveTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
      ctx.lineTo(x + Math.cos(a) * (R + s * 0.55), y + Math.sin(a) * (R + s * 0.55));
    }
    ctx.strokeStyle = 'rgba(241,245,249,0.85)';
    ctx.lineWidth = Math.max(1, s * 0.08);
    ctx.stroke();
  }

  /** 盾兵：正後方的掩護區（持盾淡、舉盾與盾牆較明顯）；盾牆在正面畫一道牆 */
  private drawShield(r: RegFrame, x: number, y: number, facing: number, owner: number): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    {
      const strong = r.stance === 'raise' || r.status === 'walled';
      const a = (facing * Math.PI) / 180;
      const fx = Math.cos(a);
      const fy = Math.sin(a);
      const hw = (r.halfW / TILE) * s;
      const f0 = -(r.halfD / TILE) * s;
      const f1 = f0 - (RULES.shield.cover.depth / TILE) * s;
      const pt = (f: number, l: number): [number, number] => [x + fx * f - fy * l, y + fy * f + fx * l];
      ctx.beginPath();
      for (const [f, l] of [[f0, -hw], [f0, hw], [f1, hw], [f1, -hw]] as const) {
        const [px, py] = pt(f, l);
        if (f === f0 && l === -hw) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = owner === 0 ? `rgba(191,219,254,${strong ? 0.1 : 0.04})` : `rgba(254,202,202,${strong ? 0.1 : 0.04})`;
      ctx.fill();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = owner === 0 ? `rgba(191,219,254,${strong ? 0.55 : 0.25})` : `rgba(254,202,202,${strong ? 0.55 : 0.25})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (r.status !== 'walled' && r.status !== 'walling') return;
    const a = (facing * Math.PI) / 180;
    const d = (r.halfD / TILE) * s + s * 0.45;
    const hw = (r.halfW / TILE) * s + s * 0.3;
    const cx = x + Math.cos(a) * d;
    const cy = y + Math.sin(a) * d;
    ctx.beginPath();
    ctx.moveTo(cx - Math.sin(a) * hw, cy + Math.cos(a) * hw);
    ctx.lineTo(cx + Math.sin(a) * hw, cy - Math.cos(a) * hw);
    ctx.strokeStyle = r.status === 'walled' ? 'rgba(226,232,240,0.9)' : 'rgba(226,232,240,0.4)';
    ctx.lineWidth = Math.max(2, s * 0.32);
    ctx.lineCap = 'butt';
    if (r.status === 'walling') ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
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

  private drawSelection(id: number, alpha: number, full: boolean): void {
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
    if (full) {
      const u = UNITS[kind];
      if (u.range > 0) {
        ctx.beginPath();
        ctx.arc(x, y, (u.range / TILE) * s, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(250,204,21,0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, ((u.sight + RULES.height.sightPerLevel * Math.max(0, this.heightAt(p.x, p.y) - 1)) / TILE) * s, 0, Math.PI * 2);
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

  private heightAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.meta.width || ty >= this.meta.height) return 0;
    return this.meta.heights[ty * this.meta.width + tx];
  }

  private terrainAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.meta.width || ty >= this.meta.height) return T.River;
    return this.meta.terrain[ty * this.meta.width + tx];
  }

  private drawBanners(alpha: number, opt: DrawOptions): void {
    const ctx = this.ctx;
    const s = this.cam.scale;
    const k = Math.max(0.75, Math.min(1.25, s / 9));
    const font = getComputedStyle(document.body).fontFamily;
    const w = 46 * k;
    const h = 15 * k;
    // 先排好每個旗標的位置：與已放好的重疊就往上移，選中的軍團優先
    const order = [...this.field].sort((a, b) => (b.id === opt.selected ? 1 : 0) - (a.id === opt.selected ? 1 : 0) || b.y - a.y);
    // AI 意圖：放大到一定程度才顯示；滑鼠指著或選中的一律顯示；一方視角只看得到自己的
    const zoomed = opt.showIntent && s >= this.fitScale * 1.6;
    const intentOf = (r: RegFrame): string =>
      r.intent !== '' && r.status !== 'routed' && (opt.viewer < 0 || this.ownerOf[r.id] === opt.viewer) && (zoomed || opt.hovered === r.id || opt.selected === r.id) ? r.intent : '';
    const ih = 12 * k;
    const placed: [number, number, number][] = [];
    const spot = new Map<number, [number, number, number]>();
    for (const r of order) {
      if (!this.shown(r.id, opt.viewer)) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const bh = h + (intentOf(r) !== '' ? ih : 0);
      const bx = this.sx(p.x);
      const by0 = this.sy(p.y) - (r.rad / TILE) * s - 12 * k - (bh - h);
      let by = by0;
      for (let tries = 0; tries < 6; tries++) {
        if (!placed.some(([px, py, ph]) => Math.abs(px - bx) < w + 6 && by < py + ph + 3 && py < by + bh + 3)) break;
        by -= h + 4;
      }
      placed.push([bx, by, bh]);
      spot.set(r.id, [bx, by, by0]);
    }
    for (const r of this.field) {
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
      // 狀態標籤（招牌技能、衝刺、換陣形、潰散；上帝視角下的埋伏）
      const t = TAG[r.status];
      const tag = t !== undefined ? (r.status === 'reforming' ? `${t[0]}・${FORMATION_NAMES[r.formation]}` : t[0]) : r.concealed && opt.viewer < 0 ? '埋伏中' : '';
      if (tag !== '') {
        ctx.font = `700 ${Math.round(9 * k)}px ${font}`;
        const tw = ctx.measureText(tag).width + 6 * k;
        ctx.fillStyle = t !== undefined ? t[1] : '#a16207';
        ctx.beginPath();
        ctx.roundRect(x + w / 2 + 2, y - h / 2, tw, h, 3 * k);
        ctx.fill();
        if (r.status === 'reforming' && r.switchLeft > 0) {
          // 換陣形的進度
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fillRect(x + w / 2 + 2, y + h / 2 - 2 * k, tw * (1 - r.switchLeft / RULES.formationSwitchTicks), 2 * k);
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(tag, x + w / 2 + 2 + 3 * k, y + 0.5);
      }
      // AI 意圖
      const intent = intentOf(r);
      if (intent !== '') {
        ctx.font = `600 ${Math.round(9 * k)}px ${font}`;
        ctx.textAlign = 'center';
        const tw = ctx.measureText(intent).width + 8 * k;
        const iy = y + h / 2 + 5 * k + ih / 2;
        ctx.fillStyle = 'rgba(8,12,20,0.72)';
        ctx.beginPath();
        ctx.roundRect(x - tw / 2, iy - ih / 2 + 1, tw, ih - 1, 3 * k);
        ctx.fill();
        ctx.fillStyle = owner === 0 ? '#bfdbfe' : '#fecaca';
        ctx.fillText(intent, x, iy + 0.5);
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
        ctx.font = `800 ${Math.round((14 + Math.min(6, s * 0.4)) * (e.size ?? 1))}px ${font}`;
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
