// @ts-check
// CS 射擊基準 Bot（步驟 6）：四層架構。
//   感知 memory.js（每次決策）：敵情記憶、已清空格、危險格成本（每秒）
//   導航 analysis.js（init 一次：可走格、距離場、區域交界與窄口、掩體點、守點位、下包位、路線集）＋ nav.js（A*、路徑點、被擋重算、探頭）
//   戰鬥 combat.js（每次決策）：目標、預判瞄準、點放、停步、蹲、換彈、狙擊、撤退、被閃、道具自保、沒事時看哪裡
//   戰術 tactics.js（回合開始＋每次決策）：隊內計畫與事件（say）、T 五種計畫與守包、CT 配置／輪轉／回防／保槍、殘局、換血
//        economy.js（指揮統一買法 B:）、utility.js（道具彈道與投擲）、roles.js（2.1：五個角色的分工，隊內喊 R:）
// 公平：只讀 init 資料與觀察資料；不寫死任何地圖座標、區域代號或地圖 id。
// 屬性包（attributes，0～100）接到行為：aim 瞄準誤差與收斂（狙擊手拿其他槍時打折）；reaction 開火前額外等待與對聲音的反應；
// awareness 雷達與聲音採信、隊內事件的反應延遲、預瞄（目標出現在正看著的方向時初始瞄準誤差小）、餘光察覺（視野邊緣的敵人多快注意到）；
// aggression 探頭等待與方式、撤退門檻、架槍時間、T 計畫（rush 比例、default 執行時機）；
// discipline 隊友擋線的安全距離、守位中不追出射程外的目標、經濟服從（eco 不偷買）、不追殘血、殘局保槍；
// movement 停步乾淨度、肩探（太低只會寬探）、附近有敵人時靜步、佈置時靜步。旋鈕是外部粗調（侵略偏移、經濟、狙擊手、CT 分點、T 計畫、角色）。
// 本檔由 scripts/build-shooter-bots.ts 從 bots/shooter-src/ 產生：請修改原始碼後重新產生，不要直接改這個檔案。

/** @typedef {import('../src/shooter/api.ts').ShooterInitData} InitData */
/** @typedef {import('../src/shooter/api.ts').ShooterHelpers} Helpers */
/** @typedef {import('../src/shooter/api.ts').ShooterObservation} Observation */
/** @typedef {import('../src/shooter/api.ts').ShooterCommand} Command */
/** @typedef {import('../src/shooter/api.ts').ShooterDeclaration} Declaration */
/** @typedef {import('../src/shooter/api.ts').EnemyInfo} Enemy */
/** @typedef {import('../src/shooter/api.ts').WeaponInfo} WeaponInfo */
/** @typedef {import('../src/shooter/api.ts').MapInfo} MapInfo */
/** @typedef {import('../src/shooter/api.ts').Team} Team */
/** @typedef {import('../src/shooter/api.ts').BuyItem} BuyItem */
/** @typedef {import('../src/shooter/api.ts').WeaponId} WeaponId */
/** @typedef {import('../src/shooter/api.ts').AttributeKey} AttributeKey */
/** @typedef {import('../src/shooter/api.ts').GrenadeId} GrenadeId */
/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect */
const UNIT = 1000;
const P = {
  chokeWidth: 6,
  holdMin: 8,
  holdMax: 20,
  holdSiteRadius: 8,
  exposeRay: 6,
  routeSlack: 1.6,
  routeMax: 3,
  confSee: 100,
  confRadar: 80,
  confTracer: 70,
  confHurt: 60,
  confSound: 40,
  confDeath: 50,
  decay0: 25,
  decay100: 25,
  unconfirmed: 30,
  clearTtl0: 7.5,
  clearTtl100: 7.5,
  sectorHalfDeg: 15,
  bandNear: [0, 12],
  bandMid: [12, 30],
  bandFar: [30, 60],
  trust0: 0.7,
  trust100: 1,
  scanEvery: 9,
  mateScanEvery: 2,
  dangerCoef: 0.6,
  sectorCoef: 0.3,
  dangerRange: 30,
  wallHug: 4,
  lowBonus: 3,
  offRoute: 12,
  routeSwitchNear: 35,
  routeSwitchRisk: 15,
  replanTicks: 30,
  stuckDecisions: 10,
  waypointReach: 1200,
  maxSegment: 6,
  peekStop: 2,
  peekHold0: 6,
  peekHold100: 2,
  shoulderBelow: 60,
  shoulderMove: 40,
  silentMove: 60,
  enemySpeed: 4.6,
  aimErr0: 1.0,
  aimErr100: 0.15,
  aimConv0: 0.8,
  aimConv100: 0.4,
  leadExtra: 2,
  react0: 3,
  react100: 0,
  preAimErr: 0.6,
  preAimDeg: 20,
  periphDeg: 25,
  notice0: 0.35,
  notice100: 1,
  fireSpreadK: 2.6,
  awpErr: 0.22,
  awpClose: 8,
  pistolSwitch: 12,
  reloadBelow: 0.4,
  friendClear0: 700,
  friendClear100: 1200,
  holdFirm: 50,
  retreatHp0: 40,
  retreatHp100: 20,
  outnumber0: 2,
  outnumber100: 4,
  mateNear: 10,
  coverRadius: 8,
  holdAngle0: 2.0,
  holdAngle100: 0.6,
  crouchFireMin: 8,
  sloppyStop0: 0.5,
  sloppyStop100: 0,
  nadeAvoid: 4,
  ctSplitA: 2,
  ctB: 2,
  plantRequireClear: true,
  stageBack: 9,
  stageGap: 1.6,
  splitWait: 32,
  fakeDelay: 4,
  defaultExec0: 48,
  defaultExec100: 30,
  forceExecLeft: 35,
  contactEvery: 1.5,
  contactTtl: 12,
  eventDelay0: 4,
  eventDelay100: 0,
  rotateHeat: 2,
  retakeGather: 3.5,
  saveMargin: 2,
  saveDist: 22,
  huntAggr: 0.65,
  tradeRange: 8,
  tradeHold: 1.5,
  chaseHp: 40,
  chaseRange: 15,
  chaseTime: 3,
  flashMateClear: 4,
  smokeOff: 4.5,
  nadeCluster: 3.5,
  molotovNear: 16,
  yieldNear: 6,
  yieldMax: 3,
  stageLead: 5,
  spawnLead: 10,
  spawnLeadMax: 4,
  spawnStop: 1.5,
  awpOffAim: 0.35,
  retakeLead: 1.2,
};
const COS = new Float64Array(360);
const SIN = new Float64Array(360);
/** @type {Helpers | null} */
let HELP = null;
/** @param {Helpers} h */
function initTrig(h) {
  HELP = h;
  for (let d = 0; d < 360; d++) {
    const [x, y] = h.offset(0, 0, d, 1000000);
    COS[d] = x / 1000000;
    SIN[d] = y / 1000000;
  }
}
/** @param {number} d */
function normDeg(d) {
  const r = Math.round(d) % 360;
  return r < 0 ? r + 360 : r;
}
/** @param {number} d */
function cosd(d) {
  return COS[normDeg(d)];
}
/** @param {number} d */
function sind(d) {
  return SIN[normDeg(d)];
}
/** 方位角（整數度 0～359；0 = 東、90 = 南） @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function angleTo(ax, ay, bx, by) {
  if (HELP === null || (ax === bx && ay === by)) return 0;
  return normDeg(HELP.angleTo(ax, ay, bx, by));
}
/** 有號角度差 a − b，範圍 (−180, 180] @param {number} a @param {number} b */
function adiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function dist(ax, ay, bx, by) {
  return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}
/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
/** 屬性線性插值：t = 屬性 / 100 @param {number} a @param {number} b @param {number} t */
function lerp(a, b, t) {
  return a + (b - a) * t;
}
/** 點到線段的距離與投影比例 t（0～1 在線段上） @param {number} px @param {number} py @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  const c = clamp(t, 0, 1);
  return { d: dist(px, py, ax + dx * c, ay + dy * c), t };
}
/** @param {Rect} r @param {number} cx @param {number} cy */
function inRect(r, cx, cy) {
  return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
}
const DIR8 = [
  [1, 0, 10],
  [-1, 0, 10],
  [0, 1, 10],
  [0, -1, 10],
  [1, 1, 14],
  [1, -1, 14],
  [-1, 1, 14],
  [-1, -1, 14],
];
class Grid {
  /** @param {MapInfo} map */
  constructor(map) {
    this.W = map.width;
    this.H = map.height;
    this.N = this.W * this.H;
    this.wall = new Uint8Array(this.N);
    this.block = new Uint8Array(this.N);
    this.low = new Uint8Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const v = map.solid[i];
      this.wall[i] = v === 1 ? 1 : 0;
      this.block[i] = v !== 0 ? 1 : 0;
      this.low[i] = v === 2 ? 1 : 0;
    }
  }
  /** 座標單位 → 格索引；出界 −1 @param {number} x @param {number} y */
  cellOf(x, y) {
    const cx = Math.floor(x / UNIT);
    const cy = Math.floor(y / UNIT);
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return -1;
    return cy * this.W + cx;
  }
  /** 格中心（座標單位） @param {number} i @returns {Pt} */
  center(i) {
    return { x: (i % this.W) * UNIT + UNIT / 2, y: Math.floor(i / this.W) * UNIT + UNIT / 2 };
  }
  /** @param {number} cx @param {number} cy */
  isWall(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
    return this.wall[cy * this.W + cx] === 1;
  }
  /** @param {number} cx @param {number} cy */
  isBlock(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
    return this.block[cy * this.W + cx] === 1;
  }
  /** @param {number} i */
  walkable(i) {
    return i >= 0 && i < this.N && this.block[i] === 0;
  }
  /**
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by
   */
  los(ax, ay, bx, by) {
    const x0 = ax / UNIT;
    const y0 = ay / UNIT;
    const x1 = bx / UNIT;
    const y1 = by / UNIT;
    let cx = Math.floor(x0);
    let cy = Math.floor(y0);
    const ex = Math.floor(x1);
    const ey = Math.floor(y1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = sx > 0 ? (cx + 1 - x0) * tdx : sx < 0 ? (x0 - cx) * tdx : Infinity;
    let tmy = sy > 0 ? (cy + 1 - y0) * tdy : sy < 0 ? (y0 - cy) * tdy : Infinity;
    let n = Math.abs(ex - cx) + Math.abs(ey - cy);
    while (n > 0) {
      if (Math.abs(tmx - tmy) < 1e-9) {
        if (this.isWall(cx + sx, cy) && this.isWall(cx, cy + sy)) return false;
        cx += sx;
        cy += sy;
        tmx += tdx;
        tmy += tdy;
        n -= 2;
      } else if (tmx < tmy) {
        cx += sx;
        tmx += tdx;
        n -= 1;
      } else {
        cy += sy;
        tmy += tdy;
        n -= 1;
      }
      if (cx === ex && cy === ey) return true;
      if (this.isWall(cx, cy)) return false;
    }
    return true;
  }
  /**
   * @param {number} x @param {number} y @param {number} deg @param {number} maxCells
   * @param {(i: number, d: number) => boolean | void} visit
   */
  ray(x, y, deg, maxCells, visit) {
    const c = cosd(deg) * (UNIT / 2);
    const s = sind(deg) * (UNIT / 2);
    let last = -1;
    for (let k = 1; k <= maxCells * 2; k++) {
      const i = this.cellOf(x + c * k, y + s * k);
      if (i < 0 || this.wall[i] === 1) return;
      if (i === last) continue;
      last = i;
      if (visit(i, k / 2) === false) return;
    }
  }
  /**
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by
   */
  walkLine(ax, ay, bx, by) {
    const len = dist(ax, ay, bx, by);
    if (len < 1) return true;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const px = -uy * 400;
    const py = ux * 400;
    const steps = Math.ceil(len / 250);
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps;
      const y = ay + ((by - ay) * k) / steps;
      for (const o of [0, 1, -1]) {
        const i = this.cellOf(x + px * o, y + py * o);
        if (i < 0 || this.block[i] === 1) return false;
      }
    }
    return true;
  }
}
class Heap {
  constructor(cap = 4096) {
    this.node = new Int32Array(cap);
    this.key = new Float64Array(cap);
    this.size = 0;
    this.lastKey = 0;
  }
  clear() {
    this.size = 0;
  }
  /** @param {number} n @param {number} k */
  push(n, k) {
    if (this.size === this.node.length) {
      const node = new Int32Array(this.size * 2);
      const key = new Float64Array(this.size * 2);
      node.set(this.node);
      key.set(this.key);
      this.node = node;
      this.key = key;
    }
    const node = this.node;
    const key = this.key;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (key[p] <= k) break;
      node[i] = node[p];
      key[i] = key[p];
      i = p;
    }
    node[i] = n;
    key[i] = k;
  }
  pop() {
    const node = this.node;
    const key = this.key;
    const top = node[0];
    this.lastKey = key[0];
    const len = --this.size;
    if (len > 0) {
      const n = node[len];
      const k = key[len];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && key[r] < key[l] ? r : l;
        if (key[c] >= k) break;
        node[i] = node[c];
        key[i] = key[c];
        i = c;
      }
      node[i] = n;
      key[i] = k;
    }
    return top;
  }
}
/**
 * @param {Grid} g @param {readonly number[]} sources
 */
