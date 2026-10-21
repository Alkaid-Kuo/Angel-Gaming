// 比賽驅動：依 tick 順序呼叫引擎與選手控制器；正式模式可平行決策，套用一律依 playerId 順序。
// MatchDriver 可逐 tick 推進（瀏覽器對局用），runMatch 一路跑到結束（CLI 用）。
import type { KnobValues } from '../api/types.ts';
import type { MatchMode } from '../config/index.ts';
import { Match, type MatchResult } from '../core/match.ts';
import type { ObservationPacket } from '../core/observe.ts';
import type { GeneratedMap } from '../mapgen/index.ts';
import { createReplay, isHashTick, type ReplayFile } from '../replay/index.ts';
import type { BotController, DecideOutcome, InitOutcome } from './controller.ts';

export interface BotRuntimeStats {
  decisions: number;
  softTimeouts: number;
  exceptions: number;
  hardKilled: boolean;
  initKilled: boolean;
  decideMsTotal: number;
  decideMsMax: number;
  /** 前幾筆例外訊息（供除錯） */
  errors: string[];
}

export interface RunMatchOptions {
  readonly mode: MatchMode;
  readonly seed: number;
  /** 依 playerId 排列 */
  readonly controllers: readonly BotController[];
  readonly knobs: readonly KnobValues[];
  readonly record: boolean;
  /** 各 playerId 是否不限指令額度（人類玩家） */
  readonly unlimitedBudget?: readonly boolean[];
}

export interface RunMatchOutput {
  readonly result: MatchResult;
  readonly replay: ReplayFile | null;
  readonly runtime: BotRuntimeStats[];
  readonly finalHash: string;
  readonly wallMs: number;
  readonly map: GeneratedMap;
  /** 各 playerId 的起點槽位 */
  readonly slotOf: number[];
}

const MAX_ERRORS = 5;

function emptyRuntime(): BotRuntimeStats {
  return { decisions: 0, softTimeouts: 0, exceptions: 0, hardKilled: false, initKilled: false, decideMsTotal: 0, decideMsMax: 0, errors: [] };
}

function isPromise<T>(v: T | Promise<T>): v is Promise<T> {
  return typeof (v as { then?: unknown }).then === 'function';
}

export class MatchDriver {
  readonly match: Match;
  readonly replay: ReplayFile | null;
  readonly runtime: BotRuntimeStats[];
  private readonly controllers: readonly BotController[];
  private readonly idle: boolean[];
  private readonly pending: (DecideOutcome | Promise<DecideOutcome> | null)[];

  constructor(opts: RunMatchOptions) {
    const n = opts.controllers.length;
    this.controllers = opts.controllers;
    const unlimited = opts.unlimitedBudget ?? [];
    this.match = new Match({ mode: opts.mode, seed: opts.seed, players: opts.knobs.map((k, i) => ({ knobs: k, unlimitedBudget: unlimited[i] === true })) });
    this.replay = opts.record
      ? createReplay(
          opts.mode,
          opts.seed,
          opts.controllers.map((c, i) => ({ playerId: i, bot: c.declaration.name, version: c.declaration.version ?? '', knobs: opts.knobs[i], ...(unlimited[i] === true ? { unlimitedBudget: true } : {}) })),
        )
      : null;
    this.runtime = opts.controllers.map(() => emptyRuntime());
    this.idle = new Array<boolean>(n).fill(false);
    this.pending = new Array<DecideOutcome | Promise<DecideOutcome> | null>(n).fill(null);
  }

  private noteError(pid: number, msg: string): void {
    this.runtime[pid].exceptions += 1;
    if (this.runtime[pid].errors.length < MAX_ERRORS) this.runtime[pid].errors.push(`tick ${this.match.tick}: ${msg}`);
  }

  /** 開局 tick 0 前呼叫各選手的 init */
  async init(): Promise<void> {
    const inits: (InitOutcome | Promise<InitOutcome>)[] = this.controllers.map((c, pid) => c.init(this.match.initData(pid)));
    for (let pid = 0; pid < inits.length; pid++) {
      const r = inits[pid];
      const out = isPromise(r) ? await r : r;
      if (out.exception !== null) this.noteError(pid, `init: ${out.exception}`);
      if (out.killed) {
        this.idle[pid] = true;
        this.runtime[pid].initKilled = true;
      }
    }
  }

  /** 推進一個 tick */
  async stepTick(): Promise<void> {
    const match = this.match;
    const n = this.controllers.length;
    match.beginTick();
    if (match.isDecisionTick()) {
      for (let pid = 0; pid < n; pid++) {
        this.pending[pid] = null;
        if (!match.isAlive(pid)) continue;
        if (this.idle[pid]) {
          match.discardObservation(pid);
          continue;
        }
        const packet: ObservationPacket = match.observe(pid);
        this.pending[pid] = this.controllers[pid].decide(packet);
      }
      for (let pid = 0; pid < n; pid++) {
        const r = this.pending[pid];
        if (r === null) continue;
        const out = isPromise(r) ? await r : r;
        this.applyOutcome(pid, out);
      }
    }
    match.endTick();
    if (this.replay !== null && isHashTick(match.tick)) this.replay.hashes.push({ tick: match.tick, hash: match.hash() });
    if (match.over && this.replay !== null) {
      const result = match.result();
      this.replay.result = { ranking: result.ranking, durationTicks: result.durationTicks, finalHash: match.hash() };
    }
  }

  private applyOutcome(pid: number, out: DecideOutcome): void {
    const rt = this.runtime[pid];
    rt.decisions += 1;
    rt.decideMsTotal += out.elapsedMs;
    if (out.elapsedMs > rt.decideMsMax) rt.decideMsMax = out.elapsedMs;
    if (out.exception !== null) this.noteError(pid, out.exception);
    if (out.killed) {
      this.idle[pid] = true;
      rt.hardKilled = true;
      return;
    }
    const tick = this.match.tick;
    if (out.voided) {
      rt.softTimeouts += 1;
      this.replay?.decisions.push({ tick, playerId: pid, commands: out.commands, voided: true });
      return;
    }
    const empty = Array.isArray(out.commands) && out.commands.length === 0;
    if (!empty) this.replay?.decisions.push({ tick, playerId: pid, commands: out.commands });
    this.match.applyCommands(pid, out.commands);
  }
}

export async function runMatch(opts: RunMatchOptions): Promise<RunMatchOutput> {
  const t0 = performance.now();
  const driver = new MatchDriver(opts);
  await driver.init();
  while (!driver.match.over) await driver.stepTick();
  const match = driver.match;
  return {
    result: match.result(),
    replay: driver.replay,
    runtime: driver.runtime,
    finalHash: match.hash(),
    wallMs: performance.now() - t0,
    map: match.state.map,
    slotOf: match.state.players.map((p) => p.slot),
  };
}
