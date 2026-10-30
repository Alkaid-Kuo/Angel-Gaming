// @ts-check
// 經濟（戰術層的一部分）：指揮依全隊金錢、連敗補償、上回合結果決定全隊怎麼買，廣播「B:full／force／half／eco」；
// 每個人在規則內自己買。紀律高的完全服從；紀律低的 eco 時可能偷買手槍、half 時錢夠就自己全買。
// 手槍局（錢 ≤ 起始金錢＋100、沒有主武器）一律護甲；加時每半場一開始錢多，自然是 full。
// 連敗補償照規則自己推算（只用比分變化：半場第一回合歸零、輸一場升一階、贏一場降一階），不讀引擎內部。

/** @typedef {'full' | 'force' | 'half' | 'eco'} BuyCall */

/** 解析「B:<買法>」 @param {string} text @returns {BuyCall | null} */
export function parseBuy(text) {
  const m = /^B:(full|force|half|eco)$/.exec(text);
  return m === null ? null : /** @type {BuyCall} */ (m[1]);
}

/** 道具購買順序（依角色，索引＝roles.js 的代碼：0 無、1 突破、2 支援、3 錨點、4 狙擊、5 游擊）：突破手閃 2、支援煙 1 閃 1（＋燃燒）、錨點燃燒 1 閃 1、游擊閃 1 手雷 */
const UTIL = {
  T: [
    ['flash', 'smoke', 'he'],
    ['flash', 'flash', 'he', 'smoke'],
    ['smoke', 'flash', 'molotov', 'flash'],
    ['molotov', 'flash', 'smoke'],
    ['smoke', 'flash'],
    ['flash', 'he', 'smoke'],
  ],
  CT: [
    ['flash', 'he'],
    ['flash', 'flash', 'he'],
    ['flash', 'incendiary', 'smoke'],
    ['incendiary', 'flash', 'he'],
    ['flash', 'smoke'],
    ['flash', 'he', 'smoke'],
  ],
};

export class Economy {
  /**
   * @param {import('./base.js').InitData} data @param {import('./base.js').Helpers} h
   * @param {{ economy: number, discipline: number }} opts
   */
  constructor(data, h, opts) {
    this.data = data;
    this.h = h;
    this.opts = opts;
    /** @type {Map<string, number>} */
    this.price = new Map(data.weapons.map((w) => [w.id, w.price]));
    for (const n of data.grenades) this.price.set(n.id, n.price);
    /** 自己隊伍與對手的連敗補償階數（0 = 沒有連敗） */
    this.lossLevel = 0;
    this.enemyLevel = 0;
    /** 上回合我方贏了（null = 半場第一回合） @type {boolean | null} */
    this.lastWon = null;
    /** 本半場第幾回合（1 起） */
    this.roundInHalf = 0;
    this.half = -1;
    this.prevMine = 0;
    this.prevTheirs = 0;
    this.lastRound = -1;
  }

  /** @param {string} id */
  cost(id) {
    return this.price.get(id) ?? Infinity;
  }

  /** 回合開始：從比分變化推算連敗補償階數 @param {import('./base.js').Observation} obs */
  roundStart(obs) {
    const r = obs.round;
    if (r.number === this.lastRound) return;
    this.lastRound = r.number;
    const mine = obs.me.team === 'T' ? r.scoreT : r.scoreCT;
    const theirs = obs.me.team === 'T' ? r.scoreCT : r.scoreT;
    if (r.half !== this.half) {
      this.half = r.half;
      this.roundInHalf = 1;
      this.lossLevel = 0;
      this.enemyLevel = 0;
      this.lastWon = null;
    } else {
      this.roundInHalf++;
      const ladder = this.data.rules.economy.lossBonus.length;
      if (mine > this.prevMine) {
        this.lastWon = true;
        this.lossLevel = Math.max(0, this.lossLevel - 1);
        this.enemyLevel = Math.min(ladder, this.enemyLevel + 1);
      } else if (theirs > this.prevTheirs) {
        this.lastWon = false;
        this.lossLevel = Math.min(ladder, this.lossLevel + 1);
        this.enemyLevel = Math.max(0, this.enemyLevel - 1);
      }
    }
    this.prevMine = mine;
    this.prevTheirs = theirs;
  }

  /** 全買的價格（步槍＋甲＋拆彈器＋一顆閃） @param {import('./base.js').Team} team */
  fullCost(team) {
    const r = this.data.rules;
    return this.cost(team === 'T' ? 'ak' : 'm4') + r.armorPrice + (team === 'CT' ? r.kitPrice : 0) + this.cost('flash');
  }

  /** 這個人要全買還差多少錢（已有好槍就只算甲與道具） @param {number} money @param {import('./base.js').WeaponId | null} primary @param {import('./base.js').Team} team */
  shortOf(money, primary, team) {
    const need = this.hasGood(primary) ? this.data.rules.armorPrice + this.cost('flash') : this.fullCost(team);
    return need - money;
  }

  /** @param {import('./base.js').WeaponId | string | null} primary */
  hasGood(primary) {
    return primary !== null && this.cost(primary) >= this.cost('smg') + 1000;
  }

  /** 手槍局：錢都很少、沒有主武器 @param {import('./base.js').Observation} obs */
  pistolRound(obs) {
    return obs.me.money <= this.data.rules.economy.startMoney + 100 && obs.me.loadout.primary === null && this.roundInHalf <= 1;
  }

