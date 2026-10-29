// @ts-check
// 導航層：自己的格級 A*（成本 = 1 ＋ 危險格加成 ＋ 貼牆加成 − 矮牆旁優惠 ＋ 路線外加成），平滑成路徑點，
// 交給引擎的 move 一點一點走；危險地圖更新後每秒重算，被人擋住（1 秒幾乎沒動，或前方貼著人）就把擋路的人當障礙重算。
// 探頭：路徑前方是沒清過、敵人可能已經到的窄口或包點入口時，先停在轉角外 P.peekStop 格、朝向窄口、靜步，
// 等一下再依侵略度肩探（露一半再退回）或直接過。另有找掩體、離開某點、離開火區的小搜尋。
import { DIR8, Heap, P, UNIT, dist, lerp } from './base.js';

/** @typedef {{ portal: number, hold: import('./base.js').Pt, far: import('./base.js').Pt, cross: import('./base.js').Pt, phase: 'approach' | 'hold' | 'shoulder' | 'back', left: number, since: number }} Peek */
/** @typedef {{ cmds: import('./base.js').Command[], look: import('./base.js').Pt | null, moving: boolean, peeking: boolean, arrived: boolean, walk: boolean }} NavOut */

export class Navigator {
  /**
   * @param {import('./base.js').Grid} g
   * @param {import('./analysis.js').MapIntel} intel
   * @param {import('./memory.js').Perception} perc
   * @param {{ aggression: number, movement: number }} attrs 0～1
   * @param {import('./base.js').InitData} data
   */
  constructor(g, intel, perc, attrs, data) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.attrs = attrs;
    this.tps = data.rules.ticksPerSecond;
    this.heap = new Heap();
    this.gScore = new Float64Array(g.N);
    this.parent = new Int32Array(g.N);
    this.visit = new Int32Array(g.N);
    this.visitId = 0;
    this.extra = new Float32Array(g.N);
    /** 站在矮牆旁、出生區等格的固定成本（不含危險） */
    this.base = new Float32Array(g.N);
    for (let i = 0; i < g.N; i++) {
      if (g.block[i] === 1) continue;
      const c = intel.cover[i];
      this.base[i] = ((c & 1) !== 0 ? P.wallHug : 0) - ((c & 2) !== 0 ? P.lowBonus : 0);
    }
    this.peekHold = Math.round(lerp(P.peekHold0, P.peekHold100, attrs.aggression));
    /** 看得到的火區格（戰鬥層每次更新），A* 視為高成本 @type {Set<number>} */
    this.hazard = new Set();
    /** 上次算路徑時的火區格數（變了就重算） */
    this.hazardSize = 0;
    /** @type {import('./base.js').Pt | null} */
    this.goal = null;
    /** @type {import('./analysis.js').Route | null} */
    this.route = null;
    /** @type {number[]} */
    this.path = [];
    /** @type {import('./base.js').Pt[]} */
    this.wps = [];
    this.wpIdx = 0;
    this.planTick = -1000000;
    this.stuck = 0;
    this.moveStreak = 0;
    /** @type {Set<number> | null} */
    this.avoid = null;
    this.avoidUntil = -1;
    /** 上一個走過的路徑點（被閃時退回去） @type {import('./base.js').Pt | null} */
    this.prevPt = null;
    /** @type {Peek | null} */
    this.peek = null;
    /** @type {Map<number, number>} */
    this.peeked = new Map();
    this.replans = 0;

  }

  reset() {
    /** @type {import('./base.js').Pt | null} */
    this.goal = null;
    /** @type {import('./analysis.js').Route | null} */
    this.route = null;
    /** @type {number[]} */
    this.path = [];
    /** @type {import('./base.js').Pt[]} */
    this.wps = [];
    this.wpIdx = 0;
    this.planTick = -1000000;
    this.stuck = 0;
    this.moveStreak = 0;
    /** @type {Set<number> | null} */
    this.avoid = null;
    this.avoidUntil = -1;
    /** 上一個走過的路徑點（被閃時退回去） @type {import('./base.js').Pt | null} */
    this.prevPt = null;
    /** @type {Peek | null} */
    this.peek = null;
    /** @type {Map<number, number>} */
    this.peeked = new Map();
    this.replans = 0;
  }

  /**
   * 設定目標（同一點半格內不重算）；route 給了就偏好走路線上的區域
   * @param {number} x @param {number} y @param {import('./analysis.js').Route | null} [route]
   */
  setGoal(x, y, route = null) {
    if (this.goal !== null && dist(this.goal.x, this.goal.y, x, y) < 500 && this.route === route) return;
    this.goal = { x, y };
    this.route = route;
    this.path = [];
    this.wps = [];
    this.peek = null;
  }

  clearGoal() {
    this.goal = null;
    this.path = [];
    this.wps = [];
    this.peek = null;
  }

  /**
   * A*：回傳格索引路徑（含起點與終點）；走不到回傳 null
   * @param {number} start @param {number} goal @param {Set<number> | null} avoid
   */
  astar(start, goal, avoid) {
    const g = this.g;
    if (start < 0 || goal < 0) return null;
    const W = g.W;
    const extra = this.extra;
    const danger = this.perc.danger;
    const route = this.route;
    const region = this.intel.region;
    for (let i = 0; i < g.N; i++) {
      if (g.block[i] === 1) continue;
      let e = this.base[i] + danger[i];
      if (route !== null && !route.regionSet.has(region[i])) e += P.offRoute;
      extra[i] = e;
    }
    for (const i of this.hazard) extra[i] += 300;
    const id = ++this.visitId;
    const vis = this.visit;
    const gs = this.gScore;
    const par = this.parent;
    const heap = this.heap;
    heap.clear();
    const gx = goal % W;
    const gy = (goal - gx) / W;
    /** @param {number} i */
    const h = (i) => {
      const dx = Math.abs((i % W) - gx);
      const dy = Math.abs(Math.floor(i / W) - gy);
      return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
    };
    vis[start] = id;
    gs[start] = 0;
    par[start] = -1;
    heap.push(start, h(start));
    while (heap.size > 0) {
      const i = heap.pop();
      const f = heap.lastKey;
      if (f > gs[i] + h(i) + 1e-6) continue;
      if (i === goal) break;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy, c] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (g.isBlock(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
        const j = ny * W + nx;
        if (avoid !== null && j !== goal && (avoid.has(j) || (dx !== 0 && dy !== 0 && (avoid.has(y * W + x + dx) || avoid.has((y + dy) * W + x))))) continue;
        const ng = gs[i] + c + Math.max(-c / 2, extra[j]);
        if (vis[j] !== id || ng < gs[j]) {
          vis[j] = id;
          gs[j] = ng;
          par[j] = i;
          heap.push(j, ng + h(j));
        }
      }
    }
    if (vis[goal] !== id) return null;
    /** @type {number[]} */
    const out = [];
    for (let i = goal; i >= 0; i = par[i]) out.push(i);
    out.reverse();
    return out;
  }

  /** 直線走得過去，而且不經過 avoid 的格 @param {import('./base.js').Pt} a @param {import('./base.js').Pt} b @param {Set<number> | null} avoid */
  lineOK(a, b, avoid) {
    const g = this.g;
    if (!g.walkLine(a.x, a.y, b.x, b.y)) return false;
    if (avoid === null || avoid.size === 0) return true;
    const len = dist(a.x, a.y, b.x, b.y);
    if (len < 1) return !avoid.has(g.cellOf(a.x, a.y));
    // 身體半徑加裕度：左右 0.4 格的平行線也不能碰到
    const px = (-(b.y - a.y) / len) * 400;
    const py = ((b.x - a.x) / len) * 400;
    const steps = Math.max(1, Math.ceil(len / 250));
    for (let k = 0; k <= steps; k++) {
      const x = a.x + ((b.x - a.x) * k) / steps;
      const y = a.y + ((b.y - a.y) * k) / steps;
      for (const o of [0, 1, -1]) if (avoid.has(g.cellOf(x + px * o, y + py * o))) return false;
    }
    return true;
  }

  /** 路徑平滑：直線走得過去（不經過 avoid、火區）就跳過中間的格，每段不超過 P.maxSegment 格 @param {number[]} path @param {Set<number> | null} avoid @param {import('./base.js').Pt} from 起點（自己的位置） @returns {import('./base.js').Pt[]} */
  smooth(path, avoid, from) {
    const g = this.g;
    /** @type {Set<number> | null} */
    let bad = avoid;
    if (this.hazard.size > 0) bad = new Set([...(avoid ?? []), ...this.hazard]);
    /** @type {import('./base.js').Pt[]} */
    const out = [];
    let i = 0;
    const maxJ = Math.round(P.maxSegment * 1.2);
    while (i < path.length - 1) {
      const a = i === 0 ? from : g.center(path[i]);
      let j = Math.min(path.length - 1, i + maxJ);
      for (; j > i + 1; j--) {
        const b = g.center(path[j]);
        if (dist(a.x, a.y, b.x, b.y) <= P.maxSegment * UNIT && this.lineOK(a, b, bad)) break;
      }
      out.push(g.center(path[j]));
      i = j;
    }
    return out;
  }

  /** @param {import('./base.js').Observation} obs @param {Set<number> | null} avoid */
  plan(obs, avoid) {
    const me = obs.me;
    const goal = /** @type {import('./base.js').Pt} */ (this.goal);
    const g = this.g;
    let start = g.cellOf(me.x, me.y);
    if (!g.walkable(start)) start = this.intel.nearestOpen(Math.floor(me.x / UNIT), Math.floor(me.y / UNIT));
    let gc = g.cellOf(goal.x, goal.y);
    if (!g.walkable(gc)) gc = this.intel.nearestOpen(Math.floor(goal.x / UNIT), Math.floor(goal.y / UNIT));
    this.replans++;
    const path = this.astar(start, gc, avoid) ?? (avoid !== null ? this.astar(start, gc, null) : null);
    this.planTick = obs.tick;
    if (path === null) {
      this.path = [];
      this.wps = [{ x: goal.x, y: goal.y }];
      this.wpIdx = 0;
      return;
    }
    this.path = path;
    const wps = this.smooth(path, avoid, { x: me.x, y: me.y });
    this.hazardSize = this.hazard.size;
    if (wps.length > 0) wps[wps.length - 1] = { x: goal.x, y: goal.y };
    else wps.push({ x: goal.x, y: goal.y });
    this.wps = wps;
    this.wpIdx = 0;
  }

  /**
   * 每次決策：沿路徑走（含探頭）
   * @param {import('./base.js').Observation} obs
   * @param {{ allowPeek: boolean, speed: number }} opts
   * @returns {NavOut}
   */
  step(obs, opts) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {NavOut} */
    const out = { cmds: [], look: null, moving: false, peeking: false, arrived: false, walk: false };
    if (this.goal === null) {
      this.moveStreak = 0;
      return out;
    }
    const goal = this.goal;
    if (dist(me.x, me.y, goal.x, goal.y) < 450) {
      out.arrived = true;
      this.moveStreak = 0;
      this.stuck = 0;
      this.peek = null;
      return out;
    }
    const freeze = obs.round.phase === 'freeze';
    // ── 被擋住：連續幾乎沒動 ──
    const still = Math.abs(me.vx) + Math.abs(me.vy) < opts.speed * 0.25;
    const holding = this.peek !== null && this.peek.phase === 'hold';
    if (!freeze && !holding && this.moveStreak >= 3 && still) this.stuck++;
    else this.stuck = 0;
    let avoid = this.avoid !== null && t < this.avoidUntil ? this.avoid : null;
    const blockedAhead = this.stuck >= 4 && this.personAhead(obs);
    if (this.stuck >= P.stuckDecisions || blockedAhead) {
      avoid = this.peopleCells(obs);
      this.avoid = avoid;
      this.avoidUntil = t + 2 * this.tps;
      this.stuck = 0;
      this.peek = null;
      this.plan(obs, avoid);
    }
    // ── 重算：沒有路徑、危險地圖更新且超過間隔、偏離路徑 ──
    const wp = this.wps[this.wpIdx];
    const off = wp !== undefined && dist(me.x, me.y, wp.x, wp.y) > 4 * UNIT && !this.g.walkLine(me.x, me.y, wp.x, wp.y);
    if (this.wps.length === 0 || off || this.hazard.size !== this.hazardSize || (this.perc.dangerTick > this.planTick && t - this.planTick >= P.replanTicks)) this.plan(obs, avoid);
    // ── 前進路徑點 ──
    while (this.wpIdx < this.wps.length - 1) {
      const p = this.wps[this.wpIdx];
      if (dist(me.x, me.y, p.x, p.y) >= P.waypointReach) break;
      this.prevPt = p;
      this.wpIdx++;
    }
    let target = this.wps[this.wpIdx];
    // ── 探頭 ──
    if (!opts.allowPeek || freeze) this.peek = null;
    else {
      if (this.peek === null) this.peek = this.findPeek(obs);
      if (this.peek !== null) {
        const pk = this.peek;
        const dHold = dist(me.x, me.y, pk.hold.x, pk.hold.y);
        if (dHold > 9 * UNIT || t - pk.since > 8 * this.tps) {
          this.peeked.set(pk.portal, t);
          this.peek = null;
        } else {
          out.peeking = true;
          out.look = pk.far;
          out.walk = true;
          if (pk.phase === 'approach') {
            target = pk.hold;
            if (dHold < 700) {
              pk.phase = 'hold';
              pk.left = this.peekHold;
            }
          }
          if (pk.phase === 'hold') {
            target = pk.hold;
            if (--pk.left <= 0) {
              if (this.attrs.aggression * 100 < P.shoulderBelow) {
                pk.phase = 'shoulder';
                pk.left = 3;
              } else {
                this.peeked.set(pk.portal, t);
                this.peek = null;
              }
            }
          } else if (pk.phase === 'shoulder') {
            target = pk.cross;
            if (--pk.left <= 0) {
              pk.phase = 'back';
              pk.left = 3;
            }
          } else if (pk.phase === 'back') {
            target = pk.hold;
            if (--pk.left <= 0) {
              this.peeked.set(pk.portal, t);
              this.peek = null;
            }
          }
        }
      }
    }
    if (this.peek !== null && this.peek.phase === 'hold' && dist(me.x, me.y, this.peek.hold.x, this.peek.hold.y) < 700) {
      out.cmds.push({ type: 'stop' });
      this.moveStreak = 0;
      out.moving = false;
      return out;
    }
    out.cmds.push({ type: 'move', x: Math.round(target.x), y: Math.round(target.y) });
    this.moveStreak++;
    out.moving = true;
    return out;
  }

  /** 有活人貼在前進方向 1 格內 @param {import('./base.js').Observation} obs */
  personAhead(obs) {
    const me = obs.me;
    const wp = this.wps[this.wpIdx];
    if (wp === undefined) return false;
    const len = dist(me.x, me.y, wp.x, wp.y);
    if (len < 1) return false;
    const ux = (wp.x - me.x) / len;
    const uy = (wp.y - me.y) / len;
    /** @param {number} x @param {number} y */
    const ahead = (x, y) => {
      const along = (x - me.x) * ux + (y - me.y) * uy;
      const side = Math.abs((x - me.x) * uy - (y - me.y) * ux);
      return along > 0 && along < 1100 && side < 700;
    };
    return obs.teammates.some((m) => m.alive && ahead(m.x, m.y)) || obs.enemies.some((e) => ahead(e.x, e.y));
  }

  /** 其他活人周圍 1 格（自己的格除外）：被擋住時當障礙 @param {import('./base.js').Observation} obs */
  peopleCells(obs) {
    const g = this.g;
    /** @type {Set<number>} */
    const s = new Set();
    const mine = g.cellOf(obs.me.x, obs.me.y);
    const people = [...obs.teammates.filter((m) => m.alive), ...obs.enemies];
    for (const q of people) {
      if (dist(q.x, q.y, obs.me.x, obs.me.y) > 8 * UNIT) continue;
      const cx = Math.floor(q.x / UNIT);
      const cy = Math.floor(q.y / UNIT);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = (cy + dy) * g.W + cx + dx;
          if (i === mine || !g.walkable(i)) continue;
          // 只擋和身體重疊（格中心離人 < 0.9 格）的格，自己旁邊留出路
          const c = g.center(i);
          if (dist(c.x, c.y, q.x, q.y) < 900 && dist(c.x, c.y, obs.me.x, obs.me.y) > 1000) s.add(i);
        }
      }
    }
    return s;
  }

  /**
   * 路徑前方 12 格內第一個要探頭的交界（窄口或包點入口）：敵人可能已經到、對面沒清過、對面 6 格內沒有隊友、最近 15 秒沒探過
   * @param {import('./base.js').Observation} obs
   * @returns {Peek | null}
   */
  findPeek(obs) {
    const g = this.g;
    const me = obs.me;
    const t = obs.tick;
    const path = this.path;
    if (path.length < 4) return null;
    const mine = g.cellOf(me.x, me.y);
    let k = path.indexOf(mine);
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
    const region = this.intel.region;
    for (let i = Math.max(k, 0); i < Math.min(path.length - 1, k + 12); i++) {
      if (region[path[i]] === region[path[i + 1]]) continue;
      const pid = this.intel.portalAt[path[i]] >= 0 ? this.intel.portalAt[path[i]] : this.intel.portalAt[path[i + 1]];
      if (pid < 0) continue;
      const portal = this.intel.portals[pid];
      if (!portal.choke && !this.isEntrance(pid)) continue;
      const last = this.peeked.get(pid);
      if (last !== undefined && t - last < 15 * this.tps) continue;
      const farIdx = Math.min(path.length - 1, i + 3);
      const far = g.center(path[farIdx]);
      if (!this.perc.reachable(path[farIdx], t, 4) || this.perc.cleared(path[farIdx], t)) continue;
      if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, far.x, far.y) < 6 * UNIT)) continue;
      const holdIdx = Math.max(k, i - P.peekStop);
      if (holdIdx === k && i - k < P.peekStop) {
        // 已經太近：不退回，直接記為探過
        this.peeked.set(pid, t);
        continue;
      }
      const lookIdx = Math.min(path.length - 1, i + 6);
      return { portal: pid, hold: g.center(path[holdIdx]), far: g.center(path[lookIdx]), cross: g.center(path[i]), phase: 'approach', left: 0, since: t };
    }
    return null;
  }

  /** @param {number} pid */
  isEntrance(pid) {
    return this.intel.sites.A.entrances.some((e) => e.portal === pid) || this.intel.sites.B.entrances.some((e) => e.portal === pid);
  }

  /**
   * 找掩體：自己周圍 P.coverRadius 格內（可走、走得到），對每個威脅點都沒有視線的格；取路徑最近的
   * @param {import('./base.js').Observation} obs @param {readonly import('./base.js').Pt[]} threats
   * @returns {import('./base.js').Pt | null}
   */
  findCover(obs, threats) {
    if (threats.length === 0) return null;
    const g = this.g;
    const start = g.cellOf(obs.me.x, obs.me.y);
    if (start < 0) return null;
    const W = g.W;
    /** @type {number[]} */
    const queue = [start];
    const depth = new Map([[start, 0]]);
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const d = /** @type {number} */ (depth.get(i));
      const p = g.center(i);
      if (i !== start && threats.every((th) => !g.los(th.x, th.y, p.x, p.y))) return p;
      if (d >= P.coverRadius) continue;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (g.isBlock(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
        const j = ny * W + nx;
        if (depth.has(j)) continue;
        depth.set(j, d + 1);
        queue.push(j);
      }
    }
    return null;
  }

  /**
   * 離開：走得到的格中，離 bad(格) 為假且最近的；bad 為 null 時改找離 (fx, fy) 至少 r 格的最近格
   * @param {import('./base.js').Observation} obs @param {(i: number) => boolean} bad @param {number} maxDepth
   * @returns {import('./base.js').Pt | null}
   */
  escape(obs, bad, maxDepth) {
    const g = this.g;
    const start = g.cellOf(obs.me.x, obs.me.y);
    if (start < 0) return null;
    const W = g.W;
    /** @type {number[]} */
    const queue = [start];
    const depth = new Map([[start, 0]]);
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const d = /** @type {number} */ (depth.get(i));
      if (!bad(i)) return g.center(i);
      if (d >= maxDepth) continue;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (g.isBlock(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
        const j = ny * W + nx;
        if (depth.has(j)) continue;
        depth.set(j, d + 1);
        queue.push(j);
      }
    }
    return null;
  }
}
