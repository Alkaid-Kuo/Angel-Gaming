// @ts-check
// CS 射擊基準 Bot（步驟 6）：四層架構。
//   感知 memory.js（每次決策）：敵情記憶、已清空格、危險格成本（每秒）
//   導航 analysis.js（init 一次：可走格、距離場、區域交界與窄口、掩體點、守點位、下包位、路線集）＋ nav.js（A*、路徑點、被擋重算、探頭）
//   戰鬥 combat.js（每次決策）：目標、預判瞄準、點放、停步、蹲、換彈、狙擊、撤退、被閃、道具自保、沒事時看哪裡
//   戰術 tactics.js（回合開始＋每次決策）：隊內計畫（say）、T 進點／下包、CT 分守／回防、購買（6-1 最簡版，6-2 擴充）
// 公平：只讀 init 資料與觀察資料；不寫死任何地圖座標、區域代號或地圖 id。
// 屬性包（attributes，0～100）接到行為：aim 瞄準誤差與收斂；reaction 開火前額外等待與對聲音的反應；awareness 記憶衰減、
// 已清空維持時間、守位掃描頻率、雷達與聲音採信；aggression 探頭等待與方式、撤退門檻、架槍時間；
// discipline 隊友擋線的安全距離、守位中不追出射程外的目標；
// movement 停步乾淨度、肩探（太低只會寬探）、附近有敵人時靜步。旋鈕是外部粗調（侵略偏移、經濟、狙擊手、CT 分點、角色）。
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
/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect */

/** 1 格 = 1000 座標單位 */
const UNIT = 1000;

/**
 * 參數表：全部是初值，步驟 7 訓練會調。距離單位標在註解（格或座標單位），時間以決策次數（0.1 秒）或秒標明。
 * 屬性（0～100）以 lerp(值0, 值100, 屬性/100) 接上，屬性 50 取中間值。
 */
const P = {
  // ── 地圖分析 ──
  /** 窄口：區域交界通道寬度上限（格） */
  chokeWidth: 6,
  /** 守點位離入口的距離範圍（格） */
  holdMin: 8,
  holdMax: 20,
  /** 守點位候選：離包點矩形的路徑距離上限（格） */
  holdSiteRadius: 8,
  /** 暴露度：8 個方向射線，走得到這麼遠（格）就算暴露 */
  exposeRay: 6,
  /** 路線集：長度不超過最短路線的倍數、每個包點最多幾條 */
  routeSlack: 1.6,
  routeMax: 3,

  // ── 感知 ──
  confSee: 100,
  confRadar: 80,
  confTracer: 70,
  confHurt: 60,
  confSound: 40,
  confDeath: 50,
  /** 信心每秒衰減：警覺 0 → 100 */
  decay0: 35,
  decay100: 15,
  /** 低於這個信心就移到「未確認」 */
  unconfirmed: 30,
  /** 「已清空」維持幾秒（警覺 0 → 100） */
  clearTtl0: 5,
  clearTtl100: 10,
  /** 聲音扇形半寬（度）與距離帶（格） */
  sectorHalfDeg: 15,
  bandNear: [0, 12],
  bandMid: [12, 30],
  bandFar: [30, 60],
  /** 雷達與聲音的採信倍率：警覺 0 → 100 */
  trust0: 0.7,
  trust100: 1,
  /** 隊友視錐掃描（已清空）每幾次決策做一次 */
  mateScanEvery: 2,

  // ── 導航（A* 基本成本：直走 10、斜走 14） ──
  /** 危險格成本 = 信心 × 係數（敵人看得到的格；距離衰減：dangerRange 格處剩一半） */
  dangerCoef: 0.6,
  /** 聲音扇形內的格 */
  sectorCoef: 0.3,
  /** 危險射線的最遠距離（格） */
  dangerRange: 30,
  /** 貼牆加成（避免卡角）與矮牆旁優惠 */
  wallHug: 4,
  lowBonus: 3,
  /** 跟路線時，路線以外區域的格加成 */
  offRoute: 12,
  /** 換路線：離 T 出生區這麼近（格）才換；路線交界點的危險格成本超過這個值就換 */
  routeSwitchNear: 35,
  routeSwitchRisk: 15,
  /** 重算路徑的間隔（tick） */
  replanTicks: 30,
  /** 被擋住：連續幾次決策幾乎沒動（1 秒） */
  stuckDecisions: 10,
  /** 到路徑點的判定距離（座標單位）；平滑線段上限（格） */
  waypointReach: 1200,
  maxSegment: 6,
  /** 探頭：停在窄口前幾格、等幾次決策（侵略 0 → 100） */
  peekStop: 2,
  peekHold0: 6,
  peekHold100: 2,
  /** 侵略低於這個值、而且走位不低於 shoulderMove 才用肩探（露一半再退），否則直接寬探過去 */
  shoulderBelow: 60,
  shoulderMove: 40,
  /** 走位高於這個值：附近（20 格）有記得的敵人時靜步移動 */
  silentMove: 60,
  /** 敵人最快的移動速度（格／秒，含裕度）：用來判斷某格敵人「可能已經到了」 */
  enemySpeed: 4.6,

  // ── 戰鬥 ──
  /** 瞄準誤差初值（格）：aim 0 → 100 */
  aimErr0: 1.0,
  aimErr100: 0.15,
  /** 每次決策的誤差收斂比例：aim 0 → 100 */
  aimConv0: 0.8,
  aimConv100: 0.4,
  /** 預判：反應延遲之外再多看幾 tick */
  leadExtra: 2,
  /** 看到新目標後額外等幾次決策才開火：reaction 0 → 100 */
  react0: 3,
  react100: 0,
  /** 開火散佈門檻：散佈 ≤ 目標半張角 × K（或基礎散佈）才開火 */
  fireSpreadK: 2.6,
  /** 狙擊開火的瞄準誤差上限（格） */
  awpErr: 0.22,
  /** 狙擊近距離切手槍（格） */
  awpClose: 8,
  /** 彈匣空了、敵人在這個距離內就切手槍（格） */
  pistolSwitch: 12,
  /** 換彈：沒看到敵人且彈匣低於這個比例 */
  reloadBelow: 0.4,
  /** 隊友擋線：隊友離彈道小於這個距離（座標單位）就不開火：discipline 0 → 100 */
  friendClear0: 700,
  friendClear100: 1200,
  /** 紀律高於這個值：守位中目標跑出射程不追 */
  holdFirm: 50,
  /** 撤退：血量門檻（侵略 0 → 100）；1 對多：看得到 ≥ N 個敵人（侵略 0 → 100，取整數部分）且 mateNear 格內沒有隊友 */
  retreatHp0: 40,
  retreatHp100: 20,
  outnumber0: 2,
  outnumber100: 4,
  mateNear: 10,
  /** 掩體搜尋半徑（格） */
  coverRadius: 8,
  /** 目標消失後架槍幾秒（侵略 0 → 100） */
  holdAngle0: 2.0,
  holdAngle100: 0.6,
  /** 開火時蹲的最短距離（格） */
  crouchFireMin: 8,
  /** 停步開火的乾淨度：movement 0 → 100 時「這次先不停」的機率 */
  sloppyStop0: 0.5,
  sloppyStop100: 0,
  /** 道具自保：手雷／燃燒落點離自己幾格內要離開 */
  nadeAvoid: 4,

  // ── 戰術（6-1 最簡版） ──
  /** CT 守 A 的人數（隊內序號 < 這個值守 A） */
  ctSplitA: 3,
  /** 下包時：看得到敵人就不下 */
  plantRequireClear: true,
};

