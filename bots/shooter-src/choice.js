// @ts-check
// 3.0 效用式個人層（丙-1，設計 docs/2026-11-10_CS射擊_Bot3.0效用式個人層設計.md）。
// 第一步影子模式：照算候選、特徵、分數、承諾，記錄前三名與「r7l 實際做的動作」，行為仍由 tactics／combat／nav 驅動（不回傳任何指令）。
// 特徵表資料驅動（審查決定 3）：每筆 { key, fn, types }，打分只走訪 FEATURES 與 P.U。
import { P, UNIT, dijkstra, dist } from './base.js';
import { ENTRY } from './roles.js';

/** 動作字母（第七節正式格式）：h 守、a 推進、p 探頭、f 退掩體、t 補槍、g 丟道具、r 轉點、o 下包／拆包 */
export const ACTS = /** @type {const} */ (['h', 'a', 'p', 'f', 't', 'g', 'r', 'o']);
/** @typedef {typeof ACTS[number]} Act */
/** 計畫階段（f11） */
export const STAGES = /** @type {const} */ (['freeze', 'setup', 'wait', 'execute', 'post', 'retake', 'save']);
/** @typedef {typeof STAGES[number]} Stage */
/** 候選：type 動作、k 同種內序號、x／y 動作結束時人在的位置、ref 參數（隊友 id、入口序號…） @typedef {{ type: Act, k: number, x: number, y: number, ref: number }} Cand */
/**
 * 決策脈絡（只讀觀察與自己的狀態）
 * @typedef {{ obs: import('./base.js').Observation, stage: Stage, goal: import('./base.js').Pt | null, threats: import('./memory.js').Threat[], mates: import('./base.js').Observation['teammates'], role: number, cur: Cand | null, held: number, entry: number }} Ctx
 */
/** @typedef {{ key: string, fn: (c: Ctx, a: Cand) => number, types: string }} Feature */
/** 決策紀錄 @typedef {{ tick: number, ev: string, top: [string, number][], pick: string, act: string, stage: Stage, fight: boolean }} LogEntry */


/** 目標點的威脅清單裡，有視線看得到目標點的個數 @param {Ctx} c @param {Cand} a @param {import('./base.js').Grid} g */
function exposed(c, a, g) {
  let n = 0;
  for (const q of c.threats) if (dist(q.x, q.y, a.x, a.y) < 40 * UNIT && g.los(q.x, q.y, a.x, a.y)) n++;
  return n;
}

