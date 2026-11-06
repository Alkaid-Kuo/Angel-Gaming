// M5 第四批 4a：教練指令（src/shooter/coach.ts）與閘道（calls、coachAi → 每回合 obs.coach → 成績單 calls）。
// 規格 6.8：1 確定性（第 3、8 回合暫停各喊不同命令、中場改計畫，重跑成績單與雜湊相同）、2 命令生效（標籤＝命令、eco 不全買）、
// 3 次數與時機（第三次正規暫停被拒、中場不扣、加時多一次）、5 AI 教練（只讀 CoachInputs、同一場重跑同一組指令）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import type { CoachEvent, MatchRequest, SideSpec } from '../src/manage/gateway.ts';
import { aiCoach, coachRules, coachSchedule, firstOfHalf, overtimeOf, TACTIC_SIDE, timeoutsAllowed, validateCalls, type AiCoachInput } from '../src/shooter/coach.ts';
import { formatOptions, gatewayDriverOptions, gatewayDriverSetup, runGatewayMatch } from '../src/shooter/gateway.ts';
import type { CoachInputs } from '../src/shooter/runner.ts';
import { runShooterMatch } from '../src/shooter/runner.ts';
import { firstGroupIsT } from '../src/shooter/sim.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
const MR6 = coachRules(formatOptions('shooter-mr6'));
const ROLES = ['entry', 'support', 'anchor', 'lurk', 'awp'];
const ALL = SHOOTER_TACTICS.map((t) => t.id);
const teamSide = (eff: number, pref: Record<string, number> = {}): SideSpec => ({
  players: ROLES.map((lineageId) => ({ lineageId, version: 3, config: { habit: 0, ...Object.fromEntries(ALL.map((t) => [`p_${t}`, eff])) } })),
  team: { ...Object.fromEntries(ALL.map((t) => [`q_${t}`, eff])), ...Object.fromEntries(ALL.map((t) => [`pref_${t}`, pref[t] ?? 0])), economy: 0 },
});
const ev = (round: number, side: 'a' | 'b', kind: CoachEvent['kind'], call: CoachEvent['call'] = null, plan: CoachEvent['plan'] = null): CoachEvent => ({ round, side, kind, plan, call, by: 'human' });

describe('教練指令規則', () => {
  it('戰術陣營表和內容包一致', () => {
    expect(TACTIC_SIDE).toEqual(Object.fromEntries(SHOOTER_TACTICS.map((t) => [t.id, t.side])));
  });

  it('半場首回合、加時段、暫停次數（MR6：每半場 6、MR3 加時）', () => {
    expect([1, 7, 13, 16, 19, 22].every((r) => firstOfHalf(r, MR6))).toBe(true);
    expect([2, 6, 8, 12, 14, 18].some((r) => firstOfHalf(r, MR6))).toBe(false);
    expect([12, 13, 18, 19, 24, 25].map((r) => overtimeOf(r, MR6))).toEqual([0, 1, 1, 2, 2, 3]);
    expect([12, 13, 19].map((r) => timeoutsAllowed(r, MR6))).toEqual([2, 3, 4]);
  });

  it('第三次正規暫停被拒；中場不扣次數；加時第一段可以多一次；換邊只在半場首回合；同回合同一方只能一則；要依回合排序', () => {
    expect(() => validateCalls([ev(2, 'a', 'timeout'), ev(5, 'a', 'timeout'), ev(9, 'a', 'timeout')], MR6)).toThrow(/超過次數/);
    expect(() => validateCalls([ev(2, 'a', 'timeout'), ev(5, 'b', 'timeout'), ev(7, 'a', 'halftime'), ev(9, 'a', 'timeout')], MR6)).not.toThrow();
    expect(() => validateCalls([ev(2, 'a', 'timeout'), ev(7, 'a', 'halftime'), ev(9, 'a', 'timeout'), ev(14, 'a', 'timeout')], MR6)).not.toThrow();
    expect(() => validateCalls([ev(2, 'a', 'timeout'), ev(9, 'a', 'timeout'), ev(14, 'a', 'timeout'), ev(15, 'a', 'timeout')], MR6)).toThrow(/超過次數/);
    expect(() => validateCalls([ev(5, 'a', 'halftime')], MR6)).toThrow(/不是換邊/);
    expect(() => validateCalls([ev(1, 'a', 'halftime')], MR6)).toThrow(/不是換邊/);
    expect(() => validateCalls([ev(3, 'a', 'timeout'), ev(3, 'a', 'timeout')], MR6)).toThrow(/兩次/);
    expect(() => validateCalls([ev(4, 'a', 'timeout'), ev(3, 'b', 'timeout')], MR6)).toThrow(/排序/);
    expect(() => validateCalls([ev(3, 'a', 'timeout', null, { pref: { rushA: 5 }, economy: 0 })], MR6)).toThrow(/偏好/);
  });

  it('計畫解析同一份：非整數的 economy／pref，有排程（AI 教練、沒喊）與沒排程解出同一個計畫', () => {
    const odd: SideSpec = { ...teamSide(50), team: { ...teamSide(50).team, economy: 1.4, pref_rushA: 2.6, pref_fake: -0.6 } };
    const req: MatchRequest = { formatId: 'shooter-mr6', a: odd, b: teamSide(50), seed: 1 };
    const plain = gatewayDriverOptions(req, bot).orders?.[0];
    const sch = coachSchedule({ ...req, coachAi: { a: 99, b: null } }, MR6);
    const inputs: CoachInputs = { round: 1, side: 'T', half: 1, firstOfHalf: true, overtime: 0, score: [0, 0], rounds: [], money: 800 };
    expect(sch?.ordersOf(1, 0, 'T', inputs)).toEqual(plain);
  });

  it('沒有任何指令：沒有排程，驅動選項沒有 ordersOf（和第一批相同）', () => {
    const req: MatchRequest = { formatId: 'shooter-mr6', a: teamSide(50), b: teamSide(50), seed: 1 };
    expect(coachSchedule(req, MR6)).toBeNull();
    expect(coachSchedule({ ...req, calls: [], coachAi: { a: null, b: null } }, MR6)).toBeNull();
    expect(gatewayDriverOptions(req, bot).ordersOf).toBeUndefined();
  });
});

