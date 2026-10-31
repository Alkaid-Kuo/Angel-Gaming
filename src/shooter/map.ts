// CS 射擊地圖：以「在實心裡挖矩形」描述，再轉成格子。
// 第一張圖「沙城」參照 Dust2：北為 CT、南為 T，中路南北直線，A 長在東、B 通道在西（v0.5 起只供引擎測試）。
// 第二張圖「赤岩鎮」（v0.5 預設）只借三路骨架，格局原創；用多邊形做斜牆、加矮牆。
// 座標：格為單位的整數矩形，含 x0/y0、不含 x1/y1。1 格 = 1 公尺 = UNIT 座標單位。
import redrock2File from '../../maps/shooter/redrock2-v4.json' with { type: 'json' };
import type { MapInfo, MapRegion } from './api.ts';
import { TEAM_SIZE, UNIT, type Team } from './config.ts';

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface MapSpawn {
  readonly x: number;
  readonly y: number;
  readonly facing: number;
}

/** 區域的地面材質（只給畫面用，引擎不讀，不進 MapInfo） */
export type MapMaterial = 'stone' | 'dirt' | 'wood' | 'market' | 'plaza' | 'site';

export interface MapLayout {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /**
   * 依序挖開的區域（代號＝ callout）。callout：這個框併進哪個區域（門洞、轉角），regions 裡用那個區域的代號與名稱，
   * 框本身留著，所以格子與 Bot 的路線圖都不變；主區域要排在併進來的框前面（選手用代號找區域時拿到第一個框）
   */
  readonly areas: readonly (Rect & { readonly id: string; readonly name: string; readonly material?: MapMaterial; readonly callout?: string })[];
  /** 挖開之後再填回去的實心（箱子、柱子） */
  readonly blocks: readonly Rect[];
  /**
   * 多邊形（格座標頂點，格中心落在多邊形內的格）：open = 挖開、wall = 填回牆、low = 填矮牆；在矩形之後依序處理（v0.5）。
   * slope（v1.1）：邊只用水平、垂直、45°，頂點在格點上，斜邊經過的格變成半格的斜切格（沒標的多邊形照舊成鋸齒）
   */
  readonly polys?: readonly { readonly mode: 'open' | 'wall' | 'low'; readonly slope?: boolean; readonly pts: readonly (readonly [number, number])[] }[];
  /** 矮牆（v0.5）：擋移動；只有蹲著的人貼近時才擋視線與子彈（VISION.lowCoverRange），道具飛得過去 */
  readonly low?: readonly Rect[];
  readonly sites: readonly (Rect & { readonly id: 'A' | 'B' })[];
  readonly spawnZones: Readonly<Record<Team, Rect>>;
  readonly spawns: Readonly<Record<Team, readonly MapSpawn[]>>;
}

export interface ShooterMap {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 列優先；0 = 可走、1 = 牆、2 = 矮牆（v0.5） */
  readonly solid: Uint8Array;
  readonly sites: readonly (Rect & { readonly id: 'A' | 'B' })[];
  readonly spawnZones: Readonly<Record<Team, Rect>>;
  readonly spawns: Readonly<Record<Team, readonly MapSpawn[]>>;
  readonly regions: readonly MapRegion[];
}

const R = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });
const A = (id: string, name: string, x0: number, y0: number, x1: number, y1: number): Rect & { id: string; name: string } => ({ id, name, x0, y0, x1, y1 });

/** 出生點：在出生區內橫向排開，座標為格中心 */
function spawnRow(xs: readonly number[], y: number, facing: number): MapSpawn[] {
  return xs.map((x) => ({ x: x * UNIT + UNIT / 2, y: y * UNIT + UNIT / 2, facing }));
}

/**
 * 沙城（參照 Dust2）。120×120 格。
 *
 *   B 點 ── B 門 ── CT 中路 ─ CT 斜坡 ─ CT 出生 ─┐
 *    │                │                  A 點 ── A 斜坡
 *   通道            中路門              │          │
 *    │                │              短道頂       A 長
 *   通道下 ───── T 中路               短道         │
 *    │                │                 │        長門
 *    └──── T 出生 ────┴──── 貓道 ───────┘   外長 ──┘
 *
 * CT 出生與 CT 中路不直接相通，改經西側的 CT 斜坡：T 出生區與 CT 出生區之間沒有任何直線視線
 *（中路門往北的直線被 CT 中路北緣的牆擋住；進斜坡的線一定往西北走，到不了 CT 出生）。
 */
