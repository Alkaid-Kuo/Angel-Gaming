// 中式屋頂：簷口平緩、近屋脊陡的凹曲面，四角起翹；硬山（人字）、廡殿（四坡）、歇山（下四坡、上人字加山花）。
// 做法：從簷口往屋脊一圈圈縮小的矩形（環），相鄰兩環接成面；屋面貼瓦壟貼圖（u 沿瓦壟橫向、v 順著坡）。
import * as THREE from 'three';
import type { Builder, V3 } from './builder.ts';

export type RoofStyle = 'gable' | 'hip' | 'xieshan';

export interface RoofSpec {
  /** 屋頂中心（俯視） */
  readonly cx: number;
  readonly cz: number;
  /** 沿屋脊的長度、進深（都含出簷） */
  readonly len: number;
  readonly depth: number;
  /** 屋脊沿 x（否則沿 z） */
  readonly alongX: boolean;
  /** 簷口高、屋脊比簷口高多少 */
  readonly y0: number;
  readonly rise: number;
  readonly style: RoofStyle;
  readonly color: THREE.Color;
  /** 四角起翹 */
  readonly lift?: number;
  /** 山花（人字牆）與屋脊的顏色 */
  readonly gableColor?: THREE.Color;
  readonly ridgeColor?: THREE.Color;
  /** 只做到這一環就停（重簷的下簷：上面接著樓身）；0～1 */
  readonly upTo?: number;
}

const RINGS = 6;

/** 簷口 0 → 屋脊 1 的高度曲線（凹） */
function prof(e: number): number {
  return 0.3 * e + 0.7 * e * e;
}