function dijkstra(g, sources) {
  const d = new Float64Array(g.N).fill(Infinity);
  const heap = new Heap();
  for (const s of sources) {
    if (!g.walkable(s)) continue;
    d[s] = 0;
    heap.push(s, 0);
  }
  const W = g.W;
  while (heap.size > 0) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > d[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy, c] of DIR8) {
      const nx = x + dx;
      const ny = y + dy;
      if (g.isBlock(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
      const j = ny * W + nx;
      const nd = di + c;
      if (nd < d[j]) {
        d[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  return d;
}
/** 矩形內所有可走格 @param {Grid} g @param {Rect} r */
function rectCells(g, r) {
  /** @type {number[]} */
  const out = [];
  for (let y = Math.max(0, r.y0); y < Math.min(g.H, r.y1); y++) {
    for (let x = Math.max(0, r.x0); x < Math.min(g.W, r.x1); x++) {
      const i = y * g.W + x;
      if (g.block[i] === 0) out.push(i);
    }
  }
  return out;
}
/**
 * @typedef {{ id: number, a: number, b: number, cells: number[], width: number, x: number, y: number, ax: number, ay: number, bx: number, by: number, choke: boolean, covers: Spot[] }} Portal
 */
/** @typedef {{ x: number, y: number, cell: number, fx: number, fy: number, score: number, entrance: number }} Spot */
/** 包點入口（包點區域與外面的交界） @typedef {{ portal: number, x: number, y: number, ix: number, iy: number, ox: number, oy: number, tDist: number, ctDist: number }} Entrance */
/** @typedef {{ id: 'A' | 'B', rect: Rect, cx: number, cy: number, regions: Set<number>, entrances: Entrance[], holds: Spot[], plants: Spot[] }} SiteIntel */
/** 路線：依序經過的區域與交界，points 是交界中點（最後一點是包點中心）；length 為格 @typedef {{ site: 'A' | 'B', team: 'T' | 'CT', regions: number[], regionSet: Set<number>, portals: number[], points: Pt[], length: number }} Route */
class MapIntel {
  /**
   * @param {MapInfo} map
   * @param {Grid} g
   */
  constructor(map, g) {
    this.g = g;
    this.map = map;
    const N = g.N;
    const W = g.W;
    this.regionCount = map.regions.length;
    /** @type {string[]} */
    this.regionNames = map.regions.map((r) => r.name);
    this.region = new Int16Array(N).fill(-1);
    const order = map.regions.map((r, i) => ({ i, area: (r.x1 - r.x0) * (r.y1 - r.y0) })).sort((a, b) => a.area - b.area || a.i - b.i);
    /** @type {number[]} */
    const queue = [];
    for (let i = 0; i < N; i++) {
      if (g.block[i] === 1) continue;
      const cx = i % W;
      const cy = (i - cx) / W;
      for (const o of order) {
        if (inRect(map.regions[o.i], cx, cy)) {
          this.region[i] = o.i;
          queue.push(i);
          break;
        }
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const cx = i % W;
      const cy = (i - cx) / W;
      for (let k = 0; k < 4; k++) {
        const j = (cy + DIR8[k][1]) * W + cx + DIR8[k][0];
        if (!g.walkable(j) || this.region[j] >= 0) continue;
        this.region[j] = this.region[i];
        queue.push(j);
      }
    }
    this.distSite = { A: dijkstra(g, rectCells(g, this.siteRect('A'))), B: dijkstra(g, rectCells(g, this.siteRect('B'))) };
    this.distSpawn = { T: dijkstra(g, rectCells(g, map.spawnZones.T)), CT: dijkstra(g, rectCells(g, map.spawnZones.CT)) };
    this.exposure = new Uint8Array(N);
    this.cover = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (g.block[i] === 1) continue;
      const cx = i % W;
      const cy = (i - cx) / W;
      let open = 0;
      let cov = 0;
      for (const [dx, dy] of DIR8) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (g.isWall(nx, ny)) cov |= 1;
        else if (g.low[ny * W + nx] === 1) cov |= 2;
        let k = 1;
        while (k <= P.exposeRay && !g.isWall(cx + dx * k, cy + dy * k)) k++;
        if (k > P.exposeRay) open++;
      }
      this.exposure[i] = open;
      this.cover[i] = cov;
    }
    /** @type {Portal[]} */
    this.portals = [];
    this.portalAt = new Int16Array(N).fill(-1);
    this.findPortals();
    this.chokes = this.portals.filter((p) => p.choke);
    for (const c of this.chokes) c.covers = this.chokeCovers(c);
    /** @type {Record<'A' | 'B', SiteIntel>} */
    this.sites = { A: this.siteIntel('A'), B: this.siteIntel('B') };
    /** @type {Record<'T' | 'CT', Record<'A' | 'B', Route[]>>} */
    this.routes = {
      T: { A: this.routeSet('T', 'A'), B: this.routeSet('T', 'B') },
      CT: { A: this.routeSet('CT', 'A'), B: this.routeSet('CT', 'B') },
    };
  }
  /** @param {'A' | 'B'} id */
  siteRect(id) {
    const s = this.map.sites.find((x) => x.id === id);
    if (s === undefined) throw new Error(`地圖沒有 ${id} 點`);
    return s;
  }
  /** 離 (x, y) 最近的可走格（格座標） @param {number} cx @param {number} cy */
  nearestOpen(cx, cy) {
    const g = this.g;
    for (let r = 0; r < 20; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!g.isBlock(x, y)) return y * g.W + x;
        }
      }
    }
    return -1;
  }
  /** 區域名稱（只給喊話與報告） @param {number} r */
  regionName(r) {
    return r >= 0 && r < this.regionNames.length ? this.regionNames[r] : '?';
  }
  findPortals() {
    const g = this.g;
    const W = g.W;
    /** @type {Map<number, number[]>} */
    const byPair = new Map();
    const mark = new Int32Array(g.N).fill(-1);
    for (let i = 0; i < g.N; i++) {
      const a = this.region[i];
      if (a < 0) continue;
      const cx = i % W;
      const cy = (i - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DIR8[k][0];
        const ny = cy + DIR8[k][1];
        if (g.isBlock(nx, ny)) continue;
        const b = this.region[ny * W + nx];
        if (b <= a) continue;
        const key = a * 4096 + b;
        if (mark[i] === key) continue;
        mark[i] = key;
        let list = byPair.get(key);
        if (list === undefined) byPair.set(key, (list = []));
        list.push(i);
      }
    }
    const keys = [...byPair.keys()].sort((x, y) => x - y);
    const comp = new Int32Array(g.N).fill(-1);
    for (const key of keys) {
      const a = Math.floor(key / 4096);
      const b = key % 4096;
      const cells = /** @type {number[]} */ (byPair.get(key));
      const inSet = new Set(cells);
      for (const start of cells) {
        if (comp[start] === key) continue;
        /** @type {number[]} */
        const part = [start];
        comp[start] = key;
        for (let h = 0; h < part.length; h++) {
          const i = part[h];
          const cx = i % W;
          const cy = (i - cx) / W;
          for (const [dx, dy] of DIR8) {
            const j = (cy + dy) * W + cx + dx;
            if (!inSet.has(j) || comp[j] === key) continue;
            comp[j] = key;
            part.push(j);
          }
        }
        let sax = 0;
        let say = 0;
        let sbx = 0;
        let sby = 0;
        let nb = 0;
        /** @type {Set<number>} */
        const bSide = new Set();
        for (const i of part) {
          const cx = i % W;
          const cy = (i - cx) / W;
          sax += cx;
          say += cy;
          for (let k = 0; k < 4; k++) {
            const nx = cx + DIR8[k][0];
            const ny = cy + DIR8[k][1];
            const j = ny * W + nx;
            if (g.isBlock(nx, ny) || this.region[j] !== b || bSide.has(j)) continue;
            bSide.add(j);
            sbx += nx;
            sby += ny;
            nb++;
          }
        }
        const id = this.portals.length;
        const ax = ((sax / part.length) + 0.5) * UNIT;
        const ay = ((say / part.length) + 0.5) * UNIT;
        const bx = ((sbx / Math.max(1, nb)) + 0.5) * UNIT;
        const by = ((sby / Math.max(1, nb)) + 0.5) * UNIT;
        const width = part.length;
        this.portals.push({ id, a, b, cells: part, width, x: Math.round((ax + bx) / 2), y: Math.round((ay + by) / 2), ax: Math.round(ax), ay: Math.round(ay), bx: Math.round(bx), by: Math.round(by), choke: width <= P.chokeWidth, covers: [] });
        for (const i of part) this.portalAt[i] = id;
        for (const j of bSide) if (this.portalAt[j] < 0) this.portalAt[j] = id;
      }
    }
  }
  /**
   * @param {Portal} c
   * @returns {Spot[]}
   */
  chokeCovers(c) {
    const g = this.g;
    const cx = Math.floor(c.x / UNIT);
    const cy = Math.floor(c.y / UNIT);
    /** @type {(Spot | null)[]} */
    const best = [null, null];
    for (let y = cy - 16; y <= cy + 16; y++) {
      for (let x = cx - 16; x <= cx + 16; x++) {
        if (g.isBlock(x, y)) continue;
        const i = y * g.W + x;
        if (this.cover[i] === 0) continue;
        const p = g.center(i);
        const d = dist(p.x, p.y, c.x, c.y) / UNIT;
        if (d < 5 || d > 16 || !g.los(p.x, p.y, c.x, c.y)) continue;
        const side = dist(p.x, p.y, c.ax, c.ay) <= dist(p.x, p.y, c.bx, c.by) ? 0 : 1;
        const score = 10 - 8 * this.exposure[i] + ((this.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 9);
        const cur = best[side];
        if (cur === null || score > cur.score) best[side] = { x: p.x, y: p.y, cell: i, fx: c.x, fy: c.y, score, entrance: -1 };
      }
    }
    return /** @type {Spot[]} */ (best.filter((s) => s !== null));
  }
  /** @param {'A' | 'B'} id @returns {SiteIntel} */
  siteIntel(id) {
    const g = this.g;
    const rect = this.siteRect(id);
    const center = this.nearestOpen(Math.floor((rect.x0 + rect.x1) / 2), Math.floor((rect.y0 + rect.y1) / 2));
    const cp = g.center(center);
    /** @type {Set<number>} */
    const regions = new Set([this.region[center]]);
    const total = new Int32Array(this.regionCount);
    const inside = new Int32Array(this.regionCount);
    for (let i = 0; i < g.N; i++) {
      const r = this.region[i];
      if (r < 0) continue;
      total[r]++;
      if (inRect(rect, i % g.W, Math.floor(i / g.W))) inside[r]++;
    }
    for (let r = 0; r < this.regionCount; r++) if (total[r] > 0 && inside[r] * 2 >= total[r]) regions.add(r);
    /** @type {Entrance[]} */
    const entrances = [];
    for (const p of this.portals) {
      const ia = regions.has(p.a);
      const ib = regions.has(p.b);
      if (ia === ib) continue;
      const ix = ia ? p.ax : p.bx;
      const iy = ia ? p.ay : p.by;
      const ox = ia ? p.bx : p.ax;
      const oy = ia ? p.by : p.ay;
      const oc = g.cellOf(ox, oy);
      const tDist = oc < 0 ? Infinity : this.distSpawn.T[oc] / 10;
      const ctDist = oc < 0 ? Infinity : this.distSpawn.CT[oc] / 10;
      entrances.push({ portal: p.id, x: p.x, y: p.y, ix, iy, ox, oy, tDist, ctDist });
    }
    entrances.sort((a, b) => a.tDist - b.tDist);
    const site = { id, rect, cx: cp.x, cy: cp.y, regions, entrances, holds: /** @type {Spot[]} */ ([]), plants: /** @type {Spot[]} */ ([]) };
    site.holds = this.holdSpots(site);
    site.plants = this.plantSpots(site);
    return site;
  }
  /**
   * @param {SiteIntel} site
   * @returns {Spot[]}
   */
  holdSpots(site) {
    const g = this.g;
    const field = this.distSite[site.id];
    /** @type {number[]} */
    const cand = [];
    for (let i = 0; i < g.N; i++) if (field[i] <= P.holdSiteRadius * 10 && g.block[i] === 0) cand.push(i);
    const sees = cand.map((i) => {
      const p = g.center(i);
      return site.entrances.map((e) => dist(p.x, p.y, e.x, e.y) <= 30 * UNIT && g.los(p.x, p.y, e.x, e.y));
    });
    /** @type {Spot[]} */
    const out = [];
    site.entrances.forEach((e, ei) => {
      /** @type {Spot[]} */
      const ranked = [];
      cand.forEach((i, k) => {
        if (!sees[k][ei]) return;
        const p = g.center(i);
        const d = dist(p.x, p.y, e.x, e.y) / UNIT;
        if (d < P.holdMin || d > P.holdMax) return;
        let others = 0;
        for (let j = 0; j < site.entrances.length; j++) if (j !== ei && sees[k][j]) others++;
        const inSite = site.regions.has(this.region[i]) ? 4 : 0;
        const score = 100 - 25 * others - 6 * this.exposure[i] + ((this.cover[i] & 1) !== 0 ? 8 : 0) + ((this.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13) + inSite;
        ranked.push({ x: p.x, y: p.y, cell: i, fx: e.x, fy: e.y, score, entrance: ei });
      });
      ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
      const first = ranked[0];
      if (first === undefined) return;
      out.push(first);
      const second = ranked.find((s) => s.score >= first.score - 15 && dist(s.x, s.y, first.x, first.y) >= 5 * UNIT);
      if (second !== undefined) out.push(second);
    });
    /** @type {Spot[]} */
    const uniq = [];
    for (const s of out) if (!uniq.some((u) => u.cell === s.cell)) uniq.push(s);
    return uniq;
  }
  /**
   * @param {SiteIntel} site
   * @returns {Spot[]}
   */
  plantSpots(site) {
    const g = this.g;
    /** @type {Spot[]} */
    const ranked = [];
    const r = site.rect;
    for (let y = r.y0 + 1; y < r.y1 - 1; y++) {
      for (let x = r.x0 + 1; x < r.x1 - 1; x++) {
        if (g.isBlock(x, y) || g.isBlock(x + 1, y) || g.isBlock(x - 1, y) || g.isBlock(x, y + 1) || g.isBlock(x, y - 1)) continue;
        const i = y * g.W + x;
        const p = g.center(i);
        let seen = 0;
        for (const e of site.entrances) if (dist(p.x, p.y, e.x, e.y) <= 30 * UNIT && g.los(p.x, p.y, e.x, e.y)) seen++;
        const score = -20 * seen - 3 * this.exposure[i] + (this.cover[i] !== 0 ? 6 : 0) - (0.3 * dist(p.x, p.y, site.cx, site.cy)) / UNIT;
        ranked.push({ x: p.x, y: p.y, cell: i, fx: site.cx, fy: site.cy, score, entrance: -1 });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    /** @type {Spot[]} */
    const out = [];
    for (const s of ranked) {
      if (out.length >= 3) break;
      if (out.every((o) => dist(o.x, o.y, s.x, s.y) >= 4 * UNIT)) out.push(s);
    }
    if (out.length === 0) out.push({ x: site.cx, y: site.cy, cell: g.cellOf(site.cx, site.cy), fx: site.cx, fy: site.cy, score: 0, entrance: -1 });
    return out;
  }
  /**
   * @param {'T' | 'CT'} team @param {'A' | 'B'} id
   * @returns {Route[]}
   */
  routeSet(team, id) {
    const g = this.g;
    const zone = this.map.spawnZones[team];
    const startCell = this.nearestOpen(Math.floor((zone.x0 + zone.x1) / 2), Math.floor((zone.y0 + zone.y1) / 2));
    const start = g.center(startCell);
    const site = this.sites[id];
    const startRegion = this.region[startCell];
    const shortest = this.distSite[id][startCell] / 10;
    if (!Number.isFinite(shortest)) return [];
    const bound = shortest * P.routeSlack * UNIT;
    /** @type {{ portals: number[], regions: number[], points: Pt[], length: number }[]} */
    const found = [];
    /** @type {Portal[][]} */
    const adj = Array.from({ length: this.regionCount }, () => []);
    for (const p of this.portals) {
      adj[p.a].push(p);
      adj[p.b].push(p);
    }
    const visited = new Uint8Array(this.regionCount);
    /** @type {number[]} */
    const portals = [];
    /** @type {number[]} */
    const regs = [startRegion];
    /** @type {Pt[]} */
    const pts = [];
    let budget = 20000;
    /** @param {number} r @param {number} x @param {number} y @param {number} len */
    const dfs = (r, x, y, len) => {
      if (--budget < 0) return;
      if (site.regions.has(r)) {
        const total = len + dist(x, y, site.cx, site.cy);
        if (total <= bound) found.push({ portals: portals.slice(), regions: regs.slice(), points: [...pts, { x: site.cx, y: site.cy }], length: total / UNIT });
        return;
      }
      visited[r] = 1;
      for (const p of adj[r]) {
        const nr = p.a === r ? p.b : p.a;
        if (visited[nr] === 1) continue;
        const nl = len + dist(x, y, p.x, p.y);
        if (nl + dist(p.x, p.y, site.cx, site.cy) > bound) continue;
        portals.push(p.id);
        regs.push(nr);
        pts.push({ x: p.x, y: p.y });
        dfs(nr, p.x, p.y, nl);
        portals.pop();
        regs.pop();
        pts.pop();
      }
      visited[r] = 0;
    };
    dfs(startRegion, start.x, start.y, 0);
    found.sort((a, b) => a.length - b.length);
    /** @type {Route[]} */
    const out = [];
    /** @param {number[]} a @param {number[]} b */
    const overlap = (a, b) => {
      const sa = new Set(a.filter((r) => r !== startRegion && !site.regions.has(r)));
      const sb = new Set(b.filter((r) => r !== startRegion && !site.regions.has(r)));
      let inter = 0;
      for (const r of sa) if (sb.has(r)) inter++;
      const uni = sa.size + sb.size - inter;
      return uni === 0 ? 1 : inter / uni;
    };
    for (const f of found) {
      if (out.length >= P.routeMax) break;
      if (out.every((o) => overlap(o.regions, f.regions) < 0.6)) out.push({ site: id, team, regions: f.regions, regionSet: new Set(f.regions), portals: f.portals, points: f.points, length: Math.round(f.length) });
    }
    if (out.length === 1 && found.length > 1) {
      const first = out[0];
      let pick = found[1];
      for (const f of found) if (overlap(first.regions, f.regions) < overlap(first.regions, pick.regions)) pick = f;
      out.push({ site: id, team, regions: pick.regions, regionSet: new Set(pick.regions), portals: pick.portals, points: pick.points, length: Math.round(pick.length) });
    }
    return out;
  }
}
/** 有 id 的敵人 @typedef {{ id: number, x: number, y: number, vx: number, vy: number, facing: number, weapon: string, tick: number, seenTick: number, conf: number, src: 'see' | 'radar' | 'tracer' }} Known */
/** 不知道是誰的點：彈道起點、隊友陣亡處（敵人看得到這裡） @typedef {{ x: number, y: number, tick: number, conf: number, src: 'tracer' | 'death' }} Anon */
/** 扇形：從 (ox, oy) 朝 dir ± P.sectorHalfDeg、距離 r0～r1 格 @typedef {{ ox: number, oy: number, dir: number, r0: number, r1: number, tick: number, conf: number, kind: string }} Sector */
/** @typedef {{ x: number, y: number, conf: number, src: string, id: number }} Threat */
const BANDS = { near: P.bandNear, mid: P.bandMid, far: P.bandFar };
const ENEMY_SOUNDS = new Set(['footstep', 'shot', 'reload', 'plant', 'defuse']);
class Perception {
  /**
   * @param {Grid} g
   * @param {MapIntel} intel
   * @param {InitData} data
   * @param {number} awareness 0～1
   */
  constructor(g, intel, data, awareness) {
    this.g = g;
    this.intel = intel;
    this.rules = data.rules;
    this.awareness = awareness;
    this.decay = lerp(P.decay0, P.decay100, awareness);
    this.trust = lerp(P.trust0, P.trust100, awareness);
    this.clearTtl = Math.round(lerp(P.clearTtl0, P.clearTtl100, awareness) * data.rules.ticksPerSecond);
    /** @type {Map<number, Known>} */
    this.known = new Map();
    /** @type {Anon[]} */
    this.anon = [];
    /** @type {Sector[]} */
    this.sectors = [];
    this.seenTick = new Int32Array(g.N).fill(-1000000);
    this.danger = new Float32Array(g.N);
    this.stamp = new Int32Array(g.N);
    this.stampId = 0;
    this.portalThreat = new Float32Array(intel.portals.length);
    this.regionSeen = new Float32Array(intel.regionCount);
    this.dangerTick = -1000000;
    this.dangerDirty = true;
    this.lastTick = -1;
    this.updates = 0;
    /** @type {Map<number, boolean>} */
    this.mateAlive = new Map();
    this.liveStart = -1;
    /** @type {{ dir: number, tick: number } | null} */
    this.lastHurt = null;
    /** @type {Sector | null} */
    this.lastSound = null;
    /** @type {number[]} */
    this.newIds = [];
    this.myTeam = /** @type {Team} */ ('T');
  }
  reset() {
    this.known.clear();
    this.anon.length = 0;
    this.sectors.length = 0;
    this.seenTick.fill(-1000000);
    this.danger.fill(0);
    this.portalThreat.fill(0);
    this.regionSeen.fill(0);
    this.dangerTick = -1000000;
    this.dangerDirty = true;
    this.lastTick = -1;
    this.mateAlive.clear();
    this.liveStart = -1;
    this.lastHurt = null;
    this.lastSound = null;
  }
  /** @param {Observation} obs */
  update(obs) {
    const me = obs.me;
    const t = obs.tick;
    this.myTeam = me.team;
    this.updates++;
    if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
    const dt = this.lastTick < 0 ? 0 : (t - this.lastTick) / this.rules.ticksPerSecond;
    this.lastTick = t;
    this.newIds = [];
    const loss = this.decay * dt;
    for (const [id, k] of this.known) {
      k.conf -= loss;
      if (k.conf <= 0) this.known.delete(id);
    }
    this.anon = this.anon.filter((a) => (a.conf -= loss) > 0);
    this.sectors = this.sectors.filter((s) => (s.conf -= loss * 1.5) > 0);
    for (const e of obs.enemies) {
      const k = this.known.get(e.id);
      let vx = 0;
      let vy = 0;
      if (k !== undefined && t - k.tick > 0 && t - k.tick <= 9) {
        vx = (e.x - k.x) / (t - k.tick);
        vy = (e.y - k.y) / (t - k.tick);
      }
      if (k === undefined || k.conf < P.unconfirmed) {
        this.newIds.push(e.id);
        this.dangerDirty = true;
      }
      this.known.set(e.id, { id: e.id, x: e.x, y: e.y, vx, vy, facing: e.facing, weapon: e.weapon, tick: t, seenTick: t, conf: P.confSee, src: 'see' });
    }
    for (const r of obs.radar) {
      const k = this.known.get(r.id);
      if (k !== undefined && k.tick === t) continue;
      let vx = 0;
      let vy = 0;
      if (k !== undefined && t - k.tick > 0 && t - k.tick <= 9) {
        vx = (r.x - k.x) / (t - k.tick);
        vy = (r.y - k.y) / (t - k.tick);
      }
      if (k === undefined || k.conf < P.unconfirmed) this.dangerDirty = true;
      const conf = Math.max(k?.conf ?? 0, P.confRadar * this.trust);
      this.known.set(r.id, { id: r.id, x: r.x, y: r.y, vx, vy, facing: k?.facing ?? 0, weapon: k?.weapon ?? '?', tick: t, seenTick: k?.seenTick ?? -1, conf, src: 'radar' });
    }
    for (const tr of obs.tracers) {
      if (tr.friendly) continue;
      this.notePoint(tr.x0, tr.y0, P.confTracer, t);
    }
    for (const h of me.hurt) {
      this.addSector(me.x, me.y, h.dirDeg, 0, 40, P.confHurt, t, 'hurt');
      this.lastHurt = { dir: h.dirDeg, tick: t };
    }
    for (const s of obs.sounds) {
      if (s.friendly || !ENEMY_SOUNDS.has(s.kind)) continue;
      const band = BANDS[s.range];
      this.lastSound = this.addSector(me.x, me.y, s.dirDeg, band[0], band[1], P.confSound * this.trust, t, s.kind);
    }
    for (const m of obs.teammates) {
      if (this.mateAlive.get(m.id) === true && !m.alive) {
        this.anon.push({ x: m.x, y: m.y, tick: t, conf: P.confDeath, src: 'death' });
        this.dangerDirty = true;
      }
      this.mateAlive.set(m.id, m.alive);
    }
    if (this.known.size > obs.enemiesAlive) {
      const list = [...this.known.values()].filter((k) => k.tick !== t).sort((a, b) => a.conf - b.conf || a.id - b.id);
      while (this.known.size > obs.enemiesAlive && list.length > 0) this.known.delete(/** @type {Known} */ (list.shift()).id);
    }
    if (me.alive && me.blindTicks === 0) this.scan(me.x, me.y, me.facing, me.scoped ? this.rules.scopedFovDeg : this.rules.fovDeg, me.scoped ? (this.rules.scopedViewRange ?? 60) : this.rules.viewRange, t);
    if (this.updates % P.mateScanEvery === 0) {
      for (const m of obs.teammates) if (m.alive && !m.blind) this.scan(m.x, m.y, m.facing, this.rules.fovDeg, this.rules.viewRange, t);
    }
    if (this.dangerDirty || t - this.dangerTick >= this.rules.ticksPerSecond) this.computeDanger(t);
  }
  /** 我打死的目標：從記憶刪掉 @param {number} id */
  forget(id) {
    if (this.known.delete(id)) this.dangerDirty = true;
  }
  /** @param {number} x @param {number} y @param {number} conf @param {number} t */
  notePoint(x, y, conf, t) {
    let best = null;
    let bestD = 2500;
    for (const k of this.known.values()) {
      const d = dist(k.x, k.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best !== null) {
      if (best.tick !== t) {
        best.x = x;
        best.y = y;
        best.tick = t;
      }
      best.conf = Math.max(best.conf, conf);
      return;
    }
    const a = this.anon.find((p) => p.src === 'tracer' && dist(p.x, p.y, x, y) < 2000);
    if (a !== undefined) {
      a.x = x;
      a.y = y;
      a.tick = t;
      a.conf = Math.max(a.conf, conf);
      return;
    }
    this.anon.push({ x, y, tick: t, conf, src: 'tracer' });
    this.dangerDirty = true;
  }
  /**
   * @param {number} ox @param {number} oy @param {number} dir @param {number} r0 @param {number} r1 @param {number} conf @param {number} t @param {string} kind
   */
  addSector(ox, oy, dir, r0, r1, conf, t, kind) {
    for (const s of this.sectors) {
      if (Math.abs(adiff(s.dir, dir)) < 20 && s.r0 === r0 && dist(s.ox, s.oy, ox, oy) < 3 * UNIT) {
        s.ox = ox;
        s.oy = oy;
        s.dir = dir;
        s.tick = t;
        s.conf = Math.max(s.conf, conf);
        s.kind = kind;
        return s;
      }
    }
    /** @type {Sector} */
    const s = { ox, oy, dir, r0, r1, tick: t, conf, kind };
    this.sectors.push(s);
    this.dangerDirty = true;
    return s;
  }
  /** 視錐掃描：記錄每格最近被看到的時間 @param {number} x @param {number} y @param {number} facing @param {number} fov @param {number} range @param {number} t */
  scan(x, y, facing, fov, range, t) {
    const half = fov / 2;
    const seen = this.seenTick;
    const g = this.g;
    const wall = g.wall;
    for (let a = -half; a <= half; a += 4) {
      const c = cosd(facing + a) * (UNIT / 2);
      const s = sind(facing + a) * (UNIT / 2);
      for (let k = 1; k <= range * 2; k++) {
        const i = g.cellOf(x + c * k, y + s * k);
        if (i < 0 || wall[i] === 1) break;
        seen[i] = t;
      }
    }
  }
  /** 某格最近被我方看過而且附近沒有記得的敵人 @param {number} i @param {number} t */
  cleared(i, t) {
    if (i < 0 || this.seenTick[i] < t - this.clearTtl) return false;
    const p = this.g.center(i);
    for (const k of this.known.values()) if (k.conf >= P.unconfirmed && dist(k.x, k.y, p.x, p.y) < 3 * UNIT) return false;
    return true;
  }
  /** 敵人此刻可能已經到得了這格（依開打後經過的時間與敵方出生區的路徑距離） @param {number} i @param {number} t @param {number} [margin] */
  reachable(i, t, margin = 2) {
    if (i < 0) return false;
    const enemy = this.myTeam === 'T' ? 'CT' : 'T';
    const d = this.intel.distSpawn[enemy][i] / 10;
    if (this.liveStart < 0) return d <= margin;
    return d <= ((t - this.liveStart) / this.rules.ticksPerSecond) * P.enemySpeed + margin;
  }
  /** 每秒：危險格成本（敵人看得到的格）、交界威脅、區域的已看過比例 @param {number} t */
  computeDanger(t) {
    const g = this.g;
    const danger = this.danger;
    danger.fill(0);
    this.portalThreat.fill(0);
    this.dangerTick = t;
    this.dangerDirty = false;
    const range = P.dangerRange;
    /** @param {number} x @param {number} y @param {number} value */
    const fromPoint = (x, y, value) => {
      const id = ++this.stampId;
      const stamp = this.stamp;
      const c = g.cellOf(x, y);
      if (c >= 0) {
        stamp[c] = id;
        danger[c] += value;
      }
      for (let a = 0; a < 360; a += 3) {
        g.ray(x, y, a, range, (i, d) => {
          if (stamp[i] === id) return;
          stamp[i] = id;
          danger[i] += value * (1 - (0.5 * d) / range);
        });
      }
    };
    for (const k of this.known.values()) if (k.conf >= 15) fromPoint(k.x, k.y, k.conf * P.dangerCoef);
    for (const a of this.anon) if (a.conf >= 15) fromPoint(a.x, a.y, a.conf * P.dangerCoef * (a.src === 'death' ? 0.7 : 1));
    for (const s of this.sectors) {
      if (s.conf < 15) continue;
      const id = ++this.stampId;
      const value = s.conf * P.sectorCoef;
      for (let r = Math.max(2, s.r0); r <= Math.min(s.r1, 35); r += 1.5) {
        for (let a = -P.sectorHalfDeg; a <= P.sectorHalfDeg; a += 5) {
          const i = g.cellOf(s.ox + cosd(s.dir + a) * r * UNIT, s.oy + sind(s.dir + a) * r * UNIT);
          if (i < 0 || g.block[i] === 1 || this.stamp[i] === id) continue;
          this.stamp[i] = id;
          danger[i] += value;
        }
      }
    }
    const portals = this.intel.portals;
    for (const p of portals) {
      let v = 0;
      for (const k of this.known.values()) {
        const d = dist(k.x, k.y, p.x, p.y) / UNIT;
        if (d < 10) v = Math.max(v, k.conf * (1 - d / 10));
      }
      for (const a of this.anon) {
        const d = dist(a.x, a.y, p.x, p.y) / UNIT;
        if (a.src === 'tracer' && d < 10) v = Math.max(v, a.conf * (1 - d / 10));
      }
      this.portalThreat[p.id] = v;
    }
    const n = this.intel.regionCount;
    const tot = new Int32Array(n);
    const seen = new Int32Array(n);
    const lim = t - this.clearTtl;
    for (let i = 0; i < g.N; i++) {
      const r = this.intel.region[i];
      if (r < 0) continue;
      tot[r]++;
      if (this.seenTick[i] >= lim) seen[r]++;
    }
    for (let r = 0; r < n; r++) this.regionSeen[r] = tot[r] === 0 ? 1 : seen[r] / tot[r];
  }
  /** 未確認區域：敵人可能到得了、最近被看過的格不到一半 @param {number} t */
  unconfirmedRegions(t) {
    /** @type {number[]} */
    const out = [];
    for (let r = 0; r < this.intel.regionCount; r++) {
      if (this.regionSeen[r] >= 0.5) continue;
      const reg = this.intel.map.regions[r];
      const c = this.intel.nearestOpen(Math.floor((reg.x0 + reg.x1) / 2), Math.floor((reg.y0 + reg.y1) / 2));
      if (this.reachable(c, t, 6)) out.push(r);
    }
    return out;
  }
  /** 記得的敵人（信心 ≥ 門檻），含不知道是誰的彈道點；最近的在前 @param {number} x @param {number} y @param {number} [minConf] @returns {Threat[]} */
  threats(x, y, minConf = P.unconfirmed) {
    /** @type {Threat[]} */
    const out = [];
    for (const k of this.known.values()) if (k.conf >= minConf) out.push({ x: k.x, y: k.y, conf: k.conf, src: k.src, id: k.id });
    for (const a of this.anon) if (a.src === 'tracer' && a.conf >= minConf) out.push({ x: a.x, y: a.y, conf: a.conf, src: a.src, id: -1 });
    out.sort((a, b) => dist(x, y, a.x, a.y) - dist(x, y, b.x, b.y));
    return out;
  }
  /** 最近的威脅（含方向，整數度）；沒有回傳 null @param {number} x @param {number} y */
  nearestThreat(x, y) {
    const t = this.threats(x, y)[0];
    return t === undefined ? null : { ...t, dir: angleTo(x, y, t.x, t.y) };
  }
}
/** @typedef {{ portal: number, hold: Pt, far: Pt, cross: Pt, phase: 'approach' | 'hold' | 'shoulder' | 'back', left: number, since: number }} Peek */
/** @typedef {{ cmds: Command[], look: Pt | null, moving: boolean, peeking: boolean, arrived: boolean, walk: boolean }} NavOut */
class Navigator {
  /**
   * @param {Grid} g
   * @param {MapIntel} intel
   * @param {Perception} perc
   * @param {{ aggression: number, movement: number }} attrs 0～1（侵略：探頭等待與方式；走位：肩探與靜步）
   * @param {InitData} data
   */
  constructor(g, intel, perc, attrs, data) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.attrs = attrs;
    this.tps = data.rules.ticksPerSecond;
    this.heap = new Heap();
    this.gScore = new Float64Array(g.N);
    this.parent = new Int32Array(g.N);
    this.visit = new Int32Array(g.N);
    this.visitId = 0;
    this.extra = new Float32Array(g.N);
    this.base = new Float32Array(g.N);
    for (let i = 0; i < g.N; i++) {
      if (g.block[i] === 1) continue;
      const c = intel.cover[i];
      this.base[i] = ((c & 1) !== 0 ? P.wallHug : 0) - ((c & 2) !== 0 ? P.lowBonus : 0);
    }
    this.peekHold = Math.round(lerp(P.peekHold0, P.peekHold100, attrs.aggression));
    /** 看得到的火區格（戰鬥層每次更新），A* 視為高成本 @type {Set<number>} */
    this.hazard = new Set();
    this.hazardSize = 0;
    /** @type {Pt | null} */
    this.goal = null;
    /** @type {Route | null} */
    this.route = null;
    /** @type {number[]} */
    this.path = [];
    /** @type {Pt[]} */
    this.wps = [];
    this.wpIdx = 0;
    this.planTick = -1000000;
    this.stuck = 0;
    this.moveStreak = 0;
    /** @type {Set<number> | null} */
    this.avoid = null;
    this.avoidUntil = -1;
    /** 和隊友正面互卡時的側移點（2.1） @type {{ x: number, y: number, until: number } | null} */
    this.side = null;
    /** 上一個走過的路徑點（被閃時退回去） @type {Pt | null} */
    this.prevPt = null;
    /** @type {Peek | null} */
    this.peek = null;
    /** @type {Map<number, number>} */
    this.peeked = new Map();
    this.replans = 0;
  }
  reset() {
    /** @type {Pt | null} */
    this.goal = null;
    /** @type {Route | null} */
    this.route = null;
    /** @type {number[]} */
    this.path = [];
    /** @type {Pt[]} */
    this.wps = [];
    this.wpIdx = 0;
    this.planTick = -1000000;
    this.stuck = 0;
    this.moveStreak = 0;
    /** @type {Set<number> | null} */
    this.avoid = null;
    this.avoidUntil = -1;
    /** 和隊友正面互卡時的側移點（2.1） @type {{ x: number, y: number, until: number } | null} */
    this.side = null;
    /** 上一個走過的路徑點（被閃時退回去） @type {Pt | null} */
    this.prevPt = null;
    /** @type {Peek | null} */
    this.peek = null;
    /** @type {Map<number, number>} */
    this.peeked = new Map();
    this.replans = 0;
  }
  /**
   * @param {number} x @param {number} y @param {Route | null} [route]
   */
  setGoal(x, y, route = null) {
    if (this.goal !== null && dist(this.goal.x, this.goal.y, x, y) < 500 && this.route === route) return;
    this.goal = { x, y };
    this.route = route;
    this.path = [];
    this.wps = [];
    this.peek = null;
  }
  clearGoal() {
    this.goal = null;
    this.path = [];
    this.wps = [];
    this.peek = null;
  }
  /**
   * @param {number} start @param {number} goal @param {Set<number> | null} avoid
   */
  astar(start, goal, avoid) {
    const g = this.g;
    if (start < 0 || goal < 0) return null;
    const W = g.W;
    const extra = this.extra;
    const danger = this.perc.danger;
    const route = this.route;
    const region = this.intel.region;
    for (let i = 0; i < g.N; i++) {
      if (g.block[i] === 1) continue;
      let e = this.base[i] + danger[i];
      if (route !== null && !route.regionSet.has(region[i])) e += P.offRoute;
      extra[i] = e;
    }
    for (const i of this.hazard) extra[i] += 300;
    const id = ++this.visitId;
    const vis = this.visit;
    const gs = this.gScore;
    const par = this.parent;
    const heap = this.heap;
    heap.clear();
    const gx = goal % W;
    const gy = (goal - gx) / W;
    /** @param {number} i */
    const h = (i) => {
      const dx = Math.abs((i % W) - gx);
      const dy = Math.abs(Math.floor(i / W) - gy);
      return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
    };
    vis[start] = id;
    gs[start] = 0;
    par[start] = -1;
    heap.push(start, h(start));
    while (heap.size > 0) {
      const i = heap.pop();
      const f = heap.lastKey;
      if (f > gs[i] + h(i) + 1e-6) continue;
      if (i === goal) break;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy, c] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (g.isBlock(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
        const j = ny * W + nx;
        if (avoid !== null && j !== goal && (avoid.has(j) || (dx !== 0 && dy !== 0 && (avoid.has(y * W + x + dx) || avoid.has((y + dy) * W + x))))) continue;
        const ng = gs[i] + c + Math.max(-c / 2, extra[j]);
        if (vis[j] !== id || ng < gs[j]) {
          vis[j] = id;
          gs[j] = ng;
          par[j] = i;
          heap.push(j, ng + h(j));
        }
      }
    }
    if (vis[goal] !== id) return null;
    /** @type {number[]} */
    const out = [];
    for (let i = goal; i >= 0; i = par[i]) out.push(i);
    out.reverse();
    return out;
  }
  /** 直線走得過去，而且不經過 avoid 的格 @param {Pt} a @param {Pt} b @param {Set<number> | null} avoid */
  lineOK(a, b, avoid) {
    const g = this.g;
    if (!g.walkLine(a.x, a.y, b.x, b.y)) return false;
    if (avoid === null || avoid.size === 0) return true;
    const len = dist(a.x, a.y, b.x, b.y);
    if (len < 1) return !avoid.has(g.cellOf(a.x, a.y));
    const px = (-(b.y - a.y) / len) * 400;
    const py = ((b.x - a.x) / len) * 400;
    const steps = Math.max(1, Math.ceil(len / 250));
    for (let k = 0; k <= steps; k++) {
      const x = a.x + ((b.x - a.x) * k) / steps;
      const y = a.y + ((b.y - a.y) * k) / steps;
      for (const o of [0, 1, -1]) if (avoid.has(g.cellOf(x + px * o, y + py * o))) return false;
    }
    return true;
  }
  /** 路徑平滑：直線走得過去（不經過 avoid、火區）就跳過中間的格，每段不超過 P.maxSegment 格 @param {number[]} path @param {Set<number> | null} avoid @param {Pt} from 起點（自己的位置） @returns {Pt[]} */
  smooth(path, avoid, from) {
    const g = this.g;
    /** @type {Set<number> | null} */
    let bad = avoid;
    if (this.hazard.size > 0) bad = new Set([...(avoid ?? []), ...this.hazard]);
    /** @type {Pt[]} */
    const out = [];
    let i = 0;
    const maxJ = Math.round(P.maxSegment * 1.2);
    while (i < path.length - 1) {
      const a = i === 0 ? from : g.center(path[i]);
      let j = Math.min(path.length - 1, i + maxJ);
      for (; j > i + 1; j--) {
        const b = g.center(path[j]);
        if (dist(a.x, a.y, b.x, b.y) <= P.maxSegment * UNIT && this.lineOK(a, b, bad)) break;
      }
      out.push(g.center(path[j]));
      i = j;
    }
    return out;
  }
  /** @param {Observation} obs @param {Set<number> | null} avoid */
  plan(obs, avoid) {
    const me = obs.me;
    const goal = /** @type {Pt} */ (this.goal);
    const g = this.g;
    let start = g.cellOf(me.x, me.y);
    if (!g.walkable(start)) start = this.intel.nearestOpen(Math.floor(me.x / UNIT), Math.floor(me.y / UNIT));
    let gc = g.cellOf(goal.x, goal.y);
    if (!g.walkable(gc)) gc = this.intel.nearestOpen(Math.floor(goal.x / UNIT), Math.floor(goal.y / UNIT));
    this.replans++;
    const path = this.astar(start, gc, avoid) ?? (avoid !== null ? this.astar(start, gc, null) : null);
    this.planTick = obs.tick;
    if (path === null) {
      this.path = [];
      this.wps = [{ x: goal.x, y: goal.y }];
      this.wpIdx = 0;
      return;
    }
    this.path = path;
    const wps = this.smooth(path, avoid, { x: me.x, y: me.y });
    this.hazardSize = this.hazard.size;
    if (wps.length > 0) wps[wps.length - 1] = { x: goal.x, y: goal.y };
    else wps.push({ x: goal.x, y: goal.y });
    this.wps = wps;
    this.wpIdx = 0;
  }
  /**
   * @param {Observation} obs
   * @param {{ allowPeek: boolean, speed: number }} opts
   * @returns {NavOut}
   */
  step(obs, opts) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {NavOut} */
    const out = { cmds: [], look: null, moving: false, peeking: false, arrived: false, walk: false };
    if (this.goal === null) {
      this.moveStreak = 0;
      return out;
    }
    const goal = this.goal;
    if (dist(me.x, me.y, goal.x, goal.y) < 450) {
      out.arrived = true;
      this.moveStreak = 0;
      this.stuck = 0;
      this.peek = null;
      return out;
    }
    const freeze = obs.round.phase === 'freeze';
    const still = Math.abs(me.vx) + Math.abs(me.vy) < opts.speed * 0.25;
    const holding = this.peek !== null && this.peek.phase === 'hold';
    if (!freeze && !holding && this.moveStreak >= 3 && still) this.stuck++;
    else this.stuck = 0;
    let avoid = this.avoid !== null && t < this.avoidUntil ? this.avoid : null;
    const blockedAhead = this.stuck >= 4 && this.personAhead(obs);
    if (this.stuck >= P.stuckDecisions || blockedAhead) {
      if (blockedAhead && obs.teammates.some((m) => m.alive && dist(m.x, m.y, me.x, me.y) < 900)) this.side = this.sideStep(obs);
      avoid = this.peopleCells(obs);
      this.avoid = avoid;
      this.avoidUntil = t + 2 * this.tps;
      this.stuck = 0;
      this.peek = null;
      this.plan(obs, avoid);
    }
    const wp = this.wps[this.wpIdx];
    const off = wp !== undefined && dist(me.x, me.y, wp.x, wp.y) > 4 * UNIT && !this.g.walkLine(me.x, me.y, wp.x, wp.y);
    if (this.wps.length === 0 || off || this.hazard.size !== this.hazardSize || (this.perc.dangerTick > this.planTick && t - this.planTick >= P.replanTicks)) this.plan(obs, avoid);
    while (this.wpIdx < this.wps.length - 1) {
      const p = this.wps[this.wpIdx];
      if (dist(me.x, me.y, p.x, p.y) >= P.waypointReach) break;
      this.prevPt = p;
      this.wpIdx++;
    }
    let target = this.wps[this.wpIdx];
    if (!opts.allowPeek || freeze) this.peek = null;
    else {
      if (this.peek === null) this.peek = this.findPeek(obs);
      if (this.peek !== null) {
        const pk = this.peek;
        const dHold = dist(me.x, me.y, pk.hold.x, pk.hold.y);
        if (dHold > 9 * UNIT || t - pk.since > 8 * this.tps) {
          this.peeked.set(pk.portal, t);
          this.peek = null;
        } else {
          out.peeking = true;
          out.look = pk.far;
          out.walk = true;
          if (pk.phase === 'approach') {
            target = pk.hold;
            if (dHold < 700) {
              pk.phase = 'hold';
              pk.left = this.peekHold;
            }
          }
          if (pk.phase === 'hold') {
            target = pk.hold;
            if (--pk.left <= 0) {
              if (this.attrs.aggression * 100 < P.shoulderBelow && this.attrs.movement * 100 >= P.shoulderMove) {
                pk.phase = 'shoulder';
                pk.left = 3;
              } else {
                this.peeked.set(pk.portal, t);
                this.peek = null;
              }
            }
          } else if (pk.phase === 'shoulder') {
            target = pk.cross;
            if (--pk.left <= 0) {
              pk.phase = 'back';
              pk.left = 3;
            }
          } else if (pk.phase === 'back') {
            target = pk.hold;
            if (--pk.left <= 0) {
              this.peeked.set(pk.portal, t);
              this.peek = null;
            }
          }
        }
      }
    }
    if (this.peek !== null && this.peek.phase === 'hold' && dist(me.x, me.y, this.peek.hold.x, this.peek.hold.y) < 700) {
      out.cmds.push({ type: 'stop' });
      this.moveStreak = 0;
      out.moving = false;
      return out;
    }
    if (this.side !== null && t < this.side.until) target = this.side;
    out.cmds.push({ type: 'move', x: Math.round(target.x), y: Math.round(target.y) });
    this.moveStreak++;
    out.moving = true;
    if (!out.walk && this.attrs.movement * 100 > P.silentMove && obs.round.phase === 'live') {
      const th = this.perc.nearestThreat(me.x, me.y);
      if (th !== null && dist(th.x, th.y, me.x, me.y) < 20 * UNIT) out.walk = true;
    }
    return out;
  }
  /** 側移點：前進方向的垂直方向 1.2 格、走得到的那一邊 @param {Observation} obs */
  sideStep(obs) {
    const me = obs.me;
    const wp = this.wps[this.wpIdx] ?? this.goal ?? me;
    const len = Math.max(1, dist(me.x, me.y, wp.x, wp.y));
    const px = -(wp.y - me.y) / len;
    const py = (wp.x - me.x) / len;
    for (const sgn of me.id % 2 === 0 ? [1, -1] : [-1, 1]) {
      const x = me.x + sgn * px * 1200;
      const y = me.y + sgn * py * 1200;
      if (this.g.walkLine(me.x, me.y, x, y)) return { x, y, until: obs.tick + 15 };
    }
    return null;
  }
  /** 有活人貼在前進方向 1 格內 @param {Observation} obs */
  personAhead(obs) {
    const me = obs.me;
    const wp = this.wps[this.wpIdx];
    if (wp === undefined) return false;
    const len = dist(me.x, me.y, wp.x, wp.y);
    if (len < 1) return false;
    const ux = (wp.x - me.x) / len;
    const uy = (wp.y - me.y) / len;
    /** @param {number} x @param {number} y */
    const ahead = (x, y) => {
      const along = (x - me.x) * ux + (y - me.y) * uy;
      const side = Math.abs((x - me.x) * uy - (y - me.y) * ux);
      return along > 0 && along < 1100 && side < 700;
    };
    return obs.teammates.some((m) => m.alive && ahead(m.x, m.y)) || obs.enemies.some((e) => ahead(e.x, e.y));
  }
  /** 其他活人周圍 1 格（自己的格除外）：被擋住時當障礙 @param {Observation} obs */
  peopleCells(obs) {
    const g = this.g;
    /** @type {Set<number>} */
    const s = new Set();
    const mine = g.cellOf(obs.me.x, obs.me.y);
    const people = [...obs.teammates.filter((m) => m.alive), ...obs.enemies];
    for (const q of people) {
      if (dist(q.x, q.y, obs.me.x, obs.me.y) > 8 * UNIT) continue;
      const cx = Math.floor(q.x / UNIT);
      const cy = Math.floor(q.y / UNIT);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = (cy + dy) * g.W + cx + dx;
          if (i === mine || !g.walkable(i)) continue;
          const c = g.center(i);
          if (dist(c.x, c.y, q.x, q.y) < 900 && dist(c.x, c.y, obs.me.x, obs.me.y) > 1000) s.add(i);
        }
      }
    }
    return s;
  }
  /**
   * @param {Observation} obs
   * @returns {Peek | null}
   */
  findPeek(obs) {
    const g = this.g;
    const me = obs.me;
    const t = obs.tick;
    const path = this.path;
    if (path.length < 4) return null;
    const mine = g.cellOf(me.x, me.y);
    let k = path.indexOf(mine);
    if (k < 0) {
      let best = Infinity;
      for (let i = 0; i < path.length; i++) {
        const c = g.center(path[i]);
        const d = dist(c.x, c.y, me.x, me.y);
        if (d < best) {
          best = d;
          k = i;
        }
      }
    }
    const region = this.intel.region;
    for (let i = Math.max(k, 0); i < Math.min(path.length - 1, k + 12); i++) {
      if (region[path[i]] === region[path[i + 1]]) continue;
      const pid = this.intel.portalAt[path[i]] >= 0 ? this.intel.portalAt[path[i]] : this.intel.portalAt[path[i + 1]];
      if (pid < 0) continue;
      const portal = this.intel.portals[pid];
      if (!portal.choke && !this.isEntrance(pid)) continue;
      const last = this.peeked.get(pid);
      if (last !== undefined && t - last < 15 * this.tps) continue;
      const farIdx = Math.min(path.length - 1, i + 3);
      const far = g.center(path[farIdx]);
      if (!this.perc.reachable(path[farIdx], t, 4) || this.perc.cleared(path[farIdx], t)) continue;
      if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, far.x, far.y) < 6 * UNIT)) continue;
      const holdIdx = Math.max(k, i - P.peekStop);
      if (holdIdx === k && i - k < P.peekStop) {
        this.peeked.set(pid, t);
        continue;
      }
      const lookIdx = Math.min(path.length - 1, i + 6);
      return { portal: pid, hold: g.center(path[holdIdx]), far: g.center(path[lookIdx]), cross: g.center(path[i]), phase: 'approach', left: 0, since: t };
    }
    return null;
  }
  /** @param {number} pid */
  isEntrance(pid) {
    return this.intel.sites.A.entrances.some((e) => e.portal === pid) || this.intel.sites.B.entrances.some((e) => e.portal === pid);
  }
  /**
   * @param {Observation} obs @param {readonly Pt[]} threats
   * @returns {Pt | null}
   */
  findCover(obs, threats) {
    if (threats.length === 0) return null;
    const g = this.g;
    const start = g.cellOf(obs.me.x, obs.me.y);
    if (start < 0) return null;
    const W = g.W;
    /** @type {number[]} */
    const queue = [start];
    const depth = new Map([[start, 0]]);
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const d = /** @type {number} */ (depth.get(i));
      const p = g.center(i);
      if (i !== start && threats.every((th) => !g.los(th.x, th.y, p.x, p.y))) return p;
      if (d >= P.coverRadius) continue;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (g.isBlock(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
        const j = ny * W + nx;
        if (depth.has(j)) continue;
        depth.set(j, d + 1);
        queue.push(j);
      }
    }
    return null;
  }
  /**
   * @param {Observation} obs @param {(i: number) => boolean} bad @param {number} maxDepth
   * @returns {Pt | null}
   */
  escape(obs, bad, maxDepth) {
    const g = this.g;
    const start = g.cellOf(obs.me.x, obs.me.y);
    if (start < 0) return null;
    const W = g.W;
    /** @type {number[]} */
    const queue = [start];
    const depth = new Map([[start, 0]]);
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const d = /** @type {number} */ (depth.get(i));
      if (!bad(i)) return g.center(i);
      if (d >= maxDepth) continue;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (g.isBlock(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
        const j = ny * W + nx;
        if (depth.has(j)) continue;
        depth.set(j, d + 1);
        queue.push(j);
      }
    }
    return null;
  }
}
/**
 * @typedef {{ engaged: boolean, aim: Pt | null, fire: boolean, move: 'stop' | Pt | null, crouch: boolean | null, holdNav: boolean, cmds: Command[], why: string }} Fight
 */
