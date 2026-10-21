import { describe, expect, it } from 'vitest';
import { idiv, isqrt, tdiv, applyPercent } from '../src/shared/intmath.ts';
import { Prng } from '../src/shared/prng.ts';
import { Hasher, hashInts } from '../src/shared/hash.ts';
import { angleOf, icos, isin } from '../src/shared/trig.ts';

describe('intmath', () => {
  it('idiv 為 floor 除法', () => {
    expect(idiv(7, 2)).toBe(3);
    expect(idiv(-7, 2)).toBe(-4);
    expect(idiv(7, -2)).toBe(-4);
    expect(idiv(-7, -2)).toBe(3);
    expect(idiv(6, 3)).toBe(2);
    expect(() => idiv(1, 0)).toThrow();
  });
  it('tdiv 向零取整', () => {
    expect(tdiv(7, 2)).toBe(3);
    expect(tdiv(-7, 2)).toBe(-3);
    expect(tdiv(7, -2)).toBe(-3);
  });
  it('isqrt 向下取整且在大數下正確', () => {
    for (let k = 0; k < 2000; k++) {
      expect(isqrt(k * k)).toBe(k);
      if (k > 0) expect(isqrt(k * k - 1)).toBe(k - 1);
    }
    const big = 94906265; // big² < 2^53
    expect(isqrt(big * big - 1)).toBe(big - 1);
    expect(isqrt(big * big)).toBe(big);
  });
  it('applyPercent 向下取整', () => {
    expect(applyPercent(8, 50)).toBe(4);
    expect(applyPercent(12, 150)).toBe(18);
    expect(applyPercent(250, 60)).toBe(150);
  });
});

describe('prng', () => {
  it('同種子同序列，狀態可序列化', () => {
    const a = Prng.fromInts(42, 1);
    const b = Prng.fromInts(42, 1);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
    const st = a.getState();
    const c = Prng.fromState(st);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(c.nextU32());
  });
  it('不同種子不同序列', () => {
    const a = Prng.fromInts(1);
    const b = Prng.fromInts(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextU32() === b.nextU32()) same++;
    expect(same).toBeLessThan(3);
  });
  it('nextInt 範圍正確且大致均勻', () => {
    const r = Prng.fromInts(7);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60000; i++) counts[r.nextInt(6)]++;
    for (const c of counts) expect(Math.abs(c - 10000)).toBeLessThan(500);
  });
  it('固定輸出（跨平台基準值）', () => {
    const r = Prng.fromInts(12345);
    const seq = [r.nextU32(), r.nextU32(), r.nextU32()];
    expect(seq).toMatchSnapshot();
  });
});

describe('hash', () => {
  it('相同輸入相同雜湊，順序敏感', () => {
    const a = new Hasher().int(1).int(2).int(-3).digest();
    const b = new Hasher().int(1).int(2).int(-3).digest();
    const c = new Hasher().int(2).int(1).int(-3).digest();
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(hashInts([1, 2])).not.toBe(hashInts([2, 1]));
    expect(new Hasher().int(2 ** 40 + 5).digest()).not.toBe(new Hasher().int(5).digest());
  });
});

describe('trig', () => {
  it('查表與方位角', () => {
    expect(icos(0)).toBe(10000);
    expect(isin(90)).toBe(10000);
    expect(icos(180)).toBe(-10000);
    expect(icos(-90)).toBe(icos(270));
    expect(angleOf(1, 0)).toBe(0);
    expect(angleOf(0, 1)).toBe(90);
    expect(angleOf(-1, 0)).toBe(180);
    expect(angleOf(1, 1)).toBe(45);
  });
});
