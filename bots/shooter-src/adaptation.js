// @ts-check
// 整場內、按己方陣營隔離的對手記憶。僅記錄親眼／雷達確認的行為；未知不當作沒有，少量樣本不改策略。
import { clamp } from './base.js';

/** @typedef {'A' | 'B'} LearnedSite */
/** @typedef {{ team: 'T' | 'CT', site: LearnedSite | null, fast: boolean | null, plan: string, won: boolean, rotated: boolean | null }} RoundSample */
export class Adaptation {
  constructor() {
    /** @type {RoundSample[]} */
    this.history = [];
    /** @type {RoundSample | null} */
    this.sample = null;
    this.round = -1;
    this.start = -1;
    /** @type {Map<number, LearnedSite>} */
    this.locations = new Map();
    /** @type {Map<number, LearnedSite>} */
    this.baitBaseline = new Map();
    this.baitAt = -1;
    this.fakeReason = '';
    this.mine = 0;
    this.theirs = 0;
  }
  /** @param {import('./base.js').Observation} obs @param {boolean | null} won */
  begin(obs, won) {
    if (this.round === obs.round.number) return;
    const mine = obs.me.team === 'T' ? obs.round.scoreT : obs.round.scoreCT;
    const theirs = obs.me.team === 'T' ? obs.round.scoreCT : obs.round.scoreT;
    const result = this.round >= 0 && obs.round.number !== this.round + 1 ? null : won ?? (mine > this.mine ? true : theirs > this.theirs ? false : null);
    if (this.sample !== null && result !== null) {
      this.history.push({ ...this.sample, won: result });
      if (this.history.length > 16) this.history.shift();
    }
    this.sample = { team: obs.me.team, site: null, fast: null, plan: '', won: false, rotated: null };
    this.round = obs.round.number;
    this.mine = mine; this.theirs = theirs;
    this.start = -1;
    this.locations.clear();
    this.baitBaseline.clear();
    this.baitAt = -1;
    this.fakeReason = '';
  }
  /** @param {import('./base.js').Observation} obs @param {import('./memory.js').Perception} perc @param {(cell: number) => LearnedSite | null} siteNear */
  observe(obs, perc, siteNear) {
    if (this.sample === null || obs.round.phase === 'freeze') return;
    if (this.start < 0) this.start = obs.tick;
    const counts = { A: 0, B: 0 };
    for (const k of perc.known.values()) {
      if (k.tick !== obs.tick || k.src === 'tracer') continue;
      const s = siteNear(perc.g.cellOf(k.x, k.y));
      if (s !== null) { this.locations.set(k.id, s); counts[s]++; }
    }
    if (obs.me.team !== 'CT') return;
    const planted = obs.bomb.state === 'planted' || obs.bomb.state === 'defusing';
    const site = planted ? obs.bomb.site : counts.A >= 2 && counts.A > counts.B ? 'A' : counts.B >= 2 && counts.B > counts.A ? 'B' : null;
    if (site !== null) {
      this.sample.site = site;
      if (this.sample.fast === null) this.sample.fast = obs.tick - this.start < 18 * perc.rules.ticksPerSecond;
    }
  }
  /** 至少三回合才偏移；權重按時間衰減，策略倍率有界。 @param {'T' | 'CT'} team */
  advice(team) {
    const samples = this.history.filter((s) => s.team === team);
    const out = { A: 0, B: 0, fast: 0.5, rotation: 0.5, evidence: samples.filter((s) => team === 'CT' ? s.site !== null : s.plan !== '').length, plans: /** @type {Record<string, number>} */ ({}) };
    if (samples.length < 3) return out;
    let sites = 0, tempo = 0, rotations = 0, fast = 0, rotated = 0;
    /** @type {Record<string, { n: number, wins: number }>} */
    const plans = {};
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const w = 0.75 ** (samples.length - 1 - i);
      if (s.site !== null) { out[s.site] += w; sites += w; }
      if (s.fast !== null) { tempo += w; if (s.fast) fast += w; }
      if (s.rotated !== null) { rotations += w; if (s.rotated) rotated += w; }
      if (s.plan !== '') {
        const p = plans[s.plan] ?? { n: 0, wins: 0 };
        p.n += w; if (s.won) p.wins += w; plans[s.plan] = p;
      }
    }
    if (sites > 0) { out.A /= sites; out.B /= sites; }
    out.fast = (fast + 1) / (tempo + 2);
    out.rotation = (rotated + 1) / (rotations + 2);
    for (const [kind, p] of Object.entries(plans)) out.plans[kind] = clamp(1 + ((p.wins + 1.5) / (p.n + 3) - 0.5), 0.75, 1.25);
    return out;
  }
  /** 反應式佯攻：觀察確認敵人移往誘餌點，或已探入空點；無反應時由原計畫期限收尾。 @param {import('./base.js').Observation} obs @param {import('./memory.js').Perception} perc @param {import('./tactics.js').TPlan} plan @param {boolean} probed */
  fake(obs, perc, plan, probed) {
    if (this.baitAt < 0) { this.baitAt = obs.tick; this.baitBaseline = new Map(this.locations); return null; }
    const tps = perc.rules.ticksPerSecond;
    if (obs.tick - this.baitAt < 1.5 * tps) return null;
    const bait = plan.site === 'A' ? 'B' : 'A';
    const counts = { A: 0, B: 0 };
    let moved = 0;
    for (const k of perc.known.values()) {
      if (obs.tick - k.tick > tps || k.conf < 60 || k.src === 'tracer') continue;
      const a = perc.intel.distSite.A[perc.g.cellOf(k.x, k.y)];
      const b = perc.intel.distSite.B[perc.g.cellOf(k.x, k.y)];
      const site = a < b ? 'A' : 'B';
      if (Math.min(a, b) > 180 || Math.abs(a - b) < 50) continue;
      counts[site]++;
      if (site === bait && this.baitBaseline.get(k.id) === plan.site) moved++;
    }
    if (moved > 0 && counts[bait] >= 2 && counts[plan.site] <= 1) {
      if (this.sample !== null) this.sample.rotated = true;
      this.fakeReason = '佯攻牽動輪轉';
      return plan.site;
    }
    if (probed && counts[plan.site] >= 2 && counts[bait] === 0) {
      if (this.sample !== null) this.sample.rotated = false;
      this.fakeReason = '探到空點轉打';
      return bait;
    }
    return null;
  }
}
