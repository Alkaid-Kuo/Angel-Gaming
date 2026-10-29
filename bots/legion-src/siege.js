// @ts-check
// 軍團戰陪練：攻城陪練（只給攻城戰用）。攻守兩邊都會打，讓玩家在石關城有一場像樣的攻城可以練。
// 守方：弓兵、長槍上牆（正門兩側、甕城、缺口兩側），長槍與盾兵守正門內側的 A 旗圈，劍士守缺口、側門與本陣；開場關門；
//       攻方的雲梯一架好就派最近的牆頂團去推倒；A 失守全軍退守 B。
// 攻方：一團劍士推衝車撞正門、盾兵跟著護送；兩團劍士到離門樓遠的牆段架雲梯；弓兵在護城河外壓制牆頂；
//       砲擊打牆頂與門後聚集的守軍（避開陰影區與自己人）；破門、佔下 A 或過了強攻時間，主力從城門推進 A、再推進 B。
// 地圖上的目標都從開局資料算（城門、隘口、旗、布陣遮罩），不寫死座標。
import { LegionBase, TILE } from './base.js';

/** @typedef {import('./base.js').Own} Own */
/** @typedef {import('./base.js').Enemy} Enemy */
/** @typedef {import('./base.js').Pt} Pt */
/** @typedef {import('./base.js').Pending} Pending */
/** @typedef {import('./base.js').Declaration} Declaration */
/** @typedef {import('./base.js').InitData} InitData */
/** @typedef {import('./base.js').Helpers} Helpers */
/** @typedef {import('./base.js').Observation} Observation */
/** @typedef {import('./base.js').UnitKind} UnitKind */
/** @typedef {import('./base.js').FormationKind} FormationKind */
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
   * @returns {import('./base.js').Deployment[]}
   */
  deployOpen() {
    /** @type {[UnitKind, string][]} */
    const wish = [['light', 'scout'], ['archer', 'archer'], ['archer', 'archer'], ['shield', 'shield'], ['sword', 'line'], ['spear', 'line'], ['spear', 'line'], ['sword', 'line'], ['spear', 'line']];
    const list = this.buy(wish, [['spear', 'line'], ['sword', 'line']]);
    const lineYs = [0, -8, 8, -16, 16, -24];
    let li = 0;
    let ai = 0;
    /** @type {import('./base.js').PlanEntry[]} */
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
    const ram = m.ram || { x: frontX, y: midY };
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
