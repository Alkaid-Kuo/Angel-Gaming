// 可序列化狀態的確定性亂數：xoshiro128**，以 splitmix32 展開種子。
import { hashInts } from './hash.ts';

export type PrngState = [number, number, number, number];

function splitmix32(state: { s: number }): number {
  state.s = (state.s + 0x9e3779b9) | 0;
  let z = state.s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export class Prng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  private constructor(state: PrngState) {
    [this.s0, this.s1, this.s2, this.s3] = state;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      throw new Error('Prng: 狀態不可全為 0');
    }
  }

  /** 由任意多個整數（例如 seed、playerId）建立 */
  static fromInts(...values: number[]): Prng {
    const st = { s: hashInts(values) | 0 };
    const state: PrngState = [splitmix32(st), splitmix32(st), splitmix32(st), splitmix32(st)];
    if ((state[0] | state[1] | state[2] | state[3]) === 0) state[0] = 1;
    return new Prng(state);
  }

  static fromState(state: PrngState): Prng {
    return new Prng([state[0] >>> 0, state[1] >>> 0, state[2] >>> 0, state[3] >>> 0]);
  }

  getState(): PrngState {
    return [this.s0 >>> 0, this.s1 >>> 0, this.s2 >>> 0, this.s3 >>> 0];
  }

  /** 32 位元無號整數 */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** [0, n) 的均勻整數（拒絕取樣，無偏差） */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > 0x100000000) {
      throw new Error(`Prng.nextInt: n 不合法 ${n}`);
    }
    const limit = 0x100000000 - (0x100000000 % n);
    for (;;) {
      const r = this.nextU32();
      if (r < limit) return r % n;
    }
  }

  /** [lo, hi] 閉區間整數 */
  range(lo: number, hi: number): number {
    if (hi < lo) throw new Error(`Prng.range: hi < lo (${lo}, ${hi})`);
    return lo + this.nextInt(hi - lo + 1);
  }

  /** 以 percent% 機率回傳 true */
  chance(percent: number): boolean {
    return this.nextInt(100) < percent;
  }

  /** 原地洗牌（Fisher–Yates） */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** [0, 1) 浮點數；只給選手的 random() 使用，引擎狀態不可使用 */
  nextFloat(): number {
    return this.nextU32() / 0x100000000;
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}
