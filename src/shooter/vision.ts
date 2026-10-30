// CS 射擊的視野與聲音（規格書第二節）：視錐、格子射線視線、射線撞牆距離、聲音方向量化與距離等級。
// 角度一律百分度（0.01°）；座標為座標單位（1 格 = UNIT）。
import { cdegDiff, iatan2C } from '../shared/geom.ts';
import { idiv, isqrt } from '../shared/intmath.ts';
import { SOUND, UNIT, VISION } from './config.ts';
import { cellOf, isLowCell, isSolidCell, type ShooterMap } from './map.ts';
import type { SoundRange } from './api.ts';

/** 擋視線的圓（煙霧；步驟 3 接上）。座標單位 */
export interface SightBlocker {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** 目標方向是否在視錐內（朝向 ± fov/2；fovDeg 為整數度） */
export function inCone(facingC: number, fovDeg: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (ax === bx && ay === by) return true;
  const d = cdegDiff(iatan2C(by - ay, bx - ax), facingC);
  return Math.abs(d) * 2 <= fovDeg * 100;
}

/**
 * 格子射線（Amanatides–Woo 的整數版）：從 a 走到 b，依序回呼經過的格子；回呼回傳 true 即停。
 * 剛好穿過格角時兩側的格子都會回呼（cornerA、cornerB），由呼叫端決定算不算擋。
 * onCell 的 tNum／tDen 是進入該格時沿線段的參數（0～1 的分數）。
 */
function traverse(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  onCell: (cx: number, cy: number, tNum: number, tDen: number) => boolean,
  onCorner: (sx: number, sy: number, tx: number, ty: number, tNum: number, tDen: number) => boolean,
): boolean {
  let cx = cellOf(ax);
  let cy = cellOf(ay);
  const ex = cellOf(bx);
  const ey = cellOf(by);
  const dx = bx - ax;
  const dy = by - ay;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  // 到下一條格線的距離（座標單位）
  let nx = sx > 0 ? (cx + 1) * UNIT - ax : sx < 0 ? ax - cx * UNIT : 0;
  let ny = sy > 0 ? (cy + 1) * UNIT - ay : sy < 0 ? ay - cy * UNIT : 0;
  let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 4;
  while ((cx !== ex || cy !== ey) && guard-- > 0) {
    // 比較 nx/adx 與 ny/ady（交叉相乘；分量為 0 視為無限大）
    const cmp = sx === 0 ? 1 : sy === 0 ? -1 : nx * ady - ny * adx;
    if (cmp < 0) {
      const t = nx;
      cx += sx;
      nx += UNIT;
      if (onCell(cx, cy, t, adx)) return true;
    } else if (cmp > 0) {
      const t = ny;
      cy += sy;
      ny += UNIT;
      if (onCell(cx, cy, t, ady)) return true;
    } else {
      // 穿過格角
      const t = nx;
      if (onCorner(cx + sx, cy, cx, cy + sy, t, adx)) return true;
      cx += sx;
      cy += sy;
      nx += UNIT;
      ny += UNIT;
      if (onCell(cx, cy, t, adx)) return true;
    }
  }
  return false;
}

/** 點到線段的距離平方是否小於 r²（煙霧遮擋） */
function segmentHitsCircle(ax: number, ay: number, bx: number, by: number, c: SightBlocker): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let px = ax;
  let py = ay;
  if (len2 > 0) {
    const dot = (c.x - ax) * dx + (c.y - ay) * dy;
    if (dot > 0) {
      if (dot >= len2) {
        px = bx;
        py = by;
      } else {
        px = ax + idiv(dx * dot, len2);
        py = ay + idiv(dy * dot, len2);
      }
    }
  }
  const ex = c.x - px;
  const ey = c.y - py;
  return ex * ex + ey * ey < c.radius * c.radius;
}

/**
 * 矮牆掩護（v0.5）：線段經過的矮牆格裡，有沒有一格離「蹲著的那一端」在 VISION.lowCoverRange 格以內。
 * aLow／bLow = 起點／終點的人蹲著。兩端都站著時矮牆不擋。距離沿線段量：對起點取進入該格的點，對終點保守多算一格
 */
