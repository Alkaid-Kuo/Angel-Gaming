// 經營層的亂數：每次隨機都由（主種子, 用途, 序號…）導出，不存亂數狀態。
// 同一份存檔重新載入，每場比賽與每次抽籤都得到相同結果（無法靠讀檔重刷）。
import { Prng } from '../shared/prng.ts';

export const STREAM = {
  newGame: 1,
  match: 2,
  scrim: 3,
  research: 4,
  scout: 5,
  npc: 6,
  auto: 7,
} as const;

export function rngFor(seed: number, stream: number, ...keys: number[]): Prng {
  return Prng.fromInts(seed, stream, ...keys);
}

/** 近似標準常態（4 個均勻亂數相加再標準化），只用四則運算，跨引擎結果一致 */
export function gauss(rng: Prng): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += rng.nextFloat();
  return (s - 2) / 0.5773502691896257;
}
