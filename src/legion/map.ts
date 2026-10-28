// 軍團戰地圖：以幾何形狀（橢圓、折線、河道）在格子上繪製地形；上半部繪製後，下半部以 180° 旋轉複製，保證雙方對稱。
// 每一格另有高度階（0～5）：高度效果全部依高低差計算（規格書 v0.2 第七節）。殲滅戰用「河谷」，佔點用「大河谷」。
import { hashInts } from '../shared/hash.ts';
import { idiv, isqrt } from '../shared/intmath.ts';
import { SIEGE, T, TILE, WALL_LAYER, WALL_LEVELS, walkable, walkableTop, RULES } from './config.ts';
import { isin } from './geom.ts';

export interface DeployZone {
  /** 格座標，含 x0、y0，不含 x1、y1 */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface FlagPoint {
  readonly name: string;
  /** 單位座標 */
  readonly x: number;
  readonly y: number;
}

/** 補給站：歸 flag 那面旗的佔領者使用 */
export interface SupplyPoint {
  readonly x: number;
  readonly y: number;
  readonly flag: number;
}

/** 城門（格座標的矩形，含 x0／y0、不含 x1／y1；範圍內每一格都必須是門樓） */
export interface MapGate {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** main 正門、side 側門（血量較薄） */
  readonly kind: 'main' | 'side';
}

export interface CaptureFlag extends FlagPoint {
  /** 佔領後每秒得幾分 */
  readonly points: number;
}

export interface LegionMap {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  /** 高度階（0～5） */
  readonly heights: Uint8Array;
  /** 依 playerId */
  readonly deploy: readonly DeployZone[];
  /** 依 playerId：布陣區內真正能布陣的格（1 = 可以）；null 或沒有 = 整個矩形都可以（攻城圖的城內不是矩形） */
  readonly deployMask?: readonly (Uint8Array | null)[];
  /** 潰散時撤離的地圖邊緣（單位 x 座標）：依 playerId */
  readonly rearX: readonly number[];
  readonly flags: readonly CaptureFlag[];
  /** 依 playerId：出生點（佔點模式的後備從這裡入場），單位座標 */
  readonly spawns: readonly { readonly x: number; readonly y: number }[];
  /** 補給站（佔點模式） */
  readonly supplies: readonly SupplyPoint[];
  /** 地標（解說用的地名），單位座標 */
  readonly landmarks: readonly FlagPoint[];
  /** 城門（沒有城的地圖是空陣列） */
  readonly gates: readonly MapGate[];
  /** 守方座位（城內布陣區的 playerId）：城門歸它開關；-1 = 沒有城。攻守互換靠交換座位，不改地圖 */
  readonly defender: number;
  /** 衝車的起點與朝向（單位座標；在攻方布陣區）；沒有就沒有衝車 */
  readonly ram?: { readonly x: number; readonly y: number; readonly facing: number };
  /** 砲擊來向（度）：從落點指向攻方地圖邊緣的方向（攻方在西邊就是 180）；沒有就沒有砲擊支援 */
  readonly bombardFrom?: number;
  /** 攻城戰攻方後備（開關打開時）在 A 旗佔下後的入場點：A 外側 */
  readonly siegeEntry?: { readonly x: number; readonly y: number };
  /** 城牆缺口（格座標矩形，可走的斷牆格，沒有門）：只用來產生公開的 features.chokes */
  readonly breaches?: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  /** 門洞（沒有城門的拱門，例如甕城入口、子城門洞）：只用來產生公開的 features.chokes */
  readonly archways?: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  /** 地面層：不可通行格 → 最近的可通行格（可通行格對應自己） */
  readonly snap: Int32Array;
  /** 牆頂層（城牆、門樓、樓梯）：非牆頂格 → 最近的牆頂格；沒有牆的地圖全是 -1 */
  readonly snapTop: Int32Array;
  /** 1 = 緊鄰不可通行格（尋路加成本，讓隊形走在橋與淺灘的中間） */
  readonly edge: Uint8Array;
  /**
   * 地形與高度旋轉 180° 對稱：紅方的尋路與吸附在旋轉後的座標系計算再轉回來，讓雙方得到互為鏡像的結果。
   * 不對稱的地圖（城池圖、測試圖）不能這樣算，雙方都用原座標系。
   */
  readonly symmetric: boolean;
}

/** 地圖的幾何與地標（snap、edge、snapTop、symmetric 由 finishMap 補上） */
export type LegionMapSpec = Omit<LegionMap, 'snap' | 'snapTop' | 'edge' | 'symmetric'>;

/** 補上尋路與吸附用的衍生陣列與對稱旗標 */
export function finishMap(spec: LegionMapSpec): LegionMap {
  const { terrain, heights, width: w, height: h } = spec;
  for (const g of spec.gates) {
    for (let y = g.y0; y < g.y1; y++) for (let x = g.x0; x < g.x1; x++) if (terrain[y * w + x] !== T.Gatehouse) throw new Error(`${spec.id}：城門 (${x}, ${y}) 不在門樓格上`);
  }
  return { ...spec, snap: buildSnap(terrain, w, h), snapTop: buildSnapTop(terrain, w, h), edge: buildEdge(terrain, w, h), symmetric: isSymmetric(terrain, heights) };
}

function isSymmetric(terrain: Uint8Array, heights: Uint8Array): boolean {
  const n = terrain.length;
  for (let i = 0; i < n; i++) if (terrain[i] !== terrain[n - 1 - i] || heights[i] !== heights[n - 1 - i]) return false;
  return true;
}

type Painter = (x: number, y: number) => boolean;

/** 橢圓（格中心），邊緣以雜湊加一點不規則 */
function ellipse(cx: number, cy: number, rx: number, ry: number, salt: number): Painter {
  return (x, y) => {
    const lhs = (x - cx) * (x - cx) * ry * ry + (y - cy) * (y - cy) * rx * rx;
    const j = (hashInts([x, y, salt]) >>> 0) % 31;
    return lhs * 100 <= rx * rx * ry * ry * (85 + j);
  };
}

/** 折線（格座標的頂點），寬度為半寬（半格單位）的平方上限 */
function polyline(pts: readonly (readonly [number, number])[], halfWidth2: number): Painter {
  return (x, y) => {
    // 半格單位：格中心 = 2x + 1
    const px = 2 * x + 1;
    const py = 2 * y + 1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = 2 * pts[i][0] + 1;
      const ay = 2 * pts[i][1] + 1;
      const bx = 2 * pts[i + 1][0] + 1;
      const by = 2 * pts[i + 1][1] + 1;
      const vx = bx - ax;
      const vy = by - ay;
      const wx = px - ax;
      const wy = py - ay;
      const len2 = vx * vx + vy * vy;
      const dot = wx * vx + wy * vy;
      let d2: number;
      if (dot <= 0) d2 = wx * wx + wy * wy;
      else if (dot >= len2) d2 = (px - bx) * (px - bx) + (py - by) * (py - by);
      else {
        const cross = wx * vy - wy * vx;
        if (cross * cross <= halfWidth2 * len2) return true;
        continue;
      }
      if (d2 <= halfWidth2) return true;
    }
    return false;
  };
}

function paint(terrain: Uint8Array, w: number, h: number, t: number, p: Painter, only?: (cur: number) => boolean): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (only !== undefined && !only(terrain[i])) continue;
      if (p(x, y)) terrain[i] = t;
    }
  }
}

/** 上半部（列優先索引的前一半）旋轉 180° 複製到下半部 */
function rotateHalf(terrain: Uint8Array): void {
  const n = terrain.length;
  for (let i = idiv(n, 2); i < n; i++) terrain[i] = terrain[n - 1 - i];
}

function buildEdge(terrain: Uint8Array, w: number, h: number): Uint8Array {
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!walkable(terrain[y * w + x])) continue;
      for (let dy = -1; dy <= 1 && edge[y * w + x] === 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!walkable(terrain[ny * w + nx])) {
            edge[y * w + x] = 1;
            break;
          }
        }
      }
    }
  }
  return edge;
}

