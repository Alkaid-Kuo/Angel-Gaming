import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileBot } from '../src/sandbox/compile.ts';
import type ShooterBaseline from '../bots/shooter-src/baseline.js';
import type { TPlan } from '../bots/shooter-src/tactics.js';
import { P, UNIT, dist } from '../bots/shooter-src/base.js';
import { ENTRY } from '../bots/shooter-src/roles.js';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { shooterHelpers } from '../src/shooter/runner.ts';

const Bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'bot-25').createClass() as unknown as typeof ShooterBaseline;

function make(pid: number, mapId = 'redrock'): { match: ShooterMatch; bot: ShooterBaseline } {
  const match = new ShooterMatch({ seed: 11, mapId });
  const bot = new Bot();
  bot.init(shooterInitData(match.map, pid, {}), shooterHelpers(match.map, 11, pid));
  return { match, bot };
}

function live(pid: number): { match: ShooterMatch; bot: ShooterBaseline } {
  const f = make(pid);
  f.match.tick = 600;
  f.match.phase = 'live';
  f.match.phaseEnd = 3000;
  f.bot.newRound(f.match.observe(pid));
  return f;
}

describe('Bot 2.5：待命位不在守位視線內', () => {
  it.each(['redrock', 'dust'])('%s：每條 T 路線的每個待命位，守位與中路位都看不到', (mapId) => {
    const { bot } = make(0, mapId);
    for (const s of ['A', 'B'] as const) {
      const holds = [...bot.intel.sites[s].holds, ...bot.tactics.midSpots()];
      bot.intel.routes.T[s].forEach((_, i) => {
        const spots = bot.tactics.stageSpots('T', s, i);
        expect(spots.length).toBeGreaterThan(0);
        for (const p of spots) expect(holds.filter((h) => dist(h.x, h.y, p.x, p.y) < 30 * UNIT && bot.g.los(h.x, h.y, p.x, p.y))).toEqual([]);
      });
    }
  });

  it('待命位在自己的路線上，地窖組不會被挑到地圖另一側', () => {
    const { bot } = make(0);
    for (const s of ['A', 'B'] as const) {
      bot.intel.routes.T[s].forEach((r, i) => {
        for (const p of bot.tactics.stageSpots('T', s, i)) expect(r.regionSet.has(bot.intel.region[p.cell])).toBe(true);
      });
    }
  });
});

describe('Bot 2.5：路線涵蓋每個入口', () => {
  it.each(['redrock', 'dust'])('%s：T 路線的終點涵蓋包點全部入口', (mapId) => {
    const { bot } = make(0, mapId);
    for (const s of ['A', 'B'] as const) {
      const ends = new Set(bot.intel.routes.T[s].map((r) => r.portals[r.portals.length - 1]));
      for (const e of bot.intel.sites[s].entrances) expect(ends.has(e.portal)).toBe(true);
    }
  });

  it('補回的遠入口排在原本三條之後，臨時換路換不到它', () => {
    const { bot } = make(0);
    for (const s of ['A', 'B'] as const) expect(bot.intel.routes.T[s].length).toBe(P.routeMax + 1);
    expect(bot.tactics.tRoute('A', 0)).toBe(bot.intel.routes.T.A[0]);
  });
});

