// CS 射擊選手衍生（步驟 7）：derivePlayer 確定性與範圍、版本成長、習慣偏移、反應延遲公式、驅動層接屬性、射擊內容包。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import type { Attributes, ShooterInitData, ShooterObservation } from '../src/shooter/api.ts';
import { ATTRIBUTE_KEYS, MIN_REACTION_TICKS } from '../src/shooter/config.ts';
import { ShooterHumanController } from '../src/shooter/human.ts';
import { MAPS } from '../src/shooter/map.ts';
import { BALANCED_ROLES, MAX_VERSION, ROLE_TABLE, SHOOTER_ROLES, balancedLineup, derivePlayer, habitOffsets, reactionEighths, reactionTicksFor } from '../src/shooter/players.ts';
import { ScriptController, ShooterBatchController, ShooterDriver, runShooterMatch, type CallOutcome } from '../src/shooter/runner.ts';
import { DEFAULT_ATTRIBUTES, PLAYER_COUNT } from '../src/shooter/sim.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { STUB_CONTENT } from '../src/manage/content.ts';
import { expectedPermille } from '../src/manage/rating.ts';

const sum = (a: Attributes): number => ATTRIBUTE_KEYS.reduce((s, k) => s + a[k], 0);

describe('選手衍生 derivePlayer', () => {
  it('同一個規格永遠得到同一組屬性與旋鈕；屬性都是 0～100 整數', () => {
    for (const role of SHOOTER_ROLES) {
      for (let v = 1; v <= MAX_VERSION; v++) {
        for (const habit of [0, 1, 7, -3, 123456]) {
          const a = derivePlayer({ role, version: v, habit });
          const b = derivePlayer({ role, version: v, habit });
          expect(a).toEqual(b);
          for (const k of ATTRIBUTE_KEYS) {
            expect(Number.isInteger(a.attributes[k])).toBe(true);
            expect(a.attributes[k]).toBeGreaterThanOrEqual(0);
            expect(a.attributes[k]).toBeLessThanOrEqual(100);
          }
          expect(a.knobs.role).toBeGreaterThanOrEqual(1);
          expect(a.reactionTicks).toBe(reactionTicksFor(a.attributes));
        }
      }
    }
  });

  it('habit 0 無偏移（版本 3 ＝ 角色基準）；不同 habit 至少一項不同；偏移在 ±4 內', () => {
    for (const role of SHOOTER_ROLES) expect(derivePlayer({ role, version: 3, habit: 0 }).attributes).toEqual(ROLE_TABLE[role].base);
    expect(Object.values(habitOffsets(0)).every((x) => x === 0)).toBe(true);
    for (let h = 1; h <= 50; h++) {
      const off = habitOffsets(h);
      for (const k of ATTRIBUTE_KEYS) expect(Math.abs(off[k])).toBeLessThanOrEqual(4);
      const a = derivePlayer({ role: 'entry', version: 3, habit: h }).attributes;
      const b = derivePlayer({ role: 'entry', version: 3, habit: h + 1 }).attributes;
      expect(ATTRIBUTE_KEYS.some((k) => a[k] !== b[k])).toBe(true);
    }
  });

  it('版本 1～MAX 六項總和嚴格遞增；主屬性在版本 MAX 不超過 100；風格屬性成長小於強度屬性', () => {
    for (const role of SHOOTER_ROLES) {
      for (const habit of [0, 5, 99]) {
        for (let v = 2; v <= MAX_VERSION; v++) expect(sum(derivePlayer({ role, version: v, habit }).attributes)).toBeGreaterThan(sum(derivePlayer({ role, version: v - 1, habit }).attributes));
      }
      const g = ROLE_TABLE[role].growth;
      const top = derivePlayer({ role, version: MAX_VERSION, habit: 0 }).attributes;
      for (const k of ATTRIBUTE_KEYS) expect(top[k]).toBeLessThanOrEqual(100);
      expect(g.aim + g.reaction + g.awareness).toBeGreaterThan(g.aggression + g.discipline + g.movement);
    }
  });

  it('不合法的規格丟錯（角色、版本範圍、habit 整數）', () => {
    expect(() => derivePlayer({ role: 'tank' as never, version: 3, habit: 0 })).toThrow();
    expect(() => derivePlayer({ role: 'entry', version: 0, habit: 0 })).toThrow();
    expect(() => derivePlayer({ role: 'entry', version: MAX_VERSION + 1, habit: 0 })).toThrow();
    expect(() => derivePlayer({ role: 'entry', version: 2.5, habit: 0 })).toThrow();
    expect(() => derivePlayer({ role: 'entry', version: 3, habit: 0.5 })).toThrow();
  });

  it('均衡陣容五個角色各一', () => {
    expect([...BALANCED_ROLES].sort()).toEqual([...SHOOTER_ROLES].sort());
    expect(balancedLineup(4).every((s) => s.version === 4 && s.habit === 0)).toBe(true);
  });
});

