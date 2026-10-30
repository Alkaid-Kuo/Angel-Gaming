import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RULES, T, UNITS } from '../src/legion/config.ts';
import { MAPS, terrainAt } from '../src/legion/map.ts';
import { LegionBatchController, runLegionMatch, runLegionReplay } from '../src/legion/runner.ts';
import { LegionMatch } from '../src/legion/sim.ts';
import type { LegionEvent } from '../src/legion/api.ts';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import { LEGION_STRATEGIES, buildLegionBot } from '../scripts/build-legion-bots.ts';

const W = 160000;
const H = 100000;
type Dep = { type: string; x: number; y: number; facing?: number; width?: number };
const rot = (d: Dep): Dep => ({ ...d, x: W - d.x, y: H - d.y, facing: ((d.facing ?? 0) + 180) % 360 });

/** 把整團瞬間移到 (x, y)（測試用） */
function teleport(m: LegionMatch, r: LegionMatch['regiments'][number], x: number, y: number): void {
  const dx = x - r.x;
  const dy = y - r.y;
  r.x = x;
  r.y = y;
  for (const sid of r.slots) {
    m.soldiers[sid].x += dx;
    m.soldiers[sid].y += dy;
  }
}

function match(a: Dep[], b: Dep[], mode: 'annihilation' | 'capture' = 'annihilation'): { m: LegionMatch; events: LegionEvent[] } {
  const m = new LegionMatch({ seed: 7, mode, deployments: [a, b] });
  const events: LegionEvent[] = [];
  m.eventTap = (e) => events.push(e);
  return { m, events };
}

function run(m: LegionMatch, ticks: number, cmds?: (tick: number) => [number, unknown[]][]): void {
  for (let i = 0; i < ticks && !m.over; i++) {
    if (m.isDecisionTick() && cmds) for (const [p, c] of cmds(m.tick)) m.applyCommands(p, c);
    m.step();
  }
}

const map = MAPS['river-valley']();
const bot = (name: string): CompiledBot => compileBot(readFileSync(`bots/legion-${name}.js`, 'utf8'), `legion-${name}.js`);

describe('軍團戰：地圖', () => {
  it('河谷：旋轉 180° 對稱、有兩座橋與一處淺灘、三個旗點對稱', () => {
    const n = map.terrain.length;
    for (let i = 0; i < n; i++) expect(map.terrain[i]).toBe(map.terrain[n - 1 - i]);
    expect(map.terrain.filter((t) => t === T.Bridge).length).toBeGreaterThan(20);
    expect(map.terrain.filter((t) => t === T.Shallow).length).toBeGreaterThan(40);
    expect(map.flags[0].x).toBe(W - map.flags[2].x);
    expect(map.flags[0].y).toBe(H - map.flags[2].y);
    expect(terrainAt(map, map.flags[1].x, map.flags[1].y)).toBe(T.Shallow);
  });

  it('大河谷：旋轉 180° 對稱（地形與高度）、三個渡口', () => {
    const g = MAPS['grand-valley']();
    const n = g.terrain.length;
    for (let i = 0; i < n; i++) {
      expect(g.terrain[i]).toBe(g.terrain[n - 1 - i]);
      expect(g.heights[i]).toBe(g.heights[n - 1 - i]);
    }
    expect(g.width * g.height).toBe(240 * 150);
    expect(g.terrain.filter((t) => t === T.Bridge).length).toBeGreaterThan(30);
    expect(g.terrain.filter((t) => t === T.Shallow).length).toBeGreaterThan(60);
  });
});

describe('軍團戰：布陣', () => {
  it('超過 500 點、不在布陣區、重疊、兵種不存在的軍團不出場，並發出事件', () => {
    const deps: Dep[] = [
      { type: 'heavyCav', x: 10000, y: 10000 },
      { type: 'heavyCav', x: 10000, y: 22000 },
      { type: 'heavyCav', x: 10000, y: 34000 },
      { type: 'heavyCav', x: 10000, y: 46000 },
      { type: 'heavyCav', x: 10000, y: 58000 },
      { type: 'heavyCav', x: 10000, y: 70000 },
      { type: 'heavyCav', x: 10000, y: 82000 }, // 第 7 團：560 點，超過
      { type: 'light', x: 40000, y: 50000 }, // 不在布陣區
      { type: 'dragon', x: 12000, y: 50000 },
    ];
    const { m } = match(deps, [{ type: 'spear', x: 150000, y: 50000 }, { type: 'spear', x: 150500, y: 50500 }]);
    const ev = m.observe(0).events.filter((e) => e.type === 'deployRejected');
    expect(m.regiments.filter((r) => r.owner === 0).length).toBe(6);
    expect(ev.map((e) => (e.type === 'deployRejected' ? e.index : -1))).toEqual([6, 7, 8]);
    // 第二團與第一團幾乎重疊
    expect(m.regiments.filter((r) => r.owner === 1).length).toBe(1);
    expect(m.observe(1).events.some((e) => e.type === 'deployRejected' && e.reason.includes('重疊'))).toBe(true);
  });

  it('沒有任何軍團出場的一方直接落敗', () => {
    const { m } = match([], [{ type: 'spear', x: 150000, y: 50000 }]);
    expect(m.over).toBe(true);
    expect(m.result().winner).toBe(1);
  });
});

