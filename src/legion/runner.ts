// 軍團戰比賽驅動：載入選手 → init／deploy（布陣）→ 每 0.5 秒 decide；可錄製回放。
// 回放保存布陣與指令，重播不需要選手程式。
import type { KnobValues } from '../api/types.ts';
import { RULES as RTS_RULES } from '../config/index.ts';
import { roundHalfEven } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import { BotLoadError, type CompiledBot } from '../sandbox/compile.ts';
import { jsonClone, validateDeclaration } from '../sandbox/controller.ts';
import type { LegionBot, LegionDeclaration, LegionHelpers, LegionInitData, LegionObservation } from './api.ts';
import { LEGION_ENGINE_VERSION, TILE, type LegionMode } from './config.ts';
import { iatan2, offset } from './geom.ts';
import { MAPS, defaultMapId, defaultTimeLimit, heightAt, terrainAt, type LegionMap } from './map.ts';
import { LegionMatch, legionInitData, type LegionResult } from './sim.ts';

export interface LegionReplay {
  readonly format: 1;
  readonly kind: 'legion';
  readonly header: {
    readonly engineVersion: string;
    readonly seed: number;
    readonly mode: LegionMode;
    readonly mapId: string;
    readonly timeLimitTicks: number;
    readonly players: readonly { readonly playerId: number; readonly bot: string; readonly version: string; readonly knobs: KnobValues }[];
    /** 依 playerId：deploy() 的回傳（JSON 安全副本） */
    readonly deployments: readonly unknown[];
  };
  readonly decisions: { readonly tick: number; readonly playerId: number; readonly commands: unknown }[];
  readonly hashes: { readonly tick: number; readonly hash: string }[];
  result: (LegionResult & { readonly finalHash: string }) | null;
}

export interface CallOutcome<T> {
  readonly value: T;
  readonly exception: string | null;
  readonly killed: boolean;
  readonly elapsedMs: number;
}

export interface LegionController {
  readonly label: string;
  readonly declaration: LegionDeclaration;
  init(data: LegionInitData): CallOutcome<null>;
  deploy(data: LegionInitData): CallOutcome<unknown>;
  decide(obs: LegionObservation): CallOutcome<unknown>;
}

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function legionHelpers(map: LegionMap, seed: number, playerId: number): LegionHelpers {
  const rng = Prng.fromInts(seed, playerId, 0x5eed);
  return {
    random: () => rng.nextFloat(),
    terrainAt: (x, y) => terrainAt(map, x, y),
    heightAt: (x, y) => heightAt(map, x, y),
    dist: (ax, ay, bx, by) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)),
    angleTo: (ax, ay, bx, by) => iatan2(roundHalfEven(by - ay), roundHalfEven(bx - ax)),
    offset: (x, y, deg, d) => {
      const [ox, oy] = offset(roundHalfEven(deg), roundHalfEven(d));
      return [roundHalfEven(x) + ox, roundHalfEven(y) + oy];
    },
  };
}

/** 批次模式：與引擎同一執行緒直接呼叫；decide 超過硬上限（50 ms）即整場閒置 */
export class LegionBatchController implements LegionController {
  readonly label: string;
  readonly declaration: LegionDeclaration;
  private readonly bot: LegionBot;
  private helpers: LegionHelpers | null = null;
  private readonly seed: number;
  private readonly playerId: number;
  private mapId: string;

  /** map 只是預設；init 時依實際的地圖重建 helpers */
  constructor(compiled: CompiledBot, label: string, map: LegionMap, seed: number, playerId: number) {
    this.label = label;
    this.seed = seed;
    this.playerId = playerId;
    this.mapId = map.id;
    const Cls = compiled.createClass() as unknown as new () => LegionBot;
    this.bot = new Cls();
    if (typeof this.bot.deploy !== 'function' || typeof this.bot.decide !== 'function') throw new BotLoadError(`${label}：軍團戰選手必須有 deploy() 與 decide()`);
    this.declaration = validateDeclaration(this.bot.declare(), label);
    this.helpers = legionHelpers(map, seed, playerId);
  }

