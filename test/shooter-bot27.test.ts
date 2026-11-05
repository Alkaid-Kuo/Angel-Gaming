import { afterEach, describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P, UNIT } from '../bots/shooter-src/base.js';
import { parseEvent, type TacOut } from '../bots/shooter-src/tactics.js';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { ScriptController, ShooterDriver, shooterHelpers } from '../src/shooter/runner.ts';
import type { ShooterObservation, WeaponId } from '../src/shooter/api.ts';
import type { Sector } from '../bots/shooter-src/memory.js';

// Bot 2.7 修正批的 regression 測試：每項測反例修好（開關開）與原本的合理行為保留；開關關掉時重現 2.6.3 的錯誤。
// 直接用原始碼（開關 P 與 Bot 共用同一份）。反例改寫自 Astra 審查的 counterexamples.mjs／extra-counterexamples.mjs。

function live(pid: number, mapId = 'redrock'): { match: ShooterMatch; bot: ShooterBaseline } {
  const match = new ShooterMatch({ seed: 11, mapId });
  const bot = new ShooterBaseline();
  bot.init(shooterInitData(match.map, pid, {}), shooterHelpers(match.map, 11, pid));
  match.tick = 600;
  match.phase = 'live';
  match.phaseEnd = 3000;
  bot.newRound(match.observe(pid));
  return { match, bot };
}

const out = (extra: Partial<TacOut> = {}): TacOut => ({ goal: null, route: null, hold: null, objective: false, allowPeek: false, cmds: [], role: 'test', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false, ...extra });

/** 開關測完還原 */
const saved: [keyof typeof P, unknown][] = [];
function setP<K extends keyof typeof P>(k: K, v: (typeof P)[K]): void {
  saved.push([k, P[k]]);
  (P as Record<string, unknown>)[k] = v;
}
afterEach(() => {
  while (saved.length > 0) {
    const [k, v] = saved.pop()!;
    (P as Record<string, unknown>)[k] = v;
  }
});

describe('Bot 2.7 批 1-1：撿槍不蓋掉趕期限的任務（grabAfterTask）', () => {
  /** CT 拆包手：敵人全滅、炸彈剩 7 秒、腳邊一把比手上好的槍 */
  function rushDefuse(): { bot: ShooterBaseline; obs: ShooterObservation; gun: { x: number; y: number }; bomb: { x: number; y: number } } {
    const { match, bot } = live(5);
    const o = match.observe(5);
    const gun = { x: o.me.x + 200, y: o.me.y };
    const bomb = { x: o.me.x + 5000, y: o.me.y };
    const obs: ShooterObservation = { ...o, enemies: [], enemiesAlive: 0, bomb: { ...o.bomb, ...bomb, ticksLeft: 210 }, items: [{ kind: 'weapon', weapon: 'm4', ...gun }], me: { ...o.me, loadout: { ...o.me.loadout, primary: null } } };
    return { bot, obs, gun, bomb };
  }

  it('趕期限的拆包不轉去撿槍：目標留在炸彈、commit 亮起', () => {
    const { bot, obs, bomb } = rushDefuse();
    const a = out({ task: 'defuse', goal: bomb });
    bot.tactics.settle(obs, a);
    expect(a.goal).toEqual(bomb);
    expect(a.commit).toBe(true);
    expect(a.role).not.toContain('撿槍');
  });

  it('不趕時間的守位照常撿 5 格內的好槍', () => {
    const { bot, obs, gun } = rushDefuse();
    const calm: ShooterObservation = { ...obs, enemiesAlive: 3, bomb: { ...obs.bomb, ticksLeft: null } };
    const a = out({ task: 'hold', goal: { x: obs.me.x + 3000, y: obs.me.y } });
    bot.tactics.settle(calm, a);
    expect(a.goal).toEqual(gun);
    expect(a.commit).toBe(false);
  });

  it('開關關掉重現 2.6.3：撿槍先跑，目標被換成槍', () => {
    setP('grabAfterTask', false);
    const { bot, obs, gun } = rushDefuse();
    const a = out({ task: 'defuse', goal: { x: obs.bomb.x!, y: obs.bomb.y! } });
    bot.tactics.settle(obs, a);
    expect(a.goal).toEqual(gun);
  });
});

describe('Bot 2.7 批 1-2：進過包點按點記（wentInSite）', () => {
  /** 狙擊手（座位 4）等 A：兩名隊友走進 site 矩形 */
  function walkIn(site: 'A' | 'B'): { before: boolean; after: boolean } {
    const { match, bot } = live(4);
    const t = bot.tactics;
    const obs = match.observe(4);
    const q = t.intel.sites[site].plants[0];
    const before = t.waitEntry(obs, 'A');
    t.trackTeam({ ...obs, teammates: obs.teammates.map((m, i) => (i < 2 ? { ...m, x: q.x, y: q.y } : m)) }, out());
    return { before, after: t.waitEntry(obs, 'A') };
  }

  it('隊友進過 B 不算突破 A：狙擊手繼續等', () => {
    expect(walkIn('B')).toEqual({ before: true, after: true });
  });

  it('隊友進過 A（之後退出矩形也算）：狙擊手不再等', () => {
    expect(walkIn('A')).toEqual({ before: true, after: false });
  });

  it('開關關掉重現 2.6.3：進過 B 也被當成進過 A', () => {
    setP('wentInSite', false);
    expect(walkIn('B')).toEqual({ before: true, after: false });
  });
});

