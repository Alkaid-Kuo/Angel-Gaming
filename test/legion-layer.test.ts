// 引擎 0.4 步驟 1：士兵分層（地面／牆頂）與城牆可走規則。
// 最小測試地圖「測試城牆」：40 × 20 格、全高 1 階；x = 20 一整列城牆（y = 10 是門樓），城內側 (21, 6) 一格樓梯。
// 藍方（player 0）在牆西側的地面，紅方（player 1）在牆東側（城內），可以布陣在牆頂。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RULES, T, TILE, UNITS, WALL_LAYER, stepLayer, terrainSpeed, walkableAt } from '../src/legion/config.ts';
import { MAPS, finishMap, registerMap, tileXY, type LegionMap } from '../src/legion/map.ts';
import { findPath } from '../src/legion/path.ts';
import { LegionBatchController, runLegionMatch } from '../src/legion/runner.ts';
import { LegionMatch, type Regiment } from '../src/legion/sim.ts';
import type { LegionEvent } from '../src/legion/api.ts';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';

const W = 40;
const H = 20;
const WALL_X = 20;
const GATE_Y = 10;
const STAIR = [21, 6] as const;
const c = (tx: number, ty: number): [number, number] => [tx * TILE + TILE / 2, ty * TILE + TILE / 2];

function wallMap(): LegionMap {
  const terrain = new Uint8Array(W * H);
  const heights = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < H; y++) terrain[y * W + WALL_X] = T.Wall;
  terrain[GATE_Y * W + WALL_X] = T.Gatehouse;
  terrain[STAIR[1] * W + STAIR[0]] = T.Stair;
  return finishMap({
    id: 'test-wall',
    name: '測試城牆',
    description: '一整列城牆、一座門樓、城內側一格樓梯。',
    width: W,
    height: H,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: WALL_X, y1: H },
      { x0: WALL_X, y0: 0, x1: W, y1: H },
    ],
    rearX: [0, W * TILE],
    flags: [],
    spawns: [
      { x: 5000, y: 10000 },
      { x: 35000, y: 10000 },
    ],
    supplies: [],
    landmarks: [],
    gates: [{ x0: WALL_X, y0: GATE_Y, x1: WALL_X + 1, y1: GATE_Y + 1, kind: 'main' }],
    defender: 1,
  });
}

const map = wallMap();
registerMap(map);

type Dep = { type: string; x: number; y: number; facing?: number; width?: number; layer?: number; formation?: string };

function match(a: Dep[], b: Dep[]): { m: LegionMatch; events: LegionEvent[] } {
  const m = new LegionMatch({ seed: 3, mode: 'annihilation', mapId: 'test-wall', deployments: [a, b] });
  const events: LegionEvent[] = [];
  m.eventTap = (e) => events.push(e);
  return { m, events };
}

function run(m: LegionMatch, ticks: number, cmds?: (tick: number) => [number, unknown[]][]): void {
  for (let i = 0; i < ticks && !m.over; i++) {
    if (m.isDecisionTick() && cmds) for (const [p, cc] of cmds(m.tick)) m.applyCommands(p, cc);
    m.step();
  }
}

const tileAt = (x: number, y: number): number => {
  const [tx, ty] = tileXY(x, y, W, H);
  return map.terrain[ty * W + tx];
};

/** 沿轉折點取樣，收集路徑經過的地形 */
function terrainsAlong(sx: number, sy: number, pts: [number, number][]): Set<number> {
  const seen = new Set<number>();
  let px = sx;
  let py = sy;
  for (const [x, y] of pts) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x - px), Math.abs(y - py)) / 250));
    for (let k = 0; k <= n; k++) seen.add(tileAt(px + Math.round(((x - px) * k) / n), py + Math.round(((y - py) * k) / n)));
    px = x;
    py = y;
  }
  return seen;
}

const hpOf = (m: LegionMatch, r: Regiment): number => r.slots.reduce((s, id) => s + m.soldiers[id].hp, 0);