describe('AI 教練（規則 6.3，淺版）', () => {
  const inputs = (p: Partial<CoachInputs>): CoachInputs => ({ round: 5, side: 'T', half: 1, firstOfHalf: false, overtime: 0, score: [1, 3], rounds: [], money: 4000, ...p });
  const base = (p: Partial<AiCoachInput> = {}, ip: Partial<CoachInputs> = {}): AiCoachInput => ({ inputs: inputs(ip), plan: { pref: {}, economy: 0 }, eff: Object.fromEntries(ALL.map((t) => [t, 50])), timeoutsLeft: 2, lastOfHalf: false, winRounds: 7, ...p });
  const lost = (tactic: string, won = false): CoachInputs['rounds'][number] => ({ won, reason: 'elimination', side: 'T', tactic });

  it('連輸 3 回合 → 暫停，命令本陣營熟練度×勝率最高、沒被禁用的戰術；錢少就存錢；半場最後一回合不命令存錢', () => {
    const rounds = [lost('splitA', true), lost('rushB'), lost('rushB'), lost('default')];
    const eff = { ...Object.fromEntries(ALL.map((t) => [t, 50])), rushA: 90, splitA: 60, ct212: 99 };
    const d = aiCoach(base({ eff, plan: { pref: { rushA: -1 }, economy: 0 } }, { rounds, money: 1500 }), -99);
    // rushA 被禁用；splitA 60×1.5＝90 最高；ct212 是 CT 的不算
    expect(d).toEqual({ kind: 'timeout', plan: null, call: { tactic: 'splitA', buy: 'eco' } });
    expect(aiCoach(base({ eff, lastOfHalf: true }, { rounds, money: 1500 }), -99)?.call?.buy).toBeNull();
    // 這 3 回合內喊過暫停就不再喊；沒次數不喊；沒連敗不喊
    expect(aiCoach(base({}, { rounds }), 3)).toBeNull();
    expect(aiCoach(base({ timeoutsLeft: 0 }, { rounds }), -99)).toBeNull();
    expect(aiCoach(base({}, { rounds: [lost('rushA'), lost('rushA', true)] }), -99)).toBeNull();
  });

  it('對方到賽點且我方落後 → 暫停（正規回合）', () => {
    const d = aiCoach(base({}, { score: [4, 6], rounds: [lost('rushA', true)] }), -99);
    expect(d?.kind).toBe('timeout');
    expect(aiCoach(base({}, { score: [6, 6], rounds: [lost('rushA', true)] }), -99)).toBeNull();
  });

  it('換邊：輸多的降一星、贏多的升一星（夾 0～3，禁用不動），有改才喊', () => {
    const rounds = [lost('rushA', true), lost('rushA', true), lost('rushB'), lost('rushB'), lost('fake')];
    const d = aiCoach(base({ plan: { pref: { rushA: 3, rushB: 1, fake: -1 }, economy: 2 } }, { round: 7, firstOfHalf: true, rounds }), -99);
    expect(d).toEqual({ kind: 'halftime', plan: { pref: { rushA: 3, rushB: 0, fake: -1 }, economy: 2 }, call: null });
    expect(aiCoach(base({}, { round: 7, firstOfHalf: true, rounds: [] }), -99)).toBeNull();
    expect(aiCoach(base({}, { round: 1, firstOfHalf: true }), -99)).toBeNull();
  });
});