describe('Bot 2.7 批 1-3：聲音反應等待（heardOnce、heardKeep）', () => {
  const sector = (tick: number): Sector => ({ ox: 0, oy: 0, dir: 90, r0: 0, r1: 12, tick, conf: 40, kind: 'footstep' });
  /** 反應等待 2 次決策：回傳每次決策（每 3 tick）聽到了沒；同一次決策呼叫 calls 次（alert 與 look 各一次） */
  function run(calls: number, steps: number, merge: boolean): boolean[] {
    const { bot } = live(5);
    const c = bot.combat;
    c.soundReact = 2;
    const s = sector(600);
    const res: boolean[] = [];
    for (let k = 0; k < steps; k++) {
      const t = 600 + 3 * k;
      if (merge) s.tick = t; // 連續的腳步聲：合併進同一個扇形、tick 每次更新
      let h = false;
      for (let i = 0; i < calls; i++) h = c.heard(s, t);
      res.push(h);
    }
    return res;
  }

  it('同一次決策叫兩次只扣一次：等滿 2 次決策才轉', () => {
    expect(run(2, 4, false)).toEqual([false, false, true, true]);
  });

  it('連續的同方向聲音不把等待歸零', () => {
    expect(run(1, 4, true)).toEqual([false, false, true, true]);
  });

  it('不同方向的新聲音、或停了 1 秒以上再響：重新等', () => {
    const { bot } = live(5);
    const c = bot.combat;
    c.soundReact = 1;
    const a = sector(600);
    expect([c.heard(a, 600), c.heard(a, 603)]).toEqual([false, true]);
    const b = sector(606);
    expect([c.heard(b, 606), c.heard(b, 609)]).toEqual([false, true]);
    b.tick = 660;
    expect([c.heard(b, 660), c.heard(b, 663)]).toEqual([false, true]);
  });

  it('開關關掉重現 2.6.3：雙扣只等一半、連射期間永遠聽不到', () => {
    setP('heardOnce', false);
    setP('heardKeep', false);
    expect(run(2, 3, false)).toEqual([false, true, true]);
    expect(run(1, 4, true)).toEqual([false, false, false, false]);
  });
});

describe('Bot 2.7 批 1-4：同點掉落物照引擎規則撿（grabSim）', () => {
  /** 沒有主武器、腳邊 0.2 格有槍：items 依引擎順序 */
  function grabWith(pid: number, items: (pos: { x: number; y: number }) => ShooterObservation['items']): TacOut {
    const { match, bot } = live(pid);
    const o = match.observe(pid);
    const q = { x: o.me.x + 200, y: o.me.y };
    const obs: ShooterObservation = { ...o, enemies: [], items: items(q), me: { ...o.me, loadout: { ...o.me.loadout, primary: null, kit: false } } };
    const a = out();
    bot.tactics.grab(obs, a);
    return a;
  }
  type Item = ShooterObservation['items'][number];
  const gun = (q: { x: number; y: number }, weapon: WeaponId = 'm4'): Item => ({ kind: 'weapon', weapon, ...q });
  const kit = (q: { x: number; y: number }): Item => ({ kind: 'kit', weapon: null, ...q });
  const pick = (a: TacOut): boolean => a.cmds.some((c) => c.type === 'pickup');

  it('CT：槍與拆彈器同一點，引擎先撿排前面的槍 → 下撿取', () => {
    expect(pick(grabWith(5, (q) => [gun(q), kit(q)]))).toBe(true);
  });

  it('CT：拆彈器排前面 → 先撿拆彈器也有用，照樣下撿取', () => {
    expect(pick(grabWith(5, (q) => [kit(q), gun(q)]))).toBe(true);
  });

  it('T：拆彈器 T 撿不到，不擋撿槍', () => {
    expect(pick(grabWith(0, (q) => [kit(q), gun(q)]))).toBe(true);
  });

  it('只有槍：照常撿（原本的行為保留）', () => {
    expect(pick(grabWith(5, (q) => [gun(q)]))).toBe(true);
  });

  it('同一點排前面的是更差的槍：不下撿取、也不把目標一直鎖在那裡', () => {
    const a = grabWith(5, (q) => [gun(q, 'pistol'), gun(q)]);
    expect(pick(a)).toBe(false);
    expect(a.goal).toBeNull();
  });

  it('同一點排前面的是比手上好、但不如目標的槍：先撿它（之後再換）', () => {
    expect(pick(grabWith(5, (q) => [gun(q, 'smg'), gun(q)]))).toBe(true);
  });

  it('開關關掉重現 2.6.3：槍與拆彈器同點永遠不撿', () => {
    setP('grabSim', false);
    expect(pick(grabWith(5, (q) => [gun(q), kit(q)]))).toBe(false);
  });
});

