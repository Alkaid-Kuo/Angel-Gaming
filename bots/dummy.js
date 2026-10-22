// @ts-check
// 教學木樁：只讓工人採礦，不生產戰鬥單位、不蓋建築、不反擊。給教學模式當練習目標。

/** @typedef {import('../src/api/types.ts').Bot} Bot */
/** @typedef {import('../src/api/types.ts').BotDeclaration} BotDeclaration */
/** @typedef {import('../src/api/types.ts').Command} Command */
/** @typedef {import('../src/api/types.ts').InitData} InitData */
/** @typedef {import('../src/api/types.ts').Observation} Observation */

/** @implements {Bot} */
export default class DummyBot {
  constructor() {
    /** @type {InitData | null} */
    this.data = null;
    this.trained = 0;
  }

  /** @returns {BotDeclaration} */
  declare() {
    return {
      name: 'Dummy',
      version: 'v1',
      style: '教學木樁：只採礦，不出兵',
      knobs: [
        { key: 'gatherers', name: '採礦工人', description: '派去採礦的工人數', min: 0, max: 4, default: 4, integer: true },
        { key: 'extraWorkers', name: '額外工人', description: '開局後再生產的工人數', min: 0, max: 6, default: 0, integer: true },
        { key: 'startTick', name: '開工時間', description: '從第幾 tick 開始派工人採礦', min: 0, max: 600, default: 0, integer: true },
      ],
    };
  }

  /** @param {InitData} data */
  init(data) {
    this.data = data;
  }

  /**
   * @param {Observation} obs
   * @returns {Command[]}
   */
  decide(obs) {
    const data = /** @type {InitData} */ (this.data);
    if (obs.tick < obs.knobs.startTick) return [];
    /** @type {Command[]} */
    const cmds = [];
    const myArea = data.mineAreas.find((a) => a.kind === 'main' && a.owner === data.me);
    const nodes = data.mineNodes.filter((n) => myArea !== undefined && n.areaId === myArea.areaId);
    const idle = obs.myUnits.filter((u) => u.type === 'worker' && u.order.type === 'idle');
    const busy = obs.myUnits.filter((u) => u.type === 'worker' && u.order.type === 'gather').length;
    let slots = obs.knobs.gatherers + this.trained - busy;
    for (const u of idle) {
      if (slots <= 0 || nodes.length === 0) break;
      cmds.push({ type: 'gather', units: [u.id], nodeId: nodes[u.id % nodes.length].id });
      slots -= 1;
    }
    const base = obs.myBuildings.find((b) => b.type === 'base' && b.complete);
    if (base !== undefined && this.trained < obs.knobs.extraWorkers && base.queue.length === 0 && obs.minerals >= data.stats.units.worker.cost) {
      cmds.push({ type: 'train', buildingId: base.id, unit: 'worker' });
      this.trained += 1;
    }
    return cmds;
  }
}
