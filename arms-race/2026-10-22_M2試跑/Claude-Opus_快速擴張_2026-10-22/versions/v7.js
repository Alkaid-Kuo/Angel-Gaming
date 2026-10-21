// 快速擴張（Expander）：優先擴張與經濟，以後期兵力碾壓。
// 單一檔案、ES2020、不 import。

const TILE = 1000;
const HALF = 500;
const COMBAT = ['spear', 'archer', 'cavalry'];
const UNIT_COST = { worker: 50, spear: 60, archer: 70, cavalry: 100 };
const UNIT_SUPPLY = { worker: 1, spear: 1, archer: 1, cavalry: 2 };
const UNIT_HP = { worker: 40, spear: 120, archer: 60, cavalry: 150 };
const BCOST = { base: 400, depot: 100, supply: 80, barracks: 150, tower: 120 };
const BSIZE = { base: 3, depot: 2, supply: 1, barracks: 2, tower: 1 };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function d2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export default class ExpanderBot {
  constructor() {
    this.data = null;
    this.helpers = null;
    this.me = -1;
    this.mode = '1v1';
    this.W = 0;
    this.H = 0;
    this.tiles = null;
    this.nodeTile = null;
    this.nodeInfo = new Map();
    this.baseTX = 0;
    this.baseTY = 0;
    this.baseX = 0;
    this.baseY = 0;
    this.mineDirX = 0;
    this.mineDirY = 0;
    this.mainArea = null;
    this.expansions = [];
    this.enemyStarts = [];
    this.defX = 0;
    this.defY = 0;
    this.enemySeen = new Map();
    this.attacking = false;
    this.targetX = 0;
    this.targetY = 0;
    this.targetPlayer = -1;
    this.lastArmyOrder = -1000;
    this.lastDefOrder = -1000;
    this.lastRebalance = 0;
    this.lastReinforce = 0;
    this.expBuilder = new Map();
    this.produced = { spear: 0, archer: 0, cavalry: 0 };
    this.rallySet = new Set();
    this.threatUntil = -1;
    this.danger = new Map();
    this.enemyBarracks = new Set();
    this.rushAlert = false;
  }

  reservedSet() {
    const s = new Set(this.expBuilder.values());
    return s;
  }

  declare() {
    return {
      name: 'Expander',
      version: 'v7',
      style: '快速擴張：工人 10 名即以採集站搶下兩座分礦，三礦區經濟堆到人口上限後，以長槍兵為主的大軍碾壓；隘口塔與分礦塔守家，被 rush 時拉工人協防。',
      knobs: [
        { key: 'expandWorkers', name: '擴張時機', description: '工人數達此值即派工人去第一座分礦蓋採集站（越小越貪）', min: 8, max: 20, default: 10, integer: true },
        { key: 'secondExpandWorkers', name: '第二分礦時機', description: '工人數達此值即佔第二座分礦（不會早於第一座）', min: 12, max: 32, default: 16, integer: true },
        { key: 'workerTarget', name: '工人目標', description: '全場工人數上限（經濟規模）', min: 16, max: 40, default: 28, integer: true },
        { key: 'attackSupply', name: '總攻兵力', description: '戰鬥單位人口達此值即全軍出擊；人口將滿時也會出擊', min: 12, max: 44, default: 28, integer: true },
        { key: 'towersPerExpansion', name: '分礦防禦塔', description: '每座分礦旁要蓋的防禦塔數量', min: 0, max: 3, default: 1, integer: true },
      ],
    };
  }

  init(data, helpers) {
    this.data = data;
    this.helpers = helpers;
    this.me = data.me;
    this.mode = data.mode;
    this.W = data.width;
    this.H = data.height;
    this.tiles = data.tiles;
    this.nodeTile = new Uint8Array(this.W * this.H);
    for (const n of data.mineNodes) {
      this.nodeTile[n.tileY * this.W + n.tileX] = 1;
      this.nodeInfo.set(n.id, n);
    }
    const slot = data.startSlots.find((s) => s.playerId === data.me);
    this.baseTX = slot.tileX;
    this.baseTY = slot.tileY;
    this.baseX = slot.tileX * TILE + 1500;
    this.baseY = slot.tileY * TILE + 1500;

    const mkArea = (a) => {
      const nodes = data.mineNodes.filter((n) => n.areaId === a.areaId);
      let cx = 0;
      let cy = 0;
      for (const n of nodes) {
        cx += n.tileX * TILE + HALF;
        cy += n.tileY * TILE + HALF;
      }
      cx /= nodes.length;
      cy /= nodes.length;
      return { areaId: a.areaId, kind: a.kind, nodes: nodes.map((n) => n.id), cx, cy, site: null, baseId: -1, dist: 0, towers: [] };
    };
    const main = data.mineAreas.find((a) => a.kind === 'main' && a.owner === data.me);
    this.mainArea = mkArea(main);
    this.mineDirX = this.mainArea.cx - this.baseX;
    this.mineDirY = this.mainArea.cy - this.baseY;

    const exps = data.mineAreas.filter((a) => a.kind === 'expansion' && a.owner === data.me).map(mkArea);
    for (const e of exps) {
      e.site = this.findSite(e, 'depot', false, null);
      e.baseSite = this.findSite(e, 'base', false, null);
      if (e.site !== null) {
        const d = helpers.pathDistance(this.baseTX + 1, this.baseTY + 1, e.site.x + 1, e.site.y + 1);
        e.dist = d < 0 ? 1e9 : d;
      } else e.dist = 1e9;
    }
    exps.sort((a, b) => a.dist - b.dist || a.areaId - b.areaId);
    this.expansions = exps;

    this.enemyStarts = data.startSlots
      .filter((s) => s.playerId !== data.me)
      .map((s) => {
        const d = helpers.pathDistance(slot.tileX + 1, slot.tileY + 1, s.tileX + 1, s.tileY + 1);
        return { playerId: s.playerId, x: s.tileX * TILE + 1500, y: s.tileY * TILE + 1500, dist: d < 0 ? 1e9 : d };
      })
      .sort((a, b) => a.dist - b.dist || a.playerId - b.playerId);

    // 防守集結點：主基地往地圖中心路徑上、離主堡約 15 格處（隘口外）
    const path = this.bfsPath(this.baseTX + 1, this.baseTY + 1, Math.floor(this.W / 2), Math.floor(this.H / 2));
    this.defX = this.baseX;
    this.defY = this.baseY;
    this.chokeX = this.baseX;
    this.chokeY = this.baseY;
    let gotChoke = false;
    let gotInner = false;
    this.innerX = this.baseX;
    this.innerY = this.baseY;
    for (const t of path) {
      const px = t[0] * TILE + HALF;
      const py = t[1] * TILE + HALF;
      const dd = d2(px, py, this.baseX, this.baseY);
      if (!gotInner && dd >= 7 * 7 * TILE * TILE) {
        this.innerX = px;
        this.innerY = py;
        gotInner = true;
      }
      if (!gotChoke && dd >= 12 * 12 * TILE * TILE) {
        this.chokeX = px;
        this.chokeY = py;
        gotChoke = true;
      }
      if (dd >= 15 * 15 * TILE * TILE) {
        this.defX = px;
        this.defY = py;
        break;
      }
      this.defX = px;
      this.defY = py;
    }
    this.outerX = this.defX;
    this.outerY = this.defY;
    if (!gotInner) {
      this.innerX = this.defX;
      this.innerY = this.defY;
    }
    this.defOuter = true;
  }

  passable(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return false;
    const i = y * this.W + x;
    return this.tiles[i] !== 1 && this.nodeTile[i] === 0;
  }

  bfsPath(sx, sy, tx, ty) {
    const W = this.W;
    const N = W * this.H;
    const prev = new Int32Array(N).fill(-2);
    const q = new Int32Array(N);
    let qh = 0;
    let qt = 0;
    const s = sy * W + sx;
    prev[s] = -1;
    q[qt++] = s;
    let best = s;
    let bestD = d2(sx, sy, tx, ty);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    while (qh < qt) {
      const c = q[qh++];
      const cx = c % W;
      const cy = (c - cx) / W;
      const dd = d2(cx, cy, tx, ty);
      if (dd < bestD) {
        bestD = dd;
        best = c;
      }
      if (cx === tx && cy === ty) break;
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.passable(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (!this.passable(cx + dx, cy) || !this.passable(cx, cy + dy))) continue;
        const ni = ny * W + nx;
        if (prev[ni] !== -2) continue;
        prev[ni] = c;
        q[qt++] = ni;
      }
    }
    const out = [];
    let c = best;
    while (c >= 0) {
      const cx = c % W;
      out.push([cx, (c - cx) / W]);
      c = prev[c];
    }
    out.reverse();
    return out;
  }

  /** 在礦區旁找建築位置（與礦點至少隔 1 格）；useCanPlace 時以 canPlace 驗證 */
  findSite(area, type, useCanPlace, obs) {
    const size = BSIZE[type];
    const nodes = area.nodes.map((id) => this.nodeInfo.get(id));
    const ctx = Math.floor(area.cx / TILE);
    const cty = Math.floor(area.cy / TILE);
    let best = null;
    let bestScore = Infinity;
    for (let ty = cty - 9; ty <= cty + 9; ty++) {
      for (let tx = ctx - 9; tx <= ctx + 9; tx++) {
        let ok = true;
        for (let yy = ty; yy < ty + size && ok; yy++) {
          for (let xx = tx; xx < tx + size; xx++) {
            if (xx < 0 || yy < 0 || xx >= this.W || yy >= this.H) {
              ok = false;
              break;
            }
            const i = yy * this.W + xx;
            if (this.tiles[i] !== 0 || this.nodeTile[i] !== 0) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue;
        let minGap = 99;
        let score = 0;
        const bcx = tx * TILE + HALF * size;
        const bcy = ty * TILE + HALF * size;
        for (const n of nodes) {
          const gx = n.tileX < tx ? tx - n.tileX : n.tileX > tx + size - 1 ? n.tileX - tx - size + 1 : 0;
          const gy = n.tileY < ty ? ty - n.tileY : n.tileY > ty + size - 1 ? n.tileY - ty - size + 1 : 0;
          const g = Math.max(gx, gy);
          if (g < minGap) minGap = g;
          score += Math.sqrt(d2(bcx, bcy, n.tileX * TILE + HALF, n.tileY * TILE + HALF));
        }
        if (minGap < 2) continue;
        if (d2(bcx, bcy, area.cx, area.cy) > 6 * 6 * TILE * TILE) continue;
        if (useCanPlace && !this.helpers.canPlace(type, tx, ty)) continue;
        if (obs && this.crowdedB(obs, tx, ty, size)) continue;
        if (score < bestScore) {
          bestScore = score;
          best = { x: tx, y: ty };
        }
      }
    }
    return best;
  }

  crowdedB(obs, x, y, size) {
    for (const b of obs.myBuildings) {
      const s = BSIZE[b.type];
      if (x - 1 < b.tileX + s && x + size + 1 > b.tileX && y - 1 < b.tileY + s && y + size + 1 > b.tileY) return true;
    }
    return false;
  }

  decide(obs) {
    const cmds = [];
    const budget = obs.commandBudget;
    const push = (c) => {
      if (cmds.length >= budget) return false;
      cmds.push(c);
      return true;
    };
    const k = obs.knobs || {};
    const knob = (key, lo, hi, def) => {
      const v = k[key];
      return typeof v === 'number' && isFinite(v) ? clamp(Math.round(v), lo, hi) : def;
    };
    const K = {
      expandWorkers: knob('expandWorkers', 8, 20, 10),
      secondExpandWorkers: knob('secondExpandWorkers', 12, 32, 16),
      workerTarget: knob('workerTarget', 16, 40, 28),
      attackSupply: knob('attackSupply', 12, 44, 28),
      towersPerExpansion: knob('towersPerExpansion', 0, 3, 1),
    };
    this.K = K;
    const tick = obs.tick;

    const workers = [];
    const army = [];
    for (const u of obs.myUnits) {
      if (u.type === 'worker') workers.push(u);
      else army.push(u);
    }
    const bld = { base: [], depot: [], supply: [], barracks: [], tower: [] };
    for (const b of obs.myBuildings) bld[b.type].push(b);
    const completeBases = bld.base.filter((b) => b.complete);
    if (bld.base.length === 0) return cmds;

    // 敵方單位紀錄（兵種組成）
    for (const e of obs.enemyUnits) {
      if (e.type !== 'worker') this.enemySeen.set(e.id, e.type);
    }

    // 已承諾的建造成本（工人已接單但尚未開工）
    let pendingCost = 0;
    const pendingBuild = { base: 0, depot: 0, supply: 0, barracks: 0, tower: 0 };
    for (const w of workers) {
      if (w.order.type === 'build') {
        pendingCost += BCOST[w.order.building];
        pendingBuild[w.order.building] += 1;
      }
    }
    let minerals = obs.minerals - pendingCost;
    let supplyUsed = obs.supplyUsed;

    // 分礦狀態：區內的卸貨點（主堡／採集站）
    for (const e of this.expansions) {
      e.drop = null;
      e.dropComplete = false;
      e.hasBase = false;
      e.pending = false;
      for (const b of obs.myBuildings) {
        if (b.type !== 'base' && b.type !== 'depot') continue;
        const s = BSIZE[b.type];
        const bx = b.tileX * TILE + HALF * s;
        const by = b.tileY * TILE + HALF * s;
        if (d2(bx, by, e.cx, e.cy) > 8 * 8 * TILE * TILE) continue;
        if (b.type === 'base') e.hasBase = true;
        if (e.drop === null || (b.complete && !e.dropComplete)) {
          e.drop = b;
          e.dropComplete = b.complete;
          e.dropX = bx;
          e.dropY = by;
        }
      }
      for (const w of workers) {
        if (w.order.type !== 'build' || (w.order.building !== 'depot' && w.order.building !== 'base')) continue;
        if (d2(w.order.tileX * TILE, w.order.tileY * TILE, e.cx, e.cy) <= 8 * 8 * TILE * TILE) e.pending = true;
      }
      if (e.drop !== null || e.pending) this.expBuilder.delete(e.areaId);
    }

    // 分礦危險評估：敵軍明顯優勢時暫停該分礦採集
    for (const e of this.expansions) {
      if (e.drop === null) continue;
      let en = 0;
      for (const u of obs.enemyUnits) {
        if (u.type !== 'worker' && d2(u.x, u.y, e.dropX, e.dropY) <= 9 * 9 * TILE * TILE) en += (UNIT_COST[u.type] * u.hp) / UNIT_HP[u.type];
      }
      if (en === 0) continue;
      let mine = 0;
      for (const u of army) if (d2(u.x, u.y, e.dropX, e.dropY) <= 11 * 11 * TILE * TILE) mine += (UNIT_COST[u.type] * u.hp) / UNIT_HP[u.type];
      for (const t of bld.tower) if (t.complete && d2(t.tileX * TILE + HALF, t.tileY * TILE + HALF, e.dropX, e.dropY) <= 8 * 8 * TILE * TILE) mine += (150 * t.hp) / 600;
      if (en > mine * 1.2) this.danger.set(e.areaId, tick + 120);
    }

    // 防守點：兵少時守在主基地隘口內，兵多時前推到隘口外保護分礦
    const armyNow = army.reduce((s, u) => s + UNIT_SUPPLY[u.type], 0);
    const wantOuter = this.defOuter ? armyNow >= 8 : armyNow >= 12;
    if (wantOuter !== this.defOuter) {
      this.defOuter = wantOuter;
      this.rallySet.clear();
    }
    this.defX = wantOuter ? this.outerX : this.innerX;
    this.defY = wantOuter ? this.outerY : this.innerY;

    // rush 警報：早期看到多座敵方兵營或多名敵方戰鬥單位
    for (const b of obs.enemyBuildings) if (b.type === 'barracks') this.enemyBarracks.add(b.id);
    for (const b of obs.rememberedBuildings) if (b.type === 'barracks') this.enemyBarracks.add(b.id);
    if (!this.rushAlert && tick < 2400) {
      let early = 0;
      for (const t of this.enemySeen.values()) if (t) early++;
      if ((this.enemyBarracks.size >= 2 && tick < 1900) || (early >= 4 && tick < 2400)) this.rushAlert = true;
    }
    if (this.rushAlert && army.reduce((s, u) => s + UNIT_SUPPLY[u.type], 0) >= 16) this.rushAlert = false;

    // ── 1. 軍隊：防守／進攻 ──
    this.armyControl(obs, army, bld, push);

    // ── 1b. 主基地遭優勢敵軍入侵：拉工人協防 ──
    const pulled = this.workerDefense(obs, workers, army, bld, push);

    // ── 2. 工人分配 ──
    this.manageWorkers(obs, pulled ? workers.filter((w) => w.order.type !== 'attack') : workers, bld, push);

    // ── 3. 補建：無人施工的未完工建築 ──
    this.resumeStalled(obs, workers, push);

    // ── 4. 生產與建造（依優先序扣礦） ──
    const threat = tick <= this.threatUntil;
    const nWorkers = workers.length;
    const queuedWorkers = bld.base.reduce((s, b) => s + b.queue.filter((q) => q.unit === 'worker').length, 0);
    const armySupply = army.reduce((s, u) => s + UNIT_SUPPLY[u.type], 0) + bld.barracks.reduce((s, b) => s + b.queue.reduce((t, q) => t + UNIT_SUPPLY[q.unit], 0), 0);
    const supplyCapNow = obs.supplyCap;
    const defNeed = this.rushAlert ? (tick < 1000 ? 0 : Math.min(K.attackSupply, Math.floor((tick - 1000) / 45))) : tick < 1400 ? 0 : Math.min(K.attackSupply, Math.floor((tick - 1400) / 80));
    const armyFirst = threat || armySupply < defNeed;

    // 4a. 補給站
    const pendingSupply = (bld.supply.filter((b) => !b.complete).length + pendingBuild.supply) * 8 + bld.base.filter((b) => !b.complete).length * 10;
    const producers = completeBases.length + bld.barracks.filter((b) => b.complete).length;
    const buffer = 2 + producers * 2;
    if (supplyCapNow + pendingSupply < 50 && supplyCapNow + pendingSupply - supplyUsed < buffer && pendingBuild.supply + bld.supply.filter((b) => !b.complete).length < 2) {
      if (minerals >= 80) {
        if (this.orderBuild(obs, workers, 'supply', null, push)) minerals -= 80;
      } else minerals -= 80; // 保留
    }

    const trainArmy = () => {
      for (const b of bld.barracks) {
        if (!b.complete) continue;
        if (!this.rallySet.has(b.id)) {
          if (push({ type: 'rally', buildingId: b.id, x: this.defX, y: this.defY })) this.rallySet.add(b.id);
        }
        if (b.queue.length >= 1) continue;
        const type = this.nextUnitType(supplyUsed >= 42);
        const cost = UNIT_COST[type];
        const sup = UNIT_SUPPLY[type];
        if (minerals < cost || supplyUsed + sup > supplyCapNow) continue;
        if (push({ type: 'train', buildingId: b.id, unit: type })) {
          this.produced[type] += 1;
          minerals -= cost;
          supplyUsed += sup;
        }
      }
    };
    const trainWorkers = () => {
      if (threat && armySupply < 10 && bld.barracks.some((b) => b.complete)) return;
      let wTotal = nWorkers + queuedWorkers;
      for (const b of completeBases) {
        if (b.queue.length > 0) continue;
        if (wTotal >= K.workerTarget) break;
        if (minerals < 50 || supplyUsed + 1 > supplyCapNow) break;
        if (push({ type: 'train', buildingId: b.id, unit: 'worker' })) {
          minerals -= 50;
          supplyUsed += 1;
          wTotal += 1;
        }
      }
    };

    // 單一保留制：依優先序，第一個礦不夠的阻塞項目保留礦量，其後項目暫停
    let blocked = false;
    const nActive = this.expansions.filter((e) => e.drop !== null || e.pending).length;
    // 擴張門檻不超過工人目標；時間到也一定擴張（快速擴張風格的保底）
    const e1 = Math.min(K.expandWorkers, K.workerTarget - 2);
    const e2 = Math.min(Math.max(K.secondExpandWorkers, e1 + 2), K.workerTarget);
    let wantExp = 0;
    if (nWorkers >= e1 || tick >= 1500) wantExp = 1;
    if (nWorkers >= e2 || tick >= 2400) wantExp = 2;
    if (this.rushAlert && armySupply < 4) wantExp = Math.min(wantExp, nActive);
    if (this.rushAlert && armySupply < 8) wantExp = Math.min(wantExp, 1);

    const doExpansion = () => {
      if (blocked || nActive >= wantExp || (threat && armySupply < 4)) return;
      const exp = this.expansions.find((e) => e.site !== null && e.drop === null && !e.pending);
      if (exp === undefined) return;
      this.handleExpansion(obs, exp, 'depot', exp.site, workers, minerals, push);
      if (minerals < 100) blocked = true;
      else minerals -= 100;
    };

    const barracksCount = bld.barracks.length + pendingBuild.barracks;
    let wantBarracks = this.wantedBarracks(K, nWorkers, tick, nActive, threat);
    // 礦在累積（產能不足）：多蓋兵營
    if (minerals >= 300 && bld.barracks.length >= 1 && bld.barracks.every((b) => b.complete)) wantBarracks = Math.max(wantBarracks, Math.min(6, bld.barracks.length + 1));
    const doBarracks = (firstOnly) => {
      if (blocked) return;
      if (firstOnly && barracksCount > 0) return;
      if (barracksCount >= wantBarracks || pendingBuild.barracks + bld.barracks.filter((b) => !b.complete).length >= 2) return;
      if (minerals >= 150) {
        if (this.orderBuild(obs, workers, 'barracks', null, push)) minerals -= 150;
      } else blocked = true;
    };
    const doMainTower = () => {
      if (blocked) return;
      if (!(bld.barracks.length > 0 && (nActive >= 1 || this.rushAlert) && !threat && pendingBuild.tower === 0 && tick < 4500)) return;
      const hasMain = bld.tower.some((t) => d2(t.tileX * TILE + HALF, t.tileY * TILE + HALF, this.innerX, this.innerY) <= 5 * 5 * TILE * TILE);
      if (hasMain) return;
      if (minerals >= 120) {
        const spot = this.findSpotAround(obs, 'tower', this.innerX, this.innerY, 4);
        if (spot !== null && this.orderBuildAt(workers, 'tower', spot, push)) minerals -= 120;
      } else if (tick < 3000) blocked = true;
    };
    const doMainDepot = () => {
      if (blocked || threat || nWorkers < 5) return;
      let mainDepot = false;
      for (const d of bld.depot) {
        if (d2(d.tileX * TILE + TILE, d.tileY * TILE + TILE, this.mainArea.cx, this.mainArea.cy) <= 5 * 5 * TILE * TILE) mainDepot = true;
      }
      for (const w of workers) {
        if (w.order.type === 'build' && w.order.building === 'depot' && d2(w.order.tileX * TILE + TILE, w.order.tileY * TILE + TILE, this.mainArea.cx, this.mainArea.cy) <= 5 * 5 * TILE * TILE) mainDepot = true;
      }
      if (mainDepot) return;
      if (minerals >= 100) {
        const site = this.findSite(this.mainArea, 'depot', true, obs);
        if (site !== null && this.orderBuildAt(workers, 'depot', site, push)) minerals -= 100;
      } else if (tick < 1500) blocked = true;
    };
    const doWorkers = () => {
      if (!blocked) trainWorkers();
    };
    const doArmy = () => {
      if (!blocked) trainArmy();
    };

    if (armyFirst) trainArmy();
    if (this.rushAlert) {
      doBarracks(false);
      doMainTower();
      doWorkers();
      doExpansion();
      doMainDepot();
      doArmy();
    } else {
      doExpansion();
      doWorkers();
      doBarracks(true);
      doMainTower();
      doMainDepot();
      doBarracks(false);
      doArmy();
    }

    // 4e. 防禦塔（分礦）
    if (K.towersPerExpansion > 0 && minerals >= 120 && pendingBuild.tower === 0 && bld.barracks.length >= 2 && !threat) {
      for (const e of this.expansions) {
        if (!e.dropComplete) continue;
        const have = bld.tower.filter((t) => d2(t.tileX * TILE + HALF, t.tileY * TILE + HALF, e.dropX, e.dropY) <= 8 * 8 * TILE * TILE).length;
        if (have >= K.towersPerExpansion) continue;
        if (this.orderBuild(obs, workers, 'tower', e, push)) minerals -= 120;
        break;
      }
    }

    // 4f. 礦多：在分礦補蓋主堡（人口、產能、資產）
    if (minerals >= 450 && supplyUsed >= 36 && pendingBuild.base === 0 && bld.base.filter((b) => !b.complete).length === 0 && tick < 5300) {
      const exp = this.expansions.find((e) => e.dropComplete && !e.hasBase);
      if (exp !== undefined) {
        const site = this.findSite(exp, 'base', true, obs);
        if (site !== null && this.orderBuildAt(workers, 'base', site, push)) minerals -= 400;
      }
    }

    // 4h. 人口將滿、礦在累積：蓋防禦塔（不佔人口，守分礦也計入資產）
    if (supplyUsed >= 44 && minerals >= 250 && pendingBuild.tower === 0 && bld.tower.length < 12 && !threat) {
      let bestE = null;
      let bestN = Infinity;
      for (const e of this.expansions) {
        if (!e.dropComplete) continue;
        const n = bld.tower.filter((t) => d2(t.tileX * TILE + HALF, t.tileY * TILE + HALF, e.dropX, e.dropY) <= 8 * 8 * TILE * TILE).length;
        if (n < bestN && n < 4) {
          bestN = n;
          bestE = e;
        }
      }
      let ok = false;
      if (bestE !== null) ok = this.orderBuild(obs, workers, 'tower', bestE, push);
      if (!ok) {
        const spot = this.findSpotAround(obs, 'tower', this.outerX, this.outerY, 4);
        if (spot !== null) ok = this.orderBuildAt(workers, 'tower', spot, push);
      }
      if (ok) minerals -= 120;
    }

    // 4g. 人口滿、礦多：加蓋兵營
    if (supplyUsed >= 46 && minerals >= 300 && bld.barracks.length + pendingBuild.barracks < 7 && pendingBuild.barracks === 0) {
      if (this.orderBuild(obs, workers, 'barracks', null, push)) minerals -= 150;
    }
    return cmds;
  }

  wantedBarracks(K, nWorkers, tick, nActive, threat) {
    let want = 0;
    if (this.rushAlert) want = nWorkers >= 14 ? 3 : 2;
    if (nActive >= 1 || tick >= 1200 || threat) want = Math.max(want, 1);
    if (nWorkers >= 15 || tick >= 1800) want = Math.max(want, 2);
    if (nWorkers >= 19) want = 3;
    if (nWorkers >= 23) want = 4;
    if (nWorkers >= 27) want = 5;
    return want;
  }

  handleExpansion(obs, exp, type, site0, workers, minerals, push) {
    // 派工人預先前往，抵達且礦夠時下 build
    const cost = BCOST[type];
    let builder = null;
    const bid = this.expBuilder.get(exp.areaId);
    if (bid !== undefined) builder = workers.find((w) => w.id === bid) || null;
    const sx = site0.x * TILE + HALF * BSIZE[type];
    const sy = site0.y * TILE + HALF * BSIZE[type];
    if (builder === null || builder.order.type === 'gather' || builder.order.type === 'construct' || builder.order.type === 'build') {
      if (minerals < cost - 60) return false;
      let best = null;
      let bestD = Infinity;
      for (const w of workers) {
        if (w.order.type !== 'gather' && w.order.type !== 'idle') continue;
        const dd = d2(w.x, w.y, sx, sy) + (w.carrying > 0 ? 9e6 : 0);
        if (dd < bestD) {
          bestD = dd;
          best = w;
        }
      }
      if (best === null) return false;
      builder = best;
      this.expBuilder.set(exp.areaId, builder.id);
      push({ type: 'move', units: [builder.id], x: sx, y: sy });
      return false;
    }
    if (minerals >= cost) {
      let site = site0;
      if (!this.helpers.canPlace(type, site.x, site.y)) {
        const alt = this.findSite(exp, type, true, null);
        if (alt === null) {
          if (builder.order.type !== 'move') push({ type: 'move', units: [builder.id], x: sx, y: sy });
          return false;
        }
        site = alt;
      }
      return push({ type: 'build', workerId: builder.id, building: type, tileX: site.x, tileY: site.y });
    }
    if (builder.order.type === 'idle' && d2(builder.x, builder.y, sx, sy) > 3 * 3 * TILE * TILE) push({ type: 'move', units: [builder.id], x: sx, y: sy });
    return false;
  }

  orderBuildAt(workers, type, spot, push) {
    const sx = spot.x * TILE + HALF;
    const sy = spot.y * TILE + HALF;
    let best = null;
    let bestD = Infinity;
    const reserved = this.reservedSet();
    for (const w of workers) {
      if (reserved.has(w.id)) continue;
      if (w.order.type !== 'gather' && w.order.type !== 'idle') continue;
      const dd = d2(w.x, w.y, sx, sy) + (w.carrying > 0 ? 4e6 : 0);
      if (dd < bestD) {
        bestD = dd;
        best = w;
      }
    }
    if (best === null) return false;
    return push({ type: 'build', workerId: best.id, building: type, tileX: spot.x, tileY: spot.y });
  }

  workerDefense(obs, workers, army, bld, push) {
    const tick = obs.tick;
    const R2 = 11 * 11 * TILE * TILE;
    const pow = (u) => (UNIT_COST[u.type] * u.hp) / UNIT_HP[u.type];
    let E = 0;
    let target = null;
    let tD = Infinity;
    for (const e of obs.enemyUnits) {
      if (e.type === 'worker') continue;
      const dd = d2(e.x, e.y, this.baseX, this.baseY);
      if (dd > R2) continue;
      E += pow(e);
      if (dd < tD) {
        tD = dd;
        target = e;
      }
    }
    const fighting = workers.filter((w) => w.order.type === 'attack');
    if (target === null) {
      return false;
    }
    let A = 0;
    for (const u of army) if (d2(u.x, u.y, this.baseX, this.baseY) <= 14 * 14 * TILE * TILE) A += pow(u);
    for (const t of bld.tower) if (t.complete && d2(t.tileX * TILE + HALF, t.tileY * TILE + HALF, this.baseX, this.baseY) <= R2) A += (150 * t.hp) / 600;
    if (A >= E * 1.1) return fighting.length > 0;
    if (tick - (this.lastPull || -100) < 15) return true;
    const avail = workers.filter((w) => w.order.type !== 'attack' && w.order.type !== 'build' && w.order.type !== 'construct' && w.hp >= 15 && d2(w.x, w.y, this.baseX, this.baseY) <= 12 * 12 * TILE * TILE);
    const need = Math.max(0, Math.ceil((E * 1.2 - A) / 30)) - fighting.length;
    const ids = fighting.map((w) => w.id);
    avail.sort((a, b) => d2(a.x, a.y, target.x, target.y) - d2(b.x, b.y, target.x, target.y));
    for (let i = 0; i < avail.length && i < need && avail.length - i > 2; i++) ids.push(avail[i].id);
    if (ids.length === 0) return false;
    this.lastPull = tick;
    push({ type: 'attack', units: ids, targetId: target.id });
    return true;
  }

  /** 派工人建造；near 為分礦物件時蓋在分礦旁 */
  orderBuild(obs, workers, type, near, push) {
    const spot = near ? this.findSpotNear(obs, type, near) : this.findSpot(obs, type);
    if (spot === null) return false;
    const sx = spot.x * TILE + HALF;
    const sy = spot.y * TILE + HALF;
    let best = null;
    let bestD = Infinity;
    const reserved = this.reservedSet();
    for (const w of workers) {
      if (reserved.has(w.id)) continue;
      if (w.order.type !== 'gather' && w.order.type !== 'idle') continue;
      const dd = d2(w.x, w.y, sx, sy) + (w.carrying > 0 ? 4e6 : 0);
      if (dd < bestD) {
        bestD = dd;
        best = w;
      }
    }
    if (best === null) return false;
    return push({ type: 'build', workerId: best.id, building: type, tileX: spot.x, tileY: spot.y });
  }

  findSpot(obs, type) {
    const size = BSIZE[type];
    const cx = this.baseTX + 1;
    const cy = this.baseTY + 1;
    for (let pass = 0; pass < 2; pass++) {
      for (let r = 3; r <= 9; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = cx + dx;
            const y = cy + dy;
            const vx = (x + size / 2) * TILE - this.baseX;
            const vy = (y + size / 2) * TILE - this.baseY;
            if (pass === 0 && vx * this.mineDirX + vy * this.mineDirY > 0) continue;
            if (pass === 1 && this.nearMain(x, y, size)) continue;
            if (!this.helpers.canPlace(type, x, y)) continue;
            if (this.crowded(obs, x, y, size)) continue;
            return { x, y };
          }
        }
      }
    }
    return null;
  }

  nearMain(x, y, size) {
    // 不擋主礦線：避開主礦點與主堡之間的區域
    for (const id of this.mainArea.nodes) {
      const n = this.nodeInfo.get(id);
      const mx = (n.tileX + this.baseTX + 1) / 2;
      const my = (n.tileY + this.baseTY + 1) / 2;
      if (Math.abs(x + size / 2 - mx) < 3 && Math.abs(y + size / 2 - my) < 3) return true;
    }
    return false;
  }

  findSpotNear(obs, type, exp) {
    const size = BSIZE[type];
    const bx = Math.floor(exp.dropX / TILE);
    const by = Math.floor(exp.dropY / TILE);
    // 偏向敵方／地圖中心方向，且不在礦線上
    const tx = this.W * HALF;
    const ty = this.H * HALF;
    let best = null;
    let bestS = Infinity;
    for (let y = by - 5; y <= by + 5; y++) {
      for (let x = bx - 5; x <= bx + 5; x++) {
        const px = x * TILE + HALF * size;
        const py = y * TILE + HALF * size;
        const dBase = d2(px, py, exp.dropX, exp.dropY);
        if (dBase < 2.5 * 2.5 * TILE * TILE) continue;
        // 礦線：與礦區中心同側且比主堡更接近礦區
        if (d2(px, py, exp.cx, exp.cy) < d2(exp.dropX, exp.dropY, exp.cx, exp.cy)) continue;
        if (!this.helpers.canPlace(type, x, y)) continue;
        if (this.crowded(obs, x, y, size)) continue;
        const s = Math.sqrt(d2(px, py, tx, ty)) + Math.sqrt(dBase) * 0.5;
        if (s < bestS) {
          bestS = s;
          best = { x, y };
        }
      }
    }
    return best;
  }

  findSpotAround(obs, type, px, py, rmax) {
    const size = BSIZE[type];
    const cx = Math.floor(px / TILE);
    const cy = Math.floor(py / TILE);
    for (let r = 0; r <= rmax; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!this.helpers.canPlace(type, x, y)) continue;
          if (this.crowded(obs, x, y, size)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  crowded(obs, x, y, size) {
    for (const b of obs.myBuildings) {
      const s = BSIZE[b.type];
      if (x - 1 < b.tileX + s && x + size + 1 > b.tileX && y - 1 < b.tileY + s && y + size + 1 > b.tileY) return true;
    }
    for (let ty = y - 1; ty <= y + size; ty++) {
      for (let tx = x - 1; tx <= x + size; tx++) {
        if (this.helpers.terrainAt(tx, ty) === 1) return true;
        if (tx >= 0 && ty >= 0 && tx < this.W && ty < this.H && this.nodeTile[ty * this.W + tx]) return true;
      }
    }
    return false;
  }

  resumeStalled(obs, workers, push) {
    for (const b of obs.myBuildings) {
      if (b.complete) continue;
      const busy = workers.some((w) => w.order.type === 'construct' && w.order.buildingId === b.id);
      if (busy) continue;
      const bx = b.tileX * TILE + HALF * BSIZE[b.type];
      const by = b.tileY * TILE + HALF * BSIZE[b.type];
      let best = null;
      let bestD = Infinity;
      for (const w of workers) {
        if (w.order.type !== 'gather' && w.order.type !== 'idle') continue;
        const dd = d2(w.x, w.y, bx, by);
        if (dd < bestD) {
          bestD = dd;
          best = w;
        }
      }
      if (best !== null) push({ type: 'resume', workerId: best.id, buildingId: b.id });
      return;
    }
  }

  manageWorkers(obs, workers, bld, push) {
    // 有卸貨點的礦區
    const areas = [];
    const tick = obs.tick;
    const mainBase = bld.base.find((b) => b.complete && Math.abs(b.tileX - this.baseTX) <= 1 && Math.abs(b.tileY - this.baseTY) <= 1);
    if (mainBase) areas.push(this.mainArea);
    const dangerNodes = new Set();
    for (const e of this.expansions) {
      if (!e.dropComplete) continue;
      if ((this.danger.get(e.areaId) || -1) >= tick && mainBase) {
        for (const id of e.nodes) dangerNodes.add(id);
        continue;
      }
      areas.push(e);
    }
    if (areas.length === 0) {
      // 主基地失去：用任何已完工主堡附近的礦區
      for (const e of this.expansions) if (e.drop) areas.push(e);
      if (areas.length === 0) areas.push(this.mainArea);
    }
    const reserve = new Map();
    for (const n of obs.mineNodes) reserve.set(n.id, n.reserve);
    const live = [];
    for (const a of areas) for (const id of a.nodes) if ((reserve.get(id) || 0) > 0) live.push(id);
    if (live.length === 0) return;
    // 分礦遭受優勢敵軍：工人撤回主礦
    if (dangerNodes.size > 0) {
      const evac = workers.filter((w) => (w.gatherNodeId != null && dangerNodes.has(w.gatherNodeId)) || (w.order.type === 'gather' && dangerNodes.has(w.order.nodeId)));
      if (evac.length > 0) {
        const mainLive = this.mainArea.nodes.filter((id) => (reserve.get(id) || 0) > 0);
        const tgt = mainLive.length > 0 ? mainLive : live;
        const half = Math.ceil(evac.length / 2);
        push({ type: 'gather', units: evac.slice(0, half).map((w) => w.id), nodeId: tgt[0] });
        if (evac.length > half) push({ type: 'gather', units: evac.slice(half).map((w) => w.id), nodeId: tgt[tgt.length > 1 ? 1 : 0] });
      }
    }
    const count = new Map(live.map((id) => [id, 0]));
    const assigned = new Map();
    for (const w of workers) {
      const nid = w.gatherNodeId != null ? w.gatherNodeId : w.order.type === 'gather' ? w.order.nodeId : null;
      if (nid !== null && count.has(nid)) {
        count.set(nid, count.get(nid) + 1);
        if (!assigned.has(nid)) assigned.set(nid, []);
        assigned.get(nid).push(w);
      }
    }
    const reserved = this.reservedSet();
    const byNode = new Map();
    const pick = (w) => {
      let best = live[0];
      let bestS = Infinity;
      for (const id of live) {
        const n = this.nodeInfo.get(id);
        const s = count.get(id) * 14000 + Math.sqrt(d2(w.x, w.y, n.tileX * TILE + HALF, n.tileY * TILE + HALF)) + (count.get(id) >= 3 ? 60000 : 0);
        if (s < bestS) {
          bestS = s;
          best = id;
        }
      }
      return best;
    };
    for (const w of workers) {
      if (w.order.type !== 'idle') continue;
      if (reserved.has(w.id)) continue;
      const best = pick(w);
      count.set(best, count.get(best) + 1);
      if (!byNode.has(best)) byNode.set(best, []);
      byNode.get(best).push(w.id);
    }
    for (const [nodeId, ids] of byNode) push({ type: 'gather', units: ids, nodeId });

    // 再平衡：過飽和礦點的工人移往不足的礦點
    if (obs.tick - this.lastRebalance >= 25) {
      this.lastRebalance = obs.tick;
      let lowId = -1;
      let lowC = 99;
      for (const id of live) if (count.get(id) < lowC) { lowC = count.get(id); lowId = id; }
      if (lowId >= 0 && lowC <= 1) {
        const moveIds = [];
        for (const id of live) {
          const c = count.get(id);
          if (c >= 3 + (lowC === 0 ? 0 : 1) || (c >= 3 && lowC === 0)) {
            const list = (assigned.get(id) || []).filter((w) => w.carrying === 0 && !reserved.has(w.id));
            if (list.length > 0 && moveIds.length < 2 - lowC) {
              moveIds.push(list[list.length - 1].id);
              count.set(id, c - 1);
            }
          }
        }
        if (moveIds.length > 0) push({ type: 'gather', units: moveIds, nodeId: lowId });
      }
    }
  }

  nextUnitType(supplyTight) {
    let eS = 0;
    let eA = 0;
    let eC = 0;
    for (const t of this.enemySeen.values()) {
      if (t === 'spear') eS++;
      else if (t === 'archer') eA++;
      else if (t === 'cavalry') eC++;
    }
    const tot = eS + eA + eC;
    let w;
    if (tot < 3) w = { spear: 65, archer: 30, cavalry: 5 };
    else w = { spear: 65 + (60 * eC) / tot, archer: 15 + (40 * eS) / tot, cavalry: 3 + (30 * eA) / tot };
    // 人口將滿：騎兵每人口效率差，改以長槍兵／弓兵為主
    if (supplyTight) w.cavalry = w.cavalry * 0.25;
    const sum = w.spear + w.archer + w.cavalry;
    const total = this.produced.spear + this.produced.archer + this.produced.cavalry + 1;
    let best = 'spear';
    let bestDef = -Infinity;
    for (const t of COMBAT) {
      const def = (w[t] / sum) * total - this.produced[t];
      if (def > bestDef) {
        bestDef = def;
        best = t;
      }
    }
    return best;
  }

  armyControl(obs, army, bld, push) {
    const tick = obs.tick;
    const K = this.K;
    // 威脅：敵方單位靠近己方建築或工人
    let threat = null;
    let threatD = Infinity;
    const myB = obs.myBuildings;
    for (const e of obs.enemyUnits) {
      for (const b of myB) {
        const bx = b.tileX * TILE + HALF * BSIZE[b.type];
        const by = b.tileY * TILE + HALF * BSIZE[b.type];
        const dd = d2(e.x, e.y, bx, by);
        if (dd < 11 * 11 * TILE * TILE && dd < threatD) {
          threatD = dd;
          threat = e;
        }
      }
    }
    if (threat !== null) this.threatUntil = tick + 60;
    const armySupply = army.reduce((s, u) => s + UNIT_SUPPLY[u.type], 0);
    if (army.length === 0) {
      if (this.attacking) this.attacking = false;
      return;
    }

    // 敵方戰力（視野內戰鬥單位）
    const enemyArmy = obs.enemyUnits.filter((e) => e.type !== 'worker');

    if (!this.attacking) {
      const maxed = obs.supplyUsed >= 47 && armySupply >= 14;
      const late = tick >= 4800 && armySupply >= 10;
      if ((armySupply >= K.attackSupply || maxed || late) && threat === null) {
        if (this.pickTarget(obs)) {
          this.attacking = true;
          this.lastArmyOrder = tick;
          push({ type: 'attackMove', units: army.map((u) => u.id), x: this.targetX, y: this.targetY });
          for (const b of bld.barracks) if (b.complete) push({ type: 'rally', buildingId: b.id, x: this.defX, y: this.defY });
          return;
        }
      }
      if (threat !== null) {
        if (tick - this.lastDefOrder >= 20) {
          this.lastDefOrder = tick;
          push({ type: 'attackMove', units: army.map((u) => u.id), x: threat.x, y: threat.y });
        }
        return;
      }
      // 無威脅：集結到防守點
      if (tick - this.lastArmyOrder >= 50) {
        const far = army.filter((u) => u.order.type === 'idle' && d2(u.x, u.y, this.defX, this.defY) > 6 * 6 * TILE * TILE);
        if (far.length > 0) {
          this.lastArmyOrder = tick;
          push({ type: 'attackMove', units: far.map((u) => u.id), x: this.defX, y: this.defY });
        }
      }
      return;
    }

    // 進攻中
    // 基地遭到攻擊而主力離得遠：留在家的單位防守
    const front = army.filter((u) => d2(u.x, u.y, this.defX, this.defY) > 12 * 12 * TILE * TILE);
    const home = army.filter((u) => d2(u.x, u.y, this.defX, this.defY) <= 12 * 12 * TILE * TILE);
    if (threat !== null && home.length > 0 && tick - this.lastDefOrder >= 20) {
      this.lastDefOrder = tick;
      push({ type: 'attackMove', units: home.map((u) => u.id), x: threat.x, y: threat.y });
    }
    // 戰力比較：撤退
    let myPow = 0;
    let fx = 0;
    let fy = 0;
    for (const u of front) {
      myPow += UNIT_COST[u.type] * (u.hp / UNIT_HP[u.type]);
      fx += u.x;
      fy += u.y;
    }
    if (front.length > 0) {
      fx /= front.length;
      fy /= front.length;
    }
    let enPow = 0;
    for (const e of enemyArmy) {
      if (front.length > 0 && d2(e.x, e.y, fx, fy) < 12 * 12 * TILE * TILE) enPow += UNIT_COST[e.type] * (e.hp / UNIT_HP[e.type]);
    }
    const supplyFront = front.reduce((s, u) => s + UNIT_SUPPLY[u.type], 0);
    const retreatRatio = obs.minerals >= 500 && obs.supplyUsed >= 44 ? 2.2 : 1.4;
    if (front.length > 0 && enPow > myPow * retreatRatio && enPow > 300) {
      this.attacking = false;
      this.lastArmyOrder = tick;
      push({ type: 'move', units: front.map((u) => u.id), x: this.defX, y: this.defY });
      return;
    }
    if (armySupply < Math.max(6, K.attackSupply * 0.35) && supplyFront < 8 && threat !== null) {
      this.attacking = false;
      return;
    }
    const changed = this.refreshTarget(obs, army);
    if (changed || tick - this.lastArmyOrder >= 100) {
      this.lastArmyOrder = tick;
      const ids = army.filter((u) => !(threat !== null && home.indexOf(u) >= 0)).map((u) => u.id);
      if (ids.length > 0) push({ type: 'attackMove', units: ids, x: this.targetX, y: this.targetY });
    } else if (tick - this.lastReinforce >= 40) {
      // 家裡集結夠多的援軍才出發
      const idleHome = home.filter((u) => u.order.type === 'idle' || u.order.type === 'move');
      const sup = idleHome.reduce((s, u) => s + UNIT_SUPPLY[u.type], 0);
      if (sup >= 4 && threat === null) {
        this.lastReinforce = tick;
        push({ type: 'attackMove', units: idleHome.map((u) => u.id), x: this.targetX, y: this.targetY });
      }
    }
  }

  pickTarget(obs) {
    const alive = obs.alivePlayers.filter((p) => p !== this.me);
    if (alive.length === 0) return false;
    // 已知敵方建築優先（最近者）；否則最近的存活起點
    const start = this.enemyStarts.find((s) => alive.indexOf(s.playerId) >= 0);
    if (start === undefined) return false;
    this.targetPlayer = start.playerId;
    this.targetX = start.x;
    this.targetY = start.y;
    return true;
  }

  refreshTarget(obs, army) {
    const alive = obs.alivePlayers.filter((p) => p !== this.me);
    const known = obs.enemyBuildings.concat(obs.rememberedBuildings).filter((b) => alive.indexOf(b.owner) >= 0);
    const near = (x, y, tiles) => d2(x, y, this.targetX, this.targetY) <= tiles * tiles * TILE * TILE;
    if (known.some((b) => near(b.tileX * TILE + HALF, b.tileY * TILE + HALF, 6))) return false;
    const arrived = army.some((u) => near(u.x, u.y, 5));
    const ownerAlive = this.enemyStarts.some((s) => s.x === this.targetX && s.y === this.targetY && alive.indexOf(s.playerId) >= 0);
    if (!arrived && ownerAlive) return false;
    if (known.length > 0) {
      let best = known[0];
      let bestD = Infinity;
      for (const b of known) {
        const dd = d2(b.tileX * TILE, b.tileY * TILE, this.targetX, this.targetY) + (b.type === 'base' ? 0 : 1e6);
        if (dd < bestD || (dd === bestD && b.id < best.id)) {
          bestD = dd;
          best = b;
        }
      }
      this.targetX = best.tileX * TILE + HALF;
      this.targetY = best.tileY * TILE + HALF;
      return true;
    }
    const next = this.enemyStarts.find((s) => alive.indexOf(s.playerId) >= 0 && !(s.x === this.targetX && s.y === this.targetY));
    if (next === undefined) return false;
    this.targetX = next.x;
    this.targetY = next.y;
    return true;
  }
}
