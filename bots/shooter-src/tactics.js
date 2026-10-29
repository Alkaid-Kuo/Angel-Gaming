// @ts-check
// 戰術層（回合開始＋每次決策檢查事件）：隊內計畫、經濟、道具、輪轉、回防、殘局。
// 協調只靠 say：活著的最小 playerId 當指揮，凍結時間廣播計畫，計畫有變（執行、輪轉、回防）就重喊；指揮死了下一個接手重喊。
// 計畫格式（parsePlan／planText）：
//   T  「P:go A 0」（直接去，6-1 格式）「P:rushA 0」（五人一條路、不探頭、閃先行）
//      「P:splitA 0 2[ go]」（兩組兩條路線到待命點，第二組到了才喊 go）
//      「P:default A 0 1[ >B]」（主力 3 人到 A 路線 0 的待命點、2 人到 B 路線 1 控圖；>B 表示執行 B）
//      「P:fake B 0 1[ >B]」（主力去 B、佯攻組去 A 製造聲音後主力執行）
//   CT 「P:hold A=2 M=1 B=2[ rot=B][ go]」（開局配置；rot＝輪轉到哪個點；go＝回防集結完畢一起進）
// 事件（感知輸出產生，隊友據此更新）：「E:contact <區域> <人數>」「E:dead <區域>」「E:planted <點>」「E:flash x y tick」「E:smoke x y」「E:kit」。
// 經濟「B:full／force／half／eco」見 economy.js；道具的彈道見 utility.js。全部由地圖資料與觀察資料算，不寫死座標或區域代號。
import { P, UNIT, adiff, angleTo, clamp, cosd, dist, inRect, lerp, segDist, sind } from './base.js';
import { Economy, parseBuy } from './economy.js';
import { Utility } from './utility.js';

/** @typedef {'A' | 'B'} SiteId */
/** T 計畫：site 主力的點、r1／r2 兩組的路線序號、exec 執行哪個點（null = 還在佈置） @typedef {{ kind: 'go' | 'default' | 'rush' | 'split' | 'fake', site: SiteId, r1: number, r2: number, exec: SiteId | null }} TPlan */
/** CT 計畫：A／中路／B 人數、輪轉目標、回防開始 @typedef {{ kind: 'hold', a: number, m: number, b: number, rot: SiteId | null, go: boolean }} CTPlan */
/** @typedef {TPlan | CTPlan} Plan */
/** @typedef {{ kind: 'contact', region: string, n: number } | { kind: 'dead', region: string } | { kind: 'planted', site: SiteId } | { kind: 'flash', x: number, y: number, pop: number } | { kind: 'smoke', x: number, y: number } | { kind: 'kit' }} TeamEvent */
/**
 * 戰術輸出：goal 目標點、route 偏好路線、hold 守位（到了要看哪裡）、objective 正在下包／拆包、allowPeek 可以探頭、cmds 購買／喊話／丟雷／下包／拆包；
 * look 沒交戰時看哪裡（urgent：躲閃光，連「目標剛消失的架槍」也蓋過）、stop 站住、walk 靜步（null = 導航決定）、noise 佯攻開槍
 * @typedef {{ goal: import('./base.js').Pt | null, route: import('./analysis.js').Route | null, hold: import('./analysis.js').Spot | null, objective: boolean, allowPeek: boolean, cmds: import('./base.js').Command[], role: string, look: import('./base.js').Pt | null, urgent: boolean, stop: boolean, walk: boolean | null, noise: boolean }} TacOut
 */

const SITES = /** @type {const} */ (['A', 'B']);
/** @param {SiteId} s @returns {SiteId} */
const other = (s) => (s === 'A' ? 'B' : 'A');

/** 解析計畫字串 @param {string} text @returns {Plan | null} */
export function parsePlan(text) {
  let m = /^P:go ([AB]) (\d+)$/.exec(text);
  if (m !== null) {
    const site = /** @type {SiteId} */ (m[1]);
    return { kind: 'go', site, r1: Number(m[2]), r2: Number(m[2]), exec: site };
  }
  m = /^P:(rush|split)([AB]) (\d+)(?: (\d+))?( go)?$/.exec(text);
  if (m !== null) {
    const site = /** @type {SiteId} */ (m[2]);
    const kind = /** @type {'rush' | 'split'} */ (m[1]);
    const r1 = Number(m[3]);
    return { kind, site, r1, r2: m[4] !== undefined ? Number(m[4]) : r1, exec: kind === 'rush' || m[5] !== undefined ? site : null };
  }
  m = /^P:(default|fake) ([AB]) (\d+) (\d+)(?: >([AB]))?$/.exec(text);
  if (m !== null) return { kind: /** @type {'default' | 'fake'} */ (m[1]), site: /** @type {SiteId} */ (m[2]), r1: Number(m[3]), r2: Number(m[4]), exec: m[5] !== undefined ? /** @type {SiteId} */ (m[5]) : null };
  m = /^P:hold A=(\d) (?:M=(\d) )?B=(\d)(?: rot=([AB]))?( go)?$/.exec(text);
  if (m !== null) return { kind: 'hold', a: Number(m[1]), m: m[2] !== undefined ? Number(m[2]) : 0, b: Number(m[3]), rot: m[4] !== undefined ? /** @type {SiteId} */ (m[4]) : null, go: m[5] !== undefined };
  return null;
}

/** @param {Plan} p */
export function planText(p) {
  switch (p.kind) {
    case 'go':
      return `P:go ${p.site} ${p.r1}`;
    case 'rush':
      return `P:rush${p.site} ${p.r1}`;
    case 'split':
      return `P:split${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ' go' : ''}`;
    case 'default':
    case 'fake':
      return `P:${p.kind} ${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ` >${p.exec}` : ''}`;
    default:
      return `P:hold A=${p.a}${p.m > 0 ? ` M=${p.m}` : ''} B=${p.b}${p.rot !== null ? ` rot=${p.rot}` : ''}${p.go ? ' go' : ''}`;
  }
}

/** 解析事件 @param {string} text @returns {TeamEvent | null} */
export function parseEvent(text) {
  let m = /^E:contact (\S+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'contact', region: m[1], n: Number(m[2]) };
  m = /^E:dead (\S+)$/.exec(text);
  if (m !== null) return { kind: 'dead', region: m[1] };
  m = /^E:planted ([AB])$/.exec(text);
  if (m !== null) return { kind: 'planted', site: /** @type {SiteId} */ (m[1]) };
  m = /^E:flash (\d+) (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'flash', x: Number(m[1]) * 100, y: Number(m[2]) * 100, pop: Number(m[3]) };
  m = /^E:smoke (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'smoke', x: Number(m[1]) * 100, y: Number(m[2]) * 100 };
  if (text === 'E:kit') return { kind: 'kit' };
  return null;
}

