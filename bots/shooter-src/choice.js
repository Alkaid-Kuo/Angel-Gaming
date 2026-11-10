// @ts-check
// 3.0 效用式個人層（丙-1，設計 docs/2026-11-10_CS射擊_Bot3.0效用式個人層設計.md）。
// 第一步影子模式：照算候選、特徵、分數、承諾，記錄前三名與「r7l 實際做的動作」，行為仍由 tactics／combat／nav 驅動（不回傳任何指令）。
// 特徵表資料驅動（審查決定 3）：每筆 { key, fn, types, min, max }，打分只走訪特徵表與 P.U。
import { P, UNIT, adiff, angleTo, cosd, dijkstra, dist, normDeg, segDist, sind } from './base.js';
import { codeOf } from './resources.js';
import { ENTRY } from './roles.js';

/** 動作字母（第七節正式格式）：h 守、a 推進、p 探頭、f 退掩體、t 補槍、g 丟道具、r 轉點、o 下包／拆包 */
export const ACTS = /** @type {const} */ (['h', 'a', 'p', 'f', 't', 'g', 'r', 'o']);
/** @typedef {typeof ACTS[number]} Act */
/** 計畫階段（f11） */
export const STAGES = /** @type {const} */ (['freeze', 'setup', 'wait', 'execute', 'post', 'retake', 'save']);
/** @typedef {typeof STAGES[number]} Stage */
const CH_SITES = /** @type {const} */ (['A', 'B']);
/**
 * 候選：type 動作、k 同種內序號、x／y 動作結束時人在的位置（丟道具是落點）、ref 參數（隊友 id、包點序號、道具序號 × 4 ＋ 落點序號…）；
 * 丟道具另帶 kind 種類、tg 觸發（f18t）、v18 落點價值（f18）
 * @typedef {{ type: Act, k: number, x: number, y: number, ref: number, kind?: string, tg?: number, v18?: number }} Cand
 */
/**
 * 影子模式的輸入（baseline.shadow 從 r7l 這一步整理）
 * @typedef {{ stage: Stage, goal: import('./base.js').Pt | null, hold: import('./base.js').Pt | null, role: number, p: number, fight: boolean, reflex: boolean,
 *   actual: { type: Act, x: number, y: number, ref?: number, kind?: string } | null, inSite: boolean, peek: import('./base.js').Pt | null,
 *   cover: () => import('./base.js').Pt | null, nade: NadeIn, group: (id: number) => number, pathless: boolean,
 *   planWait: boolean, order: { yieldF: number, spawnF: number, awpF: number }, cues: { id: number, x: number, y: number, dead: boolean }[], site: number }} ShadowIn
 */
/**
 * 丟道具（第 5 步）：res 資源層副本（只讀）、trig 指揮層記的觸發（tactics.trig，只讀）、solve 從我這裡丟得到、fighting 隊友交火中（1.5 秒內開過槍或被記得的敵人看得到）、
 * canHide 隊友 4 步內躲得到、flashR 閃光半徑、smokes／burns 我方丟過的煙與火（指揮層的紀錄）、info 指揮層的「爆點附近有情報」（flashInfo：記得的敵人、聲音、接觸喊話）
 * @typedef {{ res: import('./resources.js').Resources, trig: Map<string, { kind: string, purposes: string[] }>, solve: (x: number, y: number) => boolean,
 *   fighting: (id: number) => boolean, canHide: (x: number, y: number, c: import('./base.js').Pt) => boolean, flashR: number,
 *   smokes: import('./base.js').Pt[], burns: { x: number, y: number, until: number }[], info: (p: import('./base.js').Pt, site: 'A' | 'B') => boolean }} NadeIn
 */
/**
 * 決策脈絡（只讀觀察與自己的狀態）
 * @typedef {{ obs: import('./base.js').Observation, in: ShadowIn, threats: import('./memory.js').Threat[], mates: import('./base.js').Observation['teammates'], cur: Cand | null, held: number, site: number }} Ctx
 */
/** @typedef {{ key: string, fn: (c: Ctx, a: Cand) => number, types: string, min: number, max: number }} Feature */
/** 決策紀錄（gk：選定的與 r7l 實際丟的道具種類字母，沒有是 -；at：選定動作的目標格；丟道具、補槍、轉點是 −2 − 參數；look／ls：視線頭此刻的選擇與分數，'-'＝不歸視線頭管） @typedef {{ tick: number, ev: string, top: [string, number][], pick: string, at: number, act: string, stage: Stage, fight: boolean, reflex: boolean, look: string, ls: number, gk: string }} LogEntry */
/** 視線種類字母（第七節）：e 記得的敵位、s 聲音、i 入口／窄口、w 守點看向、c 隊友沒看的角、n 行進方向 */
export const LOOKS = /** @type {const} */ (['e', 's', 'i', 'w', 'c', 'n']);
/**
 * 視線頭的輸入（baseline.shadow 每個 decide tick 整理）。active：歸視線頭管（live、沒看到敵人、沒交戰、不是躲閃光／丟道具／下拆包這類不接管的視線）
 * peek：正在探的窄口（lock＝hold 或 shoulder 階段）；hold：3 格內的守點（含看向）；act：動作附帶的看向（等槍線、讓位、補槍、佯攻）；ahead：行進方向的下一個路點
 * @typedef {{ active: boolean, peek: { x: number, y: number, lock: boolean } | null, hold: { x: number, y: number, fx: number, fy: number } | null, holding: boolean, moving: boolean,
 *   act: import('./base.js').Pt | null, ahead: import('./base.js').Pt | null, soundReact: number }} LookIn
 */
/** 視線候選：t 種類、ref 參數（e 是名次、e9 受傷方向）、id 敵人 id（e 以外 −1）、s 分數 @typedef {{ t: typeof LOOKS[number], ref: number, id: number, x: number, y: number, s: number }} LookCand */
/** 視線頭量測（每個 decide tick；r 是 r7l 實際朝向、v 是視線頭的虛擬朝向；dl＝e9 蓋過了鎖定中的新鮮敵位） @typedef {{ tick: number, active: boolean, peek: [number, number] | null, thr: [number, number, boolean] | null, rate: [number, number] | null, hard: string, dl: boolean, vf: number }} LookStat */

/** 目標點的威脅清單裡，有視線看得到目標點的個數 @param {Ctx} c @param {Cand} a @param {import('./base.js').Grid} g */
function exposed(c, a, g) {
  let n = 0;
  for (const q of c.threats) if (dist(q.x, q.y, a.x, a.y) < 40 * UNIT && g.los(q.x, q.y, a.x, a.y)) n++;
  return n;
}

/** 同一個動作：種類相同，丟道具、補槍、轉點看參數，其他看目標點（1 格內） @param {Cand} a @param {Cand | null} b */
function same(a, b) {
  if (b === null || a.type !== b.type) return false;
  if (a.type === 'g' || a.type === 't' || a.type === 'r') return a.ref === b.ref;
  // 原地守（ref −9）：人在影子模式下照 r7l 走，原地的格子會變，但仍是同一個動作
  if (a.ref === HERE || b.ref === HERE) return a.ref === b.ref;
  return dist(a.x, a.y, b.x, b.y) < UNIT;
}

