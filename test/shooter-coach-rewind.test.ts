// M5 規格 6.5／6.12：教練模式往回看已打完的回合（真引擎、MR6、對方有 AI 教練、我方有請助理教練）。
// 1 確定性：第 3 回合暫停喊命令、中場改計畫，打到第 9 回合時回到第 2 回合；回放推回現場的雜湊＝即時那時的雜湊，
//   回放中每個決策 tick 的教練畫面資料＝即時那時（視野公平沿用即時的檢查）；打完與「請求單＋指令」批次重跑完全相同。
// 2 停點：回放經過喊過暫停的回合與換邊都不停；超過現場的回合照常停；停在暫停面板時回看，推回現場交還同一個停點。
// 3 回放中不能下指令：requestPause 回 false、resolve 丟例外，指令陣列不變。
// 4 回放中離席：先推回現場再離席，結果＝「同指令、在第 n 回合離席（助理教練接手）」的批次重跑。
// 5 沒回看時行為與原本相同：剩餘暫停次數照即時回合算＝原本照目前回合算，每個 tick 都相同。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import type { MatchRequest, SideSpec } from '../src/manage/gateway.ts';
import { liveRequest } from '../src/manage/live.ts';
import { coachRules, timeoutsAllowed } from '../src/shooter/coach.ts';
import { coachFrame, coachViewId } from '../src/shooter/coach-view.ts';
import { formatOptions, runGatewayMatch } from '../src/shooter/gateway.ts';
import { LiveCoach } from '../src/shooter/live-coach.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
const ROLES = ['entry', 'support', 'anchor', 'lurk', 'awp'];
const ALL = SHOOTER_TACTICS.map((t) => t.id);
const side = (): SideSpec => ({
  players: ROLES.map((lineageId) => ({ lineageId, version: 3, config: { habit: 0, ...Object.fromEntries(ALL.map((t) => [`p_${t}`, 50])) } })),
  team: { ...Object.fromEntries(ALL.map((t) => [`q_${t}`, 50])), ...Object.fromEntries(ALL.map((t) => [`pref_${t}`, 0])), economy: 0 },
});
// 對方（b）有 AI 教練從第 1 回合起代喊；我方（a）是玩家，有請助理教練（離席後接手）
const req: MatchRequest = { formatId: 'shooter-mr6', a: side(), b: side(), seed: 4242, coachAi: { a: null, b: 1 } };
const rules = coachRules(formatOptions(req.formatId));
const tacticFor = (s: 'T' | 'CT', t: string, ct: string): string => (s === 'T' ? t : ct);

/** 推到目標（往回看、回到現場） */
function seekAll(lc: LiveCoach): void {
  while (!lc.seekStep(500));
}

/** 教練畫面資料（我方組 0；跟隨的人固定從 0 號照教練規則換，只看這個 tick 的狀態） */
function frameOf(lc: LiveCoach): string {
  const m = lc.driver.match;
  return JSON.stringify(coachFrame(m, 0, coachViewId(m, 0, 0)));
}