export class Tactics {
  /**
   * @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./memory.js').Perception} perc
   * @param {import('./base.js').InitData} data @param {import('./base.js').Helpers} h
   * @param {{ awpSlot: number, economy: number, ctSplitA: number, plan: number }} opts
   * @param {{ aim: number, reaction: number, awareness: number, aggression: number, discipline: number, movement: number }} attrs
   */
  constructor(g, intel, perc, data, h, opts, attrs) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.data = data;
    this.h = h;
    this.opts = opts;
    this.attrs = attrs;
    this.tps = data.rules.ticksPerSecond;
    this.econ = new Economy(data, h, { awpSlot: opts.awpSlot, economy: opts.economy, discipline: attrs.discipline });
    this.util = new Utility(g, data);
    /** 全隊 id（排序）：隊內序號 = 名次 */
    this.ids = [data.playerId, ...data.teammateIds].sort((a, b) => a - b);
    this.eventDelay = Math.round(lerp(P.eventDelay0, P.eventDelay100, attrs.awareness)) * data.rules.decisionInterval;
    /** 地圖算出來的位置（第一次用到才算） @type {Map<string, import('./analysis.js').Spot[]>} */
    this.spotCache = new Map();
    /** 戰鬥層（估計對手血量用）與導航層（躲閃光用）；由入口接上 @type {import('./combat.js').Combat | null} */
    this.combat = null;
    /** @type {import('./nav.js').Navigator | null} */
    this.nav = null;
    /** 躲閃光的格（對應哪一顆閃光） @type {import('./base.js').Pt | null} */
    this.hide = null;
    this.hideFor = -1;
    // ── 整場的記憶 ──
    /** 當 CT 時對方打哪個點（最近 6 回合） @type {SiteId[]} */
    this.hits = [];
    /** 當 T 時每個點最近的結果（+1 勝、−1 敗） */
    this.siteScore = { A: 0, B: 0 };
    /** 計畫使用統計（給評測）：種類 → [回合, 勝] @type {Record<string, [number, number]>} */
    this.planStats = {};
    this.lastKind = '';
    this.lastSite = /** @type {SiteId | null} */ (null);
    this.lastAttack = /** @type {SiteId | null} */ (null);
    /** 狙擊位（第一次用到才算） @type {{ spot: import('./analysis.js').Spot, site: SiteId, len: number } | null | undefined} */
    this.sniper = undefined;
    /** @type {Plan | null} */
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.saidText = '';
    this.bought = false;
    /** @type {import('./economy.js').BuyCall | null} */
    this.buyCall = null;
    this.routeOverride = -1;
    /** 收到但還沒處理的喊話（警覺低的晚一點反應） @type {{ ready: number, from: number, text: string }[]} */
    this.inbox = [];
    /** 收到的接觸：區域 → 人數與時間；接觸 → 所屬包點 @type {Map<string, { n: number, tick: number }>} */
    this.contacts = new Map();
    /** @type {Map<string, SiteId | null>} */
    this.contactSite = new Map();
    /** 自己喊過的接觸 @type {Map<string, { n: number, tick: number }>} */
    this.saidContact = new Map();
    /** 分組（T）：id → 0 主力／1 第二組 @type {Map<number, number> | null} */
    this.groups = null;
    this.groupKey = '';
    this.execTick = -1;
    this.stageArrive = -1;
    this.noiseLeft = 0;
    /** 隊友的閃光：躲或轉身到爆完 @type {{ x: number, y: number, pop: number }[]} */
    this.mateFlash = [];
    this.flashHeard = -1;
    this.smokeHeard = -1;
    /** 有拆彈器的隊友 @type {Set<number>} */
    this.kits = new Set();
    this.kitSaid = false;
    /** 換血：朝隊友陣亡的方向架槍 @type {{ x: number, y: number, until: number } | null} */
    this.trade = null;
    /** 追殘血 @type {{ x: number, y: number, until: number } | null} */
    this.chase = null;
    /** 對每個敵人打出的傷害 @type {Map<number, number>} */
    this.dealt = new Map();
    /** @type {Map<number, boolean>} */
    this.mateAlive = new Map();
    /** 隊友最近一次開火的 tick @type {Map<number, number>} */
    this.mateFired = new Map();
    this.liveStart = -1;
    this.plantedSaid = false;
    this.saving = false;
    /** 狙擊手（開打時手上拿狙擊槍的人）；開打後固定 */
    this.awper = -1;
    this.awperFixed = false;
    /** @type {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }> | null} */
    this.layout = null;
    this.layoutKey = '';
    /** @type {import('./base.js').Pt | null} */
    this.saveCache = null;
  }

  /** 新回合（obs 為 null 時只清狀態） @param {import('./base.js').Observation | null} obs */
  reset(obs) {
    if (obs !== null) {
      this.econ.roundStart(obs);
      // 上回合的結果記進整場記憶
      const won = this.econ.lastWon;
      if (won !== null && this.lastKind !== '') {
        const st = this.planStats[this.lastKind] ?? [0, 0];
        this.planStats[this.lastKind] = st;
        st[0]++;
        if (won) st[1]++;
        if (this.lastSite !== null) this.siteScore[this.lastSite] = clamp(this.siteScore[this.lastSite] + (won ? 1 : -1), -2, 2);
      }
      if (this.lastAttack !== null) {
        this.hits.push(this.lastAttack);
        if (this.hits.length > 6) this.hits.shift();
      }
    }
    this.lastKind = '';
    this.lastSite = null;
    this.lastAttack = null;
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.saidText = '';
    this.bought = false;
    this.buyCall = null;
    this.routeOverride = -1;
    this.inbox = [];
    this.contacts = new Map();
    this.contactSite = new Map();
    this.saidContact = new Map();
    this.groups = null;
    this.groupKey = '';
    this.execTick = -1;
    this.stageArrive = -1;
    this.noiseLeft = 0;
    this.mateFlash = [];
    this.flashHeard = -1;
    this.smokeHeard = -1;
    this.kits = new Set();
    this.kitSaid = false;
    this.trade = null;
    this.chase = null;
    this.dealt = new Map();
    this.mateAlive = new Map();
    this.mateFired = new Map();
    this.liveStart = -1;
    this.plantedSaid = false;
    this.saving = false;
    this.awper = -1;
    this.awperFixed = false;
    this.layout = null;
    this.layoutKey = '';
    this.saveCache = null;
    this.util.reset();
  }

  /** 活著的最小 playerId（含自己） @param {import('./base.js').Observation} obs */
  commanderOf(obs) {
    let c = obs.me.alive ? obs.me.id : Infinity;
    for (const m of obs.teammates) if (m.alive && m.id < c) c = m.id;
    return Number.isFinite(c) ? c : -1;
  }

  /** 隊內序號 @param {number} id */
  slotOf(id) {
    return this.ids.indexOf(id);
  }

  /** 活著的隊員（含自己）：{ id, x, y } @param {import('./base.js').Observation} obs */
  alive(obs) {
    const me = obs.me;
    const out = obs.teammates.filter((m) => m.alive).map((m) => ({ id: m.id, x: m.x, y: m.y }));
    if (me.alive) out.push({ id: me.id, x: me.x, y: me.y });
    return out.sort((a, b) => a.id - b.id);
  }

  /** 區域代號 → 該區域中心格 @param {string} id */
  regionCell(id) {
    const r = this.intel.map.regions.find((x) => x.id === id);
    if (r === undefined) return -1;
    return this.intel.nearestOpen(Math.floor((r.x0 + r.x1) / 2), Math.floor((r.y0 + r.y1) / 2));
  }

  /** 格屬於哪個包點附近（路徑 ≤ 25 格且比另一點近 5 格以上）；都不是回傳 null @param {number} c @returns {SiteId | null} */
  siteNear(c) {
    if (c < 0) return null;
    const a = this.intel.distSite.A[c] / 10;
    const b = this.intel.distSite.B[c] / 10;
    if (a <= 25 && a < b - 5) return 'A';
    if (b <= 25 && b < a - 5) return 'B';
    return null;
  }

  // ───────── 每次決策 ─────────

  /**
   * @param {import('./base.js').Observation} obs
   * @returns {TacOut}
   */
  update(obs) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {TacOut} */
    const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '', look: null, urgent: false, stop: false, walk: null, noise: false };
    if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
    this.trackTeam(obs, out);
    this.readChat(obs);
    const cmd = this.commanderOf(obs);
    this.commander = cmd;
    if (cmd === me.id) this.lead(obs, out);
    else if (this.plan === null && obs.round.phase !== 'freeze' && t - this.liveStart > this.tps) this.plan = this.choosePlan(obs);
    this.buy(obs, out, cmd === me.id);
    this.report(obs, out);
    const live = obs.round.phase === 'live';
    out.allowPeek = live && obs.round.phaseTicksLeft > 25 * this.tps;
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = null;
    if (me.team === 'T') wish = this.tGoal(obs, out);
    else wish = this.ctGoal(obs, out);
    if (wish === null) wish = this.anyNade(obs);
    this.overlay(obs, out);
    /** @type {Set<number>} */
    const busy = new Set();
    for (const [id, tk] of this.mateFired) if (t - tk < 1.5 * this.tps) busy.add(id);
    const u = this.util.step(obs, wish, busy);
    out.cmds.push(...u.cmds);
    if (u.look !== null) {
      out.look = u.look;
      if (this.util.away !== null) out.urgent = true;
    }
    if (u.stop) out.stop = true;
    if (this.plan !== null) {
      this.lastKind = this.plan.kind === 'hold' ? '' : this.plan.kind;
      if (this.plan.kind !== 'hold') this.lastSite = this.plan.exec ?? this.plan.site;
    }
    return out;
  }

  /**
   * 隊友狀態：陣亡（換血、指揮喊 E:dead）、對敵人打出的傷害
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  trackTeam(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const tid = this.combat?.targetId ?? -1;
    for (const s of me.shots) if (s.hit === 'enemy' && tid >= 0) this.dealt.set(tid, (this.dealt.get(tid) ?? 0) + s.damage);
    for (const m of obs.teammates) {
      if (m.firing) this.mateFired.set(m.id, t);
      if (this.mateAlive.get(m.id) === true && !m.alive) {
        // 換血：隊友在附近陣亡，朝他面對的方向架槍
        if (me.alive && dist(m.x, m.y, me.x, me.y) <= P.tradeRange * UNIT) this.trade = { x: m.x + cosd(m.facing) * 10 * UNIT, y: m.y + sind(m.facing) * 10 * UNIT, until: t + Math.round(P.tradeHold * this.tps) };
        if (this.commanderOf(obs) === me.id) {
          const r = this.intel.region[this.g.cellOf(m.x, m.y)];
          if (r >= 0) out.cmds.push({ type: 'say', text: `E:dead ${this.intel.map.regions[r].id}` });
        }
        // 隊友在某點附近陣亡：當作那裡有接觸（CT 輪轉用）
        const near = this.siteNear(this.g.cellOf(m.x, m.y));
        if (near !== null) this.noteContact(`#dead${m.id}`, 1, t, near);
      }
      this.mateAlive.set(m.id, m.alive);
    }
  }

  /** @param {string} key @param {number} n @param {number} t @param {SiteId | null} site */
  noteContact(key, n, t, site) {
    this.contacts.set(key, { n, tick: t });
    this.contactSite.set(key, site);
  }

  /** 收喊話：計畫、買法、事件（事件延遲 eventDelay 才處理） @param {import('./base.js').Observation} obs */
  readChat(obs) {
    const me = obs.me;
    const t = obs.tick;
    for (const c of obs.chat) {
      if (c.from === me.id) continue;
      // 第一個計畫與買法立刻處理（凍結時間）；之後的變更與事件依警覺延遲
      const first = this.plan === null && c.text.startsWith('P:');
      this.inbox.push({ ready: first || c.text.startsWith('B:') ? t : t + this.eventDelay, from: c.from, text: c.text });
    }
    const keep = [];
    for (const msg of this.inbox) {
      if (msg.ready > t) {
        keep.push(msg);
        continue;
      }
      const text = msg.text;
      const p = parsePlan(text);
      if (p !== null) {
        // 只接受 id 比自己小的人（指揮或剛陣亡的指揮）的計畫；陣營要對
        if (msg.from < me.id && (p.kind === 'hold') === (me.team === 'CT')) this.setPlan(p, obs);
        continue;
      }
      const b = parseBuy(text);
      if (b !== null) {
        if (msg.from < me.id) this.buyCall = b;
        continue;
      }
      const e = parseEvent(text);
      if (e === null) continue;
      if (e.kind === 'contact') {
        const c = this.regionCell(e.region);
        this.noteContact(e.region, e.n, t, this.siteNear(c));
      } else if (e.kind === 'flash') this.mateFlash.push({ x: e.x, y: e.y, pop: e.pop });
      else if (e.kind === 'smoke') this.smokeHeard = t;
      else if (e.kind === 'kit') this.kits.add(msg.from);
      if (e.kind === 'flash') this.flashHeard = t;
    }
    this.inbox = keep;
  }

  /** @param {Plan} p @param {import('./base.js').Observation} obs */
  setPlan(p, obs) {
    const prev = this.plan;
    this.plan = p;
    if (p.kind !== 'hold' && p.exec !== null && (prev === null || prev.kind === 'hold' || prev.exec === null)) this.execTick = obs.tick;
  }

  // ───────── 指揮 ─────────

  /** 指揮：決定、更新、廣播計畫 @param {import('./base.js').Observation} obs @param {TacOut} out */
  lead(obs, out) {
    if (this.plan === null) this.setPlan(this.choosePlan(obs), obs);
    const p = /** @type {Plan} */ (this.plan);
    const next = p.kind === 'hold' ? this.leadCT(obs, p) : this.leadT(obs, p);
    if (next !== p) this.setPlan(next, obs);
    const text = planText(/** @type {Plan} */ (this.plan));
    if (this.saidAs !== obs.me.id || this.saidText !== text) {
      out.cmds.push({ type: 'say', text });
      this.saidAs = obs.me.id;
      this.saidText = text;
    }
    const b = obs.bomb;
    if (!this.plantedSaid && b.state === 'planted' && b.site !== null) {
      this.plantedSaid = true;
      out.cmds.push({ type: 'say', text: `E:planted ${b.site}` });
    }
  }

  /** @param {import('./base.js').Observation} obs @returns {Plan} */
  choosePlan(obs) {
    if (obs.me.team === 'CT') return this.chooseCT();
    return this.chooseT(obs);
  }

  /**
   * T：eco 多半 rush；否則依侵略與上回合結果抽 default／split／rush／fake；點依兩點最近的成敗加權
   * @param {import('./base.js').Observation} obs @returns {TPlan}
   */
  chooseT(obs) {
    const h = this.h;
    const ag = this.attrs.aggression;
    const call = this.buyCall ?? this.econ.teamCall(obs);
    const wA = Math.max(0.2, 1 + 0.35 * this.siteScore.A);
    const wB = Math.max(0.2, 1 + 0.35 * this.siteScore.B);
    /** @type {SiteId} */
    const site = h.random() * (wA + wB) < wA ? 'A' : 'B';
    const forced = ['', 'default', 'rush', 'split', 'fake'][this.opts.plan] ?? '';
    let kind = forced;
    if (kind === '') {
      const w = call === 'eco' ? { default: 0.25, rush: 0.6, split: 0.15, fake: 0 } : { default: 0.32, rush: 0.12 + 0.2 * ag, split: 0.3, fake: 0.18 };
      let r = h.random() * (w.default + w.rush + w.split + w.fake);
      kind = 'fake';
      for (const k of /** @type {const} */ (['default', 'rush', 'split'])) {
        if ((r -= w[k]) < 0) {
          kind = k;
          break;
        }
      }
    }
    const routes = this.intel.routes.T[site];
    const n = Math.max(1, routes.length);
    if (kind === 'rush') return { kind: 'rush', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: 0, exec: site };
    if (kind === 'split') {
      const r1 = 0;
      let r2 = 0;
      let best = Infinity;
      for (let i = 1; i < routes.length; i++) {
        let same = 0;
        for (const r of routes[i].regionSet) if (routes[r1].regionSet.has(r)) same++;
        const j = same / (routes[i].regionSet.size + routes[r1].regionSet.size - same);
        if (j < best) {
          best = j;
          r2 = i;
        }
      }
      return { kind: 'split', site, r1, r2, exec: null };
    }
    const nOther = Math.max(1, this.intel.routes.T[other(site)].length);
    if (kind === 'fake') return { kind: 'fake', site, r1: 0, r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
    return { kind: 'default', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
  }

  /** CT：預設 A=旋鈕／中路／B=P.ctB；對方最近常打同一點就多放一人，一直打同一點就疊 4 人（另一點只留錨點） @returns {CTPlan} */
  chooseCT() {
    let a = clamp(this.opts.ctSplitA, 0, 5);
    let b = Math.min(P.ctB, 5 - a);
    let m = 5 - a - b;
    const recent = this.hits.slice(-4);
    const nA = recent.filter((s) => s === 'A').length;
    const nB = recent.length - nA;
    if (recent.length >= 3 && Math.abs(nA - nB) >= 3) {
      a = nA > nB ? 4 : 1;
      b = 5 - a;
      m = 0;
    } else if (recent.length >= 3 && m > 0) {
      if (nA - nB >= 2) {
        a++;
        m--;
      } else if (nB - nA >= 2) {
        b++;
        m--;
      }
    }
    return { kind: 'hold', a, m, b, rot: null, go: false };
  }

  /**
   * T 指揮：佈置完成或時間到就執行；剩 P.forceExecLeft 秒強行執行最近的點
   * @param {import('./base.js').Observation} obs @param {TPlan} p @returns {TPlan}
   */
  leadT(obs, p) {
    if (obs.round.phase !== 'live' || p.exec !== null) return p;
    const t = obs.tick;
    const el = (t - this.liveStart) / this.tps;
    const left = obs.round.phaseTicksLeft / this.tps;
    if (left <= P.forceExecLeft) return { ...p, exec: this.nearestSite(obs) };
    if (p.kind === 'split') {
      const ready = this.alive(obs).every((m) => {
        const s = this.memberStage(obs, m.id, p);
        return s === null || dist(m.x, m.y, s.x, s.y) < 3 * UNIT;
      });
      if (ready || el >= P.splitWait) return { ...p, exec: p.site };
    }
    if (p.kind === 'fake') {
      const fakers = this.alive(obs).filter((m) => this.groupOf(obs, m.id, p) === 1);
      const there = fakers.some((m) => {
        const s = this.memberStage(obs, m.id, p);
        return s !== null && dist(m.x, m.y, s.x, s.y) < 4 * UNIT;
      });
      if (there && this.stageArrive < 0) this.stageArrive = t;
      if ((this.stageArrive >= 0 && t - this.stageArrive >= P.fakeDelay * this.tps) || el >= P.splitWait + 6) return { ...p, exec: p.site };
    }
    if (p.kind === 'default') {
      const at = lerp(P.defaultExec0, P.defaultExec100, this.attrs.aggression);
      const heat = this.heat(obs);
      // 情報：一點確認 ≥ 2 人、另一點沒有 → 提早打另一點
      const early = el >= at * 0.5 && Math.abs(heat.A - heat.B) >= 2;
      if (el >= at || early) return { ...p, exec: heat.A < heat.B ? 'A' : heat.B < heat.A ? 'B' : p.site };
    }
    return p;
  }

  /** 離持彈者（或自己）最近的點 @param {import('./base.js').Observation} obs @returns {SiteId} */
  nearestSite(obs) {
    const c = obs.teammates.find((m) => m.alive && m.hasBomb) ?? obs.me;
    const cell = this.g.cellOf(c.x, c.y);
    if (cell < 0) return 'A';
    return this.intel.distSite.A[cell] <= this.intel.distSite.B[cell] ? 'A' : 'B';
  }

  /**
   * 兩個包點附近估計的敵人數：自己記得的敵人、收到的接觸（同一區域取最新）、隊友陣亡
   * @param {import('./base.js').Observation} obs
   */
  heat(obs) {
    const t = obs.tick;
    const out = { A: 0, B: 0 };
    const seen = { A: 0, B: 0 };
    for (const k of this.perc.known.values()) {
      if (k.conf < 50) continue;
      const s = this.siteNear(this.g.cellOf(k.x, k.y));
      if (s !== null) seen[s]++;
    }
    const heard = { A: 0, B: 0 };
    for (const [key, c] of this.contacts) {
      if (t - c.tick > P.contactTtl * this.tps) {
        this.contacts.delete(key);
        continue;
      }
      const s = this.contactSite.get(key) ?? null;
      if (s !== null) heard[s] += c.n;
    }
    for (const s of SITES) out[s] = Math.max(seen[s], heard[s]);
    return out;
  }

  /**
   * CT 指揮：某點估計 ≥ P.rotateHeat 人就輪轉；炸彈下了輪轉到炸彈的點，集結完畢（或時間不多）喊 go
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @returns {CTPlan}
   */
  leadCT(obs, p) {
    if (obs.round.phase === 'freeze') return p;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.site !== null) {
      if (p.rot !== b.site) return { ...p, rot: b.site, go: false };
      if (!p.go && this.retakeReady(obs, b.site)) return { ...p, go: true };
      return p;
    }
    if (p.rot === null) {
      const heat = this.heat(obs);
      for (const s of SITES) if (heat[s] >= P.rotateHeat && heat[s] > heat[other(s)]) return { ...p, rot: s };
    }
    return p;
  }

  /** 回防集結完畢：點外的人都到了待命點；或時間只夠現在進 @param {import('./base.js').Observation} obs @param {SiteId} s */
  retakeReady(obs, s) {
    const b = obs.bomb;
    const bx = b.x ?? this.intel.sites[s].cx;
    const by = b.y ?? this.intel.sites[s].cy;
    const stage = this.stageSpots('CT', s, 0);
    if (stage.length === 0) return true;
    const st = stage[0];
    const left = (b.ticksLeft ?? 0) / this.tps;
    const need = dist(st.x, st.y, bx, by) / UNIT / 4.3 + (this.kits.size > 0 || obs.me.loadout.kit ? 5 : 10) + P.saveMargin + 2;
    if (left <= need) return true;
    return this.alive(obs).every((m) => this.inSite(m.x, m.y, s, bx, by) || stage.some((sp) => dist(m.x, m.y, sp.x, sp.y) < P.retakeGather * UNIT));
  }

  /** 在包點裡（包點區域內或離炸彈 8 格內） @param {number} x @param {number} y @param {SiteId} s @param {number} bx @param {number} by */
  inSite(x, y, s, bx, by) {
    const c = this.g.cellOf(x, y);
    return (c >= 0 && this.intel.sites[s].regions.has(this.intel.region[c])) || dist(x, y, bx, by) < 8 * UNIT;
  }

  // ───────── 購買、事件廣播 ─────────

  /** 指揮先決定買法並廣播；其他人等指揮的買法（最多 1 秒）再買 @param {import('./base.js').Observation} obs @param {TacOut} out @param {boolean} isCmd */
  buy(obs, out, isCmd) {
    const me = obs.me;
    if (!obs.round.canBuy || this.bought) {
      if (!this.kitSaid && me.loadout.kit && obs.round.phase === 'live') {
        this.kitSaid = true;
        out.cmds.push({ type: 'say', text: 'E:kit' });
      }
      return;
    }
    if (isCmd && this.buyCall === null) {
      this.buyCall = this.econ.teamCall(obs);
      out.cmds.push({ type: 'say', text: `B:${this.buyCall}` });
    }
    const waited = obs.round.phase !== 'freeze' || this.data.rules.freezeTicks - obs.round.phaseTicksLeft >= this.tps;
    if (this.buyCall === null && !waited) return;
    const call = this.buyCall ?? this.econ.teamCall(obs);
    const items = this.econ.items(obs, call, this.data.slot);
    if (items.length > 0) out.cmds.push({ type: 'buy', items });
    this.bought = true;
  }

  /**
   * 事件廣播：看到敵人 → 「E:contact <區域> <人數>」（同一區域人數變了或隔 P.contactEvery 秒才再喊）
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  report(obs, out) {
    if (obs.enemies.length === 0 || obs.round.phase === 'freeze') return;
    const t = obs.tick;
    /** @type {Map<number, number>} */
    const byRegion = new Map();
    for (const e of obs.enemies) {
      const r = this.intel.region[this.g.cellOf(e.x, e.y)];
      if (r >= 0) byRegion.set(r, (byRegion.get(r) ?? 0) + 1);
    }
    for (const [r, n] of byRegion) {
      const id = this.intel.map.regions[r].id;
      const last = this.saidContact.get(id);
      if (last !== undefined && (last.n >= n || t - last.tick < P.contactEvery * this.tps) && t - last.tick < 4 * P.contactEvery * this.tps) continue;
      this.saidContact.set(id, { n, tick: t });
      const c = this.regionCell(id);
      this.noteContact(id, n, t, this.siteNear(c));
      out.cmds.push({ type: 'say', text: `E:contact ${id} ${n}` });
      return;
    }
  }

  // ───────── T ─────────

  /**
   * 分組：主力 3 人（含持彈者）＝ 0、第二組 2 人 ＝ 1；rush／go 全隊同組。第一次知道計畫時算好（之後有人陣亡不重分）
   * @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p
   */
  groupOf(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return 0;
    const key = `${p.kind}${p.site}`;
    if (this.groups === null || this.groupKey !== key) {
      const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
      const others = this.ids.filter((x) => x !== carrier);
      const main = carrier >= 0 ? [carrier, ...others.slice(0, 2)] : others.slice(0, 3);
      this.groups = new Map(this.ids.map((x) => [x, main.includes(x) ? 0 : 1]));
      this.groupKey = key;
    }
    return this.groups.get(id) ?? 0;
  }

  /** 組內名次（持彈者排最後；第 0 個是突破手） @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  memberIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
    const list = this.ids.filter((x) => this.groupOf(obs, x, p) === gid).sort((a, b) => (a === carrier ? 1 : 0) - (b === carrier ? 1 : 0) || a - b);
    return Math.max(0, list.indexOf(id));
  }

  /** 某隊員佈置時要去的點與路線 @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p @returns {{ site: SiteId, route: number }} */
  setupOf(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    if (gid === 0) return { site: p.site, route: p.r1 };
    if (p.kind === 'split') return { site: p.site, route: p.r2 };
    return { site: other(p.site), route: p.r2 };
  }

  /** 某隊員的待命格 @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  memberStage(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return null;
    const s = this.setupOf(obs, id, p);
    const spots = this.stageSpots('T', s.site, s.route);
    if (spots.length === 0) return null;
    return spots[this.memberIndex(obs, id, p) % spots.length];
  }

  /** @param {SiteId} site @param {number} idx */
  tRoute(site, idx) {
    const routes = this.intel.routes.T[site];
    return routes.length === 0 ? null : routes[Math.min(idx, routes.length - 1)];
  }

  /**
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   * @returns {import('./utility.js').ThrowWish | null}
   */
  tGoal(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const b = obs.bomb;
    // 下包後：守包（下包者與一人在點內，其餘看回防入口）
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) return this.postPlant(obs, out, b.x, b.y, b.site ?? 'A');
    // 炸彈掉了：最近的 T 去撿
    if (b.state === 'dropped' && b.x !== null && b.y !== null) {
      const bx = b.x;
      const by = b.y;
      const myD = dist(me.x, me.y, bx, by);
      if (!obs.teammates.some((m) => m.alive && dist(m.x, m.y, bx, by) < myD)) {
        out.goal = { x: bx, y: by };
        out.role = '撿炸彈';
        return null;
      }
    }
    const p = this.plan !== null && this.plan.kind !== 'hold' ? this.plan : null;
    if (p === null) return null;
    // 剩 P.forceExecLeft 秒還沒執行（指揮沒喊）：自己也照最近的點執行
    let exec = p.exec;
    if (exec === null && obs.round.phase === 'live' && obs.round.phaseTicksLeft <= (P.forceExecLeft - 3) * this.tps) exec = this.nearestSite(obs);
    const setup = this.setupOf(obs, me.id, p);
    if (exec === null) {
      // ── 佈置：走自己組的路線到待命格，看入口；靠近了靜步 ──
      const st = this.memberStage(obs, me.id, p);
      out.route = this.pickRoute(obs, setup.site, setup.route);
      if (st === null) return null;
      out.goal = { x: st.x, y: st.y };
      out.hold = st;
      const d = dist(me.x, me.y, st.x, st.y);
      out.role = p.kind === 'fake' && this.groupOf(obs, me.id, p) === 1 ? '佯攻' : '待命';
      if (d < 10 * UNIT && this.attrs.movement >= 0.3) out.walk = true;
      // 佯攻：到了待命格就開幾槍、丟道具進點製造聲音
      if (out.role === '佯攻' && d < 2.5 * UNIT) {
        if (this.noiseLeft === 0 && this.stageArrive < 0) {
          this.stageArrive = t;
          this.noiseLeft = 4;
        }
        if (this.noiseLeft > 0) {
          this.noiseLeft--;
          out.noise = true;
          out.look = { x: st.fx, y: st.fy };
        }
        const site = this.intel.sites[setup.site];
        const kind = this.util.pick(me, ['he', 'flash', 'molotov']);
        if (kind !== null && kind !== 'flash') return { kind, x: site.cx, y: site.cy, why: '佯攻' };
      }
      return null;
    }
    // ── 執行（go 是 6-1 的直接進點：照常探頭）──
    if (p.kind !== 'go') {
      out.allowPeek = false;
      out.walk = false;
    }
    const site = this.intel.sites[exec];
    const mine = setup.site === exec;
    out.route = mine ? this.pickRoute(obs, exec, setup.route) : null;
    const ent = mine ? this.entranceOf(exec, setup.route) : null;
    // 進點前的道具：支援先煙、突破手再閃；其他人等閃光（最多 3 秒）
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = null;
    const sinceExec = this.execTick >= 0 ? (t - this.execTick) / this.tps : 99;
    if (ent !== null && !this.inSite(me.x, me.y, exec, site.cx, site.cy) && dist(me.x, me.y, ent.ox, ent.oy) < 22 * UNIT) {
      const idx = this.memberIndex(obs, me.id, p);
      const smokeFirst = p.kind !== 'rush' && p.kind !== 'go';
      if (this.util.has(me, 'smoke') && smokeFirst && idx === this.smokerIndex(obs, me.id, p)) {
        const sp = this.smokePoint(exec, ent);
        if (sp !== null) wish = { kind: 'smoke', x: sp.x, y: sp.y, why: '封架點' };
      } else if (this.util.has(me, 'flash') && idx === 0 && (!smokeFirst || this.smokeHeard >= 0 || this.util.used.has('smoke') || sinceExec > 1.5)) {
        const fp = this.flashPoint(exec, ent);
        if (fp !== null && this.viewer(fp)) wish = { kind: 'flash', x: fp.x, y: fp.y, why: '閃進點' };
      }
      // 等閃光：還在待命格附近、閃光還沒丟、執行不到 3 秒
      const st = this.memberStage(obs, me.id, p);
      const pending = this.mateFlash.some((x) => t <= x.pop);
      const waiting = smokeFirst && st !== null && dist(me.x, me.y, st.x, st.y) < 4 * UNIT && wish === null && (pending || (sinceExec < 3 && this.flashHeard < 0 && !this.util.used.has('flash')));
      if (waiting) {
        out.goal = { x: st.x, y: st.y };
        out.hold = st;
        out.role = '等閃光';
        return null;
      }
    }
    out.role = `執行 ${exec}`;
    if (me.hasBomb) {
      const spot = site.plants[0];
      out.goal = { x: spot.x, y: spot.y };
      out.role = '持彈';
      const cx = Math.floor(me.x / UNIT);
      const cy = Math.floor(me.y / UNIT);
      const r = site.rect;
      const inside = inRect({ x0: r.x0 + 1, y0: r.y0 + 1, x1: r.x1 - 1, y1: r.y1 - 1 }, cx, cy);
      const atSpot = dist(me.x, me.y, spot.x, spot.y) < 1500;
      const hurry = obs.round.phaseTicksLeft < 20 * this.tps;
      if (obs.round.phase === 'live' && inside && (atSpot || hurry) && (!P.plantRequireClear || obs.enemies.length === 0) && me.plantTicks === 0) {
        out.cmds.push({ type: 'plant' });
        out.objective = true;
      }
      return wish;
    }
    const k = this.rank(obs, (id) => id !== this.carrierId(obs));
    const holds = this.postSpots(exec, site.cx, site.cy);
    const spot = holds.length > 0 ? holds[k % holds.length] : site.plants[0];
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    return wish;
  }

  /** 支援（煙霧手）：組內序號 1、3 優先，其次 2、0 @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  smokerIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const members = this.ids.filter((x) => this.groupOf(obs, x, p) === gid && obs.teammates.every((m) => m.id !== x || m.alive));
    const pref = [1, 3, 2, 0, 4];
    for (const s of pref) {
      const who = members.find((x) => this.slotOf(x) === s);
      if (who !== undefined) return this.memberIndex(obs, who, p);
    }
    return -1;
  }

  /** 路線的包點入口 @param {SiteId} site @param {number} routeIdx */
  entranceOf(site, routeIdx) {
    const r = this.tRoute(site, routeIdx);
    if (r === null) return null;
    const pid = r.portals[r.portals.length - 1];
    return this.intel.sites[site].entrances.find((e) => e.portal === pid) ?? null;
  }

  /**
   * 煙霧落點：入口內側往「最可能架這個入口的位置」P.smokeOff 格（記得的敵人優先，否則包點守點位中看得到入口、最遠的）
   * @param {SiteId} s @param {import('./analysis.js').Entrance} e
   */
  smokePoint(s, e) {
    const g = this.g;
    let best = null;
    let bestS = -Infinity;
    for (const k of this.perc.known.values()) {
      if (k.conf < 50 || dist(k.x, k.y, e.ix, e.iy) > 25 * UNIT || !g.los(k.x, k.y, e.ix, e.iy)) continue;
      const sc = 100 + k.conf;
      if (sc > bestS) {
        bestS = sc;
        best = { x: k.x, y: k.y };
      }
    }
    if (best === null) {
      for (const hs of this.intel.sites[s].holds) {
        const d = dist(hs.x, hs.y, e.ix, e.iy);
        if (d > 25 * UNIT || !g.los(hs.x, hs.y, e.ix, e.iy)) continue;
        if (d > bestS) {
          bestS = d;
          best = { x: hs.x, y: hs.y };
        }
      }
    }
    if (best === null) return null;
    const d = dist(best.x, best.y, e.ix, e.iy);
    const f = Math.min(0.6, (P.smokeOff * UNIT) / Math.max(d, 1));
    return { x: e.ix + (best.x - e.ix) * f, y: e.iy + (best.y - e.iy) * f };
  }

  /** 爆點附近可能有敵人看得到（記得的敵人在閃光範圍內、有視線）：沒有就不丟閃光（免得只閃到自己人） @param {import('./base.js').Pt} p */
  viewer(p) {
    return this.perc.threats(p.x, p.y, 30).some((k) => dist(k.x, k.y, p.x, p.y) < this.util.flashRadius && this.g.los(k.x, k.y, p.x, p.y));
  }

  /** 閃光爆點：入口內側再往包點中心 P.flashDepth 格（碰牆就短一點） @param {SiteId} s @param {import('./analysis.js').Entrance} e */
  flashPoint(s, e) {
    const site = this.intel.sites[s];
    const d = dist(e.ix, e.iy, site.cx, site.cy);
    if (d < 1) return { x: e.ix, y: e.iy };
    for (let k = P.flashDepth; k >= 1; k--) {
      const f = Math.min(1, (k * UNIT) / d);
      const x = e.ix + (site.cx - e.ix) * f;
      const y = e.iy + (site.cy - e.iy) * f;
      if (this.g.walkable(this.g.cellOf(x, y))) return { x, y };
    }
    return { x: e.ix, y: e.iy };
  }

  /**
   * 下包後：下包者與一人守點內，其餘看回防入口（CT 最近的入口優先）；不衝出去找人。
   * 對方拆包（看見或聽到）就把燃燒／手雷丟到炸彈上
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {number} bx @param {number} by @param {SiteId} s
   * @returns {import('./utility.js').ThrowWish | null}
   */
  postPlant(obs, out, bx, by, s) {
    const me = obs.me;
    const t = obs.tick;
    const spots = this.postSpots(s, bx, by);
    const k = this.rank(obs);
    out.hold = spots.length > 0 ? spots[k % spots.length] : null;
    out.goal = out.hold ?? { x: bx, y: by };
    out.role = '守包';
    out.allowPeek = false;
    const snd = this.perc.lastSound;
    const defusing = obs.bomb.state === 'defusing' || (snd !== null && snd.kind === 'defuse' && t - snd.tick < this.tps);
    if (defusing) {
      const kind = this.util.pick(me, ['molotov', 'he']);
      if (kind !== null) return { kind, x: bx, y: by, why: '燒拆包' };
    }
    return null;
  }

  /** 守包位：包點守點位（看 CT 最近的入口的先）＋下包位，離炸彈 14 格內 @param {SiteId} s @param {number} bx @param {number} by */
  postSpots(s, bx, by) {
    const site = this.intel.sites[s];
    const holds = site.holds.filter((h) => dist(h.x, h.y, bx, by) < 14 * UNIT).sort((a, b) => (site.entrances[a.entrance]?.ctDist ?? 0) - (site.entrances[b.entrance]?.ctDist ?? 0));
    const plants = site.plants.filter((h) => dist(h.x, h.y, bx, by) < 12 * UNIT && dist(h.x, h.y, bx, by) > 1500).map((h) => ({ ...h, fx: bx, fy: by }));
    return [...holds, ...plants];
  }

  /**
   * 路線：照計畫；還在出生區附近而路線上有危險（交界點的危險格成本高），就換最安全的另一條（本回合記住）
   * @param {import('./base.js').Observation} obs @param {SiteId} site @param {number} idx0
   */
  pickRoute(obs, site, idx0) {
    const routes = this.intel.routes.T[site];
    if (routes.length === 0) return null;
    const idx = this.routeOverride >= 0 ? this.routeOverride : Math.min(idx0, routes.length - 1);
    const me = obs.me;
    const c = this.g.cellOf(me.x, me.y);
    if (c < 0 || this.intel.distSpawn.T[c] / 10 > P.routeSwitchNear) return routes[idx];
    /** @param {import('./analysis.js').Route} r */
    const risk = (r) => {
      let v = 0;
      for (const p of r.points) v = Math.max(v, this.perc.danger[this.g.cellOf(p.x, p.y)] ?? 0);
      return v;
    };
    const cur = risk(routes[idx]);
    if (cur < P.routeSwitchRisk) return routes[idx];
    let best = idx;
    for (let i = 0; i < routes.length; i++) if (risk(routes[i]) < risk(routes[best])) best = i;
    if (best !== idx && risk(routes[best]) < cur / 2) this.routeOverride = best;
    return routes[this.routeOverride >= 0 ? this.routeOverride : idx];
  }

  /** @param {import('./base.js').Observation} obs */
  carrierId(obs) {
    if (obs.me.hasBomb) return obs.me.id;
    const c = obs.teammates.find((m) => m.alive && m.hasBomb);
    return c === undefined ? -1 : c.id;
  }

  /** 同陣營活人依 id 排序後自己的名次 @param {import('./base.js').Observation} obs @param {(id: number) => boolean} [filter] */
  rank(obs, filter = () => true) {
    const ids = [obs.me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].filter(filter).sort((a, b) => a - b);
    return Math.max(0, ids.indexOf(obs.me.id));
  }

  // ───────── CT ─────────

  /**
   * CT 守位分配：A 的守點位（a 個）、中路（m 個）、B 的守點位（b 個）；狙擊手拿長對線位。依隊內序號分配
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @returns {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }>}
   */
  ctLayout(obs, p) {
    const key = `${p.a}${p.m}${p.b}${this.awper}`;
    if (this.layout !== null && this.layoutKey === key) return this.layout;
    /** @type {{ spot: import('./analysis.js').Spot, site: SiteId | null }[]} */
    const pos = [];
    const hA = this.intel.sites.A.holds;
    const hB = this.intel.sites.B.holds;
    const mids = this.midSpots();
    let m = p.m;
    if (mids.length === 0) m = 0;
    const a = p.a + (mids.length === 0 ? Math.ceil(p.m / 2) : 0);
    const b = 5 - a - m;
    for (let i = 0; i < a; i++) if (hA.length > 0) pos.push({ spot: hA[i % hA.length], site: 'A' });
    for (let i = 0; i < m; i++) pos.push({ spot: mids[i % mids.length], site: null });
    for (let i = 0; i < b; i++) if (hB.length > 0) pos.push({ spot: hB[i % hB.length], site: 'B' });
    /** @type {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }>} */
    const out = new Map();
    let ids = [...this.ids];
    if (this.awper >= 0) {
      const sn = this.sniperSpot();
      if (sn !== null) {
        // 狙擊位所在點的最後一個位置換成狙擊位（那個點只有一人時就是錨點自己）
        let idx = -1;
        for (let i = 0; i < pos.length; i++) if (pos[i].site === sn.site) idx = i;
        if (idx < 0) idx = pos.length - 1;
        pos.splice(idx, 1);
        out.set(this.awper, { spot: sn.spot, site: sn.site });
        ids = ids.filter((x) => x !== this.awper);
      }
    }
    ids.forEach((id, i) => {
      const q = pos[i % Math.max(1, pos.length)];
      if (q !== undefined) out.set(id, q);
    });
    this.layout = out;
    this.layoutKey = key;
    return out;
  }

  /** 錨點：每個點分到的第一個人 @param {import('./base.js').Observation} obs @param {CTPlan} p @param {SiteId} s */
  anchorOf(obs, p, s) {
    const lay = this.ctLayout(obs, p);
    for (const id of this.ids) if (lay.get(id)?.site === s && this.isAlive(obs, id)) return id;
    return -1;
  }

  /** @param {import('./base.js').Observation} obs @param {number} id */
  isAlive(obs, id) {
    if (id === obs.me.id) return obs.me.alive;
    return obs.teammates.some((m) => m.id === id && m.alive);
  }

  /**
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   * @returns {import('./utility.js').ThrowWish | null}
   */
  ctGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    const p = this.plan !== null && this.plan.kind === 'hold' ? this.plan : this.chooseCT();
    // 狙擊手：開打時手上拿狙擊槍的人（全隊看到的一樣）
    if (!this.awperFixed) {
      this.awper = me.loadout.primary === 'awp' ? me.id : (obs.teammates.find((m) => m.weapon === 'awp')?.id ?? -1);
      this.awperFixed = obs.round.phase === 'live';
    }
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      this.lastAttack = b.site;
      return this.retake(obs, out, p, b.x, b.y, b.site ?? 'A');
    }
    if (p.rot !== null) this.lastAttack = p.rot;
    const lay = this.ctLayout(obs, p).get(me.id);
    if (lay === undefined) return null;
    let spot = lay.spot;
    out.role = lay.site === null ? '中路' : `守 ${lay.site}`;
    // 輪轉：另一點的錨點以外全部去輪轉點的待命位（本來就守那點的不動）
    if (p.rot !== null && lay.site !== p.rot && this.anchorOf(obs, p, other(p.rot)) !== me.id) {
      const stage = this.stageSpots('CT', p.rot, 0);
      const rotators = this.ids.filter((id) => this.isAlive(obs, id) && this.ctLayout(obs, p).get(id)?.site !== p.rot && this.anchorOf(obs, p, other(/** @type {SiteId} */ (p.rot))) !== id);
      if (stage.length > 0) {
        spot = stage[Math.max(0, rotators.indexOf(me.id)) % stage.length];
        out.role = `輪轉 ${p.rot}`;
      }
    }
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    // 燃燒封入口：兩個以上敵人正接近自己守的點的入口
    const s = lay.site ?? p.rot;
    if (s !== null) {
      const kind = this.util.pick(me, ['incendiary', 'molotov']);
      if (kind !== null) {
        for (const e of this.intel.sites[s].entrances) {
          let n = 0;
          for (const k of this.perc.known.values()) {
            if (k.conf < 60 || obs.tick - k.tick > 1.5 * this.tps) continue;
            const c = this.g.cellOf(k.x, k.y);
            if (dist(k.x, k.y, e.ox, e.oy) < P.molotovNear * UNIT && !this.intel.sites[s].regions.has(this.intel.region[c])) n++;
          }
          if (n >= 2) return { kind, x: e.ox + (e.ox - e.ix) * 0.3, y: e.oy + (e.oy - e.iy) * 0.3, why: '燒入口' };
        }
      }
    }
    return null;
  }

  /**
   * 回防：點外的人到待命位集結，go 了一起進（先閃）；拆彈器的人優先拆，其他人守炸彈附近看入口；時間不夠就保槍
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {CTPlan} p @param {number} bx @param {number} by @param {SiteId} s
   * @returns {import('./utility.js').ThrowWish | null}
   */
  retake(obs, out, p, bx, by, s) {
    const me = obs.me;
    const t = obs.tick;
    const b = obs.bomb;
    out.allowPeek = false;
    const left = (b.ticksLeft ?? 0) / this.tps;
    const myD = dist(me.x, me.y, bx, by);
    const defuseS = (/** @type {boolean} */ k) => (k ? this.data.rules.defuseKitTicks : this.data.rules.defuseTicks) / this.tps;
    // 拆的人：有拆彈器的人（離炸彈不比最近的人遠 8 格以上），否則最近的人；已經在拆的人繼續
    const team = this.alive(obs).map((m) => ({ ...m, kit: m.id === me.id ? me.loadout.kit : this.kits.has(m.id), d: dist(m.x, m.y, bx, by), defusing: m.id === me.id ? me.defuseTicks > 0 : obs.teammates.some((x) => x.id === m.id && x.defusing) }));
    const closest = Math.min(...team.map((m) => m.d));
    let defuser = team.find((m) => m.defusing);
    if (defuser === undefined) {
      const withKit = team.filter((m) => m.kit && m.d <= closest + 8 * UNIT).sort((a, c) => a.d - c.d || a.id - c.id);
      defuser = withKit[0] ?? [...team].sort((a, c) => a.d - c.d || a.id - c.id)[0];
    }
    // 保槍：誰都來不及（最快的人走過去＋拆）；或 1 對 3 以上、紀律高、下回合買不起
    const fastest = Math.min(...team.map((m) => m.d / UNIT / 4.6 + defuseS(m.kit)));
    const outnumbered = team.length === 1 && obs.enemiesAlive >= 3 && this.attrs.discipline >= 0.5 && this.attrs.aggression < 0.6 && this.econ.shortOf(me.money + 1400, me.loadout.primary, 'CT') > 0;
    if (me.defuseTicks === 0 && (left < fastest + 0.5 || outnumbered || this.saving)) {
      this.saving = true;
      const away = this.saveSpot(obs, bx, by);
      if (away !== null) out.goal = away;
      out.role = '保槍';
      return null;
    }
    const inside = this.inSite(me.x, me.y, s, bx, by);
    const stage = this.stageSpots('CT', s, 0);
    const go = p.go || this.plan === null;
    if (!go && !inside && stage.length > 0) {
      const others = this.ids.filter((id) => this.isAlive(obs, id));
      const sp = stage[Math.max(0, others.indexOf(me.id)) % stage.length];
      out.goal = { x: sp.x, y: sp.y };
      out.hold = sp;
      out.role = '回防集結';
      if (dist(me.x, me.y, sp.x, sp.y) < 10 * UNIT) out.walk = true;
      return null;
    }
    // go：第一個到的人（離炸彈最近、還在點外）先閃
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = null;
    if (!inside && this.util.has(me, 'flash') && defuser.id !== me.id && t - this.flashHeard > 3 * this.tps) {
      const th = this.perc.threats(bx, by, 30).find((k) => dist(k.x, k.y, bx, by) < 12 * UNIT);
      if (th !== undefined) wish = { kind: 'flash', x: th.x, y: th.y, why: '回防閃' };
    }
    if (defuser.id === me.id) {
      out.goal = { x: bx, y: by };
      out.role = '拆包';
      const clear = obs.enemies.length === 0;
      if (myD < 1300 && b.state === 'planted' && me.defuseTicks === 0 && clear) {
        out.cmds.push({ type: 'defuse' });
        out.objective = true;
      }
      return wish;
    }
    // 掩護：炸彈附近的守點位，看入口
    const others = this.ids.filter((id) => this.isAlive(obs, id) && id !== defuser.id);
    const k = Math.max(0, others.indexOf(me.id));
    const spots = this.postSpots(s, bx, by);
    const sp = spots.length > 0 ? spots[k % spots.length] : null;
    out.hold = sp;
    out.goal = sp ?? { x: bx, y: by };
    out.role = '回防掩護';
    return wish;
  }

  /** 保槍點：離炸彈 P.saveDist 格以上、走得到的最近格 @param {import('./base.js').Observation} obs @param {number} bx @param {number} by */
  saveSpot(obs, bx, by) {
    const me = obs.me;
    if (dist(me.x, me.y, bx, by) >= P.saveDist * UNIT) return { x: me.x, y: me.y };
    if (this.saveCache !== null && dist(this.saveCache.x, this.saveCache.y, bx, by) >= P.saveDist * UNIT) return this.saveCache;
    const g = this.g;
    // BFS 太遠的話改走 CT 出生區（多半離包點遠）
    const zone = this.intel.map.spawnZones.CT;
    const c = this.intel.nearestOpen(Math.floor((zone.x0 + zone.x1) / 2), Math.floor((zone.y0 + zone.y1) / 2));
    const z = g.center(c);
    const far = dist(z.x, z.y, bx, by) >= P.saveDist * UNIT ? z : null;
    this.saveCache = far ?? { x: me.x + (me.x - bx), y: me.y + (me.y - by) };
    return this.saveCache;
  }

  // ───────── 共通：換血、追殘血、隊友閃光、手雷 ─────────

  /**
   * 疊在目標之上的小行為：隊友閃光（看得到爆點就轉身）、換血（朝隊友陣亡方向架槍）、紀律低的人追殘血
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  overlay(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    // 閃光（自己丟的或隊友喊的）：看得到爆點就躲到最近看不到的格（7 步內），沒有就轉身
    const own = this.util.away !== null && t >= this.util.away.from ? this.util.away : null;
    this.mateFlash = this.mateFlash.filter((x) => t <= x.pop + 2);
    const mf = this.mateFlash.find((x) => dist(me.x, me.y, x.x, x.y) < this.util.flashRadius + UNIT && this.g.los(me.x, me.y, x.x, x.y));
    const f = own !== null ? own : mf !== undefined ? { x: mf.x, y: mf.y, until: mf.pop + 2 } : null;
    if (f !== null && t <= f.until && !out.objective) {
      const R = this.util.flashRadius + UNIT;
      const g = this.g;
      if (dist(me.x, me.y, f.x, f.y) < R && g.los(me.x, me.y, f.x, f.y)) {
        if (this.hideFor !== f.until) {
          this.hideFor = f.until;
          this.hide = this.nav?.escape(obs, (i) => {
            const c = g.center(i);
            return dist(c.x, c.y, f.x, f.y) < R && g.los(c.x, c.y, f.x, f.y);
          }, 7) ?? null;
        }
        if (this.hide !== null) {
          out.goal = this.hide;
          out.hold = null;
          out.route = null;
          out.allowPeek = false;
          out.stop = false;
          out.walk = false;
        }
        out.look = { x: me.x + (me.x - f.x) * 2, y: me.y + (me.y - f.y) * 2 };
        out.urgent = true;
        return;
      }
    }
    // 隊友的閃光還沒爆、自己看不到爆點：先別往前走（免得走進閃光）
    if (!out.objective && this.mateFlash.some((x) => t < x.pop && dist(me.x, me.y, x.x, x.y) < this.util.flashRadius + 4 * UNIT)) {
      out.stop = true;
      return;
    }
    if (this.trade !== null) {
      if (t > this.trade.until) this.trade = null;
      else if (!out.objective) {
        out.look = { x: this.trade.x, y: this.trade.y };
        out.stop = true;
        return;
      }
    }
    // 不追殘血：紀律低的人，剛丟失的目標估計血量很低而且不遠，就追過去
    const c = this.combat;
    if (c !== null && this.attrs.discipline < 0.5 && !out.objective && obs.enemies.length === 0) {
      if (this.chase === null && c.lostPos !== null && t - c.lostTick < this.tps / 2 && c.targetId >= 0) {
        const hp = 100 - (this.dealt.get(c.targetId) ?? 0);
        if (hp <= P.chaseHp && dist(me.x, me.y, c.lostPos.x, c.lostPos.y) < P.chaseRange * UNIT) this.chase = { x: c.lostPos.x, y: c.lostPos.y, until: t + P.chaseTime * this.tps };
      }
      if (this.chase !== null) {
        if (t > this.chase.until) this.chase = null;
        else {
          out.goal = { x: this.chase.x, y: this.chase.y };
          out.hold = null;
          out.role += '・追殘血';
        }
      }
    }
  }

  /**
   * 手雷：記得兩個以上的敵人聚在一起（P.nadeCluster 格內、最近 1 秒看到）就丟過去
   * @param {import('./base.js').Observation} obs @returns {import('./utility.js').ThrowWish | null}
   */
  anyNade(obs) {
    const me = obs.me;
    if (!this.util.has(me, 'he') || obs.round.phase === 'freeze') return null;
    const list = [...this.perc.known.values()].filter((k) => k.conf >= 70 && obs.tick - k.tick <= this.tps && Math.abs(k.vx) + Math.abs(k.vy) < 40);
    for (const a of list) {
      const near = list.filter((k) => dist(k.x, k.y, a.x, a.y) < P.nadeCluster * UNIT);
      if (near.length < 2) continue;
      const x = near.reduce((s, k) => s + k.x, 0) / near.length;
      const y = near.reduce((s, k) => s + k.y, 0) / near.length;
      if (dist(me.x, me.y, x, y) < 6 * UNIT) continue;
      if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, x, y) < 4 * UNIT)) continue;
      return { kind: 'he', x, y, why: '手雷' };
    }
    return null;
  }

  // ───────── 地圖算出的位置（快取） ─────────

  /**
   * 待命格：包點入口外 P.stageBack 格（距離場差）、在路線上、包點守點位看不到的格；附近每人一格（彼此隔 P.stageGap 格）
   * team = T 用 T 路線（佈置）；CT 用 CT 路線（輪轉、回防集結）
   * @param {'T' | 'CT'} team @param {SiteId} s @param {number} routeIdx @returns {import('./analysis.js').Spot[]}
   */
  stageSpots(team, s, routeIdx) {
    const key = `${team}${s}${routeIdx}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const routes = intel.routes[team][s];
    const route = routes.length === 0 ? null : routes[Math.min(routeIdx, routes.length - 1)];
    const site = intel.sites[s];
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    const pid = route?.portals[route.portals.length - 1];
    const ent = site.entrances.find((e) => e.portal === pid) ?? (team === 'T' ? site.entrances[0] : [...site.entrances].sort((a, b) => a.ctDist - b.ctDist)[0]);
    if (ent === undefined) {
      this.spotCache.set(key, out);
      return out;
    }
    const field = intel.distSite[s];
    const d0 = field[g.cellOf(ent.ox, ent.oy)];
    const want = d0 + P.stageBack * 10;
    const prev = route !== null && route.points.length >= 3 ? route.points[route.points.length - 3] : this.spawnCenter(team);
    const enemyHolds = team === 'T' ? site.holds : [];
    let best = -1;
    let bestS = -Infinity;
    const R = 18;
    const cx0 = Math.floor(ent.ox / UNIT);
    const cy0 = Math.floor(ent.oy / UNIT);
    for (let y = cy0 - R; y <= cy0 + R; y++) {
      for (let x = cx0 - R; x <= cx0 + R; x++) {
        if (g.isBlock(x, y)) continue;
        const i = y * g.W + x;
        if (site.regions.has(intel.region[i]) || !Number.isFinite(field[i]) || Math.abs(field[i] - want) > 30) continue;
        const c = g.center(i);
        let seen = 0;
        for (const hs of enemyHolds) if (dist(hs.x, hs.y, c.x, c.y) < 30 * UNIT && g.los(hs.x, hs.y, c.x, c.y)) seen++;
        const off = segDist(c.x, c.y, prev.x, prev.y, ent.ox, ent.oy).d / UNIT;
        const sc = -Math.abs(field[i] - want) / 5 - 1.5 * off - 8 * seen - intel.exposure[i] + (intel.cover[i] !== 0 ? 2 : 0) + (team === 'CT' && g.los(c.x, c.y, ent.x, ent.y) ? 4 : 0);
        if (sc > bestS) {
          bestS = sc;
          best = i;
        }
      }
    }
    if (best < 0) {
      this.spotCache.set(key, out);
      return out;
    }
    // 每人一格：從待命格 BFS 4 步內、不比入口近、彼此隔開
    /** @type {number[]} */
    const queue = [best];
    const depth = new Map([[best, 0]]);
    for (let q = 0; q < queue.length && out.length < 5; q++) {
      const i = queue[q];
      const c = g.center(i);
      if (field[i] >= d0 + 40 && !site.regions.has(intel.region[i]) && out.every((o) => dist(o.x, o.y, c.x, c.y) >= P.stageGap * UNIT)) out.push({ x: c.x, y: c.y, cell: i, fx: ent.x, fy: ent.y, score: 0, entrance: site.entrances.indexOf(ent) });
      const dd = /** @type {number} */ (depth.get(i));
      if (dd >= 4) continue;
      const x = i % g.W;
      const y = (i - x) / g.W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const j = (y + dy) * g.W + x + dx;
        if (g.isBlock(x + dx, y + dy) || depth.has(j)) continue;
        depth.set(j, dd + 1);
        queue.push(j);
      }
    }
    this.spotCache.set(key, out);
    return out;
  }

  /** @param {'T' | 'CT'} team */
  spawnCenter(team) {
    const z = this.intel.map.spawnZones[team];
    return this.g.center(this.intel.nearestOpen(Math.floor((z.x0 + z.x1) / 2), Math.floor((z.y0 + z.y1) / 2)));
  }

  /**
   * 中路位：T 路線經過的交界（不是包點入口、離兩個包點都 ≥ 15 格、CT 比 T 早 5 格以上到、不在 CT 出生區）中，
   * 經過的 T 路線最多、到兩點距離接近、CT 領先多的那個；守位在它的 CT 側 8～20 格、看得到它、暴露少（最多 2 個）
   * @returns {import('./analysis.js').Spot[]}
   */
  midSpots() {
    const hit = this.spotCache.get('mid');
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const entrancePortals = new Set([...intel.sites.A.entrances, ...intel.sites.B.entrances].map((e) => e.portal));
    /** @type {Map<number, number>} */
    const uses = new Map();
    for (const s of SITES) for (const r of intel.routes.T[s]) for (const pid of r.portals) uses.set(pid, (uses.get(pid) ?? 0) + 1);
    let pick = null;
    let pickS = -Infinity;
    for (const [pid, n] of uses) {
      if (entrancePortals.has(pid)) continue;
      const p = intel.portals[pid];
      const c = g.cellOf(p.x, p.y);
      if (c < 0) continue;
      const dA = intel.distSite.A[c] / 10;
      const dB = intel.distSite.B[c] / 10;
      const ct = intel.distSpawn.CT[c] / 10;
      const tt = intel.distSpawn.T[c] / 10;
      if (dA < 15 || dB < 15 || ct < 12 || ct + 5 > tt) continue;
      const sc = 10 * n - Math.abs(dA - dB) / 5 + (tt - ct) / 10;
      if (sc > pickS) {
        pickS = sc;
        pick = p;
      }
    }
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    if (pick !== null) {
      const pc = g.cellOf(pick.x, pick.y);
      const ctAt = intel.distSpawn.CT[pc];
      /** @type {import('./analysis.js').Spot[]} */
      const ranked = [];
      const R = 20;
      const cx0 = Math.floor(pick.x / UNIT);
      const cy0 = Math.floor(pick.y / UNIT);
      for (let y = cy0 - R; y <= cy0 + R; y++) {
        for (let x = cx0 - R; x <= cx0 + R; x++) {
          if (g.isBlock(x, y)) continue;
          const i = y * g.W + x;
          if (intel.distSpawn.CT[i] >= ctAt) continue;
          const c = g.center(i);
          const d = dist(c.x, c.y, pick.x, pick.y) / UNIT;
          if (d < P.holdMin || d > P.holdMax || !g.los(c.x, c.y, pick.x, pick.y)) continue;
          const sc = 100 - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 8 : 0) + ((intel.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13);
          ranked.push({ x: c.x, y: c.y, cell: i, fx: pick.x, fy: pick.y, score: sc, entrance: -1 });
        }
      }
      ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
      for (const s of ranked) {
        if (out.length >= 2) break;
        if (out.every((o) => dist(o.x, o.y, s.x, s.y) >= 5 * UNIT)) out.push(s);
      }
    }
    this.spotCache.set('mid', out);
    return out;
  }

  /**
   * 狙擊位（長對線）：包點 10 格內、看得到某個入口而且距離 16～28 格、看得到的其他入口少、暴露少；兩個點取分數高的
   * @returns {{ spot: import('./analysis.js').Spot, site: SiteId, len: number } | null}
   */
  sniperSpot() {
    if (this.sniper !== undefined) return this.sniper;
    const g = this.g;
    const intel = this.intel;
    /** @type {{ spot: import('./analysis.js').Spot, site: SiteId, len: number } | null} */
    let best = null;
    let bestS = -Infinity;
    for (const s of SITES) {
      const site = intel.sites[s];
      const field = intel.distSite[s];
      for (let i = 0; i < g.N; i++) {
        if (g.block[i] === 1 || field[i] > 100) continue;
        const c = g.center(i);
        let others = 0;
        let lenBest = 0;
        let ei = -1;
        site.entrances.forEach((e, k) => {
          const d = dist(c.x, c.y, e.x, e.y) / UNIT;
          if (d > 30 || !g.los(c.x, c.y, e.x, e.y)) return;
          if (d >= 16 && d <= 28 && d > lenBest) {
            if (lenBest > 0) others++;
            lenBest = d;
            ei = k;
          } else others++;
        });
        if (ei < 0) continue;
        const sc = 2 * lenBest - 20 * others - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 6 : 0);
        if (sc > bestS) {
          bestS = sc;
          const e = site.entrances[ei];
          best = { spot: { x: c.x, y: c.y, cell: i, fx: e.x, fy: e.y, score: sc, entrance: ei }, site: s, len: lenBest };
        }
      }
    }
    this.sniper = best;
    return best;
  }
}
