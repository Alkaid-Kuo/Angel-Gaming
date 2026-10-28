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
 * 攻城地圖「石關城」：200 × 140 格，仿中國古城（參考西安、平遙一類的城制）。攻方（藍方，座位 0）從西邊出發；城池在東側、背靠大河。
 * 城牆：四格厚（牆頂能站五、六列縱深的方陣），四角 8 × 8 的角樓，牆面凸出的馬面；正門外有甕城（三格厚的牆圍成的小城，
 * 入口開在西面北段，攻方得在甕城裡轉彎、頂著三面城牆的箭撞正門）；甕城前三格寬的護城河，只有入口前有橋。
 * 路線：西牆正門（3 格）、北牆側門（2 格，兩側有門樓馬面）、南牆一段坍塌的瓦礫缺口（5 格）；北牆、南牆、西牆兩段可以架雲梯。
 * 城內全部鋪石：沿城牆一圈四格寬的順城街與馬道（三格寬的坡道上牆）、五格寬的東西大街與南北大街交會於鼓樓廣場、
 * 街道劃出的坊（四合院式的房舍圍著院落）、市集、寺廟、營房與校場、糧倉、官署；東側是兩格厚城牆圍成的衙署子城（本陣，高一階）。
 * 旗：A ＝ 正門、B ＝ 衙署。
 */
