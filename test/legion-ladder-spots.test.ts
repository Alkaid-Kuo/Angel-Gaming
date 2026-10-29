// 畫面架梯瞄準用的 ladderSpots（src/legion/ladderSpots.ts）要和引擎的 ladder 指令驗證一致：
// 同一個位置的團，對每一格牆／門樓下架梯指令，引擎收不收、拒絕的原因，都要和 ladderSpots 算的一樣。
import { describe, expect, it } from 'vitest';
import { T, TILE, walkable } from '../src/legion/config.ts';
import { ladderSpots, snapLadder, type LadderReg } from '../src/legion/ladderSpots.ts';
import { MAPS, type LegionMap } from '../src/legion/map.ts';
import type { LegionMatch } from '../src/legion/sim.ts';
import { castleMap, castleMatch, rejected, teleport } from './legion-castle-map.ts';

const regOf = (m: LegionMatch, id: number): LadderReg => {
  const r = m.regiments[id];
  return { id, owner: r.owner, kind: r.kind, x: r.x, y: r.y, layer: r.layer, building: r.building >= 0, manning: m.observe(r.owner).structures.ram?.crew === id };
};

/** 部署區中心（單位） */
const zoneCenter = (map: LegionMap, p: number): { x: number; y: number } => {
  const z = map.deploy[p];
  return { x: Math.floor((z.x0 + z.x1) / 2) * TILE + TILE / 2, y: Math.floor((z.y0 + z.y1) / 2) * TILE + TILE / 2 };
};

/** 一團 kind 站在 (x, y)，ladderSpots 的每一格都拿去下指令，比對引擎 */
function compare(mapId: string, kind: string, owner: number, x: number, y: number): { ok: number; all: number } {
  const map = MAPS[mapId]?.() ?? castleMap(mapId);
  const other = 1 - owner;
  const deps = [[] as object[], [] as object[]];
  deps[owner].push({ type: kind, ...zoneCenter(map, owner) });
  deps[other].push({ type: 'light', ...zoneCenter(map, other) });
  const id = owner === 0 ? 0 : 1;
  const fresh = (): { m: LegionMatch; events: ReturnType<typeof castleMatch>['events'] } => {
    const r = castleMatch(mapId, deps[0] as never, deps[1] as never);
    teleport(r.m, id, x, y);
    return r;
  };
  const spots = ladderSpots(map, [regOf(fresh().m, id)], []);
  for (const s of spots) {
    const { m, events } = fresh();
    m.applyCommands(owner, [{ type: 'ladder', id, x: s.x, y: s.y }]);
    const why = rejected(events).map((e) => e[2])[0] ?? '';
    expect({ tile: [s.tx, s.ty], why }).toEqual({ tile: [s.tx, s.ty], why: s.why });
    if (s.ok) expect([m.ladders[0].fx, m.ladders[0].fy]).toEqual([s.footX, s.footY]);
  }
  return { ok: spots.filter((s) => s.ok).length, all: spots.length };
}

describe('架梯瞄準：ladderSpots 和引擎一致', () => {
  it('測試城：牆西側的劍士，近的牆格能架、門樓與太遠的不能', () => {
    castleMap('test-ladder-spots');
    for (const [x, y] of [
      [17000, 6500],
      [18500, 11500],
    ]) {
      const n = compare('test-ladder-spots', 'sword', 0, x, y);
      expect(n.ok).toBeGreaterThan(0);
      expect(n.ok).toBeLessThan(n.all);
    }
    // 騎兵、守方：整片不能架
    expect(compare('test-ladder-spots', 'lightCav', 0, 17000, 6500)).toMatchObject({ ok: 0 });
    expect(compare('test-ladder-spots', 'sword', 1, 23000, 6500)).toMatchObject({ ok: 0 });
  });

  it('石關城：城牆外幾個位置', () => {
    const map = MAPS['stone-pass']();
    const { width: w, height: h, terrain } = map;
    // 找城牆格外側 2～3 格、地面能站的位置（每隔一段取一個）
    const spots: [number, number][] = [];
    for (let i = 0; i < w * h && spots.length < 6; i += 37) {
      if (terrain[i] !== T.Wall) continue;
      const tx = i % w;
      const ty = (i - tx) / w;
      for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0]] as const) {
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || !walkable(terrain[y * w + x])) continue;
        spots.push([x, y]);
        break;
      }
    }
    expect(spots.length).toBeGreaterThan(2);
    let ok = 0;
    let all = 0;
    for (const [x, y] of spots) {
      const n = compare('stone-pass', 'shield', 1 - map.defender, x * TILE + TILE / 2, y * TILE + TILE / 2);
      ok += n.ok;
      all += n.all;
    }
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(all);
  });

  it('吸附：游標附近最近、能架的牆格；太遠就沒有', () => {
    const map = castleMap('test-ladder-snap');
    const reg: LadderReg = { id: 0, owner: 0, kind: 'sword', x: 17000, y: 6500, layer: 0, building: false, manning: false };
    const spots = ladderSpots(map, [reg], [{ x: 20500, y: 6500 }]);
    expect(spots.find((s) => s.tx === 20 && s.ty === 6)?.why).toBe('這格城牆已經有雲梯');
    const s = snapLadder(spots, 21000, 6400);
    expect(s !== null && s.ok && s.tx === 20 && (s.ty === 5 || s.ty === 7)).toBe(true);
    expect(snapLadder(spots, 2000, 2000)).toBe(null);
  });
});
