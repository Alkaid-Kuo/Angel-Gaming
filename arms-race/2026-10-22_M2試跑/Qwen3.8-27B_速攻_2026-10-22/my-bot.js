// @ts-check
// 速攻流派：早期集中資源蓋兵營，長槍+弓兵成軍即全軍突襲最近敵方基地，
// 在對手成形前摧毀主堡。基地只留 1～2 座防禦塔護家。

const TILE = 1000;
const ARMY_GROUP = 1;
/** 回防判定半徑（格） */
const THREAT_RADIUS_TILES = 12;
/** 出征後每隔多少次決策重新集結 */
const REGROUP_INTERVAL = 20;
/** 回防指令最小間隔（tick） */
const DEFENSE_COOLDOWN = 50;

export default class RushBot {
  constructor() {
    this.data = null;
    this.helpers = null;
    this.me = -1;
    this.baseX = 0;
    this.baseY = 0;
    this.baseTileX = 0;
    this.baseTileY = 0;
    this.mineDirX = 1;
    this.mineDirY = 0;
    this.frontDirX = 0;
    this.frontDirY = 1;
    /** @type {number[]} */
    this.mainNodeIds = [];
    /** @type {{playerId:number,x:number,y:number,dist:number}[]} */
    this.enemyStarts = [];
    /** @type {Record<string, {x:number,y:number}[]>} */
    this.spots = { barracks: [], tower: [], supply: [] };
    /** @type {Record<string, number>} */
    this.produced = { spear: 0, archer: 0, cavalry: 0 };
    this.rushing = false;
    this.targetX = 0;
    this.targetY = 0;
    this.targetPlayer = -1;
    this.lastRegroup = 0;
    this.lastDefenseTick = -100000;
    this.decisions = 0;
  }

