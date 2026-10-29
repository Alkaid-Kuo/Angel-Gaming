// @ts-check
// CS 射擊陪練 Bot（測試用，沒有戰術）：
// T 的持彈者走最近的炸彈點下包，其他 T 跟去同一點；炸彈掉了由最近的 T 去撿；下包後守在炸彈旁。
// CT 分兩點守（預設 3 人 A、2 人 B），炸彈下了就去拆。
// 任何人看到敵人就瞄準開火（有效射程內站定，太遠邊走邊打）；沒看到就看移動方向，聽到敵方聲音就轉向聲音。
// 購買（各買各的，沒有團隊協調）：錢 ≥ 全買門檻就買步槍＋護甲（CT 加拆彈器），再多買一顆道具（T 煙霧、CT 閃光）；
// 錢 ≥ 衝鋒槍＋護甲就半買；否則 eco（只在手槍局買護甲）。
// 道具（v3，只有兩條、不是戰術）：T 下包前離目標炸彈點中心 15 格內且看得到中心，朝中心丟煙霧；
// CT 雷達或視野出現 10～20 格的敵人，朝它的方向全力丟閃光。每回合各一次。

/** @typedef {import('../src/shooter/api.ts').ShooterInitData} InitData */
/** @typedef {import('../src/shooter/api.ts').ShooterHelpers} Helpers */
/** @typedef {import('../src/shooter/api.ts').ShooterObservation} Observation */
/** @typedef {import('../src/shooter/api.ts').ShooterCommand} Command */
/** @typedef {import('../src/shooter/api.ts').EnemyInfo} Enemy */
/** @typedef {{ id: 'A' | 'B', x0: number, y0: number, x1: number, y1: number }} Site */

const UNIT = 1000;

export default class ShooterPractice {
  constructor() {
    /** @type {InitData} */
    this.data = /** @type {any} */ (null);
    /** @type {Helpers} */
    this.h = /** @type {any} */ (null);
    /** @type {Readonly<Record<string, number>>} */
    this.k = {};
    this.round = 0;
    /** 本回合要去的點（座標單位） @type {{ x: number, y: number } | null} */
    this.spot = null;
    /** 本回合的目標炸彈點 @type {'A' | 'B' | null} */
    this.site = null;
    /** 連續看見目前目標的決策次數 */
    this.seen = 0;
    this.target = -1;
    /** 本回合是否已經丟過道具 */
    this.thrown = false;
  }

  declare() {
    return {
      name: 'shooter-practice',
      version: '4',
      style: '陪練',
      knobs: [
        { key: 'reaction', name: '反應', description: '看到敵人後等幾次決策（每次 0.1 秒）才開火', min: 0, max: 5, default: 1, integer: true },
        { key: 'aimJitter', name: '瞄準抖動', description: '瞄準點的隨機偏移（座標單位，1 格 = 1000）', min: 0, max: 600, default: 150, integer: true },
        { key: 'aSplit', name: '守 A 人數', description: 'CT 守 A 點的人數（依隊內序號，其餘守 B）', min: 0, max: 5, default: 3, integer: true },
        { key: 'buyThreshold', name: '全買門檻', description: '錢到多少才全買（步槍＋護甲）；0 = 剛好買得起步槍＋護甲', min: 0, max: 16000, default: 0, integer: true },
        { key: 'awpSlot', name: '狙擊手', description: '隊內序號幾號在錢夠時改買狙擊槍（5 = 沒有狙擊手）', min: 0, max: 5, default: 4, integer: true },
      ],
    };
  }

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  init(data, helpers) {
    this.data = data;
    this.h = helpers;
    this.k = data.knobs;
  }

  /** @param {'A' | 'B'} id */
  siteRect(id) {
    return /** @type {Site} */ (this.data.map.sites.find((s) => s.id === id));
  }

