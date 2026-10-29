// @ts-check
// 戰術層（回合開始＋每次決策檢查事件）。6-1 是最簡版本，6-2 在這裡擴充（計畫種類、經濟、道具、輪轉、殘局）：
// - 指揮：活著的最小 playerId；凍結時間廣播本回合計畫，指揮死了由下一個接手並重播。格式：
//   T：「P:go <A|B> <路線序號>」（全隊跟指揮去同一個點、走同一條路線）；CT：「P:hold A=<人數> B=<人數>」。
//   沒收到計畫前照預設（T 等計畫、開打後還沒有就自己選；CT 依隊內序號分點）。
// - T：持彈者去下包位下包，其他人去包點守位；炸彈掉了最近的人去撿；下包後守在炸彈附近。
// - CT：隊內序號 < P.ctSplitA 守 A、其餘守 B（同陪練的 3／2），各自到守點位；炸彈下了全員回去，最近的人拆。
// - 購買（各買各的）：全買／半買／eco；狙擊手錢夠買狙擊槍；手槍局買護甲；備彈不到一半補彈藥。
import { P, UNIT, dist, inRect } from './base.js';

/** @typedef {{ kind: 'go', site: 'A' | 'B', route: number } | { kind: 'hold', a: number }} Plan */
/**
 * 戰術輸出：goal 目標點、route 偏好路線、hold 守位（到了要看哪裡）、objective 正在下包／拆包、allowPeek 可以探頭、cmds 購買／喊話／下包／拆包
 * @typedef {{ goal: import('./base.js').Pt | null, route: import('./analysis.js').Route | null, hold: import('./analysis.js').Spot | null, objective: boolean, allowPeek: boolean, cmds: import('./base.js').Command[], role: string }} TacOut
 */

/** 解析計畫字串 @param {string} text @returns {Plan | null} */
export function parsePlan(text) {
  const go = /^P:go ([AB]) (\d+)$/.exec(text);
  if (go !== null) return { kind: 'go', site: /** @type {'A' | 'B'} */ (go[1]), route: Number(go[2]) };
  const hold = /^P:hold A=(\d) B=(\d)$/.exec(text);
  if (hold !== null) return { kind: 'hold', a: Number(hold[1]) };
  return null;
}

/** @param {Plan} p */
export function planText(p) {
  return p.kind === 'go' ? `P:go ${p.site} ${p.route}` : `P:hold A=${p.a} B=${5 - p.a}`;
}

