// 介面 UX 2.1：HUD 的純函式
import { describe, expect, it } from 'vitest';
import type { ShooterObservation } from '../src/shooter/api.ts';
import type { FullState } from '../src/web/shooter/protocol.ts';
import { clockText, clockTicks, seesAll, visibleHp } from '../src/web/shooter/hudinfo.ts';
import { buyToggle } from '../src/web/shooter/shop.ts';

describe('商店開關', () => {
  it('不能買時按 B 不開，只給提示；開著隨時能關', () => {
    expect(buyToggle(false, true)).toBe('open');
    expect(buyToggle(false, false)).toBe('deny');
    expect(buyToggle(true, true)).toBe('close');
    expect(buyToggle(true, false)).toBe('close');
  });
});

describe('觀戰視野', () => {
  it('自由鏡頭照透視開關，維持所看選手的視野；只有全圖一律看全部', () => {
    expect(seesAll(false, 'follow')).toBe(false);
    expect(seesAll(false, 'free')).toBe(false);
    expect(seesAll(true, 'free')).toBe(true);
    expect(seesAll(false, 'overview')).toBe(true);
  });
});

describe('頂部計分', () => {
  const view = (phase: string, phaseTicksLeft: number, bombLeft: number | null): ShooterObservation => ({ round: { phase, phaseTicksLeft }, bomb: { ticksLeft: bombLeft } }) as unknown as ShooterObservation;

  it('時間：凍結與回合中看階段倒數，下包後看炸彈，回合結束不顯示', () => {
    expect(clockTicks(view('freeze', 90, null))).toBe(90);
    expect(clockTicks(view('live', 3000, null))).toBe(3000);
    expect(clockTicks(view('planted', 3000, 600))).toBe(600);
    expect(clockTicks(view('ended', 0, null))).toBeNull();
  });

  it('時間字：無條件進位到秒，分秒補零', () => {
    expect(clockText(3450, 30)).toBe('1:55');
    expect(clockText(31, 30)).toBe('0:02');
    expect(clockText(0, 30)).toBe('0:00');
  });

  it('對局中拿不到敵人血量：只有自己與隊友', () => {
    const v = { me: { id: 1, hp: 73 }, teammates: [{ id: 2, hp: 40 }] } as unknown as ShooterObservation;
    expect(visibleHp(v, null, 1)).toBe(73);
    expect(visibleHp(v, null, 2)).toBe(40);
    expect(visibleHp(v, null, 7)).toBeNull();
  });

  it('觀戰有全狀態：全員都有血量', () => {
    const v = { me: { id: 1, hp: 73 }, teammates: [] } as unknown as ShooterObservation;
    const full = { players: [{ id: 7, hp: 12 }] } as unknown as FullState;
    expect(visibleHp(v, full, 7)).toBe(12);
  });
});
