// 觀戰全狀態的彈道：全圖與自由鏡頭要畫所有人的子彈。
// 引擎的子彈紀錄是 private（觀察資料只給各選手看得到的部分），src/shooter 不動，這裡唯讀取用；觀戰本來就看全狀態，不影響公平，也不改比賽狀態。
// 紀錄欄位若改名，test/shooter-ux.test.ts 會失敗，不會默默變成沒有彈道。
import type { ShooterMatch } from '../../shooter/sim.ts';
import type { FullShot } from './protocol.ts';

interface ShotLogRow {
  readonly tick: number;
  readonly sx: number;
  readonly sy: number;
  readonly ex: number;
  readonly ey: number;
}

/** tick 大於 after 的子彈（每顆一筆） */
export function recentShots(m: ShooterMatch, after: number): FullShot[] {
  const log = Reflect.get(m, 'shotLog') as readonly ShotLogRow[];
  return log.filter((s) => s.tick > after).map((s) => ({ tick: s.tick, x0: s.sx, y0: s.sy, x1: s.ex, y1: s.ey }));
}
