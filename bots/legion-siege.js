// @ts-check
// 軍團戰陪練：攻城陪練（只給攻城戰用）。攻守兩邊都會打，讓玩家在石關城有一場像樣的攻城可以練。
// 守方：弓兵、長槍上牆（正門兩側、甕城、缺口兩側），長槍與盾兵守正門內側的 A 旗圈，劍士守缺口、側門與本陣；開場關門；
//       攻方的雲梯一架好就派最近的牆頂團去推倒；A 失守全軍退守 B。
// 攻方：一團劍士推衝車撞正門、盾兵跟著護送；兩團劍士到離門樓遠的牆段架雲梯；弓兵在護城河外壓制牆頂；
//       砲擊打牆頂與門後聚集的守軍（避開陰影區與自己人）；破門、佔下 A 或過了強攻時間，主力從城門推進 A、再推進 B。
// 地圖上的目標都從開局資料算（城門、隘口、旗、布陣遮罩），不寫死座標。
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
    /** 每個敵團最後出現的位置（不會過期；搜敵時到了那裡還沒找到才刪） @type {Map<number, { x: number, y: number, kind: UnitKind }>} */
    this.lastSeenAt = new Map();
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
    /** 佔點模式：自己的後備（不在場上的團）；觀察資料的 regiments 只留場上的 @type {Own[]} */
    this.reserves = [];
    /** 場上沒滿時自動召喚後備（統帥自己管，會關掉） */
    this.autoReinforce = true;
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
    /** @type {{ x: number, y: number, rad: number }[]} */
    const placed = [];
    /** @type {Deployment[]} */
    const out = entries.map((e) => {
      const rad = this.radiusOf(e.type, e.formation, e.width);
      let pos = this.deployAt(e);
      // 跟已經排好的團重疊（引擎的限制：中心距離 < 兩團半徑和的 55%）就沿著 y 往兩側錯開
      for (let k = 1; k < 60 && placed.some((q) => this.dist(q, pos) < (q.rad + rad) * 0.62); k++) {
        const ty = e.ty + (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 2;
        if (ty >= 4 && ty <= 96) pos = this.deployAt({ ...e, ty });
      }
      placed.push({ x: pos.x, y: pos.y, rad });
      return { type: e.type, x: pos.x, y: pos.y, facing: this.face(e.facing || 0), ...(e.width ? { width: e.width } : {}), ...(e.formation ? { formation: e.formation } : {}), ...(e.stance ? { stance: e.stance } : {}) };
    });
    // 佔點模式：剩下的點數照場上的陣容依序補成後備
    if (this.data.mode === 'capture' && this.data.capture) {
      let left = this.data.capture.budget - entries.reduce((t, e) => t + this.units[e.type].cost, 0);
      for (let i = 0; entries.length > 0 && i < 200; i++) {
        const e = entries[i % entries.length];
        if (this.units[e.type].cost > left) {
          if (entries.every((q) => this.units[q.type].cost > left)) break;
          continue;
        }
        left -= this.units[e.type].cost;
        out.push({ type: e.type, x: 0, y: 0, reserve: true, ...(e.formation ? { formation: e.formation } : {}) });
      }
    }
    return out;
  }

  /**
   * 依兵種與預算挑兵（依序，買不起就跳過）；預算還有剩就照 extra 依序補到買不起為止
   * @param {[UnitKind, string][]} wish
   * @param {[UnitKind, string][]} [extra]
   * @returns {{ type: UnitKind, role: string }[]}
   */
  buy(wish, extra = []) {
    // 佔點模式：先買場上的（上限 fieldCap），剩下的點數在 deployFrom 補成後備
    let budget = this.data.mode === 'capture' && this.data.capture ? this.data.capture.fieldCap : this.data.budget;
    /** @type {{ type: UnitKind, role: string }[]} */
    const out = [];
    for (const [type, role] of wish) {
      if (this.units[type].cost > budget) continue;
      budget -= this.units[type].cost;
      out.push({ type, role });
    }
    for (let i = 0; extra.length > 0 && i < 40; i++) {
      if (extra.every(([t]) => this.units[t].cost > budget)) break;
      const [type, role] = extra[i % extra.length];
      if (this.units[type].cost > budget) continue;
      budget -= this.units[type].cost;
      out.push({ type, role });
    }
    return out;
  }

  /**
   * 陣形的外接圓半徑（同引擎的算法；布陣時用來避開重疊）
   * @param {UnitKind} type
   * @param {FormationKind} [formation]
   * @param {number} [width]
   */
  radiusOf(type, formation, width) {
    const u = this.units[type];
    const f = formation || u.formations[0];
    const n = u.men;
    let files = 1;
    let ranks;
    if (f === 'line') {
      files = Math.max(1, Math.min(width || u.lineWidth, n));
      if (n >= 2 && Math.ceil(n / files) < 2) files = Math.ceil(n / 2);
      ranks = Math.ceil(n / files);
    } else if (f === 'square') {
      ranks = Math.max(2, Math.ceil(n / u.squareWidth));
      files = Math.ceil(n / ranks);
    } else if (f === 'wedge') {
      ranks = 0;
      for (let left = n, r = 0; left > 0; r++) {
        const c = Math.min(left, 2 * r + 1);
        files = Math.max(files, c);
        left -= c;
        ranks += 1;
      }
    } else return (n * u.spacingX) / 6283 + u.spacingX;
    const hw = (files * u.spacingX) / 2;
    const hd = (ranks * u.spacingY) / 2;
    return Math.sqrt(hw * hw + hd * hd);
  }

  // ───────── 每次決策 ─────────

  /** @param {Observation} obs */
  update(obs) {
    // 後備不在場上：另外記，觀察資料只留場上的團（各流派的程式不用管後備）
    this.reserves = obs.regiments.filter((r) => r.reserve);
    this.obs = { ...obs, regiments: obs.regiments.filter((r) => !r.reserve) };
    obs = this.obs;
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
    for (const r of obs.regiments) {
      if (this.role.has(r.id)) continue;
      const e = this.plan.find((q) => q.type === r.kind);
      if (e) this.role.set(r.id, e.role);
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
      if (e.routed) this.lastSeenAt.delete(e.id);
      else this.lastSeenAt.set(e.id, { x: e.x, y: e.y, kind: e.kind });
    }
    for (const [id, e] of this.seen) if (obs.tick - e.tick > 400 || e.routed) this.seen.delete(id);
    // 看到覆滅的敵團：從最後位置的記錄劃掉（搜敵不用再去那裡找）
    for (const ev of obs.events) if (ev.type === 'destroyed') this.lastSeenAt.delete(ev.reg);
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

  /**
   * 佔點：場上沒滿就從出生點召喚後備（依序，一次一團）
   * @param {Pending[]} out
   */
  reinforce(out) {
    if (this.data.mode !== 'capture') return;
    const room = this.obs.fieldCap - this.obs.fieldCost;
    const r = this.reserves.find((q) => q.enterIn < 0 && this.units[q.kind].cost <= room);
    if (r) this.send(out, 3, { type: 'summon', id: r.id }, '後備入場', 0);
  }

  /** @param {Pending[]} out */
  flush(out) {
    if (this.autoReinforce) this.reinforce(out);
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
    // 陣地比較高、敵方近戰還遠：先走上去再射（高處射程更遠、傷害更高）
    const higher = this.h.heightAt(post.x, post.y) > r.height && !this.foes.some((e) => e.kind !== 'archer' && this.gap(r, e) < 8);
    const far = this.dist(r, post) > (inRange && !higher ? 12000 : 2500);
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
   * @param {number} [forward] 站在 ward 前方多遠（單位）：友軍要落在盾兵正後方的掩護區裡
   */
  shieldReact(out, r, ward, forward = 3500) {
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
      this.send(out, 3, { type: 'follow', id: r.id, target: ward.id, forward }, `護送${this.units[ward.kind].name}`, 30);
      return true;
    }
    return false;
  }

  /**
   * 輕步兵：偵察；敵方弓兵落單（被貼身的弓兵拉不開弓，近戰很弱）就切入，自己剩不到對方一半人才不打；被近戰盯上就退
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
    const prey = this.nearestFoe(r, (e) => e.kind === 'archer' && (e.engaged || r.men * 2 >= e.men) && !this.foes.some((o) => o !== e && o.kind !== 'archer' && this.dist(o, e) < 6000), 12);
    if (prey) {
      if (r.skillCooldown === 0 && !r.dashing && this.gap(r, prey) > 2) {
        const p = this.predict(prey, 15);
        this.send(out, 9, { type: 'infiltrate', id: r.id, x: p.x, y: p.y }, '切入敵方弓兵', 25);
        return true;
      }
      this.send(out, 6, { type: 'attack', id: r.id, target: prey.id }, '襲擊敵方弓兵', 20);
      return true;
    }
    // 打不過的弓兵（看得到的、或最後出現的位置）：停在它的射程外監視（多留 3 格給高地加成）；觀察點在射程內也一樣，不要一直走進去挨箭
    const bow = (this.units.archer.range / TILE + 3) * TILE;
    const archers = [...this.lastSeenAt.values()].filter((e) => e.kind === 'archer');
    const inRange = (/** @type {Pt} */ p) => archers.find((e) => this.dist(e, p) < bow);
    const near = inRange(r);
    if (near && !r.engaged) {
      const safe = this.offset(near, this.angle(near, r), bow / TILE + 2);
      this.send(out, 7, { type: 'move', id: r.id, x: safe.x, y: safe.y }, '避開弓兵射程', 30);
      return true;
    }
    const risky = inRange(watch);
    const post = risky ? this.offset(risky, this.angle(risky, r), bow / TILE + 2) : watch;
    if (this.dist(r, post) > 2000) {
      this.send(out, 1, { type: 'move', id: r.id, x: post.x, y: post.y }, `偵察${watchName}`, 30);
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
    // 追丟了：先去最近一個敵團最後出現的地方；到了還沒看到就劃掉
    for (let guard = 0; guard < 50 && this.lastSeenAt.size > 0; guard++) {
      let id = -1;
      let near = Infinity;
      for (const [k, p] of this.lastSeenAt) {
        const d = this.dist(c, p);
        if (d < near) {
          near = d;
          id = k;
        }
      }
      if (near > 6 * TILE) return this.lastSeenAt.get(id) || null;
      this.lastSeenAt.delete(id);
    }
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

/** @typedef {{ type: UnitKind, role: string, x: number, y: number, layer: number, facing: number, formation?: FormationKind, width?: number }} Slot */

/** 地形代碼（引擎 0.4） */
const T = { river: 5, building: 7, wall: 8, stair: 9, gate: 10, rubble: 12 };

export default class SiegeSparring extends LegionBase {
  constructor() {
    super();
    this.attacker = false;
    /** 布陣的位置與角色（世界座標） @type {Slot[]} */
    this.slots = [];
    /** 攻方：要架雲梯的城牆格中心與梯腳（世界座標） @type {{ wall: Pt, foot: Pt }[]} */
    this.ladderSpots = [];
    /** 攻方：主力等待破門的集結點、弓兵陣地 */
    this.stage = { x: 0, y: 0 };
    this.archerPost = { x: 0, y: 0 };
    /** 進攻方向（世界角度：從攻方往城門） */
    this.attackDir = 0;
    /** 主力已經開始推進 */
    this.pushing = false;
    /** 敵團中心旁有我方、雙方都沒接戰的起始 tick；超過 10 秒就當成空殼（士兵卡在別處），不再追 */
    /** @type {Map<number, number>} */
    this.near = new Map();
    /** @type {Set<number>} */
    this.phantom = new Set();
    /** @type {readonly Enemy[]} */
    this.raw = [];
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '攻城陪練',
      version: 'v1',
      style: '攻城戰專用陪練：守方弓兵長槍上牆、關門、推倒雲梯；攻方推衝車撞門、架雲梯、砲擊牆頂，破門後推進 A、B',
      knobs: [
        { key: 'ladders', name: '雲梯隊', description: '攻方派去架雲梯的團數', min: 0, max: 2, default: 2, integer: true },
        { key: 'bombardMin', name: '砲擊門檻', description: '攻方：落點圈內至少要有多少守軍才砲擊（人；牆頂的算 1.5 人）', min: 6, max: 40, default: 14, integer: true },
        { key: 'pushSec', name: '強攻時間', description: '攻方：還沒破門也沒上牆時，過了這麼久（秒）主力就強攻', min: 60, max: 480, default: 300, integer: true },
      ],
    };
  }

  // ───────── 地圖 ─────────

  /** @param {number} x @param {number} y 格座標 → 地形 */
  tAt(x, y) {
    const m = this.data.map;
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) return T.river;
    return m.terrain[y * m.width + x];
  }

  /** 地面能站的格（城牆、門樓、建築、河不行） @param {number} t */
  ground(t) {
    return t !== T.river && t !== T.building && t !== T.wall && t !== T.gate;
  }

  /** 牆頂能站的格 @param {number} t */
  top(t) {
    return t === T.wall || t === T.gate || t === T.stair;
  }

  /** @param {number} tx @param {number} ty 格中心（世界座標） */
  cell(tx, ty) {
    return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
  }

  /** 正門（沒有就第一座門） */
  get mainGate() {
    const gs = this.data.map.features.gates;
    return gs.find((g) => g.kind === 'main') || gs[0] || null;
  }

  /**
   * 布陣：在 (tx, ty) 附近找一格合法、而且不和同層已排好的團重疊的位置（由近到遠繞圈找）
   * @param {Slot[]} placed @param {Omit<Slot, 'x' | 'y'>} s @param {number} tx @param {number} ty @param {number} maxR
   * @returns {Slot | null}
   */
  place(placed, s, tx, ty, maxR = 14) {
    const m = this.data.map;
    const z = m.deploy[this.p];
    const mask = m.deployMask[this.p];
    const rad = this.radiusOf(s.type, s.formation, s.width);
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = Math.round(tx) + dx;
          const y = Math.round(ty) + dy;
          if (x < z.x0 || y < z.y0 || x >= z.x1 || y >= z.y1) continue;
          if (mask && mask[y * m.width + x] !== 1) continue;
          const t = this.tAt(x, y);
          if (s.layer === 1 ? !this.top(t) : !this.ground(t)) continue;
          const c = this.cell(x, y);
          if (placed.some((q) => q.layer === s.layer && this.dist(q, c) < (this.radiusOf(q.type, q.formation, q.width) + rad) * 0.7)) continue;
          const slot = { ...s, x: c.x, y: c.y };
          placed.push(slot);
          return slot;
        }
      }
    }
    return null;
  }

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  deploy(data, helpers) {
    this.setup(data, helpers);
    if (data.map.defender < 0) return this.deployOpen();
    this.attacker = data.map.defender >= 0 && data.map.defender !== this.p;
    const g = this.mainGate;
    const foe = data.map.spawns[1 - this.p];
    const me = data.map.spawns[this.p];
    // 進攻方向：從攻方出生點指向城門（沒有城就指向對方出生點）
    const target = g ? { x: g.x, y: g.y } : foe;
    const from = this.attacker ? me : foe;
    this.attackDir = this.h.angleTo(from.x, from.y, target.x, target.y);
    /** @type {Slot[]} */
    const placed = [];
    /** @param {UnitKind} type @param {string} role @param {Pt} at @param {number} layer @param {Partial<Slot>} [more] */
    const put = (type, role, at, layer, more = {}) => {
      const facing = more.facing ?? (this.attacker ? this.attackDir : (this.attackDir + 180) % 360);
      const s = this.place(placed, { type, role, layer, facing, ...more }, at.x / TILE, at.y / TILE);
      if (s === null && layer === 1) this.place(placed, { type, role, layer: 0, facing, ...more }, at.x / TILE, at.y / TILE, 24);
    };
    if (this.attacker) this.deployAttack(put);
    else this.deployDefense(put);
    this.slots = placed;
    // 點數上限：照順序排，超過的不出場
    let left = data.siege ? data.siege.budget : data.budget;
    const out = [];
    for (const s of placed) {
      const cost = this.units[s.type].cost;
      if (cost > left) continue;
      left -= cost;
      out.push({ type: s.type, x: s.x, y: s.y, facing: s.facing, ...(s.layer === 1 ? { layer: 1 } : {}), ...(s.formation ? { formation: s.formation } : {}), ...(s.width ? { width: s.width } : {}) });
    }
    return out;
  }

  /**
   * 不是攻城地圖（佔點、殲滅）：一般的陣容，照己方布陣條帶排進去（沒有城可以守或攻，不走下面的城池布陣）
   * @returns {Deployment[]}
   */
  deployOpen() {
    /** @type {[UnitKind, string][]} */
    const wish = [['light', 'scout'], ['archer', 'archer'], ['archer', 'archer'], ['shield', 'shield'], ['sword', 'line'], ['spear', 'line'], ['spear', 'line'], ['sword', 'line'], ['spear', 'line']];
    const list = this.buy(wish, [['spear', 'line'], ['sword', 'line']]);
    const lineYs = [0, -8, 8, -16, 16, -24];
    let li = 0;
    let ai = 0;
    /** @type {PlanEntry[]} */
    const plan = list.map((e) => {
      if (e.role === 'line') return { ...e, tx: 17, ty: Math.max(8, Math.min(92, 50 + lineYs[li++ % 6] * 1.15)), facing: 0, formation: /** @type {FormationKind} */ (e.type === 'spear' ? 'square' : 'line') };
      if (e.role === 'archer') return { ...e, tx: 9, ty: [44, 56, 50][ai++ % 3], facing: 0, width: 12 };
      if (e.role === 'shield') return { ...e, tx: 11, ty: 50, facing: 0 };
      return { ...e, tx: 9, ty: 32, facing: 0 };
    });
    return this.deployFrom(plan);
  }

  /**
   * 守方：牆頂的弓兵與長槍、A 旗圈的長槍與盾兵、缺口與側門的劍士、本陣的劍士
   * @param {(type: UnitKind, role: string, at: Pt, layer: number, more?: Partial<Slot>) => void} put
   */
  deployDefense(put) {
    const m = this.data.map;
    const g = this.mainGate;
    const A = m.flags[0] || m.spawns[this.p];
    const B = m.flags[1] || A;
    const out = this.attackDir;
    const side = (out + 90) % 360;
    const f = m.features;
    const gate = g ? { x: g.x, y: g.y } : A;
    // 牆頂：正門兩側（往外看）
    /** @param {Pt} p @param {number} along @param {number} back */
    const wallSpot = (p, along, back) => this.go(...this.xy(this.go(p.x, p.y, side, along)), (out + 180) % 360, back);
    put('archer', 'wallArcher', this.pt(wallSpot(gate, -7000, 0)), 1, { width: 6 });
    put('archer', 'wallArcher', this.pt(wallSpot(gate, 7000, 0)), 1, { width: 6 });
    // 甕城的牆（離正門最近的橋外側）
    const bridge = f.chokes.filter((c) => c.kind === 'bridge' || c.kind === 'arch').sort((a, b) => this.dist(a, gate) - this.dist(b, gate))[0];
    put('archer', 'wallArcher', bridge ? this.pt(this.go(bridge.x, bridge.y, out, 4000)) : this.pt(wallSpot(gate, 0, 2000)), 1, { width: 6 });
    // 缺口兩側的牆頂：長槍（攻方從缺口或附近架雲梯上來）
    const breach = f.chokes.find((c) => c.kind === 'breach');
    if (breach) {
      put('spear', 'wallSpear', this.pt(this.go(breach.x, breach.y, 0, 6000)), 1, { formation: 'line', width: 8 });
      put('spear', 'wallSpear', this.pt(this.go(breach.x, breach.y, 180, 6000)), 1, { formation: 'line', width: 8 });
    } else {
      put('spear', 'wallSpear', this.pt(wallSpot(gate, -14000, 0)), 1, { formation: 'line', width: 8 });
      put('spear', 'wallSpear', this.pt(wallSpot(gate, 14000, 0)), 1, { formation: 'line', width: 8 });
    }
    // A 旗圈（正門內側）：長槍對著城門、盾兵在兩旁
    const inside = this.go(A.x, A.y, (out + 180) % 360, 2500);
    put('spear', 'gateSpear', this.pt(this.go(inside.x, inside.y, side, -2500)), 0, { formation: 'square' });
    put('spear', 'gateSpear', this.pt(this.go(inside.x, inside.y, side, 2500)), 0, { formation: 'square' });
    put('shield', 'gateShield', this.pt(this.go(A.x, A.y, side, -4500)), 0);
    put('shield', 'gateShield', this.pt(this.go(A.x, A.y, side, 4500)), 0);
    // 劍士：缺口內側、側門內側、A 後方、本陣
    if (breach) put('sword', 'breachGuard', this.pt(this.go(breach.x, breach.y, this.h.angleTo(breach.x, breach.y, A.x, A.y), 6000)), 0);
    const sideGate = f.gates.find((q) => q !== g);
    if (sideGate) put('sword', 'sideGuard', this.pt(this.go(sideGate.x, sideGate.y, this.h.angleTo(sideGate.x, sideGate.y, B.x, B.y), 6000)), 0);
    put('sword', 'reserveA', this.pt(this.go(A.x, A.y, out, 5000)), 0);
    put('sword', 'keepB', B, 0);
    put('light', 'breachGuard', breach ? this.pt(this.go(breach.x, breach.y, this.h.angleTo(breach.x, breach.y, A.x, A.y), 10000)) : A, 0);
  }

  /**
   * 攻方：推衝車的劍士在衝車旁、護送的盾兵、雲梯隊、主力、弓兵
   * @param {(type: UnitKind, role: string, at: Pt, layer: number, more?: Partial<Slot>) => void} put
   */
  deployAttack(put) {
    const m = this.data.map;
    const z = m.deploy[this.p];
    const midY = ((z.y0 + z.y1) / 2) * TILE;
    const backX = (z.x0 + 3) * TILE;
    const frontX = (z.x1 - 3) * TILE;
    // 衝車起點可能在布陣區外：推車團與護送先排在布陣區內最靠近衝車的位置，man 之後引擎會帶過去
    const ram0 = m.ram || { x: frontX, y: midY };
    const ram = { x: Math.max(backX, Math.min(frontX, ram0.x)), y: Math.max((z.y0 + 3) * TILE, Math.min((z.y1 - 3) * TILE, ram0.y)) };
    const fwd = this.attackDir;
    put('sword', 'crew', this.pt(this.go(ram.x, ram.y, (fwd + 180) % 360, 3000)), 0);
    put('shield', 'escort', this.pt(this.go(ram.x, ram.y, (fwd + 90) % 360, 4500)), 0);
    put('shield', 'escort', this.pt(this.go(ram.x, ram.y, (fwd + 270) % 360, 4500)), 0);
    const ladders = this.k.ladders ?? 2;
    for (let i = 0; i < ladders; i++) put('sword', 'ladder', { x: backX + 3000, y: midY + (12 + i * 6) * TILE }, 0);
    for (let i = 0; i < 3; i++) put('spear', 'main', { x: frontX - 2000, y: midY + (i - 1) * 9 * TILE }, 0, { formation: 'square' });
    for (let i = 0; i < 3; i++) put('archer', 'archer', { x: backX, y: midY + (i - 1) * 8 * TILE }, 0, { width: 12 });
    put('sword', 'main', { x: frontX - 2000, y: midY - 20 * TILE }, 0);
    put('light', 'main', { x: frontX - 2000, y: midY + 20 * TILE }, 0);
    put('light', 'main', { x: frontX - 2000, y: midY - 28 * TILE }, 0);
    this.planAttack();
  }

  /** 攻方的路線：雲梯位置（地面走得到、離門樓遠的牆）、主力集結點、弓兵陣地 */
  planAttack() {
    const m = this.data.map;
    const w = m.width;
    const h = m.height;
    const g = this.mainGate;
    if (!g) return;
    // 從攻方布陣區出發、只走地面（門關著、河過不去）的距離
    const z = m.deploy[this.p];
    const dist = new Int32Array(w * h).fill(-1);
    /** @type {number[]} */
    const q = [];
    for (let y = z.y0; y < z.y1; y++) {
      for (let x = z.x0; x < z.x1; x++) {
        if (!this.ground(this.tAt(x, y))) continue;
        dist[y * w + x] = 0;
        q.push(y * w + x);
      }
    }
    for (let head = 0; head < q.length; head++) {
      const i = q[head];
      const x = i % w;
      const y = (i - x) / w;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (dist[j] >= 0 || !this.ground(this.tAt(nx, ny))) continue;
        dist[j] = dist[i] + 1;
        q.push(j);
      }
    }
    // 雲梯：城牆格、旁邊有走得到的地面；離正門 20 格以上、離缺口 14 格以上（太近的話尋路會改走缺口、不爬梯）；照走過去的距離排
    const breaches = m.features.chokes.filter((c) => c.kind === 'breach');
    /** @type {{ wall: Pt, foot: Pt, d: number }[]} */
    const cand = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (this.tAt(x, y) !== T.wall) continue;
        const c = this.cell(x, y);
        if (this.dist(c, g) < 20 * TILE || breaches.some((b) => this.dist(c, b) < 14 * TILE)) continue;
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ]) {
          const d = dist[ny * w + nx];
          if (d < 0) continue;
          cand.push({ wall: c, foot: this.cell(nx, ny), d });
          break;
        }
      }
    }
    cand.sort((a, b) => a.d - b.d);
    for (const c of cand) {
      if (this.ladderSpots.length >= 2) break;
      if (this.ladderSpots.some((s) => this.dist(s.wall, c.wall) < 6 * TILE)) continue;
      this.ladderSpots.push({ wall: c.wall, foot: c.foot });
    }
    // 正門前的隘口（橋；沒有橋就是正門外 3.5 格）：弓兵在它外側、主力在更外側等
    const out = (this.attackDir + 180) % 360;
    const half = Math.max(g.x1 - g.x0, g.y1 - g.y0) * TILE;
    const choke = m.features.chokes.filter((c) => c.kind === 'bridge').sort((a, b) => this.dist(a, g) - this.dist(b, g))[0] || this.go(g.x, g.y, out, half / 2 + 3500);
    this.archerPost = this.go(choke.x, choke.y, out, 6000);
    this.stage = this.go(choke.x, choke.y, out, 14000);
  }

  /** 從 (x, y) 往 deg 方向走 dist（單位）的點（引擎的整數三角函數） @param {number} x @param {number} y @param {number} deg @param {number} dist @returns {Pt} */
  go(x, y, deg, dist) {
    const [a, b] = this.h.offset(x, y, ((Math.round(deg) % 360) + 360) % 360, dist);
    return { x: a, y: b };
  }

  /** @param {{ x: number, y: number }} p @returns {[number, number]} */
  xy(p) {
    return [p.x, p.y];
  }

  /** @param {{ x: number, y: number }} p @returns {Pt} */
  pt(p) {
    return { x: p.x, y: p.y };
  }

  // ───────── 決策 ─────────

  /** 第一次決策：照布陣的位置分角色 */
  assignRoles() {
    if (this.role.size > 0) return;
    /** @type {Set<number>} */
    const used = new Set();
    for (const r of this.obs.regiments) {
      let best = -1;
      let bestD = Infinity;
      this.slots.forEach((s, i) => {
        if (used.has(i) || s.type !== r.kind) return;
        const d = this.dist(s, r);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        used.add(best);
        this.role.set(r.id, this.slots[best].role);
        this.state(r.id).post = best;
      }
    }
  }

  /** @param {Own} r 布陣時的位置 @returns {Pt} */
  postOf(r) {
    const i = this.state(r.id).post;
    const s = i === undefined ? null : this.slots[i];
    return s ? { x: s.x, y: s.y } : { x: r.x, y: r.y };
  }

  /** @param {Observation} obs */
  decide(obs) {
    this.update(obs);
    this.assignRoles();
    this.markPhantoms();
    /** 過濾前的敵團（找空殼的位置用） */
    this.raw = this.obs.enemies;
    this.obs = { ...this.obs, enemies: this.obs.enemies.filter((e) => !this.phantom.has(e.id)) };
    /** @type {Pending[]} */
    const out = [];
    if (this.data.map.defender < 0) this.openField(out);
    else if (this.attacker) this.attack(out);
    else this.defend(out);
    return this.flush(out);
  }

  /**
   * 空殼敵團：我方有團貼著它（同層、兩團邊緣相距 1.5 格內，正在打它的 4 格內）10 秒、雙方都沒接戰，代表它的士兵卡在別處（牆後、牆頂），
   * 中心是空的；不再追它（不然整支主力會圍著空殼打不到人、也不去佔旗）。它一接戰就恢復。
   */
  markPhantoms() {
    for (const e of this.foes) {
      if (e.engaged) {
        this.phantom.delete(e.id);
        this.near.delete(e.id);
        continue;
      }
      if (this.phantom.has(e.id)) continue;
      // 引擎讓攻擊中的團停在「接觸距離」（兩團半徑相加）外，所以用半徑算
      const close = this.obs.regiments.some((r) => {
        if (r.engaged || r.layer !== e.layer) return false;
        const d = this.dist(r, e) - (r.radius || 0) - (e.radius || 0);
        return d < 1500 || (r.target === e.id && d < 4000);
      });
      if (!close) {
        this.near.delete(e.id);
        continue;
      }
      const since = this.near.get(e.id);
      if (since === undefined) this.near.set(e.id, this.obs.tick);
      else if (this.obs.tick - since > 100) this.phantom.add(e.id);
    }
  }

  /**
   * 近戰團：附近有同層的敵人就打，否則回到 home
   * @param {Pending[]} out @param {Own} r @param {Pt} home @param {number} reach @param {string} why
   */
  holdOrFight(out, r, home, reach, why) {
    if (r.kind === 'spear' && this.spearReact(out, r, true)) return;
    const t = this.nearestFoe(r, (e) => e.layer === r.layer, reach);
    if (t) {
      if (r.kind === 'sword' && this.swordAssault(out, r, t)) return;
      this.send(out, 5, { type: 'attack', id: r.id, target: t.id }, `迎擊${this.units[t.kind].name}`, 20);
      return;
    }
    if (!r.engaged && this.dist(r, home) > 3000) this.send(out, 2, { type: 'move', id: r.id, x: home.x, y: home.y }, why, 40);
  }

  /** @param {Pending[]} out */
  defend(out) {
    const obs = this.obs;
    const s = obs.structures;
    const A = this.data.map.flags[0];
    const B = this.data.map.flags[1] || A;
    const lostA = obs.flags[0] && obs.flags[0].owner !== this.p && obs.flags[0].owner >= 0;
    // 城門：開著就關（A 失守後正門會永久打開，關不了）
    const g = s.gates.find((q) => q.owner === this.p && (q.state === 'open' || q.state === 'opening'));
    if (g) this.send(out, 6, /** @type {any} */ ({ type: 'gate', gate: g.id, action: 'close' }), '關城門', 50);
    // 雲梯：攻方架好的，派最近的牆頂團去推倒
    /** @type {Set<number>} */
    const busy = new Set();
    for (const l of s.ladders) {
      if (l.owner === this.p || !l.built || l.topple >= 0) continue;
      const mouth = { x: l.x, y: l.y };
      // 梯口 40 格內的牆頂團：近戰團優先、沒有才派弓兵（最近的那個）
      const tops = obs.regiments.filter((r) => r.layer === 1 && !r.routed && !busy.has(r.id) && this.dist(r, mouth) <= 40 * TILE).sort((a, b) => this.dist(a, mouth) - this.dist(b, mouth));
      const r = tops.find((q) => q.kind !== 'archer') || tops[0];
      if (!r) continue;
      busy.add(r.id);
      if (this.dist(r, mouth) > 1200 + (r.radius || 0) * 0.5) this.send(out, 7, { type: 'move', id: r.id, x: l.x, y: l.y }, '趕去推倒雲梯', 10);
      else this.send(out, 8, /** @type {any} */ ({ type: 'topple', id: r.id, ladder: l.id }), '推倒雲梯', 30);
    }
    for (const r of obs.regiments) {
      if (r.routed || busy.has(r.id)) continue;
      const role = this.role.get(r.id) || '';
      // A 失守：全軍退守 B
      if (lostA) {
        if (r.kind === 'archer') this.archerReact(out, r, this.go(B.x, B.y, (this.attackDir + 180) % 360, 4000));
        else this.holdOrFight(out, r, B, 8, '退守本陣');
        continue;
      }
      const post = this.postOf(r);
      if (r.kind === 'archer') {
        this.archerReact(out, r, post);
        continue;
      }
      const reach = role === 'reserveA' || role === 'breachGuard' ? 12 : 7;
      // A 旗圈裡有攻方：守 A 的團都去打
      const inA = A ? this.foes.find((e) => e.layer === 0 && this.dist(e, A) < 8000) : null;
      if (inA && (role === 'gateSpear' || role === 'gateShield' || role === 'reserveA') && r.layer === 0) {
        this.send(out, 6, { type: 'attack', id: r.id, target: inA.id }, '把敵人趕出 A 旗圈', 20);
        continue;
      }
      this.holdOrFight(out, r, post, reach, role === 'keepB' ? '守本陣' : '回防位');
    }
  }

  /** @param {Pending[]} out */
  attack(out) {
    const obs = this.obs;
    const s = obs.structures;
    const A = this.data.map.flags[0];
    const B = this.data.map.flags[1] || A;
    const gateState = s.gates.find((q) => q.kind === 'main')?.state;
    const ownA = obs.flags[0] && obs.flags[0].owner === this.p;
    // 主力走城門：雲梯一次只上得了一個人，主力不跟著爬（雲梯隊上了牆自己往旗點打）
    if (!this.pushing && (gateState === 'broken' || ownA || obs.tick > (this.k.pushSec ?? 300) * 10)) this.pushing = true;
    const goal = ownA || (obs.flags[1] && obs.flags[1].open) ? B : A;
    this.bombard(out);
    // 推衝車的團沒了、門還沒破：最近的護送團接手推車
    const ram = s.ram;
    if (!this.pushing && ram && !obs.regiments.some((q) => this.role.get(q.id) === 'crew' && !q.routed)) {
      const next = obs.regiments.filter((q) => this.role.get(q.id) === 'escort' && !q.routed).sort((a, b) => this.dist(a, ram) - this.dist(b, ram))[0];
      if (next) this.role.set(next.id, 'crew');
    }
    for (const r of obs.regiments) {
      if (r.routed) continue;
      const role = this.role.get(r.id) || 'main';
      if (role === 'crew') {
        this.crew(out, r, gateState);
        continue;
      }
      if (role === 'escort') {
        const crew = obs.regiments.find((q) => this.role.get(q.id) === 'crew' && !q.routed);
        if (crew && !this.pushing && crew.order === 'man') {
          if (r.stance !== 'raise' && r.status !== 'walled') this.send(out, 4, /** @type {any} */ ({ type: 'shield', id: r.id, mode: 'raise' }), '舉盾護送衝車', 100);
          const sideIdx = obs.regiments.filter((q) => this.role.get(q.id) === 'escort').indexOf(r);
          this.send(out, 3, /** @type {any} */ ({ type: 'follow', id: r.id, target: crew.id, forward: -1000, right: sideIdx === 0 ? -2600 : 2600 }), '護送衝車', 200);
          continue;
        }
        this.advance(out, r, goal);
        continue;
      }
      if (role === 'ladder') {
        this.ladder(out, r, goal);
        continue;
      }
      if (r.kind === 'archer') {
        this.archerReact(out, r, this.pushing ? this.go(goal.x, goal.y, (this.attackDir + 180) % 360, 9000) : this.archerPost);
        continue;
      }
      if (this.pushing) this.advance(out, r, goal);
      else this.holdOrFight(out, r, this.stage, 6, '在護城河外等破門');
    }
  }

  /**
   * 推衝車：下 man 之後引擎會帶這一團走到車邊附上、沿軌道推到正門外撞門，不再對它下別的指令；破門後卸下衝車，跟著主力推進
   * @param {Pending[]} out @param {Own} r @param {string | undefined} gateState
   */
  crew(out, r, gateState) {
    const ram = this.obs.structures.ram;
    if (!ram || gateState === 'broken' || gateState === 'open' || gateState === undefined) {
      if (r.order === 'man') this.send(out, 6, /** @type {any} */ ({ type: 'unman', id: r.id }), '門破了，放下衝車', 50);
      else this.advance(out, r, this.data.map.flags[0]);
      return;
    }
    if (r.order !== 'man') this.send(out, 6, /** @type {any} */ ({ type: 'man', id: r.id, target: ram.id }), '推衝車', 50);
  }

  /**
   * 雲梯隊：走到梯腳、架梯、架好就爬上去進城；被纏住就先打
   * @param {Pending[]} out @param {Own} r @param {Pt} goal
   */
  ladder(out, r, goal) {
    const spots = this.ladderSpots;
    const teams = this.obs.regiments.filter((q) => this.role.get(q.id) === 'ladder');
    const spot = spots[teams.indexOf(r) % Math.max(1, spots.length)];
    const t = this.nearestFoe(r, (e) => e.layer === r.layer, 4);
    if (t || r.engaged) {
      if (t) this.send(out, 6, { type: 'attack', id: r.id, target: t.id }, `迎擊${this.units[t.kind].name}`, 20);
      return;
    }
    if (!spot || r.layer === 1 || this.pushing) {
      this.advance(out, r, goal);
      return;
    }
    if (r.status === 'laddering') return;
    const mine = this.obs.structures.ladders.find((l) => l.owner === this.p && this.dist(l, spot.wall) < 700);
    if (mine && mine.built) {
      // 爬上去：目的地是梯口那格城牆（只有牆頂到得了），上了牆再往旗點走
      this.send(out, 5, { type: 'move', id: r.id, x: spot.wall.x, y: spot.wall.y }, '爬雲梯上牆', 80);
      return;
    }
    if (mine) return;
    if (this.dist(r, spot.foot) > 3500) {
      this.send(out, 4, { type: 'move', id: r.id, x: spot.foot.x, y: spot.foot.y }, '走到架梯的牆下', 40);
      return;
    }
    this.send(out, 6, /** @type {any} */ ({ type: 'ladder', id: r.id, x: spot.wall.x, y: spot.wall.y }), '架雲梯', 90);
  }

  /** 推進：沿路打同層的敵人，往目標走 @param {Pending[]} out @param {Own} r @param {Pt} goal */
  advance(out, r, goal) {
    if (r.kind === 'spear' && this.spearReact(out, r, false)) return;
    const t = this.nearestFoe(r, (e) => e.layer === r.layer, 8);
    if (t) {
      if (r.kind === 'sword' && this.swordAssault(out, r, t)) return;
      this.send(out, 5, { type: 'attack', id: r.id, target: t.id }, `攻擊${this.units[t.kind].name}`, 20);
      return;
    }
    if (r.engaged) return;
    if (this.dist(r, goal) <= 2500) return;
    // 附近有空殼敵團：用一般移動（攻擊移動會被引擎自動鎖定到空殼上，整團圍著它打不到人）
    const shell = [...this.phantom].some((id) => {
      const e = this.raw.find((q) => q.id === id);
      return e !== undefined && this.dist(r, e) < 12 * TILE;
    });
    this.send(out, 3, { type: shell ? 'move' : 'attackMove', id: r.id, x: goal.x, y: goal.y }, '推進旗點', 50);
  }

  /** 落點往砲擊來向的陰影（引擎的規則：每 250 單位取樣，碰到城牆或門樓，落點那一格不算） @param {Pt} p */
  shadowed(p) {
    const sg = this.data.siege;
    if (!sg) return true;
    const from = this.data.map.bombardFrom;
    const tx0 = Math.floor(p.x / TILE);
    const ty0 = Math.floor(p.y / TILE);
    for (let d = 250; d <= sg.bombard.shadow; d += 250) {
      const q = this.go(p.x, p.y, from, d);
      const tx = Math.floor(q.x / TILE);
      const ty = Math.floor(q.y / TILE);
      if (tx === tx0 && ty === ty0) continue;
      const t = this.tAt(tx, ty);
      if (t === T.wall || t === T.gate) return true;
    }
    return false;
  }

  /** 砲擊：找看得到的守軍最密的地方（牆頂加分），不在陰影、不打到自己人 @param {Pending[]} out */
  bombard(out) {
    const s = this.obs.structures;
    const sg = this.data.siege;
    if (!sg || s.bombardsLeft <= 0 || s.bombardReadyIn > 0 || this.data.map.bombardFrom < 0) return;
    const R = sg.bombard.radius;
    let best = null;
    let bestS = 0;
    for (const e of this.foes) {
      // 試幾個點：敵團中心，以及往砲擊來向挪一點（貼牆的陰影外）
      for (const shift of [0, 1000, 2000]) {
        const p = this.go(e.x, e.y, this.data.map.bombardFrom, shift);
        if (this.shadowed(p)) continue;
        if (this.obs.regiments.some((r) => this.dist(r, p) < R + (r.radius || 0) * 0.5)) continue;
        let sc = 0;
        for (const o of this.foes) if (this.dist(o, p) < R + (o.radius || 0) * 0.4) sc += o.men * (o.layer === 1 ? 1.5 : 1);
        if (sc > bestS) {
          bestS = sc;
          best = p;
        }
      }
    }
    if (best && bestS >= (this.k.bombardMin ?? 14)) this.send(out, 9, /** @type {any} */ ({ type: 'bombard', x: Math.round(best.x), y: Math.round(best.y) }), '砲擊守軍', 0);
  }

  /** 不是攻城地圖：全軍壓向主旗（只是不讓它在別的模式當機） @param {Pending[]} out */
  openField(out) {
    const f = this.mainFlag;
    const goal = f ? { x: f.x, y: f.y } : this.data.map.spawns[1 - this.p];
    for (const r of this.obs.regiments) if (!r.routed) this.advance(out, r, goal);
  }
}
