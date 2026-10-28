// 引擎 0.4 步驟 2：城門與側門。
// 測試圖「測試城門」：40 × 20 格、全高 1 階；x = 20 一整列城牆，y = 9～11 是正門（3 格門樓）、y = 16 是側門（1 格門樓）。
// 紅方（player 1）是守方，在牆東側（城內）；藍方（player 0）在牆西側。
import { describe, expect, it } from 'vitest';
import { RULES, T, TILE, UNITS } from '../src/legion/config.ts';
import { finishMap, registerMap, tileXY, type LegionMap } from '../src/legion/map.ts';
import { findPath } from '../src/legion/path.ts';
import { LegionMatch } from '../src/legion/sim.ts';
import type { LegionEvent } from '../src/legion/api.ts';

const W = 40;
const H = 20;
const WALL_X = 20;

function gateMap(): LegionMap {
  const terrain = new Uint8Array(W * H);
  const heights = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < H; y++) terrain[y * W + WALL_X] = T.Wall;
  for (let y = 9; y <= 11; y++) terrain[y * W + WALL_X] = T.Gatehouse;
  terrain[16 * W + WALL_X] = T.Gatehouse;
  return finishMap({
    id: 'test-gate',
    name: '測試城門',
    description: '一整列城牆、一座三格寬的正門、一座一格寬的側門。',
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
    gates: [
      { x0: WALL_X, y0: 9, x1: WALL_X + 1, y1: 12, kind: 'main' },
      { x0: WALL_X, y0: 16, x1: WALL_X + 1, y1: 17, kind: 'side' },
    ],
    defender: 1,
  });
}

const map = gateMap();
registerMap(map);

type Dep = { type: string; x: number; y: number; facing?: number; layer?: number; formation?: string; width?: number };

