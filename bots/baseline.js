// @ts-check
// 基準 Bot：會正常運營但沒有戰術——不偵察、不擴張、不蓋塔，只做固定節奏的經濟與一波波進攻。
// 行為依「開發任務書 M0～M2／基準 Bot」：
//   1. 主堡持續生產工人至「工人上限」；新工人平均分配到主礦區礦點（每礦點先放滿 2 人，之後平均加到 3、4 人）
//   2. 人口餘額 ≤ 4 且沒有補給站在建時，派一名工人在主堡附近蓋補給站
//   3. 工人數達 8 且礦 ≥ 150 時蓋 1 座兵營；之後不再增加
//   4. 兵營依「弓兵比例」輪流生產長槍兵、弓兵、騎兵（其餘依 長槍 2：騎 1）
//   5. 戰鬥單位人口達「進攻門檻」時，全軍攻擊移動到最近的敵方起點；之後新單位的集結點設為該處
//   6. 主基地範圍內的建築或工人受攻擊時，所有未出征的戰鬥單位攻擊移動到受攻擊處
//   7. 4 人局：進攻目標為路徑距離最近且仍存活的敵方起點

/** @typedef {import('../src/api/types.ts').Bot} Bot */
/** @typedef {import('../src/api/types.ts').BotDeclaration} BotDeclaration */
/** @typedef {import('../src/api/types.ts').Command} Command */
/** @typedef {import('../src/api/types.ts').Helpers} Helpers */
/** @typedef {import('../src/api/types.ts').InitData} InitData */
/** @typedef {import('../src/api/types.ts').Observation} Observation */
/** @typedef {import('../src/api/types.ts').MyUnitView} MyUnitView */
/** @typedef {import('../src/api/types.ts').BuildingType} BuildingType */
/** @typedef {'spear' | 'archer' | 'cavalry'} CombatType */

const TILE = 1000;
/** 進攻部隊的編隊代號 */
const ARMY_GROUP = 1;
/** 主基地範圍（格）：此範圍內受攻擊才回防 */
const HOME_RADIUS_TILES = 15;
/** 出征後每隔多少次決策把新單位併入部隊並重新下達攻擊移動 */
const REGROUP_INTERVAL = 20;
/** 回防指令的最小間隔（tick） */
const DEFENSE_COOLDOWN = 50;
const COMBAT_TYPES = /** @type {CombatType[]} */ (['spear', 'archer', 'cavalry']);

/** @implements {Bot} */
export default class BaselineBot {
  constructor() {
    /** @type {InitData | null} */
    this.data = null;
    /** @type {Helpers | null} */
    this.helpers = null;
    this.me = -1;
    this.baseX = 0;
    this.baseY = 0;
    this.baseTileX = 0;
    this.baseTileY = 0;
    /** 主礦方向（由主堡指向主礦區中心） */
    this.mineDirX = 0;
    this.mineDirY = 0;
    /** @type {number[]} */
    this.mainNodeIds = [];
    /** @type {{ playerId: number, x: number, y: number, dist: number }[]} */
    this.enemyStarts = [];
    this.attacking = false;
    this.targetX = 0;
    this.targetY = 0;
    /** @type {Record<CombatType, number>} */
    this.produced = { spear: 0, archer: 0, cavalry: 0 };
    this.decisions = 0;
    this.lastRegroup = 0;
    this.lastDefenseTick = -1000;
  }

