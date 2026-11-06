// M5 第一批驗收（規格 3.10 第 5、6 條）的量測核心：情境（雙方的熟練度、比賽計畫、教練命令）、單場紀錄、彙總與判定。
// CLI 在 scripts/shooter-coach-acceptance.ts；測試用 test/ 裡的假 Bot 跑同一條管線（test/shooter-coach-acceptance.test.ts）。
// 「無資料」與「0%」分開：Bot 沒喊任何 K: 標籤、或給不給戰術資料打出來的比賽一模一樣（不讀 tactics／coach），
// 依賴標籤或戰術資料的判定一律回報 noData，不算成 0% 也不算未過。
import type { KnobValues } from '../src/api/types.ts';
import type { Attributes, InitTactics, ShooterObservation, Team, TeamOrders } from '../src/shooter/api.ts';
import type { CallOutcome, ShooterController } from '../src/shooter/runner.ts';
import { runShooterMatch } from '../src/shooter/runner.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';
import type { ShooterMatchOptions } from '../src/shooter/sim.ts';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';

/** 戰術代號 → 陣營（內容包 3.1） */
export const TACTIC_SIDE: ReadonlyMap<string, Team> = new Map(SHOOTER_TACTICS.map((t) => [t.id, t.side]));
export const T_TACTICS: readonly string[] = SHOOTER_TACTICS.filter((t) => t.side === 'T').map((t) => t.id);
export const CT_TACTICS: readonly string[] = SHOOTER_TACTICS.filter((t) => t.side === 'CT').map((t) => t.id);
const ALL = [...T_TACTICS, ...CT_TACTICS];

/** 一隊的戰術資料：隊伍執行熟練度、每人相同的個人熟練度、比賽計畫、每回合的教練命令 */
export interface TeamSetup {
  readonly team: Readonly<Record<string, number>>;
  readonly personal: Readonly<Record<string, number>>;
  readonly pref: Readonly<Record<string, number>>;
  readonly economy: 0 | 1 | 2;
  /** 本回合命令的戰術；沒有＝null。有給才走驅動層的 ordersOf（每回合一份），否則走開賽的 orders */
  readonly call?: (round: number, side: Team) => string | null;
}

export type ScenarioId = 'null' | 'plan0' | 'star3' | 'ecoDefault' | 'effSkew' | 'ban' | 'call' | 'strength' | 'strength100';

export interface Scenario {
  readonly id: ScenarioId;
  readonly title: string;
  /** a、b 兩方；null＝沒有教練與熟練度（試玩、對陪練） */
  readonly a: TeamSetup | null;
  readonly b: TeamSetup | null;
}

const each = (v: number, ids: readonly string[] = ALL): Record<string, number> => Object.fromEntries(ids.map((id) => [id, v]));
const setup = (eff: Record<string, number>, pref: Record<string, number> = {}, call?: TeamSetup['call']): TeamSetup => ({ team: eff, personal: eff, pref: { ...each(0), ...pref }, economy: 0, ...(call !== undefined ? { call } : {}) });

/** effSkew 的分組：每邊一半 80、一半 20 */
export const SKEW_HIGH: readonly string[] = ['rushA', 'default', 'splitB', 'ct212', 'stackB'];
export const SKEW_LOW: readonly string[] = ['rushB', 'splitA', 'fake', 'stackA', 'ctPush'];
/** ban 與 call 情境禁用的戰術 */
export const BANNED: readonly string[] = ['rushA', 'fake', 'stackB'];

/** call 情境的命令：依回合輪流指定該陣營的每個戰術（含禁用的，驗證命令蓋過禁用） */
export function rotatingCall(round: number, side: Team): string {
  const list = side === 'T' ? T_TACTICS : CT_TACTICS;
  return list[round % list.length];
}

const mirror = (s: TeamSetup | null): { a: TeamSetup | null; b: TeamSetup | null } => ({ a: s, b: s });

