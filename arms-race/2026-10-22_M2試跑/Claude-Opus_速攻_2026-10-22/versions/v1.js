// 速攻（Speed Rush）選手 Bot
// 策略：極早兵營 → 小批兵力集結 → 立刻壓進最近的敵方主堡，之後兵營持續補兵直線增援；
// 看不到敵方戰鬥單位時直接點主堡，力求在對手成形前結束比賽。

const TILE = 1000;
const COMBAT = ['spear', 'archer', 'cavalry'];

export default class SpeedRushBot {
  constructor() {
    this.data = null;
    this.h = null;
    this.me = -1;
    this.W = 0;
    this.H = 0;
    this.baseTX = 0;
    this.baseTY = 0;
    this.baseX = 0;
    this.baseY = 0;
    this.mainNodes = [];
    this.mineDirX = 0;
    this.mineDirY = 0;
    this.enemies = [];
    this.phase = 'mass';
    this.targetPid = -1;
    this.targetX = 0;
    this.targetY = 0;
    this.stageX = 0;
    this.stageY = 0;
    this.produced = { spear: 0, archer: 0, cavalry: 0 };
    this.decisions = 0;
    this.lastFullOrder = -999;
    this.lastDefTick = -999;
    this.rallied = {};
    this.proxyX = -1;
    this.proxyY = -1;
    this.proxyWorker = -1;
    this.expIdx = 0;
    this.depotDone = false;
    this.depotSpot = undefined;
  }

  declare() {
    return {
      name: 'SpeedRush',
      version: 'v1',
      style: '速攻：極早兵營、小批兵力立刻壓進敵方主堡，持續增援、直取主堡，力求在對手成形前結束比賽。',
      knobs: [
        { key: 'rushSize', name: '首波兵力', description: '戰鬥單位數達此值即發動第一波進攻（越小越早）', min: 2, max: 12, default: 5, integer: true },
        { key: 'workerCap', name: '工人上限', description: '主堡生產工人的上限（越低越早轉兵）', min: 4, max: 16, default: 7, integer: true },
        { key: 'barracksCount', name: '兵營數', description: '要蓋的兵營數量（越多出兵越快、經濟越吃緊）', min: 1, max: 4, default: 2, integer: true },
        { key: 'cavalryRatio', name: '騎兵比例', description: '兵營產出中騎兵的比例（%）', min: 0, max: 80, default: 0, integer: true },
        { key: 'archerRatio', name: '弓兵比例', description: '兵營產出中弓兵的比例（%），其餘為長槍兵', min: 0, max: 60, default: 0, integer: true },
        { key: 'proxyDistance', name: '兵營前置距離', description: '兵營蓋在往敵方主堡路線上的位置（%，0 為自家主堡旁）', min: 0, max: 60, default: 0, integer: true },
      ],
    };
  }

  init(data, helpers) {
    this.data = data;
    this.h = helpers;
    this.me = data.me;
    this.W = data.width;
    this.H = data.height;
    const slot = data.startSlots.find((s) => s.playerId === data.me);
    this.baseTX = slot.tileX;
    this.baseTY = slot.tileY;
    this.baseX = slot.tileX * TILE + 1500;
    this.baseY = slot.tileY * TILE + 1500;
    const mainArea = data.mineAreas.find((a) => a.kind === 'main' && a.owner === data.me);
    const nodes = mainArea ? data.mineNodes.filter((n) => n.areaId === mainArea.areaId) : [];
    this.mainNodes = nodes.map((n) => n.id).sort((a, b) => a - b);
    let mx = 0;
    let my = 0;
    for (const n of nodes) {
      mx += n.tileX * TILE + 500;
      my += n.tileY * TILE + 500;
    }
    if (nodes.length > 0) {
      this.mineDirX = mx / nodes.length - this.baseX;
      this.mineDirY = my / nodes.length - this.baseY;
    }
    this.enemies = data.startSlots
      .filter((s) => s.playerId !== data.me)
      .map((s) => ({
        pid: s.playerId,
        tx: s.tileX,
        ty: s.tileY,
        x: s.tileX * TILE + 1500,
        y: s.tileY * TILE + 1500,
        dist: helpers.pathDistance(slot.tileX + 1, slot.tileY + 1, s.tileX + 1, s.tileY + 1),
      }))
      .sort((a, b) => (a.dist < 0 ? 1e12 : a.dist) - (b.dist < 0 ? 1e12 : b.dist) || a.pid - b.pid);
    const first = this.enemies[0];
    if (first) {
      this.targetPid = first.pid;
      this.targetX = first.x;
      this.targetY = first.y;
      const st = this.pointToward(first.x, first.y, 6);
      this.stageX = st.x;
      this.stageY = st.y;
    } else {
      this.stageX = this.baseX;
      this.stageY = this.baseY;
    }
  }