export function stonePass(): LegionMap {
  const w = 200;
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
    const bank = y >= 22 && y <= 117 ? 189 : 189 + idiv(2 * isin(idiv(y * 360, 40)) + 10000, 10000) - 1;
    for (let x = bank; x < w; x++) terrain[idx(x, y)] = T.River;
  }
  // ── 城外：大道、村落、樹林、小丘、緩坡 ──
  paint(terrain, w, h, T.Road, polyline([[0, 63], [30, 61], [60, 64], [88, 62]], 5));
  // 繞到北橋的小路
  paint(terrain, w, h, T.Road, polyline([[40, 60], [70, 40], [110, 16], [150, 16], [150, 20]], 2));
  paint(terrain, w, h, T.Forest, ellipse(76, 30, 9, 7, 51));
  paint(terrain, w, h, T.Forest, ellipse(89, 22, 5, 4, 52));
  paint(terrain, w, h, T.Hill, ellipse(60, 112, 7, 5, 53), (c) => c === T.Plain);
  for (const [bx, by, bw, bh] of [[44, 55, 3, 2], [49, 54, 2, 3], [43, 68, 3, 2], [49, 69, 2, 2], [55, 56, 2, 2], [54, 68, 3, 2]] as const) box(bx, by, bx + bw - 1, by + bh - 1, T.Building);
  const rises = [oval(100, 12, 16, 5), oval(150, 126, 18, 5), oval(60, 112, 11, 8)];
  // ── 城牆（四格厚） ──
  const WX0 = 110;
  const WX1 = 188;
  const WY0 = 30;
  const WY1 = 109;
  box(WX0, WY0, WX0 + 3, WY1, T.Wall);
  box(WX1 - 3, WY0, WX1, WY1, T.Wall);
  box(WX0, WY0, WX1, WY0 + 3, T.Wall);
  box(WX0, WY1 - 3, WX1, WY1, T.Wall);
  // 角樓（8 × 8，往外凸兩格）
  for (const [cx, cy] of [[WX0 - 2, WY0 - 2], [WX1 - 5, WY0 - 2], [WX0 - 2, WY1 - 5], [WX1 - 5, WY1 - 5]] as const) box(cx, cy, cx + 7, cy + 7, T.Wall);
  // 馬面（往外凸三格）：北牆、南牆各兩座，北側門兩側各一座；西牆甕城以外兩座
  for (const x of [124, 168]) {
    box(x, WY0 - 3, x + 5, WY0 - 1, T.Wall);
    box(x, WY1 + 1, x + 5, WY1 + 3, T.Wall);
  }
  box(145, WY0 - 3, 148, WY0 - 1, T.Wall);
  box(153, WY0 - 3, 156, WY0 - 1, T.Wall);
  for (const y of [42, 92]) box(WX0 - 3, y, WX0 - 1, y + 5, T.Wall);
  // ── 甕城（正門外，三格厚的牆；入口在西面北段） ──
  box(96, 58, 98, 80, T.Wall);
  box(96, 58, WX0 - 1, 60, T.Wall);
  box(96, 78, WX0 - 1, 80, T.Wall);
  const archBarbican = { x0: 96, y0: 61, x1: 99, y1: 65 };
  box(archBarbican.x0, archBarbican.y0, archBarbican.x1 - 1, archBarbican.y1 - 1, T.Paved);
  // ── 城門與缺口 ──
  box(WX0, CY - 1, WX0 + 3, CY + 1, T.Gatehouse);
  box(150, WY0, 151, WY0 + 3, T.Gatehouse);
  const breach = { x0: 146, y0: WY1 - 3, x1: 151, y1: WY1 + 1 };
  box(breach.x0, breach.y0, breach.x1 - 1, breach.y1 - 1, T.Rubble);
  // ── 護城河：三格寬，繞西、北、南三面（東面接大河），和城牆之間留護城堤；甕城外的一段往外繞 ──
  // 過河處：西橋（甕城入口前）、北橋（側門前）、南牆缺口前一段淤塞成淺灘
  const MX = 99;
  const MY0 = 21;
  const MY1 = 116;
  const moat = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inMap(x, y)) terrain[idx(x, y)] = T.River;
  };
  moat(MX, MY0, 188, MY0 + 2);
  moat(MX, MY1, 188, MY1 + 2);
  moat(MX, MY0, MX + 2, 52);
  moat(MX, 86, MX + 2, MY1 + 2);
  moat(89, 52, MX + 2, 54);
  moat(89, 84, MX + 2, 86);
  moat(89, 52, 91, 86);
  box(89, archBarbican.y0, 91, archBarbican.y1 - 1, T.Bridge);
  box(150, MY0, 151, MY0 + 2, T.Bridge);
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
  // ── 衙署子城（兩格厚城牆、四角小樓、西面五格寬的門洞） ──
  const CX0 = 162;
  const CX1 = 180;
  const CY0 = 54;
  const CY1 = 84;
  box(CX0, CY0, CX0 + 1, CY1, T.Wall);
  box(CX1 - 1, CY0, CX1, CY1, T.Wall);
  box(CX0, CY0, CX1, CY0 + 1, T.Wall);
  box(CX0, CY1 - 1, CX1, CY1, T.Wall);
  for (const [cx, cy] of [[CX0 - 1, CY0 - 1], [CX1 - 2, CY0 - 1], [CX0 - 1, CY1 - 2], [CX1 - 2, CY1 - 2]] as const) box(cx, cy, cx + 3, cy + 3, T.Wall);
  const archCitadel = { x0: CX0, y0: CY - 2, x1: CX0 + 2, y1: CY + 3 };
  box(archCitadel.x0, archCitadel.y0, archCitadel.x1 - 1, archCitadel.y1 - 1, T.Paved);
  // 正堂（北）、東廂、南堂；中間是院落（B 旗）
  box(168, 58, 176, 61, T.Building);
  box(175, 64, 177, 74, T.Building);
  box(167, 78, 175, 80, T.Building);
  // ── 城內的建築：坊（四合院式）、市集、寺廟、營房與校場、糧倉、官署 ──
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
  ward(118, 38, 130, 50);
  ward(134, 38, 146, 50);
  ward(118, 54, 130, 66);
  ward(134, 54, 143, 66);
  ward(134, 72, 143, 84);
  ward(118, 88, 130, 101);
  ward(154, 55, 159, 65);
  ward(154, 73, 159, 83);
  // 市集（西大街南側、正門內）：北、西兩面沿街店鋪，中間一排排攤位
  for (let x = 118; x <= 130; x++) if ((x - 118) % 5 !== 4) box(x, 72, x, 73, T.Building);
  for (let y = 74; y <= 84; y++) if ((y - 72) % 5 !== 4) box(118, y, 119, y, T.Building);
  for (let y = 76; y <= 83; y += 3) for (let x = 122; x <= 129; x += 3) box(x, y, x + 1, y, T.Building);
  // 寺廟（西南）：山門、大殿、兩側配殿，院裡種樹
  box(137, 99, 143, 100, T.Building);
  box(136, 89, 144, 92, T.Building);
  box(134, 93, 135, 98, T.Building);
  box(145, 93, 146, 98, T.Building);
  paint(terrain, w, h, T.Forest, oval(140, 96, 2, 1), (c) => c === T.Paved);
  // 營房（東北）：三排長屋；西半部是校場（空地）
  for (const y of [38, 42, 46]) box(167, y, 179, y + 1, T.Building);
  box(155, 38, 158, 40, T.Building);
  // 糧倉（東南）：兩排倉廒
  for (const y of [89, 95]) for (const x of [156, 163, 170]) box(x, y, x + 4, y + 2, T.Building);
  // ── 馬道（城牆內側三格寬的坡道，上牆用） ──
  const ramp = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (tAt(x, y) === T.Paved) terrain[idx(x, y)] = T.Stair;
  };
  const IX0 = WX0 + 4;
  const IX1 = WX1 - 4;
  const IY0 = WY0 + 4;
  const IY1 = WY1 - 4;
  for (const y of [46, CY - 7, CY + 5, 90]) ramp(IX0, y, IX0, y + 2);
  for (const y of [46, 90]) ramp(IX1, y, IX1, y + 2);
  for (const x of [124, 144, 155, 170]) ramp(x, IY0, x + 2, IY0);
  for (const x of [124, 141, 154, 170]) ramp(x, IY1, x + 2, IY1);
  // 子城：北牆、南牆內側各一段
  ramp(165, CY0 + 2, 166, CY0 + 2);
  ramp(165, CY1 - 2, 166, CY1 - 2);
  // ── 高度：城內、甕城、城牆 2；子城院落 3；護城河與大河 0、橋 1；城外 1、緩坡 2、西南小丘 3～4 ──
  const hillTop = ellipse(60, 112, 3, 2, 56);
  for (let i = 0; i < w * h; i++) {
    const t = terrain[i];
    const x = i % w;
    const y = (i - x) / w;
    const castle = x >= 93 && x <= 191 && y >= 25 && y <= 114 && t !== T.River && t !== T.Bridge && (inside[i] === 1 || barbican[i] === 1 || t === T.Wall || t === T.Gatehouse || t === T.Rubble || t === T.Paved || t === T.Stair || t === T.Building || t === T.Forest);
    if (t === T.River) heights[i] = 0;
    else if (t === T.Bridge) heights[i] = 1;
    else if (t === T.Shallow) heights[i] = 0;
    else if (castle) heights[i] = t !== T.Wall && x > CX0 + 1 && x < CX1 - 1 && y > CY0 + 1 && y < CY1 - 1 ? 3 : 2;
    else if (t === T.Hill) heights[i] = hillTop(x, y) ? 4 : 3;
    else if (t !== T.Building && rises.some((p) => p(x, y))) heights[i] = 2;
  }
  // 子城門洞也算院落那一階
  for (let y = archCitadel.y0; y < archCitadel.y1; y++) for (let x = archCitadel.x0; x < archCitadel.x1; x++) heights[idx(x, y)] = 3;
  // ── 守方布陣區：城內、甕城、城牆（含角樓、馬面）、門樓、缺口 ──
  const defMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = (i - x) / w;
    if (x < 93 || x > 191 || y < 25 || y > 114) continue;
    const t = terrain[i];
    if (inside[i] === 1 || barbican[i] === 1 || archAt(x, y, archBarbican) || t === T.Wall || t === T.Gatehouse || t === T.Rubble) defMask[i] = 1;
  }
  const depth = RULES.deployDepthTiles;
  return finishMap({
    id: 'stone-pass',
    name: '石關城',
    description: '背靠大河的方城：四格厚的城牆、四角角樓與馬面，正門外有甕城與護城河，北牆有側門、南牆有一段坍塌的瓦礫缺口。城內全部鋪石，大街十字交會於鼓樓廣場，街坊、市集、寺廟、營房校場與糧倉分區排開，東側是圍著城牆的衙署子城（本陣）。',
    width: w,
    height: h,
    terrain,
    heights,
    deploy: [
      { x0: 0, y0: 0, x1: depth, y1: h },
      { x0: 93, y0: 25, x1: 192, y1: 115 },
    ],
    deployMask: [null, defMask],
    rearX: [0, w * TILE],
    spawns: [
      { x: 10000, y: 63000 },
      { x: 171500, y: 74500 },
    ],
    supplies: [],
    flags: [
      { name: '正門', x: 112000, y: 69500 },
      { name: '衙署', x: 171500, y: 69500 },
    ].map((f) => ({ ...f, points: 0 })),
    landmarks: [
      { name: '正門', x: 112000, y: 69500 },
      { name: '甕城', x: 103500, y: 69500 },
      { name: '西橋', x: 90500, y: 63000 },
      { name: '北橋', x: 151000, y: 22500 },
      { name: '南淺灘', x: 148500, y: 117500 },
      { name: '鼓樓廣場', x: 150500, y: 69500 },
      { name: '西大街', x: 130500, y: 69500 },
      { name: '市集', x: 124500, y: 78500 },
      { name: '寺廟', x: 140500, y: 95500 },
      { name: '校場', x: 160500, y: 44500 },
      { name: '營房', x: 173500, y: 42500 },
      { name: '糧倉', x: 166500, y: 95500 },
      { name: '北側門', x: 151000, y: 32000 },
      { name: '南牆缺口', x: 148500, y: 107500 },
      { name: '衙署', x: 171500, y: 69500 },
      { name: '西北角樓', x: 111500, y: 31500 },
      { name: '西南角樓', x: 111500, y: 107500 },
      { name: '西北樹林', x: 78500, y: 30500 },
      { name: '路邊村落', x: 49500, y: 62500 },
      { name: '西南小丘', x: 60500, y: 112500 },
      { name: '攻方陣地', x: 10000, y: 63000 },
    ],
    gates: [
      { x0: WX0, y0: CY - 1, x1: WX0 + 4, y1: CY + 2, kind: 'main' },
      { x0: 150, y0: WY0, x1: 152, y1: WY0 + 4, kind: 'side' },
    ],
    breaches: [breach],
    archways: [archBarbican, archCitadel],
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
