// 正式版讀檔（src/web/manage/save-parse.ts）：第 5～9 版的攻防戰存檔要能讀、自動遷移到目前版本；
// 第 4 版以前、比目前新、不是數字的版本、不認得的內容包都拒絕並給玩家看得懂的訊息。
// 舊檔用 newGame 產生後改回舊欄位（和 test/manage-attrs.test.ts、manage-playbook.test.ts 的做法相同）。
import { describe, expect, it } from 'vitest';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import type { ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import type { BattleGateway } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { serialize } from '../src/manage/save.ts';
import { stageOfPlayer } from '../src/manage/state.ts';
import { attrsAt } from '../src/manage/attrs.ts';
import { SAVE_VERSION, type GameState } from '../src/manage/types.ts';
import { OLDEST_MIGRATABLE, parseSave } from '../src/web/manage/save-parse.ts';

const c = SHOOTER_CONTENT;
const kinds = (id: string): ContentPack | undefined => (id === c.id ? c : undefined);
const fake = new FakeGateway(c);
const gw: BattleGateway = { formats: [{ ...fake.formats[0], id: c.formatId }], simulateBatch: (r, p) => fake.simulateBatch(r, p) };

type Raw = Record<string, unknown> & GameState;
const asRaw = (s: GameState): Raw => JSON.parse(serialize(s)) as Raw;

/** 第 10 版 → 第 9 版的樣子：沒有助理教練 */
function toV9(s: GameState): Raw {
  const r = asRaw(s);
  r.version = 9;
  for (const t of r.teams as unknown as Record<string, unknown>[]) delete t.assistant;
  return r;
}
/** 第 9 版 → 第 8 版的樣子：沒有球探對戰隊報告 */
function toV8(s: GameState): Raw {
  const r = toV9(s);
  r.version = 8;
  for (const t of r.teams as unknown as Record<string, unknown>[]) delete t.teamIntel;
  return r;
}
/** 第 8 版 → 第 7 版的樣子：選手回到版本制 */
function toV7(s: GameState): Raw {
  const r = toV8(s);
  r.version = 7;
  for (const p of r.players as unknown as Record<string, unknown>[]) {
    p.version = stageOfPlayer(c, s.players.find((x) => x.id === p.id) as GameState['players'][number]);
    p.upgradeUntilWeek = null;
    delete p.attrs;
    delete p.caps;
    delete p.progress;
  }
  for (const t of r.teams) for (const i of t.intel as unknown as Record<string, unknown>[]) delete i.attrs;
  return r;
}
/** 再往前一版：第 6 版沒有個人統計與戰術紀錄 */
function toV6(s: GameState): Raw {
  const r = toV7(s);
  r.version = 6;
  for (const p of r.players as unknown as Record<string, unknown>[]) delete p.season;
  for (const t of r.teams as unknown as Record<string, unknown>[]) delete t.tacticLog;
  for (const f of r.fixtures) if (f.result !== null) delete (f.result as unknown as Record<string, unknown>).stats;
  return r;
}
/** 第 5 版（M4）：沒有戰術手冊 */
function toV5(s: GameState): Raw {
  const r = toV6(s);
  r.version = 5;
  for (const p of r.players as unknown as Record<string, unknown>[]) {
    delete p.tactics;
    delete p.newFace;
  }
  for (const t of r.teams as unknown as Record<string, unknown>[]) {
    delete t.playbook;
    delete t.gamePlan;
  }
  return r;
}

describe('正式版讀檔：舊版存檔遷移', () => {
  it('第 5、6、7、8、9 版的攻防戰存檔都讀得了，版本變成目前版本，收件匣多了遷移說明', async () => {
    const s = newGame(21, c);
    await advance(s, c, gw);
    await advance(s, c, gw);
    expect(SAVE_VERSION).toBe(10);
    expect(OLDEST_MIGRATABLE).toBe(5);
    for (const [v, raw] of [
      [5, toV5(s)],
      [6, toV6(s)],
      [7, toV7(s)],
      [8, toV8(s)],
      [9, toV9(s)],
    ] as const) {
      const inbox0 = raw.inbox.length;
      const r = parseSave(JSON.stringify(raw), kinds);
      expect(r.migratedFrom, `第 ${v} 版`).toBe(v);
      expect(r.state.version).toBe(SAVE_VERSION);
      expect(r.content).toBe(c);
      expect(r.state.teams.every((t) => t.assistant === false)).toBe(true);
      if (v <= 8) expect(r.state.teams.every((t) => Array.isArray(t.teamIntel) && t.teamIntel.length === 0)).toBe(true);
      if (v >= 8) {
        expect(r.state.inbox.length).toBe(inbox0);
        expect(r.state.players.map((p) => p.attrs)).toEqual(s.players.map((p) => p.attrs));
        continue;
      }
      expect(r.state.inbox.length).toBeGreaterThan(inbox0);
      expect(r.state.inbox[r.state.inbox.length - 1].text).toContain('屬性制');
      // 屬性由舊存檔的版本補回（＝該版本的流派屬性）
      expect(r.state.players.map((p) => p.attrs)).toEqual(s.players.map((p) => attrsAt(c, p.lineageId, stageOfPlayer(c, p))));
    }
  });

  it('目前版本：不遷移、原樣讀回', () => {
    const s = newGame(22, c);
    const r = parseSave(serialize(s), kinds);
    expect(r.migratedFrom).toBeNull();
    expect(JSON.parse(serialize(r.state))).toEqual(JSON.parse(serialize(s)));
  });

  it('第 4 版以前、比目前新、版本不是數字、不認得的內容包、不是 JSON：拒絕並說明', () => {
    const base = asRaw(newGame(23, c));
    expect(() => parseSave(JSON.stringify({ ...base, version: 4 }), kinds)).toThrow(/新增選手品階與 ID，舊存檔無法沿用（存檔第 4 版，目前第 10 版）/);
    expect(() => parseSave(JSON.stringify({ ...base, version: 3 }), kinds)).toThrow(/存檔第 3 版/);
    expect(() => parseSave(JSON.stringify({ ...base, version: 2 }), kinds)).toThrow(/存檔是第 2 版（比賽沒有保存請求單/);
    expect(() => parseSave(JSON.stringify({ ...base, version: 11 }), kinds)).toThrow(/存檔是第 11 版，比這個版本的遊戲（第 10 版）新/);
    expect(() => parseSave(JSON.stringify({ ...base, version: '7' }), kinds)).toThrow(/舊存檔不能繼續/);
    expect(() => parseSave(JSON.stringify({ ...toV7(newGame(24, c)), contentId: 'nope' }), kinds)).toThrow(/內容包 nope/);
    expect(() => parseSave('{', kinds)).toThrow(/不是 JSON/);
  });
});