describe('Bot 2.7 批 1-5：加時的賽點門檻（otMatchPoint）', () => {
  function chance(overtime: number, theirs: number, roundInHalf: number): boolean {
    const { match, bot } = live(5);
    const o = match.observe(5);
    const e = bot.tactics.econ;
    e.roundInHalf = roundInHalf;
    return e.lastChance({ ...o, round: { ...o.round, overtime, scoreT: theirs, scoreCT: theirs } });
  }
  const rules = (): { rph: number; win: number; ot: { roundsPerHalf: number; winRounds: number } } => {
    const r = live(5).bot.data.rules;
    if (r.overtime === false) throw new Error('測試要有加時規則');
    return { rph: r.roundsPerHalf, win: r.winRounds, ot: r.overtime };
  };

  it('加時第一局（正規打平）不是對方賽點，可以保槍', () => {
    const r = rules();
    expect(chance(1, r.rph, 1)).toBe(false);
  });

  it('正規的對方賽點、加時真正的賽點、加時半場最後一局：都是最後機會', () => {
    const r = rules();
    expect(chance(0, r.win - 1, 2)).toBe(true);
    expect(chance(1, r.rph + r.ot.winRounds - 1, 2)).toBe(true);
    expect(chance(2, r.rph + r.ot.roundsPerHalf + r.ot.winRounds - 1, 2)).toBe(true);
    expect(chance(2, r.rph + r.ot.roundsPerHalf, 2)).toBe(false);
    expect(chance(1, r.rph, r.ot.roundsPerHalf)).toBe(true);
  });

  it('開關關掉重現 2.6.3：加時第一局被當成賽點', () => {
    setP('otMatchPoint', false);
    expect(chance(1, rules().rph, 1)).toBe(true);
  });
});

describe('Bot 2.7 批 1-6：閃光以投擲者＋爆炸時間識別（flashIdent）、關掉放行時的邊界（flashOffEq）', () => {
  function rig(): { bot: ShooterBaseline; obs: ShooterObservation; ent: { ix: number; iy: number } } {
    const { match, bot } = live(1);
    return { bot, obs: match.observe(1), ent: bot.intel.sites.A.entrances[0] };
  }
  const spot = (ent: { ix: number; iy: number }, t: number, by: number, dx = 0): { x: number; y: number; tick: number; by: number; pop: number } => ({ x: ent.ix + dx, y: ent.iy, tick: t, by, pop: t + 45 });

  it('同一點兩次真的投擲算兩顆：不能再丟第三顆', () => {
    const { bot, obs, ent } = rig();
    const t = bot.tactics;
    t.flashSpots = [spot(ent, obs.tick - 30, 2), spot(ent, obs.tick - 27, 3)];
    expect(t.flashNext(obs, bot.intel.sites.A.entrances[0], true, 0).ok).toBe(false);
  });

  it('只有一顆：時間到可以補第二顆；沒有就照常丟第一顆', () => {
    const { bot, obs, ent } = rig();
    const t = bot.tactics;
    const e = bot.intel.sites.A.entrances[0];
    t.flashSpots = [spot(ent, obs.tick - 30, 2)];
    expect(t.flashNext(obs, e, true, 0)).toMatchObject({ ok: true, second: true });
    t.flashSpots = [];
    expect(t.flashNext(obs, e, true, 0)).toMatchObject({ ok: true, second: false });
  });

  it('已知那一顆的飛行中拋體離落點超過 3 格：不重複計數', () => {
    const { bot, obs, ent } = rig();
    const t = bot.tactics;
    t.flashSpots = [{ ...spot(ent, obs.tick - 30, 2), pop: obs.tick + 15 }];
    const o: ShooterObservation = { ...obs, projectiles: [{ kind: 'flash', x: ent.ix + 5000, y: ent.iy, z: 1000 } as ShooterObservation['projectiles'][number]] };
    expect(t.flashOf(bot.intel.sites.A.entrances[0], o.projectiles[0])).toBe(true);
    expect(t.flashNext(o, bot.intel.sites.A.entrances[0], true, 0)).toMatchObject({ ok: true, second: true });
  });

  it('宣告的人丟出來了（落點和宣告不同）：宣告不再擋第二顆', () => {
    const { bot, obs, ent } = rig();
    const t = bot.tactics;
    t.flashClaims = [{ x: ent.ix + 5000, y: ent.iy, until: obs.tick + 30, by: 2, at: obs.tick - 32 }];
    t.flashSpots = [spot(ent, obs.tick - 30, 2)];
    expect(t.flashNext(obs, bot.intel.sites.A.entrances[0], true, 0)).toMatchObject({ ok: true, second: true });
    // 別人的宣告還沒丟：照樣擋
    t.flashClaims.push({ x: ent.ix + 3000, y: ent.iy, until: obs.tick + 30, by: 3, at: obs.tick - 3 });
    expect(t.flashNext(obs, bot.intel.sites.A.entrances[0], true, 0).ok).toBe(false);
  });

  it('開關關掉重現 2.6.3：同一點兩顆被去重成一顆', () => {
    setP('flashIdent', false);
    const { bot, obs, ent } = rig();
    const t = bot.tactics;
    t.flashSpots = [spot(ent, obs.tick - 30, 2), spot(ent, obs.tick - 27, 3)];
    expect(t.flashNext(obs, bot.intel.sites.A.entrances[0], true, 0)).toMatchObject({ ok: true, second: true });
  });

  /** 隊友的閃光剛好在 pop + 2：關掉提前放行時要和 2.6.2 一樣還在躲 */
  function boundary(): TacOut {
    const { match, bot } = live(0);
    const obs = match.observe(0);
    const me = obs.me;
    let q = null;
    for (let i = 0; i < bot.g.N && q === null; i++) {
      const c = bot.g.center(i);
      const d = Math.hypot(c.x - me.x, c.y - me.y);
      if (bot.g.walkable(i) && d > 4000 && d < 9000 && bot.g.los(me.x, me.y, c.x, c.y)) q = c;
    }
    bot.tactics.mateFlash = [{ x: q!.x, y: q!.y, pop: obs.tick - 2 }];
    const a = out();
    bot.tactics.overlay(obs, a);
    return a;
  }

  it('關掉 flashRelease：爆炸後 2 tick 仍算在躲（2.6.2 的 <=）', () => {
    setP('flashRelease', false);
    expect(boundary().urgent).toBe(true);
  });

  it('flashOffEq 也關掉重現 2.6.3：剛好 pop + 2 就放掉', () => {
    setP('flashRelease', false);
    setP('flashOffEq', false);
    expect(boundary().urgent).toBe(false);
  });
});