export class Tactics {
  /**
   * @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./memory.js').Perception} perc
   * @param {import('./base.js').InitData} data @param {import('./base.js').Helpers} h
   * @param {{ awpSlot: number, economy: number, ctSplitA: number }} opts
   */
  constructor(g, intel, perc, data, h, opts) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.data = data;
    this.h = h;
    this.opts = opts;
    this.tps = data.rules.ticksPerSecond;
    /** @type {Map<string, number>} */
    this.price = new Map(data.weapons.map((w) => [w.id, w.price]));
    for (const n of data.grenades) this.price.set(n.id, n.price);
    /** @type {Plan | null} */
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.bought = false;
    /** 本回合因危險換掉的路線（−1 = 照計畫） */
    this.routeOverride = -1;
  }

  reset() {
    /** @type {Plan | null} */
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.bought = false;
    /** 本回合因危險換掉的路線（−1 = 照計畫） */
    this.routeOverride = -1;
  }

  /** 活著的最小 playerId（含自己） @param {import('./base.js').Observation} obs */
  commanderOf(obs) {
    let c = obs.me.alive ? obs.me.id : Infinity;
    for (const m of obs.teammates) if (m.alive && m.id < c) c = m.id;
    return Number.isFinite(c) ? c : -1;
  }

  /** @param {import('./base.js').Observation} obs @returns {Plan} */
  choosePlan(obs) {
    if (obs.me.team === 'CT') return { kind: 'hold', a: this.opts.ctSplitA };
    const site = this.h.random() < 0.5 ? 'A' : 'B';
    return { kind: 'go', site, route: 0 };
  }

  /**
   * @param {import('./base.js').Observation} obs
   * @returns {TacOut}
   */
  update(obs) {
    const me = obs.me;
    /** @type {TacOut} */
    const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '' };
    // ── 計畫：收喊話；指揮就決定並廣播（指揮換人時重播）──
    const cmd = this.commanderOf(obs);
    for (const c of obs.chat) {
      const p = parsePlan(c.text);
      // 只有 id 比自己小的人（指揮或剛陣亡的指揮）能下計畫
      if (p !== null && c.from < me.id && (p.kind === 'go') === (me.team === 'T')) this.plan = p;
    }
    if (cmd === me.id) {
      if (this.plan === null) this.plan = this.choosePlan(obs);
      if (this.saidAs !== cmd) {
        out.cmds.push({ type: 'say', text: planText(this.plan) });
        this.saidAs = cmd;
      }
    }
    if (this.plan === null && obs.round.phase !== 'freeze') this.plan = this.choosePlan(obs);
    this.commander = cmd;
    if (obs.round.canBuy && !this.bought) {
      this.buy(obs, out.cmds);
      this.bought = true;
    }
    const live = obs.round.phase === 'live';
    out.allowPeek = live && obs.round.phaseTicksLeft > 25 * this.tps;
    if (me.team === 'T') this.tGoal(obs, out);
    else this.ctGoal(obs, out);
    return out;
  }

  /** 同陣營活人依 id 排序後自己的名次 @param {import('./base.js').Observation} obs @param {(id: number) => boolean} [filter] */
  rank(obs, filter = () => true) {
    const ids = [obs.me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].filter(filter).sort((a, b) => a - b);
    return Math.max(0, ids.indexOf(obs.me.id));
  }

  /** @param {import('./base.js').Observation} obs @param {TacOut} out */
  tGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    const plan = this.plan !== null && this.plan.kind === 'go' ? this.plan : null;
    // 下包後：守在炸彈附近
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      const site = this.intel.sites[b.site ?? 'A'];
      out.hold = this.nearSpot(site, b.x, b.y, this.rank(obs));
      out.goal = out.hold ?? { x: b.x, y: b.y };
      out.role = '守包';
      out.allowPeek = false;
      return;
    }
    // 炸彈掉了：最近的 T 去撿（引擎走到旁邊自動撿）
    if (b.state === 'dropped' && b.x !== null && b.y !== null) {
      const bx = b.x;
      const by = b.y;
      const myD = dist(me.x, me.y, bx, by);
      if (!obs.teammates.some((m) => m.alive && dist(m.x, m.y, bx, by) < myD)) {
        out.goal = { x: bx, y: by };
        out.role = '撿炸彈';
        return;
      }
    }
    if (plan === null) return;
    const site = this.intel.sites[plan.site];
    out.route = this.pickRoute(obs, plan);
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
      return;
    }
    const k = this.rank(obs, (id) => id !== this.carrierId(obs));
    const holds = site.holds;
    const spot = holds.length > 0 ? holds[k % holds.length] : site.plants[0];
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    out.role = '進點';
  }

  /**
   * 路線：照計畫；還在出生區附近而計畫的路線上有危險（交界點的危險格成本高），就換最安全的另一條（本回合記住）
   * @param {import('./base.js').Observation} obs @param {{ site: 'A' | 'B', route: number }} plan
   */
  pickRoute(obs, plan) {
    const routes = this.intel.routes.T[plan.site];
    if (routes.length === 0) return null;
    const idx = this.routeOverride >= 0 ? this.routeOverride : Math.min(plan.route, routes.length - 1);
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

  /** @param {import('./base.js').Observation} obs @param {TacOut} out */
  ctGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      const bx = b.x;
      const by = b.y;
      out.allowPeek = false;
      const myD = dist(me.x, me.y, bx, by);
      const closest = !obs.teammates.some((m) => m.alive && (m.defusing || dist(m.x, m.y, bx, by) < myD - 100));
      if (closest || me.defuseTicks > 0) {
        out.goal = { x: bx, y: by };
        out.role = '拆包';
        if (myD < 1300 && b.state === 'planted' && me.defuseTicks === 0 && obs.enemies.length === 0) {
          out.cmds.push({ type: 'defuse' });
          out.objective = true;
        }
        return;
      }
      const site = this.intel.sites[b.site ?? 'A'];
      out.hold = this.nearSpot(site, bx, by, this.rank(obs));
      out.goal = out.hold ?? { x: bx, y: by };
      out.role = '回防';
      return;
    }
    const split = this.plan !== null && this.plan.kind === 'hold' ? this.plan.a : this.opts.ctSplitA;
    const siteId = this.data.slot < split ? 'A' : 'B';
    const site = this.intel.sites[siteId];
    const k = siteId === 'A' ? this.data.slot : this.data.slot - split;
    const spot = site.holds.length > 0 ? site.holds[k % site.holds.length] : site.plants[0];
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    out.role = `守 ${siteId}`;
  }

  /** 炸彈附近（12 格內）的守點位或下包位，依名次分配；沒有就 null @param {import('./analysis.js').SiteIntel} site @param {number} x @param {number} y @param {number} k */
  nearSpot(site, x, y, k) {
    const list = [...site.holds, ...site.plants].filter((s) => dist(s.x, s.y, x, y) < 12 * UNIT);
    if (list.length === 0) return null;
    const s = list[k % list.length];
    return { ...s, fx: s.entrance >= 0 ? s.fx : x, fy: s.entrance >= 0 ? s.fy : y };
  }

  /** @param {string} id */
  cost(id) {
    return this.price.get(id) ?? Infinity;
  }

  /**
   * 購買（各買各的）：全買／半買／eco
   * @param {import('./base.js').Observation} obs @param {import('./base.js').Command[]} cmds
   */
  buy(obs, cmds) {
    const me = obs.me;
    const rules = this.data.rules;
    const money = me.money;
    const rifle = me.team === 'T' ? 'ak' : 'm4';
    const primary = me.loadout.primary;
    const needArmor = me.loadout.armor < rules.maxArmor;
    /** @type {import('./base.js').BuyItem[]} */
    const items = [];
    const hasGood = primary !== null && this.cost(primary) >= this.cost('smg') + 1000;
    const awper = this.data.slot === this.opts.awpSlot && money >= this.cost('awp') + rules.armorPrice + 200;
    const full = this.cost(rifle) + rules.armorPrice + (me.team === 'CT' ? rules.kitPrice : 0);
    const eco = this.opts.economy;
    if (awper && primary !== 'awp') {
      items.push('awp');
      if (needArmor) items.push('armor');
      if (me.team === 'CT' && !me.loadout.kit) items.push('kit');
      items.push('flash');
    } else if (hasGood || money >= full - (eco === 2 ? 400 : 0)) {
      if (!hasGood) items.push(rifle);
      if (needArmor) items.push('armor');
      if (me.team === 'CT' && !me.loadout.kit) items.push('kit');
      items.push('flash');
      if (me.team === 'T') items.push('smoke');
    } else if (eco !== 1 && money >= this.cost('smg') + rules.armorPrice + (eco === 2 ? 0 : 500)) {
      if (primary === null) items.push('smg');
      if (needArmor) items.push('armor');
    } else if (money <= rules.economy.startMoney + 100 && primary === null) {
      // 手槍局（或錢很少）：只買護甲
      if (needArmor) items.push('armor');
    }
    const w = this.data.weapons.find((x) => x.id === (primary ?? me.weapon));
    if (w !== undefined && w.reserve > 0 && me.ammoReserve < w.reserve / 2 && me.weapon === w.id) items.push('ammo');
    if (items.length > 0) cmds.push({ type: 'buy', items });
  }
}
