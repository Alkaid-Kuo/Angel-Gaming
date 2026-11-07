// M5 教練層第一批（經營層）：戰術手冊、排練、比賽計畫、新面孔折扣、比賽使用加成、已知層、第 5 版存檔遷移。
// 用假比賽閘道（瞬間出結果）＋攻防戰的戰術清單；回合戰術標籤由包裝閘道假造。
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/manage/commands.ts';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import { STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { advance, newGame, startPlaybook, startTactics } from '../src/manage/game.ts';
import type { BattleGateway, MatchOutcome, MatchRequest } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { REHEARSE_PERSONAL_GAIN, REHEARSE_TEAM_GAIN } from '../src/manage/jobs.ts';
import { npcPlaybook } from '../src/manage/npc.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { buildSide, effectiveLineup, effectiveTactics, grow, humanTeam, playerOf, rosterOf, stageOfPlayer } from '../src/manage/state.ts';
import type { GameState } from '../src/manage/types.ts';
import { SAVE_VERSION } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';

/** 暫代內容＋攻防戰的十個戰術（流派是暫代的，角色傾向不會命中） */
const content: ContentPack = { ...STUB_CONTENT, tactics: SHOOTER_TACTICS };
const fake = new FakeGateway(content);

/** 假比賽之外，替每回合加上雙方戰術標籤（主隊 a、客隊 b） */
class TagGateway implements BattleGateway {
  readonly formats = fake.formats;
  readonly requests: MatchRequest[] = [];
  private readonly a: string | null;
  private readonly b: string | null;
  constructor(a: string | null, b: string | null) {
    this.a = a;
    this.b = b;
  }
  async simulateBatch(requests: readonly MatchRequest[]): Promise<MatchOutcome[]> {
    this.requests.push(...requests);
    const outs = await fake.simulateBatch(requests);
    return outs.map((o) => ({ ...o, rounds: o.rounds.map((r) => ({ ...r, tactics: { a: this.a, b: this.b } })) }));
  }
}

const lineupOf = (s: GameState, teamId: string): GameState['players'] => effectiveLineup(s, content, s.teams.find((t) => t.id === teamId) as GameState['teams'][number]).map((id) => playerOf(s, id));

describe('戰術手冊：開局', () => {
  it('每個戰術都有隊伍默契與個人熟練度；預設計畫全 0；開局主序列不受影響', () => {
    const s = newGame(3, content);
    const me = humanTeam(s);
    expect(Object.keys(me.playbook).sort()).toEqual(SHOOTER_TACTICS.map((t) => t.id).sort());
    expect(Object.values(me.playbook).every((v) => v === content.economy.playbookStart.human)).toBe(true);
    expect(me.gamePlan).toEqual({ pref: Object.fromEntries(SHOOTER_TACTICS.map((t) => [t.id, 0])), economy: 0 });
    for (const p of s.players) {
      expect(Object.values(p.tactics).every((v) => Number.isInteger(v) && v >= 10 && v <= 50)).toBe(true);
      expect(p.newFace === false || p.teamId !== null).toBe(true);
    }
    // 名單、品階、流派、立繪與沒有戰術手冊的內容包同種子相同（熟練度用獨立串流）
    const plain = newGame(3, STUB_CONTENT);
    expect(s.players.map((p) => [p.name, p.rarity, p.lineageId, p.portraitId, p.habit])).toEqual(plain.players.map((p) => [p.name, p.rarity, p.lineageId, p.portraitId, p.habit]));
  });

  it('角色傾向 +10：攻防戰突破手的 rush 起點較高', () => {
    const t = startTactics({ ...content, tactics: SHOOTER_TACTICS }, 1, 7, 'entry');
    const u = startTactics({ ...content, tactics: SHOOTER_TACTICS }, 1, 7, 'support');
    expect(t.rushA - u.rushA).toBe(10);
    expect(u.default - t.default).toBe(10);
    expect(t.splitA).toBe(u.splitA);
  });
});