export const SCENARIOS: readonly Scenario[] = [
  { id: 'null', title: '沒有教練與熟練度（coach、tactics 都是 null）', ...mirror(null) },
  { id: 'plan0', title: '計畫全 0、熟練度全 50（多樣性）', ...mirror(setup(each(50))) },
  { id: 'star3', title: '只給 Rush B 3 星', ...mirror(setup(each(50), { rushB: 3 })) },
  { id: 'ecoDefault', title: '只給 Default 2 星（eco 回合不該打）', ...mirror(setup(each(50), { default: 2 })) },
  { id: 'effSkew', title: '計畫全 0、熟練度一半 80 一半 20', ...mirror(setup({ ...each(80, SKEW_HIGH), ...each(20, SKEW_LOW) })) },
  { id: 'ban', title: `禁用 ${BANNED.join('、')}`, ...mirror(setup(each(50), each(-1, BANNED))) },
  { id: 'call', title: '每回合教練命令輪流指定（含禁用的戰術）', ...mirror(setup(each(50), each(-1, BANNED), rotatingCall)) },
  { id: 'strength', title: '整隊熟練度 80 對 20（強度）', a: setup(each(80)), b: setup(each(20)) },
  { id: 'strength100', title: '整隊熟練度 100 對 0（強度）', a: setup(each(100)), b: setup(each(0)) },
];

/** 強度判定（3.10 第 6 條，2026-11-06 使用者改為「無顯著偏差」）：熟練度高的一方回合勝率的 95% 區間含 50%，且點估計 ≥ 48% */
export const STRENGTH_TARGET = '95% 區間含 50%、點估計 ≥ 48%';
/** a 方回合勝率與 95% 區間（以比賽為群集：同一場的回合不獨立，用群集比率估計量的變異數） */
export function roundWinRate(games: readonly GameRow[]): { p: number; lo: number; hi: number; wins: number; rounds: number } {
  const per = games.map((g) => {
    const a = g.rows.filter((r) => r.setup === 'a');
    return { w: a.filter((r) => r.won).length, n: a.length };
  });
  const wins = per.reduce((s, x) => s + x.w, 0);
  const rounds = per.reduce((s, x) => s + x.n, 0);
  const p = rounds === 0 ? 0 : wins / rounds;
  const G = per.length;
  const v = G < 2 || rounds === 0 ? 0 : (G / (G - 1)) * per.reduce((s, x) => s + (x.w - p * x.n) ** 2, 0) / rounds ** 2;
  const half = 1.96 * Math.sqrt(v);
  return { p, lo: p - half, hi: p + half, wins, rounds };
}

export const scenarioById = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (s === undefined) throw new Error(`沒有情境 ${id}（可用：${SCENARIOS.map((x) => x.id).join('、')}）`);
  return s;
};

export type BuyCall = 'eco' | 'force' | 'full';

/** 每組每回合一列 */
export interface RoundRow {
  readonly round: number;
  readonly group: 0 | 1;
  /** 這一組用的是 a 還是 b 的設定 */
  readonly setup: 'a' | 'b';
  readonly side: Team;
  /** 回合戰術標籤（驅動層從 K: 喊話取）；沒喊＝null */
  readonly tag: string | null;
  /** 這組本回合第一則 B: 喊話；沒喊＝null */
  readonly buy: BuyCall | null;
  /** 引擎的全買判定（沒有 B: 喊話時用來分 eco） */
  readonly fullBuy: boolean;
  /** 本回合的教練命令；沒有＝null */
  readonly call: string | null;
  readonly won: boolean;
}

export interface GameRow {
  readonly seed: number;
  /** a 方是哪一組 */
  readonly aGroup: 0 | 1;
  /** 勝方是 a、b，或平手 */
  readonly winner: 'a' | 'b' | null;
  readonly score: readonly number[];
  readonly finalHash: string;
  readonly rows: readonly RoundRow[];
}

