// 視野：每位選手一張「被幾個來源看見」的計數格網，來源移動時增量更新。
// 視野圓以觀察者所在格的中心為圓心（決策預設）；偶數尺寸建築與瞭望塔以格角為圓心，維持旋轉對稱。
// 樹林格只有在觀察者距離 ≤ forestSightTiles 時可見。
import { RULES, TERRAIN, TILE_SIZE } from '../config/index.ts';
import type { MatchState, Player } from './state.ts';

interface Stencil {
  /** 相對錨點格的位移 */
  readonly dx: Int16Array;
  readonly dy: Int16Array;
  /** 是否在樹林可見距離內 */
  readonly near: Uint8Array;
}

const stencilCache = new Map<number, Stencil>();

/** corner = true 時圓心為錨點格的左上角，否則為錨點格中心 */
export function getStencil(radiusTiles: number, corner: boolean): Stencil {
  const key = radiusTiles * 2 + (corner ? 1 : 0);
  const cached = stencilCache.get(key);
  if (cached !== undefined) return cached;
  const half = TILE_SIZE >> 1;
  const r2 = (radiusTiles * TILE_SIZE) ** 2;
  const near2 = (RULES.vision.forestSightTiles * TILE_SIZE) ** 2;
  const dxs: number[] = [];
  const dys: number[] = [];
  const nears: number[] = [];
  for (let dy = -radiusTiles - 1; dy <= radiusTiles + 1; dy++) {
    for (let dx = -radiusTiles - 1; dx <= radiusTiles + 1; dx++) {
      const ox = corner ? dx * TILE_SIZE + half : dx * TILE_SIZE;
      const oy = corner ? dy * TILE_SIZE + half : dy * TILE_SIZE;
      const d2 = ox * ox + oy * oy;
      if (d2 > r2) continue;
      dxs.push(dx);
      dys.push(dy);
      nears.push(d2 <= near2 ? 1 : 0);
    }
  }
  const s: Stencil = { dx: Int16Array.from(dxs), dy: Int16Array.from(dys), near: Uint8Array.from(nears) };
  stencilCache.set(key, s);
  return s;
}

/** 對選手 p 加上（sign = 1）或移除（sign = -1）一個視野來源 */
export function applyVision(state: MatchState, p: Player, anchorTile: number, radiusTiles: number, corner: boolean, sign: 1 | -1): void {
  if (anchorTile < 0 || radiusTiles <= 0) return;
  const w = state.width;
  const h = state.height;
  const ax = anchorTile % w;
  const ay = (anchorTile - ax) / w;
  const s = getStencil(radiusTiles, corner);
  const tiles = state.map.tiles;
  const vis = p.vis;
  const n = s.dx.length;
  for (let i = 0; i < n; i++) {
    const x = ax + s.dx[i];
    const y = ay + s.dy[i];
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const idx = y * w + x;
    if (s.near[i] === 0 && tiles[idx] === TERRAIN.forest) continue;
    if (sign > 0) {
      vis[idx] += 1;
      if (p.explored[idx] === 0) {
        p.explored[idx] = 1;
        p.exploredDelta.push(idx);
      }
    } else {
      if (vis[idx] === 0) throw new Error(`視野計數為負：tile ${idx}`);
      vis[idx] -= 1;
    }
  }
}

export function isTileVisible(p: Player, tile: number): boolean {
  return p.vis[tile] > 0;
}
