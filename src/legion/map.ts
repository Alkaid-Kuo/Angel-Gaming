// 軍團戰地圖：以幾何形狀（橢圓、折線、河道）在格子上繪製地形；上半部繪製後，下半部以 180° 旋轉複製，保證雙方對稱。
// 每一格另有高度階（0～5）：高度效果全部依高低差計算（規格書 v0.2 第七節）。殲滅戰用「河谷」，佔點用「大河谷」。
import { hashInts } from '../shared/hash.ts';
import { idiv, isqrt } from '../shared/intmath.ts';
import { SIEGE, T, TILE, WALL_LAYER, WALL_LEVELS, walkable, walkableTop, RULES } from './config.ts';
import { iatan2, isin } from './geom.ts';

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

/**
 * 3D 畫面用的外觀說明（引擎不讀）：建物畫成哪一種、正面朝哪、幾層樓，地面的農田、道路折線。
 * 範圍是格座標矩形（含 x0／y0、不含 x1／y1）；建物底下的格在地形上是建築（城樓、敵樓建在牆頂，底下是城牆）。
 */
export interface MapDecor {
  readonly kind: DecorKind;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** 正面朝向：0 東、1 南、2 西、3 北 */
  readonly face?: number;
  readonly storeys?: number;
  /** 道路：折線頂點（格座標）與路寬（格） */
  readonly pts?: readonly (readonly [number, number])[];
  readonly width?: number;
  /** 外觀的變化（屋頂顏色、高矮） */
  readonly seed?: number;
  /** 民房：茅草頂（否則是灰瓦） */
  readonly thatch?: boolean;
}

/**
 * house 民房、hall 殿堂、longhouse 長屋（營房、倉）、ruin 廢屋、silo 圓倉、stall 攤位、tent 營帳、shed 工坊、trebuchet 投石機、
 * gateTower 城樓、cornerTower 角樓、wallTower 敵樓、arrowTower 箭樓、drumTower 鼓樓、pagoda 塔、pailou 牌坊（立在街上，不擋路）、
 * court 院子、tree 樹、willow 柳樹、field 農田、road 道路、moat 護城河（石砌河岸）
 */
export type DecorKind =
  | 'house'
  | 'hall'
  | 'longhouse'
  | 'ruin'
  | 'silo'
  | 'stall'
  | 'tent'
  | 'shed'
  | 'trebuchet'
  | 'gateTower'
  | 'cornerTower'
  | 'wallTower'
  | 'arrowTower'
  | 'drumTower'
  | 'pagoda'
  | 'pailou'
  | 'court'
  | 'tree'
  | 'willow'
  | 'field'
  | 'road'
  | 'moat';

type DecorMore = Pick<MapDecor, 'face' | 'storeys' | 'pts' | 'width' | 'seed' | 'thatch'>;

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
  /** 衝車的起點與朝向（單位座標；在攻方布陣區）：有 ramTrack 時由 finishMap 從軌道起點與第一段的方向算出 */
  readonly ram?: { readonly x: number; readonly y: number; readonly facing: number };
  /** 衝車軌道（單位座標的折線）：起點是衝車開局的位置、終點是城門外的撞擊點；衝車只沿這條線往前走。沒有軌道就沒有衝車 */
  readonly ramTrack?: readonly { readonly x: number; readonly y: number }[];
  /** 砲擊來向（度）：從落點指向攻方地圖邊緣的方向（攻方在西邊就是 180）；沒有就沒有砲擊支援 */
  readonly bombardFrom?: number;
  /** 攻城戰攻方後備（開關打開時）在 A 旗佔下後的入場點：A 外側 */
  readonly siegeEntry?: { readonly x: number; readonly y: number };
  /** 城牆缺口（格座標矩形，可走的斷牆格，沒有門）：只用來產生公開的 features.chokes */
  readonly breaches?: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  /** 門洞（沒有城門的拱門，例如內城門洞、子城門洞）：只用來產生公開的 features.chokes */
  readonly archways?: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
  /** 3D 畫面用的建物與地面外觀（引擎不讀；沒有就由地形自動產生） */
  readonly decor?: readonly MapDecor[];
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
  const t = spec.ramTrack;
  if (t !== undefined && t.length < 2) throw new Error(`${spec.id}：衝車軌道至少要兩個點`);
  const ram = t === undefined ? spec.ram : { x: t[0].x, y: t[0].y, facing: iatan2(t[1].y - t[0].y, t[1].x - t[0].x) };
  return { ...spec, ram, snap: buildSnap(terrain, w, h), snapTop: buildSnapTop(terrain, w, h), edge: buildEdge(terrain, w, h), symmetric: isSymmetric(terrain, heights) };
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
 * 城外：營地（營帳、工坊、投石機）往東分出三條路，中間用兩道長嶺（坡地與樹林）隔開，其餘是農田、零星的樹與護城河邊的柳樹——
 *   中路：大道 → 西橋 → 正門（衝車路線，橋正對正門；路旁有土丘可以擋箭）；
 *   北路：沿北嶺北側穿過樹林 → 北橋 → 北牆側門（遠，但有樹林遮蔽）；
 *   南路：碎石坡與廢村 → 南淺灘 → 南牆的瓦礫缺口（近，但地形慢，騎兵過不了缺口）。
 * 第一道防線（郭城，高 2）：四格厚的城牆、角樓、馬面（上有敵樓）；護城河繞西北南三面（西面一直線），和城牆之間留護城堤（架雲梯）。
 *   郭城西半是街坊：正門內的廣場經大街到鼓樓（街從鼓樓兩側繞過，丁字街不直通），再到內城西門洞前的廣場；
 *   北邊是市集、南邊是有塔的寺院，其餘是一坊坊的院落民房，坊與坊之間是巷（4 格）與弄（3 格）；
 *   內城北、南兩側是窄長的夾道（營房、糧倉），北側門與南牆缺口各通往其中一側。
 * 第二道防線（內城，高 3）：三格厚的內城牆，西、北、南三個門洞（上有門樓、沒有門扇）；城內是院落民房的坊、牌坊大街與官署。
 * 第三道防線（子城，院落高 4）：內城最深處兩格厚城牆圍成的衙署，西面一個門洞；大堂坐東朝西，兩側廂房。
 * 旗：A ＝ 正門廣場（門內；旗圈整個在廣場裡，城外的人佔不到）、B ＝ 衙署院落。
 * 3D 畫面用的建物外觀（屋頂、城樓、塔、農田、道路折線）另外記在 decor，引擎不讀。
 */
