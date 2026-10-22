// @ts-check
// 軍團戰基準 AI：鐵壁推進。整條戰線一起推到河邊，等一下後壓過去（多半走淺灘，有時改走北橋或南橋包抄）；
// 弓兵躲在盾兵後面齊射，重騎兵護住側翼、找機會衝鋒敵方弓兵或已接戰敵軍的側背。
// （選手模組不能 import；共用的 LegionBase 直接寫在檔案裡）

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
    if (r.canCharge) {
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

export default class IronPush extends LegionBase {
  constructor() {
    super();
    /** @type {number | undefined} 戰線推到河邊的 tick */
    this.reachedAt = undefined;
    this.fought = false;
    /** 過河路線：0 淺灘、1 北橋、2 南橋（開局隨機） */
    this.route = 0;
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '鐵壁推進',
      version: 'v1',
      style: '整條戰線推到河邊，等待後一起壓過去；弓兵在盾兵後方齊射，重騎兵護翼、衝鋒敵方弓兵與側背',
      knobs: [
        { key: 'cavalry', name: '重騎兵', description: '重騎兵團數', min: 0, max: 2, default: 1, integer: true },
        { key: 'archers', name: '弓兵', description: '弓兵團數', min: 0, max: 3, default: 2, integer: true },
        { key: 'lineX', name: '前線位置', description: '戰線先推進到哪裡（己方視角的格 x，河在 76 附近）', min: 40, max: 72, default: 66, integer: true },
        { key: 'waitSec', name: '河邊等待', description: '推到河邊後等多久才過河（秒）；看到敵人就直接開打', min: 0, max: 90, default: 10, integer: true },
        { key: 'bridgeChance', name: '走橋機率', description: '開局隨機決定改走北橋或南橋包抄的機率（%）', min: 0, max: 100, default: 30, integer: true },
      ],
    };
  }

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  deploy(data, helpers) {
    this.setup(data, helpers);
    const k = data.knobs;
    const units = this.units;
    let budget = data.budget;
    if (helpers.random() * 100 < (k.bridgeChance ?? 30)) this.route = helpers.random() < 0.5 ? 1 : 2;
    /** @type {{ type: UnitKind, role: string }[]} */
    const list = [];
    /**
     * @param {UnitKind} type
     * @param {string} role
     */
    const take = (type, role) => {
      if (units[type].cost > budget) return false;
      budget -= units[type].cost;
      list.push({ type, role });
      return true;
    };
    take('light', 'scout');
    for (let i = 0; i < (k.cavalry ?? 1); i++) take('heavyCav', 'cav');
    for (let i = 0; i < (k.archers ?? 2); i++) take('archer', 'archer');
    take('shield', 'shield');
    /** @type {UnitKind[]} */
    const melee = ['spear', 'sword', 'sword', 'spear', 'sword', 'spear'];
    for (const t of melee) if (!take(t, 'line')) break;
    while (take('light', 'line'));
    const lineYs = [46, 54, 38, 62, 30, 70, 22, 78];
    let li = 0;
    let ai = 0;
    let ci = 0;
    /** @type {PlanEntry[]} */
    const out = list.map((e) => {
      if (e.role === 'line') return { ...e, tx: 17, ty: lineYs[li++ % 8], facing: 0 };
      if (e.role === 'archer') return { ...e, tx: 10, ty: [44, 56, 50][ai++ % 3], facing: 0, width: 12 };
      if (e.role === 'shield') return { ...e, tx: 13, ty: 50, facing: 0 };
      if (e.role === 'cav') return { ...e, tx: 13, ty: [26, 74][ci++ % 2], facing: 0 };
      return { ...e, tx: 10, ty: 32, facing: 0 };
    });
    return this.deployFrom(out);
  }

  /** @param {Observation} obs */
  decide(obs) {
    this.update(obs);
    /** @type {Pending[]} */
    const out = [];
    const k = this.k;
    const lineX = k.lineX ?? 66;
    const wait = (k.waitSec ?? 10) * 10;
    const capture = this.data.mode === 'capture';
    const line = this.mine('line');
    if (this.reachedAt === undefined && line.length > 0 && line.every((r) => this.loc(r).x >= lineX - 2)) this.reachedAt = obs.tick;
    const contact = obs.enemies.some((e) => !e.routed && e.kind !== 'light');
    if (contact) this.fought = true;
    const cross = this.fought || (this.reachedAt !== undefined && obs.tick - this.reachedAt >= wait) || obs.tick > 1200;
    const flags = this.data.map.flags;
    const centerFlag = flags.length > 1 ? flags[1] : null;
    // 過河的集結點：淺灘或橋
    const via = [this.at(90, 50), this.at(92, 21), this.at(90, 78)][this.route];
    const goal = capture && centerFlag ? { x: centerFlag.x, y: centerFlag.y } : this.at(150, 50);
    const frontX = line.length ? Math.min(...line.map((r) => this.loc(r).x)) : lineX;
    const lineYs = this.route === 0 ? [46, 54, 38, 62, 30, 70, 22, 78] : this.route === 1 ? [24, 30, 18, 36, 12, 42, 48, 54] : [76, 70, 82, 64, 88, 58, 52, 46];

    // 戰線
    line.forEach((r, i) => {
      if (r.kind === 'spear' && this.spearReact(out, r)) return;
      const t = this.meleeTarget(r, contact ? 22 : 12);
      if (t) return this.send(out, 6, { type: 'attack', id: r.id, target: t.id });
      if (!cross) {
        const p = this.at(lineX, lineYs[i % 8]);
        return this.send(out, 2, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(0) });
      }
      const me = this.loc(r);
      const g = capture ? goal : me.x < this.loc(via).x - 2 && !this.fought ? via : this.at(150, 50);
      this.send(out, 3, { type: 'attackMove', id: r.id, x: g.x, y: g.y });
    });
    // 佔點：一團長槍守己方高地旗點
    if (capture && flags.length > 2 && line.length > 2) {
      const holder = line.find((r) => r.kind === 'spear') || line[line.length - 1];
      const f = this.p === 0 ? flags[0] : flags[2];
      if (this.dist(holder, f) > 2500 && !holder.engaged) this.send(out, 5, { type: 'move', id: holder.id, x: f.x, y: f.y });
    }
    // 弓兵：不超前戰線
    const archers = this.mine('archer');
    for (const r of archers) {
      if (this.archerReact(out, r, frontX - 3)) continue;
      const me = this.loc(r);
      const tx = Math.max(10, frontX - 6);
      if (Math.abs(me.x - tx) > 3) {
        const p = this.at(tx, me.y < 50 ? lineYs[0] : lineYs[1]);
        this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(0) });
      }
    }
    // 盾兵：站在弓兵前方
    for (const r of this.mine('shield')) {
      const t = this.meleeTarget(r, 6);
      if (t) {
        this.send(out, 5, { type: 'attack', id: r.id, target: t.id });
        continue;
      }
      if (archers.length) {
        const cx = archers.reduce((s, a) => s + this.loc(a).x, 0) / archers.length;
        const cy = archers.reduce((s, a) => s + this.loc(a).y, 0) / archers.length;
        const p = this.at(cx + 4, cy);
        if (this.dist(r, p) > 2500) this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(0) });
      }
    }
    // 重騎兵：護翼、找機會衝鋒
    for (const r of this.mine('cav')) {
      if (this.cavalryReact(out, r, 25)) continue;
      if (r.engaged) continue;
      const t = this.meleeTarget(r, 10);
      if (t && t.engaged) {
        this.send(out, 4, { type: 'attack', id: r.id, target: t.id });
        continue;
      }
      const me = this.loc(r);
      const p = this.at(Math.max(12, frontX - 5), me.y < 50 ? 30 : 70);
      if (this.dist(r, p) > 3000) this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(0) });
    }
    // 斥候：到淺灘前觀察，敵方弓兵落單就去偷襲，被近戰盯上就退
    for (const r of this.mine('scout')) {
      const threat = this.nearestEnemy(r, (e) => e.kind !== 'archer' && e.kind !== 'light', 6);
      if (threat && !r.engaged) {
        const me = this.loc(r);
        const p = this.at(Math.max(8, me.x - 12), me.y);
        this.send(out, 7, { type: 'move', id: r.id, x: p.x, y: p.y });
        continue;
      }
      const prey = this.nearestEnemy(r, (e) => e.kind === 'archer' || e.kind === 'light', 18);
      if (prey) {
        this.send(out, 5, { type: 'attack', id: r.id, target: prey.id });
        continue;
      }
      const p = this.at(cross ? 86 : 70, 50);
      this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y });
    }
    return this.flush(out);
  }
}
