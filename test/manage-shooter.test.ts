// 攻防戰閘道接經營層（步驟 8）：真引擎確定性、名單 → 屬性換算、短賽制整季與存檔重跑、正式賽制一場。
// 真引擎一回合約 0.5～0.7 秒（Node 單執行緒），整季用短賽制（每半場 1 回合）。
import { describe, expect, it } from 'vitest';
import { runSeason } from '../src/manage/autoplayer.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import type { ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import type { BattleGateway, MatchOutcome, MatchRequest, PlayerSpec, SideSpec } from '../src/manage/gateway.ts';
import { ShooterGateway } from '../src/manage/gateway-shooter.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import type { GameState } from '../src/manage/types.ts';
import { ATTRIBUTE_KEYS } from '../src/shooter/config.ts';
import { attributeShift, seatOf } from '../src/shooter/gateway.ts';
import { derivePlayer, reactionTicksFor, SHOOTER_ROLES } from '../src/shooter/players.ts';

const gateway = new ShooterGateway();
const ROLES = ['entry', 'support', 'anchor', 'lurk', 'awp'];
const side = (version: number, habit = 0, presetBonus = 0): SideSpec => ({ players: ROLES.map((lineageId) => ({ lineageId, version, config: { habit, presetBonus } })) });

/** 同一張請求單只打一次（存檔重跑測試：讀檔後送出的請求單若與不中斷時相同就直接命中；不同就照打，結果比對會抓到） */
class MemoGateway implements BattleGateway {
  readonly formats = gateway.formats;
  readonly memo = new Map<string, MatchOutcome>();
  hits = 0;
  async simulateBatch(requests: readonly MatchRequest[]): Promise<MatchOutcome[]> {
    const outs: MatchOutcome[] = [];
    for (const r of requests) {
      const k = JSON.stringify(r);
      const hit = this.memo.get(k);
      if (hit) {
        this.hits++;
        outs.push(hit);
        continue;
      }
      const [o] = await gateway.simulateBatch([r]);
      this.memo.set(k, o);
      outs.push(o);
    }
    return outs;
  }
}

describe('攻防戰閘道：名單 → 屬性', () => {
  const spec = (lineageId: string, version: number, habit: number, presetBonus: number): PlayerSpec => ({ lineageId, version, config: { habit, presetBonus } });

  it('偏移換算：習慣 ±4、預設加成 0～6，方向正確', () => {
    expect(attributeShift({ habit: 0, presetBonus: 0 })).toBe(0);
    expect(attributeShift({ habit: 60, presetBonus: 0 })).toBe(4);
    expect(attributeShift({ habit: -60, presetBonus: 0 })).toBe(-4);
    expect(attributeShift({ habit: 30, presetBonus: 0 })).toBe(2);
    expect(attributeShift({ habit: 0, presetBonus: 36 })).toBe(2);
    expect(attributeShift({ habit: 0, presetBonus: 500 })).toBe(6);
    expect(attributeShift({ habit: 0, presetBonus: -50 })).toBe(0);
    expect(attributeShift({})).toBe(0);
  });

  it('只動 aim、reaction、awareness；夾在 0～100；反應延遲重算', () => {
    for (const role of SHOOTER_ROLES) {
      for (let v = 1; v <= 5; v++) {
        const base = derivePlayer({ role, version: v, habit: 0 }).attributes;
        for (const [habit, bonus] of [[-999, 0], [0, 0], [60, 90], [999, 999]] as const) {
          const s = seatOf(spec(role, v, habit, bonus));
          const shift = attributeShift({ habit, presetBonus: bonus });
          for (const k of ATTRIBUTE_KEYS) {
            expect(s.attributes[k]).toBeGreaterThanOrEqual(0);
            expect(s.attributes[k]).toBeLessThanOrEqual(100);
            const strength = k === 'aim' || k === 'reaction' || k === 'awareness';
            expect(s.attributes[k], `${role} v${v} ${k}`).toBe(strength ? Math.max(0, Math.min(100, base[k] + shift)) : base[k]);
          }
          expect(s.reactionTicks).toBe(reactionTicksFor(s.attributes));
        }
        // 習慣好的人反應不會更慢
        expect(seatOf(spec(role, v, 60, 0)).reactionTicks).toBeLessThanOrEqual(seatOf(spec(role, v, -60, 0)).reactionTicks);
      }
    }
    expect(() => seatOf(spec('ambush', 3, 0, 0))).toThrow(/沒有流派/);
  });
});