/** 十個座位的控制器與選項（依種子建立；同一個種子要能重建出同樣的控制器）；knobs、attributes 沒給＝驅動層預設 */
export type ControllerFactory = (seed: number) => { readonly controllers: ShooterController[]; readonly knobs?: readonly KnobValues[]; readonly attributes?: readonly Attributes[] };

export type FormatOpts = Pick<ShooterMatchOptions, 'roundsPerHalf' | 'winRounds' | 'overtime' | 'freezeTicks'>;

const BUY = /^B:(eco|force|full)$/;

/** 包住控制器：記下每組每回合第一則 B: 喊話（不改指令） */
class BuyLog implements ShooterController {
  readonly label: string;
  readonly declaration: ShooterController['declaration'];
  private readonly inner: ShooterController;
  private readonly group: 0 | 1;
  private readonly buys: Map<string, BuyCall>;
  constructor(inner: ShooterController, group: 0 | 1, buys: Map<string, BuyCall>) {
    this.inner = inner;
    this.group = group;
    this.buys = buys;
    this.label = inner.label;
    this.declaration = inner.declaration;
  }
  init(data: Parameters<ShooterController['init']>[0]): CallOutcome<null> {
    return this.inner.init(data);
  }
  decide(obs: ShooterObservation): CallOutcome<unknown> {
    const out = this.inner.decide(obs);
    const key = `${obs.round.number}:${this.group}`;
    if (!this.buys.has(key) && Array.isArray(out.value)) {
      for (const c of out.value as { type?: unknown; text?: unknown }[]) {
        const hit = c?.type === 'say' && typeof c.text === 'string' ? BUY.exec(c.text) : null;
        if (hit !== null) {
          this.buys.set(key, hit[1] as BuyCall);
          break;
        }
      }
    }
    return out;
  }
}

const initTactics = (s: TeamSetup | null): InitTactics | null => (s === null ? null : { team: s.team, personal: s.personal });
const ordersOf = (s: TeamSetup | null, round: number, side: Team): TeamOrders | null => {
  if (s === null) return null;
  const tactic = s.call?.(round, side) ?? null;
  return { pref: s.pref, economy: s.economy, call: tactic === null ? null : { tactic, buy: null } };
};

/** 跑一場：a 方坐 aGroup（0＝玩家 0～4） */
export function playGame(sc: Scenario, seed: number, aGroup: 0 | 1, make: ControllerFactory, fmt: FormatOpts, mapId = 'redrock'): GameRow {
  const of = (g: 0 | 1): TeamSetup | null => (g === aGroup ? sc.a : sc.b);
  const groupOf = (pid: number): 0 | 1 => (pid < PLAYER_COUNT / 2 ? 0 : 1);
  const buys = new Map<string, BuyCall>();
  const made = make(seed);
  const controllers = made.controllers.map((c, pid) => new BuyLog(c, groupOf(pid), buys));
  const any = sc.a !== null || sc.b !== null;
  const calls = sc.a?.call !== undefined || sc.b?.call !== undefined;
  const run = runShooterMatch({
    seed,
    mapId,
    ...fmt,
    controllers,
    ...(made.knobs !== undefined ? { knobs: made.knobs } : {}),
    ...(made.attributes !== undefined ? { attributes: made.attributes } : {}),
    record: false,
    ...(any ? { tactics: controllers.map((_, pid) => initTactics(of(groupOf(pid)))) } : {}),
    ...(any && !calls ? { orders: [ordersOf(of(0), 0, 'T'), ordersOf(of(1), 0, 'T')] as const } : {}),
    ...(calls ? { ordersOf: (round: number, g: 0 | 1, side: Team) => ordersOf(of(g), round, side) } : {}),
  });
  const rows: RoundRow[] = [];
  for (const r of run.result.rounds) {
    for (const g of [0, 1] as const) {
      const side: Team = r.tGroup === g ? 'T' : 'CT';
      rows.push({
        round: r.number,
        group: g,
        setup: g === aGroup ? 'a' : 'b',
        side,
        tag: run.tacticTags[r.number - 1]?.[g] ?? null,
        buy: buys.get(`${r.number}:${g}`) ?? null,
        fullBuy: r.fullBuy[g],
        call: of(g)?.call?.(r.number, side) ?? null,
        won: r.winnerGroup === g,
      });
    }
  }
  const w = run.result.winner;
  return { seed, aGroup, winner: w === null ? null : w === aGroup ? 'a' : 'b', score: run.result.score, finalHash: run.finalHash, rows };
}

