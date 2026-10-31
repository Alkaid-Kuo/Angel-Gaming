// 攻防戰世界的材質表與調色盤（方向 A 俯視戰術沙盤）：區域代號查地面材質，地圖不用改、API 不用升。
// 查不到的區域一律石板；不在任何區域的格子也是石板。沒有 DOM，測試可以直接跑。
import type { MapInfo } from '../../shooter/api.ts';

/** 調色盤：世界全部在暖土色內，隊色才有飽和度；陰影是偏紫的暖灰，不用黑 */
export const PAL = {
  table: '#34292a',
  mortar: '#c3b6a3',
  stone: ['#dcd2c1', '#d5cab7', '#e0d7c8', '#cec2ae'],
  dirt: '#d9c3a0',
  dirtDark: '#c4a97f',
  dirtLight: '#e5d3b5',
  wood: ['#b78f62', '#ad8558', '#c0996c', '#a57c50'],
  woodSeam: '#6d4e39',
  plaza: ['#ddd1bc', '#d6c9b3', '#e2d7c4'],
  site: ['#e4d8c2', '#dfd2ba', '#e9dfcb'],
  paint: '#a2402c',
  roof: '#957063',
  roofMid: '#a4806f',
  roofOuter: '#b3907c',
  rim: '#d6b7a0',
  rimLine: '#6f5048',
  side: '#6f4c4b',
  sideLine: '#56393d',
  shadow: '#a292ab',
  ao: '#8d7b92',
  gold: '#f0b54a',
  goldLight: '#ffd98a',
  goldDark: '#a8742a',
  blue: '#2f8fe0',
  blueLight: '#8fd0ff',
  blueDark: '#17558f',
  ink: '#1d1a22',
  warn: '#e5484d',
} as const;

export type Zone = 'stone' | 'dirt' | 'wood' | 'market' | 'plaza' | 'site';
export const ZONES: readonly Zone[] = ['stone', 'dirt', 'wood', 'market', 'plaza', 'site'];

/** 區域代號 → 材質（涵蓋 redrock 與 redrock2 各版）；新地圖的新代號查不到就是石板 */
const ZONE_OF: Readonly<Record<string, Zone>> = {
  tSpawn: 'plaza',
  ctSpawn: 'plaza',
  market: 'market',
  marketNorth: 'market',
  eastLane: 'dirt',
  eastLaneNorth: 'dirt',
  sideAlley: 'dirt',
  sideSouth: 'dirt',
  eastGate: 'dirt',
  eastGateNorth: 'dirt',
  eastRamp: 'dirt',
  eastRise: 'dirt',
  eastYard: 'dirt',
  longHall: 'dirt',
  nook: 'dirt',
  nookDoor: 'dirt',
  aMouth: 'dirt',
  cellar: 'wood',
  cellarHall: 'wood',
  cellarWest: 'wood',
  cellarEast: 'wood',
  cellarBend: 'wood',
  cellarRise: 'wood',
  cellarMouth: 'wood',
  barn: 'wood',
  barnDoor: 'wood',
  wineRoom: 'wood',
  wineDoor: 'wood',
  wineEast: 'wood',
  mason: 'wood',
  masonDoor: 'wood',
  shopW: 'wood',
  shopWDoor: 'wood',
  shopWNorth: 'wood',
  shopWSouth: 'wood',
  shopE: 'wood',
  shopEDoor: 'wood',
  shopBarn: 'wood',
  apothecary: 'wood',
  apothecaryDoor: 'wood',
  apothecarySouth: 'wood',
  eastStore: 'wood',
  storeDoor: 'wood',
  plaza: 'plaza',
  yard: 'plaza',
  yardDoor: 'plaza',
  yardNorth: 'plaza',
  bellYard: 'plaza',
  tMid: 'stone',
  tMidMouth: 'stone',
  mid: 'stone',
  midEast: 'stone',
  arch: 'stone',
  belfry: 'stone',
  belfryEast: 'stone',
  bellLane: 'stone',
  steps: 'stone',
  ctAlley: 'stone',
  ctRamp: 'stone',
  ctRampW: 'stone',
  ctRampE: 'stone',
  ctWest: 'stone',
  ctWestBend: 'stone',
  ctWestDoor: 'stone',
  ctEast: 'stone',
  ctEastBend: 'stone',
  ctEastDoor: 'stone',
  ctSouth: 'stone',
  northSt: 'stone',
  bGate: 'stone',
  aGate: 'stone',
  aWest: 'stone',
  aSouth: 'stone',
  aSite: 'site',
  bSite: 'site',
};

export const zoneOfRegion = (id: string): Zone => ZONE_OF[id] ?? 'stone';

/** 每格的地面材質；區域重疊時比照挖地圖的順序，後面的蓋前面 */
export function zoneGrid(map: Pick<MapInfo, 'width' | 'height' | 'regions'>): Zone[] {
  const grid = new Array<Zone>(map.width * map.height).fill('stone');
  for (const r of map.regions) {
    const z = zoneOfRegion(r.id);
    for (let y = Math.max(0, r.y0); y < Math.min(map.height, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(map.width, r.x1); x++) grid[y * map.width + x] = z;
  }
  return grid;
}

/** 地圖資料裡沒有、純畫面的擺設（格座標）：井是牆方塊的畫法、帆布平鋪在地上（不是棚頂，才不會蓋住人） */
export interface MapDecor {
  /** 3×3 牆方塊的左上角 */
  readonly wells: readonly { readonly x: number; readonly y: number }[];
  /** x, y, w, h */
  readonly tarps: readonly (readonly [number, number, number, number])[];
}

const NO_DECOR: MapDecor = { wells: [], tarps: [] };
const DECOR: Readonly<Record<string, MapDecor>> = {
  redrock: {
    wells: [{ x: 16, y: 18 }],
    tarps: [
      [22, 97, 6, 4],
      [31, 100, 5, 5],
      [16, 105, 7, 4],
      [27, 107, 8, 3],
    ],
  },
  redrock2: {
    wells: [{ x: 19, y: 19 }],
    tarps: [
      [17, 86, 5, 6],
      [28, 88, 7, 5],
    ],
  },
};

export const decorOf = (mapId: string): MapDecor => DECOR[mapId] ?? DECOR[mapId.split('-')[0]] ?? NO_DECOR;

/** 固定種子亂數（mulberry32） */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 格座標的固定雜訊 0～1 */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
