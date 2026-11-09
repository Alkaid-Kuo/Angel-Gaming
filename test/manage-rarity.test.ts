// 選手品階與 ID 名字庫：品階只決定屬性上限（M5 第二批起；原個人版本上限）；名字開局洗牌、依序發放、不重複。
import { describe, expect, it } from 'vitest';
import { runSeason } from '../src/manage/autoplayer.ts';
import { applyCommand } from '../src/manage/commands.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { HANDLES, RARITIES, STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { npcOffseason } from '../src/manage/npc.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { attrsAt, capPub, capVersionOf, gradeOf, startCaps } from '../src/manage/attrs.ts';
import { humanTeam, raritySpec, rosterOf, stageOfPlayer, truePower } from '../src/manage/state.ts';
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
  p.attrs = attrsAt(pack, lineageId, version);
  p.caps = startCaps(pack, lineageId, rarity, p.habit, p.attrs);
  return { s, p };
}

describe('品階表', () => {
  it('暫代包與射擊包同一張表，順序與數值照定案', () => {
    expect(STUB_CONTENT.rarities).toBe(RARITIES);
    expect(SHOOTER_CONTENT.rarities).toBe(RARITIES);
    expect(RARITIES.map((r) => [r.id, r.weight, r.capVersion, r.npcEloBonus])).toEqual([
      ['N', 45, 2, 0],
      ['R', 30, 3, 10],
      ['SR', 20, 4, 25],
      ['SSR', 5, 5, 45],
    ]);
  });
});

describe('屬性上限（品階）', () => {
  it('上限對應的舊版本：品階與流派取小', () => {
    expect(capVersionOf(content, 'turtle', 'N')).toBe(2);
    expect(capVersionOf(content, 'turtle', 'SSR')).toBe(5); // 龜守流最高 6
    expect(capVersionOf(content, 'push', 'SSR')).toBe(4); // 強攻流最高 4
  });

  it('公開上限＝該版本的可訓練屬性；真實上限不低於目前屬性；品階越高上限越高', () => {
    for (const pack of PACKS) {
      const l = pack.lineages[0].id;
      let prev = -1;
      for (const r of RARITIES) {
        const pub = capPub(pack, l, r.id);
        const at = attrsAt(pack, l, capVersionOf(pack, l, r.id));
        for (const k of pack.attributes.trainable) expect(pub[k]).toBe(at[k]);
        const sum = pack.attributes.trainable.reduce((t, k) => t + pub[k], 0);
        expect(sum).toBeGreaterThan(prev);
        prev = sum;
        const { p } = setup(r.id, l, r.capVersion, pack);
        for (const k of pack.attributes.trainable) expect(p.caps[k]).toBeGreaterThanOrEqual(p.attrs[k]);
      }
    }
  });

  it('品階不影響薪資與當下強度', () => {
    const a = setup('N', 'balance', 2);
    const b = setup('SSR', 'balance', 2);
    expect(b.p.weeklySalary).toBe(a.p.weeklySalary);
    expect(truePower(content, b.p)).toBe(truePower(content, a.p));
  });
});

