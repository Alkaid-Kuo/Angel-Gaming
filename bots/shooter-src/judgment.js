// @ts-check
// 局勢判斷：用對手也能選的守位／路線推測威脅，只讀地圖與觀察；推測不會產生可開火的敵人。
import { DIR8, P, UNIT, adiff, angleTo, dijkstra, dist } from './base.js';

export class Judgment {
  /** @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./memory.js').Perception} perc @param {import('./base.js').InitData} data */
  constructor(g, intel, perc, data) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.rules = data.rules;
    this.weapons = data.weapons;
    // 換位思考：候選守位與一般牆角；與實際敵人位置無關，普通轉角也會納入。
    this.posts = [...intel.sites.A.holds, ...intel.sites.B.holds, ...intel.chokes.flatMap((p) => p.covers)].map((p) => ({ x: p.x, y: p.y, cell: p.cell }));
    for (let i = 0; i < g.N; i++) {
      if (!g.walkable(i) || intel.cover[i] === 0) continue;
      const p = g.center(i);
      if (this.posts.every((q) => dist(q.x, q.y, p.x, p.y) > 2 * UNIT)) this.posts.push({ ...p, cell: i });
    }
    /** @type {Map<number, number>} */
    this.checked = new Map();
    this.focus = -1;
    this.since = -1;
    this.bombKey = '';
    this.bombField = new Float64Array(0);
    this.escapeKey = '';
    this.escapeField = new Float64Array(0);
    /** @type {Map<number, Float64Array>} */
    this.fields = new Map();
  }

  reset() {
    this.checked.clear();
    this.focus = -1;
    this.since = -1;
    this.bombKey = '';
    this.escapeKey = '';
    this.fields.clear();
  }

  /** 共用目標距離場，供任務期限與隊伍分工；限制快取避免長場記憶體增長。 @param {number} x @param {number} y */
  field(x, y) {
    const cell = this.g.cellOf(x, y);
    let f = this.fields.get(cell);
    if (f === undefined) {
      f = dijkstra(this.g, [cell]);
      if (this.fields.size >= 4) this.fields.delete(/** @type {number} */ (this.fields.keys().next().value));
      this.fields.set(cell, f);
    }
    return f;
  }

  /** @param {{ x: number, y: number, weapon?: string }} m @param {number} x @param {number} y */
  travel(m, x, y) {
    const f = this.field(x, y);
    const speed = (this.weapons.find((w) => w.id === m.weapon)?.speed ?? 130) * this.rules.ticksPerSecond;
    return Math.max(0, (f[this.g.cellOf(m.x, m.y)] ?? Infinity) / 10 * UNIT - 800) / speed + this.rules.reactionTicks / this.rules.ticksPerSecond;
  }

  /** 路徑距離＋正在交火的機會成本，不讓正在壓制的人只因最近就離開火線。 @param {import('./base.js').Observation} obs @param {number} bx @param {number} by */
  retriever(obs, bx, by) {
    const key = `${bx},${by}`;
    if (key !== this.bombKey) {
      this.bombKey = key;
      this.bombField = dijkstra(this.g, [this.g.cellOf(bx, by)]);
    }
    const me = obs.me;
    const team = [{ id: me.id, x: me.x, y: me.y, hp: me.hp, firing: me.shots.length > 0 }, ...obs.teammates.filter((m) => m.alive)];
    const score = (/** @type {typeof team[number]} */ m) => this.bombField[this.g.cellOf(m.x, m.y)] + (m.firing ? 100 : 0) + (m.hp < 30 ? 30 : 0);
    return team.sort((a, b) => score(a) - score(b) || a.id - b.id)[0].id;
  }

  /** 局部預瞄：先看將要露出的角度，再前進。急迫時縮短準備，瞄準到位立即恢復。 @param {import('./base.js').Observation} obs @param {import('./base.js').Pt} ahead @returns {{ look: import('./base.js').Pt | null, stop: boolean, why: string }} */
  approach(obs, ahead) {
    const me = obs.me;
    const g = this.g;
    const out = { look: /** @type {import('./base.js').Pt | null} */ (null), stop: false, why: '' };
    if (obs.enemiesAlive === 0 || me.blindTicks > 0 || obs.round.phase === 'freeze') return out;
    const len = Math.max(1, dist(me.x, me.y, ahead.x, ahead.y));
    const k = Math.min(1, 3000 / len);
    const next = { x: me.x + (ahead.x - me.x) * k, y: me.y + (ahead.y - me.y) * k };
    const deaths = this.perc.anon.filter((p) => p.src === 'death' && obs.tick - p.tick < 4 * this.rules.ticksPerSecond);
    const known = this.perc.threats(me.x, me.y, 30);
    const candidates = [...known.map((p) => ({ ...p, cell: g.cellOf(p.x, p.y), evidence: true })), ...this.posts.map((p) => ({ ...p, evidence: false }))];
    // 最後接敵後，沿合法通路擴大可能範圍；不從牆後的真實狀態補資料。
    for (const p of this.perc.belief.points) if (p.conf >= 20) candidates.push({ ...p, evidence: true });
    let best = -Infinity;
    for (const p of candidates) {
      const d = dist(me.x, me.y, p.x, p.y);
      if (p.cell < 0 || d < UNIT || d > 22 * UNIT || !this.perc.reachable(p.cell, obs.tick, 3)) continue;
      if (Math.abs(adiff(angleTo(me.x, me.y, p.x, p.y), angleTo(me.x, me.y, ahead.x, ahead.y))) > 100) continue;
      const visible = g.los(me.x, me.y, p.x, p.y);
      const opens = !visible && g.los(next.x, next.y, p.x, p.y);
      const recentDeath = deaths.some((q) => dist(q.x, q.y, p.x, p.y) < 16 * UNIT && g.los(q.x, q.y, p.x, p.y));
      if (!p.evidence && !opens && !recentDeath) continue;
      // 「剛看過」不能永遠當安全；隊友附近站著，也不代表他清過這個角度。
      if (!p.evidence && !recentDeath && obs.tick - this.perc.seenTick[p.cell] < this.rules.ticksPerSecond) continue;
      if ((this.checked.get(p.cell) ?? -1) > obs.tick && !p.evidence && !recentDeath) continue;
      // CT 換位思考：從 T 的候選進攻路線找可能出現的方向；T 則評估地圖算出的守位。
      const route = me.team === 'CT' && ['A', 'B'].some((s) => this.intel.routes.T[/** @type {'A' | 'B'} */ (s)].some((r) => r.points.some((q) => dist(q.x, q.y, p.x, p.y) < 4 * UNIT)));
      const score = (p.evidence ? 16 : 0) + (recentDeath ? 10 : 0) + (opens ? 8 : 0) + (route ? 3 : 0) - d / UNIT * 0.3;
      if (score <= best) continue;
      best = score;
      out.look = p;
    }
    if (out.look === null) return out;
    const target = out.look;
    const cell = g.cellOf(target.x, target.y);
    if (cell !== this.focus || deaths.some((p) => p.tick > this.since)) {
      this.focus = cell;
      this.since = obs.tick;
    }
    const ready = Math.abs(adiff(me.facing, angleTo(me.x, me.y, out.look.x, out.look.y))) < 16;
    const soon = { x: me.x + (ahead.x - me.x) * Math.min(1, 1000 / len), y: me.y + (ahead.y - me.y) * Math.min(1, 1000 / len) };
    const exposing = !g.los(me.x, me.y, out.look.x, out.look.y) && g.los(soon.x, soon.y, out.look.x, out.look.y);
    const loss = deaths.some((p) => dist(p.x, p.y, next.x, next.y) < 6 * UNIT && g.los(p.x, p.y, target.x, target.y));
    const hurry = obs.round.phaseTicksLeft < 12 * this.rules.ticksPerSecond;
    out.stop = !ready && (exposing || loss) && obs.tick - this.since < this.rules.ticksPerSecond * (hurry ? 0.25 : 0.65);
    out.why = out.stop ? '先架危險角度' : '預瞄前進';
    if (ready || !out.stop) this.checked.set(cell, obs.tick + 2 * this.rules.ticksPerSecond);
    return out;
  }

  /** 到保守安全圈的真實步行距離，牆後不當成防爆掩護；API 未公布爆炸半徑，沿用既有保槍距離 P.saveDist。 @param {import('./base.js').Observation} obs @param {number} bx @param {number} by */
  evacuation(obs, bx, by) {
    const g = this.g;
    const key = `${bx},${by}`;
    if (key !== this.escapeKey) {
      this.escapeKey = key;
      const safe = [];
      for (let i = 0; i < g.N; i++) {
        if (!g.walkable(i)) continue;
        const p = g.center(i);
        if (dist(p.x, p.y, bx, by) >= P.saveDist * UNIT) safe.push(i);
      }
      this.escapeField = dijkstra(g, safe);
    }
    let i = g.cellOf(obs.me.x, obs.me.y);
    const cost = this.escapeField[i];
    if (!Number.isFinite(cost)) return null;
    /** @type {import('./base.js').Pt | null} */
    let guard = null;
    for (let n = 0; n < g.N && this.escapeField[i] > 0; n++) {
      const p = g.center(i);
      if (dist(p.x, p.y, bx, by) < 14 * UNIT && g.los(p.x, p.y, bx, by)) guard = p;
      const x = i % g.W;
      const y = Math.floor(i / g.W);
      let next = i;
      for (const [dx, dy, c] of DIR8) {
        if (g.isBlock(x + dx, y + dy) || (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy)))) continue;
        const j = (y + dy) * g.W + x + dx;
        if (this.escapeField[j] + c <= this.escapeField[i] + 0.01 && this.escapeField[j] < this.escapeField[next]) next = j;
      }
      if (next === i) return null;
      i = next;
    }
    const speed = this.rules.ticksPerSecond * (this.weapons.find((w) => w.id === obs.me.weapon)?.speed ?? 130);
    return { ...g.center(i), guard, seconds: cost / 10 * UNIT / speed + this.rules.reactionTicks / this.rules.ticksPerSecond + 1 };
  }
}
