// @ts-check
// 選手範例模板：可直接執行（只會採礦與生產工人），請以此為起點撰寫自己的選手。
//
// 規則：
//   - 單一檔案（ES2020），不可 import 任何模組，≤ 200 KB。
//   - default export 一個 class，提供 declare()、init(data, helpers)、decide(obs) 三個方法。
//   - 每場比賽會建立一個新實例；實例欄位就是你的記憶。
//   - 亂數只能用 helpers.random()；Math.random、Date、performance 會直接拋例外。
//   - decide 每 5 tick 呼叫一次，軟上限 5 ms（超過該次指令作廢），硬上限 50 ms（超過整場閒置）。
//   - ES2020 不支援類別欄位語法（例如 `x = 1;` 寫在 class 內），請在 constructor 裡初始化。
//
// 指令格式、觀察資料欄位請見 spec.md 的「選手 API」章節。

export default class TemplateBot {
  constructor() {
    /** @type {any} 開局資料 */
    this.data = null;
    /** @type {any} 輔助工具：pathDistance、canPlace、terrainAt、random */
    this.helpers = null;
    /** 主礦區的礦點 id */
    this.mainNodes = /** @type {number[]} */ ([]);
  }

  declare() {
    return {
      name: 'Template', // 流派名稱
      version: 'v1', // 版本（每次存快照時遞增）
      style: '範例模板：只會採礦與生產工人', // 給玩家看的風格描述
      // 3～6 顆旋鈕；範圍內的任何值都必須能正常運作；同流派所有版本的代碼與範圍保持一致
      knobs: [
        { key: 'workerCap', name: '工人上限', description: '主堡生產工人的上限', min: 8, max: 24, default: 16, integer: true },
        { key: 'knobB', name: '旋鈕 B', description: '請改成你自己的旋鈕', min: 0, max: 100, default: 50, integer: true },
        { key: 'knobC', name: '旋鈕 C', description: '請改成你自己的旋鈕', min: 0, max: 1, default: 0.5, integer: false },
      ],
    };
  }

  /**
   * 開局 tick 0 前呼叫一次（上限 1000 ms）
   * @param {any} data 開局資料：width、height、tiles、mineNodes、mineAreas、startSlots、watchtowers、me、players、stats、matchSeed、knobs
   * @param {any} helpers
   */
  init(data, helpers) {
    this.data = data;
    this.helpers = helpers;
    const main = data.mineAreas.find((/** @type {any} */ a) => a.kind === 'main' && a.owner === data.me);
    this.mainNodes = data.mineNodes.filter((/** @type {any} */ n) => n.areaId === main.areaId).map((/** @type {any} */ n) => n.id);
  }

  /**
   * 每 5 tick 呼叫一次，回傳指令陣列（每個指令消耗 1 點額度，額度見 obs.commandBudget）
   * @param {any} obs 觀察資料
   * @returns {any[]}
   */
  decide(obs) {
    /** @type {any[]} */
    const cmds = [];
    const workers = obs.myUnits.filter((/** @type {any} */ u) => u.type === 'worker');
    const base = obs.myBuildings.find((/** @type {any} */ b) => b.type === 'base' && b.complete);

    // 閒置工人輪流分配到主礦區的礦點
    const idle = workers.filter((/** @type {any} */ u) => u.order.type === 'idle');
    idle.forEach((/** @type {any} */ u, /** @type {number} */ i) => {
      if (cmds.length < obs.commandBudget) cmds.push({ type: 'gather', units: [u.id], nodeId: this.mainNodes[i % this.mainNodes.length] });
    });

    // 生產工人
    if (base !== undefined && base.queue.length === 0 && workers.length < obs.knobs.workerCap && obs.minerals >= 50 && obs.supplyUsed < obs.supplyCap) {
      if (cmds.length < obs.commandBudget) cmds.push({ type: 'train', buildingId: base.id, unit: 'worker' });
    }

    // TODO：補給站、兵營、戰鬥單位、進攻與防守……
    return cmds;
  }
}
