// 季中補自由選手（規格 4.14，2026-11-09 使用者決定）：第 3、6 週結算後各補 2 名，N～SR、立繪與名字不重複、獨立亂數串流、存檔不升版。
import { describe, expect, it } from 'vitest';
import { STUB_CONTENT } from '../src/manage/content.ts';
import { MARKET_REFRESH_COUNT, MARKET_REFRESH_WEEKS, advance, newGame, refreshMarket } from '../src/manage/game.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import type { GameState } from '../src/manage/types.ts';
import { SAVE_VERSION, TOTAL_WEEKS } from '../src/manage/types.ts';

const content = STUB_CONTENT;
const gateway = new FakeGateway(content);

/** 推進整季，記下每次推進後新增的選手 id 與當週 */
async function season(seed: number): Promise<{ s: GameState; added: Map<number, string[]> }> {
  const s = newGame(seed, content);
  const added = new Map<number, string[]>();
  while (s.phase !== 'ended' && s.phase !== 'bankrupt') {
    const before = new Set(s.players.map((p) => p.id));
    const week = s.week;
    await advance(s, content, gateway);
    const fresh = s.players.filter((p) => !before.has(p.id)).map((p) => p.id);
    if (fresh.length > 0) added.set(week, fresh);
  }
  return { s, added };
}

describe('季中補自由選手', () => {
  it('第 3、6 週結算後各補 2 名，其他週不補；新人是自由選手、不出 SSR；整局名字與立繪不重複；收件匣通知帶新選手 id', async () => {
    expect(MARKET_REFRESH_WEEKS).toEqual([3, 6]);
    for (const seed of [1, 2, 3]) {
      const { s, added } = await season(seed);
      expect(s.week, `種子 ${seed}`).toBe(TOTAL_WEEKS);
      expect([...added.keys()], `種子 ${seed}`).toEqual([3, 6]);
      for (const ids of added.values()) {
        expect(ids).toHaveLength(MARKET_REFRESH_COUNT);
        for (const id of ids) {
          const p = s.players.find((x) => x.id === id);
          expect(p?.rarity).not.toBe('SSR');
          expect(p?.teamId, '自由選手（這個測試裡玩家與 NPC 季中都不簽人）').toBeNull();
        }
      }
      expect(new Set(s.players.map((p) => p.name)).size).toBe(s.players.length);
      expect(new Set(s.players.map((p) => p.portraitId)).size).toBe(s.players.length);
      const notes = s.inbox.filter((m) => m.playerIds !== undefined);
      expect(notes.map((m) => m.week)).toEqual([3, 6]);
      expect(notes.map((m) => m.playerIds)).toEqual([added.get(3), added.get(6)]);
      for (const m of notes) expect(m.text).toMatch(/^轉會市場新增 2 名自由選手：/);
    }
  });

  it('同種子同結果；存檔讀檔後續打相同；存檔版本不變', async () => {
    const pick = (s: GameState, ids: readonly string[]): unknown[] => ids.map((id) => s.players.find((p) => p.id === id));
    const a = await season(5);
    const b = await season(5);
    expect(pick(b.s, [...b.added.values()].flat())).toEqual(pick(a.s, [...a.added.values()].flat()));
    // 第 4 週存檔、讀回來續打：第 6 週補的人一樣
    const c = newGame(5, content);
    while (c.week < 4) await advance(c, content, gateway);
    const d = deserialize(serialize(c), content);
    while (d.phase !== 'ended' && d.phase !== 'bankrupt') await advance(d, content, gateway);
    expect(pick(d, a.added.get(6) ?? [])).toEqual(pick(a.s, a.added.get(6) ?? []));
    expect(SAVE_VERSION).toBe(11);
  });

  it('獨立串流：只動選手、序號、收件匣，其他狀態不變（開局與賽程不受影響）', () => {
    for (const seed of [1, 7, 21]) {
      const s = newGame(seed, content);
      const before = structuredClone(s);
      const ids = refreshMarket(s, content, 3);
      expect(ids).toHaveLength(2);
      const { players, nextId, inbox, ...rest } = s;
      const { players: p0, nextId: n0, inbox: i0, ...rest0 } = before;
      expect(rest).toEqual(rest0);
      expect(players.slice(0, p0.length)).toEqual(p0);
      expect(nextId).toBe(n0 + 2);
      expect(inbox.slice(0, i0.length)).toEqual(i0);
    }
  });

  it('多種子多週都不出 SSR、名字與立繪不重複；名字用完時少補、不報錯', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = newGame(seed, content);
      for (let w = 1; w <= 9; w++) for (const id of refreshMarket(s, content, w)) expect(s.players.find((p) => p.id === id)?.rarity).not.toBe('SSR');
      expect(new Set(s.players.map((p) => p.name)).size).toBe(s.players.length);
      expect(new Set(s.players.map((p) => p.portraitId)).size).toBe(s.players.length);
    }
    const s = newGame(1, content);
    const left = content.handles.filter((h) => !s.players.some((p) => p.name === h));
    // 只剩 1 個名字：只補 1 人
    for (const h of left.slice(1)) s.players.push({ ...structuredClone(s.players[0]), id: `x${h}`, name: h, portraitId: `none-${h}` });
    expect(refreshMarket(s, content, 3)).toHaveLength(1);
    expect(refreshMarket(s, content, 6)).toEqual([]);
  });
});