describe('軍團戰 0.4：分層規則（config）', () => {
  it('stepLayer：城牆只有層 1；樓梯進入即換層、從樓梯往牆或地面都可走；門樓關著時地面不可走；騎兵不進樓梯', () => {
    expect(stepLayer(0, T.Plain, T.Wall, false)).toBe(-1);
    expect(stepLayer(0, T.Plain, T.Stair, false)).toBe(1);
    expect(stepLayer(1, T.Wall, T.Stair, false)).toBe(0);
    expect(stepLayer(1, T.Stair, T.Wall, false)).toBe(1);
    expect(stepLayer(0, T.Stair, T.Wall, false)).toBe(1);
    expect(stepLayer(1, T.Stair, T.Plain, false)).toBe(0);
    expect(stepLayer(0, T.Stair, T.Plain, false)).toBe(0);
    expect(stepLayer(1, T.Wall, T.Plain, false)).toBe(-1);
    expect(stepLayer(1, T.Wall, T.Gatehouse, false)).toBe(1);
    expect(stepLayer(0, T.Plain, T.Gatehouse, false)).toBe(-1);
    expect(stepLayer(0, T.Plain, T.Gatehouse, false, true)).toBe(0);
    expect(stepLayer(0, T.Plain, T.Stair, true)).toBe(-1);
    expect(stepLayer(0, T.Plain, T.River, false)).toBe(-1);
    expect(walkableAt(T.Wall, WALL_LAYER)).toBe(true);
    expect(walkableAt(T.Wall, 0)).toBe(false);
    expect(terrainSpeed(T.Stair, 'sword')).toBe(50);
  });

  it('沒有城牆的既有地圖：snapTop 全是 -1', () => {
    const g = MAPS['grand-valley']();
    expect(g.snapTop.every((v) => v === -1)).toBe(true);
    expect(map.snapTop[5 * W + 25]).toBe(5 * W + WALL_X);
  });
});

describe('軍團戰 0.4：分層尋路', () => {
  it('城內地面到牆頂的路徑會經過樓梯，終點在牆上', () => {
    const [sx, sy] = c(30, 12);
    const [gx, gy] = c(WALL_X, 14);
    const p = findPath(map, sx, sy, gx, gy, false, 0, false);
    expect(p).not.toBeNull();
    const seen = terrainsAlong(sx, sy, p!);
    expect(seen.has(T.Stair)).toBe(true);
    expect(seen.has(T.Wall)).toBe(true);
    expect(tileAt(...p![p!.length - 1])).toBe(T.Wall);
  });

  it('騎兵找不到上牆的路；牆西側（沒有樓梯）的地面單位也找不到', () => {
    const [sx, sy] = c(30, 12);
    expect(findPath(map, sx, sy, ...c(WALL_X, 14), false, 0, true)).toBeNull();
    expect(findPath(map, ...c(10, 12), ...c(WALL_X, 14), false, 0, false)).toBeNull();
    // 門關著：地面穿不過門樓到另一側
    expect(findPath(map, ...c(10, 10), ...c(30, 10), false, 0, false)).toBeNull();
  });

  it('牆頂連通：從牆上出發沿牆走過門樓，不經樓梯', () => {
    const [sx, sy] = c(WALL_X, 3);
    const p = findPath(map, sx, sy, ...c(WALL_X, 17), false, WALL_LAYER, false);
    expect(p).not.toBeNull();
    const seen = terrainsAlong(sx, sy, p!);
    expect(seen.has(T.Gatehouse)).toBe(true);
    expect(seen.has(T.Plain)).toBe(false);
    expect(seen.has(T.Stair)).toBe(false);
  });
});

