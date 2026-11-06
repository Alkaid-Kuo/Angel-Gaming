// M5 第四批 4b：教練身分即時看我方比賽（規格 6.1、6.8）。真引擎、聯賽賽制 MR6。
// 1 確定性：即時打一場（第 3、8 回合暫停各喊不同命令、中場改計畫）與「請求單＋指令」批次重跑（finish 寫進賽程的那場）回合、標籤、指令完全相同。
// 7 教練離席：第 3 回合喊過指令、第 5 回合離席 → 前 5 回合與即時看到的一致，之後由助理教練接手，結果等於即時那場繼續打完；
//   重開遊戲（沒說怎麼結束）照離席處理，n＝最後一則指令的回合，連續讀檔兩次得到同一結果。
// 8 一般觀戰＝跳過：沒有 beginMatchDay 時照舊（請求單同第四批 4a）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/manage/commands.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import type { ContentPack } from '../src/manage/content.ts';
import { advance, beginMatchDay, newGame, recordCall } from '../src/manage/game.ts';
import { ShooterGateway } from '../src/manage/gateway-shooter.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { humanTeam } from '../src/manage/state.ts';
import type { GameState } from '../src/manage/types.ts';
import { outcomeOf } from '../src/shooter/gateway.ts';
import { LiveCoach } from '../src/shooter/live-coach.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const content: ContentPack = { ...SHOOTER_CONTENT, formatId: 'shooter-mr6' };
const gateway = new ShooterGateway();
const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');

/** 開局推到第 1 週、準備即時比賽 */
async function week1(seed: number, assistant: boolean): Promise<GameState> {
  const s = newGame(seed, content, { gateway });
  if (assistant) applyCommand(s, content, humanTeam(s).id, { type: 'hireAssistant' });
  await advance(s, content, gateway);
  return s;
}

/** 跑完即時那場：script(round) 在停下來時決定要喊什麼；leaveAt：打到這回合時離席（之後照打到完） */
function playLive(lc: LiveCoach, script: (lc: LiveCoach) => void, leaveAt: number | null = null): void {
  const m = lc.driver.match;
  while (!m.over) {
    if (leaveAt !== null && lc.leftAt === null && m.roundNumber === leaveAt) lc.leave();
    if (lc.leftAt === null && m.roundNumber === 2) lc.requestPause();
    if (lc.leftAt === null && m.roundNumber === 7) lc.requestPause();
    const stop = lc.step();
    if (stop !== null) script(lc);
  }
}

const tacticFor = (side: 'T' | 'CT', t: string, ct: string): string => (side === 'T' ? t : ct);

