import { describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { Grid, angleTo, dist } from '../bots/shooter-src/base.js';
import { MapIntel } from '../bots/shooter-src/analysis.js';
import { Perception } from '../bots/shooter-src/memory.js';
import { Judgment } from '../bots/shooter-src/judgment.js';
import type { TacOut } from '../bots/shooter-src/tactics.js';
import type { MapInfo, ShooterObservation } from '../src/shooter/api.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { shooterHelpers } from '../src/shooter/runner.ts';
import { compactIndent } from '../scripts/build-shooter-bots.ts';

function fixture(mapId = 'redrock', pid = 0): { m: ShooterMatch; bot: ShooterBaseline; data: ReturnType<typeof shooterInitData> } {
  const map = MAPS[mapId]();
  const m = new ShooterMatch({ seed: 7, mapId });
  m.tick = 600;
  m.phase = 'live';
  m.phaseEnd = m.tick + 3000;
  const data = shooterInitData(map, pid, {});
  const bot = new ShooterBaseline();
  bot.init(data, shooterHelpers(map, 7, pid));
  bot.newRound(m.observe(pid));
  return { m, bot, data };
}

const output = (): TacOut => ({ goal: null, route: null, hold: null, objective: false, allowPeek: false, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false });

describe('Bot 2.3：局勢判斷', () => {
  it('建置縮排保留多行 template 的實際字串內容與換行', () => {
    const text = 'export default class X {\n  value() {\n    return `第一行\n    保留縮排\n  最後一行`;\n  }\n}';
    expect(compactIndent(text)).toContain('`第一行\n    保留縮排\n  最後一行`');
    expect(compactIndent(text)).toContain('\nvalue() {\nreturn ');
  });
  it('正在交火的最近隊友留在火線，另一人接手；空閒時最近的人立即撿包', () => {
    const { bot, m } = fixture();
    const p = bot.intel.sites.A.plants[0];
    const raw = m.observe(0);
    const obs: ShooterObservation = { ...raw, bomb: { state: 'dropped', x: p.x, y: p.y, site: null, ticksLeft: null }, me: { ...raw.me, x: p.x, y: p.y + 2000, shots: [{ tick: m.tick, x: p.x, y: p.y, hit: null, kill: false, damage: 0 }] }, teammates: raw.teammates.map((q) => ({ ...q, alive: q.id === 1, x: p.x, y: p.y + 6000, firing: false })) };
    expect(bot.judge!.retriever(obs, p.x, p.y)).toBe(1);
    expect(bot.judge!.retriever({ ...obs, me: { ...obs.me, shots: [] } }, p.x, p.y)).toBe(0);
  });

  it('普通牆角在同一個區域內也會預瞄；轉到位後恢復前進，不依賴牆後是否真的有人', () => {
    const { data } = fixture();
    const solid = Array<number>(32 * 32).fill(0);
    for (let i = 0; i < solid.length; i++) if (i % 32 === 0 || i % 32 === 31 || i < 32 || i >= 31 * 32) solid[i] = 1;
    for (let y = 1; y < 19; y++) solid[y * 32 + 16] = 1;
    const map: MapInfo = { ...data.map, id: 'corner-fixture', width: 32, height: 32, solid, regions: [{ id: 'single', name: '單一區域', x0: 1, y0: 1, x1: 31, y1: 31 }], sites: [{ id: 'A', x0: 20, y0: 5, x1: 28, y1: 12 }, { id: 'B', x0: 3, y0: 5, x1: 10, y1: 12 }], spawnZones: { T: { x0: 3, y0: 23, x1: 9, y1: 29 }, CT: { x0: 22, y0: 23, x1: 28, y1: 29 } } };
    const g = new Grid(map);
    const intel = new MapIntel(map, g);
    const perc = new Perception(g, intel, { ...data, map }, 0.5);
    perc.liveStart = 0;
    perc.myTeam = 'T';
    const judge = new Judgment(g, intel, perc, { ...data, map });
    const raw = fixture().m.observe(0);
    const obs = { ...raw, tick: 900, me: { ...raw.me, x: 16500, y: 19500, facing: 180 }, enemies: [], radar: [], enemiesAlive: 1 };
    const ahead = { x: 18500, y: 19500 };
    const first = judge.approach(obs, ahead);
    expect(first.look).not.toBeNull();
    expect(first.stop, JSON.stringify(first)).toBe(true);
    const ready = judge.approach({ ...obs, tick: 903, me: { ...obs.me, facing: angleTo(obs.me.x, obs.me.y, first.look!.x, first.look!.y) } }, ahead);
    expect(ready.stop).toBe(false);
    judge.reset();
    expect(judge.approach(obs, ahead)).toEqual(first);
    expect(judge.approach({ ...obs, enemiesAlive: 0 }, ahead).stop).toBe(false);
  });

  it('煙霧後方不能被標成已清空', () => {
    const { bot, m } = fixture();
    const p = bot.intel.sites.A.plants[0];
    const e = bot.intel.sites.A.entrances.find((q) => bot.g.los(p.x, p.y, q.ox, q.oy))!;
    const raw = m.observe(0);
    const d = dist(p.x, p.y, e.ox, e.oy);
    const smoke = { kind: 'smoke' as const, x: p.x + (e.ox - p.x) * 0.5, y: p.y + (e.oy - p.y) * 0.5, radius: Math.min(2500, d / 3), ticksLeft: 300 };
    const obs = { ...raw, me: { ...raw.me, x: p.x, y: p.y, facing: angleTo(p.x, p.y, e.ox, e.oy) }, teammates: [], enemies: [], radar: [], effects: [smoke] };
    bot.perc.update(obs);
    expect(bot.perc.cleared(bot.g.cellOf(e.ox, e.oy), obs.tick)).toBe(false);
  });

  it('剛有隊友陣亡的拾取路線先架角度；全滅後立即撤銷戒備', () => {
    const { bot, m } = fixture();
    const site = bot.intel.sites.A;
    const p = site.plants[0];
    const q = site.holds.find((h) => dist(p.x, p.y, h.x, h.y) > 3000 && bot.g.los(p.x, p.y, h.x, h.y))!;
    expect(q).toBeDefined();
    const raw = m.observe(0);
    const ahead = { x: p.x + (q.x - p.x) * 0.3, y: p.y + (q.y - p.y) * 0.3 };
    const obs = { ...raw, enemies: [], radar: [], teammates: [], me: { ...raw.me, x: p.x, y: p.y, facing: (angleTo(p.x, p.y, q.x, q.y) + 180) % 360 } };
    bot.perc.liveStart = 0;
    bot.perc.myTeam = 'T';
    bot.perc.anon.push({ ...ahead, src: 'death', tick: obs.tick, conf: 50 });
    const check = bot.judge!.approach(obs, ahead);
    expect(check.look).not.toBeNull();
    expect(check.stop).toBe(true);
    expect(check.look).not.toEqual(ahead);
    bot.judge!.checked.set(bot.g.cellOf(check.look!.x, check.look!.y), obs.tick + 60);
    expect(bot.judge!.approach({ ...obs, tick: obs.tick + 3 }, ahead).look).not.toBeNull();
    bot.perc.clearEnemies();
    expect(bot.judge!.approach({ ...obs, enemiesAlive: 0 }, ahead).stop).toBe(false);
  });
});

describe('Bot 2.3：守包的道具與撤離', () => {
  it('撤離途中拿狙擊槍看到敵人，也不會重新開鏡而減速', () => {
    const { bot, m } = fixture();
    const b = bot.intel.sites.B.plants[0];
    const p = bot.tactics.postSpots('B', b.x, b.y)[0];
    const raw = m.observe(0);
    const obs: ShooterObservation = { ...raw, teammates: [], enemiesAlive: 1, enemies: [{ id: 5, x: p.x + 10000, y: p.y, facing: 180, weapon: 'm4', crouching: false, planting: false, defusing: false, hasBomb: false, firing: true }], me: { ...raw.me, x: p.x, y: p.y, facing: 0, weapon: 'awp', scoped: false, ammoMag: 10, ammoReserve: 30, loadout: { ...raw.me.loadout, primary: 'awp' } }, bomb: { state: 'planted', site: 'B', x: b.x, y: b.y, ticksLeft: 120 } };
    const cmds = bot.decide(obs);
    expect(bot.why).toContain('炸彈撤離');
    expect(cmds.some((c) => c.type === 'move')).toBe(true);
    expect(cmds.some((c) => c.type === 'scope' && c.on)).toBe(false);
  });
  for (const mapId of ['redrock', 'dust']) {
    it(`${mapId}：多人同時準備守包煙，以喊話確認庫存並分到不同入口`, () => {
      const fixtures = [fixture(mapId, 0), fixture(mapId, 3)];
      const wishes = fixtures.map(({ bot, m }, index) => {
        const site = bot.intel.sites.B;
        const b = site.plants[0];
        const entries: typeof site.entrances = [];
        for (const e of [...site.entrances].sort((a, c) => a.ctDist - c.ctDist || a.portal - c.portal)) if (entries.every((p) => dist(p.ox, p.oy, e.ox, e.oy) >= 8000)) entries.push(e);
        expect(entries.length).toBeGreaterThanOrEqual(2);
        const e = entries[index];
        const p = site.holds.find((q) => bot.tactics.util.solve(q.x, q.y, e.ox, e.oy) !== null)!;
        expect(p).toBeDefined();
        const pid = index === 0 ? 0 : 3;
        const raw = m.observe(pid);
        const obs: ShooterObservation = { ...raw, bomb: { state: 'planted', x: b.x, y: b.y, site: 'B', ticksLeft: 1110 }, me: { ...raw.me, x: p.x, y: p.y, loadout: { ...raw.me.loadout, grenades: ['smoke'] } }, enemies: [], radar: [], chat: [{ from: index === 0 ? 3 : 0, text: 'E:smoker' }] };
        bot.tactics.readChat(obs);
        bot.tactics.readChat({ ...obs, tick: obs.tick + 12, chat: [] });
        const wish = bot.tactics.postUtility({ ...obs, tick: obs.tick + 12 }, b.x, b.y, 'B');
        expect(wish?.kind).toBe('smoke');
        return bot.tactics.util.solve(p.x, p.y, wish!.x, wish!.y)!;
      });
      expect(dist(wishes[0].x, wishes[0].y, wishes[1].x, wishes[1].y)).toBeGreaterThanOrEqual(6000);
    });
    it(`${mapId}：守包主動封入口煙，避開炸彈與既有煙；保留反拆燃燒`, () => {
      const { bot, m } = fixture(mapId);
      const site = bot.intel.sites.B;
      const b = site.plants[0];
      const entrance = [...site.entrances].sort((a, c) => a.ctDist - c.ctDist || a.portal - c.portal)[0];
      const spot = site.holds.find((p) => bot.tactics.util.solve(p.x, p.y, entrance.ox, entrance.oy) !== null)!;
      expect(spot).toBeDefined();
      const raw = m.observe(0);
      const obs: ShooterObservation = { ...raw, bomb: { state: 'planted', x: b.x, y: b.y, site: 'B', ticksLeft: 1110 }, enemies: [], radar: [], me: { ...raw.me, x: spot.x, y: spot.y, loadout: { ...raw.me.loadout, grenades: ['smoke', 'molotov'] } }, teammates: [] };
      const wish = bot.tactics.postUtility(obs, b.x, b.y, 'B');
      expect(wish?.kind).toBe('smoke');
      expect(dist(wish!.x, wish!.y, b.x, b.y)).toBeGreaterThan(5000);
      bot.tactics.smokes.push({ x: wish!.x, y: wish!.y, tick: obs.tick, by: 0 });
      expect(bot.tactics.postUtility(obs, b.x, b.y, 'B')).toBeNull();
      const fireObs = { ...obs, bomb: { ...obs.bomb, state: 'defusing' as const } };
      const fire = bot.tactics.postPlant(fireObs, output(), b.x, b.y, 'B');
      expect(fire?.kind).toBe('molotov');
      bot.tactics.burns.push({ x: b.x, y: b.y, until: m.tick + 210 });
      expect(bot.tactics.postPlant(fireObs, output(), b.x, b.y, 'B')).toBeNull();
    });

    it(`${mapId}：不可新開拆的倒數會撤離；近期拆包聲仍須反制，安全時間不提早跑掉`, () => {
      const { bot, m } = fixture(mapId);
      const b = bot.intel.sites.B.plants[0];
      const p = bot.intel.sites.B.holds[0];
      const raw = m.observe(0);
      const obs = { ...raw, enemies: [], radar: [], teammates: [], me: { ...raw.me, x: p.x, y: p.y }, bomb: { state: 'planted' as const, site: 'B' as const, x: b.x, y: b.y, ticksLeft: 120 } };
      const out = output();
      bot.tactics.postPlant(obs, out, b.x, b.y, 'B');
      expect(out.escape).toBe(true);
      expect(dist(out.goal!.x, out.goal!.y, b.x, b.y)).toBeGreaterThanOrEqual(22000);
      const early = output();
      bot.tactics.postPlant({ ...obs, bomb: { ...obs.bomb, ticksLeft: 900 } }, early, b.x, b.y, 'B');
      expect(early.escape).toBe(false);
      bot.perc.lastSound = { ox: p.x, oy: p.y, dir: 0, r0: 0, r1: 12, tick: obs.tick, conf: 40, kind: 'defuse' };
      const alarm = output();
      bot.tactics.postPlant(obs, alarm, b.x, b.y, 'B');
      expect(alarm.escape).toBe(false);
      bot.perc.lastSound = null;
      const remembered = output();
      bot.tactics.postPlant({ ...obs, tick: obs.tick + 36 }, remembered, b.x, b.y, 'B');
      expect(remembered.escape).toBe(false);
    });
  }
});
