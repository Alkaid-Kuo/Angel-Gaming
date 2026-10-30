// @ts-check
// CS 射擊基準 Bot 共用函式庫：型別、參數表、三角表、格子視線與射線、二元堆積、Dijkstra、小工具。
// 選手模組不能 import：scripts/build-shooter-bots.ts 會把 bots/shooter-src/ 的檔案合併成單檔 bots/shooter-baseline.js。
// 公平：所有推理只用 init 資料（地圖、規則）與每次的觀察資料；不讀引擎內部。

/** @typedef {import('../../src/shooter/api.ts').ShooterInitData} InitData */
/** @typedef {import('../../src/shooter/api.ts').ShooterHelpers} Helpers */
/** @typedef {import('../../src/shooter/api.ts').ShooterObservation} Observation */
/** @typedef {import('../../src/shooter/api.ts').ShooterCommand} Command */
/** @typedef {import('../../src/shooter/api.ts').ShooterDeclaration} Declaration */
/** @typedef {import('../../src/shooter/api.ts').EnemyInfo} Enemy */
/** @typedef {import('../../src/shooter/api.ts').WeaponInfo} WeaponInfo */
/** @typedef {import('../../src/shooter/api.ts').MapInfo} MapInfo */
/** @typedef {import('../../src/shooter/api.ts').Team} Team */
/** @typedef {import('../../src/shooter/api.ts').BuyItem} BuyItem */
/** @typedef {import('../../src/shooter/api.ts').WeaponId} WeaponId */
/** @typedef {import('../../src/shooter/api.ts').AttributeKey} AttributeKey */
/** @typedef {import('../../src/shooter/api.ts').GrenadeId} GrenadeId */
/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect */

/** 1 格 = 1000 座標單位 */
export const UNIT = 1000;

/**
 * 參數表：全部是初值，步驟 7 訓練會調。距離單位標在註解（格或座標單位），時間以決策次數（0.1 秒）或秒標明。
 * 屬性（0～100）以 lerp(值0, 值100, 屬性/100) 接上，屬性 50 取中間值。
 */
export const P = {
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

  // ── 戰術（6-2 團隊） ──
  /** CT 開局守 A 的人數（旋鈕 ctSplitA）；B 固定 ctB 人，其餘守中路 */
  ctSplitA: 2,
  ctB: 2,
  /** 下包時：看得到敵人就不下 */
  plantRequireClear: true,
  /** T 待命點：在包點入口外面這麼多格（距離場差） */
  stageBack: 9,
  /** 待命點附近每人分到的格彼此至少隔幾格 */
  stageGap: 1.6,
  /** split：等第二組到待命點最多幾秒（從開打算）；fake：佯攻組製造聲音後幾秒主力執行 */
  splitWait: 32,
  fakeDelay: 4,
  /** default：開打後幾秒執行（侵略 0 → 100），期間蒐集情報 */
  defaultExec0: 48,
  defaultExec100: 30,
  /** 剩這麼多秒還沒下包就強行執行最近的點 */
  forceExecLeft: 35,
  /** 事件廣播：同一區域的接觸最少隔幾秒再喊；收到的接觸記多久（秒） */
  contactEvery: 1.5,
  contactTtl: 12,
  /** 收到事件後幾次決策才反應（警覺 0 → 100） */
  eventDelay0: 4,
  eventDelay100: 0,
  /** CT 輪轉：某點估計敵人數達到這個值就輪轉（另一點只留錨點） */
  rotateHeat: 2,
  /** 回防：在待命點幾格內算到齊 */
  retakeGather: 3.5,
  /** 回防／保槍：時間不夠的裕度（秒）；保槍要離炸彈幾格 */
  saveMargin: 2,
  saveDist: 22,
  /** 殘局：只剩自己、對方 ≤ 2 人時，侵略 ≥ 這個值（0～1）的 CT 會主動找人 */
  huntAggr: 0.65,
  /** 換血：隊友在這麼近（格）陣亡就朝他死的方向架槍幾秒 */
  tradeRange: 8,
  tradeHold: 1.5,
  /** 不追殘血：估計血量 ≤ 這個值、消失點在這麼近（格）內，紀律低的人會追幾秒 */
  chaseHp: 40,
  chaseRange: 15,
  chaseTime: 3,
  /** 閃光：隊友離爆點太近（格）就不丟 */
  flashMateClear: 4,
  /** 煙霧：放在入口往架點方向幾格 */
  smokeOff: 4.5,
  /** 手雷：兩個以上記得的敵人彼此在這麼近（格）內算聚集 */
  nadeCluster: 3.5,
  /** CT 燃燒：敵人離入口這麼近（格）時封入口外側 */
  molotovNear: 16,

  // ── 角色（2.1） ──
  /** T 執行：不是突破手的人離包點這麼近（格）就等突破手先進；每回合最多等幾秒 */
  yieldNear: 6,
  yieldMax: 3,
  /** 照計畫執行：其他人在待命格等突破手先走，執行後最多幾秒 */
  stageLead: 5,
  /** 開打時和突破手同組的人在出生區（離出生區這麼多格內）慢走讓突破手先走，最多幾秒 */
  spawnLead: 10,
  spawnLeadMax: 4,
  spawnStop: 1.5,
  /** 狙擊專長：狙擊手拿狙擊槍以外的槍時，瞄準屬性少這麼多（0～1） */
  awpOffAim: 0.35,
  /** CT 回防 go 之後，其他人等突破手先進點最多幾秒 */
  retakeLead: 1.2,
};

