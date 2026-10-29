// @ts-check
// CS 射擊基準 Bot（步驟 6）：四層架構。
//   感知 memory.js（每次決策）：敵情記憶、已清空格、危險格成本（每秒）
//   導航 analysis.js（init 一次：可走格、距離場、區域交界與窄口、掩體點、守點位、下包位、路線集）＋ nav.js（A*、路徑點、被擋重算、探頭）
//   戰鬥 combat.js（每次決策）：目標、預判瞄準、點放、停步、蹲、換彈、狙擊、撤退、被閃、道具自保、沒事時看哪裡
//   戰術 tactics.js（回合開始＋每次決策）：隊內計畫與事件（say）、T 五種計畫與守包、CT 配置／輪轉／回防／保槍、殘局、換血
//        economy.js（指揮統一買法 B:）、utility.js（道具彈道與投擲）
// 公平：只讀 init 資料與觀察資料；不寫死任何地圖座標、區域代號或地圖 id。
// 屬性包（attributes，0～100）接到行為：aim 瞄準誤差與收斂；reaction 開火前額外等待與對聲音的反應；awareness 記憶衰減、
// 已清空維持時間、守位掃描頻率、雷達與聲音採信；aggression 探頭等待與方式、撤退門檻、架槍時間；
// 已清空維持時間、守位掃描頻率、雷達與聲音採信、隊內事件的反應延遲；aggression 另接 T 計畫（rush 比例、default 執行時機）；
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
  /** 回防：在待命點幾格內算到齊；距包點區域多遠算「在點裡」 */
  retakeGather: 3.5,
  /** 回防／保槍：時間不夠的裕度（秒）；保槍要離炸彈幾格 */
  saveMargin: 2,
  saveDist: 22,
  /** 換血：隊友在這麼近（格）陣亡就朝他死的方向架槍幾秒 */
  tradeRange: 8,
  tradeHold: 1.5,
  /** 不追殘血：估計血量 ≤ 這個值、消失點在這麼近（格）內，紀律低的人會追幾秒 */
  chaseHp: 40,
  chaseRange: 15,
  chaseTime: 3,
  /** 閃光：爆點在入口內側幾格；隊友離爆點太近（格）就不丟 */
  flashDepth: 4,
  flashMateClear: 4,
  /** 煙霧：放在入口往架點方向幾格 */
  smokeOff: 4.5,
  /** 手雷：兩個以上記得的敵人彼此在這麼近（格）內算聚集 */
  nadeCluster: 3.5,
  /** CT 燃燒：敵人離入口這麼近（格）時封入口外側 */
  molotovNear: 16,
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

/** @typedef {'full' | 'force' | 'half' | 'eco'} BuyCall */

/** 解析「B:<買法>」 @param {string} text @returns {BuyCall | null} */
function parseBuy(text) {
  const m = /^B:(full|force|half|eco)$/.exec(text);
  return m === null ? null : /** @type {BuyCall} */ (m[1]);
}

/** 道具購買順序（依隊內序號分角色）：T 突破手閃 2、支援煙 1 閃 1、錨點（CT）燃燒 1；每人至少一顆閃 */
const UTIL = {
  T: [
    ['flash', 'flash', 'smoke', 'he'],
    ['smoke', 'flash', 'molotov', 'he'],
    ['flash', 'smoke', 'flash', 'molotov'],
    ['smoke', 'flash', 'molotov', 'flash'],
    ['flash', 'he', 'smoke'],
  ],
  CT: [
    ['flash', 'incendiary', 'he'],
    ['flash', 'smoke', 'flash'],
    ['flash', 'he', 'flash'],
    ['flash', 'incendiary', 'smoke'],
    ['flash', 'flash', 'he'],
  ],
};