describe('戰術手冊：說明', () => {
  it('十個戰術都有說明與相剋提示；相剋提示只提到手冊裡的戰術名稱', () => {
    expect(SHOOTER_TACTICS).toHaveLength(10);
    for (const t of SHOOTER_TACTICS) {
      expect(t.desc.length, t.id).toBeGreaterThan(30);
      expect(t.tips.length, t.id).toBeGreaterThan(10);
      expect(t.desc + t.tips, t.id).not.toMatch(/TODO/);
    }
    // 提示裡出現的英文戰術名都要是手冊裡有的（防止改名後提示沒跟著改）
    const names = new Set(SHOOTER_TACTICS.map((t) => t.name));
    for (const t of SHOOTER_TACTICS) for (const m of t.tips.match(/(Rush|Split) [AB]|Default|Fake/g) ?? []) expect(names.has(m), `${t.id}：${m}`).toBe(true);
  });
});

describe('戰術手冊：排練', () => {
  it('扣費、佔時段、推進後遞減成長（隊伍 +6、出賽名單個人 +8，乘 1 − cur/100）', async () => {
    const s = newGame(5, content);
    const me = humanTeam(s);
    const lineup = lineupOf(s, me.id);
    const team0 = me.playbook.rushB;
    const pers0 = lineup.map((p) => p.tactics.rushB);
    const bench = rosterOf(s, me.id).filter((p) => !lineup.includes(p));
    const benchBefore = bench.map((p) => p.tactics.rushB);
    const cash = me.cash;
    expect(applyCommand(s, content, me.id, { type: 'queueRehearse', tactic: 'rushB', sessions: 3 })).toEqual({ ok: true });
    expect(me.cash).toBe(cash - 3 * content.economy.rehearseCost);
    expect(knownView(s, content, me.id).me.slotsLeft).toBe(content.economy.trainingSlots[0] - 3);
    expect(knownView(s, content, me.id).me.capacityLeft).toBe(content.economy.scrimCapacity[0]);
    await advance(s, content, fake);
    let t = team0;
    for (let i = 0; i < 3; i++) t = grow(t, REHEARSE_TEAM_GAIN);
    expect(me.playbook.rushB).toBe(t);
    lineup.forEach((p, i) => {
      let v = pers0[i];
      for (let k = 0; k < 3; k++) v = grow(v, REHEARSE_PERSONAL_GAIN);
      expect(p.tactics.rushB).toBe(v);
    });
    expect(bench.map((p) => p.tactics.rushB)).toEqual(benchBefore);
    expect(s.inbox.some((m) => m.text.startsWith('排練完成：Rush B 3 節'))).toBe(true);
  });

  it('越熟越難漲；不會超過 100', () => {
    let v = 0;
    let last = Infinity;
    for (let i = 0; i < 200; i++) {
      const next = grow(v, REHEARSE_TEAM_GAIN);
      expect(next - v).toBeLessThanOrEqual(last + 1e-9);
      last = next - v;
      v = next;
    }
    expect(v).toBeLessThanOrEqual(100);
    expect(v).toBeGreaterThan(95);
  });

  it('拒絕：未知戰術、節數不是正整數、超過時段、資金不足', () => {
    const s = newGame(6, content);
    const me = humanTeam(s);
    const cap = content.economy.scrimCapacity[0];
    expect(applyCommand(s, content, me.id, { type: 'queueRehearse', tactic: 'nope', sessions: 1 }).ok).toBe(false);
    expect(applyCommand(s, content, me.id, { type: 'queueRehearse', tactic: 'rushA', sessions: 0 }).ok).toBe(false);
    expect(applyCommand(s, content, me.id, { type: 'queueRehearse', tactic: 'rushA', sessions: 1.5 }).ok).toBe(false);
    expect(applyCommand(s, content, me.id, { type: 'queueRehearse', tactic: 'rushA', sessions: cap + 1 }).ok).toBe(false);
    me.cash = content.economy.rehearseCost - 1;
    expect(applyCommand(s, content, me.id, { type: 'queueRehearse', tactic: 'rushA', sessions: 1 })).toEqual({ ok: false, reason: '資金不足' });
  });
});