describe('軍團戰：引擎公平與確定性', () => {
  it('完全鏡像的兩軍：每個 tick 的狀態都互為鏡像（處理順序不影響結果）', () => {
    const dep: Dep[] = [
      { type: 'spear', x: 17500, y: 46500 },
      { type: 'sword', x: 17500, y: 54500 },
      { type: 'heavyCav', x: 12500, y: 36500 },
    ];
    const { m } = match(dep, dep.map(rot));
    const half = m.soldiers.length / 2;
    run(m, 900, () => [
      [0, dep.map((d, i) => ({ type: 'attackMove', id: i, x: 80500, y: d.y }))],
      [1, dep.map((d, i) => ({ type: 'attackMove', id: dep.length + i, x: W - 80500, y: H - d.y }))],
    ]);
    for (let i = 0; i < half; i++) {
      const a = m.soldiers[i];
      const b = m.soldiers[half + i];
      expect([a.alive, a.x, a.y, a.hp]).toEqual([b.alive, b.alive ? W - b.x : a.x, b.alive ? H - b.y : a.y, b.hp]);
    }
    expect(m.strength(0)).toBe(m.strength(1));
  });

  it('基準 AI 對戰：同 seed 結果相同，回放重建雜湊一致', () => {
    const play = (): ReturnType<typeof runLegionMatch> => {
      const ctrls = ['push', 'ambush'].map((n, i) => new LegionBatchController(bot(n), n, map, 42, i));
      return runLegionMatch({ seed: 42, mode: 'capture', controllers: ctrls, knobs: ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label)), record: true });
    };
    const a = play();
    const b = play();
    expect(a.finalHash).toBe(b.finalHash);
    for (const rt of a.runtime) expect(rt.errors).toEqual([]);
    const r = runLegionReplay(a.replay!);
    expect(r.desyncTick).toBeNull();
    expect(r.finalHash).toBe(a.finalHash);
    expect(r.result.winner).toBe(a.result.winner);
  });
});

