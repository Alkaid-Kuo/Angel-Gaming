import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileBot } from '../src/sandbox/compile.ts';
import type ShooterBaseline from '../bots/shooter-src/baseline.js';
import { Adaptation, type RoundSample } from '../bots/shooter-src/adaptation.js';
import { dist, segDist } from '../bots/shooter-src/base.js';
import type { TacOut, TPlan } from '../bots/shooter-src/tactics.js';
import type { MapInfo, ShooterInitData, ShooterObservation } from '../src/shooter/api.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { shooterHelpers } from '../src/shooter/runner.ts';

type Fixture = { match: ShooterMatch; bot: ShooterBaseline; data: ShooterInitData; obs: ShooterObservation };
const production = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline-2.4');
function fixture(mapId = 'redrock', pid = 0, corner = false): Fixture {
  const map = MAPS[mapId]();
  const match = new ShooterMatch({ seed: 11, mapId });
  match.tick = 600;
  match.phase = 'live';
  match.phaseEnd = 3600;
  const base = shooterInitData(map, pid, {});
  let info = base.map;
  if (corner) {
    const solid = Array<number>(32 * 32).fill(0);
    for (let i = 0; i < solid.length; i++) if (i % 32 === 0 || i % 32 === 31 || i < 32 || i >= 31 * 32) solid[i] = 1;
    for (let y = 1; y < 19; y++) solid[y * 32 + 16] = 1;
    info = { ...base.map, id: 'cognition-corner', width: 32, height: 32, solid, regions: [{ id: 'left', name: '左', x0: 1, y0: 1, x1: 16, y1: 31 }, { id: 'right', name: '右', x0: 16, y0: 1, x1: 31, y1: 31 }], sites: [{ id: 'A', x0: 20, y0: 5, x1: 28, y1: 12 }, { id: 'B', x0: 3, y0: 5, x1: 10, y1: 12 }], spawnZones: { T: { x0: 3, y0: 23, x1: 9, y1: 29 }, CT: { x0: 22, y0: 23, x1: 28, y1: 29 } } } satisfies MapInfo;
  }
  const data = { ...base, map: info };
  const Bot = production.createClass() as unknown as typeof ShooterBaseline;
  const bot = new Bot();
  bot.init(data, shooterHelpers(map, 11, pid));
  const raw = match.observe(pid);
  const obs: ShooterObservation = { ...raw, teammates: raw.teammates.map((m) => ({ ...m, alive: false })), enemies: [], radar: [], sounds: [], effects: [], tracers: [], enemiesAlive: 1, me: { ...raw.me, hasBomb: false, blindTicks: 0, facing: 90, ...(corner ? { x: 6500, y: 26500 } : {}) } };
  bot.newRound(obs);
  return { match, bot, data, obs };
}
const output = (task: TacOut['task'] = 'hold'): TacOut => ({ goal: null, route: null, hold: null, objective: false, allowPeek: true, cmds: [], role: '測試', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false, task });
const lost = (obs: ShooterObservation, tick: number): ShooterObservation => ({ ...obs, tick, radar: [], enemies: [] });

