// M5 經營層經濟平衡（2026-11-06）的回歸測試：攻防戰內容包＋假比賽跑整季。
// 完整量測用 scripts/m5-training-balance.ts 20（規格 4.10）；這裡只用少數種子守住方向：NPC 不需金主補貼、會升訓練中心、
// 訓練＋排練佔支出明顯上來；訓練派玩家第一季季中升得到 Lv3、升後還在練、不破產。
import { describe, expect, it } from 'vitest';
import { runSeason, trainerPolicy } from '../src/manage/autoplayer.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { newGame } from '../src/manage/game.ts';
import type { BattleGateway } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { humanTeam } from '../src/manage/state.ts';
import type { Team } from '../src/manage/types.ts';

const c = SHOOTER_CONTENT;
const fake = new FakeGateway(c);
const gw: BattleGateway = { formats: [{ ...fake.formats[0], id: c.formatId }], simulateBatch: (r, p) => fake.simulateBatch(r, p) };
const share = (t: Team): number => {
  const out = t.ledger.filter((x) => x.amount < 0 && x.category !== 'bet');
  return out.filter((x) => x.category === 'training').reduce((s, x) => s - x.amount, 0) / Math.max(1, out.reduce((s, x) => s - x.amount, 0));
};

describe('M5 經濟平衡：攻防戰內容包', () => {
  it('NPC：整季不需要金主補貼；豪門與數據派會升訓練中心；訓練＋排練平均佔支出 ≥ 25%', async () => {
    const shares: number[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const s = newGame(seed, c);
      await runSeason(s, c, gw, null);
      for (const t of s.teams.filter((x) => !x.human)) {
        expect(t.ledger.some((x) => x.category === 'bailout'), `${seed}/${t.persona}`).toBe(false);
        if (t.persona === 'whale' || t.persona === 'data') expect(t.trainingLevel).toBeGreaterThanOrEqual(2);
        if (t.persona === 'miser') expect(t.trainingLevel).toBe(1);
        shares.push(share(t));
      }
    }
    expect(shares.reduce((a, b) => a + b, 0) / shares.length).toBeGreaterThanOrEqual(0.25);
  }, 120_000);

  it('訓練派玩家（目標 Lv3）：不破產；多數種子在第 5 週前升到 Lv3，升後每週還在練', async () => {
    let early = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = newGame(seed, c);
      await runSeason(s, c, gw, trainerPolicy(3));
      expect(s.phase).toBe('ended');
      const me = humanTeam(s);
      const up = me.ledger.find((x) => x.category === 'facility' && x.memo.includes('升到 Lv3'));
      if (up === undefined || up.week > 5) continue;
      early++;
      const weeks = new Set(me.ledger.filter((x) => x.category === 'training' && x.week > up.week).map((x) => x.week));
      expect(weeks.size).toBeGreaterThanOrEqual(3);
    }
    expect(early).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
