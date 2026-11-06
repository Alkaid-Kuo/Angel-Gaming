// M5 第二批：選手屬性制與訓練（規格第四節）。
// 開局屬性＝舊 derivePlayer(版本)；上限等級只看公開公式；訓練收益遞減與歸零；每人每週上限；時段共用；成長階段門檻；
// 已知層（上限數字、習慣、別隊進度與數字不外洩，球探後才有數字）；等級邊界；真實強度內插；閘道帶屬性；第 7 版遷移的升版中選手；NPC 會練。
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/manage/commands.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import type { BattleGateway } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { attrsAt, capPub, gradeOf, habitCapOffsets, powerOfAttrs, stageOf, stageThreshold, startCaps, strengthSum, trainGain, trainOnce, TRAIN_FULL_GAIN } from '../src/manage/attrs.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { buildSide, humanTeam, rosterOf, slotsLeft, truePower } from '../src/manage/state.ts';
import type { GameState, Player } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';
import { ATTRIBUTE_KEYS } from '../src/shooter/config.ts';
import { seatOf } from '../src/shooter/gateway.ts';
import { derivePlayer, SHOOTER_ROLES } from '../src/shooter/players.ts';
import { SHOOTER_POWER } from '../src/manage/content-shooter.ts';

const shooter = SHOOTER_CONTENT;
const fake = new FakeGateway(shooter);
const gw: BattleGateway = { formats: [{ ...fake.formats[0], id: shooter.formatId }], simulateBatch: (r, p) => fake.simulateBatch(r, p) };
const mine = (s: GameState): Player[] => rosterOf(s, s.humanTeamId);

describe('開局屬性與上限', () => {
  it('屬性＝舊 derivePlayer(版本) 的 habit 0 屬性（五個角色、v1～v5）', () => {
    for (const role of SHOOTER_ROLES) {
      for (let v = 1; v <= 5; v++) expect(attrsAt(shooter, role, v)).toEqual({ ...derivePlayer({ role, version: v, habit: 0 }).attributes });
    }
  });

  it('同種子開局：每人屬性＝成長階段那一版的屬性；上限 ≥ 屬性、與公開上限差 ≤ 2', () => {
    for (const pack of [shooter, STUB_CONTENT] as ContentPack[]) {
      const s = newGame(11, pack);
      for (const p of s.players) {
        const stage = stageOf(pack, p.lineageId, p.attrs);
        expect(p.attrs).toEqual(attrsAt(pack, p.lineageId, stage));
        const pub = capPub(pack, p.lineageId, p.rarity);
        for (const k of pack.attributes.trainable) {
          expect(p.caps[k]).toBeGreaterThanOrEqual(p.attrs[k]);
          expect(p.caps[k] - pub[k]).toBeLessThanOrEqual(2);
          if (p.caps[k] > p.attrs[k]) expect(p.caps[k] - pub[k]).toBeGreaterThanOrEqual(-2);
        }
        expect(Object.values(p.progress).every((x) => x === 0)).toBe(true);
      }
    }
  });

  it('上限等級只看公開公式：改習慣不改視圖裡的 capGrades；習慣偏移 −2～+2、habit 0 全 0', () => {
    const s = newGame(12, shooter);
    const p = mine(s)[0];
    const before = knownView(s, shooter, s.humanTeamId).players.find((x) => x.id === p.id)?.capGrades;
    p.habit = -p.habit + 37;
    p.caps = startCaps(shooter, p.lineageId, p.rarity, p.habit, p.attrs);
    expect(knownView(s, shooter, s.humanTeamId).players.find((x) => x.id === p.id)?.capGrades).toEqual(before);
    expect(habitCapOffsets(0, ['aim', 'reaction'])).toEqual({ aim: 0, reaction: 0 });
    for (let h = -60; h <= 60; h += 7) for (const v of Object.values(habitCapOffsets(h, shooter.attributes.trainable))) expect(Math.abs(v)).toBeLessThanOrEqual(2);
  });

  it('等級邊界：44 D／45 C-、89 A+／90 S', () => {
    expect([0, 44, 45, 49, 50, 64, 65, 89, 90, 100].map(gradeOf)).toEqual(['D', 'D', 'C-', 'C-', 'C', 'B-', 'B', 'A+', 'S', 'S']);
  });
});

