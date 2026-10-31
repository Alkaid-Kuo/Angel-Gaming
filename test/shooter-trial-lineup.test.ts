// 試玩頁的 Bot 等級：基準座位與經營層閘道同一條路（選項逐欄相同、整場雜湊相同）、預設陪練與改前相同、人類與陪練座位不受影響。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchRequest } from '../src/manage/gateway.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { MIN_REACTION_TICKS, ticks } from '../src/shooter/config.ts';
import { LEAGUE_FORMAT_ID, formatOptions, gatewayDriverOptions, outcomeOf, runGatewayMatch } from '../src/shooter/gateway.ts';
import { ShooterHumanController } from '../src/shooter/human.ts';
import { DEFAULT_MAP_ID, MAPS } from '../src/shooter/map.ts';
import { BALANCED_ROLES, ROLE_KNOB, type ShooterRole } from '../src/shooter/players.ts';
import { ScriptController, ShooterBatchController, ShooterDriver, runShooterMatch, runShooterReplay, type ShooterReplay, type ShooterRunOptions } from '../src/shooter/runner.ts';
import { DEFAULT_ATTRIBUTES, PLAYER_COUNT } from '../src/shooter/sim.ts';
import { humanSeat, seatLabels, seatLevels, seatNames, trialHabit, trialRunOptions, trialSpec } from '../src/web/shooter/lineup.ts';
import type { BotLevel, ShooterSetup } from '../src/web/shooter/protocol.ts';

const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'shooter-practice.js');
const baselineBot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'shooter-baseline.js');
const bots = { practice, baseline: () => baselineBot };
const base = (v: 1 | 2 | 3 | 4 | 5): BotLevel => ({ kind: 'baseline', version: v });
const PRACTICE: BotLevel = { kind: 'practice' };
const SEED = 4242;

/** 觀戰設定的等價請求單：10 個 PlayerSpec 與試玩同角色、同版本、同 habit */
function equivalentRequest(seed: number, t: number, ct: number): MatchRequest {
  const side = (from: number, version: number): MatchRequest['a'] => ({ players: BALANCED_ROLES.map((role, i) => ({ lineageId: role, version, config: { habit: trialHabit(seed, from + i) } })) });
  return { formatId: LEAGUE_FORMAT_ID, a: side(0, t), b: side(5, ct), seed };
}

function sameFields(a: ShooterRunOptions, b: ShooterRunOptions): void {
  const fields = (o: ShooterRunOptions): string[] => Object.keys(o).filter((k) => k !== 'record').sort();
  expect(fields(a)).toEqual(fields(b));
  for (const k of fields(a)) {
    if (k === 'controllers') continue;
    expect(a[k as keyof ShooterRunOptions], k).toEqual(b[k as keyof ShooterRunOptions]);
  }
  expect(a.controllers.map((c) => [c.label, c.declaration])).toEqual(b.controllers.map((c) => [c.label, c.declaration]));
}

describe('試玩基準座位與閘道同一條路', () => {
  it('觀戰基準 v3 對 v3：選項逐欄相同、整場成績單與終局雜湊相同、回放可重播', () => {
    const s: ShooterSetup = { team: 'T', seed: SEED, spectate: true, lineup: { team: base(3), enemy: base(3) } };
    const req = equivalentRequest(SEED, 3, 3);
    sameFields(trialRunOptions(s, bots, null), gatewayDriverOptions(req, baselineBot));

    const trial = runShooterMatch(trialRunOptions(s, bots, null));
    const gw = runGatewayMatch(req, baselineBot, { record: true });
    expect(trial.finalHash).toBe(gw.finalHash);
    const outcome = outcomeOf(trial.result, trial.match);
    expect(outcome).toEqual(gw.outcome);
    outcome.rounds.forEach((r, i) => expect(r.phase).toBe(i < 6 ? '上半場' : i < 12 ? '下半場' : `加時 ${Math.floor((i - 12) / 6) + 1}`));
    expect([trial.replay?.header.roundsPerHalf, trial.replay?.header.winRounds]).toEqual([6, 7]);
    expect(trial.replay?.header).toEqual(gw.replay?.header);
    const file = JSON.parse(JSON.stringify({ ...trial.replay, ...seatLabels(s) })) as ShooterReplay & { lineup: string[] };
    expect(file.lineup).toEqual(Array.from({ length: PLAYER_COUNT }, () => '基準 v3'));
    const back = runShooterReplay(file);
    expect(back.desyncTick).toBeNull();
    expect(back.finalHash).toBe(trial.finalHash);
  });

  it('兩隊不同版本也逐欄相同，座位屬性與 trialSpec 對應', () => {
    const s: ShooterSetup = { team: 'T', seed: 77, spectate: true, lineup: { team: base(1), enemy: base(5) } };
    sameFields(trialRunOptions(s, bots, null), gatewayDriverOptions(equivalentRequest(77, 1, 5), baselineBot));
    expect(trialSpec(77, 6, 5)).toEqual({ lineageId: 'support', version: 5, config: { habit: trialHabit(77, 6) } });
  });

  it('habit 只由種子與座位決定，範圍同經營層的 ±60，座位間有差異', () => {
    const hs = Array.from({ length: PLAYER_COUNT }, (_, pid) => trialHabit(SEED, pid));
    expect(hs).toEqual(Array.from({ length: PLAYER_COUNT }, (_, pid) => trialHabit(SEED, pid)));
    expect(hs.every((h) => Number.isInteger(h) && Math.abs(h) <= 60)).toBe(true);
    expect(new Set(hs).size).toBeGreaterThan(1);
  });
});