export const DUST_LAYOUT: MapLayout = {
  id: 'dust',
  name: '沙城',
  width: 120,
  height: 120,
  areas: [
    // T 側
    A('tSpawn', 'T 出生', 34, 100, 70, 116),
    A('outsideTunnels', '通道口', 20, 104, 34, 110),
    A('tunnelsUpper', '上通道', 12, 70, 20, 106),
    A('tunnelsLower', '下通道', 20, 80, 48, 86),
    A('tunnelsExit', '通道出口', 12, 44, 20, 70),
    A('tMid', 'T 中路', 48, 72, 60, 100),
    A('outsideLong', '外長', 70, 104, 92, 110),
    A('longDoors', '長門', 92, 98, 100, 106),
    // 中路
    A('mid', '中路', 50, 42, 62, 72),
    A('midDoors', '中路門', 53, 38, 60, 42),
    A('catwalk', '貓道', 62, 62, 84, 68),
    A('short', '短道', 78, 36, 86, 62),
    A('shortTop', '短道頂', 78, 26, 90, 36),
    // A 側
    A('long', 'A 長', 100, 32, 112, 106),
    A('pit', '長坑', 112, 92, 118, 104),
    A('aRamp', 'A 斜坡', 96, 26, 112, 32),
    A('aSite', 'A 點', 86, 6, 108, 26),
    A('ctToA', 'CT 往 A', 84, 8, 86, 14),
    // CT 側與 B
    A('ctSpawn', 'CT 出生', 56, 2, 84, 16),
    A('ctMid', 'CT 中路', 46, 16, 66, 38),
    A('ctRamp', 'CT 斜坡', 46, 10, 56, 16),
    A('bDoors', 'B 門', 32, 26, 48, 32),
    A('bSite', 'B 點', 8, 20, 32, 44),
  ],
  blocks: [
    // 中路門的門柱
    R(56, 38, 57, 42),
    // 中路的大箱（Xbox）
    R(54, 60, 58, 63),
    // A 點箱子
    R(92, 12, 95, 15),
    R(100, 18, 103, 21),
    // B 點箱子
    R(14, 30, 17, 33),
    R(22, 24, 25, 27),
    // 長門的門柱
    R(95, 101, 97, 103),
    // 貓道口的矮牆（擋住中路直接看貓道深處）
    R(66, 62, 67, 64),
    // CT 中路北緣：封掉與 CT 出生的直接相連，只留西側 x 46～51 通 CT 斜坡
    R(52, 16, 66, 18),
  ],
  sites: [
    { id: 'A', x0: 90, y0: 8, x1: 104, y1: 22 },
    { id: 'B', x0: 10, y0: 22, x1: 28, y1: 40 },
  ],
  spawnZones: {
    T: R(34, 100, 70, 116),
    CT: R(56, 2, 84, 16),
  },
  spawns: {
    T: spawnRow([40, 46, 52, 58, 64], 108, 270),
    CT: spawnRow([58, 63, 68, 73, 78], 8, 90),
  },
};

/**
 * 赤岩鎮（v0.5，原創格局）。120×120 格，北為 CT、南為 T，A 在東、B 在西。
 * 借用的只有這類地圖的通用骨架：三條路線（東長廊、中央大道、西側地窖）、兩個包點、長距離對線、出生區之間沒有直線視線。
 *
 *   B 包點 ─ B 西門 ─ 北街 ─ CT 坡道 ─ CT 營地 ─ CT 後巷 ─ A 包點
 *    │  │              │                                  │   │
 *   地窖口（兩個）     拱門                             石階  東長廊
 *    │  │              │                                  │   │
 *   地窖大廳         中央大道 ─────── 鐘樓步道 ────────────┘  藏兵角
 *    │                 │                                      │
 *   地窖 ─── 側巷 ─────┤                                    東門
 *    │                南街                                    │
 *   西市集 ───────── T 廣場 ─────────── 東巷 ─────────────────┘
 *
 * 中央大道是南北直線，北端的北街北緣是牆，CT 營地只經東側的 CT 坡道通北街：T 廣場與 CT 營地之間沒有直線視線。
 * 矮牆（=）：站著的人越過去看得到也打得到，蹲在後面就看不見、打不到。
 */
