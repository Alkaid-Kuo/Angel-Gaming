// 觀戰數據面板（只讀狀態）：各選手的經濟、兵力、兵種、科技、採集點與資產分數。
import { BUILDING_STATS, COMBAT_UNIT_TYPES, TICKS_PER_SECOND, UNIT_STATS, type UnitType } from '../config/index.ts';
import type { MatchState } from '../core/state.ts';
import { assetScore } from '../core/world.ts';

/** 收入取樣間隔與計算區間（tick） */
const SAMPLE_TICKS = 10;
const INCOME_WINDOW_TICKS = 60 * TICKS_PER_SECOND;

export interface ScoreRow {
  readonly id: number;
  readonly alive: boolean;
  readonly workers: number;
  /** 目前持有的礦 */
  readonly minerals: number;
  /** 最近一分鐘的採集量（每分鐘礦） */
  readonly incomePerMin: number;
  readonly gathered: number;
  /** 存活戰鬥單位的成本總和 */
  readonly army: number;
  /** 戰鬥單位數量（依兵種） */
  readonly comp: Readonly<Partial<Record<UnitType, number>>>;
  readonly supplyUsed: number;
  readonly supplyCap: number;
  readonly techLevel: number;
  readonly weapons: number;
  readonly armor: number;
  /** 已完工的主堡與採集站（卸礦點）數 */
  readonly dropoffs: number;
  readonly towers: number;
  /** 時限判定用的資產分數：存活單位成本 ＋ 已完工建築成本 */
  readonly assets: number;
  readonly holdsWatchtower: boolean;
  /** 搶點模式：勝利點、控制點數、連續控制過半的 tick 數 */
  readonly vp: number;
  readonly pointsHeld: number;
  readonly domination: number;
}

export class ScoreTracker {
  /** 每位選手的（tick, 累計採集量）取樣 */
  private samples: { tick: number; gathered: number }[][] = [];

  reset(): void {
    this.samples = [];
  }

  /** 每 tick 呼叫（內部每 SAMPLE_TICKS 取樣一次） */
  update(s: MatchState): void {
    if (s.tick % SAMPLE_TICKS !== 0) return;
    while (this.samples.length < s.players.length) this.samples.push([]);
    for (const p of s.players) {
      const list = this.samples[p.id];
      list.push({ tick: s.tick, gathered: p.stats.gathered });
      while (list.length > 0 && list[0].tick < s.tick - INCOME_WINDOW_TICKS) list.shift();
    }
  }

  rows(s: MatchState): ScoreRow[] {
    return s.players.map((p) => {
      const comp: Partial<Record<UnitType, number>> = {};
      let workers = 0;
      let army = 0;
      for (const u of s.units) {
        if (u.owner !== p.id) continue;
        if (u.type === 'worker') workers += 1;
        else if ((COMBAT_UNIT_TYPES as readonly string[]).includes(u.type)) {
          comp[u.type] = (comp[u.type] ?? 0) + 1;
          army += UNIT_STATS[u.type].cost;
        }
      }
      let dropoffs = 0;
      let towers = 0;
      let techLevel = 1;
      for (const b of s.buildings) {
        if (b.owner !== p.id || !b.complete) continue;
        if (BUILDING_STATS[b.type].isDropoff) dropoffs += 1;
        if (b.type === 'tower') towers += 1;
        if (b.type === 'base') techLevel = Math.max(techLevel, b.level);
      }
      const list = this.samples[p.id] ?? [];
      const first = list[0];
      const incomePerMin = first === undefined || s.tick <= first.tick ? 0 : Math.round(((p.stats.gathered - first.gathered) * INCOME_WINDOW_TICKS) / (s.tick - first.tick));
      return {
        id: p.id,
        alive: p.alive,
        workers,
        minerals: p.minerals,
        incomePerMin,
        gathered: p.stats.gathered,
        army,
        comp,
        supplyUsed: p.supplyUsed,
        supplyCap: p.supplyCap,
        techLevel,
        weapons: p.research.weapons,
        armor: p.research.armor,
        dropoffs,
        towers,
        assets: p.alive ? assetScore(s, p.id) : p.eliminationScore,
        holdsWatchtower: s.towers.some((t) => t.owner === p.id),
        vp: p.vp,
        pointsHeld: s.towers.filter((t) => t.owner === p.id).length,
        domination: p.domination,
      };
    });
  }
}