function buildSnap(terrain: Uint8Array, w: number, h: number): Int32Array {
  return nearestOf(terrain, w, h, walkable);
}

function buildSnapTop(terrain: Uint8Array, w: number, h: number): Int32Array {
  return nearestOf(terrain, w, h, walkableTop);
}

/** 每一格 → 最近的符合 ok 的格（符合的對應自己；一格都沒有則全是 -1） */
function nearestOf(terrain: Uint8Array, w: number, h: number, ok: (t: number) => boolean): Int32Array {
  const snap = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < w * h; i++) {
    if (ok(terrain[i])) {
      snap[i] = i;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || snap[j] >= 0) continue;
      snap[j] = snap[i];
      queue[tail++] = j;
    }
  }
  return snap;
}

/** 原型地圖「河谷」：160 × 100 格 */
export function riverValley(): LegionMap {
  const w = 160;
  const h = 100;
  const terrain = new Uint8Array(w * h);
  // 樹林：北橋兩岸、中央淺灘的側翼、後方
  paint(terrain, w, h, T.Forest, ellipse(64, 12, 8, 6, 1));
  paint(terrain, w, h, T.Forest, ellipse(101, 13, 7, 5, 2));
  paint(terrain, w, h, T.Forest, ellipse(34, 38, 5, 4, 3));
  paint(terrain, w, h, T.Forest, ellipse(60, 42, 5, 3, 4));
  // 高地：俯瞰中央淺灘
  paint(terrain, w, h, T.Hill, ellipse(95, 40, 7, 5, 5), (c) => c === T.Plain);
  // 道路：布陣區前方通往北橋（下半部旋轉後成為通往南橋的道路）
  paint(terrain, w, h, T.Road, polyline([[0, 40], [30, 32], [60, 23], [86, 21]], 5), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[84, 21], [110, 23], [132, 31], [159, 36]], 5), (c) => c !== T.Hill);
  // 河流：S 形，寬 6 格
  for (let y = 0; y < idiv(h, 2); y++) {
    const xc2 = 159 + idiv(12 * isin(idiv(y * 180, 50)), 10000);
    for (let x = 0; x < w; x++) {
      if (Math.abs(2 * x + 1 - xc2) <= 6) terrain[y * w + x] = T.River;
    }
  }
  // 北橋（3 格寬）與中央淺灘
  for (let y = 20; y <= 22; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Bridge;
  for (let y = 44; y < 50; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Shallow;
  // 高度：河道 0、河谷 1、兩岸高處 2、高地 3、高地頂 4
  const heights = new Uint8Array(w * h);
  const top = ellipse(95, 40, 4, 3, 6);
  for (let y = 0; y < idiv(h, 2); y++) {
    const xc2 = 159 + idiv(12 * isin(idiv(y * 180, 50)), 10000);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t === T.River || t === T.Shallow) heights[i] = 0;
      else if (t === T.Bridge) heights[i] = 1;
      else if (t === T.Hill) heights[i] = top(x, y) ? 4 : 3;
      else {
        const d2 = Math.abs(2 * x + 1 - xc2);
        heights[i] = d2 <= 2 * (22 + ((hashInts([x, y, 7]) >>> 0) % 3)) ? 1 : 2;
      }
    }
  }
  rotateHalf(terrain);
  rotateHalf(heights);
  const depth = RULES.deployDepthTiles;
  return {
    id: 'river-valley',
    name: '河谷',
    description: '中央一條 S 形河流，南北各一座窄橋、中央一處淺灘；兩岸都有樹林可以埋伏，淺灘兩側各有一座高地。',
    width: w,
    height: h,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: depth, y1: h },
      { x0: w - depth, y0: 0, x1: w, y1: h },
    ],
    rearX: [0, w * TILE],
    spawns: [
      { x: 10000, y: (h * TILE) / 2 },
      { x: w * TILE - 10000, y: (h * TILE) / 2 },
    ],
    supplies: [],
    gates: [],
    defender: -1,
    flags: [
      { name: '西南高地', x: 64500, y: 59500, points: 1 },
      { name: '中央淺灘', x: 80000, y: 50000, points: 2 },
      { name: '東北高地', x: 95500, y: 40500, points: 1 },
    ],
    landmarks: [
      { name: '中央淺灘', x: 80000, y: 50000 },
      { name: '北橋', x: 85300, y: 21500 },
      { name: '南橋', x: 74700, y: 78500 },
      { name: '西南高地', x: 64500, y: 59500 },
      { name: '東北高地', x: 95500, y: 40500 },
      { name: '北橋西側的樹林', x: 64500, y: 12500 },
      { name: '北橋東側的樹林', x: 101500, y: 13500 },
      { name: '南橋東側的樹林', x: 95500, y: 87500 },
      { name: '南橋西側的樹林', x: 58500, y: 86500 },
      { name: '淺灘西北的樹林', x: 60500, y: 42500 },
      { name: '淺灘東南的樹林', x: 99500, y: 57500 },
      { name: '西側樹林', x: 34500, y: 38500 },
      { name: '東側樹林', x: 125500, y: 61500 },
      { name: '藍方陣地', x: 10000, y: 50000 },
      { name: '紅方陣地', x: 150000, y: 50000 },
    ],
    snap: buildSnap(terrain, w, h),
    snapTop: buildSnapTop(terrain, w, h),
    edge: buildEdge(terrain, w, h),
    symmetric: true,
  };
}

