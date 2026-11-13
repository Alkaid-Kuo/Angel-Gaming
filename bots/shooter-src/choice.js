// @ts-check
// 3.0 效用式個人層（丙-1，設計 docs/2026-11-10_CS射擊_Bot3.0效用式個人層設計.md）。
// 第一步影子模式：照算候選、特徵、分數、承諾，記錄前三名與「r7l 實際做的動作」，行為仍由 tactics／combat／nav 驅動（不回傳任何指令）。
// 特徵表資料驅動（審查決定 3）：每筆 { key, fn, types, min, max }，打分只走訪特徵表與 P.U。
import { P, UNIT, adiff, angleTo, clamp, cosd, dijkstra, dist, normDeg, segDist, sind } from './base.js';
import { codeOf } from './resources.js';
import { AWP, ENTRY } from './roles.js';

/** 動作字母（第七節正式格式）：h 守、a 推進、p 探頭、f 退掩體、t 補槍、g 丟道具、r 轉點、o 下包／拆包 */
export const ACTS = /** @type {const} */ (['h', 'a', 'p', 'f', 't', 'g', 'r', 'o']);
/** @typedef {typeof ACTS[number]} Act */
/** 計畫階段（f11） */
export const STAGES = /** @type {const} */ (['freeze', 'setup', 'wait', 'execute', 'post', 'retake', 'save']);
/** @typedef {typeof STAGES[number]} Stage */
const CH_SITES = /** @type {const} */ (['A', 'B']);
/**
 * 候選：type 動作、k 同種內序號、x／y 動作結束時人在的位置（丟道具是落點）、ref 參數（隊友 id、包點序號、道具序號 × 4 ＋ 落點序號…）；
 * 丟道具另帶 kind 種類、tg 觸發（f18t）、v18 落點價值（f18）、why 合的觸發鍵；src：來自 PlanIntent 的目標（goal）或守點（hold）——執行時跟著指揮層這一步的最新值走
 * @typedef {{ type: Act, k: number, x: number, y: number, ref: number, kind?: string, tg?: number, v18?: number, why?: string, src?: 'goal' | 'hold' }} Cand
 */
/**
 * 效用層的輸入（PlanIntent 與個人狀態；baseline 每個 decide tick 整理）。rush：計畫是 rush（讓位上限 P.yieldMax，其他 P.yieldMaxSplit）；flashed：我方閃光剛炸開 2 秒內；flashOwner：我持有這個入口還沒丟的計畫進點閃（指揮層）；lead：waitEntry 的 lead 條件（待命格附近、先煙的計畫、執行後 P.stageLead 秒內、我這一步不丟、不是閃光擁有者，而且突破手還沒走在我前面；狙擊手等兩個隊友進點；指揮層算、只讀）；objOk：指揮層這一步要下包或拆包（下包點、拆包分工留在指揮層；或正在下拆包中）；follow：指揮層的任務允許跟進補槍（執行或回防；PlanIntent）；path：往計畫目標的路徑（格）、allowPeek：指揮層允許探頭（PlanIntent）、peekLen：探一次停幾個決策（個人屬性）；exec：T 這次執行的包點（PlanIntent）、planGo：計畫是 go（不等突破手）、entryId：突破手的 id（角色分配）
 * @typedef {{ stage: Stage, goal: import('./base.js').Pt | null, hold: import('./base.js').Pt | null, role: number, p: number, fight: boolean, reflex: boolean,
 *   actual: { type: Act, x: number, y: number, ref?: number, kind?: string } | null, inSite: boolean, peek: import('./base.js').Pt | null,
 *   cover: () => import('./base.js').Pt | null, trade: (q: { x: number, y: number, dead: boolean }) => boolean, nade: NadeIn, group: (id: number) => number, pathless: boolean,
 *   planWait: boolean, order: { spawnF: number, awpF: number }, site: number, soon: import('./base.js').Pt | null,
 *   exec: 'A' | 'B' | null, planGo: boolean, entryId: number, path: number[], allowPeek: boolean, peekLen: number, follow: boolean, objOk: boolean,
 *   rush: boolean, flashed: boolean, flashOwner: boolean, lead: boolean }} ShadowIn
 */
/**
 * 丟道具（第 5 步）：res 資源層副本（只讀）、trig 指揮層記的觸發（tactics.trig，只讀）、solve 從我這裡丟得到、fighting 隊友交火中（1.5 秒內開過槍或被記得的敵人看得到）、
 * canHide 隊友 4 步內躲得到、flashR 閃光半徑、smokes／burns 我方丟過的煙與火（指揮層的紀錄）、info 指揮層的「爆點附近有情報」（flashInfo：記得的敵人、聲音、接觸喊話）、
 * used 這一步剛丟出的資源層項目與丟出前的狀態（影子量測用）、awp 記得的敵方狙擊位（聽到或看到狙擊槍的位置）、ent 這次執行我這組走的入口（PlanIntent）、deep 包點的深位（地圖推導）、post 下包後分給我封的回防入口（資源層的隊伍協調，只讀）、anchor 指揮層 r7l 規則這一步要丟的閃光固定點（閃進點的 flashPoint、回防閃的近炸彈敵人或炸彈；tactics.lastWish，只讀）、taken 這點 8 格內已有隊友的閃光（認領喊話、3 秒內炸開、飛行中）
 * @typedef {{ res: import('./resources.js').Resources, trig: Map<string, { kind: string, purposes: string[], ent?: import('./analysis.js').Entrance }>, solve: (x: number, y: number) => boolean,
 *   fighting: (id: number) => boolean, canHide: (x: number, y: number, c: import('./base.js').Pt) => boolean, flashR: number,
 *   smokes: import('./base.js').Pt[], burns: { x: number, y: number, until: number }[], info: (p: import('./base.js').Pt, site: 'A' | 'B') => boolean,
 *   deep: (site: 'A' | 'B') => import('./base.js').Pt[], post: import('./analysis.js').Entrance | null, taken: (p: import('./base.js').Pt) => boolean,
 *   ent: import('./analysis.js').Entrance | null, used: { it: import('./resources.js').UtilItem, state: string } | null, awp: { x: number, y: number, tick: number } | null,
 *   anchor: import('./base.js').Pt | null }} NadeIn
 */
/**
 * 決策脈絡（只讀觀察與自己的狀態）
 * @typedef {{ obs: import('./base.js').Observation, in: ShadowIn, threats: import('./memory.js').Threat[], mates: import('./base.js').Observation['teammates'], cur: Cand | null, held: number, site: number, yieldF: number }} Ctx
 */
