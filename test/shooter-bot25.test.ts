import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileBot } from '../src/sandbox/compile.ts';
import type ShooterBaseline from '../bots/shooter-src/baseline.js';
import type { TPlan } from '../bots/shooter-src/tactics.js';
import { P, UNIT, dist } from '../bots/shooter-src/base.js';
import { ENTRY } from '../bots/shooter-src/roles.js';
import { parseEvent } from '../bots/shooter-src/tactics.js';
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

describe('Bot 2.5 第二批：背身與槍線', () => {
  it('挨打時先轉向來源，近處聲音在視野外也轉；視野內的聲音不搶行進預瞄', () => {
    const f = live(0);
    const me = f.match.players[0];
    const obs = f.match.observe(0);
    f.bot.perc.update({ ...obs, me: { ...obs.me, hurt: [{ tick: obs.tick, dirDeg: 90 }] } });
    const a = f.bot.combat.alert(obs, false);
    expect(a?.y).toBeGreaterThan(me.y);
    const g = live(0);
    const o2 = g.match.observe(0);
    const sound = (dirDeg: number): ReturnType<typeof g.match.observe>['sounds'][number] => ({ kind: 'footstep' as const, dirDeg, range: 'near' as const, weapon: null, friendly: false });
    const facing = Math.round(o2.me.facing);
    g.bot.perc.update({ ...o2, sounds: [sound(facing)] });
    expect(g.bot.combat.alert(o2, false)).toBeNull();
  });

  it('隊友剛死的地方在前方：停下看著那裡，時間到就走，不無限等', () => {
    const f = live(1);
    const obs = f.match.observe(1);
    const t = f.bot.tactics;
    const me = obs.me;
    f.match.players[1].grenades = [];
    const clean = f.match.observe(1);
    f.bot.nav.wps = [{ x: me.x + 10 * UNIT, y: me.y }];
    f.bot.nav.wpIdx = 0;
    f.bot.perc.anon.push({ x: me.x + 5 * UNIT, y: me.y, tick: obs.tick, conf: 50, src: 'death' });
    const out = (): Parameters<typeof t.lineCheck>[1] => ({ goal: { x: me.x + 20 * UNIT, y: me.y }, route: null, hold: null, objective: false, allowPeek: false, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false });
    const a = out();
    t.lineCheck(clean, a);
    expect(a.stop).toBe(true);
    expect(a.look?.x).toBe(me.x + 5 * UNIT);
    t.lineHeld = P.lineHold * 30;
    const b = out();
    t.lineCheck(clean, b);
    expect(b.stop).toBe(false);
  });

  it('看到狙擊手的喊話解析得出來；狙擊線蓋住主力入口就換一條沒被蓋的路線', () => {
    expect(parseEvent('E:awp 123 456')).toEqual({ kind: 'awp', x: 12300, y: 45600 });
    const f = live(0);
    const t = f.bot.tactics;
    const obs = f.match.observe(0);
    for (const s of ['A', 'B'] as const) {
      const ent = t.entranceOf(s, 0);
      if (ent === null) throw new Error('沒有入口');
      const hold = bot2Hold(f, s, ent.portal);
      if (hold === undefined) continue;
      t.dodged = false;
      t.awp = { x: hold.x, y: hold.y, tick: obs.tick };
      const plan: TPlan = { kind: 'rush', site: s, r1: 0, r2: 0, exec: s };
      const next = t.dodgeLine(obs, plan);
      if (next === plan) continue;
      expect(t.entranceOf(s, next.r1)?.portal).not.toBe(ent.portal);
      expect(t.covers(t.awp, t.entranceOf(s, next.r1))).toBe(false);
      return;
    }
    throw new Error('兩個點都換不了路');
  });
});

function bot2Hold(f: { bot: ShooterBaseline }, s: 'A' | 'B', portal: number): ShooterBaseline['intel']['sites']['A']['holds'][number] | undefined {
  const site = f.bot.intel.sites[s];
  return site.holds.find((h) => site.entrances[h.entrance]?.portal === portal);
}

describe('Bot 2.5 第二批：道具與 eco', () => {
  it('閃光致盲距離照引擎：半徑外不致盲', () => {
    const f = live(0);
    expect(f.bot.tactics.util.blindRange).toBe(f.bot.tactics.util.flashRadius);
  });

  it('eco 只打一個點：不抽 default、fake', () => {
    const f = live(0);
    const obs = f.match.observe(0);
    f.bot.tactics.buyCall = 'eco';
    const kinds = new Set(Array.from({ length: 200 }, () => f.bot.tactics.chooseT(obs).kind));
    expect([...kinds].sort()).toEqual(['rush', 'split']);
  });

});

