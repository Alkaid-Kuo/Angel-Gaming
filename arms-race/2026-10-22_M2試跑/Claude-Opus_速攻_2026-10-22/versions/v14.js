// 速攻（Speed Rush）選手 Bot
// 策略：極早兵營 → 小批兵力集結 → 立刻壓進最近的敵方主堡，之後兵營持續補兵直線增援；
// 看不到敵方戰鬥單位時直接點主堡，力求在對手成形前結束比賽。

const TILE = 1000;
const COMBAT = ['spear', 'archer', 'cavalry'];
// 開局順序：B 兵營、D 主礦採集站、Wn 工人補到 n
const EXPAND_AT = 3400;
// 前線敵我戰力比超過此值即撤退重整（0 = 永不撤退）
const RETREAT_RATIO = 1.3;
// 估算前線戰力時敵方弓兵的權重（%）
const ARCHER_THREAT = 70;
// 礦量超過此值且兵營都在忙時加蓋兵營（上限 MAX_BARRACKS）
const FLOAT_AT = 300;
// 比賽時限（tick）
const MATCH_TICKS = 6000;
// 4 人局同一目標撤退幾次後換目標（0 = 不換）
const ROTATE_AFTER = 2;
// 家裡被壓境時全軍回防
const RECALL = true;
const MAX_BARRACKS = 6;
const OPENING = ['D', 'W5', 'B'];

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
    this.retreats = 0;
    this.nodeIdx = {};
    this.nodeIdxTick = -1;
    this.massNeed = 0;
    this.lastNeedDecay = 0;
    this.nodeAt = {};
    this.expansions = [];
    this.expWorker = -1;
    this.activeNodes = [];
    this.lastPos = {};
    this.side = {};
    this.openingDone = false;
    this.depotSpot = undefined;
  }

  declare() {
    return {
      name: 'SpeedRush',
      version: 'v14',
      style: '速攻：極早兵營、小批兵力立刻壓進敵方主堡，持續增援、直取主堡，力求在對手成形前結束比賽。',
      knobs: [
        { key: 'rushSize', name: '首波兵力', description: '戰鬥單位數達此值即發動第一波進攻（越小越早）', min: 2, max: 12, default: 5, integer: true },
        { key: 'workerCap', name: '工人上限', description: '主礦區的工人上限（越低越早轉兵）；開分礦後自動加額', min: 4, max: 16, default: 10, integer: true },
        { key: 'barracksCount', name: '兵營數', description: '前期兵營數量（越多出兵越快、經濟越吃緊）；之後礦量堆積時會自動加蓋', min: 1, max: 4, default: 2, integer: true },
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
    this.nodeAt = {};
    for (const n of data.mineNodes) this.nodeAt[n.tileY * data.width + n.tileX] = true;
    this.expansions = data.mineAreas
      .filter((a) => a.kind === 'expansion' && a.owner === data.me)
      .map((a) => {
        const ns = data.mineNodes.filter((n) => n.areaId === a.areaId);
        let sx = 0;
        let sy = 0;
        for (const n of ns) {
          sx += n.tileX;
          sy += n.tileY;
        }
        const cx = Math.floor(sx / Math.max(1, ns.length));
        const cy = Math.floor(sy / Math.max(1, ns.length));
        return { areaId: a.areaId, nodes: ns.map((n) => n.id), cx, cy, dist: helpers.pathDistance(slot.tileX + 1, slot.tileY + 1, cx, cy) };
      })
      .filter((e) => e.nodes.length > 0)
      .sort((a, b) => (a.dist < 0 ? 1e12 : a.dist) - (b.dist < 0 ? 1e12 : b.dist) || a.areaId - b.areaId);
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
    // 預熱：先跑一次選址等純函式，讓第一次 decide 不必付 JIT 成本（init 上限 1000 ms）
    try {
      const fake = { myBuildings: [], myUnits: [], mineNodes: [] };
      this.findSpot(fake, 'barracks');
      this.findSpot(fake, 'supply');
      this.findDepotSpot(fake);
      if (this.expansions.length > 0) this.depotSpotFor(this.expansions[0].nodes);
    } catch (e) {
      // 忽略
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

    // 0. 卡住的單位：側移後恢復原指令
    this.unstick(obs, push);

    // 0b. 敵方工人騷擾：沒有戰鬥單位在家時，以多打少用工人反擊
    this.workerDefense(obs, workers, push);

    // 1. 閒置工人去採礦
    this.assignWorkers(obs, workers, push);

    const pendingOf = (type) =>
      obs.myBuildings.filter((b) => b.type === type && !b.complete).length +
      workers.filter((w) => w.order.type === 'build' && w.order.building === type).length;
    const countOf = (type) => obs.myBuildings.filter((b) => b.type === type).length + workers.filter((w) => w.order.type === 'build' && w.order.building === type).length;
    const barracksTotal = countOf('barracks');
    const queuedWorkers = base.queue.filter((q) => q.unit === 'worker').length;
    const workerTotal = workers.length + queuedWorkers;

    // 未完工且無人施工的建築：接續
    this.resumeStalled(obs, workers, push);

    // 補給站：剩餘人口不夠下一輪生產時
    const producers = barracks.length;
    let supplyBlocked = false;
    const buffer = 2 + producers * 2;
    const supplyPending = pendingOf('supply');
    const capSoon = obs.supplyCap + supplyPending * 8;
    if (obs.supplyCap < 50 && capSoon - supplyUsed <= buffer && supplyPending < 2 && barracksTotal > 0) {
      if (minerals >= 80) {
        if (this.orderBuild(obs, workers, 'supply', push)) minerals -= 80;
      }
      else if (capSoon - supplyUsed <= 2) supplyBlocked = true;
    }
    if (supplyBlocked) minerals = -1;

    // 開局順序：依序完成，未完成前保留礦
    const plan = this.openingStep(obs, k, workerTotal, countOf);
    if (plan !== null) {
      if (plan === 'depot') {
        if (minerals >= 100) {
          if (this.depotSpot === undefined) this.depotSpot = this.findDepotSpot(obs);
          if (this.depotSpot === null) this.depotDone = true;
          else {
            const w = this.pickBuilder(workers, this.depotSpot.x * TILE, this.depotSpot.y * TILE);
            if (w && push({ type: 'build', workerId: w.id, building: 'depot', tileX: this.depotSpot.x, tileY: this.depotSpot.y })) minerals -= 100;
          }
        }
        minerals = Math.min(minerals, 0);
      } else if (plan === 'barracks') {
        if (k.proxyDistance > 0) {
          if (this.proxyBuild(obs, workers, minerals, push, k)) minerals -= 150;
        } else if (minerals >= 150) {
          if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
        }
        minerals = Math.min(minerals, 0);
      }
    }
    const trainWorker = () => {
      if (base.complete && base.queue.length === 0 && minerals >= 50 && supplyUsed + 1 <= obs.supplyCap) {
        if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
          minerals -= 50;
          supplyUsed += 1;
        }
      }
    };
    if (plan === 'worker' && readyBarracks.length === 0) {
      trainWorker();
      minerals = Math.min(minerals, 0);
    }

    // 時限前：佇列中趕不及完成的單位取消退款（未完成單位不計入資產分數）
    const queueEnd = (b) => {
      let t = obs.tick;
      for (const q of b.queue) t += Math.ceil(((100 - q.progress) * st.units[q.unit].trainTicks) / 100);
      return t;
    };
    if (obs.tick >= MATCH_TICKS - 400) {
      for (const b of obs.myBuildings) {
        if (!b.complete || b.queue.length === 0) continue;
        if (queueEnd(b) >= MATCH_TICKS - 2) {
          const last = b.queue[b.queue.length - 1];
          if (push({ type: 'cancel', buildingId: b.id })) {
            minerals += st.units[last.unit].cost;
            supplyUsed -= st.units[last.unit].supply;
          }
        }
      }
    }
    // 時限前：剩餘的礦換成來得及完工的補給站（已完工建築計入資產分數）
    if (obs.tick >= MATCH_TICKS - 700 && obs.tick <= MATCH_TICKS - 260 && minerals >= 80 && pendingOf('supply') < 4) {
      if (this.orderBuild(obs, workers, 'supply', push)) minerals -= 80;
    }

    // 2. 兵營生產（速攻靠持續出兵）
    for (const b of readyBarracks) {
      if (b.queue.length >= 2) continue;
      const type = this.nextUnitType(k);
      const us = st.units[type];
      if (minerals < us.cost || supplyUsed + us.supply > obs.supplyCap) continue;
      if (queueEnd(b) + us.trainTicks >= MATCH_TICKS - 2) continue;
      if (push({ type: 'train', buildingId: b.id, unit: type })) {
        this.produced[type] += 1;
        minerals -= us.cost;
        supplyUsed += us.supply;
      }
    }

    if (plan === 'worker' && readyBarracks.length > 0) {
      trainWorker();
      minerals = Math.min(minerals, 0);
    }


    // 其餘兵營
    if (plan === null && barracksTotal < k.barracksCount && minerals >= 150) {
      if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
    } else if (plan === null && minerals >= FLOAT_AT && barracksTotal < MAX_BARRACKS && pendingOf('barracks') === 0) {
      // 礦量堆積：加蓋兵營把礦轉成兵力
      if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
    }
    // 前置兵營蓋好後，工人回家採礦
    if (this.proxyWorker >= 0 && (this.openingDone || barracksTotal >= 1)) {
      const pw = workers.find((w) => w.id === this.proxyWorker);
      if (!pw || (pw.order.type !== 'build' && pw.order.type !== 'construct' && pw.order.type !== 'move')) this.proxyWorker = -1;
    }

    // 擴張：有卸貨點的礦剩不到 EXPAND_AT 時，在最近的分礦蓋採集站（主礦開採約 600 礦後就提早拉第二條礦線）
    const depots = obs.myBuildings.filter((b) => b.type === 'depot' || b.type === 'base');
    this.activeNodes = this.computeActiveNodes(obs, depots);
    if (plan === null) {
      if (this.expansionStep(obs, workers, minerals, push)) minerals -= 100;
    }
    const areas = Math.max(1, Math.ceil(this.activeNodes.length / 4));
    const effCap = Math.min(30, k.workerCap + (areas - 1) * Math.max(5, k.workerCap));

    // 工人
    if (plan === null && obs.tick + 125 < MATCH_TICKS && base.complete && base.queue.length === 0 && workerTotal < effCap && minerals >= 50 && supplyUsed + 1 <= obs.supplyCap) {
      if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
        minerals -= 50;
        supplyUsed += 1;
      }
    }

    // 5. 部隊
    this.armyControl(obs, army, readyBarracks, push, k);
    return cmds;
  }

  openingStep(obs, k, workerTotal, countOf) {
    if (this.openingDone) return null;
    let needB = 0;
    for (const it of OPENING) {
      if (it === 'B') {
        needB += 1;
        if (needB > k.barracksCount) continue;
        if (countOf('barracks') < needB) return 'barracks';
      } else if (it === 'D') {
        if (this.depotDone) continue;
        if (countOf('depot') >= 1) {
          this.depotDone = true;
          continue;
        }
        return 'depot';
      } else {
        const n = Math.min(parseInt(it.slice(1), 10), k.workerCap);
        if (workerTotal < n) return 'worker';
      }
    }
    this.openingDone = true;
    return null;
  }

  // 兩個單位在牆角正面相撞時會互相推擠卡死（尋路不考慮單位）：偵測後往側面移開再恢復原指令
  unstick(obs, push) {
    const alive = {};
    let used = false;
    for (const u of obs.myUnits) {
      alive[u.id] = true;
      const side = this.side[u.id];
      if (side !== undefined) {
        const arrived = u.order.type === 'idle' || obs.tick >= side.until;
        if (arrived && !used) {
          const o = side.order;
          let c = null;
          if (o.type === 'gather') c = { type: 'gather', units: [u.id], nodeId: o.nodeId };
          else if (o.type === 'build') c = { type: 'build', workerId: u.id, building: o.building, tileX: o.tileX, tileY: o.tileY };
          else if (o.type === 'move' || o.type === 'attackMove') c = { type: o.type, units: [u.id], x: o.x, y: o.y };
          if (c === null || push(c)) {
            delete this.side[u.id];
            used = true;
            this.lastPos[u.id] = { x: u.x, y: u.y, tick: obs.tick };
          }
        }
        continue;
      }
      const lp = this.lastPos[u.id];
      if (lp === undefined || (u.x - lp.x) ** 2 + (u.y - lp.y) ** 2 > 200 * 200) {
        this.lastPos[u.id] = { x: u.x, y: u.y, tick: obs.tick };
        continue;
      }
      if (obs.tick - lp.tick < 40 || used || u.type !== 'worker') continue;
      const o = u.order;
      let gx;
      let gy;
      if (o.type === 'move' || o.type === 'attackMove') {
        gx = o.x;
        gy = o.y;
      } else if (o.type === 'build') {
        gx = o.tileX * TILE + 500;
        gy = o.tileY * TILE + 500;
      } else if (o.type === 'gather' && u.type === 'worker') {
        const n = this.data.mineNodes.find((m) => m.id === o.nodeId);
        if (!n) continue;
        gx = n.tileX * TILE + 500;
        gy = n.tileY * TILE + 500;
        // 礦點旁排隊或開採中是正常的
        if ((u.x - gx) ** 2 + (u.y - gy) ** 2 <= 2200 * 2200 || obs.tick - lp.tick < 100) continue;
        // 回卸貨點途中
        if (u.carrying > 0) continue;
      } else continue;
      const dx = gx - u.x;
      const dy = gy - u.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1500) continue;
      const sgn = (u.id + Math.floor(obs.tick / 200)) % 2 === 0 ? 1 : -1;
      const px = u.x + Math.round((-dy / len) * 1500 * sgn - (dx / len) * 500);
      const py = u.y + Math.round((dx / len) * 1500 * sgn - (dy / len) * 500);
      const tx = Math.max(0, Math.min(this.W - 1, Math.floor(px / TILE)));
      const ty = Math.max(0, Math.min(this.H - 1, Math.floor(py / TILE)));
      if (push({ type: 'move', units: [u.id], x: tx * TILE + 500, y: ty * TILE + 500 })) {
        this.side[u.id] = { order: o, until: obs.tick + 25 };
        used = true;
      }
    }
    for (const id in this.lastPos) if (!alive[id]) delete this.lastPos[id];
    for (const id in this.side) if (!alive[id]) delete this.side[id];
  }

  readKnobs(kn) {
    const num = (v, d, lo, hi) => {
      const x = typeof v === 'number' && isFinite(v) ? v : d;
      return Math.max(lo, Math.min(hi, x));
    };
    return {
      rushSize: Math.round(num(kn.rushSize, 5, 2, 12)),
      workerCap: Math.round(num(kn.workerCap, 10, 4, 16)),
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
        const bx = b.tileX * TILE + 1000;
        const by = b.tileY * TILE + 1000;
        const isProxy = this.proxyX >= 0 && (bx - this.proxyX) ** 2 + (by - this.proxyY) ** 2 <= (10 * TILE) ** 2 && (bx - this.baseX) ** 2 + (by - this.baseY) ** 2 > (14 * TILE) ** 2;
        const rx = isProxy ? this.proxyX : this.stageX;
        const ry = isProxy ? this.proxyY : this.stageY;
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
      // 撤退後的重整門檻隨時間遞減回首波兵力
      if (this.massNeed > k.rushSize && obs.tick - this.lastNeedDecay >= 150) {
        this.massNeed -= 1;
        this.lastNeedDecay = obs.tick;
      }
      const need = Math.max(k.rushSize, Math.min(this.massNeed, 24));
      const capped = obs.supplyUsed >= Math.min(50, obs.supplyCap) - 1 && obs.supplyCap >= 26;
      if ((army.length >= need || capped) && this.targetPid >= 0) {
        this.phase = 'attack';
        if (push({ type: 'attackMove', units: army.map((u) => u.id), x: this.targetX, y: this.targetY })) this.lastFullOrder = this.decisions;
      }
      return;
    }

    // attack phase：家裡被大軍壓境且守軍不足 → 全軍回防（對方主堡快倒時除外）
    if (RECALL) {
      const U = this.data.stats.units;
      const HR2 = (15 * TILE) ** 2;
      let invPow = 0;
      let ix = 0;
      let iy = 0;
      let ic = 0;
      for (const e of obs.enemyUnits) {
        if (e.type === 'worker') continue;
        if ((e.x - this.baseX) ** 2 + (e.y - this.baseY) ** 2 > HR2) continue;
        invPow += (U[e.type].cost * e.hp) / U[e.type].hp;
        ix += e.x;
        iy += e.y;
        ic += 1;
      }
      let homePow = 0;
      for (const u of atHome) homePow += (U[u.type].cost * u.hp) / U[u.type].hp;
      const tb0 = this.targetBuilding(obs);
      const nearKill = tb0 !== null && tb0.hp < 500;
      if (ic > 0 && invPow >= 150 && invPow > homePow && !nearKill) {
        const away = army.filter((u) => !atHome.includes(u));
        if (away.length > 0 && push({ type: 'attackMove', units: army.map((u) => u.id), x: Math.round(ix / ic), y: Math.round(iy / ic) })) {
          this.phase = 'mass';
          this.massNeed = Math.max(k.rushSize, army.length);
          this.lastNeedDecay = obs.tick;
          this.lastDefTick = obs.tick;
          return;
        }
      }
    }
    // attack phase：前線兵力明顯不如對方時撤回集結點，與援軍會合後再壓上
    if (RETREAT_RATIO > 0) {
      const pw = this.frontPower(obs, army);
      if (pw.enemy > 0 && pw.enemy > pw.mine * RETREAT_RATIO) {
        const away = army.filter((u) => (u.x - this.baseX) ** 2 + (u.y - this.baseY) ** 2 > (16 * TILE) ** 2);
        if (away.length > 0 && push({ type: 'move', units: away.map((u) => u.id), x: this.stageX, y: this.stageY })) {
          this.phase = 'mass';
          this.massNeed = Math.max(k.rushSize, Math.ceil(pw.enemyCount * 1.5) + 1, army.length + 2);
          // 4 人局：同一目標連續撤退多次就換打別家
          this.retreats += 1;
          if (ROTATE_AFTER > 0 && this.retreats >= ROTATE_AFTER && obs.alivePlayers.length > 2) {
            const alive = this.enemies.filter((e) => obs.alivePlayers.includes(e.pid));
            const i = alive.findIndex((e) => e.pid === this.targetPid);
            const nx = alive[(i + 1) % alive.length];
            if (nx && nx.pid !== this.targetPid) {
              this.targetPid = nx.pid;
              this.targetX = nx.x;
              this.targetY = nx.y;
              this.expIdx = 0;
              this.retreats = 0;
            }
          }
          this.lastNeedDecay = obs.tick;
          return;
        }
      }
    }
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

  workerDefense(obs, workers, push) {
    const R2 = (12 * TILE) ** 2;
    const raiders = obs.enemyUnits.filter((e) => (e.x - this.baseX) ** 2 + (e.y - this.baseY) ** 2 <= R2);
    if (raiders.length === 0) return;
    // 有敵方戰鬥單位時不拉工人（打不過，交給部隊）
    if (raiders.some((e) => e.type !== 'worker')) return;
    const myArmyHome = obs.myUnits.some((u) => u.type !== 'worker' && (u.x - this.baseX) ** 2 + (u.y - this.baseY) ** 2 <= R2);
    if (myArmyHome) return;
    const attacked = obs.events.some((ev) => ev.type === 'underAttack' && raiders.some((r) => r.id === ev.attackerId));
    if (!attacked && !workers.some((w) => w.order.type === 'attack')) return;
    // 敵方工人數少時每名派 2 人，多時全員迎戰；集中打血最少的
    const target = raiders.slice().sort((a, b) => a.hp - b.hp || a.id - b.id)[0];
    const busy = workers.filter((w) => w.order.type === 'attack' && raiders.some((r) => r.id === w.order.targetId)).length;
    const want = (raiders.length >= 2 ? workers.length : Math.min(workers.length, 2)) - busy;
    if (want <= 0) return;
    const pick = workers
      .filter((w) => w.order.type !== 'attack' && w.order.type !== 'construct')
      .sort((a, b) => ((a.x - target.x) ** 2 + (a.y - target.y) ** 2) - ((b.x - target.x) ** 2 + (b.y - target.y) ** 2) || a.id - b.id)
      .slice(0, want)
      .map((w) => w.id);
    if (pick.length > 0) push({ type: 'attack', units: pick, targetId: target.id });
  }

  // 前線交戰評估：離家較遠的我方部隊 vs 其附近看得到的敵方戰鬥單位與防禦塔（成本 × 血量比例）
  frontPower(obs, army) {
    const U = this.data.stats.units;
    const far = army.filter((u) => (u.x - this.baseX) ** 2 + (u.y - this.baseY) ** 2 > (16 * TILE) ** 2);
    const R2 = (11 * TILE) ** 2;
    let enemy = 0;
    let enemyCount = 0;
    const engaged = {};
    for (const e of obs.enemyUnits) {
      if (e.type === 'worker') continue;
      let close = false;
      for (const u of far) {
        if ((u.x - e.x) ** 2 + (u.y - e.y) ** 2 <= R2) {
          close = true;
          engaged[u.id] = true;
        }
      }
      if (!close) continue;
      const st = U[e.type];
      // 弓兵血薄、被長槍兵貼身就倒：威脅打七折，避免被射程嚇退
      enemy += (((st.cost * e.hp) / st.hp) * (e.type === 'archer' ? ARCHER_THREAT : 100)) / 100;
      enemyCount += 1;
    }
    for (const b of obs.enemyBuildings) {
      if (b.type !== 'tower' || !b.complete) continue;
      const tx = b.tileX * TILE + 500;
      const ty = b.tileY * TILE + 500;
      let close = false;
      for (const u of far) {
        if ((u.x - tx) ** 2 + (u.y - ty) ** 2 <= R2) {
          close = true;
          engaged[u.id] = true;
        }
      }
      if (!close) continue;
      enemy += (220 * b.hp) / 600;
      enemyCount += 2;
    }
    let mine = 0;
    if (enemy > 0) {
      for (const u of army) {
        // 交戰中的單位＋離交戰單位 8 格內的友軍
        let inFight = engaged[u.id] === true;
        if (!inFight) {
          for (const v of far) {
            if (engaged[v.id] && (u.x - v.x) ** 2 + (u.y - v.y) ** 2 <= (8 * TILE) ** 2) {
              inFight = true;
              break;
            }
          }
        }
        if (!inFight) continue;
        const st = U[u.type];
        mine += (st.cost * u.hp) / st.hp;
      }
    }
    return { enemy, mine, enemyCount };
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
      this.retreats = 0;
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
    const live = this.activeNodes.length > 0 ? this.activeNodes : this.mainNodes.filter((id) => {
      const n = this.nodeView(obs, id);
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
      if (w.order.type !== 'idle' || w.id === this.proxyWorker || w.id === this.expWorker) continue;
      let best = live[0];
      for (const id of live) if (count.get(id) < count.get(best)) best = id;
      count.set(best, count.get(best) + 1);
      const list = byNode.get(best);
      if (list === undefined) byNode.set(best, [w.id]);
      else list.push(w.id);
    }
    for (const [nodeId, ids] of byNode) push({ type: 'gather', units: ids, nodeId });
    // 再平衡：礦點人數差 ≥ 2 時移一名
    let hi = live[0];
    let lo = live[0];
    for (const id of live) {
      if (count.get(id) > count.get(hi)) hi = id;
      if (count.get(id) < count.get(lo)) lo = id;
    }
    if (count.get(hi) - count.get(lo) >= 3 || (count.get(lo) === 0 && count.get(hi) >= 2 && !this.mainNodes.includes(lo))) {
      const w = workers.find((x) => x.order.type === 'gather' && x.order.nodeId === hi && x.carrying === 0 && x.id !== this.proxyWorker) || workers.find((x) => x.order.type === 'gather' && x.order.nodeId === hi && x.id !== this.proxyWorker);
      if (w) push({ type: 'gather', units: [w.id], nodeId: lo });
    }
  }

  // 礦點觀察資料（每次決策建一次索引）
  nodeView(obs, id) {
    if (this.nodeIdxTick !== obs.tick) {
      this.nodeIdx = {};
      for (const m of obs.mineNodes) this.nodeIdx[m.id] = m;
      this.nodeIdxTick = obs.tick;
    }
    return this.nodeIdx[id];
  }

  // 有卸貨點（主堡或採集站在附近）且未枯竭的一般礦點
  computeActiveNodes(obs, depots) {
    const res = [];
    for (const n of this.data.mineNodes) {
      if (n.rich) continue;
      const cur = this.nodeView(obs, n.id);
      if (!cur || cur.reserve <= 0) continue;
      let ok = false;
      for (const d of depots) {
        if (!d.complete) continue;
        const sz = d.type === 'base' ? 3 : 2;
        const dx = Math.max(d.tileX - n.tileX, 0, n.tileX - (d.tileX + sz - 1));
        const dy = Math.max(d.tileY - n.tileY, 0, n.tileY - (d.tileY + sz - 1));
        if (dx <= 7 && dy <= 7) {
          ok = true;
          break;
        }
      }
      if (ok) res.push(n.id);
    }
    return res;
  }

  // 分礦採集站：派工人過去，到了再找位置
  expansionStep(obs, workers, minerals, push) {
    const reserveOf = (id) => {
      const n = this.nodeView(obs, id);
      return n ? n.reserve : 0;
    };
    let activeLeft = 0;
    for (const id of this.activeNodes) activeLeft += reserveOf(id);
    if (activeLeft > EXPAND_AT) {
      this.expWorker = -1;
      return false;
    }
    let exp = null;
    for (const e of this.expansions) {
      const anyActive = e.nodes.some((id) => this.activeNodes.includes(id));
      let left = 0;
      for (const id of e.nodes) left += reserveOf(id);
      if (anyActive || left <= 0) continue;
      const near = (x, y) => Math.abs(x - e.cx) <= 6 && Math.abs(y - e.cy) <= 6;
      const pending = obs.myBuildings.some((b) => b.type === 'depot' && !b.complete && near(b.tileX, b.tileY)) || workers.some((w) => w.order.type === 'build' && w.order.building === 'depot' && near(w.order.tileX, w.order.tileY));
      if (pending) return false;
      exp = e;
      break;
    }
    if (exp === null) return false;
    const tx = exp.cx * TILE + 500;
    const ty = exp.cy * TILE + 500;
    let w = workers.find((x) => x.id === this.expWorker);
    if (!w || w.order.type === 'gather' || w.order.type === 'construct') {
      if (minerals < 40) return false;
      w = this.pickBuilder(workers, tx, ty);
      if (!w) return false;
      if (push({ type: 'move', units: [w.id], x: tx, y: ty })) this.expWorker = w.id;
      return false;
    }
    if (w.order.type === 'build') return false;
    if ((w.x - tx) ** 2 + (w.y - ty) ** 2 > (4 * TILE) ** 2) {
      if (w.order.type !== 'move') push({ type: 'move', units: [w.id], x: tx, y: ty });
      return false;
    }
    if (minerals < 100) return false;
    const spot = this.depotSpotFor(exp.nodes);
    if (!spot) return false;
    return push({ type: 'build', workerId: w.id, building: 'depot', tileX: spot.x, tileY: spot.y });
  }

  // 採集站四周留 1 格走道：周圍一圈不可有礦點或阻擋地形（貼著礦點會讓工人卡死）
  depotRingBlocked(x, y) {
    for (let ty = y - 1; ty <= y + 2; ty++) {
      for (let tx = x - 1; tx <= x + 2; tx++) {
        if (tx >= x && tx <= x + 1 && ty >= y && ty <= y + 1) continue;
        if (this.h.terrainAt(tx, ty) === 1) return true;
        if (this.nodeAt[ty * this.W + tx]) return true;
      }
    }
    return false;
  }

  depotSpotFor(nodeIds) {
    const nodes = this.data.mineNodes.filter((n) => nodeIds.includes(n.id));
    let best = null;
    let bestS = Infinity;
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
    for (let y = minY - 3; y <= maxY + 2; y++) {
      for (let x = minX - 3; x <= maxX + 2; x++) {
        if (!this.h.canPlace('depot', x, y)) continue;
        if (this.depotRingBlocked(x, y)) continue;
        let sc = 0;
        for (const n of nodes) {
          const cx = n.tileX + 0.5;
          const cy = n.tileY + 0.5;
          const dx = Math.max(x - cx, 0, cx - (x + 2));
          const dy = Math.max(y - cy, 0, cy - (y + 2));
          sc += Math.sqrt(dx * dx + dy * dy);
        }
        if (sc < bestS) {
          bestS = sc;
          best = { x, y };
        }
      }
    }
    return best;
  }

  pickBuilder(workers, x, y) {
    let best = null;
    let bestD = Infinity;
    for (const w of workers) {
      if (w.order.type === 'build' || w.order.type === 'construct') continue;
      if (w.id === this.proxyWorker || w.id === this.expWorker) continue;
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
        if (this.depotRingBlocked(x, y)) continue;
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
    for (let ty = y - 1; ty <= y + size; ty++) {
      for (let tx = x - 1; tx <= x + size; tx++) {
        if (this.nodeAt[ty * this.W + tx]) return true;
      }
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
