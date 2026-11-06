// 攻防戰的教練指令（M5 第四批，規格 6.2、6.3）：請求單的 calls／coachAi → 驅動層每回合的 obs.coach。
// - 指令在該回合凍結時間第一個決策 tick、任何 Bot 決策之前生效（runner 的 ordersOf）；call 只管那一回合，plan 從那回合起一直生效到下次修改。
// - 次數：每方正規兩次暫停、加時每段多一次；換邊（halftime）不扣次數、只能在半場首回合（第 1 回合除外）。不合規則丟例外。
// - AI 教練（NPC 教練與助理教練同一套）：只讀 CoachInputs（己方可知的公開資訊）＋己方計畫、執行熟練度與剩餘暫停次數。
//   規則刻意淺（過渡版；Bot 3.0 的效用層日後接手）：介面與資料流是重點。
// 同一張請求單＋同樣的呼叫順序（runner 每組每回合各呼叫一次、依組別順序）→ 同樣的指令，所以重跑與觀戰都是同一場。
import type { CoachCall, CoachEvent, CoachPlan, MatchRequest, SideSpec } from '../manage/gateway.ts';
import type { OvertimeRules, Team, TeamOrders } from './api.ts';
import { ROUND } from './config.ts';
import type { CoachInputs, ShooterRunOptions } from './runner.ts';
import type { ShooterMatchOptions } from './sim.ts';
import { prefixed, sideOrders } from './team-data.ts';

/** 戰術代號 → 陣營（和內容包 SHOOTER_TACTICS 同一份清單；test/shooter-coach-orders.test.ts 對照） */
export const TACTIC_SIDE: Readonly<Record<string, Team>> = {
  rushA: 'T',
  rushB: 'T',
  default: 'T',
  splitA: 'T',
  splitB: 'T',
  fake: 'T',
  ct212: 'CT',
  stackA: 'CT',
  stackB: 'CT',
  ctPush: 'CT',
};
const TACTIC_IDS = Object.keys(TACTIC_SIDE);

/** 正規的暫停次數；加時每段再多幾次 */
export const TIMEOUTS_REGULATION = 2;
export const TIMEOUTS_PER_OVERTIME = 1;

export interface CoachRules {
  readonly roundsPerHalf: number;
  readonly winRounds: number;
  readonly overtime: OvertimeRules | null;
}

export function coachRules(o: Pick<ShooterMatchOptions, 'roundsPerHalf' | 'winRounds' | 'overtime'>): CoachRules {
  return { roundsPerHalf: o.roundsPerHalf ?? ROUND.roundsPerHalf, winRounds: o.winRounds ?? ROUND.winRounds, overtime: o.overtime === false ? null : (o.overtime ?? ROUND.overtime) };
}

/** 第幾段加時（0＝正規） */
export function overtimeOf(round: number, r: CoachRules): number {
  const k = round - r.roundsPerHalf * 2;
  return r.overtime === null || k <= 0 ? 0 : Math.floor((k - 1) / (r.overtime.roundsPerHalf * 2)) + 1;
}

/** 半場首回合（含第 1 回合、加時每個半場） */
export function firstOfHalf(round: number, r: CoachRules): boolean {
  if (round === 1 || round === r.roundsPerHalf + 1) return true;
  const k = round - r.roundsPerHalf * 2;
  return r.overtime !== null && k > 0 && (k - 1) % r.overtime.roundsPerHalf === 0;
}

/** 打到這一回合時，這一方總共可以用幾次暫停 */
export function timeoutsAllowed(round: number, r: CoachRules): number {
  return TIMEOUTS_REGULATION + TIMEOUTS_PER_OVERTIME * overtimeOf(round, r);
}