describe('軍團戰：戰鬥規則', () => {
  it('側擊與背擊：依攻擊方相對於目標朝向的位置判定', () => {
    const { m } = match(
      [{ type: 'sword', x: 15000, y: 50000, facing: 0 }],
      [
        { type: 'sword', x: 145000, y: 50000, facing: 180 },
        { type: 'sword', x: 145000, y: 30000, facing: 0 },
        { type: 'sword', x: 145000, y: 70000, facing: 90 },
      ],
    );
    const [a, front, rear, side] = m.regiments;
    expect(m.flankOf(a, front)).toBe('front');
    expect(m.flankOf(a, rear)).toBe('rear');
    expect(m.flankOf(a, side)).toBe('side');
  });

  it('沒有潰散、沒有全軍潰敗：只剩幾個人也照常指揮，比賽要打光才結束', () => {
    const { m, events } = match([{ type: 'spear', x: 15000, y: 50000 }], [{ type: 'spear', x: 145000, y: 50000 }]);
    const r = m.regiments[0];
    for (const sid of r.slots.slice(0, r.slots.length - 2)) m.soldiers[sid].alive = false;
    run(m, 1);
    expect(r.routed).toBe(false);
    expect(m.over).toBe(false);
    expect(events.some((e) => e.type === 'routed')).toBe(false);
    m.applyCommands(0, [{ type: 'move', id: 0, x: 40000, y: 50000 }]);
    const x0 = r.x;
    run(m, 30);
    expect(r.x).toBeGreaterThan(x0);
  });

  it('老兵：累積傷害達門檻升級，血量上限提高', () => {
    const { m, events } = match([{ type: 'sword', x: 15000, y: 50000 }], [{ type: 'spear', x: 145000, y: 50000 }]);
    const r = m.regiments[0];
    const hp0 = m.soldiers[r.slots[0]].hp;
    r.dmgDealt = (r.men0 * UNITS.sword.hp * RULES.veteran.levels[1].threshold) / 100;
    run(m, 1);
    expect(r.level).toBe(2);
    expect(m.soldiers[r.slots[0]].hp).toBe(hp0 + (UNITS.sword.hp * 10) / 100);
    expect(events.some((e) => e.type === 'levelUp' && e.level === 2)).toBe(true);
  });

  it('隱蔽：樹林中的軍團要很近才看得到，空地上的在視野內就看得到', () => {
    // 0 號在北橋旁樹林（64, 12），1 號在樹林外
    const forest = { type: 'sword', x: 64000, y: 12000 };
    const { m } = match([{ type: 'light', x: 15000, y: 50000 }], [{ type: 'spear', x: 145000, y: 50000 }]);
    const hide = m.regiments[1];
    const move = (r: (typeof m.regiments)[number], x: number, y: number): void => teleport(m, r, x, y);
    move(hide, forest.x, forest.y);
    // 22 格：在輕步兵 16 格視野內，但樹林中要邊緣 5 格內才看得到
    move(m.regiments[0], forest.x - 22000, forest.y);
    run(m, 1);
    expect(m.concealed(hide)).toBe(true);
    expect(m.visible[0][hide.id]).toBe(0);
    move(m.regiments[0], forest.x - 12000, forest.y);
    run(m, 1);
    expect(m.visible[0][hide.id]).toBe(1);
    move(hide, 60000, 30000);
    move(m.regiments[0], 60000 - 12000, 30000);
    run(m, 1);
    expect(m.concealed(hide)).toBe(false);
    expect(m.visible[0][hide.id]).toBe(1);
  });

  describe('佔點（大河谷）', () => {
    const G = MAPS['grand-valley']();
    const C = RULES.capture;
    /** 雙方各一團長槍在自己的布陣區，回傳比賽與兩團 */
    const setup = (): { m: LegionMatch; a: LegionMatch['regiments'][number]; b: LegionMatch['regiments'][number] } => {
      const m = new LegionMatch({ seed: 7, mode: 'capture', deployments: [[{ type: 'spear', x: 10000, y: 20000 }], [{ type: 'spear', x: G.width * 1000 - 10000, y: 20000 }]] });
      return { m, a: m.regiments[0], b: m.regiments[1] };
    };

    it('預設用大河谷、8 分鐘；三面旗對稱，中央淺灘 2 分、兩座橋 1 分', () => {
      const { m } = setup();
      expect(m.map.id).toBe('grand-valley');
      expect(m.timeLimitTicks).toBe(C.timeLimitTicks);
      expect(m.flags.map((f) => f.points)).toEqual([1, 2, 1]);
      expect(m.flags[0].x).toBe(G.width * 1000 - m.flags[2].x);
      expect(m.flags[0].y).toBe(G.height * 1000 - m.flags[2].y);
      expect(terrainAt(G, m.flags[0].x, m.flags[0].y)).toBe(T.Bridge);
      expect(terrainAt(G, m.flags[1].x, m.flags[1].y)).toBe(T.Shallow);
    });

    it('一方單獨在圈內：進度條滿了才佔領；佔領後每秒得分', () => {
      const { m, a } = setup();
      const f = m.flags[1];
      teleport(m, a, f.x, f.y);
      run(m, C.captureTicks - 1);
      expect(f.owner).toBe(-1);
      expect(f.capturer).toBe(0);
      run(m, 1);
      expect(f.owner).toBe(0);
      run(m, 50);
      expect(m.scoreOf(0)).toBe(10);
      expect(m.observe(0).score).toEqual([10, 0]);
    });

    it('沒佔滿就離開：進度倒退到零；圈內有敵人：進度不增加', () => {
      const { m, a, b } = setup();
      const f = m.flags[0];
      teleport(m, a, f.x - 2000, f.y);
      run(m, 60);
      expect(f.progress).toBe(60);
      teleport(m, a, 10000, 20000);
      run(m, 20);
      expect(f.progress).toBe(40);
      teleport(m, a, f.x - 2000, f.y);
      teleport(m, b, f.x + 2000, f.y);
      run(m, 30);
      expect(f.progress).toBe(40);
      teleport(m, a, 10000, 20000);
      run(m, 40);
      expect(f.progress).toBe(0);
      expect(f.capturer).toBe(-1);
      run(m, 5);
      expect(f.capturer).toBe(1);
    });

    it('已佔領的旗：敵人進圈就暫停得分，敵人單獨佔滿就易手', () => {
      const { m, a, b } = setup();
      const f = m.flags[2];
      f.owner = 0;
      teleport(m, b, f.x, f.y);
      run(m, 30);
      expect(f.contested).toBe(true);
      expect(m.scoreOf(0)).toBe(0);
      expect(f.capturer).toBe(1);
      run(m, C.captureTicks - 30);
      expect(f.owner).toBe(1);
      teleport(m, b, G.width * 1000 - 10000, 20000);
      teleport(m, a, 10000, 20000);
      run(m, 20);
      expect(f.contested).toBe(false);
      expect(m.scoreOf(1)).toBe(2);
    });

    it('後備：總點數 1500、場上最多 500（超過的自動轉後備）；後備不在場上、看得到自己的後備', () => {
      const fit = Math.floor(C.fieldCap / UNITS.sword.cost);
      const sw = (n: number): object[] => Array.from({ length: n }, (_, i) => ({ type: 'sword', x: 10000, y: 8000 + i * 12000 }));
      // 劍士放到場上放不下為止，多一團超過上限轉後備；再加兩團標成後備
      const m = new LegionMatch({ seed: 7, mode: 'capture', deployments: [[...sw(fit + 1), { type: 'archer', reserve: true }, { type: 'heavyCav', reserve: true }], [{ type: 'spear', x: G.width * 1000 - 10000, y: 20000 }]] });
      const mine = m.regiments.filter((r) => r.owner === 0);
      expect(mine.length).toBe(fit + 3);
      expect(mine.filter((r) => r.reserve).map((r) => r.kind)).toEqual(['sword', 'archer', 'heavyCav']);
      expect(m.fieldCost(0)).toBe(fit * UNITS.sword.cost);
      expect(m.strength(0)).toBe(((fit + 1) * UNITS.sword.cost + UNITS.archer.cost + UNITS.heavyCav.cost) * 100);
      const obs = m.observe(0);
      expect(obs.fieldCap).toBe(C.fieldCap);
      expect(obs.regiments.filter((r) => r.reserve).length).toBe(3);
      expect(m.observe(1).enemies.some((e) => mine.find((r) => r.id === e.id)?.reserve)).toBe(false);
    });

    it('後備入場：場上沒滿可以從出生點召喚（準備 10 秒）；滿了就被拒絕', () => {
      const m = new LegionMatch({ seed: 7, mode: 'capture', deployments: [[{ type: 'sword', x: 10000, y: 20000 }, { type: 'heavyCav', reserve: true }, { type: 'sword', reserve: true }], [{ type: 'spear', x: G.width * 1000 - 10000, y: 20000 }]] });
      const [, cav, sword2] = m.regiments.filter((r) => r.owner === 0);
      m.applyCommands(0, [{ type: 'summon', id: cav.id }]);
      expect(m.fieldCost(0)).toBe(UNITS.sword.cost + UNITS.heavyCav.cost);
      run(m, C.enterTicks - 1);
      expect(cav.reserve).toBe(true);
      run(m, 2);
      expect(cav.reserve).toBe(false);
      expect(cav.slots.length).toBe(12);
      const sp = G.spawns[0];
      expect(Math.abs(cav.x - sp.x) + Math.abs(cav.y - sp.y)).toBeLessThan(C.spawnRadius * 2);
      // 場上放滿劍士：再召喚一團劍士會超過 500，被拒絕
      const fit = Math.floor(C.fieldCap / UNITS.sword.cost);
      const fill = new LegionMatch({ seed: 7, mode: 'capture', deployments: [[...Array.from({ length: fit }, (_, i) => ({ type: 'sword', x: 10000, y: 8000 + i * 12000 })), { type: 'sword', reserve: true }], [{ type: 'spear', x: G.width * 1000 - 10000, y: 20000 }]] });
      const extra = fill.regiments.find((r) => r.owner === 0 && r.reserve)!;
      fill.applyCommands(0, [{ type: 'summon', id: extra.id }]);
      expect(extra.enterAt).toBe(-1);
      expect(fill.observe(0).events.some((e) => e.type === 'rejected' && e.command === 'summon')).toBe(true);
      expect(sword2.reserve).toBe(true);
    });

    it('換兵：在出生點或自己的補給站換下一團（血量補滿、人數不變），換上的在原地準備入場；沒佔那座橋就不能用它的補給站', () => {
      const m = new LegionMatch({ seed: 7, mode: 'capture', deployments: [[{ type: 'sword', x: 10000, y: 20000 }, { type: 'spear', reserve: true }], [{ type: 'spear', x: G.width * 1000 - 10000, y: 20000 }]] });
      const [sw, sp] = m.regiments.filter((r) => r.owner === 0);
      for (const sid of sw.slots.slice(0, 10)) m.soldiers[sid].alive = false;
      for (const sid of sw.slots) m.soldiers[sid].hp = 300;
      run(m, 1);
      // 不在出生點、補給站：不能換
      m.applyCommands(0, [{ type: 'swap', id: sw.id, with: sp.id }]);
      expect(sw.reserve).toBe(false);
      // 南橋的補給站：南橋不是我的就不能用
      const su = G.supplies[1];
      teleport(m, sw, su.x, su.y);
      m.applyCommands(0, [{ type: 'swap', id: sw.id, with: sp.id }]);
      expect(sw.reserve).toBe(false);
      m.flags[su.flag].owner = 0;
      m.applyCommands(0, [{ type: 'swap', id: sw.id, with: sp.id }]);
      expect(sw.reserve).toBe(true);
      expect(sw.parked.length).toBe(UNITS.sword.men - 10);
      expect(sw.parked.every((sid) => m.soldiers[sid].hp === UNITS.sword.hp)).toBe(true);
      run(m, C.enterTicks + 1);
      expect(sp.reserve).toBe(false);
      expect(Math.abs(sp.x - su.x) + Math.abs(sp.y - su.y)).toBeLessThan(C.supplyRadius * 2);
      // 撤回的那團之後也能再召喚（人數不變）
      m.applyCommands(0, [{ type: 'summon', id: sw.id }]);
      run(m, C.enterTicks + 1);
      expect(sw.reserve).toBe(false);
      expect(sw.slots.length).toBe(UNITS.sword.men - 10);
    });

    it('回血：在出生點、沒受傷一陣子的團每秒回血（不超過上限，人數不變）', () => {
      const { m, a } = setup();
      const sp = G.spawns[0];
      teleport(m, a, sp.x, sp.y);
      for (const sid of a.slots) m.soldiers[sid].hp = 500;
      run(m, 30);
      const hp = m.soldiers[a.slots[0]].hp;
      expect(hp).toBeGreaterThan(500);
      expect(hp).toBeLessThanOrEqual(UNITS.spear.hp);
      run(m, 600);
      expect(m.soldiers[a.slots[0]].hp).toBe(UNITS.spear.hp);
    });

    it('先到目標分獲勝', () => {
      const { m } = setup();
      m.flags[1].owner = 1;
      m.players[1].score = (C.scoreTarget - 1) * 10;
      run(m, 6);
      expect(m.over).toBe(true);
      expect(m.result()).toMatchObject({ winner: 1, reason: 'score' });
    });
  });
});