describe('預設陪練與改前相同', () => {
  const old = (seed: number): ShooterRunOptions => {
    const map = MAPS[DEFAULT_MAP_ID]();
    const controllers = Array.from({ length: PLAYER_COUNT }, (_, i) => new ShooterBatchController(practice, 'shooter-practice.js', seed, i, map));
    return { seed, mapId: map.id, ...formatOptions(LEAGUE_FORMAT_ID), controllers, record: true };
  };

  it('沒帶 lineup 不碰基準 Bot、選項同改前，整場雜湊與改前相同', () => {
    const noBaseline = { practice, baseline: () => { throw new Error('不該編譯基準 Bot'); } };
    for (const lineup of [undefined, { team: PRACTICE, enemy: PRACTICE }]) {
      const s: ShooterSetup = { team: 'T', seed: 5, spectate: true, lineup };
      sameFields(trialRunOptions(s, noBaseline, null), old(5));
      expect(runShooterMatch(trialRunOptions(s, noBaseline, null)).finalHash).toBe(runShooterMatch(old(5)).finalHash);
      expect(seatLabels(s)).toEqual({});
    }
    expect(seatNames({ team: 'CT', seed: 5, spectate: false })).toEqual(['陪練 1α', '陪練 2α', '陪練 3α', '陪練 4α', '陪練 5α', '你', '陪練 2β', '陪練 3β', '陪練 4β', '陪練 5β']);
  });
});

describe('人類與混合陣容', () => {
  it('凍結時間：有人類用預設 10 秒，觀戰是 Bot 對打 3 秒', () => {
    const human = new ShooterHumanController();
    expect(trialRunOptions({ team: 'T', seed: 5, spectate: false }, bots, human).freezeTicks).toBeUndefined();
    const play = new ShooterDriver(trialRunOptions({ team: 'T', seed: 5, spectate: false }, bots, human));
    expect([play.match.freezeTicks, play.match.roundsPerHalf, play.match.winRounds, play.replay?.header.freezeTicks, play.replay?.header.roundsPerHalf]).toEqual([ticks(10), 6, 7, ticks(10), 6]);
    expect(new ShooterDriver(trialRunOptions({ team: 'T', seed: 5, spectate: true }, bots, null)).match.freezeTicks).toBe(ticks(3));
  });

  it('人類當 CT：隊友等級在 5～9、對手在 0～4；人類座位空著不衍生且不延遲', () => {
    const s: ShooterSetup = { team: 'CT', seed: 9, spectate: false, lineup: { team: base(2), enemy: PRACTICE } };
    expect(humanSeat(s)).toBe(5);
    expect(seatLevels(s)).toEqual([PRACTICE, PRACTICE, PRACTICE, PRACTICE, PRACTICE, null, base(2), base(2), base(2), base(2)]);
    const human = new ShooterHumanController();
    const o = trialRunOptions(s, bots, human);
    expect(o.controllers[5]).toBe(human);
    expect(o.attributes?.[5]).toBeUndefined();
    expect(o.knobs?.[5]).toEqual({});
    const d = new ShooterDriver(o);
    expect(d.reactionTicks[5]).toBe(0);
    // 陪練維持原樣：預設屬性、最短延遲；基準照角色
    expect(d.attributes[0]).toEqual(DEFAULT_ATTRIBUTES);
    expect(d.reactionTicks.slice(0, 5)).toEqual([MIN_REACTION_TICKS, MIN_REACTION_TICKS, MIN_REACTION_TICKS, MIN_REACTION_TICKS, MIN_REACTION_TICKS]);
    expect(d.reactionTicks.slice(6).every((t) => t > MIN_REACTION_TICKS)).toBe(true);
    expect(o.knobs?.slice(6).map((k) => k.role)).toEqual((['support', 'anchor', 'lurk', 'awp'] as ShooterRole[]).map((r) => ROLE_KNOB[r]));
    expect(seatNames(s)[6]).toBe('v2 支援β');
    expect(seatLabels(s).lineup?.slice(4, 7)).toEqual(['陪練 v5', '你', '基準 v2']);
  });

  it('基準隊友少一人（人類站著不動）也打得完，沒有 Bot 例外', () => {
    const s: ShooterSetup = { team: 'T', seed: 31, spectate: false, lineup: { team: base(4), enemy: base(4) } };
    const idle = new ScriptController('idle', () => []);
    const run = runShooterMatch({ ...trialRunOptions(s, bots, idle), roundsPerHalf: 2, winRounds: 3, overtime: false });
    expect(run.match.over).toBe(true);
    expect(run.runtime.reduce((n, r) => n + r.exceptions, 0)).toBe(0);
  });
});
