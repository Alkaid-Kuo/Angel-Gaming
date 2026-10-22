// 速攻 Bot：早期雙兵營、小規模經濟，量到 rushSize 即全軍壓上，持續增援，先殺戰鬥單位再直擊主堡。
const TILE = 1000;

export default class RushBot {
  constructor() {
    this.data = null;
    this.helpers = null;
    this.me = -1;
    this.baseTileX = 0;
    this.baseTileY = 0;
    this.baseX = 0;
    this.baseY = 0;
    this.mineDirX = 0;
    this.mineDirY = 0;
    this.mainNodeIds = [];
    this.enemyStarts = [];
    this.armyIds = new Set();
    this.launched = false;
    this.badSpots = new Set();
    this.lastSupplyTick = -1000;
    this.lastDefenseTick = -1000;
    this.mode = 'march';
    this.produced = { spear: 0, archer: 0, cavalry: 0 };
  }

  declare() {
    return {
      name: 'Blitz',
      version: 'v1',
      style: '速攻：早期雙兵營、精簡經濟，湊足 rushSize 即全軍壓上，持續增援，先殺戰鬥單位再直擊主堡。',
      knobs: [
        { key: 'rushSize', name: '出擊兵力', description: '戰鬥單位人口達此值即全軍出擊', min: 3, max: 24, default: 8, integer: true },
        { key: 'workerCap', name: '工人上限', description: '主堡生產工人的上限', min: 5, max: 16, default: 10, integer: true },
        { key: 'barracksCount', name: '兵營數量', description: '同時擁有的兵營數量目標', min: 1, max: 3, default: 2, integer: true },
        { key: 'archerRatio', name: '弓兵比例', description: '兵營產出中弓兵的比例（%）', min: 0, max: 40, default: 0, integer: true },
        { key: 'cavalryRatio', name: '騎兵比例', description: '兵營產出中騎兵的比例（%），其餘為長槍兵', min: 0, max: 30, default: 0, integer: true },
      ],
    };
  }

  init(data, helpers) {
    this.data = data;
    this.helpers = helpers;
    this.me = data.me;
    const slot = data.startSlots.find((s) => s.playerId === data.me);
    this.baseTileX = slot.tileX;
    this.baseTileY = slot.tileY;
    this.baseX = slot.tileX * TILE + 1500;
    this.baseY = slot.tileY * TILE + 1500;
    const mainArea = data.mineAreas.find((a) => a.kind === 'main' && a.owner === data.me);
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

  decide(obs) {
    const cmds = [];
    const budget = obs.commandBudget;
    const push = (c) => {
      if (cmds.length >= budget) return false;
      cmds.push(c);
      return true;
    };
    try {
      this.run(obs, push);
    } catch (e) {
      // 例外不讓整次決策作廢
    }
    return cmds;
  }

  run(obs, push) {
    const knobs = obs.knobs;
    const stats = this.data.stats;
    const workers = obs.myUnits.filter((u) => u.type === 'worker');
    const combat = obs.myUnits.filter((u) => u.type !== 'worker');
    const bases = obs.myBuildings.filter((b) => b.type === 'base');
    const base = bases.find((b) => b.complete) || bases[0];
    if (base === undefined) return;
    const barracks = obs.myBuildings.filter((b) => b.type === 'barracks');
    const doneBarracks = barracks.filter((b) => b.complete);

    // 在途建造（工人已受命但尚未扣款）需保留礦
    let reserved = 0;
    let pendingSupply = obs.myBuildings.filter((b) => b.type === 'supply' && !b.complete).length;
    let pendingBarracks = barracks.filter((b) => !b.complete).length;
    for (const w of workers) {
      if (w.order.type === 'build') {
        reserved += stats.buildings[w.order.building].cost;
        if (w.order.building === 'supply') pendingSupply++;
        if (w.order.building === 'barracks') pendingBarracks++;
      }
    }
    let minerals = obs.minerals - reserved;
    let supplyUsed = obs.supplyUsed;
    let cap = obs.supplyCap;

    // 1. 閒置工人採集
    this.assignWorkers(obs, workers, push);

    // 2. 防守 / 進攻
    this.armyStep(obs, combat, push);

    // 3. 補給站
    const free = cap - supplyUsed;
    const nBarr = barracks.length + pendingBarracks - barracks.filter((b) => !b.complete).length;
    const wantSupply = free <= (doneBarracks.length >= 2 ? 6 : 4) && cap < 50;
    if (wantSupply && pendingSupply === 0 && minerals >= 80) {
      if (this.orderBuild(obs, workers, 'supply', push)) {
        minerals -= 80;
        pendingSupply++;
      }
    } else if (free <= 2 && cap < 50 && pendingSupply < 2 && minerals >= 80 && obs.tick - this.lastSupplyTick > 20) {
      if (this.orderBuild(obs, workers, 'supply', push)) {
        minerals -= 80;
        pendingSupply++;
        this.lastSupplyTick = obs.tick;
      }
    }

    // 4. 兵營
    const wantBarracks = Math.max(1, Math.min(3, Math.round(knobs.barracksCount)));
    const haveBarracks = barracks.length + obs.myUnits.filter((u) => u.order.type === 'build' && u.order.building === 'barracks').length;
    const workerCount = workers.length + base.queue.filter((q) => q.unit === 'worker').length;
    const barracksOpenWorkers = haveBarracks === 0 ? 6 : 8;
    let blockAll = false;
    if (haveBarracks < wantBarracks && workerCount >= barracksOpenWorkers) {
      if (minerals >= 150) {
        if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
      } else {
        blockAll = true; // 存錢蓋兵營
      }
    }

    // 5. 工人
    const baseQ = base.queue;
    const cWorkers = Math.max(1, Math.min(24, Math.round(knobs.workerCap)));
    if (base.complete && workerCount < cWorkers && (baseQ.length === 0 || (baseQ.length === 1 && baseQ[0].progress >= 85)) && minerals >= 50 && supplyUsed + 1 <= cap && !(blockAll && barracks.length === 0 && workerCount >= 6)) {
      if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
        minerals -= 50;
        supplyUsed += 1;
      }
    }

    // 6. 戰鬥單位
    for (const b of doneBarracks) {
      const q = b.queue;
      if (!(q.length === 0 || (q.length === 1 && q[0].progress >= 85))) continue;
      const type = this.nextUnitType(knobs);
      const st = stats.units[type];
      if (minerals < st.cost || supplyUsed + st.supply > cap) continue;
      if (push({ type: 'train', buildingId: b.id, unit: type })) {
        this.produced[type] += 1;
        minerals -= st.cost;
        supplyUsed += st.supply;
      }
    }
  }