  // 從主堡朝 (x, y) 前進約 tiles 格、且可從主堡走到的平地格中心
  pointToward(x, y, tiles) {
    const dx = x - this.baseX;
    const dy = y - this.baseY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const px = this.baseX + (dx / len) * tiles * TILE;
    const py = this.baseY + (dy / len) * tiles * TILE;
    const t = this.nearestOpen(Math.floor(px / TILE), Math.floor(py / TILE), 6);
    if (t === null) return { x: this.baseX, y: this.baseY };
    return { x: t.x * TILE + 500, y: t.y * TILE + 500 };
  }

  nearestOpen(tx, ty, maxR) {
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= this.W || y >= this.H) continue;
          if (this.h.terrainAt(x, y) !== 0) continue;
          if (this.h.pathDistance(this.baseTX + 1, this.baseTY + 1, x, y) < 0) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  decide(obs) {
    try {
      return this.think(obs);
    } catch (e) {
      return [];
    }
  }

  think(obs) {
    this.decisions += 1;
    const cmds = [];
    const budget = obs.commandBudget;
    const push = (c) => {
      if (cmds.length >= budget) return false;
      cmds.push(c);
      return true;
    };
    const k = this.readKnobs(obs.knobs || {});
    const st = this.data.stats;
    let minerals = obs.minerals;
    // 已下令但尚未開工的建築：成本視為已預留
    for (const u of obs.myUnits) if (u.type === 'worker' && u.order.type === 'build') minerals -= st.buildings[u.order.building].cost;
    let supplyUsed = obs.supplyUsed;
    const workers = obs.myUnits.filter((u) => u.type === 'worker');
    const army = obs.myUnits.filter((u) => u.type !== 'worker');
    const bases = obs.myBuildings.filter((b) => b.type === 'base');
    const base = bases.find((b) => b.complete) || bases[0];
    if (base === undefined) return cmds;
    this.baseX = base.tileX * TILE + 1500;
    this.baseY = base.tileY * TILE + 1500;
    const barracks = obs.myBuildings.filter((b) => b.type === 'barracks');
    const readyBarracks = barracks.filter((b) => b.complete);

    // 1. 閒置工人去採礦
    this.assignWorkers(obs, workers, push);

    const barracksBuilding = workers.filter((w) => w.order.type === 'build' && w.order.building === 'barracks').length;
    const needBarracks = barracks.length + barracksBuilding < k.barracksCount;
    const unitReserve = needBarracks ? 150 : 0;
    // 2. 兵營生產（最高優先：速攻靠持續出兵）
    for (const b of readyBarracks) {
      if (b.queue.length >= 2) continue;
      const type = this.nextUnitType(k);
      const us = st.units[type];
      if (minerals - unitReserve < us.cost || supplyUsed + us.supply > obs.supplyCap) continue;
      if (push({ type: 'train', buildingId: b.id, unit: type })) {
        this.produced[type] += 1;
        minerals -= us.cost;
        supplyUsed += us.supply;
      }
    }

    // 3. 建造：兵營 → 補給站
    const pendingOf = (type) =>
      obs.myBuildings.filter((b) => b.type === type && !b.complete).length +
      workers.filter((w) => w.order.type === 'build' && w.order.building === type).length;
    const barracksTotal = barracks.length + workers.filter((w) => w.order.type === 'build' && w.order.building === 'barracks').length;

    // 未完工且無人施工的建築：接續
    this.resumeStalled(obs, workers, push);

    // 主礦採集站：縮短往返距離（只蓋一次）
    if (!this.depotDone) {
      const hasDepot = obs.myBuildings.some((b) => b.type === 'depot') || workers.some((w) => w.order.type === 'build' && w.order.building === 'depot');
      if (hasDepot) this.depotDone = true;
      else if (minerals >= 100) {
        if (this.depotSpot === undefined) this.depotSpot = this.findDepotSpot(obs);
        if (this.depotSpot === null) this.depotDone = true;
        else {
          const w = this.pickBuilder(workers, this.depotSpot.x * TILE, this.depotSpot.y * TILE);
          if (w && push({ type: 'build', workerId: w.id, building: 'depot', tileX: this.depotSpot.x, tileY: this.depotSpot.y })) {
            minerals -= 100;
            this.depotDone = true;
          }
        }
      } else {
        minerals = -1;
      }
    }

    const wantBarracks = barracksTotal < k.barracksCount;
    if (!wantBarracks) this.proxyWorker = -1;
    if (wantBarracks) {
      if (k.proxyDistance > 0) {
        if (this.proxyBuild(obs, workers, minerals, push, k)) minerals -= 150;
      } else if (minerals >= 150) {
        if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
      }
    }

    // 補給站：剩餘人口不夠下一輪生產時
    const producers = readyBarracks.length + barracks.filter((b) => !b.complete).length;
    const buffer = 2 + producers * 2;
    const supplyPending = pendingOf('supply');
    const capSoon = obs.supplyCap + supplyPending * 8;
    if (obs.supplyCap < 50 && capSoon - supplyUsed <= buffer && supplyPending < 2 && minerals >= 80 && barracksTotal > 0) {
      if (this.orderBuild(obs, workers, 'supply', push)) minerals -= 80;
    }

    // 4. 工人：在兵營排隊前保留礦
    const queuedWorkers = base.queue.filter((q) => q.unit === 'worker').length;
    const minW = Math.min(5, k.workerCap);
    const reserve = barracksTotal < k.barracksCount && workers.length >= minW ? 150 : 0;
    if (base.complete && base.queue.length === 0 && workers.length + queuedWorkers < k.workerCap && minerals - reserve >= 50 && supplyUsed + 1 <= obs.supplyCap) {
      if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
        minerals -= 50;
        supplyUsed += 1;
      }
    }