  /**
   * 指揮決定全隊買法：全隊有 4 人買得起全買 → full；這回合 eco 下回合就能全買 → eco；
   * 手槍局、對方賽點、半場最後一回合 → force；手槍局贏了的第二回合、或買不起全買但夠衝鋒槍 → half
   * @param {import('./base.js').Observation} obs @returns {BuyCall}
   */
  teamCall(obs) {
    const me = obs.me;
    const team = me.team;
    if (this.pistolRound(obs)) return 'force';
    // 隊友的主武器看不到（只看得到手上的武器）：手上拿步槍或狙擊槍的算有好槍
    const people = [{ money: me.money, primary: me.loadout.primary }, ...obs.teammates.map((m) => ({ money: m.money, primary: this.hasGood(m.weapon) ? m.weapon : null }))];
    const can = people.filter((p) => this.shortOf(p.money, p.primary, team) <= 0).length;
    const n = people.length;
    if (can >= n - 1 || (this.lastWon === true && this.enemyLevel >= 2 && can >= n - 2)) return 'full';
    const ladder = this.data.rules.economy.lossBonus;
    const nextPay = ladder[Math.min(ladder.length, this.lossLevel + 1) - 1];
    const canNext = people.filter((p) => this.shortOf(p.money + nextPay, p.primary, team) <= 0).length;
    const r = obs.round;
    const theirs = team === 'T' ? r.scoreCT : r.scoreT;
    const lastOfHalf = this.roundInHalf >= (r.overtime > 0 ? (this.data.rules.overtime === false ? 3 : this.data.rules.overtime.roundsPerHalf) : this.data.rules.roundsPerHalf);
    const critical = theirs >= this.data.rules.winRounds - 1 || lastOfHalf;
    const avg = people.reduce((s, p) => s + p.money, 0) / n;
    const half = this.cost('smg') + this.data.rules.armorPrice;
    if (critical && avg >= half * 0.8) return 'force';
    if (this.roundInHalf === 2 && this.lastWon === true && avg >= half) return 'half';
    if (canNext >= n - 1) return 'eco';
    if (this.opts.economy === 2 && avg >= half) return 'force';
    if (this.opts.economy !== 1 && avg >= half + 600) return 'half';
    return 'eco';
  }

  /**
   * 照買法買（在規則內）：狙擊手（awper）錢夠買狙擊槍；道具依角色；突破手護甲優先、錨點拆彈器優先；CT 全買帶拆彈器；備彈不到一半補
   * @param {import('./base.js').Observation} obs @param {BuyCall} call @param {number} role @param {boolean} awper @returns {import('./base.js').BuyItem[]}
   */
  items(obs, call, role, awper) {
    const me = obs.me;
    const rules = this.data.rules;
    const team = me.team;
    let money = me.money;
    const primary = me.loadout.primary;
    const rifle = team === 'T' ? 'ak' : 'm4';
    /** @type {import('./base.js').BuyItem[]} */
    const items = [];
    /** @param {import('./base.js').BuyItem} id @param {number} price */
    const take = (id, price) => {
      if (price > money) return false;
      items.push(id);
      money -= price;
      return true;
    };
    const armor = () => me.loadout.armor < rules.maxArmor && !items.includes('armor') && take('armor', rules.armorPrice);
    const kit = () => team === 'CT' && !me.loadout.kit && !items.includes('kit') && take('kit', rules.kitPrice);
    const util = (/** @type {number} */ max) => {
      const owned = [...me.loadout.grenades];
      let n = 0;
      for (const g of UTIL[team][role] ?? UTIL[team][0]) {
        if (n >= max || owned.length >= rules.grenadeSlots) break;
        const def = this.data.grenades.find((x) => x.id === g);
        if (def === undefined || owned.filter((x) => x === g).length >= def.maxCarry) continue;
        if (take(/** @type {import('./base.js').BuyItem} */ (g), def.price)) {
          owned.push(/** @type {import('./base.js').GrenadeId} */ (g));
          n++;
        }
      }
    };
    // 紀律低：eco 偷買手槍、half 錢夠就自己全買
    const rebel = this.opts.discipline < 0.5 && this.h.random() < 1 - 2 * this.opts.discipline;
    let mode = call;
    if (rebel && call === 'half' && this.shortOf(money, primary, team) <= 0) mode = 'full';
    const good = this.hasGood(primary);
    if (this.pistolRound(obs)) {
      armor();
    } else if (mode === 'full' || (good && mode !== 'eco')) {
      if (awper && primary !== 'awp' && money >= this.cost('awp') + rules.armorPrice + 200) take('awp', this.cost('awp'));
      else if (!good && !take(rifle, this.cost(rifle))) take('smg', this.cost('smg'));
      armor();
      kit();
      util(4);
    } else if (mode === 'force') {
      if (role === 1) armor();
      if (!good && money >= this.cost(rifle) + rules.armorPrice) take(rifle, this.cost(rifle));
      else if (!good && money >= this.cost('smg') + rules.armorPrice) take('smg', this.cost('smg'));
      armor();
      if (!good && primary === null && items.length === 1 && money >= this.cost('deagle')) take('deagle', this.cost('deagle'));
      kit();
      util(1);
    } else if (mode === 'half') {
      if (role === 1) armor();
      if (!good && primary === null) take('smg', this.cost('smg'));
      armor();
      if (role === 3) kit();
      util(1);
    } else if (rebel && money >= this.cost('deagle') + 1000 && me.loadout.secondary !== 'deagle') {
      // eco：紀律低的人偷買手槍升級
      take('deagle', this.cost('deagle'));
    }
    const w = this.data.weapons.find((x) => x.id === (primary ?? me.weapon));
    if (w !== undefined && w.reserve > 0 && me.ammoReserve < w.reserve / 2 && me.weapon === w.id && mode !== 'eco') take('ammo', rules.ammoPrice);
    return items;
  }
}
