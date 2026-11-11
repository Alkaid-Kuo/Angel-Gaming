// 觀戰／教練模式「看」不能改變比賽（2026-11-11 體驗審查 F1）：播放路徑照 Worker 的呼叫順序出畫面
// （每個 tick 觀察跟隨對象、決策 tick 另取聲音；教練模式出己方視野聯集），打完的終局雜湊必須＝批次閘道。
// 根因：引擎的視野快取只以 tick 為鍵，套用到期的延遲指令（蹲下、開鏡、換槍）後沒有作廢；
// 旁觀者先 observe 過，同一 tick 的 Bot 就拿到套用前的舊視野。
// 種子 4242（一般觀戰）修正前：批次 4:7 雜湊 79345605f7d6e211，播放 3:7。
// 第三項防整類問題：step 之間用種子化亂數挑時機與對象，呼叫各種唯讀函式（observe、教練視野、觀戰彈道、雜湊），終局雜湊不能變。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import type { MatchRequest, SideSpec } from '../src/manage/gateway.ts';
import { liveRequest } from '../src/manage/live.ts';
import type { ShooterMatch } from '../src/shooter/sim.ts';
import { coachFrame, coachViewId, teamObservation } from '../src/shooter/coach-view.ts';
import { gatewayDriverOptions, runGatewayMatch } from '../src/shooter/gateway.ts';
import { LiveCoach } from '../src/shooter/live-coach.ts';
import { ShooterDriver, type ShooterRunOptions } from '../src/shooter/runner.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { Prng } from '../src/shared/prng.ts';
import { recentShots } from '../src/web/shooter/shots.ts';

const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
const ROLES = ['entry', 'support', 'anchor', 'lurk', 'awp'];
const ALL = SHOOTER_TACTICS.map((t) => t.id);
const side = (): SideSpec => ({
  players: ROLES.map((lineageId) => ({ lineageId, version: 3, config: { habit: 0, ...Object.fromEntries(ALL.map((t) => [`p_${t}`, 50])) } })),
  team: { ...Object.fromEntries(ALL.map((t) => [`q_${t}`, 50])), ...Object.fromEntries(ALL.map((t) => [`pref_${t}`, 0])), economy: 0 },
});
const winners = (m: ShooterMatch): string => m.result().rounds.map((r) => r.winnerGroup).join('');

/** 一般觀戰出畫面：每個 tick 看跟隨對象（輪流換人），決策 tick 再取一次聲音（worker.ts loop 的順序） */
function watchFrame(m: ShooterMatch): void {
  const view = m.tick % 10;
  m.observe(view);
  if (m.isDecisionTick()) m.observe(view);
}

describe('觀戰與教練模式出畫面不改變比賽（F1）', () => {
  it('一般觀戰（檔案室回放同一條路）：逐 tick 出畫面打完＝批次閘道', () => {
    const req: MatchRequest = { formatId: 'shooter-mr6', a: side(), b: side(), seed: 4242 };
    const batch = runGatewayMatch(req, bot);
    const d = new ShooterDriver(gatewayDriverOptions(req, bot, { record: true }));
    const m = d.match;
    while (!m.over) {
      d.step();
      watchFrame(m);
    }
    expect(m.result().rounds.length).toBeGreaterThan(6);
    expect(winners(m)).toBe(batch.outcome.rounds.map((r) => (r.winner === 'a' ? 0 : 1)).join(''));
    expect(m.hash()).toBe(batch.finalHash);
    expect(d.replay?.result?.finalHash).toBe(batch.finalHash);
  }, 600_000);

  it('教練模式（含中場換邊之後）：每個 tick 出己方視野聯集打完＝「請求單＋指令」批次重跑', () => {
    const req: MatchRequest = { formatId: 'shooter-mr6', a: side(), b: side(), seed: 4242, coachAi: { a: null, b: 1 } };
    const lc = new LiveCoach({ request: req, bot, side: 'a', assistant: true, record: true });
    let viewId = 0;
    let halftime = false;
    while (!lc.driver.match.over) {
      const stop = lc.step();
      const m = lc.driver.match;
      viewId = coachViewId(m, 0, viewId);
      coachFrame(m, 0, viewId);
      if (m.isDecisionTick()) m.observe(viewId);
      if (stop === null) continue;
      if (stop.kind === 'halftime') halftime = true;
      lc.resolve(null, null);
    }
    expect(halftime).toBe(true);
    const m = lc.driver.match;
    expect(m.result().rounds.length).toBeGreaterThan(6);
    const batch = runGatewayMatch(liveRequest(req, 'a', lc.calls, null, true), bot);
    expect(winners(m)).toBe(batch.outcome.rounds.map((r) => (r.winner === 'a' ? 0 : 1)).join(''));
    expect(m.hash()).toBe(batch.finalHash);
  }, 600_000);

  // 整類問題：任何「step 之間的唯讀呼叫」都不能改變比賽。時機、對象用種子化亂數挑（短賽制省時間）
  it('任意 step 之間對任意選手 observe、出觀戰全狀態、算教練視野：終局雜湊＝不看的那場', () => {
    for (const seed of [11, 4242, 2026]) {
      const req: MatchRequest = { formatId: 'shooter-mr6', a: side(), b: side(), seed };
      const opts = (): ShooterRunOptions => ({ ...gatewayDriverOptions(req, bot), roundsPerHalf: 3, winRounds: 4, overtime: false });
      const plain = new ShooterDriver(opts());
      while (!plain.match.over) plain.step();
      const d = new ShooterDriver(opts());
      const m = d.match;
      const rng = Prng.fromInts(seed, 0xf1);
      let looked = 0;
      while (!m.over) {
        d.step();
        // 平均每 2 個 tick 看一次，一次看 1～3 樣
        if (rng.nextInt(2) !== 0) continue;
        for (let k = rng.nextInt(3); k >= 0; k--) {
          const pid = rng.nextInt(10);
          const group = (pid < 5 ? 0 : 1) as 0 | 1;
          const what = rng.nextInt(4);
          if (what === 0) m.observe(pid);
          else if (what === 1) coachFrame(m, group, coachViewId(m, group, pid));
          else if (what === 2) teamObservation(m, group, pid);
          else {
            recentShots(m, m.tick - 30);
            m.hash();
          }
          looked += 1;
        }
      }
      expect(looked).toBeGreaterThan(1000);
      expect(winners(m)).toBe(winners(plain.match));
      expect(m.hash()).toBe(plain.match.hash());
    }
  }, 900_000);
});
