// 瞭望塔佔領（步驟 10）。決策 Q6A：他人一開始累積，原佔領者立即失去塔；其他人的部分進度也一律歸零。
import { RULES, TILE_SIZE } from '../config/index.ts';
import type { MatchState, Unit, Watchtower } from './state.ts';
import { emit, tileIndex } from './world.ts';

const captureR = RULES.watchtower.captureRadiusTiles * TILE_SIZE;
const buf: Unit[] = [];

/** 易主事件：送給目前看得到瞭望塔的選手，以及新舊佔領者 */
export function emitTowerChanged(state: MatchState, t: Watchtower, oldOwner: number): void {
  const tile = tileIndex(state, t.x, t.y);
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.vis[tile] > 0 || p.id === oldOwner || p.id === t.owner) {
      emit(state, p.id, { type: 'towerChanged', tick: state.tick, towerId: t.id, owner: t.owner >= 0 ? t.owner : null });
    }
  }
}

export function stepWatchtowers(state: MatchState): void {
  for (const t of state.towers) {
    let only = -1;
    let multiple = false;
    for (const u of state.spatial.query(t.x, t.y, captureR, buf)) {
      if (u.type === 'worker') continue;
      if (only === -1) only = u.owner;
      else if (u.owner !== only) {
        multiple = true;
        break;
      }
    }
    if (only >= 0 && !multiple) {
      for (const p of state.players) {
        if (p.id === only || t.progress[p.id] === 0) continue;
        t.progress[p.id] = 0;
        if (t.owner === p.id) {
          t.owner = -1;
          emitTowerChanged(state, t, p.id);
        }
      }
      if (t.progress[only] < RULES.watchtower.captureTarget) {
        t.progress[only] += 1;
        if (t.progress[only] >= RULES.watchtower.captureTarget && t.owner !== only) {
          const old = t.owner;
          t.owner = only;
          emitTowerChanged(state, t, old);
        }
      }
    }
    if (t.owner >= 0) state.players[t.owner].stats.towerHeldTicks += 1;
  }
}