  private call<T>(fn: () => T, limitMs: number, fallback: T): CallOutcome<T> {
    const t0 = performance.now();
    let value = fallback;
    let exception: string | null = null;
    try {
      value = fn();
    } catch (e) {
      exception = errorText(e);
    }
    const elapsedMs = performance.now() - t0;
    if (exception === null) {
      try {
        value = jsonClone(value) as T;
      } catch (e) {
        exception = errorText(e);
        value = fallback;
      }
    }
    return { value, exception, killed: elapsedMs > limitMs, elapsedMs };
  }

  init(data: LegionInitData): CallOutcome<null> {
    const bot = this.bot;
    if (data.map.id !== this.mapId && MAPS[data.map.id] !== undefined) {
      this.mapId = data.map.id;
      this.helpers = legionHelpers(MAPS[data.map.id](), this.seed, this.playerId);
    }
    return this.call(() => {
      bot.init?.(data, this.helpers!);
      return null;
    }, RTS_RULES.timing.initMs, null);
  }

  deploy(data: LegionInitData): CallOutcome<unknown> {
    return this.call(() => this.bot.deploy(data, this.helpers!), RTS_RULES.timing.initMs, [] as unknown);
  }

  decide(obs: LegionObservation): CallOutcome<unknown> {
    return this.call(() => this.bot.decide(obs), RTS_RULES.timing.hardMs, [] as unknown);
  }
}

export interface LegionRuntime {
  decisions: number;
  exceptions: number;
  killed: boolean;
  decideMsTotal: number;
  decideMsMax: number;
  errors: string[];
}

export interface LegionRunOptions {
  readonly seed: number;
  readonly mode: LegionMode;
  readonly mapId?: string;
  /** 依 playerId 排列 */
  readonly controllers: readonly LegionController[];
  readonly knobs: readonly KnobValues[];
  readonly record: boolean;
  readonly timeLimitTicks?: number;
}

export class LegionDriver {
  readonly match: LegionMatch;
  readonly replay: LegionReplay | null;
  readonly runtime: LegionRuntime[];
  private readonly controllers: readonly LegionController[];
  private readonly idle: boolean[];

  constructor(opts: LegionRunOptions) {
    const mapId = opts.mapId ?? defaultMapId(opts.mode);
    const map = MAPS[mapId]();
    const limit = opts.timeLimitTicks ?? defaultTimeLimit(opts.mode);
    this.controllers = opts.controllers;
    this.runtime = opts.controllers.map(() => ({ decisions: 0, exceptions: 0, killed: false, decideMsTotal: 0, decideMsMax: 0, errors: [] }));
    this.idle = opts.controllers.map(() => false);
    const deployments: unknown[] = [];
    opts.controllers.forEach((c, pid) => {
      const data = legionInitData(map, opts.mode, pid, opts.knobs[pid], limit);
      const a = c.init(data);
      this.note(pid, a, 'init');
      const d = this.idle[pid] ? null : c.deploy(data);
      if (d !== null) this.note(pid, d, 'deploy');
      deployments.push(d === null || d.killed ? [] : d.value);
    });
    this.match = new LegionMatch({ seed: opts.seed, mode: opts.mode, mapId, deployments, timeLimitTicks: limit });
    this.replay = opts.record
      ? {
          format: 1,
          kind: 'legion',
          header: {
            engineVersion: LEGION_ENGINE_VERSION,
            seed: opts.seed,
            mode: opts.mode,
            mapId,
            timeLimitTicks: limit,
            players: opts.controllers.map((c, i) => ({ playerId: i, bot: c.declaration.name, version: c.declaration.version ?? '', knobs: opts.knobs[i] })),
            deployments,
          },
          decisions: [],
          hashes: [],
          result: null,
        }
      : null;
  }