// ───────── 三角表與角度 ─────────

/** 整數度的 cos／sin：init 時由 helpers.offset 建表（選手禁用 Math.cos／sin） */
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

// ───────── 格子 ─────────

/** 8 方向（dx, dy, 成本 ×10） */
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
    /** 牆（擋視線、子彈） */
    this.wall = new Uint8Array(this.N);
    /** 擋移動（牆或矮牆） */
    this.block = new Uint8Array(this.N);
    /** 矮牆 */
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
   * 站姿視線（座標單位）：牆擋、矮牆不擋；斜穿格角時兩側都是牆才擋（同引擎）。起點與終點格不檢查
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
   * 射線：從 (x, y) 朝 deg 每半格走一步，最多 maxCells 格，碰牆停；每格呼叫 visit(格索引, 距離格數)，回傳 false 就停
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
   * 直線走得過去（座標單位）：沿線每 1/4 格取樣，連同左右 0.4 格的平行線都不碰擋移動的格
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

// ───────── 二元堆積與 Dijkstra ─────────

/** 最小堆積（允許重複推入，取出時由呼叫端略過過期的項目）；型別陣列重複使用，不足時加倍 */
class Heap {
  constructor(cap = 4096) {
    this.node = new Int32Array(cap);
    this.key = new Float64Array(cap);
    this.size = 0;
    /** 上一次 pop 取出的鍵值 */
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

  /** 取出最小的節點（呼叫前確認 size > 0）；最小鍵值放在 lastKey */
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
 * 多源 Dijkstra（8 方向、不斜穿牆角；成本 ×10）：回傳每格到最近來源的路徑長（×10），走不到為 Infinity
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
 * 區域交界：兩個區域之間相連的一段邊界。a < b；cells 是 a 側的邊界格
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
    // ── 區域歸屬：包含該格的最小區域（同引擎 regionsAt 的排序）；不在任何區域的可走格歸最近的區域 ──
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

    // ── 距離場（×10）──
    this.distSite = { A: dijkstra(g, rectCells(g, this.siteRect('A'))), B: dijkstra(g, rectCells(g, this.siteRect('B'))) };
    this.distSpawn = { T: dijkstra(g, rectCells(g, map.spawnZones.T)), CT: dijkstra(g, rectCells(g, map.spawnZones.CT)) };

    // ── 暴露度（8 方向有幾個方向能看出去 P.exposeRay 格）與旁邊的掩護（1 = 貼牆、2 = 貼矮牆）──
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

    // ── 區域交界 ──
    /** @type {Portal[]} */
    this.portals = [];
    /** 邊界格（兩側）→ 交界編號 */
    this.portalAt = new Int16Array(N).fill(-1);
    this.findPortals();
    /** 窄口：寬度 ≤ P.chokeWidth 的交界 */
    this.chokes = this.portals.filter((p) => p.choke);
    for (const c of this.chokes) c.covers = this.chokeCovers(c);

    // ── 包點 ──
    /** @type {Record<'A' | 'B', SiteIntel>} */
    this.sites = { A: this.siteIntel('A'), B: this.siteIntel('B') };

    // ── 路線集 ──
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
        // 8 連通的一段邊界
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
        // a 側中心、b 側中心（a 側邊界格相鄰的 b 區域格）
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
   * 窄口的掩體點：貼牆或矮牆、看得到窄口、暴露度低，離窄口 5～16 格；窄口兩側各取一個
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
    // 包點所屬區域：含中心格的區域，以及一半以上的格在包點內的區域
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
    // 入口：包點區域與外面的交界
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
    // T 最可能來的入口排前面
    entrances.sort((a, b) => a.tDist - b.tDist);
    const site = { id, rect, cx: cp.x, cy: cp.y, regions, entrances, holds: /** @type {Spot[]} */ ([]), plants: /** @type {Spot[]} */ ([]) };
    site.holds = this.holdSpots(site);
    site.plants = this.plantSpots(site);
    return site;
  }