const HALF_ANGLE_K = 300 * 5730;
class Combat {
  /**
   * @param {Grid} g @param {MapIntel} intel @param {Perception} perc @param {Navigator} nav
   * @param {Record<AttributeKey, number> & { offAim?: number }} attrs 0～1（offAim：拿狙擊槍以外的槍時的瞄準）
   * @param {InitData} data @param {Helpers} h
   */
  constructor(g, intel, perc, nav, attrs, data, h) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.nav = nav;
    this.attrs = attrs;
    this.h = h;
    this.rules = data.rules;
    this.tps = data.rules.ticksPerSecond;
    /** @type {Map<string, WeaponInfo>} */
    this.weapons = new Map(data.weapons.map((w) => [w.id, w]));
    this.err0 = lerp(P.aimErr0, P.aimErr100, attrs.aim) * UNIT;
    this.conv = lerp(P.aimConv0, P.aimConv100, attrs.aim);
    const off = attrs.offAim ?? attrs.aim;
    this.errOff = lerp(P.aimErr0, P.aimErr100, off) * UNIT;
    this.convOff = lerp(P.aimConv0, P.aimConv100, off);
    this.reactExtra = Math.round(lerp(P.react0, P.react100, attrs.reaction));
    this.preAim = 1 - P.preAimErr * attrs.awareness;
    this.awareness = attrs.awareness;
    this.wait = this.reactExtra;
    this.notice = lerp(P.notice0, P.notice100, attrs.awareness);
    /** 已注意到的敵人 → 最後看到的 tick @type {Map<number, number>} */
    this.noticed = new Map();
    this.soundReact = Math.round(lerp(3, 0, attrs.reaction));
    this.lead = data.rules.reactionTicks + P.leadExtra;
    this.retreatHp = lerp(P.retreatHp0, P.retreatHp100, attrs.aggression);
    this.outnumber = Math.floor(lerp(P.outnumber0, P.outnumber100, attrs.aggression) + 1e-9);
    this.holdAngle = Math.round(lerp(P.holdAngle0, P.holdAngle100, attrs.aggression) * this.tps);
    this.sloppy = lerp(P.sloppyStop0, P.sloppyStop100, attrs.movement);
    this.scanEvery = P.scanEvery;
    this.friendClear = lerp(P.friendClear0, P.friendClear100, attrs.discipline);
    this.firm = attrs.discipline * 100 >= P.holdFirm;
    this.targetId = -1;
    this.seen = 0;
    this.errX = 0;
    this.errY = 0;
    this.lostTick = -1000000;
    /** @type {Pt | null} */
    this.lostPos = null;
    this.blocked = 0;
    this.pistolUntil = -1;
    /** @type {Pt | null} */
    this.retreat = null;
    this.retreatUntil = -1;
    this.engagedDecisions = 0;
    this.scanIdx = 0;
    this.scanLeft = 0;
    this.soundSeen = -1;
    this.soundWait = 0;
    /** 走過的位置（被閃時退回）：每 0.5 秒記一次 @type {Pt[]} */
    this.trail = [];
    this.trailTick = -1000000;
    /** 被閃時要退回的點 @type {Pt | null} */
    this.blindBack = null;
  }
  reset() {
    this.noticed = new Map();
    this.targetId = -1;
    this.seen = 0;
    this.errX = 0;
    this.errY = 0;
    this.lostTick = -1000000;
    /** @type {Pt | null} */
    this.lostPos = null;
    this.blocked = 0;
    this.pistolUntil = -1;
    /** @type {Pt | null} */
    this.retreat = null;
    this.retreatUntil = -1;
    this.engagedDecisions = 0;
    this.scanIdx = 0;
    this.scanLeft = 0;
    this.soundSeen = -1;
    this.soundWait = 0;
    /** 走過的位置（被閃時退回）：每 0.5 秒記一次 @type {Pt[]} */
    this.trail = [];
    this.trailTick = -1000000;
    /** 被閃時要退回的點 @type {Pt | null} */
    this.blindBack = null;
  }
  /** @param {string} id */
  weapon(id) {
    return this.weapons.get(id);
  }
  /** 目前姿勢的基礎散佈 @param {Observation['me']} me @param {WeaponInfo} w @param {boolean} still @param {boolean} crouch */
  baseSpread(me, w, still, crouch) {
    const base = me.scoped && w.scopedSpread !== null ? w.scopedSpread : w.spread;
    const mul = crouch ? 0.7 : still ? 1 : me.walking ? 1.2 : w.movingMul;
    return base * mul;
  }
  /** 記錄走過的位置 @param {Observation} obs */
  track(obs) {
    const me = obs.me;
    if (obs.tick - this.trailTick < this.tps / 2) return;
    const last = this.trail[this.trail.length - 1];
    if (last !== undefined && dist(last.x, last.y, me.x, me.y) < 600) return;
    this.trailTick = obs.tick;
    this.trail.push({ x: me.x, y: me.y });
    if (this.trail.length > 8) this.trail.shift();
  }
  /**
   * @param {Observation} obs
   * @returns {{ move: Pt | null, crouch: boolean, why: string } | null}
   */
  evade(obs) {
    const me = obs.me;
    const g = this.g;
    /** @type {Set<number>} */
    const fire = new Set();
    for (const e of obs.effects) if (e.kind === 'fire' && e.cells !== undefined) for (const c of e.cells) fire.add(c);
    this.nav.hazard = fire;
    const mine = g.cellOf(me.x, me.y);
    if (fire.has(mine)) {
      const p = this.nav.escape(obs, (i) => fire.has(i), 10);
      if (p !== null) return { move: p, crouch: false, why: '離開火區' };
    }
    for (const pr of obs.projectiles) {
      if (pr.kind !== 'he' && pr.kind !== 'molotov' && pr.kind !== 'incendiary') continue;
      if (dist(pr.x, pr.y, me.x, me.y) > P.nadeAvoid * UNIT) continue;
      const r = (P.nadeAvoid + 1) * UNIT;
      const p = this.nav.escape(obs, (i) => {
        const c = g.center(i);
        return dist(c.x, c.y, pr.x, pr.y) < r || fire.has(i);
      }, 9);
      if (p !== null) return { move: p, crouch: false, why: '躲道具' };
    }
    if (me.blindTicks <= 0) this.blindBack = null;
    else {
      if (this.blindBack !== null) {
        if (dist(me.x, me.y, this.blindBack.x, this.blindBack.y) < 600) return { move: null, crouch: true, why: '被閃・蹲' };
        return { move: this.blindBack, crouch: false, why: '被閃・後退' };
      }
      let back = null;
      for (let i = this.trail.length - 1; i >= 0; i--) {
        const p = this.trail[i];
        if (dist(p.x, p.y, me.x, me.y) >= 2500 && g.walkLine(me.x, me.y, p.x, p.y)) {
          back = p;
          break;
        }
      }
      if (back === null) {
        const th = this.perc.nearestThreat(me.x, me.y);
        const dir = th !== null ? th.dir + 180 : me.facing + 180;
        const p = this.nav.escape(obs, (i) => {
          const c = g.center(i);
          return dist(c.x, c.y, me.x, me.y) < 2500 || Math.abs(adiff(angleTo(me.x, me.y, c.x, c.y), dir)) > 60;
        }, 5);
        back = p;
      }
      if (back === null) return { move: null, crouch: true, why: '被閃・原地蹲' };
      this.blindBack = back;
      return { move: back, crouch: false, why: '被閃・後退' };
    }
    return null;
  }
  /** 這個敵人注意到了沒（餘光察覺） @param {Observation} obs @param {Enemy} e */
  spot(obs, e) {
    const me = obs.me;
    const t = obs.tick;
    const last = this.noticed.get(e.id);
    const ok = (last !== undefined && t - last <= this.tps) || e.firing || Math.abs(adiff(angleTo(me.x, me.y, e.x, e.y), me.facing)) <= P.periphDeg || this.h.random() < this.notice;
    if (ok) this.noticed.set(e.id, t);
    return ok;
  }
  /**
   * @param {Observation} obs
   * @param {{ holding: boolean, objective: boolean }} ctx holding＝守位中；objective＝下包／拆包中（不開槍不移動）
   * @returns {Fight}
   */
  engage(obs, ctx) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {Fight} */
    const out = { engaged: false, aim: null, fire: false, move: null, crouch: null, holdNav: false, cmds: [], why: '' };
    for (const s of me.shots) if (s.kill && this.targetId >= 0) this.perc.forget(this.targetId);
    const vis = obs.enemies.filter((e) => this.spot(obs, e));
    if (vis.length === 0) return this.noEnemy(obs, out, ctx);
    let best = vis[0];
    let bestS = -Infinity;
    for (const e of vis) {
      const d = dist(me.x, me.y, e.x, e.y) / UNIT;
      let s = 100 - 2.5 * d;
      if (Math.abs(adiff(e.facing, angleTo(e.x, e.y, me.x, me.y))) < 25) s += 25;
      if (e.weapon === 'awp') s += 10;
      if (e.planting || e.defusing) s += 40;
      if (e.firing) s += 10;
      if (e.id === this.targetId) s += 15;
      if (s > bestS) {
        bestS = s;
        best = e;
      }
    }
    const e = best;
    out.engaged = true;
    this.engagedDecisions++;
    if (e.id !== this.targetId) {
      this.targetId = e.id;
      this.seen = 0;
      const ahead = Math.abs(adiff(angleTo(me.x, me.y, e.x, e.y), me.facing)) <= P.preAimDeg;
      const cut = ahead && this.h.random() < this.awareness ? 1 : 0;
      this.wait = Math.max(Math.min(1, this.reactExtra), this.reactExtra - cut);
      const a = Math.floor(this.h.random() * 360);
      const mag = (me.weapon === 'awp' ? this.err0 : this.errOff) * (0.6 + 0.8 * this.h.random()) * (ahead ? this.preAim : 1);
      this.errX = cosd(a) * mag;
      this.errY = sind(a) * mag;
    } else {
      this.seen++;
      const moving = Math.abs(me.vx) + Math.abs(me.vy) > 30;
      const c = me.weapon === 'awp' ? this.conv : this.convOff;
      const k = moving ? Math.sqrt(c) : c;
      this.errX *= k;
      this.errY *= k;
    }
    this.lostTick = t;
    const k = this.perc.known.get(e.id);
    let vx = k?.vx ?? 0;
    let vy = k?.vy ?? 0;
    const sp = Math.sqrt(vx * vx + vy * vy);
    if (sp > 200) {
      vx = (vx * 200) / sp;
      vy = (vy * 200) / sp;
    }
    const px = e.x + vx * this.lead;
    const py = e.y + vy * this.lead;
    this.lostPos = { x: px, y: py };
    const aim = { x: Math.round(px + this.errX), y: Math.round(py + this.errY) };
    out.aim = aim;
    const d = dist(me.x, me.y, e.x, e.y);
    const dc = d / UNIT;
    if (ctx.objective) {
      out.why = '下包／拆包中';
      return out;
    }
    const primary = me.loadout.primary;
    const secondary = me.loadout.secondary;
    const wid = me.weapon;
    if (wid === 'knife' && (primary !== null || secondary !== null) && dc > 2) {
      out.cmds.push({ type: 'switch', slot: primary !== null ? 'primary' : 'secondary' });
      out.why = '拔槍';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    const w = this.weapon(wid);
    if (w === undefined) return out;
    if (wid === 'awp' && dc < P.awpClose && secondary !== null && me.weapon !== secondary) {
      out.cmds.push({ type: 'switch', slot: 'secondary' });
      this.pistolUntil = t + 3 * this.tps;
      out.why = '近距離切手槍';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    if (me.ammoMag === 0 && w.magazine > 0) {
      if (wid === primary && secondary !== null && dc < P.pistolSwitch) {
        out.cmds.push({ type: 'switch', slot: 'secondary' });
        this.pistolUntil = t + 3 * this.tps;
        out.why = '沒子彈・切手槍';
        return this.finishMove(obs, out, e, false, d, ctx);
      }
      if (me.ammoReserve > 0 && me.reloadTicksLeft === 0) out.cmds.push({ type: 'reload' });
      out.why = '換彈';
      return this.finishMove(obs, out, e, false, d, ctx, true);
    }
    const inRange = wid === 'knife' ? dc <= 1.4 : dc <= w.range;
    if (!inRange) {
      if (ctx.holding && this.firm) {
        out.why = '射程外・守位不追';
        return out;
      }
      out.why = '射程外・接近';
      out.move = { x: e.x, y: e.y };
      return out;
    }
    let block = false;
    const drift = (Math.abs(me.vx) + Math.abs(me.vy)) * this.rules.reactionTicks;
    for (const m of obs.teammates) {
      if (!m.alive) continue;
      for (const q of [aim, e]) {
        const s = segDist(m.x, m.y, me.x, me.y, q.x, q.y);
        if (s.t > 0 && s.t < 1 && s.d < this.friendClear + drift) block = true;
      }
    }
    if (block) {
      this.blocked++;
      out.why = '隊友擋線';
      if (this.blocked >= 2 && !ctx.holding) {
        const side = this.sidestep(obs, aim);
        if (side !== null) {
          out.move = side;
          return out;
        }
      }
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    this.blocked = 0;
    if (this.seen < this.wait) {
      out.why = '反應中';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    if (me.reloadTicksLeft > 0 && wid !== 'shotgun') {
      out.why = '換彈中';
      return this.finishMove(obs, out, e, false, d, ctx, true);
    }
    if (w.scopedSpread !== null && !me.scoped) {
      out.cmds.push({ type: 'scope', on: true });
      out.why = '開鏡';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    const errMag = Math.sqrt(this.errX * this.errX + this.errY * this.errY);
    if (w.scopedSpread !== null && errMag > P.awpErr * UNIT) {
      out.why = '狙擊瞄準中';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    const lowWall = this.lowCoverNear(me.x, me.y, e.x, e.y);
    const wantCrouch = !lowWall && dc >= P.crouchFireMin;
    const still = Math.abs(me.vx) + Math.abs(me.vy) === 0;
    const recoil = Math.max(0, me.spread - this.baseSpread(me, w, still, me.crouching));
    const next = this.baseSpread(me, w, true, wantCrouch && me.crouching) + Math.max(0, recoil - w.fireTicks * 4);
    const half = HALF_ANGLE_K / Math.max(d, 500);
    const ok = next <= Math.max(half * P.fireSpreadK, w.spread * 1.05) || wid === 'shotgun' || wid === 'knife';
    out.fire = ok;
    out.why = ok ? '開火' : '等散佈';
    return this.finishMove(obs, out, e, ok, d, ctx);
  }
  /**
   * @param {Observation} obs @param {Fight} out @param {Enemy} e
   * @param {boolean} firing @param {number} d @param {{ holding: boolean, objective: boolean }} ctx @param {boolean} [weak]
   */
  finishMove(obs, out, e, firing, d, ctx, weak = false) {
    const me = obs.me;
    const t = obs.tick;
    const mateNear = obs.teammates.some((m) => m.alive && dist(m.x, m.y, me.x, me.y) < P.mateNear * UNIT);
    const outnumbered = obs.enemies.length >= this.outnumber && !mateNear;
    const lowHp = me.hp < this.retreatHp && (!firing || obs.enemies.length >= 2);
    if (outnumbered || lowHp || (weak && d > 4 * UNIT)) {
      if (this.retreat === null || t > this.retreatUntil) {
        this.retreat = this.nav.findCover(obs, obs.enemies.map((x) => ({ x: x.x, y: x.y })));
        this.retreatUntil = t + 3 * this.tps;
      }
      if (this.retreat !== null && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
        out.move = this.retreat;
        out.crouch = false;
        out.why += '・撤退';
        return out;
      }
    }
    const lowWall = this.lowCoverNear(me.x, me.y, e.x, e.y);
    if (this.engagedDecisions <= 1 && this.h.random() < this.sloppy) out.move = null;
    else out.move = 'stop';
    if (lowWall) out.crouch = !firing;
    else out.crouch = firing && d >= P.crouchFireMin * UNIT;
    return out;
  }
  /** 自己到目標的線在自己 2 格內經過矮牆 @param {number} ax @param {number} ay @param {number} bx @param {number} by */
  lowCoverNear(ax, ay, bx, by) {
    const len = dist(ax, ay, bx, by);
    if (len < 1) return false;
    const r = Math.min(len, this.rules.lowCoverRange * UNIT);
    for (let s = 250; s <= r; s += 250) {
      const i = this.g.cellOf(ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len);
      if (i >= 0 && this.g.low[i] === 1) return true;
    }
    return false;
  }
  /** 隊友擋線：往側邊 1.5 格（可走、直線走得到） @param {Observation} obs @param {Pt} aim */
  sidestep(obs, aim) {
    const me = obs.me;
    const a = angleTo(me.x, me.y, aim.x, aim.y);
    for (const s of this.h.random() < 0.5 ? [90, -90] : [-90, 90]) {
      const x = me.x + cosd(a + s) * 1500;
      const y = me.y + sind(a + s) * 1500;
      if (this.g.walkable(this.g.cellOf(x, y)) && this.g.walkLine(me.x, me.y, x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  }
  /**
   * @param {Observation} obs @param {Fight} out @param {{ holding: boolean, objective: boolean }} ctx
   */
  noEnemy(obs, out, ctx) {
    const me = obs.me;
    const t = obs.tick;
    this.engagedDecisions = 0;
    this.blocked = 0;
    if (t - this.lostTick > this.tps / 2) this.targetId = -1;
    if (this.lostPos !== null && t - this.lostTick < this.holdAngle && !ctx.objective) {
      out.aim = this.lostPos;
      out.crouch = false;
      out.holdNav = ctx.holding || this.attrs.aggression < 0.5;
      out.why = '架槍（目標剛消失）';
      if (this.retreat !== null && t < this.retreatUntil && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
        out.move = this.retreat;
        out.why = '撤退中';
      }
      return out;
    }
    this.lostPos = null;
    const hurt = this.perc.lastHurt;
    if (hurt !== null && t - hurt.tick < this.tps && me.hp < 60 && !ctx.objective) {
      const th = { x: me.x + cosd(hurt.dir) * 10 * UNIT, y: me.y + sind(hurt.dir) * 10 * UNIT };
      if (this.retreat === null || t > this.retreatUntil) {
        this.retreat = this.nav.findCover(obs, [th]);
        this.retreatUntil = t + 2 * this.tps;
      }
      if (this.retreat !== null && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
        out.move = this.retreat;
        out.why = '受傷・找掩體';
      }
    }
    return out;
  }
  /**
   * @param {Observation} obs @param {boolean} holding 站定守位
   * @returns {Command[]}
   */
  upkeep(obs, holding) {
    const me = obs.me;
    /** @type {Command[]} */
    const out = [];
    const primary = me.loadout.primary;
    if (primary !== null && me.weapon !== primary && obs.tick > this.pistolUntil) {
      out.push({ type: 'switch', slot: 'primary' });
      return out;
    }
    if (primary === null && me.weapon === 'knife' && me.loadout.secondary !== null) {
      out.push({ type: 'switch', slot: 'secondary' });
      return out;
    }
    const w = this.weapon(me.weapon);
    if (w === undefined || w.magazine === 0) return out;
    if (me.ammoMag < w.magazine * P.reloadBelow && me.ammoReserve > 0 && me.reloadTicksLeft === 0) out.push({ type: 'reload' });
    if (w.scopedSpread !== null && me.reloadTicksLeft === 0 && holding !== me.scoped) out.push({ type: 'scope', on: holding });
    return out;
  }
  /**
   * @param {Observation} obs
   * @param {{ hold: Spot | null, holding: boolean, navLook: Pt | null, ahead: Pt | null }} ctx
   * @returns {Pt | null}
   */
  look(obs, ctx) {
    const me = obs.me;
    const t = obs.tick;
    const g = this.g;
    let best = null;
    let bestD = 30 * UNIT;
    for (const r of obs.radar) {
      const d = dist(me.x, me.y, r.x, r.y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best !== null) return { x: best.x, y: best.y };
    const hurt = this.perc.lastHurt;
    if (hurt !== null && t - hurt.tick < this.tps) return { x: me.x + cosd(hurt.dir) * 8 * UNIT, y: me.y + sind(hurt.dir) * 8 * UNIT };
    const snd = this.perc.lastSound;
    if (snd !== null && t - snd.tick < this.tps) {
      if (this.soundSeen !== snd.tick) {
        this.soundSeen = snd.tick;
        this.soundWait = this.soundReact;
      }
      if (this.soundWait > 0) this.soundWait--;
      else {
        const r = clamp((snd.r0 + snd.r1) / 2, 4, 12);
        return { x: me.x + cosd(snd.dir) * r * UNIT, y: me.y + sind(snd.dir) * r * UNIT };
      }
    }
    for (const th of this.perc.threats(me.x, me.y, 50)) {
      if (dist(me.x, me.y, th.x, th.y) > 25 * UNIT) break;
      const k = this.perc.known.get(th.id);
      if (k !== undefined && t - k.tick > 3 * this.tps) continue;
      return { x: th.x, y: th.y };
    }
    if (ctx.navLook !== null) return ctx.navLook;
    if (ctx.hold !== null && ctx.holding) {
      const hold = ctx.hold;
      if (--this.scanLeft <= 0) {
        this.scanLeft = this.scanEvery;
        this.scanIdx++;
      }
      /** @type {Pt[]} */
      const views = [{ x: hold.fx, y: hold.fy }];
      for (const p of this.intel.portals) {
        if (views.length >= 3) break;
        const d = dist(p.x, p.y, hold.x, hold.y);
        if (d < 5 * UNIT || d > 25 * UNIT || !g.los(hold.x, hold.y, p.x, p.y)) continue;
        if (!this.perc.reachable(g.cellOf(p.x, p.y), t, 6)) continue;
        if (Math.abs(adiff(angleTo(hold.x, hold.y, p.x, p.y), angleTo(hold.x, hold.y, hold.fx, hold.fy))) < 20) continue;
        views.push({ x: p.x, y: p.y });
      }
      const k = this.scanIdx % (views.length + 1);
      return k < 2 ? views[0] : views[k - 1];
    }
    let pick = null;
    let pickS = -Infinity;
    for (const p of this.intel.portals) {
      const d = dist(me.x, me.y, p.x, p.y);
      if (d < 2 * UNIT || d > 15 * UNIT) continue;
      const c = g.cellOf(p.x, p.y);
      if (!this.perc.reachable(c, t, 3) || this.perc.cleared(c, t)) continue;
      if (ctx.ahead !== null && Math.abs(adiff(angleTo(me.x, me.y, p.x, p.y), angleTo(me.x, me.y, ctx.ahead.x, ctx.ahead.y))) > 100) continue;
      if (!g.los(me.x, me.y, p.x, p.y)) continue;
      const s = this.perc.portalThreat[p.id] * 2 - d / UNIT + (p.choke ? 3 : 0);
      if (s > pickS) {
        pickS = s;
        pick = p;
      }
    }
    if (pick !== null) return { x: pick.x, y: pick.y };
    return ctx.ahead;
  }
}
/** @typedef {'full' | 'force' | 'half' | 'eco'} BuyCall */
/** 解析「B:<買法>」 @param {string} text @returns {BuyCall | null} */
function parseBuy(text) {
  const m = /^B:(full|force|half|eco)$/.exec(text);
  return m === null ? null : /** @type {BuyCall} */ (m[1]);
}
const UTIL = {
  T: [
    ['flash', 'smoke', 'he'],
    ['flash', 'flash', 'he', 'smoke'],
    ['smoke', 'flash', 'molotov', 'flash'],
    ['molotov', 'flash', 'smoke'],
    ['smoke', 'flash'],
    ['flash', 'he', 'smoke'],
  ],
  CT: [
    ['flash', 'he'],
    ['flash', 'flash', 'he'],
    ['flash', 'incendiary', 'smoke'],
    ['incendiary', 'flash', 'he'],
    ['flash', 'smoke'],
    ['flash', 'he', 'smoke'],
  ],
};
class Economy {
  /**
   * @param {InitData} data @param {Helpers} h
   * @param {{ economy: number, discipline: number }} opts
   */
  constructor(data, h, opts) {
    this.data = data;
    this.h = h;
    this.opts = opts;
    /** @type {Map<string, number>} */
    this.price = new Map(data.weapons.map((w) => [w.id, w.price]));
    for (const n of data.grenades) this.price.set(n.id, n.price);
    this.lossLevel = 0;
    this.enemyLevel = 0;
    /** 上回合我方贏了（null = 半場第一回合） @type {boolean | null} */
    this.lastWon = null;
    this.roundInHalf = 0;
    this.half = -1;
    this.prevMine = 0;
    this.prevTheirs = 0;
    this.lastRound = -1;
  }
  /** @param {string} id */
  cost(id) {
    return this.price.get(id) ?? Infinity;
  }
  /** 回合開始：從比分變化推算連敗補償階數 @param {Observation} obs */
  roundStart(obs) {
    const r = obs.round;
    if (r.number === this.lastRound) return;
    this.lastRound = r.number;
    const mine = obs.me.team === 'T' ? r.scoreT : r.scoreCT;
    const theirs = obs.me.team === 'T' ? r.scoreCT : r.scoreT;
    if (r.half !== this.half) {
      this.half = r.half;
      this.roundInHalf = 1;
      this.lossLevel = 0;
      this.enemyLevel = 0;
      this.lastWon = null;
    } else {
      this.roundInHalf++;
      const ladder = this.data.rules.economy.lossBonus.length;
      if (mine > this.prevMine) {
        this.lastWon = true;
        this.lossLevel = Math.max(0, this.lossLevel - 1);
        this.enemyLevel = Math.min(ladder, this.enemyLevel + 1);
      } else if (theirs > this.prevTheirs) {
        this.lastWon = false;
        this.lossLevel = Math.min(ladder, this.lossLevel + 1);
        this.enemyLevel = Math.max(0, this.enemyLevel - 1);
      }
    }
    this.prevMine = mine;
    this.prevTheirs = theirs;
  }
  /** 全買的價格（步槍＋甲＋拆彈器＋一顆閃） @param {Team} team */
  fullCost(team) {
    const r = this.data.rules;
    return this.cost(team === 'T' ? 'ak' : 'm4') + r.armorPrice + (team === 'CT' ? r.kitPrice : 0) + this.cost('flash');
  }
  /** 這個人要全買還差多少錢（已有好槍就只算甲與道具） @param {number} money @param {WeaponId | null} primary @param {Team} team */
  shortOf(money, primary, team) {
    const need = this.hasGood(primary) ? this.data.rules.armorPrice + this.cost('flash') : this.fullCost(team);
    return need - money;
  }
  /** @param {WeaponId | string | null} primary */
  hasGood(primary) {
    return primary !== null && this.cost(primary) >= this.cost('smg') + 1000;
  }
  /** 手槍局：錢都很少、沒有主武器 @param {Observation} obs */
  pistolRound(obs) {
    return obs.me.money <= this.data.rules.economy.startMoney + 100 && obs.me.loadout.primary === null && this.roundInHalf <= 1;
  }
  /**
   * @param {Observation} obs @returns {BuyCall}
   */
  teamCall(obs) {
    const me = obs.me;
    const team = me.team;
    if (this.pistolRound(obs)) return 'force';
    const people = [{ money: me.money, primary: me.loadout.primary }, ...obs.teammates.map((m) => ({ money: m.money, primary: this.hasGood(m.weapon) ? m.weapon : null }))];
    const can = people.filter((p) => this.shortOf(p.money, p.primary, team) <= 0).length;
    const n = people.length;
    if (can >= n - 1 || (this.lastWon === true && this.enemyLevel >= 2 && can >= n - 2)) return 'full';
    const ladder = this.data.rules.economy.lossBonus;
    const nextPay = ladder[Math.min(ladder.length, this.lossLevel + 1) - 1];
    const canNext = people.filter((p) => this.shortOf(p.money + nextPay, p.primary, team) <= 0).length;
    const r = obs.round;
    const theirs = team === 'T' ? r.scoreCT : r.scoreT;
    const lastOfHalf = this.roundInHalf >= (r.overtime > 0 ? (this.data.rules.overtime === false ? 3 : this.data.rules.overtime.roundsPerHalf) : this.data.rules.roundsPerHalf);
    const critical = theirs >= this.data.rules.winRounds - 1 || lastOfHalf;
    const avg = people.reduce((s, p) => s + p.money, 0) / n;
    const half = this.cost('smg') + this.data.rules.armorPrice;
    if (critical && avg >= half * 0.8) return 'force';
    if (this.roundInHalf === 2 && this.lastWon === true && avg >= half) return 'half';
    if (canNext >= n - 1) return 'eco';
    if (this.opts.economy === 2 && avg >= half) return 'force';
    if (this.opts.economy !== 1 && avg >= half + 600) return 'half';
    return 'eco';
  }
  /**
   * @param {Observation} obs @param {BuyCall} call @param {number} role @param {boolean} awper @returns {BuyItem[]}
   */
  items(obs, call, role, awper) {
    const me = obs.me;
    const rules = this.data.rules;
    const team = me.team;
    let money = me.money;
    const primary = me.loadout.primary;
    const rifle = team === 'T' ? 'ak' : 'm4';
    /** @type {BuyItem[]} */
    const items = [];
    /** @param {BuyItem} id @param {number} price */
    const take = (id, price) => {
      if (price > money) return false;
      items.push(id);
      money -= price;
      return true;
    };
    const armor = () => me.loadout.armor < rules.maxArmor && !items.includes('armor') && take('armor', rules.armorPrice);
    const kit = () => team === 'CT' && !me.loadout.kit && !items.includes('kit') && take('kit', rules.kitPrice);
    const util = (/** @type {number} */ max) => {
      const owned = [...me.loadout.grenades];
      let n = 0;
      for (const g of UTIL[team][role] ?? UTIL[team][0]) {
        if (n >= max || owned.length >= rules.grenadeSlots) break;
        const def = this.data.grenades.find((x) => x.id === g);
        if (def === undefined || owned.filter((x) => x === g).length >= def.maxCarry) continue;
        if (take(/** @type {BuyItem} */ (g), def.price)) {
          owned.push(/** @type {GrenadeId} */ (g));
          n++;
        }
      }
    };
    const rebel = this.opts.discipline < 0.5 && this.h.random() < 1 - 2 * this.opts.discipline;
    let mode = call;
    if (rebel && call === 'half' && this.shortOf(money, primary, team) <= 0) mode = 'full';
    const good = this.hasGood(primary);
    if (this.pistolRound(obs)) {
      armor();
    } else if (mode === 'full' || (good && mode !== 'eco')) {
      if (awper && primary !== 'awp' && money >= this.cost('awp') + rules.armorPrice + 200) take('awp', this.cost('awp'));
      else if (!good && !take(rifle, this.cost(rifle))) take('smg', this.cost('smg'));
      armor();
      kit();
      util(4);
    } else if (mode === 'force') {
      if (role === 1) armor();
      if (!good && money >= this.cost(rifle) + rules.armorPrice) take(rifle, this.cost(rifle));
      else if (!good && money >= this.cost('smg') + rules.armorPrice) take('smg', this.cost('smg'));
      armor();
      if (!good && primary === null && items.length === 1 && money >= this.cost('deagle')) take('deagle', this.cost('deagle'));
      kit();
      util(1);
    } else if (mode === 'half') {
      if (role === 1) armor();
      if (!good && primary === null) take('smg', this.cost('smg'));
      armor();
      if (role === 3) kit();
      util(1);
    } else if (rebel && money >= this.cost('deagle') + 1000 && me.loadout.secondary !== 'deagle') {
      take('deagle', this.cost('deagle'));
    }
    const w = this.data.weapons.find((x) => x.id === (primary ?? me.weapon));
    if (w !== undefined && w.reserve > 0 && me.ammoReserve < w.reserve / 2 && me.weapon === w.id && mode !== 'eco') take('ammo', rules.ammoPrice);
    return items;
  }
}
/** @typedef {{ kind: GrenadeId, x: number, y: number, why: string }} ThrowWish */
/** @typedef {{ cmds: Command[], look: Pt | null, stop: boolean, thrown: ThrowWish | null }} UtilOut */
class Utility {
  /**
   * @param {Grid} g @param {InitData} data
   */
  constructor(g, data) {
    this.g = g;
    this.rules = data.rules;
    this.tps = data.rules.ticksPerSecond;
    this.range = data.rules.grenadeRules.maxThrowRange * UNIT;
    this.speed = data.rules.grenadeRules.flySpeed;
    /** @type {Map<string, number>} */
    this.fuse = new Map(data.grenades.map((n) => [n.id, n.fuseTicks]));
    this.flashR = (data.grenades.find((n) => n.id === 'flash')?.radius ?? 15 * UNIT);
    this.lastThrow = -1000000;
    this.lastEnemy = -1000000;
    this.aimSince = -1;
    this.lastLook = -1;
    /** @type {Pt | null} */
    this.aimAt = null;
    /** 自己丟的閃光：指令生效前（from）繼續看投擲方向，之後背對到 until @type {{ x: number, y: number, tx: number, ty: number, from: number, until: number } | null} */
    this.away = null;
    /** 本回合丟過的種類（每種每人一次） @type {Set<string>} */
    this.used = new Set();
    this.throws = 0;
  }
  reset() {
    this.lastThrow = -1000000;
    this.lastEnemy = -1000000;
    this.aimSince = -1;
    this.aimAt = null;
    this.away = null;
    this.used = new Set();
  }
  /** 身上有這種道具、本回合還沒丟過 @param {Observation['me']} me @param {GrenadeId} kind */
  has(me, kind) {
    return me.loadout.grenades.includes(kind) && !this.used.has(kind);
  }
  /** 第一個身上有的種類 @param {Observation['me']} me @param {GrenadeId[]} kinds */
  pick(me, kinds) {
    return kinds.find((k) => this.has(me, k)) ?? null;
  }
  /**
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by
   */
  solve(ax, ay, bx, by) {
    const d = dist(ax, ay, bx, by);
    if (d < 2 * UNIT || d > this.range) return null;
    const deg = angleTo(ax, ay, bx, by);
    const power = Math.max(1, Math.min(100, Math.round((d / this.range) * 100)));
    const land = this.fly(ax, ay, deg, power);
    if (land === null || dist(land.x, land.y, bx, by) > 1.2 * UNIT) return null;
    return { deg, power, x: land.x, y: land.y };
  }
  /** 模擬飛行；碰到牆回傳 null @param {number} ax @param {number} ay @param {number} deg @param {number} power */
  fly(ax, ay, deg, power) {
    const dx = Math.round(cosd(deg) * 10000);
    const dy = Math.round(sind(deg) * 10000);
    let x = ax;
    let y = ay;
    let left = Math.floor((power * this.range) / 100);
    for (let k = 0; k < 400 && left > 0; k++) {
      const step = Math.min(this.speed, left);
      const wx = Math.trunc((dx * step) / 10000);
      const wy = Math.trunc((dy * step) / 10000);
      if (this.hits(x + wx, y)) return null;
      x += wx;
      if (this.hits(x, y + wy)) return null;
      y += wy;
      left -= step;
    }
    return { x, y };
  }
  /** 半徑 0.12 格的圓碰到牆 @param {number} x @param {number} y */
  hits(x, y) {
    const g = this.g;
    const r = 120;
    for (let cy = Math.floor((y - r) / UNIT); cy <= Math.floor((y + r) / UNIT); cy++) {
      for (let cx = Math.floor((x - r) / UNIT); cx <= Math.floor((x + r) / UNIT); cx++) {
        if (!g.isWall(cx, cy)) continue;
        const nx = Math.max(cx * UNIT, Math.min(x, cx * UNIT + UNIT));
        const ny = Math.max(cy * UNIT, Math.min(y, cy * UNIT + UNIT));
        if ((nx - x) * (nx - x) + (ny - y) * (ny - y) <= r * r) return true;
      }
    }
    return false;
  }
  /**
   * @param {Observation} obs @param {number} x @param {number} y @param {Set<number>} busy 最近在交戰的隊友
   */
  flashSafe(obs, x, y, busy) {
    if (obs.radar.some((r) => dist(r.x, r.y, x, y) < this.flashR)) return false;
    for (const m of obs.teammates) {
      if (!m.alive) continue;
      if (!this.g.los(m.x, m.y, x, y)) continue;
      const d = dist(m.x, m.y, x, y);
      if (d < P.flashMateClear * UNIT) return false;
      if (busy.has(m.id) && d < this.blindRange) return false;
    }
    return true;
  }
  /**
   * @param {Observation} obs @param {ThrowWish | null} wish @param {Set<number>} busy 最近在交戰的隊友 @returns {UtilOut}
   */
  step(obs, wish, busy) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {UtilOut} */
    const out = { cmds: [], look: null, stop: false, thrown: null };
    if (obs.enemies.length > 0) this.lastEnemy = t;
    if (this.away !== null) {
      if (t > this.away.until) this.away = null;
      else {
        out.look = t < this.away.from ? { x: this.away.tx, y: this.away.ty } : { x: me.x + (me.x - this.away.x) * 2, y: me.y + (me.y - this.away.y) * 2 };
        return out;
      }
    }
    if (wish === null || obs.round.phase === 'freeze' || me.blindTicks > 0 || t - this.lastThrow < this.tps) return out;
    if (!this.has(me, wish.kind)) return out;
    if (obs.enemies.length > 0 && (wish.kind === 'flash' || wish.kind === 'smoke')) return out;
    const s = this.solve(me.x, me.y, wish.x, wish.y);
    if (s === null) return out;
    if (wish.kind === 'flash' && !this.flashSafe(obs, s.x, s.y, busy)) return out;
    out.look = { x: wish.x, y: wish.y };
    out.stop = true;
    if (this.aimAt === null || dist(this.aimAt.x, this.aimAt.y, wish.x, wish.y) > UNIT || t - this.lastLook > this.rules.decisionInterval) this.aimSince = t;
    this.aimAt = { x: wish.x, y: wish.y };
    this.lastLook = t;
    if (t - this.aimSince <= this.rules.reactionTicks) return out;
    const half = (me.scoped ? this.rules.scopedFovDeg : this.rules.fovDeg) / 2;
    if (Math.abs(adiff(s.deg, me.facing)) > half - 15 || Math.abs(me.vx) + Math.abs(me.vy) > 20) return out;
    if ((wish.kind === 'flash' || wish.kind === 'smoke') && t - this.lastEnemy <= 2 * this.rules.reactionTicks) return out;
    out.cmds.push({ type: 'throw', grenade: wish.kind, deg: s.deg, power: s.power });
    this.lastThrow = t;
    this.used.add(wish.kind);
    this.throws++;
    out.thrown = { ...wish, x: Math.round(s.x), y: Math.round(s.y) };
    if (wish.kind === 'flash') {
      const pop = t + this.rules.reactionTicks + (this.fuse.get('flash') ?? 45);
      this.away = { x: s.x, y: s.y, tx: wish.x, ty: wish.y, from: t + this.rules.reactionTicks + 1, until: pop + 3 };
      out.cmds.push({ type: 'say', text: `E:flash ${Math.round(s.x / 100)} ${Math.round(s.y / 100)} ${pop}` });
    } else if (wish.kind === 'smoke') out.cmds.push({ type: 'say', text: `E:smoke ${Math.round(s.x / 100)} ${Math.round(s.y / 100)}` });
    return out;
  }
  get flashRadius() {
    return this.flashR;
  }
  get blindRange() {
    return 2 * this.flashR;
  }
}
const ENTRY = 1;
const SUPPORT = 2;
const ANCHOR = 3;
const AWP = 4;
const LURK = 5;
const ROLE_NAME = ['無', '突破', '支援', '錨點', '狙擊', '游擊'];
const AUTO = [ENTRY, SUPPORT, ANCHOR, LURK, AWP];
const FILL = [ENTRY, SUPPORT, ANCHOR, LURK];
/** 自動角色 @param {number} slot @param {number} awpSlot */
function autoRole(slot, awpSlot) {
  if (slot === awpSlot) return AWP;
  const r = AUTO[slot] ?? ENTRY;
  return r === AWP ? LURK : r;
}
/** 解析「R:<代碼>」 @param {string} text */
function parseRole(text) {
  const m = /^R:([1-5])$/.exec(text);
  return m === null ? 0 : Number(m[1]);
}
class Roles {
  /** @param {number[]} ids 全隊 id（排序＝隊內序號） @param {number} me @param {number} mine 自己喊的角色 @param {number} awpSlot */
  constructor(ids, me, mine, awpSlot) {
    this.ids = ids;
    /** 喊過的角色（自己的直接知道） @type {Map<number, number>} */
    this.said = new Map([[me, mine]]);
    this.awpSlot = awpSlot;
    /** id → 實際分工；角色 → 擔任的人 @type {Map<number, number>} */
    this.eff = new Map();
    /** @type {Map<number, number>} */
    this.holder = new Map();
    this.key = '';
    this.solve();
  }
  /** 收到隊友喊的角色 @param {number} id @param {number} r */
  hear(id, r) {
    if (r === 0 || this.said.get(id) === r || !this.ids.includes(id)) return;
    this.said.set(id, r);
    this.solve();
  }
  /** @param {number} id */
  announced(id) {
    return this.said.get(id) ?? autoRole(this.ids.indexOf(id), 4);
  }
  solve() {
    this.eff = new Map();
    this.holder = new Map();
    /** @type {number[]} */
    const extra = [];
    for (const id of this.ids) {
      const r = this.announced(id);
      if (this.holder.has(r)) extra.push(id);
      else {
        this.holder.set(r, id);
        this.eff.set(id, r);
      }
    }
    for (const id of extra) {
      if (this.announced(id) === AWP) {
        this.eff.set(id, ENTRY);
        if (!this.holder.has(ENTRY)) this.holder.set(ENTRY, id);
        continue;
      }
      const r = FILL.find((x) => !this.holder.has(x)) ?? 0;
      this.eff.set(id, r);
      if (r !== 0) this.holder.set(r, id);
    }
    this.key = this.ids.map((id) => this.eff.get(id) ?? 0).join('');
  }
  /** 實際分工 @param {number} id */
  of(id) {
    return this.eff.get(id) ?? 0;
  }
  /** 擔任某角色的人（−1 = 沒有） @param {number} r */
  who(r) {
    return this.holder.get(r) ?? -1;
  }
  awper() {
    for (const id of this.ids) if (this.announced(id) === AWP) return id;
    return -1;
  }
}
const MAIN_PRI = [3, 0, 1, 2, 5, 4];
const SMOKE_PREF = [SUPPORT, ANCHOR, LURK, 0, ENTRY, AWP];
/** @typedef {'A' | 'B'} SiteId */
/** T 計畫：site 主力的點、r1／r2 兩組的路線序號、exec 執行哪個點（null = 還在佈置） @typedef {{ kind: 'go' | 'default' | 'rush' | 'split' | 'fake', site: SiteId, r1: number, r2: number, exec: SiteId | null }} TPlan */
/** CT 計畫：A／中路／B 人數、輪轉目標、回防開始 @typedef {{ kind: 'hold', a: number, m: number, b: number, rot: SiteId | null, go: boolean }} CTPlan */
/** @typedef {TPlan | CTPlan} Plan */
/** @typedef {{ kind: 'contact', region: string, n: number } | { kind: 'dead', region: string } | { kind: 'planted', site: SiteId } | { kind: 'flash', x: number, y: number, pop: number } | { kind: 'smoke', x: number, y: number } | { kind: 'kit' }} TeamEvent */
/**
 * @typedef {{ goal: Pt | null, route: Route | null, hold: Spot | null, objective: boolean, allowPeek: boolean, cmds: Command[], role: string, look: Pt | null, urgent: boolean, hard: boolean, stop: boolean, walk: boolean | null, noise: boolean }} TacOut
 */
const SITES = /** @type {const} */ (['A', 'B']);
/** @param {SiteId} s @returns {SiteId} */
const other = (s) => (s === 'A' ? 'B' : 'A');
/** 解析計畫字串 @param {string} text @returns {Plan | null} */
function parsePlan(text) {
  let m = /^P:go ([AB]) (\d+)$/.exec(text);
  if (m !== null) {
    const site = /** @type {SiteId} */ (m[1]);
    return { kind: 'go', site, r1: Number(m[2]), r2: Number(m[2]), exec: site };
  }
  m = /^P:(rush|split)([AB]) (\d+)(?: (\d+))?( go)?$/.exec(text);
  if (m !== null) {
    const site = /** @type {SiteId} */ (m[2]);
    const kind = /** @type {'rush' | 'split'} */ (m[1]);
    const r1 = Number(m[3]);
    return { kind, site, r1, r2: m[4] !== undefined ? Number(m[4]) : r1, exec: kind === 'rush' || m[5] !== undefined ? site : null };
  }
  m = /^P:(default|fake) ([AB]) (\d+) (\d+)(?: >([AB]))?$/.exec(text);
  if (m !== null) return { kind: /** @type {'default' | 'fake'} */ (m[1]), site: /** @type {SiteId} */ (m[2]), r1: Number(m[3]), r2: Number(m[4]), exec: m[5] !== undefined ? /** @type {SiteId} */ (m[5]) : null };
  m = /^P:hold A=(\d) (?:M=(\d) )?B=(\d)(?: rot=([AB]))?( go)?$/.exec(text);
  if (m !== null) return { kind: 'hold', a: Number(m[1]), m: m[2] !== undefined ? Number(m[2]) : 0, b: Number(m[3]), rot: m[4] !== undefined ? /** @type {SiteId} */ (m[4]) : null, go: m[5] !== undefined };
  return null;
}
/** @param {Plan} p */
function planText(p) {
  switch (p.kind) {
    case 'go':
      return `P:go ${p.site} ${p.r1}`;
    case 'rush':
      return `P:rush${p.site} ${p.r1}`;
    case 'split':
      return `P:split${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ' go' : ''}`;
    case 'default':
    case 'fake':
      return `P:${p.kind} ${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ` >${p.exec}` : ''}`;
    default:
      return `P:hold A=${p.a}${p.m > 0 ? ` M=${p.m}` : ''} B=${p.b}${p.rot !== null ? ` rot=${p.rot}` : ''}${p.go ? ' go' : ''}`;
  }
}
/** 解析事件 @param {string} text @returns {TeamEvent | null} */
function parseEvent(text) {
  let m = /^E:contact (\S+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'contact', region: m[1], n: Number(m[2]) };
  m = /^E:dead (\S+)$/.exec(text);
  if (m !== null) return { kind: 'dead', region: m[1] };
  m = /^E:planted ([AB])$/.exec(text);
  if (m !== null) return { kind: 'planted', site: /** @type {SiteId} */ (m[1]) };
  m = /^E:flash (\d+) (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'flash', x: Number(m[1]) * 100, y: Number(m[2]) * 100, pop: Number(m[3]) };
  m = /^E:smoke (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'smoke', x: Number(m[1]) * 100, y: Number(m[2]) * 100 };
  if (text === 'E:kit') return { kind: 'kit' };
  return null;
}
class Tactics {
  /**
   * @param {Grid} g @param {MapIntel} intel @param {Perception} perc
   * @param {InitData} data @param {Helpers} h
   * @param {{ awpSlot: number, role: number, economy: number, ctSplitA: number, plan: number }} opts
   * @param {{ aim: number, reaction: number, awareness: number, aggression: number, discipline: number, movement: number }} attrs
   */
  constructor(g, intel, perc, data, h, opts, attrs) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.data = data;
    this.h = h;
    this.opts = opts;
    this.attrs = attrs;
    this.tps = data.rules.ticksPerSecond;
    this.econ = new Economy(data, h, { economy: opts.economy, discipline: attrs.discipline });
    this.util = new Utility(g, data);
    this.ids = [data.playerId, ...data.teammateIds].sort((a, b) => a - b);
    this.roles = new Roles(this.ids, data.playerId, opts.role, opts.awpSlot);
    this.roleSaid = false;
    this.yielded = 0;
    this.slow = false;
    this.spawnHeld = 0;
    this.goTick = -1;
    this.readyAt = -1;
    this.eventDelay = Math.round(lerp(P.eventDelay0, P.eventDelay100, attrs.awareness) * data.rules.decisionInterval);
    /** 地圖算出來的位置（第一次用到才算） @type {Map<string, Spot[]>} */
    this.spotCache = new Map();
    /** 戰鬥層（估計對手血量用）與導航層（躲閃光用）；由入口接上 @type {Combat | null} */
    this.combat = null;
    /** @type {Navigator | null} */
    this.nav = null;
    /** 躲閃光的格（對應哪一顆閃光） @type {Pt | null} */
    this.hide = null;
    this.hideFor = -1;
    /** 當 CT 時對方打哪個點（最近 6 回合） @type {SiteId[]} */
    this.hits = [];
    this.siteScore = { A: 0, B: 0 };
    /** 計畫使用統計（給評測）：種類 → [回合, 勝] @type {Record<string, [number, number]>} */
    this.planStats = {};
    this.lastKind = '';
    this.lastSite = /** @type {SiteId | null} */ (null);
    this.lastAttack = /** @type {SiteId | null} */ (null);
    this.enemiesAlive = 5;
    /** 狙擊位（第一次用到才算） @type {{ spot: Spot, site: SiteId, len: number } | null | undefined} */
    this.sniper = undefined;
    /** @type {Plan | null} */
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.saidText = '';
    this.bought = false;
    /** @type {BuyCall | null} */
    this.buyCall = null;
    this.routeOverride = -1;
    /** 收到但還沒處理的喊話（警覺低的晚一點反應） @type {{ ready: number, from: number, text: string }[]} */
    this.inbox = [];
    /** 收到的接觸：區域 → 人數與時間；接觸 → 所屬包點 @type {Map<string, { n: number, tick: number }>} */
    this.contacts = new Map();
    /** @type {Map<string, SiteId | null>} */
    this.contactSite = new Map();
    /** 自己喊過的接觸 @type {Map<string, { n: number, tick: number }>} */
    this.saidContact = new Map();
    /** 分組（T）：id → 0 主力／1 第二組 @type {Map<number, number> | null} */
    this.groups = null;
    this.groupKey = '';
    this.execTick = -1;
    this.stageArrive = -1;
    this.noiseLeft = 0;
    /** 隊友的閃光：躲或轉身到爆完 @type {{ x: number, y: number, pop: number }[]} */
    this.mateFlash = [];
    this.flashHeard = -1;
    this.smokeHeard = -1;
    /** 本回合我方煙霧的位置（自己丟的與隊友喊的） @type {Pt[]} */
    this.smokes = [];
    this.flashKey = '';
    /** @type {{ x: number, y: number, sc: number }[]} */
    this.flashList = [];
    /** 有拆彈器的隊友 @type {Set<number>} */
    this.kits = new Set();
    this.kitSaid = false;
    /** 換血：朝隊友陣亡的方向架槍 @type {{ x: number, y: number, until: number } | null} */
    this.trade = null;
    /** 追殘血 @type {{ x: number, y: number, until: number } | null} */
    this.chase = null;
    /** 對每個敵人打出的傷害 @type {Map<number, number>} */
    this.dealt = new Map();
    /** @type {Map<number, boolean>} */
    this.mateAlive = new Map();
    /** 隊友最近一次開火的 tick @type {Map<number, number>} */
    this.mateFired = new Map();
    this.liveStart = -1;
    this.plantedSaid = false;
    this.saving = false;
    this.awper = -1;
    this.awperFixed = false;
    /** @type {Map<number, { spot: Spot, site: SiteId | null }> | null} */
    this.layout = null;
    this.layoutKey = '';
    /** @type {Pt | null} */
    this.saveCache = null;
  }
  /** 新回合（obs 為 null 時只清狀態） @param {Observation | null} obs */
  reset(obs) {
    if (obs !== null) {
      this.econ.roundStart(obs);
      const won = this.econ.lastWon;
      if (won !== null && this.lastKind !== '') {
        const st = this.planStats[this.lastKind] ?? [0, 0];
        this.planStats[this.lastKind] = st;
        st[0]++;
        if (won) st[1]++;
        if (this.lastSite !== null) this.siteScore[this.lastSite] = clamp(this.siteScore[this.lastSite] + (won ? 1 : -1), -2, 2);
      }
      if (this.lastAttack !== null) {
        this.hits.push(this.lastAttack);
        if (this.hits.length > 6) this.hits.shift();
      }
    }
    this.lastKind = '';
    this.lastSite = null;
    this.lastAttack = null;
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.saidText = '';
    this.bought = false;
    this.buyCall = null;
    this.routeOverride = -1;
    this.inbox = [];
    this.contacts = new Map();
    this.contactSite = new Map();
    this.saidContact = new Map();
    this.groups = null;
    this.groupKey = '';
    this.execTick = -1;
    this.stageArrive = -1;
    this.noiseLeft = 0;
    this.mateFlash = [];
    this.flashHeard = -1;
    this.smokeHeard = -1;
    /** 本回合我方煙霧的位置（自己丟的與隊友喊的） @type {Pt[]} */
    this.smokes = [];
    this.flashKey = '';
    /** @type {{ x: number, y: number, sc: number }[]} */
    this.flashList = [];
    this.kits = new Set();
    this.kitSaid = false;
    this.trade = null;
    this.chase = null;
    this.dealt = new Map();
    this.mateAlive = new Map();
    this.mateFired = new Map();
    this.liveStart = -1;
    this.plantedSaid = false;
    this.saving = false;
    this.awper = -1;
    this.awperFixed = false;
    this.layout = null;
    this.layoutKey = '';
    this.saveCache = null;
    this.roleSaid = false;
    this.yielded = 0;
    this.slow = false;
    this.spawnHeld = 0;
    this.goTick = -1;
    this.readyAt = -1;
    this.util.reset();
  }
  /** 活著的最小 playerId（含自己） @param {Observation} obs */
  commanderOf(obs) {
    let c = obs.me.alive ? obs.me.id : Infinity;
    for (const m of obs.teammates) if (m.alive && m.id < c) c = m.id;
    return Number.isFinite(c) ? c : -1;
  }
  /** 隊內序號 @param {number} id */
  slotOf(id) {
    return this.ids.indexOf(id);
  }
  /** 活著的隊員（含自己）：{ id, x, y } @param {Observation} obs */
  alive(obs) {
    const me = obs.me;
    const out = obs.teammates.filter((m) => m.alive).map((m) => ({ id: m.id, x: m.x, y: m.y }));
    if (me.alive) out.push({ id: me.id, x: me.x, y: me.y });
    return out.sort((a, b) => a.id - b.id);
  }
  /** 區域代號 → 該區域中心格 @param {string} id */
  regionCell(id) {
    const r = this.intel.map.regions.find((x) => x.id === id);
    if (r === undefined) return -1;
    return this.intel.nearestOpen(Math.floor((r.x0 + r.x1) / 2), Math.floor((r.y0 + r.y1) / 2));
  }
  /** 格屬於哪個包點附近（路徑 ≤ 25 格且比另一點近 5 格以上）；都不是回傳 null @param {number} c @returns {SiteId | null} */
  siteNear(c) {
    if (c < 0) return null;
    const a = this.intel.distSite.A[c] / 10;
    const b = this.intel.distSite.B[c] / 10;
    if (a <= 25 && a < b - 5) return 'A';
    if (b <= 25 && b < a - 5) return 'B';
    return null;
  }
  /**
   * @param {Observation} obs
   * @returns {TacOut}
   */
  update(obs) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {TacOut} */
    const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false };
    if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
    this.enemiesAlive = obs.enemiesAlive;
    if (!this.roleSaid) {
      this.roleSaid = true;
      out.cmds.push({ type: 'say', text: `R:${this.opts.role}` });
    }
    this.trackTeam(obs, out);
    this.readChat(obs);
    const cmd = this.commanderOf(obs);
    this.commander = cmd;
    if (cmd === me.id) this.lead(obs, out);
    else if (this.plan === null && obs.round.phase !== 'freeze' && t - this.liveStart > this.tps) this.plan = this.choosePlan(obs);
    this.buy(obs, out, cmd === me.id);
    this.report(obs, out);
    const live = obs.round.phase === 'live';
    out.allowPeek = live && obs.round.phaseTicksLeft > 25 * this.tps;
    this.slow = false;
    /** @type {ThrowWish | null} */
    let wish = me.team === 'T' ? this.tGoal(obs, out) : this.ctGoal(obs, out);
    if (this.slow) {
      out.walk = true;
      out.role += '・讓突破手先走';
    }
    if (wish === null) wish = this.anyNade(obs);
    this.overlay(obs, out);
    /** @type {Set<number>} */
    const busy = new Set();
    for (const [id, tk] of this.mateFired) if (t - tk < 1.5 * this.tps) busy.add(id);
    if (out.urgent || this.mateFlash.some((x) => t <= x.pop)) wish = null;
    const u = this.util.step(obs, wish, busy);
    if (u.thrown !== null && u.thrown.kind === 'smoke') this.smokes.push({ x: u.thrown.x, y: u.thrown.y });
    out.cmds.push(...u.cmds);
    if (u.look !== null) {
      out.look = u.look;
      if (this.util.away !== null) out.urgent = true;
    }
    if (u.stop) out.stop = true;
    if (this.plan !== null) {
      this.lastKind = this.plan.kind === 'hold' ? '' : this.plan.kind;
      if (this.plan.kind !== 'hold') this.lastSite = this.plan.exec ?? this.plan.site;
    }
    return out;
  }
  /**
   * @param {Observation} obs @param {TacOut} out
   */
  trackTeam(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const tid = this.combat?.targetId ?? -1;
    for (const s of me.shots) if (s.hit === 'enemy' && tid >= 0) this.dealt.set(tid, (this.dealt.get(tid) ?? 0) + s.damage);
    for (const m of obs.teammates) {
      if (m.firing) this.mateFired.set(m.id, t);
      if (this.mateAlive.get(m.id) === true && !m.alive) {
        if (me.alive && dist(m.x, m.y, me.x, me.y) <= P.tradeRange * UNIT) this.trade = { x: m.x + cosd(m.facing) * 10 * UNIT, y: m.y + sind(m.facing) * 10 * UNIT, until: t + Math.round(P.tradeHold * this.tps) };
        if (this.commanderOf(obs) === me.id) {
          const r = this.intel.region[this.g.cellOf(m.x, m.y)];
          if (r >= 0) out.cmds.push({ type: 'say', text: `E:dead ${this.intel.map.regions[r].id}` });
        }
        const near = this.siteNear(this.g.cellOf(m.x, m.y));
        if (near !== null) this.noteContact(`#dead${m.id}`, 1, t, near);
      }
      this.mateAlive.set(m.id, m.alive);
    }
  }
  /** @param {string} key @param {number} n @param {number} t @param {SiteId | null} site */
  noteContact(key, n, t, site) {
    this.contacts.set(key, { n, tick: t });
    this.contactSite.set(key, site);
  }
  /** 收喊話：計畫、買法、事件（事件延遲 eventDelay 才處理） @param {Observation} obs */
  readChat(obs) {
    const me = obs.me;
    const t = obs.tick;
    for (const c of obs.chat) {
      if (c.from === me.id) continue;
      const r = parseRole(c.text);
      if (r > 0) {
        this.roles.hear(c.from, r);
        continue;
      }
      const first = (this.plan === null || this.roles.of(me.id) === LURK) && c.text.startsWith('P:');
      this.inbox.push({ ready: first || c.text.startsWith('B:') ? t : t + this.eventDelay, from: c.from, text: c.text });
    }
    const keep = [];
    for (const msg of this.inbox) {
      if (msg.ready > t) {
        keep.push(msg);
        continue;
      }
      const text = msg.text;
      const p = parsePlan(text);
      if (p !== null) {
        if (msg.from < me.id && (p.kind === 'hold') === (me.team === 'CT')) this.setPlan(p, obs);
        continue;
      }
      const b = parseBuy(text);
      if (b !== null) {
        if (msg.from < me.id) this.buyCall = b;
        continue;
      }
      const e = parseEvent(text);
      if (e === null) continue;
      if (e.kind === 'contact') {
        const c = this.regionCell(e.region);
        this.noteContact(e.region, e.n, t, this.siteNear(c));
      } else if (e.kind === 'flash') this.mateFlash.push({ x: e.x, y: e.y, pop: e.pop });
      else if (e.kind === 'smoke') {
        this.smokeHeard = t;
        this.smokes.push({ x: e.x, y: e.y });
      }
      else if (e.kind === 'kit') this.kits.add(msg.from);
      if (e.kind === 'flash') this.flashHeard = t;
    }
    this.inbox = keep;
  }
  /** @param {Plan} p @param {Observation} obs */
  setPlan(p, obs) {
    const prev = this.plan;
    this.plan = p;
    if (p.kind !== 'hold' && p.exec !== null && (prev === null || prev.kind === 'hold' || prev.exec === null)) this.execTick = obs.tick;
  }
  /** 指揮：決定、更新、廣播計畫 @param {Observation} obs @param {TacOut} out */
  lead(obs, out) {
    if (this.plan === null) this.setPlan(this.choosePlan(obs), obs);
    const p = /** @type {Plan} */ (this.plan);
    const next = p.kind === 'hold' ? this.leadCT(obs, p) : this.leadT(obs, p);
    if (next !== p) this.setPlan(next, obs);
    const text = planText(/** @type {Plan} */ (this.plan));
    if (this.saidAs !== obs.me.id || this.saidText !== text) {
      out.cmds.push({ type: 'say', text });
      this.saidAs = obs.me.id;
      this.saidText = text;
    }
    const b = obs.bomb;
    if (!this.plantedSaid && b.state === 'planted' && b.site !== null) {
      this.plantedSaid = true;
      out.cmds.push({ type: 'say', text: `E:planted ${b.site}` });
    }
  }
  /** @param {Observation} obs @returns {Plan} */
  choosePlan(obs) {
    if (obs.me.team === 'CT') return this.chooseCT();
    return this.chooseT(obs);
  }
  /**
   * @param {Observation} obs @returns {TPlan}
   */
  chooseT(obs) {
    const h = this.h;
    const ag = this.attrs.aggression;
    const call = this.buyCall ?? this.econ.teamCall(obs);
    const wA = Math.max(0.2, 1 + 0.35 * this.siteScore.A);
    const wB = Math.max(0.2, 1 + 0.35 * this.siteScore.B);
    /** @type {SiteId} */
    const site = h.random() * (wA + wB) < wA ? 'A' : 'B';
    const forced = ['', 'default', 'rush', 'split', 'fake'][this.opts.plan] ?? '';
    let kind = forced;
    if (kind === '') {
      const w = call === 'eco' ? { default: 0.25, rush: 0.6, split: 0.15, fake: 0 } : this.enemyEco() ? { default: 0.1, rush: 0.35 + 0.2 * ag, split: 0.4, fake: 0.1 } : { default: 0.32, rush: 0.12 + 0.2 * ag, split: 0.3, fake: 0.18 };
      let r = h.random() * (w.default + w.rush + w.split + w.fake);
      kind = 'fake';
      for (const k of /** @type {const} */ (['default', 'rush', 'split'])) {
        if ((r -= w[k]) < 0) {
          kind = k;
          break;
        }
      }
    }
    const routes = this.intel.routes.T[site];
    const n = Math.max(1, routes.length);
    if (kind === 'rush') return { kind: 'rush', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: 0, exec: site };
    if (kind === 'split') {
      const r1 = 0;
      let r2 = 0;
      let best = Infinity;
      for (let i = 1; i < routes.length; i++) {
        let same = 0;
        for (const r of routes[i].regionSet) if (routes[r1].regionSet.has(r)) same++;
        const j = same / (routes[i].regionSet.size + routes[r1].regionSet.size - same);
        if (j < best) {
          best = j;
          r2 = i;
        }
      }
      return { kind: 'split', site, r1, r2, exec: null };
    }
    const nOther = Math.max(1, this.intel.routes.T[other(site)].length);
    if (kind === 'fake') return { kind: 'fake', site, r1: 0, r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
    return { kind: 'default', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
  }
  /** CT：預設 A=旋鈕／中路／B=P.ctB；對方最近常打同一點就多放一人，一直打同一點就疊 4 人（另一點只留錨點） @returns {CTPlan} */
  chooseCT() {
    let a = clamp(this.opts.ctSplitA, 0, 5);
    let b = Math.min(P.ctB, 5 - a);
    let m = 5 - a - b;
    const recent = this.hits.slice(-4);
    const nA = recent.filter((s) => s === 'A').length;
    const nB = recent.length - nA;
    if (recent.length >= 3 && Math.abs(nA - nB) >= 3) {
      a = nA > nB ? 4 : 1;
      b = 5 - a;
      m = 0;
    } else if (recent.length >= 3 && m > 0) {
      if (nA - nB >= 2) {
        a++;
        m--;
      } else if (nB - nA >= 2) {
        b++;
        m--;
      }
    }
    return { kind: 'hold', a, m, b, rot: null, go: false };
  }
  /**
   * @param {Observation} obs @param {TPlan} p @returns {TPlan}
   */
  leadT(obs, p) {
    if (obs.round.phase !== 'live' || p.exec !== null) return p;
    const t = obs.tick;
    const el = (t - this.liveStart) / this.tps;
    const left = obs.round.phaseTicksLeft / this.tps;
    if (left <= P.forceExecLeft) return { ...p, exec: this.nearestSite(obs) };
    if (p.kind === 'split') {
      const ready = this.alive(obs).every((m) => {
        const s = this.memberStage(obs, m.id, p);
        return s === null || dist(m.x, m.y, s.x, s.y) < 4.5 * UNIT;
      });
      if (!ready) this.readyAt = -1;
      else if (this.readyAt < 0) this.readyAt = t;
      if ((ready && t - this.readyAt >= 1.5 * this.tps) || el >= P.splitWait) return { ...p, exec: p.site };
    }
    if (p.kind === 'fake') {
      const fakers = this.alive(obs).filter((m) => this.groupOf(obs, m.id, p) === 1);
      const there = fakers.some((m) => {
        const s = this.memberStage(obs, m.id, p);
        return s !== null && dist(m.x, m.y, s.x, s.y) < 4 * UNIT;
      });
      if (there && this.stageArrive < 0) this.stageArrive = t;
      if ((this.stageArrive >= 0 && t - this.stageArrive >= P.fakeDelay * this.tps) || el >= P.splitWait + 6) return { ...p, exec: p.site };
    }
    if (p.kind === 'default') {
      const at = lerp(P.defaultExec0, P.defaultExec100, this.attrs.aggression) * (this.enemyEco() ? 0.6 : 1);
      const heat = this.heat(obs);
      const early = el >= at * 0.5 && Math.abs(heat.A - heat.B) >= 2;
      if (el >= at || early) return { ...p, exec: heat.A < heat.B ? 'A' : heat.B < heat.A ? 'B' : p.site };
    }
    return p;
  }
  enemyEco() {
    return this.econ.lastWon === true && this.econ.enemyLevel >= 2;
  }
  /** 離持彈者（或自己）最近的點 @param {Observation} obs @returns {SiteId} */
  nearestSite(obs) {
    const c = obs.teammates.find((m) => m.alive && m.hasBomb) ?? obs.me;
    const cell = this.g.cellOf(c.x, c.y);
    if (cell < 0) return 'A';
    return this.intel.distSite.A[cell] <= this.intel.distSite.B[cell] ? 'A' : 'B';
  }
  /**
   * @param {Observation} obs
   */
  heat(obs) {
    const t = obs.tick;
    const out = { A: 0, B: 0 };
    const seen = { A: 0, B: 0 };
    for (const k of this.perc.known.values()) {
      if (k.conf < 50) continue;
      const s = this.siteNear(this.g.cellOf(k.x, k.y));
      if (s !== null) seen[s]++;
    }
    const heard = { A: 0, B: 0 };
    for (const [key, c] of this.contacts) {
      if (t - c.tick > P.contactTtl * this.tps) {
        this.contacts.delete(key);
        continue;
      }
      const s = this.contactSite.get(key) ?? null;
      if (s !== null) heard[s] += c.n;
    }
    for (const s of SITES) out[s] = Math.max(seen[s], heard[s]);
    return out;
  }
  /**
   * @param {Observation} obs @param {CTPlan} p @returns {CTPlan}
   */
  leadCT(obs, p) {
    if (obs.round.phase === 'freeze') return p;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.site !== null) {
      if (p.rot !== b.site) return { ...p, rot: b.site, go: false };
      if (!p.go && this.retakeReady(obs, b.site)) return { ...p, go: true };
      return p;
    }
    if (p.rot === null) {
      const heat = this.heat(obs);
      for (const s of SITES) if (heat[s] >= P.rotateHeat && heat[s] > heat[other(s)]) return { ...p, rot: s };
    }
    return p;
  }
  /** 回防集結完畢：點外的人都到了待命點；或時間只夠現在進 @param {Observation} obs @param {SiteId} s */
  retakeReady(obs, s) {
    const b = obs.bomb;
    const bx = b.x ?? this.intel.sites[s].cx;
    const by = b.y ?? this.intel.sites[s].cy;
    const stage = this.stageSpots('CT', s, 0);
    if (stage.length === 0) return true;
    const st = stage[0];
    const left = (b.ticksLeft ?? 0) / this.tps;
    const need = dist(st.x, st.y, bx, by) / UNIT / 4.3 + (this.kits.size > 0 || obs.me.loadout.kit ? 5 : 10) + P.saveMargin + 2;
    if (left <= need) return true;
    return this.alive(obs).every((m) => this.inSite(m.x, m.y, s, bx, by) || stage.some((sp) => dist(m.x, m.y, sp.x, sp.y) < P.retakeGather * UNIT));
  }
  /** 在包點裡（包點區域內或離炸彈 8 格內） @param {number} x @param {number} y @param {SiteId} s @param {number} bx @param {number} by */
  inSite(x, y, s, bx, by) {
    const c = this.g.cellOf(x, y);
    return (c >= 0 && this.intel.sites[s].regions.has(this.intel.region[c])) || dist(x, y, bx, by) < 8 * UNIT;
  }
  /** 指揮先決定買法並廣播；其他人等指揮的買法（最多 1 秒）再買 @param {Observation} obs @param {TacOut} out @param {boolean} isCmd */
  buy(obs, out, isCmd) {
    const me = obs.me;
    if (!obs.round.canBuy || this.bought) {
      if (!this.kitSaid && me.loadout.kit && obs.round.phase !== 'freeze') {
        this.kitSaid = true;
        out.cmds.push({ type: 'say', text: 'E:kit' });
      }
      return;
    }
    if (isCmd && this.buyCall === null) {
      this.buyCall = this.econ.teamCall(obs);
      out.cmds.push({ type: 'say', text: `B:${this.buyCall}` });
    }
    const waited = obs.round.phase !== 'freeze' || this.data.rules.freezeTicks - obs.round.phaseTicksLeft >= this.tps;
    if (this.buyCall === null && !waited) return;
    const call = this.buyCall ?? this.econ.teamCall(obs);
    const items = this.econ.items(obs, call, this.roles.of(me.id), this.roles.awper() === me.id);
    if (items.length > 0) out.cmds.push({ type: 'buy', items });
    this.bought = true;
  }
  /**
   * @param {Observation} obs @param {TacOut} out
   */
  report(obs, out) {
    if (obs.enemies.length === 0 || obs.round.phase === 'freeze') return;
    const t = obs.tick;
    /** @type {Map<number, number>} */
    const byRegion = new Map();
    for (const e of obs.enemies) {
      const r = this.intel.region[this.g.cellOf(e.x, e.y)];
      if (r >= 0) byRegion.set(r, (byRegion.get(r) ?? 0) + 1);
    }
    for (const [r, n] of byRegion) {
      const id = this.intel.map.regions[r].id;
      const last = this.saidContact.get(id);
      if (last !== undefined && (last.n >= n || t - last.tick < P.contactEvery * this.tps) && t - last.tick < 4 * P.contactEvery * this.tps) continue;
      this.saidContact.set(id, { n, tick: t });
      const c = this.regionCell(id);
      this.noteContact(id, n, t, this.siteNear(c));
      out.cmds.push({ type: 'say', text: `E:contact ${id} ${n}` });
      return;
    }
  }
  /** 主力組優先順序（小的先）：角色，其次隊內序號 @param {number} id */
  mainPri(id) {
    return MAIN_PRI[this.roles.of(id)] * 10 + this.slotOf(id);
  }
  /**
   * @param {Observation} obs @param {number} id @param {TPlan} p
   */
  groupOf(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return 0;
    const key = `${p.kind}${p.site}${this.roles.key}`;
    if (this.groups === null || this.groupKey !== key) {
      const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
      const others = this.ids.filter((x) => x !== carrier).sort((a, b) => this.mainPri(a) - this.mainPri(b));
      const main = carrier >= 0 ? [carrier, ...others.slice(0, 2)] : others.slice(0, 3);
      this.groups = new Map(this.ids.map((x) => [x, main.includes(x) ? 0 : 1]));
      this.groupKey = key;
    }
    return this.groups.get(id) ?? 0;
  }
  /** 組內名次（持彈者排最後；其餘依角色：突破手是第 0 個） @param {Observation} obs @param {number} id @param {TPlan} p */
  memberIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
    const list = this.ids.filter((x) => this.groupOf(obs, x, p) === gid).sort((a, b) => (a === carrier ? 1 : 0) - (b === carrier ? 1 : 0) || this.mainPri(a) - this.mainPri(b));
    return Math.max(0, list.indexOf(id));
  }
  /** 某隊員佈置時要去的點與路線 @param {Observation} obs @param {number} id @param {TPlan} p @returns {{ site: SiteId, route: number }} */
  setupOf(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    if (gid === 0) return { site: p.site, route: p.r1 };
    if (p.kind === 'split') return { site: p.site, route: p.r2 };
    return { site: other(p.site), route: p.r2 };
  }
  /** 某隊員的待命格 @param {Observation} obs @param {number} id @param {TPlan} p */
  memberStage(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return null;
    const s = this.setupOf(obs, id, p);
    const spots = this.stageSpots('T', s.site, s.route);
    if (spots.length === 0) return null;
    return spots[this.memberIndex(obs, id, p) % spots.length];
  }
  /** @param {SiteId} site @param {number} idx */
  tRoute(site, idx) {
    const routes = this.intel.routes.T[site];
    return routes.length === 0 ? null : routes[Math.min(idx, routes.length - 1)];
  }
  /**
   * @param {Observation} obs @param {TacOut} out
   * @returns {ThrowWish | null}
   */
  tGoal(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) return this.postPlant(obs, out, b.x, b.y, b.site ?? 'A');
    if (b.state === 'dropped' && b.x !== null && b.y !== null) {
      const bx = b.x;
      const by = b.y;
      const myD = dist(me.x, me.y, bx, by);
      if (!obs.teammates.some((m) => m.alive && dist(m.x, m.y, bx, by) < myD)) {
        out.goal = { x: bx, y: by };
        out.role = '撿炸彈';
        return null;
      }
    }
    const p = this.plan !== null && this.plan.kind !== 'hold' ? this.plan : null;
    if (p === null) return null;
    let exec = p.exec;
    if (exec === null && obs.round.phase === 'live' && obs.round.phaseTicksLeft <= (P.forceExecLeft - 3) * this.tps) exec = this.nearestSite(obs);
    const setup = this.setupOf(obs, me.id, p);
    this.slow = obs.round.phase === 'live' && p.kind !== 'go' && this.spawnWait(obs, p, exec ?? setup.site);
    if (this.slow && this.spawnHeld <= P.spawnStop * this.tps) {
      out.stop = true;
      out.role = '讓突破手先走';
      return null;
    }
    if (exec === null) {
      const st = this.memberStage(obs, me.id, p);
      out.route = this.pickRoute(obs, setup.site, setup.route);
      if (st === null) return null;
      out.goal = { x: st.x, y: st.y };
      out.hold = st;
      const d = dist(me.x, me.y, st.x, st.y);
      out.role = p.kind === 'fake' && this.groupOf(obs, me.id, p) === 1 ? '佯攻' : '待命';
      this.awpSettle(obs, out, st);
      if (d < 10 * UNIT && this.attrs.movement >= 0.3) out.walk = true;
      if (out.role === '佯攻' && d < 2.5 * UNIT) {
        if (this.noiseLeft === 0 && this.stageArrive < 0) {
          this.stageArrive = t;
          this.noiseLeft = 4;
        }
        if (this.noiseLeft > 0) {
          this.noiseLeft--;
          out.noise = true;
          out.look = { x: st.fx, y: st.fy };
        }
        const site = this.intel.sites[setup.site];
        const kind = this.util.pick(me, ['he', 'flash', 'molotov']);
        if (kind !== null && kind !== 'flash') return { kind, x: site.cx, y: site.cy, why: '佯攻' };
      }
      return null;
    }
    if (p.kind !== 'go') {
      out.allowPeek = false;
      out.walk = false;
    }
    const site = this.intel.sites[exec];
    const mine = setup.site === exec;
    out.route = mine ? this.pickRoute(obs, exec, setup.route) : null;
    const ent = mine ? this.entranceOf(exec, setup.route) : null;
    /** @type {ThrowWish | null} */
    let wish = null;
    const sinceExec = this.execTick >= 0 ? (t - this.execTick) / this.tps : 99;
    if (ent !== null && !this.inSite(me.x, me.y, exec, site.cx, site.cy) && dist(me.x, me.y, ent.ox, ent.oy) < 22 * UNIT) {
      const idx = this.memberIndex(obs, me.id, p);
      const role = this.roles.of(me.id);
      const smokeFirst = p.kind !== 'rush' && p.kind !== 'go';
      const st = this.memberStage(obs, me.id, p);
      const near = st !== null && dist(me.x, me.y, st.x, st.y) < 6 * UNIT;
      const supportFirst = role !== SUPPORT && this.isAlive(obs, this.roles.who(SUPPORT)) && this.smokeHeard < 0 && sinceExec < 8;
      if (this.util.has(me, 'smoke') && smokeFirst && idx === this.smokerIndex(obs, me.id, p)) {
        const sp = supportFirst ? null : [this.smokePoint(exec, ent), { x: ent.ix, y: ent.iy }].find((q) => q !== null && this.util.solve(me.x, me.y, q.x, q.y) !== null);
        if (sp !== undefined && sp !== null) wish = { kind: 'smoke', x: sp.x, y: sp.y, why: '封架點' };
      } else if (this.util.has(me, 'flash') && (idx === 0 || (sinceExec > 2.5 && this.flashHeard < 0)) && (!smokeFirst || this.smokeHeard >= 0 || this.util.used.has('smoke') || sinceExec > (this.isAlive(obs, this.roles.who(SUPPORT)) ? 4 : 1.5)) && !(role === ENTRY && smokeFirst && !near)) {
        const fp = this.flashPoint(obs, exec, ent, smokeFirst ? 2 : 5);
        if (fp !== null && (smokeFirst || this.viewer(fp, exec))) wish = { kind: 'flash', x: fp.x, y: fp.y, why: '閃進點' };
      }
      const pending = this.mateFlash.some((x) => t <= x.pop);
      const waiting = smokeFirst && near && wish === null && (pending || (sinceExec < 3 && this.flashHeard < 0 && !this.util.used.has('flash')));
      const lead = smokeFirst && near && wish === null && sinceExec < P.stageLead && this.waitEntry(obs, exec);
      if ((waiting || lead || (smokeFirst && near && wish !== null && sinceExec < 4)) && st !== null) {
        out.goal = { x: st.x, y: st.y };
        out.hold = st;
        out.role = wish !== null ? '丟道具' : lead && !waiting ? '等突破手先走' : '等閃光';
        this.awpSettle(obs, out, st);
        return wish;
      }
    }
    out.role = `執行 ${exec}`;
    if (p.kind !== 'go' && this.yieldTo(obs, exec)) {
      out.stop = true;
      out.look = { x: site.cx, y: site.cy };
      out.role = this.roles.of(me.id) === AWP ? '等隊友先進' : '等突破手先進';
      return wish;
    }
    if (me.hasBomb) {
      const spot = site.plants[0];
      out.goal = { x: spot.x, y: spot.y };
      out.role = '持彈';
      const cx = Math.floor(me.x / UNIT);
      const cy = Math.floor(me.y / UNIT);
      const r = site.rect;
      const inside = inRect({ x0: r.x0 + 1, y0: r.y0 + 1, x1: r.x1 - 1, y1: r.y1 - 1 }, cx, cy);
      const atSpot = dist(me.x, me.y, spot.x, spot.y) < 1500;
      const hurry = obs.round.phaseTicksLeft < 20 * this.tps;
      if (obs.round.phase === 'live' && inside && (atSpot || hurry) && (!P.plantRequireClear || obs.enemies.length === 0) && me.plantTicks === 0) {
        out.cmds.push({ type: 'plant' });
        out.objective = true;
      }
      return wish;
    }
    const k = this.rank(obs, (id) => id !== this.carrierId(obs));
    const holds = this.postSpots(exec, site.cx, site.cy);
    const spot = holds.length > 0 ? holds[k % holds.length] : site.plants[0];
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    return wish;
  }
  /** 煙霧手：組內的支援優先，其次錨點、游擊…（同角色看隊內序號） @param {Observation} obs @param {number} id @param {TPlan} p */
  smokerIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const members = this.ids.filter((x) => this.groupOf(obs, x, p) === gid && obs.teammates.every((m) => m.id !== x || m.alive));
    for (const r of SMOKE_PREF) {
      const who = members.find((x) => this.roles.of(x) === r);
      if (who !== undefined) return this.memberIndex(obs, who, p);
    }
    return -1;
  }
  /** 在包點矩形裡 @param {number} x @param {number} y @param {SiteId} s */
  inRectSite(x, y, s) {
    return inRect(this.intel.sites[s].rect, Math.floor(x / UNIT), Math.floor(y / UNIT));
  }
  /**
   * @param {Observation} obs @param {SiteId} s
   */
  yieldTo(obs, s) {
    const me = obs.me;
    const c = this.g.cellOf(me.x, me.y);
    if (c < 0 || this.intel.distSite[s][c] > P.yieldNear * 10 || this.yielded >= P.yieldMax * this.tps) return false;
    const wait = this.waitEntry(obs, s);
    if (wait) this.yielded += this.data.rules.decisionInterval;
    return wait;
  }
  /**
   * @param {Observation} obs @param {TPlan} p @param {SiteId} s
   */
  spawnWait(obs, p, s) {
    const me = obs.me;
    const e = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
    const c = this.g.cellOf(me.x, me.y);
    if (e === undefined || c < 0 || this.spawnHeld >= P.spawnLeadMax * this.tps || this.intel.distSpawn.T[c] > P.spawnLead * 10) return false;
    if (this.groupOf(obs, e.id, p) !== this.groupOf(obs, me.id, p)) return false;
    const ce = this.g.cellOf(e.x, e.y);
    const dS = this.intel.distSite[s];
    const wait = ce >= 0 && dS[ce] >= dS[c] - 10;
    if (wait) this.spawnHeld += this.data.rules.decisionInterval;
    return wait;
  }
  /** 拿狙擊槍的狙擊手到了待命格 4 格內就站定（守位改成站的地方），讓戰鬥層開鏡架入口 @param {Observation} obs @param {TacOut} out @param {Spot} st */
  awpSettle(obs, out, st) {
    const me = obs.me;
    if (this.roles.of(me.id) !== AWP || me.loadout.primary !== 'awp' || dist(me.x, me.y, st.x, st.y) >= 4 * UNIT) return;
    out.stop = true;
    out.hold = { ...st, x: me.x, y: me.y };
  }
  /** 該不該等：我不是突破手、還沒進點，突破手活著、沒進點、沒有明顯在我前面；狙擊手等到兩個隊友進點 @param {Observation} obs @param {SiteId} s */
  waitEntry(obs, s) {
    const me = obs.me;
    const role = this.roles.of(me.id);
    const dS = this.intel.distSite[s];
    const c = this.g.cellOf(me.x, me.y);
    if (role === ENTRY || c < 0 || this.inRectSite(me.x, me.y, s)) return false;
    const mates = obs.teammates.filter((m) => m.alive);
    if (role === AWP) return mates.filter((m) => this.inRectSite(m.x, m.y, s)).length < Math.min(2, mates.length);
    const e = mates.find((m) => m.id === this.roles.who(ENTRY));
    const ce = e === undefined ? -1 : this.g.cellOf(e.x, e.y);
    return e !== undefined && ce >= 0 && !this.inRectSite(e.x, e.y, s) && dS[ce] >= dS[c] - 10;
  }
  /** 路線的包點入口 @param {SiteId} site @param {number} routeIdx */
  entranceOf(site, routeIdx) {
    const r = this.tRoute(site, routeIdx);
    if (r === null) return null;
    const pid = r.portals[r.portals.length - 1];
    return this.intel.sites[site].entrances.find((e) => e.portal === pid) ?? null;
  }
  /**
   * @param {SiteId} s @param {Entrance} e
   */
  smokePoint(s, e) {
    const g = this.g;
    let best = null;
    let bestS = -Infinity;
    for (const k of this.perc.known.values()) {
      if (k.conf < 50 || dist(k.x, k.y, e.ix, e.iy) > 25 * UNIT || !g.los(k.x, k.y, e.ix, e.iy)) continue;
      const sc = 100 + k.conf;
      if (sc > bestS) {
        bestS = sc;
        best = { x: k.x, y: k.y };
      }
    }
    if (best === null) {
      for (const hs of this.intel.sites[s].holds) {
        const d = dist(hs.x, hs.y, e.ix, e.iy);
        if (d > 25 * UNIT || !g.los(hs.x, hs.y, e.ix, e.iy)) continue;
        if (d > bestS) {
          bestS = d;
          best = { x: hs.x, y: hs.y };
        }
      }
    }
    if (best === null) return null;
    const d = dist(best.x, best.y, e.ix, e.iy);
    const f = Math.min(0.6, (P.smokeOff * UNIT) / Math.max(d, 1));
    return { x: e.ix + (best.x - e.ix) * f, y: e.iy + (best.y - e.iy) * f };
  }
  /** (x, y) 走 depth 步內有沒有看不到爆點 c 的格（BFS） @param {number} x @param {number} y @param {Pt} c @param {number} depth */
  canHide(x, y, c, depth) {
    const g = this.g;
    const start = g.cellOf(x, y);
    if (start < 0) return false;
    let frontier = [start];
    const seen = new Set(frontier);
    for (let d = 0; d <= depth; d++) {
      /** @type {number[]} */
      const next = [];
      for (const i of frontier) {
        const q = g.center(i);
        if (!g.los(q.x, q.y, c.x, c.y)) return true;
        const cx = i % g.W;
        const cy = (i - cx) / g.W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = (cy + dy) * g.W + cx + dx;
          if (g.isBlock(cx + dx, cy + dy) || seen.has(j)) continue;
          seen.add(j);
          next.push(j);
        }
      }
      frontier = next;
    }
    return false;
  }
  /**
   * @param {Pt} p @param {SiteId | null} site
   */
  viewer(p, site) {
    const R = this.util.flashRadius;
    if (this.perc.threats(p.x, p.y, 30).some((k) => dist(k.x, k.y, p.x, p.y) < R && this.g.los(k.x, k.y, p.x, p.y))) return true;
    const heard = this.perc.sectors.some((s) => {
      if (s.conf < 25 || s.kind === 'hurt') return false;
      const r = clamp(dist(s.ox, s.oy, p.x, p.y) / UNIT, s.r0, s.r1) * UNIT;
      return dist(s.ox + cosd(s.dir) * r, s.oy + sind(s.dir) * r, p.x, p.y) < R * 0.6;
    });
    if (heard) return true;
    if (site === null) return false;
    let far = 0;
    for (const k of this.perc.known.values()) if (k.conf >= 30 && dist(k.x, k.y, p.x, p.y) > R * 1.5) far++;
    if (far >= this.enemiesAlive) return false;
    const t = this.perc.lastTick;
    return this.intel.sites[site].holds.some((h) => dist(h.x, h.y, p.x, p.y) < R && !this.perc.cleared(h.cell, t) && this.g.los(h.x, h.y, p.x, p.y));
  }
  /**
   * @param {Observation} obs @param {SiteId} s @param {Entrance} e @param {number} ratio
   */
  flashPoint(obs, s, e, ratio) {
    const g = this.g;
    const site = this.intel.sites[s];
    const R = this.util.flashRadius;
    const key = `${s}${e.portal}:${this.smokes.length}`;
    if (this.flashKey !== key) {
      this.flashKey = key;
      const t = this.perc.lastTick;
      const seers = [...site.holds.filter((h) => !this.perc.cleared(h.cell, t)).map((h) => ({ x: h.x, y: h.y, w: 1 })), ...this.perc.threats(e.ix, e.iy, 30).map((k) => ({ x: k.x, y: k.y, w: 2 }))];
      for (const sc of this.perc.sectors) {
        if (sc.conf < 25 || sc.kind === 'hurt') continue;
        const r = clamp(dist(sc.ox, sc.oy, e.ix, e.iy) / UNIT, sc.r0, sc.r1) * UNIT;
        const q = { x: sc.ox + cosd(sc.dir) * r, y: sc.oy + sind(sc.dir) * r };
        const qc = g.cellOf(q.x, q.y);
        if (qc >= 0 && !g.isWall(qc % g.W, Math.floor(qc / g.W)) && site.regions.has(this.intel.region[qc])) seers.push({ x: q.x, y: q.y, w: 1 });
      }
      /** @type {{ x: number, y: number, sc: number }[]} */
      const list = [];
      const cx = Math.floor(e.ix / UNIT);
      const cy = Math.floor(e.iy / UNIT);
      for (let y = cy - 8; y <= cy + 8; y++) {
        for (let x = cx - 8; x <= cx + 8; x++) {
          if (g.isWall(x, y)) continue;
          const i = y * g.W + x;
          if (!site.regions.has(this.intel.region[i])) continue;
          const c = g.center(i);
          const de = dist(c.x, c.y, e.ix, e.iy);
          if (de > 8 * UNIT || de < 1.5 * UNIT) continue;
          let sc = 0;
          for (const v of seers) {
            if (dist(v.x, v.y, c.x, c.y) > R || !g.los(v.x, v.y, c.x, c.y)) continue;
            if (this.smokes.some((m) => segDist(m.x, m.y, v.x, v.y, c.x, c.y).d < 3 * UNIT)) continue;
            sc += v.w;
          }
          if (sc > 0) list.push({ x: c.x, y: c.y, sc: sc - de / (20 * UNIT) });
        }
      }
      list.sort((a, b) => b.sc - a.sc);
      this.flashList = list.slice(0, 12);
      {
        const d = Math.max(1, dist(e.ix, e.iy, site.cx, site.cy));
        const f = Math.min(1, (4 * UNIT) / d);
        const ax = e.ix + (site.cx - e.ix) * f;
        const ay = e.iy + (site.cy - e.iy) * f;
        /** @type {{ x: number, y: number, sc: number }[]} */
        const def = [];
        for (let y = cy - 8; y <= cy + 8; y++) {
          for (let x = cx - 8; x <= cx + 8; x++) {
            if (g.isWall(x, y)) continue;
            const i = y * g.W + x;
            const c = g.center(i);
            const de = dist(c.x, c.y, e.ix, e.iy);
            if (!site.regions.has(this.intel.region[i]) || de > 8 * UNIT || de < 2 * UNIT || !g.los(e.ox, e.oy, c.x, c.y)) continue;
            def.push({ x: c.x, y: c.y, sc: 1 - dist(c.x, c.y, ax, ay) / (40 * UNIT) });
          }
        }
        def.sort((a, b) => b.sc - a.sc);
        this.flashList.push(...def.slice(0, 12));
      }
    }
    const me = obs.me;
    const B = this.util.blindRange;
    const mates = obs.teammates.filter((m) => m.alive);
    let best = null;
    let bestS = 0;
    let tries = 0;
    for (const c of this.flashList) {
      if (++tries > 12) break;
      if (this.util.solve(me.x, me.y, c.x, c.y) === null) continue;
      let cost = 0;
      for (const m of mates) {
        const d = dist(m.x, m.y, c.x, c.y);
        if (d < B && g.los(m.x, m.y, c.x, c.y) && !(ratio < 5 && this.canHide(m.x, m.y, c, 4))) cost += 1 - d / B;
      }
      const hide = this.nav?.escape(obs, (i) => {
        const q = g.center(i);
        return dist(q.x, q.y, c.x, c.y) < B && g.los(q.x, q.y, c.x, c.y);
      }, 6);
      if (hide === null || hide === undefined) cost += 1 - dist(me.x, me.y, c.x, c.y) / B;
      const gain = 6 * c.sc * 0.5;
      if (gain >= ratio * cost && gain - cost > bestS) {
        bestS = gain - cost;
        best = c;
      }
    }
    return best;
  }
  /**
   * @param {Observation} obs @param {TacOut} out @param {number} bx @param {number} by @param {SiteId} s
   * @returns {ThrowWish | null}
   */
  postPlant(obs, out, bx, by, s) {
    const me = obs.me;
    const t = obs.tick;
    const spots = this.postSpots(s, bx, by);
    const anchor = this.roles.who(ANCHOR);
    const ids = [me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].sort((a, b) => (a === anchor ? -1 : 0) - (b === anchor ? -1 : 0) || a - b);
    const k = Math.max(0, ids.indexOf(me.id));
    out.hold = spots.length > 0 ? spots[k % spots.length] : null;
    out.goal = out.hold ?? { x: bx, y: by };
    out.role = '守包';
    out.allowPeek = false;
    const snd = this.perc.lastSound;
    const defusing = obs.bomb.state === 'defusing' || (snd !== null && snd.kind === 'defuse' && t - snd.tick < this.tps);
    if (defusing) {
      const kind = this.util.pick(me, ['molotov', 'he']);
      if (kind !== null) return { kind, x: bx, y: by, why: '燒拆包' };
    }
    return null;
  }
  /** 守包位：包點守點位（看 CT 最近的入口的先）＋下包位，離炸彈 14 格內 @param {SiteId} s @param {number} bx @param {number} by */
  postSpots(s, bx, by) {
    const site = this.intel.sites[s];
    const holds = site.holds.filter((h) => dist(h.x, h.y, bx, by) < 14 * UNIT).sort((a, b) => (site.entrances[a.entrance]?.ctDist ?? 0) - (site.entrances[b.entrance]?.ctDist ?? 0));
    const plants = site.plants.filter((h) => dist(h.x, h.y, bx, by) < 12 * UNIT && dist(h.x, h.y, bx, by) > 1500).map((h) => ({ ...h, fx: bx, fy: by }));
    return [...holds, ...plants];
  }
  /**
   * @param {Observation} obs @param {SiteId} site @param {number} idx0
   */
  pickRoute(obs, site, idx0) {
    const routes = this.intel.routes.T[site];
    if (routes.length === 0) return null;
    const idx = this.routeOverride >= 0 ? this.routeOverride : Math.min(idx0, routes.length - 1);
    const me = obs.me;
    const c = this.g.cellOf(me.x, me.y);
    if (c < 0 || this.intel.distSpawn.T[c] / 10 > P.routeSwitchNear) return routes[idx];
    /** @param {Route} r */
    const risk = (r) => {
      let v = 0;
      for (const p of r.points) v = Math.max(v, this.perc.danger[this.g.cellOf(p.x, p.y)] ?? 0);
      return v;
    };
    const cur = risk(routes[idx]);
    if (cur < P.routeSwitchRisk) return routes[idx];
    let best = idx;
    for (let i = 0; i < routes.length; i++) if (risk(routes[i]) < risk(routes[best])) best = i;
    if (best !== idx && risk(routes[best]) < cur / 2) this.routeOverride = best;
    return routes[this.routeOverride >= 0 ? this.routeOverride : idx];
  }
  /** @param {Observation} obs */
  carrierId(obs) {
    if (obs.me.hasBomb) return obs.me.id;
    const c = obs.teammates.find((m) => m.alive && m.hasBomb);
    return c === undefined ? -1 : c.id;
  }
  /** 同陣營活人依 id 排序後自己的名次 @param {Observation} obs @param {(id: number) => boolean} [filter] */
  rank(obs, filter = () => true) {
    const ids = [obs.me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].filter(filter).sort((a, b) => a - b);
    return Math.max(0, ids.indexOf(obs.me.id));
  }
  /**
   * @param {Observation} obs @param {CTPlan} p @returns {Map<number, { spot: Spot, site: SiteId | null }>}
   */
  ctLayout(obs, p) {
    const key = `${p.a}${p.m}${p.b}${this.awper}${this.roles.key}`;
    if (this.layout !== null && this.layoutKey === key) return this.layout;
    /** 位置：k ＝ 該點的第幾個（中路 −1） @type {{ spot: Spot, site: SiteId | null, k: number }[]} */
    const pos = [];
    const mids = this.midSpots();
    let m = p.m;
    if (mids.length === 0) m = 0;
    const a = p.a + (mids.length === 0 ? Math.ceil(p.m / 2) : 0);
    const b = 5 - a - m;
    this.siteSpots('A', a).forEach((spot, k) => pos.push({ spot, site: 'A', k }));
    for (let i = 0; i < m; i++) pos.push({ spot: mids[i % mids.length], site: null, k: -1 });
    this.siteSpots('B', b).forEach((spot, k) => pos.push({ spot, site: 'B', k }));
    /** @type {Map<number, { spot: Spot, site: SiteId | null }>} */
    const out = new Map();
    let ids = [...this.ids];
    /** @type {SiteId | null} */
    let snSite = null;
    if (this.awper >= 0) {
      const sn = this.sniperSpot();
      if (sn !== null) {
        let idx = -1;
        for (let i = 0; i < pos.length; i++) if (pos[i].site === sn.site) idx = i;
        if (idx < 0) idx = pos.length - 1;
        pos.splice(idx, 1);
        out.set(this.awper, { spot: sn.spot, site: sn.site });
        ids = ids.filter((x) => x !== this.awper);
        snSite = sn.site;
      }
    }
    /** 角色對位置的偏好（小的好） @type {Record<number, (q: { site: SiteId | null, k: number }) => number>} */
    const pref = {
      [ANCHOR]: (q) => (q.site === null ? 9 : q.k === 0 ? (q.site !== snSite ? 0 : 1) : 2 + q.k),
      [SUPPORT]: (q) => (q.site === null ? 5 : q.k === 1 ? (q.site !== snSite ? 0 : 1) : q.k >= 2 ? 2 : 4),
      [LURK]: (q) => (q.site === null ? 0 : q.k >= 2 ? 1 : q.k === 1 ? 2 : 3),
      [ENTRY]: (q) => (q.site === null ? 3 : q.k === 0 ? (q.site === snSite ? 0 : 1) : 2),
    };
    const free = pos.map(() => true);
    const order = [ANCHOR, SUPPORT, LURK, ENTRY].map((r) => this.roles.who(r)).filter((id) => ids.includes(id));
    for (const id of [...order, ...ids.filter((x) => !order.includes(x))]) {
      const f = pref[this.roles.of(id)] ?? (() => 0);
      let best = -1;
      for (let i = 0; i < pos.length; i++) if (free[i] && (best < 0 || f(pos[i]) < f(pos[best]))) best = i;
      if (best < 0) best = ids.indexOf(id) % Math.max(1, pos.length);
      else free[best] = false;
      const q = pos[best];
      if (q !== undefined) out.set(id, { spot: q.spot, site: q.site });
    }
    this.layout = out;
    this.layoutKey = key;
    return out;
  }
  /** 錨點：點上的錨點角色，否則分到這個點的第一個人 @param {Observation} obs @param {CTPlan} p @param {SiteId} s */
  anchorOf(obs, p, s) {
    const lay = this.ctLayout(obs, p);
    const an = this.roles.who(ANCHOR);
    if (an >= 0 && lay.get(an)?.site === s && this.isAlive(obs, an)) return an;
    for (const id of this.ids) if (lay.get(id)?.site === s && this.isAlive(obs, id)) return id;
    return -1;
  }
  /** 輪轉時留守：另一點的錨點，或守在點上的錨點角色 @param {Observation} obs @param {CTPlan} p @param {number} id */
  stays(obs, p, id) {
    if (p.rot === null) return false;
    const site = this.ctLayout(obs, p).get(id)?.site ?? null;
    return this.anchorOf(obs, p, other(p.rot)) === id || (this.roles.of(id) === ANCHOR && site !== null);
  }
  /** @param {Observation} obs @param {number} id */
  isAlive(obs, id) {
    if (id === obs.me.id) return obs.me.alive;
    return obs.teammates.some((m) => m.id === id && m.alive);
  }
  /**
   * @param {Observation} obs @param {TacOut} out
   * @returns {ThrowWish | null}
   */
  ctGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    const p = this.plan !== null && this.plan.kind === 'hold' ? this.plan : this.chooseCT();
    if (!this.awperFixed) {
      this.awper = me.loadout.primary === 'awp' ? me.id : (obs.teammates.find((m) => m.weapon === 'awp')?.id ?? -1);
      this.awperFixed = obs.round.phase === 'live';
    }
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      this.lastAttack = b.site;
      return this.retake(obs, out, p, b.x, b.y, b.site ?? 'A');
    }
    if (p.rot !== null) this.lastAttack = p.rot;
    const lay = this.ctLayout(obs, p).get(me.id);
    if (lay === undefined) return null;
    let spot = lay.spot;
    out.role = lay.site === null ? '中路' : `守 ${lay.site}`;
    if (p.rot !== null && lay.site !== p.rot && !this.stays(obs, p, me.id)) {
      const stage = this.stageSpots('CT', p.rot, 0);
      const rotators = this.ids.filter((id) => this.isAlive(obs, id) && this.ctLayout(obs, p).get(id)?.site !== p.rot && !this.stays(obs, p, id));
      if (stage.length > 0) {
        spot = stage[Math.max(0, rotators.indexOf(me.id)) % stage.length];
        out.role = `輪轉 ${p.rot}`;
      }
      if (lay.site === null) {
        const stack = this.siteSpots(p.rot, 3)[2];
        if (stack !== undefined) {
          spot = stack;
          out.role = `輪轉疊點 ${p.rot}`;
        }
      }
    }
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    if (obs.round.phase === 'live' && obs.teammates.every((m) => !m.alive) && obs.enemiesAlive <= 2 && this.attrs.aggression >= P.huntAggr) {
      const th = this.perc.threats(me.x, me.y, 30)[0];
      if (th !== undefined) {
        out.goal = { x: th.x, y: th.y };
        out.hold = null;
        out.role = '殘局找人';
      }
    }
    const s = lay.site ?? p.rot;
    if (s !== null) {
      const kind = this.util.pick(me, ['incendiary', 'molotov']);
      if (kind !== null) {
        for (const e of this.intel.sites[s].entrances) {
          let n = 0;
          for (const k of this.perc.known.values()) {
            if (k.conf < 60 || obs.tick - k.tick > 1.5 * this.tps) continue;
            const c = this.g.cellOf(k.x, k.y);
            if (dist(k.x, k.y, e.ox, e.oy) < P.molotovNear * UNIT && !this.intel.sites[s].regions.has(this.intel.region[c])) n++;
          }
          if (n >= 2) return { kind, x: e.ox + (e.ox - e.ix) * 0.3, y: e.oy + (e.oy - e.iy) * 0.3, why: '燒入口' };
        }
      }
    }
    return null;
  }
  /**
   * @param {Observation} obs @param {TacOut} out @param {CTPlan} p @param {number} bx @param {number} by @param {SiteId} s
   * @returns {ThrowWish | null}
   */
  retake(obs, out, p, bx, by, s) {
    const me = obs.me;
    const t = obs.tick;
    const b = obs.bomb;
    out.allowPeek = false;
    const left = (b.ticksLeft ?? 0) / this.tps;
    const myD = dist(me.x, me.y, bx, by);
    const defuseS = (/** @type {boolean} */ k) => (k ? this.data.rules.defuseKitTicks : this.data.rules.defuseTicks) / this.tps;
    const team = this.alive(obs).map((m) => ({ ...m, kit: m.id === me.id ? me.loadout.kit : this.kits.has(m.id), d: dist(m.x, m.y, bx, by), defusing: m.id === me.id ? me.defuseTicks > 0 : obs.teammates.some((x) => x.id === m.id && x.defusing) }));
    const closest = Math.min(...team.map((m) => m.d));
    let defuser = team.find((m) => m.defusing);
    if (defuser === undefined) {
      const withKit = team.filter((m) => m.kit && m.d <= closest + 8 * UNIT).sort((a, c) => a.d - c.d || a.id - c.id);
      defuser = withKit[0] ?? [...team].sort((a, c) => a.d - c.d || a.id - c.id)[0];
    }
    const fastest = Math.min(...team.map((m) => m.d / UNIT / 4.6 + defuseS(m.kit)));
    const outnumbered = team.length === 1 && obs.enemiesAlive >= 3 && this.attrs.discipline >= 0.5 && this.attrs.aggression < 0.6 && this.econ.shortOf(me.money + 1400, me.loadout.primary, 'CT') > 0;
    const mateDefusing = obs.teammates.some((m) => m.alive && m.defusing) && left > defuseS(this.kits.size > 0) - 0.5;
    if (me.defuseTicks === 0 && !mateDefusing && (left < fastest + 0.5 || outnumbered || this.saving)) {
      this.saving = true;
      const away = this.saveSpot(obs, bx, by);
      if (away !== null) out.goal = away;
      out.role = '保槍';
      return null;
    }
    const inside = this.inSite(me.x, me.y, s, bx, by);
    const stage = this.stageSpots('CT', s, 0);
    const go = p.go || this.plan === null;
    if (go && this.goTick < 0) this.goTick = t;
    const entry = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
    const lead = go && entry !== undefined && !this.inSite(entry.x, entry.y, s, bx, by) && t - this.goTick < P.retakeLead * this.tps;
    if ((!go || lead) && !inside && stage.length > 0) {
      const others = this.ids.filter((id) => this.isAlive(obs, id));
      const sp = stage[Math.max(0, others.indexOf(me.id)) % stage.length];
      out.goal = { x: sp.x, y: sp.y };
      out.hold = sp;
      out.role = lead ? '等突破手先進' : '回防集結';
      if (dist(me.x, me.y, sp.x, sp.y) < 10 * UNIT) out.walk = true;
      return null;
    }
    /** @type {ThrowWish | null} */
    let wish = null;
    if (!inside && this.util.has(me, 'flash') && defuser.id !== me.id && t - this.flashHeard > 3 * this.tps) {
      const th = this.perc.threats(bx, by, 30).find((k) => dist(k.x, k.y, bx, by) < 12 * UNIT);
      if (th !== undefined) wish = { kind: 'flash', x: th.x, y: th.y, why: '回防閃' };
    }
    if (defuser.id === me.id) {
      out.goal = { x: bx, y: by };
      out.role = '拆包';
      const clear = obs.enemies.length === 0;
      if (myD < 1300 && b.state === 'planted' && me.defuseTicks === 0 && clear) {
        out.cmds.push({ type: 'defuse' });
        out.objective = true;
      }
      return wish;
    }
    const others = this.ids.filter((id) => this.isAlive(obs, id) && id !== defuser.id);
    const k = Math.max(0, others.indexOf(me.id));
    const all = this.postSpots(s, bx, by);
    const away = all.filter((q) => dist(q.x, q.y, bx, by) < 12 * UNIT && Math.abs(adiff(angleTo(q.x, q.y, q.fx, q.fy), angleTo(q.x, q.y, bx, by))) > 70);
    const spots = away.length > 0 ? [...away, ...all.filter((q) => !away.includes(q))] : all;
    const sp = spots.length > 0 ? spots[k % spots.length] : null;
    out.hold = sp;
    out.goal = sp ?? { x: bx, y: by };
    out.role = '回防掩護';
    return wish;
  }
  /** 保槍點：離炸彈 P.saveDist 格以上、走得到的最近格 @param {Observation} obs @param {number} bx @param {number} by */
  saveSpot(obs, bx, by) {
    const me = obs.me;
    if (dist(me.x, me.y, bx, by) >= P.saveDist * UNIT) return { x: me.x, y: me.y };
    if (this.saveCache !== null && dist(this.saveCache.x, this.saveCache.y, bx, by) >= P.saveDist * UNIT) return this.saveCache;
    const g = this.g;
    const zone = this.intel.map.spawnZones.CT;
    const c = this.intel.nearestOpen(Math.floor((zone.x0 + zone.x1) / 2), Math.floor((zone.y0 + zone.y1) / 2));
    const z = g.center(c);
    const far = dist(z.x, z.y, bx, by) >= P.saveDist * UNIT ? z : null;
    this.saveCache = far ?? { x: me.x + (me.x - bx), y: me.y + (me.y - by) };
    return this.saveCache;
  }
  /**
   * @param {Observation} obs @param {TacOut} out
   */
  overlay(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const own = this.util.away !== null && t >= this.util.away.from ? this.util.away : null;
    this.mateFlash = this.mateFlash.filter((x) => t <= x.pop + 2);
    const mf = this.mateFlash.find((x) => dist(me.x, me.y, x.x, x.y) < this.util.blindRange && this.g.los(me.x, me.y, x.x, x.y));
    const f = own !== null ? own : mf !== undefined ? { x: mf.x, y: mf.y, until: mf.pop + 2 } : null;
    if (f !== null && t <= f.until && !out.objective) {
      const R = this.util.blindRange;
      const g = this.g;
      if (dist(me.x, me.y, f.x, f.y) < R && g.los(me.x, me.y, f.x, f.y)) {
        if (this.hideFor !== f.until) {
          this.hideFor = f.until;
          this.hide = this.nav?.escape(obs, (i) => {
            const c = g.center(i);
            return dist(c.x, c.y, f.x, f.y) < R && g.los(c.x, c.y, f.x, f.y);
          }, 7) ?? null;
        }
        if (this.hide !== null) {
          out.goal = this.hide;
          out.hold = null;
          out.route = null;
          out.allowPeek = false;
          out.stop = false;
          out.walk = false;
        }
        out.look = { x: me.x + (me.x - f.x) * 2, y: me.y + (me.y - f.y) * 2 };
        out.urgent = true;
        out.hard = f.until - t <= this.data.rules.reactionTicks + 12;
        return;
      }
    }
    const ownPending = this.util.away !== null && t < this.util.away.until - 3;
    const lead = this.plan?.kind === 'rush' ? Math.round(0.7 * this.tps) : Infinity;
    if (!out.objective && (ownPending || this.mateFlash.some((x) => t < x.pop && x.pop - t <= lead && dist(me.x, me.y, x.x, x.y) < this.util.blindRange))) {
      out.stop = true;
      return;
    }
    if (this.trade !== null) {
      if (t > this.trade.until) this.trade = null;
      else if (!out.objective) {
        out.look = { x: this.trade.x, y: this.trade.y };
        out.stop = true;
        return;
      }
    }
    const c = this.combat;
    if (c !== null && this.attrs.discipline < 0.5 && !out.objective && obs.enemies.length === 0) {
      if (this.chase === null && c.lostPos !== null && t - c.lostTick < this.tps / 2 && c.targetId >= 0) {
        const hp = 100 - (this.dealt.get(c.targetId) ?? 0);
        if (hp <= P.chaseHp && dist(me.x, me.y, c.lostPos.x, c.lostPos.y) < P.chaseRange * UNIT) this.chase = { x: c.lostPos.x, y: c.lostPos.y, until: t + P.chaseTime * this.tps };
      }
      if (this.chase !== null) {
        if (t > this.chase.until) this.chase = null;
        else {
          out.goal = { x: this.chase.x, y: this.chase.y };
          out.hold = null;
          out.role += '・追殘血';
        }
      }
    }
  }
  /**
   * @param {Observation} obs @returns {ThrowWish | null}
   */
  anyNade(obs) {
    const me = obs.me;
    if (!this.util.has(me, 'he') || obs.round.phase === 'freeze') return null;
    const list = [...this.perc.known.values()].filter((k) => k.conf >= 70 && obs.tick - k.tick <= this.tps && Math.abs(k.vx) + Math.abs(k.vy) < 40);
    for (const a of list) {
      const near = list.filter((k) => dist(k.x, k.y, a.x, a.y) < P.nadeCluster * UNIT);
      if (near.length < 2) continue;
      const x = near.reduce((s, k) => s + k.x, 0) / near.length;
      const y = near.reduce((s, k) => s + k.y, 0) / near.length;
      if (dist(me.x, me.y, x, y) < 6 * UNIT) continue;
      if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, x, y) < 4 * UNIT)) continue;
      return { kind: 'he', x, y, why: '手雷' };
    }
    return null;
  }
  /**
   * @param {'T' | 'CT'} team @param {SiteId} s @param {number} routeIdx @returns {Spot[]}
   */
  stageSpots(team, s, routeIdx) {
    const key = `${team}${s}${routeIdx}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const routes = intel.routes[team][s];
    const route = routes.length === 0 ? null : routes[Math.min(routeIdx, routes.length - 1)];
    const site = intel.sites[s];
    /** @type {Spot[]} */
    const out = [];
    const pid = route?.portals[route.portals.length - 1];
    const ent = site.entrances.find((e) => e.portal === pid) ?? (team === 'T' ? site.entrances[0] : [...site.entrances].sort((a, b) => a.ctDist - b.ctDist)[0]);
    if (ent === undefined) {
      this.spotCache.set(key, out);
      return out;
    }
    const field = intel.distSite[s];
    const d0 = field[g.cellOf(ent.ox, ent.oy)];
    const want = d0 + P.stageBack * 10;
    const prev = route !== null && route.points.length >= 3 ? route.points[route.points.length - 3] : this.spawnCenter(team);
    const enemyHolds = team === 'T' ? site.holds : [];
    let best = -1;
    let bestS = -Infinity;
    const R = 18;
    const cx0 = Math.floor(ent.ox / UNIT);
    const cy0 = Math.floor(ent.oy / UNIT);
    for (let y = cy0 - R; y <= cy0 + R; y++) {
      for (let x = cx0 - R; x <= cx0 + R; x++) {
        if (g.isBlock(x, y)) continue;
        const i = y * g.W + x;
        if (site.regions.has(intel.region[i]) || !Number.isFinite(field[i]) || Math.abs(field[i] - want) > 30) continue;
        const c = g.center(i);
        let seen = 0;
        for (const hs of enemyHolds) if (dist(hs.x, hs.y, c.x, c.y) < 30 * UNIT && g.los(hs.x, hs.y, c.x, c.y)) seen++;
        const off = segDist(c.x, c.y, prev.x, prev.y, ent.ox, ent.oy).d / UNIT;
        const sc = -Math.abs(field[i] - want) / 5 - 1.5 * off - 8 * seen - intel.exposure[i] + (intel.cover[i] !== 0 ? 2 : 0) + (team === 'CT' && g.los(c.x, c.y, ent.x, ent.y) ? 4 : 0);
        if (sc > bestS) {
          bestS = sc;
          best = i;
        }
      }
    }
    if (best < 0) {
      this.spotCache.set(key, out);
      return out;
    }
    /** @type {number[]} */
    const queue = [best];
    const depth = new Map([[best, 0]]);
    for (let q = 0; q < queue.length && out.length < 5; q++) {
      const i = queue[q];
      const c = g.center(i);
      if (field[i] >= d0 + 40 && !site.regions.has(intel.region[i]) && out.every((o) => dist(o.x, o.y, c.x, c.y) >= P.stageGap * UNIT)) out.push({ x: c.x, y: c.y, cell: i, fx: ent.x, fy: ent.y, score: 0, entrance: site.entrances.indexOf(ent) });
      const dd = /** @type {number} */ (depth.get(i));
      if (dd >= 4) continue;
      const x = i % g.W;
      const y = (i - x) / g.W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const j = (y + dy) * g.W + x + dx;
        if (g.isBlock(x + dx, y + dy) || depth.has(j)) continue;
        depth.set(j, dd + 1);
        queue.push(j);
      }
    }
    if (team === 'T') out.sort((a, b) => dist(a.x, a.y, ent.ox, ent.oy) - dist(b.x, b.y, ent.ox, ent.oy) || a.cell - b.cell);
    this.spotCache.set(key, out);
    return out;
  }
  /** @param {'T' | 'CT'} team */
  spawnCenter(team) {
    const z = this.intel.map.spawnZones[team];
    return this.g.center(this.intel.nearestOpen(Math.floor((z.x0 + z.x1) / 2), Math.floor((z.y0 + z.y1) / 2)));
  }
  /**
   * @returns {Spot[]}
   */
  midSpots() {
    const hit = this.spotCache.get('mid');
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const entrancePortals = new Set([...intel.sites.A.entrances, ...intel.sites.B.entrances].map((e) => e.portal));
    /** @type {Map<number, number>} */
    const uses = new Map();
    for (const s of SITES) for (const r of intel.routes.T[s]) for (const pid of r.portals) uses.set(pid, (uses.get(pid) ?? 0) + 1);
    let pick = null;
    let pickS = -Infinity;
    for (const [pid, n] of uses) {
      if (entrancePortals.has(pid)) continue;
      const p = intel.portals[pid];
      const c = g.cellOf(p.x, p.y);
      if (c < 0) continue;
      const dA = intel.distSite.A[c] / 10;
      const dB = intel.distSite.B[c] / 10;
      const ct = intel.distSpawn.CT[c] / 10;
      const tt = intel.distSpawn.T[c] / 10;
      if (dA < 15 || dB < 15 || ct < 12 || ct + 5 > tt) continue;
      const sc = 10 * n - Math.abs(dA - dB) / 5 + (tt - ct) / 10;
      if (sc > pickS) {
        pickS = sc;
        pick = p;
      }
    }
    /** @type {Spot[]} */
    const out = [];
    if (pick !== null) {
      const ctAt = intel.distSpawn.CT[g.cellOf(pick.x, pick.y)];
      out.push(...this.watchSpots(pick.x, pick.y, (i) => intel.distSpawn.CT[i] < ctAt, 2, [], -1));
    }
    this.spotCache.set('mid', out);
    return out;
  }
  /**
   * @param {number} px @param {number} py @param {(i: number) => boolean} ok @param {number} n @param {Spot[]} avoid @param {number} entrance
   * @returns {Spot[]}
   */
  watchSpots(px, py, ok, n, avoid, entrance) {
    const g = this.g;
    const intel = this.intel;
    /** @type {Spot[]} */
    const ranked = [];
    const R = P.holdMax;
    const cx0 = Math.floor(px / UNIT);
    const cy0 = Math.floor(py / UNIT);
    for (let y = cy0 - R; y <= cy0 + R; y++) {
      for (let x = cx0 - R; x <= cx0 + R; x++) {
        if (g.isBlock(x, y)) continue;
        const i = y * g.W + x;
        if (!ok(i)) continue;
        const c = g.center(i);
        const d = dist(c.x, c.y, px, py) / UNIT;
        if (d < P.holdMin || d > P.holdMax || !g.los(c.x, c.y, px, py)) continue;
        const sc = 100 - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 8 : 0) + ((intel.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13);
        ranked.push({ x: c.x, y: c.y, cell: i, fx: px, fy: py, score: sc, entrance });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    /** @type {Spot[]} */
    const out = [];
    for (const s of ranked) {
      if (out.length >= n) break;
      if ([...out, ...avoid].every((o) => dist(o.x, o.y, s.x, s.y) >= 4 * UNIT)) out.push(s);
    }
    return out;
  }
  /**
   * @param {SiteId} s @param {number} n @returns {Spot[]}
   */
  siteSpots(s, n) {
    const key = `site${s}${n}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const site = this.intel.sites[s];
    const holds = site.holds;
    /** @type {Spot[]} */
    let out = holds.slice(0, Math.min(2, n));
    if (n > 2 && holds.length > 0) {
      const ei = Math.max(0, holds[0].entrance);
      const e = site.entrances[ei];
      const field = this.intel.distSite[s];
      out = [...out, ...this.watchSpots(e.x, e.y, (i) => field[i] <= P.holdSiteRadius * 10, n - out.length, out, ei)];
    }
    for (let i = 0; out.length < n && holds.length > 0; i++) out.push(holds[i % holds.length]);
    this.spotCache.set(key, out);
    return out;
  }
  /**
   * @returns {{ spot: Spot, site: SiteId, len: number } | null}
   */
  sniperSpot() {
    if (this.sniper !== undefined) return this.sniper;
    const g = this.g;
    const intel = this.intel;
    /** @type {{ spot: Spot, site: SiteId, len: number } | null} */
    let best = null;
    let bestS = -Infinity;
    for (const s of SITES) {
      const site = intel.sites[s];
      const field = intel.distSite[s];
      for (let i = 0; i < g.N; i++) {
        if (g.block[i] === 1 || field[i] > 100) continue;
        const c = g.center(i);
        let others = 0;
        let lenBest = 0;
        let ei = -1;
        site.entrances.forEach((e, k) => {
          const d = dist(c.x, c.y, e.x, e.y) / UNIT;
          if (d > 30 || !g.los(c.x, c.y, e.x, e.y)) return;
          if (d >= 16 && d <= 28 && d > lenBest) {
            if (lenBest > 0) others++;
            lenBest = d;
            ei = k;
          } else others++;
        });
        if (ei < 0) continue;
        const sc = 2 * lenBest - 20 * others - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 6 : 0);
        if (sc > bestS) {
          bestS = sc;
          const e = site.entrances[ei];
          best = { spot: { x: c.x, y: c.y, cell: i, fx: e.x, fy: e.y, score: sc, entrance: ei }, site: s, len: lenBest };
        }
      }
    }
    this.sniper = best;
    return best;
  }
}
export default class ShooterBaseline {
  constructor() {
    /** @type {InitData} */
    this.data = /** @type {any} */ (null);
    /** @type {Helpers} */
    this.h = /** @type {any} */ (null);
    /** @type {Grid} */
    this.g = /** @type {any} */ (null);
    /** @type {MapIntel} */
    this.intel = /** @type {any} */ (null);
    /** @type {Perception} */
    this.perc = /** @type {any} */ (null);
    /** @type {Navigator} */
    this.nav = /** @type {any} */ (null);
    /** @type {Combat} */
    this.combat = /** @type {any} */ (null);
    /** @type {Tactics} */
    this.tactics = /** @type {any} */ (null);
    this.round = -1;
    this.why = '';
  }
  /** @returns {Declaration} */
  declare() {
    return {
      name: 'shooter-baseline',
      version: '2.1',
      style: '基準',
      knobs: [
        { key: 'aggression', name: '侵略偏移', description: '加在屬性「侵略」上的偏移（−50～50）：影響探頭方式、撤退門檻、架槍時間', min: -50, max: 50, default: 0, integer: true },
        { key: 'economy', name: '經濟風格', description: '0 標準、1 保守（不半買）、2 積極（差一點也全買、半買門檻低）', min: 0, max: 2, default: 0, integer: true },
        { key: 'awpSlot', name: '狙擊手', description: '隊內序號幾號在錢夠時買狙擊槍（5 = 沒有狙擊手）', min: 0, max: 5, default: 4, integer: true },
        { key: 'ctSplitA', name: 'CT 守 A 人數', description: 'CT 開局守 A 點的人數（B 固定 2 人，其餘守中路）', min: 0, max: 5, default: P.ctSplitA, integer: true },
        { key: 'plan', name: 'T 計畫', description: '0 自動（依經濟與侵略抽）；1 default、2 rush、3 split、4 fake（指揮才有作用）', min: 0, max: 4, default: 0, integer: true },
        { key: 'role', name: '角色', description: '0 自動（依隊內序號）；1 突破手、2 支援、3 錨點、4 狙擊手（錢夠就買狙擊槍）、5 游擊', min: 0, max: 5, default: 0, integer: true },
      ],
    };
  }
  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  init(data, helpers) {
    this.data = data;
    this.h = helpers;
    initTrig(helpers);
    const k = data.knobs;
    /** @param {AttributeKey} key */
    const at = (key) => clamp((data.attributes?.[key] ?? 50) / 100, 0, 1);
    const awpSlot = k.awpSlot ?? 4;
    const role = (k.role ?? 0) > 0 ? /** @type {number} */ (k.role) : autoRole(data.slot, awpSlot);
    const attrs = {
      aim: at('aim'),
      offAim: role === AWP ? clamp(at('aim') - P.awpOffAim, 0, 1) : at('aim'),
      reaction: at('reaction'),
      awareness: at('awareness'),
      aggression: clamp(at('aggression') + (k.aggression ?? 0) / 100, 0, 1),
      discipline: at('discipline'),
      movement: at('movement'),
    };
    this.attrs = attrs;
    this.g = new Grid(data.map);
    this.intel = new MapIntel(data.map, this.g);
    this.perc = new Perception(this.g, this.intel, data, attrs.awareness);
    this.nav = new Navigator(this.g, this.intel, this.perc, attrs, data);
    this.combat = new Combat(this.g, this.intel, this.perc, this.nav, attrs, data, helpers);
    this.tactics = new Tactics(this.g, this.intel, this.perc, data, helpers, { awpSlot, role, economy: k.economy ?? 0, ctSplitA: k.ctSplitA ?? P.ctSplitA, plan: k.plan ?? 0 }, attrs);
    this.tactics.combat = this.combat;
    this.tactics.nav = this.nav;
  }
  /** @param {Observation} obs */
  newRound(obs) {
    this.round = obs.round.number;
    this.perc.reset();
    this.nav.reset();
    this.combat.reset();
    this.tactics.reset(obs);
  }
  /**
   * @param {Observation} obs
   * @returns {Command[]}
   */
  decide(obs) {
    const me = obs.me;
    if (obs.round.number !== this.round) this.newRound(obs);
    if (!me.alive || obs.round.phase === 'over') return [];
    this.perc.update(obs);
    this.combat.track(obs);
    const tac = this.tactics.update(obs);
    /** @type {Command[]} */
    const out = [];
    /** 下包、拆包這類要最後送（移動會取消它們） @type {Command[]} */
    const late = [];
    for (const c of tac.cmds) (c.type === 'plant' || c.type === 'defuse' ? late : out).push(c);
    if (tac.goal !== null) this.nav.setGoal(tac.goal.x, tac.goal.y, tac.route);
    else this.nav.clearGoal();
    const ev = this.combat.evade(obs);
    const holding = tac.hold !== null && dist(me.x, me.y, tac.hold.x, tac.hold.y) < 900;
    const fight = this.combat.engage(obs, { holding, objective: tac.objective });
    const w = this.combat.weapon(me.weapon);
    const speed = (w?.speed ?? 130) * (me.walking ? 0.52 : 1) * (me.crouching ? 0.34 : 1);
    const nav = this.nav.step(obs, { allowPeek: tac.allowPeek && !fight.engaged && ev === null, speed });
    let moving = false;
    if (!tac.objective) {
      if (ev !== null && ev.move !== null) {
        out.push({ type: 'move', x: Math.round(ev.move.x), y: Math.round(ev.move.y) });
        moving = true;
      } else if (ev !== null) out.push({ type: 'stop' });
      else if (fight.move === 'stop') out.push({ type: 'stop' });
      else if (fight.move !== null) {
        out.push({ type: 'move', x: Math.round(fight.move.x), y: Math.round(fight.move.y) });
        moving = true;
      } else if (fight.holdNav || (tac.stop && !fight.engaged)) out.push({ type: 'stop' });
      else {
        out.push(...nav.cmds);
        moving = nav.moving;
      }
    }
    const next = this.nav.wps[this.nav.wpIdx + 1] ?? this.nav.wps[this.nav.wpIdx] ?? null;
    const aim = ((tac.urgent && !fight.engaged) || tac.hard ? tac.look : null) ?? fight.aim ?? tac.look ?? this.combat.look(obs, { hold: tac.hold, holding: holding && !moving, navLook: nav.look, ahead: next });
    if (aim !== null && (Math.abs(aim.x - me.x) > 50 || Math.abs(aim.y - me.y) > 50)) out.push({ type: 'aim', x: Math.round(aim.x), y: Math.round(aim.y) });
    out.push({ type: 'fire', on: (fight.fire || (tac.noise && !fight.engaged)) && !tac.objective && !tac.hard });
    out.push(...fight.cmds);
    if (!fight.engaged) out.push(...this.combat.upkeep(obs, holding && !moving));
    const crouch = moving ? false : ev !== null ? ev.crouch : (fight.crouch ?? false);
    if (crouch !== me.crouching) out.push({ type: 'crouch', on: crouch });
    const walk = (tac.walk ?? nav.walk) && !fight.engaged && ev === null;
    if (walk !== me.walking) out.push({ type: 'walk', on: walk });
    out.push(...late);
    this.why = `${ROLE_NAME[this.tactics.roles.of(me.id)]}・${tac.role}｜${ev !== null ? ev.why : fight.why || (nav.peeking ? `探頭 ${this.nav.peek?.phase ?? ''}` : nav.moving ? '移動' : '待命')}`;
    return out;
  }
}