    // 5. 部隊
    this.armyControl(obs, army, readyBarracks, push, k);
    return cmds;
  }

  readKnobs(kn) {
    const num = (v, d, lo, hi) => {
      const x = typeof v === 'number' && isFinite(v) ? v : d;
      return Math.max(lo, Math.min(hi, x));
    };
    return {
      rushSize: Math.round(num(kn.rushSize, 5, 2, 12)),
      workerCap: Math.round(num(kn.workerCap, 7, 4, 16)),
      barracksCount: Math.round(num(kn.barracksCount, 2, 1, 4)),
      cavalryRatio: num(kn.cavalryRatio, 0, 0, 80),
      archerRatio: num(kn.archerRatio, 0, 0, 60),
      proxyDistance: num(kn.proxyDistance, 0, 0, 60),
    };
  }

  nextUnitType(k) {
    let cav = k.cavalryRatio;
    let arc = k.archerRatio;
    if (cav + arc > 100) {
      const s = cav + arc;
      cav = (cav * 100) / s;
      arc = (arc * 100) / s;
    }
    const target = { spear: 100 - cav - arc, archer: arc, cavalry: cav };
    const total = this.produced.spear + this.produced.archer + this.produced.cavalry + 1;
    let best = 'spear';
    let bestD = -Infinity;
    for (const t of COMBAT) {
      if (target[t] <= 0) continue;
      const d = (target[t] * total) / 100 - this.produced[t];
      if (d > bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  // ---------- 部隊控制 ----------
  armyControl(obs, army, readyBarracks, push, k) {
    // 目標維護
    this.refreshTarget(obs);
    // 集結點
    for (const b of readyBarracks) {
      const want = this.phase === 'attack' ? 'a' + this.targetPid : 's';
      if (this.rallied[b.id] !== want) {
        const rx = this.phase === 'attack' ? this.stageX : this.stageX;
        const ry = this.phase === 'attack' ? this.stageY : this.stageY;
        if (push({ type: 'rally', buildingId: b.id, x: rx, y: ry })) this.rallied[b.id] = want;
      }
    }
    if (army.length === 0) return;

    // 回防：家中受到戰鬥單位攻擊
    const threat = this.findThreat(obs);
    const homeR2 = (18 * TILE) ** 2;
    const atHome = army.filter((u) => (u.x - this.baseX) ** 2 + (u.y - this.baseY) ** 2 <= homeR2);

    if (this.phase === 'mass') {
      if (threat !== null && obs.tick - this.lastDefTick >= 30) {
        if (push({ type: 'attackMove', units: army.map((u) => u.id), x: threat.x, y: threat.y })) this.lastDefTick = obs.tick;
        return;
      }
      if (army.length >= k.rushSize && this.targetPid >= 0) {
        this.phase = 'attack';
        if (push({ type: 'attackMove', units: army.map((u) => u.id), x: this.targetX, y: this.targetY })) this.lastFullOrder = this.decisions;
      }
      return;
    }

    // attack phase
    if (threat !== null && atHome.length > 0 && obs.tick - this.lastDefTick >= 30) {
      if (push({ type: 'attackMove', units: atHome.map((u) => u.id), x: threat.x, y: threat.y })) this.lastDefTick = obs.tick;
    }

    const enemyCombat = obs.enemyUnits.filter((e) => e.type !== 'worker');
    const enemyTowers = obs.enemyBuildings.filter((b) => b.type === 'tower');
    const tb = this.targetBuilding(obs);
    // 部隊前線：離目標最近的單位
    const near = (u, x, y, r) => (u.x - x) ** 2 + (u.y - y) ** 2 <= (r * TILE) ** 2;
    const fightNear = (u) => enemyCombat.some((e) => near(u, e.x, e.y, 9)) || enemyTowers.some((t) => near(u, t.tileX * TILE + 500, t.tileY * TILE + 500, 8));

    if (tb !== null) {
      const bx = tb.tileX * TILE + (tb.type === 'base' ? 1500 : 1000);
      const by = tb.tileY * TILE + (tb.type === 'base' ? 1500 : 1000);
      // 附近沒有敵方戰鬥單位 → 直接點主堡
      const sieger = army.filter((u) => near(u, bx, by, 12) && !fightNear(u) && !(u.order.type === 'attack' && u.order.targetId === tb.id));
      if (sieger.length > 0) {
        push({ type: 'attack', units: sieger.map((u) => u.id), targetId: tb.id });
      }
      // 有敵方戰鬥單位逼近、正在打主堡的單位 → 改為攻擊移動迎戰
      const distracted = army.filter((u) => u.order.type === 'attack' && fightNear(u));
      if (distracted.length > 0) push({ type: 'attackMove', units: distracted.map((u) => u.id), x: bx, y: by });
    }

    // 閒置／移動中的單位：投入戰場（家中的散兵湊滿 2 隻再出發）
    const loose = army.filter((u) => u.order.type === 'idle' || u.order.type === 'move');
    const looseHome = loose.filter((u) => near(u, this.baseX, this.baseY, 18));
    const looseField = loose.filter((u) => !near(u, this.baseX, this.baseY, 18));
    let send = looseField;
    if (looseHome.length >= Math.min(3, k.rushSize) || (looseHome.length > 0 && threat === null && this.decisions - this.lastFullOrder > 40)) send = send.concat(looseHome);
    if (send.length > 0) {
      if (push({ type: 'attackMove', units: send.map((u) => u.id), x: this.targetX, y: this.targetY }) && send.length === loose.length) this.lastFullOrder = this.decisions;
    }
  }

  // 目前目標玩家的主要建築（看得到的優先主堡）
  targetBuilding(obs) {
    const vis = obs.enemyBuildings.filter((b) => b.owner === this.targetPid);
    const base = vis.find((b) => b.type === 'base');
    if (base) return base;
    return null;
  }

  refreshTarget(obs) {
    const alive = obs.alivePlayers;
    if (this.targetPid < 0 || !alive.includes(this.targetPid)) {
      const next = this.enemies.find((e) => alive.includes(e.pid));
      if (!next) {
        this.targetPid = -1;
        return;
      }
      this.targetPid = next.pid;
      this.targetX = next.x;
      this.targetY = next.y;
      this.expIdx = 0;
      this.lastFullOrder = -999;
      return;
    }
    // 目標點已清空但對手未淘汰：改打已知建築，否則巡分礦
    const known = obs.enemyBuildings.concat(obs.rememberedBuildings).filter((b) => b.owner === this.targetPid);
    const atTarget = known.some((b) => Math.abs(b.tileX * TILE - this.targetX) < 4000 && Math.abs(b.tileY * TILE - this.targetY) < 4000);
    if (atTarget) return;
    const armyThere = obs.myUnits.some((u) => u.type !== 'worker' && (u.x - this.targetX) ** 2 + (u.y - this.targetY) ** 2 <= (4 * TILE) ** 2);
    const startOfTarget = this.enemies.find((e) => e.pid === this.targetPid);
    const isStart = startOfTarget && startOfTarget.x === this.targetX && startOfTarget.y === this.targetY;
    if (!armyThere && isStart) return;
    if (known.length > 0) {
      const b = known.find((x) => x.type === 'base') || known[0];
      this.targetX = b.tileX * TILE + 1000;
      this.targetY = b.tileY * TILE + 1000;
      this.lastFullOrder = -999;
      return;
    }
    if (!armyThere) return;
    const exps = this.data.mineAreas.filter((a) => a.owner === this.targetPid && a.kind === 'expansion');
    if (exps.length === 0) return;
    const a = exps[this.expIdx % exps.length];
    this.expIdx += 1;
    const ns = this.data.mineNodes.filter((n) => n.areaId === a.areaId);
    if (ns.length === 0) return;
    let sx = 0;
    let sy = 0;
    for (const n of ns) {
      sx += n.tileX;
      sy += n.tileY;
    }
    this.targetX = Math.floor((sx / ns.length) * TILE + 500);
    this.targetY = Math.floor((sy / ns.length) * TILE + 500);
    this.lastFullOrder = -999;
  }

  findThreat(obs) {
    const r2 = (16 * TILE) ** 2;
    for (const ev of obs.events) {
      if (ev.type !== 'underAttack') continue;
      if (ev.attackerId !== null) {
        const att = obs.enemyUnits.find((e) => e.id === ev.attackerId);
        if (att && att.type === 'worker') continue;
      }
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

  // ---------- 經濟 ----------
  assignWorkers(obs, workers, push) {
    const live = this.mainNodes.filter((id) => {
      const n = obs.mineNodes.find((x) => x.id === id);
      return n !== undefined && n.reserve > 0;
    });
    if (live.length === 0) return;
    const count = new Map(live.map((id) => [id, 0]));
    for (const w of workers) {
      const nid = w.gatherNodeId !== null && w.gatherNodeId !== undefined ? w.gatherNodeId : w.order.type === 'gather' ? w.order.nodeId : null;
      if (nid !== null && count.has(nid)) count.set(nid, count.get(nid) + 1);
    }
    const byNode = new Map();
    for (const w of workers) {
      if (w.order.type !== 'idle' || w.id === this.proxyWorker) continue;
      let best = live[0];
      for (const id of live) if (count.get(id) < count.get(best)) best = id;
      count.set(best, count.get(best) + 1);
      const list = byNode.get(best);
      if (list === undefined) byNode.set(best, [w.id]);
      else list.push(w.id);
    }
    for (const [nodeId, ids] of byNode) push({ type: 'gather', units: ids, nodeId });
  }

  pickBuilder(workers, x, y) {
    let best = null;
    let bestD = Infinity;
    for (const w of workers) {
      if (w.order.type === 'build' || w.order.type === 'construct') continue;
      if (w.id === this.proxyWorker) continue;
      const d = (w.x - x) ** 2 + (w.y - y) ** 2 + (w.carrying > 0 ? 4e6 : 0);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  resumeStalled(obs, workers, push) {
    for (const b of obs.myBuildings) {
      if (b.complete) continue;
      const busy = workers.some((w) => (w.order.type === 'construct' && w.order.buildingId === b.id));
      if (busy) continue;
      const x = b.tileX * TILE + 500;
      const y = b.tileY * TILE + 500;
      const w = this.pickBuilder(workers, x, y);
      if (w) push({ type: 'resume', workerId: w.id, buildingId: b.id });
      return;
    }
  }

  orderBuild(obs, workers, type, push) {
    const spot = this.findSpot(obs, type);
    if (spot === null) return false;
    const w = this.pickBuilder(workers, spot.x * TILE, spot.y * TILE);
    if (w === null) return false;
    return push({ type: 'build', workerId: w.id, building: type, tileX: spot.x, tileY: spot.y });
  }

  // 採集站位置：讓主礦區礦點到卸貨點的距離總和最小；比主堡好不夠多就不蓋
  findDepotSpot(obs) {
    const nodes = this.data.mineNodes.filter((n) => this.mainNodes.includes(n.id));
    if (nodes.length === 0) return null;
    const rectDist = (n, x, y, s) => {
      const cx = n.tileX + 0.5;
      const cy = n.tileY + 0.5;
      const dx = Math.max(x - cx, 0, cx - (x + s));
      const dy = Math.max(y - cy, 0, cy - (y + s));
      return Math.sqrt(dx * dx + dy * dy);
    };
    let baseSum = 0;
    for (const n of nodes) baseSum += rectDist(n, this.baseTX, this.baseTY, 3);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.tileX);
      minY = Math.min(minY, n.tileY);
      maxX = Math.max(maxX, n.tileX);
      maxY = Math.max(maxY, n.tileY);
    }
    let best = null;
    let bestS = Infinity;
    for (let y = minY - 3; y <= maxY + 2; y++) {
      for (let x = minX - 3; x <= maxX + 2; x++) {
        if (!this.h.canPlace('depot', x, y)) continue;
        // 不貼著主堡，避免堵路
        if (x - 1 < this.baseTX + 3 && x + 3 > this.baseTX && y - 1 < this.baseTY + 3 && y + 3 > this.baseTY) continue;
        let s = 0;
        for (const n of nodes) s += rectDist(n, x, y, 2);
        if (s < bestS) {
          bestS = s;
          best = { x, y };
        }
      }
    }
    if (best === null || bestS > baseSum * 0.75) return null;
    return best;
  }

  // 主堡周圍找位置：兵營偏向敵方方向，補給站偏向後方
  findSpot(obs, type) {
    const size = this.data.stats.buildings[type].size;
    const cx = this.baseTX + 1;
    const cy = this.baseTY + 1;
    let prefX;
    let prefY;
    if (type === 'barracks') {
      prefX = this.stageX;
      prefY = this.stageY;
    } else {
      prefX = this.baseX - (this.stageX - this.baseX);
      prefY = this.baseY - (this.stageY - this.baseY);
    }
    let best = null;
    let bestD = Infinity;
    for (let r = 3; r <= 9; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          const vx = (x + size / 2) * TILE - this.baseX;
          const vy = (y + size / 2) * TILE - this.baseY;
          if (vx * this.mineDirX + vy * this.mineDirY > 0) continue;
          const d = ((x + size / 2) * TILE - prefX) ** 2 + ((y + size / 2) * TILE - prefY) ** 2;
          if (d >= bestD) continue;
          if (!this.h.canPlace(type, x, y)) continue;
          if (this.crowded(obs, x, y, size)) continue;
          bestD = d;
          best = { x, y };
        }
      }
    }
    return best;
  }

  crowded(obs, x, y, size) {
    for (const b of obs.myBuildings) {
      const s = this.data.stats.buildings[b.type].size;
      if (x - 1 < b.tileX + s && x + size + 1 > b.tileX && y - 1 < b.tileY + s && y + size + 1 > b.tileY) return true;
    }
    for (const u of obs.myUnits) {
      if (u.type !== 'worker' || u.order.type !== 'build') continue;
      const s = this.data.stats.buildings[u.order.building].size;
      const bx = u.order.tileX;
      const by = u.order.tileY;
      if (x - 1 < bx + s && x + size + 1 > bx && y - 1 < by + s && y + size + 1 > by) return true;
    }
    for (let ty = y - 1; ty <= y + size; ty++) {
      for (let tx = x - 1; tx <= x + size; tx++) {
        if (this.h.terrainAt(tx, ty) === 1) return true;
      }
    }
    for (const n of this.data.mineNodes) {
      if (n.tileX >= x - 1 && n.tileX <= x + size && n.tileY >= y - 1 && n.tileY <= y + size) return true;
    }
    return false;
  }

  // 前置兵營：派一名工人走到路線上的前置點，到達後就地找位置蓋兵營
  proxyBuild(obs, workers, minerals, push, k) {
    if (this.targetPid < 0) return false;
    const tgt = this.enemies.find((e) => e.pid === this.targetPid) || this.enemies[0];
    if (!tgt) return false;
    if (this.proxyX < 0) {
      const dx = tgt.x - this.baseX;
      const dy = tgt.y - this.baseY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const t = (len * k.proxyDistance) / 100 / TILE;
      const p = this.pointToward(tgt.x, tgt.y, Math.max(4, t));
      this.proxyX = p.x;
      this.proxyY = p.y;
    }
    let pw = workers.find((w) => w.id === this.proxyWorker);
    if (!pw) {
      if (minerals < 60) return false;
      pw = this.pickBuilder(workers, this.proxyX, this.proxyY);
      if (!pw) return false;
      if (push({ type: 'move', units: [pw.id], x: this.proxyX, y: this.proxyY })) this.proxyWorker = pw.id;
      return false;
    }
    if (pw.order.type === 'build' || pw.order.type === 'construct') return false;
    const d2 = (pw.x - this.proxyX) ** 2 + (pw.y - this.proxyY) ** 2;
    if (d2 > (3 * TILE) ** 2) {
      if (pw.order.type !== 'move') push({ type: 'move', units: [pw.id], x: this.proxyX, y: this.proxyY });
      return false;
    }
    if (minerals < 150) return false;
    const spot = this.findSpotNear(obs, 'barracks', Math.floor(this.proxyX / TILE), Math.floor(this.proxyY / TILE));
    if (!spot) return false;
    return push({ type: 'build', workerId: pw.id, building: 'barracks', tileX: spot.x, tileY: spot.y });
  }

  findSpotNear(obs, type, cx, cy) {
    const size = this.data.stats.buildings[type].size;
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!this.h.canPlace(type, x, y)) continue;
          if (this.crowded(obs, x, y, size)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }
}