describe('軍團戰 0.4：分層模擬（測試城牆圖）', () => {
  it('布陣：layer 只能 0／1、牆頂只能在牆格上、騎兵不能上牆；牆頂的團與下方地面的團不算重疊', () => {
    const { m, events } = match(
      [{ type: 'sword', x: 10000, y: 10500 }],
      [
        { type: 'archer', x: 20500, y: 12500, layer: 1 },
        { type: 'archer', x: 25500, y: 12500, layer: 1 }, // 地面格不能布在牆頂
        { type: 'lightCav', x: 20500, y: 5500, layer: 1 }, // 騎兵
        { type: 'spear', x: 25500, y: 5500, layer: 2 },
        { type: 'spear', x: 21500, y: 12500 }, // 牆頂弓兵正下方旁邊的地面：與層 1 的團不算重疊
      ],
    );
    expect(events).toEqual([]);
    // 布陣事件在建構時就發出（eventTap 還沒掛上），從 m.events 讀
    const rejected = m.events.filter((e) => e.type === 'deployRejected').map((e) => (e as { index: number }).index);
    expect(rejected).toEqual([1, 2, 3]);
    expect(m.regiments.length).toBe(3);
    expect(m.regiments[1].layer).toBe(1);
    expect(m.soldiers.filter((s) => s.reg === 1).every((s) => s.layer === 1)).toBe(true);
    expect(m.regiments[2].layer).toBe(0);
  });

  it('牆頂隊形為縱隊（一格寬）；觀測資料有 layer，高度 ＝ 地面 ＋ 3 階', () => {
    const { m } = match([{ type: 'sword', x: 10000, y: 10500 }], [{ type: 'sword', x: 20500, y: 10500, layer: 1, facing: 270 }]);
    const wall = m.regiments[1];
    expect(wall.corridor).toBe(1);
    expect(wall.shape.files).toBe(1);
    expect(wall.shape.ranks).toBe(UNITS.sword.men);
    for (const sid of wall.slots) expect(m.soldiers[sid].x).toBe(20500);
    const obs = m.observe(1);
    expect(obs.regiments[0].layer).toBe(1);
    expect(obs.regiments[0].height).toBe(4);
    expect(m.observe(0).regiments[0].layer).toBe(0);
  });

  it('地面單位走不進牆：往牆後下令，整團留在牆西側、沒有人站上牆格', () => {
    const { m } = match([{ type: 'light', x: 15000, y: 10500 }], [{ type: 'spear', x: 30000, y: 10500 }]);
    run(m, 300, (t) => (t === 0 ? [[0, [{ type: 'move', id: 0, x: 24500, y: 10500 }]]] : []));
    for (const s of m.soldiers.filter((q) => q.reg === 0)) {
      expect(s.alive).toBe(true);
      expect(s.x).toBeLessThan(WALL_X * TILE);
      expect(s.layer).toBe(0);
      expect(tileAt(s.x, s.y)).not.toBe(T.Wall);
    }
    expect(m.regiments[0].layer).toBe(0);
  });

  it('步兵經樓梯上牆：軍團與士兵 layer 變成 1，樓梯上速度減半', () => {
    // 藍方放在遠處的角落：牆頂縱隊的半徑很大，離太近會觸發「附近有敵軍」的互擠推移，量不到純粹的樓梯速度
    const { m } = match([{ type: 'sword', x: 2500, y: 18500 }], [{ type: 'sword', x: 27500, y: 6500, facing: 180 }]);
    const r = m.regiments[1];
    let maxStairSpd = 0;
    let onStair = 0;
    const [gx, gy] = c(WALL_X, 6);
    for (let i = 0; i < 400 && !m.over; i++) {
      if (m.isDecisionTick()) m.applyCommands(1, [{ type: 'move', id: 1, x: gx, y: gy }]);
      const before = new Map(r.slots.map((sid) => [sid, tileAt(m.soldiers[sid].x, m.soldiers[sid].y)]));
      m.step();
      for (const sid of r.slots) {
        if (before.get(sid) === T.Stair) {
          onStair += 1;
          maxStairSpd = Math.max(maxStairSpd, m.soldiers[sid].spd);
        }
      }
    }
    expect(onStair).toBeGreaterThan(0);
    expect(r.nearEnemy).toBe(false);
    // 劍士速度 196 單位／tick，樓梯 ×50% ＝ 98，追趕加速 ×1.4 ＝ 137
    expect(maxStairSpd).toBeLessThanOrEqual(Math.ceil((UNITS.sword.speed * 50 * RULES.soldier.catchUp) / 10000));
    expect(r.layer).toBe(1);
    expect(tileAt(r.x, r.y)).toBe(T.Wall);
    const up = r.slots.filter((sid) => m.soldiers[sid].layer === 1 && tileAt(m.soldiers[sid].x, m.soldiers[sid].y) !== T.Plain);
    expect(up.length).toBeGreaterThanOrEqual(r.slots.length - 2);
    for (const sid of r.slots) {
      const s = m.soldiers[sid];
      if (tileAt(s.x, s.y) === T.Wall) expect(s.layer).toBe(1);
    }
  });

  it('騎兵不能進樓梯：下令上牆原地不動，沒有人踏上樓梯或城牆', () => {
    const { m } = match([{ type: 'sword', x: 5000, y: 10500 }], [{ type: 'lightCav', x: 27500, y: 6500, facing: 180 }]);
    const r = m.regiments[1];
    run(m, 200, () => [[1, [{ type: 'move', id: 1, x: 20500, y: 6500 }]]]);
    expect(r.layer).toBe(0);
    for (const sid of r.slots) {
      const s = m.soldiers[sid];
      expect(s.layer).toBe(0);
      expect([T.Stair, T.Wall]).not.toContain(tileAt(s.x, s.y));
    }
  });

  it('牆頂弓兵射地面單位：射程與傷害享有 ＋3 階加成（每箭 150 → 195）', () => {
    const { m } = match([{ type: 'sword', x: 16500, y: 12500, facing: 0 }], [{ type: 'archer', x: 20500, y: 12500, layer: 1, facing: 180 }]);
    const shots = new Set<LegionMatch['projectiles'][number]>();
    for (let i = 0; i < 30; i++) {
      m.step();
      for (const p of m.projectiles) if (p.reg === 1) shots.add(p);
    }
    expect(shots.size).toBeGreaterThan(0);
    const expected = Math.floor((UNITS.archer.attack * (100 + RULES.height.rangedPerLevel * 3)) / 100);
    for (const p of shots) expect(p.dmg).toBe(expected);
    expect(hpOf(m, m.regiments[0])).toBeLessThan(UNITS.sword.men * UNITS.sword.hp);
  });

  it('近戰、推擠只在同層：地面劍士貼著牆、牆頂劍士在正上方，互相攻擊 100 tick 無傷、沒有人被推離隊形位置', () => {
    // 藍劍士橫陣朝東，前排在 x = 19950（距牆頂士兵 550，在觸及 1500 與互擋 650 之內）
    const { m, events } = match([{ type: 'sword', x: 19550, y: 10500, facing: 0 }], [{ type: 'sword', x: 20500, y: 10500, layer: 1, facing: 270 }]);
    const ground = m.regiments[0];
    const wall = m.regiments[1];
    const slotX = ground.slots.map((sid) => m.soldiers[sid].sx);
    expect(Math.max(...slotX)).toBe(19950);
    expect(m.visible[0][1]).toBe(1);
    const hp0 = hpOf(m, ground);
    const hp1 = hpOf(m, wall);
    run(m, 100, (t) => (t === 0 ? [[0, [{ type: 'attack', id: 0, target: 1 }]], [1, [{ type: 'attack', id: 1, target: 0 }]]] : []));
    expect(hpOf(m, ground)).toBe(hp0);
    expect(hpOf(m, wall)).toBe(hp1);
    expect(events.some((e) => e.type === 'contact')).toBe(false);
    for (const sid of ground.slots) {
      const s = m.soldiers[sid];
      expect([s.x, s.y]).toEqual([s.sx, s.sy]);
      expect(s.layer).toBe(0);
    }
    for (const sid of wall.slots) {
      const s = m.soldiers[sid];
      expect(s.x).toBe(20500);
      expect(s.layer).toBe(1);
    }
  });

  it('近戰團自動索敵略過另一層：攻擊移動經過牆下不會為牆頂的敵人停下', () => {
    const { m } = match([{ type: 'sword', x: 16100, y: 4500, facing: 90 }], [{ type: 'archer', x: 20500, y: 10500, layer: 1, facing: 180 }]);
    const r = m.regiments[0];
    run(m, 400, (t) => (t === 0 ? [[0, [{ type: 'attackMove', id: 0, x: 16100, y: 16500 }]]] : []));
    expect(r.target).toBe(-1);
    expect(r.y).toBeGreaterThan(15000);
  });
});

describe('軍團戰 0.4：既有地圖零變動', () => {
  it('大河谷：基準 AI 對戰的最終雜湊與 0.3.2 相同（push vs ambush、seed 42）', () => {
    const gv = MAPS['grand-valley']();
    const bot = (name: string): CompiledBot => compileBot(readFileSync(`bots/legion-${name}.js`, 'utf8'), `legion-${name}.js`);
    const ctrls = ['push', 'ambush'].map((n, i) => new LegionBatchController(bot(n), n, gv, 42, i));
    const r = runLegionMatch({ seed: 42, mode: 'capture', controllers: ctrls, knobs: ctrls.map((q) => resolveKnobs(q.declaration, undefined, q.label)), record: false });
    expect(r.finalHash).toBe('a7be4b4131586b98');
    expect(r.result.durationTicks).toBe(3042);
  });
});
