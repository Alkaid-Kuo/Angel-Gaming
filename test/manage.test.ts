import { describe, expect, it } from 'vitest';
import { POLICIES, runSeason } from '../src/manage/autoplayer.ts';
import { applyCommand } from '../src/manage/commands.ts';
import { STUB_CONTENT } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import type { MatchRequest } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { roundRobin, standings } from '../src/manage/league.ts';
import { expectedPermille, updateElo } from '../src/manage/rating.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { humanTeam, rosterOf } from '../src/manage/state.ts';
import type { GameState } from '../src/manage/types.ts';
import { LINEUP_SIZE, REGULAR_WEEKS, TOTAL_WEEKS } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';

const content = STUB_CONTENT;
const gateway = new FakeGateway(content);

function startCashes(state: GameState): Map<string, number> {
  return new Map(state.teams.map((t) => [t.id, t.cash]));
}

describe('評分', () => {
  it('勝率表對稱、單調，Elo 更新總分守恆', () => {
    expect(expectedPermille(0)).toBe(500);
    for (const d of [10, 50, 120, 400, 790]) expect(expectedPermille(d) + expectedPermille(-d)).toBe(1000);
    expect(expectedPermille(100)).toBeGreaterThan(expectedPermille(50));
    expect(expectedPermille(400)).toBeGreaterThan(880);
    expect(expectedPermille(400)).toBeLessThan(920);
    const [a, b] = updateElo(1500, 1600, 1000, 24);
    expect(a + b).toBe(3100);
    expect(a).toBeGreaterThan(1500);
  });
});

describe('對戰閘道（假比賽）', () => {
  const side = (lineageId: string, version: number, habit = 0): MatchRequest['a'] => ({ lineageId, version, config: { habit, presetBonus: 0 } });

  it('同一張請求單永遠得到同一張成績單', async () => {
    const req: MatchRequest = { formatId: 'stub-bo1', a: side('ambush', 3), b: side('push', 2), seed: 12345 };
    const [x] = await gateway.simulateBatch([req]);
    const [y] = await gateway.simulateBatch([req]);
    expect(y).toEqual(x);
  });

  it('強的一方勝率接近表上的值', async () => {
    const reqs: MatchRequest[] = [];
    for (let i = 0; i < 4000; i++) reqs.push({ formatId: 'stub-bo1', a: side('balance', 1, 100), b: side('balance', 1, 0), seed: i + 1 });
    const outs = await gateway.simulateBatch(reqs);
    const rate = outs.filter((o) => o.winner === 'a').length / outs.length;
    expect(Math.abs(rate - expectedPermille(100) / 1000)).toBeLessThan(0.03);
  });
});