  /**
   * 守點位：每個入口挑一～兩個點：看得到入口、離入口 P.holdMin～P.holdMax 格、
   * 看得到的其他入口越少越好、暴露度低、貼牆或矮牆；候選限包點附近（路徑距離 ≤ P.holdSiteRadius 格）
   * @param {SiteIntel} site
   * @returns {Spot[]}
   */
  holdSpots(site) {
    const g = this.g;
    const field = this.distSite[site.id];
    /** @type {number[]} */
    const cand = [];
    for (let i = 0; i < g.N; i++) if (field[i] <= P.holdSiteRadius * 10 && g.block[i] === 0) cand.push(i);
    // 每個候選看得到哪些入口
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
    // 入口已依 T 的距離排序，每個入口的兩個點排在一起：分配守位時 T 最可能來的入口先有兩個人（實測比每個入口各一人好，見 6-1 報告）；同一點只留一次
    /** @type {Spot[]} */
    const uniq = [];
    for (const s of out) if (!uniq.some((u) => u.cell === s.cell)) uniq.push(s);
    return uniq;
  }

  /**
   * 下包位：包點內、四鄰都可走、能直視的入口越少越好、貼掩護；取 3 個彼此相距 ≥ 4 格
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
   * 路線集：在區域鄰接圖上列舉從出生區到包點區域的簡單路徑（長度 ≤ 最短 × P.routeSlack），
   * 取經過區域差異夠大的最多 P.routeMax 條（至少 2 條，地圖只有一條路時例外）
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
    /** 區域 → 交界清單 */
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
      // 只找到一條差異夠大的：補上差異最大的那條
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
    /** 每個交界的威脅信心 */
    this.portalThreat = new Float32Array(intel.portals.length);
    /** 每個區域最近被看過的格的比例 */
    this.regionSeen = new Float32Array(intel.regionCount);
    this.dangerTick = -1000000;
    this.dangerDirty = true;
    this.lastTick = -1;
    this.updates = 0;
    /** @type {Map<number, boolean>} */
    this.mateAlive = new Map();
    /** 回合開打的 tick（判斷敵人最快可能到哪裡） */
    this.liveStart = -1;
    /** 這次更新的事件 */
    /** @type {{ dir: number, tick: number } | null} */
    this.lastHurt = null;
    /** @type {Sector | null} */
    this.lastSound = null;
    /** @type {number[]} */
    this.newIds = [];
    this.myTeam = /** @type {Team} */ ('T');
  }

  /** 回合開始：清空記憶 */
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
    // ── 衰減 ──
    const loss = this.decay * dt;
    for (const [id, k] of this.known) {
      k.conf -= loss;
      if (k.conf <= 0) this.known.delete(id);
    }
    this.anon = this.anon.filter((a) => (a.conf -= loss) > 0);
    this.sectors = this.sectors.filter((s) => (s.conf -= loss * 1.5) > 0);
    // ── 看到的敵人：位置、朝向、武器、信心 100 ──
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
    // ── 雷達：位置、信心 80 ──
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
    // ── 敵人的彈道起點：信心 70（附近有記得的敵人就更新它，否則記成不知道是誰的點）──
    for (const tr of obs.tracers) {
      if (tr.friendly) continue;
      this.notePoint(tr.x0, tr.y0, P.confTracer, t);
    }
    // ── 受傷：方向扇形、信心 60 ──
    for (const h of me.hurt) {
      this.addSector(me.x, me.y, h.dirDeg, 0, 40, P.confHurt, t, 'hurt');
      this.lastHurt = { dir: h.dirDeg, tick: t };
    }
    // ── 敵方聲音：方向扇形、信心 40 ──
    for (const s of obs.sounds) {
      if (s.friendly || !ENEMY_SOUNDS.has(s.kind)) continue;
      const band = BANDS[s.range];
      this.lastSound = this.addSector(me.x, me.y, s.dirDeg, band[0], band[1], P.confSound * this.trust, t, s.kind);
    }
    // ── 隊友陣亡：敵人看得到那裡 ──
    for (const m of obs.teammates) {
      if (this.mateAlive.get(m.id) === true && !m.alive) {
        this.anon.push({ x: m.x, y: m.y, tick: t, conf: P.confDeath, src: 'death' });
        this.dangerDirty = true;
      }
      this.mateAlive.set(m.id, m.alive);
    }
    // ── 敵人數校正：記得的比活著的多，就丟掉最不確定的（看得到的不丟）──
    if (this.known.size > obs.enemiesAlive) {
      const list = [...this.known.values()].filter((k) => k.tick !== t).sort((a, b) => a.conf - b.conf || a.id - b.id);
      while (this.known.size > obs.enemiesAlive && list.length > 0) this.known.delete(/** @type {Known} */ (list.shift()).id);
    }
    // ── 已清空：自己的視錐每次、隊友的每 P.mateScanEvery 次 ──
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
   * 加一個扇形（同方向同距離帶的合併）
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
    // 同 Grid.ray（每半格一步、碰牆停），寫成迴圈避免每條射線配置閉包
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
    // 交界威脅：附近（10 格內）記得的敵人信心
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
    // 區域的已看過比例
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
    /** 站在矮牆旁、出生區等格的固定成本（不含危險） */
    this.base = new Float32Array(g.N);
    for (let i = 0; i < g.N; i++) {
      if (g.block[i] === 1) continue;
      const c = intel.cover[i];
      this.base[i] = ((c & 1) !== 0 ? P.wallHug : 0) - ((c & 2) !== 0 ? P.lowBonus : 0);
    }
    this.peekHold = Math.round(lerp(P.peekHold0, P.peekHold100, attrs.aggression));
    /** 看得到的火區格（戰鬥層每次更新），A* 視為高成本 @type {Set<number>} */
    this.hazard = new Set();
    /** 上次算路徑時的火區格數（變了就重算） */
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
    /** 上一個走過的路徑點（被閃時退回去） @type {Pt | null} */
    this.prevPt = null;
    /** @type {Peek | null} */
    this.peek = null;
    /** @type {Map<number, number>} */
    this.peeked = new Map();
    this.replans = 0;
  }

  /**
   * 設定目標（同一點半格內不重算）；route 給了就偏好走路線上的區域
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
   * A*：回傳格索引路徑（含起點與終點）；走不到回傳 null
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
    // 身體半徑加裕度：左右 0.4 格的平行線也不能碰到
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
   * 每次決策：沿路徑走（含探頭）
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
    // ── 被擋住：連續幾乎沒動 ──
    const still = Math.abs(me.vx) + Math.abs(me.vy) < opts.speed * 0.25;
    const holding = this.peek !== null && this.peek.phase === 'hold';
    if (!freeze && !holding && this.moveStreak >= 3 && still) this.stuck++;
    else this.stuck = 0;
    let avoid = this.avoid !== null && t < this.avoidUntil ? this.avoid : null;
    const blockedAhead = this.stuck >= 4 && this.personAhead(obs);
    if (this.stuck >= P.stuckDecisions || blockedAhead) {
      avoid = this.peopleCells(obs);
      this.avoid = avoid;
      this.avoidUntil = t + 2 * this.tps;
      this.stuck = 0;
      this.peek = null;
      this.plan(obs, avoid);
    }
    // ── 重算：沒有路徑、危險地圖更新且超過間隔、偏離路徑 ──
    const wp = this.wps[this.wpIdx];
    const off = wp !== undefined && dist(me.x, me.y, wp.x, wp.y) > 4 * UNIT && !this.g.walkLine(me.x, me.y, wp.x, wp.y);
    if (this.wps.length === 0 || off || this.hazard.size !== this.hazardSize || (this.perc.dangerTick > this.planTick && t - this.planTick >= P.replanTicks)) this.plan(obs, avoid);
    // ── 前進路徑點 ──
    while (this.wpIdx < this.wps.length - 1) {
      const p = this.wps[this.wpIdx];
      if (dist(me.x, me.y, p.x, p.y) >= P.waypointReach) break;
      this.prevPt = p;
      this.wpIdx++;
    }
    let target = this.wps[this.wpIdx];
    // ── 探頭 ──
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
    out.cmds.push({ type: 'move', x: Math.round(target.x), y: Math.round(target.y) });
    this.moveStreak++;
    out.moving = true;
    // 走位好的人：附近記得有敵人就靜步
    if (!out.walk && this.attrs.movement * 100 > P.silentMove && obs.round.phase === 'live') {
      const th = this.perc.nearestThreat(me.x, me.y);
      if (th !== null && dist(th.x, th.y, me.x, me.y) < 20 * UNIT) out.walk = true;
    }
    return out;
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
          // 只擋和身體重疊（格中心離人 < 0.9 格）的格，自己旁邊留出路
          const c = g.center(i);
          if (dist(c.x, c.y, q.x, q.y) < 900 && dist(c.x, c.y, obs.me.x, obs.me.y) > 1000) s.add(i);
        }
      }
    }
    return s;
  }

  /**
   * 路徑前方 12 格內第一個要探頭的交界（窄口或包點入口）：敵人可能已經到、對面沒清過、對面 6 格內沒有隊友、最近 15 秒沒探過
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
        // 已經太近：不退回，直接記為探過
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
   * 找掩體：自己周圍 P.coverRadius 格內（可走、走得到），對每個威脅點都沒有視線的格；取路徑最近的
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
   * 離開：走得到的格中，離 bad(格) 為假且最近的；bad 為 null 時改找離 (fx, fy) 至少 r 格的最近格
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
 * 交戰結果：aim 瞄準點、fire 開火、move（'stop'、座標或 null＝交給導航）、crouch（null＝不管）、holdNav（暫停導航架槍）
 * @typedef {{ engaged: boolean, aim: Pt | null, fire: boolean, move: 'stop' | Pt | null, crouch: boolean | null, holdNav: boolean, cmds: Command[], why: string }} Fight
 */