/**
 * 這支 Bot 讀不讀戰術資料：同一個種子，雙方都不給 vs 給了一組差很多的資料（熟練度 80 對 20、Rush B 3 星、禁用、經濟保守），
 * 終局雜湊與回合戰術標籤都相同＝給不給都一樣＝不讀。只用來把依賴戰術資料的判定標成「無資料」，不是 Bot 的驗收項。
 */
export function readsTactics(make: ControllerFactory, seed: number, fmt: FormatOpts, mapId = 'redrock'): boolean {
  const rich: Scenario = { id: 'strength', title: 'probe', a: { ...setup(each(80), { rushB: 3, ...each(-1, BANNED) }), economy: 1 }, b: setup(each(20)) };
  const plain = playGame(SCENARIOS[0], seed, 0, make, fmt, mapId);
  const given = playGame(rich, seed, 0, make, fmt, mapId);
  const tags = (g: GameRow): string => JSON.stringify(g.rows.map((r) => r.tag));
  return plain.finalHash !== given.finalHash || tags(plain) !== tags(given);
}

export type Verdict = 'pass' | 'fail' | 'noData';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly target: string;
  readonly verdict: Verdict;
  /** 顯示用的值；noData 時是原因 */
  readonly value: string;
  /** 樣本數（列或場） */
  readonly n: number;
}

const pct = (a: number, b: number): string => `${((a / b) * 100).toFixed(1)}%`;
const noData = (id: string, title: string, target: string, why: string, n = 0): Check => ({ id, title, target, verdict: 'noData', value: `無資料：${why}`, n });
const judge = (id: string, title: string, target: string, ok: boolean, value: string, n: number): Check => ({ id, title, target, verdict: ok ? 'pass' : 'fail', value, n });

/** 依賴戰術資料的列：有給設定的那一方（null 方不看） */
function configured(sc: Scenario, games: readonly GameRow[]): RoundRow[] {
  return games.flatMap((g) => g.rows).filter((r) => (r.setup === 'a' ? sc.a : sc.b) !== null);
}

const isEco = (r: RoundRow): boolean => (r.buy !== null ? r.buy === 'eco' : !r.fullBuy);

