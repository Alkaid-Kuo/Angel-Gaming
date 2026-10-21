import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { BUILDING_STATS, MAP_MODES, RULES, TERRAIN, UNIT_STATS, type MatchMode } from '../src/config/index.ts';
import type { MatchState } from '../src/core/state.ts';
import { getStencil } from '../src/core/vision.ts';
import { tileIndex } from '../src/core/world.ts';
import { WALK_BLOCKED } from '../src/path/index.ts';
import { BatchController, resolveKnobs } from '../src/sandbox/controller.ts';
import { loadBotFile } from '../src/sandbox/node-loader.ts';
import { MatchDriver } from '../src/sandbox/runner.ts';

const BASELINE = loadBotFile(resolve('bots/baseline.js'));
const RANDOM = loadBotFile(resolve('bots/random.js'));

/** 檢查引擎內部狀態的一致性；回傳違反項目 */
function violations(s: MatchState): string[] {
  const out: string[] = [];
  const w = s.width;
  for (const p of s.players) {
    if (!p.alive) continue;
    if (p.minerals < 0) out.push(`P${p.id} 礦量為負`);
    let supply = 0;
    for (const u of s.units) if (u.owner === p.id) supply += UNIT_STATS[u.type].supply;
    let cap = 0;
    for (const b of s.buildings) {
      if (b.owner !== p.id) continue;
      for (const q of b.queue) supply += UNIT_STATS[q.unit].supply;
      if (b.complete) cap += BUILDING_STATS[b.type].supplyProvided;
    }
    if (supply !== p.supplyUsed) out.push(`P${p.id} 人口不一致：${p.supplyUsed} ≠ ${supply}`);
    if (Math.min(cap, RULES.supply.hardCap) !== p.supplyCap) out.push(`P${p.id} 人口上限不一致`);
  }
  for (const u of s.units) {
    if (u.hp <= 0) out.push(`單位 ${u.id} 血量 ≤ 0 仍存在`);
    if (s.walk[tileIndex(s, u.x, u.y)] === WALK_BLOCKED) out.push(`單位 ${u.id}（${u.type}）在不可通行格 (${u.x},${u.y})`);
    if (!s.unitById.has(u.id)) out.push(`單位 ${u.id} 不在索引中`);
  }
  if (s.unitById.size !== s.units.length) out.push('單位索引數量不符');
  if (s.buildingById.size !== s.buildings.length) out.push('建築索引數量不符');
  for (let i = 1; i < s.units.length; i++) if (s.units[i - 1].id >= s.units[i].id) out.push('單位陣列未依 id 排序');
  // 通行格網與建築佔用
  const expectedAt = new Int32Array(w * s.height);
  for (const b of s.buildings) for (let y = b.tileY; y < b.tileY + b.size; y++) for (let x = b.tileX; x < b.tileX + b.size; x++) expectedAt[y * w + x] = b.id;
  for (let i = 0; i < expectedAt.length; i++) {
    if (expectedAt[i] !== s.buildingAt[i]) {
      out.push(`建築佔用格不一致 @${i}`);
      break;
    }
    const blocked = s.map.tiles[i] === TERRAIN.blocked || expectedAt[i] !== 0 || s.nodeAt[i] !== 0;
    if (blocked !== (s.walk[i] === WALK_BLOCKED)) {
      out.push(`通行格網不一致 @${i}`);
      break;
    }
  }
  for (const n of s.nodes) {
    if (n.reserve < 0) out.push(`礦點 ${n.id} 儲量為負`);
    if (n.minerId !== 0 && !s.unitById.has(n.minerId)) out.push(`礦點 ${n.id} 的開採者已不存在`);
    for (const q of n.queue) if (!s.unitById.has(q)) out.push(`礦點 ${n.id} 排隊者已不存在`);
  }
  return out;
}

/** 從頭重算視野計數，與增量結果比對 */
function visionMismatch(s: MatchState): string | null {
  const w = s.width;
  for (const p of s.players) {
    if (!p.alive) continue;
    const vis = new Uint16Array(w * s.height);
    const add = (anchor: number, r: number, corner: boolean): void => {
      if (anchor < 0) return;
      const st = getStencil(r, corner);
      const ax = anchor % w;
      const ay = (anchor - ax) / w;
      for (let i = 0; i < st.dx.length; i++) {
        const x = ax + st.dx[i];
        const y = ay + st.dy[i];
        if (x < 0 || y < 0 || x >= w || y >= s.height) continue;
        const idx = y * w + x;
        if (st.near[i] === 0 && s.map.tiles[idx] === TERRAIN.forest) continue;
        vis[idx] += 1;
      }
    };
    for (const u of s.units) if (u.owner === p.id) add(u.visTile, u.visRadius, false);
    for (const b of s.buildings) if (b.owner === p.id) add(b.visTile, b.visRadius, b.visCorner);
    for (const t of s.towers) if (t.visOwner === p.id) add(Math.floor(t.y / 1000) * w + Math.floor(t.x / 1000), RULES.watchtower.sightTiles, true);
    for (let i = 0; i < vis.length; i++) if (vis[i] !== p.vis[i]) return `P${p.id} 視野計數不一致 @${i}：${p.vis[i]} ≠ ${vis[i]}`;
  }
  return null;
}

async function soak(mode: MatchMode, seed: number): Promise<void> {
  const n = MAP_MODES[mode].players;
  const files = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? BASELINE : RANDOM));
  const controllers = files.map((f) => new BatchController(f.compiled, f.label));
  const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const d = new MatchDriver({ mode, seed, controllers, knobs, record: false });
  await d.init();
  while (!d.match.over) {
    await d.stepTick();
    if (d.match.tick % 50 === 0) {
      const v = violations(d.match.state);
      expect(v, `tick ${d.match.tick}`).toEqual([]);
    }
    if (d.match.tick % 500 === 0) expect(visionMismatch(d.match.state), `tick ${d.match.tick}`).toBeNull();
  }
  for (const rt of d.runtime) expect(rt.exceptions).toBe(0);
}

describe('引擎不變量（基準 Bot 與隨機 Bot 混戰）', () => {
  for (const mode of ['1v1', 'ffa4', 'ffa8'] as MatchMode[]) {
    it(`${mode}：人口、礦量、通行格網、索引、視野計數始終一致`, async () => {
      for (const seed of mode === 'ffa8' ? [1] : [1, 2, 3]) await soak(mode, seed);
    });
  }
});
