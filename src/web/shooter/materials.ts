// 攻防戰世界的材質分區與隊色：地圖 JSON 的 areas[].material 優先，沒標的（沙城）才查區域代號表；世界的調色盤與畫法在 themes/。
// 不在任何區域的格子是石板。沒有 DOM，測試可以直接跑。
import type { MapInfo } from '../../shooter/api.ts';
import type { MapMaterial } from '../../shooter/map.ts';

/** 隊色與介面警示：跨 theme 不變，世界才換 */
export const PAL = {
  gold: '#f0b54a',
  goldLight: '#ffd98a',
  goldDark: '#a8742a',
  blue: '#2f8fe0',
  blueLight: '#8fd0ff',
  blueDark: '#17558f',
  ink: '#1d1a22',
  warn: '#e5484d',
} as const;

/** 牆與矮牆的視覺高度（格），畫側面與落影用 */
export const WALL_H = 0.72;
export const LOW_H = 0.3;

export type Zone = MapMaterial;
export const ZONES: readonly Zone[] = ['stone', 'dirt', 'wood', 'market', 'plaza', 'site'];

/** 區域代號 → 材質：地圖 JSON 沒標 material 時的退路；新代號查不到就是石板 */
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

/** 每格的地面材質；區域重疊時比照挖地圖的順序，後面的蓋前面。materials 與 regions 同序（地圖 JSON 的 material），沒標的查代號表 */
export function zoneGrid(map: Pick<MapInfo, 'width' | 'height' | 'regions'>, materials: readonly (MapMaterial | undefined)[] = []): Zone[] {
  const grid = new Array<Zone>(map.width * map.height).fill('stone');
  map.regions.forEach((r, i) => {
    const z = materials[i] ?? zoneOfRegion(r.id);
    for (let y = Math.max(0, r.y0); y < Math.min(map.height, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(map.width, r.x1); x++) grid[y * map.width + x] = z;
  });
  return grid;
}

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
