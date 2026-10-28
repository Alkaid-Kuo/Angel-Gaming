// CS 射擊地圖：以「在實心裡挖矩形」描述，再轉成格子。
// 第一張圖「沙城」參照 Dust2：北為 CT、南為 T，中路南北直線，A 長在東、B 通道在西。
// 座標：格為單位的整數矩形，含 x0/y0、不含 x1/y1。1 格 = 1 公尺 = UNIT 座標單位。
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

export interface MapLayout {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 依序挖開的區域（代號＝ callout） */
  readonly areas: readonly (Rect & { readonly id: string; readonly name: string })[];
  /** 挖開之後再填回去的實心（箱子、柱子） */
  readonly blocks: readonly Rect[];
  readonly sites: readonly (Rect & { readonly id: 'A' | 'B' })[];
  readonly spawnZones: Readonly<Record<Team, Rect>>;
  readonly spawns: Readonly<Record<Team, readonly MapSpawn[]>>;
}

export interface ShooterMap {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 列優先；1 = 牆 */
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
    regions: layout.areas.map((a) => ({ id: a.id, name: a.name, x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 })),
  };
}

export const MAPS: Readonly<Record<string, () => ShooterMap>> = {
  dust: () => buildMap(DUST_LAYOUT),
};

export const DEFAULT_MAP_ID = 'dust';

/** 格座標是否為牆；出界視為牆 */
export function isSolidCell(map: ShooterMap, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return true;
  return map.solid[cy * map.width + cx] === 1;
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

/** 文字圖（除錯、審圖用）：# 牆、. 可走、A／B 炸彈點、t／c 出生區、T／C 出生點 */
export function dumpAscii(map: ShooterMap): string {
  const rows: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let line = '';
    for (let x = 0; x < map.width; x++) {
      if (map.solid[y * map.width + x] === 1) {
        line += '#';
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
  if (isSolidCell(map, cx, cy)) return seen;
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
      if (isSolidCell(map, nx, ny)) continue;
      const j = ny * map.width + nx;
      if (seen[j] === 1) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return seen;
}