describe('Bot 2.4：敵情推斷的範圍與反證', () => {
  it('失聯後沿通路擴展；不能以直線距離穿牆，到得了才納入牆另一側', () => {
    const { bot, obs } = fixture('redrock', 0, true);
    bot.perc.update({ ...obs, radar: [{ id: 5, x: 14500, y: 10500 }] });
    bot.perc.update(lost(obs, 630));
    const near = bot.g.cellOf(13500, 10500);
    const behind = bot.g.cellOf(18500, 10500);
    expect(bot.perc.belief.tracks.get(5)?.cells.has(near)).toBe(true);
    expect(bot.perc.belief.tracks.get(5)?.cells.has(behind)).toBe(false);
    bot.perc.update(lost(obs, 765));
    expect(bot.perc.belief.tracks.get(5)?.cells.has(behind)).toBe(true);
    expect([...bot.perc.belief.regions].reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(1.00001);
  });

  it('剛確認空的格縮小候選範圍；舊掃描不能永久禁止重新進入', () => {
    const { bot, obs } = fixture('redrock', 0, true);
    bot.perc.update({ ...obs, radar: [{ id: 5, x: 14500, y: 10500 }] });
    const cell = bot.g.cellOf(13500, 10500);
    bot.perc.seenTick[cell] = 630;
    bot.perc.update(lost(obs, 630));
    expect(bot.perc.belief.tracks.get(5)?.cells.has(cell)).toBe(false);
    bot.perc.update(lost(obs, 660));
    expect(bot.perc.belief.tracks.get(5)?.cells.has(cell)).toBe(true);
  });

  it('煙後保持未知，煙散後確認空才排除；重新接敵立即收斂', () => {
    const { bot, obs } = fixture('redrock', 0, true);
    const visible = { ...obs, me: { ...obs.me, x: 10500, y: 10500, facing: 0 } };
    bot.perc.update({ ...visible, radar: [{ id: 5, x: 14500, y: 10500 }] });
    const cell = bot.g.cellOf(14500, 10500);
    bot.perc.update({ ...lost(visible, 630), effects: [{ kind: 'smoke', x: 12500, y: 10500, radius: 1200, ticksLeft: 300 }] });
    expect(bot.perc.belief.tracks.get(5)?.cells.has(cell)).toBe(true);
    bot.perc.update(lost(visible, 660));
    expect(bot.perc.belief.tracks.get(5)?.cells.has(cell)).toBe(false);
    bot.perc.update({ ...visible, tick: 663, radar: [{ id: 5, x: 13500, y: 10500 }] });
    expect(bot.perc.belief.tracks.get(5)?.cells.size).toBe(0);
    expect(bot.perc.belief.points.some((p) => p.id === 5)).toBe(false);
  });

  it('失聯信心衰減、過期清除、敵人全滅立即清除；從不加入可見敵人', () => {
    const { bot, obs } = fixture('redrock', 0, true);
    bot.perc.update({ ...obs, radar: [{ id: 5, x: 14500, y: 10500 }] });
    const first = lost(obs, 630);
    bot.perc.update(first);
    const risk = Math.max(...bot.perc.belief.risk);
    bot.perc.update(lost(obs, 690));
    expect(Math.max(...bot.perc.belief.risk)).toBeLessThan(risk);
    expect(first.enemies).toEqual([]);
    bot.perc.update(lost(obs, 795));
    expect(bot.perc.belief.tracks.size).toBe(0);
    bot.perc.update({ ...obs, tick: 810, radar: [{ id: 5, x: 14500, y: 10500 }] });
    bot.perc.update({ ...lost(obs, 840), enemiesAlive: 0 });
    expect(bot.perc.belief.tracks.size).toBe(0);
    expect(Math.max(...bot.perc.belief.risk)).toBe(0);
  });
});

describe('Bot 2.4：任務期限與中斷', () => {
  it('凍結階段的倒數屬準備時間，不能被當成下包期限而改走緊急路線', () => {
    const { bot, obs } = fixture();
    const out = output('plant'); out.goal = bot.intel.sites.A.plants[0]; out.stop = true;
    bot.mission!.assess({ ...obs, round: { ...obs.round, phase: 'freeze', phaseTicksLeft: 30 } }, out);
    expect(out.commit).toBe(false); expect(out.stop).toBe(true);
  });
  it('普通任務維持戒備；逼近期限才取消額外等待，期限解除後恢復', () => {
    const { bot, obs } = fixture('redrock', 0, true);
    const goal = { x: 10500, y: 26500 };
    const a = output('retrieve'); a.goal = goal; a.stop = true;
    bot.mission!.assess(obs, a);
    expect(a.commit).toBe(false);
    expect(a.stop).toBe(true);
    const urgent = { ...obs, round: { ...obs.round, phaseTicksLeft: 210 } };
    const b = output('retrieve'); b.goal = goal; b.stop = true;
    bot.mission!.assess(urgent, b);
    expect(b.commit).toBe(true);
    expect(b.stop).toBe(false);
    expect(b.allowPeek).toBe(false);
    bot.mission!.assess(obs, a);
    expect(a.commit).toBe(false);
    expect(bot.mission!.changes).toBe(1);
  });

  it('任務路程計入繞牆，離目標直線很近也不能低估回防時間', () => {
    const { bot, obs } = fixture('redrock', 0, true);
    const me = { ...obs.me, x: 14500, y: 10500, weapon: 'ak' as const };
    const goal = { x: 18500, y: 10500 };
    expect(bot.judge!.travel(me, goal.x, goal.y)).toBeGreaterThan(4);
    const out = output('defuse'); out.goal = goal;
    bot.mission!.assess({ ...obs, me, bomb: { state: 'planted', site: 'A', ...goal, ticksLeft: 510 } }, out);
    expect(out.commit).toBe(true);
  });

  for (const mapId of ['redrock', 'dust']) {
    it(`${mapId}：下包期限壓力能中斷狙擊槍對消失目標的等待，仍不盲射`, () => {
      const { bot, obs } = fixture(mapId);
      const plant = bot.intel.sites.A.plants[0];
      const hold = bot.intel.sites.A.entrances.find((p) => !bot.tactics.inRectSite(p.ox, p.oy, 'A'))!;
      expect(hold).toBeDefined();
      const next: ShooterObservation = { ...obs, me: { ...obs.me, x: hold.ox, y: hold.oy, hasBomb: true, weapon: 'awp', loadout: { ...obs.me.loadout, primary: 'awp', grenades: [] }, ammoMag: 10 }, round: { ...obs.round, phaseTicksLeft: 150 } };
      bot.tactics.setPlan({ kind: 'rush', site: 'A', r1: 0, r2: 0, exec: 'A' }, next);
      bot.combat.lostPos = plant; bot.combat.lostTick = next.tick;
      const cmds = bot.decide(next);
      expect(bot.mission!.critical).toBe(true);
      expect(cmds.some((c) => c.type === 'move')).toBe(true);
      expect(cmds.some((c) => c.type === 'fire' && c.on)).toBe(false);
      expect(cmds.some((c) => c.type === 'scope' && c.on)).toBe(false);
    });
  }

  it('保槍可因局勢改善而取消，不會被上一個決定永久鎖住', () => {
    const { bot, obs } = fixture('redrock', 5);
    const p = bot.intel.sites.A.plants[0];
    const next: ShooterObservation = { ...obs, me: { ...obs.me, x: p.x, y: p.y, loadout: { ...obs.me.loadout, kit: true } }, bomb: { state: 'planted', site: 'A', ...p, ticksLeft: 600 } };
    bot.tactics.saving = true;
    const out = output();
    bot.tactics.retake(next, out, { kind: 'hold', a: 2, m: 1, b: 2, rot: 'A', go: true }, p.x, p.y, 'A');
    expect(bot.tactics.saving).toBe(false);
    expect(out.task).toBe('defuse');
  });
  it('接敵失聯不能當成空點撤銷輪轉，可靠清點後才解除', () => {
    const { bot, obs } = fixture('redrock', 5);
    const plan = { kind: 'hold' as const, a: 2, m: 1, b: 2, rot: 'A' as const, go: false };
    bot.tactics.rotSince = obs.tick - 300;
    expect(bot.tactics.leadCT(obs, plan).rot).toBe('A');
    for (let i = 0; i < bot.g.N; i++) if (bot.intel.sites.A.regions.has(bot.intel.region[i])) bot.perc.seenTick[i] = obs.tick;
    expect(bot.tactics.leadCT(obs, plan).rot).toBeNull();
  });

  it('隊友已拆了九秒且剩兩秒，會留下掩護而不把整段拆包時間重新算一次', () => {
    const { bot, obs } = fixture('redrock', 5);
    const p = bot.intel.sites.A.plants[0];
    const mates = obs.teammates.map((m) => ({ ...m, alive: m.id === 6, x: p.x, y: p.y, defusing: m.id === 6 }));
    const first = { ...obs, teammates: mates };
    bot.tactics.trackTeam(first, output());
    const next: ShooterObservation = { ...first, tick: 870, me: { ...first.me, x: p.x + 3000, y: p.y }, bomb: { state: 'defusing', site: 'A', ...p, ticksLeft: 60 } };
    bot.tactics.trackTeam(next, output());
    const out = output();
    bot.tactics.retake(next, out, { kind: 'hold', a: 2, m: 1, b: 2, rot: 'A', go: true }, p.x, p.y, 'A');
    expect(out.task).toBe('cover');
    expect(bot.tactics.saving).toBe(false);
  });
  it('自己正在拆也會重評：確定拆不完便中止，仍可完成則繼續', () => {
    const { bot, obs } = fixture('redrock', 5);
    const p = bot.intel.sites.A.plants[0];
    const next: ShooterObservation = { ...obs, me: { ...obs.me, x: p.x, y: p.y, defuseTicks: 60, loadout: { ...obs.me.loadout, kit: true } }, bomb: { state: 'defusing', site: 'A', ...p, ticksLeft: 30 } };
    const plan = { kind: 'hold' as const, a: 2, m: 1, b: 2, rot: 'A' as const, go: true };
    const a = output(); a.objective = true;
    bot.tactics.retake(next, a, plan, p.x, p.y, 'A');
    expect(a.task).toBe('save'); expect(a.objective).toBe(false);
    const b = output(); b.objective = true;
    bot.tactics.retake({ ...next, me: { ...next.me, defuseTicks: 130 }, bomb: { ...next.bomb, ticksLeft: 40 } }, b, plan, p.x, p.y, 'A');
    expect(b.task).toBe('defuse'); expect(b.objective).toBe(true);
  });
  it('期限導航仍避開看得到的火區，期限解除後恢復一般路線成本', () => {
    const { bot, obs } = fixture('redrock', 0, true);
    bot.nav.setGoal(12500, 26500);
    const fire = bot.g.cellOf(9500, 26500);
    bot.nav.hazard.add(fire);
    bot.nav.step(obs, { allowPeek: false, speed: 130, evading: false, priority: true });
    expect(bot.nav.path).not.toContain(fire);
    const plans = bot.nav.replans;
    bot.nav.step({ ...obs, tick: 603 }, { allowPeek: false, speed: 130, evading: false, priority: false });
    expect(bot.nav.replans).toBeGreaterThan(plans);
    expect(bot.nav.priority).toBe(false);
  });
});

describe('Bot 2.4：團隊跟進、補槍與守角', () => {
  function contact(): Fixture {
    const f = fixture('redrock', 0, true);
    const obs: ShooterObservation = { ...f.obs, me: { ...f.obs.me, x: 7500, y: 23500 }, teammates: f.obs.teammates.map((m) => ({ ...m, alive: m.id === 1, x: 11500, y: 23500, facing: 270, firing: m.id === 1, hasBomb: false })), radar: [{ id: 5, x: 11500, y: 15500 }] };
    f.bot.perc.update(obs); f.bot.tactics.coop.observe(obs);
    return { ...f, obs };
  }
  it('最近的空閒隊員跟進接戰，站到側面支援而不踏入隊友射線', () => {
    const { bot, obs } = contact();
    const out = output('execute'); out.goal = { x: 11500, y: 15500 };
    bot.tactics.coop.apply(obs, out);
    expect(out.role).toContain('跟進掩護');
    expect(out.goal).not.toBeNull();
    expect(segDist(out.goal!.x, out.goal!.y, 11500, 23500, 11500, 15500).d).toBeGreaterThanOrEqual(1100);
    expect(out.look).toEqual(expect.objectContaining({ x: 11500, y: 15500 }));
    expect(out.cmds).toEqual([]);
  });
  it('隊友死亡後短時間內接替補槍，線索過期就恢復原任務', () => {
    const { bot, obs } = contact();
    const dead = { ...lost(obs, 603), teammates: obs.teammates.map((m) => ({ ...m, alive: false, firing: false })) };
    bot.perc.update(dead); bot.tactics.coop.observe(dead);
    const out = output('execute'); bot.tactics.coop.apply(dead, out);
    expect(out.role).toContain('補槍接替');
    bot.tactics.coop.observe(lost(dead, 690));
    const later = output('execute'); bot.tactics.coop.apply(lost(dead, 690), later);
    expect(later.role).toBe('測試');
  });
  it('有更近的接替者或正在趕任務時，不把多人一起拉去補槍', () => {
    const { bot, obs } = contact();
    const others = { ...obs, teammates: obs.teammates.map((m) => m.id === 2 ? { ...m, alive: true, x: 9500, y: 23500, firing: false } : m) };
    const out = output('execute'); out.goal = { x: 6500, y: 10500 };
    bot.tactics.coop.apply(others, out);
    expect(out.goal).toEqual({ x: 6500, y: 10500 });
    out.commit = true;
    bot.tactics.coop.apply(obs, out);
    expect(out.role).toBe('測試');
  });
  it('沒有可信接敵或彈道時不按死亡位置假造射擊目標', () => {
    const { bot, obs } = contact();
    bot.perc.known.clear();
    const out = output('execute'); out.goal = { x: 6500, y: 10500 };
    bot.tactics.coop.apply({ ...obs, radar: [], tracers: [] }, out);
    expect(out.role).toBe('測試');
    expect(out.look).toBeNull();
  });
  for (const mapId of ['redrock', 'dust']) {
    it(`${mapId}：兩個守點者分配不同可見入口，重複觀察不互換角度`, () => {
      const { bot, obs } = fixture(mapId);
      const pair = Object.values(bot.intel.sites).flatMap((s) => s.holds.flatMap((p) => {
        const visible = s.entrances.filter((e) => bot.g.los(p.x, p.y, e.ox, e.oy)).sort((a, b) => dist(p.x, p.y, a.ox, a.oy) - dist(p.x, p.y, b.ox, b.oy));
        if (visible.length === 0) return [];
        const q = s.holds.find((h) => dist(p.x, p.y, h.x, h.y) >= 1500 && dist(p.x, p.y, h.x, h.y) < 16000 && s.entrances.some((e) => e.portal !== visible[0].portal && bot.g.los(h.x, h.y, e.ox, e.oy)));
        return q === undefined ? [] : [{ p, q }];
      }))[0];
      expect(pair).toBeDefined();
      const { p, q } = pair;
      const mate = obs.teammates[0];
      const aObs = { ...obs, tick: 630, me: { ...obs.me, x: p.x, y: p.y }, teammates: [{ ...mate, alive: true, x: q.x, y: q.y, blind: false, planting: false, defusing: false }] };
      const a = output(); a.hold = p; bot.tactics.coop.apply(aObs, a);
      const bObs = { ...aObs, me: { ...aObs.me, id: mate.id, x: q.x, y: q.y }, teammates: [{ ...mate, id: obs.me.id, x: p.x, y: p.y, alive: true }] };
      const b = output(); b.hold = q; bot.tactics.coop.apply(bObs, b);
      expect(a.look).not.toBeNull(); expect(b.look).not.toBeNull();
      expect(a.look).not.toEqual(b.look);
      const again = output(); again.hold = p;
      bot.tactics.coop.apply({ ...aObs, teammates: aObs.teammates.map((m) => ({ ...m, facing: (m.facing + 180) % 360 })) }, again);
      expect(again.look).toEqual(a.look);
      const scan = output(); scan.hold = p;
      bot.tactics.coop.apply({ ...aObs, tick: 660 }, scan);
      expect(scan.look).toBeNull();
    });
  }
  it('突破手死亡後，存活組員的第一人接手進場道具職責', () => {
    const { bot, obs } = fixture();
    const plan: TPlan = { kind: 'split', site: 'A', r1: 0, r2: 1, exec: 'A' };
    const full = { ...obs, teammates: obs.teammates.map((m) => ({ ...m, alive: true, hasBomb: m.id === 2 })) };
    bot.tactics.groupOf(full, 1, plan);
    const next = { ...full, me: { ...full.me, id: 1 }, teammates: [{ ...full.teammates[0], id: 0, alive: false }, ...full.teammates.filter((m) => m.id !== 1)] };
    expect(bot.tactics.memberIndex(next, 1, plan)).toBe(0);
  });
});

describe('Bot 2.4：跨回合學習與反應式佯攻', () => {
  const sample = (site: 'A' | 'B', team: 'T' | 'CT' = 'CT'): RoundSample => ({ team, site, fast: true, plan: 'rush', won: true, rotated: null });
  it('至少三回合才調整、樣本按時間衰減，換邊模型隔離', () => {
    const a = new Adaptation();
    a.history = [sample('A'), sample('A')];
    expect(a.advice('CT').A).toBe(0);
    a.history.push(sample('A'));
    expect(a.advice('CT').A).toBe(1);
    expect(a.advice('T').evidence).toBe(0);
    a.history.push(...Array.from({ length: 5 }, () => sample('B')));
    expect(a.advice('CT').B).toBeGreaterThan(a.advice('CT').A);
    expect(a.advice('CT').plans.rush).toBeLessThanOrEqual(1.25);
  });
  it('一個回合只記一次、未知不記成快攻，重新開場不繼承其他場次記憶', () => {
    const { obs } = fixture();
    const a = new Adaptation(); a.begin(obs, null);
    a.begin({ ...obs, round: { ...obs.round, number: obs.round.number + 1 } }, true);
    a.begin({ ...obs, round: { ...obs.round, number: obs.round.number + 1 } }, true);
    expect(a.history.length).toBe(1);
    expect(a.history[0].fast).toBeNull();
    expect(a.history[0].site).toBeNull();
    expect(new Adaptation().history).toEqual([]);
  });
  it('沒有看到進攻點的回合，不湊成守點偏好的證據門檻', () => {
    const a = new Adaptation();
    a.history = [sample('A'), { ...sample('A'), site: null, fast: null }, { ...sample('A'), site: null, fast: null }];
    expect(a.advice('CT').evidence).toBe(1);
  });
  for (const mapId of ['redrock', 'dust']) {
    it(`${mapId}：確認敵人被誘到另一點後，提早執行原主攻點`, () => {
      const { bot, obs } = fixture(mapId);
      const p: TPlan = { kind: 'fake', site: 'A', r1: 0, r2: 0, exec: null };
      const a = bot.intel.sites.A.plants[0], b = bot.intel.sites.B.plants[0];
      const first = { ...obs, radar: [{ id: 5, ...a }, { id: 6, ...a }], enemiesAlive: 2 };
      bot.perc.update(first); bot.tactics.adapt.observe(first, bot.perc, (c) => bot.tactics.siteNear(c));
      expect(bot.tactics.adapt.fake(first, bot.perc, p, false)).toBeNull();
      const next = { ...first, tick: 660, radar: [{ id: 5, ...b }, { id: 6, ...b }] };
      bot.perc.update(next); bot.tactics.adapt.observe(next, bot.perc, (c) => bot.tactics.siteNear(c));
      expect(bot.tactics.adapt.fake(next, bot.perc, p, false)).toBe('A');
      expect(bot.tactics.adapt.sample?.rotated).toBe(true);
    });
    it(`${mapId}：主攻點確認多人、佯攻組實際探入空點時可以轉打；只有聲音不觸發`, () => {
      const { bot, obs } = fixture(mapId);
      const p: TPlan = { kind: 'fake', site: 'A', r1: 0, r2: 0, exec: null };
      bot.tactics.adapt.fake(obs, bot.perc, p, false);
      const a = bot.intel.sites.A.plants[0];
      const next = { ...obs, tick: 660, radar: [{ id: 5, ...a }, { id: 6, ...a }], enemiesAlive: 2 };
      bot.perc.update(next);
      expect(bot.tactics.adapt.fake(next, bot.perc, p, false)).toBeNull();
      expect(bot.tactics.adapt.fake(next, bot.perc, p, true)).toBe('B');
    });
  }
  it('沒有可信反應時，佯攻仍在原定期限結束等待', () => {
    const { bot, obs } = fixture();
    const p: TPlan = { kind: 'fake', site: 'A', r1: 0, r2: 0, exec: null };
    bot.tactics.liveStart = obs.tick - 1800;
    expect(bot.tactics.leadT(obs, p).exec).toBe('A');
  });
  it('換邊時仍從公開比分確認上一回合結果，記在原陣營模型', () => {
    const { bot, obs } = fixture();
    const a = new (bot.tactics.adapt.constructor as typeof Adaptation)();
    a.begin({ ...obs, me: { ...obs.me, team: 'CT' }, round: { ...obs.round, number: 6, scoreCT: 3, scoreT: 2 } }, null);
    a.begin({ ...obs, me: { ...obs.me, team: 'T' }, round: { ...obs.round, number: 7, half: 2, scoreT: 4, scoreCT: 2 } }, null);
    expect(a.history).toEqual([expect.objectContaining({ team: 'CT', won: true })]);
    expect(a.sample?.team).toBe('T');
  });
  it('佯攻組會實際試探空入口；確認受阻時取消試探', () => {
    const { bot, obs } = fixture('redrock', 3);
    const plan: TPlan = { kind: 'fake', site: 'A', r1: 0, r2: 0, exec: null };
    const full: ShooterObservation = { ...obs, teammates: obs.teammates.map((m) => ({ ...m, alive: true, hasBomb: m.id === 0 })) };
    bot.tactics.setPlan(plan, full);
    const stage = bot.tactics.memberStage(full, 3, plan)!;
    const next = { ...full, me: { ...full.me, x: stage.x, y: stage.y } };
    bot.tactics.stageArrive = obs.tick - 60;
    const out = output(); bot.tactics.tGoal(next, out);
    expect(out.role).toBe('佯攻試探');
    expect(out.goal).toEqual(bot.intel.sites.B.plants[0]);
    const enemy = bot.intel.sites.B.plants[0];
    bot.perc.update({ ...next, radar: [{ id: 5, ...enemy }, { id: 6, ...enemy }], enemiesAlive: 2 });
    const blocked = output(); bot.tactics.tGoal(next, blocked);
    expect(bot.tactics.fakeProbe).toBe(false);
    expect(blocked.role).toBe('佯攻');
  });
});

describe('Bot 2.4：同樣觀察的確定性', () => {
  it('相同初始條件與觀察序列，推斷、任務及指令完全一致', () => {
    const a = fixture(), b = fixture();
    for (let tick = 600; tick <= 690; tick += 3) {
      const obs = { ...a.obs, tick };
      expect(a.bot.decide(obs)).toEqual(b.bot.decide(obs));
      expect(a.bot.why).toBe(b.bot.why);
    }
  });
});
