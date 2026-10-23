// @ts-check
// 軍團戰基準 AI：鐵壁推進。整條戰線一起推到河邊、站穩後一起過河（多半走淺灘，有時改走北橋或南橋）；
// 長槍守中央、遇騎兵就架槍林，劍士在兩側找機會突擊；弓兵在盾兵掩護下射擊與齊射；重騎兵在側翼等機會衝敵方弓兵或已接戰敵軍的側背。
import { LegionBase } from './base.js';

/** @typedef {import('./base.js').Own} Own */
/** @typedef {import('./base.js').Pending} Pending */
/** @typedef {import('./base.js').PlanEntry} PlanEntry */
/** @typedef {import('./base.js').Declaration} Declaration */
/** @typedef {import('./base.js').InitData} InitData */
/** @typedef {import('./base.js').Helpers} Helpers */
/** @typedef {import('./base.js').Observation} Observation */

/** 過河路線（己方視角）：戰線集結的 y、過河後的目標 */
const ROUTES = [
  { name: '淺灘', y: 50, crossX: 92 },
  { name: '北橋', y: 22, crossX: 94 },
  { name: '南橋', y: 78, crossX: 94 },
];

export default class IronPush extends LegionBase {
  constructor() {
    super();
    this.route = 0;
    /** 戰線推到河邊的 tick */
    this.reachedAt = -1;
    this.crossing = false;
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '鐵壁推進',
      version: 'v2',
      style: '整條戰線推到河邊站穩，再一起過河；長槍架槍林守中央、劍士在兩側突擊，弓兵在盾兵後方齊射，重騎兵在側翼伺機衝鋒',
      knobs: [
        { key: 'cavalry', name: '重騎兵', description: '重騎兵團數', min: 0, max: 2, default: 1, integer: true },
        { key: 'archers', name: '弓兵', description: '弓兵團數', min: 0, max: 3, default: 2, integer: true },
        { key: 'lineX', name: '前線位置', description: '戰線先推進到哪裡（己方視角的格 x，河在 76 附近）', min: 40, max: 72, default: 67, integer: true },
        { key: 'waitSec', name: '河邊等待', description: '推到河邊後等多久才過河（秒）；看到敵人就直接開打', min: 0, max: 90, default: 6, integer: true },
        { key: 'bridgeChance', name: '走橋機率', description: '開局隨機決定改走北橋或南橋的機率（%）', min: 0, max: 100, default: 25, integer: true },
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
    if (helpers.random() * 100 < (k.bridgeChance ?? 25)) this.route = helpers.random() < 0.5 ? 1 : 2;
    /** @type {[import('./base.js').UnitKind, string][]} */
    const wish = [['light', 'scout']];
    for (let i = 0; i < (k.cavalry ?? 1); i++) wish.push(['heavyCav', 'cav']);
    for (let i = 0; i < (k.archers ?? 2); i++) wish.push(['archer', 'archer']);
    wish.push(['shield', 'shield']);
    for (const t of /** @type {import('./base.js').UnitKind[]} */ (['sword', 'spear', 'spear', 'sword', 'spear', 'sword'])) wish.push([t, 'line']);
    const list = this.buy(wish);
    const y0 = ROUTES[this.route].y;
    const lineYs = [0, -8, 8, -16, 16, -24];
    let li = 0;
    let ai = 0;
    let ci = 0;
    // 戰線由左到右：劍士、長槍、長槍、劍士……（陣列順序就是 lineYs 的位置）
    /** @type {PlanEntry[]} */
    const plan = list.map((e) => {
      if (e.role === 'line') {
        const y = Math.max(8, Math.min(92, 50 + lineYs[li++ % 6] * 1.15));
        return { ...e, tx: 17, ty: y, facing: 0, formation: e.type === 'spear' ? 'square' : 'line' };
      }
      if (e.role === 'archer') return { ...e, tx: 9, ty: [44, 56, 50][ai++ % 3], facing: 0, width: 12 };
      if (e.role === 'shield') return { ...e, tx: 11, ty: 50, facing: 0 };
      if (e.role === 'cav') return { ...e, tx: 12, ty: (y0 < 50 ? [24, 76] : [76, 24])[ci++ % 2], facing: 0, formation: 'wedge' };
      return { ...e, tx: 9, ty: 32, facing: 0 };
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
    const route = ROUTES[this.route];
    const line = this.mine('line').sort((a, b) => this.loc(a).y - this.loc(b).y);
    const lineX = k.lineX ?? 67;
    const front = line.length ? Math.min(...line.map((r) => this.loc(r).x)) : lineX;
    const foes = this.foes;
    const contact = foes.some((e) => e.kind !== 'light' && line.some((r) => this.gap(r, e) < 18));
    if (this.reachedAt < 0 && front >= lineX - 3) this.reachedAt = obs.tick;
    if (!this.crossing && (contact || (this.reachedAt >= 0 && obs.tick - this.reachedAt >= (k.waitSec ?? 6) * 10) || obs.tick > 1100)) this.crossing = true;
    // 戰線錨點：還沒過河就停在 lineX；過河後一路往前（每次最多比最慢的一團前 6 格，維持戰線）
    const goalX = this.crossing ? 140 : lineX;
    const anchorX = Math.round(Math.min(goalX, front + 6) / 3) * 3;
    const centerFlag = this.data.map.flags[1];
    const anchorY = this.crossing ? 50 : route.y;
    let anchor = this.at(anchorX, anchorY);
    if (capture && this.crossing && centerFlag) anchor = { x: centerFlag.x, y: centerFlag.y };
    const hunt = this.huntPoint();
    if (hunt) {
      this.crossing = true;
      anchor = hunt;
    }
    const slots = this.lineSlots(line, anchor, this.forward, 1.5);
    /** @type {Map<number, number>} */
    const load = new Map();

    // 戰線
    for (const r of line) {
      const slot = slots.get(r.id) || anchor;
      // 過河進攻時不為步兵停下架槍林（只防騎兵），避免兩邊隔河對峙
      if (r.kind === 'spear' && this.spearReact(out, r, !this.crossing)) continue;
      const t = this.meleeTarget(r, this.crossing ? 14 : 9, load);
      if (t) {
        load.set(t.id, (load.get(t.id) || 0) + 1);
        if (r.kind === 'sword' && this.swordAssault(out, r, t)) continue;
        if ((r.kind === 'sword' || r.kind === 'light') && this.spearWall(t, r)) {
          const fp = this.flankPoint(r, t, 6);
          this.send(out, 5, { type: 'move', id: r.id, x: fp.x, y: fp.y }, '避開槍林繞側面', 30);
          continue;
        }
        this.send(out, 5, { type: 'attack', id: r.id, target: t.id }, `攻擊${this.units[t.kind].name}`, 20);
        continue;
      }
      if (r.engaged) continue;
      if (this.dist(r, slot) > 2500) {
        const why = hunt ? '搜索敵軍' : this.crossing ? (capture ? '推進中央旗點' : `經${route.name}進攻`) : '推進到河邊列陣';
        this.send(out, 2, { type: 'move', id: r.id, x: slot.x, y: slot.y, facing: this.forward }, why, 30);
      }
    }
    // 佔點：一團長槍守己方高地旗點
    if (capture) {
      const own = this.data.map.flags[this.p === 0 ? 0 : 2];
      const holder = line.find((r) => r.kind === 'spear');
      if (own && holder && !holder.engaged && this.dist(holder, own) > 3000) this.send(out, 6, { type: 'move', id: holder.id, x: own.x, y: own.y, facing: this.forward }, '守住己方旗點', 40);
    }
    // 弓兵：戰線後方 7 格
    const archers = this.mine('archer');
    archers.forEach((r, i) => {
      const post = this.offset(this.offset(anchor, this.face(180), 7), this.face(90), (i - (archers.length - 1) / 2) * 9);
      this.archerReact(out, r, post);
    });
    // 盾兵：護送第一團弓兵
    for (const r of this.mine('shield')) this.shieldReact(out, r, archers[0] || null);
    // 重騎兵：戰線的側翼待命，找機會衝鋒
    for (const r of this.mine('cav')) {
      const side = this.loc(r).y < 50 ? -1 : 1;
      const rally = this.offset(this.offset(anchor, this.face(90), side * 20), this.face(180), 4);
      this.cavalryCycle(out, r, rally, 26);
    }
    // 斥候：戰線前方
    for (const r of this.mine('scout')) this.scoutReact(out, r, this.at(Math.min(84, anchorX + 12), route.y), route.name);
    return this.flush(out);
  }
}