/** 檢查玩家的指令（請求單的 calls）；不合規則丟例外（經營層送出前也會先檢查） */
export function validateCalls(calls: readonly CoachEvent[], r: CoachRules): void {
  const used = { a: 0, b: 0 };
  const seen = new Set<string>();
  let last = 0;
  for (const e of calls) {
    if (!Number.isInteger(e.round) || e.round < 1) throw new Error(`教練指令的回合不對：${e.round}`);
    if (e.round < last) throw new Error('教練指令要依回合排序');
    last = e.round;
    if (e.side !== 'a' && e.side !== 'b') throw new Error(`教練指令的一方不對：${String(e.side)}`);
    const key = `${e.round}:${e.side}`;
    if (seen.has(key)) throw new Error(`第 ${e.round} 回合 ${e.side} 方喊了兩次`);
    seen.add(key);
    if (e.kind === 'halftime') {
      if (e.round === 1 || !firstOfHalf(e.round, r)) throw new Error(`第 ${e.round} 回合不是換邊`);
    } else if (e.kind === 'timeout') {
      used[e.side] += 1;
      if (used[e.side] > timeoutsAllowed(e.round, r)) throw new Error(`${e.side} 方第 ${e.round} 回合的暫停超過次數（最多 ${timeoutsAllowed(e.round, r)} 次）`);
    } else throw new Error(`教練指令的種類不對：${String(e.kind)}`);
    if (e.plan !== null) {
      if (e.plan.economy !== 0 && e.plan.economy !== 1 && e.plan.economy !== 2) throw new Error('經濟風格只能是 0、1、2');
      for (const [k, v] of Object.entries(e.plan.pref)) if (!Number.isInteger(v) || v < -1 || v > 3) throw new Error(`偏好只能是 -1～3：${k}`);
    }
    if (e.call !== null) {
      if (e.call.tactic !== null && typeof e.call.tactic !== 'string') throw new Error('命令的戰術不對');
      if (e.call.buy !== null && e.call.buy !== 'full' && e.call.buy !== 'force' && e.call.buy !== 'eco') throw new Error('命令的買法不對');
    }
  }
}

/** AI 教練看得到的東西（型別限制輸入：只有己方可知的資訊） */
export interface AiCoachInput {
  readonly inputs: CoachInputs;
  /** 目前生效的己方比賽計畫 */
  readonly plan: CoachPlan;
  /** 己方的隊伍執行熟練度（0～100） */
  readonly eff: Readonly<Record<string, number>>;
  /** 這一回合之前還剩幾次暫停 */
  readonly timeoutsLeft: number;
  /** 本回合是不是半場最後一回合 */
  readonly lastOfHalf: boolean;
  /** 正規回合到幾勝（判斷對方賽點） */
  readonly winRounds: number;
}

/** AI 教練的決定：要不要喊（暫停或換邊）、改不改計畫、下不下命令 */
export type AiCoachDecision = Pick<CoachEvent, 'kind' | 'plan' | 'call'> | null;

/** 喊暫停的連敗數 */
export const AI_LOSS_STREAK = 3;
/** 平均金錢低於這個就命令存錢 */
export const AI_ECO_MONEY = 2000;

/**
 * AI 教練（規格 6.3，初值）：
 * 1. 換邊（半場首回合、不是第 1 回合）：本場打過、輸多於贏的戰術降一星，贏多的升一星（夾 0～3，禁用的不動）；有改才喊。
 * 2. 暫停（還有次數）：連輸 3 回合（而且這 3 回合裡沒喊過暫停），或正規回合對方到賽點而我方落後。
 *    命令：本陣營偏好 ≥ 0 的戰術中 eff ×（1 ＋ 0.5×本場勝率 − 0.5×本場連敗）最高的（同分取清單順序）；
 *    平均金錢 < 2000 而且不是半場最後一回合就命令存錢，否則買法交給選手。
 */
