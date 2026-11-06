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

describe('Bot 2.8 第 2 步：戰術選擇（選法 B）', () => {
  /** 固定序列的亂數（記錄被呼叫幾次） */
  const seq = (vals: number[]): { random: () => number; n: number } => {
    const o = { n: 0, random: (): number => vals[o.n++ % vals.length] };
    return o;
  };
  const orders = (pref: Record<string, number>, tactic: string | null = null): NonNullable<ShooterObservation['coach']> => ({ pref, economy: 1, call: tactic === null ? null : { tactic, buy: null } });

  it('沒資料：不看「本半場用過」，同一串亂數抽出同一個計畫、用同樣次數的亂數（和 2.7 同一個式子）', () => {
    const { match, bot } = live(2);
    const obs = match.observe(2);
    const t = bot.tactics;
    expect(t.hasData()).toBe(false);
    const vals = [0.13, 0.71, 0.42, 0.88, 0.05, 0.6];
    const runs = [new Map<string, number>(), new Map([['splitA', 9], ['splitB', 9], ['rushA', 9]])].map((used) => {
      t.used = used;
      const h = seq(vals);
      t.h = h as unknown as typeof t.h;
      return { plan: t.chooseT(obs), n: h.n };
    });
    expect(runs[1]).toEqual(runs[0]);
  });

  it('有資料：Rush B 3 星多數回合打 Rush B；禁用的不出現', () => {
    const { match, bot } = live(2);
    const obs = match.observe(2);
    const t = bot.tactics;
    t.coach = orders({ rushB: 3, default: -1, fake: -1 });
    const tags: string[] = [];
    for (let i = 0; i < 400; i++) {
      t.used = new Map();
      t.chooseT(obs);
      tags.push(String(t.tagPick));
    }
    expect(tags.filter((x) => x === 'rushB').length / tags.length).toBeGreaterThan(0.5);
    expect(tags.some((x) => x === 'default' || x === 'fake')).toBe(false);
  });

  it('有資料：half 也當 eco（不打 default、fake）；教練命令直接採用、不抽打法', () => {
    const { match, bot } = live(2);
    const obs = match.observe(2);
    const t = bot.tactics;
    t.coach = orders({ default: 3 });
    t.buyCall = 'half';
    const kinds = new Set(Array.from({ length: 200 }, () => t.chooseT(obs).kind));
    expect([...kinds].sort()).toEqual(['rush', 'split']);
    t.coach = orders({}, 'fake');
    const h = seq([0.5]);
    t.h = h as unknown as typeof t.h;
    expect(t.chooseT(obs).kind).toBe('fake');
    expect(t.tagPick).toBe('fake');
    expect(h.n).toBe(1); // 只有路線序號
  });

  it('CT：沒資料照 2.7 規則（沒證據 ct212）；有資料時 3 星蓋過規則、禁用規則選的就換下一個', () => {
    const { match, bot } = live(5);
    const obs = match.observe(5);
    const t = bot.tactics;
    const plain = t.chooseCT(obs);
    expect(t.tagPick).toBe('ct212');
    expect(plain.push).toBeUndefined();
    t.coach = orders({ ctPush: 3 });
    expect(t.chooseCT(obs).push).toBe(true);
    expect(t.tagPick).toBe('ctPush');
    t.coach = orders({ ct212: -1 });
    t.chooseCT(obs);
    expect(t.tagPick).not.toBe('ct212');
  });
});