describe('反應延遲 reactionTicksFor', () => {
  const at = (reaction: number): Attributes => ({ ...DEFAULT_ATTRIBUTES, reaction });
  it('reaction 0 → 14、50 → 8、70 以上 → 5；永遠 ≥ 5', () => {
    expect(reactionTicksFor(at(0))).toBe(14);
    expect(reactionTicksFor(at(70))).toBe(5);
    expect(reactionTicksFor(at(50))).toBe(8);
    expect(reactionTicksFor(at(100))).toBe(5);
    for (let r = -20; r <= 120; r++) expect(reactionTicksFor(at(r))).toBeGreaterThanOrEqual(MIN_REACTION_TICKS);
  });

  it('精確延遲 reactionEighths：期望 ＝ 5 + (70 − reaction) / 8，70 以上是 5', () => {
    expect(reactionEighths(at(50))).toBe(60);
    expect(reactionEighths(at(69))).toBe(41);
    expect(reactionEighths(at(70))).toBe(40);
    expect(reactionEighths(at(100))).toBe(40);
    expect(reactionEighths(at(0))).toBe(110);
  });

  it('機率式進位：每批指令 7 或 8 tick、平均 7.5；同種子相同、換種子不同；明確給延遲與沒屬性的不進位', () => {
    const run = (seed: number, opts: { attrs?: boolean; ticks?: number } = {}): number[] => {
      const seen: number[] = [];
      const ctl = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ScriptController(`s${pid}`, (o: ShooterObservation) => {
        if (pid === 2) seen.push(o.tick);
        return pid === 2 ? [{ type: 'stop' }] : [];
      }));
      const d = new ShooterDriver({ seed, mapId: 'dust', controllers: ctl, record: true, ...(opts.attrs === false ? {} : { attributes: Array.from({ length: PLAYER_COUNT }, () => DEFAULT_ATTRIBUTES) }), ...(opts.ticks !== undefined ? { reactionTicks: Array.from({ length: PLAYER_COUNT }, () => opts.ticks) } : {}) });
      for (let i = 0; i < 300; i++) d.step();
      const done = d.replay!.decisions.filter((x) => x.playerId === 2).map((x) => x.tick);
      return done.map((t, i) => t - seen[i]);
    };
    const a = run(7);
    expect(a.length).toBeGreaterThan(80);
    expect(new Set(a)).toEqual(new Set([7, 8]));
    expect(Math.abs(a.reduce((x, y) => x + y, 0) / a.length - 7.5)).toBeLessThan(0.15);
    expect(run(7)).toEqual(a);
    expect(run(8)).not.toEqual(a);
    expect(new Set(run(7, { ticks: 8 }))).toEqual(new Set([8]));
    expect(new Set(run(7, { attrs: false }))).toEqual(new Set([MIN_REACTION_TICKS]));
  });

  it('均衡陣容五人平均 v1 約 9 → v5 約 5，每版快約 1 tick；角色 ±1；突破手最快、狙擊手與錨點最慢', () => {
    const want = [9, 8, 7, 6, 5];
    for (let v = 1; v <= MAX_VERSION; v++) {
      const row = balancedLineup(v).map((s) => ({ role: s.role, ticks: derivePlayer(s).reactionTicks }));
      const ticks = row.map((x) => x.ticks);
      const avg = ticks.reduce((a, b) => a + b, 0) / ticks.length;
      expect(Math.abs(avg - want[v - 1])).toBeLessThanOrEqual(0.5);
      expect(Math.max(...ticks) - Math.min(...ticks)).toBeLessThanOrEqual(2);
      expect(Math.min(...ticks)).toBeGreaterThanOrEqual(MIN_REACTION_TICKS);
      const of = (role: string): number => row.find((x) => x.role === role)!.ticks;
      expect(of('entry')).toBe(Math.min(...ticks));
      expect(of('awp')).toBe(Math.max(...ticks));
      expect(of('anchor')).toBe(Math.max(...ticks));
    }
  });
});

/** 記錄 init 資料的控制器（不經沙盒） */
class Probe {
  readonly label = 'probe';
  readonly declaration = { name: 'probe', version: '', style: 'probe', knobs: [] };
  data: ShooterInitData | null = null;
  init(data: ShooterInitData): CallOutcome<null> {
    this.data = data;
    return { value: null, exception: null, timedOut: false, elapsedMs: 0 };
  }
  decide(): CallOutcome<unknown> {
    return { value: [], exception: null, timedOut: false, elapsedMs: 0 };
  }
}

