// 選手品階與 ID 名字庫：品階只決定個人版本上限；名字開局洗牌、依序發放、不重複。
import { describe, expect, it } from 'vitest';
import { runSeason } from '../src/manage/autoplayer.ts';
import { applyCommand } from '../src/manage/commands.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { HANDLES, RARITIES, STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { npcOffseason } from '../src/manage/npc.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { humanTeam, playerMaxVersion, raritySpec, rosterOf, truePower } from '../src/manage/state.ts';
import type { GameState, Player, Rarity } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';

const content = STUB_CONTENT;
const gateway = new FakeGateway(content);
const PACKS: readonly ContentPack[] = [STUB_CONTENT, SHOOTER_CONTENT];

/** 玩家第一位選手，改成指定的品階、流派、版本，資金給足 */
function setup(rarity: Rarity, lineageId: string, version: number, pack: ContentPack = content): { s: GameState; p: Player } {
  const s = newGame(5, pack);
  humanTeam(s).cash = 100_000;
  const p = rosterOf(s, s.humanTeamId)[0];
  p.rarity = rarity;
  p.lineageId = lineageId;
  p.version = version;
  return { s, p };
}

describe('品階表', () => {
  it('暫代包與射擊包同一張表，順序與數值照定案', () => {
    expect(STUB_CONTENT.rarities).toBe(RARITIES);
    expect(SHOOTER_CONTENT.rarities).toBe(RARITIES);
    expect(RARITIES.map((r) => [r.id, r.weight, r.maxVersion, r.npcEloBonus])).toEqual([
      ['N', 45, 2, 0],
      ['R', 30, 3, 10],
      ['SR', 20, 4, 25],
      ['SSR', 5, 5, 45],
    ]);
  });
});

describe('個人版本上限', () => {
  it('品階與流派取小', () => {
    expect(playerMaxVersion(content, setup('N', 'turtle', 1).p)).toBe(2);
    expect(playerMaxVersion(content, setup('SSR', 'turtle', 1).p)).toBe(5); // 龜守流上限 6
    expect(playerMaxVersion(content, setup('SSR', 'push', 1).p)).toBe(4); // 強攻流上限 4
  });

  it('N 到 SSR 都升不過自己的上限：到上限時失敗、不扣錢、訊息提到品階；差一版時還能升', () => {
    for (const r of RARITIES) {
      const { s, p } = setup(r.id, 'turtle', r.maxVersion);
      const me = humanTeam(s);
      const cash = me.cash;
      expect(applyCommand(s, content, me.id, { type: 'upgradeVersion', playerId: p.id })).toEqual({ ok: false, reason: `${r.id} 階選手最高只能到 v${r.maxVersion}` });
      expect(me.cash).toBe(cash);
      expect(p.upgradeUntilWeek).toBeNull();
      p.version = r.maxVersion - 1;
      expect(applyCommand(s, content, me.id, { type: 'upgradeVersion', playerId: p.id }).ok).toBe(true);
    }
  });

  it('流派上限較低時訊息提到流派（SSR 配強攻流 v4）；兩者相等時說品階（SR 配強攻流 v4）', () => {
    const a = setup('SSR', 'push', 4);
    const cash = humanTeam(a.s).cash;
    expect(applyCommand(a.s, content, a.s.humanTeamId, { type: 'upgradeVersion', playerId: a.p.id })).toEqual({ ok: false, reason: '強攻流已是最高版本' });
    expect(humanTeam(a.s).cash).toBe(cash);
    const b = setup('SR', 'push', 4);
    expect(applyCommand(b.s, content, b.s.humanTeamId, { type: 'upgradeVersion', playerId: b.p.id })).toEqual({ ok: false, reason: 'SR 階選手最高只能到 v4' });
  });

  it('品階不影響薪資與當下強度', () => {
    const a = setup('N', 'balance', 2);
    const b = setup('SSR', 'balance', 2);
    expect(b.p.weeklySalary).toBe(a.p.weeklySalary);
    expect(truePower(content, b.p)).toBe(truePower(content, a.p));
  });

  it('completeUpgrades 不會升過個人上限：升版中途被卡住時版本與週薪不變、升版狀態清掉', async () => {
    const { s, p } = setup('N', 'turtle', 2);
    const salary = p.weeklySalary;
    p.upgradeUntilWeek = 1;
    await advance(s, content, gateway); // 休賽期 → 第 1 週
    await advance(s, content, gateway); // 第 1 週結算
    expect(p.version).toBe(2);
    expect(p.weeklySalary).toBe(salary);
    expect(p.upgradeUntilWeek).toBeNull();
  });

  it('completeUpgrades 在上限內照常升：N 從 v1 升到 v2 後就不能再升', async () => {
    const { s, p } = setup('N', 'turtle', 1);
    expect(applyCommand(s, content, s.humanTeamId, { type: 'upgradeVersion', playerId: p.id }).ok).toBe(true);
    for (let i = 0; i < 3; i++) await advance(s, content, gateway);
    expect(p.version).toBe(2);
    expect(applyCommand(s, content, s.humanTeamId, { type: 'upgradeVersion', playerId: p.id })).toEqual({ ok: false, reason: 'N 階選手最高只能到 v2' });
  });
});