export class Choice {
  /**
   * @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./memory.js').Perception} perc
   * @param {import('./base.js').InitData} data
   */
  constructor(g, intel, perc, data) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.data = data;
    this.tps = data.rules.ticksPerSecond;
    /** 錯開：隊內序號（審查意見 C） */
    this.slot = data.slot;
    /** @type {LogEntry[]} */
    this.log = [];
    /** @type {Cand | null} */
    this.cur = null;
    this.since = -1;
    this.lastTick = -1e9;
    /** 事件偵測用的上一次狀態 */
    this.seen = 0;
    this.hp = 100;
    this.mates = 0;
    this.bomb = '';
    this.chatN = 0;
    /** 計畫目標的距離場（目標格變了才重算） @type {Float64Array | null} */
    this.goalField = null;
    this.goalCell = -1;
    /** @type {Feature[]} */
    this.features = this.table();
  }

  reset() {
    this.cur = null;
    this.since = -1;
    this.lastTick = -1e9;
    this.seen = 0;
    this.hp = 100;
    this.mates = 0;
    this.bomb = '';
  }

  /** 特徵表（第五節；影子模式先實作對應 r7l 必要的子集，其餘回 0，之後逐項補） @returns {Feature[]} */
  table() {
    const g = this.g;
    const perc = this.perc;
    const intel = this.intel;
    /** @param {Cand} a */
    const cell = (a) => g.cellOf(a.x, a.y);
    return [
      { key: 'f1', types: 'hfrt', fn: (_c, a) => { const i = cell(a); return i < 0 ? 0 : Math.min(1, perc.danger[i] / 60); } },
      { key: 'f3', types: 'hft', fn: (c, a) => { if (c.threats.length === 0) { const i = cell(a); return i < 0 ? 0 : (intel.cover[i] !== 0 ? 1 : 0); } return 1 - exposed(c, a, g) / c.threats.length; } },
      { key: 'f4', types: 'hpa', fn: (c, a) => { if (c.threats.length === 0) { const i = cell(a); return i < 0 ? 0 : Math.min(1, intel.exposure[i] / 8); } return Math.min(1, exposed(c, a, g) / 3); } },
      { key: 'f5', types: 'art', fn: (c, a) => { let d = 1e9; for (const m of c.mates) d = Math.min(d, dist(m.x, m.y, a.x, a.y)); return Math.min(1, d / (20 * UNIT)); } },
      { key: 'f7', types: '*', fn: (c) => { const r = c.obs.round; return Math.max(0, Math.min(1, r.phaseTicksLeft / this.data.rules.roundTicks)); } },
      { key: 'f9', types: 'hpa', fn: (c, a) => { let m = 0; for (const q of c.threats) if (dist(q.x, q.y, a.x, a.y) < 15 * UNIT) m = Math.max(m, q.conf); return Math.min(1, m / 100); } },
      { key: 'f10', types: 'har', fn: (c, a) => this.goalDist(c, a) },
      // f10 的另一項：推進還有多遠（到計畫目標 5 格以上＝1；已經到了＝0，推進和守沒差）
      { key: 'f10p', types: 'a', fn: (c, a) => Math.min(1, dist(c.obs.me.x, c.obs.me.y, a.x, a.y) / (5 * UNIT)) },
      { key: 'f12', types: 'har', fn: (c) => Math.max(-1, Math.min(1, (c.mates.length + 1 - c.obs.enemiesAlive) / 4)) },
      { key: 'f13', types: '*', fn: (c) => c.obs.me.hp / 100 },
      { key: 'f16', types: 'apt', fn: (c) => (c.role === ENTRY ? 1 : 0) },
      { key: 'f20', types: '*', fn: (c, a) => (c.cur !== null && c.cur.type === a.type && c.cur.k === a.k ? Math.max(P.U.commitMin, 1 - c.held / (P.U.commitSec * this.tps)) : 0) },
    ];
  }

  /** f10：到計畫目標的路程 ÷ 40 格（沒有目標＝0） @param {Ctx} c @param {Cand} a */
  goalDist(c, a) {
    if (c.goal === null) return 0;
    const gc = this.g.cellOf(c.goal.x, c.goal.y);
    if (gc < 0) return 0;
    if (gc !== this.goalCell || this.goalField === null) {
      this.goalCell = gc;
      this.goalField = dijkstra(this.g, [gc]);
    }
    const i = this.g.cellOf(a.x, a.y);
    const d = i < 0 ? Infinity : this.goalField[i];
    return Number.isFinite(d) ? Math.min(1, d / 40) : 1;
  }

  /**
   * 這次要不要決策：輪到自己的槽（每 n 個 decide tick），或有事件；回傳事件碼（'' ＝ 輪值，null ＝ 不決策）
   * @param {import('./base.js').Observation} obs @param {number} p 個人熟練度
   * @returns {string | null}
   */
  due(obs, p) {
    const me = obs.me;
    const k = Math.floor(obs.tick / this.data.rules.decisionInterval);
    const n = p < 0.25 ? 6 : 5;
    let ev = '';
    if (obs.enemies.length !== this.seen) ev = 'e';
    else if (me.hp < this.hp) ev = 'd';
    else if (obs.teammates.filter((m) => m.alive).length < this.mates) ev = 'm';
    else if (obs.bomb.state !== this.bomb) ev = 'b';
    else if (obs.chat.some((c) => /^(K:|E:|U:[prf])/.test(c.text))) ev = 'c';
    this.seen = obs.enemies.length;
    this.hp = me.hp;
    this.mates = obs.teammates.filter((m) => m.alive).length;
    this.bomb = obs.bomb.state;
    if (ev !== '' && obs.tick > this.lastTick) return ev;
    return (k - this.slot) % n === 0 ? '' : null;
  }

  /**
   * 影子模式一步：產生候選、打分、承諾防抖、記錄（不回傳指令）
   * @param {import('./base.js').Observation} obs
   * @param {{ stage: Stage, goal: import('./base.js').Pt | null, hold: import('./base.js').Pt | null, role: number, p: number, fight: boolean, actual: { type: Act, x: number, y: number } | null, inSite: boolean, peek: import('./base.js').Pt | null, cover: import('./base.js').Pt | null, rotate: import('./base.js').Pt[] }} ctx
   */
  shadow(obs, ctx) {
    // 凍結期間只買與喊話（硬反射第 6 項），不決策
    if (ctx.stage === 'freeze') return;
    const ev = this.due(obs, ctx.p);
    if (ev === null) return;
    this.lastTick = obs.tick;
    const me = obs.me;
    const mates = obs.teammates.filter((m) => m.alive && m.id !== me.id);
    /** @type {Cand[]} */
    const cands = [];
    /** @param {Act} type @param {number} x @param {number} y @param {number} ref */
    const add = (type, x, y, ref = -1) => { if (cands.length < 16) cands.push({ type, k: cands.filter((q) => q.type === type).length, x, y, ref }); };
    // 守＝留在這附近：原地，加上 3 格內的守點；遠的守點是「推進」到那裡
    add('h', me.x, me.y);
    if (ctx.hold !== null && dist(me.x, me.y, ctx.hold.x, ctx.hold.y) < 3 * UNIT && dist(me.x, me.y, ctx.hold.x, ctx.hold.y) > UNIT) add('h', ctx.hold.x, ctx.hold.y);
    if (ctx.goal !== null) add('a', ctx.goal.x, ctx.goal.y);
    if (ctx.peek !== null) add('p', ctx.peek.x, ctx.peek.y);
    if (ctx.cover !== null) add('f', ctx.cover.x, ctx.cover.y);
    for (const m of mates) if (m.firing && dist(m.x, m.y, me.x, me.y) < 25 * UNIT) add('t', m.x, m.y, m.id);
    for (const r of ctx.rotate) add('r', r.x, r.y);
    // 下包：帶包而且在包點矩形內；拆包：CT、炸彈下了、2 格內（遠的是「推進」到炸彈）
    const bx = obs.bomb.x;
    const by = obs.bomb.y;
    if (me.hasBomb && ctx.inSite) add('o', me.x, me.y);
    else if (me.team === 'CT' && (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing') && bx !== null && by !== null && dist(me.x, me.y, bx, by) < 2 * UNIT) add('o', bx, by);
    /** @type {Ctx} */
    const c = { obs, stage: ctx.stage, goal: ctx.goal, threats: this.perc.threats(me.x, me.y), mates, role: ctx.role, cur: this.cur, held: this.since < 0 ? 0 : obs.tick - this.since, entry: 0 };
    const scored = cands.map((a) => ({ a, s: this.score(c, a) }));
    // 同分取動作序號小、再取同種序號小（第四節）
    scored.sort((p, q) => q.s - p.s || ACTS.indexOf(p.a.type) - ACTS.indexOf(q.a.type) || p.a.k - q.a.k);
    let pick = scored[0]?.a ?? null;
    // 承諾防抖：最短停留與切換門檻（事件觸發不受最短停留限制）
    const curS = this.cur === null ? null : scored.find((q) => q.a.type === this.cur?.type && q.a.k === this.cur.k);
    if (pick !== null && curS !== undefined && curS !== null && curS.a !== pick) {
      const top = scored[0].s;
      if ((ev === '' && c.held < P.U.dwellSec * this.tps) || top < curS.s + P.U.margin) pick = curS.a;
    }
    if (pick !== null && (this.cur === null || pick.type !== this.cur.type || pick.k !== this.cur.k)) this.since = obs.tick;
    this.cur = pick;
    const code = (/** @type {Cand} */ a) => `${a.type}${a.k}`;
    const act = ctx.actual === null ? '-' : this.match(cands, ctx.actual);
    this.log.push({ tick: obs.tick, ev, top: scored.slice(0, 3).map((q) => [code(q.a), q.s]), pick: pick === null ? '-' : code(pick), act, stage: ctx.stage, fight: ctx.fight });
    if (this.log.length > 64) this.log.shift();
  }

  /** r7l 實際動作對到最接近的同種候選（3 格內）；對不到回 '?'＋種類 @param {Cand[]} cands @param {{ type: Act, x: number, y: number }} act */
  match(cands, act) {
    let best = null;
    let bd = 3 * UNIT;
    for (const a of cands) {
      if (a.type !== act.type) continue;
      const d = dist(a.x, a.y, act.x, act.y);
      if (d <= bd) { bd = d; best = a; }
    }
    return best === null ? `?${act.type}` : `${best.type}${best.k}`;
  }

  /** U(a) ＝ b[type] ＋ Σ w[type][k] × f_k ＋ w_stage[type][stage]（第五節） @param {Ctx} c @param {Cand} a */
  score(c, a) {
    const W = P.U;
    const row = W.w[a.type];
    let s = (W.b[a.type] ?? 0) + (W.stage[a.type]?.[STAGES.indexOf(c.stage)] ?? 0);
    for (const f of this.features) {
      if (f.types !== '*' && !f.types.includes(a.type)) continue;
      const w = row?.[f.key] ?? 0;
      if (w !== 0) s += w * f.fn(c, a);
    }
    s += W.commit * (this.features.find((f) => f.key === 'f20')?.fn(c, a) ?? 0);
    return s;
  }

  /** 第七節正式字串（最近一筆） */
  text() {
    const e = this.log[this.log.length - 1];
    if (e === undefined) return '';
    const n = (/** @type {number} */ v) => v.toFixed(2).replace(/^(-?)0\./, '$1.');
    return `${e.fight ? '!' : ''}${e.top.map(([k, v]) => `${k} ${n(v)}`).join('|')} → ${e.pick}`;
  }
}