/** 情境的判定；reads＝這支 Bot 讀不讀戰術資料（readsTactics），null＝沒量 */
export function evaluate(sc: Scenario, games: readonly GameRow[], reads: boolean | null): Check[] {
  const all = games.flatMap((g) => g.rows);
  const tagged = all.filter((r) => r.tag !== null);
  const out: Check[] = [];
  const NO_TAG = 'Bot 沒喊任何 K: 戰術標籤';
  const NO_READ = '給不給戰術資料打出來的比賽相同（Bot 不讀 tactics／coach）';
  // 標籤覆蓋率：全部列（含 null 方）
  if (all.length === 0) out.push(noData('coverage', '回合戰術標籤覆蓋率', '≥ 99%', '沒有回合'));
  else if (tagged.length === 0) out.push(noData('coverage', '回合戰術標籤覆蓋率', '≥ 99%', NO_TAG, all.length));
  else out.push(judge('coverage', '回合戰術標籤覆蓋率', '≥ 99%', tagged.length / all.length >= 0.99, `${pct(tagged.length, all.length)}（${tagged.length}/${all.length}）`, all.length));
  if (tagged.length > 0) {
    const bad = tagged.filter((r) => TACTIC_SIDE.get(r.tag as string) !== r.side);
    out.push(judge('validTags', '標籤是該陣營的戰術代號', '100%', bad.length === 0, bad.length === 0 ? '全部合法' : `${bad.length} 列不合法（例：${bad[0].side} 喊 ${bad[0].tag}）`, tagged.length));
  }
  const rows = configured(sc, games).filter((r) => r.tag !== null);
  const needRead = (id: string, title: string, target: string): Check | null => {
    if (tagged.length === 0) return noData(id, title, target, NO_TAG);
    if (reads === false) return noData(id, title, target, NO_READ);
    return null;
  };
  const share = (list: readonly RoundRow[], id: string): number => list.filter((r) => r.tag === id).length;
  switch (sc.id) {
    case 'null':
    case 'strength':
    case 'strength100':
      break;
    case 'plan0': {
      const title = '多樣性：任何 T 戰術佔 T 回合';
      const t = rows.filter((r) => r.side === 'T');
      const pre = needRead('diversity', title, '≤ 40%');
      if (pre !== null) out.push(pre);
      else if (t.length === 0) out.push(noData('diversity', title, '≤ 40%', '沒有帶標籤的 T 回合'));
      else {
        const top = T_TACTICS.map((id) => [id, share(t, id)] as const).sort((x, y) => y[1] - x[1])[0];
        out.push(judge('diversity', title, '≤ 40%', top[1] / t.length <= 0.4, `最多 ${top[0]} ${pct(top[1], t.length)}`, t.length));
      }
      break;
    }
    case 'star3': {
      const title = '3 星勝出：非 eco 的 T 回合打 Rush B';
      const t = rows.filter((r) => r.side === 'T' && !isEco(r));
      const pre = needRead('star3', title, '≥ 50%');
      if (pre !== null) out.push(pre);
      else if (t.length === 0) out.push(noData('star3', title, '≥ 50%', '沒有帶標籤的非 eco T 回合'));
      else out.push(judge('star3', title, '≥ 50%', share(t, 'rushB') / t.length >= 0.5, `${pct(share(t, 'rushB'), t.length)}（${share(t, 'rushB')}/${t.length}）`, t.length));
      break;
    }
    case 'ecoDefault': {
      const title = '狀態蓋過星級：eco 的 T 回合打 Default（2 星）';
      const t = rows.filter((r) => r.side === 'T' && isEco(r));
      const pre = needRead('ecoDefault', title, '0 回合');
      if (pre !== null) out.push(pre);
      else if (t.length === 0) out.push(noData('ecoDefault', title, '0 回合', '沒有帶標籤的 eco T 回合'));
      else out.push(judge('ecoDefault', title, '0 回合', share(t, 'default') === 0, `${share(t, 'default')} 回合（eco T 回合 ${t.length}）`, t.length));
      break;
    }
    case 'effSkew': {
      for (const side of ['T', 'CT'] as const) {
        const title = `熟練度溫和：${side} 方 eff 80 對 20 的戰術平均被選次數比`;
        const s = rows.filter((r) => r.side === side);
        const hi = SKEW_HIGH.filter((id) => TACTIC_SIDE.get(id) === side);
        const lo = SKEW_LOW.filter((id) => TACTIC_SIDE.get(id) === side);
        const pre = needRead(`effSkew${side}`, title, '≤ 2 倍');
        if (pre !== null) out.push(pre);
        else if (s.length === 0) out.push(noData(`effSkew${side}`, title, '≤ 2 倍', `沒有帶標籤的 ${side} 回合`));
        else {
          const h = hi.reduce((n, id) => n + share(s, id), 0) / hi.length;
          const l = lo.reduce((n, id) => n + share(s, id), 0) / lo.length;
          const ratio = l === 0 ? (h === 0 ? 1 : Infinity) : h / l;
          out.push(judge(`effSkew${side}`, title, '≤ 2 倍', ratio <= 2, `${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'} 倍（80：每個 ${h.toFixed(1)}、20：每個 ${l.toFixed(1)}）`, s.length));
        }
      }
      break;
    }
    case 'ban': {
      const title = `禁用的戰術出現（${BANNED.join('、')}）`;
      const pre = needRead('ban', title, '0%');
      if (pre !== null) out.push(pre);
      else if (rows.length === 0) out.push(noData('ban', title, '0%', '沒有帶標籤的回合'));
      else {
        const hit = rows.filter((r) => BANNED.includes(r.tag as string)).length;
        out.push(judge('ban', title, '0%', hit === 0, `${pct(hit, rows.length)}（${hit}/${rows.length}）`, rows.length));
      }
      break;
    }
    case 'call': {
      const title = '命令回合的標籤等於命令';
      // 命令回合不看有沒有標籤：沒喊也算不符（Bot 有喊別的回合時）
      const c = configured(sc, games).filter((r) => r.call !== null);
      const pre = needRead('call', title, '100%');
      if (pre !== null) out.push(pre);
      else if (c.length === 0) out.push(noData('call', title, '100%', '沒有命令回合'));
      else {
        const ok = c.filter((r) => r.tag === r.call).length;
        const banned = c.filter((r) => BANNED.includes(r.call as string));
        const bOk = banned.filter((r) => r.tag === r.call).length;
        out.push(judge('call', title, '100%', ok === c.length, `${pct(ok, c.length)}（${ok}/${c.length}；其中命令禁用戰術 ${bOk}/${banned.length}）`, c.length));
      }
      break;
    }
  }
  if (sc.id === 'strength' || sc.id === 'strength100') {
    const title = `強度：整隊 eff ${sc.id === 'strength' ? '80 對 20' : '100 對 0'}，高熟練度方的回合勝率`;
    const id = sc.id;
    if (games.length === 0) out.push(noData(id, title, STRENGTH_TARGET, '沒有比賽'));
    else if (reads === false) out.push(noData(id, title, STRENGTH_TARGET, NO_READ, games.length));
    else if (tagged.length === 0) out.push(noData(id, title, STRENGTH_TARGET, NO_TAG, games.length));
    else {
      const r = roundWinRate(games);
      const f = (x: number): string => (x * 100).toFixed(1);
      out.push(judge(id, title, STRENGTH_TARGET, r.lo <= 0.5 && r.hi >= 0.5 && r.p >= 0.48, `${f(r.p)}%［${f(r.lo)}, ${f(r.hi)}］（${r.wins}/${r.rounds} 回合、${games.length} 場）`, games.length));
    }
  }
  return out;
}

