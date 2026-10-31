// 攻防戰的特效，全部畫在畫面座標（CSS px）：彈道、槍口、煙、火、爆炸、手雷、炸彈標記、受傷暗角。
// 畫面內容的隨機一律固定雜湊（煙以位置為種子、火以格為種子）；Math.random 不用，動畫只吃時間。
import { PAL, hash2, rng } from './materials.ts';

const ZH = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
const EN = '"Barlow Condensed", "Noto Sans TC", sans-serif';

/** 亮地面上純亮線看不見：底下壓一道暗影，再畫暖色漸層亮線；head、tail 是彈頭與彈尾在全程的比例 */
export function paintTracer(g: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, head: number, tail: number, width: number, alpha: number): void {
  const hx = ax + (bx - ax) * head;
  const hy = ay + (by - ay) * head;
  const tx = ax + (bx - ax) * tail;
  const ty = ay + (by - ay) * tail;
  if (Math.hypot(hx - tx, hy - ty) < 1) return;
  g.lineCap = 'round';
  g.globalAlpha = alpha;
  const under = g.createLinearGradient(tx, ty, hx, hy);
  under.addColorStop(0, 'rgba(70, 40, 40, 0)');
  under.addColorStop(1, 'rgba(60, 30, 30, 0.72)');
  g.strokeStyle = under;
  g.lineWidth = width * 2;
  g.beginPath();
  g.moveTo(tx, ty);
  g.lineTo(hx, hy);
  g.stroke();
  const core = g.createLinearGradient(tx, ty, hx, hy);
  core.addColorStop(0, 'rgba(255, 130, 40, 0)');
  core.addColorStop(0.45, 'rgba(255, 150, 50, 0.95)');
  core.addColorStop(0.8, '#ffd27a');
  core.addColorStop(1, '#fffbe9');
  g.strokeStyle = core;
  g.lineWidth = width;
  g.stroke();
  g.globalAlpha = 1;
}

/** 槍口：星形火光＋地面光暈 */
export function paintMuzzle(g: CanvasRenderingContext2D, x: number, y: number, a: number, s: number): void {
  const glow = g.createRadialGradient(x, y, 0, x, y, s * 3.2);
  glow.addColorStop(0, 'rgba(255, 225, 150, 0.75)');
  glow.addColorStop(1, 'rgba(255, 190, 90, 0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(x, y, s * 3.2, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const b = (i * Math.PI) / 5;
    const r = i === 0 ? s * 2 : i % 2 === 0 ? s * 0.95 : s * 0.36;
    if (i === 0) g.moveTo(Math.cos(b) * r, Math.sin(b) * r);
    else g.lineTo(Math.cos(b) * r, Math.sin(b) * r);
  }
  g.closePath();
  g.fillStyle = '#ffd27a';
  g.fill();
  g.scale(0.55, 0.55);
  g.fillStyle = '#fffbe9';
  g.fill();
  g.restore();
}

// ───────── 煙 ─────────

/** 煙的貼圖：基準半徑 SMOKE_R 格，24 px／格；一團不透明的體積，上面堆亮面朝西北的團塊 */
const SMOKE_R = 3;
const SMOKE_PPC = 24;
const smokeCache = new Map<number, HTMLCanvasElement>();

function smokeSprite(seed: number): HTMLCanvasElement {
  const hit = smokeCache.get(seed);
  if (hit !== undefined) return hit;
  const half = Math.ceil((SMOKE_R + 1.6) * SMOKE_PPC);
  const c = document.createElement('canvas');
  c.width = half * 2;
  c.height = half * 2;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(SMOKE_PPC, 0, 0, SMOKE_PPC, half, half);
  g.fillStyle = '#d7d5da';
  g.beginPath();
  g.arc(0, 0, SMOKE_R * 0.96, 0, Math.PI * 2);
  g.fill();
  const rand = rng(seed);
  const puffs: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 64; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * SMOKE_R * 0.9;
    puffs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.62 + rand() * 0.72 });
  }
  puffs.sort((p, q) => p.y + p.x - (q.y + q.x));
  for (const p of puffs) {
    const pg = g.createRadialGradient(p.x - p.r * 0.34, p.y - p.r * 0.42, p.r * 0.05, p.x, p.y, p.r);
    pg.addColorStop(0, '#fbfaf8');
    pg.addColorStop(0.55, '#ecebed');
    pg.addColorStop(0.92, '#c6c4cf');
    pg.addColorStop(1, 'rgba(190, 187, 200, 0)');
    g.fillStyle = pg;
    g.beginPath();
    g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    g.fill();
  }
  if (smokeCache.size >= 8) smokeCache.delete(smokeCache.keys().next().value as number);
  smokeCache.set(seed, c);
  return c;
}