export const REDROCK_LAYOUT: MapLayout = {
  id: 'redrock',
  name: '赤岩鎮',
  width: 120,
  height: 120,
  areas: [
    // T 側
    A('tSpawn', 'T 廣場', 38, 98, 82, 114),
    A('market', '西市集', 12, 94, 40, 112),
    A('eastLane', '東巷', 80, 100, 112, 110),
    // 西路：地窖
    A('cellar', '地窖', 20, 62, 28, 96),
    A('sideAlley', '側巷', 28, 62, 52, 68),
    A('cellarHall', '地窖大廳', 8, 44, 32, 62),
    A('cellarWest', '地窖西口', 10, 36, 18, 46),
    A('cellarEast', '地窖東口', 24, 36, 32, 46),
    // 中路
    A('tMid', '南街', 54, 76, 66, 100),
    A('mid', '中央大道', 52, 40, 68, 76),
    A('arch', '拱門', 55, 34, 65, 40),
    A('belfry', '鐘樓步道', 68, 46, 90, 54),
    A('steps', '石階', 84, 28, 94, 54),
    // 東路
    A('eastGate', '東門', 100, 76, 112, 104),
    A('longHall', '東長廊', 98, 34, 114, 76),
    A('nook', '藏兵角', 92, 56, 98, 64),
    // 包點與 CT 側
    A('aSite', 'A 包點', 86, 6, 114, 36),
    A('ctAlley', 'CT 後巷', 76, 6, 86, 14),
    A('ctSpawn', 'CT 營地', 50, 4, 76, 18),
    A('ctRamp', 'CT 坡道', 72, 14, 80, 22),
    A('northSt', '北街', 44, 22, 80, 34),
    A('bGate', 'B 西門', 36, 24, 46, 32),
    A('bSite', 'B 包點', 6, 6, 38, 38),
  ],
  blocks: [
    // 拱門中柱：分成左右兩個門洞
    R(59, 34, 61, 38),
    // 東門門柱：中間留 6 格
    R(100, 80, 103, 84),
    R(109, 80, 112, 84),
    // 北街北緣：封住北街與 CT 營地之間（只留 CT 坡道）
    R(50, 18, 72, 22),
    // A 包點的石柱與 B 包點的井
    R(104, 14, 107, 17),
    R(16, 18, 19, 21),
    // 中央大道的石墩
    R(63, 58, 66, 61),
  ],
  polys: [
    // T 廣場四角削斜
    { mode: 'wall', pts: [[38, 98], [46, 98], [38, 104]] },
    { mode: 'wall', pts: [[82, 98], [74, 98], [82, 104]] },
    { mode: 'wall', pts: [[38, 114], [44, 114], [38, 109]] },
    // 西市集斜邊、東巷南側斜邊
    { mode: 'wall', pts: [[12, 94], [20, 94], [12, 102]] },
    { mode: 'wall', pts: [[80, 110], [92, 110], [80, 106]] },
    // 中央大道南口斜坡（往南街收窄）
    { mode: 'wall', pts: [[52, 70], [54, 70], [54, 76], [52, 76]] },
    { mode: 'open', pts: [[66, 70], [70, 76], [66, 76]] },
    // 鐘樓步道斜接石階
    { mode: 'open', pts: [[84, 54], [90, 54], [94, 50], [94, 46]] },
    // A 包點：東北角削斜、西南角斜坡
    { mode: 'wall', pts: [[114, 6], [106, 6], [114, 12]] },
    { mode: 'wall', pts: [[86, 36], [86, 28], [84, 36]] },
    // B 包點：西北角削斜、東南角斜邊
    { mode: 'wall', pts: [[6, 6], [14, 6], [6, 13]] },
    { mode: 'wall', pts: [[38, 38], [38, 33], [33, 38]] },
    // 地窖大廳的斜牆
    { mode: 'wall', pts: [[8, 62], [8, 54], [14, 62]] },
    // 東長廊西側凹位
    { mode: 'wall', pts: [[98, 40], [98, 48], [100, 48], [100, 40]] },
  ],
  low: [
    // A 包點的箱子
    R(92, 16, 95, 18),
    R(96, 24, 98, 27),
    R(108, 26, 111, 28),
    // B 包點的箱子
    R(24, 14, 27, 16),
    R(12, 28, 14, 31),
    R(28, 28, 31, 30),
    // 中央大道、東長廊、北街的掩體
    R(56, 50, 59, 52),
    R(104, 60, 107, 62),
    R(66, 26, 69, 28),
    // 地窖大廳
    R(18, 52, 21, 54),
  ],
  sites: [
    { id: 'A', x0: 90, y0: 10, x1: 110, y1: 30 },
    { id: 'B', x0: 10, y0: 10, x1: 32, y1: 32 },
  ],
  spawnZones: {
    T: R(44, 100, 76, 112),
    CT: R(52, 5, 74, 17),
  },
  spawns: {
    T: spawnRow([48, 54, 60, 66, 72], 106, 270),
    CT: spawnRow([54, 58, 63, 67, 71], 10, 90),
  },
};

