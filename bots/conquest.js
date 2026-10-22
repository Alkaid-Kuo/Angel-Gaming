// @ts-check
// 搶點基準 Bot（搶點模式原型）：兵營持續出兵，部隊分成幾隊去搶最有價值的控制點；
// 自己的點被攻擊時派最近的一隊回防，主基地被攻擊時全軍回防；所有點都到手後去拆對手主堡。

/** @typedef {import('../src/api/types.ts').Bot} Bot */
/** @typedef {import('../src/api/types.ts').BotDeclaration} BotDeclaration */
/** @typedef {import('../src/api/types.ts').BuildingType} BuildingType */
/** @typedef {import('../src/api/types.ts').Command} Command */
/** @typedef {import('../src/api/types.ts').Helpers} Helpers */
/** @typedef {import('../src/api/types.ts').InitData} InitData */
/** @typedef {import('../src/api/types.ts').InitControlPoint} InitControlPoint */
/** @typedef {import('../src/api/types.ts').MyUnitView} MyUnitView */
/** @typedef {import('../src/api/types.ts').Observation} Observation */

const TILE = 1000;
/** 同一隊重新下令的最短間隔（tick），避免浪費指令額度 */
const REISSUE_TICKS = 40;
/** 敵人離自己的控制點多近算「被攻擊」 */
const THREAT_RADIUS = 7 * TILE;
/** 敵人離主堡多近要全軍回防 */
const BASE_THREAT_RADIUS = 12 * TILE;

/** @implements {Bot} */
export default class ConquestBot {
  constructor() {
    /** @type {InitData | null} */
    this.data = null;
    /** @type {Helpers | null} */
    this.helpers = null;
    this.baseX = 0;
    this.baseY = 0;
    this.baseTileX = 0;
    this.baseTileY = 0;
    /** @type {InitControlPoint[]} */
    this.points = [];
    /** 各隊目前目標（控制點 id，-1 為主堡防守，-2 為進攻主堡）與下令時間 */
    /** @type {number[]} */
    this.groupTarget = [];
    /** @type {number[]} */
    this.groupOrderTick = [];
  }