describe('驅動層接屬性', () => {
  it('給 attributes：InitData.attributes 就是它、rules.reactionTicks ＝ reactionTicksFor；回放 players 帶屬性', () => {
    const specs = [...balancedLineup(1), ...balancedLineup(5, 7)];
    const derived = specs.map((s) => derivePlayer(s));
    const probes = Array.from({ length: PLAYER_COUNT }, () => new Probe());
    const d = new ShooterDriver({ seed: 1, mapId: 'dust', controllers: probes, record: true, attributes: derived.map((x) => x.attributes) });
    probes.forEach((p, i) => {
      expect(p.data!.attributes).toEqual(derived[i].attributes);
      expect(p.data!.rules.reactionTicks).toBe(derived[i].reactionTicks);
    });
    expect(d.replay!.header.players.map((p) => p.attributes)).toEqual(derived.map((x) => x.attributes));
    expect(d.replay!.header.reactionTicks).toEqual(derived.map((x) => x.reactionTicks));
  });

  it('沒給：屬性全 50、反應延遲為下限 5；明確給 reactionTicks 時照給的（仍夾 ≥ 5）；人類控制器 0', () => {
    const probes = Array.from({ length: PLAYER_COUNT }, () => new Probe());
    new ShooterDriver({ seed: 1, mapId: 'dust', controllers: probes, record: false });
    for (const p of probes) {
      expect(p.data!.attributes).toEqual(DEFAULT_ATTRIBUTES);
      expect(p.data!.rules.reactionTicks).toBe(MIN_REACTION_TICKS);
    }
    const low = { ...DEFAULT_ATTRIBUTES, reaction: 0 };
    const probes2 = Array.from({ length: PLAYER_COUNT }, () => new Probe());
    const ctl = [new ShooterHumanController(), ...probes2.slice(1)];
    const d = new ShooterDriver({ seed: 1, mapId: 'dust', controllers: ctl, record: false, attributes: Array.from({ length: PLAYER_COUNT }, () => low), reactionTicks: [undefined as never, 2, 9] });
    expect(d.reactionTicks[0]).toBe(0);
    expect(d.reactionTicks[1]).toBe(MIN_REACTION_TICKS);
    expect(d.reactionTicks[2]).toBe(9);
    expect(d.reactionTicks[3]).toBe(14);
    expect(probes2[3].data!.attributes).toEqual(low);
  });

  it('同種子同名單 → 同雜湊；屬性不同 → 雜湊不同（基準 Bot、短賽制）', () => {
    const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'shooter-baseline.js');
    const play = (version: number): string => {
      const specs = [...balancedLineup(version), ...balancedLineup(3)];
      const derived = specs.map((s) => derivePlayer(s));
      const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(bot, 'baseline', 3, pid, MAPS.dust()));
      const knobs = controllers.map((c, pid) => resolveKnobs(c.declaration, derived[pid].knobs, c.label));
      return runShooterMatch({ seed: 3, mapId: 'dust', roundsPerHalf: 1, winRounds: 2, overtime: false, controllers, knobs, record: false, attributes: derived.map((x) => x.attributes) }).finalHash;
    };
    const a = play(5);
    expect(play(5)).toBe(a);
    expect(play(1)).not.toBe(a);
  }, 60_000);
});

describe('射擊內容包 SHOOTER_CONTENT', () => {
  it('五個 lineage（id ＝ 角色）、power 長度＝MAX_VERSION、隨版本嚴格遞增、可以餵 expectedPermille', () => {
    expect(SHOOTER_CONTENT.id).toBe('shooter-1');
    expect(SHOOTER_CONTENT.formatId).toBe('shooter-mr6');
    expect(SHOOTER_CONTENT.lineages.map((l) => l.id).sort()).toEqual([...SHOOTER_ROLES].sort());
    for (const l of SHOOTER_CONTENT.lineages) {
      expect(l.power.length).toBe(MAX_VERSION);
      expect(l.name).toBe(ROLE_TABLE[l.id as keyof typeof ROLE_TABLE].name);
      for (let i = 1; i < l.power.length; i++) expect(l.power[i]).toBeGreaterThan(l.power[i - 1]);
      for (const p of l.power) expect(Number.isInteger(p) && p > 1000 && p < 2400).toBe(true);
    }
    const top = SHOOTER_CONTENT.lineages[0].power[MAX_VERSION - 1];
    const low = SHOOTER_CONTENT.lineages[0].power[0];
    const e = expectedPermille(top - low);
    expect(e).toBeGreaterThan(500);
    expect(e).toBeLessThanOrEqual(995);
    expect(SHOOTER_CONTENT.teamNames.length).toBe(7);
    // 步驟 8：5 人名單、經濟從暫代包放大（陣容上限容得下名單＋替補、NPC 陣容目標 6～7）
    expect(SHOOTER_CONTENT.lineupSize).toBe(5);
    expect(SHOOTER_CONTENT.slotNames).toHaveLength(5);
    expect(SHOOTER_CONTENT.economy.rosterMax).toBeGreaterThan(SHOOTER_CONTENT.lineupSize);
    for (const p of Object.values(SHOOTER_CONTENT.personas)) {
      expect(p.rosterTarget).toBeGreaterThanOrEqual(6);
      expect(p.rosterTarget).toBeLessThanOrEqual(SHOOTER_CONTENT.economy.rosterMax);
    }
    expect(SHOOTER_CONTENT.economy.humanStartCash).toBeGreaterThan(STUB_CONTENT.economy.humanStartCash);
  });
});