describe('比賽計畫', () => {
  const pref = (over: Record<string, number> = {}): Record<string, number> => ({ ...Object.fromEntries(SHOOTER_TACTICS.map((t) => [t.id, 0])), ...over });

  it('設定後送進請求單的 team（pref_、economy、q_＝執行熟練度）', async () => {
    const s = newGame(7, content);
    const me = humanTeam(s);
    expect(applyCommand(s, content, me.id, { type: 'setGamePlan', plan: { pref: { rushA: 3, fake: -1 }, economy: 2 } })).toEqual({ ok: true });
    expect(me.gamePlan).toEqual({ pref: pref({ rushA: 3, fake: -1 }), economy: 2 });
    const side = buildSide(content, me, lineupOf(s, me.id));
    const eff = effectiveTactics(content, me, lineupOf(s, me.id));
    expect(side.team?.pref_rushA).toBe(3);
    expect(side.team?.pref_fake).toBe(-1);
    expect(side.team?.economy).toBe(2);
    expect(side.team?.q_rushA).toBe(eff.rushA);
    expect(side.players[0].config.p_rushA).toBe(Math.round(lineupOf(s, me.id)[0].tactics.rushA));
    expect(side.players[0].config.presetBonus).toBeUndefined();
  });

  it('拒絕：未知戰術、偏好超出 -1～3、經濟風格不對、某一方全部禁用', () => {
    const s = newGame(8, content);
    const me = humanTeam(s);
    const ok = (plan: unknown): boolean => applyCommand(s, content, me.id, { type: 'setGamePlan', plan } as never).ok;
    expect(ok({ pref: { nope: 1 }, economy: 0 })).toBe(false);
    expect(ok({ pref: { rushA: 4 }, economy: 0 })).toBe(false);
    expect(ok({ pref: { rushA: 1.5 }, economy: 0 })).toBe(false);
    expect(ok({ pref: {}, economy: 3 })).toBe(false);
    expect(ok({ pref: { ct212: -1, stackA: -1, stackB: -1, ctPush: -1 }, economy: 0 })).toBe(false);
    expect(ok({ pref: { ct212: -1, stackA: -1, stackB: -1 }, economy: 0 })).toBe(true);
  });

  it('沒有戰術手冊的內容包：請求單沒有 team、個人資料只有習慣與表定屬性', () => {
    const s = newGame(9, STUB_CONTENT);
    const me = humanTeam(s);
    const side = buildSide(STUB_CONTENT, me, rosterOf(s, me.id).slice(0, 3));
    expect(side.team).toBeUndefined();
    expect(Object.keys(side.players[0].config)).toEqual(['habit', ...STUB_CONTENT.attributes.keys]);
  });
});

describe('新面孔與比賽使用', () => {
  it('新面孔第一次出賽前隊伍默契 ×0.95（每人一次）；簽了不上場不扣；之後不再扣', async () => {
    const s = newGame(10, content);
    const me = humanTeam(s);
    me.cash = 99_999;
    await advance(s, content, fake); // 休賽期 → 第 1 週
    expect(applyCommand(s, content, me.id, { type: 'setLineup', lineup: lineupOf(s, me.id).map((p) => p.id) }).ok).toBe(true);
    for (const p of rosterOf(s, me.id)) p.newFace = false;
    const free = s.players.find((p) => p.teamId === null) as GameState['players'][number];
    expect(applyCommand(s, content, me.id, { type: 'sign', playerId: free.id }).ok).toBe(true);
    expect(free.newFace).toBe(true);
    const lineup = lineupOf(s, me.id).map((p) => p.id);
    expect(lineup).not.toContain(free.id);
    const before = me.playbook.rushA;
    await advance(s, content, fake); // 新人沒上場
    expect(me.playbook.rushA).toBe(before);
    expect(free.newFace).toBe(true);
    expect(applyCommand(s, content, me.id, { type: 'setLineup', lineup: [free.id, ...lineup.slice(1)] }).ok).toBe(true);
    await advance(s, content, fake); // 新人上場：打折一次
    expect(me.playbook.rushA).toBe(Math.round(before * 0.95 * 10) / 10);
    expect(free.newFace).toBe(false);
    const after = me.playbook.rushA;
    await advance(s, content, fake);
    expect(me.playbook.rushA).toBe(after);
  });

  it('比賽使用：我方每回合打的戰術，隊伍默契與出賽名單個人熟練度各 +0.5 × (1 − cur/100)；不認得的代號略過', async () => {
    const s = newGame(12, content);
    await advance(s, content, fake); // 休賽期（NPC 開局簽的新面孔在第 1 週才打折，先清掉）
    for (const p of s.players) p.newFace = false;
    const me = humanTeam(s);
    const f = s.fixtures.find((x) => x.week === s.week && (x.home === me.id || x.away === me.id)) as GameState['fixtures'][number];
    const gw = new TagGateway(f.home === me.id ? 'splitA' : 'nope', f.home === me.id ? 'nope' : 'splitA');
    const lineup = lineupOf(s, me.id);
    const team0 = me.playbook.splitA;
    const p0 = lineup[0].tactics.splitA;
    await advance(s, content, gw);
    expect(me.playbook.splitA).toBe(grow(team0, 0.5));
    expect(lineup[0].tactics.splitA).toBe(grow(p0, 0.5));
  });
});

