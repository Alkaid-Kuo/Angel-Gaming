import { afterEach, describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P } from '../bots/shooter-src/base.js';
import type { TacOut, TPlan } from '../bots/shooter-src/tactics.js';
import { ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { shooterHelpers } from '../src/shooter/runner.ts';
import type { ShooterObservation } from '../src/shooter/api.ts';

// Bot 2.8 執行品質（M5 規格 3.5）的 regression 測試：熟練度低時退化、q、p ≥ 0.5 時和 2.7 相同、開關 0 時等於 2.7。
// 直接用原始碼（開關 P 與 Bot 共用同一份）。

function live(pid: number): { match: ShooterMatch; bot: ShooterBaseline } {
  const match = new ShooterMatch({ seed: 11, mapId: 'redrock' });
  const bot = new ShooterBaseline();
  bot.init(shooterInitData(match.map, pid, {}), shooterHelpers(match.map, 11, pid));
  match.tick = 600;
  match.phase = 'live';
  match.phaseEnd = 3000;
  bot.newRound(match.observe(pid));
  return { match, bot };
}

const out = (extra: Partial<TacOut> = {}): TacOut => ({ goal: null, route: null, hold: null, objective: false, allowPeek: false, cmds: [], role: 'test', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false, ...extra });

/** 十個戰術同一個熟練度 */
const IDS = ['rushA', 'rushB', 'default', 'splitA', 'splitB', 'fake', 'ct212', 'stackA', 'stackB', 'ctPush'];
const each = (v: number): Record<string, number> => Object.fromEntries(IDS.map((id) => [id, v]));

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

describe('Bot 2.8 第 3 步：隊友閃光炸開後慢半拍（qFlashLate）', () => {
  /** T 執行 rush A 中、還沒進點、看不到敵人；隊伍熟練度 q、個人熟練度 100（不觸發執行後晚出發）；閃光在 since 秒前炸開 */
  function roleAt(q: number, since: number): string {
    const { match, bot } = live(2);
    const raw = match.observe(2);
    // 站在 A 點入口外（離開出生區，不觸發「讓突破手先走」；還沒進點）
    const e = bot.intel.sites.A.entrances[0];
    const obs: ShooterObservation = { ...raw, enemies: [], me: { ...raw.me, hasBomb: false, x: e.ox, y: e.oy } };
    const t = bot.tactics;
    const plan: TPlan = { kind: 'rush', site: 'A', r1: 0, r2: 0, exec: 'A' };
    t.setPlan(plan, obs);
    t.prof = { team: each(q), personal: each(100) };
    t.tagNow = 'rushA';
    t.execTick = obs.tick - 10 * 30;
    t.flashPop = obs.tick - Math.round(since * 30);
    const a = out();
    t.tGoal(obs, a);
    return a.role;
  }

  it('q＝0：炸開後 (0.5−q) × qFlashLate 秒內停下（慢半拍），過了就照常執行', () => {
    const win = 0.5 * P.qFlashLate;
    expect(roleAt(0, win - 0.2)).toBe('慢半拍');
    expect(roleAt(0, win + 0.2)).not.toBe('慢半拍');
  });

  it('q ≥ 0.5 同 2.7：炸開後馬上跟進', () => {
    expect(roleAt(50, 0.3)).not.toBe('慢半拍');
    expect(roleAt(100, 0.3)).not.toBe('慢半拍');
  });

  it('開關 0 ＝ 2.7：q＝0 也不停', () => {
    setP('qFlashLate', 0);
    expect(roleAt(0, 0.3)).not.toBe('慢半拍');
  });
});