export function stonePass(): LegionMap {
  const w = 224;
  const h = 140;
  const terrain = new Uint8Array(w * h);
  const heights = new Uint8Array(w * h).fill(1);
  const decor: MapDecor[] = [];
  const idx = (x: number, y: number): number => y * w + x;
  const inMap = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  const box = (x0: number, y0: number, x1: number, y1: number, t: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inMap(x, y)) terrain[idx(x, y)] = t;
  };
  const tAt = (x: number, y: number): number => (inMap(x, y) ? terrain[idx(x, y)] : -1);
  /** 記下 3D 外觀（輸入的範圍含兩端） */
  const deco = (kind: DecorKind, x0: number, y0: number, x1: number, y1: number, more: DecorMore = {}): void => {
    decor.push({ kind, x0, y0, x1: x1 + 1, y1: y1 + 1, ...more });
  };
  /** 建物：格子是建築，3D 照 kind 畫 */
  const build = (kind: DecorKind, x0: number, y0: number, x1: number, y1: number, more: DecorMore = {}): void => {
    box(x0, y0, x1, y1, T.Building);
    deco(kind, x0, y0, x1, y1, more);
  };
  const roll = (a: number, b: number, salt: number): number => hashInts([a, b, salt]) >>> 0;
  /** 沿一邊排一間間房（每間 3～5 格寬，剩不到 3 格就併進最後一間）；face：正面朝向 */
  const row = (x0: number, y0: number, x1: number, y1: number, alongX: boolean, face: number, salt: number): void => {
    const len = alongX ? x1 - x0 + 1 : y1 - y0 + 1;
    for (let p = 0; p < len; ) {
      const r = roll(x0 + p, y0 + p, salt);
      let n = 3 + (r % 3);
      if (len - p - n < 3) n = len - p;
      const more = { face, storeys: r % 5 === 0 ? 2 : 1, seed: r % 1000 };
      if (alongX) deco('house', x0 + p, y0, x0 + p + n - 1, y1, more);
      else deco('house', x0, y0 + p, x1, y0 + p + n - 1, more);
      p += n;
    }
  };
  /**
   * 一坊院落民房：沿街一圈三格深的房舍（正面朝外），中間是一個個院子（種樹，或蓋一間正房）。
   * 窄的坊只排一兩列。整坊在格子上都是建築（院子圍在房舍裡，走不進去）。
   */
  const houses = (x0: number, y0: number, x1: number, y1: number, salt: number): void => {
    box(x0, y0, x1, y1, T.Building);
    const W = x1 - x0 + 1;
    const H = y1 - y0 + 1;
    if (H < 6 && H <= W) {
      if (H >= 5) {
        const mid = y0 + idiv(H, 2);
        row(x0, y0, x1, mid - 1, true, 3, salt);
        row(x0, mid, x1, y1, true, 1, salt + 1);
      } else row(x0, y0, x1, y1, true, salt % 2 === 0 ? 1 : 3, salt);
      return;
    }
    if (W < 6) {
      if (W >= 5) {
        const mid = x0 + idiv(W, 2);
        row(x0, y0, mid - 1, y1, false, 2, salt);
        row(mid, y0, x1, y1, false, 0, salt + 1);
      } else row(x0, y0, x1, y1, false, salt % 2 === 0 ? 0 : 2, salt);
      return;
    }
    row(x0, y0, x1, y0 + 2, true, 3, salt);
    row(x0, y1 - 2, x1, y1, true, 1, salt + 1);
    if (H > 6) {
      row(x0, y0 + 3, x0 + 2, y1 - 3, false, 2, salt + 2);
      row(x1 - 2, y0 + 3, x1, y1 - 3, false, 0, salt + 3);
    }
    // 院子：沿長邊切成 4～6 格的院，三成蓋一間正房、其餘種樹
    const ix0 = x0 + 3;
    const ix1 = x1 - 3;
    const iy0 = y0 + 3;
    const iy1 = y1 - 3;
    if (ix1 < ix0 || iy1 < iy0) return;
    const alongX = ix1 - ix0 >= iy1 - iy0;
    const len = alongX ? ix1 - ix0 + 1 : iy1 - iy0 + 1;
    for (let p = 0; p < len; ) {
      const r = roll(ix0 + p, iy0 + p, salt + 9);
      let n = 4 + (r % 3);
      if (len - p - n < 3) n = len - p;
      const cx0 = alongX ? ix0 + p : ix0;
      const cy0 = alongX ? iy0 : iy0 + p;
      const cx1 = alongX ? ix0 + p + n - 1 : ix1;
      const cy1 = alongX ? iy1 : iy0 + p + n - 1;
      if (r % 10 < 3 && cx1 - cx0 >= 2 && cy1 - cy0 >= 2) deco('house', cx0, cy0, cx1, cy1, { face: alongX ? 1 : 0, storeys: 1, seed: r % 1000 });
      else {
        deco('court', cx0, cy0, cx1, cy1);
        deco('tree', idiv(cx0 + cx1, 2), idiv(cy0 + cy1, 2), idiv(cx0 + cx1, 2), idiv(cy0 + cy1, 2), { seed: r % 1000 });
      }
      p += n;
    }
  };
  const CY = 69;
  // ── 東邊的大河（城池背水） ──
  for (let y = 0; y < h; y++) {
    const bank = y >= 20 && y <= 119 ? 213 : 213 + idiv(2 * isin(idiv(y * 360, 40)) + 10000, 10000) - 1;
    for (let x = bank; x < w; x++) terrain[idx(x, y)] = T.River;
  }
  // ── 城外：兩道長嶺把攻方的路分成三條 ──
  const plainOnly = (c: number): boolean => c === T.Plain;
  // 道路：格子畫成道路，3D 照折線畫平滑的路面
  const road = (pts: [number, number][], halfWidth2: number): void => {
    paint(terrain, w, h, T.Road, polyline(pts, halfWidth2));
    decor.push({ kind: 'road', x0: 0, y0: 0, x1: 0, y1: 0, pts, width: isqrt(halfWidth2) });
  };
  // 北嶺、南嶺（坡地，嶺上有樹）
  const ridges = [polyline([[24, 52], [40, 46], [62, 42], [84, 40]], 36), polyline([[24, 76], [40, 84], [62, 88], [84, 92]], 36)];
  for (const r of ridges) paint(terrain, w, h, T.Hill, r, plainOnly);
  paint(terrain, w, h, T.Forest, ellipse(42, 46, 7, 3, 61));
  paint(terrain, w, h, T.Forest, ellipse(70, 41, 6, 3, 62));
  paint(terrain, w, h, T.Forest, ellipse(52, 86, 5, 2, 63));
  // 中路：大道彎向西橋、過橋直通正門；路旁的土丘（擋箭、架弓）與小樹叢
  road([[0, 63], [28, 63], [52, 61], [72, 63], [88, 66], [96, 69], [98, 69]], 9);
  road([[102, 69], [109, 69]], 9);
  paint(terrain, w, h, T.Hill, ellipse(50, 56, 4, 2, 66), plainOnly);
  paint(terrain, w, h, T.Hill, ellipse(64, 69, 4, 2, 67), plainOnly);
  paint(terrain, w, h, T.Hill, ellipse(80, 56, 3, 2, 68), plainOnly);
  paint(terrain, w, h, T.Forest, ellipse(36, 70, 3, 2, 69), plainOnly);
  // 北路：繞過北嶺、穿過樹林到北橋（林間的路在格子上算樹林）
  road([[16, 58], [26, 46], [44, 34], [66, 22], [96, 16], [140, 15], [166, 15], [166, 22]], 4);
  paint(terrain, w, h, T.Forest, ellipse(56, 27, 8, 5, 70), (c) => c === T.Plain || c === T.Road);
  paint(terrain, w, h, T.Forest, ellipse(86, 15, 9, 4, 71), (c) => c === T.Plain || c === T.Road);
  paint(terrain, w, h, T.Forest, ellipse(122, 10, 10, 4, 72), (c) => c === T.Plain || c === T.Road);
  // 南路：碎石坡與廢村到南淺灘
  road([[16, 68], [26, 80], [44, 94], [66, 106], [96, 116], [118, 121], [132, 121], [132, 117]], 4);
  paint(terrain, w, h, T.Rubble, ellipse(58, 101, 5, 3, 64), plainOnly);
  paint(terrain, w, h, T.Rubble, ellipse(84, 113, 6, 3, 65), plainOnly);
  for (const [bx, by, bw, bh] of [[66, 98, 3, 2], [71, 100, 2, 3], [62, 110, 3, 2], [74, 108, 2, 2], [104, 124, 3, 2]] as const) build('ruin', bx, by, bx + bw - 1, by + bh - 1, { seed: bx });
  // 攻方營地：西端南北兩群營帳（中間留給布陣），衝車出發處北側是器械工坊，營帳旁各一架投石機
  for (const [bx, by] of [[2, 34], [6, 34], [2, 38], [6, 38], [2, 42], [6, 42], [2, 88], [6, 88], [2, 92], [6, 92], [2, 96], [6, 96]] as const) build('tent', bx, by, bx + 2, by + 1, { seed: bx + by });
  build('shed', 9, 56, 14, 58, { face: 1 });
  build('trebuchet', 12, 44, 13, 45, { face: 0 });
  build('trebuchet', 12, 86, 13, 87, { face: 0 });
  const rises = [oval(112, 10, 18, 4), oval(160, 128, 20, 5)];
  // 農田（3D 的地面花紋，格子仍是平地）
  for (const [x0, y0, x1, y1] of [[2, 2, 20, 28], [2, 102, 20, 137], [22, 108, 46, 137], [96, 123, 128, 137], [138, 120, 186, 137], [96, 1, 110, 10], [134, 1, 162, 10], [170, 1, 210, 12], [190, 118, 210, 137]] as const) deco('field', x0, y0, x1, y1, { seed: x0 * 7 + y0 });
  // ── 郭城城牆（四格厚） ──
  const WX0 = 110;
  const WX1 = 210;
  const WY0 = 32;
  const WY1 = 107;
  box(WX0, WY0, WX0 + 3, WY1, T.Wall);
  box(WX1 - 3, WY0, WX1, WY1, T.Wall);
  box(WX0, WY0, WX1, WY0 + 3, T.Wall);
  box(WX0, WY1 - 3, WX1, WY1, T.Wall);
  // 角樓（8 × 8，往外凸兩格，兩層樓）
  for (const [cx, cy] of [[WX0 - 2, WY0 - 2], [WX1 - 5, WY0 - 2], [WX0 - 2, WY1 - 5], [WX1 - 5, WY1 - 5]] as const) {
    box(cx, cy, cx + 7, cy + 7, T.Wall);
    deco('cornerTower', cx, cy, cx + 7, cy + 7, { storeys: 2 });
  }
  // 馬面（往外凸三格，上有敵樓）：北牆三座、南牆三座（西邊那座貼著缺口）、西牆兩座；北側門兩側各一座門樓馬面
  const bastion = (x0: number, y0: number, x1: number, y1: number, face: number): void => {
    box(x0, y0, x1, y1, T.Wall);
    deco('wallTower', x0, y0, x1, y1, { face, storeys: 1 });
  };
  for (const x of [126, 146, 188]) bastion(x, WY0 - 3, x + 5, WY0 - 1, 3);
  for (const x of [122, 150, 188]) bastion(x, WY1 + 1, x + 5, WY1 + 3, 1);
  for (const y of [42, 92]) bastion(WX0 - 3, y, WX0 - 1, y + 5, 2);
  box(161, WY0 - 3, 164, WY0 - 1, T.Wall);
  box(169, WY0 - 3, 172, WY0 - 1, T.Wall);
  // ── 城門與缺口（正門、側門上是城樓） ──
  box(WX0, CY - 1, WX0 + 3, CY + 1, T.Gatehouse);
  deco('gateTower', WX0, CY - 5, WX0 + 3, CY + 5, { face: 2, storeys: 2 });
  box(166, WY0, 167, WY0 + 3, T.Gatehouse);
  deco('gateTower', 163, WY0, 170, WY0 + 3, { face: 3, storeys: 1 });
  const breach = { x0: 130, y0: WY1 - 3, x1: 135, y1: WY1 + 1 };
  box(breach.x0, breach.y0, breach.x1 - 1, breach.y1 - 1, T.Rubble);
  // ── 護城河：三格寬，繞西、北、南三面（東面接大河；西面一直線） ──
  // 過河處：西橋（正對正門，5 格寬）、北橋（側門前）、南牆缺口前一段淤塞成淺灘
  const MX = 99;
  const MY0 = 23;
  const MY1 = 114;
  const moat = (x0: number, y0: number, x1: number, y1: number): void => {
    box(x0, y0, x1, y1, T.River);
    deco('moat', x0, y0, x1, y1);
  };
  moat(MX, MY0, 212, MY0 + 2);
  moat(MX, MY1, 212, MY1 + 2);
  moat(MX, MY0, MX + 2, MY1 + 2);
  box(MX, CY - 2, MX + 2, CY + 2, T.Bridge);
  box(166, MY0, 167, MY0 + 2, T.Bridge);
  box(breach.x0, MY1, breach.x1 - 1, MY1 + 2, T.Shallow);
  // 護城河外岸的柳樹
  const willow = (x: number, y: number): void => {
    if (tAt(x, y) === T.Plain) deco('willow', x, y, x, y, { seed: x * 3 + y });
  };
  for (let x = 104; x <= 208; x += 6) if (Math.abs(x - 166) > 3) willow(x, MY0 - 2);
  for (let x = 104; x <= 208; x += 6) if (x < 127 || x > 138) willow(x, MY1 + 4);
  for (let y = 28; y <= 110; y += 6) willow(MX - 2, y);
  // 城外零星的樹
  for (let y = 2; y < h - 2; y++) {
    for (let x = 22; x < 88; x++) if (tAt(x, y) === T.Plain && roll(x, y, 77) % 160 === 0) deco('tree', x, y, x, y, { seed: roll(x, y, 78) % 1000 });
  }
  // ── 城內的範圍（淹過去鋪石） ──
  const solid = (i: number): boolean => {
    const t = terrain[i];
    return t === T.Wall || t === T.Gatehouse || t === T.River || t === T.Rubble || t === T.Bridge;
  };
  const inside = floodMask(w, h, 150, CY, (i) => !solid(i));
  const archAt = (x: number, y: number, a: { x0: number; y0: number; x1: number; y1: number }): boolean => x >= a.x0 && x < a.x1 && y >= a.y0 && y < a.y1;
  for (let i = 0; i < w * h; i++) if (inside[i] === 1) terrain[i] = T.Paved;
  // ── 第二道防線：內城牆（三格厚、內角樓 5 × 5、西門洞兩側馬面；東面接郭城東牆；三個門洞上有門樓） ──
  const IW = 152;
  const IN = 46;
  const IS = 93;
  box(IW, IN, IW + 2, IS, T.Wall);
  box(IW, IN, WX1 - 4, IN + 2, T.Wall);
  box(IW, IS - 2, WX1 - 4, IS, T.Wall);
  box(IW - 1, IN - 1, IW + 3, IN + 3, T.Wall);
  box(IW - 1, IS - 3, IW + 3, IS + 1, T.Wall);
  deco('cornerTower', IW - 1, IN - 1, IW + 3, IN + 3, { storeys: 1 });
  deco('cornerTower', IW - 1, IS - 3, IW + 3, IS + 1, { storeys: 1 });
  for (const y of [60, 75]) {
    box(IW - 2, y, IW - 1, y + 3, T.Wall);
    deco('wallTower', IW - 2, y, IW + 2, y + 3, { face: 2, storeys: 1 });
  }
  const archInW = { x0: IW, y0: CY - 2, x1: IW + 3, y1: CY + 3 };
  const archInN = { x0: 178, y0: IN, x1: 183, y1: IN + 3 };
  const archInS = { x0: 184, y0: IS - 2, x1: 189, y1: IS + 1 };
  for (const a of [archInW, archInN, archInS]) box(a.x0, a.y0, a.x1 - 1, a.y1 - 1, T.Paved);
  deco('gateTower', IW, CY - 5, IW + 2, CY + 5, { face: 2, storeys: 1 });
  deco('gateTower', archInN.x0 - 2, IN, archInN.x1 + 1, IN + 2, { face: 3, storeys: 1 });
  deco('gateTower', archInS.x0 - 2, IS - 2, archInS.x1 + 1, IS, { face: 1, storeys: 1 });
  // ── 第三道防線：衙署子城（兩格厚城牆、四角小樓、西面五格寬的門洞，門洞上是譙樓） ──
  const CX0 = 182;
  const CX1 = 204;
  const CY0 = 56;
  const CY1 = 83;
  box(CX0, CY0, CX0 + 1, CY1, T.Wall);
  box(CX1 - 1, CY0, CX1, CY1, T.Wall);
  box(CX0, CY0, CX1, CY0 + 1, T.Wall);
  box(CX0, CY1 - 1, CX1, CY1, T.Wall);
  for (const [cx, cy] of [[CX0 - 1, CY0 - 1], [CX1 - 2, CY0 - 1], [CX0 - 1, CY1 - 2], [CX1 - 2, CY1 - 2]] as const) {
    box(cx, cy, cx + 3, cy + 3, T.Wall);
    deco('cornerTower', cx, cy, cx + 3, cy + 3, { storeys: 1 });
  }
  const archCitadel = { x0: CX0, y0: CY - 2, x1: CX0 + 2, y1: CY + 3 };
  box(archCitadel.x0, archCitadel.y0, archCitadel.x1 - 1, archCitadel.y1 - 1, T.Paved);
  deco('gateTower', CX0, CY - 4, CX0 + 1, CY + 4, { face: 2, storeys: 2 });
  // 大堂坐東朝西、南北兩側廂房；院子裡兩棵老樹（B 旗）
  build('hall', 197, 63, 201, 76, { face: 2, storeys: 1 });
  build('hall', 186, 59, 195, 61, { face: 1, storeys: 1 });
  build('hall', 186, 78, 195, 80, { face: 3, storeys: 1 });
  deco('tree', 188, 64, 188, 64, { seed: 5 });
  deco('tree', 188, 74, 188, 74, { seed: 6 });
  // ── 郭城西半：街坊（街與巷是坊與坊之間的空隙） ──
  // 正門內廣場 x 117～126、y 63～75；鼓樓立在大街中間，街從南北兩側繞過去，再到內城西門洞前的廣場（x 141～148、y 61～77）
  build('drumTower', 130, 65, 135, 72, { face: 2, storeys: 2 });
  // 市集：三排攤位
  for (const y of [42, 47]) for (const x of [130, 134, 138]) build('stall', x, y, x + 2, y, { seed: x + y });
  // 寺院：塔、大殿，院裡種樹，入口是牌坊
  build('pagoda', 134, 91, 137, 94, { storeys: 7 });
  build('hall', 140, 94, 147, 98, { face: 3, storeys: 1 });
  deco('pailou', 136, 88, 144, 88, { face: 3 });
  deco('tree', 139, 90, 139, 90, { seed: 11 });
  deco('tree', 145, 91, 145, 91, { seed: 12 });
  deco('tree', 132, 98, 132, 98, { seed: 13 });
  // 民房的坊：北街（x 125～128）、東巷（x 142～144）、北弄（y 52～54）；南街（x 121～124）、東南巷（x 141～144）、南弄（y 85～87）
  houses(117, 39, 124, 51, 1);
  houses(117, 55, 124, 62, 2);
  houses(129, 55, 141, 60, 3);
  houses(145, 39, 148, 51, 4);
  houses(145, 55, 148, 60, 5);
  houses(117, 76, 120, 84, 6);
  houses(117, 88, 120, 100, 7);
  houses(125, 77, 140, 84, 8);
  houses(125, 88, 130, 100, 9);
  houses(145, 78, 148, 84, 10);
  // ── 內城北、南兩側的夾道：營房與糧倉（中間一排，兩側是街；留出側門、門洞的通路） ──
  for (const [x0, x1] of [[156, 163], [170, 176], [185, 192], [196, 204]] as const) build('longhouse', x0, 39, x1, 42, { face: 1, storeys: 1 });
  build('longhouse', 157, 97, 163, 100, { face: 3, storeys: 1 });
  for (const x of [167, 171, 177, 181]) build('silo', x, 97, x + 2, 99);
  for (const [x0, x1] of [[191, 197], [200, 205]] as const) build('longhouse', x0, 97, x1, 100, { face: 3, storeys: 1 });
  // ── 內城：院落民房的坊、牌坊大街（沿街種樹）、子城北南兩側的官署 ──
  houses(158, 52, 173, 64, 21);
  houses(158, 74, 173, 87, 22);
  deco('pailou', 166, 65, 166, 73, { face: 2 });
  for (let x = 159; x <= 172; x += 4) {
    deco('tree', x, 65, x, 65, { seed: x });
    deco('tree', x, 73, x, 73, { seed: x + 1 });
  }
  build('hall', 184, 50, 192, 53, { face: 1, storeys: 1 });
  build('hall', 196, 50, 203, 53, { face: 1, storeys: 1 });
  build('hall', 191, 87, 203, 89, { face: 3, storeys: 1 });
  // ── 走不到的空格（被房舍圍住的小角落）改成房舍 ──
  const reach = floodMask(w, h, 121, CY, (i) => {
    const t = terrain[i];
    return t === T.Paved || t === T.Forest || t === T.Rubble || t === T.Gatehouse;
  });
  for (let i = 0; i < w * h; i++) if (inside[i] === 1 && reach[i] === 0 && (terrain[i] === T.Paved || terrain[i] === T.Forest)) terrain[i] = T.Building;
  // ── 馬道（城牆內側的坡道，上牆用） ──
  const OX0 = WX0 + 4;
  const OY0 = WY0 + 4;
  const OY1 = WY1 - 4;
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
    const castle = x >= 93 && x <= 212 && y >= 26 && y <= 113 && (inside[i] === 1 || t === T.Wall || t === T.Gatehouse || t === T.Rubble);
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
  // ── 守方布陣區：城內、城牆（含角樓、馬面）、門樓、缺口 ──
  const defMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = (i - x) / w;
    if (x < 93 || x > 212 || y < 26 || y > 113) continue;
    const t = terrain[i];
    if (inside[i] === 1 || t === T.Wall || t === T.Gatehouse || t === T.Rubble) defMask[i] = 1;
  }
  const depth = RULES.deployDepthTiles;
  return finishMap({
    id: 'stone-pass',
    name: '石關城',
    description:
      '背靠大河的三重城：郭城（四格厚城牆、角樓、馬面與敵樓、護城河）、內城（三格厚城牆、三個門洞、高一階）、衙署子城（本陣、再高一階）。攻方營地往東分出三條路：中路大道過西橋直撞正門、北路穿過樹林到北橋與側門、南路經碎石坡與淺灘到南牆的瓦礫缺口。郭城西半是街坊：大街在鼓樓前分成兩路，北有市集、南有寺院與塔；內城是院落民房、牌坊大街與官署。',
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
      { name: '正門廣場', x: 121500, y: 69500 },
      { name: '衙署', x: 193500, y: 69500 },
    ].map((f) => ({ ...f, points: 0 })),
    landmarks: [
      { name: '正門', x: 112000, y: 69500 },
      { name: '西橋', x: 100500, y: 69500 },
      { name: '北橋', x: 167000, y: 24500 },
      { name: '南淺灘', x: 132500, y: 115500 },
      { name: '正門廣場', x: 121500, y: 69500 },
      { name: '鼓樓', x: 133000, y: 69000 },
      { name: '市集', x: 135500, y: 45000 },
      { name: '寺院', x: 139500, y: 92000 },
      { name: '內城西門', x: 153500, y: 69500 },
      { name: '內城北門', x: 180500, y: 47500 },
      { name: '內城南門', x: 186500, y: 92500 },
      { name: '牌坊大街', x: 166500, y: 69500 },
      { name: '營房', x: 180500, y: 40500 },
      { name: '糧倉', x: 175500, y: 98500 },
      { name: '官署廣場', x: 177500, y: 69500 },
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
    archways: [archInW, archInN, archInS, archCitadel],
    defender: 1,
    // 衝車軌道：營地的衝車起點 → 中路大道 → 西橋 → 正門外的撞擊點（離門 1.5 格）
    ramTrack: [
      // 起點在營地前方的大道上（布陣區外 26 格）：推到正門約 63.4 格
      { x: 46000, y: 61500 },
      { x: 52500, y: 61500 },
      { x: 72500, y: 63500 },
      { x: 88500, y: 66500 },
      { x: 96500, y: 69500 },
      { x: (WX0 - 1) * TILE - TILE / 2, y: CY * TILE + TILE / 2 },
    ],
    bombardFrom: 180,
    siegeEntry: { x: 92500, y: 68500 },
    decor,
  });
}