describe('已知層', () => {
  it('自己看得到默契、執行熟練度、計畫、自己人的個人熟練度與我方回合戰術；別隊的看不到', async () => {
    const s = newGame(13, content);
    await advance(s, content, fake);
    const me = humanTeam(s);
    const f = s.fixtures.find((x) => x.week === s.week && (x.home === me.id || x.away === me.id)) as GameState['fixtures'][number];
    const gw = new TagGateway(f.home === me.id ? 'rushA' : 'stackB', f.home === me.id ? 'stackB' : 'rushA');
    await advance(s, content, gw);
    const v = knownView(s, content, me.id);
    expect(Object.keys(v.me.playbook)).toHaveLength(SHOOTER_TACTICS.length);
    expect(Object.keys(v.me.effective)).toHaveLength(SHOOTER_TACTICS.length);
    expect(v.me.gamePlan.economy).toBe(0);
    for (const p of v.players) expect(p.tactics !== undefined).toBe(p.teamId === me.id);
    const kf = v.fixtures.find((x) => x.id === f.id);
    expect(kf?.match?.rounds.every((r) => r.tactic === 'rushA')).toBe(true);
    // 別場比賽沒有戰術標籤
    const other = v.fixtures.find((x) => x.week === f.week && x.id !== f.id);
    expect(other?.match?.rounds.every((r) => r.tactic === undefined)).toBe(true);

    // 對手視角：看不到玩家的默契與計畫、玩家選手的個人熟練度、玩家那一半的回合戰術
    const foeId = f.home === me.id ? f.away : f.home;
    const fv = knownView(s, content, foeId);
    expect(fv.me.playbook).toEqual(Object.fromEntries(Object.entries(s.teams.find((t) => t.id === foeId)?.playbook ?? {}).map(([k, x]) => [k, Math.round(x)])));
    for (const p of fv.players) if (p.teamId === me.id) expect(p.tactics).toBeUndefined();
    expect(fv.fixtures.find((x) => x.id === f.id)?.match?.rounds.every((r) => r.tactic === 'stackB')).toBe(true);
  });
});