export function lowCoverBlocks(map: ShooterMap, ax: number, ay: number, bx: number, by: number, aLow: boolean, bLow: boolean): boolean {
  if (!aLow && !bLow) return false;
  const len = isqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
  const range = VISION.lowCoverRange * UNIT;
  const near = (tNum: number, tDen: number): boolean => {
    const d = tDen === 0 ? 0 : idiv(tNum * len, tDen);
    return (aLow && d <= range) || (bLow && len - d - UNIT <= range);
  };
  return traverse(
    ax,
    ay,
    bx,
    by,
    (cx, cy, tNum, tDen) => isLowCell(map, cx, cy) && near(tNum, tDen),
    (sx, sy, tx, ty, tNum, tDen) => (isLowCell(map, sx, sy) || isLowCell(map, tx, ty)) && near(tNum, tDen),
  );
}

/**
 * 視線：兩點之間沒有牆（穿過格角時兩側都是牆才算擋），也沒有穿過煙霧；
 * 任一端蹲著時，貼近他的矮牆也擋（aLow／bLow，v0.5）。
 * 起點、終點所在的格子不檢查（角色本身不會在牆裡）。
 */
export function lineOfSight(map: ShooterMap, ax: number, ay: number, bx: number, by: number, smokes: readonly SightBlocker[] = [], aLow = false, bLow = false): boolean {
  if (lowCoverBlocks(map, ax, ay, bx, by, aLow, bLow)) return false;
  const blocked = traverse(
    ax,
    ay,
    bx,
    by,
    (cx, cy) => isSolidCell(map, cx, cy) && !(cx === cellOf(bx) && cy === cellOf(by)),
    (sx, sy, tx, ty) => isSolidCell(map, sx, sy) && isSolidCell(map, tx, ty),
  );
  if (blocked) return false;
  for (const s of smokes) if (segmentHitsCircle(ax, ay, bx, by, s)) return false;
  return true;
}

/**
 * 子彈射線：從 (x, y) 沿方向 (cx, cy)（×10000）走最多 maxLen，回傳撞到第一面牆的距離（沒撞到回傳 maxLen）。
 * 子彈不可穿過格角（任一側是牆就擋）。lowRange > 0（開槍的人蹲著）時，這個距離內的矮牆也擋（v0.5）
 */
export function rayWallDistance(map: ShooterMap, x: number, y: number, cx: number, cy: number, maxLen: number, lowRange = 0): number {
  const bx = x + idiv(cx * maxLen, 10000);
  const by = y + idiv(cy * maxLen, 10000);
  let hit = maxLen;
  traverse(
    x,
    y,
    bx,
    by,
    (gx, gy, tNum, tDen) => {
      const d = tDen === 0 ? 0 : idiv(tNum * maxLen, tDen);
      if (!isSolidCell(map, gx, gy) && !(lowRange > 0 && d <= lowRange && isLowCell(map, gx, gy))) return false;
      hit = d;
      return true;
    },
    (sx, sy, tx, ty, tNum, tDen) => {
      const d = tDen === 0 ? 0 : idiv(tNum * maxLen, tDen);
      const low = lowRange > 0 && d <= lowRange && (isLowCell(map, sx, sy) || isLowCell(map, tx, ty));
      if (!isSolidCell(map, sx, sy) && !isSolidCell(map, tx, ty) && !low) return false;
      hit = d;
      return true;
    },
  );
  return hit > maxLen ? maxLen : hit;
}

/** 聲音方向量化：取最接近的 directionStepDeg 倍數（整數度 0～359） */
export function quantizeDir(ax: number, ay: number, bx: number, by: number): number {
  const step = SOUND.directionStepDeg * 100;
  const c = iatan2C(by - ay, bx - ax);
  const q = idiv(c + idiv(step, 2), step) * step;
  return idiv(q % 36000, 100);
}

/** 距離等級：near < nearRange、mid < midRange、其餘 far（格） */
export function soundRange(distUnits: number): SoundRange {
  if (distUnits < SOUND.nearRange * UNIT) return 'near';
  if (distUnits < SOUND.midRange * UNIT) return 'mid';
  return 'far';
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return isqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}