/** 佔點地圖「大河谷」：240 × 150 格。三個渡口（北橋、中央淺灘、南橋）相隔約 48 格，各有一面旗 */
export function grandValley(): LegionMap {
  const w = 240;
  const h = 150;
  const half = idiv(h, 2);
  const terrain = new Uint8Array(w * h);
  /** 河道中心（半格單位）：S 形，振幅 8 格 */
  const riverX2 = (y: number): number => 239 + idiv(16 * isin(idiv(y * 180, half)), 10000);
  // 樹林：北橋兩岸、淺灘側翼、雙方後方
  paint(terrain, w, h, T.Forest, ellipse(104, 15, 8, 6, 11));
  paint(terrain, w, h, T.Forest, ellipse(151, 17, 9, 6, 12));
  paint(terrain, w, h, T.Forest, ellipse(96, 60, 6, 4, 13));
  paint(terrain, w, h, T.Forest, ellipse(148, 47, 6, 4, 14));
  paint(terrain, w, h, T.Forest, ellipse(46, 28, 7, 5, 15));
  paint(terrain, w, h, T.Forest, ellipse(62, 62, 5, 4, 16));
  paint(terrain, w, h, T.Forest, ellipse(192, 40, 6, 5, 17));
  // 高地：東岸俯瞰淺灘、西岸俯瞰北橋、後方一座
  paint(terrain, w, h, T.Hill, ellipse(143, 64, 8, 5, 18), (c) => c === T.Plain);
  paint(terrain, w, h, T.Hill, ellipse(101, 36, 7, 5, 19), (c) => c === T.Plain);
  paint(terrain, w, h, T.Hill, ellipse(40, 54, 6, 4, 20), (c) => c === T.Plain);
  // 道路：布陣區通往北橋（旋轉後成為通往南橋的道路），以及通往淺灘的小路
  paint(terrain, w, h, T.Road, polyline([[0, 46], [40, 38], [82, 30], [127, 27]], 5), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[125, 27], [166, 30], [206, 40], [239, 47]], 5), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[20, 73], [60, 71], [112, 73]], 3), (c) => c !== T.Hill);
  // 村莊：北橋東岸（旋轉後在南橋西岸）
  for (const [bx, by] of [[157, 31], [158, 31], [161, 33], [161, 34], [155, 35], [156, 35]] as const) terrain[by * w + bx] = T.Building;
  // 河流：寬 6 格
  for (let y = 0; y < half; y++) {
    const xc2 = riverX2(y);
    for (let x = 0; x < w; x++) if (Math.abs(2 * x + 1 - xc2) <= 6) terrain[y * w + x] = T.River;
  }
  // 北橋（3 格寬）與中央淺灘（旋轉後共 12 格寬）
  for (let y = 26; y <= 28; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Bridge;
  for (let y = half - 6; y < half; y++) for (let x = 0; x < w; x++) if (terrain[y * w + x] === T.River) terrain[y * w + x] = T.Shallow;
  // 高度：河道 0、河谷 1、兩岸高處 2、高地 3、高地頂 4
  const heights = new Uint8Array(w * h);
  const tops = [ellipse(143, 64, 4, 3, 21), ellipse(101, 36, 3, 2, 22), ellipse(40, 54, 3, 2, 23)];
  for (let y = 0; y < half; y++) {
    const xc2 = riverX2(y);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t === T.River || t === T.Shallow) heights[i] = 0;
      else if (t === T.Bridge) heights[i] = 1;
      else if (t === T.Hill) heights[i] = tops.some((p) => p(x, y)) ? 4 : 3;
      else heights[i] = Math.abs(2 * x + 1 - xc2) <= 2 * (30 + ((hashInts([x, y, 7]) >>> 0) % 3)) ? 1 : 2;
    }
  }
  rotateHalf(terrain);
  rotateHalf(heights);
  const depth = RULES.deployDepthTiles;
  const W = w * TILE;
  const H = h * TILE;
  const north = { x: riverX2(27) * 500, y: 27500 };
  const rot = (p: { x: number; y: number }, name: string): FlagPoint => ({ name, x: W - p.x, y: H - p.y });
  return {
    id: 'grand-valley',
    name: '大河谷',
    description: '縱貫中央的 S 形大河，北橋、中央淺灘、南橋三個渡口相隔約 48 格，各插一面旗；兩岸有樹林、高地與村莊，雙方必須分兵。',
    width: w,
    height: h,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: depth, y1: h },
      { x0: w - depth, y0: 0, x1: w, y1: h },
    ],
    rearX: [0, W],
    spawns: [
      { x: 10000, y: H / 2 },
      { x: W - 10000, y: H / 2 },
    ],
    // 補給站：各座橋的旗往東（北橋）、往西（南橋）9 格的岸上，歸佔著那座橋的一方
    supplies: [
      { x: north.x + 9000, y: north.y, flag: 0 },
      { x: W - north.x - 9000, y: H - north.y, flag: 2 },
    ],
    gates: [],
    defender: -1,
    flags: [
      { name: '北橋', x: north.x, y: north.y, points: 1 },
      { name: '中央淺灘', x: W / 2, y: H / 2, points: 2 },
      { ...rot(north, '南橋'), points: 1 },
    ],
    landmarks: [
      { name: '北橋', x: north.x, y: north.y },
      { name: '中央淺灘', x: W / 2, y: H / 2 },
      rot(north, '南橋'),
      { name: '淺灘東岸的高地', x: 143500, y: 64500 },
      rot({ x: 143500, y: 64500 }, '淺灘西岸的高地'),
      { name: '北橋西岸的高地', x: 101500, y: 36500 },
      rot({ x: 101500, y: 36500 }, '南橋東岸的高地'),
      { name: '北橋東岸的村莊', x: 158000, y: 33000 },
      rot({ x: 158000, y: 33000 }, '南橋西岸的村莊'),
      { name: '北橋西側的樹林', x: 104500, y: 15500 },
      rot({ x: 104500, y: 15500 }, '南橋東側的樹林'),
      { name: '北橋東側的樹林', x: 151500, y: 17500 },
      rot({ x: 151500, y: 17500 }, '南橋西側的樹林'),
      { name: '淺灘西北的樹林', x: 96500, y: 60500 },
      rot({ x: 96500, y: 60500 }, '淺灘東南的樹林'),
      { name: '淺灘東北的樹林', x: 148500, y: 47500 },
      rot({ x: 148500, y: 47500 }, '淺灘西南的樹林'),
      { name: '藍方陣地', x: 10000, y: H / 2 },
      { name: '紅方陣地', x: W - 10000, y: H / 2 },
    ],
    snap: buildSnap(terrain, w, h),
    snapTop: buildSnapTop(terrain, w, h),
    edge: buildEdge(terrain, w, h),
    symmetric: true,
  };
}

/** 邊緣平滑的橢圓（不加雜湊抖動；山腳、緩坡用，看起來才像一圈圈的等高線） */
function oval(cx: number, cy: number, rx: number, ry: number): Painter {
  return (x, y) => (x - cx) * (x - cx) * ry * ry + (y - cy) * (y - cy) * rx * rx <= rx * rx * ry * ry;
}

/** 從 (sx, sy) 四方向淹過 pass 為真的格，回傳遮罩 */
function floodMask(w: number, h: number, sx: number, sy: number, pass: (i: number) => boolean): Uint8Array {
  const mask = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  mask[sy * w + sx] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || mask[j] === 1 || !pass(j)) continue;
      mask[j] = 1;
      stack.push(j);
    }
  }
  return mask;
}

/**
 * 攻城地圖「石關城」：224 × 140 格，中國城池的「三重城」：郭城（外城）→ 內城 → 衙署子城，城內逐級升高（台地），越往裡越是仰攻。
 * 攻方（藍方，座位 0）在西端紮營；城池在東側、背靠大河。
 * 城外：攻方營地往東分出三條路，中間用兩道長嶺（坡地與樹林）隔開——
 *   中路：大道 → 西橋 → 甕城 → 正門（衝車路線，路旁有土丘可以擋箭）；
 *   北路：沿北嶺北側穿過樹林 → 北橋 → 北牆側門（遠，但有樹林遮蔽）；
 *   南路：碎石坡與廢村 → 南淺灘 → 南牆的瓦礫缺口（近，但地形慢，騎兵過不了缺口）。
 * 第一道防線（郭城，高 2）：四格厚的城牆、角樓、馬面、甕城（入口開在西面北段）；護城河繞西北南三面，和城牆之間留護城堤（架雲梯）。
 *   郭城西半是巷戰區：正門內與內城門洞前各一座廣場，大街（6 格）、巷（4 格）、弄（3 格）直角錯開、穿過密集的民房，另有市集與寺廟；
 *   內城北、南兩側是窄長的夾道（營房、糧倉），北側門與南牆缺口各通往其中一側。
 * 第二道防線（內城，高 3）：三格厚的內城牆，西、北、南三個門洞（沒有門扇），西門洞兩側有馬面；城內是整齊的坊與官署。
 * 第三道防線（子城，院落高 4）：內城最深處兩格厚城牆圍成的衙署，西面一個門洞。
 * 旗：A ＝ 正門（旗圈涵蓋甕城東半與正門內側）、B ＝ 衙署院落。
 */
