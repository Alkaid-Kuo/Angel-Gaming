// 整數運算輔助。所有狀態都以 JS number 存整數，範圍遠小於 2^53，因此加減乘皆精確；
// 除法與開根號一律經過這裡，保證結果為整數且與平台無關。

export function assertInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${what} 必須是安全整數，收到 ${n}`);
  }
}

/** 向下取整除法（floor）。b 不可為 0。 */
export function idiv(a: number, b: number): number {
  if (b === 0) throw new Error('idiv: 除以 0');
  let q = Math.floor(a / b);
  // 修正浮點捨入誤差，確保 q 為真正的 floor(a / b)
  if (b > 0) {
    if (q * b > a) q -= 1;
    else if ((q + 1) * b <= a) q += 1;
  } else {
    if (q * b < a) q -= 1;
    else if ((q + 1) * b >= a) q += 1;
  }
  return q;
}

/** 向零取整除法（trunc）。用於方向向量分量，保持正負對稱。 */
export function tdiv(a: number, b: number): number {
  if (b === 0) throw new Error('tdiv: 除以 0');
  const negative = (a < 0) !== (b < 0);
  const q = idiv(Math.abs(a), Math.abs(b));
  return negative ? -q : q;
}

/** 整數平方根（向下取整）。n 必須 ≥ 0。 */
export function isqrt(n: number): number {
  if (n < 0) throw new Error(`isqrt: 負數 ${n}`);
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

/** 以整數百分比套用倍率並向下取整：floor(value × percent ÷ 100) */
export function applyPercent(value: number, percent: number): number {
  return idiv(value * percent, 100);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** 點到軸對齊矩形 [x0, x1] × [y0, y1] 的距離平方（點在矩形內為 0） */
export function pointRectDistSq(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  return dx * dx + dy * dy;
}

/**
 * 四捨六入五成雙：剛好 .5 時取偶數。對奇函數對稱（round(-v) = -round(v)），
 * 地圖寬高是偶數時 round(W - v) = W - round(v)，雙方鏡像的座標捨入後仍然鏡像。
 */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
