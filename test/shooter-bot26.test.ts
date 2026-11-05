import { afterEach, describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P, UNIT, dist } from '../bots/shooter-src/base.js';
import { parseEvent } from '../bots/shooter-src/tactics.js';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { shooterHelpers } from '../src/shooter/runner.ts';

// 直接用原始碼（開關 P 的旗標要跟 Bot 共用同一份 P；產生檔與原始碼一致另有測試）
const Bot = ShooterBaseline;

function make(pid: number, mapId = 'redrock'): { match: ShooterMatch; bot: ShooterBaseline } {
  const match = new ShooterMatch({ seed: 11, mapId });
  const bot = new Bot();
  bot.init(shooterInitData(match.map, pid, {}), shooterHelpers(match.map, 11, pid));
  return { match, bot };
}

function live(pid: number, mapId = 'redrock'): { match: ShooterMatch; bot: ShooterBaseline } {
  const f = make(pid, mapId);
  f.match.tick = 600;
  f.match.phase = 'live';
  f.match.phaseEnd = 3000;
  f.bot.newRound(f.match.observe(pid));
  return f;
}

describe('Bot 2.6：探點站位', () => {
  it.each(['redrock', 'dust'])('%s：探點位貼牆或矮牆、看得到 T 來向；沒有掩體的才停留減半', (mapId) => {
    const { bot } = make(5, mapId);
    const spots = bot.tactics.probeSpots();
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) {
      expect(bot.g.los(s.x, s.y, s.fx, s.fy)).toBe(true);
      expect(bot.intel.cover[s.cell] !== 0 || bot.tactics.probeBare.has(s.cell)).toBe(true);
    }
  });
});

describe('Bot 2.6：閃光認領', () => {
  afterEach(() => {
    P.flashClaim = true;
  });

  it('E:flashing 解析成認領；E:fl（flashHolders，2.7 刪掉）不再解析', () => {
    expect(parseEvent('E:flashing 12 34')).toEqual({ kind: 'claim', x: 1200, y: 3400 });
    expect(parseEvent('E:fl 1')).toBeNull();
  });

  it('隊友認領的爆點在入口：認領期間算已經閃過，過期就不算；關掉 flashClaim 回到 2.5', () => {
    const f = live(1);
    const t = f.bot.tactics;
    const ent = f.bot.intel.sites.A.entrances[0];
    const obs = f.match.observe(1);
    expect(t.flashDone(obs, ent)).toBe(false);
    t.flashClaims.push({ x: ent.ix, y: ent.iy, until: obs.tick + 60 });
    expect(t.flashDone(obs, ent)).toBe(true);
    expect(t.flashDone({ ...obs, tick: obs.tick + 61 }, ent)).toBe(false);
    P.flashClaim = false;
    expect(t.flashDone(obs, ent)).toBe(false);
  });

  it('爆點在入口內側深處（flashDeep 內）而且最近的是這個入口：也算這個入口的閃光', () => {
    const f = live(1);
    const t = f.bot.tactics;
    const ent = f.bot.intel.sites.A.entrances[0];
    const obs = f.match.observe(1);
    const dx = ent.ix - ent.ox;
    const dy = ent.iy - ent.oy;
    const len = Math.hypot(dx, dy);
    const deep = { x: Math.round(ent.ix + (dx / len) * 13 * UNIT), y: Math.round(ent.iy + (dy / len) * 13 * UNIT), tick: obs.tick };
    const others = ['A', 'B'].flatMap((s) => f.bot.intel.sites[s as 'A' | 'B'].entrances).filter((e) => e !== ent);
    if (others.some((e) => dist(deep.x, deep.y, e.ix, e.iy) < dist(deep.x, deep.y, ent.ix, ent.iy))) return;
    t.flashSpots.push(deep);
    expect(t.flashDone(obs, ent)).toBe(true);
    P.flashClaim = false;
    expect(t.flashDone(obs, ent)).toBe(false);
  });
});

