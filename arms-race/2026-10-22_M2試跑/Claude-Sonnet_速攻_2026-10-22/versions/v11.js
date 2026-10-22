// 速攻 Bot：早期雙兵營、小規模經濟，量到 rushSize 即全軍壓上，持續增援，先殺戰鬥單位再直擊主堡。
const TILE = 1000;
const CFG = { open1: 7, open2: 7, supBase: 3, supPer: 0, wave: 2, waveMax: 8, waveMul: 1.0, memory: 300, homeR: 16, recallAt: 4, finishHp: 450, recallHold: 80, oldTarget: 1, retreat: 1, retreatRatio: 0.8, retreatMax: 24, needMul: 1.0, retreatHold: 40, needMulT: 2.6, retreatHoldT: 400, towerPower: 2, autoFight: 2, expandAt: 900, expandMinTick: 1500, towerPenalty: 25000, towerNeedA: 3, towerNeedB: 3, saveB2: 0, theatre: 14, dmgPerUnit: 30, preWorkers: 7, unitsFirst: 0, b2AfterLaunch: 0 };

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
    this.expAreas = [];
    this.expSpot = null;
    this.expFailTick = -1000;
    this.enemyStarts = [];
    this.armyIds = new Set();
    this.launched = false;
    this.badSpots = new Set();
    this.lastSupplyTick = -1000;
    this.lastDefenseTick = -1000;
    this.mode = 'march';
    this.enemySeen = [];
    this.need = 0;
    this.holdUntil = 0;
    this.retreats = 0;
    this.retarget = false;
    this.curTarget = null;
    this.recalling = false;
    this.lastHomeTick = -1000;
    this.homeAt = null;
    this.produced = { spear: 0, archer: 0, cavalry: 0 };
  }

  declare() {
    return {
      name: 'Blitz',
      version: 'v11',
      style: '速攻：早期雙兵營、精簡經濟，湊足 rushSize 即全軍壓上，持續增援，先殺戰鬥單位再直擊主堡。',
      knobs: [
        { key: 'rushSize', name: '出擊兵力', description: '戰鬥單位人口達此值即全軍出擊（越小越早壓上）', min: 3, max: 24, default: 3, integer: true },
        { key: 'workerCap', name: '工人上限', description: '主堡生產工人的上限（出擊前先養到前期上限，出擊後補到此值）', min: 5, max: 16, default: 12, integer: true },
        { key: 'barracksCount', name: '兵營數量', description: '同時擁有的兵營數量目標', min: 1, max: 3, default: 3, integer: true },
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
    this.expAreas = [];
    for (const a of data.mineAreas) {
      if (a.kind !== 'expansion' || a.owner !== data.me) continue;
      const ns = data.mineNodes.filter((n) => n.areaId === a.areaId);
      if (ns.length === 0) continue;
      let ex = 0;
      let ey = 0;
      for (const n of ns) {
        ex += n.tileX + 0.5;
        ey += n.tileY + 0.5;
      }
      ex /= ns.length;
      ey /= ns.length;
      const d = helpers.pathDistance(slot.tileX + 1, slot.tileY + 1, Math.floor(ex), Math.floor(ey));
      this.expAreas.push({ areaId: a.areaId, nodeIds: ns.map((n) => n.id), cx: ex, cy: ey, dist: d < 0 ? 1e9 : d });
    }
    this.expAreas.sort((p, q) => p.dist - q.dist || p.areaId - q.areaId);
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

    // 以下為嚴格優先序採購：買不起的項目會擋住後面的項目（存錢）
    const wantBarracks = Math.max(1, Math.min(3, Math.round(knobs.barracksCount)));
    const haveBarracks = barracks.length + obs.myUnits.filter((u) => u.order.type === 'build' && u.order.building === 'barracks').length;
    const baseQ = base.queue;
    const workerCount = workers.length + baseQ.filter((q) => q.unit === 'worker').length;
    const cWorkers = Math.max(1, Math.min(24, Math.round(knobs.workerCap)));
    const baseReady = base.complete && (baseQ.length === 0 || (baseQ.length === 1 && baseQ[0].progress >= 85));
    const trainWorker = () => {
      if (!baseReady || minerals < 50 || supplyUsed + 1 > cap) return false;
      if (push({ type: 'train', buildingId: base.id, unit: 'worker' })) {
        minerals -= 50;
        supplyUsed += 1;
        return true;
      }
      return false;
    };
    const free = cap - supplyUsed;

    // A. 開局工人
    if (workerCount < CFG.open1) {
      if (trainWorker()) return this.trainUnits(obs, doneBarracks, minerals, supplyUsed, cap, push);
      if (minerals < 50 && baseReady) return;
    }
    // B. 第一座兵營
    if (haveBarracks === 0) {
      if (minerals >= 150) {
        if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
      } else {
        return; // 存錢
      }
    }
    // C. 補給站
    const supNeed = CFG.supBase + CFG.supPer * doneBarracks.length;
    if (cap < 50 && pendingSupply === 0 && free <= supNeed) {
      if (minerals >= 80) {
        if (this.orderBuild(obs, workers, 'supply', push)) {
          minerals -= 80;
          pendingSupply++;
        }
      } else {
        return;
      }
    } else if (cap < 50 && free <= 1 && pendingSupply < 2 && minerals >= 80 && obs.tick - this.lastSupplyTick > 20) {
      if (this.orderBuild(obs, workers, 'supply', push)) {
        minerals -= 80;
        pendingSupply++;
        this.lastSupplyTick = obs.tick;
      }
    }
    const mAfter = this.expandStep(obs, workers, minerals, push);
    if (mAfter < 0) return;
    minerals = mAfter;
    // D. 工人補到上限（出擊前只養 preWorkers 個，出擊後補到 workerCap）
    const effCap = this.launched ? cWorkers : Math.min(cWorkers, CFG.preWorkers);
    if (CFG.unitsFirst && doneBarracks.length > 0 && !this.launched) {
      // 兵營完工後，出擊前先出兵再補工人
      const before = this.produced.spear + this.produced.archer + this.produced.cavalry;
      const unitsNow = obs.myUnits.filter((u) => u.type !== 'worker').length;
      if (unitsNow < knobs.rushSize + 1) {
        const n0 = push.__count ? 0 : 0;
        this.trainUnits(obs, doneBarracks, minerals, supplyUsed, cap, push);
        const after = this.produced.spear + this.produced.archer + this.produced.cavalry;
        if (after > before) return;
      }
    }
    if (workerCount < effCap) {
      if (trainWorker()) return this.trainUnits(obs, doneBarracks, minerals, supplyUsed, cap, push);
    }
    // E. 其餘兵營
    if (haveBarracks < wantBarracks && workerCount >= Math.min(CFG.open2, effCap) && (this.launched || !CFG.b2AfterLaunch)) {
      if (minerals >= 150) {
        if (this.orderBuild(obs, workers, 'barracks', push)) minerals -= 150;
      } else if (CFG.saveB2) {
        return;
      }
    }
    // F. 戰鬥單位
    this.trainUnits(obs, doneBarracks, minerals, supplyUsed, cap, push);
  }

  trainUnits(obs, doneBarracks, minerals, supplyUsed, cap, push) {
    const stats = this.data.stats;
    for (const b of doneBarracks) {
      const q = b.queue;
      if (!(q.length === 0 || (q.length === 1 && q[0].progress >= 85))) continue;
      const type = this.nextUnitType(obs.knobs);
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
    const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
    const idSet = new Set(combat.map((u) => u.id));
    for (const id of this.armyIds) if (!idSet.has(id)) this.armyIds.delete(id);
    const army = combat.filter((u) => this.armyIds.has(u.id));
    const fresh = combat.filter((u) => !this.armyIds.has(u.id));
    const freshSupply = fresh.reduce((s, u) => s + sup(u), 0);
    const target = this.pickTarget(obs, army);
    if (target === null) return;

    // ---- 本營威脅
    const homeEnemies = obs.enemyUnits.filter((e) => e.type !== 'worker' && d2(e.x, e.y, this.baseX, this.baseY) <= (CFG.homeR * TILE) ** 2);
    const alarm = homeEnemies.length;
    if (alarm > 0) {
      this.lastHomeTick = obs.tick;
      let hx = 0;
      let hy = 0;
      for (const e of homeEnemies) {
        hx += e.x;
        hy += e.y;
      }
      hx = Math.round(hx / alarm);
      hy = Math.round(hy / alarm);
      this.homeAt = { x: hx, y: hy };
      // 留守新兵就地迎擊
      if (fresh.length > 0) {
        const todo = fresh.filter((u) => !(u.order.type === 'attackMove' && d2(u.order.x, u.order.y, hx, hy) < (4 * TILE) ** 2));
        if (todo.length > 0 && obs.tick - this.lastDefenseTick >= 20) {
          if (push({ type: 'attackMove', units: todo.map((u) => u.id), x: hx, y: hy })) this.lastDefenseTick = obs.tick;
        }
      }
      // 大軍壓境：召回外出部隊（除非對方主堡快倒了）
      if (this.launched && army.length > 0 && alarm >= CFG.recallAt) {
        let finishing = false;
        for (const eb of obs.enemyBuildings) {
          if (eb.type === 'base' && eb.hp < CFG.finishHp && army.some((u) => d2(u.x, u.y, eb.tileX * TILE + 1500, eb.tileY * TILE + 1500) <= (12 * TILE) ** 2)) finishing = true;
        }
        if (!finishing) this.recalling = true;
      }
    }
    if (this.recalling) {
      if (obs.tick - this.lastHomeTick > CFG.recallHold || alarm === 0 && army.every((u) => d2(u.x, u.y, this.baseX, this.baseY) < (12 * TILE) ** 2) && obs.tick - this.lastHomeTick > 20) {
        this.recalling = false;
      } else {
        const at = this.homeAt || { x: this.baseX, y: this.baseY };
        const todo = army.filter((u) => !(u.order.type === 'attackMove' && d2(u.order.x, u.order.y, at.x, at.y) < (5 * TILE) ** 2));
        if (todo.length > 0) push({ type: 'attackMove', units: todo.map((u) => u.id), x: at.x, y: at.y });
        return;
      }
    }

    if (!this.launched) {
      if (freshSupply >= knobs.rushSize && alarm === 0) {
        this.launched = true;
        for (const u of fresh) this.armyIds.add(u.id);
        push({ type: 'attackMove', units: fresh.map((u) => u.id), x: target.x, y: target.y });
      } else if (alarm === 0) {
        this.defend(obs, combat, push);
      }
      return;
    }

    // 敵軍強度：我軍附近的敵方戰鬥單位（以人口計）；記憶近 N tick 的峰值
    let seen = 0;
    let nTowers = 0;
    const engaged = [];
    if (army.length > 0) {
      const near = obs.enemyUnits.filter((e) => e.type !== 'worker' && army.some((u) => d2(u.x, u.y, e.x, e.y) <= (14 * TILE) ** 2));
      const nearT = obs.enemyBuildings.filter((b) => b.type === 'tower' && b.complete && army.some((u) => d2(u.x, u.y, b.tileX * TILE + 500, b.tileY * TILE + 500) <= (13 * TILE) ** 2));
      nTowers = nearT.length;
      seen = near.reduce((a, e) => a + (e.type === 'cavalry' ? 2 : 1), 0) + CFG.towerPower * nearT.length;
      if (near.length > 0 || nearT.length > 0) {
        for (const u of army) {
          if (near.some((e) => d2(u.x, u.y, e.x, e.y) <= (14 * TILE) ** 2) || nearT.some((b) => d2(u.x, u.y, b.tileX * TILE + 500, b.tileY * TILE + 500) <= (13 * TILE) ** 2)) engaged.push(u);
        }
      }
    }
    this.enemySeen.push({ tick: obs.tick, n: seen });
    while (this.enemySeen.length > 0 && obs.tick - this.enemySeen[0].tick > CFG.memory) this.enemySeen.shift();
    let peak = 0;
    for (const r of this.enemySeen) if (r.n > peak) peak = r.n;
    // 打不過就撤：被明顯壓過且部隊不大，撤回本營與新兵會合，下次湊更大一波
    if (CFG.retreat && seen > 0 && engaged.length > 0) {
      const M = engaged.reduce((a, u) => a + sup(u), 0);
      let finishing = false;
      for (const eb of obs.enemyBuildings) if (eb.type === 'base' && eb.hp < CFG.finishHp) finishing = true;
      if (!finishing && seen >= CFG.retreatRatio * M + 1 && M <= CFG.retreatMax) {
        for (const u of engaged) this.armyIds.delete(u.id);
        push({ type: 'move', units: engaged.map((u) => u.id), x: this.baseX, y: this.baseY });
        const tw = nTowers > 0;
        this.need = Math.min(24, Math.ceil(seen * (tw ? CFG.needMulT : CFG.needMul)) + 2);
        this.holdUntil = obs.tick + (tw ? CFG.retreatHoldT : CFG.retreatHold);
        this.retreats++;
        this.retarget = true;
        return;
      }
    }
    // 增援：新單位湊滿一批才派出；批量隨敵軍強度提高（避免零星送死）
    const waveSize = Math.min(CFG.waveMax, Math.max(CFG.wave, Math.ceil(peak * CFG.waveMul)));
    const tw = this.towersOf(obs, target.playerId);
    const needT = tw > 0 ? Math.min(24, CFG.towerNeedA * tw + CFG.towerNeedB) : 0;
    const needFresh = army.length === 0 ? Math.max(Math.min(CFG.waveMax + 2, Math.max(knobs.rushSize, this.need, Math.ceil(peak * CFG.waveMul) + 1)), needT) : waveSize;
    if (fresh.length > 0 && freshSupply >= needFresh && alarm === 0 && obs.tick >= this.holdUntil) {
      for (const u of fresh) this.armyIds.add(u.id);
      push({ type: 'attackMove', units: fresh.map((u) => u.id), x: target.x, y: target.y });
    } else if (army.length === 0 && alarm === 0) {
      this.defend(obs, combat, push);
    }
    const front = army;
    if (front.length === 0) return;
    this.fight(obs, front, target, push);
  }

  // 戰場：就近單位分配集火（威脅優先、其餘直擊主堡）
  fight(obs, army, target, push) {
    const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
    const T2 = (tiles) => (tiles * TILE) ** 2;
    const enemyCombat = obs.enemyUnits.filter((e) => e.type !== 'worker');
    const bldPos = (b) => ({ x: b.tileX * TILE + 500, y: b.tileY * TILE + 500 });
    // 戰區單位：靠近目標基地，或附近有敵軍戰鬥單位
    const theatre = [];
    const marching = [];
    for (const u of army) {
      let inT = dist2(u.x, u.y, target.x, target.y) <= T2(CFG.theatre);
      if (!inT) for (const e of enemyCombat) if (dist2(u.x, u.y, e.x, e.y) <= T2(10)) { inT = true; break; }
      (inT ? theatre : marching).push(u);
    }
    const idleMarch = marching.filter((u) => u.order.type === 'idle');
    if (idleMarch.length > 0) push({ type: 'attackMove', units: idleMarch.map((u) => u.id), x: target.x, y: target.y });
    if (theatre.length === 0) return;
    let cx = 0;
    let cy = 0;
    for (const u of theatre) {
      cx += u.x;
      cy += u.y;
    }
    cx /= theatre.length;
    cy /= theatre.length;
    // 威脅：戰區附近的敵方戰鬥單位
    const threats = enemyCombat
      .filter((e) => dist2(e.x, e.y, cx, cy) <= T2(14) || theatre.some((u) => dist2(u.x, u.y, e.x, e.y) <= T2(9)))
      .sort((p, q) => dist2(p.x, p.y, cx, cy) - dist2(q.x, q.y, cx, cy) || p.id - q.id);
    if (CFG.autoFight > 0 && threats.length >= CFG.autoFight) {
      // 敵軍多時交給引擎自動索敵（姿態 aggressive 的 attackMove）
      let tx = 0;
      let ty = 0;
      for (const e of threats) {
        tx += e.x;
        ty += e.y;
      }
      tx = Math.round(tx / threats.length);
      ty = Math.round(ty / threats.length);
      const todo = theatre.filter((u) => !(u.order.type === 'attackMove' && dist2(u.order.x, u.order.y, tx, ty) < T2(6)));
      if (todo.length > 0) push({ type: 'attackMove', units: todo.map((u) => u.id), x: tx, y: ty });
      return;
    }
    // 建築目標
    let bestB = null;
    let bestScore = Infinity;
    for (const b of obs.enemyBuildings) {
      const p = bldPos(b);
      if (dist2(p.x, p.y, cx, cy) > T2(16)) continue;
      let pri = b.type === 'base' ? 1 : b.type === 'tower' ? (b.complete && dist2(p.x, p.y, cx, cy) <= T2(9) ? 0 : 3.5) : b.type === 'barracks' ? 2 : 3;
      if (b.type === 'base' && b.hp < CFG.finishHp) pri = -1;
      const sc = pri * 1e12 + dist2(p.x, p.y, cx, cy);
      if (sc < bestScore) {
        bestScore = sc;
        bestB = b;
      }
    }
    const assign = new Map(); // unitId -> targetId | 'move'
    const free = new Map(theatre.map((u) => [u.id, u]));
    const threatById = new Map(threats.map((e) => [e.id, e]));
    const need = new Map(threats.map((e) => [e.id, Math.max(2, Math.ceil(e.hp / CFG.dmgPerUnit))]));
    // 黏著：已在打某威脅的單位維持
    for (const u of theatre) {
      if (u.order.type === 'attack' && threatById.has(u.order.targetId) && need.get(u.order.targetId) > 0) {
        assign.set(u.id, u.order.targetId);
        need.set(u.order.targetId, need.get(u.order.targetId) - 1);
        free.delete(u.id);
      }
    }
    for (const e of threats) {
      let n = need.get(e.id);
      if (n <= 0 || free.size === 0) continue;
      const cand = [...free.values()].sort((p, q) => dist2(p.x, p.y, e.x, e.y) - dist2(q.x, q.y, e.x, e.y) || p.id - q.id);
      for (const u of cand) {
        if (n <= 0) break;
        assign.set(u.id, e.id);
        free.delete(u.id);
        n--;
      }
    }
    for (const u of free.values()) assign.set(u.id, bestB !== null ? bestB.id : 'move');
    // 依目標分組發令（只對命令不同者）
    const groups = new Map();
    for (const u of theatre) {
      const t = assign.get(u.id);
      if (t === 'move') {
        if (u.order.type === 'idle') {
          if (!groups.has('move')) groups.set('move', []);
          groups.get('move').push(u.id);
        }
        continue;
      }
      if (u.order.type === 'attack' && u.order.targetId === t) continue;
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(u.id);
    }
    // 威脅組優先發令
    const keys = [...groups.keys()].sort((p, q) => (threatById.has(p) ? 0 : 1) - (threatById.has(q) ? 0 : 1));
    for (const k of keys) {
      if (k === 'move') push({ type: 'attackMove', units: groups.get(k), x: target.x, y: target.y });
      else push({ type: 'attack', units: groups.get(k), targetId: k });
    }
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

  towersOf(obs, owner) {
    const ids = new Set();
    for (const b of obs.enemyBuildings) if (b.owner === owner && b.type === 'tower' && b.complete) ids.add(b.id);
    for (const b of obs.rememberedBuildings) if (b.owner === owner && b.type === 'tower' && b.complete) ids.add(b.id);
    return ids.size;
  }

  pickTarget(obs, army) {
    const alive = obs.alivePlayers.filter((p) => p !== this.me);
    if (this.curTarget !== null && alive.includes(this.curTarget.playerId) && !this.retarget) return this.curTarget;
    this.retarget = false;
    {
      let bestS = null;
      let bestV = Infinity;
      for (const st of this.enemyStarts) {
        if (!alive.includes(st.playerId)) continue;
        const v = (st.dist < 0 ? 1e9 : st.dist) + CFG.towerPenalty * this.towersOf(obs, st.playerId);
        if (v < bestV) {
          bestV = v;
          bestS = st;
        }
      }
      if (bestS === null) return null;
      this.curTarget = { x: bestS.x, y: bestS.y, playerId: bestS.playerId };
      return this.curTarget;
    }
    if (CFG.oldTarget) {
      const st0 = this.enemyStarts.find((st) => alive.includes(st.playerId));
      if (st0 === undefined) return null;
      this.curTarget = { x: st0.x, y: st0.y, playerId: st0.playerId };
      return this.curTarget;
    }
    // 重新選：以部隊（或本營）位置為起點、路徑距離最近的存活敵人
    let fx = this.baseTileX + 1;
    let fy = this.baseTileY + 1;
    if (army.length > 0) {
      let cx = 0;
      let cy = 0;
      for (const u of army) {
        cx += u.x;
        cy += u.y;
      }
      fx = Math.floor(cx / army.length / TILE);
      fy = Math.floor(cy / army.length / TILE);
    }
    let best = null;
    let bestD = Infinity;
    for (const st of this.enemyStarts) {
      if (!alive.includes(st.playerId)) continue;
      let d = this.helpers.pathDistance(fx, fy, Math.floor(st.x / TILE), Math.floor(st.y / TILE));
      if (d < 0) d = 1e9 + (st.x - fx * TILE) ** 2 / 1e6;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    if (best === null) return null;
    this.curTarget = { x: best.x, y: best.y, playerId: best.playerId };
    return this.curTarget;
  }

  depotNear(obs, area, completeOnly) {
    for (const b of obs.myBuildings) {
      if (b.type !== 'depot') continue;
      if (completeOnly && !b.complete) continue;
      if ((b.tileX + 1 - area.cx) ** 2 + (b.tileY + 1 - area.cy) ** 2 <= 36) return true;
    }
    return false;
  }

  // 主礦快採完時，在最近的己方分礦區蓋採集站，讓閒置工人轉過去（只在後期、錢有剩時）
  expandStep(obs, workers, minerals, push) {
    if (this.expAreas.length === 0 || obs.tick < CFG.expandMinTick) return minerals;
    let remain = 0;
    for (const id of this.mainNodeIds) {
      const n = obs.mineNodes.find((x) => x.id === id);
      if (n !== undefined) remain += n.reserve;
    }
    if (remain > CFG.expandAt) return minerals;
    const area = this.expAreas.find((a) => a.nodeIds.some((id) => {
      const n = obs.mineNodes.find((x) => x.id === id);
      return n !== undefined && n.reserve > 0;
    }));
    if (area === undefined) return minerals;
    if (this.depotNear(obs, area, false)) return minerals;
    if (workers.some((w) => w.order.type === 'build' && w.order.building === 'depot')) return minerals;
    if (obs.tick - this.expFailTick < 100) return minerals;
    if (minerals < 100) return -1; // 存錢
    // 找採集站位置：礦區中心附近、可建造、可達
    let best = null;
    let bestD = Infinity;
    const cx = Math.floor(area.cx);
    const cy = Math.floor(area.cy);
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = (x + 1 - area.cx) ** 2 + (y + 1 - area.cy) ** 2;
        if (d >= bestD) continue;
        if (!this.helpers.canPlace('depot', x, y)) continue;
        if (this.helpers.pathDistance(this.baseTileX + 1, this.baseTileY + 1, x, y) < 0) continue;
        bestD = d;
        best = { x, y };
      }
    }
    if (best === null) {
      this.expFailTick = obs.tick;
      return minerals;
    }
    const cands = workers.filter((w) => w.order.type !== 'build' && w.order.type !== 'construct');
    if (cands.length === 0) return minerals;
    let bw = cands[0];
    let bs = Infinity;
    for (const w of cands) {
      const sc = (w.x - (best.x + 1) * TILE) ** 2 + (w.y - (best.y + 1) * TILE) ** 2 + (w.carrying > 0 ? 4e7 : 0);
      if (sc < bs) {
        bs = sc;
        bw = w;
      }
    }
    if (push({ type: 'build', workerId: bw.id, building: 'depot', tileX: best.x, tileY: best.y })) {
      this.expFailTick = obs.tick;
      return minerals - 100;
    }
    return minerals;
  }

  assignWorkers(obs, workers, push) {
    const alive = (id) => {
      const n = obs.mineNodes.find((x) => x.id === id);
      return n !== undefined && n.reserve > 0;
    };
    let live = this.mainNodeIds.filter(alive);
    for (const area of this.expAreas) {
      if (this.depotNear(obs, area, true)) live = live.concat(area.nodeIds.filter(alive));
    }
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