describe('Bot 2.7 批 1-7：閃光候選快取每秒依敵情重算（flashCacheSec）', () => {
  function reads(advance: number): { first: number; again: number; later: number } {
    const { match, bot } = live(1);
    const t = bot.tactics;
    const obs = match.observe(1);
    const e = bot.intel.sites.A.entrances[0];
    let calls = 0;
    const original = bot.perc.threats.bind(bot.perc);
    bot.perc.threats = (...args: Parameters<typeof original>) => {
      calls++;
      return original(...args);
    };
    t.flashPoint(obs, 'A', e, 2);
    const first = calls;
    t.flashPoint(obs, 'A', e, 2);
    const again = calls;
    bot.perc.lastTick += advance;
    bot.perc.sectors.push({ conf: 100, kind: 'footstep', ox: e.ix, oy: e.iy, dir: 0, r0: 0, r1: 20, tick: obs.tick + advance });
    t.flashPoint({ ...obs, tick: obs.tick + advance }, 'A', e, 2);
    return { first, again, later: calls };
  }

  it('同一秒內重複呼叫用快取；一秒後有新聲音就重算', () => {
    const r = reads(30);
    expect(r.again).toBe(r.first);
    expect(r.later).toBe(r.first + 1);
  });

  it('開關關掉重現 2.6.3：新敵情進來也不重算', () => {
    setP('flashCacheSec', 0);
    const r = reads(30);
    expect(r.later).toBe(r.first);
  });
});

describe('Bot 2.7 批 1-8：繞後者離開原組（lurkOut）', () => {
  const plan = { kind: 'default' as const, site: 'A' as const, r1: 0, r2: 0, exec: 'A' as const };
  /** 找一個座位 3（游擊）會繞後的回合 */
  function lurkRound(): { bot: ShooterBaseline; obs: ShooterObservation; gid: number } {
    const { match, bot } = live(3);
    const t = bot.tactics;
    t.buyCall = 'full';
    const o = match.observe(3);
    for (let n = 1; n <= 100; n++) {
      t.lurkKey = '';
      const obs = { ...o, round: { ...o.round, number: n } };
      if (t.lurkOf(obs, plan) !== null) return { bot, obs, gid: t.groupOf(obs, 3, plan) };
    }
    throw new Error('找不到繞後回合');
  }

  it('繞後者的隊友收到 E:lurk：組的人數與順序不算他', () => {
    const { obs: o3, gid } = lurkRound();
    const { match, bot } = live(4);
    const t = bot.tactics;
    const obs = { ...match.observe(4), round: o3.round };
    expect(t.groupOf(obs, 3, plan)).toBe(gid);
    expect(t.groupOf(obs, 4, plan)).toBe(gid);
    const before = t.groupSize(obs, plan);
    t.lurkers.add(3);
    expect(t.groupSize(obs, plan)).toBe(before - 1);
    expect(t.memberIndex(obs, 4, plan)).toBe(0);
  });

  it('E:lurk 解析；全隊剩不到 4 人就不再繞後（決定已經快取也一樣）', () => {
    expect(parseEvent('E:lurk')).toEqual({ kind: 'lurk' });
    const { bot, obs } = lurkRound();
    const few = { ...obs, teammates: obs.teammates.map((m, i) => (i < 2 ? { ...m, alive: false } : m)) };
    expect(bot.tactics.lurkOf(few, plan)).toBeNull();
    expect(bot.tactics.lurkOf(obs, plan)).not.toBeNull();
  });

  it('開關關掉重現 2.6.3：繞後者仍算原組成員、人數變少照繞', () => {
    setP('lurkOut', false);
    const { bot, obs } = lurkRound();
    const few = { ...obs, teammates: obs.teammates.map((m, i) => (i < 2 ? { ...m, alive: false } : m)) };
    expect(bot.tactics.lurkOf(few, plan)).not.toBeNull();
    const { match, bot: b4 } = live(4);
    const o4 = { ...match.observe(4), round: obs.round };
    const before = b4.tactics.groupSize(o4, plan);
    b4.tactics.lurkers.add(3);
    expect(b4.tactics.groupSize(o4, plan)).toBe(before);
  });
});

