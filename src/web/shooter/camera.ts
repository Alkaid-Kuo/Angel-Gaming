// 觀戰鏡頭狀態機（純邏輯，不碰 DOM，測試可以直接跑）：follow 跟隨、free 自由、overview 全圖。
// follow：cam += (目標 − cam) × k，k 由經過時間換算（幀率不同手感相同），切換跟隨對象走同一條平滑，不瞬移；貼著地圖邊時鏡頭停在邊界，不露出一大片空白。
// overview：由地圖尺寸一次算出固定的中心與縮放，到位後直接抄那個值，之後每幀完全不變。
// free：拖曳與滾輪改，中心夾在地圖外一圈內。
// 滾輪以游標為中心；跟隨時游標下的點先固定住，之後慢慢回正到跟隨對象。
const UNIT = 1000;

/** 跟隨阻尼的時間常數（毫秒，越大越慢；1 倍速）：可調 */
export const FOLLOW_TAU_MS = 130;
/** 回跟隨、進全圖的過渡 */
const SETTLE_TAU_MS = 150;
/** 滾輪縮放的過渡 */
const ZOOM_TAU_MS = 70;
/** 跟隨時滾輪造成的偏移回正 */
const OFFSET_TAU_MS = 650;
/** 自由鏡頭可以超出地圖多少格 */
export const BOUND_CELLS = 6;
/** 最大縮放（px／格） */
export const MAX_PPC = 72;
/** 拖曳門檻（px）：小於這個算點擊 */
export const DRAG_PX = 4;
/** 模型底座半徑（格，soldier.ts）；遠看時至少 PICK_PX 才點得到 */
const BASE_CELLS = 0.68;
const PICK_PX = 14;
/** 鏡頭移動到位的門檻（px）與縮放到位的門檻（log）：差這麼一點已經看不出來，直接到位 */
const NEAR_PX = 0.25;
const NEAR_LOG = 1e-3;

export type CamMode = 'follow' | 'free' | 'overview';

export interface CamView {
  readonly cx: number;
  readonly cy: number;
  /** px／座標單位 */
  readonly scale: number;
}

/** 鏡頭的環境：畫面大小（CSS px）、全圖要留給面板的邊、地圖大小（格） */
export interface CamEnv {
  readonly w: number;
  readonly h: number;
  readonly padX: number;
  readonly padY: number;
  readonly mapW: number;
  readonly mapH: number;
}

/** 經過 dt 毫秒往目標走的比例（指數平滑） */
export const approach = (dtMs: number, tauMs: number): number => 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
/** 速度倍率越高人跑越快，阻尼跟著收緊，人才不會跑出畫面 */
export const followTau = (speed: number): number => FOLLOW_TAU_MS / Math.sqrt(Math.max(1, speed));

/** 全圖鏡頭：地圖塞進扣掉面板的區域，中心永遠是地圖中心 */
export function overviewCam(e: CamEnv): CamView {
  const scale = Math.min(Math.max(1, e.w - 2 * e.padX) / e.mapW, Math.max(1, e.h - 2 * e.padY) / e.mapH) / UNIT;
  return { cx: (e.mapW * UNIT) / 2, cy: (e.mapH * UNIT) / 2, scale };
}

/** 中心夾在邊界內：viewSize 是畫面看得到的世界長度；比地圖＋邊界還大時置中 */
export function clampCenter(c: number, viewSize: number, mapSize: number, margin: number): number {
  const lo = viewSize / 2 - margin;
  const hi = mapSize - viewSize / 2 + margin;
  return lo > hi ? mapSize / 2 : Math.max(lo, Math.min(hi, c));
}