/**
 * 佔點地圖「大草原」：240 × 150 格，旋轉 180° 對稱。開闊的起伏草原，騎兵有利。
 * 三面旗排成一條西北—東南的斜線：中央是十字路口的驛站（2 分），西北丘、東南丘各有一座烽火台遺跡（1 分），離中央約 60 格；
 * 西北丘離藍方陣地近、東南丘離紅方陣地近，中央兩邊一樣遠。
 * 道路連成環：一條環路繞過雙方陣地與兩座烽火台丘；斜貫中央的大道把三面旗串成一線；東西大道從雙方陣地直通驛站。
 * 四處是小塊的樹林與岩堆（瓦礫）、幾處緩坡與小丘、一個池塘；擋路的地形加起來不到全圖 5%，大部分仍是騎兵能奔馳的開闊地。
 * 3D 畫面用的道路折線、農田、烽火台記在 decor。
 */
export function grassland(): LegionMap {
  const w = 240;
  const h = 150;
  const half = idiv(h, 2);
  const terrain = new Uint8Array(w * h);
  const heights = new Uint8Array(w * h).fill(1);
  const decor: MapDecor[] = [];
  const W = w * TILE;
  const H = h * TILE;
  const box = (x0: number, y0: number, x1: number, y1: number, t: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) terrain[y * w + x] = t;
  };
  /** 3D 外觀：上半部的一份，連同旋轉 180° 的那一份（輸入的範圍含兩端） */
  const decoPair = (kind: DecorKind, x0: number, y0: number, x1: number, y1: number, more: DecorMore = {}): void => {
    decor.push({ kind, x0, y0, x1: x1 + 1, y1: y1 + 1, ...more });
    decor.push({ kind, x0: w - 1 - x1, y0: h - 1 - y1, x1: w - x0, y1: h - y0, ...more, face: more.face === undefined ? undefined : (more.face + 2) % 4 });
  };
  // 道路（整條畫，本來就對稱）：格子畫成道路，3D 照折線畫
  const road = (pts: [number, number][], halfWidth2: number): void => {
    paint(terrain, w, h, T.Road, polyline(pts, halfWidth2));
    decor.push({ kind: 'road', x0: 0, y0: 0, x1: 0, y1: 0, pts, width: isqrt(halfWidth2) });
  };
  // 以下的地形只畫上半部（列 0～74），最後旋轉 180° 複製成下半部
  // 烽火台丘（西北，側旗所在；山頂 4 階）、小丘與緩坡（2 階）
  const flagHill = oval(80, 30, 9, 7);
  const knolls = [oval(30, 22, 5, 4), oval(172, 36, 6, 4), oval(214, 12, 5, 3)];
  const rises = [oval(80, 30, 15, 11), oval(46, 56, 10, 7), oval(150, 46, 12, 6), oval(196, 22, 10, 6), oval(104, 58, 6, 4)];
  paint(terrain, w, h, T.Hill, flagHill);
  for (const k of knolls) paint(terrain, w, h, T.Hill, k);
  // 小塊樹林（不規則的邊）與岩堆
  const groves: [number, number, number, number][] = [
    [36, 40, 3, 2], [58, 18, 4, 2], [66, 48, 3, 2], [96, 40, 3, 3], [104, 10, 4, 2], [132, 32, 3, 2], [140, 56, 3, 2], [176, 10, 4, 2],
    [192, 40, 3, 2], [206, 62, 3, 2], [92, 64, 2, 2], [44, 66, 3, 2], [226, 30, 3, 2], [16, 20, 3, 2], [124, 46, 2, 2], [160, 24, 2, 2],
    [60, 4, 3, 2], [186, 56, 2, 2], [74, 8, 2, 1], [150, 30, 2, 2], [168, 52, 2, 2], [112, 48, 2, 1], [38, 10, 2, 1], [200, 32, 2, 1], [126, 20, 2, 1], [84, 52, 2, 2],
  ];
  groves.forEach(([cx, cy, rx, ry], k) => paint(terrain, w, h, T.Forest, ellipse(cx, cy, rx, ry, 80 + k), (c) => c === T.Plain || c === T.Hill));
  const rocks: [number, number, number, number][] = [
    [52, 28, 2, 1], [114, 34, 1, 1], [146, 14, 2, 1], [70, 62, 1, 1], [200, 50, 2, 1], [24, 56, 1, 1], [166, 64, 1, 1], [128, 8, 1, 1], [90, 18, 1, 1], [218, 66, 2, 1], [100, 30, 1, 1], [180, 44, 1, 1], [62, 40, 1, 1],
  ];
  rocks.forEach(([cx, cy, rx, ry], k) => paint(terrain, w, h, T.Rubble, ellipse(cx, cy, rx, ry, 120 + k), (c) => c === T.Plain || c === T.Hill));
  // 池塘（淺灘）
  paint(terrain, w, h, T.Shallow, ellipse(58, 62, 3, 2, 71), (c) => c === T.Plain);
  // 道路：斜貫中央的大道（三面旗）、東西大道（陣地 → 驛站）、繞全圖的環路
  road([[80, 30], [100, 52], [120, 75], [140, 98], [160, 120]], 9);
  road([[0, 75], [40, 72], [80, 76], [120, 75], [160, 74], [200, 78], [240, 75]], 9);
  road([[12, 75], [24, 52], [50, 34], [80, 30], [112, 18], [150, 16], [186, 24], [214, 46], [228, 75], [216, 98], [190, 116], [160, 120], [128, 132], [90, 134], [54, 126], [26, 104], [12, 75]], 4);
  // 驛站：十字路口四周的房舍（中央留 7 格空地給旗圈）
  for (const [x0, y0, x1, y1] of [[109, 64, 112, 66], [113, 60, 115, 62], [127, 63, 130, 65], [125, 59, 127, 60], [132, 68, 133, 70]] as const) {
    box(x0, y0, x1, y1, T.Building);
    decoPair('house', x0, y0, x1, y1, { face: y1 < 64 ? 1 : x0 > 120 ? 2 : 0, storeys: 1, seed: x0 + y0, thatch: true });
  }
  // 烽火台遺跡（西北丘頂東側）
  box(84, 27, 85, 28, T.Building);
  decoPair('ruin', 84, 27, 85, 28, { seed: 84 });
  // 驛站外的幾塊田（3D 的地面花紋，格子仍是平地）
  for (const [x0, y0, x1, y1] of [[90, 52, 104, 60], [136, 54, 152, 64], [100, 4, 120, 12], [196, 4, 220, 12], [4, 2, 20, 16]] as const) decoPair('field', x0, y0, x1, y1, { seed: x0 * 7 + y0 });
  // 高度
  const tops = [oval(80, 30, 4, 3)];
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      const hill = t === T.Hill || flagHill(x, y) || knolls.some((p) => p(x, y));
      if (t === T.Shallow) heights[i] = 0;
      else if (t === T.Building) heights[i] = flagHill(x, y) ? 3 : 1;
      else if (hill) heights[i] = tops.some((p) => p(x, y)) ? 4 : 3;
      else if (rises.some((p) => p(x, y))) heights[i] = 2;
    }
  }
  rotateHalf(terrain);
  rotateHalf(heights);
  const depth = RULES.deployDepthTiles;
  const nw = { x: 80500, y: 30500 };
  const rot = (p: { x: number; y: number }, name: string): FlagPoint => ({ name, x: W - p.x, y: H - p.y });
  return finishMap({
    id: 'grassland',
    name: '大草原',
    description:
      '開闊起伏的草原，騎兵有利。三面旗排成西北—東南的斜線：中央十字路口的驛站插著中央旗，西北丘、東南丘各有一座烽火台遺跡與側旗，離中央約 60 格（西北丘靠近藍方、東南丘靠近紅方）。一條環路繞過雙方陣地與兩座烽火台丘，斜貫中央的大道把三面旗串成一線；四處是小塊樹林、岩堆與緩坡。',
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
    // 補給站：西北丘山腳西南、東南丘山腳東北，歸佔著那座山丘的一方
    supplies: [
      { x: nw.x - 12000, y: nw.y + 8000, flag: 0 },
      { x: W - nw.x + 12000, y: H - nw.y - 8000, flag: 2 },
    ],
    flags: [
      { name: '西北烽火台', x: nw.x, y: nw.y, points: 1 },
      { name: '十字路口驛站', x: W / 2, y: H / 2, points: 2 },
      { ...rot(nw, '東南烽火台'), points: 1 },
    ],
    landmarks: [
      { name: '西北烽火台', x: nw.x, y: nw.y },
      { name: '十字路口驛站', x: W / 2, y: H / 2 },
      rot(nw, '東南烽火台'),
      { name: '西北池塘', x: 58500, y: 62500 },
      rot({ x: 58500, y: 62500 }, '東南池塘'),
      { name: '西邊緩坡', x: 46500, y: 56500 },
      rot({ x: 46500, y: 56500 }, '東邊緩坡'),
      { name: '北邊緩坡', x: 150500, y: 46500 },
      rot({ x: 150500, y: 46500 }, '南邊緩坡'),
      { name: '東北小丘', x: 172500, y: 36500 },
      rot({ x: 172500, y: 36500 }, '西南小丘'),
      { name: '北環路', x: 150500, y: 16500 },
      rot({ x: 150500, y: 16500 }, '南環路'),
      { name: '藍方陣地', x: 10000, y: H / 2 },
      { name: '紅方陣地', x: W - 10000, y: H / 2 },
    ],
    gates: [],
    defender: -1,
    decor,
  });
}

