import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P } from '../bots/shooter-src/base.js';
import { Resources, allocate, buyOrders, buyText, decodeItem, encodeItem, needsOf, parseBuyOrders, itemsText } from '../bots/shooter-src/resources.js';
import type { KindCode, UtilItem } from '../bots/shooter-src/resources.js';
import type { TPlan } from '../bots/shooter-src/tactics.js';
import { compileBot } from '../src/sandbox/compile.ts';
import type { CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterBatchController, ShooterDriver } from '../src/shooter/runner.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';
import type { ShooterCommand, ShooterObservation } from '../src/shooter/api.ts';

// Bot 3.0 資源層（設計 docs/2026-11-07_CS射擊_Bot3.0資源層設計.md 第十一節 A、B）。

const ent = (_s: 'A' | 'B', r: number): number => r % 2;

describe('Bot 3.0 資源層：協定', () => {
  it('token 編碼後再解碼不變（所有用途、目標形式）', () => {
    const items: UtilItem[] = [
      { idx: 0, owner: 3, kind: 'f', purpose: 'entryFlash', target: { site: 'A', ent: 0 }, state: 'plan', backup: false },
      { idx: 1, owner: 7, kind: 's', purpose: 'holdSmoke', target: { site: 'B', ent: -1 }, state: 'plan', backup: false },
      { idx: 2, owner: 9, kind: 'm', purpose: 'chokeMolotov', target: { site: 'A', ent: 1 }, state: 'plan', backup: false },
      { idx: 3, owner: 0, kind: 's', purpose: 'retakeSmoke', target: { site: null, ent: -2 }, state: 'plan', backup: false },
      { idx: 4, owner: 1, kind: 'h', purpose: 'fakeUtil', target: { site: 'B', ent: 2 }, state: 'plan', backup: false },
    ];
    const all = ['entryFlash', 'entrySmoke', 'holdSmoke', 'fireBackup', 'fakeUtil', 'chokeMolotov', 'retakeSmoke', 'retakeFlash'] as const;
    all.forEach((purpose, i) => items.push({ idx: 5 + i, owner: i, kind: 'f', purpose, target: { site: 'A', ent: i % 3 }, state: 'plan', backup: false }));
    for (const it of items) {
      const tok = encodeItem(it);
      expect(tok).toHaveLength(5);
      expect(decodeItem(tok, it.idx)).toEqual(it);
    }
    const text = itemsText(items);
    expect(text.length).toBeLessThanOrEqual(120);
    const orders = new Map<number, KindCode[]>([[3, ['f', 'f']], [7, ['s', 'm']]]);
    expect(parseBuyOrders(buyText(orders))).toEqual(orders);
  });

  it('全隊副本一致：五份 Resources 吃同一串喊話後狀態相同', () => {
    const ids = [0, 1, 2, 3, 4];
    const plan: TPlan = { kind: 'rush', site: 'A', r1: 0, r2: 0, exec: 'A' };
    const holds = new Map<number, KindCode[]>([[0, ['f']], [1, ['f', 's']], [2, ['f', 'f']], [3, ['s', 'h']], [4, []]]);
    const items = allocate(needsOf(plan, { ent, choke: 'A' }), holds, (id) => id);
    const chat = [
      { from: 0, text: 'U:b 1:fs 2:ff' },
      ...[...holds].map(([id, ks]) => ({ from: id, text: `U:h ${ks.join('')}` })),
      { from: 0, text: itemsText(items) },
      { from: items[0].owner, text: `U:u 0` },
      { from: 3, text: 'U:u h' },
      { from: items[1].owner, text: `U:x 1 s` },
      { from: 0, text: `U:r 1 ${items[0].owner}` },
    ];
    const reps = ids.map((id) => new Resources(ids, id));
    for (const r of reps) r.read(chat);
    const snap = (r: Resources): string => JSON.stringify({ items: r.items, holds: [...r.holds], active: r.active, orders: [...(r.orders ?? [])], site: r.retakeSite });
    for (const r of reps) expect(snap(r)).toBe(snap(reps[0]));
    expect(reps[0].active).toBe(true);
    expect(reps[0].items[0].state).toBe('used');
  });

  it('擁有者陣亡：指揮者把項目交給活著、身上有、離目標最近的人；聽到 U:r 後擁有者換人', () => {
    const ids = [0, 1, 2, 3, 4];
    const r = new Resources(ids, 0);
    r.read([
      { from: 1, text: 'U:h s' },
      { from: 2, text: 'U:h s' },
      { from: 3, text: 'U:h s' },
      { from: 0, text: 'U:p sb1A0' },
    ]);
    const people = [
      { id: 0, x: 0, y: 0, alive: true },
      { id: 1, x: 0, y: 0, alive: false },
      { id: 2, x: 50000, y: 0, alive: true },
      { id: 3, x: 10000, y: 0, alive: true },
    ];
    const say = r.upkeep(people, () => ({ x: 0, y: 0 }), null);
    expect(say).toEqual(['U:r 0 3']);
    r.read(say.map((text) => ({ from: 0, text })));
    expect(r.items[0].owner).toBe(3);
    // 沒有人身上有 → 作廢
    const r2 = new Resources(ids, 0);
    r2.read([{ from: 1, text: 'U:h s' }, { from: 0, text: 'U:p sb1A0' }]);
    expect(r2.upkeep(people, () => null, null)).toEqual(['U:r 0 -']);
  });

  it('保留不出借：fireBackup 的煙在到期前不能被 free 用途拿走；release 後可以', () => {
    const r = new Resources([0, 1], 0);
    r.read([{ from: 1, text: 'U:h s' }, { from: 0, text: 'U:p sb1A0' }]);
    expect(r.claim(1, 'smoke', ['free'])).toBeNull();
    expect(r.claim(1, 'smoke', ['entrySmoke', 'holdSmoke'])).toBeNull();
    expect(r.claim(1, 'smoke', ['fireBackup'])?.idx).toBe(0);
    r.release(['fireBackup']);
    expect(r.claim(1, 'smoke', ['free'])?.idx).toBe(0);
    // 回防道具同樣保留
    const c = new Resources([5, 6], 5);
    c.read([{ from: 6, text: 'U:h fs' }, { from: 5, text: 'U:p sr6--' }]);
    expect(c.claim(6, 'smoke', ['free'])).toBeNull();
    expect(c.claim(6, 'flash', ['free'])).not.toBeNull();
    // 沒收到計畫：一律放行（2.8 行為）
    expect(new Resources([0, 1], 0).claim(1, 'smoke', ['fireBackup'])).not.toBeNull();
  });

  it('需求表與購買單：force 只下 entryFlash 一顆；eco、half 不下；CT 必要一火、另一點的火只填已有的', () => {
    const rush: TPlan = { kind: 'rush', site: 'B', r1: 0, r2: 0, exec: 'B' };
    const people = [0, 1, 2, 3, 4].map((id) => ({ id, money: 6000, good: false, role: id + 1 }));
    const r = { team: 'T' as const, rifle: 2700, armor: 650, kit: 400, price: (k: KindCode) => ({ f: 200, s: 300, h: 300, m: 400 })[k], carry: (k: KindCode) => (k === 'f' ? 2 : 1), slots: 4 };
    const needs = needsOf(rush, { ent, choke: 'A' });
    const full = buyOrders(needs, 'full', people, r);
    expect([...full.values()].flat().sort()).toEqual(['f', 'f', 's']);
    const force = buyOrders(needs, 'force', people, r);
    expect([...force.values()].flat()).toEqual(['f']);
    expect(buyOrders(needs, 'eco', people, r).size).toBe(0);
    expect(buyOrders(needs, 'half', people, r).size).toBe(0);
    const ct = needsOf({ kind: 'hold', a: 2, m: 1, b: 2, rot: null, go: false }, { ent, choke: 'B' });
    expect(ct.filter((n) => n.must).map((n) => n.purpose)).toEqual(['chokeMolotov', 'retakeSmoke', 'retakeFlash']);
    expect(ct.find((n) => n.purpose === 'chokeMolotov' && n.must)?.target.site).toBe('B');
    expect(ct.find((n) => n.purpose === 'chokeMolotov' && !n.must)?.target.site).toBe('A');
  });
});