  /** @returns {BotDeclaration} */
  declare() {
    return {
      name: 'ConquestBase',
      version: 'v1',
      style: '搶點基準：分隊搶控制點、守點、持續出兵',
      knobs: [
        { key: 'groups', name: '分隊數', description: '部隊分成幾隊同時搶點', min: 1, max: 3, default: 2, integer: true },
        { key: 'aggression', name: '進攻傾向', description: '越高越優先搶對手手上的點（而不是中立點）', min: 0, max: 100, default: 50, integer: true },
        { key: 'archerRatio', name: '弓兵比例', description: '兵營產出中弓兵的百分比，其餘為長槍兵', min: 0, max: 60, default: 30, integer: true },
        { key: 'barracksMax', name: '兵營上限', description: '最多蓋幾座兵營', min: 1, max: 4, default: 3, integer: true },
        { key: 'towersPerPoint', name: '每點防禦塔', description: '在自己的控制點旁蓋幾座防禦塔', min: 0, max: 2, default: 0, integer: true },
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
    const slot = data.startSlots.find((s) => s.playerId === data.me);
    if (slot === undefined || data.conquest === null) throw new Error('搶點基準 Bot 只能用在搶點模式');
    this.baseTileX = slot.tileX;
    this.baseTileY = slot.tileY;
    this.baseX = slot.tileX * TILE + 1500;
    this.baseY = slot.tileY * TILE + 1500;
    this.points = data.conquest.points.slice();
  }

  /**
   * @param {Observation} obs
   * @returns {Command[]}
   */
  decide(obs) {
    /** @type {Command[]} */
    const cmds = [];
    const budget = obs.commandBudget;
    const push = (/** @type {Command} */ c) => {
      if (cmds.length >= budget) return false;
      cmds.push(c);
      return true;
    };
    this.army(obs, push);
    this.produce(obs, push);
    this.build(obs, push);
    return cmds;
  }

  // ───────── 部隊 ─────────

  /**
   * @param {Observation} obs
   * @param {(c: Command) => boolean} push
   */
  army(obs, push) {
    const data = /** @type {InitData} */ (this.data);
    const k = obs.knobs;
    const combat = obs.myUnits.filter((u) => u.type !== 'worker').sort((a, b) => a.id - b.id);
    if (combat.length === 0) return;
    const nGroups = Math.max(1, Math.min(k.groups, combat.length));
    /** @type {MyUnitView[][]} */
    const groups = Array.from({ length: nGroups }, () => []);
    combat.forEach((u, i) => groups[i % nGroups].push(u));
    const cps = obs.controlPoints ?? [];
    const owner = new Map(cps.map((c) => [c.id, c.owner]));
    // 主基地被攻擊：全軍回防
    const baseThreat = obs.enemyUnits.filter((e) => dist2(e.x, e.y, this.baseX, this.baseY) < BASE_THREAT_RADIUS ** 2);
    /** @type {Set<number>} */
    const taken = new Set();
    groups.forEach((g, gi) => {
      if (g.length === 0) return;
      const cx = g.reduce((a, u) => a + u.x, 0) / g.length;
      const cy = g.reduce((a, u) => a + u.y, 0) / g.length;
      let target = -1;
      let tx = this.baseX;
      let ty = this.baseY;
      if (baseThreat.length > 0) {
        target = -1;
        tx = baseThreat[0].x;
        ty = baseThreat[0].y;
      } else {
        // 自己的點被攻擊 → 回防；否則挑分數最高的點
        let best = -Infinity;
        for (const p of this.points) {
          if (taken.has(p.id)) continue;
          const o = owner.get(p.id) ?? null;
          const threatened = o === data.me && obs.enemyUnits.some((e) => dist2(e.x, e.y, p.x, p.y) < THREAT_RADIUS ** 2);
          if (o === data.me && !threatened) continue;
          const value = p.vp * 10 + p.income;
          const base = threatened ? 120 : o === null ? 60 : 30 + k.aggression;
          const score = base + value * 4 - Math.sqrt(dist2(cx, cy, p.x, p.y)) / TILE;
          if (score > best) {
            best = score;
            target = p.id;
            tx = p.x;
            ty = p.y;
          }
        }
        if (target < 0) {
          // 所有點都在手上：去拆最近的對手主堡
          const enemy = data.startSlots.filter((s) => s.playerId !== data.me && obs.alivePlayers.includes(s.playerId)).map((s) => ({ x: s.tileX * TILE + 1500, y: s.tileY * TILE + 1500 }));
          enemy.sort((a, b) => dist2(cx, cy, a.x, a.y) - dist2(cx, cy, b.x, b.y));
          if (enemy.length > 0) {
            target = -2;
            tx = enemy[0].x;
            ty = enemy[0].y;
          }
        }
      }
      if (target >= 0) taken.add(target);
      const changed = this.groupTarget[gi] !== target;
      const stale = obs.tick - (this.groupOrderTick[gi] ?? -1e9) >= REISSUE_TICKS;
      if (!changed && !stale) return;
      // 只對還沒到目標附近的單位下令（到了就留在原地守點）
      const units = g.filter((u) => dist2(u.x, u.y, tx, ty) > (2 * TILE) ** 2).map((u) => u.id);
      if (units.length === 0 && !changed) return;
      if (push({ type: 'attackMove', units: units.length > 0 ? units : g.map((u) => u.id), x: Math.round(tx), y: Math.round(ty) })) {
        this.groupTarget[gi] = target;
        this.groupOrderTick[gi] = obs.tick;
      }
    });
  }

  // ───────── 生產 ─────────

  /**
   * @param {Observation} obs
   * @param {(c: Command) => boolean} push
   */
  produce(obs, push) {
    const data = /** @type {InitData} */ (this.data);
    let minerals = obs.minerals;
    const free = obs.supplyCap - obs.supplyUsed;
    let used = 0;
    for (const b of obs.myBuildings) {
      if (!b.complete || b.queue.length >= 2) continue;
      if (b.type === 'barracks') {
        const archers = obs.myUnits.filter((u) => u.type === 'archer').length;
        const total = obs.myUnits.filter((u) => u.type === 'archer' || u.type === 'spear').length + 1;
        const unit = (archers * 100) / total < obs.knobs.archerRatio ? 'archer' : 'spear';
        const st = data.stats.units[unit];
        if (minerals < st.cost || free - used < st.supply) continue;
        if (push({ type: 'train', buildingId: b.id, unit })) {
          minerals -= st.cost;
          used += st.supply;
        }
      } else if (b.type === 'base') {
        const workers = obs.myUnits.filter((u) => u.type === 'worker').length;
        if (workers < 3 && minerals >= data.stats.units.worker.cost && free - used >= 1 && push({ type: 'train', buildingId: b.id, unit: 'worker' })) {
          minerals -= data.stats.units.worker.cost;
          used += 1;
        }
      }
    }
  }

  // ───────── 建造 ─────────

  /**
   * @param {Observation} obs
   * @param {(c: Command) => boolean} push
   */
  build(obs, push) {
    const data = /** @type {InitData} */ (this.data);
    const k = obs.knobs;
    const workers = obs.myUnits.filter((u) => u.type === 'worker');
    const busy = new Set(workers.filter((w) => w.order.type === 'build' || w.order.type === 'construct').map((w) => w.id));
    const idle = workers.filter((w) => !busy.has(w.id));
    if (idle.length === 0) return;
    const count = (/** @type {BuildingType} */ t) => obs.myBuildings.filter((b) => b.type === t).length;
    const pending = (/** @type {BuildingType} */ t) => workers.some((w) => w.order.type === 'build' && w.order.building === t);
    const cost = (/** @type {BuildingType} */ t) => data.stats.buildings[t].cost;
    let minerals = obs.minerals;
    const order = (/** @type {BuildingType} */ t, /** @type {{x: number, y: number} | null} */ spot) => {
      const w = idle.shift();
      if (w === undefined || spot === null) return;
      if (push({ type: 'build', workerId: w.id, building: t, tileX: spot.x, tileY: spot.y })) minerals -= cost(t);
    };
    const barracks = count('barracks');
    if (barracks === 0 && !pending('barracks') && minerals >= cost('barracks')) order('barracks', this.spotNear(obs, 'barracks', this.baseTileX + 1, this.baseTileY + 1, 3, 9));
    const supplyBuffer = 3 + 2 * Math.max(1, barracks);
    if (obs.supplyCap < 50 && obs.supplyCap - obs.supplyUsed <= supplyBuffer && !pending('supply') && minerals >= cost('supply')) order('supply', this.spotNear(obs, 'supply', this.baseTileX + 1, this.baseTileY + 1, 3, 9));
    if (barracks > 0 && barracks < k.barracksMax && !pending('barracks') && minerals >= cost('barracks') + 60) order('barracks', this.spotNear(obs, 'barracks', this.baseTileX + 1, this.baseTileY + 1, 3, 10));
    if (k.towersPerPoint > 0 && minerals >= cost('tower') + 100 && !pending('tower')) {
      for (const cp of obs.controlPoints ?? []) {
        if (cp.owner !== data.me) continue;
        const p = this.points.find((x) => x.id === cp.id);
        if (p === undefined) continue;
        const near = obs.myBuildings.filter((b) => b.type === 'tower' && dist2((b.tileX + 0.5) * TILE, (b.tileY + 0.5) * TILE, p.x, p.y) < (5 * TILE) ** 2).length;
        if (near >= k.towersPerPoint) continue;
        order('tower', this.spotNear(obs, 'tower', Math.floor(p.x / TILE), Math.floor(p.y / TILE), 2, 4));
        break;
      }
    }
  }

  /**
   * 以 (cx, cy) 為中心往外找可放置的位置
   * @param {Observation} obs
   * @param {BuildingType} type
   * @param {number} cx
   * @param {number} cy
   * @param {number} rMin
   * @param {number} rMax
   * @returns {{ x: number, y: number } | null}
   */
  spotNear(obs, type, cx, cy, rMin, rMax) {
    const data = /** @type {InitData} */ (this.data);
    const helpers = /** @type {Helpers} */ (this.helpers);
    const size = data.stats.buildings[type].size;
    for (let r = rMin; r <= rMax; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!helpers.canPlace(type, x, y)) continue;
          if (this.crowded(obs, x, y, size)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  /**
   * 與己方建築至少隔 1 格，避免堵住通道
   * @param {Observation} obs
   * @param {number} x
   * @param {number} y
   * @param {number} size
   */
  crowded(obs, x, y, size) {
    const data = /** @type {InitData} */ (this.data);
    for (const b of obs.myBuildings) {
      const s = data.stats.buildings[b.type].size;
      if (x - 1 < b.tileX + s && x + size + 1 > b.tileX && y - 1 < b.tileY + s && y + size + 1 > b.tileY) return true;
    }
    return false;
  }
}

/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 */
function dist2(ax, ay, bx, by) {
  return (ax - bx) ** 2 + (ay - by) ** 2;
}