/**
 * 赤岩舊城（v1.1，使用者用地圖編輯器畫的）。資料在 maps/shooter/，編輯器的 JSON 就是 MapLayout。
 * 編輯器照檔案內的 id 存檔、一個版本一個檔，所以引擎代號在這裡固定；換版本只改上面那行 import。
 */
export const REDROCK2_LAYOUT: MapLayout = { ...(redrock2File as unknown as MapLayout), id: 'redrock2', name: '赤岩舊城' };

export function buildMap(layout: MapLayout): ShooterMap {
  const { width, height } = layout;
  const solid = new Uint8Array(width * height).fill(1);
  const carve = (r: Rect, v: number): void => {
    for (let y = Math.max(0, r.y0); y < Math.min(height, r.y1); y++) {
      for (let x = Math.max(0, r.x0); x < Math.min(width, r.x1); x++) solid[y * width + x] = v;
    }
  };
  for (const a of layout.areas) carve(a, 0);
  for (const b of layout.blocks) carve(b, 1);
  for (const p of layout.polys ?? []) {
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    for (const [px, py] of p.pts) {
      x0 = Math.min(x0, Math.floor(px));
      y0 = Math.min(y0, Math.floor(py));
      x1 = Math.max(x1, Math.ceil(px));
      y1 = Math.max(y1, Math.ceil(py));
    }
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        const k = y * width + x;
        if (p.slope === true) solid[k] = cutCell(solid[k], p.mode, polyCover(p.pts, x, y));
        else if (inPolygon(p.pts, x + 0.5, y + 0.5)) solid[k] = p.mode === 'open' ? 0 : p.mode === 'low' ? 2 : 1;
      }
    }
  }
  for (const r of layout.low ?? []) carve(r, 2);
  // 外框永遠是牆
  for (let x = 0; x < width; x++) {
    solid[x] = 1;
    solid[(height - 1) * width + x] = 1;
  }
  for (let y = 0; y < height; y++) {
    solid[y * width] = 1;
    solid[y * width + width - 1] = 1;
  }
  for (const t of ['T', 'CT'] as const) {
    if (layout.spawns[t].length < TEAM_SIZE) throw new Error(`地圖 ${layout.id}：${t} 出生點不足 ${TEAM_SIZE} 個`);
  }
  return {
    id: layout.id,
    name: layout.name,
    width,
    height,
    solid,
    sites: layout.sites,
    spawnZones: layout.spawnZones,
    spawns: layout.spawns,
    regions: layout.areas.map((a) => {
      const c = a.callout === undefined ? a : layout.areas.find((o) => o.id === a.callout);
      if (c === undefined) throw new Error(`地圖 ${layout.id}：區域 ${a.id} 併入的 ${a.callout} 不存在`);
      return { id: c.id, name: c.name, x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 };
    }),
  };
}

export const MAPS: Readonly<Record<string, () => ShooterMap>> = {
  dust: () => buildMap(DUST_LAYOUT),
  redrock: () => buildMap(REDROCK_LAYOUT),
  redrock2: () => buildMap(REDROCK2_LAYOUT),
};

/** 預設地圖（v0.5 起為赤岩鎮；沙城保留給引擎測試與驗收情境） */
export const DEFAULT_MAP_ID = 'redrock';

