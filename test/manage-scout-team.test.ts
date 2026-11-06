// M5 5.3 球探對戰隊：報告的整理規則（近 3 場、各陣營前三名、同數依內容包順序）、指令的檢查與扣費、推進後回報、
// 已知層（只有自己派的報告；報告不含熟練度與計畫）、存檔第 8 → 9 版遷移。
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/manage/commands.ts';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import { STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import type { BattleGateway, MatchOutcome, MatchRequest } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { humanTeam } from '../src/manage/state.ts';
import { teamTacticReport } from '../src/manage/stats.ts';
import { SAVE_VERSION, type GameState } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';

const content: ContentPack = { ...STUB_CONTENT, tactics: SHOOTER_TACTICS };
const fake = new FakeGateway(content);

/** 回合戰術標籤由種子決定：A 方 T 輪流 rushB／rushB／splitA，CT stackA；B 方 T default，CT ct212／ctPush */
class TagGateway implements BattleGateway {
  readonly formats = fake.formats;
  async simulateBatch(requests: readonly MatchRequest[]): Promise<MatchOutcome[]> {
    const outs = await fake.simulateBatch(requests);
    return outs.map((o) => ({
      ...o,
      rounds: o.rounds.map((r, i) => ({ ...r, tactics: i % 2 === 0 ? { a: ['rushB', 'rushB', 'splitA'][i % 3], b: i % 4 === 0 ? 'ct212' : 'ctPush' } : { a: 'stackA', b: 'default' } })),
    }));
  }
}

/** 手造一場已打完的比賽（只填報告會看的欄位） */
function played(s: GameState, week: number, home: string, away: string, rounds: { a: string | null; b: string | null; winner: 'a' | 'b' }[]): void {
  s.fixtures.push({
    id: `x${s.fixtures.length}`,
    week,
    stage: 'regular',
    home,
    away,
    result: { lineupA: [], lineupB: [], winner: null, scoreA: 0, scoreB: 0, rounds: rounds.map((r) => ({ label: '', winner: r.winner, scoreA: 0, scoreB: 0, tactics: { a: r.a, b: r.b } })), request: { formatId: '', a: { players: [] }, b: { players: [] }, seed: 0 } },
  });
}

describe('球探對戰隊：報告整理', () => {
  it('只看最近 3 場；依陣營各取前三；同數依內容包順序；勝場照該隊那一方算；沒標籤的回合不算', () => {
    const s = newGame(31, content);
    s.fixtures = [];
    const [x, y, z] = s.teams.map((t) => t.id);
    // 第 1 週（最舊，不在近 3 場）：大量 fake，應該看不到
    played(s, 1, x, y, Array.from({ length: 6 }, () => ({ a: 'fake', b: 'ct212', winner: 'a' as const })));
    // 第 2 週：x 是客隊（b 方）
    played(s, 2, y, x, [
      { a: 'ct212', b: 'rushA', winner: 'b' },
      { a: 'ct212', b: 'rushA', winner: 'a' },
      { a: 'rushB', b: 'stackB', winner: 'b' },
    ]);
    // 第 3 週：x 主場
    played(s, 3, x, z, [
      { a: 'splitB', b: 'ct212', winner: 'a' },
      { a: 'rushA', b: 'ct212', winner: 'b' },
      { a: null, b: 'ct212', winner: 'b' },
      { a: 'stackA', b: 'default', winner: 'a' },
    ]);
    // 第 4 週：x 主場
    played(s, 4, x, y, [
      { a: 'default', b: 'stackA', winner: 'a' },
      { a: 'splitB', b: 'ct212', winner: 'a' },
      { a: 'ctPush', b: 'rushB', winner: 'a' },
    ]);
    s.week = 5;
    const r = teamTacticReport(s, content, x);
    expect(r.weeks).toEqual([4, 3, 2]);
    expect(r.week).toBe(5);
    // T：rushA 3 回合贏 1（第 2 週當 b 方贏 1 輸 1、第 3 週輸）；splitB 2 回合贏 2；default 1 回合贏 1
    expect(r.top.T).toEqual([
      { tactic: 'rushA', played: 3, won: 1 },
      { tactic: 'splitB', played: 2, won: 2 },
      { tactic: 'default', played: 1, won: 1 },
    ]);
    // CT：stackB、stackA、ctPush 各 1 → 依內容包順序 stackA、stackB、ctPush
    expect(r.top.CT).toEqual([
      { tactic: 'stackA', played: 1, won: 1 },
      { tactic: 'stackB', played: 1, won: 1 },
      { tactic: 'ctPush', played: 1, won: 1 },
    ]);
    expect(r.rounds).toEqual({ T: 6, CT: 3 });
    // 第 1 週的 fake 不在近 3 場
    expect(r.top.T.some((t) => t.tactic === 'fake')).toBe(false);
  });

  it('沒打過比賽：空報告', () => {
    const s = newGame(32, content);
    const r = teamTacticReport(s, content, s.teams[1].id);
    expect(r.weeks).toEqual([]);
    expect(r.top).toEqual({ T: [], CT: [] });
  });
});