describe('開局抽品階', () => {
  it('100 個種子：版本不超過品階上限，NPC 與自由選手的版本範圍不變，流派撐得住版本', () => {
    for (const pack of PACKS) {
      for (let seed = 1; seed <= 100; seed++) {
        const s = newGame(seed, pack);
        s.players.forEach((p, i) => {
          // 開局屬性＝生成版本的流派屬性，所以成長階段＝生成版本
          const version = stageOfPlayer(pack, p);
          expect(version, `${pack.id}/${seed}/${p.id}`).toBeLessThanOrEqual(raritySpec(pack, p.rarity).capVersion);
          expect((pack.lineages.find((l) => l.id === p.lineageId) as ContentPack['lineages'][number]).power.length).toBeGreaterThanOrEqual(version);
          for (const k of pack.attributes.trainable) expect(p.caps[k]).toBeGreaterThanOrEqual(p.attrs[k]);
          // 名單前段是各隊原班人馬，後段是自由選手（可能已被 NPC 簽走）
          const team = i < 8 * pack.lineupSize ? s.teams.find((t) => t.id === p.teamId) : undefined;
          const [lo, hi] = team === undefined ? [1, 3] : team.persona === null ? pack.economy.humanVersions : pack.personas[team.persona].versions;
          expect(version).toBeGreaterThanOrEqual(lo);
          expect(version).toBeLessThanOrEqual(hi);
        });
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
    // 季中補人（規格 4.14）只往後加新選手：開局那些人的品階不變
    expect(s.players.slice(0, before.length).map((p) => p.rarity)).toEqual(before);
    expect(s.players.every((p) => content.attributes.trainable.every((k) => p.attrs[k] <= p.caps[k]))).toBe(true);
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
    npc.cash = SHOOTER_CONTENT.personas.whale.startCash;
    // 把開局那一輪還原：所有自由選手回到市場，再比一次
    const free = s.players.slice(8 * SHOOTER_CONTENT.lineupSize);
    free.forEach((p) => {
      p.teamId = null;
      p.elo = 1500;
      p.weeklySalary = 50;
      p.rarity = 'N';
    });
    free[5].rarity = 'SSR';
    const cmds = npcOffseason(knownView(s, SHOOTER_CONTENT, npc.id), 'whale', SHOOTER_CONTENT.personas.whale, SHOOTER_CONTENT);
    expect(cmds.find((c) => c.type === 'sign')).toEqual({ type: 'sign', playerId: free[5].id });
  });

  it('視圖公開品階；上限等級只給自己的人（公開公式），隱藏層仍不外洩', () => {
    const s = newGame(9, content);
    const v = knownView(s, content, s.humanTeamId);
    for (const kp of v.players) {
      const p = s.players.find((x) => x.id === kp.id) as Player;
      expect(kp.rarity).toBe(p.rarity);
      if (p.teamId === s.humanTeamId) expect(kp.capGrades).toEqual(Object.fromEntries(Object.entries(capPub(content, p.lineageId, p.rarity)).map(([k, x]) => [k, gradeOf(x)])));
      else expect(kp.capGrades).toBeUndefined();
    }
    expect(JSON.stringify(v)).not.toContain('"habit"');
  });
});

describe('NPC 開局先簽一輪', () => {
  it('開局就簽完：還在休賽期第 0 週，帳本與現金對得上，陣容不超過目標', () => {
    for (const pack of PACKS) {
      let signed = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const s = newGame(seed, pack);
        expect(s.phase).toBe('offseason');
        expect(s.week).toBe(0);
        for (const t of s.teams) {
          if (t.persona === null) {
            expect(t.ledger).toEqual([]);
            continue;
          }
          const spec = pack.personas[t.persona];
          const roster = rosterOf(s, t.id).length;
          expect(t.ledger.every((e) => e.week === 0)).toBe(true);
          expect(t.ledger.filter((e) => e.category === 'signing')).toHaveLength(roster - pack.lineupSize);
          expect(t.cash).toBe(spec.startCash + t.ledger.reduce((x, e) => x + e.amount, 0));
          expect(roster).toBeLessThanOrEqual(Math.max(pack.lineupSize, spec.rosterTarget));
          signed += roster - pack.lineupSize;
        }
      }
      expect(signed).toBeGreaterThan(0);
    }
  });

  it('玩家搶不到這一輪：簽光市場再推進，NPC 陣容與現金都不變，第一次推進不再簽約', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = newGame(seed, content);
      const npcs = (): unknown => s.teams.filter((t) => !t.human).map((t) => [t.id, t.cash, t.trainingLevel, rosterOf(s, t.id).map((p) => p.id)]);
      const before = npcs();
      const me = humanTeam(s);
      me.cash = 100_000;
      for (const p of s.players.filter((x) => x.teamId === null)) applyCommand(s, content, me.id, { type: 'sign', playerId: p.id });
      await advance(s, content, gateway);
      expect(s.week).toBe(1);
      expect(npcs()).toEqual(before);
    }
  });

  it('玩家看到的市場已被挑過：100 個種子，自由選手裡的 SSR 大多已被 NPC 簽走', () => {
    let total = 0;
    let taken = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const s = newGame(seed, SHOOTER_CONTENT);
      const ssr = s.players.slice(8 * SHOOTER_CONTENT.lineupSize).filter((p) => p.rarity === 'SSR');
      total += ssr.length;
      taken += ssr.filter((p) => p.teamId !== null).length;
    }
    expect(total).toBeGreaterThan(50);
    expect(taken / total).toBeGreaterThan(0.8);
  });
});
