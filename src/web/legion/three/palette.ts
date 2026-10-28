// 3D 沙盤的色票：照《軍團戰 美術風格 v2》第四節；v2 沒寫的（城內石板、城樓木作、農作物）用同樣低飽和的色調補上。
import * as THREE from 'three';

export const PAL = {
  bg: 0x0b0d10,
  grass: 0x7f8d5e,
  grassDry: 0x979661,
  forestFloor: 0x69774b,
  crownDark: 0x3d5a2c,
  crownMid: 0x46663a,
  crownLight: 0x5a7d42,
  willow: 0x7a8c4a,
  road: 0xb8a679,
  roadEdge: 0x97875f,
  water: 0x3d6b78,
  waterDeep: 0x2f5865,
  bank: 0x6f7a55,
  sand: 0xa9a487,
  riverbed: 0x5c5a45,
  cliff: 0x6e6a48,
  cliffDark: 0x5b5639,
  wood: 0x8a6a45,
  woodDark: 0x5e4630,
  plaster: 0xc2b598,
  plasterLight: 0xc4b89f,
  roofSlate: 0x74787c,
  roofDark: 0x5d6166,
  roofThatch: 0xa8956a,
  wallSide: 0x8e8a80,
  wallTop: 0xa39f94,
  // v2 沒有的：城內的石板地、院子、碎石、台基與柱子
  paving: 0x9a958a,
  court: 0xaba597,
  rubble: 0x8a8174,
  stone: 0x8c887e,
  column: 0x6b4a36,
  canvas: 0xcfc4a8,
  skin: 0xd6b08a,
} as const;

export function col(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

/** 依種子在 ±amount 明度內微調顏色（同一種物件不會每個都一樣） */
export function vary(hex: number, seed: number, amount = 0.06): THREE.Color {
  const c = new THREE.Color(hex);
  const k = 1 + (((seed * 9301 + 49297) % 233280) / 233280 - 0.5) * 2 * amount;
  return c.multiplyScalar(k);
}

/** 0～1 的雜湊亂數（畫面用，不影響對戰） */
export function rand(a: number, b = 0, c = 0): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
