// 引擎 API 1.2（M5 教練層第一批）：開局資料 tactics、觀察資料 coach、回合戰術標籤（K: 喊話）。
// 驅動層只把資料放進己方的開局與觀察資料，不改模擬：沒讀新欄位的 Bot 打出的比賽與沒給資料時完全相同。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { InitTactics, ShooterDeclaration, ShooterInitData, ShooterObservation, TeamOrders } from '../src/shooter/api.ts';
import { SHOOTER_API_VERSION, SHOOTER_ENGINE_VERSION } from '../src/shooter/config.ts';
import { ShooterBatchController, ShooterDriver, runShooterMatch, type CallOutcome, type ShooterController } from '../src/shooter/runner.ts';
import { MAPS } from '../src/shooter/map.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const short = { seed: 7, mapId: 'redrock', roundsPerHalf: 1, winRounds: 2, overtime: false } as const;

/** 記下開局資料與每次觀察到的 coach；可在指定回合的第一次決策喊話 */
class Probe implements ShooterController {
  readonly label: string;
  readonly declaration: ShooterDeclaration;
  init0: ShooterInitData | null = null;
  coaches: (TeamOrders | null)[] = [];
  private said = new Set<number>();
  private readonly say: ((round: number) => string | null) | null;
  constructor(label: string, say: ((round: number) => string | null) | null = null) {
    this.label = label;
    this.say = say;
    this.declaration = { name: label, version: '', style: 'probe', knobs: [] };
  }
  init(data: ShooterInitData): CallOutcome<null> {
    this.init0 = data;
    return { value: null, exception: null, timedOut: false, elapsedMs: 0 };
  }
  decide(obs: ShooterObservation): CallOutcome<unknown> {
    this.coaches.push(obs.coach);
    const n = obs.round.number;
    const text = this.say !== null && !this.said.has(n) ? this.say(n) : null;
    if (text !== null) this.said.add(n);
    return { value: text === null ? [] : [{ type: 'say', text }], exception: null, timedOut: false, elapsedMs: 0 };
  }
}

const orders = (tactic: string | null): TeamOrders => ({ pref: { rushA: 3, fake: -1 }, economy: 1, call: tactic === null ? null : { tactic, buy: null } });

describe('引擎 API 1.2：版本', () => {
  it('API 1.2、引擎 1.3.0，開局資料帶版本', () => {
    expect(SHOOTER_API_VERSION).toBe('1.2');
    expect(SHOOTER_ENGINE_VERSION).toBe('1.3.0');
    const p = new Probe('p');
    new ShooterDriver({ ...short, controllers: Array.from({ length: PLAYER_COUNT }, (_, i) => (i === 0 ? p : new Probe(`q${i}`))), record: false });
    expect(p.init0?.rules.apiVersion).toBe('1.2');
  });
});

describe('引擎 API 1.2：開局資料 tactics', () => {
  it('依座位傳進開局資料；沒給是 null', () => {
    const probes = Array.from({ length: PLAYER_COUNT }, (_, i) => new Probe(`p${i}`));
    const tA: InitTactics = { team: { rushA: 80 }, personal: { rushA: 60 } };
    new ShooterDriver({ ...short, controllers: probes, record: false, tactics: [tA, undefined, null] });
    expect(probes[0].init0?.tactics).toEqual(tA);
    expect(probes[1].init0?.tactics).toBeNull();
    expect(probes[2].init0?.tactics).toBeNull();
    expect(probes[9].init0?.tactics).toBeNull();
  });
});

describe('引擎 API 1.2：觀察資料 coach', () => {
  it('依組別放己方指令：組 0 看到組 0 的、組 1 看到組 1 的；沒給是 null', () => {
    const probes = Array.from({ length: PLAYER_COUNT }, (_, i) => new Probe(`p${i}`));
    const a = orders('rushA');
    const d = new ShooterDriver({ ...short, controllers: probes, record: false, orders: [a, null] });
    for (let i = 0; i < 40; i++) d.step();
    for (let pid = 0; pid < PLAYER_COUNT; pid++) {
      expect(probes[pid].coaches.length).toBeGreaterThan(0);
      for (const c of probes[pid].coaches) expect(c).toEqual(pid < 5 ? a : null);
    }
  });

  it('沒有 orders 時每次都是 null', () => {
    const probes = Array.from({ length: PLAYER_COUNT }, (_, i) => new Probe(`p${i}`));
    const d = new ShooterDriver({ ...short, controllers: probes, record: false });
    for (let i = 0; i < 20; i++) d.step();
    expect(probes.every((p) => p.coaches.every((c) => c === null))).toBe(true);
  });
});

