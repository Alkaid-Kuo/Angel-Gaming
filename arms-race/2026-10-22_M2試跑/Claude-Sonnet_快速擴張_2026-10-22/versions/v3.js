// 快速擴張流：開局即派工人到分礦區蓋採集站（便宜擴張），以雙礦區經濟＋多兵營＋防禦塔穩住，
// 兵力累積到門檻後全軍壓上，並持續增援。
const T = 1000;
const RETHROW = true;

export default class QuickExpandBot {
  constructor() {
    this.data = null;
    this.helpers = null;
    this.me = -1;
    this.baseTX = 0;
    this.baseTY = 0;
    this.baseX = 0;
    this.baseY = 0;
    this.mineDirX = 0;
    this.mineDirY = 0;
    this.areas = [];
    this.mainArea = null;
    this.expAreas = [];
    this.enemyStarts = [];
    this.staging = { x: 0, y: 0 };
    this.bad = new Set();
    this.lastCmds = [];
    this.pushing = false;
    this.peak = 0;
    this.visited = new Set();
    this.scout = null;
    this.defTarget = null;
    this.defTick = -1000;
    this.spotCache = {};
    this.lastWave = 0;
    this.errors = 0;
    this.retreatUntil = 0;
  }

  declare() {
    return {
      name: 'QuickExpand',
      version: 'v3',
      style: '快速擴張：開局搶蓋分礦採集站，雙礦區經濟＋多兵營，後期以大軍碾壓。',
      knobs: [
        { key: 'expandAt', name: '擴張時機', description: '工人數達此值時開始蓋第一座分礦採集站（越小越早擴張）', min: 5, max: 16, default: 8, integer: true },
        { key: 'workerTarget', name: '工人目標', description: '工人總數目標', min: 10, max: 32, default: 24, integer: true },
        { key: 'armyPush', name: '總攻門檻', description: '戰鬥單位人口達此值即全軍壓上', min: 12, max: 45, default: 28, integer: true },
        { key: 'expansions', name: '擴張礦區數', description: '最多佔用幾個額外礦區（分礦、第二分礦、富礦）', min: 1, max: 3, default: 2, integer: true },
        { key: 'towers', name: '防禦塔數', description: '每個擴張礦區旁的防禦塔數量', min: 0, max: 3, default: 1, integer: true },
        { key: 'archerShare', name: '弓兵比例', description: '戰鬥單位中弓兵的比例（%），其餘以長槍兵為主', min: 0, max: 70, default: 30, integer: true },
      ],
    };
  }

  // ---------------------------------------------------------------- init
  init(data, helpers) {
    this.data = data;
    this.helpers = helpers;
    this.me = data.me;
    const slot = data.startSlots.find((s) => s.playerId === data.me);
    this.baseTX = slot.tileX;
    this.baseTY = slot.tileY;
    this.baseX = slot.tileX * T + 1500;
    this.baseY = slot.tileY * T + 1500;
    const W = data.width;
    const nodeAt = new Set(data.mineNodes.map((n) => n.tileY * W + n.tileX));
    this.nodeAt = nodeAt;

    for (const a of data.mineAreas) {
      const nodes = data.mineNodes.filter((n) => n.areaId === a.areaId);
      if (nodes.length === 0) continue;
      let cx = 0;
      let cy = 0;
      for (const n of nodes) {
        cx += n.tileX + 0.5;
        cy += n.tileY + 0.5;
      }
      cx /= nodes.length;
      cy /= nodes.length;
      const area = { areaId: a.areaId, kind: a.kind, owner: a.owner, nodes, nodeIds: nodes.map((n) => n.id), cx, cy, spots: [], pathD: 1e9, depotId: null };
      this.areas.push(area);
    }
    this.mainArea = this.areas.find((a) => a.kind === 'main' && a.owner === data.me);
    {
      const m = this.mainArea;
      this.mineDirX = m.cx * T - this.baseX;
      this.mineDirY = m.cy * T - this.baseY;
    }
    // 候選擴張礦區：自己的分礦區 + 最近的富礦區
    const exp = this.areas.filter((a) => a.kind === 'expansion' && a.owner === data.me);
    const rich = this.areas.filter((a) => a.kind === 'rich');
    for (const a of exp.concat(rich)) {
      this.computeDepotSpots(a);
    }
    exp.sort((a, b) => a.pathD - b.pathD);
    rich.sort((a, b) => a.pathD - b.pathD);
    this.expAreas = exp.concat(rich.slice(0, 1)).filter((a) => a.spots.length > 0 && a.pathD < 1e8);
    // 敵方起點
    this.enemyStarts = data.startSlots
      .filter((s) => s.playerId !== data.me)
      .map((s) => ({
        playerId: s.playerId,
        x: s.tileX * T + 1500,
        y: s.tileY * T + 1500,
        tx: s.tileX + 1,
        ty: s.tileY + 1,
        dist: helpers.pathDistance(slot.tileX + 1, slot.tileY + 1, s.tileX + 1, s.tileY + 1),
      }))
      .sort((a, b) => (a.dist < 0 ? 1e12 : a.dist) - (b.dist < 0 ? 1e12 : b.dist) || a.playerId - b.playerId);
    this.computeStaging();
  }

