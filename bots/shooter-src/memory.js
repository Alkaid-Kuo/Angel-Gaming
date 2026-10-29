// @ts-check
// 感知層（每次決策）：把 enemies／radar／tracers／sounds／me.hurt／隊友陣亡整合成敵情記憶。
// 看到的敵人記 id 與位置；雷達記位置；彈道起點、隊友陣亡處記成不知道是誰的點；聲音與受傷只有方向與遠近，記成扇形不記點。
// 信心每秒衰減（警覺高衰得慢），低於門檻就是「未確認」；敵人數以 enemiesAlive 校正。
// 另外維護「已清空」格（自己或隊友的視錐掃過的時間）與每秒重算的危險格成本（導航用）。
import { P, UNIT, adiff, angleTo, cosd, dist, lerp, sind } from './base.js';

/** 有 id 的敵人 @typedef {{ id: number, x: number, y: number, vx: number, vy: number, facing: number, weapon: string, tick: number, seenTick: number, conf: number, src: 'see' | 'radar' | 'tracer' }} Known */
/** 不知道是誰的點：彈道起點、隊友陣亡處（敵人看得到這裡） @typedef {{ x: number, y: number, tick: number, conf: number, src: 'tracer' | 'death' }} Anon */
/** 扇形：從 (ox, oy) 朝 dir ± P.sectorHalfDeg、距離 r0～r1 格 @typedef {{ ox: number, oy: number, dir: number, r0: number, r1: number, tick: number, conf: number, kind: string }} Sector */
/** @typedef {{ x: number, y: number, conf: number, src: string, id: number }} Threat */

const BANDS = { near: P.bandNear, mid: P.bandMid, far: P.bandFar };
const ENEMY_SOUNDS = new Set(['footstep', 'shot', 'reload', 'plant', 'defuse']);

export class Perception {
  /**
   * @param {import('./base.js').Grid} g
   * @param {import('./analysis.js').MapIntel} intel
   * @param {import('./base.js').InitData} data
   * @param {number} awareness 0～1
   */
  constructor(g, intel, data, awareness) {
    this.g = g;
    this.intel = intel;
    this.rules = data.rules;
    this.awareness = awareness;
    this.decay = lerp(P.decay0, P.decay100, awareness);
    this.trust = lerp(P.trust0, P.trust100, awareness);
    this.clearTtl = Math.round(lerp(P.clearTtl0, P.clearTtl100, awareness) * data.rules.ticksPerSecond);
    /** @type {Map<number, Known>} */
    this.known = new Map();
    /** @type {Anon[]} */
    this.anon = [];
    /** @type {Sector[]} */
    this.sectors = [];
    this.seenTick = new Int32Array(g.N).fill(-1000000);
    this.danger = new Float32Array(g.N);
    this.stamp = new Int32Array(g.N);
    this.stampId = 0;
    /** 每個交界的威脅信心 */
    this.portalThreat = new Float32Array(intel.portals.length);
    /** 每個區域最近被看過的格的比例 */
    this.regionSeen = new Float32Array(intel.regionCount);
    this.dangerTick = -1000000;
    this.dangerDirty = true;
    this.lastTick = -1;
    this.updates = 0;
    /** @type {Map<number, boolean>} */
    this.mateAlive = new Map();
    /** 回合開打的 tick（判斷敵人最快可能到哪裡） */
    this.liveStart = -1;
    /** 這次更新的事件 */
    /** @type {{ dir: number, tick: number } | null} */
    this.lastHurt = null;
    /** @type {Sector | null} */
    this.lastSound = null;
    /** @type {number[]} */
    this.newIds = [];
    this.myTeam = /** @type {import('./base.js').Team} */ ('T');
  }

  /** 回合開始：清空記憶 */
  reset() {
    this.known.clear();
    this.anon.length = 0;
    this.sectors.length = 0;
    this.seenTick.fill(-1000000);
    this.danger.fill(0);
    this.portalThreat.fill(0);
    this.regionSeen.fill(0);
    this.dangerTick = -1000000;
    this.dangerDirty = true;
    this.lastTick = -1;
    this.mateAlive.clear();
    this.liveStart = -1;
    this.lastHurt = null;
    this.lastSound = null;
  }

