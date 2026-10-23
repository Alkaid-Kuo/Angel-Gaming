// @ts-check
// 軍團戰基準 AI：林中伏兵。主力守在淺灘後方，劍士事先藏進淺灘旁的樹林；
// 敵軍過河靠近樹林、或和主力接戰時，伏兵從側面殺出（能突擊就突擊）；太久沒等到人就改去支援主戰場。
// 接觸後騎兵繞橋偷襲敵方弓兵與後排；斥候躲在橋邊樹林看動靜。
import { LegionBase } from './base.js';

/** @typedef {import('./base.js').Own} Own */
/** @typedef {import('./base.js').Pending} Pending */
/** @typedef {import('./base.js').PlanEntry} PlanEntry */
/** @typedef {import('./base.js').Declaration} Declaration */
/** @typedef {import('./base.js').InitData} InitData */
/** @typedef {import('./base.js').Helpers} Helpers */
/** @typedef {import('./base.js').Observation} Observation */
/** @typedef {import('./base.js').Pt} Pt */

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
    /** @type {[import('./base.js').UnitKind, string][]} */
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
    const hunt = this.huntPoint();
    if (hunt) this.allIn = true;
    const main0 = capture ? this.mainFlag : null;
    const goal = hunt || (main0 ? { x: main0.x, y: main0.y } : this.at(140, 50));
    const hold = main0 ? { x: main0.x, y: main0.y } : this.at(68, 50);
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
    // 佔點：最後一團長槍去佔離它最近的兩側旗
    if (capture && main.length >= 2) {
      const holder = main[main.length - 1];
      const sf = this.sideFlagFor(holder);
      if (sf && !holder.engaged) this.takeFlag(out, holder, sf, 6);
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
      const sf = capture ? this.sideFlagFor(r) : null;
      if (sf && !r.engaged && !r.dashing && !this.nearestFoe(r, (e) => e.kind !== 'light', 10) && this.takeFlag(out, r, sf, 4)) continue;
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
