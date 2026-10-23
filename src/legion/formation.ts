// 陣形：依陣形、人數、橫寬算出每個序號的隊形位置（相對軍團中心，fwd 沿朝向、lat 向右）。
// 序號 0 永遠在最前面（補位時後排往前補）。人數減少時自動調整：
// 橫陣保住寬度（最少 2 排後才變窄）、方陣保住厚度（先變窄）、圓陣縮小成完整的圓、楔形陣等比例縮小（尖端永遠有人）。
import { idiv, isqrt, tdiv } from '../shared/intmath.ts';
import type { FormationKind } from './config.ts';
import { icos, isin } from './geom.ts';

export interface FormationShape {
  /** [fwd, lat] × 人數（單位） */
  readonly offsets: Int32Array;
  readonly halfW: number;
  readonly halfD: number;
  readonly rad: number;
  /** 排數（厚度）；圓陣為圈數 */
  readonly ranks: number;
  /** 正面最寬一排的人數 */
  readonly files: number;
}

/**
 * @param width 橫陣、方陣：橫寬（人）
 * @param depth 方陣：要保住的排數
 */
export function formationShape(kind: FormationKind, n: number, width: number, depth: number, sx: number, sy: number): FormationShape {
  if (n <= 0) return { offsets: new Int32Array(0), halfW: 0, halfD: 0, rad: 0, ranks: 0, files: 0 };
  switch (kind) {
    case 'line': {
      // 保住寬度，最少 2 排
      let files = Math.max(1, Math.min(width, n));
      if (n >= 2 && Math.ceil(n / files) < 2) files = Math.ceil(n / 2);
      return grid(n, files, sx, sy);
    }
    case 'square': {
      // 保住厚度：排數固定，人少了就變窄
      const ranks = Math.max(1, Math.min(depth, n));
      const files = Math.max(1, Math.ceil(n / ranks));
      return grid(n, files, sx, sy);
    }
    case 'wedge':
      return wedge(n, sx, sy);
    case 'circle':
      return circle(n, sx, sy);
  }
}

/** 橫排格狀（橫陣、方陣、縱隊）；最後一排置中 */
export function grid(n: number, filesIn: number, sx: number, sy: number): FormationShape {
  const files = Math.max(1, Math.min(filesIn, n));
  const ranks = Math.ceil(n / files);
  const out = new Int32Array(n * 2);
  for (let ord = 0; ord < n; ord++) {
    const rank = Math.floor(ord / files);
    const f = ord - rank * files;
    const inRank = rank === ranks - 1 ? n - rank * files : files;
    out[ord * 2] = idiv((ranks - 1 - 2 * rank) * sy, 2);
    out[ord * 2 + 1] = idiv((2 * f - (inRank - 1)) * sx, 2);
  }
  const halfW = idiv(files * sx, 2);
  const halfD = idiv(ranks * sy, 2);
  return { offsets: out, halfW, halfD, rad: isqrt(halfW * halfW + halfD * halfD), ranks, files };
}

/** 楔形陣：第 r 排 2r + 1 人，尖端在前 */
function wedge(n: number, sx: number, sy: number): FormationShape {
  const rows: number[] = [];
  let left = n;
  for (let r = 0; left > 0; r++) {
    const c = Math.min(left, 2 * r + 1);
    rows.push(c);
    left -= c;
  }
  const ranks = rows.length;
  const out = new Int32Array(n * 2);
  let ord = 0;
  let widest = 1;
  rows.forEach((c, r) => {
    widest = Math.max(widest, c);
    for (let i = 0; i < c; i++) {
      out[ord * 2] = idiv((ranks - 1 - 2 * r) * sy, 2);
      out[ord * 2 + 1] = idiv((2 * i - (c - 1)) * sx, 2);
      ord += 1;
    }
  });
  const halfW = idiv(widest * sx, 2);
  const halfD = idiv(ranks * sy, 2);
  return { offsets: out, halfW, halfD, rad: isqrt(halfW * halfW + halfD * halfD), ranks, files: widest };
}

/** 圓陣：1～3 圈，外圈先排（序號 0 在正前方）；人少了縮小半徑，維持完整的圓 */
function circle(n: number, sx: number, sy: number): FormationShape {
  const rings = n <= 16 ? 1 : n <= 48 ? 2 : 3;
  // Σ 半徑 × 2π ≈ n × 間距  →  外圈半徑
  const sumR = idiv(n * sx * 1000, 6283);
  const outer = Math.max(sx, idiv(sumR + idiv(sy * rings * (rings - 1), 2), rings));
  const radii: number[] = [];
  for (let j = 0; j < rings; j++) radii.push(Math.max(idiv(sx, 2), outer - j * sy));
  const total = radii.reduce((s, r) => s + r, 0);
  const counts = radii.map((r) => Math.max(1, idiv(n * r, total)));
  let assigned = counts.reduce((s, c) => s + c, 0);
  for (let j = 0; assigned !== n; j = (j + 1) % rings) {
    if (assigned < n) {
      counts[j] += 1;
      assigned += 1;
    } else if (counts[j] > 1) {
      counts[j] -= 1;
      assigned -= 1;
    }
  }
  const out = new Int32Array(n * 2);
  let ord = 0;
  for (let j = 0; j < rings; j++) {
    const c = counts[j];
    for (let i = 0; i < c; i++) {
      // 交錯：內圈轉半格
      const deg = idiv(360 * i * 2 + (j % 2 === 1 ? 360 : 0), 2 * c);
      out[ord * 2] = tdiv(radii[j] * icos(deg), 10000);
      out[ord * 2 + 1] = tdiv(radii[j] * isin(deg), 10000);
      ord += 1;
    }
  }
  const half = outer + idiv(sx, 2);
  return { offsets: out, halfW: half, halfD: half, rad: half, ranks: rings, files: counts[0] };
}