  /** @param {import('./base.js').Observation} obs */
  update(obs) {
    const me = obs.me;
    const t = obs.tick;
    this.myTeam = me.team;
    this.updates++;
    if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
    const dt = this.lastTick < 0 ? 0 : (t - this.lastTick) / this.rules.ticksPerSecond;
    this.lastTick = t;
    this.newIds = [];
    // ── 衰減 ──
    const loss = this.decay * dt;
    for (const [id, k] of this.known) {
      k.conf -= loss;
      if (k.conf <= 0) this.known.delete(id);
    }
    this.anon = this.anon.filter((a) => (a.conf -= loss) > 0);
    this.sectors = this.sectors.filter((s) => (s.conf -= loss * 1.5) > 0);
    // ── 看到的敵人：位置、朝向、武器、信心 100 ──
    for (const e of obs.enemies) {
      const k = this.known.get(e.id);
      let vx = 0;
      let vy = 0;
      if (k !== undefined && t - k.tick > 0 && t - k.tick <= 9) {
        vx = (e.x - k.x) / (t - k.tick);
        vy = (e.y - k.y) / (t - k.tick);
      }
      if (k === undefined || k.conf < P.unconfirmed) {
        this.newIds.push(e.id);
        this.dangerDirty = true;
      }
      this.known.set(e.id, { id: e.id, x: e.x, y: e.y, vx, vy, facing: e.facing, weapon: e.weapon, tick: t, seenTick: t, conf: P.confSee, src: 'see' });
    }
    // ── 雷達：位置、信心 80 ──
    for (const r of obs.radar) {
      const k = this.known.get(r.id);
      if (k !== undefined && k.tick === t) continue;
      let vx = 0;
      let vy = 0;
      if (k !== undefined && t - k.tick > 0 && t - k.tick <= 9) {
        vx = (r.x - k.x) / (t - k.tick);
        vy = (r.y - k.y) / (t - k.tick);
      }
      if (k === undefined || k.conf < P.unconfirmed) this.dangerDirty = true;
      const conf = Math.max(k?.conf ?? 0, P.confRadar * this.trust);
      this.known.set(r.id, { id: r.id, x: r.x, y: r.y, vx, vy, facing: k?.facing ?? 0, weapon: k?.weapon ?? '?', tick: t, seenTick: k?.seenTick ?? -1, conf, src: 'radar' });
    }
    // ── 敵人的彈道起點：信心 70（附近有記得的敵人就更新它，否則記成不知道是誰的點）──
    for (const tr of obs.tracers) {
      if (tr.friendly) continue;
      this.notePoint(tr.x0, tr.y0, P.confTracer, t);
    }
    // ── 受傷：方向扇形、信心 60 ──
    for (const h of me.hurt) {
      this.addSector(me.x, me.y, h.dirDeg, 0, 40, P.confHurt, t, 'hurt');
      this.lastHurt = { dir: h.dirDeg, tick: t };
    }
    // ── 敵方聲音：方向扇形、信心 40 ──
    for (const s of obs.sounds) {
      if (s.friendly || !ENEMY_SOUNDS.has(s.kind)) continue;
      const band = BANDS[s.range];
      this.lastSound = this.addSector(me.x, me.y, s.dirDeg, band[0], band[1], P.confSound * this.trust, t, s.kind);
    }
    // ── 隊友陣亡：敵人看得到那裡 ──
    for (const m of obs.teammates) {
      if (this.mateAlive.get(m.id) === true && !m.alive) {
        this.anon.push({ x: m.x, y: m.y, tick: t, conf: P.confDeath, src: 'death' });
        this.dangerDirty = true;
      }
      this.mateAlive.set(m.id, m.alive);
    }
    // ── 敵人數校正：記得的比活著的多，就丟掉最不確定的（看得到的不丟）──
    if (this.known.size > obs.enemiesAlive) {
      const list = [...this.known.values()].filter((k) => k.tick !== t).sort((a, b) => a.conf - b.conf || a.id - b.id);
      while (this.known.size > obs.enemiesAlive && list.length > 0) this.known.delete(/** @type {Known} */ (list.shift()).id);
    }
    // ── 已清空：自己的視錐每次、隊友的每 P.mateScanEvery 次 ──
    if (me.alive && me.blindTicks === 0) this.scan(me.x, me.y, me.facing, me.scoped ? this.rules.scopedFovDeg : this.rules.fovDeg, me.scoped ? (this.rules.scopedViewRange ?? 60) : this.rules.viewRange, t);
    if (this.updates % P.mateScanEvery === 0) {
      for (const m of obs.teammates) if (m.alive && !m.blind) this.scan(m.x, m.y, m.facing, this.rules.fovDeg, this.rules.viewRange, t);
    }
    if (this.dangerDirty || t - this.dangerTick >= this.rules.ticksPerSecond) this.computeDanger(t);
  }