describe('Bot 2.5：所有開火分支都過友軍檢查', () => {
  function fakeLine(mateAhead: boolean): { fired: boolean; why: string } {
    const f = live(3);
    f.match.players[3].grenades = [];
    const plan: TPlan = { kind: 'fake', site: 'A', r1: 0, r2: 0, exec: null };
    f.bot.tactics.setPlan(plan, f.match.observe(3));
    const stage = f.bot.tactics.memberStage(f.match.observe(3), 3, plan);
    if (stage === null) throw new Error('沒有待命位');
    f.match.teleport(3, stage.x, stage.y);
    const dx = stage.fx - stage.x;
    const dy = stage.fy - stage.y;
    const len = Math.hypot(dx, dy);
    if (mateAhead) f.match.teleport(4, Math.round(stage.x + (dx / len) * 2000), Math.round(stage.y + (dy / len) * 2000));
    const obs = f.match.observe(3);
    expect(obs.enemies).toEqual([]);
    const commands = f.bot.decide(obs);
    return { fired: commands.some((c) => c.type === 'fire' && c.on), why: f.bot.why };
  }

  it('佯攻開槍時隊友在前方：不開火（2.4.3 會開）', () => {
    const r = fakeLine(true);
    expect(r.why).toContain('佯攻');
    expect(r.fired).toBe(false);
  });

  it('佯攻開槍時線上沒人：照常開火製造聲音', () => {
    const r = fakeLine(false);
    expect(r.why).toContain('佯攻');
    expect(r.fired).toBe(true);
  });

  it('線上淨空隨距離放大：遠處離線 1.3 格的隊友也算擋線，近處不算', () => {
    const f = live(0);
    const me = f.match.players[0];
    const obs = f.match.observe(0);
    const far = { x: me.x + 30 * UNIT, y: me.y };
    const at = (d: number, side: number): typeof obs => ({ ...obs, teammates: obs.teammates.map((m, i) => (i === 0 ? { ...m, alive: true, x: me.x + d * UNIT, y: me.y + side * UNIT } : { ...m, alive: false })) });
    expect(f.bot.combat.lineClear(at(20, 1.3), [far])).toBe(false);
    expect(f.bot.combat.lineClear(at(3, 1.3), [far])).toBe(true);
  });

  it('隊友在目標後方的同一條線上：沒打中會飛到他，不開火；有牆隔開就可以', () => {
    const f = live(0);
    const obs = f.match.observe(0);
    const me = f.match.players[0];
    const target = { x: me.x, y: me.y - 4 * UNIT };
    const mate = (dy: number): typeof obs => ({ ...obs, teammates: obs.teammates.map((m, i) => (i === 0 ? { ...m, alive: true, x: me.x, y: me.y - dy * UNIT } : { ...m, alive: false })) });
    expect(f.bot.g.los(me.x, me.y, target.x, target.y)).toBe(true);
    expect(f.bot.combat.lineClear(mate(6), [target])).toBe(false);
    expect(f.bot.combat.lineClear(mate(60), [target])).toBe(true);
  });
});

describe('Bot 2.5：守包拉開、進點不排隊', () => {
  it('下包後的守包位彼此拉開、不貼著炸彈；下包前的順序不變', () => {
    const { bot } = make(0);
    for (const s of ['A', 'B'] as const) {
      const site = bot.intel.sites[s];
      const b = site.plants[0];
      const spread = bot.tactics.postSpots(s, b.x, b.y, true);
      const picked = spread.filter((h, i) => dist(h.x, h.y, b.x, b.y) >= P.postMin * UNIT && spread.slice(0, i).every((o) => dist(o.x, o.y, h.x, h.y) >= P.postGap * UNIT));
      expect(picked.length).toBeGreaterThanOrEqual(3);
      expect(spread.slice(0, picked.length)).toEqual(picked);
      expect(new Set(spread).size).toBe(bot.tactics.postSpots(s, b.x, b.y).length);
    }
  });

  it('前一個人領先不到間距就放慢；突破手在後面、或等太久就不放慢', () => {
    const { bot, match } = live(1);
    const tactics = bot.tactics;
    const entry = tactics.roles.who(ENTRY);
    const me = entry === 1 ? 2 : 1;
    const mate = [1, 2, 3, 4].find((id) => id !== me && id !== entry) as number;
    const ent = bot.intel.sites.B.entrances[0];
    const place = (id: number, back: number): void => match.teleport(id, ent.ix, ent.iy + back * UNIT);
    const obsOf = (): ReturnType<typeof match.observe> => match.observe(me);
    const helper = make(me);
    helper.bot.newRound(match.observe(me));
    const t = helper.bot.tactics;
    place(entry, 0.5);
    place(mate, 5);
    place(me, 7);
    expect(t.tooClose(obsOf(), 'B', ent)).toBe(true);
    place(mate, 1);
    expect(t.tooClose(obsOf(), 'B', ent)).toBe(false);
    place(mate, 5);
    place(entry, 9);
    expect(t.tooClose(obsOf(), 'B', ent)).toBe(false);
    place(entry, 0.5);
    t.queueHeld = P.entryWaitMax * 30;
    expect(t.tooClose(obsOf(), 'B', ent)).toBe(false);
  });
});
