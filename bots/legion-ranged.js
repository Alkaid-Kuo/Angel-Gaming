// @ts-check
// 軍團戰基準 AI：箭雨。佔住淺灘旁的高地，大量弓兵居高齊射，盾兵擋箭、長槍架陣防騎兵；
// 敵方近戰逼近就後撤再射。（選手模組不能 import；共用的 LegionBase 直接寫在檔案裡）

/** @typedef {import('../src/legion/api.ts').LegionInitData} InitData */
/** @typedef {import('../src/legion/api.ts').LegionHelpers} Helpers */
/** @typedef {import('../src/legion/api.ts').LegionObservation} Observation */
/** @typedef {import('../src/legion/api.ts').LegionDeclaration} Declaration */
/** @typedef {import('../src/legion/api.ts').OwnRegiment} Own */
/** @typedef {import('../src/legion/api.ts').EnemyRegiment} Enemy */
/** @typedef {import('../src/legion/api.ts').LegionCommand} Command */
/** @typedef {import('../src/legion/api.ts').Deployment} Deployment */
/** @typedef {import('../src/legion/api.ts').UnitInfo} UnitInfo */
/** @typedef {import('../src/legion/api.ts').UnitKind} UnitKind */
/** @typedef {{ x: number, y: number, radius?: number }} Pt */
/** @typedef {{ type: UnitKind, role: string, tx: number, ty: number, facing?: number, width?: number }} PlanEntry */
/** @typedef {{ prio: number, c: Command, key: string }} Pending */

const TILE = 1000;

class LegionBase {
  constructor() {
    /** @type {InitData} */
    this.data = /** @type {any} */ (null);
    /** @type {Helpers} */
    this.h = /** @type {any} */ (null);
    /** @type {Observation} */
    this.obs = /** @type {any} */ (null);
    this.p = 0;
    this.W = 0;
    this.H = 0;
    /** @type {Readonly<Record<string, number>>} */
    this.k = {};
    /** @type {Record<string, UnitInfo>} */
    this.units = {};
    /** 最後看到的敵軍 @type {Map<number, Enemy & { tick: number }>} */
    this.seen = new Map();
    /** 最近送出的指令 @type {Map<number, { key: string, tick: number }>} */
    this.sent = new Map();
    /** 軍團 id → 角色 @type {Map<number, string>} */
    this.role = new Map();
    /** @type {PlanEntry[]} */
    this.plan = [];
  }

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  setup(data, helpers) {
    this.data = data;
    this.h = helpers;
    this.p = data.playerId;
    this.W = data.map.width * TILE;
    this.H = data.map.height * TILE;
    this.k = data.knobs;
    for (const u of data.units) this.units[u.kind] = u;
  }

  /**
   * 己方視角（0 號在左）的格座標 → 世界座標
   * @param {number} tx
   * @param {number} ty
   * @returns {Pt}
   */
  at(tx, ty) {
    const x = Math.round(tx * TILE);
    const y = Math.round(ty * TILE);
    return this.p === 0 ? { x, y } : { x: this.W - x, y: this.H - y };
  }

  /**
   * 世界座標 → 己方視角的格座標
   * @param {Pt} o
   * @returns {Pt}
   */
  loc(o) {
    return this.p === 0 ? { x: o.x / TILE, y: o.y / TILE } : { x: (this.W - o.x) / TILE, y: (this.H - o.y) / TILE };
  }

  /** @param {number} deg */
  face(deg) {
    return this.p === 0 ? (deg + 360) % 360 : (deg + 180 + 360) % 360;
  }

  /**
   * @param {Pt} a
   * @param {Pt} b
   */
  dist(a, b) {
    return this.h.dist(a.x, a.y, b.x, b.y);
  }

  /**
   * 兩軍團邊緣距離（格）
   * @param {Pt} a
   * @param {Pt} b
   */
  gap(a, b) {
    return (this.dist(a, b) - (a.radius || 0) - (b.radius || 0)) / TILE;
  }

  /**
   * @param {UnitKind} a
   * @param {UnitKind} b
   */
  vs(a, b) {
    return this.data.versus[a][b];
  }

  /** @param {UnitKind} kind */
  isCav(kind) {
    return kind === 'lightCav' || kind === 'heavyCav';
  }

  /**
   * 布陣：entries 以己方視角格座標描述，role 用來在開戰後辨認軍團
   * @param {PlanEntry[]} entries
   * @returns {Deployment[]}
   */
  deployFrom(entries) {
    this.plan = entries;
    return entries.map((e) => {
      const pos = this.at(e.tx, e.ty);
      return { type: e.type, x: pos.x, y: pos.y, facing: this.face(e.facing || 0), ...(e.width ? { width: e.width } : {}) };
    });
  }