/**
 * 沙盒地圖「平地測試場」：160 × 100 格，只給觀戰網頁的自訂對戰用（不對稱，正式比賽不用）。
 * 中央（x 20～140、y 34～66）是一整片高度 1 的平地；北側由西到東：高地（3，頂 4）、樹林、一段有橋與淺灘渡口的河；
 * 南側由西到東：有房舍擋視線的村莊、緩坡（高度 2，只差 1 階）、淺水池
 */
export function testField(): LegionMap {
  const w = 160;
  const h = 100;
  const terrain = new Uint8Array(w * h);
  const heights = new Uint8Array(w * h).fill(1);
  const hill = ellipse(36, 18, 13, 9, 11);
  const top = ellipse(36, 18, 6, 4, 12);
  const slope = ellipse(80, 84, 13, 8, 13);
  paint(terrain, w, h, T.Hill, hill);
  paint(terrain, w, h, T.Forest, ellipse(78, 17, 12, 8, 14));
  paint(terrain, w, h, T.Shallow, ellipse(122, 83, 11, 7, 15));
  // 村莊：一條村道穿過，兩旁幾棟房舍
  paint(terrain, w, h, T.Road, polyline([[12, 83], [54, 83]], 4));
  for (const [x0, y0, x1, y1] of [[27, 77, 31, 80], [35, 77, 39, 80], [29, 86, 33, 89], [38, 86, 42, 89], [46, 78, 49, 80]]) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) terrain[y * w + x] = T.Building;
  }
  // 東北：一段南北向的河（寬 6 格），北邊一座 3 格寬的橋、南邊一處淺灘渡口；河的南端在 y 31，可以從下方繞過
  for (let y = 2; y <= 31; y++) {
    for (let x = 117; x <= 122; x++) terrain[y * w + x] = y >= 8 && y <= 10 ? T.Bridge : y >= 20 && y <= 25 ? T.Shallow : T.River;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t === T.River || t === T.Shallow) heights[i] = 0;
      else if (t === T.Hill) heights[i] = top(x, y) ? 4 : 3;
      else if (t === T.Plain && slope(x, y)) heights[i] = 2;
    }
  }
  const depth = RULES.deployDepthTiles;
  return finishMap({
    id: 'test-field',
    name: '平地測試場',
    description: '中央一整片平地；北側有高地、樹林、一段有橋與淺灘的河，南側有村莊、緩坡與淺水池，用來測試兵種對抗與地形效果。',
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
    flags: [
      { name: '西北高地', x: 36500, y: 18500, points: 1 },
      { name: '中央平原', x: 80000, y: 50000, points: 2 },
      { name: '南方緩坡', x: 80500, y: 84500, points: 1 },
    ],
    landmarks: [
      { name: '中央平原', x: 80000, y: 50000 },
      { name: '西北高地', x: 36500, y: 18500 },
      { name: '北方樹林', x: 78500, y: 17500 },
      { name: '東北的橋', x: 120000, y: 9500 },
      { name: '東北的淺灘渡口', x: 120000, y: 23000 },
      { name: '西南村莊', x: 34500, y: 83500 },
      { name: '南方緩坡', x: 80500, y: 84500 },
      { name: '東南淺水池', x: 122500, y: 83500 },
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
  'test-field': once(testField),
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
  /** 衝車軌道（單位座標的折線，起點 ＝ 衝車開局位置、終點 ＝ 正門外的撞擊點）；沒有衝車的地圖是空陣列 */
  readonly ramTrack: readonly { readonly x: number; readonly y: number }[];
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
  const ramTrack = (m.ramTrack ?? []).map((q) => ({ x: q.x, y: q.y }));
  const f: MapFeatures = { walls, gates, stairs, chokes, highs, covers, ramTrack };
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