describe('訓練', () => {
  it('收益：離上限 6 點以上 60、最後 6 點線性遞減、最低 10、碰上限 0', () => {
    expect(trainGain(80, 60)).toBe(60);
    expect(trainGain(80, 74)).toBe(60);
    expect(trainGain(80, 77)).toBe(30);
    expect(trainGain(80, 79)).toBe(10);
    expect(trainGain(80, 80)).toBe(0);
    expect(trainGain(80, 85)).toBe(0);
  });

  it('逐節累積進度、滿 100 進 1 點；練到上限就停、不會超過', () => {
    const attrs = { aim: 70 };
    const progress = { aim: 0 };
    const caps = { aim: 72 };
    const gains: number[] = [];
    for (let i = 0; i < 20; i++) gains.push(trainOnce(attrs, progress, caps, 'aim'));
    expect(attrs.aim).toBe(72);
    expect(progress.aim).toBe(0);
    expect(gains.slice(-3)).toEqual([0, 0, 0]);
    expect(gains[0]).toBe(Math.round((TRAIN_FULL_GAIN * 2) / 6));
  });

  it('每人每週最多 3 節；訓練與排練共用時段；扣費；推進後屬性漲、報告寫收益', async () => {
    const s = newGame(13, shooter);
    const me = humanTeam(s);
    me.cash = 100_000;
    const [a, b] = mine(s);
    const k = shooter.attributes.trainable[0];
    a.caps[k] = Math.max(a.caps[k], a.attrs[k] + 10);
    const slots0 = slotsLeft(s, shooter, me);
    expect(applyCommand(s, shooter, me.id, { type: 'queueTrain', playerId: a.id, attr: k, sessions: 3 }).ok).toBe(true);
    expect(applyCommand(s, shooter, me.id, { type: 'queueTrain', playerId: a.id, attr: shooter.attributes.trainable[1], sessions: 1 })).toEqual({ ok: false, reason: '每名選手每週最多練 3 節' });
    expect(applyCommand(s, shooter, me.id, { type: 'queueTrain', playerId: a.id, attr: 'aggression', sessions: 1 })).toEqual({ ok: false, reason: '只能訓練強度屬性' });
    expect(slotsLeft(s, shooter, me)).toBe(slots0 - 3);
    expect(applyCommand(s, shooter, me.id, { type: 'queueRehearse', tactic: shooter.tactics[0].id, sessions: slots0 - 3 }).ok).toBe(true);
    expect(slotsLeft(s, shooter, me)).toBe(0);
    expect(applyCommand(s, shooter, me.id, { type: 'queueTrain', playerId: b.id, attr: k, sessions: 1 })).toEqual({ ok: false, reason: '超過本週訓練中心的時段' });
    expect(me.ledger.filter((x) => x.category === 'training').reduce((t, x) => t + x.amount, 0)).toBe(-(3 * shooter.economy.trainCost + (slots0 - 3) * shooter.economy.rehearseCost));
    const before = a.attrs[k];
    await advance(s, shooter, gw);
    expect(a.attrs[k]).toBe(before + 1);
    expect(a.progress[k]).toBe(80);
    expect(s.inbox.some((m) => m.text.includes(`${a.name} ${shooter.attributes.names[k]} ${before} → ${before + 1}`) && m.text.includes('收益 100%／100%／100%'))).toBe(true);
  });

  it('解約取消該選手排好的訓練；別人的選手不能練', () => {
    const s = newGame(14, shooter);
    const me = humanTeam(s);
    me.cash = 100_000;
    const p = mine(s)[0];
    const foe = s.players.find((x) => x.teamId !== null && x.teamId !== me.id) as Player;
    expect(applyCommand(s, shooter, me.id, { type: 'queueTrain', playerId: foe.id, attr: 'aim', sessions: 1 })).toEqual({ ok: false, reason: '不是自己的選手' });
    expect(applyCommand(s, shooter, me.id, { type: 'queueTrain', playerId: p.id, attr: 'aim', sessions: 2 }).ok).toBe(true);
    // 陣容要多於名單人數才能解約
    const fa = s.players.find((x) => x.teamId === null) as Player;
    expect(applyCommand(s, shooter, me.id, { type: 'sign', playerId: fa.id }).ok).toBe(true);
    expect(applyCommand(s, shooter, me.id, { type: 'release', playerId: p.id }).ok).toBe(true);
    expect(s.jobs.some((j) => j.kind === 'train')).toBe(false);
  });
});