export function aiCoach(x: AiCoachInput, lastTimeoutRound: number): AiCoachDecision {
  const { inputs } = x;
  if (inputs.firstOfHalf && inputs.round > 1) {
    const pref: Record<string, number> = { ...x.plan.pref };
    let changed = false;
    for (const id of TACTIC_IDS) {
      const p = pref[id] ?? 0;
      if (p < 0) continue;
      const rs = inputs.rounds.filter((r) => r.tactic === id);
      const won = rs.filter((r) => r.won).length;
      const next = won * 2 > rs.length ? Math.min(3, p + 1) : won * 2 < rs.length ? Math.max(0, p - 1) : p;
      if (next !== p) {
        pref[id] = next;
        changed = true;
      }
    }
    return changed ? { kind: 'halftime', plan: { pref, economy: x.plan.economy }, call: null } : null;
  }
  if (x.timeoutsLeft <= 0) return null;
  const rs = inputs.rounds;
  const recent = rs.slice(-AI_LOSS_STREAK);
  const streak = recent.length === AI_LOSS_STREAK && recent.every((r) => !r.won) && lastTimeoutRound < inputs.round - AI_LOSS_STREAK;
  const [mine, theirs] = inputs.score;
  const matchPoint = inputs.overtime === 0 && theirs === x.winRounds - 1 && mine < theirs && lastTimeoutRound !== inputs.round - 1;
  if (!streak && !matchPoint) return null;
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const id of TACTIC_IDS) {
    if (TACTIC_SIDE[id] !== inputs.side || (x.plan.pref[id] ?? 0) < 0) continue;
    const mineRs = rs.filter((r) => r.tactic === id);
    const rate = mineRs.length === 0 ? 0 : mineRs.filter((r) => r.won).length / mineRs.length;
    let lossRun = 0;
    for (let i = mineRs.length - 1; i >= 0 && !mineRs[i].won; i--) lossRun++;
    const score = (x.eff[id] ?? 50) * (1 + 0.5 * rate - 0.5 * lossRun);
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  const call: CoachCall = { tactic: best, buy: inputs.money < AI_ECO_MONEY && !x.lastOfHalf ? 'eco' : null };
  return { kind: 'timeout', plan: null, call };
}

/** 一方請求單的計畫：和閘道同一個解析（sideOrders）；沒有 team＝null */
function sidePlan(side: SideSpec): CoachPlan | null {
  const o = sideOrders(side);
  return o === null ? null : { pref: { ...o.pref }, economy: o.economy };
}

/** 一方的隊伍執行熟練度：和開局資料同一個解析（q_，夾 0～100） */
const sideEff = (side: SideSpec): Record<string, number> => prefixed(side.team, 'q_', 0, 100);

export interface CoachSchedule {
  readonly ordersOf: NonNullable<ShooterRunOptions['ordersOf']>;
  /** 到目前為止生效的指令（依回合、組別順序；比賽結束後就是整場） */
  readonly log: CoachEvent[];
}

/**
 * 請求單的教練指令 → 驅動層的 ordersOf。沒有任何指令（calls 空、coachAi 雙方 null）＝null：閘道照舊用開賽的 orders，
 * 驅動選項和第一批逐欄相同。玩家的指令在 coachAi 接手的回合起不再採用（教練離席：之後由 AI 教練接手或沒人喊）。
 */
export function coachSchedule(request: MatchRequest, rules: CoachRules): CoachSchedule | null {
  const calls = request.calls ?? [];
  const ai = request.coachAi ?? { a: null, b: null };
  if (calls.length === 0 && ai.a === null && ai.b === null) return null;
  validateCalls(calls, rules);
  const plans: Record<'a' | 'b', CoachPlan | null> = { a: sidePlan(request.a), b: sidePlan(request.b) };
  const eff = { a: sideEff(request.a), b: sideEff(request.b) };
  const used = { a: 0, b: 0 };
  const lastTimeout = { a: -99, b: -99 };
  const log: CoachEvent[] = [];
  const ordersOf = (round: number, group: 0 | 1, _side: Team, inputs: CoachInputs): TeamOrders | null => {
    const s = group === 0 ? 'a' : 'b';
    const from = ai[s];
    let ev: CoachEvent | null = null;
    if (from !== null && round >= from) {
      const d = aiCoach({ inputs, plan: plans[s] ?? { pref: {}, economy: 0 }, eff: eff[s], timeoutsLeft: timeoutsAllowed(round, rules) - used[s], lastOfHalf: firstOfHalf(round + 1, rules), winRounds: rules.winRounds }, lastTimeout[s]);
      if (d !== null) ev = { round, side: s, ...d, by: 'npc' };
    } else {
      ev = calls.find((c) => c.round === round && c.side === s) ?? null;
    }
    if (ev !== null) {
      if (ev.kind === 'timeout') {
        used[s] += 1;
        lastTimeout[s] = round;
      }
      if (ev.plan !== null) {
        const cur = plans[s] ?? { pref: {}, economy: 0 };
        plans[s] = { pref: { ...cur.pref, ...ev.plan.pref }, economy: ev.plan.economy };
      }
      log.push(structuredClone(ev));
    }
    const plan = plans[s];
    const call = ev?.call ?? null;
    if (plan === null && call === null) return null;
    return { pref: { ...(plan?.pref ?? {}) }, economy: plan?.economy ?? 0, call };
  };
  return { ordersOf, log };
}