describe('Bot 2.6：穿煙盲射', () => {
  afterEach(() => {
    P.blindFire = true;
  });

  it('剛看到的敵人走進煙：盲射目標在煙後；沒有煙、或線索超過 blindMemo 秒就不打', () => {
    const f = live(5);
    const c = f.bot.combat;
    const me = f.match.players[5];
    const obs = f.match.observe(5);
    // 找一個看得到的 10 格外的點
    let target = null;
    for (let deg = 0; deg < 360 && target === null; deg += 15) {
      const q = { x: Math.round(me.x + Math.cos((deg * Math.PI) / 180) * 10 * UNIT), y: Math.round(me.y + Math.sin((deg * Math.PI) / 180) * 10 * UNIT) };
      if (f.bot.g.walkable(f.bot.g.cellOf(q.x, q.y)) && f.bot.g.los(me.x, me.y, q.x, q.y)) target = q;
    }
    if (target === null) throw new Error('找不到開闊方向');
    f.bot.perc.known.set(0, { id: 0, x: target.x, y: target.y, vx: 0, vy: 0, facing: 0, weapon: 'ak', tick: obs.tick - 10, seenTick: obs.tick - 10, conf: 90, src: 'see' });
    expect(c.blindAim(obs)).toBeNull();
    c.smokes.set('s', { x: target.x, y: target.y, radius: 3 * UNIT, tick: obs.tick, until: obs.tick + 300 });
    const aim = c.blindAim(obs);
    expect(aim).not.toBeNull();
    expect(dist(aim!.x, aim!.y, target.x, target.y)).toBeLessThan(UNIT);
    expect(c.blindAim({ ...obs, tick: obs.tick + P.blindMemo * 30 })).toBeNull();
  });

  it('盲射決策：轉到目標才開火、隊友在彈道上不打、手槍不打、關掉 blindFire 不打', () => {
    const f = live(5);
    const c = f.bot.combat;
    const me = f.match.players[5];
    let target = null;
    for (let deg = 0; deg < 360 && target === null; deg += 15) {
      const q = { x: Math.round(me.x + Math.cos((deg * Math.PI) / 180) * 10 * UNIT), y: Math.round(me.y + Math.sin((deg * Math.PI) / 180) * 10 * UNIT) };
      if (f.bot.g.walkable(f.bot.g.cellOf(q.x, q.y)) && f.bot.g.los(me.x, me.y, q.x, q.y)) target = { ...q, deg };
    }
    if (target === null) throw new Error('找不到開闊方向');
    f.match.teleport(5, me.x, me.y, target.deg);
    const base = f.match.observe(5);
    const obs = { ...base, teammates: base.teammates.map((m) => ({ ...m, alive: false })), me: { ...base.me, weapon: 'm4' as const, ammoMag: 30, loadout: { ...base.me.loadout, primary: 'm4' as const } } };
    f.bot.perc.known.set(0, { id: 0, x: target.x, y: target.y, vx: 0, vy: 0, facing: 0, weapon: 'ak', tick: obs.tick - 5, seenTick: obs.tick - 5, conf: 90, src: 'see' });
    c.smokes.set('s', { x: target.x, y: target.y, radius: 3 * UNIT, tick: obs.tick, until: obs.tick + 300 });
    const fight = c.engage(obs, { holding: true, objective: false });
    expect(fight.engaged).toBe(true);
    expect(fight.fire).toBe(true);
    expect(fight.why).toBe('盲射');
    c.blind = null;
    const half = { x: Math.round((me.x + target.x) / 2), y: Math.round((me.y + target.y) / 2) };
    const mate = c.engage({ ...obs, teammates: obs.teammates.map((m, i) => (i === 0 ? { ...m, alive: true, ...half } : m)) }, { holding: true, objective: false });
    expect(mate.fire).toBe(false);
    c.blind = null;
    const pistol = c.engage({ ...obs, me: { ...obs.me, weapon: 'pistol' } }, { holding: true, objective: false });
    expect(pistol.fire).toBe(false);
    P.blindFire = false;
    c.blind = null;
    expect(c.engage(obs, { holding: true, objective: false }).fire).toBe(false);
  });
});