/** 點是否在多邊形內（偶奇規則；地圖建構用，頂點為格座標小數） */
function inPolygon(pts: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 斜切格（v1.1）：solid 的 3～6 是斜切牆、7～10 是斜切矮牆，值減去基底是實心角（0 西北、1 東北、2 東南、3 西南）。
 * 實心的是貼著那個角的 45° 三角形，另一半可走。格子層（尋路、區域）把斜切格當整格擋，碰撞與射線才算實際形狀
 */
export const SLOPE_WALL = 3;
export const SLOPE_LOW = 7;

/** 只讀格子的介面：引擎地圖與給選手的 MapInfo 都符合 */
export type CellGrid = Pick<ShooterMap, 'width' | 'height'> & { readonly solid: ArrayLike<number> };

/** 格值的實心角；不是斜切格回傳 −1 */
export const slopeCorner = (v: number): number => (v < SLOPE_WALL ? -1 : (v - SLOPE_WALL) % 4);

/** 把格值改成 mode 蓋過之後的結果。cover：−2 沒蓋到、−1 蓋滿、0～3 只蓋到貼著該角的半格 */
function cutCell(v: number, mode: 'open' | 'wall' | 'low', cover: number): number {
  if (cover === -2) return v;
  if (mode === 'open') {
    if (cover === -1) return 0;
    if (v === 1 || v === 2) return (v === 1 ? SLOPE_WALL : SLOPE_LOW) + ((cover + 2) % 4);
    return slopeCorner(v) === cover ? 0 : v;
  }
  const full = mode === 'wall' ? 1 : 2;
  if (cover === -1) return full;
  const base = full === 1 ? SLOPE_WALL : SLOPE_LOW;
  if (v === 0) return base + cover;
  // 同材質的兩個對角半格合成一整格
  return v === base + ((cover + 2) % 4) ? full : v;
}

/** 多邊形蓋住格 (x, y) 的部分：兩條對角線把格切成四塊，45° 的邊不會切過任何一塊（回傳值同 cutCell 的 cover） */
function polyCover(pts: readonly (readonly [number, number])[], x: number, y: number): number {
  const n = inPolygon(pts, x + 0.5, y + 0.25);
  const e = inPolygon(pts, x + 0.75, y + 0.5);
  const s = inPolygon(pts, x + 0.5, y + 0.75);
  const w = inPolygon(pts, x + 0.25, y + 0.5);
  const count = Number(n) + Number(e) + Number(s) + Number(w);
  if (count >= 3) return -1;
  if (count < 2) return -2;
  if (n && w) return 0;
  if (n && e) return 1;
  if (s && e) return 2;
  if (s && w) return 3;
  return -2;
}

/** 格座標是否為牆（擋視線、子彈、道具；含斜切牆，不含矮牆）；出界視為牆 */
export function isSolidCell(map: CellGrid, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return true;
  const v = map.solid[cy * map.width + cx];
  return v === 1 || (v >= SLOPE_WALL && v < SLOPE_LOW);
}

/** 格座標是否為矮牆（v0.5；含斜切矮牆） */
export function isLowCell(map: CellGrid, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return false;
  const v = map.solid[cy * map.width + cx];
  return v === 2 || v >= SLOPE_LOW;
}

/** 格座標是否擋移動（牆或矮牆，斜切格算整格）；出界視為擋 */
export function blocksMove(map: CellGrid, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return true;
  return map.solid[cy * map.width + cx] !== 0;
}

/** 格 (cx, cy) 的實心角；不是斜切格或出界回傳 −1 */
export function slopeAt(map: CellGrid, cx: number, cy: number): number {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return -1;
  return slopeCorner(map.solid[cy * map.width + cx]);
}

/** 斜面朝可走那一側的法線（分量 ±1） */
export function slopeNormal(corner: number): readonly [number, number] {
  return corner === 0 ? [1, 1] : corner === 1 ? [-1, 1] : corner === 2 ? [-1, -1] : [1, -1];
}

/** 換到以實心角為原點、朝格內為正的本地座標：實心三角形是 u ≥ 0、v ≥ 0、u + v ≤ UNIT */
function slopeLocal(cx: number, cy: number, corner: number, x: number, y: number): readonly [number, number] {
  const u = corner === 0 || corner === 3 ? x - cx * UNIT : (cx + 1) * UNIT - x;
  const v = corner === 0 || corner === 1 ? y - cy * UNIT : (cy + 1) * UNIT - y;
  return [u, v];
}

/** 點到斜切格實心三角形的距離平方（點在三角形內為 0） */
export function slopeDistSq(cx: number, cy: number, corner: number, x: number, y: number): number {
  const [u, v] = slopeLocal(cx, cy, corner, x, y);
  if (u >= 0 && v >= 0 && u + v <= UNIT) return 0;
  const clampU = Math.max(0, Math.min(UNIT, u));
  const clampV = Math.max(0, Math.min(UNIT, v));
  const legU = (u - clampU) * (u - clampU) + v * v;
  const legV = u * u + (v - clampV) * (v - clampV);
  // 斜邊上最近的點：(UNIT + s, UNIT − s) / 2
  const s = Math.max(-UNIT, Math.min(UNIT, u - v));
  const du = u - (UNIT + s) / 2;
  const dv = v - (UNIT - s) / 2;
  return Math.min(legU, legV, du * du + dv * dv);
}

/**
 * 線段 a→b 進入斜切格實心三角形時沿線段的參數，分數 [分子, 分母]（0～1，整數運算）；碰不到回傳 null。
 * 碰到邊界就算：相鄰斜切格的接縫不漏視線與子彈
 */
export function slopeEntry(cx: number, cy: number, corner: number, ax: number, ay: number, bx: number, by: number): readonly [number, number] | null {
  const [ua, va] = slopeLocal(cx, cy, corner, ax, ay);
  const [ub, vb] = slopeLocal(cx, cy, corner, bx, by);
  const du = ub - ua;
  const dv = vb - va;
  let inNum = 0;
  let inDen = 1;
  let outNum = 1;
  let outDen = 1;
  // 三條邊各是一個半平面 g ≤ 0：起點的 g、沿線段的變化量
  for (const [g, d] of [[-ua, -du], [-va, -dv], [ua + va - UNIT, du + dv]]) {
    if (d === 0) {
      if (g > 0) return null;
    } else if (d < 0) {
      if (g * inDen > inNum * -d) {
        inNum = g;
        inDen = -d;
      }
    } else if (-g * outDen < outNum * d) {
      outNum = -g;
      outDen = d;
    }
  }
  return inNum * outDen > outNum * inDen ? null : [inNum, inDen];
}

/** 斜切格可走半邊裡的一點（座標單位） */
export function slopeFreePoint(cx: number, cy: number, corner: number): readonly [number, number] {
  const far = (UNIT * 3) / 4;
  const near = UNIT / 4;
  return [cx * UNIT + (corner === 0 || corner === 3 ? far : near), cy * UNIT + (corner === 0 || corner === 1 ? far : near)];
}

/** 座標單位 → 格座標（向下取整；負數也正確） */
export function cellOf(v: number): number {
  return Math.floor(v / UNIT);
}

export function inRect(r: Rect, cx: number, cy: number): boolean {
  return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
}

/** 點（座標單位）所在的命名區域代號，面積小的在前 */
export function regionsAt(map: ShooterMap, x: number, y: number): string[] {
  const cx = cellOf(x);
  const cy = cellOf(y);
  return map.regions
    .filter((r) => inRect(r, cx, cy))
    .sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0))
    .map((r) => r.id);
}

