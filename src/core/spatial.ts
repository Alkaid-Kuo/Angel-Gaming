// 均勻格網空間索引：每桶 bucketTiles × bucketTiles 格，存放單位。
// 以計數排序重建（桶內依 id 排序），查詢不配置新陣列。
import { RULES, TILE_SIZE } from '../config/index.ts';
import { idiv } from '../shared/intmath.ts';
import type { Unit } from './state.ts';

export class SpatialIndex {
  private readonly bucketSize: number;
  private readonly bw: number;
  private readonly bh: number;
  /** 桶 c 的單位為 items[cellStart[c] .. cellStart[c + 1]) */
  private readonly cellStart: Int32Array;
  private readonly cellWrite: Int32Array;
  private items: Unit[] = [];
  private cellOfItem: Int32Array = new Int32Array(256);

  constructor(widthTiles: number, heightTiles: number) {
    this.bucketSize = RULES.spatial.bucketTiles * TILE_SIZE;
    this.bw = idiv(widthTiles + RULES.spatial.bucketTiles - 1, RULES.spatial.bucketTiles);
    this.bh = idiv(heightTiles + RULES.spatial.bucketTiles - 1, RULES.spatial.bucketTiles);
    this.cellStart = new Int32Array(this.bw * this.bh + 1);
    this.cellWrite = new Int32Array(this.bw * this.bh);
  }

  private cellX(x: number): number {
    const c = idiv(x, this.bucketSize);
    return c < 0 ? 0 : c >= this.bw ? this.bw - 1 : c;
  }

  private cellY(y: number): number {
    const c = idiv(y, this.bucketSize);
    return c < 0 ? 0 : c >= this.bh ? this.bh - 1 : c;
  }

  /** units 必須依 id 排序；桶內因此也依 id 排序 */
  rebuild(units: readonly Unit[]): void {
    const n = units.length;
    if (this.cellOfItem.length < n) this.cellOfItem = new Int32Array(n * 2);
    const start = this.cellStart;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const u = units[i];
      const c = this.cellY(u.y) * this.bw + this.cellX(u.x);
      this.cellOfItem[i] = c;
      start[c + 1] += 1;
    }
    const cells = this.bw * this.bh;
    for (let c = 0; c < cells; c++) {
      start[c + 1] += start[c];
      this.cellWrite[c] = start[c];
    }
    if (this.items.length !== n) this.items = new Array<Unit>(n);
    for (let i = 0; i < n; i++) this.items[this.cellWrite[this.cellOfItem[i]]++] = units[i];
  }

  /** 收集中心距離 (x, y) ≤ radius 的單位，結果依 id 排序 */
  query(x: number, y: number, radius: number, out: Unit[]): Unit[] {
    out.length = 0;
    const bx0 = this.cellX(x - radius);
    const by0 = this.cellY(y - radius);
    const bx1 = this.cellX(x + radius);
    const by1 = this.cellY(y + radius);
    const r2 = radius * radius;
    const items = this.items;
    const start = this.cellStart;
    let cellsWithHits = 0;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const c = by * this.bw + bx;
        const before = out.length;
        for (let k = start[c]; k < start[c + 1]; k++) {
          const u = items[k];
          const dx = u.x - x;
          const dy = u.y - y;
          if (dx * dx + dy * dy <= r2) out.push(u);
        }
        if (out.length > before) cellsWithHits += 1;
      }
    }
    if (cellsWithHits > 1) {
      // 插入排序（結果通常很少）
      for (let i = 1; i < out.length; i++) {
        const v = out[i];
        let j = i - 1;
        while (j >= 0 && out[j].id > v.id) {
          out[j + 1] = out[j];
          j--;
        }
        out[j + 1] = v;
      }
    }
    return out;
  }
}
