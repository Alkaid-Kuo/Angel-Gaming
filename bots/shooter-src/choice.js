// @ts-check
// 3.0 效用式個人層（丙-1，設計 docs/2026-11-10_CS射擊_Bot3.0效用式個人層設計.md）。
// 第一步影子模式：照算候選、特徵、分數、承諾，記錄前三名與「r7l 實際做的動作」，行為仍由 tactics／combat／nav 驅動（不回傳任何指令）。
// 特徵表資料驅動（審查決定 3）：每筆 { key, fn, types, min, max }，打分只走訪特徵表與 P.U。
import { P, UNIT, dijkstra, dist, segDist } from './base.js';
import { ENTRY } from './roles.js';

/** 動作字母（第七節正式格式）：h 守、a 推進、p 探頭、f 退掩體、t 補槍、g 丟道具、r 轉點、o 下包／拆包 */
export const ACTS = /** @type {const} */ (['h', 'a', 'p', 'f', 't', 'g', 'r', 'o']);
/** @typedef {typeof ACTS[number]} Act */
/** 計畫階段（f11） */
export const STAGES = /** @type {const} */ (['freeze', 'setup', 'wait', 'execute', 'post', 'retake', 'save']);
/** @typedef {typeof STAGES[number]} Stage */
const CH_SITES = /** @type {const} */ (['A', 'B']);
/** 候選：type 動作、k 同種內序號、x／y 動作結束時人在的位置、ref 參數（隊友 id、包點序號、道具序號…） @typedef {{ type: Act, k: number, x: number, y: number, ref: number }} Cand */
/**
 * 影子模式的輸入（baseline.shadow 從 r7l 這一步整理）
 * @typedef {{ stage: Stage, goal: import('./base.js').Pt | null, hold: import('./base.js').Pt | null, role: number, p: number, fight: boolean, reflex: boolean,
 *   actual: { type: Act, x: number, y: number, ref?: number } | null, inSite: boolean, peek: import('./base.js').Pt | null,
 *   cover: () => import('./base.js').Pt | null, nades: { kind: string, trig: boolean }[], group: (id: number) => number, pathless: boolean }} ShadowIn
 */
/**
 * 決策脈絡（只讀觀察與自己的狀態）
 * @typedef {{ obs: import('./base.js').Observation, in: ShadowIn, threats: import('./memory.js').Threat[], mates: import('./base.js').Observation['teammates'], cur: Cand | null, held: number, site: number }} Ctx
 */
/** @typedef {{ key: string, fn: (c: Ctx, a: Cand) => number, types: string, min: number, max: number }} Feature */
/** 決策紀錄 @typedef {{ tick: number, ev: string, top: [string, number][], pick: string, act: string, stage: Stage, fight: boolean, reflex: boolean }} LogEntry */

/** 目標點的威脅清單裡，有視線看得到目標點的個數 @param {Ctx} c @param {Cand} a @param {import('./base.js').Grid} g */
function exposed(c, a, g) {
  let n = 0;
  for (const q of c.threats) if (dist(q.x, q.y, a.x, a.y) < 40 * UNIT && g.los(q.x, q.y, a.x, a.y)) n++;
  return n;
}

