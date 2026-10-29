// CS 射擊比賽驅動：載入選手 → init → 每 DECISION_INTERVAL tick 呼叫 decide；人類玩家的指令每個 tick 套用；可錄製回放。
// 回放保存比賽選項與每次決策的指令，重播不需要選手程式。
// 時間限制：decide 超過硬上限（50 ms）當該次無指令；同一回合連續超時 idleAfterTimeouts 次，該回合剩下的時間閒置。
// 反應延遲（v1.0 引擎強制）：Bot 在 tick t 決策出的指令排隊到 t + reactionTicks（≥ MIN_REACTION_TICKS）才套用；
// 回合交接時還沒生效的指令作廢。人類玩家（takeRealtime）不延遲。回放記錄實際套用的 tick，重播不需要知道延遲。
import type { KnobValues } from '../api/types.ts';
import { iatan2, offset } from '../shared/geom.ts';
import { roundHalfEven } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import { BotLoadError, type CompiledBot } from '../sandbox/compile.ts';
import { jsonClone, validateDeclaration } from '../sandbox/controller.ts';
import type { ShooterBot, ShooterDeclaration, ShooterHelpers, ShooterInitData, ShooterObservation, Team, WeaponId } from './api.ts';
import { MIN_REACTION_TICKS, SHOOTER_ENGINE_VERSION, TIMING } from './config.ts';
import { DEFAULT_MAP_ID, MAPS, blocksMove, regionsAt, type ShooterMap } from './map.ts';
import { HASH_INTERVAL, PLAYER_COUNT, ShooterMatch, shooterInitData, type ShooterMatchOptions, type ShooterResult } from './sim.ts';
import { lineOfSight } from './vision.ts';

export interface ShooterReplay {
  readonly format: 1;
  readonly kind: 'shooter';
  readonly header: {
    readonly engineVersion: string;
    readonly seed: number;
    readonly mapId: string;
    readonly defaultLoadout?: Partial<Record<Team, WeaponId>>;
    readonly defaultArmor?: number;
    readonly startMoney?: number;
    readonly roundMoney?: readonly [number | null, number | null];
    readonly roundsPerHalf?: number;
    readonly winRounds?: number;
    /** 加時規則（v1.0）；沒寫＝預設 MR3 */
    readonly overtime?: ShooterMatchOptions['overtime'];
    /** 各選手的反應延遲（tick，v1.0；只供查閱，decisions 已是實際套用的 tick） */
    readonly reactionTicks?: readonly number[];
    readonly players: readonly { readonly playerId: number; readonly bot: string; readonly version: string; readonly knobs: KnobValues }[];
  };
  readonly decisions: { readonly tick: number; readonly playerId: number; readonly commands: unknown }[];
  readonly hashes: { readonly tick: number; readonly hash: string }[];
  result: (ShooterResult & { readonly finalHash: string }) | null;
}

export interface CallOutcome<T> {
  readonly value: T;
  readonly exception: string | null;
  /** 超過時間上限 */
  readonly timedOut: boolean;
  readonly elapsedMs: number;
}

export interface ShooterController {
  readonly label: string;
  readonly declaration: ShooterDeclaration;
  init(data: ShooterInitData): CallOutcome<null>;
  decide(obs: ShooterObservation): CallOutcome<unknown>;
  /** 人類玩家：每個 tick 取出介面送來的指令（不必等決策 tick）；Bot 不實作 */
  takeRealtime?(): unknown[];
}

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function shooterHelpers(map: ShooterMap, seed: number, playerId: number): ShooterHelpers {
  const rng = Prng.fromInts(seed, playerId, 0x5eed);
  return {
    random: () => rng.nextFloat(),
    isSolid: (cx, cy) => blocksMove(map, Math.floor(cx), Math.floor(cy)),
    clearLine: (ax, ay, bx, by) => lineOfSight(map, roundHalfEven(ax), roundHalfEven(ay), roundHalfEven(bx), roundHalfEven(by)),
    dist: (ax, ay, bx, by) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)),
    angleTo: (ax, ay, bx, by) => iatan2(roundHalfEven(by - ay), roundHalfEven(bx - ax)),
    offset: (x, y, deg, d) => {
      const [ox, oy] = offset(roundHalfEven(deg), roundHalfEven(d));
      return [roundHalfEven(x) + ox, roundHalfEven(y) + oy];
    },
    regionsAt: (x, y) => regionsAt(map, roundHalfEven(x), roundHalfEven(y)),
  };
}