/** 煙：地面落影（朝東南）＋團塊貼圖；id 用落點，同一顆煙長相固定。半徑擴散時整張等比放大 */
export function paintSmoke(g: CanvasRenderingContext2D, sx: number, sy: number, r: number, id: number, now: number): void {
  const sh = g.createRadialGradient(sx + r * 0.27, sy + r * 0.33, r * 0.5, sx + r * 0.27, sy + r * 0.33, r * 1.35);
  sh.addColorStop(0, 'rgba(70, 58, 82, 0.5)');
  sh.addColorStop(1, 'rgba(70, 58, 82, 0)');
  g.fillStyle = sh;
  g.beginPath();
  g.arc(sx + r * 0.27, sy + r * 0.33, r * 1.35, 0, Math.PI * 2);
  g.fill();
  const c = smokeSprite(id);
  const s = (r / (SMOKE_R * SMOKE_PPC)) * (1 + Math.sin(now / 900 + id) * 0.012);
  const w = c.width * s;
  g.drawImage(c, sx - w / 2, sy - w / 2, w, w);
}

// ───────── 火 ─────────

/** 一格的火：焦痕交給外面畫，這裡是一條跳動的火舌（下圓上尖，紅底、橘身、亮芯）；彼此交疊成一片，中心高、邊緣低 */
export function paintFlame(g: CanvasRenderingContext2D, cx: number, cy: number, size: number, cell: number, k: number, now: number): void {
  const hx = hash2(cell, 1, 31) - 0.5;
  const hy = hash2(cell, 1, 37) - 0.5;
  const phase = hash2(cell, 1, 41) * 6.28;
  const f = 0.82 + 0.18 * Math.sin(now / 83 + phase);
  const x = cx + hx * size * 0.6;
  const y = cy + hy * size * 0.6;
  const r = size * (0.46 + 0.42 * k) * f;
  // 火舌頂端隨時間往左右擺
  const sway = Math.sin(now / 131 + phase) * r * 0.32;
  const tongue = (rr: number, dy: number, color: string): void => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x + sway * (rr / r), y + dy - rr * 1.75);
    g.bezierCurveTo(x + rr * 0.3, y + dy - rr * 0.8, x + rr, y + dy - rr * 0.35, x + rr, y + dy + rr * 0.1);
    g.arc(x, y + dy + rr * 0.1, rr, 0, Math.PI);
    g.bezierCurveTo(x - rr, y + dy - rr * 0.35, x - rr * 0.3, y + dy - rr * 0.8, x + sway * (rr / r), y + dy - rr * 1.75);
    g.fill();
  };
  tongue(r, 0, 'rgba(229, 72, 77, 0.62)');
  tongue(r * 0.68, r * 0.2, 'rgba(255, 150, 50, 0.9)');
  tongue(r * 0.34, r * 0.36, 'rgba(255, 235, 170, 0.95)');
}

// ───────── 手雷、爆炸 ─────────