  armyStep(obs, combat, push) {
    const knobs = obs.knobs;
    const sup = (u) => (u.type === 'cavalry' ? 2 : 1);
    const idSet = new Set(combat.map((u) => u.id));
    for (const id of this.armyIds) if (!idSet.has(id)) this.armyIds.delete(id);
    const target = this.pickTarget(obs);
    if (target === null) return;
    const army = combat.filter((u) => this.armyIds.has(u.id));
    const fresh = combat.filter((u) => !this.armyIds.has(u.id));
    const freshSupply = fresh.reduce((s, u) => s + sup(u), 0);

    if (!this.launched) {
      if (freshSupply >= knobs.rushSize) {
        this.launched = true;
        for (const u of fresh) this.armyIds.add(u.id);
        push({ type: 'attackMove', units: fresh.map((u) => u.id), x: target.x, y: target.y });
      } else {
        this.defend(obs, combat, push);
      }
      return;
    }

    // 增援：新單位湊滿一小波才派出
    const waveSize = 2;
    if (fresh.length > 0 && (freshSupply >= waveSize || army.length === 0)) {
      for (const u of fresh) this.armyIds.add(u.id);
      push({ type: 'attackMove', units: fresh.map((u) => u.id), x: target.x, y: target.y });
      return;
    }
    if (army.length === 0) return;

    // 戰場判斷
    let cx = 0;
    let cy = 0;
    for (const u of army) {
      cx += u.x;
      cy += u.y;
    }
    cx /= army.length;
    cy /= army.length;
    const near = (x, y, tiles) => (x - cx) ** 2 + (y - cy) ** 2 <= (tiles * TILE) ** 2;
    const enemyCombat = obs.enemyUnits.filter((e) => e.type !== 'worker' && near(e.x, e.y, 10));
    const enemyBld = obs.enemyBuildings.filter((b) => near(b.tileX * TILE + 500, b.tileY * TILE + 500, 12));

    if (enemyCombat.length === 0 && enemyBld.length > 0) {
      // 直擊建築：主堡優先，其次生產建築，其次最近
      let best = null;
      let bestScore = Infinity;
      for (const b of enemyBld) {
        const pri = b.type === 'base' ? 0 : b.type === 'barracks' ? 1 : b.type === 'tower' ? 2 : 3;
        const d = (b.tileX * TILE + 500 - cx) ** 2 + (b.tileY * TILE + 500 - cy) ** 2;
        const score = pri * 1e12 + d;
        if (score < bestScore) {
          bestScore = score;
          best = b;
        }
      }
      const todo = army.filter((u) => !(u.order.type === 'attack' && u.order.targetId === best.id));
      if (todo.length > 0) push({ type: 'attack', units: todo.map((u) => u.id), targetId: best.id });
      return;
    }
    // 其他情況：攻擊移動；idle 或正在打建築但有敵軍時重下
    const todo = army.filter((u) => u.order.type === 'idle' || (u.order.type === 'attack' && enemyCombat.length > 0) || (u.order.type === 'attackMove' && (Math.abs(u.order.x - target.x) > 3000 || Math.abs(u.order.y - target.y) > 3000)));
    if (todo.length > 0) push({ type: 'attackMove', units: todo.map((u) => u.id), x: target.x, y: target.y });
  }