export function stonePass(): LegionMap {
  const w = 224;
  const h = 140;
  const terrain = new Uint8Array(w * h);
  const heights = new Uint8Array(w * h).fill(1);
  const idx = (x: number, y: number): number => y * w + x;
  const inMap = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  const box = (x0: number, y0: number, x1: number, y1: number, t: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inMap(x, y)) terrain[idx(x, y)] = t;
  };
  const tAt = (x: number, y: number): number => (inMap(x, y) ? terrain[idx(x, y)] : -1);
  const CY = 69;
  // ── 東邊的大河（城池背水） ──
  for (let y = 0; y < h; y++) {
    const bank = y >= 20 && y <= 119 ? 213 : 213 + idiv(2 * isin(idiv(y * 360, 40)) + 10000, 10000) - 1;
    for (let x = bank; x < w; x++) terrain[idx(x, y)] = T.River;
  }
  // ── 城外：兩道長嶺把攻方的路分成三條 ──
  const plainOnly = (c: number): boolean => c === T.Plain;
  // 北嶺、南嶺（坡地，嶺上有樹）
  const ridges = [polyline([[24, 52], [40, 46], [62, 42], [84, 40]], 36), polyline([[24, 76], [40, 84], [62, 88], [84, 92]], 36)];
  for (const r of ridges) paint(terrain, w, h, T.Hill, r, plainOnly);
  paint(terrain, w, h, T.Forest, ellipse(42, 46, 7, 3, 61));
  paint(terrain, w, h, T.Forest, ellipse(70, 41, 6, 3, 62));
  paint(terrain, w, h, T.Forest, ellipse(52, 86, 5, 2, 63));
  // 中路：大道直通西橋；路旁的土丘（擋箭、架弓）與小樹叢
  paint(terrain, w, h, T.Road, polyline([[0, 63], [28, 63], [52, 61], [72, 63], [88, 62]], 9));
  paint(terrain, w, h, T.Hill, ellipse(50, 56, 4, 2, 66), plainOnly);
  paint(terrain, w, h, T.Hill, ellipse(64, 69, 4, 2, 67), plainOnly);
  paint(terrain, w, h, T.Hill, ellipse(80, 56, 3, 2, 68), plainOnly);
  paint(terrain, w, h, T.Forest, ellipse(36, 70, 3, 2, 69), plainOnly);
  // 北路：繞過北嶺、穿過樹林到北橋
  paint(terrain, w, h, T.Road, polyline([[16, 58], [26, 46], [44, 34], [66, 22], [96, 16], [140, 15], [166, 15], [166, 22]], 4));
  paint(terrain, w, h, T.Forest, ellipse(56, 27, 8, 5, 70), (c) => c === T.Plain || c === T.Road);
  paint(terrain, w, h, T.Forest, ellipse(86, 15, 9, 4, 71), (c) => c === T.Plain || c === T.Road);
  paint(terrain, w, h, T.Forest, ellipse(122, 10, 10, 4, 72), (c) => c === T.Plain || c === T.Road);
  // 南路：碎石坡與廢村到南淺灘
  paint(terrain, w, h, T.Road, polyline([[16, 68], [26, 80], [44, 94], [66, 106], [96, 116], [118, 121], [132, 121], [132, 117]], 4));
  paint(terrain, w, h, T.Rubble, ellipse(58, 101, 5, 3, 64), plainOnly);
  paint(terrain, w, h, T.Rubble, ellipse(84, 113, 6, 3, 65), plainOnly);
  for (const [bx, by, bw, bh] of [[66, 98, 3, 2], [71, 100, 2, 3], [62, 110, 3, 2], [74, 108, 2, 2], [104, 124, 3, 2]] as const) box(bx, by, bx + bw - 1, by + bh - 1, T.Building);
  // 攻方營地：西端南北兩群營帳（中間留給布陣），衝車出發處北側是攻城器械工坊
  for (const [bx, by] of [[2, 34], [6, 34], [2, 38], [6, 38], [2, 42], [6, 42], [2, 88], [6, 88], [2, 92], [6, 92], [2, 96], [6, 96]] as const) box(bx, by, bx + 2, by + 1, T.Building);
  box(9, 56, 14, 58, T.Building);
  const rises = [oval(112, 10, 18, 4), oval(160, 128, 20, 5)];
  // ── 郭城城牆（四格厚） ──
  const WX0 = 110;
  const WX1 = 210;
  const WY0 = 32;
  const WY1 = 107;
  box(WX0, WY0, WX0 + 3, WY1, T.Wall);
  box(WX1 - 3, WY0, WX1, WY1, T.Wall);
  box(WX0, WY0, WX1, WY0 + 3, T.Wall);
  box(WX0, WY1 - 3, WX1, WY1, T.Wall);
  // 角樓（8 × 8，往外凸兩格）
  for (const [cx, cy] of [[WX0 - 2, WY0 - 2], [WX1 - 5, WY0 - 2], [WX0 - 2, WY1 - 5], [WX1 - 5, WY1 - 5]] as const) box(cx, cy, cx + 7, cy + 7, T.Wall);
  // 馬面（往外凸三格）：北牆、南牆各兩座（南牆西邊那座緊貼缺口），北側門兩側各一座；西牆甕城以外兩座
  for (const x of [124, 186]) {
    box(x, WY0 - 3, x + 5, WY0 - 1, T.Wall);
    box(x, WY1 + 1, x + 5, WY1 + 3, T.Wall);
  }
  box(161, WY0 - 3, 164, WY0 - 1, T.Wall);
  box(169, WY0 - 3, 172, WY0 - 1, T.Wall);
  for (const y of [42, 92]) box(WX0 - 3, y, WX0 - 1, y + 5, T.Wall);
  // ── 甕城（正門外，三格厚的牆；入口在西面北段） ──
  box(96, 58, 98, 80, T.Wall);
  box(96, 58, WX0 - 1, 60, T.Wall);
  box(96, 78, WX0 - 1, 80, T.Wall);
  const archBarbican = { x0: 96, y0: 61, x1: 99, y1: 65 };
  box(archBarbican.x0, archBarbican.y0, archBarbican.x1 - 1, archBarbican.y1 - 1, T.Paved);
  // ── 城門與缺口 ──
  box(WX0, CY - 1, WX0 + 3, CY + 1, T.Gatehouse);
  box(166, WY0, 167, WY0 + 3, T.Gatehouse);
  const breach = { x0: 130, y0: WY1 - 3, x1: 135, y1: WY1 + 1 };
  box(breach.x0, breach.y0, breach.x1 - 1, breach.y1 - 1, T.Rubble);
  // ── 護城河：三格寬，繞西、北、南三面（東面接大河）；甕城外的一段往外繞 ──
  // 過河處：西橋（甕城入口前）、北橋（側門前）、南牆缺口前一段淤塞成淺灘
  const MX = 99;
  const MY0 = 23;
  const MY1 = 114;
  const moat = (x0: number, y0: number, x1: number, y1: number): void => box(x0, y0, x1, y1, T.River);
  moat(MX, MY0, 212, MY0 + 2);
  moat(MX, MY1, 212, MY1 + 2);
  moat(MX, MY0, MX + 2, 52);
  moat(MX, 86, MX + 2, MY1 + 2);
  moat(89, 52, MX + 2, 54);
  moat(89, 84, MX + 2, 86);
  moat(89, 52, 91, 86);
  box(89, archBarbican.y0, 91, archBarbican.y1 - 1, T.Bridge);
  box(166, MY0, 167, MY0 + 2, T.Bridge);
  box(breach.x0, MY1, breach.x1 - 1, MY1 + 2, T.Shallow);
  // ── 城內與甕城內的範圍（淹過去鋪石） ──
  const solid = (i: number): boolean => {
    const t = terrain[i];
    return t === T.Wall || t === T.Gatehouse || t === T.River || t === T.Rubble || t === T.Bridge;
  };
  const inside = floodMask(w, h, 150, CY, (i) => !solid(i));
  const archAt = (x: number, y: number, a: { x0: number; y0: number; x1: number; y1: number }): boolean => x >= a.x0 && x < a.x1 && y >= a.y0 && y < a.y1;
  const barbican = floodMask(w, h, 104, CY, (i) => !solid(i) && !archAt(i % w, (i - (i % w)) / w, archBarbican));
  for (let i = 0; i < w * h; i++) if (inside[i] === 1 || barbican[i] === 1) terrain[i] = T.Paved;
  // ── 第二道防線：內城牆（三格厚、內角樓 5 × 5、西門洞兩側馬面；東面接郭城東牆） ──
  const IW = 152;
  const IN = 46;
  const IS = 93;
  box(IW, IN, IW + 2, IS, T.Wall);
  box(IW, IN, WX1 - 4, IN + 2, T.Wall);
  box(IW, IS - 2, WX1 - 4, IS, T.Wall);
  box(IW - 1, IN - 1, IW + 3, IN + 3, T.Wall);
  box(IW - 1, IS - 3, IW + 3, IS + 1, T.Wall);
  box(IW - 2, 60, IW - 1, 63, T.Wall);
  box(IW - 2, 75, IW - 1, 78, T.Wall);
  const archInW = { x0: IW, y0: CY - 2, x1: IW + 3, y1: CY + 3 };
  const archInN = { x0: 178, y0: IN, x1: 183, y1: IN + 3 };
  const archInS = { x0: 184, y0: IS - 2, x1: 189, y1: IS + 1 };
  for (const a of [archInW, archInN, archInS]) box(a.x0, a.y0, a.x1 - 1, a.y1 - 1, T.Paved);
  // ── 第三道防線：衙署子城（兩格厚城牆、四角小樓、西面五格寬的門洞） ──
  const CX0 = 182;
  const CX1 = 204;
  const CY0 = 56;
  const CY1 = 83;
  box(CX0, CY0, CX0 + 1, CY1, T.Wall);
  box(CX1 - 1, CY0, CX1, CY1, T.Wall);
  box(CX0, CY0, CX1, CY0 + 1, T.Wall);
  box(CX0, CY1 - 1, CX1, CY1, T.Wall);
  for (const [cx, cy] of [[CX0 - 1, CY0 - 1], [CX1 - 2, CY0 - 1], [CX0 - 1, CY1 - 2], [CX1 - 2, CY1 - 2]] as const) box(cx, cy, cx + 3, cy + 3, T.Wall);
  const archCitadel = { x0: CX0, y0: CY - 2, x1: CX0 + 2, y1: CY + 3 };
  box(archCitadel.x0, archCitadel.y0, archCitadel.x1 - 1, archCitadel.y1 - 1, T.Paved);
  // 正堂（北）、東廂、南堂；中間是院落（B 旗）
  box(188, 59, 198, 62, T.Building);
  box(199, 65, 201, 74, T.Building);
  box(188, 77, 198, 79, T.Building);
  // ── 郭城西半：巷戰區（先全部蓋滿民房，再挖出街巷與廣場） ──
  const OX0 = WX0 + 4;
  const OX1 = IW - 1;
  const OY0 = WY0 + 4;
  const OY1 = WY1 - 4;
  for (let y = OY0; y <= OY1; y++) for (let x = OX0; x <= OX1; x++) if (tAt(x, y) === T.Paved) terrain[idx(x, y)] = T.Building;
  const carve = (p: Painter): void => {
    for (let y = OY0; y <= OY1; y++) for (let x = OX0; x <= OX1; x++) if (tAt(x, y) === T.Building && p(x, y)) terrain[idx(x, y)] = T.Paved;
  };
  // 順城街（沿城牆、內城牆三格）
  carve((x, y) => x <= OX0 + 2 || y <= OY0 + 2 || y >= OY1 - 2 || x >= OX1 - 2);
  // 街巷都是直角轉折（老城的街不是直通到底，走幾步就錯開一段），格子上不會出現鋸齒邊
  const lane = (x0: number, y0: number, x1: number, y1: number): void => carve((x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  // 正門內廣場、內城西門洞前廣場
  lane(117, 63, 126, 75);
  lane(141, 62, 148, 76);
  // 大街（六格）：出廣場往東，錯開兩次才到內城西門洞
  lane(126, 63, 135, 68);
  lane(132, 63, 137, 71);
  lane(135, 66, 141, 71);
  // 巷（四格）：北巷、東北巷各轉一次到北邊順城街；南巷轉一次通到南牆缺口；東南巷轉一次到寺廟
  lane(118, 50, 121, 63);
  lane(118, 50, 128, 53);
  lane(125, 39, 128, 53);
  lane(134, 52, 137, 63);
  lane(134, 52, 143, 55);
  lane(140, 39, 143, 55);
  lane(120, 75, 123, 84);
  lane(120, 81, 131, 84);
  lane(128, 81, 131, 100);
  lane(136, 71, 139, 88);
  lane(136, 85, 145, 88);
  lane(142, 85, 145, 100);
  // 弄（三格）：串起巷子的短街
  lane(122, 57, 134, 59);
  lane(124, 76, 136, 78);
  lane(117, 91, 128, 93);
  lane(143, 46, 149, 48);
  lane(145, 80, 149, 82);
  // 市集（北巷與東北巷之間）：一排排攤位
  lane(129, 40, 139, 48);
  for (const y of [42, 45]) for (let x = 130; x <= 138; x += 3) box(x, y, x + 1, y, T.Building);
  // 寺廟（南巷與東南巷之間）：大殿、兩側配殿，院裡種樹
  lane(132, 91, 141, 100);
  box(134, 92, 139, 94, T.Building);
  box(132, 96, 133, 99, T.Building);
  box(140, 96, 141, 99, T.Building);
  paint(terrain, w, h, T.Forest, oval(136, 98, 1, 1), (c) => c === T.Paved);
  // ── 內城北、南兩側的夾道：營房與糧倉（中間一排，兩側是街；留出側門、門洞的通路） ──
  for (const [x0, x1] of [[156, 163], [170, 176], [185, 192], [196, 204]] as const) box(x0, 39, x1, 42, T.Building);
  for (const [x0, x1] of [[157, 163], [167, 173], [177, 182], [191, 197], [200, 205]] as const) box(x0, 97, x1, 100, T.Building);
  // ── 內城：整齊的坊與官署 ──
  /** 坊：沿街一圈兩格深的房舍（每隔幾間留一條巷子、南面正中開坊門），中間是院落，大的坊院子裡再一座正房 */
  const ward = (x0: number, y0: number, x1: number, y1: number): void => {
    const midX = idiv(x0 + x1, 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ring = x < x0 + 2 || x > x1 - 2 || y < y0 + 2 || y > y1 - 2;
        if (!ring) continue;
        const onNS = y < y0 + 2 || y > y1 - 2;
        const onWE = x < x0 + 2 || x > x1 - 2;
        // 巷子：南北兩面每隔五格、東西兩面每隔五格留一格；南面正中兩格是坊門
        const alleyX = onNS && !onWE && (x - x0) % 5 === 4;
        const alleyY = onWE && !onNS && (y - y0) % 5 === 4;
        const gate = y > y1 - 2 && (x === midX || x === midX + 1);
        if (alleyX || alleyY || gate) continue;
        terrain[idx(x, y)] = T.Building;
      }
    }
    if (x1 - x0 >= 10 && y1 - y0 >= 10) box(midX - 1, y0 + 4, midX + 2, y0 + 6, T.Building);
  };
  ward(158, 52, 173, 64);
  ward(158, 74, 173, 87);
  // 子城北側的官署
  box(184, 50, 192, 53, T.Building);
  box(196, 50, 203, 53, T.Building);
  // ── 走不到的空格（被房舍圍住的小角落）改成房舍 ──
  const reach = floodMask(w, h, 121, CY, (i) => {
    const t = terrain[i];
    return t === T.Paved || t === T.Forest || t === T.Rubble || t === T.Gatehouse;
  });
  for (let i = 0; i < w * h; i++) if (inside[i] === 1 && reach[i] === 0 && (terrain[i] === T.Paved || terrain[i] === T.Forest)) terrain[i] = T.Building;
  // ── 馬道（城牆內側的坡道，上牆用） ──
  const ramp = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (tAt(x, y) === T.Paved) terrain[idx(x, y)] = T.Stair;
  };
  // 郭城：西牆、北牆、南牆、東牆內側
  for (const y of [42, 56, 82, 94]) ramp(OX0, y, OX0, y + 2);
  for (const x of [120, 140, 158, 186, 198]) ramp(x, OY0, x + 2, OY0);
  for (const x of [118, 140, 160, 178, 198]) ramp(x, OY1, x + 2, OY1);
  for (const y of [40, 52, 86, 98]) ramp(WX1 - 4, y, WX1 - 4, y + 2);
  // 內城牆：只有內側有馬道（攻方要上內城牆得架雲梯）
  for (const y of [56, 80]) ramp(IW + 3, y, IW + 3, y + 2);
  for (const x of [162, 194]) {
    ramp(x, IN + 3, x + 2, IN + 3);
    ramp(x, IS - 3, x + 2, IS - 3);
  }
  // 子城：北牆、南牆內側各一段
  ramp(185, CY0 + 2, 186, CY0 + 2);
  ramp(185, CY1 - 2, 186, CY1 - 2);
  // ── 高度：郭城 2、內城 3、子城 4（城牆跟著所在的台地）；護城河與大河 0、橋 1；城外 1、緩坡 2、長嶺與土丘 3 ──
  const innerWall = (x: number, y: number): boolean => x >= IW - 2 && x <= WX1 - 4 && y >= IN - 1 && y <= IS + 1;
  const innerArea = (x: number, y: number): boolean => x >= IW + 3 && x <= WX1 - 4 && y >= IN + 3 && y <= IS - 3;
  const citadel = (x: number, y: number): boolean => x >= CX0 - 1 && x <= CX1 && y >= CY0 - 1 && y <= CY1 + 1;
  for (let i = 0; i < w * h; i++) {
    const t = terrain[i];
    const x = i % w;
    const y = (i - x) / w;
    const castle = x >= 93 && x <= 212 && y >= 26 && y <= 113 && (inside[i] === 1 || barbican[i] === 1 || t === T.Wall || t === T.Gatehouse || t === T.Rubble);
    if (t === T.River || t === T.Shallow) heights[i] = 0;
    else if (t === T.Bridge) heights[i] = 1;
    else if (castle) {
      const wallOrArch = t === T.Wall || [archInW, archInN, archInS].some((a) => archAt(x, y, a));
      if (citadel(x, y) && (t === T.Wall || x >= CX0)) heights[i] = 4;
      else if (innerArea(x, y) || (wallOrArch && innerWall(x, y))) heights[i] = 3;
      else heights[i] = 2;
    } else if (t === T.Hill || (t !== T.Building && ridges.some((p) => p(x, y)))) heights[i] = 3;
    else if (t !== T.Building && rises.some((p) => p(x, y))) heights[i] = 2;
  }
  // ── 守方布陣區：城內、甕城、城牆（含角樓、馬面）、門樓、缺口 ──
  const defMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = (i - x) / w;
    if (x < 93 || x > 212 || y < 26 || y > 113) continue;
    const t = terrain[i];
    if (inside[i] === 1 || barbican[i] === 1 || archAt(x, y, archBarbican) || t === T.Wall || t === T.Gatehouse || t === T.Rubble) defMask[i] = 1;
  }
  const depth = RULES.deployDepthTiles;
  return finishMap({
    id: 'stone-pass',
    name: '石關城',
    description:
      '背靠大河的三重城：郭城（四格厚城牆、角樓、馬面、甕城、護城河）、內城（三格厚城牆、三個門洞、高一階）、衙署子城（本陣、再高一階）。攻方營地往東分出三條路：中路大道經西橋進甕城撞正門、北路穿過樹林到北橋與側門、南路經碎石坡與淺灘到南牆的瓦礫缺口。郭城西半是彎曲街巷的巷戰區，內城是整齊的坊與官署。',
    width: w,
    height: h,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: depth, y1: h },
      { x0: 93, y0: 26, x1: 213, y1: 114 },
    ],
    deployMask: [null, defMask],
    rearX: [0, w * TILE],
    spawns: [
      { x: 10000, y: 63000 },
      { x: 193500, y: 74500 },
    ],
    supplies: [],
    flags: [
      { name: '正門', x: 112000, y: 69500 },
      { name: '衙署', x: 193500, y: 69500 },
    ].map((f) => ({ ...f, points: 0 })),
    landmarks: [
      { name: '正門', x: 112000, y: 69500 },
      { name: '甕城', x: 103500, y: 69500 },
      { name: '西橋', x: 90500, y: 63000 },
      { name: '北橋', x: 167000, y: 24500 },
      { name: '南淺灘', x: 132500, y: 115500 },
      { name: '正門廣場', x: 121500, y: 69500 },
      { name: '西大街', x: 134500, y: 66500 },
      { name: '市集', x: 134500, y: 44500 },
      { name: '寺廟', x: 136500, y: 96500 },
      { name: '內城西門', x: 153500, y: 69500 },
      { name: '內城北門', x: 180500, y: 47500 },
      { name: '內城南門', x: 186500, y: 92500 },
      { name: '營房', x: 180500, y: 40500 },
      { name: '糧倉', x: 180500, y: 98500 },
      { name: '官署廣場', x: 176500, y: 69500 },
      { name: '北側門', x: 167000, y: 34000 },
      { name: '南牆缺口', x: 132500, y: 105500 },
      { name: '衙署', x: 193500, y: 69500 },
      { name: '西北角樓', x: 111500, y: 33500 },
      { name: '西南角樓', x: 111500, y: 105500 },
      { name: '北嶺', x: 54500, y: 44500 },
      { name: '南嶺', x: 54500, y: 86500 },
      { name: '北路樹林', x: 86500, y: 15500 },
      { name: '南路廢村', x: 68500, y: 101500 },
      { name: '攻方營地', x: 10000, y: 63000 },
    ],
    gates: [
      { x0: WX0, y0: CY - 1, x1: WX0 + 4, y1: CY + 2, kind: 'main' },
      { x0: 166, y0: WY0, x1: 168, y1: WY0 + 4, kind: 'side' },
    ],
    breaches: [breach],
    archways: [archBarbican, archInW, archInN, archInS, archCitadel],
    defender: 1,
    ram: { x: 16000, y: 62500, facing: 0 },
    bombardFrom: 180,
    siegeEntry: { x: 86500, y: 62500 },
  });
}

