import { describe, expect, it } from 'vitest';
import type { UnitKind } from '../src/legion/config.ts';
import { LegionDriver } from '../src/legion/runner.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import { PlayerController } from '../src/web/legion/player.ts';

const ARMIES: Record<string, UnitKind[]> = {
  預設: ['spear', 'spear', 'sword', 'sword', 'shield', 'archer', 'archer', 'light', 'heavyCav'],
  全重騎: Array<UnitKind>(6).fill('heavyCav'),
  全輕步兵: Array<UnitKind>(16).fill('light'),
  全長槍: Array<UnitKind>(10).fill('spear'),
};

function driver(mode: 'annihilation' | 'capture', field: UnitKind[], reserve: UnitKind[]): { d: LegionDriver; ctrls: PlayerController[] } {
  const ctrls = [new PlayerController({ field, reserve }), new PlayerController({ field, reserve: [] })];
  const knobs = ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  return { d: new LegionDriver({ seed: 1, mode, controllers: ctrls, knobs, record: false }), ctrls };
}

// 玩家指揮：自動布陣不能被引擎拒絕（重疊、不在布陣區、不可通行），兩種模式、兩個座位都一樣
describe('軍團戰：玩家指揮', () => {
  for (const mode of ['annihilation', 'capture'] as const)
    for (const [name, field] of Object.entries(ARMIES))
      it(`${mode} ${name}：自動布陣全部上場`, () => {
        const reserve: UnitKind[] = mode === 'capture' ? ['sword', 'sword'] : [];
        const { d } = driver(mode, field, reserve);
        for (let p = 0; p < 2; p++) {
          const rej = d.match.observe(p).events.filter((e) => e.type === 'deployRejected');
          expect(rej, `玩家 ${p}`).toEqual([]);
          const regs = d.match.regiments.filter((r) => r.owner === p);
          expect(regs.length).toBe(field.length + (p === 0 ? reserve.length : 0));
          expect(regs.filter((r) => r.reserve).length).toBe(p === 0 ? reserve.length : 0);
        }
      });

  it('畫面送來的指令在下一個決策點交給引擎', () => {
    const { d, ctrls } = driver('annihilation', ARMIES['預設'], []);
    const reg = d.match.regiments.find((r) => r.owner === 0)!;
    const x0 = reg.x;
    ctrls[0].push([{ type: 'move', id: reg.id, x: reg.x + 20000, y: reg.y, intent: '玩家：移動' }]);
    for (let i = 0; i < 30; i++) d.step();
    expect(reg.intent).toBe('玩家：移動');
    expect(reg.x).toBeGreaterThan(x0 + 1000);
  });
});