describe('Bot 2.7 批 1-10 A5：守位時 look() 不轉去看聲音（lookHoldQuiet）', () => {
  /** CT 站在 A 的守點位上守入口，背後 40 格外有槍聲（反應等待 0） */
  function aim(holding: boolean, sound: boolean): { x: number; y: number } | null {
    const { match, bot } = live(5);
    const obs = match.observe(5);
    const hold = bot.intel.sites.A.holds[0];
    const o: ShooterObservation = { ...obs, radar: [], me: { ...obs.me, x: hold.x, y: hold.y } };
    bot.combat.soundReact = 0;
    bot.perc.lastSound = sound ? { ox: hold.x, oy: hold.y, dir: 180, r0: 30, r1: 70, tick: o.tick, conf: 40, kind: 'shot' } : null;
    return bot.combat.look(o, { hold, holding, navLook: null, ahead: null });
  }

  it('守位中：看守的入口，不轉去看遠處的聲音', () => {
    expect(aim(true, true)).toEqual(aim(true, false));
  });

  it('不在守位（走動中）：照常轉向聲音', () => {
    expect(aim(false, true)).not.toEqual(aim(false, false));
  });

  it('開關關掉重現 2.6.3：守位中也轉去看聲音', () => {
    setP('lookHoldQuiet', false);
    expect(aim(true, true)).not.toEqual(aim(true, false));
  });
});

describe('Bot 2.7 批 1-10 A11：拆包警報在警報後有 CT 陣亡就解除（defuseAlarmKill）', () => {
  /** T 守包：看到 CT 在拆；一秒後炸彈看不到人在拆（回到 planted），CT 人數 3 → after */
  function alarm(after: number): [boolean, boolean] {
    const { match, bot } = live(0);
    const o = match.observe(0);
    const t = bot.tactics;
    const bomb = { ...o.bomb, state: 'defusing' as const, x: o.me.x, y: o.me.y, site: 'A' as const, ticksLeft: 900 };
    const a = t.defuseNow({ ...o, enemiesAlive: 3, bomb });
    const b = t.defuseNow({ ...o, tick: o.tick + 30, enemiesAlive: after, bomb: { ...bomb, state: 'planted' as const } });
    return [a, b];
  }

  it('拆包的人被殺（警報後 CT 少一人）：警報解除，該撤離就撤離', () => {
    expect(alarm(2)).toEqual([true, false]);
  });

  it('沒有人陣亡、只是看不到：照 2.3 的設計當成還在拆（拆包時間內）', () => {
    expect(alarm(3)).toEqual([true, true]);
  });

  it('開關關掉重現 2.6.3：拆包的人死了也鎖滿 10 秒', () => {
    setP('defuseAlarmKill', false);
    expect(alarm(2)).toEqual([true, true]);
  });
});

describe('Bot 2.7 批 1-10 A12：等槍線計時只在有更新的陣亡時歸零（lineNewest）', () => {
  /** 兩個隊友 5 秒內先後陣亡（都在 8 格外，不形成槍線）：已經等了 20 tick，再看一次槍線 */
  function held(): number {
    const { match, bot } = live(0);
    const obs = match.observe(0);
    const t = bot.tactics;
    const far = { x: obs.me.x + 30000, y: obs.me.y };
    bot.perc.anon = [{ ...far, tick: obs.tick - 60, conf: 50, src: 'death' }, { ...far, y: far.y + 3000, tick: obs.tick - 20, conf: 50, src: 'death' }];
    const soon = { x: obs.me.x + 1000, y: obs.me.y };
    t.gunLine(obs, soon);
    t.lineHeld = 20;
    t.gunLine(obs, soon);
    return t.lineHeld;
  }

  it('同一批陣亡：計時不被較舊的那一筆歸零', () => {
    expect(held()).toBe(20);
  });

  it('開關關掉重現 2.6.3：兩筆來回切，每次都歸零', () => {
    setP('lineNewest', false);
    expect(held()).toBe(0);
  });
});

describe('Bot 2.7 批 1-10 A13：拆包、下包途中不換血架槍、不追殘血（tradeSkipTask）', () => {
  function run(task: TacOut['task']): { trade: TacOut; chase: TacOut } {
    const { match, bot } = live(5);
    const obs = match.observe(5);
    const t = bot.tactics;
    const goal = { x: obs.me.x + 5000, y: obs.me.y };
    t.trade = { x: obs.me.x, y: obs.me.y + 9000, until: obs.tick + 30 };
    const trade = out({ task, goal });
    t.overlay(obs, trade);
    t.trade = null;
    (t.attrs as { discipline: number }).discipline = 0.2;
    t.chase = { x: obs.me.x - 4000, y: obs.me.y, until: obs.tick + 60 };
    const chase = out({ task, goal });
    t.overlay(obs, chase);
    return { trade, chase };
  }

  it('拆包途中：不停下架槍、不改去追殘血', () => {
    const r = run('defuse');
    expect(r.trade.stop).toBe(false);
    expect(r.chase.goal).toEqual({ x: r.chase.goal!.x, y: r.chase.goal!.y });
    expect(r.chase.role).not.toContain('追殘血');
  });

  it('下包途中也一樣；守位照常換血架槍', () => {
    expect(run('plant').trade.stop).toBe(false);
    expect(run('hold').trade.stop).toBe(true);
  });

  it('開關關掉重現 2.6.3：拆包手停下架槍', () => {
    setP('tradeSkipTask', false);
    expect(run('defuse').trade.stop).toBe(true);
  });
});

