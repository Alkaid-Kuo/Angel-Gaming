// @ts-check
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 軍團戰選手範本：示範 declare／init／deploy／decide 的介面，可直接執行、通過沙盒檢查。
// 不含任何戰術：布陣一組固定的合法兵力，開戰後全軍往對方出生點前進；佔點模式場上有空位就召喚後備。
//
// 規則摘要（完整規則見 spec.md）：
//   - 單一檔案、ES2020 模組、不可 import、≤ 200 KB；default export 一個 class。
//   - 不能用 class 欄位語法（在 class 本體寫 `x = 1;`）、`??=`、數字分隔符號；請在 constructor 裡初始化。
//   - 每場比賽建立新實例；實例欄位就是記憶。
//   - 亂數只能用 helpers.random()；Math.random、Date、performance 會拋出例外。
//   - init、deploy 上限各 1000 ms；decide 每 5 tick 呼叫一次，上限 50 ms（超過就整場不再呼叫）。
//   - 每次 decide 最多 10 個指令（plan 不算）。

/** @typedef {import('../src/legion/api.ts').LegionInitData} InitData */
/** @typedef {import('../src/legion/api.ts').LegionHelpers} Helpers */
/** @typedef {import('../src/legion/api.ts').LegionObservation} Observation */
/** @typedef {import('../src/legion/api.ts').LegionDeclaration} Declaration */
/** @typedef {import('../src/legion/api.ts').Deployment} Deployment */
/** @typedef {import('../src/legion/api.ts').UnitKind} UnitKind */

/** 場上兵力（依序布陣；殲滅戰 500 點以內） @type {UnitKind[]} */
const FIELD = ['spear', 'spear', 'sword', 'sword', 'shield', 'archer', 'archer', 'lightCav', 'light'];
/** 佔點模式的後備（總點數 1500 以內） @type {UnitKind[]} */
const RESERVE = ['spear', 'spear', 'sword', 'sword', 'shield', 'archer', 'archer', 'lightCav', 'heavyCav', 'light'];

export default class TemplateBot {
  constructor() {
    /** @type {InitData | null} */
    this.data = null;
    /** @type {Helpers | null} */
    this.helpers = null;
    /** 兵種 → 點數 @type {Record<string, number>} */
    this.cost = {};
    this.planSent = false;
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: 'Template',
      version: 'v1',
      style: '範本：全軍往前走',
      // 3～6 顆旋鈕；範圍內的任何值都必須能正常運作
      knobs: [
        { key: 'spacing', name: '布陣間距', description: '各團在布陣時的南北間距（格）', min: 8, max: 14, default: 11, integer: true },
        { key: 'knobB', name: '旋鈕 B', description: '請改成你自己的旋鈕', min: 0, max: 100, default: 50, integer: true },
        { key: 'knobC', name: '旋鈕 C', description: '請改成你自己的旋鈕', min: 0, max: 1, default: 0.5, integer: false },
      ],
    };
  }

  /**
   * 開戰前呼叫一次（選填，上限 1000 ms）
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  init(data, helpers) {
    this.data = data;
    this.helpers = helpers;
    for (const u of data.units) this.cost[u.kind] = u.cost;
  }

  /**
   * 布陣：回傳每一團的兵種、位置、朝向（上限 1000 ms）
   * @param {InitData} data
   * @param {Helpers} helpers
   * @returns {Deployment[]}
   */
  deploy(data, helpers) {
    const T = data.tileSize;
    const zone = data.map.deploy[data.playerId];
    const west = data.playerId === 0;
    const facing = west ? 0 : 180;
    // 布陣區內兩列：前列（靠近敵方）步兵、後列其他兵種
    const frontX = (west ? zone.x1 - 4 : zone.x0 + 4) * T;
    const backX = (west ? zone.x1 - 12 : zone.x0 + 12) * T;
    const spacing = data.knobs.spacing * T;
    const midY = (data.map.height * T) / 2;
    /** @type {Deployment[]} */
    const out = [];
    let spent = 0;
    const front = FIELD.filter((k) => k === 'spear' || k === 'sword' || k === 'shield');
    const back = FIELD.filter((k) => !front.includes(k));
    const place = (/** @type {UnitKind[]} */ kinds, /** @type {number} */ x) => {
      kinds.forEach((kind, i) => {
        // 從中線往兩側交錯排開
        const offset = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * spacing;
        let y = midY + (west ? offset : -offset);
        // 不可通行就往南找一格可以站的位置
        for (let k = 0; k < 10 && !walkable(helpers.terrainAt(x, y)); k++) y += T;
        if (spent + this.cost[kind] > data.budget) return;
        spent += this.cost[kind];
        out.push({ type: kind, x, y, facing });
      });
    };
    place(front, frontX);
    place(back, backX);
    if (data.mode === 'capture') {
      for (const kind of RESERVE) {
        if (spent + this.cost[kind] > data.budget) continue;
        spent += this.cost[kind];
        // 後備不需要座標（引擎會忽略；型別要求才填 0）
        out.push({ type: kind, reserve: true, x: 0, y: 0 });
      }
    }
    return out;
  }

  /**
   * 每 5 tick 呼叫一次，回傳指令陣列（上限 50 ms）
   * @param {Observation} obs
   */
  decide(obs) {
    const data = /** @type {InitData} */ (this.data);
    /** @type {any[]} */
    const cmds = [];
    if (!this.planSent) {
      cmds.push({ type: 'plan', text: '範本：全軍前進' });
      this.planSent = true;
    }
    let quota = data.commandsPerDecision;
    // 被拒絕的布陣與指令會出現在事件裡（除錯用）
    for (const e of obs.events) {
      if (e.type === 'deployRejected' || e.type === 'rejected') {
        // 例如：記錄下來、調整下一次的行為
      }
    }
    // 佔點模式：場上點數還有空位就召喚後備
    let fieldCost = obs.fieldCost;
    for (const r of obs.regiments) {
      if (quota <= 0) break;
      if (!r.reserve || r.enterIn >= 0) continue;
      const c = this.cost[r.kind];
      if (fieldCost + c > obs.fieldCap) continue;
      cmds.push({ type: 'summon', id: r.id, intent: '入場' });
      fieldCost += c;
      quota -= 1;
    }
    // 場上閒著的團：往對方出生點前進（邊走邊打）
    const goal = data.map.spawns[1 - obs.me];
    for (const r of obs.regiments) {
      if (quota <= 0) break;
      if (r.reserve || r.order !== 'idle') continue;
      const far = (r.x - goal.x) * (r.x - goal.x) + (r.y - goal.y) * (r.y - goal.y) > 3000 * 3000;
      if (!far) continue;
      cmds.push({ type: 'attackMove', id: r.id, x: goal.x, y: goal.y, intent: '前進' });
      quota -= 1;
    }
    return cmds;
  }
}

/** 可通行：不是河流（5）、建築（7）、城牆（8） @param {number} t */
function walkable(t) {
  return t !== 5 && t !== 7 && t !== 8;
}