describe('NPC 戰術手冊', () => {
  it('依個性設計畫、拿一半時段排練兩邊最熟的戰術；同一個視圖同一組指令', () => {
    const s = newGame(14, content);
    const npc = s.teams.find((t) => t.persona === 'whale') as GameState['teams'][number];
    const v = knownView(s, content, npc.id);
    const cmds = npcPlaybook(v, 'whale', content);
    expect(cmds).toEqual(npcPlaybook(v, 'whale', content));
    expect(cmds[0].type).toBe('setGamePlan');
    const plan = (cmds[0] as Extract<(typeof cmds)[number], { type: 'setGamePlan' }>).plan;
    expect(Object.values(plan.pref).filter((x) => x === 2)).toHaveLength(2);
    expect(plan.economy).toBe(2);
    const reh = cmds.filter((c) => c.type === 'queueRehearse');
    expect(reh.map((c) => (c as { tactic: string }).tactic).map((id) => SHOOTER_TACTICS.find((t) => t.id === id)?.side).sort()).toEqual(['CT', 'T']);
    expect(npcPlaybook(knownView(s, STUB_CONTENT, npc.id), 'whale', STUB_CONTENT)).toEqual([]);
  });

  it('整季跑完：NPC 有排練、默契上升、帳本一致', async () => {
    const s = newGame(15, content);
    while (s.phase === 'offseason' || s.phase === 'season') await advance(s, content, fake);
    const npcs = s.teams.filter((t) => t.persona === 'whale' || t.persona === 'data');
    expect(npcs.some((t) => Object.values(t.playbook).some((x) => x > content.economy.playbookStart[t.persona ?? 'human']))).toBe(true);
    expect(s.teams.some((t) => t.ledger.some((e) => e.memo.startsWith('排練')))).toBe(true);
  });
});

describe('存檔', () => {
  it('第 11 版存讀一致', async () => {
    const s = newGame(16, content);
    applyCommand(s, content, humanTeam(s).id, { type: 'setGamePlan', plan: { pref: { rushA: 2 }, economy: 1 } });
    await advance(s, content, fake);
    const back = deserialize(serialize(s), content);
    expect(back).toEqual(s);
    expect(back.version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(11);
  });

  it('第 5 版 → 第 11 版：刪預設與研發、補熟練度與計畫、收件匣說明，再補統計、版本換成屬性；第 4 版照舊拒絕', () => {
    const s = newGame(17, content);
    const v5 = JSON.parse(serialize(s)) as Record<string, unknown> & GameState;
    v5.version = 5;
    for (const p of v5.players as unknown as Record<string, unknown>[]) {
      delete p.tactics;
      delete p.newFace;
      delete p.season;
      // 第 5 版是版本制：版本＝開局的成長階段（開局屬性就是該版本的屬性）
      p.version = stageOfPlayer(content, s.players.find((x) => x.id === p.id) as GameState['players'][number]);
      p.upgradeUntilWeek = null;
      delete p.attrs;
      delete p.caps;
      delete p.progress;
      p.presets = [{ id: 'r1', target: 'generic', version: 1, bonus: 10, reportedBonus: 12 }];
    }
    for (const t of v5.teams as unknown as Record<string, unknown>[]) {
      delete t.playbook;
      delete t.gamePlan;
      delete t.tacticLog;
    }
    (v5.jobs as unknown[]).push({ kind: 'research', id: 999, teamId: s.humanTeamId, playerId: s.players[0].id, target: 'generic', games: 5 });
    const m = deserialize(JSON.stringify(v5), content);
    expect(m.version).toBe(11);
    for (const p of m.players) expect(p.season.games).toBe(0);
    for (const t of m.teams) expect(t.tacticLog).toEqual({});
    expect(m.jobs.some((j) => (j.kind as string) === 'research')).toBe(false);
    for (const p of m.players) {
      expect('presets' in p).toBe(false);
      expect(p.tactics).toEqual(startTactics(content, s.seed, Number(p.id.slice(1)), p.lineageId));
      expect(p.newFace).toBe(false);
    }
    for (const t of m.teams) expect(t.playbook).toEqual(startPlaybook(content, t.persona ?? 'human'));
    const notes = m.inbox.slice(-2).map((x) => x.text);
    expect(notes[0]).toContain('戰術手冊');
    expect(notes[0]).toContain('研發已取消');
    expect(notes[1]).toContain('屬性制');
    // 版本 → 屬性：和同種子新開局相同（同一套生成規則）；真實上限、進度也一樣
    expect(m.players.map((p) => [p.attrs, p.caps, p.progress])).toEqual(s.players.map((p) => [p.attrs, p.caps, p.progress]));
    // 遷移後的熟練度等於同種子新開局的值（同一套規則）
    expect(m.players.map((p) => p.tactics)).toEqual(s.players.map((p) => p.tactics));
    expect(() => deserialize(JSON.stringify({ ...v5, version: 4 }), content)).toThrow(/存檔版本 4/);
  });
});