  /** 我打死的目標：從記憶刪掉 @param {number} id */
  forget(id) {
    if (this.known.delete(id)) this.dangerDirty = true;
  }

  /** @param {number} x @param {number} y @param {number} conf @param {number} t */
  notePoint(x, y, conf, t) {
    let best = null;
    let bestD = 2500;
    for (const k of this.known.values()) {
      const d = dist(k.x, k.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best !== null) {
      if (best.tick !== t) {
        best.x = x;
        best.y = y;
        best.tick = t;
      }
      best.conf = Math.max(best.conf, conf);
      return;
    }
    const a = this.anon.find((p) => p.src === 'tracer' && dist(p.x, p.y, x, y) < 2000);
    if (a !== undefined) {
      a.x = x;
      a.y = y;
      a.tick = t;
      a.conf = Math.max(a.conf, conf);
      return;
    }
    this.anon.push({ x, y, tick: t, conf, src: 'tracer' });
    this.dangerDirty = true;
  }

  /**
   * 加一個扇形（同方向同距離帶的合併）
   * @param {number} ox @param {number} oy @param {number} dir @param {number} r0 @param {number} r1 @param {number} conf @param {number} t @param {string} kind
   */
  addSector(ox, oy, dir, r0, r1, conf, t, kind) {
    for (const s of this.sectors) {
      if (Math.abs(adiff(s.dir, dir)) < 20 && s.r0 === r0 && dist(s.ox, s.oy, ox, oy) < 3 * UNIT) {
        s.ox = ox;
        s.oy = oy;
        s.dir = dir;
        s.tick = t;
        s.conf = Math.max(s.conf, conf);
        s.kind = kind;
        return s;
      }
    }
    /** @type {Sector} */
    const s = { ox, oy, dir, r0, r1, tick: t, conf, kind };
    this.sectors.push(s);
    this.dangerDirty = true;
    return s;
  }

  /** 視錐掃描：記錄每格最近被看到的時間 @param {number} x @param {number} y @param {number} facing @param {number} fov @param {number} range @param {number} t */
  scan(x, y, facing, fov, range, t) {
    const half = fov / 2;
    const seen = this.seenTick;
    const g = this.g;
    const wall = g.wall;
    // 同 Grid.ray（每半格一步、碰牆停），寫成迴圈避免每條射線配置閉包
    for (let a = -half; a <= half; a += 4) {
      const c = cosd(facing + a) * (UNIT / 2);
      const s = sind(facing + a) * (UNIT / 2);
      for (let k = 1; k <= range * 2; k++) {
        const i = g.cellOf(x + c * k, y + s * k);
        if (i < 0 || wall[i] === 1) break;
        seen[i] = t;
      }
    }
  }

  /** 某格最近被我方看過而且附近沒有記得的敵人 @param {number} i @param {number} t */
  cleared(i, t) {
    if (i < 0 || this.seenTick[i] < t - this.clearTtl) return false;
    const p = this.g.center(i);
    for (const k of this.known.values()) if (k.conf >= P.unconfirmed && dist(k.x, k.y, p.x, p.y) < 3 * UNIT) return false;
    return true;
  }

  /** 敵人此刻可能已經到得了這格（依開打後經過的時間與敵方出生區的路徑距離） @param {number} i @param {number} t @param {number} [margin] */
  reachable(i, t, margin = 2) {
    if (i < 0) return false;
    const enemy = this.myTeam === 'T' ? 'CT' : 'T';
    const d = this.intel.distSpawn[enemy][i] / 10;
    if (this.liveStart < 0) return d <= margin;
    return d <= ((t - this.liveStart) / this.rules.ticksPerSecond) * P.enemySpeed + margin;
  }

  /** 每秒：危險格成本（敵人看得到的格）、交界威脅、區域的已看過比例 @param {number} t */
  computeDanger(t) {
    const g = this.g;
    const danger = this.danger;
    danger.fill(0);
    this.portalThreat.fill(0);
    this.dangerTick = t;
    this.dangerDirty = false;
    const range = P.dangerRange;
    /** @param {number} x @param {number} y @param {number} value */
    const fromPoint = (x, y, value) => {
      const id = ++this.stampId;
      const stamp = this.stamp;
      const c = g.cellOf(x, y);
      if (c >= 0) {
        stamp[c] = id;
        danger[c] += value;
      }
      for (let a = 0; a < 360; a += 3) {
        g.ray(x, y, a, range, (i, d) => {
          if (stamp[i] === id) return;
          stamp[i] = id;
          danger[i] += value * (1 - (0.5 * d) / range);
        });
      }
    };
    for (const k of this.known.values()) if (k.conf >= 15) fromPoint(k.x, k.y, k.conf * P.dangerCoef);
    for (const a of this.anon) if (a.conf >= 15) fromPoint(a.x, a.y, a.conf * P.dangerCoef * (a.src === 'death' ? 0.7 : 1));
    for (const s of this.sectors) {
      if (s.conf < 15) continue;
      const id = ++this.stampId;
      const value = s.conf * P.sectorCoef;
      for (let r = Math.max(2, s.r0); r <= Math.min(s.r1, 35); r += 1.5) {
        for (let a = -P.sectorHalfDeg; a <= P.sectorHalfDeg; a += 5) {
          const i = g.cellOf(s.ox + cosd(s.dir + a) * r * UNIT, s.oy + sind(s.dir + a) * r * UNIT);
          if (i < 0 || g.block[i] === 1 || this.stamp[i] === id) continue;
          this.stamp[i] = id;
          danger[i] += value;
        }
      }
    }
    // 交界威脅：附近（10 格內）記得的敵人信心
    const portals = this.intel.portals;
    for (const p of portals) {
      let v = 0;
      for (const k of this.known.values()) {
        const d = dist(k.x, k.y, p.x, p.y) / UNIT;
        if (d < 10) v = Math.max(v, k.conf * (1 - d / 10));
      }
      for (const a of this.anon) {
        const d = dist(a.x, a.y, p.x, p.y) / UNIT;
        if (a.src === 'tracer' && d < 10) v = Math.max(v, a.conf * (1 - d / 10));
      }
      this.portalThreat[p.id] = v;
    }
    // 區域的已看過比例
    const n = this.intel.regionCount;
    const tot = new Int32Array(n);
    const seen = new Int32Array(n);
    const lim = t - this.clearTtl;
    for (let i = 0; i < g.N; i++) {
      const r = this.intel.region[i];
      if (r < 0) continue;
      tot[r]++;
      if (this.seenTick[i] >= lim) seen[r]++;
    }
    for (let r = 0; r < n; r++) this.regionSeen[r] = tot[r] === 0 ? 1 : seen[r] / tot[r];
  }

  /** 未確認區域：敵人可能到得了、最近被看過的格不到一半 @param {number} t */
  unconfirmedRegions(t) {
    /** @type {number[]} */
    const out = [];
    for (let r = 0; r < this.intel.regionCount; r++) {
      if (this.regionSeen[r] >= 0.5) continue;
      const reg = this.intel.map.regions[r];
      const c = this.intel.nearestOpen(Math.floor((reg.x0 + reg.x1) / 2), Math.floor((reg.y0 + reg.y1) / 2));
      if (this.reachable(c, t, 6)) out.push(r);
    }
    return out;
  }

  /** 記得的敵人（信心 ≥ 門檻），含不知道是誰的彈道點；最近的在前 @param {number} x @param {number} y @param {number} [minConf] @returns {Threat[]} */
  threats(x, y, minConf = P.unconfirmed) {
    /** @type {Threat[]} */
    const out = [];
    for (const k of this.known.values()) if (k.conf >= minConf) out.push({ x: k.x, y: k.y, conf: k.conf, src: k.src, id: k.id });
    for (const a of this.anon) if (a.src === 'tracer' && a.conf >= minConf) out.push({ x: a.x, y: a.y, conf: a.conf, src: a.src, id: -1 });
    out.sort((a, b) => dist(x, y, a.x, a.y) - dist(x, y, b.x, b.y));
    return out;
  }

  /** 最近的威脅（含方向，整數度）；沒有回傳 null @param {number} x @param {number} y */
  nearestThreat(x, y) {
    const t = this.threats(x, y)[0];
    return t === undefined ? null : { ...t, dir: angleTo(x, y, t.x, t.y) };
  }
}