/** 飛行中或落地的道具：彈體顏色分種類，高爆雷加紅色脈衝環 */
export function paintProjectile(g: CanvasRenderingContext2D, x: number, y: number, kind: string, ppc: number, now: number): void {
  const s = Math.max(4, ppc * 0.28);
  if (kind === 'he') {
    const p = (now % 700) / 700;
    for (const [k, al] of [
      [0, 0.95],
      [0.34, 0.55],
      [0.67, 0.28],
    ] as const) {
      const t = (p + k) % 1;
      g.strokeStyle = `rgba(229, 72, 77, ${al * (1 - t)})`;
      g.lineWidth = Math.max(1.5, ppc * 0.075);
      g.beginPath();
      g.arc(x, y, s + t * ppc * 1.1, 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.fillStyle = 'rgba(58, 38, 62, 0.5)';
  g.beginPath();
  g.arc(x + s * 0.35, y + s * 0.45, s, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = kind === 'he' ? '#34402f' : kind === 'smoke' ? '#7e8590' : kind === 'flash' ? '#eef2f6' : '#7a5233';
  g.beginPath();
  g.arc(x, y, s, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#c8ccc4';
  g.fillRect(x - s * 0.28, y - s * 1.42, s * 0.56, s * 0.64);
  g.fillStyle = 'rgba(255, 255, 255, 0.55)';
  g.beginPath();
  g.arc(x - s * 0.32, y - s * 0.32, s * 0.28, 0, Math.PI * 2);
  g.fill();
}

export const BLAST_MS = 650;

/** 爆炸：先是一團白熱閃光，再來是往外擴的揚塵環與碎屑；k＝0～1 是經過的比例 */
export function paintBlast(g: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number, k: number, kind: 'he' | 'flash' | 'bomb'): void {
  const ease = 1 - (1 - k) * (1 - k);
  if (kind !== 'flash') {
    // 揚塵環
    const rr = r * (0.3 + 0.8 * ease);
    const dust = g.createRadialGradient(x, y, rr * 0.55, x, y, rr);
    dust.addColorStop(0, 'rgba(232, 218, 195, 0)');
    dust.addColorStop(0.7, `rgba(214, 196, 168, ${0.55 * (1 - k)})`);
    dust.addColorStop(1, 'rgba(214, 196, 168, 0)');
    g.fillStyle = dust;
    g.beginPath();
    g.arc(x, y, rr, 0, Math.PI * 2);
    g.fill();
    const rand = rng(seed);
    g.fillStyle = `rgba(92, 70, 58, ${0.8 * (1 - k)})`;
    for (let i = 0; i < 18; i++) {
      const a = rand() * Math.PI * 2;
      const d = (0.3 + rand() * 0.8) * r * ease;
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.5 + rand() * 2.5, 0, Math.PI * 2);
      g.fill();
    }
  }
  const flashK = Math.max(0, 1 - k * 2.6);
  if (flashK > 0) {
    const fr = r * (kind === 'flash' ? 1.25 : 1.05) * (0.75 + 0.6 * k);
    const fl = g.createRadialGradient(x, y, 0, x, y, fr);
    fl.addColorStop(0, `rgba(255, 252, 235, ${flashK})`);
    fl.addColorStop(0.5, kind === 'flash' ? `rgba(255, 252, 235, ${0.85 * flashK})` : `rgba(255, 196, 96, ${0.95 * flashK})`);
    fl.addColorStop(1, 'rgba(255, 150, 60, 0)');
    g.fillStyle = fl;
    g.beginPath();
    g.arc(x, y, fr, 0, Math.PI * 2);
    g.fill();
  }
}

/** 爆炸留在地上的焦痕（回合結束才清） */
export function paintScorch(g: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number): void {
  const rand = rng(seed);
  g.fillStyle = 'rgba(46, 34, 34, 0.14)';
  for (let i = 0; i < 7; i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * r * 0.3;
    g.beginPath();
    g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.3 + rand() * 0.34), 0, Math.PI * 2);
    g.fill();
  }
}

// ───────── 炸彈 ─────────

/** 炸彈本體 */
function paintBombBody(g: CanvasRenderingContext2D, x: number, y: number, s: number, lit: boolean): void {
  g.fillStyle = 'rgba(58, 38, 62, 0.5)';
  g.fillRect(x - s + s * 0.25, y - s * 0.7 + s * 0.32, s * 2, s * 1.4);
  g.fillStyle = '#25222a';
  g.fillRect(x - s, y - s * 0.7, s * 2, s * 1.4);
  g.fillStyle = '#46424e';
  g.fillRect(x - s * 0.84, y - s * 0.54, s * 1.68, s * 0.5);
  g.fillStyle = lit ? PAL.warn : '#7a2c2c';
  g.fillRect(x + s * 0.2, y + s * 0.1, s * 0.56, s * 0.36);
}

/** 炸彈標記：地上的炸彈；已下包加脈衝環、倒數環與秒數（left／total 是剩餘比例，null＝不顯示） */
export function paintBombMark(g: CanvasRenderingContext2D, x: number, y: number, ppc: number, now: number, armed: boolean, frac: number | null, text: string | null, defused: boolean): void {
  const s = Math.max(6, ppc * 0.42);
  const R = Math.max(18, ppc * 1.2);
  if (armed) {
    const pulse = (now % 1000) / 1000;
    g.strokeStyle = `rgba(229, 72, 77, ${0.85 * (1 - pulse)})`;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, R * (0.8 + pulse * 1.1), 0, Math.PI * 2);
    g.stroke();
  }
  if (frac !== null) {
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(29, 26, 34, 0.55)';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(x, y, R, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = PAL.warn;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    g.stroke();
  }
  paintBombBody(g, x, y, s, armed && now % 500 < 250);
  if (defused) {
    g.strokeStyle = '#eef2f6';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x - s * 0.9, y - s * 0.6);
    g.lineTo(x + s * 0.9, y + s * 0.6);
    g.stroke();
  }
  if (text !== null) {
    g.font = `800 italic 18px ${EN}`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.lineJoin = 'round';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(29, 26, 34, 0.85)';
    g.strokeText(text, x, y - R - 6);
    g.fillStyle = '#ffffff';
    g.fillText(text, x, y - R - 6);
  }
}

