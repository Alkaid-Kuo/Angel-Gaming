// @ts-check
// 軍團戰基準 AI：林中伏兵。主力守在淺灘後方，劍士事先藏進河邊樹林，敵軍過河與主力接戰時從側面殺出；
// 騎兵繞橋偷襲敵方弓兵。（選手模組不能 import；共用的 LegionBase 直接寫在檔案裡）

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

export default class ForestAmbush extends LegionBase {
  constructor() {
    super();
    this.fought = false;
    this.sprung = false;
    this.allIn = false;
    /** 開局隨機：耐心的倍率、騎兵繞後走哪座橋（0 南、1 北） */
    this.patienceScale = 1;
    this.raidRoute = 0;
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '林中伏兵',
      version: 'v1',
      style: '主力守在淺灘後方，劍士藏進河邊樹林，敵軍過河接戰時從側面殺出；騎兵繞南橋偷襲敵方弓兵',
      knobs: [
        { key: 'ambushers', name: '伏兵', description: '藏在樹林裡的劍士團數', min: 1, max: 3, default: 2, integer: true },
        { key: 'patience', name: '耐心', description: '多久沒接戰就主動進攻（秒）', min: 20, max: 180, default: 45, integer: true },
        { key: 'raid', name: '騎兵繞後', description: '1 = 騎兵繞南橋偷襲；0 = 留在高地後方待命', min: 0, max: 1, default: 1, integer: true },
        { key: 'spring', name: '出擊距離', description: '敵軍離樹林多近（格）伏兵就殺出', min: 4, max: 16, default: 10, integer: true },
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
    this.raidRoute = helpers.random() < 0.5 ? 0 : 1;
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
    take('spear', 'main', { tx: 17, ty: 45, facing: 0 });
    take('spear', 'main', { tx: 17, ty: 55, facing: 0 });
    take('archer', 'archer', { tx: 10, ty: 50, facing: 0, width: 12 });
    take('shield', 'main', { tx: 13, ty: 50, facing: 0 });
    const n = k.ambushers ?? 2;
    for (let i = 0; i < n; i++) take('sword', 'ambush', { tx: 16, ty: [30, 22, 38][i], facing: 0, width: 8 });
    take('heavyCav', 'cav', { tx: 12, ty: 70, facing: 0 });
    take('light', 'scout', { tx: 10, ty: 36, facing: 0 });
    take('lightCav', 'cav', { tx: 12, ty: 80, facing: 0 });
    while (take('spear', 'main', { tx: 13, ty: [62, 38, 86][list.length % 3], facing: 0 }));
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
    const forest = this.at(60, 42);
    const main = this.mine('main');
    const engagedMain = obs.enemies.find((e) => !e.routed && main.some((m) => this.gap(m, e) < 2));
    const near = obs.enemies.filter((e) => !e.routed && e.kind !== 'light' && this.dist(e, forest) / 1000 < (k.spring ?? 10) + 4);
    if (obs.enemies.some((e) => !e.routed && e.kind !== 'light' && this.loc(e).x < 80)) this.fought = true;
    if (engagedMain || near.length > 0) this.sprung = true;
    if (!this.fought && obs.tick > (k.patience ?? 45) * 10 * this.patienceScale) {
      this.fought = true;
      this.allIn = true;
    }
    const sprung = this.sprung === true;
    const goal = capture ? { x: flags[1].x, y: flags[1].y } : this.at(150, 50);

    // 主力：守淺灘後方（佔點：守中央旗點旁的河岸）
    const spots = capture ? [[75, 46], [75, 54], [69, 50]] : [[69, 45], [69, 55], [66, 50]];
    main.forEach((r, i) => {
      if (r.kind === 'spear' && this.spearReact(out, r)) return;
      const t = this.meleeTarget(r, this.allIn ? 25 : 8);
      if (t) return this.send(out, 6, { type: 'attack', id: r.id, target: t.id });
      if (this.allIn) return this.send(out, 3, { type: 'attackMove', id: r.id, x: goal.x, y: goal.y });
      const s = spots[i % spots.length];
      const p = this.at(s[0], s[1] + (i >= 3 ? 8 : 0));
      if (this.dist(r, p) > 1500) this.send(out, 2, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(0) });
    });
    // 佔點：己方高地旗點派一團
    if (capture && main.length >= 2) {
      const f = this.p === 0 ? flags[0] : flags[2];
      const holder = main[main.length - 1];
      if (!holder.engaged && this.dist(holder, f) > 2500) this.send(out, 5, { type: 'move', id: holder.id, x: f.x, y: f.y });
    }
    // 弓兵：在主力後方
    for (const r of this.mine('archer')) {
      if (this.archerReact(out, r)) continue;
      const p = this.allIn ? this.at(Math.min(80, this.loc(r).x + 10), 50) : this.at(61, 50);
      if (this.dist(r, p) > 2000) this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(0) });
    }
    // 伏兵：先進樹林躲好，觸發後殺出
    this.mine('ambush').forEach((r, i) => {
      if (sprung || this.allIn) {
        const t = this.meleeTarget(r, 25);
        if (t) return this.send(out, 7, { type: 'attack', id: r.id, target: t.id });
        if (this.allIn) return this.send(out, 3, { type: 'attackMove', id: r.id, x: goal.x, y: goal.y });
      }
      const spot = [[58, 41], [62, 43.5], [60, 39]][i % 3];
      const p = this.at(spot[0], spot[1]);
      if (this.dist(r, p) > 1200) this.send(out, 2, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(20) });
    });
    // 騎兵
    const raid = (k.raid ?? 1) === 1 && (this.fought || obs.tick > 450);
    for (const r of this.mine('cav')) {
      if (this.cavalryReact(out, r, raid ? 30 : 18)) continue;
      if (r.engaged) continue;
      const me = this.loc(r);
      if (raid) {
        // 繞橋：先到橋頭，過橋，再往敵方後方
        const bridgeY = this.raidRoute === 0 ? 78 : 21;
        const wp = me.x < 74 ? this.at(70, bridgeY) : me.x < 86 ? this.at(92, bridgeY + (this.raidRoute === 0 ? -2 : 2)) : this.at(112, this.raidRoute === 0 ? 60 : 40);
        this.send(out, 2, { type: 'move', id: r.id, x: wp.x, y: wp.y });
      } else {
        const p = this.at(54, me.y < 70 ? 64 : 70);
        if (this.dist(r, p) > 2500) this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y, facing: this.face(0) });
      }
    }
    // 斥候：躲在北橋旁的樹林看橋
    for (const r of this.mine('scout')) {
      const threat = this.nearestEnemy(r, (e) => e.kind !== 'archer' && e.kind !== 'light', 5);
      if (threat && !r.engaged) {
        const p = this.at(Math.max(6, this.loc(r).x - 12), this.loc(r).y);
        this.send(out, 7, { type: 'move', id: r.id, x: p.x, y: p.y });
        continue;
      }
      const prey = this.nearestEnemy(r, (e) => e.kind === 'archer', 14);
      if (prey) {
        this.send(out, 5, { type: 'attack', id: r.id, target: prey.id });
        continue;
      }
      const p = this.at(64, 13);
      if (this.dist(r, p) > 1500) this.send(out, 1, { type: 'move', id: r.id, x: p.x, y: p.y });
    }
    return this.flush(out);
  }
}