function timedCall<T>(fn: () => T, limitMs: number, fallback: T): CallOutcome<T> {
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
  return { value, exception, timedOut: elapsedMs > limitMs, elapsedMs };
}

/** 批次模式：與引擎同一執行緒直接呼叫 */
export class ShooterBatchController implements ShooterController {
  readonly label: string;
  readonly declaration: ShooterDeclaration;
  private readonly bot: ShooterBot;
  private helpers: ShooterHelpers;
  private readonly seed: number;
  private readonly playerId: number;
  private mapId: string;

  constructor(compiled: CompiledBot, label: string, seed: number, playerId: number, map: ShooterMap = MAPS[DEFAULT_MAP_ID]()) {
    this.label = label;
    this.seed = seed;
    this.playerId = playerId;
    this.mapId = map.id;
    const Cls = compiled.createClass() as unknown as new () => ShooterBot;
    this.bot = new Cls();
    if (typeof this.bot.decide !== 'function') throw new BotLoadError(`${label}：射擊選手必須有 decide()`);
    this.declaration = validateDeclaration(this.bot.declare(), label);
    this.helpers = shooterHelpers(map, seed, playerId);
  }

  init(data: ShooterInitData): CallOutcome<null> {
    if (data.map.id !== this.mapId && MAPS[data.map.id] !== undefined) {
      this.mapId = data.map.id;
      this.helpers = shooterHelpers(MAPS[data.map.id](), this.seed, this.playerId);
    }
    return timedCall(
      () => {
        this.bot.init?.(data, this.helpers);
        return null;
      },
      TIMING.initMs,
      null,
    );
  }

  decide(obs: ShooterObservation): CallOutcome<unknown> {
    return timedCall(() => this.bot.decide(obs), TIMING.decideHardMs, [] as unknown);
  }
}

/** 腳本控制器（測試與情境用）：直接以函式產生指令，不經過沙盒 */
export class ScriptController implements ShooterController {
  readonly label: string;
  readonly declaration: ShooterDeclaration;
  private readonly fn: (obs: ShooterObservation) => unknown;

  constructor(label: string, fn: (obs: ShooterObservation) => unknown) {
    this.label = label;
    this.fn = fn;
    this.declaration = { name: label, version: '', style: 'script', knobs: [] };
  }

  init(): CallOutcome<null> {
    return { value: null, exception: null, timedOut: false, elapsedMs: 0 };
  }

  decide(obs: ShooterObservation): CallOutcome<unknown> {
    return timedCall(() => this.fn(obs), TIMING.decideHardMs, [] as unknown);
  }
}

export interface ShooterRuntime {
  decisions: number;
  exceptions: number;
  timeouts: number;
  /** 因連續超時而閒置的回合數 */
  idleRounds: number;
  initFailed: boolean;
  decideMsTotal: number;
  decideMsMax: number;
  errors: string[];
}

export interface ShooterRunOptions extends ShooterMatchOptions {
  /** 依 playerId 排列（10 個） */
  readonly controllers: readonly ShooterController[];
  readonly knobs?: readonly KnobValues[];
  readonly record: boolean;
  /** 依 playerId 的 Bot 反應延遲（tick，v1.0）：預設 MIN_REACTION_TICKS，小於下限夾到下限（屬性只能讓它更慢） */
  readonly reactionTicks?: readonly number[];
}

/** 反應延遲夾到下限；非整數取整、非數字用下限 */
export function clampReaction(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return MIN_REACTION_TICKS;
  return Math.max(MIN_REACTION_TICKS, Math.floor(v));
}

export class ShooterDriver {
  readonly match: ShooterMatch;
  readonly replay: ShooterReplay | null;
  readonly runtime: ShooterRuntime[];
  private readonly controllers: readonly ShooterController[];
  /** 同一回合連續超時次數；達上限時該回合閒置 */
  private readonly streak: number[];
  private readonly streakRound: number[] = Array.from({ length: PLAYER_COUNT }, () => 0);
  private readonly idleRound: number[];
  private readonly dead: boolean[];
  /** 各選手的反應延遲（tick）；人類玩家為 0 */
  readonly reactionTicks: readonly number[];
  /** 排隊中的 Bot 指令（依決策順序；套用 tick 遞增） */
  private pending: { readonly at: number; readonly round: number; readonly playerId: number; readonly commands: unknown[] }[] = [];