/** 世界座標點到的人：底座半徑內最近的活人；沒有回傳 null */
export function pickPlayer(players: readonly { readonly id: number; readonly x: number; readonly y: number; readonly alive: boolean }[], wx: number, wy: number, scale: number, minPx = PICK_PX): number | null {
  const r = Math.max(BASE_CELLS * UNIT, minPx / scale);
  let best: number | null = null;
  let bestD = r;
  for (const p of players) {
    if (!p.alive) continue;
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d <= bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

export class SpectateCamera {
  mode: CamMode = 'follow';
  cx = 0;
  cy = 0;
  scale = 0.02;
  private env: CamEnv;
  /** 跟隨縮放倍率（1 = 短邊的一半 24 格，同玩家模式的算法） */
  private zoom: number;
  private freeScale = 0.02;
  /** 平滑後的跟隨位置（不含滾輪偏移）與滾輪偏移 */
  private fx = 0;
  private fy = 0;
  private ox = 0;
  private oy = 0;
  /** 縮放時固定在游標下的世界點 */
  private anchor: { readonly sx: number; readonly sy: number; readonly wx: number; readonly wy: number } | null = null;
  /** 自由鏡頭的目的地（點小地圖空地） */
  private glide: { readonly x: number; readonly y: number } | null = null;
  private ready = false;

  constructor(env: CamEnv, zoom: number) {
    this.env = env;
    this.zoom = zoom;
  }

  setEnv(env: CamEnv): void {
    this.env = env;
  }

  private get base(): number {
    return Math.min(this.env.w, this.env.h) / 2 / 24 / UNIT;
  }

  private clampScale(s: number): number {
    return Math.max(overviewCam(this.env).scale, Math.min(MAX_PPC / UNIT, s));
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.env.w / 2) / this.scale + this.cx, (sy - this.env.h / 2) / this.scale + this.cy];
  }

  /** 回到跟隨：從目前畫面平滑移過去 */
  follow(): void {
    this.fx = this.cx;
    this.fy = this.cy;
    this.ox = 0;
    this.oy = 0;
    this.anchor = null;
    this.glide = null;
    this.mode = 'follow';
  }

  overview(): void {
    this.anchor = null;
    this.glide = null;
    this.mode = 'overview';
  }

  free(): void {
    if (this.mode === 'free') return;
    this.freeScale = this.scale;
    this.anchor = null;
    this.glide = null;
    this.mode = 'free';
  }

  /** 拖曳：畫面位移（px） */
  pan(dx: number, dy: number): void {
    this.free();
    this.glide = null;
    this.cx -= dx / this.scale;
    this.cy -= dy / this.scale;
    this.bound();
  }

  /** 自由鏡頭平移到世界座標 */
  jumpTo(x: number, y: number): void {
    this.free();
    this.glide = { x, y };
  }

  /** 以畫面座標 (sx, sy) 為中心縮放 */
  zoomAt(factor: number, sx: number, sy: number): void {
    if (this.mode === 'overview') this.free();
    const [wx, wy] = this.toWorld(sx, sy);
    this.anchor = { sx, sy, wx, wy };
    if (this.mode === 'follow') this.zoom = this.clampScale(this.base * this.zoom * factor) / this.base;
    else this.freeScale = this.clampScale(this.freeScale * factor);
  }

  private bound(): void {
    const e = this.env;
    const m = BOUND_CELLS * UNIT;
    this.cx = clampCenter(this.cx, e.w / this.scale, e.mapW * UNIT, m);
    this.cy = clampCenter(this.cy, e.h / this.scale, e.mapH * UNIT, m);
  }

  private stepScale(dt: number, goal: number): void {
    if (this.scale === goal) return;
    const next = Math.exp(Math.log(this.scale) + Math.log(goal / this.scale) * approach(dt, this.anchor !== null ? ZOOM_TAU_MS : SETTLE_TAU_MS));
    this.scale = Math.abs(Math.log(next / goal)) < NEAR_LOG ? goal : next;
  }

  /** 縮放時把游標下的世界點留在游標下；回傳鏡頭中心該在哪 */
  private anchored(goal: number): [number, number] | null {
    const a = this.anchor;
    if (a === null) return null;
    if (this.scale === goal) this.anchor = null;
    return [a.wx - (a.sx - this.env.w / 2) / this.scale, a.wy - (a.sy - this.env.h / 2) / this.scale];
  }

  /** 每幀推進；target 是跟隨對象的位置（座標單位），speed 是播放速度 */
  update(dtMs: number, target: { readonly x: number; readonly y: number } | null, speed: number): CamView {
    if (!this.ready) {
      this.ready = true;
      const start = this.mode === 'overview' ? overviewCam(this.env) : { cx: target?.x ?? 0, cy: target?.y ?? 0, scale: this.base * this.zoom };
      this.cx = start.cx;
      this.cy = start.cy;
      this.scale = start.scale;
      this.fx = start.cx;
      this.fy = start.cy;
      if (this.mode !== 'overview') this.bound();
      return this.view;
    }
    if (this.mode === 'overview') this.stepOverview(dtMs);
    else if (this.mode === 'follow') this.stepFollow(dtMs, target, speed);
    else this.stepFree(dtMs);
    return this.view;
  }

  private stepOverview(dt: number): void {
    const g = overviewCam(this.env);
    const k = approach(dt, SETTLE_TAU_MS);
    this.cx += (g.cx - this.cx) * k;
    this.cy += (g.cy - this.cy) * k;
    this.stepScale(dt, g.scale);
    // 到位後直接等於固定值：之後每幀的鏡頭一模一樣
    if (this.scale === g.scale && Math.hypot(this.cx - g.cx, this.cy - g.cy) * g.scale < NEAR_PX) {
      this.cx = g.cx;
      this.cy = g.cy;
    }
  }

  private stepFollow(dt: number, target: { readonly x: number; readonly y: number } | null, speed: number): void {
    if (target !== null) {
      const k = approach(dt, followTau(speed));
      this.fx += (target.x - this.fx) * k;
      this.fy += (target.y - this.fy) * k;
    }
    const goal = this.base * this.zoom;
    this.stepScale(dt, goal);
    const at = this.anchored(goal);
    if (at !== null) {
      this.ox = at[0] - this.fx;
      this.oy = at[1] - this.fy;
    } else {
      const decay = Math.exp(-dt / OFFSET_TAU_MS);
      this.ox *= decay;
      this.oy *= decay;
    }
    this.cx = this.fx + this.ox;
    this.cy = this.fy + this.oy;
    this.bound();
  }

  private stepFree(dt: number): void {
    this.stepScale(dt, this.freeScale);
    const at = this.anchored(this.freeScale);
    if (at !== null) {
      this.cx = at[0];
      this.cy = at[1];
    } else if (this.glide !== null) {
      const k = approach(dt, SETTLE_TAU_MS);
      this.cx += (this.glide.x - this.cx) * k;
      this.cy += (this.glide.y - this.cy) * k;
      if (Math.hypot(this.glide.x - this.cx, this.glide.y - this.cy) * this.scale < NEAR_PX) this.glide = null;
    }
    this.bound();
  }

  get view(): CamView {
    return { cx: this.cx, cy: this.cy, scale: this.scale };
  }
}
