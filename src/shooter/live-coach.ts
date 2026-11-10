// 即時比賽的教練（M5 規格 6.1、6.2、6.5）：包住驅動層，逐 tick 推進；新回合開始、還沒有任何 Bot 為這回合做決策時，
// 若教練按過暫停（或到了換邊點）就停下來等指令。指令寫進請求單的 calls（同一個陣列），所以「請求單＋已喊的指令」批次重跑會得到同一場。
// - 暫停：本回合照打，停在下一回合凍結的第一個 tick 之前；扣次數（正規兩次、加時每段 +1）。
// - 換邊：半場首回合（第 1 回合除外）自動停一次，只能改計畫，不扣次數。
// - 離席（轉一般觀戰、關掉頁面）：記下打到的回合 n；有請助理教練就從 n＋1 回合起由 AI 教練接手（改 coachAi，即時這一場也照辦）。
// - 往回看（2026-11-10，規格 6.5、6.12）：用同一張請求單重建驅動、重跑到要看的回合（比賽是確定性的，同設定就是同一場）。
//   即時打到的最遠 tick 記在 liveTick；驅動在它之前＝回放中，推回它＝回到現場。回放中：
//   - 停點只在超過 frontier 的回合觸發，回放經過的回合（含換邊、喊過暫停的回合）不再停；
//   - 不能下指令（requestPause 回 false、resolve 丟例外），指令陣列只讀；
//   - 停在暫停面板時回看：停點保留，推回現場時再交還同一個停點。
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

/** 回看的目標：推到第 round 回合開始，或推回現場（liveTick） */
type SeekTarget = { readonly round: number } | { readonly live: true };