/**
 * 佔點地圖「大草原」：240 × 150 格，旋轉 180° 對稱。開闊的起伏草原，騎兵有利。
 * 中央是十字路口的驛站（中央旗，2 分）；北丘、南丘各有一座烽火台遺跡（側旗，1 分），離中央約 55 格。
 * 大道從雙方陣地經過驛站連到對面；驛站往北、往南的路通到兩座山丘；陣地另有小路斜向通往較近的那座山丘。
 * 四處緩坡（2 階）、零星小樹林與一個池塘提供一點掩護，但大部分是騎兵能自由奔馳的開闊地。
 */
export function grassland(): LegionMap {
  const w = 240;
  const h = 150;
  const half = idiv(h, 2);
  const terrain = new Uint8Array(w * h);
  const heights = new Uint8Array(w * h).fill(1);
  const box = (x0: number, y0: number, x1: number, y1: number, t: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) terrain[y * w + x] = t;
  };
  // 以下只畫上半部（列 0～74），旋轉 180° 複製成下半部
  // 山腳與低嶺（高度 2）：北丘、西邊小丘的山腳一圈，以及從西陣地斜向北丘的一道低嶺（西嶺）
  const rises = [oval(126, 20, 17, 12), oval(40, 64, 10, 8), polyline([[54, 40], [72, 45], [90, 52]], 36)];
  // 北丘（側旗所在，3～4 階）與西邊小丘
  paint(terrain, w, h, T.Hill, oval(126, 20, 10, 7));
  paint(terrain, w, h, T.Hill, oval(40, 64, 5, 4));
  // 樹林：北丘西側的林子、東北的長林帶、西邊幾片小樹林
  paint(terrain, w, h, T.Forest, ellipse(104, 22, 5, 4, 66), (c) => c === T.Plain);
  paint(terrain, w, h, T.Forest, ellipse(158, 30, 7, 3, 67), (c) => c === T.Plain);
  paint(terrain, w, h, T.Forest, ellipse(84, 52, 4, 3, 68), (c) => c === T.Plain);
  paint(terrain, w, h, T.Forest, ellipse(34, 26, 4, 3, 69), (c) => c === T.Plain);
  paint(terrain, w, h, T.Forest, ellipse(196, 66, 4, 3, 70), (c) => c === T.Plain);
  // 池塘（淺灘）
  paint(terrain, w, h, T.Shallow, ellipse(72, 30, 4, 2, 71), (c) => c === T.Plain);
  // 道路：大道（西陣地 → 驛站）、北路（驛站 → 北丘）、斜路（西陣地 → 北丘）
  paint(terrain, w, h, T.Road, polyline([[0, 73], [36, 70], [76, 73], [119, 74]], 5), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[121, 74], [123, 56], [124, 40], [125, 28]], 3), (c) => c !== T.Hill);
  paint(terrain, w, h, T.Road, polyline([[0, 44], [44, 36], [86, 28], [116, 22]], 3), (c) => c !== T.Hill && c !== T.Shallow);
  // 驛站：十字路口四周的房舍（中央留 7 格空地給旗圈）
  box(109, 64, 112, 66, T.Building);
  box(113, 60, 115, 62, T.Building);
  box(127, 63, 130, 65, T.Building);
  box(125, 59, 127, 60, T.Building);
  box(132, 68, 133, 70, T.Building);
  // 烽火台遺跡（北丘頂東側）
  box(130, 17, 131, 18, T.Building);
  // 高度
  const hillTops = [oval(126, 20, 4, 3), oval(40, 64, 2, 2)];
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t === T.Hill) heights[i] = hillTops.some((p) => p(x, y)) ? 4 : 3;
      else if (t === T.Shallow) heights[i] = 0;
      else if (t !== T.Building && rises.some((p) => p(x, y))) heights[i] = 2;
    }
  }
  rotateHalf(terrain);
  rotateHalf(heights);
  const depth = RULES.deployDepthTiles;
  const W = w * TILE;
  const H = h * TILE;
  const north = { x: 126500, y: 20500 };
  const rot = (p: { x: number; y: number }, name: string): FlagPoint => ({ name, x: W - p.x, y: H - p.y });
  return finishMap({
    id: 'grassland',
    name: '大草原',
    description: '開闊起伏的草原，騎兵有利。中央十字路口的驛站插著中央旗；北丘、南丘各有一座烽火台遺跡與側旗，離中央約 55 格。大道與小路把雙方陣地、驛站和兩座山丘連在一起；西嶺、東嶺兩道低嶺斜向山丘，另有零星小樹林與池塘。',
    width: w,
    height: h,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: depth, y1: h },
      { x0: w - depth, y0: 0, x1: w, y1: h },
    ],
    rearX: [0, W],
    spawns: [
      { x: 10000, y: H / 2 },
      { x: W - 10000, y: H / 2 },
    ],
    // 補給站：北丘山腳東側、南丘山腳西側，歸佔著那座山丘的一方
    supplies: [
      { x: north.x + 12000, y: north.y + 6000, flag: 0 },
      { x: W - north.x - 12000, y: H - north.y - 6000, flag: 2 },
    ],
    flags: [
      { name: '北丘烽火台', x: north.x, y: north.y, points: 1 },
      { name: '十字路口驛站', x: W / 2, y: H / 2, points: 2 },
      { ...rot(north, '南丘烽火台'), points: 1 },
    ],
    landmarks: [
      { name: '北丘烽火台', x: north.x, y: north.y },
      { name: '十字路口驛站', x: W / 2, y: H / 2 },
      rot(north, '南丘烽火台'),
      { name: '北丘西側的林子', x: 104500, y: 22500 },
      rot({ x: 104500, y: 22500 }, '南丘東側的林子'),
      { name: '東北林帶', x: 158500, y: 30500 },
      rot({ x: 158500, y: 30500 }, '西南林帶'),
      { name: '西北池塘', x: 72500, y: 30500 },
      rot({ x: 72500, y: 30500 }, '東南池塘'),
      { name: '西邊小丘', x: 40500, y: 64500 },
      rot({ x: 40500, y: 64500 }, '東邊小丘'),
      { name: '西嶺', x: 72500, y: 45500 },
      rot({ x: 72500, y: 45500 }, '東嶺'),
      { name: '藍方陣地', x: 10000, y: H / 2 },
      { name: '紅方陣地', x: W - 10000, y: H / 2 },
    ],
    gates: [],
    defender: -1,
  });
}