  /** @returns {BotDeclaration} */
  declare() {
    return {
      name: 'Baseline',
      version: 'v1',
      style: '穩定運營、固定節奏一波波進攻；不偵察、不擴張、不蓋塔。',
      knobs: [
        { key: 'attackThreshold', name: '進攻門檻', description: '戰鬥單位人口達此值即全軍出擊', min: 6, max: 30, default: 12, integer: true },
        { key: 'workerCap', name: '工人上限', description: '主堡生產工人的上限', min: 8, max: 24, default: 16, integer: true },
        { key: 'archerRatio', name: '弓兵比例', description: '兵營產出中弓兵的比例（%），其餘依長槍 2：騎兵 1', min: 0, max: 80, default: 40, integer: true },
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
    this.me = data.me;
    const slot = data.startSlots.find((s) => s.playerId === data.me);
    if (slot === undefined) throw new Error('找不到自己的起點');
    this.baseTileX = slot.tileX;
    this.baseTileY = slot.tileY;
    this.baseX = slot.tileX * TILE + 1500;
    this.baseY = slot.tileY * TILE + 1500;
    const mainArea = data.mineAreas.find((a) => a.kind === 'main' && a.owner === data.me);
    if (mainArea === undefined) throw new Error('找不到主礦區');
    const nodes = data.mineNodes.filter((n) => n.areaId === mainArea.areaId);
    this.mainNodeIds = nodes.map((n) => n.id).sort((a, b) => a - b);
    let mx = 0;
    let my = 0;
    for (const n of nodes) {
      mx += n.tileX * TILE + 500;
      my += n.tileY * TILE + 500;
    }
    this.mineDirX = mx / nodes.length - this.baseX;
    this.mineDirY = my / nodes.length - this.baseY;
    this.enemyStarts = data.startSlots
      .filter((s) => s.playerId !== data.me)
      .map((s) => ({
        playerId: s.playerId,
        x: s.tileX * TILE + 1500,
        y: s.tileY * TILE + 1500,
        dist: helpers.pathDistance(slot.tileX + 1, slot.tileY + 1, s.tileX + 1, s.tileY + 1),
      }))
      .sort((a, b) => (a.dist < 0 ? 1e12 : a.dist) - (b.dist < 0 ? 1e12 : b.dist) || a.playerId - b.playerId);
  }

  /**
   * @param {Observation} obs
   * @returns {Command[]}
   */
  decide(obs) {
    this.decisions += 1;
    /** @type {Command[]} */
    const cmds = [];
    const budget = obs.commandBudget;
    /** @param {Command} c */
    const push = (c) => {
      if (cmds.length >= budget) return false;
      cmds.push(c);
      return true;
    };
    const knobs = obs.knobs;
    let minerals = obs.minerals;
    let supplyUsed = obs.supplyUsed;
    const workers = obs.myUnits.filter((u) => u.type === 'worker');
    const army = obs.myUnits.filter((u) => u.type !== 'worker');
    const bases = obs.myBuildings.filter((b) => b.type === 'base');
    const base = bases.find((b) => b.complete) ?? bases[0];
    if (base === undefined) return cmds;
    const barracks = obs.myBuildings.filter((b) => b.type === 'barracks');

    // 6. 回防：主基地範圍內的建築或工人受攻擊
    const home = army.filter((u) => u.group !== ARMY_GROUP);
    if (home.length > 0 && obs.tick - this.lastDefenseTick >= DEFENSE_COOLDOWN) {
      const threat = this.findThreat(obs);
      if (threat !== null && push({ type: 'attackMove', units: home.map((u) => u.id), x: threat.x, y: threat.y })) {
        this.lastDefenseTick = obs.tick;
      }
    }

    // 5／7. 進攻
    const armySupply = army.reduce((s, u) => s + (u.type === 'cavalry' ? 2 : 1), 0);
    if (!this.attacking && armySupply >= knobs.attackThreshold) {
      if (this.pickTarget(obs)) {
        this.attacking = true;
        this.lastRegroup = this.decisions;
        push({ type: 'group', group: ARMY_GROUP, units: army.map((u) => u.id) });
        push({ type: 'attackMove', units: ARMY_GROUP, x: this.targetX, y: this.targetY });
        for (const b of barracks) push({ type: 'rally', buildingId: b.id, x: this.targetX, y: this.targetY });
      }
    } else if (this.attacking) {
      const changed = this.refreshTarget(obs, army);
      if (changed || this.decisions - this.lastRegroup >= REGROUP_INTERVAL) {
        this.lastRegroup = this.decisions;
        if (army.some((u) => u.group !== ARMY_GROUP)) push({ type: 'group', group: ARMY_GROUP, units: army.map((u) => u.id) });
        push({ type: 'attackMove', units: ARMY_GROUP, x: this.targetX, y: this.targetY });
        if (changed) for (const b of barracks) push({ type: 'rally', buildingId: b.id, x: this.targetX, y: this.targetY });
      }
    }

    // 1. 閒置工人平均分配到主礦區礦點
    this.assignWorkers(obs, workers, push);

    // 1. 生產工人
    const queuedWorkers = base.queue.filter((q) => q.unit === 'worker').length;
    if (base.complete && base.queue.length === 0 && workers.length + queuedWorkers < knobs.workerCap && minerals >= 50 && supplyUsed + 1 <= obs.supplyCap) {
      if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
        minerals -= 50;
        supplyUsed += 1;
      }
    }

    // 2. 補給站
    const supplyPending = obs.myBuildings.some((b) => b.type === 'supply' && !b.complete) || workers.some((w) => w.order.type === 'build' && w.order.building === 'supply');
    if (obs.supplyCap - supplyUsed <= 4 && obs.supplyCap < 50 && !supplyPending && minerals >= 80) {
      if (this.orderBuild(obs, workers, 'supply', push)) minerals -= 80;
    }

    // 3. 兵營（只蓋一座）
    const barracksPending = barracks.length > 0 || workers.some((w) => w.order.type === 'build' && w.order.building === 'barracks');
    if (!barracksPending && workers.length >= 8 && minerals >= 150) {
      if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
    }

    // 4. 依比例生產戰鬥單位
    for (const b of barracks) {
      if (!b.complete || b.queue.length >= 2) continue;
      const type = this.nextUnitType(knobs.archerRatio);
      const st = (/** @type {InitData} */ (this.data)).stats.units[type];
      if (minerals < st.cost || supplyUsed + st.supply > obs.supplyCap) continue;
      if (push({ type: 'train', buildingId: b.id, unit: type })) {
        this.produced[type] += 1;
        minerals -= st.cost;
        supplyUsed += st.supply;
      }
    }
    return cmds;
  }

  /**
   * 主基地範圍內受攻擊的建築或工人位置
   * @param {Observation} obs
   * @returns {{ x: number, y: number } | null}
   */
  findThreat(obs) {
    const r2 = (HOME_RADIUS_TILES * TILE) ** 2;
    for (const ev of obs.events) {
      if (ev.type !== 'underAttack') continue;
      const b = obs.myBuildings.find((x) => x.id === ev.targetId);
      if (b !== undefined) {
        const bx = b.tileX * TILE + 500;
        const by = b.tileY * TILE + 500;
        if ((bx - this.baseX) ** 2 + (by - this.baseY) ** 2 <= r2) return { x: bx, y: by };
        continue;
      }
      const u = obs.myUnits.find((x) => x.id === ev.targetId);
      if (u !== undefined && u.type === 'worker' && (u.x - this.baseX) ** 2 + (u.y - this.baseY) ** 2 <= r2) return { x: u.x, y: u.y };
    }
    return null;
  }

  /**
   * 最近且仍存活的敵方起點
   * @param {Observation} obs
   */
  pickTarget(obs) {
    const start = this.enemyStarts.find((s) => obs.alivePlayers.includes(s.playerId));
    if (start === undefined) return false;
    this.targetX = start.x;
    this.targetY = start.y;
    return true;
  }

  /**
   * 目標點已清空（部隊抵達且附近沒有已知敵方建築）時，改打最近的已知敵方建築或下一個起點。
   * @param {Observation} obs
   * @param {MyUnitView[]} army
   */
  refreshTarget(obs, army) {
    const alive = obs.alivePlayers.filter((p) => p !== this.me);
    const known = obs.enemyBuildings.concat(obs.rememberedBuildings).filter((b) => alive.includes(b.owner));
    const near = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ tiles) => (x - this.targetX) ** 2 + (y - this.targetY) ** 2 <= (tiles * TILE) ** 2;
    if (known.some((b) => near(b.tileX * TILE + 500, b.tileY * TILE + 500, 6))) return false;
    const arrived = army.some((u) => u.group === ARMY_GROUP && near(u.x, u.y, 4));
    const ownerAlive = this.enemyStarts.some((s) => s.x === this.targetX && s.y === this.targetY && alive.includes(s.playerId));
    if (!arrived && ownerAlive) return false;
    if (known.length > 0) {
      let best = known[0];
      let bestD = Infinity;
      for (const b of known) {
        const d = (b.tileX * TILE - this.targetX) ** 2 + (b.tileY * TILE - this.targetY) ** 2;
        if (d < bestD || (d === bestD && b.id < best.id)) {
          bestD = d;
          best = b;
        }
      }
      this.targetX = best.tileX * TILE + 500;
      this.targetY = best.tileY * TILE + 500;
      return true;
    }
    const next = this.enemyStarts.find((s) => alive.includes(s.playerId) && !(s.x === this.targetX && s.y === this.targetY));
    if (next === undefined) return false;
    this.targetX = next.x;
    this.targetY = next.y;
    return true;
  }

