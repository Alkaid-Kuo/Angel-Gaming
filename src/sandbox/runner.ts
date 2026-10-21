// 比賽驅動：依 tick 順序呼叫引擎與選手控制器；正式模式可平行決策，套用一律依 playerId 順序。
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

export async function runMatch(opts: RunMatchOptions): Promise<RunMatchOutput> {
  const t0 = performance.now();
  const n = opts.controllers.length;
  const match = new Match({ mode: opts.mode, seed: opts.seed, players: opts.knobs.map((k) => ({ knobs: k })) });
  const replay = opts.record
    ? createReplay(opts.mode, opts.seed, opts.controllers.map((c, i) => ({ playerId: i, bot: c.declaration.name, version: c.declaration.version ?? '', knobs: opts.knobs[i] })))
    : null;
  const runtime = opts.controllers.map(() => emptyRuntime());
  const idle = new Array<boolean>(n).fill(false);
  const noteError = (pid: number, msg: string): void => {
    runtime[pid].exceptions += 1;
    if (runtime[pid].errors.length < MAX_ERRORS) runtime[pid].errors.push(`tick ${match.tick}: ${msg}`);
  };

  // init：開局 tick 0 前呼叫一次
  const inits: (InitOutcome | Promise<InitOutcome>)[] = opts.controllers.map((c, pid) => c.init(match.initData(pid)));
  for (let pid = 0; pid < n; pid++) {
    const r = inits[pid];
    const out = isPromise(r) ? await r : r;
    if (out.exception !== null) noteError(pid, `init: ${out.exception}`);
    if (out.killed) {
      idle[pid] = true;
      runtime[pid].initKilled = true;
    }
  }

  const pending: (DecideOutcome | Promise<DecideOutcome> | null)[] = new Array(n).fill(null);
  while (!match.over) {
    match.beginTick();
    if (match.isDecisionTick()) {
      for (let pid = 0; pid < n; pid++) {
        pending[pid] = null;
        if (!match.isAlive(pid)) continue;
        if (idle[pid]) {
          match.discardObservation(pid);
          continue;
        }
        const packet: ObservationPacket = match.observe(pid);
        pending[pid] = opts.controllers[pid].decide(packet);
      }
      for (let pid = 0; pid < n; pid++) {
        const r = pending[pid];
        if (r === null) continue;
        const out = isPromise(r) ? await r : r;
        const rt = runtime[pid];
        rt.decisions += 1;
        rt.decideMsTotal += out.elapsedMs;
        if (out.elapsedMs > rt.decideMsMax) rt.decideMsMax = out.elapsedMs;
        if (out.exception !== null) noteError(pid, out.exception);
        if (out.killed) {
          idle[pid] = true;
          rt.hardKilled = true;
          continue;
        }
        if (out.voided) {
          rt.softTimeouts += 1;
          replay?.decisions.push({ tick: match.tick, playerId: pid, commands: out.commands, voided: true });
          continue;
        }
        const empty = Array.isArray(out.commands) && out.commands.length === 0;
        if (!empty) replay?.decisions.push({ tick: match.tick, playerId: pid, commands: out.commands });
        match.applyCommands(pid, out.commands);
      }
    }
    match.endTick();
    if (replay !== null && isHashTick(match.tick)) replay.hashes.push({ tick: match.tick, hash: match.hash() });
  }
  const result = match.result();
  const finalHash = match.hash();
  if (replay !== null) replay.result = { ranking: result.ranking, durationTicks: result.durationTicks, finalHash };
  return { result, replay, runtime, finalHash, wallMs: performance.now() - t0, map: match.state.map, slotOf: match.state.players.map((p) => p.slot) };
}