/** 原地守的參數 */
const HERE = -9;

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
    /** 引擎轉身速度（度／秒；視線頭的虛擬朝向用） */
    this.turn = data.rules.turnDegPerSec ?? 720;
    /** 錯開：隊內序號（審查意見 C） */
    this.slot = data.slot;
    /** @type {LogEntry[]} */
    this.log = [];
    /** @type {Cand | null} */
    this.cur = null;
    /** 上一個動作（防來回） @type {Cand | null} */
    this.prev = null;
    this.since = -1;
    this.lastTick = -1e9;
    /** 事件偵測用的上一次狀態（凍結期間逐拍同步，live 第一拍不會誤觸發） */
    /** 敵人 id → 最後一次看到的 tick @type {Map<number, number>} */
    this.seenAt = new Map();
    /** 上一拍看得到的敵人 @type {Set<number>} */
    this.vis = new Set();
    /** 看不見了、等第 2 拍確認的敵人 id → 已連續看不到的拍數 @type {Map<number, number>} */
    this.missing = new Map();
    /** 各類事件最後觸發的 tick（冷卻用） @type {Map<string, number>} */
    this.evAt = new Map();
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
    // ── 視線頭（第二組效用） ──
    /** 目前看的方向 @type {LookCand | null} */
    this.lk = null;
    this.lkSince = -1;
    /** 硬優先鎖定的敵人 id（信心掉到 freshConf 以下才放） */
    this.lockId = -1;
    /** 虛擬朝向（影子模式：照視線頭的選擇、以引擎轉速轉過去的朝向；不歸視線頭管時跟實際朝向同步） */
    this.vface = 0;
    this.lkTick = -1;
    /** 上一個量測點的實際朝向（角速度） */
    this.rface = 0;
    /** 聲音的反應延遲（自己的狀態，和 combat.heard 同規則，不碰 combat） @type {import('./memory.js').Sector | null} */
    this.sndObj = null;
    this.sndSeen = -1;
    this.sndWait = 0;
    /** @type {LookStat | null} */
    this.lstat = null;
    /** 隊友上一次的位置與位移（f18 的 1.5 秒推定） @type {Map<number, { x: number, y: number, t: number, vx: number, vy: number, dt: number }>} */
    this.mpos = new Map();
    /** 最近一次決策的候選（量測工具讀） @type {Cand[]} */
    this.cands = [];
  }

  reset() {
    this.cur = null;
    this.prev = null;
    this.since = -1;
    this.lastTick = -1e9;
    this.lk = null;
    this.lkSince = -1;
    this.lockId = -1;
    this.lkTick = -1;
    this.sndObj = null;
    this.lstat = null;
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
      // 遲滯（防抖補充裁定乙）：已經在守的人，離目標 P.U.holdGap 格以上才算該推進
      { key: 'f10p', types: 'a', min: 0, max: 1, fn: (c, a) => { const d = dist(c.obs.me.x, c.obs.me.y, a.x, a.y); return d < (c.cur !== null && c.cur.type === 'h' ? P.U.holdGap : P.U.holdZone) * UNIT ? 0 : unit(d / (5 * UNIT)); } },
      { key: 'f12', types: 'harf', min: -1, max: 1, fn: (c) => Math.max(-1, Math.min(1, (c.mates.length + 1 - c.obs.enemiesAlive) / 4)) },
      { key: 'f13', types: '*', min: 0, max: 1, fn: (c) => unit(c.obs.me.hp / 100) },
      { key: 'f16', types: 'apt', min: 0, max: 1, fn: (c) => (c.in.role === ENTRY ? 1 : 0) },
      // 補槍：我是看得到線索、離線索最近的可支援隊友（和 cooperation 的跟進人選一致）
      { key: 'f6t', types: 't', min: 0, max: 1, fn: (c, a) => this.helper(c, a) },
      // 守的是指揮層給的守點或計畫目標（1 格內）
      { key: 'fhp', types: 'h', min: 0, max: 1, fn: (c, a) => (a.ref !== HERE && [c.in.hold, c.in.goal].some((p) => p !== null && dist(p.x, p.y, a.x, a.y) < UNIT) ? 1 : 0) },
      // 狙擊手拿狙擊槍、離守點 4 格內（取代 awpSettle 的條件）
      { key: 'f16w', types: 'h', min: 0, max: 1, fn: (c) => c.in.order.awpF },
      // f21 進點順序：等突破手先進（yieldTo 的條件）、出生區讓位（spawnWait 的條件）
      { key: 'f21y', types: 'a', min: 0, max: 1, fn: (c) => c.in.order.yieldF },
      { key: 'f21s', types: 'a', min: 0, max: 1, fn: (c) => c.in.order.spawnF },
      // 指揮層的合法等待（PlanIntent）：2.8 執行品質的慢半拍、跟上等
      { key: 'fw', types: 'ha', min: 0, max: 1, fn: (c) => (c.in.planWait ? 1 : 0) },
      // f18 的計畫時機項：資源層／指揮層的觸發條件成立（設計第八節第 1 點；效用層只讀）
      { key: 'f18t', types: 'g', min: 0, max: 1, fn: (_c, a) => a.tg ?? 0 },
      // f18 落點價值（第八節第 2 點）：產生候選時算好
      { key: 'f18', types: 'g', min: -1, max: 1, fn: (_c, a) => a.v18 ?? 0 },
      { key: 'f19', types: 'ra', min: 0, max: 1, fn: (c) => this.blocked(c) },
      { key: 'f20', types: '*', min: 0, max: 1, fn: (c, a) => (same(a, c.cur) ? Math.max(P.U.commitMin, 1 - c.held / (P.U.commitSec * this.tps)) : 0) },
    ];
  }

  /** f6t：線索 a（隊友位置）9 格內、看得到它的可支援隊友中，我最近 @param {Ctx} c @param {Cand} a */
  helper(c, a) {
    const me = c.obs.me;
    if (!this.g.los(me.x, me.y, a.x, a.y)) return 0;
    const d0 = dist(me.x, me.y, a.x, a.y);
    for (const m of c.mates) {
      if (m.id === a.ref || m.hasBomb || m.blind || m.planting || m.defusing) continue;
      const d = dist(m.x, m.y, a.x, a.y);
      if (d <= 9 * UNIT && (d < d0 || (d === d0 && m.id < me.id)) && this.g.los(m.x, m.y, a.x, a.y)) return 0;
    }
    return 1;
  }

  /** f10：到計畫目標的路程 ÷ 40 格（沒有目標＝0） @param {Ctx} c @param {Cand} a */
  goalDist(c, a) {
    const goal = c.in.goal;
    if (goal === null) return 0;
    const gc = this.g.cellOf(goal.x, goal.y);
    if (gc < 0) return 0;
    if (gc !== this.goalCell || this.goalField === null) {
      this.goalCell = gc;
      // 只算到 40 格（f10 在 40 格封頂）：全圖距離場在目標換了的那一拍會讓單次決策逼近 50 ms 上限
      this.goalField = dijkstra(this.g, [gc], 400);
    }
    const i = this.g.cellOf(a.x, a.y);
    const d = i < 0 ? Infinity : this.goalField[i];
    // 距離場單位是 0.1 格（直走 10、斜走 14）
    return Number.isFinite(d) ? unit(d / 400) : 1;
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
    const t = obs.tick;
    // 敵人（防抖補充裁定）：出現＝這個 id 最近 1 秒內沒看過才立即觸發（1 秒內看過又出現＝邊緣閃現，不觸發）；
    // 消失＝連續 2 個 decide tick 都看不到才觸發
    const vis = new Set(obs.enemies.map((e) => e.id));
    let appear = false;
    for (const id of vis) {
      const at = this.seenAt.get(id);
      if (at === undefined || t - at > this.tps) appear = true;
      this.seenAt.set(id, t);
      this.missing.delete(id);
    }
    let gone = false;
    for (const id of this.vis) if (!vis.has(id)) this.missing.set(id, 0);
    for (const [id, n] of this.missing) {
      if (n + 1 >= 2) {
        gone = true;
        this.missing.delete(id);
      } else this.missing.set(id, n + 1);
    }
    this.vis = vis;
    /** 依優先序的候選事件，取第一個不在冷卻中的（同類冷卻 P.U.evCool 秒；d 受傷、m 隊友陣亡不冷卻） @type {string[]} */
    const evs = [];
    if (appear || gone) evs.push('e');
    if (me.hp < this.hp) evs.push('d');
    if (obs.sounds.some((s) => s.kind === 'shot' && s.range === 'near' && !s.friendly)) evs.push('s');
    if (obs.teammates.some((m) => !m.alive && this.alive.has(m.id) && (si.group(m.id) === si.group(me.id) || near(m.x, m.y)))) evs.push('m');
    if (obs.bomb.state !== this.bomb) evs.push('b');
    if (obs.chat.some((c) => /^(K:|E:|U:[prf])/.test(c.text))) evs.push('c');
    const cool = (/** @type {string} */ e) => e !== 'd' && e !== 'm' && t - (this.evAt.get(e) ?? -1e9) < P.U.evCool * this.tps;
    let ev = evs.find((e) => !cool(e)) ?? '';
    const fx = new Set(obs.effects.filter((f) => near(f.x, f.y)).map((f) => `${f.kind}${Math.round(f.x / UNIT)},${Math.round(f.y / UNIT)}`));
    const flying = new Set(obs.projectiles.filter((q) => q.kind === 'flash' && near(q.x, q.y)).map((q) => `${Math.round(q.x / UNIT)},${Math.round(q.y / UNIT)}`));
    if (ev === '' && !cool('n') && ([...fx].some((k) => !this.fx.has(k)) || [...this.fx].some((k) => !fx.has(k)) || (this.flying.size > 0 && flying.size < this.flying.size))) ev = 'n';
    const cur = this.cur;
    if (ev === '' && cur !== null && obs.round.phase === 'live') {
      const arrived = (cur.type === 'a' || cur.type === 'r' || cur.type === 'f' || cur.type === 't') && dist(me.x, me.y, cur.x, cur.y) < UNIT;
      const taken = cur.type === 'h' && obs.teammates.some((m) => m.alive && m.id !== me.id && dist(m.x, m.y, cur.x, cur.y) < UNIT && dist(me.x, me.y, cur.x, cur.y) > UNIT);
      const thrown = cur.type === 'g' && si.actual?.type !== 'g';
      // 同一個動作（種類＋目標格）只觸發一次：到了以後重選仍是同一個推進時，不每拍再觸發
      const key = `${cur.type}${Math.round(cur.x / UNIT)},${Math.round(cur.y / UNIT)}`;
      if ((arrived || taken || thrown || (si.pathless && (cur.type === 'a' || cur.type === 'r'))) && key !== this.kDone && !cool('k')) {
        ev = 'k';
        this.kDone = key;
      }
    }
    if (ev !== '') this.evAt.set(ev, t);
    for (const m of obs.teammates) {
      const q = this.mpos.get(m.id);
      const dt = q === undefined ? 0 : t - q.t;
      this.mpos.set(m.id, { x: m.x, y: m.y, t, vx: q === undefined || dt <= 0 ? 0 : m.x - q.x, vy: q === undefined || dt <= 0 ? 0 : m.y - q.y, dt: dt > 0 ? dt : (q?.dt ?? 0) });
    }
    this.hp = me.hp;
    this.alive = new Set(obs.teammates.filter((m) => m.alive).map((m) => m.id));
    this.bomb = obs.bomb.state;
    this.fx = fx;
    this.flying = flying;
    return ev;
  }

  /**
   * 影子模式一步：偵測事件；視線頭；輪到自己的槽或有事件時產生候選、打分、承諾防抖、記錄（不回傳指令）
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si @param {LookIn} li
   */
  shadow(obs, si, li) {
    const ev = this.events(obs, si);
    // 視線頭每個 decide tick 都走（瞄準指令每次決策都送）；凍結期間只同步朝向
    this.look(obs, li, si.stage === 'freeze');
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
    /** @param {Act} type @param {number} x @param {number} y @param {number} ref @returns {Cand | null} */
    const add = (type, x, y, ref = -1) => {
      if (cands.length >= 16) return null;
      /** @type {Cand} */
      const a = { type, k: cands.filter((q) => q.type === type).length, x, y, ref };
      cands.push(a);
      return a;
    };
    // 守＝留在這附近：原地，加上 3 格內的守點；遠的守點是「推進」到那裡
    add('h', me.x, me.y, HERE);
    const hold = si.hold;
    if (hold !== null && dist(me.x, me.y, hold.x, hold.y) < 3 * UNIT && dist(me.x, me.y, hold.x, hold.y) > UNIT) add('h', hold.x, hold.y);
    // 推進：目標在守的範圍（P.U.holdZone 格）外才算；範圍內走過去就是守
    const zone = (this.cur !== null && this.cur.type === 'h' ? P.U.holdGap : P.U.holdZone) * UNIT;
    const gd = si.goal === null ? Infinity : dist(me.x, me.y, si.goal.x, si.goal.y);
    if (si.goal !== null && gd >= zone) add('a', si.goal.x, si.goal.y);
    // 目標在守的範圍內（1 格外）：守在目標點（對照組 r7l 這時記成守目標點）
    else if (si.goal !== null && gd > UNIT && !cands.some((q) => q.type === 'h' && q.ref !== HERE && dist(q.x, q.y, si.goal?.x ?? 0, si.goal?.y ?? 0) < UNIT)) add('h', si.goal.x, si.goal.y);
    if (si.peek !== null) add('p', si.peek.x, si.peek.y);
    // 退掩體：對記得的威脅（接觸前；交戰中的撤退是 combat.finishMove）
    if (threats.length > 0 && !si.fight) {
      const cv = si.cover();
      if (cv !== null) add('f', cv.x, cv.y);
    }
    // 補槍：隊友開火（0.9 秒內）或陣亡（2 秒內）的線索、離我 1.8～9 格（和 cooperation 的跟進條件一致；表 13-1 第 6 條）
    for (const q of si.cues) { const d = dist(q.x, q.y, me.x, me.y); if (d >= 1800 && d <= 9 * UNIT && !me.hasBomb) add('t', q.x, q.y, q.id); }
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
    // 丟道具：claim 拿得到的道具 × 落點（放在最後，候選上限 16 時先擠掉的是多的落點）
    this.nadeCands(obs, si, threats, add);
    // 現行動作仍有效就留在候選裡（防抖：守點、掩體在產生門檻邊緣進出時不換掉）
    const cur = this.cur;
    if (cur !== null && !cands.some((q) => same(q, cur)) && cands.length < 16) {
      const d = dist(me.x, me.y, cur.x, cur.y);
      if ((cur.type === 'h' && cur.ref !== HERE && d < (P.U.holdZone + 1) * UNIT) || (cur.type === 'f' && threats.length > 0 && !si.fight)) cands.push({ ...cur, k: cands.filter((q) => q.type === cur.type).length });
    }
    // 量測工具讀（最近一次決策的候選）
    this.cands = cands;
    const scored = cands.map((a) => ({ a, s: this.score(c, a) }));
    if (P.choiceTrace) this.trace = cands.map((a) => this.features.filter((f) => f.types === '*' || f.types.includes(a.type)).map((f) => ({ key: f.key, v: f.fn(c, a) })));
    // 同分取動作序號小、再取同種序號小（第四節）
    scored.sort((p, q) => q.s - p.s || ACTS.indexOf(p.a.type) - ACTS.indexOf(q.a.type) || p.a.k - q.a.k);
    let pick = scored[0]?.a ?? null;
    // 承諾防抖：最短停留與切換門檻（事件觸發不受最短停留限制）
    const curS = this.cur === null ? undefined : scored.find((q) => same(q.a, this.cur));
    if (pick !== null && curS !== undefined && curS.a !== pick) {
      const top = scored[0].s;
      // 防來回：2 秒內換回上一個動作，門檻加倍（第六節）
      const back = same(pick, this.prev) && c.held <= 2 * this.tps;
      if ((ev === '' && c.held < P.U.dwellSec * this.tps) || top < curS.s + P.U.margin * (back ? 2 : 1)) pick = curS.a;
    }
    if (pick !== null && !same(pick, this.cur)) {
      this.prev = this.cur;
      this.since = obs.tick;
    }
    this.cur = pick;
    const code = (/** @type {Cand} */ a) => `${a.type}${a.k}`;
    const act = si.actual === null ? '-' : this.match(cands, si.actual);
    this.log.push({ tick: obs.tick, ev, top: scored.slice(0, 3).map((q) => [code(q.a), q.s]), pick: pick === null ? '-' : code(pick), at: pick === null ? -1 : (pick.type === 'g' || pick.type === 't' || pick.type === 'r' || pick.ref === HERE ? -2 - pick.ref : this.g.cellOf(pick.x, pick.y)), act, stage: si.stage, fight: si.fight, reflex: si.reflex, look: this.lstat?.active === true && this.lk !== null ? `${this.lk.t}${this.lk.ref}` : '-', ls: this.lk?.s ?? 0, gk: `${pick?.kind === undefined ? '-' : codeOf(pick.kind)}${si.actual?.kind === undefined ? '-' : codeOf(si.actual.kind)}` });
    if (this.log.length > 64) this.log.shift();
  }

  /**
   * 視線頭（第四節第二組、第六節防抖）：產生視線候選、打分、硬優先與防抖，更新虛擬朝向與量測（影子模式不送指令）
   * 硬優先依序：探頭 hold／shoulder 階段鎖窄口（驗證清單 b）→ 1 秒內受傷的方向（和鎖定的新鮮敵位夾角 < hurtSameDeg 時留在敵位）→ 新鮮的記得敵位（信心 ≥ freshConf、freshSec 秒內有消息；
   * 鎖定後直到信心掉到 freshConf 以下，驗證清單 c）。其他時候照分數，換方向要差 minDeg 度、停滿 dwellSec 秒
   * @param {import('./base.js').Observation} obs @param {LookIn} li @param {boolean} freeze
   */
  look(obs, li, freeze) {
    const me = obs.me;
    const t = obs.tick;
    const L = P.U.L;
    const dt = this.lkTick < 0 ? 0 : t - this.lkTick;
    this.lkTick = t;
    const active = !freeze && li.active;
    const was = this.lstat;
    const wasActive = was !== null && was.active;
    // 先照上一次的選擇把虛擬朝向轉過去（引擎轉速；量的是這一拍的朝向，和實際朝向一樣是之前指令的結果）
    const step = (this.turn / this.tps) * dt;
    if (active && wasActive && this.lk !== null) {
      const d = adiff(angleTo(me.x, me.y, this.lk.x, this.lk.y), this.vface);
      this.vface = normDeg(this.vface + Math.max(-step, Math.min(step, d)));
    } else this.vface = me.facing;
    /** @type {LookStat} */
    const st = { tick: t, active, peek: null, thr: null, rate: null, hard: '', dl: false, vf: this.vface };
    if (active) {
      const off = (/** @type {number} */ f, /** @type {number} */ x, /** @type {number} */ y) => Math.abs(adiff(f, angleTo(me.x, me.y, x, y)));
      if (li.peek !== null && li.peek.lock) st.peek = [off(me.facing, li.peek.x, li.peek.y), off(this.vface, li.peek.x, li.peek.y)];
      let r = 1e9;
      let v = 1e9;
      let fresh = false;
      for (const k of this.perc.known.values()) {
        if (k.conf < L.freshConf) continue;
        r = Math.min(r, off(me.facing, k.x, k.y));
        v = Math.min(v, off(this.vface, k.x, k.y));
        if (t - k.tick <= L.freshSec * this.tps) fresh = true;
      }
      if (r < 1e9) st.thr = [r, v, fresh];
      if (wasActive && dt > 0) st.rate = [(Math.abs(adiff(me.facing, this.rface)) * this.tps) / dt, (Math.abs(adiff(this.vface, was.vf)) * this.tps) / dt];
    }
    this.rface = me.facing;
    this.lstat = st;
    if (!active) {
      this.lk = null;
      this.lockId = -1;
      return;
    }
    const cands = this.lookCands(obs, li);
    /** @type {LookCand | null} */
    let pick = null;
    // 新鮮的記得敵位的鎖定（探頭、受傷時也照樣更新）：信心 ≥ freshConf、freshSec 秒內有消息才鎖；鎖住後直到信心掉到門檻以下
    const held = this.lockId >= 0 ? this.perc.known.get(this.lockId) : undefined;
    if (held === undefined || held.conf < L.freshConf) this.lockId = -1;
    if (this.lockId < 0) {
      /** @type {import('./memory.js').Known | null} */
      let best = null;
      for (const k of this.perc.known.values()) {
        if (k.conf < L.freshConf || t - k.tick > L.freshSec * this.tps) continue;
        if (best === null || k.conf > best.conf || (k.conf === best.conf && (dist(me.x, me.y, k.x, k.y) < dist(me.x, me.y, best.x, best.y) || (dist(me.x, me.y, k.x, k.y) === dist(me.x, me.y, best.x, best.y) && k.id < best.id)))) best = k;
      }
      if (best !== null) this.lockId = best.id;
    }
    const lock = this.lockId >= 0 ? this.perc.known.get(this.lockId) : undefined;
    /** @type {LookCand | null} */
    const lockC = lock === undefined ? null : (cands.find((q) => q.t === 'e' && q.id === lock.id) ?? { t: 'e', ref: 8, id: lock.id, x: lock.x, y: lock.y, s: L.b.e + L.w.econf * (lock.conf / 100) });
    // 1. 探頭鎖窄口
    if (li.peek !== null && li.peek.lock) {
      pick = cands.find((q) => q.t === 'i' && q.ref === 0) ?? null;
      st.hard = 'p';
    }
    // 2. 受傷方向（1 秒內；只有打我的人沒看到時才會到這裡，看得到就是交戰、不歸視線頭管）。
    // e9 裁定第 1 條：和鎖定的新鮮敵位夾角小於 hurtSameDeg 度＝同一個威脅，留在敵位、不換
    const hurt = pick === null ? cands.find((q) => q.t === 'e' && q.ref === 9) : undefined;
    if (hurt !== undefined) {
      if (lockC !== null && Math.abs(adiff(angleTo(me.x, me.y, hurt.x, hurt.y), angleTo(me.x, me.y, lockC.x, lockC.y))) < L.hurtSameDeg) {
        pick = lockC;
        st.hard = 'e';
      } else {
        pick = hurt;
        st.hard = 'd';
        st.dl = lockC !== null;
      }
    }
    // 3. 新鮮的記得敵位
    if (pick === null && lockC !== null) {
      pick = lockC;
      st.hard = 'e';
    }
    // 4. 照分數，加防抖（換方向要差 minDeg 度、停滿 dwellSec 秒；目前的候選消失了就直接換）
    if (pick === null) {
      cands.sort((p, q) => q.s - p.s || LOOKS.indexOf(p.t) - LOOKS.indexOf(q.t) || p.ref - q.ref);
      // 沒有任何候選（停著、沒守點、沒路點）：照舊看原來的方向
      pick = cands[0] ?? this.lk;
      const cur = this.lk;
      const keep = cur === null ? undefined : cands.find((q) => this.sameLook(q, cur));
      if (pick !== null && keep !== undefined && keep !== pick) {
        const turn = Math.abs(adiff(angleTo(me.x, me.y, pick.x, pick.y), angleTo(me.x, me.y, keep.x, keep.y)));
        if (turn < L.minDeg || t - this.lkSince < L.dwellSec * this.tps) pick = keep;
      }
    }
    if (pick !== null && (this.lk === null || !this.sameLook(pick, this.lk))) this.lkSince = t;
    this.lk = pick;
  }

  /** 同一個看向：種類相同，記得的敵位看敵人 id，其他看參數 @param {LookCand} a @param {LookCand} b */
  sameLook(a, b) {
    return a.t === b.t && (a.t === 'e' ? a.id === b.id : a.ref === b.ref);
  }

  /**
   * 視線候選（第四節）：受傷方向、記得的敵位 2 個、聲音 2 個、窄口（探頭、動作附帶）、守點看向、隊友沒看的角 2 個、行進方向（前方窄口、下一個路點）
   * @param {import('./base.js').Observation} obs @param {LookIn} li @returns {LookCand[]}
   */
  lookCands(obs, li) {
    const me = obs.me;
    const t = obs.tick;
    const g = this.g;
    const L = P.U.L;
    const W = L.w;
    /** @type {LookCand[]} */
    const out = [];
    /** @param {LookCand['t']} type @param {number} ref @param {number} x @param {number} y @param {number} s @param {number} [id] */
    const add = (type, ref, x, y, s, id = -1) => out.push({ t: type, ref, id, x, y, s: (L.b[type] ?? 0) + s });
    // e：受傷方向（1 秒內，ref 9）、記得的敵人（25 格內、信心最高的 2 個）
    const hurt = this.perc.lastHurt;
    if (hurt !== null && t - hurt.tick < this.tps) add('e', 9, me.x + cosd(hurt.dir) * 8 * UNIT, me.y + sind(hurt.dir) * 8 * UNIT, W.econf + W.efresh);
    const ks = [...this.perc.known.values()].filter((k) => k.conf >= P.unconfirmed && dist(me.x, me.y, k.x, k.y) <= 25 * UNIT)
      .sort((a, b) => b.conf - a.conf || a.id - b.id).slice(0, 2);
    ks.forEach((k, i) => add('e', i, k.x, k.y, W.econf * (k.conf / 100) + W.efresh * unit(1 - (t - k.tick) / (L.freshSec * this.tps)), k.id));
    // s：聲音扇形中心（1 秒內；最新的聲音要過反應延遲，和 combat.heard 同規則；最近的 2 個）
    const snd = this.perc.lastSound;
    if (snd !== null && t - snd.tick < this.tps) {
      if (this.sndObj !== snd || snd.tick - this.sndSeen > this.tps) {
        this.sndObj = snd;
        this.sndWait = li.soundReact;
      } else if (this.sndWait > 0) this.sndWait--;
      this.sndSeen = snd.tick;
    }
    const secs = this.perc.sectors.filter((q) => t - q.tick < this.tps && (q !== this.sndObj || this.sndWait <= 0)).sort((a, b) => b.tick - a.tick).slice(0, 2);
    secs.forEach((q, i) => {
      const r = Math.max(4, Math.min(12, (q.r0 + q.r1) / 2));
      add('s', i, q.ox + cosd(q.dir) * r * UNIT, q.oy + sind(q.dir) * r * UNIT, W.sfresh * unit(1 - (t - q.tick) / this.tps) + W.shold * (li.holding ? 1 : 0));
    });
    // i：探頭的窄口（ref 0）、動作附帶的看向（ref 2）
    if (li.peek !== null) add('i', 0, li.peek.x, li.peek.y, W.ipeek);
    if (li.act !== null) add('i', 2, li.act.x, li.act.y, W.iact);
    // w：守點看向（隊友已經看著同一方向就扣分）
    if (li.hold !== null) add('w', 0, li.hold.fx, li.hold.fy, W.whold * (li.holding ? 1 : 0) + W.wcov * (this.covered(obs, li.hold.fx, li.hold.fy) ? 1 : 0));
    // c：守點（或自己）所在包點的入口裡，隊友沒看的（看得到、2～25 格，最近的 2 個；ref＝入口序號）
    const s0 = this.siteOf(li.hold ?? me);
    if (s0 >= 0) {
      const ents = this.intel.sites[CH_SITES[s0]].entrances;
      const open = ents.map((e, i) => ({ e, i, d: dist(me.x, me.y, e.x, e.y) }))
        .filter((q) => q.d <= 25 * UNIT && q.d > 2 * UNIT && g.los(me.x, me.y, q.e.x, q.e.y) && !this.covered(obs, q.e.x, q.e.y))
        .sort((a, b) => a.d - b.d || a.i - b.i).slice(0, 2);
      for (const q of open) add('c', q.i, q.e.x, q.e.y, W.chold * (li.holding ? 1 : 0));
    }
    // n：行進中，前方 15 格內看得到、敵人可能已到、沒清過的交界（和 combat.look 第 7 項同條件，ref 0），以及下一個路點（ref 1）
    if (!li.holding && li.ahead !== null) {
      const ah = li.ahead;
      const dir = angleTo(me.x, me.y, ah.x, ah.y);
      /** @type {import('./analysis.js').Portal | null} */
      let best = null;
      let bestS = -Infinity;
      for (const p of this.intel.portals) {
        const d = dist(me.x, me.y, p.x, p.y);
        if (d < 2 * UNIT || d > 15 * UNIT) continue;
        const c = g.cellOf(p.x, p.y);
        if (!this.perc.reachable(c, t, 3) || this.perc.cleared(c, t)) continue;
        if (Math.abs(adiff(angleTo(me.x, me.y, p.x, p.y), dir)) > 100) continue;
        if (!g.los(me.x, me.y, p.x, p.y)) continue;
        const s = this.perc.portalThreat[p.id] * 2 - d / UNIT + (p.choke ? 3 : 0);
        if (s > bestS) {
          bestS = s;
          best = p;
        }
      }
      const mv = W.nmove * (li.moving ? 1 : 0);
      if (best !== null) add('n', 0, best.x, best.y, mv + W.nchoke * (best.choke ? 1 : 0));
      add('n', 1, ah.x, ah.y, mv);
    }
    return out;
  }

  /** 有隊友（離我 8 格內、看得到這點）面向這點 ±45°（f17 的視線版） @param {import('./base.js').Observation} obs @param {number} x @param {number} y */
  covered(obs, x, y) {
    const me = obs.me;
    return obs.teammates.some((m) => m.alive && m.id !== me.id && dist(m.x, m.y, me.x, me.y) <= 8 * UNIT && Math.abs(adiff(m.facing, angleTo(m.x, m.y, x, y))) <= 45 && this.g.los(m.x, m.y, x, y));
  }

  /**
   * 丟道具候選（第八節、第 5 步）：不看 r7l 這一步要丟什麼（tactics.lastWish），由資源層 claim 拿得到的道具 × 效用層自己找的落點（最多 3 個）產生。
   * 道具：自己的計畫項目（plan）各一筆，加上可以自由使用的（轉 free 的計畫或計畫外的持有）一筆；沒收到計畫時每種道具一筆 free。
   * 觸發（f18t）：指揮層／資源層記下的時機（tactics.trig，只讀）裡，有種類相同、用途相符的；進點閃另外要有情報（P.flashNeedInfo，敵方價值 > 0）。
   * ref＝道具序號 × 4 ＋ 落點序號
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si @param {import('./memory.js').Threat[]} threats
   * @param {(type: Act, x: number, y: number, ref: number) => Cand | null} add
   */
  nadeCands(obs, si, threats, add) {
    const me = obs.me;
    const N = si.nade;
    const res = N.res;
    /** @type {{ kind: string, pur: string, target: import('./resources.js').Target | null }[]} */
    const items = [];
    for (const kind of [...new Set(me.loadout.grenades)]) {
      const own = me.loadout.grenades.filter((x) => x === kind).length;
      const code = codeOf(kind);
      if (!res.active) {
        items.push({ kind, pur: 'free', target: null });
        continue;
      }
      for (const it of res.items) if (it.owner === me.id && it.kind === code && it.state === 'plan') items.push({ kind, pur: it.purpose, target: it.target });
      if (res.items.some((it) => it.owner === me.id && it.kind === code && it.state === 'free') || res.spare(me.id, code, null, own) > 0) items.push({ kind, pur: 'free', target: null });
    }
    const hints = [...N.trig].map(([key, h]) => ({ key, ...h }));
    /** 全部道具的落點候選；候選上限 16 時，有觸發的先放 @type {{ i: number, j: number, kind: string, tg: number, p: import('./base.js').Pt, v: number }[]} */
    const all = [];
    items.slice(0, 4).forEach((it, i) => {
      const keys = hints.filter((h) => h.kind === it.kind && h.purposes.includes(it.pur)).map((h) => h.key);
      // 落點照 f18 由高到低（同分照產生順序：計畫目標在前），試丟不丟得到（最多試 10 個），取前 3
      /** @type {{ p: import('./base.js').Pt, v: { v: number, enemy: number }, o: number }[]} */
      const all18 = [];
      this.landings(obs, si, it).forEach((p, o) => {
        const v = this.f18(obs, si, threats, it.kind, p);
        if (v !== null) all18.push({ p, v, o });
      });
      all18.sort((x, y) => y.v.v - x.v.v || x.o - y.o);
      /** @type {typeof all18} */
      const ok = [];
      let tries = 0;
      for (const q of all18) {
        if (ok.length >= 3 || ++tries > 10) break;
        if (si.nade.solve(q.p.x, q.p.y)) ok.push(q);
      }
      ok.forEach((q, j) => {
        // 進點閃要有情報（P.flashNeedInfo；情報判斷是指揮層的 flashInfo，只讀）
        const sq = it.kind === 'flash' ? this.siteOf(q.p) : -1;
        const info = sq >= 0 ? si.nade.info(q.p, CH_SITES[sq]) : q.v.enemy > 0;
        // 閃光的落點價值要是正的（敵方價值大於隊友代價；r7l 的 gain ≥ ratio × cost 的效用版）
        const tg = keys.some((k) => !(k === 'entryFlash' && P.flashNeedInfo && !info)) && (it.kind !== 'flash' || q.v.v > 0) ? 1 : 0;
        all.push({ i, j, kind: it.kind, tg, p: q.p, v: q.v.v });
      });
    });
    all.sort((x, y) => y.tg - x.tg || x.i - y.i || x.j - y.j);
    for (const q of all) {
      const a = add('g', q.p.x, q.p.y, q.i * 4 + q.j);
      if (a === null) break;
      a.kind = q.kind;
      a.tg = q.tg;
      a.v18 = q.v;
    }
  }

  /**
   * 落點候選（還沒檢查丟不丟得到；去重 2 格、最多 40 個），依序：
   * 計畫項目只用計畫目標推出的點：入口（閃光是入口內側、往未清架點 4、8 格、入口內側 8 格內的包點格〔每 2 格〕；煙是封架點位〔架點往入口內側 smokeOff 格〕、火是入口外側；包點：架點與中心）、
   * 可以自由使用的道具：路上的火（煙）、槍線（煙：我往威脅 6 格內）、炸彈、記得的敵人、手雷的敵人群中心、計畫或所在包點的各入口、包點中心
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si @param {{ kind: string, target: import('./resources.js').Target | null }} it
   * @returns {import('./base.js').Pt[]}
   */
  landings(obs, si, it) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {import('./base.js').Pt[]} */
    const pts = [];
    const push = (/** @type {number} */ x, /** @type {number} */ y) => {
      if (pts.length < 40 && pts.every((q) => dist(q.x, q.y, x, y) >= 2 * UNIT)) pts.push({ x: Math.round(x), y: Math.round(y) });
    };
    const flash = it.kind === 'flash';
    const smoke = it.kind === 'smoke';
    const toward = (/** @type {import('./base.js').Pt} */ a, /** @type {import('./base.js').Pt} */ b, /** @type {number} */ cells, /** @type {number} */ cap) => {
      const f = Math.min(cap, (cells * UNIT) / Math.max(dist(a.x, a.y, b.x, b.y), 1));
      push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
    };
    /** @param {import('./analysis.js').Entrance} e @param {import('./analysis.js').SiteIntel} site @param {number} n */
    const entPts = (e, site, n) => {
      const inner = { x: e.ix, y: e.iy };
      if (flash) {
        push(e.ix, e.iy);
        const hs = site.holds.filter((h) => !this.perc.cleared(h.cell, t) && dist(h.x, h.y, e.ix, e.iy) <= 16 * UNIT).sort((a, b) => dist(a.x, a.y, e.ix, e.iy) - dist(b.x, b.y, e.ix, e.iy) || a.cell - b.cell);
        for (const h of hs.slice(0, n)) for (const k of [4, 8]) toward(inner, h, k, 1);
        // 入口內側 8 格內、包點範圍、從入口外側看得到的格（每 2 格取一個；f18 排序後再試丟不丟得到）
        if (n >= 2) {
          const g = this.g;
          const cx = Math.floor(e.ix / UNIT);
          const cy = Math.floor(e.iy / UNIT);
          for (let y = cy - 8; y <= cy + 8; y += 2) {
            for (let x = cx - 8; x <= cx + 8; x += 2) {
              if (x < 0 || y < 0 || x >= g.W || y >= g.H || g.isWall(x, y)) continue;
              const i = y * g.W + x;
              const c = g.center(i);
              const de = dist(c.x, c.y, e.ix, e.iy);
              if (!site.regions.has(this.intel.region[i]) || de > 8 * UNIT || de < 2 * UNIT || !g.los(e.ox, e.oy, c.x, c.y)) continue;
              push(c.x, c.y);
            }
          }
        }
      } else if (smoke) {
        // 封架點（和 tactics.smokeSpots 同一套地圖推導：看得到入口內側的架點，遠的先，往入口內側 smokeOff 格）
        const hs = site.holds.filter((h) => dist(h.x, h.y, e.ix, e.iy) <= 25 * UNIT && this.g.los(h.x, h.y, e.ix, e.iy)).sort((a, b) => dist(b.x, b.y, e.ix, e.iy) - dist(a.x, a.y, e.ix, e.iy) || a.cell - b.cell);
        for (const h of hs.slice(0, n)) toward(inner, h, P.smokeOff, 0.6);
        push(e.ix, e.iy);
        push(e.ox, e.oy);
      } else {
        push(e.ox + (e.ox - e.ix) * 0.3, e.oy + (e.oy - e.iy) * 0.3);
        push(e.ox, e.oy);
      }
    };
    const tgt = it.target;
    if (tgt !== null && tgt.site !== null) {
      const site = this.intel.sites[tgt.site];
      const e = tgt.ent >= 0 ? site.entrances[tgt.ent] : undefined;
      if (e !== undefined) entPts(e, site, 3);
      else {
        // 包點內（S）：從離我最近的入口推（封架點、閃架點）；再加架點與中心
        for (const x of [...site.entrances].sort((a, b) => dist(me.x, me.y, a.ox, a.oy) - dist(me.x, me.y, b.ox, b.oy) || a.portal - b.portal).slice(0, 2)) entPts(x, site, 2);
        for (const h of [...site.holds].sort((a, b) => dist(me.x, me.y, a.x, a.y) - dist(me.x, me.y, b.x, b.y) || a.cell - b.cell).slice(0, 2)) push(h.x, h.y);
        push(site.cx, site.cy);
      }
      // 計畫項目（有目標包點）：落點只從計畫目標推（計畫說了丟哪裡）；其他情境的落點給可以自由使用的道具
      return pts;
    }
    const th = this.perc.threats(me.x, me.y, 30).filter((q) => dist(me.x, me.y, q.x, q.y) < 25 * UNIT).slice(0, 2);
    if (smoke) {
      for (const f of obs.effects) if (f.kind === 'fire' && dist(me.x, me.y, f.x, f.y) < 20 * UNIT) push(f.x, f.y);
      for (const q of th) toward(me, q, 6, 0.6);
    }
    const bx = obs.bomb.x;
    const by = obs.bomb.y;
    if (!smoke && (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing') && bx !== null && by !== null) push(bx, by);
    if (!smoke) for (const q of th) push(q.x, q.y);
    if (it.kind === 'he') {
      const list = [...this.perc.known.values()].filter((k) => k.conf >= 70 && t - k.tick <= this.tps);
      for (const a of list) {
        const near = list.filter((k) => dist(k.x, k.y, a.x, a.y) < P.nadeCluster * UNIT);
        if (near.length >= 2) push(near.reduce((q, k) => q + k.x, 0) / near.length, near.reduce((q, k) => q + k.y, 0) / near.length);
      }
    }
    const s0 = this.siteOf(si.goal ?? me);
    const s = s0 >= 0 ? s0 : si.site;
    if (s >= 0) {
      const site = this.intel.sites[CH_SITES[s]];
      for (const e of [...site.entrances].sort((a, b) => dist(me.x, me.y, a.ox, a.oy) - dist(me.x, me.y, b.ox, b.oy) || a.portal - b.portal).slice(0, 3)) entPts(e, site, 1);
      if (!smoke) push(site.cx, site.cy);
    }
    return pts;
  }

  /**
   * f18 落點價值（第八節第 2 點，−1～1）；回傳 null＝硬排除。enemy＝敵方價值（閃光的情報判斷用）
   * 閃光：敵方＝半徑內記得的敵人（看得到爆點）× (1 − d／2R) × 朝向（看到的敵人用真實面向，推定的算正面）× 信心；
   *   隊友代價＝現在與 1.5 秒後推定位置（照速度外插，撞牆停在原地），半徑內看得到爆點：正對或側向全額、背對 0.15，× (1 − d／R)；
   *   推定的敵人（敵方守著的包點裡沒清過的架點，每個 0.5，上限 1）只算價值、不算情報；
   *   落點離任一個位置 3 格內直接排除；硬否決照 r7l 第一輪（面向爆點或交火中、4 步內躲不掉）
   * 煙：遮斷的威脅視線（威脅到我或隊友的線段穿過煙）、蓋住路上的火。火、手雷：半徑內的威脅、炸彈（T 下包後）；隊友 4 格內排除
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si @param {import('./memory.js').Threat[]} threats @param {string} kind @param {import('./base.js').Pt} p
   * @returns {{ v: number, enemy: number } | null}
   */
  f18(obs, si, threats, kind, p) {
    const me = obs.me;
    const g = this.g;
    const mates = obs.teammates.filter((m) => m.alive && m.id !== me.id);
    const th = threats.filter((q) => q.conf >= 30);
    if (kind === 'flash') {
      const R = si.nade.flashR;
      const side = this.data.rules.grenadeRules.flashSideDeg;
      let enemy = 0;
      for (const q of th) {
        const d = dist(q.x, q.y, p.x, p.y);
        if (d >= R || !g.los(q.x, q.y, p.x, p.y)) continue;
        const k = q.id >= 0 ? this.perc.known.get(q.id) : undefined;
        const face = k !== undefined && k.src === 'see' && Math.abs(adiff(angleTo(k.x, k.y, p.x, p.y), k.facing)) > side ? 0.15 : 1;
        enemy += (1 - d / (2 * R)) * face * (q.conf / 100);
      }
      // 推定的敵人（設計第八節：一律算正面）：敵方守著的包點裡還沒清過的架點，每個 0.5（只算價值，不算情報）
      let guess = 0;
      const planted = obs.bomb.state === 'planted' || obs.bomb.state === 'defusing';
      const s = this.siteOf(p);
      if (s >= 0 && (me.team === 'T') !== planted) {
        for (const h of this.intel.sites[CH_SITES[s]].holds) {
          const d = dist(h.x, h.y, p.x, p.y);
          if (d < R && !this.perc.cleared(h.cell, obs.tick) && g.los(h.x, h.y, p.x, p.y)) guess += 0.5 * (1 - d / (2 * R));
        }
      }
      let cost = 0;
      for (const m of mates) {
        const pos = [{ x: m.x, y: m.y }, this.predict(m)];
        if (pos.some((q) => dist(q.x, q.y, p.x, p.y) < 3 * UNIT)) return null;
        const faces = Math.abs(adiff(angleTo(m.x, m.y, p.x, p.y), m.facing)) <= side;
        const near = dist(m.x, m.y, p.x, p.y) < R && g.los(m.x, m.y, p.x, p.y);
        // r7l 第一輪：面向爆點或交火中、4 步內躲不掉就排除（第二輪只看交火中：影子模式只記第一輪，全部排除時 landings 會換下一個點）
        if (near && (si.nade.fighting(m.id) || faces) && !si.nade.canHide(m.x, m.y, p)) return null;
        let worst = 0;
        for (const q of pos) {
          const d = dist(q.x, q.y, p.x, p.y);
          if (d < R && g.los(q.x, q.y, p.x, p.y)) worst = Math.max(worst, (faces ? 1 : 0.15) * (1 - d / R));
        }
        cost += worst;
      }
      return { v: Math.max(-1, Math.min(1, enemy + Math.min(1, guess) - cost)), enemy };
    }
    if (kind === 'smoke') {
      // 我方的煙 smokeGap 格內不再丟（和 r7l 同規則）
      if (si.nade.smokes.some((m) => dist(m.x, m.y, p.x, p.y) < P.smokeGap * UNIT)) return null;
      const r = 3 * UNIT;
      let lines = 0;
      for (const q of th) {
        for (const m of [me, ...mates]) {
          if (segDist(q.x, q.y, m.x, m.y, p.x, p.y).d < r && g.los(q.x, q.y, m.x, m.y)) {
            lines++;
            break;
          }
        }
      }
      const fire = obs.effects.some((f) => f.kind === 'fire' && dist(f.x, f.y, p.x, p.y) < f.radius + r) ? 1 : 0;
      // 擋路：記得的敵人 10 格內（封他過來的路，r7l 封回防入口的條件）
      const block = th.some((q) => dist(q.x, q.y, p.x, p.y) < 10 * UNIT) ? 0.5 : 0;
      return { v: Math.min(1, lines / 2 + fire + block), enemy: lines };
    }
    if (mates.some((m) => dist(m.x, m.y, p.x, p.y) < 4 * UNIT)) return null;
    // 火：還在燒的我方火 4 格內不再丟
    if (kind !== 'he' && si.nade.burns.some((b) => b.until > obs.tick && dist(b.x, b.y, p.x, p.y) < 4 * UNIT)) return null;
    const r = kind === 'he' ? 3.5 * UNIT : 3 * UNIT;
    let enemy = 0;
    for (const q of th) if (dist(q.x, q.y, p.x, p.y) < r + UNIT) enemy += q.conf / 100;
    const bx = obs.bomb.x;
    const by = obs.bomb.y;
    const bomb = me.team === 'T' && (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing') && bx !== null && by !== null && dist(bx, by, p.x, p.y) < r ? 0.5 : 0;
    return { v: Math.min(1, enemy + bomb), enemy };
  }

  /** 隊友 1.5 秒後的推定位置：照最近兩次看到的速度外插，路線被牆擋住就留在原地 @param {import('./base.js').Observation['teammates'][number]} m */
  predict(m) {
    const q = this.mpos.get(m.id);
    if (q === undefined || q.dt <= 0) return { x: m.x, y: m.y };
    const k = (1.5 * this.tps) / q.dt;
    const x = m.x + q.vx * k;
    const y = m.y + q.vy * k;
    return this.g.los(m.x, m.y, x, y) ? { x, y } : { x: m.x, y: m.y };
  }

  /**
   * r7l 實際動作對到候選：g 依種類與落點（4 格內）、r 依包點／入口參數、其他依位置（3 格內最近的同種）；對不到回 '?'＋種類
   * @param {Cand[]} cands @param {{ type: Act, x: number, y: number, ref?: number, kind?: string }} act
   */
  match(cands, act) {
    let best = null;
    let bd = 3 * UNIT;
    for (const a of cands) {
      if (a.type !== act.type) continue;
      // 丟道具：種類相同、落點 4 格內最近的（第 5 步：候選不再依 r7l 的道具序號產生）
      if (a.type === 'g') {
        if (a.kind !== act.kind) continue;
        const d = dist(a.x, a.y, act.x, act.y);
        if (d <= Math.max(bd, 4 * UNIT) && (best === null || d < dist(best.x, best.y, act.x, act.y))) best = a;
        continue;
      }
      if (act.ref !== undefined && (a.type === 'r' || a.type === 't')) {
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
    return `${e.fight ? '!' : ''}${e.top.map(([k, v]) => `${k} ${n(v)}`).join('|')} → ${e.pick}${e.look === '-' ? '' : `｜L:${e.look} ${n(e.ls)}`}`;
  }
}