  /** 炸彈點裡隨機一格（避開牆） @param {'A' | 'B'} id */
  pickSpot(id) {
    const s = this.siteRect(id);
    for (let i = 0; i < 20; i++) {
      const cx = s.x0 + 2 + Math.floor(this.h.random() * (s.x1 - s.x0 - 4));
      const cy = s.y0 + 2 + Math.floor(this.h.random() * (s.y1 - s.y0 - 4));
      if (!this.h.isSolid(cx, cy) && !this.h.isSolid(cx + 1, cy) && !this.h.isSolid(cx - 1, cy) && !this.h.isSolid(cx, cy + 1) && !this.h.isSolid(cx, cy - 1)) {
        return { x: cx * UNIT + UNIT / 2, y: cy * UNIT + UNIT / 2 };
      }
    }
    return { x: ((s.x0 + s.x1) * UNIT) / 2, y: ((s.y0 + s.y1) * UNIT) / 2 };
  }

  /** 離 (x, y) 直線最近的炸彈點 @param {number} x @param {number} y */
  nearestSite(x, y) {
    let best = /** @type {'A' | 'B'} */ ('A');
    let bestD = Infinity;
    for (const s of this.data.map.sites) {
      const d = this.h.dist(x, y, ((s.x0 + s.x1) * UNIT) / 2, ((s.y0 + s.y1) * UNIT) / 2);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    return best;
  }

  /** @param {number} x @param {number} y */
  inSite(x, y) {
    const cx = Math.floor(x / UNIT);
    const cy = Math.floor(y / UNIT);
    return this.data.map.sites.some((s) => cx >= s.x0 + 1 && cx < s.x1 - 1 && cy >= s.y0 + 1 && cy < s.y1 - 1);
  }

  /** @param {Observation} obs */
  decide(obs) {
    const me = obs.me;
    if (!me.alive) return [];
    if (obs.round.number !== this.round) {
      this.round = obs.round.number;
      this.spot = null;
      this.site = null;
      this.seen = 0;
      this.target = -1;
      this.thrown = false;
    }
    /** @type {Command[]} */
    const out = [];
    if (obs.round.canBuy) this.buy(obs, out);
    if (!this.thrown) this.throwNade(obs, out);
    if (me.loadout.primary !== null && me.weapon !== me.loadout.primary) out.push({ type: 'switch', slot: 'primary' });
    else if (me.loadout.primary === null && me.weapon === 'knife' && me.loadout.secondary !== null) out.push({ type: 'switch', slot: 'secondary' });

    const enemy = this.closestEnemy(obs);
    if (enemy !== null) {
      if (enemy.id === this.target) this.seen += 1;
      else {
        this.target = enemy.id;
        this.seen = 0;
      }
      const j = this.k.aimJitter ?? 0;
      out.push({ type: 'aim', x: enemy.x + (this.h.random() * 2 - 1) * j, y: enemy.y + (this.h.random() * 2 - 1) * j });
      if (me.ammoMag === 0 && me.weapon !== 'knife') {
        out.push({ type: 'fire', on: false }, { type: 'reload' });
      } else if (me.weapon === 'awp' && !me.scoped) {
        // 狙擊槍不開鏡極不準：先開鏡，下一次決策才開火
        out.push({ type: 'fire', on: false }, { type: 'scope', on: true });
      } else {
        out.push({ type: 'fire', on: this.seen >= (this.k.reaction ?? 0) });
      }
      // 有效射程內站定開火；太遠就邊走邊打
      const w = this.data.weapons.find((x) => x.id === me.weapon);
      if (w === undefined || this.h.dist(me.x, me.y, enemy.x, enemy.y) <= w.range * UNIT || me.plantTicks > 0 || me.defuseTicks > 0) {
        out.push({ type: 'stop' });
        return out;
      }
      const goal = me.team === 'T' ? this.tGoal(obs, []) : this.ctGoal(obs, []);
      if (goal !== null) out.push({ type: 'move', x: goal.x, y: goal.y });
      return out;
    }
    this.target = -1;
    this.seen = 0;
    out.push({ type: 'fire', on: false });
    const w = this.data.weapons.find((x) => x.id === me.weapon);
    if (w !== undefined && w.magazine > 0 && me.ammoMag < w.magazine / 2 && me.ammoReserve > 0 && me.reloadTicksLeft === 0) out.push({ type: 'reload' });

    if (me.plantTicks > 0 || me.defuseTicks > 0) return out;
    const goal = me.team === 'T' ? this.tGoal(obs, out) : this.ctGoal(obs, out);
    if (goal !== null) out.push({ type: 'move', x: goal.x, y: goal.y });
    // 狙擊槍：站定（快到目標點）就開鏡架點，要跑遠路就收鏡（開鏡移動慢一半）
    if (me.weapon === 'awp') {
      const holding = goal === null || this.h.dist(me.x, me.y, goal.x, goal.y) < 2 * UNIT;
      if (holding !== me.scoped) out.push({ type: 'scope', on: holding });
    }
    this.look(obs, out);
    return out;
  }

  /** @param {string} id */
  price(id) {
    const w = this.data.weapons.find((x) => x.id === id);
    return w === undefined ? Infinity : w.price;
  }

  /**
   * 最簡單的購買規則：全買／半買（衝鋒槍）／eco；已經有的不重買
   * @param {Observation} obs
   * @param {Command[]} out
   */
  buy(obs, out) {
    const me = obs.me;
    const rules = this.data.rules;
    const rifle = me.team === 'T' ? 'ak' : 'm4';
    const rifleCost = this.price(rifle) + rules.armorPrice;
    const full = Math.max(this.k.buyThreshold ?? 0, rifleCost);
    const needArmor = me.loadout.armor < rules.maxArmor;
    const primary = me.loadout.primary;
    /** @type {import('../src/shooter/api.ts').BuyItem[]} */
    const items = [];
    // 狙擊手：錢夠狙擊槍＋護甲就改買狙擊槍
    const awper = this.data.slot === (this.k.awpSlot ?? 4) && me.money >= this.price('awp') + rules.armorPrice;
    if (awper && primary !== 'awp') items.push('awp');
    if (me.money >= full || awper) {
      if (!awper && (primary === null || this.price(primary) < this.price(rifle))) items.push(rifle);
      if (needArmor) items.push('armor');
      if (me.team === 'CT' && !me.loadout.kit) items.push('kit');
      const nade = me.team === 'T' ? 'smoke' : 'flash';
      if (!me.loadout.grenades.includes(nade)) items.push(nade);
    } else if (me.money >= this.price('smg') + rules.armorPrice) {
      if (primary === null) items.push('smg');
      if (needArmor) items.push('armor');
    } else {
      const pistolRound = obs.round.number === 1 || obs.round.number === rules.roundsPerHalf + 1;
      if (pistolRound && needArmor) items.push('armor');
    }
    // 彈藥不會自動補：手上的槍備彈剩一半以下就買（新買的槍本來就是滿的）
    const w = this.data.weapons.find((x) => x.id === me.weapon);
    if (w !== undefined && w.reserve > 0 && me.ammoReserve < w.reserve / 2) items.push('ammo');
    if (items.length > 0) out.push({ type: 'buy', items });
  }

  /**
   * 每回合最多丟一次：T 在目標炸彈點 15 格內朝點中心丟煙霧（下包前、沒看到敵人、看得到中心）；
   * CT 看到或雷達上有 10～20 格內的敵人就朝它全力丟閃光
   * @param {Observation} obs
   * @param {Command[]} out
   */
  throwNade(obs, out) {
    const me = obs.me;
    const range = this.data.rules.grenadeRules.maxThrowRange * UNIT;
    if (me.team === 'T') {
      if (obs.round.phase !== 'live' || this.site === null || obs.enemies.length > 0 || !me.loadout.grenades.includes('smoke')) return;
      const s = this.siteRect(this.site);
      const cx = ((s.x0 + s.x1) * UNIT) / 2;
      const cy = ((s.y0 + s.y1) * UNIT) / 2;
      const d = this.h.dist(me.x, me.y, cx, cy);
      if (d > 15 * UNIT || !this.h.clearLine(me.x, me.y, cx, cy)) return;
      out.push({ type: 'throw', grenade: 'smoke', deg: this.h.angleTo(me.x, me.y, cx, cy), power: Math.min(100, Math.round((d / range) * 100)) });
      this.thrown = true;
      return;
    }
    if ((obs.round.phase !== 'live' && obs.round.phase !== 'planted') || !me.loadout.grenades.includes('flash')) return;
    for (const e of [...obs.enemies, ...obs.radar]) {
      const d = this.h.dist(me.x, me.y, e.x, e.y);
      if (d < 10 * UNIT || d > 20 * UNIT) continue;
      out.push({ type: 'throw', grenade: 'flash', deg: this.h.angleTo(me.x, me.y, e.x, e.y), power: 100 });
      this.thrown = true;
      return;
    }
  }

  /** @param {Observation} obs */
  closestEnemy(obs) {
    /** @type {Enemy | null} */
    let best = null;
    let bestD = Infinity;
    for (const e of obs.enemies) {
      const d = this.h.dist(obs.me.x, obs.me.y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * @param {Observation} obs
   * @param {Command[]} out
   * @returns {{ x: number, y: number } | null}
   */
  tGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      if (this.h.dist(me.x, me.y, b.x, b.y) < 4 * UNIT) return null;
      return { x: b.x, y: b.y };
    }
    if (me.hasBomb) {
      if (this.site === null) this.site = this.nearestSite(me.x, me.y);
      if (obs.round.phase === 'live' && this.inSite(me.x, me.y)) {
        out.push({ type: 'plant' });
        return null;
      }
      if (this.spot === null) this.spot = this.pickSpot(this.site);
      return this.spot;
    }
    if (b.state === 'dropped' && b.x !== null && b.y !== null) {
      // 最近的活著的 T 去撿
      const myD = this.h.dist(me.x, me.y, b.x, b.y);
      const closer = obs.teammates.some((t) => t.alive && this.h.dist(t.x, t.y, /** @type {number} */ (b.x), /** @type {number} */ (b.y)) < myD);
      if (!closer) return { x: b.x, y: b.y };
    }
    const carrier = obs.teammates.find((t) => t.alive && t.hasBomb);
    if (this.site === null && carrier !== undefined) this.site = this.nearestSite(carrier.x, carrier.y);
    if (this.site === null) return null;
    if (this.spot === null) this.spot = this.pickSpot(this.site);
    return this.spot;
  }

  /**
   * @param {Observation} obs
   * @param {Command[]} out
   * @returns {{ x: number, y: number } | null}
   */
  ctGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      if (this.h.dist(me.x, me.y, b.x, b.y) < 1.2 * UNIT) {
        if (b.state === 'planted') out.push({ type: 'defuse' });
        return null;
      }
      return { x: b.x, y: b.y };
    }
    if (this.site === null) this.site = this.data.slot < (this.k.aSplit ?? 3) ? 'A' : 'B';
    if (this.spot === null) this.spot = this.pickSpot(this.site);
    return this.spot;
  }

  /**
   * 沒看到敵人時看哪裡：雷達紅點 → 敵方聲音 → 移動方向
   * @param {Observation} obs
   * @param {Command[]} out
   */
  look(obs, out) {
    const me = obs.me;
    let best = null;
    let bestD = Infinity;
    for (const r of obs.radar) {
      const d = this.h.dist(me.x, me.y, r.x, r.y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best !== null) {
      out.push({ type: 'aim', x: best.x, y: best.y });
      return;
    }
    const s = obs.sounds.find((x) => !x.friendly && x.kind !== 'explosion');
    if (s !== undefined) {
      const [x, y] = this.h.offset(me.x, me.y, s.dirDeg, 5 * UNIT);
      out.push({ type: 'aim', x, y });
      return;
    }
    if (me.vx !== 0 || me.vy !== 0) out.push({ type: 'aim', x: me.x + me.vx * 30, y: me.y + me.vy * 30 });
  }
}
