// M5 第四批 4a（經營層）：助理教練（請／辭、週薪）、NPC 依個性請教練、請求單帶 coachAi、成績單的指令存進賽程（玩家方的 AI 標成助理教練）、
// 指令賽後雙方公開、存檔第 9 → 10 版。
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/manage/commands.ts';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import { STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import type { BattleGateway, CoachEvent, MatchOutcome, MatchRequest } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { NPC_ASSISTANT_WEEKS, npcAssistant } from '../src/manage/npc.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { humanTeam, weeklyFixedCost } from '../src/manage/state.ts';
import { SAVE_VERSION, type GameState, type Persona } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';

const content: ContentPack = { ...STUB_CONTENT, tactics: SHOOTER_TACTICS, economy: { ...STUB_CONTENT.economy, assistantSalary: 20 } };
const fake = new FakeGateway(content);

/** 記下請求單；有 AI 教練的一方在第 1 回合回一則指令（閘道把 AI 標成 npc） */
class CoachSpy implements BattleGateway {
  readonly formats = fake.formats;
  readonly sent: MatchRequest[] = [];
  async simulateBatch(requests: readonly MatchRequest[]): Promise<MatchOutcome[]> {
    this.sent.push(...requests);
    const outs = await fake.simulateBatch(requests);
    return outs.map((o, i) => {
      const ai = requests[i].coachAi;
      if (ai === undefined) return o;
      const calls: CoachEvent[] = (['a', 'b'] as const).filter((s) => ai[s] !== null).map((side) => ({ round: 1, side, kind: 'timeout', plan: null, call: { tactic: 'rushA', buy: null }, by: 'npc' }));
      return { ...o, calls };
    });
  }
}

describe('助理教練：指令與週薪', () => {
  it('請／辭；重複請、沒請就辭、賽制沒有戰術手冊都拒絕；週薪算進固定支出、週結算付；自己的視圖看得到', async () => {
    const s = newGame(41, content);
    const me = humanTeam(s);
    expect(applyCommand(s, STUB_CONTENT, me.id, { type: 'hireAssistant' })).toEqual({ ok: false, reason: '這個賽制沒有戰術手冊' });
    expect(applyCommand(s, content, me.id, { type: 'fireAssistant' })).toEqual({ ok: false, reason: '沒有請助理教練' });
    const fixed = weeklyFixedCost(s, content, me);
    expect(applyCommand(s, content, me.id, { type: 'hireAssistant' })).toEqual({ ok: true });
    expect(applyCommand(s, content, me.id, { type: 'hireAssistant' })).toEqual({ ok: false, reason: '已經請了助理教練' });
    expect(weeklyFixedCost(s, content, me)).toBe(fixed + 20);
    expect(knownView(s, content, me.id).me.assistant).toBe(true);
    await advance(s, content, fake);
    await advance(s, content, fake);
    expect(me.ledger.filter((x) => x.memo === '助理教練週薪').map((x) => x.amount)).toEqual([-20]);
    expect(applyCommand(s, content, me.id, { type: 'fireAssistant' })).toEqual({ ok: true });
    expect(knownView(s, content, me.id).me.assistant).toBe(false);
  });

  it('NPC：豪門、數據派一定請；青訓派、守財奴現金夠撐門檻週數才請，跌破就辭', () => {
    const s = newGame(42, content);
    const npc = s.teams.find((t) => !t.human) as GameState['teams'][number];
    const view = (cash: number, assistant: boolean): ReturnType<typeof knownView> => {
      npc.cash = cash;
      npc.assistant = assistant;
      return knownView(s, content, npc.id);
    };
    for (const p of ['whale', 'data'] as Persona[]) expect(npcAssistant(view(0, false), p, content)).toEqual([{ type: 'hireAssistant' }]);
    for (const p of ['youth', 'miser'] as Persona[]) {
      npc.assistant = false;
      const fixed = weeklyFixedCost(s, content, npc) + 20;
      expect(npcAssistant(view(NPC_ASSISTANT_WEEKS[p] * fixed - 1, false), p, content)).toEqual([]);
      expect(npcAssistant(view(NPC_ASSISTANT_WEEKS[p] * fixed, false), p, content)).toEqual([{ type: 'hireAssistant' }]);
      expect(npcAssistant(view(0, true), p, content)).toEqual([{ type: 'fireAssistant' }]);
    }
    expect(npcAssistant(view(0, false), 'whale', STUB_CONTENT)).toEqual([]);
  });
});

describe('比賽日：請求單帶 coachAi、指令存進賽程', () => {
  it('有請的一方 coachAi＝1；雙方都沒請不帶這欄；指令存進賽程，玩家方的 AI 標成助理教練；賽後雙方公開', async () => {
    const s = newGame(43, content);
    const me = humanTeam(s);
    applyCommand(s, content, me.id, { type: 'hireAssistant' });
    const g = new CoachSpy();
    await advance(s, content, g);
    await advance(s, content, g);
    const byId = new Map(s.teams.map((t) => [t.id, t]));
    for (const r of g.sent) {
      const f = s.fixtures.find((x) => x.result?.request.seed === r.seed) as GameState['fixtures'][number];
      const [h, a] = [byId.get(f.home), byId.get(f.away)];
      if (!h?.assistant && !a?.assistant) expect(r.coachAi).toBeUndefined();
      else expect(r.coachAi).toEqual({ a: h?.assistant ? 1 : null, b: a?.assistant ? 1 : null });
    }
    // NPC 的豪門、數據派這週已經請了
    expect(s.teams.filter((t) => t.persona === 'whale' || t.persona === 'data').every((t) => t.assistant)).toBe(true);
    const mine = s.fixtures.find((f) => f.result !== null && (f.home === me.id || f.away === me.id)) as GameState['fixtures'][number];
    const side = mine.home === me.id ? 'a' : 'b';
    expect(mine.result?.calls?.find((c) => c.side === side)?.by).toBe('assistant');
    // 對方（NPC）的指令也公開：任何一隊的視圖都看得到這場的雙方指令
    const npc = s.teams.find((t) => !t.human) as GameState['teams'][number];
    const seen = knownView(s, content, npc.id).fixtures.find((f) => f.id === mine.id)?.match?.calls;
    expect(seen).toEqual(mine.result?.calls);
    // 沒有指令的比賽不存 calls
    expect(s.fixtures.filter((f) => f.result !== null && f.result.request.coachAi === undefined).every((f) => f.result?.calls === undefined)).toBe(true);
  });
});

describe('存檔', () => {
  it('第 11 版存讀一致；第 9 版遷移後沒有助理教練（串到第 11 版）', async () => {
    const s = newGame(44, content);
    applyCommand(s, content, humanTeam(s).id, { type: 'hireAssistant' });
    await advance(s, content, new CoachSpy());
    await advance(s, content, new CoachSpy());
    expect(SAVE_VERSION).toBe(11);
    expect(JSON.parse(serialize(deserialize(serialize(s), content)))).toEqual(JSON.parse(serialize(s)));
    const v9 = JSON.parse(serialize(s)) as GameState & Record<string, unknown>;
    v9.version = 9;
    for (const t of v9.teams as unknown as Record<string, unknown>[]) delete t.assistant;
    const m = deserialize(JSON.stringify(v9), content);
    expect(m.version).toBe(11);
    expect(m.teams.every((t) => t.assistant === false)).toBe(true);
  });
});
