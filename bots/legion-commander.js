// @ts-check
// 軍團戰官方基準 AI：統帥。三層指揮：
//   指揮官（每 2 秒）：推估雙方兵力（含看不到的敵軍：對手最多 500 點，扣掉看到被殲滅的）、評估附近的敵軍集團，
//     決定姿態（集結、固守、迎擊、決戰、收攏、進攻、搜敵）與各戰鬥群的任務；佔點模式另外分派各旗的人手。
//   戰鬥群（每次決策）：戰線（槍兵居中、劍士兩翼，一起推進、只打戰線附近的敵人，依兵種相剋分配目標）、
//     火力（弓兵佔高處、集火與齊射，盾兵護送）、打擊（騎兵在側翼待命，敵人被纏住或露出側背才衝）、
//     斥候（偵察、獵落單弓兵、搶空旗）、護衛（敵人逼近弓兵時就近派兵攔截）、守旗。
//   兵種動作：沿用共用函式庫（槍林、突擊、弓兵後撤與集火、盾牆、斥候）。
// 本檔由 scripts/build-legion-bots.ts 從 bots/legion-src/ 產生：請修改原始碼後重新產生，不要直接改這個檔案。

/** @typedef {import('../src/legion/api.ts').LegionInitData} InitData */
/** @typedef {import('../src/legion/api.ts').LegionHelpers} Helpers */
/** @typedef {import('../src/legion/api.ts').LegionObservation} Observation */
/** @typedef {import('../src/legion/api.ts').LegionDeclaration} Declaration */
/** @typedef {import('../src/legion/api.ts').OwnRegiment} Own */
/** @typedef {import('../src/legion/api.ts').EnemyRegiment} Enemy */
/** 對某一團的指令（不含 plan） @typedef {Exclude<import('../src/legion/api.ts').LegionCommand, { type: 'plan' }>} Command */
/** @typedef {import('../src/legion/api.ts').Deployment} Deployment */
/** @typedef {import('../src/legion/api.ts').UnitInfo} UnitInfo */
/** @typedef {import('../src/legion/api.ts').UnitKind} UnitKind */
/** @typedef {import('../src/legion/api.ts').FormationKind} FormationKind */
/** @typedef {{ x: number, y: number, radius?: number }} Pt */
/** @typedef {{ type: UnitKind, role: string, tx: number, ty: number, facing?: number, width?: number, formation?: FormationKind, stance?: 'carry' | 'raise' }} PlanEntry */
/** @typedef {{ prio: number, c: Command, key: string, hold: number }} Pending */
/** @typedef {{ x: number, y: number, size: number }} Blob */
/** @typedef {Enemy & { tick: number, vx: number, vy: number }} Memory */

