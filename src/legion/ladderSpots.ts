// 雲梯能架在哪：照引擎 ladder 指令的驗證（sim.ts 的 ladderCommand）抽出的純函式，給畫面的架梯瞄準用
// （能架的牆格亮綠、不能架的亮紅、游標吸附到最近能架的牆格）。引擎的判斷改了這裡要跟著改；
// test/legion-ladder-spots.test.ts 拿引擎實際下指令的結果對照。
import { LADDER_KINDS, RULES, T, TILE, walkable, type UnitKind } from './config.ts';
import type { LegionMap } from './map.ts';

/** 要架梯的團（引擎的 Regiment 或觀戰狀態流的 RegFrame 都湊得出來） */
export interface LadderReg {
  readonly id: number;
  readonly owner: number;
  readonly kind: UnitKind;
  /** 中心（單位） */
  readonly x: number;
  readonly y: number;
  /** 所在的層（0 地面、1 牆頂、2 爬梯中） */
  readonly layer: number;
  /** 正在架另一座雲梯 */
  readonly building: boolean;
  /** 正在推衝車 */
  readonly manning: boolean;
}

export interface LadderSpot {
  /** 牆格（格座標）與格索引 */
  readonly tx: number;
  readonly ty: number;
  readonly top: number;
  /** 梯腳格（-1 ＝ 牆下沒有可以站的地面）與梯腳格中心（單位） */
  readonly foot: number;
  readonly footX: number;
  readonly footY: number;
  /** 下指令用的座標：牆格中心（單位） */
  readonly x: number;
  readonly y: number;
  readonly ok: boolean;
  /** 不能架的原因（能架時是空字串）；同引擎拒絕指令的字樣 */
  readonly why: string;
  /** 由哪一團架（能架時是離梯腳最近的那團；不能架時 -1） */
  readonly reg: number;
}

/** 團本身能不能架梯（與牆格無關的檢查）；可以回傳 null */
export function ladderRegBlocked(map: LegionMap, r: LadderReg): string | null {
  if (!LADDER_KINDS.includes(r.kind)) return '只有劍士、盾兵、長槍、輕步兵能架雲梯';
  if (map.defender < 0 || r.owner === map.defender) return '只有攻方能架雲梯';
  if (r.layer !== 0) return '要在地面才能架雲梯';
  if (r.building) return '這一團正在架另一座雲梯';
  if (r.manning) return '推衝車中不能這樣做，先卸下（unman）';
  return null;
}

/** 梯腳：城牆格上下左右、地面可以站的格裡離團中心最近的一格（同引擎的順序，距離相同取先找到的）；回傳格索引與距離平方 */
export function ladderFoot(map: LegionMap, tx: number, ty: number, rx: number, ry: number): { foot: number; d2: number } {
  const { width: w, height: h, terrain } = map;
  let foot = -1;
  let best = Infinity;
  for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
    const fx = tx + dx;
    const fy = ty + dy;
    if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
    const t = terrain[fy * w + fx];
    if (t === T.Stair || t === T.Gatehouse || !walkable(t)) continue;
    const cx = fx * TILE + TILE / 2;
    const cy = fy * TILE + TILE / 2;
    const d = (cx - rx) * (cx - rx) + (cy - ry) * (cy - ry);
    if (d < best) {
      best = d;
      foot = fy * w + fx;
    }
  }
  return { foot, d2: best };
}

/**
 * 這些團附近（每團中心 radius 單位內）的城牆格與門樓格，各自能不能架梯：一格只要有一團能架就算能架（由離梯腳最近的那團架）。
 * taken：已經有雲梯的牆格中心（單位，引擎觀測的 LadderInfo x／y）。
 */
export function ladderSpots(map: LegionMap, regs: readonly LadderReg[], taken: readonly { readonly x: number; readonly y: number }[], radius = RULES.ladder.reach + 6 * TILE): LadderSpot[] {
  const { width: w, height: h, terrain } = map;
  const used = new Set<number>();
  for (const l of taken) used.add(Math.floor(l.y / TILE) * w + Math.floor(l.x / TILE));
  const seen = new Map<number, LadderSpot>();
  const seenD = new Map<number, number>();
  const reach2 = RULES.ladder.reach * RULES.ladder.reach;
  for (const r of regs) {
    const blocked = ladderRegBlocked(map, r);
    const R = Math.ceil(radius / TILE);
    const cx = Math.floor(r.x / TILE);
    const cy = Math.floor(r.y / TILE);
    for (let ty = Math.max(0, cy - R); ty <= Math.min(h - 1, cy + R); ty++) {
      for (let tx = Math.max(0, cx - R); tx <= Math.min(w - 1, cx + R); tx++) {
        const top = ty * w + tx;
        const t = terrain[top];
        if (t !== T.Wall && t !== T.Gatehouse) continue;
        const x = tx * TILE + TILE / 2;
        const y = ty * TILE + TILE / 2;
        if ((x - r.x) * (x - r.x) + (y - r.y) * (y - r.y) > radius * radius) continue;
        const { foot, d2 } = ladderFoot(map, tx, ty, r.x, r.y);
        // 判斷順序同引擎：團本身、城牆格、已有雲梯、梯腳、距離
        const why =
          blocked ?? (t !== T.Wall ? '只能架在城牆格' : used.has(top) ? '這格城牆已經有雲梯' : foot < 0 ? '城牆下沒有可以站的地面' : d2 > reach2 ? '離城牆太遠' : '');
        const fx = foot % w;
        const fy = (foot - fx) / w;
        const spot: LadderSpot = { tx, ty, top, foot, footX: foot < 0 ? -1 : fx * TILE + TILE / 2, footY: foot < 0 ? -1 : fy * TILE + TILE / 2, x, y, ok: why === '', why, reg: why === '' ? r.id : -1 };
        const prev = seen.get(top);
        // 有團能架就換成能架的；都能架時留離梯腳最近的那團
        if (prev === undefined || (!prev.ok && spot.ok) || (prev.ok && spot.ok && d2 < (seenD.get(top) ?? Infinity))) {
          seen.set(top, spot);
          seenD.set(top, d2);
        }
      }
    }
  }
  return [...seen.values()];
}

/** 吸附：離 (x, y)（單位）最近、能架的牆格；maxDist 單位以內都沒有就回傳 null */
export function snapLadder(spots: readonly LadderSpot[], x: number, y: number, maxDist = 4 * TILE): LadderSpot | null {
  let best: LadderSpot | null = null;
  let bd = maxDist * maxDist;
  for (const s of spots) {
    if (!s.ok) continue;
    const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
    if (d <= bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}