describe('軍團戰：基準 AI', () => {
  it('bots/legion-*.js 與 bots/legion-src/ 的原始碼一致（改原始碼後要執行 scripts/build-legion-bots.ts）', () => {
    for (const name of LEGION_STRATEGIES) expect(readFileSync(`bots/legion-${name}.js`, 'utf8').replaceAll('\r\n', '\n')).toBe(buildLegionBot(name));
  });

  it('三隻基準 AI 都能載入、宣告 3～6 顆旋鈕、布陣不超過 500 點且全部出場', () => {
    for (const name of ['push', 'ambush', 'ranged']) {
      const c = new LegionBatchController(bot(name), name, map, 1, 0);
      expect(c.declaration.knobs.length).toBeGreaterThanOrEqual(3);
      const out = runLegionMatch({ seed: 3, mode: 'annihilation', controllers: [c, new LegionBatchController(bot('push'), 'push', map, 3, 1)], knobs: [resolveKnobs(c.declaration, undefined, name), resolveKnobs(c.declaration, undefined, name)].map((k, i) => (i === 0 ? k : resolveKnobs(new LegionBatchController(bot('push'), 'push', map, 3, 1).declaration, undefined, 'push'))), record: false });
      const mine = out.match.regiments.filter((r) => r.owner === 0);
      expect(mine.reduce((s, r) => s + r.def.cost, 0)).toBeLessThanOrEqual(RULES.budget);
      expect(out.match.players[0].cost).toBeGreaterThan(450);
      // 兩個座位都不能有布陣失敗的軍團
      for (const seat of [0, 1]) {
        const ctrls = [0, 1].map((i) => new LegionBatchController(bot(i === seat ? name : 'push'), name, map, 5, i));
        const m = new LegionMatch({ seed: 5, mode: 'capture', deployments: ctrls.map((c, i) => c.deploy(new LegionMatch({ seed: 5, mode: 'capture', deployments: [[], []] }).initData(i, resolveKnobs(c.declaration, undefined, name))).value) });
        expect(m.observe(seat).events.filter((e) => e.type === 'deployRejected')).toEqual([]);
      }
      expect(out.runtime[0].errors).toEqual([]);
    }
  });
});