  declare() {
    return {
      name: 'Rush',
      version: 'v1',
      style: '速攻：早期兵營集結長槍與弓兵，直取敵方主堡，不給對手成形機會。',
      knobs: [
        { key: 'rushThreshold', name: '突襲門檻', description: '戰鬥單位人口（含騎兵×2）達此值即全軍突襲最近敵方基地', min: 4, max: 20, default: 8, integer: true },
        { key: 'workerCap', name: '工人上限', description: '主堡生產工人的上限；越高經濟越快但越佔人口', min: 6, max: 20, default: 10, integer: true },
        { key: 'spearRatio', name: '長槍比例', description: '兵營產出中長槍兵的比例（%），其餘為弓兵；長槍耐打、弓兵射程遠', min: 0, max: 100, default: 70, integer: true },
        { key: 'towerCount', name: '防禦塔數', description: '主堡周圍蓋幾座防禦塔護家（0～3）', min: 0, max: 3, default: 1, integer: true },
      ],
    };
  }

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
    mx = mx / nodes.length - this.baseX;
    my = my / nodes.length - this.baseY;
    const ml = Math.hypot(mx, my) || 1;
    this.mineDirX = mx / ml;
    this.mineDirY = my / ml;
    const fx = (data.width / 2) * TILE - this.baseX;
    const fy = (data.height / 2) * TILE - this.baseY;
    const fl = Math.hypot(fx, fy) || 1;
    this.frontDirX = fx / fl;
    this.frontDirY = fy / fl;
    this.enemyStarts = data.startSlots
      .filter((s) => s.playerId !== data.me)
      .map((s) => ({
        playerId: s.playerId,
        x: s.tileX * TILE + 1500,
        y: s.tileY * TILE + 1500,
        dist: helpers.pathDistance(slot.tileX + 1, slot.tileY + 1, s.tileX + 1, s.tileY + 1),
      }))
      .sort((a, b) => (a.dist < 0 ? 1e12 : a.dist) - (b.dist < 0 ? 1e12 : b.dist) || a.playerId - b.playerId);
    this.spots = {
      barracks: this.genSpots('barracks', 0.6),
      tower: this.genSpots('tower', 1.6),
      supply: this.genSpots('supply', 0.2),
    };
  }

  /**
   * 預計算建築候選位置（環形搜索、不擋礦線、偏向前方隘口方向）
   * @param {string} type
   * @param {number} frontBias
   */
  genSpots(type, frontBias) {
    const helpers = this.helpers;
    const size = this.data.stats.buildings[type].size;
    const cx = this.baseTileX + 1;
    const cy = this.baseTileY + 1;
    /** @type {{x:number,y:number,score:number}[]} */
    const cands = [];
    for (let r = 2; r <= 9; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          const vx = (x + size / 2) * TILE - this.baseX;
          const vy = (y + size / 2) * TILE - this.baseY;
          if (vx * this.mineDirX + vy * this.mineDirY > 0) continue; // 不擋礦線
          let score = Math.hypot(vx, vy);
          score -= frontBias * (vx * this.frontDirX + vy * this.frontDirY);
          if (helpers.canPlace(type, x, y)) cands.push({ x, y, score });
        }
      }
    }
    cands.sort((a, b) => a.score - b.score);
    return cands;
  }

  decide(obs) {
    this.decisions += 1;
    /** @type {any[]} */
    const cmds = [];
    const budget = obs.commandBudget;
    /** @param {any} c */
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
    const barracksList = obs.myBuildings.filter((b) => b.type === 'barracks');
    const towersBuilt = obs.myBuildings.filter((b) => b.type === 'tower').length;

    // 目標失效（該玩家被消滅）時換下一個最近敵方基地
    this.ensureTarget(obs);

    // 1. 回防（尚未出征時才用留守部隊）
    if (!this.rushing) {
      const home = army.filter((u) => u.group !== ARMY_GROUP);
      if (home.length > 0 && obs.tick - this.lastDefenseTick >= DEFENSE_COOLDOWN) {
        const threat = this.findThreat(obs);
        if (threat !== null && push({ type: 'attackMove', units: home.map((u) => u.id), x: threat.x, y: threat.y })) {
          this.lastDefenseTick = obs.tick;
        }
      }
    }

    // 2. 出征
    const armySupply = army.reduce((s, u) => s + (u.type === 'cavalry' ? 2 : 1), 0);
    if (!this.rushing && armySupply >= knobs.rushThreshold && barracksList.some((b) => b.complete)) {
      this.rushing = true;
      this.lastRegroup = this.decisions;
      if (this.ensureTarget(obs)) {
        push({ type: 'group', group: ARMY_GROUP, units: army.map((u) => u.id) });
        push({ type: 'attackMove', units: ARMY_GROUP, x: this.targetX, y: this.targetY });
        for (const b of barracksList) push({ type: 'rally', buildingId: b.id, x: this.targetX, y: this.targetY });
      }
    } else if (this.rushing && this.decisions - this.lastRegroup >= REGROUP_INTERVAL) {
      this.lastRegroup = this.decisions;
      if (army.some((u) => u.group !== ARMY_GROUP)) push({ type: 'group', group: ARMY_GROUP, units: army.map((u) => u.id) });
      push({ type: 'attackMove', units: ARMY_GROUP, x: this.targetX, y: this.targetY });
    }

    // 3. 工人採集
    this.assignWorkers(obs, workers, push);

    // 4. 生產工人
    const queuedWorkers = base.queue.filter((q) => q.unit === 'worker').length;
    if (base.complete && base.queue.length < 5 && workers.length + queuedWorkers < knobs.workerCap && minerals >= 50 && supplyUsed + 1 <= obs.supplyCap) {
      if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
        minerals -= 50;
        supplyUsed += 1;
      }
    }

    // 5. 建築：兵營 > 補給站 > 防禦塔 > 第二兵營
    const barracksPending = barracksList.length > 0 || workers.some((w) => w.order.type === 'build' && w.order.building === 'barracks');
    const supplyPending = obs.myBuildings.some((b) => b.type === 'supply' && !b.complete) || workers.some((w) => w.order.type === 'build' && w.order.building === 'supply');
    const towerPending = workers.some((w) => w.order.type === 'build' && w.order.building === 'tower');
    if (!barracksPending && workers.length >= 6 && minerals >= 150) {
      if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
    } else if (obs.supplyCap - supplyUsed <= 4 && !supplyPending && minerals >= 80) {
      if (this.orderBuild(obs, workers, 'supply', push)) minerals -= 80;
    } else if (towersBuilt < knobs.towerCount && !towerPending && minerals >= 120) {
      if (this.orderBuild(obs, workers, 'tower', push)) minerals -= 120;
    } else if (barracksList.length === 1 && workers.length >= 8 && minerals >= 150) {
      if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
    }

    // 6. 兵營生產戰鬥單位
    for (const b of barracksList) {
      if (!b.complete || b.queue.length >= 4) continue;
      const type = this.nextUnitType(knobs.spearRatio);
      const st = this.data.stats.units[type];
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
   * 確保有有效目標（最近且存活的敵方起點）
   * @param {any} obs
   */
  ensureTarget(obs) {
    if (this.targetPlayer >= 0 && obs.alivePlayers.includes(this.targetPlayer)) return true;
    const s = this.enemyStarts.find((s) => obs.alivePlayers.includes(s.playerId));
    if (s === undefined) return false;
    this.targetPlayer = s.playerId;
    this.targetX = s.x;
    this.targetY = s.y;
    return true;
  }

  /**
   * 基地附近的威脅位置（視野內敵方單位或基地範圍內受擊建築）
   * @param {any} obs
   */
  findThreat(obs) {
    const r2 = (THREAT_RADIUS_TILES * TILE) ** 2;
    let best = null;
    let bd = Infinity;
    for (const e of obs.enemyUnits) {
      const d = (e.x - this.baseX) ** 2 + (e.y - this.baseY) ** 2;
      if (d <= r2 && d < bd) {
        bd = d;
        best = e;
      }
    }
    if (best !== null) return { x: best.x, y: best.y };
    for (const ev of obs.events) {
      if (ev.type !== 'underAttack') continue;
      const b = obs.myBuildings.find((x) => x.id === ev.targetId);
      if (b !== undefined) {
        const bx = b.tileX * TILE + 500;
        const by = b.tileY * TILE + 500;
        if ((bx - this.baseX) ** 2 + (by - this.baseY) ** 2 <= r2) return { x: bx, y: by };
      }
    }
    return null;
  }

  /**
   * 閒置工人平均分配到主礦區礦點
   * @param {any} obs
   * @param {any[]} workers
   * @param {(c:any)=>boolean} push
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
   * 派一名工人在預選位置蓋建築
   * @param {any} obs
   * @param {any[]} workers
   * @param {string} type
   * @param {(c:any)=>boolean} push
   */
  orderBuild(obs, workers, type, push) {
    const helpers = this.helpers;
    let spot = null;
    for (const s of this.spots[type]) {
      if (helpers.canPlace(type, s.x, s.y)) {
        spot = s;
        break;
      }
    }
    if (spot === null) return false;
    let builder = workers.find((w) => w.order.type === 'idle');
    if (builder === undefined) {
      const gs = workers.filter((w) => w.order.type === 'gather' && w.carrying === 0).sort((a, b) => a.id - b.id);
      builder = gs[0];
    }
    if (builder === undefined) builder = workers.find((w) => w.order.type !== 'build' && w.order.type !== 'construct');
    if (builder === undefined) return false;
    return push({ type: 'build', workerId: builder.id, building: type, tileX: spot.x, tileY: spot.y });
  }

  /**
   * 依長槍比例決定下一兵種（其餘為弓兵）
   * @param {number} spearRatio
   */
  nextUnitType(spearRatio) {
    const total = this.produced.spear + this.produced.archer + 1;
    const dSpear = (spearRatio * total) / 100 - this.produced.spear;
    const dArcher = ((100 - spearRatio) * total) / 100 - this.produced.archer;
    return dSpear >= dArcher ? 'spear' : 'archer';
  }
}