const TILE = 1000;
/** 地形代碼 */
const TR = { plain: 0, road: 1, forest: 2, hill: 3, shallow: 4, river: 5, bridge: 6, building: 7, wall: 8 };

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
    /** 敵情記憶 @type {Map<number, Memory>} */
    this.seen = new Map();
    /** 最近送出的指令（承諾：一段時間內不改） @type {Map<number, { key: string, tick: number, until: number }>} */
    this.sent = new Map();
    /** 軍團 id → 角色 @type {Map<number, string>} */
    this.role = new Map();
    /** @type {PlanEntry[]} */
    this.plan = [];
    /** 地圖分析（世界座標） @type {{ forests: Blob[], hills: Blob[], bridges: Blob[], fords: Blob[] }} */
    this.geo = { forests: [], hills: [], bridges: [], fords: [] };
    /** 各團的暫存狀態（騎兵的衝鋒循環、弓兵的後撤等） @type {Map<number, Record<string, number>>} */
    this.mem = new Map();
    /** 這次決策時正在交戰；上次交戰的 tick（還沒交戰過是 -1） */
    this.busy = false;
    this.lastFight = -1;
    this.myHp = -1;
    /** 己方視角座標的縮放：程式裡的格座標以 160 × 100 的地圖為準，換到實際地圖 */
    this.sx = 1;
    this.sy = 1;
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
    this.sx = data.map.width / 160;
    this.sy = data.map.height / 100;
    this.k = data.knobs;
    for (const u of data.units) this.units[u.kind] = u;
    this.geo = {
      forests: this.blobs((t) => t === TR.forest),
      hills: this.blobs((t, h) => h >= 3 && t !== TR.forest),
      bridges: this.blobs((t) => t === TR.bridge),
      fords: this.blobs((t) => t === TR.shallow),
    };
  }

  /**
   * 地圖上符合條件的連通區塊（中心、格數）
   * @param {(t: number, h: number) => boolean} test
   * @returns {Blob[]}
   */
  blobs(test) {
    const m = this.data.map;
    const seen = new Uint8Array(m.width * m.height);
    /** @type {Blob[]} */
    const out = [];
    for (let i = 0; i < m.width * m.height; i++) {
      if (seen[i] || !test(m.terrain[i], m.heights[i])) continue;
      let sx = 0;
      let sy = 0;
      let n = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = /** @type {number} */ (stack.pop());
        const x = j % m.width;
        const y = (j - x) / m.width;
        sx += x;
        sy += y;
        n += 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) continue;
          const q = ny * m.width + nx;
          if (seen[q] || !test(m.terrain[q], m.heights[q])) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      if (n >= 6) out.push({ x: Math.round(((sx / n) + 0.5) * TILE), y: Math.round(((sy / n) + 0.5) * TILE), size: n });
    }
    return out;
  }

  // ───────── 座標：己方視角（0 號在左、往 +x 進攻） ─────────

  /**
   * 己方視角的格座標（以 160 × 100 的地圖為準，依實際地圖縮放）→ 世界座標
   * @param {number} tx
   * @param {number} ty
   * @returns {Pt}
   */
  at(tx, ty) {
    const x = Math.round(tx * this.sx * TILE);
    const y = Math.round(ty * this.sy * TILE);
    return this.p === 0 ? { x, y } : { x: this.W - x, y: this.H - y };
  }

  /**
   * 布陣位置：布陣區的深度固定（不隨地圖縮放），所以 x 不縮放、y 依地圖高度縮放
   * @param {{ tx: number, ty: number }} e
   * @returns {Pt}
   */
  deployAt(e) {
    return this.at(e.tx / this.sx, e.ty);
  }

  /**
   * 世界座標 → 己方視角的格座標（以 160 × 100 的地圖為準）
   * @param {Pt} o
   * @returns {Pt}
   */
  loc(o) {
    const x = this.p === 0 ? o.x : this.W - o.x;
    const y = this.p === 0 ? o.y : this.H - o.y;
    return { x: x / TILE / this.sx, y: y / TILE / this.sy };
  }

  /**
   * 四捨六入五成雙（雙方鏡像的座標捨入後仍然鏡像）
   * @param {number} v
   */
  rnd(v) {
    const f = Math.floor(v);
    const d = v - f;
    if (d !== 0.5) return d > 0.5 ? f + 1 : f;
    return f % 2 === 0 ? f : f + 1;
  }

  /** @param {number} deg 己方視角的角度 → 世界角度 */
  face(deg) {
    return ((this.p === 0 ? deg : deg + 180) % 360 + 360) % 360;
  }

  /** 進攻方向（世界角度） */
  get forward() {
    return this.face(0);
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
   * a 指向 b 的角度
   * @param {Pt} a
   * @param {Pt} b
   */
  angle(a, b) {
    return this.h.angleTo(a.x, a.y, b.x, b.y);
  }

  /**
   * 兩個角度的差（0～180）
   * @param {number} a
   * @param {number} b
   */
  adiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /**
   * 從 o 往 deg 方向走 dist 格
   * @param {Pt} o
   * @param {number} deg
   * @param {number} tiles
   * @returns {Pt}
   */
  offset(o, deg, tiles) {
    const [x, y] = this.h.offset(o.x, o.y, deg, tiles * TILE);
    return { x, y };
  }

  /** @param {UnitKind} kind */
  isCav(kind) {
    return kind === 'lightCav' || kind === 'heavyCav';
  }

  /**
   * 兩點之間能不能直線走（騎兵另外不能穿過樹林、淺灘）
   * @param {Pt} a
   * @param {Pt} b
   * @param {boolean} cavalry
   */
  clearLine(a, b, cavalry) {
    const n = Math.max(1, Math.ceil(this.dist(a, b) / 600));
    for (let i = 1; i <= n; i++) {
      const t = this.h.terrainAt(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      if (t === TR.river || t === TR.building || t === TR.wall) return false;
      if (cavalry && (t === TR.forest || t === TR.shallow)) return false;
    }
    return true;
  }

  // ───────── 布陣與角色 ─────────

  /**
   * @param {PlanEntry[]} entries 己方視角格座標
   * @returns {Deployment[]}
   */
  deployFrom(entries) {
    this.plan = entries;
    return entries.map((e) => {
      const pos = this.deployAt(e);
      return { type: e.type, x: pos.x, y: pos.y, facing: this.face(e.facing || 0), ...(e.width ? { width: e.width } : {}), ...(e.formation ? { formation: e.formation } : {}), ...(e.stance ? { stance: e.stance } : {}) };
    });
  }

  /**
   * 依兵種與預算挑兵（依序，買不起就跳過）
   * @param {[UnitKind, string][]} wish
   * @returns {{ type: UnitKind, role: string }[]}
   */
  buy(wish) {
    let budget = this.data.budget;
    /** @type {{ type: UnitKind, role: string }[]} */
    const out = [];
    for (const [type, role] of wish) {
      if (this.units[type].cost > budget) continue;
      budget -= this.units[type].cost;
      out.push({ type, role });
    }
    return out;
  }

  // ───────── 每次決策 ─────────

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
          const d = this.dist(this.deployAt(e), r);
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
    // 交戰判定：有團在近戰、或上次決策後我方掉血、或看得到的敵軍掉了人
    const hp = obs.regiments.reduce((t, r) => t + r.hp, 0);
    let hurt = this.myHp >= 0 && hp < this.myHp;
    this.myHp = hp;
    for (const e of obs.enemies) {
      const old = this.seen.get(e.id);
      if (old && e.men < old.men) hurt = true;
    }
    this.busy = hurt || obs.regiments.some((r) => r.engaged);
    if (this.busy) this.lastFight = obs.tick;
    for (const e of obs.enemies) {
      const old = this.seen.get(e.id);
      const dt = old ? Math.max(1, obs.tick - old.tick) : 1;
      const vx = old && obs.tick - old.tick <= 20 ? (e.x - old.x) / dt : 0;
      const vy = old && obs.tick - old.tick <= 20 ? (e.y - old.y) / dt : 0;
      this.seen.set(e.id, { ...e, tick: obs.tick, vx, vy });
    }
    for (const [id, e] of this.seen) if (obs.tick - e.tick > 400 || e.routed) this.seen.delete(id);
  }

  /** @param {string} role */
  mine(role) {
    return this.obs.regiments.filter((r) => !r.routed && this.role.get(r.id) === role);
  }

  /** 看得到的敵軍（沒潰散） */
  get foes() {
    return this.obs.enemies.filter((e) => !e.routed);
  }

  /**
   * 記得的敵軍（含現在看不到、但 maxAge tick 內見過的），位置依速度推估
   * @param {number} maxAge
   * @returns {Memory[]}
   */
  remembered(maxAge) {
    /** @type {Memory[]} */
    const out = [];
    for (const e of this.seen.values()) {
      const age = this.obs.tick - e.tick;
      if (age > maxAge) continue;
      const k = Math.min(age, 30);
      out.push({ ...e, x: this.rnd(e.x + e.vx * k), y: this.rnd(e.y + e.vy * k) });
    }
    return out;
  }

  /**
   * 敵軍 s 秒後的位置（依觀察到的速度）
   * @param {Enemy} e
   * @param {number} ticks
   * @returns {Pt}
   */
  predict(e, ticks) {
    const m = this.seen.get(e.id);
    if (!m) return { x: e.x, y: e.y };
    return { x: this.rnd(e.x + m.vx * ticks), y: this.rnd(e.y + m.vy * ticks) };
  }

  /**
   * 最近的敵軍
   * @param {Pt} r
   * @param {((e: Enemy) => boolean) | null} filter
   * @param {number} [maxTiles]
   */
  nearestFoe(r, filter, maxTiles) {
    /** @type {Enemy | null} */
    let best = null;
    let bestD = maxTiles === undefined ? Infinity : maxTiles;
    for (const e of this.foes) {
      if (filter && !filter(e)) continue;
      const d = this.gap(r, e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * p 在 e 的正面嗎（e 朝向 ±deg 內）
   * @param {Enemy | Own} e
   * @param {Pt} p
   * @param {number} [deg]
   */
  inFront(e, p, deg = 60) {
    return this.adiff(this.angle(e, p), e.facing) <= deg;
  }

  /**
   * e 正朝我逼近（行軍、進攻或衝刺中，而且大致朝向我）
   * @param {Enemy} e
   * @param {Pt} me
   */
  approaching(e, me) {
    const moving = e.status === 'moving' || e.status === 'attacking' || e.status === 'assaulting' || e.status === 'infiltrating' || e.status === 'charging';
    return moving && this.adiff(e.facing, this.angle(e, me)) < 50;
  }

  /**
   * 敵方架好槍林、而且我在它的正面
   * @param {Enemy} e
   * @param {Pt} me
   */
  spearWall(e, me) {
    return e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing') && e.formation !== 'circle' && this.inFront(e, me, 70);
  }

  /**
   * 敵方架好盾牆、而且我在它的正面
   * @param {Enemy} e
   * @param {Pt} me
   */
  shieldWall(e, me) {
    return e.kind === 'shield' && e.status === 'walled' && this.inFront(e, me, 70);
  }

  // ───────── 指令與承諾 ─────────

  /**
   * 送一個指令。同一團同樣的指令 3 秒內不重送；承諾期間（hold tick）只有更高優先的指令能改。
   * @param {Pending[]} out
   * @param {number} prio 優先度（越大越先送；8 以上可以打斷承諾）
   * @param {Command} c
   * @param {string} intent AI 意圖（觀戰顯示）
   * @param {number} [hold] 承諾多少 tick 不改
   */
  send(out, prio, c, intent, hold = 0) {
    const cmd = /** @type {Command} */ ({ ...c, intent });
    const key = JSON.stringify(c);
    const last = this.sent.get(c.id);
    if (last) {
      if (last.key === key && this.obs.tick - last.tick < 30) return;
      if (this.obs.tick < last.until && prio < 8 && last.key !== key) return;
    }
    out.push({ prio, c: cmd, key, hold });
  }

  /**
   * 這一團目前的承諾還在（不要改它）
   * @param {Own} r
   */
  committed(r) {
    const last = this.sent.get(r.id);
    return !!last && this.obs.tick < last.until;
  }

  /** @param {Pending[]} out */
  flush(out) {
    // 同一團只留最高優先的一個指令
    /** @type {Map<number, Pending>} */
    const best = new Map();
    for (const o of out) {
      const cur = best.get(o.c.id);
      if (!cur || o.prio > cur.prio) best.set(o.c.id, o);
    }
    const picked = [...best.values()].sort((a, b) => b.prio - a.prio).slice(0, this.data.commandsPerDecision);
    for (const o of picked) this.sent.set(o.c.id, { key: o.key, tick: this.obs.tick, until: this.obs.tick + o.hold });
    return picked.map((o) => o.c);
  }

  /**
   * 暫存狀態
   * @param {number} id
   */
  state(id) {
    let s = this.mem.get(id);
    if (!s) {
      s = {};
      this.mem.set(id, s);
    }
    return s;
  }

  // ───────── 戰線 ─────────

  /**
   * 戰線位置：regs 依序在 anchor 兩側排開（橫向間距依各團寬度），全部朝 facing
   * @param {Own[]} regs
   * @param {Pt} anchor 世界座標
   * @param {number} facing 世界角度
   * @param {number} gapTiles 團與團之間的空隙
   * @returns {Map<number, Pt>}
   */
  lineSlots(regs, anchor, facing, gapTiles) {
    const widths = regs.map((r) => (r.radius * 2) / TILE + gapTiles);
    const total = widths.reduce((s, w) => s + w, 0);
    let off = -total / 2;
    /** @type {Map<number, Pt>} */
    const out = new Map();
    regs.forEach((r, i) => {
      const mid = off + widths[i] / 2;
      out.set(r.id, this.offset(anchor, facing + 90, mid));
      off += widths[i];
    });
    return out;
  }

  // ───────── 各兵種的戰術動作（回傳 true 表示這次已經處理） ─────────

  /**
   * 長槍：前方有騎兵逼近、或步兵正面壓上來時架槍林；沒威脅一陣子才收
   * @param {Pending[]} out
   * @param {Own} r
   * @param {boolean} mayHold 現在可以停下來架陣（戰線不需要前進）
   */
  spearReact(out, r, mayHold) {
    const s = this.state(r.id);
    // 騎兵：在前方、而且正朝我來或正在衝鋒
    const cav = this.nearestFoe(r, (e) => this.isCav(e.kind) && this.inFront(r, e, 75) && (e.dashing === 'charge' || this.approaching(e, r)), 14);
    // 步兵：正面壓上來（雙方都站著不動時不架，避免兩邊對峙）
    const inf = mayHold ? this.nearestFoe(r, (e) => !this.isCav(e.kind) && e.kind !== 'archer' && this.inFront(r, e, 60) && (this.approaching(e, r) || this.gap(r, e) < 1.5), 6) : null;
    const threat = cav || inf;
    const braced = r.status === 'braced' || r.status === 'bracing';
    if (threat) s.lastThreat = this.obs.tick;
    if (threat && !braced && !r.engaged) {
      const f = this.angle(r, threat);
      this.send(out, 9, { type: 'brace', id: r.id, facing: f }, cav ? '架槍林擋騎兵' : '架槍林守正面', 40);
      return true;
    }
    if (braced) {
      // 威脅消失 4 秒才收陣（避免架了又收）
      if (!threat && this.obs.tick - (s.lastThreat || 0) > 40) {
        this.send(out, 5, { type: 'unbrace', id: r.id }, '收槍林');
        return true;
      }
      return true;
    }
    return false;
  }

  /**
   * 劍士：近距離、對方沒架槍林或盾牆正面朝我時突擊
   * @param {Pending[]} out
   * @param {Own} r
   * @param {Enemy} t
   */
  swordAssault(out, r, t) {
    if (r.skillCooldown > 0 || r.dashing || r.engaged) return false;
    const d = this.gap(r, t);
    if (d < 1.5 || d > 6.5) return false;
    if (this.spearWall(t, r) || this.shieldWall(t, r) || t.dashing) return false;
    if (!this.inFront(r, t, 35)) return false;
    const p = this.predict(t, 15);
    this.send(out, 8, { type: 'assault', id: r.id, x: p.x, y: p.y }, `突擊${this.units[t.kind].name}`, 30);
    return true;
  }

  /**
   * 近戰挑目標：距離為主；避開槍林正面（騎兵、劍士）與盾牆正面；正在跟我方打的敵人優先（夾擊）
   * @param {Own} r
   * @param {number} maxTiles
   * @param {Map<number, number>} [load] 已經有幾團在打這個目標
   */
  meleeTarget(r, maxTiles, load) {
    /** @type {Enemy | null} */
    let best = null;
    let bestS = Infinity;
    for (const e of this.foes) {
      const d = this.gap(r, e);
      if (d > maxTiles) continue;
      // 步兵追不上騎兵：騎兵沒被纏住、也沒停下就不追
      if (!this.isCav(r.kind) && this.isCav(e.kind) && !e.engaged && e.status !== 'idle' && d > 2) continue;
      let s = d;
      if (e.engaged) s -= 5;
      if (e.kind === 'archer') s -= 4;
      if (r.kind === 'spear' && this.isCav(e.kind)) s -= 6;
      if (this.isCav(r.kind) || r.kind === 'sword' || r.kind === 'light') {
        if (this.spearWall(e, r)) s += 30;
      }
      if (this.shieldWall(e, r) && r.kind !== 'heavyCav') s += 8;
      if (r.kind === 'light' && e.kind !== 'archer' && !e.engaged) s += 10;
      s += 4 * ((load && load.get(e.id)) || 0);
      if (s < bestS) {
        bestS = s;
        best = e;
      }
    }
    return best;
  }

  /**
   * 側翼位置：目標側面（離目標正面 110° 的方向）dist 格處，選比較近、能走的一側
   * @param {Own} r
   * @param {Enemy} t
   * @param {number} tiles
   */
  flankPoint(r, t, tiles) {
    const a = this.offset(t, t.facing + 110, tiles);
    const b = this.offset(t, t.facing - 110, tiles);
    const okA = this.h.terrainAt(a.x, a.y) !== TR.river;
    const okB = this.h.terrainAt(b.x, b.y) !== TR.river;
    if (okA && (!okB || this.dist(r, a) <= this.dist(r, b))) return a;
    return b;
  }

  /**
   * 騎兵的衝鋒循環：等待 → 繞到側背 → 衝鋒 → 拉開重整 → 冷卻好再衝
   * @param {Pending[]} out
   * @param {Own} r
   * @param {Pt} rally 待命與重整的位置
   * @param {number} reach 找目標的範圍（格）
   * @returns {boolean}
   */
  cavalryCycle(out, r, rally, reach) {
    if (r.dashing) return true;
    const s = this.state(r.id);
    const heavy = r.kind === 'heavyCav';
    const name = heavy ? '重騎' : '輕騎';
    // 混戰中：對方快垮了就留下來砍，不然拉開
    if (r.engaged) {
      const near = this.nearestFoe(r, null, 2);
      const weak = near && near.men / near.men0 < 0.35 && near.kind !== 'spear';
      if (!weak && r.men > 1) {
        const back = this.offset(r, this.face(180), 10);
        this.send(out, 7, { type: 'move', id: r.id, x: back.x, y: back.y }, `${name}脫離重整`, 30);
        return true;
      }
      return false;
    }
    // 挑目標：弓兵、輕步兵、正在跟我方纏鬥的敵人、潰兵；避開槍林與（輕騎）盾牆的正面
    /** @type {Enemy | null} */
    let best = null;
    let bestS = -Infinity;
    for (const e of this.foes) {
      const d = this.gap(r, e);
      if (d > reach) continue;
      if (e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing') && e.formation !== 'circle') continue;
      if (e.kind === 'spear' && !e.engaged) continue;
      if (this.isCav(e.kind)) continue;
      if (e.dashing === 'charge') continue;
      let sc = 30 - d;
      if (e.kind === 'archer') sc += 25;
      if (e.kind === 'light') sc += 10;
      if (e.engaged) sc += 18;
      if (!this.inFront(e, r, 60)) sc += 12;
      if (!heavy && e.kind === 'shield') sc -= 25;
      if (sc > bestS) {
        bestS = sc;
        best = e;
      }
    }
    if (best && r.skillCooldown === 0) {
      const d = this.gap(r, best);
      // 在目標正面而且它沒在纏鬥：先繞到側面
      const exposed = !this.inFront(best, r, 60) || best.engaged;
      if (exposed && d >= 4 && d <= 22) {
        const p = this.predict(best, Math.round((d * TILE) / (heavy ? 600 : 680)));
        if (this.clearLine(r, p, true)) {
          s.chargedAt = this.obs.tick;
          this.send(out, 9, { type: 'charge', id: r.id, x: p.x, y: p.y }, `${name}衝鋒${this.units[best.kind].name}`, 20);
          return true;
        }
      }
      if (d <= 30) {
        const fp = this.flankPoint(r, best, 12);
        this.send(out, 6, { type: 'move', id: r.id, x: fp.x, y: fp.y }, `${name}繞到${this.units[best.kind].name}側面`, 20);
        return true;
      }
    }
    // 冷卻中或沒有目標：回待命點
    if (this.dist(r, rally) > 3000) {
      this.send(out, 2, { type: 'move', id: r.id, x: rally.x, y: rally.y, facing: this.forward }, r.skillCooldown > 0 ? `${name}重整，等待再衝` : `${name}在側翼待命`, 20);
      return true;
    }
    return false;
  }

  /**
   * 弓兵：近戰逼近就後撤；有密集或被纏住的敵軍就齊射；其餘站定自動射擊
   * @param {Pending[]} out
   * @param {Own} r
   * @param {Pt} post 射擊陣地
   * @returns {boolean}
   */
  archerReact(out, r, post) {
    const s = this.state(r.id);
    const range = this.units.archer.range / TILE;
    // 盾兵近戰弱又慢：貼到身邊才躲，否則一直被護送弓兵的盾兵趕著跑
    const melee = this.nearestFoe(r, (e) => e.kind !== 'archer' && !e.engaged && (e.kind === 'shield' ? this.gap(r, e) < 2 : this.approaching(e, r) || this.gap(r, e) < 3), 6);
    const screened = melee && this.obs.regiments.some((o) => o.id !== r.id && o.kind !== 'archer' && !o.routed && this.dist(o, melee) < this.dist(r, melee) - 1500);
    if (melee && !screened && !r.engaged && this.obs.tick - (s.kitedAt || -100) > 40) {
      const away = this.angle(melee, r);
      const back = this.offset(r, away, 9);
      s.kitedAt = this.obs.tick;
      this.send(out, 8, { type: 'move', id: r.id, x: back.x, y: back.y }, '後撤避開近戰', 30);
      return true;
    }
    if (r.status === 'volleying') return true;
    // 齊射：被我方纏住的敵人、淺灘中的敵人、或兩團擠在一起
    if (r.skillCooldown === 0 && r.status !== 'moving') {
      /** @type {Enemy | null} */
      let best = null;
      let bestS = 0;
      for (const e of this.foes) {
        const d = this.dist(r, e) / TILE;
        if (d > range + (r.height - e.height) - 1) continue;
        let sc = e.men;
        if (e.engaged) sc += 20;
        if (e.terrain === TR.shallow) sc += 25;
        if (e.kind === 'shield') sc -= 30;
        for (const o of this.foes) if (o !== e && this.dist(o, e) < 5000) sc += 15;
        if (sc > bestS) {
          bestS = sc;
          best = e;
        }
      }
      if (best && bestS >= 45) {
        const p = this.predict(best, 12);
        this.send(out, 7, { type: 'volley', id: r.id, x: p.x, y: p.y }, `齊射${this.units[best.kind].name}`, 30);
        return true;
      }
    }
    // 射程內有敵人：站定射擊，不再調整位置（除非離陣地太遠）
    // 集火：射程內挑最值得射的（舉盾的盾兵幾乎射不動；優先弓兵、被纏住的、殘兵）；最近的就是它時交給自動射擊
    /** @type {Enemy | null} */
    let pick = null;
    let pickS = -Infinity;
    let inRangeCount = 0;
    for (const e of this.foes) {
      const d = (this.dist(r, e) - e.radius / 2) / TILE;
      if (d > range + (r.height - e.height) - 1.5) continue;
      inRangeCount += 1;
      let sc = -d + (1 - e.men / e.men0) * 10;
      // 盾牆時姿態仍是持盾，要看狀態
      if (e.kind === 'shield') sc -= e.stance === 'carry' && e.status !== 'walled' && e.status !== 'walling' ? 10 : 40;
      if (e.kind === 'archer') sc += 12;
      if (e.engaged) sc += 8;
      if (e.routed) sc -= 30;
      if (sc > pickS) {
        pickS = sc;
        pick = e;
      }
    }
    if (pick && r.order === 'attack' && r.target === pick.id) return true;
    // 射程內不只一個目標：明確指定（引擎的自動射擊只挑最近的）
    if (pick && inRangeCount > 1) {
      this.send(out, 8, { type: 'attack', id: r.id, target: pick.id }, `集火${this.units[pick.kind].name}`, 40);
      return true;
    }
    // 剛後撤過、或陣地旁有敵方近戰：留在原地射擊，不走回陣地（避免撤退與回位來回跑）
    const inRange = this.foes.some((e) => this.dist(r, e) / TILE - e.radius / TILE / 2 <= range + (r.height - e.height) - 1);
    const contested = this.foes.some((e) => e.kind !== 'archer' && e.kind !== 'light' && this.dist(e, post) < 7000);
    const settle = inRange && (contested || this.obs.tick - (s.kitedAt || -1000) < 200);
    const far = this.dist(r, post) > (inRange ? 12000 : 2500);
    if (far && !settle && !this.committed(r) && this.obs.tick - (s.kitedAt || -100) > 60) {
      this.send(out, 3, { type: 'move', id: r.id, x: post.x, y: post.y, facing: this.forward }, '進入射擊陣地', 30);
      return true;
    }
    if (r.status !== 'moving' && r.order !== 'hold') {
      this.send(out, 1, { type: 'hold', id: r.id }, '站定射擊', 20);
      return true;
    }
    return false;
  }

  /**
   * 盾兵：跟著要保護的友軍；有弓兵威脅就舉盾、步兵逼近就架盾牆
   * @param {Pending[]} out
   * @param {Own} r
   * @param {Own | null} ward 要保護的友軍
   */
  shieldReact(out, r, ward) {
    const s = this.state(r.id);
    const archers = this.nearestFoe(r, (e) => e.kind === 'archer', 18);
    // 盾兵對盾兵架盾牆只會互相僵持：只對會打人的步兵架
    const inf = this.nearestFoe(r, (e) => !this.isCav(e.kind) && e.kind !== 'archer' && e.kind !== 'shield' && this.inFront(r, e, 70) && (this.approaching(e, r) || this.gap(r, e) < 1.5), 5);
    if (inf) s.lastInf = this.obs.tick;
    if (r.status === 'walled' || r.status === 'walling') {
      if (!inf && this.obs.tick - (s.lastInf || 0) > 30) {
        this.send(out, 5, { type: 'shield', id: r.id, mode: 'unwall' }, '收盾牆');
        return true;
      }
      return true;
    }
    if (inf && !r.engaged && !ward?.dashing) {
      this.send(out, 8, { type: 'shield', id: r.id, mode: 'wall' }, '架盾牆擋步兵', 40);
      return true;
    }
    const want = archers ? 'raise' : 'carry';
    if (r.stance !== want) {
      this.send(out, 6, { type: 'shield', id: r.id, mode: want }, want === 'raise' ? '舉盾擋箭' : '持盾行軍', 20);
      return true;
    }
    if (ward && r.order !== 'follow') {
      this.send(out, 3, { type: 'follow', id: r.id, target: ward.id, forward: 3500 }, `護送${this.units[ward.kind].name}`, 30);
      return true;
    }
    return false;
  }

  /**
   * 輕步兵：偵察；敵方弓兵落單就切入；被近戰盯上就退
   * @param {Pending[]} out
   * @param {Own} r
   * @param {Pt} watch 觀察點
   * @param {string} watchName
   */
  scoutReact(out, r, watch, watchName) {
    const threat = this.nearestFoe(r, (e) => e.kind !== 'archer' && e.kind !== 'light', 6);
    if (threat && !r.engaged) {
      const back = this.offset(r, this.angle(threat, r), 10);
      this.send(out, 8, { type: 'move', id: r.id, x: back.x, y: back.y }, '斥候後撤', 30);
      return true;
    }
    const prey = this.nearestFoe(r, (e) => e.kind === 'archer' && !this.foes.some((o) => o !== e && o.kind !== 'archer' && this.dist(o, e) < 6000), 12);
    if (prey) {
      if (r.skillCooldown === 0 && !r.dashing && this.gap(r, prey) > 2) {
        const p = this.predict(prey, 15);
        this.send(out, 9, { type: 'infiltrate', id: r.id, x: p.x, y: p.y }, '切入敵方弓兵', 25);
        return true;
      }
      this.send(out, 6, { type: 'attack', id: r.id, target: prey.id }, '襲擊敵方弓兵', 20);
      return true;
    }
    if (this.dist(r, watch) > 2000) {
      this.send(out, 1, { type: 'move', id: r.id, x: watch.x, y: watch.y }, `偵察${watchName}`, 30);
      return true;
    }
    return false;
  }

  /**
   * 該去找敵人了：交戰後 30 秒沒再打、或剩一分半還落後。回傳要去的點（最近的記得的敵軍，沒有就輪流搜敵方陣地）；不用找就是 null
   * @returns {Pt | null}
   */
  huntPoint() {
    if (this.lastFight < 0) return null;
    const behind = this.obs.timeLeft < 900 && this.strengthRatio() < 1;
    if (this.obs.tick - this.lastFight < 300 && !behind) return null;
    const own = this.obs.regiments.filter((r) => !r.routed);
    if (own.length === 0) return null;
    const c = { x: own.reduce((t, r) => t + r.x, 0) / own.length, y: own.reduce((t, r) => t + r.y, 0) / own.length };
    /** @type {Pt | null} */
    let best = null;
    let bestD = Infinity;
    for (const e of this.remembered(400)) {
      const d = this.dist(c, e);
      if (d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (best) return best;
    const sweep = [this.at(128, 50), this.at(110, 24), this.at(110, 76), this.at(86, 50)];
    return sweep[Math.floor(this.obs.tick / 300) % sweep.length];
  }

  // ───────── 佔點 ─────────

  /** 佔點模式的旗（殲滅戰是空的） */
  get flags() {
    return this.obs.flags;
  }

  /** 中央的旗（分數最高的） */
  get mainFlag() {
    return this.flags.reduce((/** @type {import('../src/legion/api.ts').FlagState | null} */ b, f) => (b === null || f.points > b.points ? f : b), null);
  }

  /**
   * 兩側的旗中，離 from 最近、還不是我的（或被爭奪中）的一面；except 是別人已經負責的旗
   * @param {Pt} from
   * @param {number} [except]
   */
  sideFlagFor(from, except = -1) {
    const main = this.mainFlag;
    let best = null;
    let bestD = Infinity;
    for (const f of this.flags) {
      if (f === main || f.id === except) continue;
      const d = this.dist(from, f) * (f.owner === this.p && !f.contested ? 3 : 1);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  /**
   * 去佔領（或守住）旗點：站進圈內；佔下來後留在圈內
   * @param {Pending[]} out
   * @param {Own} r
   * @param {import('../src/legion/api.ts').FlagState} f
   * @param {number} prio
   */
  takeFlag(out, r, f, prio) {
    if (this.dist(r, f) <= this.data.capture.radius * 0.5) return false;
    const why = f.owner === this.p ? (f.contested ? `守住${f.name}` : `回防${f.name}`) : `佔領${f.name}`;
    this.send(out, prio, { type: 'move', id: r.id, x: f.x, y: f.y }, why, 30);
    return true;
  }

  /** 我方剩餘人數 vs 記得的敵方人數 */
  strengthRatio() {
    const mine = this.obs.regiments.filter((r) => !r.routed).reduce((s, r) => s + r.men * this.units[r.kind].cost / this.units[r.kind].men, 0);
    const theirs = this.remembered(300).reduce((s, e) => s + e.men * this.units[e.kind].cost / this.units[e.kind].men, 0);
    return theirs === 0 ? 9 : mine / theirs;
  }
}

/** @typedef {import('../src/legion/api.ts').FlagState} Flag */
/** @typedef {{ members: Memory[], x: number, y: number, pts: number, engaged: boolean, cav: number, spears: number }} Cluster */
/** @typedef {'集結' | '固守' | '迎擊' | '決戰' | '收攏' | '進攻' | '搜敵'} Posture */
/** @typedef {{ anchor: Pt, facing: number, mode: 'hold' | 'advance' | 'engage', leash: number, column: boolean }} LineMission */

export default class Commander extends LegionBase {
  constructor() {
    super();
    /** @type {Posture} */
    this.posture = '集結';
    this.stratAt = -100;
    this.planText = '';
    this.planSent = '';
    /** 戰場位置：己方這一側、中央渡口後方的河岸 */
    /** @type {Pt} */
    this.bp = { x: 0, y: 0 };
    /** @type {Pt} */
    this.crossing = { x: 0, y: 0 };
    this.inPositionAt = -1;
    /** 兵力推估：看到被殲滅的敵方點數、每團上次看到的人數 */
    this.killedPts = 0;
    /** @type {Map<number, number>} */
    this.lastMen = new Map();
    /** @type {Set<number>} */
    this.routedSeen = new Set();
    this.myPts = 0;
    this.enemyPts = 500;
    this.ratio = 1;
    /** @type {Cluster[]} */
    this.clusters = [];
    /** 戰線任務 @type {LineMission} */
    this.line = { anchor: { x: 0, y: 0 }, facing: 0, mode: 'hold', leash: 6, column: false };
    /** 被遠程壓制（掉血但沒在近戰）的累計 tick */
    this.pressure = 0;
    this.lastHp = -1;
    /** 佔點：各團負責的旗（團 id → 旗 id） @type {Map<number, number>} */
    this.flagJob = new Map();
    /** 本次決策中已被護衛或守旗占用的團 @type {Set<number>} */
    this.busyIds = new Set();
    /** 佔點：己方的橋、對方的橋 @type {Flag | null} */
    this.nearFlag = null;
    /** @type {Flag | null} */
    this.farFlag = null;
    this.lastTick = 0;
    /** 目前要對付的敵軍集團 @type {Cluster | null} */
    this.engageTarget = null;
    /** 進攻要走的渡口 @type {Pt | null} */
    this.attackCrossing = null;
    /** 佔點：得分競賽落後、兵力又不夠主攻時，派騎兵騷擾對方的橋 */
    this.raid = false;
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '統帥',
      version: 'v1',
      style: '三層指揮：指揮官評估兵力與地形決定姿態，戰線一起推進、弓兵佔高處集火、騎兵等敵人被纏住再衝側背；佔點時分兵守旗與襲擾',
      knobs: [
        { key: 'style', name: '風格', description: '0 均衡、1 進攻（兵力稍弱也接戰）、2 防守（佔優才接戰）', min: 0, max: 2, default: 0, integer: true },
        { key: 'patience', name: '耐心', description: '在戰場位置等敵人來的時間（秒），之後主動進攻', min: 10, max: 180, default: 45, integer: true },
        { key: 'cavalry', name: '騎兵', description: '騎兵團數', min: 0, max: 2, default: 1, integer: true },
        { key: 'archers', name: '弓兵', description: '弓兵團數', min: 0, max: 3, default: 2, integer: true },
      ],
    };
  }

  // ───────── 布陣 ─────────

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  deploy(data, helpers) {
    this.setup(data, helpers);
    const k = data.knobs;
    const cav = k.cavalry ?? 1;
    const arch = k.archers ?? 2;
    /** @type {[UnitKind, string][]} */
    const wish = [['spear', 'line'], ['spear', 'line'], ['sword', 'line']];
    for (let i = 0; i < arch; i++) wish.push(['archer', 'fire']);
    if (arch > 0) wish.push(['shield', 'escort']);
    if (cav >= 1) wish.push(['heavyCav', 'strike']);
    if (cav >= 2) wish.push(['lightCav', 'strike']);
    wish.push(['light', 'screen']);
    wish.push(['sword', 'line']);
    wish.push(['sword', 'line'], ['light', 'screen'], ['spear', 'line']);
    const list = this.buy(wish);
    let li = 0;
    let ai = 0;
    let ci = 0;
    let si = 0;
    const lineYs = [50, 42, 58, 34, 66, 26];
    /** @type {PlanEntry[]} */
    const plan = list.map((e) => {
      if (e.role === 'line') return { ...e, tx: 16, ty: lineYs[li++ % lineYs.length], facing: 0, ...(e.type === 'spear' ? { formation: /** @type {const} */ ('square') } : {}) };
      if (e.role === 'fire') return { ...e, tx: 9, ty: [46, 54, 50][ai++ % 3], facing: 0, width: 12 };
      if (e.role === 'escort') return { ...e, tx: 12, ty: 50, facing: 0 };
      if (e.role === 'strike') return { ...e, tx: 8, ty: [74, 26][ci++ % 2], facing: 0, formation: /** @type {const} */ ('wedge') };
      return { ...e, tx: 5, ty: [36, 64][si++ % 2], facing: 0 };
    });
    this.chooseBattlefield();
    return this.deployFrom(plan);
  }

  /** 戰場位置：最靠近地圖中央的渡口（淺灘優先）往己方退 8 格的河岸 */
  chooseBattlefield() {
    const mid = { x: this.W / 2, y: this.H / 2 };
    const fords = this.localOrder(this.geo.fords.length ? this.geo.fords : this.geo.bridges);
    let best = fords[0] || mid;
    for (const f of fords) if (this.dist(f, mid) < this.dist(best, mid)) best = f;
    this.crossing = { x: best.x, y: best.y };
    let bestS = -Infinity;
    for (const a of [0, -20, 20, -40, 40]) {
      const p = this.landBehind(this.offset(this.crossing, this.face(180) + a, 8), this.face(180));
      const hg = this.highGround(this.offset(p, this.face(180), 6), 6);
      const s = this.h.heightAt(hg.x, hg.y) * 10 - Math.abs(a) * 0.08;
      if (s > bestS) {
        bestS = s;
        this.bp = p;
      }
    }
  }

  /**
   * 依己方視角排序（先 y 後 x）：同分時雙方的選擇互相對稱
   * @template {Pt} T
   * @param {T[]} list
   * @returns {T[]}
   */
  localOrder(list) {
    return [...list].sort((a, b) => this.loc(a).y - this.loc(b).y || this.loc(a).x - this.loc(b).x);
  }

  /**
   * 落在可站的陸地上：在河裡就往 back 方向退，最多 10 格
   * @param {Pt} p
   * @param {number} back 世界角度
   */
  landBehind(p, back) {
    let q = p;
    for (let i = 0; i < 10; i++) {
      const t = this.h.terrainAt(q.x, q.y);
      if (t !== TR.river && t !== TR.building && t !== TR.wall && t !== TR.shallow) return q;
      q = this.offset(q, back, 1);
    }
    return q;
  }

  // ───────── 每次決策 ─────────

  /** @param {Observation} obs */
  decide(obs) {
    this.update(obs);
    this.assess();
    if (obs.tick - this.stratAt >= 20) {
      this.stratAt = obs.tick;
      this.strategize();
    }
    /** @type {Pending[]} */
    const out = [];
    this.busyIds = new Set();
    this.control(out);
    /** @type {import('../src/legion/api.ts').LegionCommand[]} */
    const cmds = this.flush(out);
    if (this.planText !== this.planSent) {
      cmds.push({ type: 'plan', text: this.planText });
      this.planSent = this.planText;
    }
    return cmds;
  }

  // ───────── 評估 ─────────

  /** @param {UnitKind} kind */
  perMan(kind) {
    return this.units[kind].cost / this.units[kind].men;
  }

  assess() {
    const obs = this.obs;
    for (const e of obs.enemies) {
      const prev = this.lastMen.get(e.id);
      if (prev !== undefined && e.men < prev) this.killedPts += (prev - e.men) * this.perMan(e.kind);
      if (e.routed && !this.routedSeen.has(e.id)) {
        this.routedSeen.add(e.id);
        this.killedPts += e.men * this.perMan(e.kind);
      }
      this.lastMen.set(e.id, e.men);
    }
    const mine = obs.regiments.filter((r) => !r.routed);
    this.myPts = mine.reduce((s, r) => s + r.men * this.perMan(r.kind), 0);
    const known = this.remembered(600).filter((e) => !e.routed).reduce((s, e) => s + e.men * this.perMan(e.kind), 0);
    this.enemyPts = Math.max(known, this.data.budget * 0.96 - this.killedPts, 1);
    this.ratio = this.myPts / this.enemyPts;
    // 遠程壓制：掉血但沒有任何一團在近戰
    const hp = mine.reduce((s, r) => s + r.hp, 0);
    const meleeing = mine.some((r) => r.engaged);
    if (this.lastHp >= 0 && hp < this.lastHp && !meleeing) this.pressure += obs.tick - this.lastTick;
    else if (meleeing || hp >= this.lastHp) this.pressure = Math.max(0, this.pressure - 2);
    this.lastHp = hp;
    this.lastTick = obs.tick;
    this.clusters = this.cluster(this.remembered(250).filter((e) => !e.routed), 12);
  }

  /**
   * 敵軍集團：彼此 tiles 格內的歸成一群
   * @param {Memory[]} list
   * @param {number} tiles
   * @returns {Cluster[]}
   */
  cluster(list, tiles) {
    /** @type {Cluster[]} */
    const out = [];
    for (const e of list) {
      let c = out.find((g) => this.dist(g, e) <= tiles * TILE);
      if (!c) {
        c = { members: [], x: e.x, y: e.y, pts: 0, engaged: false, cav: 0, spears: 0 };
        out.push(c);
      }
      c.members.push(e);
      const n = c.members.length;
      c.x = (c.x * (n - 1) + e.x) / n;
      c.y = (c.y * (n - 1) + e.y) / n;
      c.pts += e.men * this.perMan(e.kind);
      if (e.engaged) c.engaged = true;
      if (this.isCav(e.kind)) c.cav += 1;
      if (e.kind === 'spear') c.spears += 1;
    }
    return out.sort((a, b) => b.pts - a.pts);
  }

  /** @param {readonly Own[]} regs */
  centroid(regs) {
    if (regs.length === 0) return null;
    return { x: regs.reduce((s, r) => s + r.x, 0) / regs.length, y: regs.reduce((s, r) => s + r.y, 0) / regs.length };
  }

  /** @param {readonly Own[]} regs */
  ptsOf(regs) {
    return regs.reduce((s, r) => s + r.men * this.perMan(r.kind), 0);
  }

  /**
   * 每人交換比：a 打 b 每秒殺掉 b 的比例 ÷ b 打 a 的比例（近戰；含相剋與減免）
   * @param {UnitKind} a
   * @param {UnitKind} b
   */
  edge(a, b) {
    const A = this.units[a];
    const B = this.units[b];
    const va = (this.data.versus[a]?.[b] ?? 100) / 100;
    const vb = (this.data.versus[b]?.[a] ?? 100) / 100;
    const da = ((A.meleeAttack / A.cooldown) * va * (100 - B.meleeDR)) / 100 / B.hp;
    const db = ((B.meleeAttack / B.cooldown) * vb * (100 - A.meleeDR)) / 100 / A.hp;
    return Math.max(0.25, Math.min(4, da / Math.max(1e-9, db)));
  }

  // ───────── 指揮官：姿態與任務 ─────────

  /** 依風格：接戰需要的局部兵力比 */
  get fightEdge() {
    const st = this.k.style ?? 0;
    return st === 1 ? 0.7 : st === 2 ? 1.05 : 0.85;
  }

  /** 戰線的團（槍兵、劍士；不含被派去守旗的） */
  lineRegs() {
    return this.obs.regiments.filter((r) => !r.routed && (r.kind === 'spear' || r.kind === 'sword') && !this.flagJob.has(r.id));
  }

  strategize() {
    const capture = this.data.mode === 'capture';
    if (capture) this.assignFlags();
    const line = this.lineRegs();
    const archers = this.obs.regiments.filter((r) => !r.routed && r.kind === 'archer');
    const main = [...line, ...archers];
    const mc = this.centroid(main.length ? main : this.obs.regiments) || this.bp;
    const fwd = this.forward;
    // 附近的敵軍集團（不含只是路過的輕步兵、騎兵小隊）
    const near = this.clusters.filter((c) => this.dist(c, mc) < 30 * TILE && c.pts >= 25);
    const nearPts = near.reduce((s, c) => s + c.pts, 0);
    const localRatio = this.ptsOf(main) / Math.max(1, nearPts);
    const home = capture ? this.flagHome() : this.bp;
    /** @type {Posture} */
    let posture;
    /** @type {LineMission} */
    let mission;
    if (near.length > 0) {
      const target = near.reduce((a, b) => (this.dist(a, mc) <= this.dist(b, mc) ? a : b));
      const face = this.angle(mc, target);
      const engaged = line.some((r) => r.engaged);
      const coming = target.members.some((e) => this.approaching(e, mc) && !this.isCav(e.kind)) || target.engaged;
      // 地形修正：要涉水過河 ×0.6；敵人每高一階 ×0.85
      const wet = this.waterBetween(mc, target);
      const up = Math.max(0, this.h.heightAt(target.x, target.y) - this.h.heightAt(mc.x, mc.y));
      let eff = localRatio * (wet ? 0.6 : 1);
      for (let i = 0; i < up; i++) eff *= 0.85;
      const archersOpp = target.members.filter((e) => e.kind === 'archer').length;
      // 主動進攻要把看不到的敵軍算進去（推估總兵力 − 記得的），對方主力多半就在附近
      const known = this.remembered(600).filter((e) => !e.routed).reduce((t, e) => t + e.men * this.perMan(e.kind), 0);
      const unseen = Math.max(0, this.enemyPts - known);
      const attackEff = (this.ptsOf(main) / Math.max(1, nearPts + unseen * 0.6)) * (eff / Math.max(1e-9, localRatio));
      if (engaged && eff < this.fightEdge * 0.6 && localRatio < 0.65) {
        posture = '收攏';
        const away = this.angle(target, mc);
        const back = this.behind(mc, home, target) ? home : this.landBehind(this.offset(mc, away, 14), away);
        mission = { anchor: back, facing: this.angle(back, target), mode: 'hold', leash: 2, column: false };
      } else if (engaged) {
        posture = '決戰';
        mission = { anchor: this.stepToward(line.length ? this.centroid(line) || mc : mc, target, 4), facing: face, mode: 'engage', leash: 12, column: false };
      } else if (eff < this.fightEdge * 0.75) {
        posture = '收攏';
        const away = this.angle(target, mc);
        const back = this.behind(mc, home, target) ? home : this.landBehind(this.offset(mc, away, 12), away);
        mission = { anchor: back, facing: this.angle(back, target), mode: 'hold', leash: 4, column: false };
      } else if (coming) {
        posture = '迎擊';
        const at = capture ? home : this.dist(mc, home) < 12 * TILE ? home : mc;
        mission = { anchor: at, facing: this.angle(at, target), mode: 'hold', leash: 6, column: false };
      } else if (attackEff >= this.fightEdge * 1.3 || (capture && this.standoff() && eff >= this.fightEdge * 0.8)) {
        posture = '決戰';
        mission = { anchor: this.stepToward(mc, target, 7), facing: face, mode: 'engage', leash: 12, column: wet && this.dist(mc, target) < 20 * TILE };
      } else if (this.pressure > 40 && archersOpp > 0) {
        // 對方弓兵在射、我方打不贏：退出射程
        posture = '收攏';
        const away = this.angle(target, mc);
        const back = this.landBehind(this.offset(target, away, 17), away);
        mission = { anchor: back, facing: this.angle(back, target), mode: 'hold', leash: 4, column: false };
      } else {
        posture = '迎擊';
        const at = capture ? home : this.dist(mc, home) < 12 * TILE ? home : mc;
        mission = { anchor: at, facing: this.angle(at, target), mode: 'hold', leash: 6, column: false };
      }
      this.engageTarget = target;
    } else if (capture) {
      posture = '固守';
      const mf = this.mainFlag;
      mission = { anchor: home, facing: mf ? this.angle(home, mf) : fwd, mode: 'hold', leash: 6, column: false };
      // 得分競賽：照目前的得分速度誰先到目標分；會輸就要改變局面
      const race = this.raceLosing();
      this.raid = race && this.ratio < 1.15;
      const enemyFlag = this.flags.filter((f) => f.owner === 1 - this.p && !f.contested).sort((a, b) => b.points - a.points || this.dist(a, mc) - this.dist(b, mc))[0];
      if (enemyFlag && race && (this.ratio >= 1.15 || this.obs.timeLeft < 1500)) {
        posture = '進攻';
        mission = { anchor: this.stepToward(mc, enemyFlag, 8), facing: this.angle(mc, enemyFlag), mode: 'advance', leash: 10, column: this.waterBetween(mc, enemyFlag) && this.dist(mc, enemyFlag) < 18 * TILE };
      }
    } else {
      // 殲滅戰、附近沒有敵人：集結到戰場位置 → 固守等敵人 → 等太久就過河進攻 → 找不到人就搜敵
      const atBp = this.dist(mc, this.bp) < 9 * TILE;
      if (atBp && this.inPositionAt < 0) this.inPositionAt = this.obs.tick;
      const waited = this.inPositionAt >= 0 ? this.obs.tick - this.inPositionAt : 0;
      const patience = (this.k.patience ?? 45) * 10;
      const hunt = this.huntPoint();
      const late = this.obs.timeLeft < 1200 && this.ratio < 1.1;
      const target = this.clusters[0];
      if (hunt && this.lastFight >= 0) {
        posture = '搜敵';
        mission = this.advanceMission(mc, hunt);
      } else if ((waited > patience && this.ratio >= this.fightEdge) || late || this.posture === '進攻') {
        posture = '進攻';
        if (this.posture !== '進攻' || !this.attackCrossing) this.attackCrossing = this.pickCrossing(mc, target || null);
        const goal = target ? { x: target.x, y: target.y } : this.at(128, 50);
        mission = this.advanceMission(mc, goal);
      } else {
        posture = atBp ? '固守' : '集結';
        mission = { anchor: this.bp, facing: target ? this.angle(this.bp, target) : fwd, mode: atBp ? 'hold' : 'advance', leash: atBp ? 6 : 4, column: false };
      }
    }
    if (near.length === 0) this.engageTarget = null;
    this.posture = posture;
    this.line = mission;
    this.planText = this.describe();
  }

  /**
   * p 在 me 的「後方」（相對 enemy）而且比較遠離敵人
   * @param {Pt} me
   * @param {Pt} p
   * @param {Pt} enemy
   */
  behind(me, p, enemy) {
    return this.adiff(this.angle(me, p), this.angle(me, enemy)) > 100 && this.dist(p, enemy) > this.dist(me, enemy);
  }

  /**
   * 安全的行軍：直線路上會經過敵軍（不含 except）旁邊 4 格內，就先走到它側面的繞道點
   * @param {Own} r
   * @param {Pt} dest
   * @param {number} [except] 要去打的敵團
   */
  safeStep(r, dest, except = -1) {
    const d = this.dist(r, dest);
    if (d < 3000) return dest;
    const dir = this.angle(r, dest);
    const ux = (dest.x - r.x) / d;
    const uy = (dest.y - r.y) / d;
    /** @type {Enemy | null} */
    let block = null;
    let blockD = Infinity;
    for (const e of this.foes) {
      if (e.id === except || e.routed) continue;
      // e 投影在路上的位置與離路的距離
      const ex = e.x - r.x;
      const ey = e.y - r.y;
      const along = ex * ux + ey * uy;
      if (along < 0 || along > d + (e.radius || 0)) continue;
      const side = Math.abs(ex * uy - ey * ux);
      if (side > (e.radius || 0) + (r.radius || 0) + 4 * TILE) continue;
      if (along < blockD) {
        blockD = along;
        block = e;
      }
    }
    if (!block) return dest;
    const clear = (block.radius || 0) + (r.radius || 0) + 6 * TILE;
    const a = this.offset(block, dir + 90, clear / TILE);
    const b = this.offset(block, dir - 90, clear / TILE);
    const ok = (/** @type {Pt} */ q) => {
      const t = this.h.terrainAt(q.x, q.y);
      return t !== TR.river && t !== TR.building && t !== TR.wall && q.x > 0 && q.y > 0 && q.x < this.W && q.y < this.H;
    };
    const score = (/** @type {Pt} */ q) => (ok(q) ? 0 : 1e9) + this.dist(q, dest) + this.dist(r, q) * 0.3;
    return score(a) <= score(b) ? a : b;
  }

  /**
   * r 直線走到 dest 的路上（到 dest 之前）會碰到別的敵團
   * @param {Own} r
   * @param {Pt} dest
   * @param {number} except
   */
  pathBlocked(r, dest, except) {
    const d = this.dist(r, dest);
    if (d < 1) return false;
    const ux = (dest.x - r.x) / d;
    const uy = (dest.y - r.y) / d;
    return this.foes.some((e) => {
      if (e.id === except || e.routed) return false;
      const ex = e.x - r.x;
      const ey = e.y - r.y;
      const along = ex * ux + ey * uy;
      if (along < 0 || along > d - (e.radius || 0)) return false;
      return Math.abs(ex * uy - ey * ux) < (e.radius || 0) + (r.radius || 0) + 1000;
    });
  }

  /**
   * 從 a 往 b 走 tiles 格（不超過 b）
   * @param {Pt} a
   * @param {Pt} b
   * @param {number} tiles
   */
  stepToward(a, b, tiles) {
    return this.dist(a, b) <= tiles * TILE ? { x: b.x, y: b.y } : this.offset(a, this.angle(a, b), tiles);
  }

  /**
   * a 走到 b 要經過幾格河、淺灘
   * @param {Pt} a
   * @param {Pt} b
   */
  wetTiles(a, b) {
    const n = Math.max(1, Math.ceil(this.dist(a, b) / 1000));
    let w = 0;
    for (let i = 1; i <= n; i++) {
      const t = this.h.terrainAt(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      if (t === TR.river || t === TR.shallow) w += 1;
    }
    return w;
  }

  /**
   * 兩點之間有河或淺灘（要涉水或過橋）
   * @param {Pt} a
   * @param {Pt} b
   */
  waterBetween(a, b) {
    const n = Math.max(1, Math.ceil(this.dist(a, b) / 1000));
    for (let i = 1; i < n; i++) {
      const t = this.h.terrainAt(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      if (t === TR.river || t === TR.shallow || t === TR.bridge) return true;
    }
    return false;
  }

  /** 佔點：中央旗點被雙方爭奪（都站在圈內）、而且 20 秒沒有交戰：僵持中 */
  standoff() {
    const mf = this.mainFlag;
    if (!mf) return false;
    const rad = this.data.capture.radius;
    const mine = this.obs.regiments.some((r) => !r.routed && this.dist(r, mf) < rad + (r.radius || 0));
    const theirs = this.foes.some((e) => this.dist(e, mf) < rad + (e.radius || 0));
    return mine && theirs && this.obs.tick - Math.max(0, this.lastFight) > 200;
  }

  /** 佔點：照目前雙方的得分速度（佔著、沒被爭奪的旗），對方會先到目標分 */
  raceLosing() {
    const goal = this.data.capture.scoreTarget;
    const rate = (/** @type {number} */ p) => this.flags.reduce((t, f) => t + (f.owner === p && !f.contested ? f.points : 0), 0);
    const sc = this.obs.score;
    const mine = rate(this.p);
    const theirs = rate(1 - this.p);
    const tMe = mine > 0 ? (goal - sc[this.p]) / mine : Infinity;
    const tThem = theirs > 0 ? (goal - sc[1 - this.p]) / theirs : Infinity;
    return tThem < tMe || (tThem === Infinity && tMe === Infinity && sc[this.p] < sc[1 - this.p]);
  }

  /**
   * 推進任務：還沒過河就先走到渡口對岸（縱隊通過），過河後往目標推進；每次最多比戰線重心前 7 格，維持隊形
   * @param {Pt} mc 主力重心
   * @param {Pt} goal
   * @returns {LineMission}
   */
  advanceMission(mc, goal) {
    const cr = this.attackCrossing || this.crossing;
    const crossed = this.loc(mc).x > this.loc(cr).x + 4;
    const needCross = !crossed && this.loc(goal).x > this.loc(cr).x;
    const exit = this.landBehind(this.offset(cr, this.forward, 9), this.forward);
    const target = needCross ? (this.dist(mc, cr) > 10 * TILE ? this.landBehind(this.offset(cr, this.face(180), 6), this.face(180)) : exit) : goal;
    const d = this.dist(mc, target);
    const step = d > 9 * TILE ? this.offset(mc, this.angle(mc, target), 7) : target;
    const column = needCross && this.dist(mc, cr) < 14 * TILE;
    return { anchor: step, facing: this.angle(mc, goal), mode: 'advance', leash: 8, column };
  }

  /**
   * 進攻的渡口：離敵軍主力遠（避開對方的弓兵與高地）、離我方近
   * @param {Pt} mc
   * @param {Cluster | null} enemy
   */
  pickCrossing(mc, enemy) {
    const all = this.localOrder([...this.geo.fords, ...this.geo.bridges]);
    if (all.length === 0) return this.crossing;
    let best = all[0];
    let bestS = -Infinity;
    for (const c of all) {
      const s = (enemy ? Math.min(30 * TILE, this.dist(c, enemy)) : 0) - this.dist(c, mc) * 0.6 + (this.geo.fords.includes(c) ? 3 * TILE : 0);
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    return { x: best.x, y: best.y };
  }

  /** 觀戰顯示的戰略意圖 */
  describe() {
    const capture = this.data.mode === 'capture';
    const where = (/** @type {Pt} */ p) => this.placeName(p);
    switch (this.posture) {
      case '集結':
        return `集結：主力到${where(this.bp)}列陣`;
      case '固守':
        return capture ? `佔點：主力守${this.mainFlag?.name ?? '中央'}，分兵守旗襲擾` : `固守：在${where(this.bp)}等敵軍過河`;
      case '迎擊':
        return '迎擊：戰線站穩，弓兵先射，等敵人上來';
      case '決戰':
        return '決戰：戰線接敵，騎兵找側背';
      case '收攏':
        return `收攏：兵力不足，退回${capture ? '旗點' : where(this.bp)}重整`;
      case '進攻':
        return capture ? '進攻：分數落後，全軍搶旗' : `進攻：經${where(this.attackCrossing || this.crossing)}過河壓上`;
      case '搜敵':
        return '搜敵：交戰中斷，主動找敵軍';
      default:
        return '';
    }
  }

  /**
   * 地點的名字：最近的旗點、淺灘、橋、高地
   * @param {Pt} p
   */
  placeName(p) {
    /** @type {[string, Pt][]} */
    const cands = [];
    for (const f of this.flags) cands.push([f.name, f]);
    for (const f of this.geo.fords) cands.push(['淺灘', f]);
    for (const b of this.geo.bridges) cands.push([this.loc(b).y < 50 ? '北橋' : '南橋', b]);
    let best = '河岸';
    let bestD = 16 * TILE;
    for (const [n, q] of cands) {
      const d = this.dist(p, q);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  // ───────── 佔點：分派各旗 ─────────

  /** 主力在中央旗的站位：中央旗往己方退 4 格的河岸（站在圈內但不下水） */
  flagHome() {
    const mf = this.mainFlag;
    if (!mf) return this.bp;
    return this.landBehind(this.offset(mf, this.face(180), 4), this.face(180));
  }

  assignFlags() {
    const flags = this.flags;
    const mf = this.mainFlag;
    const sides = flags.filter((f) => f !== mf);
    if (sides.length === 0) return;
    // 己方的橋（離己方布陣區近的）與對方的橋
    const myRear = this.at(0, 50);
    sides.sort((a, b) => this.dist(a, myRear) - this.dist(b, myRear));
    const near = sides[0];
    const far = sides[1] || null;
    this.nearFlag = near;
    this.farFlag = far;
    // 主力集中守中央；己方的橋交給斥候，被騷擾時由騎兵回防（不再固定派長槍駐守，避免中央兵力不足）
    this.flagJob.clear();
  }

  // ───────── 戰鬥群 ─────────

  /** @param {Pending[]} out */
  control(out) {
    const regs = this.obs.regiments.filter((r) => !r.routed);
    const archers = regs.filter((r) => r.kind === 'archer');
    this.guard(out, archers);
    this.garrison(out);
    this.lineControl(out, this.lineRegs().filter((r) => !this.busyIds.has(r.id)));
    this.fireControl(out, archers, regs.filter((r) => r.kind === 'shield'));
    this.strikeControl(out, regs.filter((r) => this.isCav(r.kind) && !this.busyIds.has(r.id)));
    this.screenControl(out, regs.filter((r) => r.kind === 'light' && !this.busyIds.has(r.id)));
  }

  /**
   * 護衛：敵人（沒被纏住）逼近弓兵 7 格內，就近派一團攔截（騎兵派槍兵，步兵派劍士或槍兵）
   * @param {Pending[]} out
   * @param {Own[]} archers
   */
  guard(out, archers) {
    for (const a of archers) {
      // 會動、正朝弓兵來（或已經貼近）的敵人才算威脅；站著架盾牆、槍林的不算
      const threat = this.nearestFoe(a, (e) => e.kind !== 'archer' && !e.engaged && !e.routed && e.status !== 'walled' && e.status !== 'walling' && e.status !== 'braced' && (this.approaching(e, a) || this.gap(a, e) < 1.2), 7);
      if (!threat) continue;
      const cav = this.isCav(threat.kind);
      const pool = this.obs.regiments.filter((r) => !r.routed && !r.engaged && !r.dashing && !this.busyIds.has(r.id) && !this.flagJob.has(r.id) && (cav ? r.kind === 'spear' || r.kind === 'heavyCav' : r.kind === 'sword' || r.kind === 'spear' || r.kind === 'shield'));
      const best = pool.sort((x, y) => this.dist(x, threat) - this.dist(y, threat))[0];
      if (!best || this.dist(best, threat) > 16 * TILE) continue;
      this.busyIds.add(best.id);
      if (best.kind === 'spear' && cav && this.gap(best, threat) < 6 && best.status !== 'braced' && best.status !== 'bracing') {
        this.send(out, 9, { type: 'brace', id: best.id, facing: this.angle(best, threat) }, '架槍林護弓兵', 30);
        continue;
      }
      if (best.status === 'braced' && cav) continue;
      this.send(out, 7, { type: 'attack', id: best.id, target: threat.id }, `攔截${this.units[threat.kind].name}`, 20);
    }
  }

  /**
   * 守旗：被分派的團站進旗點；有敵人進圈就打
   * @param {Pending[]} out
   */
  garrison(out) {
    for (const [id, fid] of this.flagJob) {
      const r = this.obs.regiments.find((x) => x.id === id);
      const f = this.flags.find((x) => x.id === fid);
      if (!r || !f || r.routed) continue;
      this.busyIds.add(r.id);
      if (r.kind === 'spear' && this.spearGuard(out, r, true)) continue;
      const foe = this.nearestFoe(f, (e) => !e.routed && this.dist(e, f) < this.data.capture.radius + 4 * TILE, 12);
      if (foe && !(r.kind === 'spear' && this.isCav(foe.kind) && !foe.engaged)) {
        this.send(out, 6, { type: 'attack', id: r.id, target: foe.id }, `守旗：攔截${this.units[foe.kind].name}`, 20);
        continue;
      }
      if (!r.engaged) this.takeFlag(out, r, f, 5);
    }
  }

  /**
   * 戰線：槍兵居中、劍士兩翼；依任務站位、推進或接敵；目標依相剋分配，只打離自己站位 leash 格內的敵人
   * @param {Pending[]} out
   * @param {Own[]} line
   */
  lineControl(out, line) {
    if (line.length === 0) return;
    const m = this.line;
    // 排列：劍士在兩側、槍兵在中間
    const spears = line.filter((r) => r.kind === 'spear');
    const swords = line.filter((r) => r.kind === 'sword');
    /** @type {Own[]} */
    const order = [];
    swords.forEach((s, i) => (i % 2 === 0 ? order.unshift(s) : order.push(s)));
    const mid = Math.ceil(order.length / 2);
    order.splice(mid, 0, ...spears);
    // 佔點守中央：正面不超過 18 格（太寬就排兩排），兵力集中在旗點圈附近
    const slots = m.column ? this.columnSlots(order, m.anchor, m.facing) : this.data.mode === 'capture' ? this.compactSlots(order, m.anchor, m.facing, 18) : this.lineSlots(order, m.anchor, m.facing, 1.5);
    for (const [id, p] of slots) slots.set(id, this.landBehind(p, m.facing + 180));
    const targets = this.assignTargets(order, slots, m.leash, this.posture === '收攏');
    // 推進中（沒有任何一團接敵）：沿朝向的進度比最慢的一團多 4 格以上就等
    const progress = (/** @type {Own} */ r) => {
      const dx = r.x - m.anchor.x;
      const dy = r.y - m.anchor.y;
      const [fx, fy] = this.h.offset(0, 0, m.facing, 1000);
      return (dx * fx + dy * fy) / 1000 / TILE;
    };
    const anyEngaged = order.some((r) => r.engaged);
    const slowest = Math.min(...order.map(progress));
    for (const r of order) {
      const slot = slots.get(r.id) || m.anchor;
      if (!anyEngaged && m.mode !== 'hold' && order.length > 1 && progress(r) - slowest > 4 && !r.engaged) {
        if (r.kind === 'spear' && this.spearGuard(out, r, false)) continue;
        if (r.status !== 'idle') this.send(out, 4, { type: 'hold', id: r.id }, '等戰線跟上', 15);
        continue;
      }
      if (r.kind === 'spear' && this.spearGuard(out, r, m.mode !== 'advance')) continue;
      const t = targets.get(r.id);
      if (t) {
        if (r.kind === 'sword' && this.swordAssault(out, r, t)) continue;
        const via = r.engaged ? t : this.safeStep(r, t, t.id);
        if (via !== t && this.dist(r, t) > 4000) {
          this.send(out, 5, { type: 'move', id: r.id, x: via.x, y: via.y }, `繞路去打${this.units[t.kind].name}`, 15);
          continue;
        }
        this.send(out, 5, { type: 'attack', id: r.id, target: t.id }, `${m.mode === 'engage' ? '接戰' : '迎擊'}${this.units[t.kind].name}`, 20);
        continue;
      }
      if (r.engaged && this.posture !== '收攏') continue;
      if (this.dist(r, slot) > 2500) {
        const why = m.mode === 'advance' ? (m.column ? '縱隊過河' : '戰線推進') : m.mode === 'engage' ? '壓上接敵' : '戰線站位';
        this.send(out, 2, { type: 'move', id: r.id, x: slot.x, y: slot.y, facing: m.facing }, why, 20);
      } else if (r.status === 'idle' && this.adiff(r.facing, m.facing) > 30 && !r.engaged) {
        this.send(out, 1, { type: 'face', id: r.id, facing: m.facing }, '轉向敵軍', 20);
      }
    }
  }

  /**
   * 長槍防騎兵：沒被纏住的敵方騎兵在附近（固守 26 格、推進 14 格；衝鋒中一律）就朝它架槍林，任何方向都算；其餘交給共用的槍林反應
   * @param {Pending[]} out
   * @param {Own} r
   * @param {boolean} mayHold
   */
  spearGuard(out, r, mayHold) {
    if (r.engaged) return this.spearReact(out, r, mayHold);
    const reach = mayHold ? 26 : 14;
    const cav = this.nearestFoe(r, (e) => this.isCav(e.kind) && !e.engaged && !e.routed && (e.dashing === 'charge' || this.gap(r, e) <= reach), 30);
    if (!cav) return this.spearReact(out, r, mayHold);
    const s = this.state(r.id);
    s.lastThreat = this.obs.tick;
    const f = this.angle(r, this.predict(cav, 10));
    const braced = r.status === 'braced' || r.status === 'bracing';
    if (!braced || this.adiff(r.facing, f) > 50) {
      this.send(out, 9, { type: 'brace', id: r.id, facing: f }, '架槍林擋騎兵', 30);
    }
    return true;
  }

  /**
   * 緊密的陣：正面寬度超過 maxTiles 就把後面的團排到第二排（中間的團在前）
   * @param {Own[]} regs
   * @param {Pt} anchor
   * @param {number} facing
   * @param {number} maxTiles
   */
  compactSlots(regs, anchor, facing, maxTiles) {
    const width = (/** @type {Own[]} */ rs) => rs.reduce((t, r) => t + (r.radius * 2) / TILE + 0.8, 0);
    if (width(regs) <= maxTiles) return this.lineSlots(regs, anchor, facing, 0.8);
    const mid = Math.floor(regs.length / 2);
    const front = regs.slice(Math.max(0, mid - 1), mid + 1);
    const back = regs.filter((r) => !front.includes(r));
    const out = this.lineSlots(front, anchor, facing, 0.8);
    const depth = Math.max(...front.map((r) => r.radius)) / TILE + Math.max(1, ...back.map((r) => r.radius)) / TILE + 1;
    for (const [id, p] of this.lineSlots(back, this.offset(anchor, facing + 180, depth), facing, 0.8)) out.set(id, p);
    return out;
  }

  /**
   * 縱隊：一團接一團排在 anchor 後方（過渡口、過橋時用）
   * @param {Own[]} regs
   * @param {Pt} anchor
   * @param {number} facing
   */
  columnSlots(regs, anchor, facing) {
    /** @type {Map<number, Pt>} */
    const out = new Map();
    let back = 0;
    for (const r of regs) {
      out.set(r.id, this.offset(anchor, facing + 180, back));
      back += (r.radius * 2) / TILE + 1;
    }
    return out;
  }

  /**
   * 戰線目標分配：每團在站位 leash 格內挑最划算的敵人（相剋、已被我方纏住、能打側背加分；槍林、盾牆正面扣分；同一目標最多兩團）
   * @param {Own[]} regs
   * @param {Map<number, Pt>} slots
   * @param {number} leash
   * @param {boolean} retreat 收攏中：只還擊已經貼身的敵人
   * @returns {Map<number, Enemy>}
   */
  assignTargets(regs, slots, leash, retreat) {
    /** @type {Map<number, Enemy>} */
    const out = new Map();
    /** @type {Map<number, number>} */
    const load = new Map();
    /** @type {[number, Own, Enemy][]} */
    const pairs = [];
    for (const r of regs) {
      const slot = slots.get(r.id) || r;
      for (const e of this.foes) {
        const dSlot = this.gap(slot, e);
        const d = this.gap(r, e);
        if (retreat ? !(r.engaged && d < 1) : dSlot > leash && d > 2) continue;
        // 步兵追不上沒被纏住、正在跑的騎兵
        if (this.isCav(e.kind) && !e.engaged && e.status !== 'idle' && d > 2) continue;
        // 不追下水：要涉水超過 2 格才打得到的不打（除非是主動過河進攻）
        if (this.posture !== '進攻' && !(r.engaged && d < 1.5) && this.wetTiles(r, e) > 2) continue;
        const ed = this.edge(r.kind, e.kind);
        let s = 6 * (ed >= 1 ? ed - 1 : 1 - 1 / ed) - d;
        if (e.engaged) s += 6;
        if (!this.inFront(e, r, 60)) s += 5;
        if ((r.kind === 'sword' || r.kind === 'light') && this.spearWall(e, r)) s -= 25;
        if (this.shieldWall(e, r)) s -= 10;
        if (e.kind === 'archer') s += 4;
        if (r.engaged && d < 1.5) s += 8;
        // 太不划算的對手（例如劍士對槍林正面）：除非已經貼身，不打
        if (s < -14 && !(r.engaged && d < 1.5)) continue;
        pairs.push([s, r, e]);
      }
    }
    pairs.sort((a, b) => b[0] - a[0]);
    for (const [, r, e] of pairs) {
      if (out.has(r.id)) continue;
      if ((load.get(e.id) || 0) >= 2) continue;
      out.set(r.id, e);
      load.set(e.id, (load.get(e.id) || 0) + 1);
    }
    return out;
  }

  /**
   * 火力：弓兵在戰線後方 7 格、就近找高處；盾兵護送
   * @param {Pending[]} out
   * @param {Own[]} archers
   * @param {Own[]} shields
   */
  fireControl(out, archers, shields) {
    const m = this.line;
    const n = archers.length;
    const tgt = this.engageTarget;
    const range = this.units.archer.range / TILE;
    const lineC = this.centroid(this.lineRegs()) || m.anchor;
    // 射擊陣地：戰線後方 7 格（決戰時離敵軍約射程 - 2 格），在 12 格內找高處；各團在陣地兩側 3.5 格
    let center = this.offset(m.anchor, m.facing + 180, 7);
    if (tgt && m.mode === 'engage') center = this.offset(tgt, m.facing + 180, Math.min(range - 2, this.dist(tgt, lineC) / TILE + 6));
    // 交戰點：戰線前方 4 格（或敵軍）；陣地離它不能超過射程 - 2 格
    // 交戰點：決戰時是敵軍；固守、迎擊時是戰線（在高處等敵人進射程，不離開高地去迎敵）
    const front = tgt && m.mode === 'engage' && this.dist(tgt, lineC) < 20 * TILE ? tgt : m.anchor;
    center = this.highGround(this.landBehind(center, m.facing + 180), 12, tgt, front, range - 2);
    archers.forEach((r, i) => {
      if (this.busyIds.has(r.id)) return;
      const lat = n <= 1 ? 0 : (i - (n - 1) / 2) * 7;
      const base = this.landBehind(this.offset(center, m.facing + 90, lat), m.facing + 180);
      if (this.archerCover(out, r)) return;
      const spot = this.archerReposition(r);
      if (spot && this.dist(r, spot) > 1500 && !r.engaged && r.status !== 'volleying') {
        this.send(out, 5, { type: 'move', id: r.id, x: spot.x, y: spot.y }, '移位射擊好目標', 20);
        return;
      }
      this.archerReact(out, r, spot || this.highGround(base, 5, tgt, front, range - 2));
    });
    shields.forEach((r, i) => {
      if (this.busyIds.has(r.id)) return;
      this.shieldReact(out, r, archers[i % Math.max(1, n)] || null);
    });
  }

  /**
   * 弓兵躲騎兵：沒被纏住的敵方騎兵在 16 格內，就躲到最近的我方長槍（或盾兵、劍士）背後；沒有掩護就往反方向跑
   * @param {Pending[]} out
   * @param {Own} r
   */
  archerCover(out, r) {
    if (r.engaged) return false;
    const cav = this.nearestFoe(r, (e) => this.isCav(e.kind) && !e.engaged && !e.routed, 16);
    if (!cav) return false;
    const mates = this.obs.regiments.filter((o) => !o.routed && o.id !== r.id && (o.kind === 'spear' || o.kind === 'shield' || o.kind === 'sword') && this.dist(o, r) < 18 * TILE);
    const prot = mates.sort((a, b) => (a.kind === 'spear' ? 0 : 1) - (b.kind === 'spear' ? 0 : 1) || this.dist(a, r) - this.dist(b, r))[0];
    const away = prot ? this.angle(cav, prot) : this.angle(cav, r);
    const dest = this.landBehind(prot ? this.offset(prot, away, (prot.radius + r.radius) / TILE + 2) : this.offset(r, away, 10), away);
    if (this.dist(r, dest) < 1500) return false;
    this.send(out, 8, { type: 'move', id: r.id, x: dest.x, y: dest.y }, prot ? `躲到${this.units[prot.kind].name}後面` : '避開騎兵', 25);
    return true;
  }

  /**
   * 弓兵移位：射程內只有盾牆或舉盾的盾兵、射程外一點有值得射的敵人（不是盾兵，最好是被纏住的），就往前移到射程內；
   * 那個位置 5 格內有沒被纏住的敵方近戰就不去
   * @param {Own} r
   * @returns {Pt | null}
   */
  archerReposition(r) {
    const range = this.units.archer.range / TILE;
    const inRange = (/** @type {Enemy} */ e) => (this.dist(r, e) - (e.radius || 0) / 2) / TILE <= range + (r.height - e.height) - 1.5;
    const good = (/** @type {Enemy} */ e) => !e.routed && (e.kind !== 'shield' || (e.stance === 'carry' && e.status !== 'walled' && e.status !== 'walling'));
    if (this.foes.some((e) => good(e) && inRange(e))) return null;
    /** @type {Enemy | null} */
    let best = null;
    let bestS = -Infinity;
    for (const e of this.foes) {
      if (!good(e)) continue;
      const d = this.gap(r, e);
      if (d > range + 8) continue;
      const s = (e.engaged ? 10 : 0) + (e.kind === 'archer' ? 4 : 0) - d;
      if (s > bestS) {
        bestS = s;
        best = e;
      }
    }
    if (!best) return null;
    // 目標正朝這裡來：在原地（多半是高處）等它進射程
    if (this.approaching(best, r)) return null;
    const spot = this.highGround(this.landBehind(this.offset(best, this.angle(best, r), range - 2), this.angle(best, r)), 2, best);
    const danger = this.foes.some((e) => e !== best && !e.engaged && e.kind !== 'archer' && e.status !== 'walled' && e.status !== 'braced' && this.gap(spot, e) < 5);
    return danger ? null : spot;
  }

  /**
   * p 附近 tiles 格內最高的可站位置（同高度取最近）；有敵軍時不往敵人那邊靠
   * @param {Pt} p
   * @param {number} tiles
   * @param {Pt | null} [enemy]
   * @param {Pt | null} [keepNear] 不能離這一點超過 maxTiles 格
   * @param {number} [maxTiles]
   */
  highGround(p, tiles, enemy = null, keepNear = null, maxTiles = 0) {
    let best = p;
    let bestS = this.h.heightAt(p.x, p.y) * 10;
    const d0 = enemy ? this.dist(p, enemy) : 0;
    // 掃描順序用己方視角（1 號整個反過來），同分時雙方挑到互相對稱的位置
    const sg = this.p === 0 ? 1 : -1;
    for (let dy = -tiles; dy <= tiles; dy += 2) {
      for (let dx = -tiles; dx <= tiles; dx += 2) {
        const q = { x: p.x + sg * dx * TILE, y: p.y + sg * dy * TILE };
        const t = this.h.terrainAt(q.x, q.y);
        if (t === TR.river || t === TR.shallow || t === TR.building || t === TR.wall) continue;
        if (enemy && this.dist(q, enemy) < d0 - 1500) continue;
        // 越高射得越遠：每高一階多 1 格
        if (keepNear && this.dist(q, keepNear) > (maxTiles + Math.max(0, this.h.heightAt(q.x, q.y) - this.h.heightAt(keepNear.x, keepNear.y))) * TILE) continue;
        if (this.obs && this.foes.some((e) => e.kind !== 'archer' && !e.routed && this.gap(q, e) < 7)) continue;
        const s = this.h.heightAt(q.x, q.y) * 12 - Math.sqrt(dx * dx + dy * dy) * 0.8;
        if (s > bestS) {
          bestS = s;
          best = q;
        }
      }
    }
    return best;
  }

  /**
   * 打擊：騎兵在戰線側翼待命；佔點時沒事就去襲擾對方的橋
   * @param {Pending[]} out
   * @param {Own[]} cavs
   */
  strikeControl(out, cavs) {
    const m = this.line;
    const lineRegs = this.lineRegs();
    const lineC = this.centroid(lineRegs.length ? lineRegs : this.obs.regiments.filter((o) => o.kind === 'archer' && !o.routed)) || m.anchor;
    cavs.forEach((r, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const rally = this.landBehind(this.offset(this.offset(lineC, m.facing + 90 * side, 14), m.facing + 180, 6), m.facing + 180);
      if (this.data.mode === 'capture' && this.posture !== '決戰' && !r.dashing) {
        // 回防：己方的旗被小股敵軍騷擾（附近沒有敵方主力）
        const mine = this.flags.find((f) => f.owner === this.p && f.contested && f !== this.mainFlag);
        if (mine && (!r.engaged || this.dist(r, mine) < this.data.capture.radius + 3 * TILE)) {
          const raiders = this.foes.filter((e) => this.dist(e, mine) < this.data.capture.radius + 3 * TILE);
          const pts = raiders.reduce((t, e) => t + e.men * this.perMan(e.kind), 0);
          // 看不到是誰在偷（旗點被爭奪是公開資訊）：也派騎兵去看
          if (pts <= r.men * this.perMan(r.kind) * 1.3 && !raiders.some((e) => e.kind === 'spear')) {
            // 先站進圈內擋住對方的佔領進度，再打
            if (this.dist(r, mine) > this.data.capture.radius * 0.6) {
              const step = this.safeStep(r, mine);
              this.send(out, 6, { type: 'move', id: r.id, x: step.x, y: step.y }, `回防${mine.name}`, 20);
            } else {
              // 在圈內：直接近戰纏住偷旗的（不繞側背、不衝穿出圈）
              const raider = raiders.sort((a, b) => this.dist(a, r) - this.dist(b, r))[0];
              if (raider) this.send(out, 6, { type: 'attack', id: r.id, target: raider.id }, `趕走偷${mine.name}的${this.units[raider.kind].name}`, 20);
            }
            return;
          }
        }
        // 中央還沒開打：第一團騎兵負責己方的橋（佔下後在橋與中央之間待命，有人來偷就回防）
        const near = this.nearFlag;
        const far0 = this.farFlag;
        if (this.raid && far0 && !r.engaged && near && near.owner === this.p && !near.contested) {
          // 騷擾對方的橋：站進圈內讓它暫停得分；圈內有長槍就在外圍等
          if (!this.foes.some((e) => e.kind === 'spear' && !e.engaged && this.dist(e, far0) < 8 * TILE)) {
            this.takeFlag(out, r, far0, 5);
            return;
          }
        }
        if (near && i === 0 && !r.engaged) {
          if ((near.owner !== this.p || near.contested) && !this.foes.some((e) => e.kind === 'spear' && this.dist(e, near) < 10 * TILE)) {
            this.takeFlag(out, r, near, 4);
            return;
          }
          const mf = this.mainFlag;
          const post = this.landBehind(mf ? this.offset(near, this.angle(near, mf), 8) : near, this.face(180));
          this.hammer(out, r, post);
          return;
        }
        // 輕騎兵：對方的橋附近沒有敵軍才去偷
        const far = this.farFlag;
        if (far && r.kind === 'lightCav' && !r.engaged && (far.owner !== this.p || far.contested) && !this.foes.some((e) => this.dist(e, far) < 14 * TILE)) {
          this.takeFlag(out, r, far, 4);
          return;
        }
      }
      this.hammer(out, r, rally);
    });
  }

  /**
   * 騎兵的錘：只衝被纏住、露出側背的敵人或弓兵、輕步兵、潰兵；繞到側背再衝；衝完拉開重整
   * @param {Pending[]} out
   * @param {Own} r
   * @param {Pt} rally
   */
  hammer(out, r, rally) {
    if (r.dashing) return;
    const heavy = r.kind === 'heavyCav';
    const name = heavy ? '重騎' : '輕騎';
    if (r.engaged) {
      const near = this.nearestFoe(r, null, 2);
      const stay = near && ((near.men / near.men0 < 0.4 && near.kind !== 'spear') || near.kind === 'archer' || near.kind === 'light');
      if (!stay && r.men > 1) {
        const back = this.offset(r, this.angle(near || r, r), 10);
        this.send(out, 7, { type: 'move', id: r.id, x: back.x, y: back.y }, `${name}脫離重整`, 25);
      }
      return;
    }
    /** @type {Enemy | null} */
    let best = null;
    let bestS = -Infinity;
    for (const e of this.foes) {
      const d = this.gap(r, e);
      if (d > 28 || this.isCav(e.kind) || e.dashing) continue;
      const front = this.inFront(e, r, 65);
      const bracedFront = e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing') && (e.formation === 'circle' || front);
      if (bracedFront) continue;
      if (e.kind === 'spear' && !e.engaged && front) continue;
      // 附近有沒被纏住的敵方長槍：衝進去會被架槍林
      const spearNear = this.foes.some((o) => o !== e && o.kind === 'spear' && !o.engaged && this.dist(o, e) < 6 * TILE);
      // 沒被纏住的目標：只有身邊沒有長槍、盾兵、劍士保護的弓兵、輕步兵或殘兵才值得衝
      if (!e.engaged) {
        const soft = e.kind === 'archer' || e.kind === 'light' || e.men / e.men0 < 0.35;
        const guarded = this.foes.some((o) => o !== e && !o.engaged && (o.kind === 'spear' || o.kind === 'shield' || o.kind === 'sword') && this.dist(o, e) < 8 * TILE);
        if (!soft || guarded) continue;
      }
      let s = 30 - d;
      if (e.kind === 'archer') s += 25;
      if (e.kind === 'light') s += 10;
      if (e.engaged) s += 20;
      s += front ? -12 : 14;
      if (spearNear) s -= 18;
      if (!heavy && (e.kind === 'shield' || e.kind === 'spear')) s -= 20;
      if (e.men / e.men0 < 0.4) s += 6;
      if (s > bestS) {
        bestS = s;
        best = e;
      }
    }
    if (best && bestS > 0 && r.skillCooldown === 0) {
      const d = this.gap(r, best);
      const soft = best.kind === 'archer' || best.kind === 'light' || best.men / best.men0 < 0.3;
      const exposed = !this.inFront(best, r, 70) || soft;
      if (exposed && d >= 3 && d <= 20) {
        const p = this.predict(best, Math.round((d * TILE) / (heavy ? 600 : 680)));
        const through = this.offset(p, this.angle(r, p), 3);
        if (this.clearLine(r, through, true) && !this.pathBlocked(r, p, best.id)) {
          this.send(out, 9, { type: 'charge', id: r.id, x: through.x, y: through.y }, `${name}衝${best.engaged ? '側背' : ''}${this.units[best.kind].name}`, 20);
          return;
        }
      }
      // 繞到側背：目標背後或側面 11 格，挑離敵方長槍最遠、能走的點
      const cands = [180, 110, -110].map((a) => this.offset(best, best.facing + a, 11)).filter((q) => {
        const t = this.h.terrainAt(q.x, q.y);
        return t !== TR.river && t !== TR.building && t !== TR.wall && t !== TR.forest;
      });
      const spears = this.foes.filter((o) => o.kind === 'spear' && !o.engaged);
      const score = (/** @type {Pt} */ q) => Math.min(30 * TILE, ...spears.map((o) => this.dist(o, q))) - this.dist(r, q) * 0.5;
      const fp = cands.sort((a, b) => score(b) - score(a))[0];
      if (fp) {
        const step = this.safeStep(r, fp, best.id);
        this.send(out, 6, { type: 'move', id: r.id, x: step.x, y: step.y }, `${name}繞到${this.units[best.kind].name}側背`, 20);
        return;
      }
    }
    if (this.dist(r, rally) > 3000) {
      const step = this.safeStep(r, rally);
      this.send(out, 2, { type: 'move', id: r.id, x: step.x, y: step.y, facing: this.line.facing }, r.skillCooldown > 0 ? `${name}重整，等待再衝` : `${name}在側翼待命`, 20);
    }
  }

  /**
   * 斥候：佔點時搶空旗與守己方的橋；殲滅戰偵察兩座橋
   * @param {Pending[]} out
   * @param {Own[]} lights
   */
  screenControl(out, lights) {
    lights.forEach((r, i) => {
      /** @type {Pt} */
      let watch;
      let name;
      if (this.data.mode === 'capture') {
        const near = this.nearFlag;
        const far = this.farFlag;
        // 斥候守己方的橋（沒人守的旗一個人就能偷）；得分落後時第二團去騷擾對方的橋
        const f = i === 1 && this.raid ? far || near : near || far;
        if (f) {
          watch = { x: f.x, y: f.y };
          name = f.name;
          // 己方的橋還沒到手：先去佔
          if (f.owner !== this.p && !this.nearestFoe(r, (e) => e.kind !== 'light' && e.kind !== 'archer', 7)) {
            this.takeFlag(out, r, f, 4);
            return;
          }
        } else {
          watch = this.bp;
          name = '河岸';
        }
      } else {
        const ys = [24, 76];
        watch = this.landBehind(this.at(70, ys[i % 2]), this.face(180));
        name = i % 2 === 0 ? '北橋' : '南橋';
        // 沒有敵情又沒交戰：往前偵察
        if (this.clusters.length === 0 && this.obs.tick > 300) watch = this.landBehind(this.at(92, ys[i % 2]), this.face(180));
      }
      this.scoutReact(out, r, watch, name);
    });
  }
}