  constructor(opts: ShooterRunOptions) {
    if (opts.controllers.length !== PLAYER_COUNT) throw new Error(`射擊比賽需要 ${PLAYER_COUNT} 個控制器，收到 ${opts.controllers.length}`);
    const mapId = opts.mapId ?? DEFAULT_MAP_ID;
    this.match = new ShooterMatch({ ...opts, mapId });
    this.controllers = opts.controllers;
    this.runtime = opts.controllers.map(() => ({ decisions: 0, exceptions: 0, timeouts: 0, idleRounds: 0, initFailed: false, decideMsTotal: 0, decideMsMax: 0, errors: [] }));
    this.streak = opts.controllers.map(() => 0);
    this.idleRound = opts.controllers.map(() => 0);
    this.dead = opts.controllers.map(() => false);
    const knobs = opts.knobs ?? opts.controllers.map(() => ({}));
    this.reactionTicks = opts.controllers.map((c, pid) => (c.takeRealtime !== undefined ? 0 : clampReaction(opts.reactionTicks?.[pid])));
    opts.controllers.forEach((c, pid) => {
      const init = { roundsPerHalf: opts.roundsPerHalf, winRounds: opts.winRounds, startMoney: opts.startMoney, overtime: opts.overtime, reactionTicks: this.reactionTicks[pid] };
      const out = c.init(shooterInitData(this.match.map, pid, knobs[pid], init));
      const rt = this.runtime[pid];
      if (out.exception !== null) this.error(pid, `init: ${out.exception}`);
      // init 超時：整場閒置（沿用 RTS／軍團戰）
      if (out.timedOut) {
        rt.initFailed = true;
        this.dead[pid] = true;
      }
    });
    this.replay = opts.record
      ? {
          format: 1,
          kind: 'shooter',
          header: {
            engineVersion: SHOOTER_ENGINE_VERSION,
            seed: opts.seed,
            mapId,
            ...(opts.defaultLoadout !== undefined ? { defaultLoadout: opts.defaultLoadout } : {}),
            ...(opts.defaultArmor !== undefined ? { defaultArmor: opts.defaultArmor } : {}),
            ...(opts.startMoney !== undefined ? { startMoney: opts.startMoney } : {}),
            ...(opts.roundMoney !== undefined ? { roundMoney: opts.roundMoney } : {}),
            ...(opts.roundsPerHalf !== undefined ? { roundsPerHalf: opts.roundsPerHalf } : {}),
            ...(opts.winRounds !== undefined ? { winRounds: opts.winRounds } : {}),
            ...(opts.overtime !== undefined ? { overtime: opts.overtime } : {}),
            reactionTicks: this.reactionTicks,
            players: opts.controllers.map((c, i) => ({ playerId: i, bot: c.declaration.name, version: c.declaration.version ?? '', knobs: knobs[i] })),
          },
          decisions: [],
          hashes: [],
          result: null,
        }
      : null;
  }

  private error(pid: number, text: string): void {
    const rt = this.runtime[pid];
    rt.exceptions += 1;
    if (rt.errors.length < 5) rt.errors.push(text);
  }