describe('Bot 2.7 批 1-10 A21：沒送出導航移動時不算被擋（navIdle）', () => {
  /** 目標在 20 格外、人站著不動（站著開槍或丟道具）：每次決策導航都排了移動，但入口用了 stop */
  function stuck(idle: boolean): number {
    const { match, bot } = live(5);
    const o = match.observe(5);
    const g = bot.intel.sites.A;
    bot.nav.setGoal(g.cx, g.cy, null);
    for (let k = 0; k < 10; k++) {
      bot.nav.step({ ...o, tick: o.tick + 3 * k, me: { ...o.me, vx: 0, vy: 0 } }, { allowPeek: false, speed: 130, evading: false, priority: false });
      if (idle) bot.nav.idle();
    }
    return bot.nav.stuck;
  }

  it('站著不動但沒有送出導航的移動：不累計被擋', () => {
    expect(stuck(true)).toBe(0);
  });

  it('真的送出移動卻動不了：照常算被擋（原本的行為保留）', () => {
    expect(stuck(false)).toBeGreaterThan(0);
  });

  it('開關關掉重現 2.6.3：刻意停步也算被擋', () => {
    setP('navIdle', false);
    expect(stuck(true)).toBeGreaterThan(0);
  });
});

describe('Bot 2.7 批 1-10 A27：燒拆包不燒到正在交火的隊友（burnMateCheck）', () => {
  /** T 守 B 包、身上有燃燒彈、看到 CT 在拆；mate＝隊友站在炸彈旁 2 格 */
  function wish(mate: boolean): string | undefined {
    const { match, bot } = live(0);
    const raw = match.observe(0);
    const b = bot.intel.sites.B.plants[0];
    const p = bot.intel.sites.B.holds[0];
    const teammates = mate ? [{ ...raw.teammates[0], alive: true, x: b.x + 2000, y: b.y }] : [];
    const obs: ShooterObservation = { ...raw, enemies: [], radar: [], teammates, enemiesAlive: 3, me: { ...raw.me, x: p.x, y: p.y, loadout: { ...raw.me.loadout, grenades: ['molotov'] } }, bomb: { state: 'defusing', site: 'B', x: b.x, y: b.y, ticksLeft: 900 } };
    return bot.tactics.postPlant(obs, out(), b.x, b.y, 'B')?.why;
  }

  it('炸彈旁沒有隊友：照常燒拆包', () => {
    expect(wish(false)).toBe('燒拆包');
  });

  it('隊友在炸彈 4 格內：不燒', () => {
    expect(wish(true)).not.toBe('燒拆包');
  });

  it('開關關掉重現 2.6.3：隊友在旁邊也燒', () => {
    setP('burnMateCheck', false);
    expect(wish(true)).toBe('燒拆包');
  });
});

describe('Bot 2.7 批 1-10 A23：沒有下一回合時不存錢（critForce）', () => {
  function call(lastOfHalf: boolean): string {
    const { match, bot } = live(5);
    const o = match.observe(5);
    const e = bot.tactics.econ;
    const r = bot.data.rules;
    e.roundInHalf = lastOfHalf ? r.roundsPerHalf : 4;
    e.prevCall = null;
    e.lastWon = false;
    return e.teamCall({ ...o, round: { ...o.round, overtime: 0, scoreT: 0, scoreCT: 0 }, me: { ...o.me, money: 1000, loadout: { ...o.me.loadout, primary: null } }, teammates: o.teammates.map((m) => ({ ...m, money: 1000, weapon: 'pistol' as const })) });
  }

  it('半場最後一回合、錢很少：照樣 force（錢會被重置）', () => {
    expect(call(true)).toBe('force');
  });

  it('還有下一回合、錢很少：照常 eco', () => {
    expect(call(false)).toBe('eco');
  });

  it('開關關掉重現 2.6.3：最後一回合也存錢', () => {
    setP('critForce', false);
    expect(call(true)).toBe('eco');
  });
});

describe('Bot 2.7 批 1-10 A9：主武器空了也沒備彈、敵人在遠處：切手槍（emptySwitch）', () => {
  /** CT 拿空的 m4（沒有備彈），正前方 20 格有敵人；reserve＝備彈 */
  function fight(reserve: number): { cmds: string[]; why: string } {
    const { match, bot } = live(5);
    const me = match.players[5];
    let target = null;
    for (let deg = 0; deg < 360 && target === null; deg += 15) {
      const q = { x: Math.round(me.x + Math.cos((deg * Math.PI) / 180) * 20 * UNIT), y: Math.round(me.y + Math.sin((deg * Math.PI) / 180) * 20 * UNIT) };
      if (bot.g.walkable(bot.g.cellOf(q.x, q.y)) && bot.g.los(me.x, me.y, q.x, q.y)) target = { ...q, deg };
    }
    if (target === null) throw new Error('找不到開闊方向');
    match.teleport(5, me.x, me.y, target.deg);
    const base = match.observe(5);
    const enemy = { id: 0, x: target.x, y: target.y, facing: 0, weapon: 'ak' as const, crouching: false, planting: false, defusing: false, hasBomb: false, firing: false };
    const obs: ShooterObservation = { ...base, enemies: [enemy], me: { ...base.me, weapon: 'm4', ammoMag: 0, ammoReserve: reserve, reloadTicksLeft: 0, loadout: { ...base.me.loadout, primary: 'm4', secondary: 'pistol' } } };
    bot.perc.update(obs);
    const f = bot.combat.engage(obs, { holding: false, objective: false });
    return { cmds: f.cmds.map((c) => c.type), why: f.why };
  }

  it('沒有備彈：切手槍', () => {
    expect(fight(0).cmds).toContain('switch');
  });

  it('還有備彈：照常換彈（原本的行為保留）', () => {
    expect(fight(60).cmds).toContain('reload');
  });

  it('開關關掉重現 2.6.3：沒有任何指令', () => {
    setP('emptySwitch', false);
    expect(fight(0).cmds.filter((c) => c === 'switch' || c === 'reload')).toEqual([]);
  });
});

