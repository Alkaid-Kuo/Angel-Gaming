// 瞭望塔佔領（步驟 10）。決策 Q6A：他人一開始累積，原佔領者立即失去塔；其他人的部分進度也一律歸零。
import { CONQUEST, RULES, TILE_SIZE } from '../config/index.ts';
import type { MatchState, Unit, Watchtower } from './state.ts';
import { emit, tileIndex } from './world.ts';
import { WALK_BLOCKED } from '../path/index.ts';

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

// ───────── 搶點模式（原型）：控制點 ─────────

const pointR = CONQUEST.captureRadiusTiles * TILE_SIZE;

/** 離 (tx, ty) 最近的可通行格（控制點中心用；同距離依 y、x 決定） */
export function nearestWalkableTile(state: MatchState, tx: number, ty: number): { x: number; y: number } {
  for (let r = 0; r < Math.max(state.width, state.height); r++) {
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = ty - r; y <= ty + r; y++) {
      for (let x = tx - r; x <= tx + r; x++) {
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
        if (state.walk[y * state.width + x] === WALK_BLOCKED) continue;
        const d = (x - tx) ** 2 + (y - ty) ** 2;
        if (best === null || d < best.d) best = { x, y, d };
      }
    }
    if (best !== null) return { x: best.x, y: best.y };
  }
  throw new Error('地圖上沒有可通行格');
}

/**
 * 步驟 10（搶點模式）：控制點佔領與結算。
 * 圈內只有一方的戰鬥單位時：佔領者在場則補滿佔領值；他人在場則先把佔領值扣到 0（變中立），再累積自己的佔領進度。
 * 雙方都在場時暫停。每次結算時，主堡與控制點給收入，控制點給勝利點。
 */
export function stepControlPoints(state: MatchState): void {
  for (const t of state.towers) {
    let only = -1;
    let multiple = false;
    let count = 0;
    for (const u of state.spatial.query(t.x, t.y, pointR, buf)) {
      if (u.type === 'worker') continue;
      if (only === -1) only = u.owner;
      else if (u.owner !== only) {
        multiple = true;
        break;
      }
      count += 1;
    }
    if (only >= 0 && !multiple) {
      const rate = Math.min(count, CONQUEST.captureMaxRate);
      if (t.owner === only) {
        t.hold = Math.min(CONQUEST.captureTarget, t.hold + rate);
      } else if (t.owner >= 0) {
        t.hold -= rate;
        if (t.hold <= 0) {
          const old = t.owner;
          t.owner = -1;
          t.hold = 0;
          emitTowerChanged(state, t, old);
        }
      } else {
        if (t.capturer !== only) {
          if (t.capturer >= 0) t.progress[t.capturer] = 0;
          t.capturer = only;
        }
        t.progress[only] += rate;
        if (t.progress[only] >= CONQUEST.captureTarget) {
          t.progress[only] = 0;
          t.capturer = -1;
          t.owner = only;
          t.hold = CONQUEST.captureTarget;
          emitTowerChanged(state, t, -1);
        }
      }
    }
    if (t.owner >= 0) state.players[t.owner].stats.towerHeldTicks += 1;
  }
  // 壓制倒數：控制超過半數的控制點才累積，否則歸零
  if (CONQUEST.dominationTicks > 0) {
    for (const p of state.players) {
      let held = 0;
      for (const t of state.towers) if (t.owner === p.id) held += 1;
      p.domination = p.alive && held * 2 > state.towers.length ? p.domination + 1 : 0;
    }
  }
  if ((state.tick + 1) % CONQUEST.incomeInterval !== 0) return;
  let mult = 1;
  for (const [from, m] of CONQUEST.vpEscalation) if (state.tick >= from) mult = m;
  for (const p of state.players) {
    if (!p.alive) continue;
    let income = state.buildings.some((b) => b.owner === p.id && b.complete && b.type === 'base') ? CONQUEST.baseIncome : 0;
    for (const t of state.towers) {
      if (t.owner !== p.id) continue;
      income += t.income;
      p.vp += t.vp * mult;
    }
    p.minerals += income;
    p.stats.gathered += income;
  }
}
