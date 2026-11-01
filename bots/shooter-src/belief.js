// @ts-check
// 失聯敵人的可能區域。路徑可達性與可靠掃描是約束；權重只供規劃，絕不產生開火目標。
import { P, UNIT, dijkstra, dist } from './base.js';

/** @typedef {{ id: number, x: number, y: number, tick: number, conf: number, field: Float64Array | null, cells: Set<number> }} Hypothesis */
export class Belief {
  /** @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./base.js').InitData} data */
  constructor(g, intel, data) {
    this.g = g;
    this.intel = intel;
    this.tps = data.rules.ticksPerSecond;
    /** @type {Map<number, Hypothesis>} */
    this.tracks = new Map();
    /** @type {{ x: number, y: number, cell: number, id: number, conf: number }[]} */
    this.points = [];
    this.risk = new Float32Array(g.N);
    this.regions = new Float32Array(intel.regionCount);
    this.next = -1;
  }
  reset() {
    this.tracks.clear();
    this.points = [];
    this.risk.fill(0);
    this.regions.fill(0);
    this.next = -1;
  }
  /** @param {import('./base.js').Observation} obs @param {import('./memory.js').Perception} perc */
  update(obs, perc) {
    const t = obs.tick;
    if (obs.enemiesAlive === 0) { this.reset(); return; }
    for (const k of perc.known.values()) {
      if (k.tick !== t) continue;
      const old = this.tracks.get(k.id);
      this.points = this.points.filter((p) => p.id !== k.id);
      // 新接敵會收斂到實際觀察，不能沿用上次失聯的可能區域。
      this.tracks.set(k.id, { id: k.id, x: k.x, y: k.y, tick: t, conf: k.conf, field: old !== undefined && this.g.cellOf(k.x, k.y) === this.g.cellOf(old.x, old.y) ? old.field : null, cells: new Set() });
    }
    for (const [id, k] of this.tracks) if (t - k.tick > 6 * this.tps) this.tracks.delete(id);
    if (this.tracks.size > obs.enemiesAlive) {
      const stale = [...this.tracks.values()].filter((k) => k.tick !== t).sort((a, b) => a.tick - b.tick || a.id - b.id);
      while (this.tracks.size > obs.enemiesAlive && stale.length > 0) this.tracks.delete(/** @type {Hypothesis} */ (stale.shift()).id);
    }
    if (t < this.next) return;
    this.next = t + Math.max(1, Math.round(this.tps / 2));
    this.points = [];
    this.risk.fill(0);
    this.regions.fill(0);
    const g = this.g;
    for (const k of this.tracks.values()) {
      const age = (t - k.tick) / this.tps;
      k.cells.clear();
      if (age <= 0) continue;
      if (k.field === null) k.field = dijkstra(g, [g.cellOf(k.x, k.y)], 6 * P.enemySpeed * 10 + 14);
      const reach = age * P.enemySpeed * 10 + 7;
      const conf = k.conf * Math.max(0, 1 - age / 6);
      const mass = new Float64Array(this.regions.length);
      let sum = 0;
      /** @type {Map<number, { x: number, y: number, cell: number, score: number }>} */
      const representatives = new Map();
      for (let i = 0; i < g.N; i++) {
        const d = k.field[i];
        if (d > reach || !Number.isFinite(d)) continue;
        // 只排除剛確認的空格；之後可能重新進入，不能把舊掃描永久當封鎖。
        if (perc.seenTick[i] > k.tick && t - perc.seenTick[i] <= this.tps / 3) continue;
        k.cells.add(i);
        const r = this.intel.region[i];
        const w = 1 / (1 + d / 50);
        if (r >= 0) mass[r] += w;
        sum += w;
        this.risk[i] = Math.max(this.risk[i], conf / (1 + age));
        const p = g.center(i);
        const score = (this.intel.cover[i] > 0 ? 2 : 0) - dist(obs.me.x, obs.me.y, p.x, p.y) / (30 * UNIT) - d / 200;
        if (r >= 0 && score > (representatives.get(r)?.score ?? -Infinity)) representatives.set(r, { ...p, cell: i, score });
      }
      for (let r = 0; r < mass.length; r++) this.regions[r] += sum > 0 ? mass[r] / sum * conf / 100 : 0;
      for (const p of representatives.values()) this.points.push({ x: p.x, y: p.y, cell: p.cell, id: k.id, conf: conf / (1 + age / 2) });
    }
    this.points.sort((a, b) => b.conf - a.conf || a.id - b.id || a.cell - b.cell);
  }
}