describe('教練模式往回看（真引擎 MR6）', () => {
  it('回到第 2 回合再推回現場：雜湊、畫面資料相同；回放中不停、不能下指令；停在面板時回看交還同一停點；打完＝批次重跑', () => {
    const lc = new LiveCoach({ request: req, bot, side: 'a', assistant: true });
    const frames = new Map<number, string>();
    const stops: [number, string][] = [];
    // 一、即時打到第 9 回合開始：第 2 回合按暫停（停在第 3 回合）、中場改計畫；每個 tick 驗剩餘暫停次數（沒回看時與原本算法相同）
    while (lc.driver.match.roundNumber < 9) {
      const m = lc.driver.match;
      if (m.roundNumber === 2 && !lc.pausePending && lc.calls.length === 0) expect(lc.requestPause()).toBe(true);
      const stop = lc.step();
      const used = lc.calls.filter((c) => c.kind === 'timeout').length;
      expect(lc.timeoutsLeft()).toBe(timeoutsAllowed(Math.max(1, m.roundNumber + 1), rules) - used);
      if (m.isDecisionTick() && m.roundNumber >= 2) frames.set(m.tick, frameOf(lc));
      if (stop === null) continue;
      stops.push([stop.round, stop.kind]);
      if (stop.kind === 'halftime') lc.resolve({ ...stop.plan, economy: 1 }, null);
      else lc.resolve(null, { tactic: tacticFor(stop.side, 'splitB', 'stackA'), buy: 'eco' });
    }
    expect(stops).toEqual([
      [3, 'timeout'],
      [7, 'halftime'],
    ]);
    const liveTick = lc.driver.match.tick;
    const liveHash = lc.driver.match.hash();
    const calls = JSON.stringify(lc.calls);
    const log = JSON.stringify(lc.log);
    expect(lc.replaying).toBe(false);
    expect(lc.rewind(0)).toBe(true);
    expect(lc.rewind(2)).toBe(true);
    // 二、回到第 2 回合：重跑中、回放中都不能下指令
    expect(lc.seeking).toBe(true);
    expect(lc.requestPause()).toBe(false);
    seekAll(lc);
    expect(lc.driver.match.roundNumber).toBe(2);
    expect(lc.replaying).toBe(true);
    expect(lc.liveRound).toBe(9);
    expect(lc.requestPause()).toBe(false);
    expect(lc.pausePending).toBe(false);
    expect(lc.waiting).toBeNull();
    expect(() => lc.resolve(null, { tactic: 'rushA', buy: null })).toThrow();
    const used0 = lc.timeoutsLeft();
    // 回放推回現場：經過第 3 回合（喊過暫停）與第 7 回合（換邊）都不停；畫面資料逐 tick 與即時相同
    let compared = 0;
    while (lc.replaying) {
      expect(lc.step()).toBeNull();
      const m = lc.driver.match;
      expect(lc.timeoutsLeft()).toBe(used0);
      const f = frames.get(m.tick);
      if (f !== undefined && m.isDecisionTick()) {
        expect(frameOf(lc)).toBe(f);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(lc.driver.match.tick).toBe(liveTick);
    expect(lc.driver.match.hash()).toBe(liveHash);
    expect(JSON.stringify(lc.calls)).toBe(calls);
    expect(JSON.stringify(lc.log)).toBe(log);
    // 三、繼續即時：第 9 回合按暫停 → 第 10 回合停（超過現場，照常停）
    expect(lc.requestPause()).toBe(true);
    let stop = lc.step();
    while (stop === null) stop = lc.step();
    expect([stop.round, stop.kind]).toEqual([10, 'timeout']);
    // 停在面板時回看第 8 回合：停點收起、不能下指令；回到現場交還同一個停點
    const at = lc.driver.match.tick;
    expect(lc.rewind(8)).toBe(true);
    seekAll(lc);
    expect(lc.waiting).toBeNull();
    expect(() => lc.resolve(null, null)).toThrow('回放中不能下指令');
    expect(lc.backToLive()).toBe(true);
    seekAll(lc);
    expect(lc.driver.match.tick).toBe(at);
    expect(lc.waiting).toBe(stop);
    lc.resolve(null, { tactic: tacticFor(stop.side, 'fake', 'ctPush'), buy: null });
    // 之後不再喊；加時的換邊停點照常出現，直接繼續（不改計畫）
    while (!lc.driver.match.over) {
      const s = lc.step();
      if (s !== null) {
        expect(s.kind).toBe('halftime');
        lc.resolve(null, null);
      }
    }
    // 打完：不能再往回看（比賽結束後的回放是全知觀戰）
    expect(lc.canRewind()).toBe(false);
    expect(lc.rewind(3)).toBe(false);
    // 四、與「請求單＋指令」批次重跑完全相同（對方 AI 教練的指令也相同）
    const m = lc.driver.match;
    const batch = runGatewayMatch(liveRequest(req, 'a', lc.calls, null, true), bot);
    expect(batch.finalHash).toBe(m.hash());
    expect(batch.outcome.calls).toEqual(lc.log);
    expect(lc.log.some((c) => c.side === 'b' && c.by === 'npc')).toBe(true);
    for (const r of [3, 10]) expect(batch.outcome.rounds[r - 1].tactics?.a).toBe(lc.calls.find((c) => c.round === r)?.call?.tactic);
  }, 900_000);

  it('回放中離席：先推回現場再離席；結果＝在第 n 回合離席、助理教練接手的批次重跑；離席後不能往回看', () => {
    const lc = new LiveCoach({ request: req, bot, side: 'a', assistant: true });
    while (lc.driver.match.roundNumber < 6) {
      if (lc.driver.match.roundNumber === 2 && lc.calls.length === 0) lc.requestPause();
      const stop = lc.step();
      if (stop !== null) lc.resolve(null, { tactic: tacticFor(stop.side, 'rushB', 'stackB'), buy: null });
    }
    for (let i = 0; i < 200; i++) lc.step();
    const liveTick = lc.driver.match.tick;
    expect(lc.rewind(2)).toBe(true);
    seekAll(lc);
    for (let i = 0; i < 50; i++) lc.step();
    expect(lc.replaying).toBe(true);
    const n = lc.leave();
    expect(n).toBe(6);
    expect(lc.driver.match.tick).toBe(liveTick);
    expect(lc.canRewind()).toBe(false);
    expect(lc.rewind(3)).toBe(false);
    while (!lc.driver.match.over) lc.step();
    const batch = runGatewayMatch(liveRequest(req, 'a', lc.calls, n, true), bot);
    expect(batch.finalHash).toBe(lc.driver.match.hash());
    expect(batch.outcome.calls).toEqual(lc.log);
    expect(lc.log.filter((c) => c.side === 'a' && c.round > n).every((c) => c.by === 'npc')).toBe(true);
  }, 900_000);
});