const HALF_ANGLE_K = 300 * 5730;

class Combat {
  /**
   * @param {Grid} g @param {MapIntel} intel @param {Perception} perc @param {Navigator} nav
   * @param {Record<AttributeKey, number>} attrs 0～1
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
    this.reactExtra = Math.round(lerp(P.react0, P.react100, attrs.reaction));
    this.soundReact = Math.round(lerp(3, 0, attrs.reaction));
    this.lead = data.rules.reactionTicks + P.leadExtra;
    this.retreatHp = lerp(P.retreatHp0, P.retreatHp100, attrs.aggression);
    this.outnumber = Math.floor(lerp(P.outnumber0, P.outnumber100, attrs.aggression) + 1e-9);
    this.holdAngle = Math.round(lerp(P.holdAngle0, P.holdAngle100, attrs.aggression) * this.tps);
    this.sloppy = lerp(P.sloppyStop0, P.sloppyStop100, attrs.movement);
    this.scanEvery = Math.round(lerp(14, 5, attrs.awareness));
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
   * 自保：火區、腳邊的手雷／燃燒、被閃。回傳要走去的點與要不要蹲；沒事回傳 null
   * @param {Observation} obs
   * @returns {{ move: Pt | null, crouch: boolean, why: string } | null}
   */
  evade(obs) {
    const me = obs.me;
    const g = this.g;
    // 站在火上：走到最近不著火的格
    /** @type {Set<number>} */
    const fire = new Set();
    for (const e of obs.effects) if (e.kind === 'fire' && e.cells !== undefined) for (const c of e.cells) fire.add(c);
    this.nav.hazard = fire;
    const mine = g.cellOf(me.x, me.y);
    if (fire.has(mine)) {
      const p = this.nav.escape(obs, (i) => fire.has(i), 10);
      if (p !== null) return { move: p, crouch: false, why: '離開火區' };
    }
    // 手雷、燃燒的落點在 P.nadeAvoid 格內
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
    // 被閃：退回上一個走過的點（≥ 2.5 格外），到了就蹲
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

  /**
   * 交戰
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
    const vis = obs.enemies;
    if (vis.length === 0) return this.noEnemy(obs, out, ctx);
    // ── 目標：威脅排序 ──
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
      const a = Math.floor(this.h.random() * 360);
      const mag = this.err0 * (0.6 + 0.8 * this.h.random());
      this.errX = cosd(a) * mag;
      this.errY = sind(a) * mag;
    } else {
      this.seen++;
      const moving = Math.abs(me.vx) + Math.abs(me.vy) > 30;
      const k = moving ? Math.sqrt(this.conv) : this.conv;
      this.errX *= k;
      this.errY *= k;
    }
    this.lostTick = t;
    // 預判：對方在我的指令生效時的位置
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
    // ── 武器 ──
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
    // ── 能不能開火 ──
    const inRange = wid === 'knife' ? dc <= 1.4 : dc <= w.range;
    if (!inRange) {
      // 守位中而且紀律高：不離開守位去追
      if (ctx.holding && this.firm) {
        out.why = '射程外・守位不追';
        return out;
      }
      out.why = '射程外・接近';
      out.move = { x: e.x, y: e.y };
      return out;
    }
    // 隊友在彈道上
    let block = false;
    for (const m of obs.teammates) {
      if (!m.alive) continue;
      const s = segDist(m.x, m.y, me.x, me.y, aim.x, aim.y);
      if (s.t > 0 && s.t < 1 && s.d < this.friendClear) block = true;
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
    if (this.seen < this.reactExtra) {
      out.why = '反應中';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    if (me.reloadTicksLeft > 0 && wid !== 'shotgun') {
      out.why = '換彈中';
      return this.finishMove(obs, out, e, false, d, ctx, true);
    }
    // 狙擊：先開鏡，下一次決策才開火；誤差收斂才開
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
    // 散佈門檻：停步後的散佈 ≤ 目標半張角 × K（至少允許基礎散佈）
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
   * 交戰時的移動與蹲：撤退 → 停步（射程內） → 矮牆後沒開火就蹲
   * @param {Observation} obs @param {Fight} out @param {Enemy} e
   * @param {boolean} firing @param {number} d @param {{ holding: boolean, objective: boolean }} ctx @param {boolean} [weak]
   */
  finishMove(obs, out, e, firing, d, ctx, weak = false) {
    const me = obs.me;
    const t = obs.tick;
    // ── 撤退：血少而且打不到、1 對多沒隊友、沒子彈 ──
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
    // ── 停步：射程內停下來開火（走位差的偶爾晚一步停）──
    const lowWall = this.lowCoverNear(me.x, me.y, e.x, e.y);
    if (this.engagedDecisions <= 1 && this.h.random() < this.sloppy) out.move = null;
    else out.move = 'stop';
    // ── 蹲：矮牆後沒在開火就蹲下躲；遠距離開火蹲著開 ──
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
   * 沒看到敵人：剛丟失目標就架槍（守位中或侵略低時暫停導航）；矮牆後蹲著就站起來再探；受傷又看不到人就找掩體
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
    // 受傷但看不到開槍的人：血不多就躲
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
   * 沒交戰時的武器整理：切回主武器、換彈、狙擊鏡
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
   * 沒看到敵人時看哪裡
   * @param {Observation} obs
   * @param {{ hold: Spot | null, holding: boolean, navLook: Pt | null, ahead: Pt | null }} ctx
   * @returns {Pt | null}
   */
  look(obs, ctx) {
    const me = obs.me;
    const t = obs.tick;
    const g = this.g;
    // 1. 雷達：隊友此刻看到的敵人
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
    // 2. 受傷方向
    const hurt = this.perc.lastHurt;
    if (hurt !== null && t - hurt.tick < this.tps) return { x: me.x + cosd(hurt.dir) * 8 * UNIT, y: me.y + sind(hurt.dir) * 8 * UNIT };
    // 3. 敵方聲音（反應延遲後）
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
    // 4. 記得的敵人（3 秒內、25 格內、信心 ≥ 50）
    for (const th of this.perc.threats(me.x, me.y, 50)) {
      if (dist(me.x, me.y, th.x, th.y) > 25 * UNIT) break;
      const k = this.perc.known.get(th.id);
      if (k !== undefined && t - k.tick > 3 * this.tps) continue;
      return { x: th.x, y: th.y };
    }
    // 5. 探頭
    if (ctx.navLook !== null) return ctx.navLook;
    // 6. 守位：看守的入口，偶爾掃看得到的其他交界
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
      // 主要入口看久一點：三次裡兩次看主要入口
      const k = this.scanIdx % (views.length + 1);
      return k < 2 ? views[0] : views[k - 1];
    }
    // 7. 行進中：前方 15 格內看得到、敵人可能已到、沒清過的交界（威脅高的優先）
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
    // 8. 行進方向
    return ctx.ahead;
  }
}

/** @typedef {{ kind: 'go', site: 'A' | 'B', route: number } | { kind: 'hold', a: number }} Plan */
/**
 * 戰術輸出：goal 目標點、route 偏好路線、hold 守位（到了要看哪裡）、objective 正在下包／拆包、allowPeek 可以探頭、cmds 購買／喊話／下包／拆包
 * @typedef {{ goal: Pt | null, route: Route | null, hold: Spot | null, objective: boolean, allowPeek: boolean, cmds: Command[], role: string }} TacOut
 */

/** 解析計畫字串 @param {string} text @returns {Plan | null} */
function parsePlan(text) {
  const go = /^P:go ([AB]) (\d+)$/.exec(text);
  if (go !== null) return { kind: 'go', site: /** @type {'A' | 'B'} */ (go[1]), route: Number(go[2]) };
  const hold = /^P:hold A=(\d) B=(\d)$/.exec(text);
  if (hold !== null) return { kind: 'hold', a: Number(hold[1]) };
  return null;
}

/** @param {Plan} p */
function planText(p) {
  return p.kind === 'go' ? `P:go ${p.site} ${p.route}` : `P:hold A=${p.a} B=${5 - p.a}`;
}

class Tactics {
  /**
   * @param {Grid} g @param {MapIntel} intel @param {Perception} perc
   * @param {InitData} data @param {Helpers} h
   * @param {{ awpSlot: number, economy: number, ctSplitA: number }} opts
   */
  constructor(g, intel, perc, data, h, opts) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.data = data;
    this.h = h;
    this.opts = opts;
    this.tps = data.rules.ticksPerSecond;
    /** @type {Map<string, number>} */
    this.price = new Map(data.weapons.map((w) => [w.id, w.price]));
    for (const n of data.grenades) this.price.set(n.id, n.price);
    /** @type {Plan | null} */
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.bought = false;
    /** 本回合因危險換掉的路線（−1 = 照計畫） */
    this.routeOverride = -1;
  }