describe('引擎 API 1.2：教練指令與熟練度不能被 Bot 改', () => {
  it('深凍結：Bot 改 obs.coach.pref 或 init.tactics 會被拒，隊友與之後的觀察不變；呼叫端的原物件不被凍結', () => {
    const a = orders('rushA');
    const t: InitTactics = { team: { rushA: 80 }, personal: { rushA: 60 } };
    let tried = 0;
    let rejected = 0;
    const vandal = new Probe('vandal');
    const decide = vandal.decide.bind(vandal);
    vandal.decide = (obs: ShooterObservation): CallOutcome<unknown> => {
      const out = decide(obs);
      if (obs.coach !== null) {
        tried++;
        try {
          (obs.coach.pref as Record<string, number>).rushA = -1;
          (obs.coach as { economy: number }).economy = 0;
        } catch {
          rejected++;
        }
      }
      return out;
    };
    const probes = Array.from({ length: PLAYER_COUNT }, (_, i) => (i === 0 ? vandal : new Probe(`p${i}`)));
    const d = new ShooterDriver({ ...short, controllers: probes, record: false, orders: [a, null], tactics: Array.from({ length: PLAYER_COUNT }, () => t) });
    for (let i = 0; i < 40; i++) d.step();
    expect(tried).toBeGreaterThan(0);
    expect(rejected).toBe(tried);
    for (const c of [...probes[0].coaches, ...probes[1].coaches]) expect(c).toEqual(a);
    expect(Object.isFrozen(probes[1].coaches[0]?.pref)).toBe(true);
    const init = probes[2].init0?.tactics as InitTactics;
    expect(Object.isFrozen(init.team) && Object.isFrozen(init.personal)).toBe(true);
    expect(() => {
      (init.team as Record<string, number>).rushA = 0;
    }).toThrow();
    expect(probes[3].init0?.tactics?.team.rushA).toBe(80);
    expect(Object.isFrozen(a) || Object.isFrozen(t.team)).toBe(false);
  });
});

describe('引擎 API 1.2：回合戰術標籤', () => {
  it('每組每回合記第一則 K: 喊話；格式不對、沒喊記 null', () => {
    const probes = Array.from({ length: PLAYER_COUNT }, (_, i) => {
      if (i === 0) return new Probe('t0', (n) => (n === 1 ? 'K:rushB' : 'hello'));
      if (i === 1) return new Probe('t1', (n) => (n === 1 ? 'K:splitA' : null));
      if (i === 5) return new Probe('c0', (n) => (n === 2 ? 'K:stackA' : 'K:bad tag'));
      return new Probe(`p${i}`);
    });
    const run = runShooterMatch({ ...short, controllers: probes, record: false });
    expect(run.tacticTags[0]).toEqual(['rushB', null]);
    expect(run.tacticTags[1]).toEqual([null, 'stackA']);
  });
});

describe('引擎 API 1.2：不讀新欄位的 Bot 結果不變', () => {
  // 基準 Bot 從 2.8 起會讀這兩個欄位，所以把它包成「看不到新欄位」的版本：開局 tactics 與每回合 coach 一律當 null 交給它。
  // 驗的是引擎注入教練指令與熟練度不會影響其他東西（不讀的 Bot 結果完全相同）
  class Blind implements ShooterController {
    readonly label: string;
    readonly declaration: ShooterDeclaration;
    private readonly inner: ShooterBatchController;
    constructor(inner: ShooterBatchController) {
      this.inner = inner;
      this.label = inner.label;
      this.declaration = inner.declaration;
    }
    init(data: ShooterInitData): CallOutcome<null> {
      return this.inner.init({ ...data, tactics: null });
    }
    decide(obs: ShooterObservation): CallOutcome<unknown> {
      return this.inner.decide({ ...obs, coach: null });
    }
  }
  it('基準 Bot（看不到新欄位）：給了 tactics 與 orders 的比賽和沒給時終局雜湊相同', () => {
    const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
    const map = MAPS.redrock();
    const ctl = (): ShooterController[] => Array.from({ length: PLAYER_COUNT }, (_, pid) => new Blind(new ShooterBatchController(bot, pid < 5 ? 'A' : 'B', short.seed, pid, map, { timeLimits: false })));
    const plain = runShooterMatch({ ...short, controllers: ctl(), record: false });
    const t: InitTactics = { team: { rushA: 90 }, personal: { rushA: 10 } };
    const rich = runShooterMatch({ ...short, controllers: ctl(), record: false, tactics: Array.from({ length: PLAYER_COUNT }, () => t), orders: [orders('rushA'), orders(null)] });
    expect(rich.finalHash).toBe(plain.finalHash);
    expect(rich.result.score).toEqual(plain.result.score);
  });
});