  /**
   * @param {Observation} obs
   * @param {MyUnitView[]} workers
   * @param {(c: Command) => boolean} push
   */
  assignWorkers(obs, workers, push) {
    const live = this.mainNodeIds.filter((id) => {
      const n = obs.mineNodes.find((x) => x.id === id);
      return n !== undefined && n.reserve > 0;
    });
    if (live.length === 0) return;
    /** @type {Map<number, number>} */
    const count = new Map(live.map((id) => [id, 0]));
    for (const w of workers) {
      const nid = w.gatherNodeId ?? (w.order.type === 'gather' ? w.order.nodeId : null);
      if (nid !== null && count.has(nid)) count.set(nid, /** @type {number} */ (count.get(nid)) + 1);
    }
    /** @type {Map<number, number[]>} */
    const byNode = new Map();
    for (const w of workers) {
      if (w.order.type !== 'idle') continue;
      let best = live[0];
      for (const id of live) if (/** @type {number} */ (count.get(id)) < /** @type {number} */ (count.get(best))) best = id;
      count.set(best, /** @type {number} */ (count.get(best)) + 1);
      const list = byNode.get(best);
      if (list === undefined) byNode.set(best, [w.id]);
      else list.push(w.id);
    }
    for (const [nodeId, ids] of byNode) push({ type: 'gather', units: ids, nodeId });
  }