  reset() {
    /** @type {Plan | null} */
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.bought = false;
    /** 本回合因危險換掉的路線（−1 = 照計畫） */
    this.routeOverride = -1;
  }

  /** 活著的最小 playerId（含自己） @param {Observation} obs */
  commanderOf(obs) {
    let c = obs.me.alive ? obs.me.id : Infinity;
    for (const m of obs.teammates) if (m.alive && m.id < c) c = m.id;
    return Number.isFinite(c) ? c : -1;
  }

  /** @param {Observation} obs @returns {Plan} */
  choosePlan(obs) {
    if (obs.me.team === 'CT') return { kind: 'hold', a: this.opts.ctSplitA };
    const site = this.h.random() < 0.5 ? 'A' : 'B';
    return { kind: 'go', site, route: 0 };
  }

  /**
   * @param {Observation} obs
   * @returns {TacOut}
   */
  update(obs) {
    const me = obs.me;
    /** @type {TacOut} */
    const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '' };
    // ── 計畫：收喊話；指揮就決定並廣播（指揮換人時重播）──
    const cmd = this.commanderOf(obs);
    for (const c of obs.chat) {
      const p = parsePlan(c.text);
      // 只有 id 比自己小的人（指揮或剛陣亡的指揮）能下計畫
      if (p !== null && c.from < me.id && (p.kind === 'go') === (me.team === 'T')) this.plan = p;
    }
    if (cmd === me.id) {
      if (this.plan === null) this.plan = this.choosePlan(obs);
      if (this.saidAs !== cmd) {
        out.cmds.push({ type: 'say', text: planText(this.plan) });
        this.saidAs = cmd;
      }
    }
    if (this.plan === null && obs.round.phase !== 'freeze') this.plan = this.choosePlan(obs);
    this.commander = cmd;
    if (obs.round.canBuy && !this.bought) {
      this.buy(obs, out.cmds);
      this.bought = true;
    }
    const live = obs.round.phase === 'live';
    out.allowPeek = live && obs.round.phaseTicksLeft > 25 * this.tps;
    if (me.team === 'T') this.tGoal(obs, out);
    else this.ctGoal(obs, out);
    return out;
  }

  /** 同陣營活人依 id 排序後自己的名次 @param {Observation} obs @param {(id: number) => boolean} [filter] */
  rank(obs, filter = () => true) {
    const ids = [obs.me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].filter(filter).sort((a, b) => a - b);
    return Math.max(0, ids.indexOf(obs.me.id));
  }

  /** @param {Observation} obs @param {TacOut} out */
  tGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    const plan = this.plan !== null && this.plan.kind === 'go' ? this.plan : null;
    // 下包後：守在炸彈附近
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      const site = this.intel.sites[b.site ?? 'A'];
      out.hold = this.nearSpot(site, b.x, b.y, this.rank(obs));
      out.goal = out.hold ?? { x: b.x, y: b.y };
      out.role = '守包';
      out.allowPeek = false;
      return;
    }
    // 炸彈掉了：最近的 T 去撿（引擎走到旁邊自動撿）
    if (b.state === 'dropped' && b.x !== null && b.y !== null) {
      const bx = b.x;
      const by = b.y;
      const myD = dist(me.x, me.y, bx, by);
      if (!obs.teammates.some((m) => m.alive && dist(m.x, m.y, bx, by) < myD)) {
        out.goal = { x: bx, y: by };
        out.role = '撿炸彈';
        return;
      }
    }
    if (plan === null) return;
    const site = this.intel.sites[plan.site];
    out.route = this.pickRoute(obs, plan);
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
      return;
    }
    const k = this.rank(obs, (id) => id !== this.carrierId(obs));
    const holds = site.holds;
    const spot = holds.length > 0 ? holds[k % holds.length] : site.plants[0];
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    out.role = '進點';
  }

  /**
   * 路線：照計畫；還在出生區附近而計畫的路線上有危險（交界點的危險格成本高），就換最安全的另一條（本回合記住）
   * @param {Observation} obs @param {{ site: 'A' | 'B', route: number }} plan
   */
  pickRoute(obs, plan) {
    const routes = this.intel.routes.T[plan.site];
    if (routes.length === 0) return null;
    const idx = this.routeOverride >= 0 ? this.routeOverride : Math.min(plan.route, routes.length - 1);
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

  /** @param {Observation} obs @param {TacOut} out */
  ctGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      const bx = b.x;
      const by = b.y;
      out.allowPeek = false;
      const myD = dist(me.x, me.y, bx, by);
      const closest = !obs.teammates.some((m) => m.alive && (m.defusing || dist(m.x, m.y, bx, by) < myD - 100));
      if (closest || me.defuseTicks > 0) {
        out.goal = { x: bx, y: by };
        out.role = '拆包';
        if (myD < 1300 && b.state === 'planted' && me.defuseTicks === 0 && obs.enemies.length === 0) {
          out.cmds.push({ type: 'defuse' });
          out.objective = true;
        }
        return;
      }
      const site = this.intel.sites[b.site ?? 'A'];
      out.hold = this.nearSpot(site, bx, by, this.rank(obs));
      out.goal = out.hold ?? { x: bx, y: by };
      out.role = '回防';
      return;
    }
    const split = this.plan !== null && this.plan.kind === 'hold' ? this.plan.a : this.opts.ctSplitA;
    const siteId = this.data.slot < split ? 'A' : 'B';
    const site = this.intel.sites[siteId];
    const k = siteId === 'A' ? this.data.slot : this.data.slot - split;
    const spot = site.holds.length > 0 ? site.holds[k % site.holds.length] : site.plants[0];
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    out.role = `守 ${siteId}`;
  }

  /** 炸彈附近（12 格內）的守點位或下包位，依名次分配；沒有就 null @param {SiteIntel} site @param {number} x @param {number} y @param {number} k */
  nearSpot(site, x, y, k) {
    const list = [...site.holds, ...site.plants].filter((s) => dist(s.x, s.y, x, y) < 12 * UNIT);
    if (list.length === 0) return null;
    const s = list[k % list.length];
    return { ...s, fx: s.entrance >= 0 ? s.fx : x, fy: s.entrance >= 0 ? s.fy : y };
  }

  /** @param {string} id */
  cost(id) {
    return this.price.get(id) ?? Infinity;
  }

  /**
   * 購買（各買各的）：全買／半買／eco
   * @param {Observation} obs @param {Command[]} cmds
   */
  buy(obs, cmds) {
    const me = obs.me;
    const rules = this.data.rules;
    const money = me.money;
    const rifle = me.team === 'T' ? 'ak' : 'm4';
    const primary = me.loadout.primary;
    const needArmor = me.loadout.armor < rules.maxArmor;
    /** @type {BuyItem[]} */
    const items = [];
    const hasGood = primary !== null && this.cost(primary) >= this.cost('smg') + 1000;
    const awper = this.data.slot === this.opts.awpSlot && money >= this.cost('awp') + rules.armorPrice + 200;
    const full = this.cost(rifle) + rules.armorPrice + (me.team === 'CT' ? rules.kitPrice : 0);
    const eco = this.opts.economy;
    if (awper && primary !== 'awp') {
      items.push('awp');
      if (needArmor) items.push('armor');
      if (me.team === 'CT' && !me.loadout.kit) items.push('kit');
      items.push('flash');
    } else if (hasGood || money >= full - (eco === 2 ? 400 : 0)) {
      if (!hasGood) items.push(rifle);
      if (needArmor) items.push('armor');
      if (me.team === 'CT' && !me.loadout.kit) items.push('kit');
      items.push('flash');
      if (me.team === 'T') items.push('smoke');
    } else if (eco !== 1 && money >= this.cost('smg') + rules.armorPrice + (eco === 2 ? 0 : 500)) {
      if (primary === null) items.push('smg');
      if (needArmor) items.push('armor');
    } else if (money <= rules.economy.startMoney + 100 && primary === null) {
      // 手槍局（或錢很少）：只買護甲
      if (needArmor) items.push('armor');
    }
    const w = this.data.weapons.find((x) => x.id === (primary ?? me.weapon));
    if (w !== undefined && w.reserve > 0 && me.ammoReserve < w.reserve / 2 && me.weapon === w.id) items.push('ammo');
    if (items.length > 0) cmds.push({ type: 'buy', items });
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
    /** 除錯用：最近一次決策的說明 */
    this.why = '';
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: 'shooter-baseline',
      version: '1.0',
      style: '基準',
      knobs: [
        { key: 'aggression', name: '侵略偏移', description: '加在屬性「侵略」上的偏移（−50～50）：影響探頭方式、撤退門檻、架槍時間', min: -50, max: 50, default: 0, integer: true },
        { key: 'economy', name: '經濟風格', description: '0 標準、1 保守（不半買）、2 積極（差一點也全買、半買門檻低）', min: 0, max: 2, default: 0, integer: true },
        { key: 'awpSlot', name: '狙擊手', description: '隊內序號幾號在錢夠時買狙擊槍（5 = 沒有狙擊手）', min: 0, max: 5, default: 4, integer: true },
        { key: 'ctSplitA', name: 'CT 守 A 人數', description: 'CT 開局守 A 點的人數（依隊內序號，其餘守 B）', min: 0, max: 5, default: P.ctSplitA, integer: true },
        { key: 'role', name: '角色覆寫', description: '0 自動；4 狙擊（錢夠就買狙擊槍）；1～3、5 保留給 6-2（突破、支援、錨點、游擊）', min: 0, max: 5, default: 0, integer: true },
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
    const attrs = {
      aim: at('aim'),
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
    const awpSlot = (k.role ?? 0) === 4 ? data.slot : (k.awpSlot ?? 4);
    this.tactics = new Tactics(this.g, this.intel, this.perc, data, helpers, { awpSlot, economy: k.economy ?? 0, ctSplitA: k.ctSplitA ?? P.ctSplitA });
  }

  /** @param {Observation} obs */
  newRound(obs) {
    this.round = obs.round.number;
    this.perc.reset();
    this.nav.reset();
    this.combat.reset();
    this.tactics.reset();
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
    // ── 移動：自保 → 交戰 → 架槍 → 導航 ──
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
      } else if (fight.holdNav) out.push({ type: 'stop' });
      else {
        out.push(...nav.cmds);
        moving = nav.moving;
      }
    }
    // ── 瞄準 ──
    const next = this.nav.wps[this.nav.wpIdx + 1] ?? this.nav.wps[this.nav.wpIdx] ?? null;
    const aim = fight.aim ?? this.combat.look(obs, { hold: tac.hold, holding: holding && !moving, navLook: nav.look, ahead: next });
    if (aim !== null && (Math.abs(aim.x - me.x) > 50 || Math.abs(aim.y - me.y) > 50)) out.push({ type: 'aim', x: Math.round(aim.x), y: Math.round(aim.y) });
    // ── 開火與武器 ──
    out.push({ type: 'fire', on: fight.fire && !tac.objective });
    out.push(...fight.cmds);
    if (!fight.engaged) out.push(...this.combat.upkeep(obs, holding && !moving));
    // ── 姿勢：移動時不蹲 ──
    const crouch = moving ? false : ev !== null ? ev.crouch : (fight.crouch ?? false);
    if (crouch !== me.crouching) out.push({ type: 'crouch', on: crouch });
    const walk = nav.walk && !fight.engaged && ev === null;
    if (walk !== me.walking) out.push({ type: 'walk', on: walk });
    out.push(...late);
    this.why = `${tac.role}｜${ev !== null ? ev.why : fight.why || (nav.peeking ? `探頭 ${this.nav.peek?.phase ?? ''}` : nav.moving ? '移動' : '待命')}`;
    return out;
  }
}
