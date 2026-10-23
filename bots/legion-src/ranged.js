// @ts-check
// 軍團戰基準 AI：箭雨。佔住淺灘旁的己方高地，弓兵居高射擊、對淺灘與被纏住的敵軍齊射；
// 盾兵在弓兵前方舉盾擋箭、步兵逼近就架盾牆；長槍守兩翼、騎兵逼近就架槍林；兵力明顯佔優或太久沒交戰就往前壓。
import { LegionBase } from './base.js';

/** @typedef {import('./base.js').Own} Own */
/** @typedef {import('./base.js').Pending} Pending */
/** @typedef {import('./base.js').PlanEntry} PlanEntry */
/** @typedef {import('./base.js').Declaration} Declaration */
/** @typedef {import('./base.js').InitData} InitData */
/** @typedef {import('./base.js').Helpers} Helpers */
/** @typedef {import('./base.js').Observation} Observation */
/** @typedef {import('./base.js').Pt} Pt */

export default class ArrowRain extends LegionBase {
  constructor() {
    super();
    this.advance = false;
    this.lastBusy = 0;
    /** 往前壓的進度（格）：只增不減，交戰中佔優時也慢慢往前 */
    this.pushed = 0;
    this.lastTick = 0;
    this.patienceScale = 1;
    /** 己方高地（世界座標） @type {Pt} */
    this.hill = { x: 0, y: 0 };
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '箭雨',
      version: 'v2',
      style: '佔住淺灘旁的高地，弓兵居高齊射、盾兵舉盾與架盾牆、長槍架槍林守兩翼；佔優或久攻不下時往前壓',
      knobs: [
        { key: 'archers', name: '弓兵', description: '弓兵團數', min: 2, max: 5, default: 4, integer: true },
        { key: 'shields', name: '盾兵', description: '盾兵團數', min: 1, max: 3, default: 2, integer: true },
        { key: 'advanceRatio', name: '進攻門檻', description: '我方兵力是敵方幾倍（×10）就往前壓', min: 11, max: 30, default: 16, integer: true },
        { key: 'patience', name: '耐心', description: '多久沒交戰就往前推（秒）', min: 30, max: 240, default: 70, integer: true },
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
    // 己方這一側、最靠近淺灘的高地
    const ford = this.geo.fords[0] || this.at(80, 50);
    let best = this.at(64, 59);
    let bestD = Infinity;
    for (const h of this.geo.hills) {
      if (this.loc(h).x > 76) continue;
      const d = this.dist(h, ford);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    this.hill = best;
    const k = data.knobs;
    /** @type {[import('./base.js').UnitKind, string][]} */
    const wish = [['light', 'scout'], ['spear', 'spear'], ['spear', 'spear']];
    for (let i = 0; i < (k.archers ?? 4); i++) wish.push(['archer', 'archer']);
    for (let i = 0; i < (k.shields ?? 2); i++) wish.push(['shield', 'shield']);
    wish.push(['heavyCav', 'cav'], ['sword', 'spear'], ['light', 'scout']);
    const list = this.buy(wish);
    let ai = 0;
    let si = 0;
    let pi = 0;
    /** @type {PlanEntry[]} */
    const plan = list.map((e) => {
      if (e.role === 'archer') return { ...e, tx: [8, 8, 13, 13, 4][ai % 5], ty: [50, 60, 45, 65, 55][ai++ % 5], facing: 0, width: 10 };
      if (e.role === 'shield') return { ...e, tx: 17, ty: [50, 60, 40][si++ % 3], facing: 0 };
      if (e.role === 'spear') return { ...e, tx: 17, ty: [32, 72, 84][pi++ % 3], facing: 0, ...(e.type === 'spear' ? { formation: /** @type {const} */ ('square') } : {}) };
      if (e.role === 'cav') return { ...e, tx: 6, ty: 75, facing: 0, formation: 'wedge' };
      return { ...e, tx: 6, ty: e.role === 'scout' && pi > 0 ? 24 : 80, facing: 0 };
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
    const busy = this.busy;
    if (busy || this.lastBusy === 0) this.lastBusy = obs.tick;
    const seenAny = this.seen.size > 0;
    if (!this.advance) {
      if (seenAny && this.strengthRatio() * 10 >= (k.advanceRatio ?? 16) && obs.tick > 600) this.advance = true;
      if (obs.tick - this.lastBusy > (k.patience ?? 70) * 10 * this.patienceScale) this.advance = true;
    }
    const dt = obs.tick - this.lastTick;
    this.lastTick = obs.tick;
    if (this.advance) this.pushed = Math.min(48, this.pushed + (busy ? (this.strengthRatio() >= 1 ? dt / 40 : 0) : dt / 15));
    const forward = this.forward;
    const flags = this.data.map.flags;
    // 陣地：高地；往前壓時陣地往前移（交戰時不往回縮）；太久沒打就去找敵人（陣地在敵軍前方 9 格）
    const hunt = this.huntPoint();
    if (hunt) this.advance = true;
    const post = hunt ? this.offset(hunt, this.face(180), 9) : this.advance ? this.offset(this.hill, forward, 12 + this.pushed) : this.hill;
    /** @type {Map<number, number>} */
    const load = new Map();

    // 弓兵：高地上排成兩排兩列
    const archers = this.mine('archer');
    archers.forEach((r, i) => {
      const lat = (i % 2 === 0 ? -1 : 1) * 4.5;
      const back = Math.floor(i / 2) * 3;
      this.archerReact(out, r, this.offset(this.offset(post, this.face(90), lat), this.face(180), back));
    });
    // 盾兵：各護送一團弓兵（站在前方）
    this.mine('shield').forEach((r, i) => this.shieldReact(out, r, archers[i % Math.max(1, archers.length)] || null));
    // 長槍（與劍士）：守高地兩翼
    const wings = [this.offset(this.offset(post, forward, 6), this.face(90), -9), this.offset(this.offset(post, forward, 6), this.face(90), 9), this.offset(post, this.face(90), 14)];
    this.mine('spear').forEach((r, i) => {
      if (r.kind === 'spear' && this.spearReact(out, r, !this.advance)) return;
      const t = this.meleeTarget(r, this.advance ? 16 : 7, load);
      if (t) {
        load.set(t.id, (load.get(t.id) || 0) + 1);
        if (r.kind === 'sword' && this.swordAssault(out, r, t)) return;
        this.send(out, 5, { type: 'attack', id: r.id, target: t.id }, `迎戰${this.units[t.kind].name}`, 20);
        return;
      }
      if (r.engaged) return;
      const w = wings[i % wings.length];
      if (this.dist(r, w) > 2500) this.send(out, 2, { type: 'move', id: r.id, x: w.x, y: w.y, facing: forward }, hunt ? '搜索敵軍' : this.advance ? '往前推進' : '守高地側翼', 30);
    });
    // 佔點：長槍守中央旗點旁
    if (capture && flags[1]) {
      const sp = this.mine('spear').find((r) => r.kind === 'spear');
      if (sp && !sp.engaged && this.dist(sp, flags[1]) > 4500) this.send(out, 6, { type: 'move', id: sp.id, x: flags[1].x, y: flags[1].y, facing: forward }, '守中央旗點', 40);
    }
    // 騎兵：高地後方待命
    for (const r of this.mine('cav')) this.cavalryCycle(out, r, this.offset(this.offset(post, this.face(180), 8), this.face(90), 12), 22);
    // 斥候：北邊、南邊的橋
    this.mine('scout').forEach((r, i) => this.scoutReact(out, r, this.at(68, i === 0 ? 24 : 76), i === 0 ? '北橋' : '南橋'));
    return this.flush(out);
  }
}