/** @typedef {{ key: string, fn: (c: Ctx, a: Cand) => number, types: string, min: number, max: number }} Feature */
/** 決策紀錄（gk：選定的與 r7l 實際丟的道具種類字母，沒有是 -；at：選定動作的目標格；丟道具、補槍、轉點是 −2 − 參數；look／ls：視線頭此刻的選擇與分數，'-'＝不歸視線頭管） @typedef {{ tick: number, ev: string, top: [string, number][], pick: string, at: number, act: string, stage: Stage, fight: boolean, reflex: boolean, look: string, ls: number, gk: string }} LogEntry */
/** 視線種類字母（第七節）：e 記得的敵位、s 聲音、i 入口／窄口、w 守點看向、c 隊友沒看的角、n 行進方向、j 先架危險角度的預瞄（第 6 步修正，排最後不影響既有的同分順序） */
export const LOOKS = /** @type {const} */ (['e', 's', 'i', 'w', 'c', 'n', 'j']);
/**
 * 視線頭的輸入（baseline.shadow 每個 decide tick 整理）。active：歸視線頭管（live、沒看到敵人、沒交戰、不是躲閃光／丟道具／下拆包這類不接管的視線）
 * peek：正在探的窄口（lock＝hold 或 shoulder 階段）；hold：3 格內的守點（含看向）；act：指揮層這一步的看向 i2（等槍線、佯攻、換血架槍、補槍站位；每拍重給，沒有就是 null）；ahead：行進方向的下一個路點；
 * pre：先架危險角度（judgment.approach）這一拍要預瞄的點與要不要停（每拍重給，沒有就是 null）
 * @typedef {{ active: boolean, peek: { x: number, y: number, lock: boolean } | null, hold: { x: number, y: number, fx: number, fy: number } | null, holding: boolean, moving: boolean,
 *   act: import('./base.js').Pt | null, pre: { x: number, y: number, stop: boolean } | null, ahead: import('./base.js').Pt | null, soundReact: number }} LookIn
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
export const HERE = -9;

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
    /** 守位掃描的計數（P.U.L.holdScan；視線頭自己的狀態，和 r7l combat.look 第 6 項同一套節奏） */
    this.scanIdx = 0;
    this.scanLeft = 0;
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
    /** 補槍的線索（隊友開火 0.9 秒內、陣亡 2 秒內的位置；和 cooperation 同規則、效用層自己記） @type {Map<number, { x: number, y: number, tick: number, dead: boolean }>} */
    this.cues = new Map();
    /** 探頭（效用層自己找、自己記）：目前要探的窄口、各窄口最後探過的 tick、上一次探頭的位置；nav＝交給 nav 狀態機執行的探頭 @type {{ portal: number, hold: import('./base.js').Pt, far: import('./base.js').Pt, since: number, reach: number, at: number, nav: import('./nav.js').Peek } | null} */
    this.pk = null;
    /** @type {Map<number, number>} */
    this.peeked = new Map();
    /** @type {{ x: number, y: number, t: number } | null} */
    this.lastPeek = null;
    /** 這回合讓位累計的 tick（yieldTo 的上限；效用層自己記）與這一拍的 f21y */
    this.yHeld = 0;
    this.yF = 0;
    /** 這回合進過包點的隊友：`${點}${id}`（等突破手用；效用層自己記） @type {Set<string>} */
    this.wentIn = new Set();
    /** 最近一次決策的丟道具產生診斷（量測工具讀） @type {Map<string, number[]>} */
    this.ndiag = new Map();
    /** 最近一次決策的道具筆（候選 ref ÷ 4 對到這裡；切換後執行丟道具時給資源層的項目） @type {{ kind: string, pur: string, target: import('./resources.js').Target | null, it: import('./resources.js').UtilItem | null }[]} */
    this.nitems = [];
    /** 目前的丟道具動作已經丟出（執行層回報；下一次決策前不再丟） */
    this.gDone = false;
    /** 上一次看到的 PlanIntent 目標（目標換地方＝計畫改變事件） @type {import('./base.js').Pt | null} */
    this.goal0 = null;
  }

  reset() {
    this.cur = null;
    this.yHeld = 0;
    this.yF = 0;
    this.goal0 = null;
    this.prev = null;
    this.since = -1;
    this.lastTick = -1e9;
    this.lk = null;
    this.lkSince = -1;
    this.lockId = -1;
    this.scanIdx = 0;
    this.scanLeft = 0;
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
      // 指揮層的任務允許跟進（執行或回防；cooperation 的條件）
      { key: 'ftk', types: 't', min: 0, max: 1, fn: (c) => (c.in.follow ? 1 : 0) },
      // 守的是指揮層這一步要去的點（1 格內）：計畫目標；守點只在目標就在守點附近（守的範圍內）或沒有目標時才算（目標已經換到別處＝守點是舊的）
      { key: 'fhp', types: 'h', min: 0, max: 1, fn: (c, a) => { if (a.ref === HERE) return 0; const g = c.in.goal; const h = c.in.hold; const at = (/** @type {import('./base.js').Pt | null} */ p) => p !== null && dist(p.x, p.y, a.x, a.y) < UNIT; return at(g) || (at(h) && h !== null && (g === null || dist(g.x, g.y, h.x, h.y) < P.U.holdZone * UNIT)) ? 1 : 0; } },
      // 狙擊手拿狙擊槍、離守點或這一組的待命格 4 格內（取代 awpSettle 的條件）；只加在站得住的那一個：原地或 4 格內的 h（awpSettle 是就地站定，第 6 步修正 R2）
      { key: 'f16w', types: 'h', min: 0, max: 1, fn: (c, a) => (c.in.order.awpF && (a.ref === HERE || dist(c.obs.me.x, c.obs.me.y, a.x, a.y) < 4 * UNIT) ? 1 : 0) },
      // f21 進點順序：等突破手先進（yieldTo 的條件）、出生區讓位（spawnWait 的條件）
      // 遠處的守（4 格以上，例如執行開始後搬進包點的守點）也是往前走，一樣要讓（第 6 步修正 R2）
      { key: 'f21y', types: 'ah', min: 0, max: 1, fn: (c, a) => (a.type === 'a' || (a.ref !== HERE && dist(c.obs.me.x, c.obs.me.y, a.x, a.y) >= 4 * UNIT) ? c.yieldF : 0) },
      { key: 'f21s', types: 'a', min: 0, max: 1, fn: (c) => c.in.order.spawnF },
      // 指揮層的合法等待（PlanIntent）：2.8 執行品質的慢半拍、跟上等
      { key: 'fw', types: 'ha', min: 0, max: 1, fn: (c) => (c.in.planWait ? 1 : 0) },
      // f18 的計畫時機項：資源層／指揮層的觸發條件成立（設計第八節第 1 點；效用層只讀）
      { key: 'f18t', types: 'g', min: 0, max: 1, fn: (_c, a) => a.tg ?? 0 },
      // f18 落點價值（第八節第 2 點）：產生候選時算好
      { key: 'f18', types: 'g', min: -1, max: 1, fn: (_c, a) => a.v18 ?? 0 },
      // 分給我的回防入口（資源層的隊伍協調，輸入特徵）：煙的落點在那個入口外側 2 格內
      { key: 'f18a', types: 'g', min: 0, max: 1, fn: (c, a) => { const e = c.in.nade.post; return a.kind === 'smoke' && e !== null && dist(e.ox, e.oy, a.x, a.y) < 2 * UNIT ? 1 : 0; } },
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

  /**
   * 探頭（原 nav.findPeek 的條件，第 6 步準備搬進效用層；每個 decide tick 走）：路徑前方 12 格內第一個要探的交界（窄口或包點入口）——
   * 對面 6 格（看窄口後面）敵人可能已經到、沒清過、6 格內沒有隊友、這個窄口 15 秒內沒探過；停在交界前 P.peekStop 格。
   * 到了停點、停滿 peekLen 個決策就算探過；離停點太遠或排定 8 秒還沒探完就放棄（也算探過）
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si
   */
  peekStep(obs, si) {
    const g = this.g;
    const me = obs.me;
    const t = obs.tick;
    const goal = si.goal;
    if (!si.allowPeek || si.stage === 'freeze' || goal === null || dist(me.x, me.y, goal.x, goal.y) < 450) {
      this.pk = null;
      return;
    }
    const pk = this.pk;
    if (pk !== null) {
      const dh = dist(me.x, me.y, pk.hold.x, pk.hold.y);
      if (pk.at < 0 && dh < 700) pk.at = t;
      const done = pk.at >= 0 && t - pk.at >= si.peekLen * this.data.rules.decisionInterval;
      if (done || dh > pk.reach || t - pk.since > 8 * this.tps) {
        this.peeked.set(pk.portal, t);
        if (done) this.lastPeek = { x: pk.hold.x, y: pk.hold.y, t };
        this.pk = null;
      }
      return;
    }
    const path = si.path;
    if (path.length < 4) return;
    let k = path.indexOf(g.cellOf(me.x, me.y));
    if (k < 0) {
      let best = Infinity;
      for (let i = 0; i < path.length; i++) {
        const c = g.center(path[i]);
        const d = dist(c.x, c.y, me.x, me.y);
        if (d < best) {
          best = d;
          k = i;
        }
      }
    }
    const intel = this.intel;
    for (let i = Math.max(k, 0); i < Math.min(path.length - 1, k + 12); i++) {
      if (intel.region[path[i]] === intel.region[path[i + 1]]) continue;
      const pid = intel.portalAt[path[i]] >= 0 ? intel.portalAt[path[i]] : intel.portalAt[path[i + 1]];
      if (pid < 0) continue;
      if (!intel.portals[pid].choke && !CH_SITES.some((s) => intel.sites[s].entrances.some((e) => e.portal === pid))) continue;
      const last = this.peeked.get(pid);
      if (last !== undefined && t - last < 15 * this.tps) continue;
      const lp = this.lastPeek;
      if (lp !== null && t - lp.t < 5 * this.tps && dist(lp.x, lp.y, g.center(path[i]).x, g.center(path[i]).y) < 8 * UNIT) continue;
      const fi = Math.min(path.length - 1, i + 6);
      const far = g.center(path[fi]);
      if (!this.perc.reachable(path[fi], t, 4) || this.perc.cleared(path[fi], t)) continue;
      if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, far.x, far.y) < 6 * UNIT)) continue;
      const hi = Math.max(k, i - P.peekStop);
      if (hi === k && i - k < P.peekStop) {
        this.peeked.set(pid, t);
        continue;
      }
      const hold = g.center(path[hi]);
      const reach = dist(me.x, me.y, hold.x, hold.y) + 3 * UNIT;
      this.pk = { portal: pid, hold, far, since: t, reach, at: -1, nav: { portal: pid, hold, far, cross: g.center(path[i]), phase: 'approach', left: 0, since: t, reach } };
      return;
    }
  }

  /** (x, y) 在包點 s 的矩形內 @param {'A' | 'B'} s @param {number} x @param {number} y */
  inRect(s, x, y) {
    const r = this.intel.sites[s].rect;
    const cx = Math.floor(x / UNIT);
    const cy = Math.floor(y / UNIT);
    return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
  }

  /**
   * f21y 等突破手先進（原 tactics.yieldTo／waitEntry 的條件，第 6 步準備搬進效用層）：執行中、計畫不是 go、離執行包點 P.yieldNear 格內，
   * 我不是突破手、還沒進點，突破手活著、沒進過包點、沒有明顯在我前面（1 格以上）；狙擊手等到兩個隊友進過包點
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si
   */
  yieldF(obs, si) {
    const s = si.exec;
    const me = obs.me;
    const c = this.g.cellOf(me.x, me.y);
    if (s === null || si.planGo || c < 0) return 0;
    const dS = this.intel.distSite[s];
    if (dS[c] > P.yieldNear * 10 || si.role === ENTRY || this.inRect(s, me.x, me.y)) return 0;
    const mates = obs.teammates.filter((m) => m.alive);
    const other = s === 'A' ? 'B' : 'A';
    const went = (/** @type {number} */ id) => this.wentIn.has(`${s}${id}`) || (!P.wentInSite && this.wentIn.has(`${other}${id}`));
    if (si.role === AWP) return mates.filter((m) => went(m.id)).length < Math.min(2, mates.length) ? 1 : 0;
    const e = mates.find((m) => m.id === si.entryId);
    const ce = e === undefined ? -1 : this.g.cellOf(e.x, e.y);
    return e !== undefined && ce >= 0 && !went(e.id) && dS[ce] >= dS[c] - 10 ? 1 : 0;
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
    // 12 格內的槍聲；隊友在 9 格內開火（新的補槍線索：線索只活 0.9 秒，等輪值會錯過）
    if (obs.sounds.some((s) => s.kind === 'shot' && s.range === 'near' && !s.friendly) || obs.teammates.some((m) => m.alive && m.firing && !this.cues.has(m.id) && near(m.x, m.y) && dist(me.x, me.y, m.x, m.y) <= 9 * UNIT)) evs.push('s');
    if (obs.teammates.some((m) => !m.alive && this.alive.has(m.id) && (si.group(m.id) === si.group(me.id) || near(m.x, m.y)))) evs.push('m');
    // 炸彈狀態改變，或指揮層這一步要我下包／拆包（下包點到了、拆包分工輪到我；這個不冷卻：拆包指令送出後指揮層會等反應延遲、不再重送）
    const objEv = si.objOk && (this.cur === null || this.cur.type !== 'o');
    if (obs.bomb.state !== this.bomb || objEv) evs.push('b');
    // 計畫或事件喊話；指揮層這一步的目標換了地方（守的範圍以外）也算計畫改變
    const g0 = this.goal0;
    const goalMoved = si.goal !== null && (g0 === null || dist(g0.x, g0.y, si.goal.x, si.goal.y) >= P.U.holdZone * UNIT);
    if (si.goal !== null && (g0 === null || goalMoved)) this.goal0 = { x: si.goal.x, y: si.goal.y };
    if (obs.chat.some((c) => /^(K:|E:|U:[prf])/.test(c.text)) || (goalMoved && g0 !== null)) evs.push('c');
    const cool = (/** @type {string} */ e) => e !== 'd' && e !== 'm' && !(e === 'b' && objEv) && t - (this.evAt.get(e) ?? -1e9) < P.U.evCool * this.tps;
    let ev = evs.find((e) => !cool(e)) ?? '';
    const fx = new Set(obs.effects.filter((f) => near(f.x, f.y)).map((f) => `${f.kind}${Math.round(f.x / UNIT)},${Math.round(f.y / UNIT)}`));
    const flying = new Set(obs.projectiles.filter((q) => q.kind === 'flash' && near(q.x, q.y)).map((q) => `${Math.round(q.x / UNIT)},${Math.round(q.y / UNIT)}`));
    if (ev === '' && !cool('n') && ([...fx].some((k) => !this.fx.has(k)) || [...this.fx].some((k) => !fx.has(k)) || (this.flying.size > 0 && flying.size < this.flying.size))) ev = 'n';
    const cur = this.cur;
    if (ev === '' && cur !== null && obs.round.phase === 'live') {
      const arrived = (cur.type === 'a' || cur.type === 'r' || cur.type === 'f' || cur.type === 't') && dist(me.x, me.y, cur.x, cur.y) < UNIT;
      const taken = cur.type === 'h' && obs.teammates.some((m) => m.alive && m.id !== me.id && dist(m.x, m.y, cur.x, cur.y) < UNIT && dist(me.x, me.y, cur.x, cur.y) > UNIT);
      const thrown = cur.type === 'g' && (P.choiceDrive ? this.gDone : si.actual?.type !== 'g');
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
    for (const m of obs.teammates) {
      if (m.alive && m.firing) this.cues.set(m.id, { x: m.x, y: m.y, tick: t, dead: false });
      if (this.alive.has(m.id) && !m.alive) this.cues.set(m.id, { x: m.x, y: m.y, tick: t, dead: true });
    }
    for (const [id, q] of this.cues) if (t - q.tick > (q.dead ? 2 : 0.9) * this.tps) this.cues.delete(id);
    if (obs.round.phase === 'freeze') this.wentIn.clear();
    else for (const m of obs.teammates) if (m.alive) for (const s of CH_SITES) if (this.inRect(s, m.x, m.y)) this.wentIn.add(`${s}${m.id}`);
    this.hp = me.hp;
    this.alive = new Set(obs.teammates.filter((m) => m.alive).map((m) => m.id));
    this.bomb = obs.bomb.state;
    this.fx = fx;
    this.flying = flying;
    return ev;
  }

  /**
   * 動作決策一步（每個 decide tick）：偵測事件、探頭紀錄；輪到自己的槽或有事件時產生候選、打分、承諾防抖、記錄。選定的動作在 this.cur（執行在 baseline）
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si
   */
  step(obs, si) {
    const ev = this.events(obs, si);
    this.peekStep(obs, si);
    // f21y 每個 decide tick 算並計時（和 yieldTo 一樣：讓位累計到上限就不再讓；閃光剛炸開不讓〔狙擊手照讓〕；持有計畫進點閃的人不讓）
    // lead 分支（第 6 步修正，R2：原 tactics waitEntry 的「等突破手先走」待命，上限是執行後 P.stageLead 秒，不受讓位上限管，和 r7l 相同）
    const yf = si.stage === 'freeze' ? 0 : si.lead ? 1 : si.flashOwner || (si.flashed && si.role !== AWP) || this.yHeld >= (si.rush ? P.yieldMax : P.yieldMaxSplit) * this.tps ? 0 : this.yieldF(obs, si);
    // lead 期間不佔讓位額度（r7l 的 waitEntry lead 和 yieldTo 是分開的；第 6 步修正批二）
    if (yf > 0 && !si.lead) this.yHeld += this.data.rules.decisionInterval;
    this.yF = yf;
    // 凍結期間只買與喊話（硬反射第 6 項），不決策
    if (si.stage === 'freeze') return;
    const k = Math.floor(obs.tick / this.data.rules.decisionInterval);
    const n = si.p < 0.25 ? 6 : 5;
    if (ev === '' && (k - this.slot) % n !== 0) return;
    if (obs.tick <= this.lastTick) return;
    this.lastTick = obs.tick;
    this.gDone = false;
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
    if (hold !== null && dist(me.x, me.y, hold.x, hold.y) < 3 * UNIT && dist(me.x, me.y, hold.x, hold.y) > UNIT) { const a = add('h', hold.x, hold.y); if (a !== null) a.src = 'hold'; }
    // 推進：目標在守的範圍（P.U.holdZone 格）外才算；範圍內走過去就是守
    const zone = (this.cur !== null && this.cur.type === 'h' ? P.U.holdGap : P.U.holdZone) * UNIT;
    const gd = si.goal === null ? Infinity : dist(me.x, me.y, si.goal.x, si.goal.y);
    if (si.goal !== null && gd >= zone) { const a = add('a', si.goal.x, si.goal.y); if (a !== null) a.src = 'goal'; }
    // 目標在守的範圍內（1 格外）：守在目標點（對照組 r7l 這時記成守目標點）
    else if (si.goal !== null && gd > UNIT && !cands.some((q) => q.type === 'h' && q.ref !== HERE && dist(q.x, q.y, si.goal?.x ?? 0, si.goal?.y ?? 0) < UNIT)) { const a = add('h', si.goal.x, si.goal.y); if (a !== null) a.src = 'goal'; }
    if (this.pk !== null) add('p', this.pk.hold.x, this.pk.hold.y);
    // 退掩體：對記得的威脅（接觸前；交戰中的撤退是 combat.finishMove）
    if (threats.length > 0 && !si.fight) {
      const cv = si.cover();
      if (cv !== null) add('f', cv.x, cv.y);
    }
    // 補槍：隊友開火（0.9 秒內）或陣亡（2 秒內）的線索、離我 1.8～9 格（和 cooperation 的跟進條件一致；表 13-1 第 6 條）
    // 站位要找得到（補槍方向來自真實接敵或隊友公開開火方向；cooperation.spotFor），換彈中不跟（P.coopEligible）
    for (const [id, q0] of this.cues) { const q = { id, ...q0 }; const d = dist(q.x, q.y, me.x, me.y); if (d >= 1800 && d <= 9 * UNIT && !me.hasBomb && (!P.coopEligible || me.reloadTicksLeft === 0) && si.trade(q)) add('t', q.x, q.y, q.id); }
    // 轉點：另一個包點（離我最近的入口外側）；回防時只在入口受阻才換同包點的另一入口
    const site = this.siteOf(si.goal);
    /** @type {Ctx} */
    const c = { obs, in: si, threats, mates, cur: this.cur, held: this.since < 0 ? 0 : obs.tick - this.since, site, yieldF: this.yF };
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
    // 下包／拆包（審查第 6 步切換條件 1、2）：下包點與拆包分工留在指揮層（postPlant、defuseTeam），指揮層這一步要下拆包才是候選；
    // 下包點以外的地方是「推進」到下包點
    if (si.objOk) add('o', obs.bomb.x ?? me.x, obs.bomb.y ?? me.y);
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
    this.log.push({ tick: obs.tick, ev, top: scored.slice(0, 3).map((q) => [code(q.a), q.s]), pick: pick === null ? '-' : code(pick), at: pick === null ? -1 : (pick.type === 'g' || pick.type === 't' || pick.type === 'r' || pick.ref === HERE ? -2 - pick.ref : this.g.cellOf(pick.x, pick.y)), act, stage: si.stage, fight: si.fight, reflex: si.reflex, look: '-', ls: 0, gk: `${pick?.kind === undefined ? '-' : codeOf(pick.kind)}${si.actual?.kind === undefined ? '-' : codeOf(si.actual.kind)}` });
    if (this.log.length > 64) this.log.shift();
  }

  /**
   * 視線頭（第四節第二組、第六節防抖）：產生視線候選、打分、硬優先與防抖，更新虛擬朝向與量測（影子模式不送指令）
   * 硬優先依序：探頭 hold／shoulder 階段鎖窄口（驗證清單 b）→ 1 秒內受傷的方向（和鎖定的新鮮敵位夾角 < hurtSameDeg 時留在敵位）→ 先架危險角度的預瞄 j（P.U.L.approachHard）→ 指揮層這一步的看向 i2（P.U.L.i2Hard）→ 新鮮的記得敵位（信心 ≥ freshConf、freshSec 秒內有消息；
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
    // 雷達（隊友此刻看到的敵人）30 格內最近的那個最新鮮：優先鎖它，鎖定中的不在雷達上就換（和 combat.look 第 1 項同條件）
    let rb = null;
    let rd = 30 * UNIT;
    for (const r of obs.radar) {
      const d = dist(me.x, me.y, r.x, r.y);
      if (d < rd || (d === rd && rb !== null && r.id < rb.id)) {
        rd = d;
        rb = r;
      }
    }
    if (rb !== null && this.perc.known.has(rb.id) && !obs.radar.some((r) => r.id === this.lockId)) this.lockId = rb.id;
    if (this.lockId < 0) {
      /** @type {import('./memory.js').Known | null} */
      let best = null;
      for (const k of this.perc.known.values()) {
        if (k.conf < L.freshConf || t - k.tick > L.freshSec * this.tps) continue;
        if (best === null || k.conf > best.conf || (k.conf === best.conf && (dist(me.x, me.y, k.x, k.y) < dist(me.x, me.y, best.x, best.y) || (dist(me.x, me.y, k.x, k.y) === dist(me.x, me.y, best.x, best.y) && k.id < best.id)))) best = k;
      }
      if (best !== null) this.lockId = best.id;
    }
    let lock = this.lockId >= 0 ? this.perc.known.get(this.lockId) : undefined;
    // 守位、沒在移動時（r7l combat.look 的 holding）：雷達上以外的鎖定要在 25 格內（r7l 第 4 項記得的敵人的上限；P.U.L.holdLockCap）
    if (L.holdLockCap && li.holding && lock !== undefined && !obs.radar.some((r) => r.id === lock?.id) && dist(me.x, me.y, lock.x, lock.y) > 25 * UNIT) lock = undefined;
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
    // 3. 先架危險角度的預瞄（j；P.U.L.approachHard）：judgment.approach 每拍重給，沒有就沒有候選。關掉時 j 只是計分候選；不論哪種，沒採用 j 時 baseline 不送它的停步（耦合規則）
    if (L.approachHard && pick === null) {
      const ja = cands.find((q) => q.t === 'j');
      if (ja !== undefined) {
        pick = ja;
        st.hard = 'j';
      }
    }
    // 4. 指揮層這一步的看向（i2；P.U.L.i2Hard）：li.act 每拍由這一步的指令重新給，指令消失就沒有 i2 候選、不會殘留
    if (L.i2Hard && pick === null) {
      const ia = cands.find((q) => q.t === 'i' && q.ref === 2);
      if (ia !== undefined) {
        pick = ia;
        st.hard = 'i';
      }
    }
    // 5. 新鮮的記得敵位
    if (pick === null && lockC !== null) {
      pick = lockC;
      st.hard = 'e';
    }
    // 6. 守位、沒在移動時照 r7l 的掃描節奏（P.U.L.holdScan；combat.look 第 6 項）：主要入口（守點看向）三次裡兩次，其餘輪掃看得到的其他交界
    if (L.holdScan && pick === null && li.holding && li.hold !== null) {
      pick = this.holdScan(obs, li.hold);
      st.hard = 'h';
    }
    // 7. 照分數，加防抖（換方向要差 minDeg 度、停滿 dwellSec 秒；目前的候選消失了就直接換）
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
    const e = this.log[this.log.length - 1];
    if (e !== undefined && e.tick === t && pick !== null) {
      e.look = `${pick.t}${pick.ref}`;
      e.ls = pick.s;
    }
  }

  /**
   * 守位掃描（r7l combat.look 第 6 項的同一套節奏，計數是視線頭自己的）：views＝守點看向＋最多 2 個看得到的其他交界（離守點 5～25 格、6 秒內可能有人、和主要方向差 20° 以上）；
   * 每 P.scanEvery 次換一格，三次裡兩次看主要入口。主要入口是 w0，其他是 c（ref＝序號）
   * @param {import('./base.js').Observation} obs @param {{ x: number, y: number, fx: number, fy: number }} hold @returns {LookCand}
   */
  holdScan(obs, hold) {
    const g = this.g;
    const t = obs.tick;
    if (--this.scanLeft <= 0) {
      this.scanLeft = P.scanEvery;
      this.scanIdx++;
    }
    /** @type {import('./base.js').Pt[]} */
    const views = [{ x: hold.fx, y: hold.fy }];
    for (const p of this.intel.portals) {
      if (views.length >= 3) break;
      const d = dist(p.x, p.y, hold.x, hold.y);
      if (d < 5 * UNIT || d > 25 * UNIT || !g.los(hold.x, hold.y, p.x, p.y)) continue;
      if (!this.perc.reachable(g.cellOf(p.x, p.y), t, 6)) continue;
      if (Math.abs(adiff(angleTo(hold.x, hold.y, p.x, p.y), angleTo(hold.x, hold.y, hold.fx, hold.fy))) < 20) continue;
      views.push({ x: p.x, y: p.y });
    }
    const k = this.scanIdx % (views.length + 1);
    const v = k < 2 ? views[0] : views[k - 1];
    return k < 2 ? { t: 'w', ref: 0, id: -1, x: v.x, y: v.y, s: 0 } : { t: 'c', ref: 10 + k, id: -1, x: v.x, y: v.y, s: 0 };
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
    // j：先架危險角度的預瞄（要停步的另外加分）
    if (li.pre !== null) add('j', 0, li.pre.x, li.pre.y, W.jstop * (li.pre.stop ? 1 : 0));
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
    /** @type {{ kind: string, pur: string, target: import('./resources.js').Target | null, it: import('./resources.js').UtilItem | null }[]} */
    const items = [];
    this.nitems = items;
    for (const kind of [...new Set(me.loadout.grenades)]) {
      const own = me.loadout.grenades.filter((x) => x === kind).length;
      const code = codeOf(kind);
      if (!res.active) {
        items.push({ kind, pur: 'free', target: null, it: null });
        continue;
      }
      // 丟出那一步看丟出前的狀態（影子量測）
      const st = (/** @type {import('./resources.js').UtilItem} */ it) => (N.used !== null && N.used.it === it ? N.used.state : it.state);
      const taken = res.items.filter((it) => it.owner === me.id && it.kind === code && st(it) === 'plan').length;
      for (const it of res.items) if (it.owner === me.id && it.kind === code && st(it) === 'plan') items.push({ kind, pur: it.purpose, target: it.target, it });
      if (res.items.some((it) => it.owner === me.id && it.kind === code && st(it) === 'free') || own - taken > 0) items.push({ kind, pur: 'free', target: null, it: res.claim(me.id, kind, ['free'], own) });
    }
    const hints = [...N.trig].map(([key, h]) => ({ key, ...h }));
    /** 診斷（量測工具讀）：種類 → [道具、落點、f18 沒排除、丟得到、放進候選] @type {Map<string, number[]>} */
    const dg = new Map();
    this.ndiag = dg;
    const dgOf = (/** @type {string} */ k) => { let r = dg.get(k); if (r === undefined) dg.set(k, (r = [0, 0, 0, 0, 0])); return r; };
    /** 全部道具的落點候選；候選上限 16 時，有觸發的先放 @type {{ i: number, j: number, kind: string, tg: number, p: import('./base.js').Pt, v: number, why: string }[]} */
    const all = [];
    items.slice(0, 4).forEach((it, i) => {
      // 佯攻雷（觸發紀錄 fakeUtil）預設不當觸發（P.U.fakeNade；第 6 步修正：r7l 同時機幾乎不丟，新行為沒有證據前收回）
      const keys = hints.filter((h) => h.kind === it.kind && h.purposes.includes(it.pur) && (P.U.fakeNade || h.key !== 'fakeUtil')).map((h) => h.key);
      // 落點先看合不合觸發、再照 f18 由高到低（同分照產生順序：計畫目標在前），試丟不丟得到（閃光最多試 40 個、其他 12 個），取前 3
      /** @type {{ p: import('./base.js').Pt, v: { v: number, enemy: number, raw: number, ng?: number }, o: number, tg: number, why: string }[]} */
      const all18 = [];
      const lp = this.landings(obs, si, it);
      const dr = dgOf(it.kind);
      dr[0]++;
      dr[1] += lp.length;
      // 進點閃以外的閃光（配對、回防、槍線、自由）：隊友在半徑內看得到爆點就不丟（不靠轉開）
      const strict = it.pur !== 'entryFlash' && !keys.includes('entryFlash');
      const pe = si.nade.post;
      const bx = obs.bomb.x;
      const by = obs.bomb.y;
      const lines = keys.includes('lineTime2') ? this.lineSrc(obs, si) : [];
      /**
       * 這個落點合不合觸發（f18t）：進點閃要有情報（P.flashNeedInfo；指揮層的 flashInfo，只讀）；下包後封回防入口是「分給我的那個入口」外側 2 格內；
       * 配對、回防、槍線的閃光是閃人（記得的敵人 3 格內；回防閃也可以閃炸彈）；閃光的落點價值要是正的（r7l 的 gain ≥ ratio × cost 的效用版）
       * @param {import('./base.js').Pt} p @param {{ v: number, enemy: number }} v @returns {string[]} 合的觸發鍵
       */
      const tgOf = (p, v) => {
        if (it.kind === 'flash' && v.v <= 0) return [];
        const onFoe = () => threats.some((k) => k.conf >= 30 && dist(k.x, k.y, p.x, p.y) < 3 * UNIT);
        const onBomb = () => bx !== null && by !== null && dist(bx, by, p.x, p.y) < 3 * UNIT;
        const onEnt = () => CH_SITES.some((s) => this.intel.sites[s].entrances.some((e) => Math.min(dist(e.ox, e.oy, p.x, p.y), dist(e.ix, e.iy, p.x, p.y)) < 3 * UNIT + (it.kind === 'smoke' ? 0 : 0.3 * dist(e.ox, e.oy, e.ix, e.iy))));
        const ok1 = (/** @type {string} */ k) => {
          if (k === 'entryFlash') {
            if (!P.flashNeedInfo) return true;
            const sq = this.siteOf(p);
            return sq >= 0 ? si.nade.info(p, CH_SITES[sq]) : v.enemy > 0;
          }
          if (k === 'postSmoke') return pe !== null && dist(pe.ox, pe.oy, p.x, p.y) < 2 * UNIT;
          if (k === 'pairTime') return onFoe();
          if (k === 'lineTime2') return onFoe() || lines.some((q) => dist(q.x, q.y, p.x, p.y) < 3 * UNIT);
          if (k === 'retakeFlashTime' || k === 'postDefuse') return onFoe() || onBomb();
          // 手雷、下包後燒入口、回防煙（看到的敵人）：落點要有敵方價值
          if (k === 'heTime' || k === 'postBurn' || k === 'retakeSmokeTime2') return v.enemy > 0 || (k === 'postBurn' && onBomb());
          // 守入口的火與煙、回防煙封另一入口：落點在入口（外側或內側）3 格內
          // 守入口的火與煙、回防煙封另一入口：落點在時機指的那個入口（受壓的入口、回防要封的另一入口；指揮層給的）3 格內
          if (k === 'chokeTime' || k === 'holdTime' || k === 'retakeSmokeTime') { const e = N.trig.get(k)?.ent; return e === undefined ? onEnt() : Math.min(dist(e.ox, e.oy, p.x, p.y), dist(e.ix, e.iy, p.x, p.y)) < 3 * UNIT + (it.kind === 'smoke' ? 0 : 0.3 * dist(e.ox, e.oy, e.ix, e.iy)); }
          return true;
        };
        return keys.filter(ok1);
      };
      lp.forEach((p, o) => {
        const v = this.f18(obs, si, threats, it.kind, p, strict);
        if (v === null) return;
        const ks = keys.length === 0 ? [] : tgOf(p, v);
        all18.push({ p, v, o, tg: ks.length > 0 ? 1 : 0, why: ks.join('+') || it.pur });
      });
      // 排序用未封頂的原始值（特徵值 f18 夾在 ±1，很多落點會同分）
      // 閃光的 r7l 固定點（P.U.flashAnchor）：別的落點贏它只靠推定敵位、推定全落空時（ng）比它差，就排到它後面（不能只押推定）
      const anc = it.kind === 'flash' && P.U.flashAnchor && si.nade.anchor !== null ? all18.find((q) => q.o === 0 && dist(q.p.x, q.p.y, si.nade.anchor?.x ?? 0, si.nade.anchor?.y ?? 0) < UNIT) : undefined;
      const key = (/** @type {typeof all18[number]} */ q) => (anc !== undefined && q !== anc && q.tg === anc.tg && (q.v.ng ?? 0) < (anc.v.ng ?? 0) ? Math.min(q.v.raw, anc.v.raw - 1e-6) : q.v.raw);
      all18.sort((x, y) => y.tg - x.tg || key(y) - key(x) || x.o - y.o);
      /** @type {typeof all18} */
      const ok = [];
      let tries = 0;
      for (const q of all18) {
        if (ok.length >= 3 || ++tries > (it.kind === 'flash' ? 40 : 12)) break;
        if (si.nade.solve(q.p.x, q.p.y)) ok.push(q);
      }
      dr[2] += all18.length;
      dr[3] += ok.length;
      ok.forEach((q, j) => all.push({ i, j, kind: it.kind, tg: q.tg, p: q.p, v: q.v.v, why: q.why }));
    });
    all.sort((x, y) => y.tg - x.tg || x.i - y.i || x.j - y.j);
    for (const q of all) {
      const a = add('g', q.p.x, q.p.y, q.i * 4 + q.j);
      if (a === null) break;
      dgOf(q.kind)[4]++;
      a.kind = q.kind;
      a.tg = q.tg;
      a.v18 = q.v;
      a.why = q.why;
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
    const cap = it.kind === 'flash' ? 80 : 40;
    const push = (/** @type {number} */ x, /** @type {number} */ y) => {
      if (pts.length < cap && pts.every((q) => dist(q.x, q.y, x, y) >= 2 * UNIT)) pts.push({ x: Math.round(x), y: Math.round(y) });
    };
    const flash = it.kind === 'flash';
    const smoke = it.kind === 'smoke';
    // r7l 的固定點排第一個（第 6 步修正批二：P.U.flashAnchor）
    const anc = flash && P.U.flashAnchor ? si.nade.anchor : null;
    if (anc !== null) push(anc.x, anc.y);
    const toward = (/** @type {import('./base.js').Pt} */ a, /** @type {import('./base.js').Pt} */ b, /** @type {number} */ cells, /** @type {number} */ top) => {
      const f = Math.min(top, (cells * UNIT) / Math.max(dist(a.x, a.y, b.x, b.y), 1));
      push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
    };
    /** @param {import('./analysis.js').Entrance} e @param {import('./analysis.js').SiteIntel} site @param {number} n */
    const entPts = (e, site, n) => {
      const inner = { x: e.ix, y: e.iy };
      if (flash) {
        push(e.ix, e.iy);
        const hs = site.holds.filter((h) => !this.perc.cleared(h.cell, t) && dist(h.x, h.y, e.ix, e.iy) <= 16 * UNIT).sort((a, b) => dist(a.x, a.y, e.ix, e.iy) - dist(b.x, b.y, e.ix, e.iy) || a.cell - b.cell);
        for (const h of hs.slice(0, n)) for (const k of [4, 8]) toward(inner, h, k, 1);
        // 入口內側 P.flashDeep 格內、包點範圍的格（每 2 格取一個；深位要放進點裡才閃得到；f18 排序後再試丟不丟得到）
        if (n >= 2) {
          const g = this.g;
          const R = P.flashDeep;
          const cx = Math.floor(e.ix / UNIT);
          const cy = Math.floor(e.iy / UNIT);
          for (let y = cy - R; y <= cy + R; y += 2) {
            for (let x = cx - R; x <= cx + R; x += 2) {
              if (x < 0 || y < 0 || x >= g.W || y >= g.H || g.isWall(x, y)) continue;
              const i = y * g.W + x;
              const c = g.center(i);
              const de = dist(c.x, c.y, e.ix, e.iy);
              if (!site.regions.has(this.intel.region[i]) || de > R * UNIT || de < 1.5 * UNIT) continue;
              push(c.x, c.y);
            }
          }
        }
      } else if (smoke) {
        // 封架點（和 tactics.smokeSpots 同一套地圖推導：看得到入口內側的架點，遠的先，往入口內側 smokeOff 格）
        // 記得的敵人（信心 50 以上、看得到入口內側）先：封他
        for (const k of this.perc.known.values()) if (k.conf >= 50 && dist(k.x, k.y, e.ix, e.iy) <= 25 * UNIT && this.g.los(k.x, k.y, e.ix, e.iy)) toward(inner, k, P.smokeOff, 0.6);
        const hs = site.holds.filter((h) => dist(h.x, h.y, e.ix, e.iy) <= 25 * UNIT && this.g.los(h.x, h.y, e.ix, e.iy)).sort((a, b) => dist(b.x, b.y, e.ix, e.iy) - dist(a.x, a.y, e.ix, e.iy) || a.cell - b.cell);
        for (const h of hs.slice(0, n >= 2 ? hs.length : n)) toward(inner, h, P.smokeOff, 0.6);
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
      const pe = si.nade.ent;
      const e = smoke && pe !== null && site.entrances.includes(pe) ? pe : tgt.ent >= 0 ? site.entrances[tgt.ent] : undefined;
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
    const th = this.perc.threats(me.x, me.y, 30).filter((q) => dist(me.x, me.y, q.x, q.y) < 25 * UNIT).slice(0, 3);
    // 槍線：隊友陣亡處看得到的敵人（沒有就是陣亡處）、記得的狙擊位；閃光閃它，煙從「再走 3 格」的位置往它封 6 格
    for (const q of this.lineSrc(obs, si)) {
      if (it.kind === 'flash') push(q.x, q.y);
      else if (smoke) toward(si.soon ?? me, q, 6, 0.6);
    }
    const pe = si.nade.post;
    if (smoke && pe !== null) push(pe.ox, pe.oy);
    if (it.kind === 'he') {
      // 手雷：記得兩個以上的敵人聚在一起（最近 1 秒看到、幾乎沒在動、離我 6 格以上）
      const list = [...this.perc.known.values()].filter((k) => k.conf >= 70 && t - k.tick <= this.tps && Math.abs(k.vx) + Math.abs(k.vy) < 40);
      for (const a of list) {
        const near = list.filter((k) => dist(k.x, k.y, a.x, a.y) < P.nadeCluster * UNIT);
        const x = near.reduce((q, k) => q + k.x, 0) / near.length;
        const y = near.reduce((q, k) => q + k.y, 0) / near.length;
        if (near.length >= 2 && dist(me.x, me.y, x, y) >= 6 * UNIT) push(x, y);
      }
    }
    if (smoke) {
      for (const f of obs.effects) if (f.kind === 'fire' && dist(me.x, me.y, f.x, f.y) < 20 * UNIT) push(f.x, f.y);
      // 槍線：從「照路徑再走 3 格」的位置往威脅 6 格（停下來等槍線時封的那條線），再加從現在位置
      const so = si.soon ?? me;
      for (const q of th) {
        toward(so, q, 6, 0.6);
        if (so !== me) toward(me, q, 6, 0.6);
      }
    }
    const bx = obs.bomb.x;
    const by = obs.bomb.y;
    if (!smoke && (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing') && bx !== null && by !== null) push(bx, by);
    if (!smoke) for (const q of th) push(q.x, q.y);
    // 執行中：這組走的入口照計畫道具的落點全套算（自由的閃光、煙也可能是這次進點用的）
    const pe0 = si.nade.ent;
    if (pe0 !== null && !it.kind.startsWith('he')) for (const k of CH_SITES) if (this.intel.sites[k].entrances.includes(pe0)) entPts(pe0, this.intel.sites[k], 3);
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
   * strict：隊友在半徑內看得到爆點就排除（進點閃以外）；已有隊友的閃光（認領、剛炸、飛行中）8 格內排除；T 下包後的煙不罩包（5 格內）
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si @param {import('./memory.js').Threat[]} threats @param {string} kind @param {import('./base.js').Pt} p
   * @param {boolean} strict
   * @returns {{ v: number, enemy: number, raw: number, ng?: number } | null} ng：閃光不算推定敵位（架點、深位、聲音）的值，推定全落空時的價值
   */
  f18(obs, si, threats, kind, p, strict) {
    const me = obs.me;
    const g = this.g;
    const mates = obs.teammates.filter((m) => m.alive && m.id !== me.id);
    const th = threats.filter((q) => q.conf >= 30);
    if (kind === 'flash') {
      if (si.nade.taken(p)) return null;
      const R = si.nade.flashR;
      const side = this.data.rules.grenadeRules.flashSideDeg;
      // 視線被我方的煙擋住（3 格內；引擎規則閃光會被煙擋，和指揮層 flashPoint 同判定）的人閃不到
      const smoked = (/** @type {import('./base.js').Pt} */ q) => si.nade.smokes.some((m) => segDist(m.x, m.y, q.x, q.y, p.x, p.y).d < 3 * UNIT);
      let enemy = 0;
      for (const q of th) {
        const d = dist(q.x, q.y, p.x, p.y);
        if (d >= R || !g.los(q.x, q.y, p.x, p.y) || smoked(q)) continue;
        const k = q.id >= 0 ? this.perc.known.get(q.id) : undefined;
        const face = k !== undefined && k.src === 'see' && Math.abs(adiff(angleTo(k.x, k.y, p.x, p.y), k.facing)) > side ? 0.15 : 1;
        enemy += (1 - d / (2 * R)) * face * (q.conf / 100);
      }
      // 推定的敵人（設計第八節：一律算正面）：敵方守著的包點裡還沒清過的架點，每個 0.5（只算價值，不算情報）
      let guess = 0;
      const planted = obs.bomb.state === 'planted' || obs.bomb.state === 'defusing';
      const s = this.siteOf(p);
      if (s >= 0 && (me.team === 'T') !== planted) {
        for (const h of [...this.intel.sites[CH_SITES[s]].holds, ...si.nade.deep(CH_SITES[s])]) {
          const d = dist(h.x, h.y, p.x, p.y);
          if (d < R && !this.perc.cleared(g.cellOf(h.x, h.y), obs.tick) && g.los(h.x, h.y, p.x, p.y) && !smoked(h)) guess += 0.5 * (1 - d / (2 * R));
        }
      }
      // 聽到的敵方聲音：扇形上離爆點一樣遠的那一點（推定的敵人，只算價值）
      for (const sc of this.perc.sectors) {
        if (sc.conf < 25 || sc.kind === 'hurt') continue;
        const r = clamp(dist(sc.ox, sc.oy, p.x, p.y) / UNIT, sc.r0, sc.r1) * UNIT;
        const q = { x: sc.ox + cosd(sc.dir) * r, y: sc.oy + sind(sc.dir) * r };
        const d = dist(q.x, q.y, p.x, p.y);
        if (d < R && g.los(q.x, q.y, p.x, p.y) && !smoked(q)) guess += 0.5 * (1 - d / (2 * R));
      }
      let cost = 0;
      for (const m of mates) {
        const pos = [{ x: m.x, y: m.y }, this.predict(m)];
        if (pos.some((q) => dist(q.x, q.y, p.x, p.y) < 3 * UNIT)) return null;
        const faces = Math.abs(adiff(angleTo(m.x, m.y, p.x, p.y), m.facing)) <= side;
        const near = dist(m.x, m.y, p.x, p.y) < R && g.los(m.x, m.y, p.x, p.y);
        if (near && strict) return null;
        // r7l 第一輪：面向爆點或交火中、4 步內躲不掉就排除（第二輪只看交火中：影子模式只記第一輪，全部排除時 landings 會換下一個點）
        if (near && (si.nade.fighting(m.id) || faces) && !si.nade.canHide(m.x, m.y, p)) return null;
        let worst = 0;
        for (const q of pos) {
          const d = dist(q.x, q.y, p.x, p.y);
          if (d < R && g.los(q.x, q.y, p.x, p.y)) worst = Math.max(worst, (faces ? 1 : 0.15) * (1 - d / R));
        }
        cost += worst;
      }
      return { v: Math.max(-1, Math.min(1, enemy + Math.min(1, guess) - cost)), enemy, raw: enemy + guess - cost, ng: enemy - cost };
    }
    if (kind === 'smoke') {
      // 我方的煙 smokeGap 格內不再丟（和 r7l 同規則）
      if (si.nade.smokes.some((m) => dist(m.x, m.y, p.x, p.y) < P.smokeGap * UNIT)) return null;
      const sx = obs.bomb.x;
      const sy = obs.bomb.y;
      if (me.team === 'T' && sx !== null && sy !== null && (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing') && dist(sx, sy, p.x, p.y) < 5 * UNIT) return null;
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
      return { v: Math.min(1, lines / 2 + fire + block), enemy: lines, raw: lines / 2 + fire + block };
    }
    if (mates.some((m) => dist(m.x, m.y, p.x, p.y) < 4 * UNIT)) return null;
    // 火：還在燒的我方火 4 格內不再丟
    if (kind !== 'he' && si.nade.burns.some((b) => b.until > obs.tick && dist(b.x, b.y, p.x, p.y) < 4 * UNIT)) return null;
    const r = kind === 'he' ? 3.5 * UNIT : 3 * UNIT;
    let enemy = 0;
    for (const q of th) if (dist(q.x, q.y, p.x, p.y) < r + UNIT) enemy += q.conf / 100;
    const bx = obs.bomb.x;
    const by = obs.bomb.y;
    const bomb = me.team === 'T' && (obs.bomb.state === 'planted' || obs.bomb.state === 'defusing') && bx !== null && by !== null && dist(bx, by, p.x, p.y) < r ? (obs.bomb.state === 'defusing' ? 1 : 0.5) : 0;
    return { v: Math.min(1, enemy + bomb), enemy, raw: enemy + bomb };
  }

  /**
   * 槍線的來源（和指揮層 gunLine 同一套資訊）：P.lineMemo 秒內的隊友陣亡處，有記得的敵人看得到那裡就是那個敵人，沒有就是陣亡處；P.awpMemo 秒內記得的敵方狙擊位
   * @param {import('./base.js').Observation} obs @param {ShadowIn} si @returns {import('./base.js').Pt[]}
   */
  lineSrc(obs, si) {
    const g = this.g;
    const t = obs.tick;
    /** @type {import('./base.js').Pt[]} */
    const out = [];
    for (const a of this.perc.anon) {
      if (a.src !== 'death' || t - a.tick >= P.lineMemo * this.tps) continue;
      const th = this.perc.threats(a.x, a.y, 30).find((q) => dist(q.x, q.y, a.x, a.y) < 30 * UNIT && g.los(q.x, q.y, a.x, a.y));
      out.push(th ?? a);
    }
    const w = si.nade.awp;
    if (w !== null && t - w.tick < P.awpMemo * this.tps && dist(obs.me.x, obs.me.y, w.x, w.y) < 45 * UNIT) out.push(w);
    return out;
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