class Economy {
  /**
   * @param {InitData} data @param {Helpers} h
   * @param {{ awpSlot: number, economy: number, discipline: number }} opts
   */
  constructor(data, h, opts) {
    this.data = data;
    this.h = h;
    this.opts = opts;
    /** @type {Map<string, number>} */
    this.price = new Map(data.weapons.map((w) => [w.id, w.price]));
    for (const n of data.grenades) this.price.set(n.id, n.price);
    /** 自己隊伍與對手的連敗補償階數（0 = 沒有連敗） */
    this.lossLevel = 0;
    this.enemyLevel = 0;
    /** 上回合我方贏了（null = 半場第一回合） @type {boolean | null} */
    this.lastWon = null;
    /** 本半場第幾回合（1 起） */
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
   * 指揮決定全隊買法：全隊有 4 人買得起全買 → full；這回合 eco 下回合就能全買 → eco；
   * 手槍局、對方賽點、半場最後一回合 → force；手槍局贏了的第二回合、或買不起全買但夠衝鋒槍 → half
   * @param {Observation} obs @returns {BuyCall}
   */
  teamCall(obs) {
    const me = obs.me;
    const team = me.team;
    if (this.pistolRound(obs)) return 'force';
    // 隊友的主武器看不到（只看得到手上的武器）：手上拿步槍或狙擊槍的算有好槍
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
   * 照買法買（在規則內）：狙擊手錢夠買狙擊槍；道具依角色；CT 全買帶拆彈器；備彈不到一半補
   * @param {Observation} obs @param {BuyCall} call @param {number} slot @returns {BuyItem[]}
   */
  items(obs, call, slot) {
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
    const armor = () => me.loadout.armor < rules.maxArmor && take('armor', rules.armorPrice);
    const kit = () => team === 'CT' && !me.loadout.kit && take('kit', rules.kitPrice);
    const util = (/** @type {number} */ max) => {
      const owned = [...me.loadout.grenades];
      let n = 0;
      for (const g of UTIL[team][slot % 5]) {
        if (n >= max || owned.length >= rules.grenadeSlots) break;
        const def = this.data.grenades.find((x) => x.id === g);
        if (def === undefined || owned.filter((x) => x === g).length >= def.maxCarry) continue;
        if (take(/** @type {BuyItem} */ (g), def.price)) {
          owned.push(/** @type {GrenadeId} */ (g));
          n++;
        }
      }
    };
    // 紀律低：eco 偷買手槍、half 錢夠就自己全買
    const rebel = this.opts.discipline < 0.5 && this.h.random() < 1 - 2 * this.opts.discipline;
    let mode = call;
    if (rebel && call === 'half' && this.shortOf(money, primary, team) <= 0) mode = 'full';
    const good = this.hasGood(primary);
    if (this.pistolRound(obs)) {
      armor();
    } else if (mode === 'full' || (good && mode !== 'eco')) {
      const awper = slot === this.opts.awpSlot && money >= this.cost('awp') + rules.armorPrice + 200;
      if (awper && primary !== 'awp') take('awp', this.cost('awp'));
      else if (!good) take(rifle, this.cost(rifle)) || take('smg', this.cost('smg'));
      armor();
      kit();
      util(4);
    } else if (mode === 'force') {
      if (!good && money >= this.cost(rifle) + rules.armorPrice) take(rifle, this.cost(rifle));
      else if (!good && money >= this.cost('smg') + rules.armorPrice) take('smg', this.cost('smg'));
      armor();
      if (!good && primary === null && items.length === 1 && money >= this.cost('deagle')) take('deagle', this.cost('deagle'));
      kit();
      util(1);
    } else if (mode === 'half') {
      if (!good && primary === null) take('smg', this.cost('smg'));
      armor();
      util(1);
    } else if (rebel && money >= this.cost('deagle') + 1000 && me.loadout.secondary !== 'deagle') {
      // eco：紀律低的人偷買手槍升級
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
    /** @type {Map<string, number>} */
    this.fuse = new Map(data.grenades.map((n) => [n.id, n.fuseTicks]));
    this.flashR = (data.grenades.find((n) => n.id === 'flash')?.radius ?? 15 * UNIT);
    this.lastThrow = -1000000;
    /** 最後一次看到敵人的 tick（交戰剛結束時之前送出的移動指令還沒生效，不丟） */
    this.lastEnemy = -1000000;
    /** 自己丟的閃光：指令生效前（from）繼續看投擲方向，之後背對到 until @type {{ x: number, y: number, tx: number, ty: number, from: number, until: number } | null} */
    this.away = null;
    /** 本回合丟過的種類（每種每人一次） @type {Set<string>} */
    this.used = new Set();
    this.throws = 0;
  }

  reset() {
    this.lastThrow = -1000000;
    this.lastEnemy = -1000000;
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
   * 直線丟得到：路上沒有牆（道具半徑 0.1 格加裕度），回傳整數方向與力道與落點；丟不到回傳 null
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by
   */
  solve(ax, ay, bx, by) {
    const d = dist(ax, ay, bx, by);
    if (d < 2 * UNIT || d > this.range) return null;
    const deg = angleTo(ax, ay, bx, by);
    const power = Math.max(1, Math.min(100, Math.round((d / this.range) * 100)));
    const len = (power * this.range) / 100;
    const lx = ax + cosd(deg) * len;
    const ly = ay + sind(deg) * len;
    if (dist(lx, ly, bx, by) > 1.2 * UNIT || !this.clear(ax, ay, lx, ly)) return null;
    return { deg, power, x: lx, y: ly };
  }

  /** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
  clear(ax, ay, bx, by) {
    const g = this.g;
    const len = dist(ax, ay, bx, by);
    if (len < 1) return true;
    const px = (-(by - ay) / len) * 180;
    const py = ((bx - ax) / len) * 180;
    const steps = Math.ceil(len / 200);
    for (let k = 1; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps;
      const y = ay + ((by - ay) * k) / steps;
      for (const o of [0, 1, -1]) {
        const i = g.cellOf(x + px * o, y + py * o);
        if (i < 0 || g.wall[i] === 1) return false;
      }
    }
    return true;
  }

  /**
   * 閃光會不會閃到隊友：爆點 P.flashMateClear 格內有看得到爆點的隊友、看得到爆點又最近在開火的隊友、或隊友正看著爆點附近的敵人，就不丟
   * @param {Observation} obs @param {number} x @param {number} y @param {Set<number>} busy 最近在交戰的隊友
   */
  flashSafe(obs, x, y, busy) {
    // 隊友此刻看得到爆點附近的敵人（雷達）：他正對著爆點，不丟
    if (obs.radar.some((r) => dist(r.x, r.y, x, y) < this.flashR)) return false;
    for (const m of obs.teammates) {
      if (!m.alive) continue;
      if (!this.g.los(m.x, m.y, x, y)) continue;
      const d = dist(m.x, m.y, x, y);
      if (d < P.flashMateClear * UNIT) return false;
      // 最近在開火的隊友（交戰中轉不開）
      if (busy.has(m.id) && d < this.flashR) return false;
    }
    return true;
  }

  /**
   * 每次決策：處理戰術層這次的願望（最多一個）。要轉向就回傳 look；朝向對了就丟
   * @param {Observation} obs @param {ThrowWish | null} wish @param {Set<number>} busy 最近在交戰的隊友 @returns {UtilOut}
   */
  step(obs, wish, busy) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {UtilOut} */
    const out = { cmds: [], look: null, stop: false, thrown: null };
    if (obs.enemies.length > 0) this.lastEnemy = t;
    // 自己丟的閃光：背對爆點
    if (this.away !== null) {
      if (t > this.away.until) this.away = null;
      else {
        // 丟出的指令要等反應延遲才生效：這段時間繼續看投擲方向（免得方向被夾到視錐邊界）
        out.look = t < this.away.from ? { x: this.away.tx, y: this.away.ty } : { x: me.x + (me.x - this.away.x) * 2, y: me.y + (me.y - this.away.y) * 2 };
        return out;
      }
    }
    if (wish === null || obs.round.phase === 'freeze' || me.blindTicks > 0 || t - this.lastThrow < this.tps) return out;
    if (!this.has(me, wish.kind)) return out;
    // 看得到敵人時只丟手雷與燃燒（閃光、煙霧要在交戰前丟）
    if (obs.enemies.length > 0 && (wish.kind === 'flash' || wish.kind === 'smoke')) return out;
    const s = this.solve(me.x, me.y, wish.x, wish.y);
    if (s === null) return out;
    if (wish.kind === 'flash' && !this.flashSafe(obs, s.x, s.y, busy)) return out;
    out.look = { x: wish.x, y: wish.y };
    out.stop = true;
    // 方向要在視錐內（引擎會把視錐外的方向夾到邊界），留 15° 裕度；還在走就先停（指令延遲生效時位置會偏，窄處會撞牆反彈）
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

  /** 閃光的影響範圍（座標單位） */
  get flashRadius() {
    return this.flashR;
  }
}

/** @typedef {'A' | 'B'} SiteId */
/** T 計畫：site 主力的點、r1／r2 兩組的路線序號、exec 執行哪個點（null = 還在佈置） @typedef {{ kind: 'go' | 'default' | 'rush' | 'split' | 'fake', site: SiteId, r1: number, r2: number, exec: SiteId | null }} TPlan */
/** CT 計畫：A／中路／B 人數、輪轉目標、回防開始 @typedef {{ kind: 'hold', a: number, m: number, b: number, rot: SiteId | null, go: boolean }} CTPlan */
/** @typedef {TPlan | CTPlan} Plan */
/** @typedef {{ kind: 'contact', region: string, n: number } | { kind: 'dead', region: string } | { kind: 'planted', site: SiteId } | { kind: 'flash', x: number, y: number, pop: number } | { kind: 'smoke', x: number, y: number } | { kind: 'kit' }} TeamEvent */
/**
 * 戰術輸出：goal 目標點、route 偏好路線、hold 守位（到了要看哪裡）、objective 正在下包／拆包、allowPeek 可以探頭、cmds 購買／喊話／丟雷／下包／拆包；
 * look 沒交戰時看哪裡（urgent：躲閃光，連「目標剛消失的架槍」也蓋過）、stop 站住、walk 靜步（null = 導航決定）、noise 佯攻開槍
 * @typedef {{ goal: Pt | null, route: Route | null, hold: Spot | null, objective: boolean, allowPeek: boolean, cmds: Command[], role: string, look: Pt | null, urgent: boolean, stop: boolean, walk: boolean | null, noise: boolean }} TacOut
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
   * @param {{ awpSlot: number, economy: number, ctSplitA: number, plan: number }} opts
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
    this.econ = new Economy(data, h, { awpSlot: opts.awpSlot, economy: opts.economy, discipline: attrs.discipline });
    this.util = new Utility(g, data);
    /** 全隊 id（排序）：隊內序號 = 名次 */
    this.ids = [data.playerId, ...data.teammateIds].sort((a, b) => a - b);
    this.eventDelay = Math.round(lerp(P.eventDelay0, P.eventDelay100, attrs.awareness)) * data.rules.decisionInterval;
    /** 地圖算出來的位置（第一次用到才算） @type {Map<string, Spot[]>} */
    this.spotCache = new Map();
    /** 戰鬥層（估計對手血量用）與導航層（躲閃光用）；由入口接上 @type {Combat | null} */
    this.combat = null;
    /** @type {Navigator | null} */
    this.nav = null;
    /** 躲閃光的格（對應哪一顆閃光） @type {Pt | null} */
    this.hide = null;
    this.hideFor = -1;
    // ── 整場的記憶 ──
    /** 當 CT 時對方打哪個點（最近 6 回合） @type {SiteId[]} */
    this.hits = [];
    /** 當 T 時每個點最近的結果（+1 勝、−1 敗） */
    this.siteScore = { A: 0, B: 0 };
    /** 計畫使用統計（給評測）：種類 → [回合, 勝] @type {Record<string, [number, number]>} */
    this.planStats = {};
    this.lastKind = '';
    this.lastSite = /** @type {SiteId | null} */ (null);
    this.lastAttack = /** @type {SiteId | null} */ (null);
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
    /** 狙擊手（開打時手上拿狙擊槍的人）；開打後固定 */
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
      // 上回合的結果記進整場記憶
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

  // ───────── 每次決策 ─────────

  /**
   * @param {Observation} obs
   * @returns {TacOut}
   */
  update(obs) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {TacOut} */
    const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '', look: null, urgent: false, stop: false, walk: null, noise: false };
    if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
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
    /** @type {ThrowWish | null} */
    let wish = null;
    if (me.team === 'T') wish = this.tGoal(obs, out);
    else wish = this.ctGoal(obs, out);
    if (wish === null) wish = this.anyNade(obs);
    this.overlay(obs, out);
    /** @type {Set<number>} */
    const busy = new Set();
    for (const [id, tk] of this.mateFired) if (t - tk < 1.5 * this.tps) busy.add(id);
    const u = this.util.step(obs, wish, busy);
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
   * 隊友狀態：陣亡（換血、指揮喊 E:dead）、對敵人打出的傷害
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
        // 換血：隊友在附近陣亡，朝他面對的方向架槍
        if (me.alive && dist(m.x, m.y, me.x, me.y) <= P.tradeRange * UNIT) this.trade = { x: m.x + cosd(m.facing) * 10 * UNIT, y: m.y + sind(m.facing) * 10 * UNIT, until: t + Math.round(P.tradeHold * this.tps) };
        if (this.commanderOf(obs) === me.id) {
          const r = this.intel.region[this.g.cellOf(m.x, m.y)];
          if (r >= 0) out.cmds.push({ type: 'say', text: `E:dead ${this.intel.map.regions[r].id}` });
        }
        // 隊友在某點附近陣亡：當作那裡有接觸（CT 輪轉用）
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
      // 第一個計畫與買法立刻處理（凍結時間）；之後的變更與事件依警覺延遲
      const first = this.plan === null && c.text.startsWith('P:');
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
        // 只接受 id 比自己小的人（指揮或剛陣亡的指揮）的計畫；陣營要對
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
      else if (e.kind === 'smoke') this.smokeHeard = t;
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

  // ───────── 指揮 ─────────

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
   * T：eco 多半 rush；否則依侵略與上回合結果抽 default／split／rush／fake；點依兩點最近的成敗加權
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
      const w = call === 'eco' ? { default: 0.25, rush: 0.6, split: 0.15, fake: 0 } : { default: 0.32, rush: 0.12 + 0.2 * ag, split: 0.3, fake: 0.18 };
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
   * T 指揮：佈置完成或時間到就執行；剩 P.forceExecLeft 秒強行執行最近的點
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
        return s === null || dist(m.x, m.y, s.x, s.y) < 3 * UNIT;
      });
      if (ready || el >= P.splitWait) return { ...p, exec: p.site };
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
      const at = lerp(P.defaultExec0, P.defaultExec100, this.attrs.aggression);
      const heat = this.heat(obs);
      // 情報：一點確認 ≥ 2 人、另一點沒有 → 提早打另一點
      const early = el >= at * 0.5 && Math.abs(heat.A - heat.B) >= 2;
      if (el >= at || early) return { ...p, exec: heat.A < heat.B ? 'A' : heat.B < heat.A ? 'B' : p.site };
    }
    return p;
  }

  /** 離持彈者（或自己）最近的點 @param {Observation} obs @returns {SiteId} */
  nearestSite(obs) {
    const c = obs.teammates.find((m) => m.alive && m.hasBomb) ?? obs.me;
    const cell = this.g.cellOf(c.x, c.y);
    if (cell < 0) return 'A';
    return this.intel.distSite.A[cell] <= this.intel.distSite.B[cell] ? 'A' : 'B';
  }

  /**
   * 兩個包點附近估計的敵人數：自己記得的敵人、收到的接觸（同一區域取最新）、隊友陣亡
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
   * CT 指揮：某點估計 ≥ P.rotateHeat 人就輪轉；炸彈下了輪轉到炸彈的點，集結完畢（或時間不多）喊 go
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

  // ───────── 購買、事件廣播 ─────────

  /** 指揮先決定買法並廣播；其他人等指揮的買法（最多 1 秒）再買 @param {Observation} obs @param {TacOut} out @param {boolean} isCmd */
  buy(obs, out, isCmd) {
    const me = obs.me;
    if (!obs.round.canBuy || this.bought) {
      if (!this.kitSaid && me.loadout.kit && obs.round.phase === 'live') {
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
    const items = this.econ.items(obs, call, this.data.slot);
    if (items.length > 0) out.cmds.push({ type: 'buy', items });
    this.bought = true;
  }

  /**
   * 事件廣播：看到敵人 → 「E:contact <區域> <人數>」（同一區域人數變了或隔 P.contactEvery 秒才再喊）
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

  // ───────── T ─────────

  /**
   * 分組：主力 3 人（含持彈者）＝ 0、第二組 2 人 ＝ 1；rush／go 全隊同組。第一次知道計畫時算好（之後有人陣亡不重分）
   * @param {Observation} obs @param {number} id @param {TPlan} p
   */
  groupOf(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return 0;
    const key = `${p.kind}${p.site}`;
    if (this.groups === null || this.groupKey !== key) {
      const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
      const others = this.ids.filter((x) => x !== carrier);
      const main = carrier >= 0 ? [carrier, ...others.slice(0, 2)] : others.slice(0, 3);
      this.groups = new Map(this.ids.map((x) => [x, main.includes(x) ? 0 : 1]));
      this.groupKey = key;
    }
    return this.groups.get(id) ?? 0;
  }

  /** 組內名次（持彈者排最後；第 0 個是突破手） @param {Observation} obs @param {number} id @param {TPlan} p */
  memberIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
    const list = this.ids.filter((x) => this.groupOf(obs, x, p) === gid).sort((a, b) => (a === carrier ? 1 : 0) - (b === carrier ? 1 : 0) || a - b);
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
    // 下包後：守包（下包者與一人在點內，其餘看回防入口）
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) return this.postPlant(obs, out, b.x, b.y, b.site ?? 'A');
    // 炸彈掉了：最近的 T 去撿
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
    // 剩 P.forceExecLeft 秒還沒執行（指揮沒喊）：自己也照最近的點執行
    let exec = p.exec;
    if (exec === null && obs.round.phase === 'live' && obs.round.phaseTicksLeft <= (P.forceExecLeft - 3) * this.tps) exec = this.nearestSite(obs);
    const setup = this.setupOf(obs, me.id, p);
    if (exec === null) {
      // ── 佈置：走自己組的路線到待命格，看入口；靠近了靜步 ──
      const st = this.memberStage(obs, me.id, p);
      out.route = this.pickRoute(obs, setup.site, setup.route);
      if (st === null) return null;
      out.goal = { x: st.x, y: st.y };
      out.hold = st;
      const d = dist(me.x, me.y, st.x, st.y);
      out.role = p.kind === 'fake' && this.groupOf(obs, me.id, p) === 1 ? '佯攻' : '待命';
      if (d < 10 * UNIT && this.attrs.movement >= 0.3) out.walk = true;
      // 佯攻：到了待命格就開幾槍、丟道具進點製造聲音
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
    // ── 執行（go 是 6-1 的直接進點：照常探頭）──
    if (p.kind !== 'go') {
      out.allowPeek = false;
      out.walk = false;
    }
    const site = this.intel.sites[exec];
    const mine = setup.site === exec;
    out.route = mine ? this.pickRoute(obs, exec, setup.route) : null;
    const ent = mine ? this.entranceOf(exec, setup.route) : null;
    // 進點前的道具：支援先煙、突破手再閃；其他人等閃光（最多 3 秒）
    /** @type {ThrowWish | null} */
    let wish = null;
    const sinceExec = this.execTick >= 0 ? (t - this.execTick) / this.tps : 99;
    if (ent !== null && !this.inSite(me.x, me.y, exec, site.cx, site.cy) && dist(me.x, me.y, ent.ox, ent.oy) < 22 * UNIT) {
      const idx = this.memberIndex(obs, me.id, p);
      const smokeFirst = p.kind !== 'rush' && p.kind !== 'go';
      if (this.util.has(me, 'smoke') && smokeFirst && idx === this.smokerIndex(obs, me.id, p)) {
        const sp = this.smokePoint(exec, ent);
        if (sp !== null) wish = { kind: 'smoke', x: sp.x, y: sp.y, why: '封架點' };
      } else if (this.util.has(me, 'flash') && idx === 0 && (!smokeFirst || this.smokeHeard >= 0 || this.util.used.has('smoke') || sinceExec > 1.5)) {
        const fp = this.flashPoint(exec, ent);
        if (fp !== null && this.viewer(fp)) wish = { kind: 'flash', x: fp.x, y: fp.y, why: '閃進點' };
      }
      // 等閃光：還在待命格附近、閃光還沒丟、執行不到 3 秒
      const st = this.memberStage(obs, me.id, p);
      const pending = this.mateFlash.some((x) => t <= x.pop);
      const waiting = smokeFirst && st !== null && dist(me.x, me.y, st.x, st.y) < 4 * UNIT && wish === null && (pending || (sinceExec < 3 && this.flashHeard < 0 && !this.util.used.has('flash')));
      if (waiting) {
        out.goal = { x: st.x, y: st.y };
        out.hold = st;
        out.role = '等閃光';
        return null;
      }
    }
    out.role = `執行 ${exec}`;
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

  /** 支援（煙霧手）：組內序號 1、3 優先，其次 2、0 @param {Observation} obs @param {number} id @param {TPlan} p */
  smokerIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const members = this.ids.filter((x) => this.groupOf(obs, x, p) === gid && obs.teammates.every((m) => m.id !== x || m.alive));
    const pref = [1, 3, 2, 0, 4];
    for (const s of pref) {
      const who = members.find((x) => this.slotOf(x) === s);
      if (who !== undefined) return this.memberIndex(obs, who, p);
    }
    return -1;
  }

  /** 路線的包點入口 @param {SiteId} site @param {number} routeIdx */
  entranceOf(site, routeIdx) {
    const r = this.tRoute(site, routeIdx);
    if (r === null) return null;
    const pid = r.portals[r.portals.length - 1];
    return this.intel.sites[site].entrances.find((e) => e.portal === pid) ?? null;
  }

  /**
   * 煙霧落點：入口內側往「最可能架這個入口的位置」P.smokeOff 格（記得的敵人優先，否則包點守點位中看得到入口、最遠的）
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

  /** 爆點附近可能有敵人看得到（記得的敵人在閃光範圍內、有視線）：沒有就不丟閃光（免得只閃到自己人） @param {Pt} p */
  viewer(p) {
    return this.perc.threats(p.x, p.y, 30).some((k) => dist(k.x, k.y, p.x, p.y) < this.util.flashRadius && this.g.los(k.x, k.y, p.x, p.y));
  }

  /** 閃光爆點：入口內側再往包點中心 P.flashDepth 格（碰牆就短一點） @param {SiteId} s @param {Entrance} e */
  flashPoint(s, e) {
    const site = this.intel.sites[s];
    const d = dist(e.ix, e.iy, site.cx, site.cy);
    if (d < 1) return { x: e.ix, y: e.iy };
    for (let k = P.flashDepth; k >= 1; k--) {
      const f = Math.min(1, (k * UNIT) / d);
      const x = e.ix + (site.cx - e.ix) * f;
      const y = e.iy + (site.cy - e.iy) * f;
      if (this.g.walkable(this.g.cellOf(x, y))) return { x, y };
    }
    return { x: e.ix, y: e.iy };
  }

  /**
   * 下包後：下包者與一人守點內，其餘看回防入口（CT 最近的入口優先）；不衝出去找人。
   * 對方拆包（看見或聽到）就把燃燒／手雷丟到炸彈上
   * @param {Observation} obs @param {TacOut} out @param {number} bx @param {number} by @param {SiteId} s
   * @returns {ThrowWish | null}
   */
  postPlant(obs, out, bx, by, s) {
    const me = obs.me;
    const t = obs.tick;
    const spots = this.postSpots(s, bx, by);
    const k = this.rank(obs);
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
   * 路線：照計畫；還在出生區附近而路線上有危險（交界點的危險格成本高），就換最安全的另一條（本回合記住）
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

  // ───────── CT ─────────

  /**
   * CT 守位分配：A 的守點位（a 個）、中路（m 個）、B 的守點位（b 個）；狙擊手拿長對線位。依隊內序號分配
   * @param {Observation} obs @param {CTPlan} p @returns {Map<number, { spot: Spot, site: SiteId | null }>}
   */
  ctLayout(obs, p) {
    const key = `${p.a}${p.m}${p.b}${this.awper}`;
    if (this.layout !== null && this.layoutKey === key) return this.layout;
    /** @type {{ spot: Spot, site: SiteId | null }[]} */
    const pos = [];
    const hA = this.intel.sites.A.holds;
    const hB = this.intel.sites.B.holds;
    const mids = this.midSpots();
    let m = p.m;
    if (mids.length === 0) m = 0;
    const a = p.a + (mids.length === 0 ? Math.ceil(p.m / 2) : 0);
    const b = 5 - a - m;
    for (let i = 0; i < a; i++) if (hA.length > 0) pos.push({ spot: hA[i % hA.length], site: 'A' });
    for (let i = 0; i < m; i++) pos.push({ spot: mids[i % mids.length], site: null });
    for (let i = 0; i < b; i++) if (hB.length > 0) pos.push({ spot: hB[i % hB.length], site: 'B' });
    /** @type {Map<number, { spot: Spot, site: SiteId | null }>} */
    const out = new Map();
    let ids = [...this.ids];
    if (this.awper >= 0) {
      const sn = this.sniperSpot();
      if (sn !== null) {
        // 狙擊位所在點的最後一個位置換成狙擊位（那個點只有一人時就是錨點自己）
        let idx = -1;
        for (let i = 0; i < pos.length; i++) if (pos[i].site === sn.site) idx = i;
        if (idx < 0) idx = pos.length - 1;
        pos.splice(idx, 1);
        out.set(this.awper, { spot: sn.spot, site: sn.site });
        ids = ids.filter((x) => x !== this.awper);
      }
    }
    ids.forEach((id, i) => {
      const q = pos[i % Math.max(1, pos.length)];
      if (q !== undefined) out.set(id, q);
    });
    this.layout = out;
    this.layoutKey = key;
    return out;
  }

  /** 錨點：每個點分到的第一個人 @param {Observation} obs @param {CTPlan} p @param {SiteId} s */
  anchorOf(obs, p, s) {
    const lay = this.ctLayout(obs, p);
    for (const id of this.ids) if (lay.get(id)?.site === s && this.isAlive(obs, id)) return id;
    return -1;
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
    // 狙擊手：開打時手上拿狙擊槍的人（全隊看到的一樣）
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
    // 輪轉：另一點的錨點以外全部去輪轉點的待命位（本來就守那點的不動）
    if (p.rot !== null && lay.site !== p.rot && this.anchorOf(obs, p, other(p.rot)) !== me.id) {
      const stage = this.stageSpots('CT', p.rot, 0);
      const rotators = this.ids.filter((id) => this.isAlive(obs, id) && this.ctLayout(obs, p).get(id)?.site !== p.rot && this.anchorOf(obs, p, other(/** @type {SiteId} */ (p.rot))) !== id);
      if (stage.length > 0) {
        spot = stage[Math.max(0, rotators.indexOf(me.id)) % stage.length];
        out.role = `輪轉 ${p.rot}`;
      }
    }
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    // 燃燒封入口：兩個以上敵人正接近自己守的點的入口
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
   * 回防：點外的人到待命位集結，go 了一起進（先閃）；拆彈器的人優先拆，其他人守炸彈附近看入口；時間不夠就保槍
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
    // 拆的人：有拆彈器的人（離炸彈不比最近的人遠 8 格以上），否則最近的人；已經在拆的人繼續
    const team = this.alive(obs).map((m) => ({ ...m, kit: m.id === me.id ? me.loadout.kit : this.kits.has(m.id), d: dist(m.x, m.y, bx, by), defusing: m.id === me.id ? me.defuseTicks > 0 : obs.teammates.some((x) => x.id === m.id && x.defusing) }));
    const closest = Math.min(...team.map((m) => m.d));
    let defuser = team.find((m) => m.defusing);
    if (defuser === undefined) {
      const withKit = team.filter((m) => m.kit && m.d <= closest + 8 * UNIT).sort((a, c) => a.d - c.d || a.id - c.id);
      defuser = withKit[0] ?? [...team].sort((a, c) => a.d - c.d || a.id - c.id)[0];
    }
    // 保槍：誰都來不及（最快的人走過去＋拆）；或 1 對 3 以上、紀律高、下回合買不起
    const fastest = Math.min(...team.map((m) => m.d / UNIT / 4.6 + defuseS(m.kit)));
    const outnumbered = team.length === 1 && obs.enemiesAlive >= 3 && this.attrs.discipline >= 0.5 && this.attrs.aggression < 0.6 && this.econ.shortOf(me.money + 1400, me.loadout.primary, 'CT') > 0;
    if (me.defuseTicks === 0 && (left < fastest + 0.5 || outnumbered || this.saving)) {
      this.saving = true;
      const away = this.saveSpot(obs, bx, by);
      if (away !== null) out.goal = away;
      out.role = '保槍';
      return null;
    }
    const inside = this.inSite(me.x, me.y, s, bx, by);
    const stage = this.stageSpots('CT', s, 0);
    const go = p.go || this.plan === null;
    if (!go && !inside && stage.length > 0) {
      const others = this.ids.filter((id) => this.isAlive(obs, id));
      const sp = stage[Math.max(0, others.indexOf(me.id)) % stage.length];
      out.goal = { x: sp.x, y: sp.y };
      out.hold = sp;
      out.role = '回防集結';
      if (dist(me.x, me.y, sp.x, sp.y) < 10 * UNIT) out.walk = true;
      return null;
    }
    // go：第一個到的人（離炸彈最近、還在點外）先閃
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
    // 掩護：炸彈附近的守點位，看入口
    const others = this.ids.filter((id) => this.isAlive(obs, id) && id !== defuser.id);
    const k = Math.max(0, others.indexOf(me.id));
    const spots = this.postSpots(s, bx, by);
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
    // BFS 太遠的話改走 CT 出生區（多半離包點遠）
    const zone = this.intel.map.spawnZones.CT;
    const c = this.intel.nearestOpen(Math.floor((zone.x0 + zone.x1) / 2), Math.floor((zone.y0 + zone.y1) / 2));
    const z = g.center(c);
    const far = dist(z.x, z.y, bx, by) >= P.saveDist * UNIT ? z : null;
    this.saveCache = far ?? { x: me.x + (me.x - bx), y: me.y + (me.y - by) };
    return this.saveCache;
  }

  // ───────── 共通：換血、追殘血、隊友閃光、手雷 ─────────

  /**
   * 疊在目標之上的小行為：隊友閃光（看得到爆點就轉身）、換血（朝隊友陣亡方向架槍）、紀律低的人追殘血
   * @param {Observation} obs @param {TacOut} out
   */
  overlay(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    // 閃光（自己丟的或隊友喊的）：看得到爆點就躲到最近看不到的格（7 步內），沒有就轉身
    const own = this.util.away !== null && t >= this.util.away.from ? this.util.away : null;
    this.mateFlash = this.mateFlash.filter((x) => t <= x.pop + 2);
    const mf = this.mateFlash.find((x) => dist(me.x, me.y, x.x, x.y) < this.util.flashRadius + UNIT && this.g.los(me.x, me.y, x.x, x.y));
    const f = own !== null ? own : mf !== undefined ? { x: mf.x, y: mf.y, until: mf.pop + 2 } : null;
    if (f !== null && t <= f.until && !out.objective) {
      const R = this.util.flashRadius + UNIT;
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
        return;
      }
    }
    // 隊友的閃光還沒爆、自己看不到爆點：先別往前走（免得走進閃光）
    if (!out.objective && this.mateFlash.some((x) => t < x.pop && dist(me.x, me.y, x.x, x.y) < this.util.flashRadius + 4 * UNIT)) {
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
    // 不追殘血：紀律低的人，剛丟失的目標估計血量很低而且不遠，就追過去
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
   * 手雷：記得兩個以上的敵人聚在一起（P.nadeCluster 格內、最近 1 秒看到）就丟過去
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

  // ───────── 地圖算出的位置（快取） ─────────

  /**
   * 待命格：包點入口外 P.stageBack 格（距離場差）、在路線上、包點守點位看不到的格；附近每人一格（彼此隔 P.stageGap 格）
   * team = T 用 T 路線（佈置）；CT 用 CT 路線（輪轉、回防集結）
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
    // 每人一格：從待命格 BFS 4 步內、不比入口近、彼此隔開
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
    this.spotCache.set(key, out);
    return out;
  }

  /** @param {'T' | 'CT'} team */
  spawnCenter(team) {
    const z = this.intel.map.spawnZones[team];
    return this.g.center(this.intel.nearestOpen(Math.floor((z.x0 + z.x1) / 2), Math.floor((z.y0 + z.y1) / 2)));
  }

  /**
   * 中路位：T 路線經過的交界（不是包點入口、離兩個包點都 ≥ 15 格、CT 比 T 早 5 格以上到、不在 CT 出生區）中，
   * 經過的 T 路線最多、到兩點距離接近、CT 領先多的那個；守位在它的 CT 側 8～20 格、看得到它、暴露少（最多 2 個）
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
      const pc = g.cellOf(pick.x, pick.y);
      const ctAt = intel.distSpawn.CT[pc];
      /** @type {Spot[]} */
      const ranked = [];
      const R = 20;
      const cx0 = Math.floor(pick.x / UNIT);
      const cy0 = Math.floor(pick.y / UNIT);
      for (let y = cy0 - R; y <= cy0 + R; y++) {
        for (let x = cx0 - R; x <= cx0 + R; x++) {
          if (g.isBlock(x, y)) continue;
          const i = y * g.W + x;
          if (intel.distSpawn.CT[i] >= ctAt) continue;
          const c = g.center(i);
          const d = dist(c.x, c.y, pick.x, pick.y) / UNIT;
          if (d < P.holdMin || d > P.holdMax || !g.los(c.x, c.y, pick.x, pick.y)) continue;
          const sc = 100 - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 8 : 0) + ((intel.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13);
          ranked.push({ x: c.x, y: c.y, cell: i, fx: pick.x, fy: pick.y, score: sc, entrance: -1 });
        }
      }
      ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
      for (const s of ranked) {
        if (out.length >= 2) break;
        if (out.every((o) => dist(o.x, o.y, s.x, s.y) >= 5 * UNIT)) out.push(s);
      }
    }
    this.spotCache.set('mid', out);
    return out;
  }

  /**
   * 狙擊位（長對線）：包點 10 格內、看得到某個入口而且距離 16～28 格、看得到的其他入口少、暴露少；兩個點取分數高的
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
    /** 除錯用：最近一次決策的說明 */
    this.why = '';
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: 'shooter-baseline',
      version: '2.0',
      style: '基準',
      knobs: [
        { key: 'aggression', name: '侵略偏移', description: '加在屬性「侵略」上的偏移（−50～50）：影響探頭方式、撤退門檻、架槍時間', min: -50, max: 50, default: 0, integer: true },
        { key: 'economy', name: '經濟風格', description: '0 標準、1 保守（不半買）、2 積極（差一點也全買、半買門檻低）', min: 0, max: 2, default: 0, integer: true },
        { key: 'awpSlot', name: '狙擊手', description: '隊內序號幾號在錢夠時買狙擊槍（5 = 沒有狙擊手）', min: 0, max: 5, default: 4, integer: true },
        { key: 'ctSplitA', name: 'CT 守 A 人數', description: 'CT 開局守 A 點的人數（B 固定 2 人，其餘守中路）', min: 0, max: 5, default: P.ctSplitA, integer: true },
        { key: 'plan', name: 'T 計畫', description: '0 自動（依經濟與侵略抽）；1 default、2 rush、3 split、4 fake（指揮才有作用）', min: 0, max: 4, default: 0, integer: true },
        { key: 'role', name: '角色覆寫', description: '0 自動；4 狙擊（錢夠就買狙擊槍）', min: 0, max: 5, default: 0, integer: true },
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
    this.tactics = new Tactics(this.g, this.intel, this.perc, data, helpers, { awpSlot, economy: k.economy ?? 0, ctSplitA: k.ctSplitA ?? P.ctSplitA, plan: k.plan ?? 0 }, attrs);
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
      } else if (fight.holdNav || (tac.stop && !fight.engaged)) out.push({ type: 'stop' });
      else {
        out.push(...nav.cmds);
        moving = nav.moving;
      }
    }
    // ── 瞄準 ──
    const next = this.nav.wps[this.nav.wpIdx + 1] ?? this.nav.wps[this.nav.wpIdx] ?? null;
    const aim = (tac.urgent && !fight.engaged ? tac.look : null) ?? fight.aim ?? tac.look ?? this.combat.look(obs, { hold: tac.hold, holding: holding && !moving, navLook: nav.look, ahead: next });
    if (aim !== null && (Math.abs(aim.x - me.x) > 50 || Math.abs(aim.y - me.y) > 50)) out.push({ type: 'aim', x: Math.round(aim.x), y: Math.round(aim.y) });
    // ── 開火與武器 ──
    out.push({ type: 'fire', on: (fight.fire || (tac.noise && !fight.engaged)) && !tac.objective });
    out.push(...fight.cmds);
    if (!fight.engaged) out.push(...this.combat.upkeep(obs, holding && !moving));
    // ── 姿勢：移動時不蹲 ──
    const crouch = moving ? false : ev !== null ? ev.crouch : (fight.crouch ?? false);
    if (crouch !== me.crouching) out.push({ type: 'crouch', on: crouch });
    const walk = (tac.walk ?? nav.walk) && !fight.engaged && ev === null;
    if (walk !== me.walking) out.push({ type: 'walk', on: walk });
    out.push(...late);
    this.why = `${tac.role}｜${ev !== null ? ev.why : fight.why || (nav.peeking ? `探頭 ${this.nav.peek?.phase ?? ''}` : nav.moving ? '移動' : '待命')}`;
    return out;
  }
}