  step(): void {
    const m = this.match;
    if (m.over) return;
    // 到期的 Bot 指令先套用（依決策順序）；上一回合決策、還沒生效的作廢
    while (this.pending.length > 0 && this.pending[0].at <= m.tick) {
      const q = this.pending[0];
      this.pending.shift();
      if (q.round !== m.roundNumber) continue;
      this.replay?.decisions.push({ tick: m.tick, playerId: q.playerId, commands: q.commands });
      m.applyCommands(q.playerId, q.commands);
    }
    if (m.isDecisionTick()) {
      // 先讓每個人都觀察完，再依序下指令：後面的人不會看到前面的人剛下的指令
      const views = this.controllers.map((_, pid) => m.observe(pid));
      for (let pid = 0; pid < this.controllers.length; pid++) {
        if (this.dead[pid] || this.idleRound[pid] === m.roundNumber) continue;
        const out = this.controllers[pid].decide(views[pid]);
        const rt = this.runtime[pid];
        rt.decisions += 1;
        rt.decideMsTotal += out.elapsedMs;
        if (out.elapsedMs > rt.decideMsMax) rt.decideMsMax = out.elapsedMs;
        if (out.timedOut) {
          rt.timeouts += 1;
          if (this.streakRound[pid] !== m.roundNumber) {
            this.streakRound[pid] = m.roundNumber;
            this.streak[pid] = 0;
          }
          this.streak[pid] += 1;
          if (this.streak[pid] >= TIMING.idleAfterTimeouts) {
            this.idleRound[pid] = m.roundNumber;
            rt.idleRounds += 1;
          }
          continue;
        }
        this.streak[pid] = 0;
        if (out.exception !== null) {
          this.error(pid, `tick ${m.tick}: ${out.exception}`);
          continue;
        }
        const cmds = out.value;
        if (Array.isArray(cmds) && cmds.length > 0) {
          if (this.reactionTicks[pid] === 0) {
            this.replay?.decisions.push({ tick: m.tick, playerId: pid, commands: cmds });
            m.applyCommands(pid, cmds);
          } else {
            // 依套用 tick 插入（延遲不同的選手可能後決策先生效）；同 tick 維持決策順序
            const at = m.tick + this.reactionTicks[pid];
            let i = this.pending.length;
            while (i > 0 && this.pending[i - 1].at > at) i -= 1;
            this.pending.splice(i, 0, { at, round: m.roundNumber, playerId: pid, commands: cmds as unknown[] });
          }
        }
      }
    }
    // 人類玩家的指令每個 tick 套用，按實際 tick 錄進回放（決策 tick 排在 Bot 之後，與錄製順序一致）
    for (let pid = 0; pid < this.controllers.length; pid++) {
      const take = this.controllers[pid].takeRealtime;
      if (take === undefined || this.dead[pid]) continue;
      const cmds = take.call(this.controllers[pid]);
      if (cmds.length === 0) continue;
      this.replay?.decisions.push({ tick: m.tick, playerId: pid, commands: cmds });
      m.applyCommands(pid, cmds);
    }
    m.step();
    if (this.replay !== null && m.tick % HASH_INTERVAL === 0) this.replay.hashes.push({ tick: m.tick, hash: m.hash() });
    if (m.over && this.replay !== null) this.replay.result = { ...m.result(), finalHash: m.hash() };
  }
}

export interface ShooterRunOutput {
  readonly result: ShooterResult;
  readonly replay: ShooterReplay | null;
  readonly runtime: ShooterRuntime[];
  readonly finalHash: string;
  readonly wallMs: number;
  readonly match: ShooterMatch;
}

export function runShooterMatch(opts: ShooterRunOptions): ShooterRunOutput {
  const t0 = performance.now();
  const d = new ShooterDriver(opts);
  while (!d.match.over) d.step();
  return { result: d.match.result(), replay: d.replay, runtime: d.runtime, finalHash: d.match.hash(), wallMs: performance.now() - t0, match: d.match };
}

/** 回放重建：逐 tick 套用紀錄的指令，比對雜湊 */
export class ShooterReplayCursor {
  readonly match: ShooterMatch;
  readonly replay: ShooterReplay;
  desyncTick: number | null = null;
  private idx = 0;
  private hashIdx = 0;

  constructor(replay: ShooterReplay) {
    if (replay.kind !== 'shooter') throw new Error(`不是射擊回放：${String(replay.kind)}`);
    this.replay = replay;
    const h = replay.header;
    this.match = new ShooterMatch({ seed: h.seed, mapId: h.mapId, defaultLoadout: h.defaultLoadout, defaultArmor: h.defaultArmor, startMoney: h.startMoney, roundMoney: h.roundMoney, roundsPerHalf: h.roundsPerHalf, winRounds: h.winRounds, overtime: h.overtime });
  }

  step(): void {
    const m = this.match;
    if (m.over) return;
    const ds = this.replay.decisions;
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

export function runShooterReplay(replay: ShooterReplay): { finalHash: string; desyncTick: number | null; result: ShooterResult } {
  const c = new ShooterReplayCursor(replay);
  while (!c.match.over) c.step();
  return { finalHash: c.match.hash(), desyncTick: c.desyncTick, result: c.match.result() };
}