export class LiveCoach {
  /** 目前在推進的驅動（往回看時換成重建的那個） */
  driver: ShooterDriver;
  readonly side: 'a' | 'b';
  readonly group: 0 | 1;
  /** 玩家喊的指令（請求單 calls 的同一個陣列） */
  readonly calls: CoachEvent[] = [];
  /** 雙方 AI 教練（請求單 coachAi 的同一個物件） */
  readonly ai: { a: number | null; b: number | null };
  /** 生效的指令紀錄（含 AI；比賽結束後就是成績單的 calls）；往回看時換成重建驅動的那份，推回現場時內容與原本相同 */
  log: CoachEvent[];
  readonly rules: CoachRules;
  /** 實際送進驅動的請求單（calls、coachAi 是上面兩個可變的物件） */
  readonly request: MatchRequest;
  private readonly assistant: boolean;
  private readonly bot: CompiledBot;
  private readonly record: boolean;
  /** 已經開始過的最大回合（往回看時不重複停） */
  private frontier = 0;
  /** 即時打到的最遠 tick；驅動在它之前就是回放中 */
  private liveTick = 0;
  /** 即時那場已經打完（之後不能往回看：比賽結束後的回放是全知觀戰） */
  private liveOver = false;
  private seekTarget: SeekTarget | null = null;
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
    this.bot = o.bot;
    this.record = o.record === true;
    const built = this.build();
    this.log = built.log;
    this.driver = built.driver;
  }

  /**
   * 用同一張請求單建驅動（calls、coachAi 是同一個可變物件，已喊的指令都帶著）。
   * 指令排程（各方計畫、已用暫停、AI 教練的上一次暫停、生效紀錄）每次重建都是新的，回放不會重複推進誰的狀態。
   */
  private build(): { driver: ShooterDriver; log: CoachEvent[] } {
    const setup = gatewayDriverSetup(this.request, this.bot, { record: this.record, live: true });
    return { driver: new ShooterDriver(setup.options), log: setup.calls ?? [] };
  }

  /** 回放中：驅動在即時打到的最遠 tick 之前 */
  get replaying(): boolean {
    return this.driver.match.tick < this.liveTick;
  }

  /** 即時打到第幾回合（回放中也是現場的回合） */
  get liveRound(): number {
    return this.frontier;
  }

  /** 正在重跑（往回看或回到現場），要呼叫 seekStep 推進 */
  get seeking(): boolean {
    return this.seekTarget !== null;
  }

  /** 能不能往回看：還在當教練、即時那場還沒打完、已經打過至少一回合 */
  canRewind(): boolean {
    return this.leftAt === null && !this.liveOver && this.frontier >= 1;
  }

  /**
   * 往回看第 round 回合（夾在 1～即時回合）：要往前就重建驅動，否則沿用現在的往後推。之後呼叫 seekStep 推到該回合開始。
   * 回傳是否接受。
   */
  rewind(round: number): boolean {
    if (!this.canRewind() || !Number.isInteger(round)) return false;
    const target = Math.max(1, Math.min(round, this.frontier));
    const m = this.driver.match;
    if (m.roundNumber >= target) {
      const built = this.build();
      this.driver = built.driver;
      this.log = built.log;
    }
    this.seekTarget = { round: target };
    return true;
  }

  /** 回到現場：推回即時打到的最遠 tick（回放中才有意義） */
  backToLive(): boolean {
    if (!this.replaying) return false;
    this.seekTarget = { live: true };
    return true;
  }

  /** 回放中跳到下一回合（不能超過現場） */
  skipRound(): boolean {
    if (!this.replaying) return false;
    const next = this.driver.match.roundNumber + 1;
    this.seekTarget = next > this.frontier ? { live: true } : { round: next };
    return true;
  }

  /**
   * 重跑最多 maxTicks 個 tick（Worker 分段推進，中間回報進度）。到了目標回傳 true。
   * 不會推過現場；推回現場時若停在暫停面板，waiting 會再交出同一個停點。
   */
  seekStep(maxTicks: number): boolean {
    const t = this.seekTarget;
    if (t === null) return true;
    const m = this.driver.match;
    const reached = (): boolean => m.tick >= this.liveTick || ('round' in t && m.roundNumber >= t.round);
    for (let i = 0; i < maxTicks && !reached(); i++) this.driver.step();
    if (!reached()) return false;
    this.seekTarget = null;
    return true;
  }

  /** 停著等教練（null＝照常推進）；回放中不算（面板要收起來，推回現場才交還） */
  get waiting(): CoachStop | null {
    return this.replaying ? null : this.stopped;
  }

  /** 按了暫停、還沒停下（停在下一回合開始前） */
  get pausePending(): boolean {
    return this.wantPause;
  }

  /** 到目前回合為止還剩幾次暫停（照即時回合算；沒回看時 frontier 就是目前回合，與原本相同） */
  timeoutsLeft(): number {
    return timeoutsAllowed(Math.max(1, this.frontier + 1), this.rules) - this.used;
  }

  /** 按暫停：本回合照打，下一回合開始前停。離席後、沒次數、比賽結束、回放中都不行 */
  requestPause(): boolean {
    if (this.leftAt !== null || this.driver.match.over || this.replaying || this.seeking || this.timeoutsLeft() <= 0) return false;
    this.wantPause = true;
    return true;
  }

  cancelPause(): void {
    this.wantPause = false;
  }

  /**
   * 推進一個 tick；新回合開始而且要教練介入時回傳停點（之後要 resolve 才會再推進）。
   * 回放中照推（不停），推回現場那一刻若有沒處理的停點就交還。
   */
  step(): CoachStop | null {
    if (this.replaying) {
      this.driver.step();
      return this.replaying ? null : this.stopped;
    }
    if (this.stopped !== null) return this.stopped;
    const m = this.driver.match;
    if (m.over) return null;
    this.driver.step();
    this.liveTick = Math.max(this.liveTick, m.tick);
    if (m.over) this.liveOver = true;
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
    if (this.replaying || this.seeking) throw new Error('回放中不能下指令');
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

  /** 離席：記下打到的回合；有請助理教練就從下一回合起由 AI 教練接手。停著的話直接繼續（不喊）。回放中先推回現場再離席 */
  leave(): number {
    if (this.leftAt !== null) return this.leftAt;
    if (this.replaying || this.seeking) {
      this.seekTarget = { live: true };
      this.seekStep(Number.MAX_SAFE_INTEGER);
    }
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