  private note(pid: number, out: CallOutcome<unknown>, what: string): void {
    const rt = this.runtime[pid];
    if (out.exception !== null) {
      rt.exceptions += 1;
      if (rt.errors.length < 5) rt.errors.push(`${what}: ${out.exception}`);
    }
    if (out.killed) {
      rt.killed = true;
      this.idle[pid] = true;
    }
  }

  step(): void {
    const m = this.match;
    if (m.over) return;
    if (m.isDecisionTick()) {
      // 先讓每一方都觀察完，再依序下指令：不然後面的一方會先看到前面一方剛下的指令造成的狀態（不公平）
      const views = this.controllers.map((_, pid) => m.observe(pid));
      for (let pid = 0; pid < this.controllers.length; pid++) {
        const obs = views[pid];
        if (this.idle[pid]) continue;
        const out = this.controllers[pid].decide(obs);
        const rt = this.runtime[pid];
        rt.decisions += 1;
        rt.decideMsTotal += out.elapsedMs;
        if (out.elapsedMs > rt.decideMsMax) rt.decideMsMax = out.elapsedMs;
        this.note(pid, out, `tick ${m.tick}`);
        if (out.killed || out.exception !== null) continue;
        const cmds = out.value;
        if (Array.isArray(cmds) && cmds.length > 0) {
          this.replay?.decisions.push({ tick: m.tick, playerId: pid, commands: cmds });
          m.applyCommands(pid, cmds);
        }
      }
    }
    m.step();
    if (this.replay !== null && m.tick % RTS_RULES.replay.hashInterval === 0) this.replay.hashes.push({ tick: m.tick, hash: m.hash() });
    if (m.over && this.replay !== null) this.replay.result = { ...m.result(), finalHash: m.hash() };
  }
}

export interface LegionRunOutput {
  readonly result: LegionResult;
  readonly replay: LegionReplay | null;
  readonly runtime: LegionRuntime[];
  readonly finalHash: string;
  readonly wallMs: number;
  readonly match: LegionMatch;
}

export function runLegionMatch(opts: LegionRunOptions): LegionRunOutput {
  const t0 = performance.now();
  const d = new LegionDriver(opts);
  while (!d.match.over) d.step();
  return { result: d.match.result(), replay: d.replay, runtime: d.runtime, finalHash: d.match.hash(), wallMs: performance.now() - t0, match: d.match };
}

/** 回放重建：逐 tick 套用紀錄的指令，比對雜湊；回傳最終雜湊與第一個不同步的 tick */
export class LegionReplayCursor {
  readonly match: LegionMatch;
  desyncTick: number | null = null;
  private idx = 0;
  private hashIdx = 0;

  readonly replay: LegionReplay;

  constructor(replay: LegionReplay) {
    this.replay = replay;
    const h = replay.header;
    this.match = new LegionMatch({ seed: h.seed, mode: h.mode, mapId: h.mapId, deployments: h.deployments, timeLimitTicks: h.timeLimitTicks });
  }

  step(): void {
    const m = this.match;
    if (m.over) return;
    const ds = this.replay.decisions;
    if (m.isDecisionTick()) for (let pid = 0; pid < m.playerCount; pid++) m.observe(pid);
    while (this.idx < ds.length && ds[this.idx].tick === m.tick) {
      m.applyCommands(ds[this.idx].playerId, ds[this.idx].commands);
      this.idx += 1;
    }
    m.step();
    const hs = this.replay.hashes;
    while (this.hashIdx < hs.length && hs[this.hashIdx].tick < m.tick) this.hashIdx += 1;
    if (this.hashIdx < hs.length && hs[this.hashIdx].tick === m.tick) {
      if (this.desyncTick === null && hs[this.hashIdx].hash !== m.hash()) this.desyncTick = m.tick;
      this.hashIdx += 1;
    }
  }
}

export function runLegionReplay(replay: LegionReplay): { finalHash: string; desyncTick: number | null; result: LegionResult } {
  const c = new LegionReplayCursor(replay);
  while (!c.match.over) c.step();
  return { finalHash: c.match.hash(), desyncTick: c.desyncTick, result: c.match.result() };
}

export { TILE };