  tileFree(x, y) {
    const d = this.data;
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return false;
    if (d.tiles[y * d.width + x] !== 0) return false;
    return !this.nodeAt.has(y * d.width + x);
  }

  // 只依地形計算的採集站候選位置（開局未探索，不能用 canPlace）
  computeDepotSpots(area) {
    const cands = [];
    const minX = Math.floor(area.cx) - 7;
    const maxX = Math.floor(area.cx) + 7;
    const minY = Math.floor(area.cy) - 7;
    const maxY = Math.floor(area.cy) + 7;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!(this.tileFree(x, y) && this.tileFree(x + 1, y) && this.tileFree(x, y + 1) && this.tileFree(x + 1, y + 1))) continue;
        const px = x + 1;
        const py = y + 1;
        let cost = 0;
        let maxd = 0;
        for (const n of area.nodes) {
          const dd = Math.hypot(px - (n.tileX + 0.5), py - (n.tileY + 0.5));
          cost += dd;
          if (dd > maxd) maxd = dd;
        }
        cands.push({ x, y, cost: cost + maxd * 0.5 });
      }
    }
    cands.sort((a, b) => a.cost - b.cost);
    // 去除過度重疊的候選
    const chosen = [];
    for (const c of cands) {
      if (chosen.every((o) => Math.abs(o.x - c.x) + Math.abs(o.y - c.y) >= 2)) chosen.push(c);
      if (chosen.length >= 10) break;
    }
    area.spots = chosen;
    if (chosen.length > 0) {
      let best = 1e9;
      for (const c of chosen.slice(0, 3)) {
        const d = this.helpers.pathDistance(this.baseTX + 1, this.baseTY + 1, c.x, c.y);
        if (d >= 0 && d < best) best = d;
      }
      area.pathD = best;
    }
  }

  computeStaging() {
    const d = this.data;
    const nat = this.expAreas[0];
    const enemy = this.enemyStarts[0];
    const cx = nat ? nat.spots[0].x + 1 : this.baseTX + 1;
    const cy = nat ? nat.spots[0].y + 1 : this.baseTY + 1;
    if (!enemy) {
      this.staging = { x: cx * T, y: cy * T };
      return;
    }
    let best = null;
    let bestD = 1e12;
    const R = 6;
    for (let y = cy - R; y <= cy + R; y++) {
      for (let x = cx - R; x <= cx + R; x++) {
        if (!this.tileFree(x, y)) continue;
        const r = Math.hypot(x - cx, y - cy);
        if (r > R || r < 2) continue;
        const dn = this.helpers.pathDistance(x, y, cx, cy);
        if (dn < 0) continue;
        const de = this.helpers.pathDistance(x, y, enemy.tx, enemy.ty);
        if (de < 0) continue;
        // 偏向敵方方向，但別離礦區太遠
        const score = de + dn * 0.3;
        if (score < bestD) {
          bestD = score;
          best = { x, y };
        }
      }
    }
    if (best === null) best = { x: cx, y: cy };
    this.staging = { x: best.x * T + 500, y: best.y * T + 500 };
  }

  // ---------------------------------------------------------------- decide
  decide(obs) {
    if (RETHROW) return this.think(obs);
    try {
      return this.think(obs);
    } catch (e) {
      this.errors++;
      return [];
    }
  }

  think(obs) {
    const D = this.data;
    const K = obs.knobs;
    const tick = obs.tick;
    const budget = obs.commandBudget;
    const cmds = [];
    const push = (c) => {
      if (cmds.length >= budget) return false;
      cmds.push(c);
      return true;
    };
    this.processEvents(obs);

    const workers = obs.myUnits.filter((u) => u.type === 'worker');
    const army = obs.myUnits.filter((u) => u.type !== 'worker');
    const bases = obs.myBuildings.filter((b) => b.type === 'base');
    const base = bases.find((b) => b.complete) || bases[0];
    if (!base) {
      this.lastCmds = cmds;
      return cmds;
    }
    const completeB = (type) => obs.myBuildings.filter((b) => b.type === type && b.complete);
    const allB = (type) => obs.myBuildings.filter((b) => b.type === type);
    const barracks = allB('barracks');
    const supplies = allB('supply');
    const depots = allB('depot');
    const towersB = allB('tower');

    // 正在建造 / 已下令的建築
    const buildOrders = workers.filter((w) => w.order.type === 'build');
    const pendingCount = (type) => buildOrders.filter((w) => w.order.building === type).length + obs.myBuildings.filter((b) => b.type === type && !b.complete).length;
    let committed = 0;
    for (const w of buildOrders) committed += D.stats.buildings[w.order.building].cost;
    let minerals = obs.minerals - committed;
    let supplyUsed = obs.supplyUsed;
    let blocked = false;
    const spend = (cost) => {
      if (!blocked && minerals >= cost) {
        minerals -= cost;
        return true;
      }
      return false;
    };
    const want = (cost) => {
      // 想要但買不起 → 阻擋較低優先的支出
      if (!blocked && minerals >= cost) return true;
      blocked = true;
      return false;
    };

    // 礦區啟用狀況：有完工的卸貨點在附近
    this.updateAreas(obs, depots, bases);
    const activeAreas = this.areas.filter((a) => a.active);
    const liveNodes = (area) => area.nodeIds.filter((id) => {
      const n = obs.mineNodes.find((x) => x.id === id);
      return n && n.reserve > 0;
    });

    // ---- 0. 防守反應
    this.defend(obs, army, workers, push);

    // ---- 1. 閒置工人採礦
    this.assignWorkers(obs, workers, activeAreas, liveNodes, push);

    // ---- 2. 補給站
    const supplyPend = pendingCount('supply');
    const barracksDone = completeB('barracks').length;
    const capEff = obs.supplyCap + 8 * supplyPend;
    const threshold = Math.ceil(3 + 1.5 * barracksDone);
    const maxCapNeeded = 50;
    if (capEff - supplyUsed <= threshold && capEff < maxCapNeeded + 8 && supplyPend < (barracksDone >= 2 ? 2 : 1) && obs.supplyCap < 50) {
      if (want(80)) {
        if (this.orderBuild(obs, workers, 'supply', push)) spend(80);
      }
    }

    // ---- 3. 擴張（分礦採集站）
    const wantedExp = Math.min(K.expansions, this.expAreas.length);
    const expDone = this.expAreas.filter((a) => a.depotId !== null || a.pending).length;
    const workerCount = workers.length;
    const queuedWorkers = base.queue.filter((q) => q.unit === 'worker').length;
    const effExpandAt = Math.min(K.expandAt, K.workerTarget, 12);
    let expandingNow = false;
    for (let i = 0; i < this.expAreas.length && i < wantedExp; i++) {
      const a = this.expAreas[i];
      if (a.depotId !== null) continue;
      const wc = workerCount + queuedWorkers;
      const scoutDue = i === 0 && wc >= effExpandAt - 3;
      const due = i === 0 ? wc >= effExpandAt - 1 || tick >= 1500 : this.expAreas[i - 1].depotId !== null && workerCount >= effExpandAt + 4 + 3 * (i - 1) && barracksDone >= 1;
      if (!due && !scoutDue) break;
      const hasDepotOrder = buildOrders.some((w) => w.order.building === 'depot');
      if (hasDepotOrder) break;
      const r = this.orderDepot(obs, workers, a, push, due && minerals >= 100 && !blocked);
      if (r === 'built') spend(100);
      else if (r === 'ready' && due) {
        expandingNow = true;
        if (minerals < 100) blocked = true;
      }
      break;
    }

    // ---- 4. 工人
    const liveActive = activeAreas.reduce((s, a) => s + liveNodes(a).length, 0);
    const livePending = this.expAreas.filter((a) => a.pending && !a.active).reduce((s, a) => s + liveNodes(a).length, 0);
    const workerCap = Math.min(K.workerTarget, Math.max(8, 3 * (liveActive + livePending)));
    if (base.complete && workerCount + queuedWorkers < workerCap && supplyUsed + 1 <= obs.supplyCap) {
      if (base.queue.length === 0 || (base.queue.length === 1 && base.queue[0].progress >= 60)) {
        if (!(expandingNow && minerals < 150)) {
          if (minerals >= 50 && !blocked) {
            if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
              minerals -= 50;
              supplyUsed += 1;
            }
          }
        }
      }
    }
    // 第二批擴張後，副堡（若有）也生產工人
    for (const b of bases) {
      if (b === base || !b.complete) continue;
      if (b.queue.length === 0 && workerCount + queuedWorkers < workerCap && minerals >= 50 && supplyUsed + 1 <= obs.supplyCap) {
        if (push({ type: 'train', buildingId: b.id, unit: 'worker' })) {
          minerals -= 50;
          supplyUsed += 1;
        }
      }
    }

    // ---- 5. 兵營
    const wantBarracks = Math.min(5, 1 + Math.floor((workerCount - 8) / 5));
    const barracksTotal = barracks.length + buildOrders.filter((w) => w.order.building === 'barracks').length;
    const firstDepotStarted = this.expAreas.length === 0 || this.expAreas[0].depotId !== null || wantedExp === 0 || tick >= 1100;
    if (firstDepotStarted && barracksTotal < wantBarracks && barracksTotal < 5 && pendingCount('barracks') < 1) {
      if (want(150)) {
        if (this.orderBuild(obs, workers, 'barracks', push)) {
          spend(150);
          blocked = true;
        }
      }
    }

    // ---- 6. 戰鬥單位
    for (const b of barracks) {
      if (!b.complete || b.queue.length >= 2) continue;
      if (b.queue.length === 1 && b.queue[0].progress < 50) continue;
      const type = this.nextUnitType(obs, army, K);
      const st = D.stats.units[type];
      if (supplyUsed + st.supply > obs.supplyCap) continue;
      if (!want(st.cost)) break;
      if (push({ type: 'train', buildingId: b.id, unit: type })) {
        minerals -= st.cost;
        supplyUsed += st.supply;
        this.produced[type] = (this.produced[type] || 0) + 1;
      }
    }

    // ---- 7. 防禦塔
    if (K.towers > 0 && army.length >= 4) {
      for (const a of this.expAreas) {
        if (a.depotId === null) continue;
        const have = towersB.filter((t) => this.nearArea(t.tileX, t.tileY, a, 9)).length + buildOrders.filter((w) => w.order.building === 'tower' && this.nearArea(w.order.tileX, w.order.tileY, a, 9)).length;
        if (have < K.towers && !buildOrders.some((w) => w.order.building === 'tower') && towersB.every((t) => t.complete)) {
          if (want(120)) {
            if (this.orderTower(obs, workers, a, push)) spend(120);
          }
          break;
        }
      }
    }

    // ---- 8. 未完工建築沒有人蓋 → 接續
    this.resumeBuilds(obs, workers, push);

    // ---- 9. 集結點
    for (const b of barracks) {
      if (!b.rally || Math.abs(b.rally.x - this.staging.x) > 1500 || Math.abs(b.rally.y - this.staging.y) > 1500) {
        push({ type: 'rally', buildingId: b.id, x: this.staging.x, y: this.staging.y });
      }
    }

    // ---- 10. 軍隊
    this.controlArmy(obs, army, workers, push);

    this.lastCmds = cmds;
    return cmds;
  }

  // ---------------------------------------------------------------- 事件
  processEvents(obs) {
    for (const ev of obs.events) {
      if (ev.type === 'buildFailed') {
        this.bad.add(ev.building + ':' + ev.tileX + ',' + ev.tileY);
      } else if (ev.type === 'commandRejected') {
        const c = this.lastCmds[ev.index];
        if (c && c.type === 'build' && ev.reason === 'BAD_PLACEMENT') this.bad.add(c.building + ':' + c.tileX + ',' + c.tileY);
      }
    }
  }

  nearArea(tx, ty, area, r) {
    return (tx - area.cx) ** 2 + (ty - area.cy) ** 2 <= r * r;
  }

  updateAreas(obs, depots, bases) {
    for (const a of this.areas) {
      a.active = false;
      a.pending = false;
    }
    this.mainArea.active = bases.some((b) => b.complete);
    this.mainArea.pending = true;
    const dropoffs = depots.concat(bases.filter((b) => b.tileX !== this.baseTX || b.tileY !== this.baseTY));
    for (const a of this.expAreas) {
      a.depotId = null;
      for (const d of dropoffs) {
        if (this.nearArea(d.tileX + 1, d.tileY + 1, a, 8)) {
          a.depotId = d.id;
          a.pending = true;
          if (d.complete) a.active = true;
        }
      }
    }
    // 工人正前往蓋採集站
    for (const w of obs.myUnits) {
      if (w.order.type === 'build' && w.order.building === 'depot') {
        for (const a of this.expAreas) {
          if (this.nearArea(w.order.tileX + 1, w.order.tileY + 1, a, 8)) a.pending = true;
        }
      }
    }
  }

  // ---------------------------------------------------------------- 採礦
  assignWorkers(obs, workers, activeAreas, liveNodes, push) {
    const cand = [];
    for (const a of activeAreas) {
      for (const id of liveNodes(a)) cand.push({ id, area: a });
    }
    if (cand.length === 0) return;
    const count = new Map(cand.map((c) => [c.id, 0]));
    for (const w of workers) {
      const nid = w.gatherNodeId !== null && w.gatherNodeId !== undefined ? w.gatherNodeId : w.order.type === 'gather' ? w.order.nodeId : null;
      if (nid !== null && count.has(nid)) count.set(nid, count.get(nid) + 1);
    }
    const prio = (c) => (c.area.kind === 'main' ? 0 : c.area.kind === 'expansion' ? 1 : 2);
    const byNode = new Map();
    const idle = workers.filter((w) => w.order.type === 'idle' && w.id !== this.scout);
    for (const w of idle) {
      let best = null;
      for (const c of cand) {
        if (best === null) best = c;
        else {
          const a = count.get(c.id);
          const b = count.get(best.id);
          if (a < b || (a === b && prio(c) < prio(best))) best = c;
        }
      }
      count.set(best.id, count.get(best.id) + 1);
      if (!byNode.has(best.id)) byNode.set(best.id, []);
      byNode.get(best.id).push(w.id);
    }
    for (const [nodeId, ids] of byNode) push({ type: 'gather', units: ids, nodeId });
  }

  // ---------------------------------------------------------------- 建造
  pickBuilder(obs, workers, tx, ty) {
    let best = null;
    let bestD = 1e18;
    for (const w of workers) {
      if (w.order.type === 'build' || w.order.type === 'construct') continue;
      if (w.carrying > 0 && w.order.type === 'gather') continue;
      const d = (w.x - tx * T) ** 2 + (w.y - ty * T) ** 2;
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    if (best === null) {
      for (const w of workers) {
        if (w.order.type === 'build' || w.order.type === 'construct') continue;
        const d = (w.x - tx * T) ** 2 + (w.y - ty * T) ** 2;
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
    }
    return best;
  }

  orderDepot(obs, workers, area, push, canAfford) {
    const H = this.helpers;
    let spot = null;
    for (const s of area.spots) {
      if (this.bad.has('depot:' + s.x + ',' + s.y)) continue;
      if (H.canPlace('depot', s.x, s.y)) {
        spot = s;
        break;
      }
    }
    const first = area.spots.find((s) => !this.bad.has('depot:' + s.x + ',' + s.y));
    if (!first) return false;
    let builder = null;
    if (this.scout) {
      const sw = workers.find((w) => w.id === this.scout);
      if (sw && sw.order.type !== 'build' && sw.order.type !== 'construct') builder = sw;
    }
    if (!builder) builder = this.pickBuilder(obs, workers, first.x, first.y);
    if (!builder) return false;
    if (spot === null) {
      // 還沒探索：先走過去
      this.scout = builder.id;
      const mv = builder.order.type === 'move';
      if (!mv && (builder.x - first.x * T) ** 2 + (builder.y - first.y * T) ** 2 > (2 * T) ** 2) push({ type: 'move', units: [builder.id], x: first.x * T + 1000, y: first.y * T + 1000 });
      return 'scouting';
    }
    this.scout = builder.id;
    if (!canAfford) return 'ready';
    this.scout = null;
    return push({ type: 'build', workerId: builder.id, building: 'depot', tileX: spot.x, tileY: spot.y }) ? 'built' : 'ready';
  }

  crowded(obs, x, y, size, gap) {
    const D = this.data;
    for (const b of obs.myBuildings) {
      const s = D.stats.buildings[b.type].size;
      if (x - gap < b.tileX + s && x + size + gap > b.tileX && y - gap < b.tileY + s && y + size + gap > b.tileY) return true;
    }
    for (let ty = y - 1; ty <= y + size; ty++) {
      for (let tx = x - 1; tx <= x + size; tx++) {
        if (this.helpers.terrainAt(tx, ty) === 1) return true;
        if (this.nodeAt.has(ty * D.width + tx)) return true;
      }
    }
    return false;
  }

  orderBuild(obs, workers, type, push) {
    const spot = this.findSpotHome(obs, type);
    if (spot === null) return false;
    const builder = this.pickBuilder(obs, workers, spot.x, spot.y);
    if (!builder) return false;
    return push({ type: 'build', workerId: builder.id, building: type, tileX: spot.x, tileY: spot.y });
  }

  findSpotHome(obs, type) {
    const D = this.data;
    const H = this.helpers;
    const size = D.stats.buildings[type].size;
    const cx = this.baseTX + 1;
    const cy = this.baseTY + 1;
    for (let r = 3; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          const vx = (x + size / 2) * T - this.baseX;
          const vy = (y + size / 2) * T - this.baseY;
          if (vx * this.mineDirX + vy * this.mineDirY > 0) continue;
          if (this.bad.has(type + ':' + x + ',' + y)) continue;
          if (!H.canPlace(type, x, y)) continue;
          if (this.crowded(obs, x, y, size, 1)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  orderTower(obs, workers, area, push) {
    const H = this.helpers;
    const dep = obs.myBuildings.find((b) => b.id === area.depotId);
    if (!dep) return false;
    const cx = dep.tileX + 1;
    const cy = dep.tileY + 1;
    const sx = this.staging.x / T;
    const sy = this.staging.y / T;
    let best = null;
    let bestScore = 1e18;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (this.bad.has('tower:' + x + ',' + y)) continue;
        if (!H.canPlace('tower', x, y)) continue;
        if (this.crowded(obs, x, y, 1, 1)) continue;
        // 離礦點 ≥ 2 格，偏向集結點方向
        let nearNode = false;
        for (const n of area.nodes) {
          if (Math.abs(n.tileX - x) <= 1 && Math.abs(n.tileY - y) <= 1) nearNode = true;
        }
        if (nearNode) continue;
        const score = (x - sx) ** 2 + (y - sy) ** 2 + 0.5 * ((x - cx) ** 2 + (y - cy) ** 2);
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    if (best === null) return false;
    const builder = this.pickBuilder(obs, workers, best.x, best.y);
    if (!builder) return false;
    return push({ type: 'build', workerId: builder.id, building: 'tower', tileX: best.x, tileY: best.y });
  }

  resumeBuilds(obs, workers, push) {
    for (const b of obs.myBuildings) {
      if (b.complete) continue;
      const covered = workers.some((w) => (w.order.type === 'construct' && w.order.buildingId === b.id) || (w.order.type === 'build' && w.order.tileX === b.tileX && w.order.tileY === b.tileY));
      if (covered) continue;
      const builder = this.pickBuilder(obs, workers, b.tileX, b.tileY);
      if (builder) {
        push({ type: 'resume', workerId: builder.id, buildingId: b.id });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- 兵種
  nextUnitType(obs, army, K) {
    if (!this.produced) this.produced = { spear: 0, archer: 0, cavalry: 0 };
    const a = K.archerShare;
    // 敵方弓兵多 → 騎兵；其餘按比例
    let eArch = 0;
    let eAll = 0;
    for (const u of obs.enemyUnits) {
      if (u.type === 'worker') continue;
      eAll++;
      if (u.type === 'archer') eArch++;
    }
    let cavShare = 0;
    if (eAll >= 4 && eArch / eAll >= 0.5) cavShare = 25;
    const target = { spear: 100 - a - cavShare, archer: a, cavalry: cavShare };
    const total = this.produced.spear + this.produced.archer + this.produced.cavalry + 1;
    let best = 'spear';
    let bd = -1e9;
    for (const t of ['spear', 'archer', 'cavalry']) {
      const def = (target[t] * total) / 100 - this.produced[t];
      if (def > bd) {
        bd = def;
        best = t;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- 軍隊
  defend(obs, army, workers, push) {
    const D = this.data;
    const myB = obs.myBuildings;
    const threats = [];
    for (const e of obs.enemyUnits) {
      if (e.type === 'worker') continue;
      for (const b of myB) {
        const bx = b.tileX * T + 500;
        const by = b.tileY * T + 500;
        if ((e.x - bx) ** 2 + (e.y - by) ** 2 <= (12 * T) ** 2) {
          threats.push(e);
          break;
        }
      }
    }
    if (threats.length === 0) {
      this.defTarget = null;
      return;
    }
    let sx = 0;
    let sy = 0;
    let eh = 0;
    let ed = 0;
    for (const e of threats) {
      sx += e.x;
      sy += e.y;
      const st = D.stats.units[e.type];
      eh += e.hp;
      ed += st.attack / st.cooldown;
    }
    sx = Math.round(sx / threats.length);
    sy = Math.round(sy / threats.length);

    const home = army.filter((u) => this.isHome(u));
    let ah = 0;
    let ad = 0;
    for (const u of home) {
      const st = D.stats.units[u.type];
      ah += u.hp;
      ad += st.attack / st.cooldown;
    }
    // 民兵：兵力不足但加上附近工人可以贏時，工人一起上
    const wst = D.stats.units.worker;
    const near = workers.filter((w) => w.order.type !== 'build' && w.order.type !== 'construct' && (w.x - sx) ** 2 + (w.y - sy) ** 2 <= (13 * T) ** 2);
    let wh = 0;
    for (const w of near) wh += w.hp;
    const wd = (near.length * wst.attack) / wst.cooldown;
    const enemyS = eh * ed;
    const armyS = ah * ad;
    const allS = (ah + wh) * (ad + wd);
    if (near.length > 0 && armyS < 1.6 * enemyS && allS > 1.25 * enemyS) {
      // 以最靠近工人的敵人為目標
      let cx = 0;
      let cy = 0;
      for (const w of near) {
        cx += w.x;
        cy += w.y;
      }
      cx /= near.length;
      cy /= near.length;
      let tgt = null;
      let td = 1e18;
      for (const e of threats) {
        const d = (e.x - cx) ** 2 + (e.y - cy) ** 2;
        if (d < td) {
          td = d;
          tgt = e;
        }
      }
      const need = near.filter((w) => !(w.order.type === 'attack' && w.order.targetId === tgt.id));
      if (need.length > 0 && tgt) push({ type: 'attack', units: need.map((w) => w.id), targetId: tgt.id });
    }

    if (home.length === 0) return;
    const needs = home.filter((u) => !(u.order.type === 'attackMove' && (u.order.x - sx) ** 2 + (u.order.y - sy) ** 2 < (4 * T) ** 2));
    if (needs.length === 0) return;
    if (obs.tick - this.defTick < 20 && this.defTarget && (this.defTarget.x - sx) ** 2 + (this.defTarget.y - sy) ** 2 < (5 * T) ** 2) return;
    if (push({ type: 'attackMove', units: needs.map((u) => u.id), x: this.clampX(sx), y: this.clampY(sy) })) {
      this.defTarget = { x: sx, y: sy };
      this.defTick = obs.tick;
    }
  }

  clampX(x) {
    return Math.max(500, Math.min(this.data.width * T - 500, Math.round(x)));
  }
  clampY(y) {
    return Math.max(500, Math.min(this.data.height * T - 500, Math.round(y)));
  }

  // 單位是否算「留守」：距離己方集結點 / 基地不遠
  isHome(u) {
    if (!this.pushing) return true;
    return !this.pushIds || !this.pushIds.has(u.id);
  }

  controlArmy(obs, army, workers, push) {
    const K = obs.knobs;
    const tick = obs.tick;
    let supply = 0;
    for (const u of army) supply += u.type === 'cavalry' ? 2 : 1;
    const effPush = Math.max(8, Math.min(K.armyPush, 50 - Math.max(workers.length, K.workerTarget) - 1));
    const st = this.staging;

    if (!this.pushing) {
      if (supply >= effPush) {
        this.pushing = true;
        this.pushIds = new Set(army.map((u) => u.id));
        this.peak = supply;
        this.lastWave = tick;
      }
    }
    if (!this.pushing) {
      // 留守：閒置且離集結點太遠的單位走回集結點（沒有威脅時）
      if (this.defTarget === null) {
        const back = army.filter((u) => u.order.type === 'idle' && (u.x - st.x) ** 2 + (u.y - st.y) ** 2 > (7 * T) ** 2);
        if (back.length > 0) push({ type: 'attackMove', units: back.map((u) => u.id), x: st.x, y: st.y });
      }
      return;
    }

    // 出征中
    const target = this.pickTarget(obs, army);
    if (target === null) {
      this.pushing = false;
      return;
    }
    // 出征部隊 = pushIds 中仍存活者
    const alive = new Set(army.map((u) => u.id));
    for (const id of Array.from(this.pushIds)) if (!alive.has(id)) this.pushIds.delete(id);
    const pushers = army.filter((u) => this.pushIds.has(u.id));
    let pSupply = 0;
    for (const u of pushers) pSupply += u.type === 'cavalry' ? 2 : 1;
    if (pSupply > this.peak) this.peak = pSupply;

    // 增援：集結點附近閒置的非出征單位，累積 ≥ 4 隻就送出
    const reserve = army.filter((u) => !this.pushIds.has(u.id) && u.order.type === 'idle' && (u.x - st.x) ** 2 + (u.y - st.y) ** 2 < (8 * T) ** 2);
    if (reserve.length >= 4 || (reserve.length >= 1 && pushers.length === 0)) {
      for (const u of reserve) this.pushIds.add(u.id);
    }

    // 撤退：兵力剩太少
    if (pushers.length === 0 || (pSupply < this.peak * 0.4 && pSupply < effPush * 0.5)) {
      if (pushers.length > 0) push({ type: 'move', units: pushers.map((u) => u.id), x: st.x, y: st.y });
      this.pushing = false;
      this.pushIds = null;
      return;
    }

    const need = army.filter((u) => this.pushIds.has(u.id) && !(u.order.type === 'attackMove' && (u.order.x - target.x) ** 2 + (u.order.y - target.y) ** 2 < (3 * T) ** 2) && !(u.order.type === 'attack'));
    if (need.length > 0) {
      push({ type: 'attackMove', units: need.map((u) => u.id), x: this.clampX(target.x), y: this.clampY(target.y) });
    }
  }

  pickTarget(obs, army) {
    const alive = obs.alivePlayers.filter((p) => p !== this.me);
    if (alive.length === 0) return null;
    const known = obs.enemyBuildings.concat(obs.rememberedBuildings).filter((b) => alive.includes(b.owner));
    const st = this.staging;
    let best = null;
    let bestScore = 1e18;
    for (const b of known) {
      const bx = b.tileX * T + 500;
      const by = b.tileY * T + 500;
      let sc = (bx - st.x) ** 2 + (by - st.y) ** 2;
      if (b.type === 'base') sc *= 0.25;
      if (sc < bestScore) {
        bestScore = sc;
        best = { x: bx, y: by };
      }
    }
    if (best !== null) return best;
    // 沒有已知建築：去最近的、尚未探訪的存活敵方起點
    for (const s of this.enemyStarts) {
      if (!alive.includes(s.playerId)) continue;
      if (this.visited.has(s.playerId)) continue;
      if (army.some((u) => (u.x - s.x) ** 2 + (u.y - s.y) ** 2 < (5 * T) ** 2)) {
        this.visited.add(s.playerId);
        continue;
      }
      return { x: s.x, y: s.y };
    }
    return null;
  }
}