/** 給選手的地圖資料（JSON 安全） */
export function mapInfo(map: ShooterMap): MapInfo {
  return {
    id: map.id,
    name: map.name,
    width: map.width,
    height: map.height,
    solid: Array.from(map.solid),
    sites: map.sites,
    spawnZones: map.spawnZones,
    spawns: map.spawns,
    regions: map.regions,
  };
}

/** 文字圖（除錯、審圖用）：# 牆、= 矮牆、/ \ 斜切格、. 可走、A／B 炸彈點、t／c 出生區、T／C 出生點 */
export function dumpAscii(map: ShooterMap): string {
  const rows: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let line = '';
    for (let x = 0; x < map.width; x++) {
      if (map.solid[y * map.width + x] === 1) {
        line += '#';
        continue;
      }
      if (map.solid[y * map.width + x] === 2) {
        line += '=';
        continue;
      }
      if (slopeAt(map, x, y) >= 0) {
        line += slopeAt(map, x, y) % 2 === 0 ? '/' : '\\';
        continue;
      }
      let ch = '.';
      for (const s of map.sites) if (inRect(s, x, y)) ch = s.id;
      if (inRect(map.spawnZones.T, x, y)) ch = 't';
      if (inRect(map.spawnZones.CT, x, y)) ch = 'c';
      for (const t of ['T', 'CT'] as const) {
        for (const s of map.spawns[t]) if (cellOf(s.x) === x && cellOf(s.y) === y) ch = t === 'T' ? 'T' : 'C';
      }
      line += ch;
    }
    rows.push(line);
  }
  return rows.join('\n');
}

/** 從一格出發（四方向）能到達的格；供地圖驗證與尋路測試 */
export function reachable(map: ShooterMap, cx: number, cy: number): Uint8Array {
  const seen = new Uint8Array(map.width * map.height);
  if (blocksMove(map, cx, cy)) return seen;
  const queue: number[] = [cy * map.width + cx];
  seen[queue[0]] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % map.width;
    const y = (i - x) / map.width;
    const next: [number, number][] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of next) {
      if (blocksMove(map, nx, ny)) continue;
      const j = ny * map.width + nx;
      if (seen[j] === 1) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return seen;
}