describe('開局抽品階', () => {
  it('100 個種子：版本不超過品階上限，NPC 與自由選手的版本範圍不變，流派撐得住版本', () => {
    for (const pack of PACKS) {
      for (let seed = 1; seed <= 100; seed++) {
        const s = newGame(seed, pack);
        for (const p of s.players) {
          expect(p.version, `${pack.id}/${seed}/${p.id}`).toBeLessThanOrEqual(raritySpec(pack, p.rarity).maxVersion);
          expect((pack.lineages.find((l) => l.id === p.lineageId) as ContentPack['lineages'][number]).power.length).toBeGreaterThanOrEqual(p.version);
          const team = s.teams.find((t) => t.id === p.teamId);
          const [lo, hi] = team === undefined ? [1, 3] : team.persona === null ? pack.economy.humanVersions : pack.personas[team.persona].versions;
          expect(p.version).toBeGreaterThanOrEqual(lo);
          expect(p.version).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('100 個種子：玩家起手品階照陣列順序，版本照 humanVersions', () => {
    expect(SHOOTER_CONTENT.economy.humanStartRarities).toEqual(['SR', 'R', 'R', 'N', 'N']);
    expect(STUB_CONTENT.economy.humanStartRarities).toEqual(['SR', 'R', 'N']);
    for (const pack of PACKS) {
      for (let seed = 1; seed <= 100; seed++) {
        const s = newGame(seed, pack);
        expect(rosterOf(s, s.humanTeamId).map((p) => p.rarity)).toEqual(pack.economy.humanStartRarities);
      }
    }
  });

  it('全體比例接近權重：低版本才抽得到 N，SSR 維持稀有', () => {
    const tally: Record<string, number> = { N: 0, R: 0, SR: 0, SSR: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const s = newGame(seed, SHOOTER_CONTENT);
      for (const p of s.players) if (p.teamId === null || p.teamId !== s.humanTeamId) tally[p.rarity]++;
    }
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    expect(tally.SSR / total).toBeGreaterThan(0.04);
    expect(tally.SSR / total).toBeLessThan(0.11);
    expect(tally.N).toBeGreaterThan(tally.SR);
  });

  it('同一種子開局完全相同；序列化讀回與打完整季後品階都不變', async () => {
    expect(serialize(newGame(77, content))).toBe(serialize(newGame(77, content)));
    const s = newGame(77, content);
    const back = deserialize(serialize(s), content);
    expect(back.players.map((p) => p.rarity)).toEqual(s.players.map((p) => p.rarity));
    const before = s.players.map((p) => p.rarity);
    await runSeason(s, content, gateway, null);
    expect(s.players.map((p) => p.rarity)).toEqual(before);
    expect(s.players.every((p) => p.version <= playerMaxVersion(content, p))).toBe(true);
  });
});

describe('內容包驗證', () => {
  const withEconomy = (over: Partial<ContentPack['economy']>): ContentPack => ({ ...content, economy: { ...content.economy, ...over } });

  it('玩家起手品階數與名單人數不符時拒絕開局', () => {
    expect(() => newGame(1, withEconomy({ humanStartRarities: ['SR', 'R'] }))).toThrow(/起手品階數/);
  });

  it('玩家起手版本範圍超過品階上限時拒絕開局（不靠種子運氣）', () => {
    expect(() => newGame(1, withEconomy({ humanVersions: [1, 3] }))).toThrow(/N 階上限/);
  });

  it('未知品階拒絕開局', () => {
    expect(() => newGame(1, withEconomy({ humanStartRarities: ['SR', 'R', 'UR' as Rarity] }))).toThrow(/未知品階 UR/);
  });

  it('handles 重複時拒絕開局；大小寫不同不算重複', () => {
    expect(() => newGame(1, { ...content, handles: [...content.handles, content.handles[0]] })).toThrow(new RegExp(`重複：${content.handles[0]}`));
    expect(() => newGame(1, { ...content, handles: [...content.handles, content.handles[0].toUpperCase()] })).not.toThrow();
  });

  it('handles 不足時拒絕開局，數量剛好時可以', () => {
    for (const pack of PACKS) {
      const need = 8 * pack.lineupSize + pack.economy.freeAgentCount;
      expect(() => newGame(1, { ...pack, handles: pack.handles.slice(0, need - 1) })).toThrow(new RegExp(`只有 ${need - 1} 個，開局需要 ${need} 個`));
      const s = newGame(1, { ...pack, handles: pack.handles.slice(0, need) });
      expect(new Set(s.players.map((p) => p.name)).size).toBe(need);
    }
  });
});

describe('ID 名字庫', () => {
  it('名單 120 個、不重複、只用英文字母與數字、不超過 11 字元；兩包同一份', () => {
    expect(HANDLES).toHaveLength(120);
    expect(new Set(HANDLES).size).toBe(120);
    for (const h of HANDLES) expect(h).toMatch(/^[A-Za-z0-9]{1,11}$/);
    expect(STUB_CONTENT.handles).toBe(HANDLES);
    expect(SHOOTER_CONTENT.handles).toBe(HANDLES);
  });

  it('100 個種子：名字不重複且都來自 handles；不同種子的發放順序不同', () => {
    for (const pack of PACKS) {
      const known = new Set(pack.handles);
      const firsts = new Set<string>();
      for (let seed = 1; seed <= 100; seed++) {
        const s = newGame(seed, pack);
        expect(new Set(s.players.map((p) => p.name)).size).toBe(s.players.length);
        expect(s.players.every((p) => known.has(p.name))).toBe(true);
        firsts.add(s.players[0].name);
      }
      expect(firsts.size).toBeGreaterThan(30);
    }
  });
});

describe('NPC 簽約估值與公開視圖', () => {
  it('Elo 與薪資都相同時，高品階先被簽走；估值只改簽約，不改品階', () => {
    const s = newGame(9, SHOOTER_CONTENT);
    const npc = s.teams.find((t) => t.persona === 'whale') as GameState['teams'][number];
    const free = s.players.filter((p) => p.teamId === null);
    free.forEach((p) => {
      p.elo = 1500;
      p.weeklySalary = 50;
      p.rarity = 'N';
    });
    free[5].rarity = 'SSR';
    const cmds = npcOffseason(knownView(s, SHOOTER_CONTENT, npc.id), 'whale', SHOOTER_CONTENT.personas.whale, SHOOTER_CONTENT);
    expect(cmds.find((c) => c.type === 'sign')).toEqual({ type: 'sign', playerId: free[5].id });
  });

  it('視圖公開品階與個人上限，隱藏層仍不外洩', () => {
    const s = newGame(9, content);
    const v = knownView(s, content, s.humanTeamId);
    for (const kp of v.players) {
      const p = s.players.find((x) => x.id === kp.id) as Player;
      expect(kp.rarity).toBe(p.rarity);
      expect(kp.maxVersion).toBe(playerMaxVersion(content, p));
    }
    expect(JSON.stringify(v)).not.toContain('"habit"');
  });
});
