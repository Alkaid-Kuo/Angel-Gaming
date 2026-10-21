// @ts-check
// 隨機 Bot：每次決策隨機挑指令類型與格式合法的參數，作為「完全無腦」的對照組。

/** @typedef {import('../src/api/types.ts').Bot} Bot */
/** @typedef {import('../src/api/types.ts').BotDeclaration} BotDeclaration */
/** @typedef {import('../src/api/types.ts').Command} Command */
/** @typedef {import('../src/api/types.ts').Helpers} Helpers */
/** @typedef {import('../src/api/types.ts').InitData} InitData */
/** @typedef {import('../src/api/types.ts').Observation} Observation */
/** @typedef {import('../src/api/types.ts').UnitType} UnitType */
/** @typedef {import('../src/api/types.ts').BuildingType} BuildingType */
/** @typedef {import('../src/api/types.ts').Stance} Stance */

const UNIT_TYPES = /** @type {UnitType[]} */ (['worker', 'spear', 'archer', 'cavalry']);
const BUILDING_TYPES = /** @type {BuildingType[]} */ (['base', 'depot', 'supply', 'barracks', 'tower']);
const STANCES = /** @type {Stance[]} */ (['aggressive', 'defensive', 'hold', 'retreat']);

/** @implements {Bot} */
export default class RandomBot {
  constructor() {
    /** @type {InitData | null} */
    this.data = null;
    /** @type {Helpers | null} */
    this.helpers = null;
  }

  /** @returns {BotDeclaration} */
  declare() {
    return {
      name: 'Random',
      version: 'v1',
      style: '隨機亂下指令的對照組',
      knobs: [
        { key: 'activity', name: '活躍度', description: '每次決策使用額度的比例（%）', min: 0, max: 100, default: 80, integer: true },
        { key: 'economy', name: '經濟傾向', description: '選擇採集／生產／建造類指令的權重', min: 0, max: 100, default: 50, integer: true },
        { key: 'aggression', name: '攻擊傾向', description: '選擇移動／攻擊類指令的權重', min: 0, max: 100, default: 50, integer: true },
      ],
    };
  }

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  init(data, helpers) {
    this.data = data;
    this.helpers = helpers;
  }

  /** @param {number} n */
  pick(n) {
    return Math.floor(/** @type {Helpers} */ (this.helpers).random() * n);
  }

  /**
   * @template T
   * @param {readonly T[]} arr
   * @returns {T | undefined}
   */
  choose(arr) {
    return arr.length === 0 ? undefined : arr[this.pick(arr.length)];
  }

  /**
   * @param {Observation} obs
   * @returns {Command[]}
   */
  decide(obs) {
    const data = /** @type {InitData} */ (this.data);
    /** @type {Command[]} */
    const cmds = [];
    const activity = obs.knobs.activity;
    const eco = obs.knobs.economy;
    const agg = obs.knobs.aggression;
    for (let i = 0; i < obs.commandBudget; i++) {
      if (this.pick(100) >= activity) continue;
      const roll = this.pick(eco + agg + 1);
      const unit = this.choose(obs.myUnits);
      const building = this.choose(obs.myBuildings);
      const x = this.pick(data.width * 1000);
      const y = this.pick(data.height * 1000);
      if (roll < eco) {
        const kind = this.pick(4);
        if (kind === 0 && unit !== undefined) {
          const node = this.choose(data.mineNodes);
          if (node !== undefined) cmds.push({ type: 'gather', units: [unit.id], nodeId: node.id });
        } else if (kind === 1 && building !== undefined) {
          const ut = this.choose(UNIT_TYPES);
          if (ut !== undefined) cmds.push({ type: 'train', buildingId: building.id, unit: ut });
        } else if (kind === 2 && unit !== undefined) {
          const bt = this.choose(BUILDING_TYPES);
          if (bt !== undefined) cmds.push({ type: 'build', workerId: unit.id, building: bt, tileX: Math.floor(unit.x / 1000) + this.pick(9) - 4, tileY: Math.floor(unit.y / 1000) + this.pick(9) - 4 });
        } else if (building !== undefined) {
          cmds.push({ type: 'rally', buildingId: building.id, x, y });
        }
      } else if (unit !== undefined) {
        const kind = this.pick(5);
        if (kind === 0) cmds.push({ type: 'move', units: [unit.id], x, y });
        else if (kind === 1) cmds.push({ type: 'attackMove', units: [unit.id], x, y });
        else if (kind === 2) {
          const target = this.choose(obs.enemyUnits) ?? this.choose(obs.enemyBuildings);
          if (target !== undefined) cmds.push({ type: 'attack', units: [unit.id], targetId: target.id });
        } else if (kind === 3) {
          const st = this.choose(STANCES);
          if (st !== undefined) cmds.push({ type: 'stance', units: [unit.id], stance: st });
        } else {
          cmds.push({ type: 'hold', units: [unit.id] });
        }
      }
    }
    return cmds;
  }
}