describe('成長階段與真實強度', () => {
  it('門檻 T(v)：剛好到門檻就升階、差 1 點就不到；低於 T(1) 算 1', () => {
    for (const role of SHOOTER_ROLES) {
      for (let v = 2; v <= 5; v++) {
        const at = attrsAt(shooter, role, v);
        expect(strengthSum(shooter, at)).toBe(stageThreshold(shooter, role, v));
        expect(stageOf(shooter, role, at)).toBe(v);
        expect(stageOf(shooter, role, { ...at, aim: at.aim - 1 })).toBe(v - 1);
      }
      expect(stageOf(shooter, role, { aim: 0, reaction: 0, awareness: 0 })).toBe(1);
    }
  });

  it('真實強度內插：整數版本時＝舊表；兩版中間＝平均；習慣照加', () => {
    for (const role of SHOOTER_ROLES) {
      for (let v = 1; v <= 5; v++) expect(powerOfAttrs(shooter, role, attrsAt(shooter, role, v))).toBe(SHOOTER_POWER[role][v - 1]);
      const lo = attrsAt(shooter, role, 3);
      const hi = attrsAt(shooter, role, 4);
      // aim、reaction、awareness 各走一半（growth 是偶數的那幾項剛好整數）
      const half = Object.fromEntries(Object.keys(lo).map((k) => [k, (lo[k] + hi[k]) / 2]));
      expect(powerOfAttrs(shooter, role, half)).toBeCloseTo((SHOOTER_POWER[role][2] + SHOOTER_POWER[role][3]) / 2, 6);
    }
    const s = newGame(15, shooter);
    const p = s.players[0];
    expect(truePower(shooter, p)).toBe(powerOfAttrs(shooter, p.lineageId, p.attrs) + p.habit);
  });
});

describe('已知層', () => {
  it('沒有真實上限數字與習慣；別隊沒有進度、上限等級，沒球探過就沒有屬性數字；球探後有報告當下的數字與週數', async () => {
    const s = newGame(16, shooter);
    const me = humanTeam(s);
    const foe = s.players.find((x) => x.teamId !== null && x.teamId !== me.id) as Player;
    const v0 = knownView(s, shooter, me.id);
    const json = JSON.stringify(v0);
    expect(json).not.toContain('"caps"');
    expect(json).not.toContain('"habit"');
    for (const kp of v0.players) {
      if (kp.teamId === me.id) {
        expect(kp.attrs).toBeDefined();
        expect(kp.progress).toBeDefined();
        expect(kp.capGrades).toBeDefined();
      } else {
        expect(kp.attrs).toBeUndefined();
        expect(kp.progress).toBeUndefined();
        expect(kp.capGrades).toBeUndefined();
        expect(Object.keys(kp.grades)).toEqual(shooter.attributes.keys);
      }
    }
    expect(applyCommand(s, shooter, me.id, { type: 'scout', playerId: foe.id }).ok).toBe(true);
    await advance(s, shooter, gw);
    const kp = knownView(s, shooter, me.id).players.find((x) => x.id === foe.id);
    expect(kp?.attrs).toEqual(foe.attrs);
    expect(kp?.attrsWeek).toBe(0);
    expect(kp?.capGrades).toBeUndefined();
    // 對方之後練了，報告的數字不跟著變
    const snap = { ...foe.attrs };
    foe.attrs.aim += 3;
    expect(knownView(s, shooter, me.id).players.find((x) => x.id === foe.id)?.attrs).toEqual(snap);
    // 別隊視角看不到我方的數字
    const other = knownView(s, shooter, foe.teamId as string);
    expect(other.players.find((x) => x.id === mine(s)[0].id)?.attrs).toBeUndefined();
  });
});