describe('Bot 2.7 批 1-10 A6：視錐掃描照站姿越過矮牆（scanLow）', () => {
  /** 找一段東西向的矮牆（1～3 格厚）：西邊 3 格、東邊 6 格都是可走的平地。before(d)＝矮牆西邊第 d 格，after(d)＝矮牆東邊第 d 格 */
  function rig(): { bot: ShooterBaseline; t: number; before: (d: number) => { x: number; y: number }; after: (d: number) => number } {
    const { match, bot } = live(5);
    const g = bot.g;
    const flat = (i: number): boolean => g.walkable(i) && g.low[i] === 0 && g.wall[i] === 0 && g.slope[i] < 0;
    for (let i = 0; i < g.N; i++) {
      if (g.low[i] !== 1 || g.low[i - 1] === 1) continue;
      let n = 0;
      while (n < 4 && g.low[i + n] === 1) n++;
      const x = i % g.W;
      if (n > 3 || x < 4 || x + n + 6 >= g.W) continue;
      let ok = true;
      for (let d = 1; d <= 3 && ok; d++) ok = flat(i - d);
      for (let d = 1; d <= 6 && ok; d++) ok = flat(i + n - 1 + d);
      if (!ok) continue;
      return { bot, t: match.tick, before: (d) => g.center(i - d), after: (d) => i + n - 1 + d };
    }
    throw new Error('地圖上找不到矮牆');
  }

  it('站著：看得到矮牆後面 4 格以外；緊貼矮牆後面（蹲著的人躲得住）不算清過', () => {
    const { bot, t, before, after } = rig();
    const p = before(3);
    bot.perc.scan(p.x, p.y, 0, 10, 14, t, false);
    expect(bot.perc.seenTick[after(5)]).toBe(t);
    expect(bot.perc.seenTick[after(1)]).not.toBe(t);
  });

  it('蹲著、矮牆在 2 格內：擋住（引擎的規則）', () => {
    const { bot, t, before, after } = rig();
    const p = before(1);
    bot.perc.scan(p.x, p.y, 0, 10, 14, t, true);
    expect(bot.perc.seenTick[after(5)]).not.toBe(t);
  });

  it('開關關掉重現 2.6.3：站著也被矮牆擋住', () => {
    setP('scanLow', false);
    const { bot, t, before, after } = rig();
    const p = before(3);
    bot.perc.scan(p.x, p.y, 0, 10, 14, t, false);
    expect(bot.perc.seenTick[after(5)]).not.toBe(t);
  });
});

describe('Bot 2.7 批 1-12（H01）：守包反拆責任人（antiDefuse）', () => {
  /** 單一 T（AK、沒有道具）守包對只拆包的腳本 CT；smoke＝炸彈上有煙、kit＝CT 有拆彈器 */
  function defuse(o: { mapId?: string; smoke: boolean; kit: boolean }): { fired: number; reason: string; ctAlive: boolean; roles: string[]; moved: number } {
    const bot = new ShooterBaseline();
    let fired = 0;
    let live = false;
    const roles: string[] = [];
    const controllers = Array.from({ length: 10 }, (_, id) => new ScriptController(`h01-${id}`, (obs: ShooterObservation): unknown[] => {
      if (!live) return [];
      if (id === 5) return obs.round.phase === 'planted' ? [{ type: 'defuse' }] : [];
      if (id !== 0) return [];
      const cmds = bot.decide(obs);
      fired += cmds.filter((c) => c.type === 'fire' && c.on).length;
      if (obs.tick % 30 === 0) roles.push(bot.why);
      return cmds;
    }));
    const d = new ShooterDriver({ seed: 43001, mapId: o.mapId ?? 'redrock', freezeTicks: 3, defaultLoadout: { T: 'ak', CT: 'm4' }, controllers, record: false });
    const m = d.match;
    for (let i = 1; i < 10; i++) if (i !== 5) m.kill(i);
    while (m.phase !== 'live') d.step();
    bot.init(shooterInitData(m.map, 0, {}), shooterHelpers(m.map, 43001, 0));
    const bomb = bot.intel.sites.A.plants[0];
    const spot = bot.tactics.postSpots('A', bomb.x, bomb.y, true)[0];
    m.teleport(0, spot.x, spot.y, 180);
    m.teleport(5, bomb.x, bomb.y, 0);
    for (const p of m.players) { p.hasBomb = false; p.grenades = []; }
    m.players[5].kit = o.kit;
    Object.assign(m.bomb, { state: 'planted', carrier: -1, x: bomb.x, y: bomb.y, site: 'A', explodeTick: m.tick + 1200, planter: 0, defuser: -1 });
    m.phase = 'planted';
    m.phaseEnd = m.bomb.explodeTick;
    if (o.smoke) m.smokes.push({ x: bomb.x, y: bomb.y, owner: 5, startTick: m.tick - 30, endTick: m.tick + 1000 });
    bot.newRound(m.observe(0));
    live = true;
    const start = m.tick;
    let moved = 0;
    while (m.rounds.length === 0 && m.tick - start < 450) {
      d.step();
      moved = Math.max(moved, Math.hypot(m.players[0].x - spot.x, m.players[0].y - spot.y));
    }
    return { fired, reason: m.rounds[0]?.reason ?? 'none', ctAlive: m.players[5].alive, roles, moved };
  }

  it.each([['redrock', false], ['redrock', true], ['dust', false], ['dust', true]] as const)('%s 煙裡拆包（拆彈器 %s）：T 要出手反拆（開火或殺掉 CT），不是站著看', (mapId, kit) => {
    const r = defuse({ mapId, smoke: true, kit });
    expect(r.fired > 0 || !r.ctAlive).toBe(true);
  });

  it('沒有煙：照常看得到就打（原本的行為保留）', () => {
    const r = defuse({ smoke: false, kit: false });
    expect(r.ctAlive).toBe(false);
  });

  it('假拆：證據過 1 秒就不再接手；來不及在最晚干預時間前到位也不去', () => {
    const { match, bot } = live(0);
    const o = match.observe(0);
    const t = bot.tactics;
    const bomb = bot.intel.sites.A.plants[0];
    const obs: ShooterObservation = { ...o, teammates: o.teammates.map((m) => ({ ...m, alive: false })), me: { ...o.me, x: bomb.x + 6000, y: bomb.y } };
    t.defuseSince = obs.tick - 10;
    t.defuseLast = obs.tick - 10;
    expect(t.antiDefuse(obs, out(), bomb.x, bomb.y)).toBe(true);
    t.defuseLast = obs.tick - 40;
    expect(t.antiDefuse(obs, out(), bomb.x, bomb.y)).toBe(false);
    t.defuseLast = obs.tick;
    t.defuseSince = obs.tick - bot.data.rules.defuseTicks + 5;
    const far: ShooterObservation = { ...obs, me: { ...obs.me, x: bomb.x + 30000 } };
    expect(t.antiDefuse(far, out(), bomb.x, bomb.y)).toBe(false);
  });

  it('開關關掉重現 2.6.3：煙裡拆包 T 一槍不開', () => {
    setP('antiDefuse', false);
    expect(defuse({ smoke: true, kit: false }).fired).toBe(0);
  });
});

