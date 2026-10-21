// 轉播分析（只讀狀態）：交戰熱點與交戰強度，供自動導播、精華模式、跳到下一次交戰使用。
import { TILE_SIZE } from '../config/index.ts';
import type { MatchState } from '../core/state.ts';
import { buildingCenterX, buildingCenterY } from '../core/world.ts';

export interface Hotspot {
  /** 熱點中心（單位座標） */
  readonly x: number;
  readonly y: number;
  /** 本 tick 在此區域發生的攻擊次數 */
  readonly hits: number;
  /** 涉及的選手 */
  readonly players: readonly number[];
}

/** 熱點分群的格網大小（格） */
const CELL_TILES = 10;
/**
 * 交戰強度門檻（每 tick 攻擊次數的移動平均）：達到即算一次交戰。
 * 0.5 約為 6 隻長槍兵持續攻擊；速攻的第一波（5～8 隻）也要算進來。
 */
export const FIGHT_LEVEL = 0.5;
/** 低於此強度且持續一段時間才算平靜 */
export const QUIET_LEVEL = 0.3;

/**
 * 上一個 tick（state.tick - 1）發生的攻擊，依區域分群後由強到弱排序。
 */
export function combatHotspots(state: MatchState): Hotspot[] {
  const t = state.tick - 1;
  const cell = CELL_TILES * TILE_SIZE;
  const groups = new Map<number, { sx: number; sy: number; hits: number; players: Set<number> }>();
  const add = (ax: number, ay: number, owner: number, targetId: number): void => {
    const tu = state.unitById.get(targetId);
    const tb = tu === undefined ? state.buildingById.get(targetId) : undefined;
    const tx = tu?.x ?? (tb !== undefined ? buildingCenterX(tb) : ax);
    const ty = tu?.y ?? (tb !== undefined ? buildingCenterY(tb) : ay);
    const mx = (ax + tx) >> 1;
    const my = (ay + ty) >> 1;
    const key = Math.floor(my / cell) * 1000 + Math.floor(mx / cell);
    let g = groups.get(key);
    if (g === undefined) {
      g = { sx: 0, sy: 0, hits: 0, players: new Set() };
      groups.set(key, g);
    }
    g.sx += mx;
    g.sy += my;
    g.hits += 1;
    g.players.add(owner);
    const targetOwner = tu?.owner ?? tb?.owner;
    if (targetOwner !== undefined) g.players.add(targetOwner);
  };
  for (const u of state.units) if (u.lastHitTick === t) add(u.x, u.y, u.owner, u.lastHitTarget);
  for (const b of state.buildings) if (b.lastHitTick === t) add(buildingCenterX(b), buildingCenterY(b), b.owner, b.lastHitTarget);
  return [...groups.values()]
    .map((g) => ({ x: Math.round(g.sx / g.hits), y: Math.round(g.sy / g.hits), hits: g.hits, players: [...g.players].sort((a, b) => a - b) }))
    .sort((a, b) => b.hits - a.hits || a.x - b.x || a.y - b.y);
}

/** 交戰強度的指數移動平均（每 tick 更新） */
export class CombatMeter {
  level = 0;
  /** 最近的熱點（強度最高者在前） */
  hotspots: Hotspot[] = [];
  private quietTicks = 0;

  update(state: MatchState): void {
    const hs = combatHotspots(state);
    const hits = hs.reduce((a, h) => a + h.hits, 0);
    this.level = this.level * 0.9 + hits * 0.1;
    if (hs.length > 0) this.hotspots = hs.slice(0, 3);
    if (hits === 0) this.quietTicks += 1;
    else this.quietTicks = 0;
    if (this.quietTicks > 50) this.hotspots = [];
  }

  /** 平靜（精華模式可快轉） */
  get quiet(): boolean {
    return this.level < QUIET_LEVEL && this.quietTicks > 30;
  }

  /** 是否進入一場交戰（跳到下一次交戰的停止條件） */
  get fighting(): boolean {
    return this.level >= FIGHT_LEVEL;
  }

  reset(): void {
    this.level = 0;
    this.hotspots = [];
    this.quietTicks = 0;
  }
}