describe('即時比賽：教練身分（真引擎 MR6）', () => {
  it('第 3、8 回合暫停各喊命令、中場改計畫：即時那場與 finish 寫進賽程的批次重跑完全相同；命令回合標籤＝命令', async () => {
    const s = await week1(51, false);
    const t = beginMatchDay(s, content);
    expect(t).not.toBeNull();
    if (t === null) return;
    const saved = JSON.parse(serialize(s)) as GameState;
    expect(saved.matchDay?.live?.fixtureId).toBe(t.fixtureId);
    const lc = new LiveCoach({ request: t.request, bot, side: t.side, assistant: t.assistant });
    const seen: number[] = [];
    playLive(lc, (x) => {
      const w = x.waiting;
      if (w === null) return;
      seen.push(w.round);
      const ev = w.kind === 'halftime' ? x.resolve({ ...w.plan, economy: 1 }, null) : x.resolve(null, { tactic: tacticFor(w.side, w.round === 3 ? 'splitB' : 'fake', w.round === 3 ? 'stackA' : 'ctPush'), buy: w.round === 3 ? 'eco' : null });
      if (ev !== null) recordCall(s, ev);
    });
    expect(seen).toEqual([3, 7, 8]);
    expect(lc.calls.map((c) => [c.round, c.kind])).toEqual([
      [3, 'timeout'],
      [7, 'halftime'],
      [8, 'timeout'],
    ]);
    const m = lc.driver.match;
    const liveOut = outcomeOf(m.result(), m, lc.driver.tacticTags);
    for (const r of [3, 8]) expect(liveOut.rounds[r - 1].tactics?.[t.side]).toBe(lc.calls.find((c) => c.round === r)?.call?.tactic);
    await advance(s, content, gateway, { live: { leftAt: null } });
    expect(s.matchDay).toBeNull();
    const f = s.fixtures.find((x) => x.id === t.fixtureId) as GameState['fixtures'][number];
    expect(f.result?.rounds).toEqual(liveOut.rounds);
    expect(f.result?.calls?.filter((c) => c.side === t.side)).toEqual(lc.calls);
    expect(f.result?.request.calls).toEqual(lc.calls);
    expect(f.result?.request.coachAi?.[t.side]).toBeNull();
  }, 300_000);

  it('教練離席：第 3 回合喊過、第 5 回合離席 → 助理教練從第 6 回合接手；即時繼續打完的那場＝批次重跑', async () => {
    const s = await week1(52, true);
    const t = beginMatchDay(s, content);
    if (t === null) throw new Error('沒有我方比賽');
    const lc = new LiveCoach({ request: t.request, bot, side: t.side, assistant: t.assistant });
    playLive(
      lc,
      (x) => {
        const w = x.waiting;
        if (w === null) return;
        const ev = x.resolve(null, { tactic: tacticFor(w.side, 'rushA', 'stackB'), buy: null });
        if (ev !== null) recordCall(s, ev);
      },
      5,
    );
    expect(lc.leftAt).toBe(5);
    expect(lc.calls.map((c) => c.round)).toEqual([3]);
    expect(lc.log.filter((c) => c.side === t.side && c.round > 5).every((c) => c.by === 'npc')).toBe(true);
    const m = lc.driver.match;
    const liveOut = outcomeOf(m.result(), m, lc.driver.tacticTags);
    await advance(s, content, gateway, { live: { leftAt: 5 } });
    const f = s.fixtures.find((x) => x.id === t.fixtureId) as GameState['fixtures'][number];
    expect(f.result?.rounds).toEqual(liveOut.rounds);
    expect(f.result?.request.coachAi?.[t.side]).toBe(6);
    // 我方 AI（助理教練）的指令標成助理教練
    expect(f.result?.calls?.filter((c) => c.side === t.side && c.round > 5).every((c) => c.by === 'assistant')).toBe(true);
  }, 300_000);

  it('重開遊戲（沒說怎麼結束）照離席處理：n＝最後一則指令的回合；同一份存檔讀兩次結果相同', async () => {
    const s = await week1(53, true);
    const t = beginMatchDay(s, content);
    if (t === null) throw new Error('沒有我方比賽');
    recordCall(s, { round: 3, side: t.side, kind: 'timeout', plan: null, call: { tactic: null, buy: 'eco' }, by: 'human' });
    const json = serialize(s);
    const runs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const x = deserialize(json, content);
      await advance(x, content, gateway);
      const f = x.fixtures.find((q) => q.id === t.fixtureId) as GameState['fixtures'][number];
      expect(f.result?.request.coachAi?.[t.side]).toBe(4);
      expect(f.result?.request.calls).toHaveLength(1);
      runs.push(JSON.stringify(f.result));
    }
    expect(runs[1]).toBe(runs[0]);
  }, 300_000);
});

describe('一般觀戰／跳過', () => {
  it('沒有 beginMatchDay：請求單和第四批 4a 相同（沒有 calls；我方 coachAi 照有沒有請助理教練）', async () => {
    const s = await week1(54, true);
    await advance(s, content, gateway);
    const me = humanTeam(s).id;
    const f = s.fixtures.find((x) => x.week === 1 && (x.home === me || x.away === me)) as GameState['fixtures'][number];
    expect(f.result?.request.calls).toBeUndefined();
    expect(f.result?.request.coachAi?.[f.home === me ? 'a' : 'b']).toBe(1);
  }, 300_000);
});