/** 0～1 夾住 @param {number} v */
const unit = (v) => Math.max(0, Math.min(1, v));

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
    /** 事件偵測用的上一次狀態（凍結期間逐拍同步，live 第一拍不會誤觸發） */
    this.seen = 0;
    this.hp = 100;
    /** @type {Set<number>} */
    this.alive = new Set();
    this.bomb = '';
    /** 看得見的煙／火（x,y,kind）與閃光投擲物 @type {Set<string>} */
    this.fx = new Set();
    /** @type {Set<string>} */
    this.flying = new Set();
    /** 已觸發過「完成或失效」的動作鍵 */
    this.kDone = '';
    /** 計畫目標的距離場（目標格變了才重算） @type {Float64Array | null} */
    this.goalField = null;
    this.goalCell = -1;
    /** @type {Feature[]} */
    this.features = this.table();
    /** f20（承諾）在建表時記下，score 不用每次找 */
    this.commitF = /** @type {Feature} */ (this.features.find((f) => f.key === 'f20'));
    /** 除錯：最近一次決策每個候選的特徵值（測試檢查範圍用；P.choiceTrace 開時才記） @type {{ key: string, v: number }[][]} */
    this.trace = [];
  }

  reset() {
    this.cur = null;
    this.since = -1;
    this.lastTick = -1e9;
  }

  /** 特徵表（第五節）：影子模式先實作對應 r7l 必要的子集，其餘之後逐項補 @returns {Feature[]} */
  table() {
    const g = this.g;
    const perc = this.perc;
    const intel = this.intel;
    /** @param {Cand} a */
    const cell = (a) => g.cellOf(a.x, a.y);
    return [
      { key: 'f1', types: 'hfrt', min: 0, max: 1, fn: (_c, a) => { const i = cell(a); return i < 0 ? 0 : unit(perc.danger[i] / 60); } },
      { key: 'f3', types: 'hft', min: 0, max: 1, fn: (c, a) => { if (c.threats.length === 0) { const i = cell(a); return i < 0 ? 0 : (intel.cover[i] !== 0 ? 1 : 0); } return 1 - exposed(c, a, g) / c.threats.length; } },
      { key: 'f4', types: 'hpa', min: 0, max: 1, fn: (c, a) => { if (c.threats.length === 0) { const i = cell(a); return i < 0 ? 0 : unit(intel.exposure[i] / 8); } return unit(exposed(c, a, g) / 3); } },
      { key: 'f5', types: 'art', min: 0, max: 1, fn: (c, a) => { let d = 1e9; for (const m of c.mates) d = Math.min(d, dist(m.x, m.y, a.x, a.y)); return unit(d / (20 * UNIT)); } },
      { key: 'f7', types: '*', min: 0, max: 1, fn: (c) => unit(c.obs.round.phaseTicksLeft / this.data.rules.roundTicks) },
      { key: 'f9', types: 'hpaf', min: 0, max: 1, fn: (c, a) => { let m = 0; for (const q of c.threats) if (dist(q.x, q.y, a.x, a.y) < 15 * UNIT) m = Math.max(m, q.conf); return unit(m / 100); } },
      { key: 'f10', types: 'har', min: 0, max: 1, fn: (c, a) => this.goalDist(c, a) },
      // f10 的另一項：推進還有多遠（到計畫目標 5 格以上＝1；已經到了＝0，推進和守沒差）
      { key: 'f10p', types: 'a', min: 0, max: 1, fn: (c, a) => unit(dist(c.obs.me.x, c.obs.me.y, a.x, a.y) / (5 * UNIT)) },
      { key: 'f12', types: 'harf', min: -1, max: 1, fn: (c) => Math.max(-1, Math.min(1, (c.mates.length + 1 - c.obs.enemiesAlive) / 4)) },
      { key: 'f13', types: '*', min: 0, max: 1, fn: (c) => unit(c.obs.me.hp / 100) },
      { key: 'f16', types: 'apt', min: 0, max: 1, fn: (c) => (c.in.role === ENTRY ? 1 : 0) },
      // f18 的計畫時機項：資源層／指揮層的觸發條件成立（設計第八節第 1 點；效用層只讀）
      { key: 'f18t', types: 'g', min: 0, max: 1, fn: (c, a) => (c.in.nades[a.ref]?.trig ? 1 : 0) },
      { key: 'f19', types: 'ra', min: 0, max: 1, fn: (c) => this.blocked(c) },
      { key: 'f20', types: '*', min: 0, max: 1, fn: (c, a) => (c.cur !== null && c.cur.type === a.type && c.cur.k === a.k ? Math.max(P.U.commitMin, 1 - c.held / (P.U.commitSec * this.tps)) : 0) },
    ];
  }

  /** f10：到計畫目標的路程 ÷ 40 格（沒有目標＝0） @param {Ctx} c @param {Cand} a */
  goalDist(c, a) {
    const goal = c.in.goal;
    if (goal === null) return 0;
    const gc = this.g.cellOf(goal.x, goal.y);
    if (gc < 0) return 0;
    if (gc !== this.goalCell || this.goalField === null) {
      this.goalCell = gc;
      this.goalField = dijkstra(this.g, [gc]);
    }
    const i = this.g.cellOf(a.x, a.y);
    const d = i < 0 ? Infinity : this.goalField[i];
    return Number.isFinite(d) ? unit(d / 40) : 1;
  }

  /** 計畫目標所在的包點序號（目標在包點矩形外擴 8 格內；不在任何包點附近＝−1） @param {import('./base.js').Pt | null} p */
  siteOf(p) {
    if (p === null) return -1;
    for (let s = 0; s < 2; s++) {
      const r = this.intel.sites[CH_SITES[s]].rect;
      const cx = p.x / UNIT;
      const cy = p.y / UNIT;
      if (cx >= r.x0 - 8 && cx < r.x1 + 8 && cy >= r.y0 - 8 && cy < r.y1 + 8) return s;
    }
    return -1;
  }

  /** f19：計畫包點離我最近的入口被看得見的煙或火蓋住（入口線段在效果半徑＋1 格內） @param {Ctx} c */
  blocked(c) {
    if (c.site < 0) return 0;
    const me = c.obs.me;
    const ents = this.intel.sites[CH_SITES[c.site]].entrances;
    let e = ents[0];
    for (const x of ents) if (dist(me.x, me.y, x.ox, x.oy) < dist(me.x, me.y, e.ox, e.oy)) e = x;
    if (e === undefined) return 0;
    return c.obs.effects.some((f) => segDist(f.x, f.y, e.ox, e.oy, e.ix, e.iy).d <= f.radius + UNIT) ? 1 : 0;
  }

  /**
   * 事件偵測（設計第三節），每個 decide tick 都要呼叫（含凍結，凍結時只同步狀態）；回傳事件碼，沒有事件＝''
   * e 看到的敵人數變了、d 受傷、s 12 格內槍聲、m 隊友陣亡（同組或 20 格內）、b 炸彈狀態、c 計畫或事件喊話、
   * n 附近（20 格內）的煙或火出現或消失、閃光炸開、k 動作完成或失效（到達、路徑不通、目標點被隊友占住、道具丟出）
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si
   */
  events(obs, si) {
    const me = obs.me;
    const near = (/** @type {number} */ x, /** @type {number} */ y) => dist(me.x, me.y, x, y) < 20 * UNIT;
    let ev = '';
    if (obs.enemies.length !== this.seen) ev = 'e';
    else if (me.hp < this.hp) ev = 'd';
    else if (obs.sounds.some((s) => s.kind === 'shot' && s.range === 'near' && !s.friendly)) ev = 's';
    else if (obs.teammates.some((m) => !m.alive && this.alive.has(m.id) && (si.group(m.id) === si.group(me.id) || near(m.x, m.y)))) ev = 'm';
    else if (obs.bomb.state !== this.bomb) ev = 'b';
    else if (obs.chat.some((c) => /^(K:|E:|U:[prf])/.test(c.text))) ev = 'c';
    const fx = new Set(obs.effects.filter((f) => near(f.x, f.y)).map((f) => `${f.kind}${Math.round(f.x / UNIT)},${Math.round(f.y / UNIT)}`));
    const flying = new Set(obs.projectiles.filter((q) => q.kind === 'flash' && near(q.x, q.y)).map((q) => `${Math.round(q.x / UNIT)},${Math.round(q.y / UNIT)}`));
    if (ev === '' && ([...fx].some((k) => !this.fx.has(k)) || [...this.fx].some((k) => !fx.has(k)) || (this.flying.size > 0 && flying.size < this.flying.size))) ev = 'n';
    const cur = this.cur;
    if (ev === '' && cur !== null && obs.round.phase === 'live') {
      const arrived = (cur.type === 'a' || cur.type === 'r' || cur.type === 'f' || cur.type === 't') && dist(me.x, me.y, cur.x, cur.y) < UNIT;
      const taken = cur.type === 'h' && obs.teammates.some((m) => m.alive && m.id !== me.id && dist(m.x, m.y, cur.x, cur.y) < UNIT && dist(me.x, me.y, cur.x, cur.y) > UNIT);
      const thrown = cur.type === 'g' && si.actual?.type !== 'g';
      // 同一個動作（種類＋目標格）只觸發一次：到了以後重選仍是同一個推進時，不每拍再觸發
      const key = `${cur.type}${Math.round(cur.x / UNIT)},${Math.round(cur.y / UNIT)}`;
      if ((arrived || taken || thrown || (si.pathless && (cur.type === 'a' || cur.type === 'r'))) && key !== this.kDone) {
        ev = 'k';
        this.kDone = key;
      }
    }
    this.seen = obs.enemies.length;
    this.hp = me.hp;
    this.alive = new Set(obs.teammates.filter((m) => m.alive).map((m) => m.id));
    this.bomb = obs.bomb.state;
    this.fx = fx;
    this.flying = flying;
    return ev;
  }

  /**
   * 影子模式一步：偵測事件；輪到自己的槽或有事件時產生候選、打分、承諾防抖、記錄（不回傳指令）
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si
   */
  shadow(obs, si) {
    const ev = this.events(obs, si);
    // 凍結期間只買與喊話（硬反射第 6 項），不決策
    if (si.stage === 'freeze') return;
    const k = Math.floor(obs.tick / this.data.rules.decisionInterval);
    const n = si.p < 0.25 ? 6 : 5;
    if (ev === '' && (k - this.slot) % n !== 0) return;
    if (obs.tick <= this.lastTick) return;
    this.lastTick = obs.tick;
    const me = obs.me;
    const mates = obs.teammates.filter((m) => m.alive && m.id !== me.id);
    const threats = this.perc.threats(me.x, me.y);
    /** @type {Cand[]} */
    const cands = [];
    /** @param {Act} type @param {number} x @param {number} y @param {number} ref */
    const add = (type, x, y, ref = -1) => { if (cands.length < 16) cands.push({ type, k: cands.filter((q) => q.type === type).length, x, y, ref }); };
    // 守＝留在這附近：原地，加上 3 格內的守點；遠的守點是「推進」到那裡
    add('h', me.x, me.y);
    const hold = si.hold;
    if (hold !== null && dist(me.x, me.y, hold.x, hold.y) < 3 * UNIT && dist(me.x, me.y, hold.x, hold.y) > UNIT) add('h', hold.x, hold.y);
    if (si.goal !== null) add('a', si.goal.x, si.goal.y);
    if (si.peek !== null) add('p', si.peek.x, si.peek.y);
    // 退掩體：對記得的威脅（接觸前；交戰中的撤退是 combat.finishMove）
    if (threats.length > 0 && !si.fight) {
      const cv = si.cover();
      if (cv !== null) add('f', cv.x, cv.y);
    }
    for (const m of mates) if (m.firing && dist(m.x, m.y, me.x, me.y) < 25 * UNIT) add('t', m.x, m.y, m.id);
    si.nades.forEach((_q, i) => add('g', me.x, me.y, i));
    // 轉點：另一個包點（離我最近的入口外側）；回防時只在入口受阻才換同包點的另一入口
    const site = this.siteOf(si.goal);
    /** @type {Ctx} */
    const c = { obs, in: si, threats, mates, cur: this.cur, held: this.since < 0 ? 0 : obs.tick - this.since, site };
    if (si.stage !== 'retake') {
      for (let s = 0; s < 2; s++) {
        if (s === site || site < 0) continue;
        const ents = this.intel.sites[CH_SITES[s]].entrances;
        let e = ents[0];
        for (const x of ents) if (dist(me.x, me.y, x.ox, x.oy) < dist(me.x, me.y, e.ox, e.oy)) e = x;
        if (e !== undefined) add('r', e.ox, e.oy, s);
      }
    } else if (site >= 0 && this.blocked(c) === 1) {
      const ents = this.intel.sites[CH_SITES[site]].entrances;
      const sorted = [...ents].sort((p, q) => dist(me.x, me.y, p.ox, p.oy) - dist(me.x, me.y, q.ox, q.oy));
      const e = sorted[1];
      if (e !== undefined) add('r', e.ox, e.oy, 2 + ents.indexOf(e));
    }
    // 下包：帶包而且在包點矩形內；拆包：CT、炸彈下了、2 格內（遠的是「推進」到炸彈）
    const bx = obs.bomb.x;
    const by = obs.bomb.y;
    if (me.hasBomb && si.inSite) add('o', me.x, me.y);
    else if (me.team === 'CT' && (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing') && bx !== null && by !== null && dist(me.x, me.y, bx, by) < 2 * UNIT) add('o', bx, by);
    const scored = cands.map((a) => ({ a, s: this.score(c, a) }));
    if (P.choiceTrace) this.trace = cands.map((a) => this.features.filter((f) => f.types === '*' || f.types.includes(a.type)).map((f) => ({ key: f.key, v: f.fn(c, a) })));
    // 同分取動作序號小、再取同種序號小（第四節）
    scored.sort((p, q) => q.s - p.s || ACTS.indexOf(p.a.type) - ACTS.indexOf(q.a.type) || p.a.k - q.a.k);
    let pick = scored[0]?.a ?? null;
    // 承諾防抖：最短停留與切換門檻（事件觸發不受最短停留限制）
    const curS = this.cur === null ? undefined : scored.find((q) => q.a.type === this.cur?.type && q.a.k === this.cur.k);
    if (pick !== null && curS !== undefined && curS.a !== pick) {
      const top = scored[0].s;
      if ((ev === '' && c.held < P.U.dwellSec * this.tps) || top < curS.s + P.U.margin) pick = curS.a;
    }
    if (pick !== null && (this.cur === null || pick.type !== this.cur.type || pick.k !== this.cur.k)) this.since = obs.tick;
    this.cur = pick;
    const code = (/** @type {Cand} */ a) => `${a.type}${a.k}`;
    const act = si.actual === null ? '-' : this.match(cands, si.actual);
    this.log.push({ tick: obs.tick, ev, top: scored.slice(0, 3).map((q) => [code(q.a), q.s]), pick: pick === null ? '-' : code(pick), act, stage: si.stage, fight: si.fight, reflex: si.reflex });
    if (this.log.length > 64) this.log.shift();
  }

  /**
   * r7l 實際動作對到候選：g 依道具序號、r 依包點／入口參數、其他依位置（3 格內最近的同種）；對不到回 '?'＋種類
   * @param {Cand[]} cands @param {{ type: Act, x: number, y: number, ref?: number }} act
   */
  match(cands, act) {
    let best = null;
    let bd = 3 * UNIT;
    for (const a of cands) {
      if (a.type !== act.type) continue;
      if (act.ref !== undefined && (a.type === 'g' || a.type === 'r')) {
        if (a.ref === act.ref) { best = a; break; }
        continue;
      }
      const d = dist(a.x, a.y, act.x, act.y);
      if (d <= bd) { bd = d; best = a; }
    }
    return best === null ? `?${act.type}` : `${best.type}${best.k}`;
  }

  /** U(a) ＝ b[type] ＋ Σ w[type][k] × f_k ＋ w_stage[type][stage] ＋ 承諾（第五、六節） @param {Ctx} c @param {Cand} a */
  score(c, a) {
    const W = P.U;
    const row = W.w[a.type];
    let s = (W.b[a.type] ?? 0) + (W.stage[a.type]?.[STAGES.indexOf(c.in.stage)] ?? 0);
    for (const f of this.features) {
      if (f.types !== '*' && !f.types.includes(a.type)) continue;
      const w = row?.[f.key] ?? 0;
      if (w !== 0) s += w * f.fn(c, a);
    }
    s += W.commit * this.commitF.fn(c, a);
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
