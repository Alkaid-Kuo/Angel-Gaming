// 步驟 11：視野更新、敵方建築記憶、礦點已知儲量；以及偵察統計。
import { BUILDING_STATS, RULES, TILE_SIZE, UNIT_STATS } from '../config/index.ts';
import { applyPercent, idiv } from '../shared/intmath.ts';
import type { Building, MatchState } from './state.ts';
import { applyVision } from './vision.ts';
import { buildingVisibleTo, tileIndex, toTile } from './world.ts';

function buildingVisionAnchor(state: MatchState, b: Building): number {
  const half = b.size >> 1;
  // 奇數尺寸：中心格；偶數尺寸：以格角為圓心（錨點格為中心右下那格，配合 corner 模板）
  return (b.tileY + half) * state.width + (b.tileX + half);
}

export function updateVision(state: MatchState): void {
  for (const u of state.units) {
    const anchor = tileIndex(state, u.x, u.y);
    const radius = UNIT_STATS[u.type].sight;
    if (anchor === u.visTile && radius === u.visRadius) continue;
    const p = state.players[u.owner];
    if (u.visTile >= 0) applyVision(state, p, u.visTile, u.visRadius, false, -1);
    applyVision(state, p, anchor, radius, false, 1);
    u.visTile = anchor;
    u.visRadius = radius;
  }
  for (const b of state.buildings) {
    const st = BUILDING_STATS[b.type];
    const radius = b.complete ? st.sight : applyPercent(st.sight, RULES.vision.constructingSightPercent);
    const anchor = buildingVisionAnchor(state, b);
    if (anchor === b.visTile && radius === b.visRadius) continue;
    const p = state.players[b.owner];
    if (b.visTile >= 0) applyVision(state, p, b.visTile, b.visRadius, b.visCorner, -1);
    applyVision(state, p, anchor, radius, b.visCorner, 1);
    b.visTile = anchor;
    b.visRadius = radius;
  }
  for (const t of state.towers) {
    if (t.owner === t.visOwner) continue;
    const anchor = toTile(t.y) * state.width + toTile(t.x);
    if (t.visOwner >= 0 && state.players[t.visOwner].alive) {
      applyVision(state, state.players[t.visOwner], anchor, RULES.watchtower.sightTiles, true, -1);
    }
    if (t.owner >= 0) applyVision(state, state.players[t.owner], anchor, RULES.watchtower.sightTiles, true, 1);
    t.visOwner = t.owner;
  }
}

/** 敵方建築記憶與礦點已知儲量 */
export function updateKnowledge(state: MatchState): void {
  for (const p of state.players) {
    if (!p.alive) continue;
    for (const b of state.buildings) {
      if (b.owner === p.id) continue;
      const visible = buildingVisibleTo(state, p, b);
      let m = p.memory.get(b.id);
      if (visible) {
        const progressPercent = b.complete ? 100 : idiv(b.progress * 100, BUILDING_STATS[b.type].buildTicks);
        if (m === undefined) {
          m = { id: b.id, owner: b.owner, type: b.type, tileX: b.tileX, tileY: b.tileY, size: b.size, hp: b.hp, complete: b.complete, progressPercent, lastSeenTick: state.tick, visibleNow: true };
          p.memory.set(b.id, m);
        } else {
          m.hp = b.hp;
          m.complete = b.complete;
          m.progressPercent = progressPercent;
          m.lastSeenTick = state.tick;
          m.visibleNow = true;
        }
      } else if (m !== undefined) {
        m.visibleNow = false;
      }
    }
    for (const m of p.memory.values()) {
      if (state.buildingById.has(m.id)) continue;
      m.visibleNow = false;
      // 已被摧毀：看到該處時才忘記
      let seen = false;
      for (let y = m.tileY; y < m.tileY + m.size && !seen; y++) {
        for (let x = m.tileX; x < m.tileX + m.size; x++) {
          if (p.vis[y * state.width + x] > 0) {
            seen = true;
            break;
          }
        }
      }
      if (seen) p.memory.delete(m.id);
    }
    for (const n of state.nodes) {
      if (p.vis[n.tileY * state.width + n.tileX] > 0) p.nodeKnown[n.index] = n.reserve;
    }
  }
}

/** 偵察統計：單位每次進入敵方起點 15 格內記一次 */
export function updateScouting(state: MatchState): void {
  const r = RULES.stats.scoutRadiusTiles * TILE_SIZE;
  const r2 = r * r;
  for (const u of state.units) {
    for (const q of state.players) {
      if (q.id === u.owner || !q.alive) continue;
      const bit = 1 << q.id;
      const dx = u.x - q.startX;
      const dy = u.y - q.startY;
      const inside = dx * dx + dy * dy <= r2;
      if (inside && (u.scoutMask & bit) === 0) {
        u.scoutMask |= bit;
        state.players[u.owner].stats.scoutCount += 1;
      } else if (!inside && (u.scoutMask & bit) !== 0) {
        u.scoutMask &= ~bit;
      }
    }
  }
}
