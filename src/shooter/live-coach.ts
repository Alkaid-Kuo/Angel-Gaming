// 即時比賽的教練（M5 規格 6.1、6.2、6.5）：包住驅動層，逐 tick 推進；新回合開始、還沒有任何 Bot 為這回合做決策時，
// 若教練按過暫停（或到了換邊點）就停下來等指令。指令寫進請求單的 calls（同一個陣列），所以「請求單＋已喊的指令」批次重跑會得到同一場。
// - 暫停：本回合照打，停在下一回合凍結的第一個 tick 之前；扣次數（正規兩次、加時每段 +1）。
// - 換邊：半場首回合（第 1 回合除外）自動停一次，只能改計畫，不扣次數。
// - 離席（轉一般觀戰、關掉頁面）：記下打到的回合 n；有請助理教練就從 n＋1 回合起由 AI 教練接手（改 coachAi，即時這一場也照辦）。
// 這個檔不碰 DOM：Worker 與 Node 測試用同一份。
import type { CoachCall, CoachEvent, CoachPlan, MatchRequest } from '../manage/gateway.ts';
import type { CompiledBot } from '../sandbox/compile.ts';
import type { Team } from './api.ts';
import { coachRules, firstOfHalf, timeoutsAllowed, validateCalls, type CoachRules } from './coach.ts';
import { formatOptions, gatewayDriverSetup } from './gateway.ts';
import { ShooterDriver } from './runner.ts';
import { sideOrders } from './team-data.ts';

/** 停下來等教練：哪一回合、暫停或換邊、我方陣營、剩幾次暫停、目前的計畫 */
export interface CoachStop {
  readonly round: number;
  readonly kind: 'timeout' | 'halftime';
  readonly side: Team;
  readonly timeoutsLeft: number;
  readonly plan: CoachPlan;
}

export interface LiveCoachOptions {
  /** 這場的請求單（經營層 beginMatchDay 給的；我方的 coachAi 會被設成 null，教練是玩家） */
  readonly request: MatchRequest;
  readonly bot: CompiledBot;
  /** 我方是請求單的哪一方 */
  readonly side: 'a' | 'b';
  /** 有沒有請助理教練（離席後由他接手） */
  readonly assistant: boolean;
  readonly record?: boolean;
}

export class LiveCoach {
  readonly driver: ShooterDriver;
  readonly side: 'a' | 'b';
  readonly group: 0 | 1;
  /** 玩家喊的指令（請求單 calls 的同一個陣列） */
  readonly calls: CoachEvent[] = [];
  /** 雙方 AI 教練（請求單 coachAi 的同一個物件） */
  readonly ai: { a: number | null; b: number | null };
  /** 生效的指令紀錄（含 AI；比賽結束後就是成績單的 calls） */
  readonly log: CoachEvent[];
  readonly rules: CoachRules;
  /** 實際送進驅動的請求單（calls、coachAi 是上面兩個可變的物件） */
  readonly request: MatchRequest;
  private readonly assistant: boolean;
  /** 已經開始過的最大回合（往回看時不重複停） */
  private frontier = 0;
  private wantPause = false;
  private stopped: CoachStop | null = null;
  /** 離席時打到的回合；還在當教練＝null */
  leftAt: number | null = null;
  private used = 0;
  private plan: CoachPlan;

  constructor(o: LiveCoachOptions) {
    this.side = o.side;
    this.group = o.side === 'a' ? 0 : 1;
    this.assistant = o.assistant;
    const ai = o.request.coachAi ?? { a: null, b: null };
    this.ai = { ...ai, [o.side]: null } as { a: number | null; b: number | null };
    const mine = sideOrders(o.side === 'a' ? o.request.a : o.request.b);
    this.plan = { pref: { ...(mine?.pref ?? {}) }, economy: mine?.economy ?? 0 };
    this.request = { ...o.request, calls: this.calls, coachAi: this.ai };
    this.rules = coachRules(formatOptions(o.request.formatId));
    const setup = gatewayDriverSetup(this.request, o.bot, { record: o.record === true, live: true });
    this.log = setup.calls ?? [];
    this.driver = new ShooterDriver(setup.options);
  }

  /** 停著等教練（null＝照常推進） */
  get waiting(): CoachStop | null {
    return this.stopped;
  }

  /** 按了暫停、還沒停下（停在下一回合開始前） */
  get pausePending(): boolean {
    return this.wantPause;
  }

  /** 到目前回合為止還剩幾次暫停 */
  timeoutsLeft(): number {
    return timeoutsAllowed(Math.max(1, this.driver.match.roundNumber + 1), this.rules) - this.used;
  }

  /** 按暫停：本回合照打，下一回合開始前停。離席後、沒次數、比賽結束都不行 */
  requestPause(): boolean {
    if (this.leftAt !== null || this.driver.match.over || this.timeoutsLeft() <= 0) return false;
    this.wantPause = true;
    return true;
  }

  cancelPause(): void {
    this.wantPause = false;
  }

  /** 推進一個 tick；新回合開始而且要教練介入時回傳停點（之後要 resolve 才會再推進） */
  step(): CoachStop | null {
    if (this.stopped !== null) return this.stopped;
    const m = this.driver.match;
    if (m.over) return null;
    this.driver.step();
    const r = m.roundNumber;
    if (m.over || r <= this.frontier) return null;
    this.frontier = r;
    if (this.leftAt !== null) return null;
    const side: Team = m.players.find((p) => p.group === this.group)?.team ?? 'T';
    const half = r > 1 && firstOfHalf(r, this.rules);
    if (half || (this.wantPause && timeoutsAllowed(r, this.rules) - this.used > 0)) {
      this.wantPause = false;
      this.stopped = { round: r, kind: half ? 'halftime' : 'timeout', side, timeoutsLeft: timeoutsAllowed(r, this.rules) - this.used - (half ? 0 : 1), plan: structuredClone(this.plan) };
    }
    return this.stopped;
  }

  /**
   * 教練下完指令、按繼續：換邊只收計畫（沒改就不記）；暫停收命令與計畫（就算都沒給也算用掉一次暫停）。
   * 指令先過 validateCalls（和閘道同一套規則）才寫進 calls。
   */
  resolve(plan: CoachPlan | null, call: CoachCall | null): CoachEvent | null {
    const s = this.stopped;
    if (s === null) throw new Error('現在不是暫停或換邊');
    const changed = plan !== null && JSON.stringify(plan) !== JSON.stringify(s.plan) ? plan : null;
    if (s.kind === 'halftime' && changed === null) {
      this.stopped = null;
      return null;
    }
    const ev: CoachEvent = { round: s.round, side: this.side, kind: s.kind, plan: changed, call: s.kind === 'timeout' ? call : null, by: 'human' };
    validateCalls([...this.calls, ev], this.rules);
    this.calls.push(ev);
    if (ev.kind === 'timeout') this.used += 1;
    if (changed !== null) this.plan = structuredClone(changed);
    this.stopped = null;
    return ev;
  }

  /** 離席：記下打到的回合；有請助理教練就從下一回合起由 AI 教練接手。停著的話直接繼續（不喊） */
  leave(): number {
    if (this.leftAt !== null) return this.leftAt;
    const n = this.stopped !== null ? this.stopped.round - 1 : this.driver.match.roundNumber;
    this.leftAt = n;
    this.stopped = null;
    this.wantPause = false;
    if (this.assistant) this.ai[this.side] = n + 1;
    return n;
  }
}

// 批次重跑用的請求單在經營層（src/manage/live.ts），這裡轉出去給 Worker 與測試
export { liveRequest } from '../manage/live.ts';