/** 各模式預設的地圖：殲滅戰用「河谷」，佔點用「大河谷」，攻城戰用「石關城」 */
export function defaultMapId(mode: string): string {
  return mode === 'capture' ? 'grand-valley' : mode === 'siege' ? 'stone-pass' : 'river-valley';
}

/** 各模式預設的時間上限（tick） */
export function defaultTimeLimit(mode: string): number {
  return mode === 'capture' ? RULES.capture.timeLimitTicks : mode === 'siege' ? SIEGE.timeLimitTicks : RULES.timeLimitTicks;
}

/** 地圖不會變，產生一次後共用 */
function once(make: () => LegionMap): () => LegionMap {
  let cached: LegionMap | null = null;
  return () => (cached ??= make());
}

export const MAPS: Record<string, () => LegionMap> = {
  'river-valley': once(riverValley),
  'grand-valley': once(grandValley),
  'stone-pass': once(stonePass),
  grassland: once(grassland),
};

/** 聯賽與觀戰用的地圖：攻城戰一張、佔點兩張（三場制第三場輪替） */
export const LEAGUE_MAPS: Readonly<Record<'siege' | 'capture', readonly string[]>> = {
  siege: ['stone-pass'],
  capture: ['grand-valley', 'grassland'],
};

// ───────── 公開的地圖特徵（features） ─────────