describe('閘道與存檔', () => {
  it('請求單帶表定屬性；攻防戰座位用 config 的屬性，舊請求單（沒有屬性）照版本衍生', () => {
    const s = newGame(17, shooter);
    const me = humanTeam(s);
    const ps = mine(s);
    ps[0].attrs.aim = 77;
    const side = buildSide(shooter, me, ps);
    expect(side.players[0].config.aim).toBe(77);
    expect(side.players[0].version).toBe(stageOf(shooter, ps[0].lineageId, ps[0].attrs));
    const seat = seatOf({ ...side.players[0], config: { ...side.players[0].config, habit: 0 } });
    expect(seat.attributes.aim).toBe(77);
    for (const k of ATTRIBUTE_KEYS) expect(seat.attributes[k]).toBe(ps[0].attrs[k]);
    const old = seatOf({ lineageId: 'entry', version: 4, config: { habit: 0 } });
    expect(old.attributes).toEqual(derivePlayer({ role: 'entry', version: 4, habit: 0 }).attributes);
  });

  it('第 7 版 → 第 8 版：升版中的人直接完成那一版、週薪照舊制調升；其他人屬性＝當時版本', () => {
    const s = newGame(18, shooter);
    const v7 = JSON.parse(serialize(s)) as GameState & Record<string, unknown>;
    v7.version = 7;
    const players = v7.players as unknown as Record<string, unknown>[];
    for (const p of players) {
      p.version = stageOf(shooter, p.lineageId as string, p.attrs as Record<string, number>);
      p.upgradeUntilWeek = null;
      delete p.attrs;
      delete p.caps;
      delete p.progress;
    }
    const up = players.find((p) => p.teamId === s.humanTeamId && (p.rarity === 'SR' || p.rarity === 'R') && (p.version as number) < 3) as Record<string, unknown>;
    up.upgradeUntilWeek = 2;
    const salary = up.weeklySalary as number;
    const v = up.version as number;
    const m = deserialize(JSON.stringify(v7), shooter);
    expect(m.version).toBe(10);
    const p = m.players.find((x) => x.id === up.id) as Player;
    expect(p.attrs).toEqual(attrsAt(shooter, p.lineageId, v + 1));
    expect(p.weeklySalary).toBe(Math.round((salary * shooter.economy.salaryGrowthPct) / 100));
    expect('version' in p || 'upgradeUntilWeek' in p).toBe(false);
    for (const q of m.players) if (q.id !== p.id) expect(q.attrs).toEqual(s.players.find((x) => x.id === q.id)?.attrs);
    expect(m.inbox[m.inbox.length - 1].text).toContain('已直接完成那一版');
  });
});

describe('NPC 訓練', () => {
  it('推進幾週後 NPC 有排訓練（帳本有訓練支出）、屬性有漲，而且沒有超過上限', async () => {
    const s = newGame(19, shooter);
    const before = new Map(s.players.map((p) => [p.id, strengthSum(shooter, p.attrs)]));
    for (let i = 0; i < 4; i++) await advance(s, shooter, gw);
    const npcs = s.teams.filter((t) => !t.human);
    expect(npcs.some((t) => t.ledger.some((x) => x.category === 'training' && x.memo.startsWith('訓練')))).toBe(true);
    const grown = s.players.filter((p) => p.teamId !== null && p.teamId !== s.humanTeamId && strengthSum(shooter, p.attrs) > (before.get(p.id) ?? 0));
    expect(grown.length).toBeGreaterThan(0);
    for (const p of s.players) for (const k of shooter.attributes.trainable) expect(p.attrs[k]).toBeLessThanOrEqual(p.caps[k]);
  });
});
