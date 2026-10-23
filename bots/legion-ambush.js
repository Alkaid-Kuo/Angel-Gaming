// @ts-check
// 軍團戰基準 AI：林中伏兵。主力守在淺灘後方，劍士事先藏進淺灘旁的樹林；
// 敵軍過河靠近樹林、或和主力接戰時，伏兵從側面殺出（能突擊就突擊）；太久沒等到人就改去支援主戰場。
// 接觸後騎兵繞橋偷襲敵方弓兵與後排；斥候躲在橋邊樹林看動靜。
// 本檔由 scripts/build-legion-bots.ts 從 bots/legion-src/ 產生：請修改原始碼後重新產生，不要直接改這個檔案。

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
   * 己方視角的格座標 → 世界座標
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
      const pos = this.at(e.tx, e.ty);
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
      out.push({ ...e, x: Math.round(e.x + e.vx * k), y: Math.round(e.y + e.vy * k) });
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
    return { x: Math.round(e.x + m.vx * ticks), y: Math.round(e.y + m.vy * ticks) };
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
    /** @type {Enemy | null} */
    let nearest = null;
    let nearD = Infinity;
    for (const e of this.foes) {
      const d = (this.dist(r, e) - e.radius / 2) / TILE;
      if (d > range + (r.height - e.height) - 1.5) continue;
      if (d < nearD) {
        nearD = d;
        nearest = e;
      }
      let sc = -d + (1 - e.men / e.men0) * 10;
      if (e.kind === 'shield') sc -= e.stance === 'carry' ? 10 : 40;
      if (e.kind === 'archer') sc += 12;
      if (e.engaged) sc += 8;
      if (e.routed) sc -= 30;
      if (sc > pickS) {
        pickS = sc;
        pick = e;
      }
    }
    if (pick && r.order === 'attack' && r.target === pick.id) return true;
    if (pick && nearest && pick.id !== nearest.id && !this.committed(r)) {
      this.send(out, 4, { type: 'attack', id: r.id, target: pick.id }, `集火${this.units[pick.kind].name}`, 40);
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

  /** 我方剩餘人數 vs 記得的敵方人數 */
  strengthRatio() {
    const mine = this.obs.regiments.filter((r) => !r.routed).reduce((s, r) => s + r.men * this.units[r.kind].cost / this.units[r.kind].men, 0);
    const theirs = this.remembered(300).reduce((s, e) => s + e.men * this.units[e.kind].cost / this.units[e.kind].men, 0);
    return theirs === 0 ? 9 : mine / theirs;
  }
}

