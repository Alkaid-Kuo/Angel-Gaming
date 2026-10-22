// 軍團戰的整數幾何：角度（整數度，0 = +x、90 = +y，畫面上是往下）、方向向量（×10000）、整數 atan2。
import { idiv, isqrt, tdiv } from '../shared/intmath.ts';
import { icos, isin } from '../shared/trig.ts';

export { icos, isin };

/** tan(d) × 10000，d = 0～45（由三角函數表以整數除法推得，與平台無關） */
const TAN: number[] = [];
for (let d = 0; d <= 45; d++) TAN.push(idiv(isin(d) * 10000, icos(d)));

function nearestTan(r: number): number {
  let lo = 0;
  let hi = 45;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (TAN[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && r - TAN[lo - 1] <= TAN[lo] - r) return lo - 1;
  return lo;
}

/** 整數 atan2：向量 (dx, dy) 的方位角（0～359）；零向量回傳 0 */
export function iatan2(dy: number, dx: number): number {
  if (dx === 0 && dy === 0) return 0;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const a = ax >= ay ? nearestTan(idiv(ay * 10000, ax)) : 90 - nearestTan(idiv(ax * 10000, ay));
  let deg: number;
  if (dx >= 0) deg = dy >= 0 ? a : 360 - a;
  else deg = dy >= 0 ? 180 - a : 180 + a;
  return deg % 360;
}

export function normDeg(d: number): number {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/** a − b，範圍 −179～180 */
export function angleDiff(a: number, b: number): number {
  let d = normDeg(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** 從 cur 往 target 轉，每次最多 step 度 */
export function turnToward(cur: number, target: number, step: number): number {
  const d = angleDiff(target, cur);
  if (d > step) return normDeg(cur + step);
  if (d < -step) return normDeg(cur - step);
  return normDeg(target);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return isqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}

/** 從 (x, y) 朝 (tx, ty) 前進最多 step；回傳新座標（不超過目標） */
export function stepToward(x: number, y: number, tx: number, ty: number, step: number): [number, number] {
  const dx = tx - x;
  const dy = ty - y;
  const d2 = dx * dx + dy * dy;
  if (d2 <= step * step) return [tx, ty];
  const d = isqrt(d2);
  return [x + tdiv(dx * step, d), y + tdiv(dy * step, d)];
}

/** 以角度 deg 前進 len */
export function offset(deg: number, len: number): [number, number] {
  return [tdiv(icos(deg) * len, 10000), tdiv(isin(deg) * len, 10000)];
}