function match(a: Dep[], b: Dep[]): { m: LegionMatch; events: LegionEvent[] } {
  const m = new LegionMatch({ seed: 5, mode: 'annihilation', mapId: 'test-gate', deployments: [a, b] });
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
const eastOfWall = (m: LegionMatch, reg: number): number => m.soldiers.filter((s) => s.reg === reg && s.alive && s.x > (WALL_X + 1) * TILE).length;
const gateEvents = (events: LegionEvent[]): string[] => events.flatMap((e) => (e.type === 'gate' ? [`${e.gate}:${e.state}`] : []));

describe('軍團戰 0.4：城門', () => {
  it('開局：兩座城門都是關的，血量照常數，obs.structures 雙方都看得到', () => {
    const { m } = match([{ type: 'light', x: 5000, y: 3500 }], [{ type: 'light', x: 35000, y: 3500 }]);
    for (const p of [0, 1]) {
      const gs = m.observe(p).structures.gates;
      expect(gs.map((g) => [g.id, g.kind, g.state, g.hp, g.hpMax, g.owner])).toEqual([
        [0, 'main', 'closed', RULES.gate.mainHp, RULES.gate.mainHp, 1],
        [1, 'side', 'closed', RULES.gate.sideHp, RULES.gate.sideHp, 1],
      ]);
      expect([gs[0].x, gs[0].y, gs[0].x0, gs[0].y0, gs[0].x1, gs[0].y1]).toEqual([20500, 10500, 20, 9, 21, 12]);
    }
  });

  it('關著的城門擋住地面：藍方輕步兵下令穿過正門，整場留在牆西側', () => {
    const { m } = match([{ type: 'light', x: 15000, y: 10500 }], [{ type: 'light', x: 35000, y: 3500 }]);
    run(m, 300, (t) => (t === 0 ? [[0, [{ type: 'move', id: 0, x: 30500, y: 10500 }]]] : []));
    expect(eastOfWall(m, 0)).toBe(0);
    for (const s of m.soldiers.filter((q) => q.reg === 0)) expect(tileAt(s.x, s.y)).not.toBe(T.Gatehouse);
  });

  it('守方開門：開門中 3 秒不能過，開好後地面可以通過；尋路也走門洞', () => {
    const { m, events } = match([{ type: 'light', x: 15000, y: 10500 }], [{ type: 'light', x: 35000, y: 3500 }]);
    m.applyCommands(1, [{ type: 'gate', gate: 0, action: 'open' }]);
    expect(m.gates[0].state).toBe('opening');
    expect(m.gates[0].timer).toBe(RULES.gate.openTicks);
    // 沒給通行狀態（門關著）：尋路不能穿過
    expect(findPath(map, 15500, 10500, 30500, 10500)).toBeNull();
    run(m, RULES.gate.openTicks - 1);
    expect(m.gates[0].state).toBe('opening');
    m.step();
    expect(m.gates[0].state).toBe('open');
    expect(gateEvents(events)).toEqual(['0:opening', '0:open']);
    // 給了城門開著的通行狀態：尋路穿過門洞
    const p = findPath(map, 15500, 10500, 30500, 10500, false, 0, false, { open: m.gateMask, links: null, linkCost: 0 });
    expect(p).not.toBeNull();
    run(m, 400, (t) => (t === RULES.gate.openTicks + 5 ? [[0, [{ type: 'move', id: 0, x: 30500, y: 10500 }]]] : []));
    expect(eastOfWall(m, 0)).toBe(UNITS.light.men);
    for (const s of m.soldiers.filter((q) => q.reg === 0)) expect(s.layer).toBe(0);
  });

  it('攻方不能操作城門；門 id 不存在、action 不合法都被拒', () => {
    const { m, events } = match([{ type: 'light', x: 15000, y: 10500 }], [{ type: 'light', x: 35000, y: 3500 }]);
    m.applyCommands(0, [{ type: 'gate', gate: 0, action: 'open' }]);
    m.applyCommands(1, [
      { type: 'gate', gate: 9, action: 'open' },
      { type: 'gate', gate: 1, action: 'smash' },
    ]);
    const rej = events.flatMap((e) => (e.type === 'rejected' ? [[e.player, e.command, e.reason]] : []));
    expect(rej).toEqual([
      [0, 'gate', '只有守方能開關城門'],
      [1, 'gate', '沒有這座城門'],
      [1, 'gate', 'action 只能是 open 或 close'],
    ]);
    expect(m.gates.map((g) => g.state)).toEqual(['closed', 'closed']);
  });

  it('開關門指令佔指令額度：一次 11 條只執行前 10 條', () => {
    const { m } = match([{ type: 'light', x: 15000, y: 10500 }], [{ type: 'light', x: 35000, y: 3500 }]);
    const cmds = [...Array.from({ length: 10 }, () => ({ type: 'hold', id: 1 })), { type: 'gate', gate: 1, action: 'open' }];
    m.applyCommands(1, cmds);
    expect(m.gates[1].state).toBe('closed');
  });

  it('門洞有人時關不上：守方站在門洞裡下令關門，要等人走出去才關上', () => {
    const { m, events } = match([{ type: 'light', x: 5000, y: 3500 }], [{ type: 'light', x: 27500, y: 16500, facing: 180 }]);
    m.applyCommands(1, [{ type: 'gate', gate: 1, action: 'open' }]);
    run(m, RULES.gate.openTicks + 1);
    expect(m.gates[1].state).toBe('open');
    // 側門只有一格寬：整團走進門洞、停在門洞中心
    let inGate = false;
    for (let i = 0; i < 300 && !inGate; i++) {
      if (m.isDecisionTick()) m.applyCommands(1, [{ type: 'move', id: 1, x: 20500, y: 16500 }]);
      m.step();
      inGate = m.soldiers.some((s) => s.reg === 1 && s.alive && s.layer === 0 && tileAt(s.x, s.y) === T.Gatehouse);
    }
    expect(inGate).toBe(true);
    m.applyCommands(1, [{ type: 'gate', gate: 1, action: 'close' }]);
    run(m, RULES.gate.closeTicks + 20, () => [[1, [{ type: 'move', id: 1, x: 20500, y: 16500 }]]]);
    expect(m.soldiers.some((s) => s.reg === 1 && s.alive && s.layer === 0 && tileAt(s.x, s.y) === T.Gatehouse)).toBe(true);
    expect(m.gates[1].state).toBe('closing');
    run(m, 400, () => [[1, [{ type: 'move', id: 1, x: 30500, y: 16500 }]]]);
    expect(m.gates[1].state).toBe('closed');
    expect(gateEvents(events)).toEqual(['1:opening', '1:open', '1:closing', '1:closed']);
  });

  it('城門被破壞：永久開啟，守方關不上；地面可以穿過', () => {
    const { m, events } = match([{ type: 'light', x: 15000, y: 16500 }], [{ type: 'light', x: 35000, y: 3500 }]);
    m.damageGate(m.gates[1], RULES.gate.sideHp - 1);
    expect(m.gates[1].state).toBe('closed');
    m.damageGate(m.gates[1], 5);
    expect(m.gates[1].hp).toBe(0);
    expect(m.gates[1].state).toBe('broken');
    m.applyCommands(1, [{ type: 'gate', gate: 1, action: 'close' }]);
    expect(events.some((e) => e.type === 'rejected' && e.reason === '城門已被破壞，關不上')).toBe(true);
    run(m, 400, (t) => (t === 0 ? [[0, [{ type: 'move', id: 0, x: 30500, y: 16500 }]]] : []));
    expect(m.gates[1].state).toBe('broken');
    expect(eastOfWall(m, 0)).toBe(UNITS.light.men);
  });
});

describe('軍團戰 0.4：門樓頂與門洞的落點層', () => {
  /** 記下每一次傷害（攔截 damage） */
  function spyDamage(m: LegionMatch): number[] {
    const out: number[] = [];
    const host = m as unknown as { damage: (e: unknown, amount: number, by: unknown) => void };
    const orig = host.damage.bind(m);
    host.damage = (e, amount, by): void => {
      out.push(amount);
      orig(e, amount, by);
    };
    return out;
  }

  // 藍方弓兵在地面（高 1 階）朝東；紅方劍士朝西：正面中箭，劍士遠程減免 15%。
  // 齊射期間弓兵不做一般射擊；只量齊射的箭，跑到齊射結束（60 tick）加上箭飛行時間
  const archer: Dep = { type: 'archer', x: 8500, y: 10500, facing: 0 };
  const VOLLEY_TICKS = RULES.volley.duration + 4;
  /** 依老兵等級 1～3 的每箭傷害：idiv(150 × idiv(老兵 × 高度, 100), 100) × 85% */
  const perLevel = (heightPct: number): number[] => RULES.veteran.levels.map((l) => Math.floor((Math.floor((UNITS.archer.attack * Math.floor((l.attack * heightPct) / 100)) / 100) * 85) / 100));

  function teleport(m: LegionMatch, reg: number, x: number, y: number): void {
    const r = m.regiments[reg];
    const dx = x - r.x;
    const dy = y - r.y;
    r.x = x;
    r.y = y;
    for (const sid of r.slots) {
      m.soldiers[sid].x += dx;
      m.soldiers[sid].y += dy;
    }
  }
  const topSword: Dep = { type: 'sword', x: 20500, y: 10500, layer: 1, facing: 180 };

  it('齊射射程：目標在門樓頂算高 3 階，地面弓兵射程少 3 格', () => {
    const { m, events } = match([{ ...archer, x: 6500 }], [topSword]);
    m.applyCommands(0, [{ type: 'volley', id: 0, x: 20500, y: 10500 }]);
    expect(events.some((e) => e.type === 'rejected' && e.reason === '落點超出射程')).toBe(true);
    const { m: m2, events: ev2 } = match([archer], [topSword]);
    m2.applyCommands(0, [{ type: 'volley', id: 0, x: 20500, y: 10500 }]);
    expect(ev2.some((e) => e.type === 'rejected')).toBe(false);
    expect(UNITS.archer.range - 3 * RULES.height.rangePerLevel).toBe(13000);
  });

  it('齊射打門樓頂的守軍：仰射少 30%（每箭 150 → 105）', () => {
    const { m } = match([archer], [topSword]);
    const hits = spyDamage(m);
    m.applyCommands(0, [{ type: 'volley', id: 0, x: 20500, y: 10500 }]);
    run(m, VOLLEY_TICKS);
    expect(hits.length).toBeGreaterThan(0);
    // 150 × 70% ＝ 105；正面、劍士遠程減免 15% → 105 × 85% ＝ 89（之後老兵升級會變高）
    expect(perLevel(70)).toEqual([89, 97, 107]);
    expect(hits[0]).toBe(89);
    for (const h of hits) expect(perLevel(70)).toContain(h);
  });

  it('門開著時門洞地面的人中齊射：落點是門樓格（估牆頂），落地改用地面層，沒有仰射減傷', () => {
    // 弓兵先放在射程外（避免一般射擊與老兵升級），劍士走進門洞後再移到射程內齊射
    const { m } = match([{ ...archer, x: 1500 }], [{ type: 'sword', x: 27500, y: 10500, facing: 180 }]);
    m.applyCommands(1, [{ type: 'gate', gate: 0, action: 'open' }]);
    run(m, 200, (t) => (t >= RULES.gate.openTicks ? [[1, [{ type: 'move', id: 1, x: 20500, y: 10500, facing: 180 }]]] : []));
    const r = m.regiments[1];
    expect(r.layer).toBe(0);
    expect(tileAt(r.x, r.y)).toBe(T.Gatehouse);
    expect(m.regiments[0].dmgDealt).toBe(0);
    teleport(m, 0, 8500, 10500);
    const hits = spyDamage(m);
    m.applyCommands(0, [{ type: 'volley', id: 0, x: 20500, y: 10500 }]);
    run(m, VOLLEY_TICKS);
    expect(hits.length).toBeGreaterThan(0);
    // 同高：150 × 85% ＝ 127；沒有用落點估的牆頂層（89）
    expect(perLevel(100)).toEqual([127, 140, 153]);
    expect(hits[0]).toBe(127);
    for (const h of hits) expect(perLevel(100)).toContain(h);
  });
});
