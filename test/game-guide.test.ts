// 新手引導的規則：功能逐週開放、帶路順序、基地的「下一步」。
import { describe, expect, it } from 'vitest';
import type { KnownView } from '../src/manage/index.ts';
import { HELP, UNLOCK_WEEK, autoHelpId, currentStep, lockedUntil, nextHint, type GuideState } from '../src/web/game/guide.ts';

function view(over: Partial<KnownView> & { runway?: number | null; left?: number } = {}): KnownView {
  const { runway = 10, left = 0, ...rest } = over;
  return { week: 0, phase: 'offseason', me: { runwayWeeks: runway, capacityLeft: left, cash: 2500, weeklyFixedCost: 200, weeklySponsor: 40, lineup: [], roster: [] }, ...rest } as unknown as KnownView;
}
const on = (done: string[] = []): GuideState => ({ on: true, done });

/** 把目前這一課的步驟全部看完 */
function finish(g: GuideState, v: KnownView): string[] {
  const seen: string[] = [];
  for (let s = currentStep(g, v); s; s = currentStep(g, v)) {
    seen.push(s.id);
    g.done.push(s.id);
  }
  return seen;
}

describe('功能逐週開放', () => {
  it('開放週之前鎖住，到了就開', () => {
    expect(lockedUntil('training', view({ week: 1, phase: 'season' }), on())).toBe(2);
    expect(lockedUntil('training', view({ week: 2, phase: 'season' }), on())).toBeNull();
    expect(lockedUntil('betting', view({ week: 2, phase: 'season' }), on())).toBe(3);
    expect(lockedUntil('league', view(), on())).toBe(1);
  });

  it('戰隊與市場一開始就有', () => {
    for (const s of ['hub', 'squad', 'market', 'inbox', 'player'] as const) expect(lockedUntil(s, view(), on())).toBeNull();
  });

  it('關閉教學或沒有引導資料（舊存檔）全部開放', () => {
    expect(lockedUntil('betting', view(), { on: false, done: [] })).toBeNull();
    expect(lockedUntil('betting', view(), undefined)).toBeNull();
  });

  it('賽段結束後全部能看', () => {
    for (const s of Object.keys(UNLOCK_WEEK)) expect(lockedUntil(s as 'league', view({ week: 2, phase: 'bankrupt' }), on())).toBeNull();
  });
});

describe('帶路步驟', () => {
  it('開季前從歡迎開始，到開幕結束，只有第一步能跳過', () => {
    const g = on();
    const first = currentStep(g, view());
    expect(first?.id).toBe('intro.welcome');
    expect(first?.first).toBe(true);
    const seen = finish(g, view());
    expect(seen[seen.length - 1]).toBe('intro.go');
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('要玩家自己走的步驟都有亮處可以點', () => {
    const g = on();
    for (let s = currentStep(g, view()); s; s = currentStep(g, view())) {
      if (s.go) expect(s.target).toBeTruthy();
      g.done.push(s.id);
    }
  });

  it('開放週先講新功能', () => {
    const g = on();
    finish(g, view());
    expect(currentStep(g, view({ week: 1, phase: 'season' }))?.id).toBe('w1.unlock');
    finish(g, view({ week: 1, phase: 'season' }));
    expect(currentStep(g, view({ week: 1, phase: 'season' }))).toBeNull();
    expect(currentStep(g, view({ week: 2, phase: 'season' }))?.open).toBe('training');
    finish(g, view({ week: 2, phase: 'season' }));
    expect(currentStep(g, view({ week: 3, phase: 'season' }))?.open).toBe('betting');
  });

  it('關閉教學就沒有步驟', () => {
    expect(currentStep({ on: false, done: [] }, view())).toBeNull();
    expect(currentStep(undefined, view())).toBeNull();
  });

  it('自動說明只跳一次', () => {
    expect(autoHelpId(on(), 'training')).toBe('help.training');
    expect(autoHelpId(on(['help.training']), 'training')).toBeNull();
    expect(autoHelpId(on(), 'squad')).toBeNull();
  });

  it('每個會出現的畫面都有說明', () => {
    for (const s of ['hub', 'squad', 'player', 'market', 'training', 'league', 'betting', 'finance', 'inbox'] as const) expect(HELP[s]?.items.length).toBeGreaterThan(0);
  });
});

describe('基地的下一步', () => {
  const hint = (v: KnownView, unread = 0, foe: string | null = '雷鳴特攻'): ReturnType<typeof nextHint> => nextHint({ v, guide: on(), unread, foe, capacity: 10 });

  it('快破產排最前面；財務還沒開放時不帶路過去', () => {
    expect(hint(view({ week: 2, phase: 'season', runway: 1 }), 3).to).toBe('finance');
    const early = hint(view({ runway: 1 }));
    expect(early.to).toBeUndefined();
    expect(early.text).toContain('1 週');
  });

  it('有新報告先看信', () => {
    expect(hint(view({ week: 2, phase: 'season' }), 2).to).toBe('inbox');
  });

  it('訓練開放後沒排才提醒，還沒開放不提', () => {
    expect(hint(view({ week: 2, phase: 'season', left: 10 })).to).toBe('training');
    expect(hint(view({ week: 2, phase: 'season', left: 4 })).to).toBe('squad');
    expect(hint(view({ week: 1, phase: 'season', left: 10 })).to).toBe('squad');
  });

  it('本週沒有比賽不提對手', () => {
    const h = hint(view({ week: 8, phase: 'season' }), 0, null);
    expect(h.to).toBeUndefined();
    expect(h.text).toContain('沒有我方比賽');
  });

  it('賽段結束與破產各有去處', () => {
    expect(hint(view({ week: 9, phase: 'ended' })).to).toBe('league');
    expect(hint(view({ week: 3, phase: 'bankrupt' })).to).toBe('finance');
  });
});