export function roof(b: Builder, s: RoofSpec): void {
  const { cx, cz, len, depth, alongX, y0, rise, style, color } = s;
  const lift = s.lift ?? 0.12;
  const hl = len / 2;
  const hd = depth / 2;
  const upTo = s.upTo ?? 1;
  // 區域座標 (a 沿屋脊, c 橫向) → 世界
  const P = (a: number, y: number, c: number): V3 => (alongX ? [cx + a, y, cz + c] : [cx + c, y, cz + a]);
  const U = 2.4;
  // 歇山：下半截是四坡、上半截是人字（兩端內縮 hd/2）
  const split = style === 'xieshan' ? 0.45 : style === 'hip' ? 1 : 0;
  const ringAt = (e: number): { ha: number; hc: number; y: number; l: number } => {
    const hc = hd * (1 - e);
    const ha = style === 'gable' ? hl : style === 'hip' ? Math.max(hl - hd * e, 0) : Math.max(hl - hd * Math.min(e, split), 0);
    const l = lift * Math.pow(1 - e, 3);
    return { ha, hc, y: y0 + rise * prof(e), l };
  };
  const steps = Math.max(1, Math.round(RINGS * upTo));
  for (let k = 0; k < steps; k++) {
    const e0 = (k / RINGS) * 1;
    const e1 = Math.min(upTo, (k + 1) / RINGS);
    const r0 = ringAt(e0);
    const r1 = ringAt(e1);
    const v0 = e0 * hd * 1.2;
    const v1 = e1 * hd * 1.2;
    // 兩條長邊（±c）
    for (const sc of [-1, 1]) {
      const a0 = P(-r0.ha, r0.y + r0.l, sc * r0.hc);
      const b0 = P(r0.ha, r0.y + r0.l, sc * r0.hc);
      const b1 = P(r1.ha, r1.y + r1.l, sc * r1.hc);
      const a1 = P(-r1.ha, r1.y + r1.l, sc * r1.hc);
      const out: V3 = alongX ? [0, 0.6, sc] : [sc, 0.6, 0];
      b.quad(a0, b0, b1, a1, color, out, [
        [-r0.ha * U, v0 * U],
        [r0.ha * U, v0 * U],
        [r1.ha * U, v1 * U],
        [-r1.ha * U, v1 * U],
      ]);
    }
    // 兩端（±a）：四坡的那一截才有斜面
    if (style !== 'gable' && e0 < split) {
      const r1e = ringAt(Math.min(e1, split));
      for (const sa of [-1, 1]) {
        const a0 = P(sa * r0.ha, r0.y + r0.l, -r0.hc);
        const b0 = P(sa * r0.ha, r0.y + r0.l, r0.hc);
        const b1 = P(sa * r1e.ha, r1e.y + r1e.l, r1e.hc);
        const a1 = P(sa * r1e.ha, r1e.y + r1e.l, -r1e.hc);
        const out: V3 = alongX ? [sa, 0.6, 0] : [0, 0.6, sa];
        b.quad(a0, b0, b1, a1, color, out, [
          [-r0.hc * U, v0 * U],
          [r0.hc * U, v0 * U],
          [r1e.hc * U, v1 * U],
          [-r1e.hc * U, v1 * U],
        ]);
      }
    }
  }
  // 簷下（從低角度看得到）
  const r0 = ringAt(0);
  const under = (s.gableColor ?? color).clone().multiplyScalar(0.55);
  b.quad(P(-r0.ha, y0, -r0.hc), P(r0.ha, y0, -r0.hc), P(r0.ha, y0, r0.hc), P(-r0.ha, y0, r0.hc), under, [0, -1, 0]);
  if (upTo < 1) return;
  // 人字的山花：硬山在兩端、歇山在內縮處
  if (style === 'gable' || style === 'xieshan') {
    const eBase = style === 'gable' ? 0 : split;
    const base = ringAt(eBase);
    const gc = s.gableColor ?? color;
    for (const sa of [-1, 1]) {
      const pts: V3[] = [];
      for (let k = 0; k <= 4; k++) {
        const e = eBase + ((1 - eBase) * k) / 4;
        const r = ringAt(e);
        pts.push(P(sa * base.ha, r.y + r.l, -r.hc));
      }
      for (let k = 4; k >= 0; k--) {
        const e = eBase + ((1 - eBase) * k) / 4;
        const r = ringAt(e);
        pts.push(P(sa * base.ha, r.y + r.l, r.hc));
      }
      const bottom = base.y + base.l;
      const out: V3 = alongX ? [sa, 0, 0] : [0, 0, sa];
      for (let k = 0; k + 1 < pts.length; k++) b.tri(P(sa * base.ha, bottom, 0), pts[k], pts[k + 1], gc, out);
    }
  }
  // 屋脊：一條略粗的脊，兩端翹起（鴟尾）
  const top = ringAt(1);
  const rc = s.ridgeColor ?? color.clone().multiplyScalar(0.7);
  const ry = top.y;
  const ra = Math.max(top.ha, 0.15);
  const t = Math.min(0.09, depth * 0.03);
  const a0 = -ra - 0.05;
  const a1 = ra + 0.05;
  const box = (aa0: number, aa1: number, yy0: number, yy1: number, cc0: number, cc1: number): void => {
    const [x0, , z0] = P(aa0, 0, cc0);
    const [x1, , z1] = P(aa1, 0, cc1);
    b.box(Math.min(x0, x1), yy0, Math.min(z0, z1), Math.max(x0, x1), yy1, Math.max(z0, z1), rc);
  };
  box(a0, a1, ry - t, ry + t * 1.6, -t, t);
  for (const sa of [-1, 1]) {
    const e = sa < 0 ? a0 : a1;
    box(Math.min(e, e - sa * 0.14), Math.max(e, e - sa * 0.14), ry, ry + t * 4.2, -t * 0.9, t * 0.9);
  }
}

/** 瓦壟貼圖：一條條筒瓦（白底，顏色由頂點色決定） */
export function roofTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f4';
  g.fillRect(0, 0, 64, 64);
  for (let x = 0; x < 64; x += 8) {
    const grad = g.createLinearGradient(x, 0, x + 8, 0);
    grad.addColorStop(0, '#b4b4b4');
    grad.addColorStop(0.35, '#ffffff');
    grad.addColorStop(0.6, '#ececec');
    grad.addColorStop(1, '#a8a8a8');
    g.fillStyle = grad;
    g.fillRect(x, 0, 8, 64);
  }
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < 64; y += 16) g.fillRect(0, y, 64, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 城磚貼圖：錯縫的大塊城磚（白底，顏色由頂點色決定） */
export function brickTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#cfcac0';
  g.fillRect(0, 0, 128, 128);
  const rowH = 16;
  for (let r = 0; r < 128 / rowH; r++) {
    const off = (r % 2) * 16;
    for (let x = -32; x < 128; x += 32) {
      const v = 225 + ((r * 7 + x * 3) % 5) * 6;
      g.fillStyle = `rgb(${v},${v - 3},${v - 8})`;
      g.fillRect(x + off + 1, r * rowH + 1, 30, rowH - 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // 一張貼圖 ＝ 2 × 2 單位
  t.repeat.set(0.5, 0.5);
  return t;
}
