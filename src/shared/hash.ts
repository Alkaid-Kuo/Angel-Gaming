// 確定性雜湊：兩條獨立的 32 位元混合，合成 64 位元十六進位字串。
// 支援 |n| < 2^53 的整數（拆成高低 32 位元餵入）。

const TWO_32 = 0x100000000;

function mix(h: number, v: number): number {
  let k = Math.imul(v, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Hasher {
  private h1 = 0x12345678;
  private h2 = 0x9abcdef0 | 0;
  private count = 0;

  int(n: number): this {
    if (!Number.isSafeInteger(n)) throw new Error(`Hasher.int: 非安全整數 ${n}`);
    const neg = n < 0 ? 1 : 0;
    const a = Math.abs(n);
    const lo = a % TWO_32;
    const hi = (a - lo) / TWO_32;
    this.h1 = mix(this.h1, lo | 0);
    this.h1 = mix(this.h1, (hi | 0) ^ (neg << 31));
    this.h2 = mix(this.h2, (lo ^ 0x5bd1e995) | 0);
    this.h2 = mix(this.h2, ((hi | 0) ^ (neg << 30)) + 0x27d4eb2f);
    this.count += 1;
    return this;
  }

  bool(b: boolean): this {
    return this.int(b ? 1 : 0);
  }

  str(s: string): this {
    this.int(s.length);
    for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i));
    return this;
  }

  bytes(arr: Uint8Array | Uint16Array | Int32Array): this {
    this.int(arr.length);
    for (let i = 0; i < arr.length; i++) this.int(arr[i]);
    return this;
  }

  digest(): string {
    const a = fmix(this.h1 ^ this.count);
    const b = fmix(this.h2 ^ Math.imul(this.count, 0x9e3779b1));
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
}

/** 由多個整數得到 32 位元無號雜湊；用於衍生種子，例如 hash(seed, playerId) */
export function hashInts(values: readonly number[]): number {
  let h = 0x2545f491;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new Error(`hashInts: 非安全整數 ${v}`);
    const neg = v < 0 ? 1 : 0;
    const a = Math.abs(v);
    const lo = a % TWO_32;
    const hi = (a - lo) / TWO_32;
    h = mix(h, lo | 0);
    h = mix(h, (hi | 0) ^ (neg << 31));
  }
  return fmix(h ^ values.length);
}