/** 拆彈器：地上一個小工具箱 */
export function paintKit(g: CanvasRenderingContext2D, x: number, y: number, ppc: number): void {
  const s = Math.max(5, ppc * 0.3);
  g.fillStyle = 'rgba(58, 38, 62, 0.45)';
  g.fillRect(x - s + 2, y - s * 0.7 + 3, s * 2, s * 1.4);
  g.fillStyle = '#3a4252';
  g.fillRect(x - s, y - s * 0.7, s * 2, s * 1.4);
  g.fillStyle = '#eef2f6';
  g.fillRect(x - s * 0.5, y - s * 0.12, s, s * 0.24);
  g.fillRect(x - s * 0.12, y - s * 0.5, s * 0.24, s);
}

// ───────── 全螢幕 ─────────

/** 世界四周的暗角：貼著沙盤邊緣收一點，重心留在中間 */
export function paintVignette(g: CanvasRenderingContext2D, w: number, h: number): void {
  const v = g.createRadialGradient(w / 2, h / 2, h * 0.62, w / 2, h / 2, w * 0.64);
  v.addColorStop(0, 'rgba(50, 34, 44, 0)');
  v.addColorStop(1, 'rgba(50, 34, 44, 0.34)');
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
}

/** 受傷暗角：畫面四周泛紅；k＝強度 0～1 */
export function paintHurtVignette(g: CanvasRenderingContext2D, w: number, h: number, k: number): void {
  const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.hypot(w, h) * 0.56);
  v.addColorStop(0, 'rgba(229, 72, 77, 0)');
  v.addColorStop(1, `rgba(150, 24, 30, ${0.62 * k})`);
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
}

/** 準心旁的小標籤：墨黑底、左緣金、白字 */
export function paintChip(g: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  g.font = `700 13px ${ZH}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(text).width + 16;
  g.fillStyle = 'rgba(11, 14, 20, 0.86)';
  g.fillRect(x - w / 2, y, w, 20);
  g.fillStyle = PAL.gold;
  g.fillRect(x - w / 2, y, 3, 20);
  g.fillStyle = '#eef2f6';
  g.fillText(text, x + 1, y + 10.5);
}