export interface MapFeatures {
  /** 牆段（城牆與門樓連成的直線段，端點是格中心的單位座標）；height ＝ 牆頂高度（地面 ＋ 3 階） */
  readonly walls: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly height: number }[];
  /** 城門：門洞中心、血量、kind（main 正門、side 側門）與格座標範圍 */
  readonly gates: readonly { readonly id: number; readonly x: number; readonly y: number; readonly hp: number; readonly kind: 'main' | 'side'; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  /** 樓梯格中心 */
  readonly stairs: readonly { readonly x: number; readonly y: number }[];
  /** 隘口：bridge 橋、ford 淺灘、gate 城門、arch 沒有門的門洞、breach 城牆缺口；width ＝ 寬（格） */
  readonly chokes: readonly { readonly x: number; readonly y: number; readonly width: number; readonly kind: 'bridge' | 'ford' | 'gate' | 'arch' | 'breach' }[];
  /** 高地（高度 3 階以上連成的一片）：中心、半徑（單位）、最高的階 */
  readonly highs: readonly { readonly x: number; readonly y: number; readonly radius: number; readonly height: number }[];
  /** 樹林：中心、半徑（單位） */
  readonly covers: readonly { readonly x: number; readonly y: number; readonly radius: number }[];
}

/** 連通塊（四方向）：回傳每一塊的格索引（依第一格的索引排序） */
function components(w: number, h: number, ok: (i: number) => boolean): number[][] {
  const seen = new Uint8Array(w * h);
  const out: number[][] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] === 1 || !ok(i)) continue;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const j = stack.pop()!;
      comp.push(j);
      const x = j % w;
      const y = (j - x) / w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k < 0 || seen[k] === 1 || !ok(k)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    comp.sort((a, b) => a - b);
    out.push(comp);
  }
  return out;
}

