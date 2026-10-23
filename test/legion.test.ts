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

  it('殘兵：人數低於 20% 就潰散、不能再指揮、往己方後方撤離', () => {
    // 0 號有兩團：只有一團潰散時比賽還沒結束
    const { m, events } = match(
      [
        { type: 'spear', x: 15000, y: 50000 },
        { type: 'spear', x: 15000, y: 30000 },
      ],
      [{ type: 'spear', x: 145000, y: 50000 }],
    );
    const r = m.regiments[0];
    for (const sid of r.slots.slice(0, 33)) m.soldiers[sid].alive = false;
    run(m, 1);
    expect(r.routed).toBe(true);
    expect(events.some((e) => e.type === 'routed' && e.reg === 0)).toBe(true);
    m.applyCommands(0, [{ type: 'move', id: 0, x: 80000, y: 50000 }]);
    expect(m.observe(0).events.some((e) => e.type === 'rejected' && e.reason.includes('潰散'))).toBe(true);
    const x0 = r.x;
    run(m, 30);
    expect(r.x).toBeLessThan(x0);
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
    const move = (r: (typeof m.regiments)[number], x: number, y: number): void => {
      const dx = x - r.x;
      const dy = y - r.y;
      r.x = x;
      r.y = y;
      for (const sid of r.slots) {
        m.soldiers[sid].x += dx;
        m.soldiers[sid].y += dy;
      }
    };
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

  it('佔點：控制超過半數旗點 45 秒獲勝', () => {
    const { m } = match([{ type: 'spear', x: 15000, y: 50000 }], [{ type: 'spear', x: 145000, y: 30000 }], 'capture');
    m.flags[0].owner = 1;
    m.flags[0].value = RULES.capture.target;
    m.flags[2].owner = 1;
    m.flags[2].value = RULES.capture.target;
    run(m, RULES.capture.dominationTicks + 5);
    expect(m.over).toBe(true);
    expect(m.result()).toMatchObject({ winner: 1, reason: 'domination' });
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
