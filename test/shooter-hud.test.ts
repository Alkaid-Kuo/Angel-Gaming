// 介面 UX 2.1：HUD 的純函式
import { describe, expect, it } from 'vitest';
import { buyToggle } from '../src/web/shooter/shop.ts';

describe('商店開關', () => {
  it('不能買時按 B 不開，只給提示；開著隨時能關', () => {
    expect(buyToggle(false, true)).toBe('open');
    expect(buyToggle(false, false)).toBe('deny');
    expect(buyToggle(true, true)).toBe('close');
    expect(buyToggle(true, false)).toBe('close');
  });
});