describe('Bot 2.6：繞後（看側翼 flankCover 在 2.7 刪掉）', () => {
  it.each(['redrock', 'dust'])('%s：繞後路線和路線集每一條的區域重疊都小於 60%，長度不超過最短 × lurkSlack，不在路線集裡', (mapId) => {
    const { bot } = make(0, mapId);
    for (const s of ['A', 'B'] as const) {
      const l = bot.intel.lurk[s];
      expect(l).not.toBeNull();
      const routes = bot.intel.routes.T[s];
      expect(routes).not.toContain(l);
      const shortest = Math.min(...routes.map((r) => r.length));
      expect(l!.length).toBeLessThanOrEqual(Math.ceil(shortest * P.lurkSlack) + 1);
      for (const r of routes) {
        const a = new Set(r.regions);
        const inter = l!.regions.filter((x) => a.has(x)).length;
        expect(inter / new Set([...r.regions, ...l!.regions]).size).toBeLessThan(0.6);
      }
    }
  });

  it('繞後只給 default／fake 的游擊、eco 不繞；決定後同一個計畫不重抽', () => {
    const f = live(3);
    const t = f.bot.tactics;
    const obs = f.match.observe(3);
    const lurker = t.roles.who(5);
    const isMe = lurker === 3;
    const plan = { kind: 'default' as const, site: 'A' as const, r1: 0, r2: 0, exec: null };
    const first = t.lurkOf(obs, plan);
    if (!isMe) expect(first).toBeNull();
    expect(t.lurkOf(obs, plan)).toBe(first);
    t.lurkKey = '';
    expect(t.lurkOf(obs, { kind: 'rush', site: 'A', r1: 0, r2: 0, exec: 'A' })).toBeNull();
    t.lurkKey = '';
    t.buyCall = 'eco';
    expect(t.lurkOf(obs, plan)).toBeNull();
  });
});

describe('Bot 2.6.1：有效連閃、盲射友軍、保槍躲遠', () => {
  afterEach(() => {
    P.flashSecond = true;
  });

  it('同入口第二顆：第一顆確定出手 0.8 秒後才行（依順序再錯開），有人宣告中不行、兩顆以上不行；非 rush 要避開第一顆爆點', () => {
    const f = live(1);
    const t = f.bot.tactics;
    const ent = f.bot.intel.sites.A.entrances[0];
    const obs = f.match.observe(1);
    expect(t.flashNext(obs, ent, false, 0)).toEqual({ ok: true, avoid: null, second: false });
    t.flashSpots.push({ x: ent.ix, y: ent.iy, tick: obs.tick });
    expect(t.flashNext(obs, ent, false, 0).ok).toBe(false);
    const later = { ...obs, tick: obs.tick + 27 };
    const r = t.flashNext(later, ent, false, 0);
    expect(r.ok && r.second).toBe(true);
    expect(r.avoid).toEqual({ x: ent.ix, y: ent.iy });
    expect(t.flashNext(later, ent, true, 0).avoid).toBeNull();
    expect(t.flashNext(later, ent, false, 1).ok).toBe(false);
    expect(t.flashNext({ ...obs, tick: obs.tick + 42 }, ent, false, 1).ok).toBe(true);
    t.flashClaims.push({ x: ent.ix + 8000, y: ent.iy, until: later.tick + 30 });
    if (t.flashOf(ent, { x: ent.ix + 8000, y: ent.iy })) expect(t.flashNext(later, ent, false, 0).ok).toBe(false);
    t.flashClaims.length = 0;
    t.flashSpots.push({ x: ent.ix + 5000, y: ent.iy, tick: obs.tick });
    if (t.flashOf(ent, { x: ent.ix + 5000, y: ent.iy })) expect(t.flashNext(later, ent, false, 0).ok).toBe(false);
    P.flashSecond = false;
    t.flashSpots.length = 1;
    expect(t.flashNext(later, ent, false, 0).ok).toBe(false);
  });

  it('隊友站在煙裡：不盲射', () => {
    const f = live(5);
    const c = f.bot.combat;
    const me = f.match.players[5];
    let target = null;
    for (let deg = 0; deg < 360 && target === null; deg += 15) {
      const q = { x: Math.round(me.x + Math.cos((deg * Math.PI) / 180) * 10 * UNIT), y: Math.round(me.y + Math.sin((deg * Math.PI) / 180) * 10 * UNIT) };
      if (f.bot.g.walkable(f.bot.g.cellOf(q.x, q.y)) && f.bot.g.los(me.x, me.y, q.x, q.y)) target = { ...q, deg };
    }
    if (target === null) throw new Error('找不到開闊方向');
    f.match.teleport(5, me.x, me.y, target.deg);
    const base = f.match.observe(5);
    const obs = { ...base, teammates: base.teammates.map((m) => ({ ...m, alive: false })), me: { ...base.me, weapon: 'm4' as const, ammoMag: 30, loadout: { ...base.me.loadout, primary: 'm4' as const } } };
    f.bot.perc.known.set(0, { id: 0, x: target.x, y: target.y, vx: 0, vy: 0, facing: 0, weapon: 'ak', tick: obs.tick - 5, seenTick: obs.tick - 5, conf: 90, src: 'see' });
    c.smokes.set('s', { x: target.x, y: target.y, radius: 3 * UNIT, tick: obs.tick, until: obs.tick + 300 });
    expect(c.engage(obs, { holding: true, objective: false }).fire).toBe(true);
    c.blind = null;
    // 隊友在煙的另一側邊緣（不在彈道上）也不打
    const side = { x: target.x + Math.round(Math.cos(((target.deg + 90) * Math.PI) / 180) * 2500), y: target.y + Math.round(Math.sin(((target.deg + 90) * Math.PI) / 180) * 2500) };
    const inSmoke = { ...obs, teammates: obs.teammates.map((m, i) => (i === 0 ? { ...m, alive: true, ...side } : m)) };
    expect(c.engage(inSmoke, { holding: true, objective: false }).fire).toBe(false);
  });

  it('保槍：選離炸彈 saveDist 以上、有掩體、離記得的敵人遠的格，不是原地', () => {
    const f = live(5);
    const t = f.bot.tactics;
    const site = f.bot.intel.sites.B;
    const bomb = site.plants[0];
    const obs = f.match.observe(5);
    const sp = t.saveSpot(obs, bomb.x, bomb.y);
    expect(sp).not.toBeNull();
    expect(dist(sp!.x, sp!.y, bomb.x, bomb.y)).toBeGreaterThanOrEqual(P.saveDist * UNIT);
    expect(f.bot.intel.cover[f.bot.g.cellOf(sp!.x, sp!.y)]).not.toBe(0);
  });
});