// ───────── 三角表與角度 ─────────

/** 整數度的 cos／sin：init 時由 helpers.offset 建表（選手禁用 Math.cos／sin） */
const COS = new Float64Array(360);
const SIN = new Float64Array(360);
/** @type {Helpers | null} */
let HELP = null;

/** @param {Helpers} h */
export function initTrig(h) {
  HELP = h;
  for (let d = 0; d < 360; d++) {
    const [x, y] = h.offset(0, 0, d, 1000000);
    COS[d] = x / 1000000;
    SIN[d] = y / 1000000;
  }
}

/** @param {number} d */
export function normDeg(d) {
  const r = Math.round(d) % 360;
  return r < 0 ? r + 360 : r;
}

/** @param {number} d */
export function cosd(d) {
  return COS[normDeg(d)];
}

/** @param {number} d */
export function sind(d) {
  return SIN[normDeg(d)];
}

/** 方位角（整數度 0～359；0 = 東、90 = 南） @param {number} ax @param {number} ay @param {number} bx @param {number} by */
export function angleTo(ax, ay, bx, by) {
  if (HELP === null || (ax === bx && ay === by)) return 0;
  return normDeg(HELP.angleTo(ax, ay, bx, by));
}

/** 有號角度差 a − b，範圍 (−180, 180] @param {number} a @param {number} b */
export function adiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
export function dist(ax, ay, bx, by) {
  return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 屬性線性插值：t = 屬性 / 100 @param {number} a @param {number} b @param {number} t */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 點到線段的距離與投影比例 t（0～1 在線段上） @param {number} px @param {number} py @param {number} ax @param {number} ay @param {number} bx @param {number} by */
export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  const c = clamp(t, 0, 1);
  return { d: dist(px, py, ax + dx * c, ay + dy * c), t };
}

/** @param {Rect} r @param {number} cx @param {number} cy */
export function inRect(r, cx, cy) {
  return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
}

// ───────── 格子 ─────────

/** 8 方向（dx, dy, 成本 ×10） */
export const DIR8 = [
  [1, 0, 10],
  [-1, 0, 10],
  [0, 1, 10],
  [0, -1, 10],
  [1, 1, 14],
  [1, -1, 14],
  [-1, 1, 14],
  [-1, -1, 14],
];

export class Grid {
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
export class Heap {
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
export function dijkstra(g, sources) {
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
export function rectCells(g, r) {
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