  defend(obs, combat, push) {
    if (combat.length === 0 || obs.tick - this.lastDefenseTick < 40) return;
    const r2 = (15 * TILE) ** 2;
    for (const ev of obs.events) {
      if (ev.type !== 'underAttack') continue;
      const b = obs.myBuildings.find((x) => x.id === ev.targetId);
      let px = null;
      let py = null;
      if (b !== undefined) {
        px = b.tileX * TILE + 500;
        py = b.tileY * TILE + 500;
      } else {
        const u = obs.myUnits.find((x) => x.id === ev.targetId);
        if (u !== undefined) {
          px = u.x;
          py = u.y;
        }
      }
      if (px === null) continue;
      if ((px - this.baseX) ** 2 + (py - this.baseY) ** 2 > r2) continue;
      if (push({ type: 'attackMove', units: combat.map((u) => u.id), x: px, y: py })) {
        this.lastDefenseTick = obs.tick;
        return;
      }
    }
  }

  pickTarget(obs) {
    const alive = obs.alivePlayers;
    const start = this.enemyStarts.find((s) => alive.includes(s.playerId));
    if (start === undefined) return null;
    return { x: start.x, y: start.y, playerId: start.playerId };
  }

  assignWorkers(obs, workers, push) {
    const live = this.mainNodeIds.filter((id) => {
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
      if (w.order.type !== 'idle') continue;
      let best = live[0];
      for (const id of live) if (count.get(id) < count.get(best)) best = id;
      count.set(best, count.get(best) + 1);
      const list = byNode.get(best);
      if (list === undefined) byNode.set(best, [w.id]);
      else list.push(w.id);
    }
    for (const [nodeId, ids] of byNode) push({ type: 'gather', units: ids, nodeId });
  }

  orderBuild(obs, workers, type, push) {
    const cands = workers.filter((w) => w.order.type !== 'build' && w.order.type !== 'construct');
    if (cands.length === 0) return false;
    const spot = this.findSpot(obs, type);
    if (spot === null) return false;
    const sx = (spot.x + 0.5) * TILE;
    const sy = (spot.y + 0.5) * TILE;
    let best = null;
    let bestScore = Infinity;
    for (const w of cands) {
      const d = (w.x - sx) ** 2 + (w.y - sy) ** 2;
      const score = d + (w.carrying > 0 ? 4e7 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = w;
      }
    }
    return push({ type: 'build', workerId: best.id, building: type, tileX: spot.x, tileY: spot.y });
  }

  findSpot(obs, type) {
    const data = this.data;
    const helpers = this.helpers;
    const size = data.stats.buildings[type].size;
    const cx = this.baseTileX + 1;
    const cy = this.baseTileY + 1;
    for (let r = 3; r <= 11; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (this.badSpots.has(x + ',' + y)) continue;
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

  crowded(obs, x, y, size) {
    const data = this.data;
    for (const b of obs.myBuildings) {
      const s = data.stats.buildings[b.type].size;
      if (x - 1 < b.tileX + s && x + size + 1 > b.tileX && y - 1 < b.tileY + s && y + size + 1 > b.tileY) return true;
    }
    for (const u of obs.myUnits) {
      if (u.order.type === 'build') {
        const s = data.stats.buildings[u.order.building].size;
        if (x - 1 < u.order.tileX + s && x + size + 1 > u.order.tileX && y - 1 < u.order.tileY + s && y + size + 1 > u.order.tileY) return true;
      }
    }
    for (let ty = y - 1; ty <= y + size; ty++) {
      for (let tx = x - 1; tx <= x + size; tx++) {
        if (this.helpers.terrainAt(tx, ty) === 1) return true;
      }
    }
    return false;
  }

  nextUnitType(knobs) {
    const arch = Math.max(0, Math.min(100, knobs.archerRatio));
    const cav = Math.max(0, Math.min(100 - arch, knobs.cavalryRatio));
    const target = { spear: 100 - arch - cav, archer: arch, cavalry: cav };
    const total = this.produced.spear + this.produced.archer + this.produced.cavalry + 1;
    let best = 'spear';
    let bestDeficit = -Infinity;
    for (const t of ['spear', 'archer', 'cavalry']) {
      const deficit = (target[t] * total) / 100 - this.produced[t];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = t;
      }
    }
    return best;
  }
}