describe('Bot 2.7 批 1-13（H02）：補槍人選先篩資格再排序（coopEligible）', () => {
  /** 找一組幾何：隊友 0 在 cue 開火、目標在 cue 前 6 格；自己在 cue 後 5 格；near＝離 cue 2～5 格但隔牆的隊友 1 */
  function rig(visibleNear: boolean): { acted: (nearAlive: boolean) => boolean } {
    const { match, bot } = live(2);
    const base = match.observe(2);
    const g = bot.g;
    let found = null;
    outer: for (let i = 0; i < g.N; i += 3) {
      if (!g.walkable(i)) continue;
      const cue = g.center(i);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const me = { x: cue.x - dx * 5000, y: cue.y - dy * 5000 };
        const target = { x: cue.x + dx * 6000, y: cue.y + dy * 6000 };
        if (!g.walkLine(me.x, me.y, target.x, target.y)) continue;
        for (let ay = -4; ay <= 4; ay++) for (let ax = -4; ax <= 4; ax++) {
          const near = { x: cue.x + ax * 1000, y: cue.y + ay * 1000 };
          const d = Math.hypot(ax, ay);
          if (d < 2 || d >= 5 || !g.walkable(g.cellOf(near.x, near.y)) || g.los(near.x, near.y, cue.x, cue.y) !== visibleNear) continue;
          if (visibleNear && Math.hypot(near.x - cue.x, near.y - cue.y) >= Math.hypot(me.x - cue.x, me.y - cue.y)) continue;
          found = { cue, me, target, near };
          break outer;
        }
      }
    }
    if (found === null) throw new Error('找不到幾何');
    const { cue, me, target, near } = found;
    const obs: ShooterObservation = { ...base, enemies: [], radar: [], effects: [], me: { ...base.me, ...me, hasBomb: false }, teammates: base.teammates.map((m) => ({ ...m, alive: m.id === 0 || m.id === 1, hasBomb: false, planting: false, defusing: false, blind: false, ...(m.id === 0 ? cue : near) })) };
    bot.perc.known.set(5, { id: 5, ...target, tick: 600, seenTick: 600, conf: 100, src: 'see', vx: 0, vy: 0, facing: 0, weapon: 'ak' });
    return {
      acted: (nearAlive) => {
        bot.tactics.coop.cues.set(0, { ...cue, facing: 0, tick: 600, dead: false });
        bot.tactics.coop.apply(nearAlive ? obs : { ...obs, teammates: obs.teammates.map((m) => (m.id === 1 ? { ...m, alive: false } : m)) }, out({ role: 'execute', task: 'execute' }));
        return bot.tactics.coop.acted;
      },
    };
  }

  it('最近的隊友隔牆看不到線索：由真正能補的人接手', () => {
    const r = rig(false);
    expect(r.acted(true)).toBe(true);
    expect(r.acted(false)).toBe(true);
  });

  it('更近的隊友看得到線索：讓他接手，我不搶（原本的行為保留）', () => {
    expect(rig(true).acted(true)).toBe(false);
  });

  it('開關關掉重現 2.6.3：隔牆的最近隊友占住名額，沒人接手', () => {
    setP('coopEligible', false);
    expect(rig(false).acted(true)).toBe(false);
  });
});
