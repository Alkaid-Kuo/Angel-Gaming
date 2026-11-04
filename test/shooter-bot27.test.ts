import { afterEach, describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P } from '../bots/shooter-src/base.js';
import type { TacOut } from '../bots/shooter-src/tactics.js';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { shooterHelpers } from '../src/shooter/runner.ts';
import type { ShooterObservation } from '../src/shooter/api.ts';
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