describe('Bot 2.5 第二批：站位', () => {
  it('中路守位依回合小幅變化，變化後仍看得到原本的目標', () => {
    const { bot } = make(5);
    const seen = new Set<number>();
    for (let round = 1; round <= 24; round++) {
      for (const s of bot.tactics.midSpots()) {
        const v = bot.tactics.varySpot(s, round);
        seen.add(v.cell);
        expect(bot.g.los(v.x, v.y, v.fx, v.fy)).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('T 待命位看的是看得到的走道，不是牆後的入口', () => {
    const { bot } = make(0);
    for (const s of ['A', 'B'] as const) {
      bot.intel.routes.T[s].forEach((_, i) => {
        for (const p of bot.tactics.stageSpots('T', s, i)) {
          const ent = bot.intel.sites[s].entrances[p.entrance];
          if (p.fx !== ent.x || p.fy !== ent.y) expect(bot.g.los(p.x, p.y, p.fx, p.fy)).toBe(true);
        }
      });
    }
  });
});

describe('Bot 2.5 第三批：經濟', () => {
  /** CT（5～9 號）每人同樣的錢、上回合買法、輸過一場（下回合補償 1900） */
  const call = (money: number, prev: 'eco' | 'force' | null): string => {
    const f = live(5);
    for (let k = 5; k < 10; k++) f.match.players[k].money = money;
    const e = f.bot.tactics.econ;
    e.roundInHalf = 5;
    e.lastWon = false;
    e.lossLevel = 1;
    e.prevCall = prev;
    return e.teamCall(f.match.observe(5));
  };

  it('CT 全買門檻：拆彈器算兩人份、閃光算一半人，每人 4100 就全買（舊算法要 4350）', () => {
    expect(call(4100, null)).toBe('full');
  });

  it('連續 eco 最多一回合：上回合 eco，平均還有 1500 就 force；不到 1500 才再 eco', () => {
    expect(call(2200, null)).toBe('eco');
    expect(call(2200, 'eco')).toBe('force');
    expect(call(1600, 'eco')).toBe('force');
    expect(call(1200, 'eco')).toBe('eco');
  });

  it('平均 3500 以上（差一點全買）直接 force，不存錢', () => {
    expect(call(3600, null)).toBe('force');
  });
});

describe('Bot 2.5 第三批：CT 守法', () => {
  it.each(['redrock', 'dust'])('%s：深位看得到 T 主要兩個入口、都在閃光半徑外，兩個入口同時在視野內', (mapId) => {
    const { bot } = make(5, mapId);
    const R = bot.tactics.util.flashRadius;
    for (const s of ['A', 'B'] as const) {
      const deep = bot.tactics.deepSpots(s);
      expect(deep.length).toBeGreaterThanOrEqual(2);
      const top = bot.intel.sites[s].entrances.slice(0, 2);
      for (const d of deep) {
        for (const e of top) {
          expect(bot.g.los(d.x, d.y, e.x, e.y)).toBe(true);
          expect(dist(d.x, d.y, e.x, e.y)).toBeGreaterThan(R);
        }
      }
    }
  });

  it('兩人守點都在深位、依回合換組合，全隊算出來一樣', () => {
    const { bot } = make(5);
    const seen = new Set<number>();
    for (let round = 1; round <= 24; round++) {
      const a = bot.tactics.pickHolds('A', 2, round);
      expect(a.map((s) => s.cell)).toEqual(make(6).bot.tactics.pickHolds('A', 2, round).map((s) => s.cell));
      for (const s of a) {
        expect(bot.tactics.deepSpots('A')).toContain(s);
        seen.add(s.cell);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('道具先拖時間：入口外有人先燒，火快熄或兩人以上再封煙；閃光要有隊友看著入口才丟', () => {
    const f = live(5);
    const t = f.bot.tactics;
    const site = f.bot.intel.sites.A;
    const ent = site.entrances[0];
    const hold = site.holds.find((h) => h.entrance === 0) ?? site.holds[0];
    const plan = t.chooseCT();
    t.plan = plan;
    f.match.teleport(5, hold.x, hold.y);
    const obs = f.match.observe(5);
    const known = (id: number, dy: number): Parameters<typeof f.bot.perc.known.set>[1] => ({ id, x: ent.ox + (ent.ox - ent.ix), y: ent.oy + (ent.oy - ent.iy) + dy, vx: 0, vy: 0, facing: 0, weapon: 'ak', tick: obs.tick, seenTick: obs.tick, conf: 100, src: 'see' as const });
    f.match.players[5].grenades = ['incendiary', 'smoke'];
    const o1 = f.match.observe(5);
    expect(t.ctUtility(o1, plan, 'A')).toBeNull();
    f.bot.perc.known.set(0, known(0, 0));
    const burn = t.ctUtility(o1, plan, 'A');
    expect(burn?.kind).toBe('incendiary');
    t.burns.push({ x: burn?.x ?? 0, y: burn?.y ?? 0, until: obs.tick + 6 * 30 });
    expect(t.ctUtility(o1, plan, 'A')).toBeNull();
    f.bot.perc.known.set(1, known(1, 500));
    expect(t.ctUtility(o1, plan, 'A')?.kind).toBe('smoke');
    // 閃光：只有一個人在入口外、沒有隊友看著入口 → 不丟；隊友站到深位看著入口 → 配對閃
    f.bot.perc.known.delete(1);
    t.burns = [];
    f.match.players[5].grenades = ['flash'];
    const lay = t.ctLayout(obs, plan);
    const mate = [...lay].find(([id, q]) => id !== 5 && q.site === 'A')?.[0];
    if (mate === undefined) throw new Error('A 沒有其他守點的人');
    f.match.teleport(mate, 0, 0);
    expect(t.ctUtility(f.match.observe(5), plan, 'A')).toBeNull();
    const deep = t.deepSpots('A')[0];
    f.match.teleport(mate, deep.x, deep.y);
    expect(t.ctUtility(f.match.observe(5), plan, 'A')?.why).toBe('配對閃');
  });

  it('放棄點：三人以上已經進點、點上不超過兩人就退到回防位；下包後交給回防', () => {
    const f = live(5);
    const t = f.bot.tactics;
    const plan = t.chooseCT();
    t.plan = plan;
    const site = f.bot.intel.sites.A;
    const obs = f.match.observe(5);
    expect(t.giveUp(obs, plan, 'A')).toBeNull();
    for (let id = 0; id < 3; id++) f.bot.perc.known.set(id, { id, x: site.cx + id * 600, y: site.cy, vx: 0, vy: 0, facing: 0, weapon: 'ak', tick: obs.tick, seenTick: obs.tick, conf: 100, src: 'see' as const });
    expect(t.giveUp(obs, plan, 'A')).toBe('A');
    const out: Parameters<typeof t.ctGoal>[1] = { goal: null, route: null, hold: null, objective: false, allowPeek: true, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false };
    t.ctGoal(obs, out);
    expect(out.role).toBe('退守 A');
    expect(t.fallSpots('A').some((s) => s.x === out.goal?.x && s.y === out.goal?.y)).toBe(true);
    f.match.bomb.state = 'planted';
    expect(t.giveUp(f.match.observe(5), plan, 'A')).toBeNull();
  });

  it('退守位在包點裡看不到（入口內側、包點中心都沒有視線），不和看得到入口的回防集結位共用', () => {
    const { bot } = make(5);
    for (const s of ['A', 'B'] as const) {
      const site = bot.intel.sites[s];
      for (const p of bot.tactics.fallSpots(s)) {
        expect(site.regions.has(bot.intel.region[p.cell])).toBe(false);
        expect(bot.g.los(p.x, p.y, site.cx, site.cy)).toBe(false);
      }
    }
  });

  it.each(['redrock', 'dust'])('%s：探點位置 CT 來得及到、T 晚到，看得到 T 來的方向', (mapId) => {
    const { bot } = make(5, mapId);
    const list = bot.tactics.probeSpots();
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(bot.intel.distSpawn.CT[p.cell] / 10 / P.routeSpeed).toBeLessThanOrEqual(P.probeTime - 3);
      expect(bot.g.los(p.x, p.y, p.fx, p.fy)).toBe(true);
    }
  });

  it('看到對面在包點附近封煙只提高警覺：當成 1 人，單獨不夠輪轉', () => {
    expect(P.smokeAlarmN).toBeLessThan(P.rotateHeat);
  });
});

describe('Bot 2.5 第三批：T 閃光照得到深位', () => {
  it('主要入口的爆點候選裡，有在深位閃光半徑內、看得到的點', () => {
    const f = live(0);
    const t = f.bot.tactics;
    const obs = f.match.observe(0);
    const R = t.util.flashRadius;
    for (const s of ['A', 'B'] as const) {
      const e = f.bot.intel.sites[s].entrances[0];
      t.flashKey = '';
      t.flashPoint(obs, s, e, 2);
      const deep = t.deepSpots(s);
      expect(t.flashList.some((c) => deep.some((d) => dist(c.x, c.y, d.x, d.y) < R && f.bot.g.los(c.x, c.y, d.x, d.y)))).toBe(true);
    }
  });
});