describe('攻防戰閘道：真引擎', () => {
  it('同一張請求單跑兩次成績單相同；A／B 對調不炸；名單人數不對會拒絕', async () => {
    const req: MatchRequest = { formatId: 'shooter-short', a: side(4, 30, 20), b: side(3, -20), seed: 424242 };
    const [x] = await gateway.simulateBatch([req]);
    const [y] = await gateway.simulateBatch([req]);
    expect(y).toEqual(x);
    expect(x.rounds.length).toBeGreaterThan(0);
    const [z] = await gateway.simulateBatch([{ ...req, a: req.b, b: req.a }]);
    expect(['a', 'b', 'draw']).toContain(z.winner);
    await expect(gateway.simulateBatch([{ ...req, a: { players: req.a.players.slice(0, 3) } }])).rejects.toThrow(/5 人/);
  }, 60_000);

  it('正式賽制一場：至少 13 回合、累計比分單調、最後比分與勝方一致', async () => {
    const [o] = await gateway.simulateBatch([{ formatId: 'shooter-mr12', a: side(3), b: side(3), seed: 7 }]);
    expect(o.rounds.length).toBeGreaterThanOrEqual(13);
    let pa = 0;
    let pb = 0;
    for (const r of o.rounds) {
      expect(r.scoreA + r.scoreB).toBe(pa + pb + 1);
      expect(r.winner).toBe(r.scoreA > pa ? 'a' : 'b');
      pa = r.scoreA;
      pb = r.scoreB;
    }
    expect(o.winner).toBe(pa > pb ? 'a' : pb > pa ? 'b' : 'draw');
    if (o.winner !== 'draw') expect(Math.max(pa, pb)).toBeGreaterThanOrEqual(13);
  }, 120_000);
});

describe('攻防戰內容包＋真閘道（短賽制）', () => {
  const content: ContentPack = { ...SHOOTER_CONTENT, formatId: 'shooter-short' };

  it('開局 5 人；passive 打完整季：32 場都有結果、帳本恆等、Elo 守恆；第 3 週存檔讀檔續打與不中斷相同', async () => {
    const memo = new MemoGateway();
    const whole = newGame(8, content, { gateway: memo });
    for (const t of whole.teams) expect(whole.players.filter((p) => p.teamId === t.id)).toHaveLength(5);
    const start = new Map(whole.teams.map((t) => [t.id, t.cash]));
    const eloSum = whole.players.reduce((s, p) => s + p.elo, 0);
    await runSeason(whole, content, memo, null);
    expect(['ended', 'bankrupt']).toContain(whole.phase);
    expect(whole.fixtures).toHaveLength(32);
    for (const f of whole.fixtures) {
      const r = f.result as NonNullable<GameState['fixtures'][number]['result']>;
      expect(r).not.toBeNull();
      expect(r.lineupA).toHaveLength(5);
      expect(r.lineupB).toHaveLength(5);
      expect(r.winner).toBe(r.scoreA > r.scoreB ? f.home : r.scoreB > r.scoreA ? f.away : null);
    }
    for (const t of whole.teams) expect(t.cash).toBe((start.get(t.id) as number) + t.ledger.reduce((s, e) => s + e.amount, 0));
    expect(whole.players.reduce((s, p) => s + p.elo, 0)).toBe(eloSum);
    const played = memo.memo.size;

    const part = newGame(8, content, { gateway: memo });
    for (let i = 0; i < 3; i++) await advance(part, content, memo);
    expect(part.week).toBe(3);
    const loaded = deserialize(serialize(part), content);
    await runSeason(loaded, content, memo, null);
    expect(serialize(loaded)).toBe(serialize(whole));
    // 讀檔後送出的請求單與不中斷時完全相同（全部命中）
    expect(memo.memo.size).toBe(played);
  }, 600_000);
});