  /** @param {Observation} obs */
  update(obs) {
    this.obs = obs;
    if (this.role.size === 0 && obs.regiments.length > 0) {
      /** @type {Set<number>} */
      const used = new Set();
      for (const r of obs.regiments) {
        let best = -1;
        let bestD = Infinity;
        this.plan.forEach((e, i) => {
          if (used.has(i) || e.type !== r.kind) return;
          const d = this.dist(this.at(e.tx, e.ty), r);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0) {
          used.add(best);
          this.role.set(r.id, this.plan[best].role);
        }
      }
    }
    for (const e of obs.enemies) this.seen.set(e.id, { ...e, tick: obs.tick });
    for (const [id, e] of this.seen) if (obs.tick - e.tick > 300 || e.routed) this.seen.delete(id);
  }

  /** @param {string} role */
  mine(role) {
    return this.obs.regiments.filter((r) => !r.routed && this.role.get(r.id) === role);
  }

  /**
   * 不重複送同一個指令（3 秒內）
   * @param {Pending[]} out
   * @param {number} prio
   * @param {Command} c
   */
  send(out, prio, c) {
    const key = JSON.stringify(c);
    const last = this.sent.get(c.id);
    if (last && last.key === key && this.obs.tick - last.tick < 30) return;
    out.push({ prio, c, key });
  }

  /** @param {Pending[]} out */
  flush(out) {
    out.sort((a, b) => b.prio - a.prio);
    const picked = out.slice(0, this.data.commandsPerDecision);
    for (const o of picked) this.sent.set(o.c.id, { key: o.key, tick: this.obs.tick });
    return picked.map((o) => o.c);
  }

  /**
   * @param {Pt} r
   * @param {((e: Enemy) => boolean) | null} filter
   * @param {number} [maxTiles]
   */
  nearestEnemy(r, filter, maxTiles) {
    /** @type {Enemy | null} */
    let best = null;
    let bestD = maxTiles === undefined ? Infinity : maxTiles;
    for (const e of this.obs.enemies) {
      if (e.routed || (filter && !filter(e))) continue;
      const d = this.gap(r, e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * 近戰挑目標：距離為主，相剋有利加分、不利扣分，已經在跟我方打的敵人優先（夾擊）
   * @param {Own} r
   * @param {number} maxTiles
   */
  meleeTarget(r, maxTiles) {
    /** @type {Enemy | null} */
    let best = null;
    let bestS = Infinity;
    for (const e of this.obs.enemies) {
      if (e.routed) continue;
      const d = this.gap(r, e);
      if (d > maxTiles) continue;
      let s = d;
      if (this.vs(r.kind, e.kind) > 100) s -= 6;
      if (this.vs(e.kind, r.kind) > 100) s += 8;
      if (e.engaged) s -= 5;
      if (e.kind === 'archer') s -= 3;
      if (s < bestS) {
        bestS = s;
        best = e;
      }
    }
    return best;
  }

  /**
   * 前方一定距離內的敵方騎兵
   * @param {Own} r
   * @param {number} tiles
   */
  cavThreat(r, tiles) {
    for (const e of this.obs.enemies) {
      if (!this.isCav(e.kind) || e.routed || this.gap(r, e) > tiles) continue;
      const ang = this.h.angleTo(r.x, r.y, e.x, e.y);
      let d = Math.abs(ang - r.facing) % 360;
      if (d > 180) d = 360 - d;
      if (d < 70) return e;
    }
    return null;
  }

  /**
   * 長槍兵：前方有騎兵逼近就架陣，騎兵走遠就收陣；回傳 true 表示這次已處理
   * @param {Pending[]} out
   * @param {Own} r
   */
  spearReact(out, r) {
    const threat = this.cavThreat(r, 14);
    if (threat && !r.engaged) {
      if (r.status !== 'braced' && r.status !== 'bracing') this.send(out, 9, { type: 'brace', id: r.id });
      return true;
    }
    if (r.status === 'braced' && !this.cavThreat(r, 22)) {
      this.send(out, 5, { type: 'unbrace', id: r.id });
      return true;
    }
    return r.status === 'braced' || r.status === 'bracing';
  }

  /**
   * 騎兵：可以衝鋒時找弓兵、輕步兵或正在接戰的敵人（避開正面的長槍）
   * @param {Pending[]} out
   * @param {Own} r
   * @param {number} maxTiles
   */
  cavalryReact(out, r, maxTiles) {
    if (r.status === 'charging') return true;
    if (r.skillCooldown === 0 && !r.dashing && r.terrain !== 2 && r.terrain !== 4) {
      /** @type {Enemy | null} */
      let best = null;
      let bestS = Infinity;
      for (const e of this.obs.enemies) {
        if (e.routed) continue;
        const d = this.gap(r, e);
        if (d < 3 || d > maxTiles) continue;
        if (e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing' || !e.engaged)) continue;
        let s = d;
        if (e.kind === 'archer') s -= 12;
        if (e.kind === 'light') s -= 6;
        if (e.engaged) s -= 8;
        if (this.isCav(e.kind)) s += 10;
        if (s < bestS) {
          bestS = s;
          best = e;
        }
      }
      if (best) {
        this.send(out, 8, { type: 'charge', id: r.id, target: best.id });
        return true;
      }
    } else if (!r.engaged) {
      // 撞擊後要先脫離才能再衝鋒：往己方後退
      const near = this.nearestEnemy(r, null, 6);
      if (near) {
        const me = this.loc(r);
        const back = this.at(Math.max(4, me.x - 10), me.y);
        this.send(out, 6, { type: 'move', id: r.id, x: back.x, y: back.y });
        return true;
      }
    }
    return false;
  }

  /**
   * 弓兵：敵方近戰太近就後撤，否則挑射程內最好打的目標
   * @param {Pending[]} out
   * @param {Own} r
   * @param {number} [holdX] 己方視角：超過這條線就不再往前追
   */
  archerReact(out, r, holdX) {
    const melee = this.nearestEnemy(r, (e) => e.kind !== 'archer', 5);
    if (melee && !r.engaged) {
      const me = this.loc(r);
      const back = this.at(Math.max(3, me.x - 9), me.y);
      this.send(out, 7, { type: 'move', id: r.id, x: back.x, y: back.y });
      return true;
    }
    const range = this.units.archer.range / TILE + (this.terrain(r) === 3 ? 2 : 0);
    /** @type {Enemy | null} */
    let best = null;
    let bestS = Infinity;
    for (const e of this.obs.enemies) {
      if (e.routed) continue;
      const d = this.gap(r, e);
      if (d > range + 4) continue;
      let s = d;
      if (e.kind === 'shield') s += 15;
      if (e.kind === 'archer') s -= 4;
      if (this.isCav(e.kind)) s -= 2;
      if (e.terrain === 4) s -= 4;
      if (s < bestS) {
        bestS = s;
        best = e;
      }
    }
    if (best) {
      const me = this.loc(r);
      if (this.gap(r, best) > range - 0.5 && holdX !== undefined && me.x >= holdX) return false;
      this.send(out, 4, { type: 'attack', id: r.id, target: best.id });
      return true;
    }
    return false;
  }

  /** @param {Pt} o */
  terrain(o) {
    return this.h.terrainAt(o.x, o.y);
  }
}

export default class ArrowRain extends LegionBase {
  constructor() {
    super();
    this.fought = false;
    this.advance = false;
    /** @type {number | undefined} 最後一次有交戰或敵軍逼近的 tick */
    this.lastBusy = undefined;
    /** 開局隨機：耐心的倍率 */
    this.patienceScale = 1;
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '箭雨',
      version: 'v1',
      style: '佔住淺灘旁的高地，大量弓兵居高齊射、盾兵擋箭、長槍架陣防騎兵；敵人逼近就後撤再射',
      knobs: [
        { key: 'archers', name: '弓兵', description: '弓兵團數', min: 2, max: 5, default: 4, integer: true },
        { key: 'shields', name: '盾兵', description: '盾兵團數', min: 1, max: 3, default: 3, integer: true },
        { key: 'kite', name: '後撤距離', description: '敵方近戰離弓兵多近（格）就後撤', min: 3, max: 10, default: 6, integer: true },
        { key: 'patience', name: '耐心', description: '多久沒接戰就往前推（秒）', min: 30, max: 240, default: 60, integer: true },
      ],
    };
  }

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  deploy(data, helpers) {
    this.setup(data, helpers);
    this.patienceScale = 0.7 + helpers.random() * 0.6;
    const k = data.knobs;
    const u = this.units;
    let budget = data.budget;
    /** @type {PlanEntry[]} */
    const list = [];
    /**
     * @param {UnitKind} type
     * @param {string} role
     * @param {{ tx: number, ty: number, facing?: number, width?: number }} extra
     */
    const take = (type, role, extra) => {
      if (u[type].cost > budget) return false;
      budget -= u[type].cost;
      list.push({ type, role, ...extra });
      return true;
    };
    take('light', 'scout', { tx: 10, ty: 30, facing: 0 });
    take('spear', 'spear', { tx: 17, ty: 42, facing: 0 });
    take('spear', 'spear', { tx: 17, ty: 70, facing: 0 });
    const na = k.archers ?? 4;
    for (let i = 0; i < na; i++) take('archer', 'archer', { tx: [8, 8, 13, 13, 4][i], ty: [50, 60, 46, 64, 55][i], facing: 0, width: 10 });
    const ns = k.shields ?? 3;
    for (let i = 0; i < ns; i++) take('shield', 'shield', { tx: 17, ty: [50, 58, 34][i], facing: 0 });
    while (take('sword', 'spear', { tx: 17, ty: [26, 78, 86][list.length % 3], facing: 0 }));
    while (take('light', 'scout', { tx: 4, ty: [20, 80][list.length % 2], facing: 0 }));
    return this.deployFrom(list);
  }

  /** @param {Observation} obs */
  decide(obs) {
    this.update(obs);
    /** @type {Pending[]} */
    const out = [];
    const k = this.k;
    const capture = this.data.mode === 'capture';
    const flags = this.data.map.flags;
    if (obs.enemies.some((e) => !e.routed && e.kind !== 'light')) this.fought = true;
    if (!this.fought && obs.tick > (k.patience ?? 60) * 10 * this.patienceScale) this.advance = true;
    // 敵方可見兵力明顯少於我方就往前壓
    const myMen = obs.regiments.filter((r) => !r.routed).reduce((s, r) => s + r.men, 0);
    const theirs = [...this.seen.values()].filter((e) => !e.routed).reduce((s, e) => s + e.men, 0);
    if (this.fought && theirs > 0 && myMen > theirs * 2) this.advance = true;
    if (this.fought && theirs === 0 && obs.tick > 1500) this.advance = true;
    // 接觸後 45 秒沒有交戰也往前推（避免雙方都在高地上乾等）
    const busy = obs.regiments.some((r) => r.engaged) || obs.enemies.some((e) => !e.routed && obs.regiments.some((r) => this.gap(r, e) < 14));
    if (busy || this.lastBusy === undefined) this.lastBusy = obs.tick;
    if (this.fought && obs.tick - this.lastBusy > 450) this.advance = true;
    const shift = this.advance ? 14 : 0;
    const goal = capture ? { x: flags[1].x, y: flags[1].y } : this.at(150, 50);

    // 弓兵：高地上；敵方近戰逼近就往後撤
    const archerSpots = [[64, 56], [70, 59], [60, 61], [66, 63], [58, 55]];
    this.mine('archer').forEach((r, i) => {
      const kite = this.nearestEnemy(r, (e) => e.kind !== 'archer' && e.kind !== 'light', k.kite ?? 6);
      if (kite && !r.engaged) {
        const me = this.loc(r);
        const p = this.at(Math.max(6, me.x - 10), me.y);
        return this.send(out, 8, { type: 'move', id: r.id, x: p.x, y: p.y });
      }
      if (this.archerReact(out, r)) return;
      const s = archerSpots[i % archerSpots.length];
      const p = this.at(s[0] + shift, s[1] - (shift ? 6 : 0));
      if (this.dist(r, p) > 2000) this.send(out, 2, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(-20) });
    });
    // 盾兵：站在弓兵前方（朝淺灘）
    const shieldSpots = [[70, 55], [71, 61], [67, 51]];
    this.mine('shield').forEach((r, i) => {
      const t = this.meleeTarget(r, this.advance ? 12 : 5);
      if (t) return this.send(out, 6, { type: 'attack', id: r.id, target: t.id });
      const s = shieldSpots[i % shieldSpots.length];
      const p = this.at(s[0] + shift, s[1] - (shift ? 6 : 0));
      if (this.dist(r, p) > 1500) this.send(out, 2, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(-35) });
    });
    // 長槍與劍士：守淺灘出口與南側
    const spearSpots = capture ? [[76, 47], [68, 67], [64, 46]] : [[69, 50], [68, 67], [64, 46]];
    this.mine('spear').forEach((r, i) => {
      if (r.kind === 'spear' && this.spearReact(out, r)) return;
      const t = this.meleeTarget(r, this.advance ? 20 : 7);
      if (t) return this.send(out, 6, { type: 'attack', id: r.id, target: t.id });
      if (this.advance && !capture) return this.send(out, 3, { type: 'attackMove', id: r.id, x: goal.x, y: goal.y });
      const s = spearSpots[i % spearSpots.length];
      const p = this.at(s[0], s[1]);
      if (this.dist(r, p) > 1500) this.send(out, 2, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(i === 1 ? 30 : -30) });
    });
    // 斥候：北邊看橋，南邊看橋
    this.mine('scout').forEach((r, i) => {
      const threat = this.nearestEnemy(r, (e) => e.kind !== 'archer' && e.kind !== 'light', 6);
      if (threat && !r.engaged) {
        const p = this.at(Math.max(6, this.loc(r).x - 12), this.loc(r).y);
        return this.send(out, 7, { type: 'move', id: r.id, x: p.x, y: p.y });
      }
      const p = this.at(68, i === 0 ? 24 : 76);
      if (this.dist(r, p) > 1500) this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y });
    });
    return this.flush(out);
  }
}