describe('閘道：教練指令接到每回合 obs.coach（真引擎 MR6）', () => {
  // a 方是組 0：第 3 回合在上半場、第 8 回合在下半場
  const sideAt = (round: number): 'T' | 'CT' => (firstGroupIsT(round <= 6 ? 1 : 2) ? 'T' : 'CT');
  const pick = (round: number, t: string, ct: string): string => (sideAt(round) === 'T' ? t : ct);
  const req: MatchRequest = {
    formatId: 'shooter-mr6',
    a: teamSide(60),
    b: teamSide(60),
    seed: 4242,
    calls: [
      ev(3, 'a', 'timeout', { tactic: pick(3, 'splitB', 'stackB'), buy: 'eco' }),
      ev(7, 'a', 'halftime', null, { pref: { rushA: 3 }, economy: 1 }),
      ev(8, 'a', 'timeout', { tactic: pick(8, 'fake', 'ctPush'), buy: null }),
    ],
  };

  it('同一張請求單（含指令）重跑：成績單、指令紀錄、終局雜湊都相同；命令回合標籤＝命令；eco 命令那回合隊內喊 B:eco', () => {
    const x = runGatewayMatch(req, bot);
    const y = runGatewayMatch(req, bot);
    expect(y.outcome).toEqual(x.outcome);
    expect(y.finalHash).toBe(x.finalHash);
    expect(x.outcome.calls).toEqual(req.calls);
    expect(x.outcome.rounds[2].tactics?.a).toBe(pick(3, 'splitB', 'stackB'));
    expect(x.outcome.rounds[7].tactics?.a).toBe(pick(8, 'fake', 'ctPush'));
    const s = gatewayDriverSetup(req, bot, { record: true });
    const run = runShooterMatch(s.options);
    expect(run.finalHash).toBe(x.finalHash);
    // eco 命令那一回合，a 方隊內第一則買法喊話是 B:eco（存活者留著步槍，所以不看全買判定）
    const [r2, r3] = [run.result.rounds[1].endTick, run.result.rounds[2].endTick];
    const says = (run.replay?.decisions ?? []).filter((d) => d.tick > r2 && d.tick <= r3 && d.playerId < 5).flatMap((d) => d.commands as { type?: string; text?: string }[]).filter((c) => c.type === 'say' && typeof c.text === 'string' && c.text.startsWith('B:'));
    expect(says[0]?.text).toBe('B:eco');
    // 沒喊指令的同一場：結果不同（指令真的有作用）
    expect(runGatewayMatch({ ...req, calls: [] }, bot).finalHash).not.toBe(x.finalHash);
  }, 180_000);

  it('AI 教練代喊 a 方（coachAi a＝1）：重跑同一組指令；指令都合規則、都是 a 方、標成 npc；玩家的指令在 AI 接手後不採用', () => {
    const ai: MatchRequest = { formatId: 'shooter-mr6', a: teamSide(40), b: teamSide(80), seed: 77, coachAi: { a: 1, b: null } };
    const x = runGatewayMatch(ai, bot);
    const y = runGatewayMatch(ai, bot);
    expect(y.outcome).toEqual(x.outcome);
    expect(y.finalHash).toBe(x.finalHash);
    const calls = x.outcome.calls ?? [];
    expect(calls.every((c) => c.side === 'a' && c.by === 'npc')).toBe(true);
    expect(() => validateCalls(calls, MR6)).not.toThrow();
    // 教練離席：第 1～4 回合玩家喊，第 5 回合起 AI 接手；第 6 回合的玩家指令不採用
    const handoff: MatchRequest = { ...ai, calls: [ev(2, 'a', 'timeout', { tactic: 'rushB', buy: null }), ev(6, 'a', 'timeout', { tactic: 'rushA', buy: null })], coachAi: { a: 5, b: null } };
    const h = runGatewayMatch(handoff, bot);
    const hc = h.outcome.calls ?? [];
    expect(hc[0]).toEqual(handoff.calls?.[0]);
    expect(hc.some((c) => c.round === 6 && c.by === 'human')).toBe(false);
    expect(hc.filter((c) => c.round >= 5).every((c) => c.by === 'npc')).toBe(true);
  }, 180_000);
});