export default class ForestAmbush extends LegionBase {
  constructor() {
    super();
    this.fought = -1;
    this.sprung = false;
    this.allIn = false;
    /** 開局隨機：耐心倍率、騎兵繞哪座橋（0 南、1 北） */
    this.patienceScale = 1;
    this.raidRoute = 0;
    /** 伏擊的樹林（世界座標） @type {Pt} */
    this.forest = { x: 0, y: 0 };
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '林中伏兵',
      version: 'v2',
      style: '主力守淺灘後方，劍士藏進樹林等敵軍過河時從側面殺出；接觸後騎兵繞橋偷襲敵方弓兵',
      knobs: [
        { key: 'ambushers', name: '伏兵', description: '藏在樹林裡的劍士團數', min: 1, max: 3, default: 2, integer: true },
        { key: 'patience', name: '耐心', description: '多久沒接戰就主動進攻（秒）', min: 20, max: 180, default: 60, integer: true },
        { key: 'raid', name: '騎兵繞後', description: '1 = 接觸後騎兵繞橋偷襲；0 = 留在高地後方待命', min: 0, max: 1, default: 1, integer: true },
        { key: 'spring', name: '出擊距離', description: '敵軍離樹林多近（格）伏兵就殺出', min: 2, max: 16, default: 7, integer: true },
      ],
    };
  }

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  deploy(data, helpers) {
    this.setup(data, helpers);
    this.patienceScale = 0.8 + helpers.random() * 0.4;
    this.raidRoute = helpers.random() < 0.5 ? 0 : 1;
    // 伏擊點：淺灘旁、己方這一側最近的樹林
    const ford = this.geo.fords[0] || this.at(80, 50);
    let best = this.at(60, 42);
    let bestD = Infinity;
    for (const f of this.geo.forests) {
      const l = this.loc(f);
      if (l.x > 74) continue;
      const d = this.dist(f, ford);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    this.forest = best;
    const n = data.knobs.ambushers ?? 2;
    /** @type {[UnitKind, string][]} */
    const wish = [['spear', 'main'], ['spear', 'main'], ['archer', 'archer'], ['shield', 'shield']];
    for (let i = 0; i < n; i++) wish.push(['sword', 'ambush']);
    wish.push(['heavyCav', 'cav'], ['light', 'scout'], ['lightCav', 'cav'], ['spear', 'main']);
    const list = this.buy(wish);
    let mi = 0;
    let wi = 0;
    let ci = 0;
    /** @type {PlanEntry[]} */
    const plan = list.map((e) => {
      if (e.role === 'main') return { ...e, tx: 17, ty: [45, 55, 64][mi++ % 3], facing: 0, formation: 'square' };
      if (e.role === 'archer') return { ...e, tx: 8, ty: 50, facing: 0, width: 12 };
      if (e.role === 'shield') return { ...e, tx: 14, ty: 50, facing: 0 };
      if (e.role === 'ambush') return { ...e, tx: 16, ty: [30, 22, 38][wi++ % 3], facing: 0, width: 8 };
      if (e.role === 'cav') return { ...e, tx: 12, ty: [70, 80][ci++ % 2], facing: 0, formation: 'wedge' };
      return { ...e, tx: 10, ty: 36, facing: 0 };
    });
    return this.deployFrom(plan);
  }

  /** @param {Observation} obs */
  decide(obs) {
    this.update(obs);
    /** @type {Pending[]} */
    const out = [];
    const k = this.k;
    const capture = this.data.mode === 'capture';
    const foes = this.foes;
    const main = this.mine('main');
    const amb = this.mine('ambush');
    const engagedMain = foes.find((e) => main.some((m) => this.gap(m, e) < 3));
    const nearForest = foes.find((e) => e.kind !== 'light' && this.dist(e, this.forest) / 1000 < (k.spring ?? 7) + 6);
    if (this.fought < 0 && foes.some((e) => e.kind !== 'light' && this.loc(e).x < 84)) this.fought = obs.tick;
    if (engagedMain || nearForest) this.sprung = true;
    // 等太久：主動進攻；接觸後一分鐘伏兵還沒等到人，就去支援主戰場
    if (this.fought < 0 && obs.tick > (k.patience ?? 60) * 10 * this.patienceScale) this.allIn = true;
    if (!this.sprung && this.fought >= 0 && obs.tick - this.fought > 600) this.sprung = true;
    const forward = this.forward;
    const flags = this.data.map.flags;
    const hunt = this.huntPoint();
    if (hunt) this.allIn = true;
    const goal = hunt || (capture && flags[1] ? { x: flags[1].x, y: flags[1].y } : this.at(140, 50));
    const hold = this.at(capture ? 74 : 68, 50);
    /** @type {Map<number, number>} */
    const load = new Map();

    // 主力：守淺灘後方（佔點：守中央旗點旁的河岸）；全面進攻時往前
    const anchor = hunt || (this.allIn ? this.offset(hold, forward, Math.min(60, (obs.tick - (k.patience ?? 60) * 10) / 20)) : hold);
    const slots = this.lineSlots(main, anchor, forward, 1.5);
    for (const r of main) {
      if (r.kind === 'spear' && this.spearReact(out, r, !this.allIn)) continue;
      const t = this.meleeTarget(r, this.allIn ? 18 : 8, load);
      if (t) {
        load.set(t.id, (load.get(t.id) || 0) + 1);
        this.send(out, 5, { type: 'attack', id: r.id, target: t.id }, `迎戰${this.units[t.kind].name}`, 20);
        continue;
      }
      if (r.engaged) continue;
      const slot = slots.get(r.id) || anchor;
      if (this.dist(r, slot) > 2500) this.send(out, 2, { type: 'move', id: r.id, x: slot.x, y: slot.y, facing: forward }, hunt ? '搜索敵軍' : this.allIn ? '全軍進攻' : '守住淺灘後方', 30);
    }
    if (capture && main.length >= 2) {
      const own = flags[this.p === 0 ? 0 : 2];
      const holder = main[main.length - 1];
      if (own && !holder.engaged && this.dist(holder, own) > 3000) this.send(out, 6, { type: 'move', id: holder.id, x: own.x, y: own.y, facing: forward }, '守住己方旗點', 40);
    }
    // 弓兵與盾兵
    const archers = this.mine('archer');
    archers.forEach((r, i) => this.archerReact(out, r, this.offset(this.offset(anchor, this.face(180), 7), this.face(90), i * 8)));
    for (const r of this.mine('shield')) this.shieldReact(out, r, archers[0] || null);
    // 伏兵
    amb.forEach((r, i) => {
      if (this.sprung || this.allIn) {
        const t = this.meleeTarget(r, 22, load);
        if (t) {
          load.set(t.id, (load.get(t.id) || 0) + 1);
          if (this.swordAssault(out, r, t)) return;
          if (this.spearWall(t, r)) {
            const fp = this.flankPoint(r, t, 6);
            this.send(out, 6, { type: 'move', id: r.id, x: fp.x, y: fp.y }, '伏兵繞開槍林', 30);
            return;
          }
          this.send(out, 7, { type: 'attack', id: r.id, target: t.id }, `伏兵殺出攻擊${this.units[t.kind].name}`, 20);
          return;
        }
        if (this.sprung && !this.allIn) {
          // 沒有看到目標：往主力身邊靠過去支援
          const sp = this.offset(anchor, this.face(90), i % 2 === 0 ? -9 : 9);
          if (this.dist(r, sp) > 3000) this.send(out, 3, { type: 'move', id: r.id, x: sp.x, y: sp.y, facing: forward }, '伏兵支援主力', 30);
          return;
        }
        if (this.allIn) {
          this.send(out, 3, { type: 'attackMove', id: r.id, x: goal.x, y: goal.y }, '全軍進攻', 30);
          return;
        }
      }
      const spot = this.offset(this.forest, this.face(90), (i - (amb.length - 1) / 2) * 3.5);
      if (this.dist(r, spot) > 1200) this.send(out, 2, { type: 'move', id: r.id, x: spot.x, y: spot.y, facing: this.angle(this.forest, this.geo.fords[0] || this.at(80, 50)) }, '進入樹林埋伏', 40);
    });
    // 騎兵：接觸後繞橋偷襲，否則在高地後方待命
    const raid = (k.raid ?? 1) === 1 && (this.fought >= 0 || obs.tick > 500);
    for (const r of this.mine('cav')) {
      const me = this.loc(r);
      if (raid && me.x < 88 && !r.engaged) {
        const by = this.raidRoute === 0 ? 78 : 22;
        const wp = me.x < 70 ? this.at(70, by) : this.at(96, by + (this.raidRoute === 0 ? -6 : 6));
        const t = this.nearestFoe(r, (e) => e.kind === 'archer', 20);
        if (!t) {
          this.send(out, 3, { type: 'move', id: r.id, x: wp.x, y: wp.y }, `繞${this.raidRoute === 0 ? '南' : '北'}橋偷襲`, 30);
          continue;
        }
      }
      const rally = raid ? this.at(108, 50) : this.at(56, 64);
      this.cavalryCycle(out, r, rally, raid ? 30 : 18);
    }
    // 斥候：躲在北橋旁的樹林
    for (const r of this.mine('scout')) this.scoutReact(out, r, this.at(64, 13), '北橋');
    return this.flush(out);
  }
}