describe('球探對戰隊：指令與回報', () => {
  it('扣球探費、推進後回報（含本週那場）、收件匣有報告；同一隊不能重派；看自己、休賽期、沒有戰術手冊都拒絕', async () => {
    const s = newGame(33, content);
    const me = humanTeam(s);
    const g = new TagGateway();
    const other = s.teams.find((t) => !t.human) as GameState['teams'][number];
    expect(applyCommand(s, content, me.id, { type: 'scoutTeam', teamId: other.id })).toEqual({ ok: false, reason: '賽季還沒開始，沒有比賽可看' });
    await advance(s, content, g);
    expect(s.phase).toBe('season');
    expect(applyCommand(s, content, me.id, { type: 'scoutTeam', teamId: me.id })).toEqual({ ok: false, reason: '球探要看的是別隊' });
    expect(applyCommand(s, { ...content, tactics: [] }, me.id, { type: 'scoutTeam', teamId: other.id })).toEqual({ ok: false, reason: '這個賽制沒有戰術手冊' });
    const cash = me.cash;
    expect(applyCommand(s, content, me.id, { type: 'scoutTeam', teamId: other.id })).toEqual({ ok: true });
    expect(me.cash).toBe(cash - content.economy.scoutCost);
    expect(me.ledger[me.ledger.length - 1].category).toBe('scout');
    expect(applyCommand(s, content, me.id, { type: 'scoutTeam', teamId: other.id })).toEqual({ ok: false, reason: '已經派球探去看這隊了' });
    await advance(s, content, g);
    expect(s.jobs.some((j) => j.kind === 'scoutTeam')).toBe(false);
    const rep = me.teamIntel.find((r) => r.teamId === other.id);
    expect(rep?.weeks).toEqual([1]);
    expect(rep?.week).toBe(1);
    const total = (rep?.rounds.T ?? 0) + (rep?.rounds.CT ?? 0);
    const f = s.fixtures.find((x) => x.week === 1 && (x.home === other.id || x.away === other.id));
    expect(total).toBe(f?.result?.rounds.length);
    expect(s.inbox.some((m) => m.text.startsWith(`球探報告：${other.name} 近 1 場的常用戰術。進攻：`))).toBe(true);
    // 再派一次：同一隊只留最新一份
    expect(applyCommand(s, content, me.id, { type: 'scoutTeam', teamId: other.id })).toEqual({ ok: true });
    await advance(s, content, g);
    expect(me.teamIntel.filter((r) => r.teamId === other.id)).toHaveLength(1);
    expect(me.teamIntel.find((r) => r.teamId === other.id)?.weeks).toEqual([2, 1]);
  });

  it('資金不足拒絕', async () => {
    const s = newGame(34, content);
    await advance(s, content, new TagGateway());
    const me = humanTeam(s);
    me.cash = content.economy.scoutCost - 1;
    expect(applyCommand(s, content, me.id, { type: 'scoutTeam', teamId: s.teams.find((t) => !t.human)?.id as string })).toEqual({ ok: false, reason: '資金不足' });
  });
});

describe('球探對戰隊：已知層與存檔', () => {
  it('報告只在派的那隊的視圖裡，只有戰術代號與回合數（不含熟練度、計畫）', async () => {
    const s = newGame(35, content);
    const g = new TagGateway();
    await advance(s, content, g);
    const me = humanTeam(s);
    const other = s.teams.find((t) => !t.human) as GameState['teams'][number];
    applyCommand(s, content, me.id, { type: 'scoutTeam', teamId: other.id });
    await advance(s, content, g);
    const mine = knownView(s, content, me.id);
    expect(mine.teamIntel).toHaveLength(1);
    expect(Object.keys(mine.teamIntel[0]).sort()).toEqual(['rounds', 'teamId', 'top', 'week', 'weeks']);
    for (const x of [...mine.teamIntel[0].top.T, ...mine.teamIntel[0].top.CT]) expect(Object.keys(x).sort()).toEqual(['played', 'tactic', 'won']);
    // 被看的那隊與其他 NPC 看不到我方派的報告
    for (const t of s.teams.filter((x) => !x.human)) expect(knownView(s, content, t.id).teamIntel).toEqual([]);
    // 視圖是複本
    mine.teamIntel[0].top.T.length = 0;
    expect(me.teamIntel[0].top.T.length).toBeGreaterThan(0);
  });

  it('第 11 版存讀一致；第 8 版補空報告（串到第 11 版）', async () => {
    const s = newGame(36, content);
    const g = new TagGateway();
    await advance(s, content, g);
    applyCommand(s, content, humanTeam(s).id, { type: 'scoutTeam', teamId: s.teams.find((t) => !t.human)?.id as string });
    await advance(s, content, g);
    expect(SAVE_VERSION).toBe(11);
    expect(JSON.parse(serialize(deserialize(serialize(s), content)))).toEqual(JSON.parse(serialize(s)));
    const v8 = JSON.parse(serialize(s)) as GameState & Record<string, unknown>;
    v8.version = 8;
    for (const t of v8.teams as unknown as Record<string, unknown>[]) delete t.teamIntel;
    const m = deserialize(JSON.stringify(v8), content);
    expect(m.version).toBe(11);
    for (const t of m.teams) expect(t.teamIntel).toEqual([]);
  });
});