/** 情境內每個戰術被選的分布（顯示用；只算有給設定的一方） */
export function tagMix(sc: Scenario, games: readonly GameRow[]): Record<Team, Record<string, number>> {
  const mix: Record<Team, Record<string, number>> = { T: {}, CT: {} };
  for (const r of configured(sc, games)) {
    const k = r.tag ?? '(無)';
    mix[r.side][k] = (mix[r.side][k] ?? 0) + 1;
  }
  return mix;
}

/** 整體結論：有任何無資料就是「無資料」（不和通過、未過混算） */
export function overall(checks: readonly Check[]): { verdict: Verdict; text: string } {
  const nd = checks.filter((c) => c.verdict === 'noData');
  const bad = checks.filter((c) => c.verdict === 'fail');
  if (nd.length > 0) return { verdict: 'noData', text: `無資料 ${nd.length} 項（${[...new Set(nd.map((c) => c.value.replace(/^無資料：/, '')))].join('；')}）${bad.length > 0 ? `；另有未過 ${bad.length} 項` : ''}` };
  if (bad.length > 0) return { verdict: 'fail', text: `未過 ${bad.length} 項：${bad.map((c) => c.id).join('、')}` };
  return { verdict: 'pass', text: `全部 ${checks.length} 項通過` };
}