describe('Bot 2.6.2：保槍看局勢、發槍、撿槍', () => {
  it('沒有下一回合可存：對方賽點、半場最後一回合', () => {
    const f = live(5);
    const e = f.bot.tactics.econ;
    const obs = f.match.observe(5);
    expect(e.lastChance(obs)).toBe(false);
    const win = f.bot.data.rules.winRounds;
    expect(e.lastChance({ ...obs, round: { ...obs.round, scoreT: win - 1 } })).toBe(true);
    e.roundInHalf = f.bot.data.rules.roundsPerHalf;
    expect(e.lastChance(obs)).toBe(true);
  });

  it('發槍計畫：狙擊手買不起狙擊槍時由錢最多、沒好槍的人送；買不起步槍的人也有人送；每人最多送一把', () => {
    const f = live(5);
    const e = f.bot.tactics.econ;
    const people = [
      { id: 5, money: 9800, good: false, awp: false, awper: false },
      { id: 6, money: 8500, good: false, awp: false, awper: false },
      { id: 7, money: 4000, good: false, awp: false, awper: true },
      { id: 8, money: 1500, good: false, awp: false, awper: false },
      { id: 9, money: 6000, good: true, awp: false, awper: false },
    ];
    const plan = e.giftPlan(people, 'CT', 'full');
    expect(plan).toContainEqual({ from: 5, to: 7, w: 'awp' });
    expect(plan).toContainEqual({ from: 6, to: 8, w: 'm4' });
    expect(new Set(plan.map((g) => g.from)).size).toBe(plan.length);
    expect(e.giftPlan(people, 'CT', 'eco')).toEqual([]);
  });

  it('送槍的人先買要送的槍；收槍的人不買主武器', () => {
    const f = live(5);
    const e = f.bot.tactics.econ;
    const base = f.match.observe(5);
    const obs = { ...base, me: { ...base.me, money: 9000, loadout: { ...base.me.loadout, primary: null } } };
    const give = e.items(obs, 'full', 1, false, 'm4');
    expect(give[0]).toBe('m4');
    expect(give.filter((x) => x === 'm4').length).toBe(2);
    const get = e.items(obs, 'full', 1, false, null, true);
    expect(get.some((x) => x === 'm4' || x === 'smg' || x === 'awp')).toBe(false);
  });

  it('槍的價值：狙擊槍給狙擊手最高、步槍其次；E:gift 解析', async () => {
    const { parseGift } = await import('../bots/shooter-src/economy.js');
    expect(parseGift('B:gift 5 7 awp')).toEqual({ from: 5, to: 7, w: 'awp' });
    expect(parseGift('B:full')).toBeNull();
    const f = live(5);
    const t = f.bot.tactics;
    expect(t.gunValue('ak')).toBeGreaterThan(t.gunValue('smg'));
    expect(t.gunValue('smg')).toBeGreaterThan(t.gunValue(null));
  });
});