/** 連通塊的中心（單位座標，格中心平均）、等面積半徑（單位）與外框 */
function blob(w: number, comp: readonly number[]): { x: number; y: number; radius: number; bw: number; bh: number } {
  let sx = 0;
  let sy = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (const i of comp) {
    const x = i % w;
    const y = (i - x) / w;
    sx += x;
    sy += y;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const n = comp.length;
  return { x: idiv(sx * TILE, n) + TILE / 2, y: idiv(sy * TILE, n) + TILE / 2, radius: isqrt(idiv(n * TILE * TILE * 100, 314)), bw: x1 - x0 + 1, bh: y1 - y0 + 1 };
}

const featureCache = new WeakMap<LegionMap, MapFeatures>();

/** 從地形、高度、城門資料算出公開的地圖特徵（BOT 不必一張圖寫一套）；同一張地圖只算一次 */
export function mapFeatures(m: LegionMap): MapFeatures {
  const cached = featureCache.get(m);
  if (cached !== undefined) return cached;
  const { width: w, height: h, terrain, heights } = m;
  const c = (t: number): number => t * TILE + TILE / 2;
  const isWall = (i: number): boolean => terrain[i] === T.Wall || terrain[i] === T.Gatehouse;
  const walls: MapFeatures['walls'][number][] = [];
  // 橫向段
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; ) {
      if (!isWall(y * w + x)) {
        x += 1;
        continue;
      }
      let e = x;
      while (e + 1 < w && isWall(y * w + e + 1)) e += 1;
      if (e > x) walls.push({ x0: c(x), y0: c(y), x1: c(e), y1: c(y), height: heights[y * w + x] + WALL_LEVELS });
      x = e + 1;
    }
  }
  // 縱向段
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; ) {
      if (!isWall(y * w + x)) {
        y += 1;
        continue;
      }
      let e = y;
      while (e + 1 < h && isWall((e + 1) * w + x)) e += 1;
      if (e > y) walls.push({ x0: c(x), y0: c(y), x1: c(x), y1: c(e), height: heights[y * w + x] + WALL_LEVELS });
      y = e + 1;
    }
  }
  const gates = m.gates.map((g, id) => ({ id, x: idiv((g.x0 + g.x1) * TILE, 2), y: idiv((g.y0 + g.y1) * TILE, 2), hp: g.kind === 'main' ? RULES.gate.mainHp : RULES.gate.sideHp, kind: g.kind, x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 }));
  const stairs: MapFeatures['stairs'][number][] = [];
  for (let i = 0; i < w * h; i++) if (terrain[i] === T.Stair) stairs.push({ x: c(i % w), y: c((i - (i % w)) / w) });
  const chokes: MapFeatures['chokes'][number][] = [];
  // 橋與淺灘：要接著河流才算渡口（草原上的池塘不是隘口）
  const touchesRiver = (comp: readonly number[]): boolean =>
    comp.some((i) => {
      const x = i % w;
      return (x > 0 && terrain[i - 1] === T.River) || (x < w - 1 && terrain[i + 1] === T.River) || (i >= w && terrain[i - w] === T.River) || (i + w < w * h && terrain[i + w] === T.River);
    });
  /** 通道寬：門洞左右兩側都能走就是東西向通道（寬 ＝ 南北長度），否則是南北向通道（寬 ＝ 東西長度） */
  const passWidth = (r: { x0: number; y0: number; x1: number; y1: number }): number => {
    const my = idiv(r.y0 + r.y1 - 1, 2);
    const ew = r.x0 > 0 && r.x1 < w && walkable(terrain[my * w + r.x0 - 1]) && walkable(terrain[my * w + r.x1]);
    return ew ? r.y1 - r.y0 : r.x1 - r.x0;
  };
  const centerOf = (r: { x0: number; y0: number; x1: number; y1: number }): { x: number; y: number } => ({ x: idiv((r.x0 + r.x1) * TILE, 2), y: idiv((r.y0 + r.y1) * TILE, 2) });
  for (const [t, kind] of [[T.Bridge, 'bridge'], [T.Shallow, 'ford']] as const) {
    for (const comp of components(w, h, (i) => terrain[i] === t)) {
      if (!touchesRiver(comp)) continue;
      const b = blob(w, comp);
      let x0 = w;
      let y0 = h;
      let x1 = 0;
      let y1 = 0;
      for (const i of comp) {
        const x = i % w;
        const y = (i - x) / w;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
      chokes.push({ x: b.x, y: b.y, width: passWidth({ x0, y0, x1, y1 }), kind });
    }
  }
  for (const g of m.gates) chokes.push({ ...centerOf(g), width: passWidth(g), kind: 'gate' });
  for (const b of m.archways ?? []) chokes.push({ ...centerOf(b), width: passWidth(b), kind: 'arch' });
  for (const b of m.breaches ?? []) chokes.push({ ...centerOf(b), width: passWidth(b), kind: 'breach' });
  const highs = components(w, h, (i) => heights[i] >= 3 && walkable(terrain[i])).map((comp) => {
    const b = blob(w, comp);
    let top = 0;
    for (const i of comp) top = Math.max(top, heights[i]);
    return { x: b.x, y: b.y, radius: b.radius, height: top };
  });
  const covers = components(w, h, (i) => terrain[i] === T.Forest).map((comp) => {
    const b = blob(w, comp);
    return { x: b.x, y: b.y, radius: b.radius };
  });
  const f: MapFeatures = { walls, gates, stairs, chokes, highs, covers };
  featureCache.set(m, f);
  return f;
}

/** 註冊地圖（測試用的最小地圖、之後的城池與平原圖）；同 id 覆蓋 */
export function registerMap(map: LegionMap): void {
  MAPS[map.id] = () => map;
}

/**
 * 座標 → 格：以地圖中心對稱（剛好落在格線上的點歸給靠近中心的那一格），
 * 讓旋轉 180° 的兩個點一定落在互相對應的兩格，雙方不會因為取整方向不同而有差異。
 */
export function tileCoord(v: number, tiles: number): number {
  const total = tiles * TILE;
  if (v * 2 < total) return Math.floor(v / TILE);
  return tiles - 1 - Math.floor((total - v) / TILE);
}

/**
 * 座標 → 格（二維）：跟 tileCoord 一樣以地圖中心對稱；剛好落在中心線上的點（自己就是自己的鏡像那一軸），
 * 依另一軸在中心的哪一側決定歸哪一格，讓旋轉 180° 的兩個點一定落在互相對應的兩格。
 */
export function tileXY(x: number, y: number, w: number, h: number): [number, number] {
  let tx = tileCoord(x, w);
  let ty = tileCoord(y, h);
  if (y * 2 === h * TILE) ty = x * 2 < w * TILE ? h / 2 - 1 : h / 2;
  if (x * 2 === w * TILE) tx = y * 2 < h * TILE ? w / 2 - 1 : w / 2;
  return [tx, ty];
}

export function terrainAt(map: LegionMap, x: number, y: number): number {
  const [tx, ty] = tileXY(x, y, map.width, map.height);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return T.River;
  return map.terrain[ty * map.width + tx];
}

export function heightAt(map: LegionMap, x: number, y: number): number {
  const [tx, ty] = tileXY(x, y, map.width, map.height);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return 0;
  return map.heights[ty * map.width + tx];
}

/** 建築與城牆擋視線的高度 */
const BLOCK_HEIGHT = 9;

/** 某一層的高度：牆頂 ＝ 地面高度 ＋ WALL_LEVELS 階 */
export function heightAtLayer(map: LegionMap, x: number, y: number, layer: number): number {
  return heightAt(map, x, y) + (layer === WALL_LAYER ? WALL_LEVELS : 0);
}

/**
 * 視線是否被地形擋住：沿兩點連線每格取樣，中間任何一格的地形高過視線（雙方眼睛在各自高度 + 0.5 階）就看不到。
 * 樹林不擋視線（隱蔽另外計算）；建築、城牆、門樓擋視線。
 * al、bl 是兩端的層：任一端在牆頂時，城牆與門樓改以牆頂實高擋（否則牆頂看不到沿牆的敵人）。
 */
export function sightBlocked(map: LegionMap, ax: number, ay: number, bx: number, by: number, al = 0, bl = 0): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const steps = idiv(Math.max(Math.abs(dx), Math.abs(dy)), TILE);
  if (steps < 2) return false;
  const ea = 2 * heightAtLayer(map, ax, ay, al) + 1;
  const eb = 2 * heightAtLayer(map, bx, by, bl) + 1;
  const onTop = al === WALL_LAYER || bl === WALL_LAYER;
  for (let k = 1; k < steps; k++) {
    const x = ax + idiv(dx * k, steps);
    const y = ay + idiv(dy * k, steps);
    const t = terrainAt(map, x, y);
    let hgt: number;
    if (t === T.Building) hgt = BLOCK_HEIGHT;
    else if (t === T.Wall || t === T.Gatehouse) hgt = onTop ? heightAt(map, x, y) + WALL_LEVELS : BLOCK_HEIGHT;
    else hgt = heightAt(map, x, y);
    // 2 × 地形高度 > 視線高度（半階單位，乘上 steps 避免除法）
    if (2 * hgt * steps > ea * steps + (eb - ea) * k) return true;
  }
  return false;
}