  /**
   * 派一名採集中的工人在主堡附近（主礦反方向）蓋建築
   * @param {Observation} obs
   * @param {MyUnitView[]} workers
   * @param {BuildingType} type
   * @param {(c: Command) => boolean} push
   */
  orderBuild(obs, workers, type, push) {
    const builder = workers.filter((w) => w.order.type === 'gather' && w.carrying === 0).sort((a, b) => a.id - b.id)[0]
      ?? workers.filter((w) => w.order.type !== 'build' && w.order.type !== 'construct').sort((a, b) => a.id - b.id)[0];
    if (builder === undefined) return false;
    const spot = this.findSpot(obs, type);
    if (spot === null) return false;
    return push({ type: 'build', workerId: builder.id, building: type, tileX: spot.x, tileY: spot.y });
  }

  /**
   * @param {Observation} obs
   * @param {BuildingType} type
   * @returns {{ x: number, y: number } | null}
   */
  findSpot(obs, type) {
    const data = /** @type {InitData} */ (this.data);
    const helpers = /** @type {Helpers} */ (this.helpers);
    const size = data.stats.buildings[type].size;
    const cx = this.baseTileX + 1;
    const cy = this.baseTileY + 1;
    for (let r = 3; r <= 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          // 不擋礦線：建築中心必須在主礦反方向的半平面
          const vx = (x + size / 2) * TILE - this.baseX;
          const vy = (y + size / 2) * TILE - this.baseY;
          if (vx * this.mineDirX + vy * this.mineDirY > 0) continue;
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
    const helpers = /** @type {Helpers} */ (this.helpers);
    for (let ty = y - 1; ty <= y + size; ty++) {
      for (let tx = x - 1; tx <= x + size; tx++) {
        if (helpers.terrainAt(tx, ty) === 1) return true;
      }
    }
    return false;
  }

  /**
   * 依弓兵比例決定下一個兵種：弓兵 archerRatio%，其餘長槍 2：騎兵 1；取目前最落後者
   * @param {number} archerRatio
   * @returns {CombatType}
   */
  nextUnitType(archerRatio) {
    const rest = 100 - archerRatio;
    /** @type {Record<CombatType, number>} */
    const target = { spear: (rest * 2) / 3, archer: archerRatio, cavalry: rest / 3 };
    const total = this.produced.spear + this.produced.archer + this.produced.cavalry + 1;
    let best = COMBAT_TYPES[0];
    let bestDeficit = -Infinity;
    for (const t of COMBAT_TYPES) {
      const deficit = (target[t] * total) / 100 - this.produced[t];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = t;
      }
    }
    return best;
  }
}