// ── 整場：購買單生效（補充 A）、沒收到 U:p 退回 2.8（補充 B） ──

type Cb = (obs: ShooterObservation, cmds: readonly ShooterCommand[]) => void;
class Spy extends ShooterBatchController {
  private readonly cb: Cb;
  constructor(b: CompiledBot, label: string, seed: number, pid: number, cb: Cb) {
    super(b, label, seed, pid, MAPS.redrock(), { timeLimits: false });
    this.cb = cb;
  }
  override decide(obs: ShooterObservation): ReturnType<ShooterBatchController['decide']> {
    const o = super.decide(obs);
    this.cb(obs, Array.isArray(o.value) ? (o.value as ShooterCommand[]) : []);
    return o;
  }
}

/** 測試要看的比賽狀態 */
interface MatchView {
  over: boolean;
  roundNumber: number;
  phase: string;
  players: { id: number; team: 'T' | 'CT' }[];
  result: () => { rounds: { winner: string; reason: string; endTick: number }[] };
}

// 原始碼直接當選手（開關 P 與 Bot 共用同一份，才能關掉資源層比對）
const base: CompiledBot = { createClass: () => ShooterBaseline as never, sizeBytes: 0 };
const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'practice');

function driver(seed: number, pick: (pid: number) => CompiledBot, cb: (pid: number, obs: ShooterObservation, cmds: readonly ShooterCommand[]) => void, opts: Record<string, unknown> = {}): { d: ShooterDriver; m: MatchView } {
  const ctrl = Array.from({ length: PLAYER_COUNT }, (_, pid) => new Spy(pick(pid), pick(pid) === base ? 'a' : 'p', seed, pid, (obs, cmds) => cb(pid, obs, cmds)));
  const knobs = ctrl.map((c) => resolveKnobs(c.declaration, {}, c.label));
  const d = new ShooterDriver({ seed, mapId: 'redrock', controllers: ctrl, knobs, record: false, ...opts } as ConstructorParameters<typeof ShooterDriver>[0]);
  return { d, m: (d as unknown as { match: MatchView }).match };
}

