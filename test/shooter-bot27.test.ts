import { afterEach, describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P } from '../bots/shooter-src/base.js';
import type { TacOut } from '../bots/shooter-src/tactics.js';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { shooterHelpers } from '../src/shooter/runner.ts';
import type { ShooterObservation } from '../src/shooter/api.ts';

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
