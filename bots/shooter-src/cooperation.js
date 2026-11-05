// @ts-check
// 近距離接戰跟進與互補守角。所有協調只用可觀察隊友、雷達與既有戰術目標，沒有共享隱藏狀態。
import { P, UNIT, adiff, angleTo, dist, segDist } from './base.js';

export class Cooperation {
  /** @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./memory.js').Perception} perc @param {import('./base.js').InitData} data */
  constructor(g, intel, perc, data) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.tps = data.rules.ticksPerSecond;
    /** @type {Map<number, boolean>} */
    this.alive = new Map();
    /** @type {Map<number, { x: number, y: number, facing: number, tick: number, dead: boolean }>} */
    this.cues = new Map();
    /** 這次決策接手了補槍／跟進 */
    this.acted = false;
  }
  reset() { this.alive.clear(); this.cues.clear(); }
  /** @param {import('./base.js').Observation} obs */
  observe(obs) {
    for (const m of obs.teammates) {
      if (m.alive && m.firing) this.cues.set(m.id, { x: m.x, y: m.y, facing: m.facing, tick: obs.tick, dead: false });
      if (this.alive.get(m.id) === true && !m.alive) this.cues.set(m.id, { x: m.x, y: m.y, facing: m.facing, tick: obs.tick, dead: true });
      this.alive.set(m.id, m.alive);
    }
    for (const [id, c] of this.cues) if (obs.tick - c.tick > (c.dead ? 2 : 0.9) * this.tps) this.cues.delete(id);
  }
  /** @param {import('./base.js').Observation} obs @param {import('./tactics.js').TacOut} out */
  apply(obs, out) {
    const me = obs.me;
    this.acted = false;
    if (obs.round.phase === 'freeze' || obs.enemiesAlive === 0 || me.blindTicks > 0 || out.objective || out.commit || out.urgent || out.stop || obs.enemies.length > 0) return;
    if (out.task === 'execute' || out.task === 'retake') {
      const cues = [...this.cues].sort((a, b) => b[1].tick - a[1].tick || a[0] - b[0]);
      for (const [id, cue] of cues) {
        const d = dist(me.x, me.y, cue.x, cue.y);
        if (d < 1800 || d > 9 * UNIT || me.hasBomb) continue;
        // 2.7（P.coopEligible）：先篩掉不能支援的人（看不到線索、換彈中的自己），再依距離選；不然隔牆的最近隊友會占住名額
        const able = (/** @type {{ id: number, x: number, y: number }} */ m) => !P.coopEligible || (this.g.los(m.x, m.y, cue.x, cue.y) && (m.id !== me.id || me.reloadTicksLeft === 0));
        const helpers = [{ id: me.id, x: me.x, y: me.y, hasBomb: me.hasBomb, blind: me.blindTicks > 0 }, ...obs.teammates.filter((m) => m.alive && !m.planting && !m.defusing)].filter((m) => m.id !== id && !m.hasBomb && !m.blind && dist(m.x, m.y, cue.x, cue.y) <= 9 * UNIT && able(m)).sort((a, b) => dist(a.x, a.y, cue.x, cue.y) - dist(b.x, b.y, cue.x, cue.y) || a.id - b.id);
        if (helpers[0]?.id !== me.id) continue;
        // 補槍方向來自真實接敵或隊友公開開火方向；沒有接敵時只預瞄，不盲射。
        const target = this.perc.threats(cue.x, cue.y, 45).find((p) => dist(p.x, p.y, cue.x, cue.y) < 18 * UNIT);
        const trace = obs.tracers.find((p) => p.friendly && dist(p.x0, p.y0, cue.x, cue.y) < 1500);
        const look = target ?? (trace === undefined ? null : { x: trace.x1, y: trace.y1 });
        if (look === null || !this.g.los(me.x, me.y, cue.x, cue.y)) continue;
        /** @type {import('./base.js').Pt | null} */
        let best = null;
        let score = -Infinity;
        const center = this.g.cellOf(cue.x, cue.y);
        const cx = center % this.g.W;
        const cy = Math.floor(center / this.g.W);
        for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) {
          const i = y * this.g.W + x;
          if (x < 0 || x >= this.g.W || y < 0 || y >= this.g.H || !this.g.walkable(i)) continue;
          const p = this.g.center(i);
          const gap = dist(p.x, p.y, cue.x, cue.y);
          if ((!cue.dead && gap < 1600) || gap > 4000 || !this.g.walkLine(me.x, me.y, p.x, p.y) || !this.g.los(p.x, p.y, look.x, look.y)) continue;
          if (!cue.dead && segDist(p.x, p.y, cue.x, cue.y, look.x, look.y).d < 1100) continue;
          if (obs.effects.some((e) => e.kind === 'fire' && dist(p.x, p.y, e.x, e.y) < e.radius + 500)) continue;
          let s = (this.intel.cover[i] > 0 ? 2 : 0) - dist(me.x, me.y, p.x, p.y) / UNIT - Math.abs(gap / UNIT - 2.5) - this.perc.danger[i] / 40;
          // 2.7 批 2b（P.tradePen）：補陣亡的隊友偏好換一個角度看殺手（和死者同角度扣分）；只是偏好，沒有別的角照樣補
          if (cue.dead && P.tradePen > 0) s -= P.tradePen * Math.max(0, 1 - Math.abs(adiff(angleTo(p.x, p.y, look.x, look.y), angleTo(cue.x, cue.y, look.x, look.y))) / P.tradeAngle);
          if (s > score) { score = s; best = p; }
        }
        if (best !== null) {
          out.goal = best;
          out.route = null;
          out.hold = null;
          out.look = look;
          out.walk = false;
          out.allowPeek = false;
          out.role += cue.dead ? '・補槍接替' : '・跟進掩護';
          this.acted = true;
          return;
        }
      }
    }
    if (out.hold === null || dist(me.x, me.y, out.hold.x, out.hold.y) > 2500 || out.look !== null) return;
    const confirmed = this.perc.threats(me.x, me.y, 60).find((p) => dist(me.x, me.y, p.x, p.y) < 25 * UNIT && this.g.los(me.x, me.y, p.x, p.y));
    if (confirmed !== undefined) { out.look = { x: confirmed.x, y: confirmed.y }; return; }
    // 大部分時間保留戰鬥層原本的掃描；只短暫分配補充守角，不能盯死出口而漏掉點內接敵。
    if (Math.floor(obs.tick / this.tps) % 3 !== 0) return;
    const site = this.intel.distSite.A[this.g.cellOf(me.x, me.y)] <= this.intel.distSite.B[this.g.cellOf(me.x, me.y)] ? this.intel.sites.A : this.intel.sites.B;
    const team = [{ id: me.id, x: me.x, y: me.y }, ...obs.teammates.filter((m) => m.alive && !m.blind && !m.planting && !m.defusing && dist(m.x, m.y, me.x, me.y) < 16 * UNIT)].sort((a, b) => a.id - b.id);
    const reserved = new Set();
    // 固定 id 順序分配，避免兩人逐幀看對方朝向而同時換角、來回擺頭。
    for (const actor of team) {
      let best = -Infinity;
      let chosen = null;
      for (const e of site.entrances) {
        if (!this.g.los(actor.x, actor.y, e.ox, e.oy) || dist(actor.x, actor.y, e.ox, e.oy) > 30 * UNIT) continue;
        const i = this.g.cellOf(e.ox, e.oy);
        const risk = this.perc.belief.risk[i] ?? 0;
        const sc = (reserved.has(e.portal) ? -6 : 3) + risk / 20 - dist(actor.x, actor.y, e.ox, e.oy) / (20 * UNIT);
        if (sc > best) { best = sc; chosen = e; }
      }
      if (chosen !== null) reserved.add(chosen.portal);
      if (actor.id === me.id) { if (chosen !== null) out.look = { x: chosen.ox, y: chosen.oy }; break; }
    }
    if (out.look !== null) out.role += '・互補守角';
  }
}