const kindName = (k: string, team: 'T' | 'CT'): string => (k === 'f' ? 'flash' : k === 's' ? 'smoke' : k === 'h' ? 'he' : team === 'T' ? 'molotov' : 'incendiary');

describe('Bot 3.0 資源層：整場', () => {
  it('購買時序與購買單生效：隊友在聽到 U:b 之後才買，每人買完後持有的道具（回合開始時原有＋買的）包含 U:b 指定的；每個種子各自要檢查到', () => {
    for (const seed of [3, 4]) {
      // 從第 2 回合起找第一個有購買單的回合（最多到第 6 回合）：第 2 回合有沒有購買單看第 1 回合的經濟，固定第 2 回合會依賴種子；每個種子各自要檢查到
      let checked = 0;
      for (let round = 2; round <= 6 && checked === 0; round++) checked = checkRound(seed, round);
      expect(checked, `種子 ${seed}`).toBeGreaterThan(0);
    }
  }, 240000);

  /** 一個種子的某一回合：檢查購買時序與購買單（持有＝回合開始時身上原有的＋這次買的），回傳檢查過的購買單筆數（這一回合沒有購買單就是 0） */
  function checkRound(seed: number, round: number): number {
    let checked = 0;
    const orders = new Map<number, string>();
    const saidAt = new Map<string, number>();
    const buyAt = new Map<number, number>();
    const bought = new Map<number, string[]>();
    /** 回合開始時身上已經有的道具（上一回合留下的；購買單算的是持有，已經有的不必再買；每個人都記，不只有下購買指令的人） */
    const had = new Map<number, string[]>();
    const { d, m } = driver(seed, () => base, (pid, obs, cmds) => {
      if (obs.round.number !== round) return;
      if (!had.has(pid)) had.set(pid, [...obs.me.loadout.grenades]);
      for (const c of cmds) {
        if (c.type === 'say' && c.text.startsWith('U:b')) {
          saidAt.set(obs.me.team, obs.tick);
          for (const [id, ks] of parseBuyOrders(c.text) ?? []) orders.set(id, ks.join(''));
        }
        if (c.type === 'buy' && !buyAt.has(pid)) {
          buyAt.set(pid, obs.tick);
          bought.set(pid, [...c.items]);
        }
      }
    });
    while (!m.over && (m.roundNumber < round || m.phase === 'freeze')) d.step();
    expect(saidAt.size).toBe(2);
    for (const [pid, at] of buyAt) {
      const team = m.players[pid].team;
      const isCmd = Math.min(...m.players.filter((p) => p.team === team).map((p) => p.id)) === pid;
      if (!isCmd) expect(at).toBeGreaterThan(saidAt.get(team) ?? Infinity);
    }
    for (const [id, ks] of orders) {
      const kinds = ks.split('').map((k) => kindName(k, m.players[id].team));
      const got = [...(had.get(id) ?? []), ...(bought.get(id) ?? [])];
      for (const k of new Set(kinds)) expect(got.filter((x) => x === k).length).toBeGreaterThanOrEqual(kinds.filter((x) => x === k).length);
      checked++;
    }
    return checked;
  }

  it('沒收到 U:p（陪練 Bot 當指揮者）：資源層不啟用，回合結果和關掉資源層（2.8 道具行為）相同', () => {
    // 0、5 號（兩隊最小 id）是陪練 Bot：不喊 B:、U:b、U:p；其他基準 Bot 收不到計畫
    const pick = (pid: number): CompiledBot => (pid === 0 || pid === 5 ? practice : base);
    const run = (on: boolean): { rounds: unknown[]; plans: string[] } => {
      const keep = P.resLayer;
      (P as Record<string, unknown>).resLayer = on;
      const plans: string[] = [];
      try {
        const { d, m } = driver(7, pick, (_pid, _obs, cmds) => {
          for (const c of cmds) if (c.type === 'say' && c.text.startsWith('U:p')) plans.push(c.text);
        }, { roundsPerHalf: 2, winRounds: 3, overtime: false });
        while (!m.over) d.step();
        return { rounds: m.result().rounds.map((r) => [r.winner, r.reason, r.endTick]), plans };
      } finally {
        (P as Record<string, unknown>).resLayer = keep;
      }
    };
    const on = run(true);
    const off = run(false);
    expect(on.plans).toEqual([]);
    expect(on.rounds).toEqual(off.rounds);
  }, 240000);
});
