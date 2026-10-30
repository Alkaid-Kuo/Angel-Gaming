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
// 角色（2.1，roles.js）：每回合第一次決策喊「R:<代碼>」；分組、突破手與煙霧手、進點順序、CT 守位、錨點、回防先後都先看角色，
// 角色重複或缺角時退回隊內序號。
// 經濟「B:full／force／half／eco」見 economy.js；道具的彈道見 utility.js。全部由地圖資料與觀察資料算，不寫死座標或區域代號。
import { P, UNIT, adiff, angleTo, clamp, cosd, dist, inRect, lerp, segDist, sind } from './base.js';
import { Economy, parseBuy } from './economy.js';
import { Utility } from './utility.js';
import { ANCHOR, AWP, ENTRY, LURK, Roles, SUPPORT, parseRole } from './roles.js';

/** T 主力組的優先順序（索引＝角色代碼）：突破、支援、錨點、無、游擊、狙擊 */
const MAIN_PRI = [3, 0, 1, 2, 5, 4];
/** T 的煙霧手：支援優先，其次錨點、游擊、無、突破、狙擊 */
const SMOKE_PREF = [SUPPORT, ANCHOR, LURK, 0, ENTRY, AWP];

/** @typedef {'A' | 'B'} SiteId */
/** T 計畫：site 主力的點、r1／r2 兩組的路線序號、exec 執行哪個點（null = 還在佈置） @typedef {{ kind: 'go' | 'default' | 'rush' | 'split' | 'fake', site: SiteId, r1: number, r2: number, exec: SiteId | null }} TPlan */
/** CT 計畫：A／中路／B 人數、輪轉目標、回防開始 @typedef {{ kind: 'hold', a: number, m: number, b: number, rot: SiteId | null, go: boolean }} CTPlan */
/** @typedef {TPlan | CTPlan} Plan */
/** @typedef {{ kind: 'contact', region: string, n: number } | { kind: 'dead', region: string } | { kind: 'planted', site: SiteId } | { kind: 'flash', x: number, y: number, pop: number } | { kind: 'smoke', x: number, y: number } | { kind: 'kit' }} TeamEvent */
/**
 * 戰術輸出：goal 目標點、route 偏好路線、hold 守位（到了要看哪裡）、objective 正在下包／拆包、allowPeek 可以探頭、cmds 購買／喊話／丟雷／下包／拆包；
 * look 沒交戰時看哪裡（urgent：躲閃光，連「目標剛消失的架槍」也蓋過；hard：閃光快爆了，交戰中也轉身、停火）、stop 站住、walk 靜步（null = 導航決定）、noise 佯攻開槍
 * @typedef {{ goal: import('./base.js').Pt | null, route: import('./analysis.js').Route | null, hold: import('./analysis.js').Spot | null, objective: boolean, allowPeek: boolean, cmds: import('./base.js').Command[], role: string, look: import('./base.js').Pt | null, urgent: boolean, hard: boolean, stop: boolean, walk: boolean | null, noise: boolean }} TacOut
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
   * @param {{ awpSlot: number, role: number, economy: number, ctSplitA: number, plan: number }} opts
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
    this.econ = new Economy(data, h, { economy: opts.economy, discipline: attrs.discipline });
    this.util = new Utility(g, data);
    /** 全隊 id（排序）：隊內序號 = 名次 */
    this.ids = [data.playerId, ...data.teammateIds].sort((a, b) => a - b);
    /** 全隊的角色分工（整場） */
    this.roles = new Roles(this.ids, data.playerId, opts.role, opts.awpSlot);
    this.roleSaid = false;
    /** 本回合讓突破手先進已經停了幾 tick；回防 go 的 tick */
    this.yielded = 0;
    this.slow = false;
    this.spawnHeld = 0;
    this.goTick = -1;
    this.readyAt = -1;
    this.eventDelay = Math.round(lerp(P.eventDelay0, P.eventDelay100, attrs.awareness) * data.rules.decisionInterval);
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
    this.enemiesAlive = 5;
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
    /** 本回合我方煙霧的位置（自己丟的與隊友喊的） @type {import('./base.js').Pt[]} */
    this.smokes = [];
    /** 閃光爆點候選（依入口與煙霧數快取） */
    this.flashKey = '';
    /** @type {{ x: number, y: number, sc: number }[]} */
    this.flashList = [];
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
    /** 本回合我方煙霧的位置（自己丟的與隊友喊的） @type {import('./base.js').Pt[]} */
    this.smokes = [];
    /** 閃光爆點候選（依入口與煙霧數快取） */
    this.flashKey = '';
    /** @type {{ x: number, y: number, sc: number }[]} */
    this.flashList = [];
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
    this.roleSaid = false;
    this.yielded = 0;
    this.slow = false;
    this.spawnHeld = 0;
    this.goTick = -1;
    this.readyAt = -1;
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
    const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false };
    if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
    this.enemiesAlive = obs.enemiesAlive;
    if (!this.roleSaid) {
      this.roleSaid = true;
      out.cmds.push({ type: 'say', text: `R:${this.opts.role}` });
    }
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
    this.slow = false;
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = me.team === 'T' ? this.tGoal(obs, out) : this.ctGoal(obs, out);
    if (this.slow) {
      out.walk = true;
      out.role += '・讓突破手先走';
    }
    if (wish === null) wish = this.anyNade(obs);
    this.overlay(obs, out);
    /** @type {Set<number>} */
    const busy = new Set();
    for (const [id, tk] of this.mateFired) if (t - tk < 1.5 * this.tps) busy.add(id);
    // 正在躲隊友的閃光、或隊友的閃光還沒爆：不轉頭去丟自己的道具
    if (out.urgent || this.mateFlash.some((x) => t <= x.pop)) wish = null;
    const u = this.util.step(obs, wish, busy);
    if (u.thrown !== null && u.thrown.kind === 'smoke') this.smokes.push({ x: u.thrown.x, y: u.thrown.y });
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
      const r = parseRole(c.text);
      if (r > 0) {
        this.roles.hear(c.from, r);
        continue;
      }
      // 第一個計畫與買法立刻處理（凍結時間）；之後的變更與事件依警覺延遲；游擊對計畫變更（輪轉）不延遲
      const first = (this.plan === null || this.roles.of(me.id) === LURK) && c.text.startsWith('P:');
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
      else if (e.kind === 'smoke') {
        this.smokeHeard = t;
        this.smokes.push({ x: e.x, y: e.y });
      }
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
      // 對方多半在 eco（我方贏、對方連敗兩場以上）：不打慢的 default，多 rush／split
      const w = call === 'eco' ? { default: 0.25, rush: 0.6, split: 0.15, fake: 0 } : this.enemyEco() ? { default: 0.1, rush: 0.35 + 0.2 * ag, split: 0.4, fake: 0.1 } : { default: 0.32, rush: 0.12 + 0.2 * ag, split: 0.3, fake: 0.18 };
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
        return s === null || dist(m.x, m.y, s.x, s.y) < 4.5 * UNIT;
      });
      // 兩組都到了再等 1.5 秒（狙擊手站定開鏡、隊友站好）
      if (!ready) this.readyAt = -1;
      else if (this.readyAt < 0) this.readyAt = t;
      if ((ready && t - this.readyAt >= 1.5 * this.tps) || el >= P.splitWait) return { ...p, exec: p.site };
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
      const at = lerp(P.defaultExec0, P.defaultExec100, this.attrs.aggression) * (this.enemyEco() ? 0.6 : 1);
      const heat = this.heat(obs);
      // 情報：一點確認 ≥ 2 人、另一點沒有 → 提早打另一點
      const early = el >= at * 0.5 && Math.abs(heat.A - heat.B) >= 2;
      if (el >= at || early) return { ...p, exec: heat.A < heat.B ? 'A' : heat.B < heat.A ? 'B' : p.site };
    }
    return p;
  }

  /** 對方多半在 eco：上回合我方贏，而且對方連敗補償 ≥ 2 階 */
  enemyEco() {
    return this.econ.lastWon === true && this.econ.enemyLevel >= 2;
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
      if (!this.kitSaid && me.loadout.kit && obs.round.phase !== 'freeze') {
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
    const items = this.econ.items(obs, call, this.roles.of(me.id), this.roles.awper() === me.id);
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

  /** 主力組優先順序（小的先）：角色，其次隊內序號 @param {number} id */
  mainPri(id) {
    return MAIN_PRI[this.roles.of(id)] * 10 + this.slotOf(id);
  }

  /**
   * 分組：主力 3 人（持彈者＋突破手、支援優先）＝ 0、第二組 2 人（游擊、狙擊）＝ 1；rush／go 全隊同組。第一次知道計畫時算好（之後有人陣亡不重分）
   * @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p
   */
  groupOf(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return 0;
    const key = `${p.kind}${p.site}${this.roles.key}`;
    if (this.groups === null || this.groupKey !== key) {
      const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
      const others = this.ids.filter((x) => x !== carrier).sort((a, b) => this.mainPri(a) - this.mainPri(b));
      const main = carrier >= 0 ? [carrier, ...others.slice(0, 2)] : others.slice(0, 3);
      this.groups = new Map(this.ids.map((x) => [x, main.includes(x) ? 0 : 1]));
      this.groupKey = key;
    }
    return this.groups.get(id) ?? 0;
  }

  /** 組內名次（持彈者排最後；其餘依角色：突破手是第 0 個） @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  memberIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
    const list = this.ids.filter((x) => this.groupOf(obs, x, p) === gid).sort((a, b) => (a === carrier ? 1 : 0) - (b === carrier ? 1 : 0) || this.mainPri(a) - this.mainPri(b));
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
    // 出生區裡先讓突破手走到前面（慢走讓他超過；出生區空間大，進了路線就是一列，突破手自然在最前）
    this.slow = obs.round.phase === 'live' && p.kind !== 'go' && this.spawnWait(obs, p, exec ?? setup.site);
    if (this.slow && this.spawnHeld <= P.spawnStop * this.tps) {
      out.stop = true;
      out.role = '讓突破手先走';
      return null;
    }
    if (exec === null) {
      // ── 佈置：走自己組的路線到待命格，看入口；靠近了靜步 ──
      const st = this.memberStage(obs, me.id, p);
      out.route = this.pickRoute(obs, setup.site, setup.route);
      if (st === null) return null;
      out.goal = { x: st.x, y: st.y };
      out.hold = st;
      const d = dist(me.x, me.y, st.x, st.y);
      out.role = p.kind === 'fake' && this.groupOf(obs, me.id, p) === 1 ? '佯攻' : '待命';
      this.awpSettle(obs, out, st);
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
    // 進點前的道具：支援先煙、突破手（組內第 0 個）再閃，2.5 秒還沒人閃就誰有誰閃；其他人等閃光（最多 3 秒）
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = null;
    const sinceExec = this.execTick >= 0 ? (t - this.execTick) / this.tps : 99;
    if (ent !== null && !this.inSite(me.x, me.y, exec, site.cx, site.cy) && dist(me.x, me.y, ent.ox, ent.oy) < 22 * UNIT) {
      const idx = this.memberIndex(obs, me.id, p);
      const role = this.roles.of(me.id);
      const smokeFirst = p.kind !== 'rush' && p.kind !== 'go';
      const st = this.memberStage(obs, me.id, p);
      const near = st !== null && dist(me.x, me.y, st.x, st.y) < 6 * UNIT;
      // 第一顆煙給支援丟：支援活著、還沒人丟煙、執行不到 8 秒時，其他人先不丟
      const supportFirst = role !== SUPPORT && this.isAlive(obs, this.roles.who(SUPPORT)) && this.smokeHeard < 0 && sinceExec < 8;
      if (this.util.has(me, 'smoke') && smokeFirst && idx === this.smokerIndex(obs, me.id, p)) {
        // 封架點；從這裡丟不到就改封入口內側
        const sp = supportFirst ? null : [this.smokePoint(exec, ent), { x: ent.ix, y: ent.iy }].find((q) => q !== null && this.util.solve(me.x, me.y, q.x, q.y) !== null);
        if (sp !== undefined && sp !== null) wish = { kind: 'smoke', x: sp.x, y: sp.y, why: '封架點' };
      } else if (this.util.has(me, 'flash') && (idx === 0 || (sinceExec > 2.5 && this.flashHeard < 0)) && (!smokeFirst || this.smokeHeard >= 0 || this.util.used.has('smoke') || sinceExec > (this.isAlive(obs, this.roles.who(SUPPORT)) ? 4 : 1.5)) && !(role === ENTRY && smokeFirst && !near)) {
        // 突破手只在待命格丟閃（離開了就直接進點，不停下來丟）
        const fp = this.flashPoint(obs, exec, ent, smokeFirst ? 2 : 5);
        // 照計畫執行（隊友在待命格等）照例先閃；其他時候（rush）要可能有人看得到爆點才丟
        if (fp !== null && (smokeFirst || this.viewer(fp, exec))) wish = { kind: 'flash', x: fp.x, y: fp.y, why: '閃進點' };
      }
      // 等閃光：還在待命格附近、閃光還沒丟、執行不到 3 秒
      const pending = this.mateFlash.some((x) => t <= x.pop);
      const waiting = smokeFirst && near && wish === null && (pending || (sinceExec < 3 && this.flashHeard < 0 && !this.util.used.has('flash')));
      // 等突破手先走（狙擊手等兩個人進點）：執行後最多 P.stageLead 秒
      const lead = smokeFirst && near && wish === null && sinceExec < P.stageLead && this.waitEntry(obs, exec);
      // 正在準備丟煙／閃的人也留在待命格（最多到執行後 4 秒，丟不出去就照樣進）
      if ((waiting || lead || (smokeFirst && near && wish !== null && sinceExec < 4)) && st !== null) {
        out.goal = { x: st.x, y: st.y };
        out.hold = st;
        out.role = wish !== null ? '丟道具' : lead && !waiting ? '等突破手先走' : '等閃光';
        this.awpSettle(obs, out, st);
        return wish;
      }
    }
    out.role = `執行 ${exec}`;
    if (p.kind !== 'go' && this.yieldTo(obs, exec)) {
      out.stop = true;
      out.look = { x: site.cx, y: site.cy };
      out.role = this.roles.of(me.id) === AWP ? '等隊友先進' : '等突破手先進';
      return wish;
    }
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

  /** 煙霧手：組內的支援優先，其次錨點、游擊…（同角色看隊內序號） @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  smokerIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const members = this.ids.filter((x) => this.groupOf(obs, x, p) === gid && obs.teammates.every((m) => m.id !== x || m.alive));
    for (const r of SMOKE_PREF) {
      const who = members.find((x) => this.roles.of(x) === r);
      if (who !== undefined) return this.memberIndex(obs, who, p);
    }
    return -1;
  }

  /** 在包點矩形裡 @param {number} x @param {number} y @param {SiteId} s */
  inRectSite(x, y, s) {
    return inRect(this.intel.sites[s].rect, Math.floor(x / UNIT), Math.floor(y / UNIT));
  }

  /**
   * 進點順序：突破手先進——不是突破手的人離包點 P.yieldNear 格內、突破手還沒進點而且沒有明顯在前面，就停住等；
   * 狙擊手等到兩個隊友進點才進。每回合最多停 P.yieldMax 秒
   * @param {import('./base.js').Observation} obs @param {SiteId} s
   */
  yieldTo(obs, s) {
    const me = obs.me;
    const c = this.g.cellOf(me.x, me.y);
    if (c < 0 || this.intel.distSite[s][c] > P.yieldNear * 10 || this.yielded >= P.yieldMax * this.tps) return false;
    const wait = this.waitEntry(obs, s);
    if (wait) this.yielded += this.data.rules.decisionInterval;
    return wait;
  }

  /**
   * 出生區讓位：和突破手同一組（rush 全隊同組）、還在出生區附近（P.spawnLead 格內）、突破手沒有比我靠近目標點 1 格以上 → 先停 P.spawnStop 秒、之後慢走；每回合最多 P.spawnLeadMax 秒
   * @param {import('./base.js').Observation} obs @param {TPlan} p @param {SiteId} s
   */
  spawnWait(obs, p, s) {
    const me = obs.me;
    const e = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
    const c = this.g.cellOf(me.x, me.y);
    if (e === undefined || c < 0 || this.spawnHeld >= P.spawnLeadMax * this.tps || this.intel.distSpawn.T[c] > P.spawnLead * 10) return false;
    if (this.groupOf(obs, e.id, p) !== this.groupOf(obs, me.id, p)) return false;
    const ce = this.g.cellOf(e.x, e.y);
    const dS = this.intel.distSite[s];
    const wait = ce >= 0 && dS[ce] >= dS[c] - 10;
    if (wait) this.spawnHeld += this.data.rules.decisionInterval;
    return wait;
  }

  /** 拿狙擊槍的狙擊手到了待命格 4 格內就站定（守位改成站的地方），讓戰鬥層開鏡架入口 @param {import('./base.js').Observation} obs @param {TacOut} out @param {import('./analysis.js').Spot} st */
  awpSettle(obs, out, st) {
    const me = obs.me;
    if (this.roles.of(me.id) !== AWP || me.loadout.primary !== 'awp' || dist(me.x, me.y, st.x, st.y) >= 4 * UNIT) return;
    out.stop = true;
    out.hold = { ...st, x: me.x, y: me.y };
  }

  /** 該不該等：我不是突破手、還沒進點，突破手活著、沒進點、沒有明顯在我前面；狙擊手等到兩個隊友進點 @param {import('./base.js').Observation} obs @param {SiteId} s */
  waitEntry(obs, s) {
    const me = obs.me;
    const role = this.roles.of(me.id);
    const dS = this.intel.distSite[s];
    const c = this.g.cellOf(me.x, me.y);
    if (role === ENTRY || c < 0 || this.inRectSite(me.x, me.y, s)) return false;
    const mates = obs.teammates.filter((m) => m.alive);
    if (role === AWP) return mates.filter((m) => this.inRectSite(m.x, m.y, s)).length < Math.min(2, mates.length);
    const e = mates.find((m) => m.id === this.roles.who(ENTRY));
    const ce = e === undefined ? -1 : this.g.cellOf(e.x, e.y);
    return e !== undefined && ce >= 0 && !this.inRectSite(e.x, e.y, s) && dS[ce] >= dS[c] - 10;
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

  /** (x, y) 走 depth 步內有沒有看不到爆點 c 的格（BFS） @param {number} x @param {number} y @param {import('./base.js').Pt} c @param {number} depth */
  canHide(x, y, c, depth) {
    const g = this.g;
    const start = g.cellOf(x, y);
    if (start < 0) return false;
    let frontier = [start];
    const seen = new Set(frontier);
    for (let d = 0; d <= depth; d++) {
      /** @type {number[]} */
      const next = [];
      for (const i of frontier) {
        const q = g.center(i);
        if (!g.los(q.x, q.y, c.x, c.y)) return true;
        const cx = i % g.W;
        const cy = (i - cx) / g.W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = (cy + dy) * g.W + cx + dx;
          if (g.isBlock(cx + dx, cy + dy) || seen.has(j)) continue;
          seen.add(j);
          next.push(j);
        }
      }
      frontier = next;
    }
    return false;
  }

  /**
   * 爆點附近可能有敵人看得到：記得的敵人在閃光範圍內有視線、最近聽到的敵方聲音（扇形）經過爆點附近、
   * 或還有下落不明的敵人而包點有沒清過的守點位看得到爆點；都不是就不丟閃光（免得只閃到自己人）
   * @param {import('./base.js').Pt} p @param {SiteId | null} site
   */
  viewer(p, site) {
    const R = this.util.flashRadius;
    if (this.perc.threats(p.x, p.y, 30).some((k) => dist(k.x, k.y, p.x, p.y) < R && this.g.los(k.x, k.y, p.x, p.y))) return true;
    const heard = this.perc.sectors.some((s) => {
      if (s.conf < 25 || s.kind === 'hurt') return false;
      const r = clamp(dist(s.ox, s.oy, p.x, p.y) / UNIT, s.r0, s.r1) * UNIT;
      return dist(s.ox + cosd(s.dir) * r, s.oy + sind(s.dir) * r, p.x, p.y) < R * 0.6;
    });
    if (heard) return true;
    if (site === null) return false;
    // 還有下落不明的敵人，而且包點有守點位看得到爆點、最近沒被我方看過（敵人可能守在那）
    let far = 0;
    for (const k of this.perc.known.values()) if (k.conf >= 30 && dist(k.x, k.y, p.x, p.y) > R * 1.5) far++;
    if (far >= this.enemiesAlive) return false;
    const t = this.perc.lastTick;
    return this.intel.sites[site].holds.some((h) => dist(h.x, h.y, p.x, p.y) < R && !this.perc.cleared(h.cell, t) && this.g.los(h.x, h.y, p.x, p.y));
  }

  /**
   * 閃光爆點：包點區域內、入口內側 8 格內的格，依「看得到它的沒清過的守點位、記得的敵人、聽到聲音的位置」排序（中間隔著我方煙霧的不算），
   * 取第一個從自己的位置丟得到的；排序每回合每個入口算一次
   * @param {import('./base.js').Observation} obs @param {SiteId} s @param {import('./analysis.js').Entrance} e @param {number} ratio
   */
  flashPoint(obs, s, e, ratio) {
    const g = this.g;
    const site = this.intel.sites[s];
    const R = this.util.flashRadius;
    const key = `${s}${e.portal}:${this.smokes.length}`;
    if (this.flashKey !== key) {
      this.flashKey = key;
      const t = this.perc.lastTick;
      const seers = [...site.holds.filter((h) => !this.perc.cleared(h.cell, t)).map((h) => ({ x: h.x, y: h.y, w: 1 })), ...this.perc.threats(e.ix, e.iy, 30).map((k) => ({ x: k.x, y: k.y, w: 2 }))];
      // 聽到的敵方聲音：扇形上離入口一樣遠的那一點
      for (const sc of this.perc.sectors) {
        if (sc.conf < 25 || sc.kind === 'hurt') continue;
        const r = clamp(dist(sc.ox, sc.oy, e.ix, e.iy) / UNIT, sc.r0, sc.r1) * UNIT;
        const q = { x: sc.ox + cosd(sc.dir) * r, y: sc.oy + sind(sc.dir) * r };
        const qc = g.cellOf(q.x, q.y);
        if (qc >= 0 && !g.isWall(qc % g.W, Math.floor(qc / g.W)) && site.regions.has(this.intel.region[qc])) seers.push({ x: q.x, y: q.y, w: 1 });
      }
      /** @type {{ x: number, y: number, sc: number }[]} */
      const list = [];
      const cx = Math.floor(e.ix / UNIT);
      const cy = Math.floor(e.iy / UNIT);
      for (let y = cy - 8; y <= cy + 8; y++) {
        for (let x = cx - 8; x <= cx + 8; x++) {
          if (g.isWall(x, y)) continue;
          const i = y * g.W + x;
          if (!site.regions.has(this.intel.region[i])) continue;
          const c = g.center(i);
          const de = dist(c.x, c.y, e.ix, e.iy);
          if (de > 8 * UNIT || de < 1.5 * UNIT) continue;
          let sc = 0;
          for (const v of seers) {
            if (dist(v.x, v.y, c.x, c.y) > R || !g.los(v.x, v.y, c.x, c.y)) continue;
            if (this.smokes.some((m) => segDist(m.x, m.y, v.x, v.y, c.x, c.y).d < 3 * UNIT)) continue;
            sc += v.w;
          }
          if (sc > 0) list.push({ x: c.x, y: c.y, sc: sc - de / (20 * UNIT) });
        }
      }
      list.sort((a, b) => b.sc - a.sc);
      this.flashList = list.slice(0, 12);
      // 後面接預設：入口內側 2～8 格、從入口外側看得到的格，離「入口往包點中心 4 格」近的先（照常執行時的預設閃）
      {
        const d = Math.max(1, dist(e.ix, e.iy, site.cx, site.cy));
        const f = Math.min(1, (4 * UNIT) / d);
        const ax = e.ix + (site.cx - e.ix) * f;
        const ay = e.iy + (site.cy - e.iy) * f;
        /** @type {{ x: number, y: number, sc: number }[]} */
        const def = [];
        for (let y = cy - 8; y <= cy + 8; y++) {
          for (let x = cx - 8; x <= cx + 8; x++) {
            if (g.isWall(x, y)) continue;
            const i = y * g.W + x;
            const c = g.center(i);
            const de = dist(c.x, c.y, e.ix, e.iy);
            if (!site.regions.has(this.intel.region[i]) || de > 8 * UNIT || de < 2 * UNIT || !g.los(e.ox, e.oy, c.x, c.y)) continue;
            def.push({ x: c.x, y: c.y, sc: 1 - dist(c.x, c.y, ax, ay) / (40 * UNIT) });
          }
        }
        def.sort((a, b) => b.sc - a.sc);
        this.flashList.push(...def.slice(0, 12));
      }
    }
    // 丟得到的候選中取「預期閃到敵人 ÷ 閃到自己人」最好的：敵方算正閃（×6）、己方看得到爆點的人算背閃，
    // 都乘距離係數 1 − d／(2R)；自己丟完 6 步內有看不到爆點的格可以躲就不算自己。比值不到 ratio 就不丟
    // （照計畫執行時隊友在待命格等閃光、收到 E:flash 會躲，用 2；其他時候用 5）
    const me = obs.me;
    const B = this.util.blindRange;
    const mates = obs.teammates.filter((m) => m.alive);
    let best = null;
    let bestS = 0;
    let tries = 0;
    for (const c of this.flashList) {
      if (++tries > 12) break;
      if (this.util.solve(me.x, me.y, c.x, c.y) === null) continue;
      let cost = 0;
      for (const m of mates) {
        const d = dist(m.x, m.y, c.x, c.y);
        // 照計畫執行時隊友收到 E:flash 會躲：4 步內躲得到的不算
        if (d < B && g.los(m.x, m.y, c.x, c.y) && !(ratio < 5 && this.canHide(m.x, m.y, c, 4))) cost += 1 - d / B;
      }
      const hide = this.nav?.escape(obs, (i) => {
        const q = g.center(i);
        return dist(q.x, q.y, c.x, c.y) < B && g.los(q.x, q.y, c.x, c.y);
      }, 6);
      if (hide === null || hide === undefined) cost += 1 - dist(me.x, me.y, c.x, c.y) / B;
      const gain = 6 * c.sc * 0.5;
      if (gain >= ratio * cost && gain - cost > bestS) {
        bestS = gain - cost;
        best = c;
      }
    }
    return best;
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
    // 錨點拿第一個守包位（看 CT 最近的入口）
    const anchor = this.roles.who(ANCHOR);
    const ids = [me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].sort((a, b) => (a === anchor ? -1 : 0) - (b === anchor ? -1 : 0) || a - b);
    const k = Math.max(0, ids.indexOf(me.id));
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
   * CT 守位分配：A 的守點位（a 個）、中路（m 個）、B 的守點位（b 個）；狙擊手（拿狙擊槍的人）拿長對線位。
   * 角色先挑：錨點拿沒有狙擊手的點的第一個位、支援拿第二個位（疊點看主入口）、游擊拿中路、突破手拿狙擊手那一點的第一個位；其餘依隊內序號補
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @returns {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }>}
   */
  ctLayout(obs, p) {
    const key = `${p.a}${p.m}${p.b}${this.awper}${this.roles.key}`;
    if (this.layout !== null && this.layoutKey === key) return this.layout;
    /** 位置：k ＝ 該點的第幾個（中路 −1） @type {{ spot: import('./analysis.js').Spot, site: SiteId | null, k: number }[]} */
    const pos = [];
    const mids = this.midSpots();
    let m = p.m;
    if (mids.length === 0) m = 0;
    const a = p.a + (mids.length === 0 ? Math.ceil(p.m / 2) : 0);
    const b = 5 - a - m;
    this.siteSpots('A', a).forEach((spot, k) => pos.push({ spot, site: 'A', k }));
    for (let i = 0; i < m; i++) pos.push({ spot: mids[i % mids.length], site: null, k: -1 });
    this.siteSpots('B', b).forEach((spot, k) => pos.push({ spot, site: 'B', k }));
    /** @type {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }>} */
    const out = new Map();
    let ids = [...this.ids];
    /** @type {SiteId | null} */
    let snSite = null;
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
        snSite = sn.site;
      }
    }
    /** 角色對位置的偏好（小的好） @type {Record<number, (q: { site: SiteId | null, k: number }) => number>} */
    const pref = {
      [ANCHOR]: (q) => (q.site === null ? 9 : q.k === 0 ? (q.site !== snSite ? 0 : 1) : 2 + q.k),
      [SUPPORT]: (q) => (q.site === null ? 5 : q.k === 1 ? (q.site !== snSite ? 0 : 1) : q.k >= 2 ? 2 : 4),
      [LURK]: (q) => (q.site === null ? 0 : q.k >= 2 ? 1 : q.k === 1 ? 2 : 3),
      [ENTRY]: (q) => (q.site === null ? 3 : q.k === 0 ? (q.site === snSite ? 0 : 1) : 2),
    };
    const free = pos.map(() => true);
    const order = [ANCHOR, SUPPORT, LURK, ENTRY].map((r) => this.roles.who(r)).filter((id) => ids.includes(id));
    for (const id of [...order, ...ids.filter((x) => !order.includes(x))]) {
      const f = pref[this.roles.of(id)] ?? (() => 0);
      let best = -1;
      for (let i = 0; i < pos.length; i++) if (free[i] && (best < 0 || f(pos[i]) < f(pos[best]))) best = i;
      if (best < 0) best = ids.indexOf(id) % Math.max(1, pos.length);
      else free[best] = false;
      const q = pos[best];
      if (q !== undefined) out.set(id, { spot: q.spot, site: q.site });
    }
    this.layout = out;
    this.layoutKey = key;
    return out;
  }

  /** 錨點：點上的錨點角色，否則分到這個點的第一個人 @param {import('./base.js').Observation} obs @param {CTPlan} p @param {SiteId} s */
  anchorOf(obs, p, s) {
    const lay = this.ctLayout(obs, p);
    const an = this.roles.who(ANCHOR);
    if (an >= 0 && lay.get(an)?.site === s && this.isAlive(obs, an)) return an;
    for (const id of this.ids) if (lay.get(id)?.site === s && this.isAlive(obs, id)) return id;
    return -1;
  }

  /** 輪轉時留守：另一點的錨點，或守在點上的錨點角色 @param {import('./base.js').Observation} obs @param {CTPlan} p @param {number} id */
  stays(obs, p, id) {
    if (p.rot === null) return false;
    const site = this.ctLayout(obs, p).get(id)?.site ?? null;
    return this.anchorOf(obs, p, other(p.rot)) === id || (this.roles.of(id) === ANCHOR && site !== null);
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
    // 輪轉：另一點的錨點（與守點的錨點角色）以外全部去輪轉點的待命位（本來就守那點的不動）
    if (p.rot !== null && lay.site !== p.rot && !this.stays(obs, p, me.id)) {
      const stage = this.stageSpots('CT', p.rot, 0);
      const rotators = this.ids.filter((id) => this.isAlive(obs, id) && this.ctLayout(obs, p).get(id)?.site !== p.rot && !this.stays(obs, p, id));
      if (stage.length > 0) {
        spot = stage[Math.max(0, rotators.indexOf(me.id)) % stage.length];
        out.role = `輪轉 ${p.rot}`;
      }
      // 中路的人（游擊）離那一點最近：直接去疊點看主入口（第三個守位），不在待命位等
      if (lay.site === null) {
        const stack = this.siteSpots(p.rot, 3)[2];
        if (stack !== undefined) {
          spot = stack;
          out.role = `輪轉疊點 ${p.rot}`;
        }
      }
    }
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    // 殘局：只剩自己、對方 ≤ 2 人、侵略高 → 主動去最後知道敵人的地方找人（侵略低的守位打時間）
    if (obs.round.phase === 'live' && obs.teammates.every((m) => !m.alive) && obs.enemiesAlive <= 2 && this.attrs.aggression >= P.huntAggr) {
      const th = this.perc.threats(me.x, me.y, 30)[0];
      if (th !== undefined) {
        out.goal = { x: th.x, y: th.y };
        out.hold = null;
        out.role = '殘局找人';
      }
    }
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
    // 隊友已經在拆（而且拆得完）就不保槍，留下來掩護
    const mateDefusing = obs.teammates.some((m) => m.alive && m.defusing) && left > defuseS(this.kits.size > 0) - 0.5;
    if (me.defuseTicks === 0 && !mateDefusing && (left < fastest + 0.5 || outnumbered || this.saving)) {
      this.saving = true;
      const away = this.saveSpot(obs, bx, by);
      if (away !== null) out.goal = away;
      out.role = '保槍';
      return null;
    }
    const inside = this.inSite(me.x, me.y, s, bx, by);
    const stage = this.stageSpots('CT', s, 0);
    const go = p.go || this.plan === null;
    if (go && this.goTick < 0) this.goTick = t;
    // go 之後突破手先進：其他還在待命位的人等他進點（最多 P.retakeLead 秒）
    const entry = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
    const lead = go && entry !== undefined && !this.inSite(entry.x, entry.y, s, bx, by) && t - this.goTick < P.retakeLead * this.tps;
    if ((!go || lead) && !inside && stage.length > 0) {
      const others = this.ids.filter((id) => this.isAlive(obs, id));
      const sp = stage[Math.max(0, others.indexOf(me.id)) % stage.length];
      out.goal = { x: sp.x, y: sp.y };
      out.hold = sp;
      out.role = lead ? '等突破手先進' : '回防集結';
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
    // 掩護：炸彈附近的守點位，看入口；優先 12 格內、看出去的方向不經過炸彈的位置（背對拆包的人）
    const others = this.ids.filter((id) => this.isAlive(obs, id) && id !== defuser.id);
    const k = Math.max(0, others.indexOf(me.id));
    const all = this.postSpots(s, bx, by);
    const away = all.filter((q) => dist(q.x, q.y, bx, by) < 12 * UNIT && Math.abs(adiff(angleTo(q.x, q.y, q.fx, q.fy), angleTo(q.x, q.y, bx, by))) > 70);
    const spots = away.length > 0 ? [...away, ...all.filter((q) => !away.includes(q))] : all;
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
    // 閃光（自己丟的或隊友喊的）：致盲距離內看得到爆點就躲到最近看不到的格（7 步內），沒有就轉身
    const own = this.util.away !== null && t >= this.util.away.from ? this.util.away : null;
    this.mateFlash = this.mateFlash.filter((x) => t <= x.pop + 2);
    const mf = this.mateFlash.find((x) => dist(me.x, me.y, x.x, x.y) < this.util.blindRange && this.g.los(me.x, me.y, x.x, x.y));
    const f = own !== null ? own : mf !== undefined ? { x: mf.x, y: mf.y, until: mf.pop + 2 } : null;
    if (f !== null && t <= f.until && !out.objective) {
      const R = this.util.blindRange;
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
        // 快爆了（反應延遲＋轉身 180° 的時間內）：交戰中也先轉身
        out.hard = f.until - t <= this.data.rules.reactionTicks + 12;
        return;
      }
    }
    // 自己或隊友的閃光還沒爆、自己看不到爆點：先別動（免得走回視線裡）；rush 只在快爆的 0.7 秒內停
    const ownPending = this.util.away !== null && t < this.util.away.until - 3;
    const lead = this.plan?.kind === 'rush' ? Math.round(0.7 * this.tps) : Infinity;
    if (!out.objective && (ownPending || this.mateFlash.some((x) => t < x.pop && x.pop - t <= lead && dist(me.x, me.y, x.x, x.y) < this.util.blindRange))) {
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
    // 離入口近的在前（組內第 0 個＝突破手站最前面，進點不用穿過隊友）
    if (team === 'T') out.sort((a, b) => dist(a.x, a.y, ent.ox, ent.oy) - dist(b.x, b.y, ent.ox, ent.oy) || a.cell - b.cell);
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
      const ctAt = intel.distSpawn.CT[g.cellOf(pick.x, pick.y)];
      out.push(...this.watchSpots(pick.x, pick.y, (i) => intel.distSpawn.CT[i] < ctAt, 2, [], -1));
    }
    this.spotCache.set('mid', out);
    return out;
  }

  /**
   * 看守位：離 (px, py) P.holdMin～P.holdMax 格、看得到它、ok(格) 為真、暴露少、貼牆或矮牆加分；
   * 取 n 個彼此隔 4 格以上、也離 avoid 4 格以上的
   * @param {number} px @param {number} py @param {(i: number) => boolean} ok @param {number} n @param {import('./analysis.js').Spot[]} avoid @param {number} entrance
   * @returns {import('./analysis.js').Spot[]}
   */
  watchSpots(px, py, ok, n, avoid, entrance) {
    const g = this.g;
    const intel = this.intel;
    /** @type {import('./analysis.js').Spot[]} */
    const ranked = [];
    const R = P.holdMax;
    const cx0 = Math.floor(px / UNIT);
    const cy0 = Math.floor(py / UNIT);
    for (let y = cy0 - R; y <= cy0 + R; y++) {
      for (let x = cx0 - R; x <= cx0 + R; x++) {
        if (g.isBlock(x, y)) continue;
        const i = y * g.W + x;
        if (!ok(i)) continue;
        const c = g.center(i);
        const d = dist(c.x, c.y, px, py) / UNIT;
        if (d < P.holdMin || d > P.holdMax || !g.los(c.x, c.y, px, py)) continue;
        const sc = 100 - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 8 : 0) + ((intel.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13);
        ranked.push({ x: c.x, y: c.y, cell: i, fx: px, fy: py, score: sc, entrance });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    for (const s of ranked) {
      if (out.length >= n) break;
      if ([...out, ...avoid].every((o) => dist(o.x, o.y, s.x, s.y) >= 4 * UNIT)) out.push(s);
    }
    return out;
  }

  /**
   * 某點的 CT 守位：前兩個用守點位（最可能來的入口的兩個）；疊到 3 人以上時，多出來的人也看那個入口（看守位另外算）
   * @param {SiteId} s @param {number} n @returns {import('./analysis.js').Spot[]}
   */
  siteSpots(s, n) {
    const key = `site${s}${n}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const site = this.intel.sites[s];
    const holds = site.holds;
    /** @type {import('./analysis.js').Spot[]} */
    let out = holds.slice(0, Math.min(2, n));
    if (n > 2 && holds.length > 0) {
      const ei = Math.max(0, holds[0].entrance);
      const e = site.entrances[ei];
      const field = this.intel.distSite[s];
      out = [...out, ...this.watchSpots(e.x, e.y, (i) => field[i] <= P.holdSiteRadius * 10, n - out.length, out, ei)];
    }
    for (let i = 0; out.length < n && holds.length > 0; i++) out.push(holds[i % holds.length]);
    this.spotCache.set(key, out);
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