describe('賽程', () => {
  it('8 隊單循環：每輪每隊一場，任兩隊恰好交手一次', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rounds = roundRobin(ids);
    expect(rounds).toHaveLength(7);
    const seen = new Set<string>();
    for (const pairs of rounds) {
      expect(new Set(pairs.flat()).size).toBe(8);
      for (const [h, a] of pairs) {
        const key = [h, a].sort().join('-');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(28);
  });
});

describe('開新局', () => {
  it('8 隊、1 位玩家、各隊 3 人、10 名自由選手、28 場例行賽，同種子結果相同', () => {
    const s = newGame(7, content);
    expect(s.teams).toHaveLength(8);
    expect(s.teams.filter((t) => t.human)).toHaveLength(1);
    for (const t of s.teams) expect(rosterOf(s, t.id)).toHaveLength(LINEUP_SIZE);
    expect(s.players.filter((p) => p.teamId === null)).toHaveLength(content.economy.freeAgentCount);
    expect(s.fixtures).toHaveLength(28);
    expect(serialize(newGame(7, content))).toBe(serialize(s));
    expect(serialize(newGame(8, content))).not.toBe(serialize(s));
    expect(new Set(s.players.map((p) => p.name)).size).toBe(s.players.length);
  });
});

describe('指令', () => {
  it('簽約：扣簽約金、進陣容；資金不足與陣容已滿會被拒絕', () => {
    const s = newGame(3, content);
    const me = humanTeam(s);
    const fa = s.players.filter((p) => p.teamId === null).sort((a, b) => a.weeklySalary - b.weeklySalary);
    const fee = fa[0].weeklySalary * content.economy.signingFeeWeeks;
    const before = me.cash;
    expect(applyCommand(s, content, me.id, { type: 'sign', playerId: fa[0].id })).toEqual({ ok: true });
    expect(me.cash).toBe(before - fee);
    expect(fa[0].teamId).toBe(me.id);
    expect(applyCommand(s, content, me.id, { type: 'sign', playerId: fa[0].id }).ok).toBe(false);
    expect(applyCommand(s, content, me.id, { type: 'sign', playerId: fa[1].id }).ok).toBe(true);
    expect(applyCommand(s, content, me.id, { type: 'sign', playerId: fa[2].id }).ok).toBe(false); // 已滿 5 人
    me.cash = 0;
    const s2 = newGame(3, content);
    humanTeam(s2).cash = 0;
    expect(applyCommand(s2, content, s2.humanTeamId, { type: 'sign', playerId: fa[3].id })).toEqual({ ok: false, reason: '資金不足以支付簽約金' });
  });

  it('解約：陣容不可低於 3 人；出賽名單需 3 人不重複且都是自己的', () => {
    const s = newGame(3, content);
    const me = humanTeam(s);
    const mine = rosterOf(s, me.id);
    expect(applyCommand(s, content, me.id, { type: 'release', playerId: mine[0].id }).ok).toBe(false);
    expect(applyCommand(s, content, me.id, { type: 'setLineup', lineup: mine.map((p) => p.id) }).ok).toBe(true);
    expect(applyCommand(s, content, me.id, { type: 'setLineup', lineup: [mine[0].id, mine[0].id, mine[1].id] }).ok).toBe(false);
    const other = s.players.find((p) => p.teamId !== me.id) as GameState['players'][number];
    expect(applyCommand(s, content, me.id, { type: 'setLineup', lineup: [mine[0].id, mine[1].id, other.id] }).ok).toBe(false);
  });

  it('下注：自己的比賽只能押自己；超過上限與資金不足被拒；押注時鎖定賠率', async () => {
    const s = newGame(5, content);
    await advance(s, content, gateway); // 進入第 1 週
    const me = humanTeam(s);
    const own = s.fixtures.find((f) => f.week === 1 && (f.home === me.id || f.away === me.id)) as GameState['fixtures'][number];
    const wrongSide = own.home === me.id ? 'away' : 'home';
    expect(applyCommand(s, content, me.id, { type: 'bet', fixtureId: own.id, side: wrongSide, stake: 50 }).ok).toBe(false);
    const rightSide = own.home === me.id ? 'home' : 'away';
    expect(applyCommand(s, content, me.id, { type: 'bet', fixtureId: own.id, side: rightSide, stake: 50 })).toEqual({ ok: true });
    expect(s.bets).toHaveLength(1);
    expect(s.bets[0].oddsX100).toBeGreaterThanOrEqual(105);
    expect(applyCommand(s, content, me.id, { type: 'bet', fixtureId: own.id, side: rightSide, stake: 9_999 }).ok).toBe(false);
    expect(applyCommand(s, content, me.id, { type: 'bet', fixtureId: own.id, side: rightSide, stake: 5 }).ok).toBe(false);
  });

  it('練習賽與研發共用訓練中心每週場數；球探要付費', () => {
    const s = newGame(5, content);
    const me = humanTeam(s);
    const mine = rosterOf(s, me.id)[0];
    const foe = s.players.find((p) => p.teamId !== null && p.teamId !== me.id) as GameState['players'][number];
    expect(applyCommand(s, content, me.id, { type: 'queueScrim', playerId: mine.id, opponentId: foe.id, games: 150 }).ok).toBe(true);
    expect(applyCommand(s, content, me.id, { type: 'queueResearch', playerId: mine.id, target: 'generic', games: 60 }).ok).toBe(false);
    expect(applyCommand(s, content, me.id, { type: 'queueResearch', playerId: mine.id, target: 'generic', games: 50 }).ok).toBe(true);
    const before = me.cash;
    expect(applyCommand(s, content, me.id, { type: 'scout', playerId: foe.id })).toEqual({ ok: true });
    expect(me.cash).toBe(before - content.economy.scoutCost);
    expect(applyCommand(s, content, me.id, { type: 'scout', playerId: foe.id }).ok).toBe(false);
  });
});

describe('完整賽段', () => {
  it('9 週打完：32 場全有結果、名次完整、帳本與資金一致、Elo 總分守恆', async () => {
    const s = newGame(11, content);
    const start = startCashes(s);
    const eloSum = s.players.reduce((x, p) => x + p.elo, 0);
    await runSeason(s, content, gateway, null);
    expect(['ended', 'bankrupt']).toContain(s.phase);
    expect(s.fixtures).toHaveLength(28 + 4);
    expect(s.fixtures.every((f) => f.result !== null && f.result.slots.length === LINEUP_SIZE)).toBe(true);
    expect(s.seasonResult?.ranks).toHaveLength(8);
    expect(new Set(s.seasonResult?.ranks).size).toBe(8);
    for (const t of s.teams) expect(t.cash).toBe((start.get(t.id) as number) + t.ledger.reduce((x, e) => x + e.amount, 0));
    expect(s.players.reduce((x, p) => x + p.elo, 0)).toBe(eloSum);
  });

  it('季後賽：前 4 名打準決賽，冠亞軍是決賽雙方', async () => {
    const s = newGame(12, content);
    await runSeason(s, content, gateway, null);
    const top4 = standings(s)
      .slice(0, 4)
      .map((r) => r.teamId);
    const semis = s.fixtures.filter((f) => f.stage === 'semi');
    expect(new Set(semis.flatMap((f) => [f.home, f.away]))).toEqual(new Set(top4));
    const final = s.fixtures.find((f) => f.stage === 'final') as GameState['fixtures'][number];
    expect(final.week).toBe(TOTAL_WEEKS);
    expect(new Set(s.seasonResult?.ranks.slice(0, 2))).toEqual(new Set([final.home, final.away]));
    expect(semis.every((f) => f.week === REGULAR_WEEKS + 1)).toBe(true);
  });

  it('同一個種子、同一個策略，整季結果完全相同', async () => {
    const a = newGame(21, content);
    await runSeason(a, content, gateway, POLICIES.splurge);
    const b = newGame(21, content);
    await runSeason(b, content, gateway, POLICIES.splurge);
    expect(serialize(b)).toBe(serialize(a));
  });

  it('讀檔後繼續打，與不中斷打完的結果相同', async () => {
    const whole = newGame(22, content);
    await runSeason(whole, content, gateway, null);
    const part = newGame(22, content);
    for (let i = 0; i < 5; i++) await advance(part, content, gateway);
    const loaded = deserialize(serialize(part), content);
    await runSeason(loaded, content, gateway, null);
    expect(serialize(loaded)).toBe(serialize(whole));
  });

  it('現金為負的玩家在週結算後破產，賽段結束後不能再推進', async () => {
    const s = newGame(31, content);
    humanTeam(s).cash = -1;
    await advance(s, content, gateway); // 休賽期 → 第 1 週，不結算
    expect(s.phase).toBe('season');
    await advance(s, content, gateway);
    expect(s.phase).toBe('bankrupt');
    await expect(advance(s, content, gateway)).rejects.toThrow();
    expect(applyCommand(s, content, s.humanTeamId, { type: 'upgradeTraining' }).ok).toBe(false);
  });
});

describe('背景工作與升版', () => {
  it('球探報告在推進後出現，估計值接近真實強度；情報不會出現在別隊的已知視圖', async () => {
    const s = newGame(41, content);
    const me = humanTeam(s);
    const foe = s.players.find((p) => p.teamId !== null && p.teamId !== me.id) as GameState['players'][number];
    applyCommand(s, content, me.id, { type: 'scout', playerId: foe.id });
    await advance(s, content, gateway);
    expect(me.intel).toHaveLength(1);
    expect(knownView(s, content, me.id).intel).toHaveLength(1);
    const other = s.teams.find((t) => t.id !== me.id) as GameState['teams'][number];
    expect(knownView(s, content, other.id).intel).toHaveLength(0);
    const lineage = content.lineages.find((l) => l.id === foe.lineageId) as (typeof content.lineages)[number];
    const truth = lineage.power[foe.version - 1] + foe.habit;
    expect(Math.abs(me.intel[0].estPower - truth)).toBeLessThan(content.economy.scoutSd * 4);
  });

  it('研發：場數越多加成上限越高；升版 2 週後完成並讓預設失效', async () => {
    const s = newGame(42, content);
    const me = humanTeam(s);
    const p = rosterOf(s, me.id)[0];
    p.version = 1;
    me.cash = 5000;
    applyCommand(s, content, me.id, { type: 'queueResearch', playerId: p.id, target: 'generic', games: 200 });
    applyCommand(s, content, me.id, { type: 'upgradeVersion', playerId: p.id });
    expect(applyCommand(s, content, me.id, { type: 'upgradeVersion', playerId: p.id }).ok).toBe(false);
    const salary = p.weeklySalary;
    await advance(s, content, gateway);
    expect(p.presets).toHaveLength(1);
    expect(p.presets[0].bonus).toBeLessThanOrEqual(Math.ceil(content.economy.researchCapGeneric * 1.3));
    await advance(s, content, gateway); // 第 1 週
    await advance(s, content, gateway); // 第 2 週結算後升版完成
    expect(p.version).toBe(2);
    expect(p.weeklySalary).toBe(Math.round((salary * content.economy.salaryGrowthPct) / 100));
    expect(p.presets).toHaveLength(0);
  });
});

describe('資訊分層', () => {
  it('已知層視圖裡看不到隱藏的習慣、戰術預設的真實加成、流派真實強度', async () => {
    const s = newGame(51, content);
    const me = humanTeam(s);
    const p = rosterOf(s, me.id)[0];
    applyCommand(s, content, me.id, { type: 'queueResearch', playerId: p.id, target: 'generic', games: 100 });
    await advance(s, content, gateway);
    const forbidden = new Set(['habit', 'bonus', 'power', 'truePower']);
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          expect(forbidden.has(k), `視圖不該有 ${path}.${k}`).toBe(false);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(knownView(s, content, me.id), 'view');
    expect(knownView(s, content, me.id).presets).toHaveLength(1);
  });

  it('視圖：資金跑道不會是負數；別隊的視圖看不到玩家的信箱', () => {
    const s = newGame(52, content);
    humanTeam(s).cash = -50;
    const v = knownView(s, content, s.humanTeamId);
    expect(v.me.runwayWeeks === null || v.me.runwayWeeks >= 0).toBe(true);
    expect(v.inbox.length).toBeGreaterThan(0);
    const other = s.teams.find((t) => !t.human) as GameState['teams'][number];
    expect(knownView(s, content, other.id).inbox).toHaveLength(0);
  });
});

describe('自動玩家與平衡下限', () => {
  it('所有策略都能打完賽段，帳本與資金恆等', async () => {
    for (const name of Object.keys(POLICIES)) {
      for (let seed = 1; seed <= 6; seed++) {
        const s = newGame(100 + seed, content);
        const start = startCashes(s);
        await runSeason(s, content, gateway, POLICIES[name]);
        expect(['ended', 'bankrupt'], `${name}/${seed}`).toContain(s.phase);
        for (const t of s.teams) expect(t.cash, `${name}/${seed}/${t.id}`).toBe((start.get(t.id) as number) + t.ledger.reduce((x, e) => x + e.amount, 0));
      }
    }
  });

  it('亂押長期虧損（莊家抽成）', async () => {
    let net = 0;
    let stakes = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = newGame(1000 + seed, content);
      await runSeason(s, content, gateway, POLICIES.randomBettor);
      for (const e of humanTeam(s).ledger) {
        if (e.category !== 'bet') continue;
        net += e.amount;
        if (e.amount < 0) stakes -= e.amount;
      }
    }
    expect(stakes).toBeGreaterThan(0);
    expect(net / stakes).toBeLessThan(0);
  });
});
