import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P } from '../bots/shooter-src/base.js';
import type { Choice, LogEntry } from '../bots/shooter-src/choice.js';
import type { CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterBatchController, ShooterDriver } from '../src/shooter/runner.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';

// Bot 3.0 效用層（設計 docs/2026-11-10_CS射擊_Bot3.0效用式個人層設計.md）第 2 步：特徵範圍、確定性、錯開、紀錄格式。

const base: CompiledBot = { createClass: () => ShooterBaseline as never, sizeBytes: 0 };
type Row = { pid: number; e: LogEntry; feats: { key: string; v: number }[][]; text: string };

/** 特徵表宣告的範圍（跑過一次後填） */
const declared = new Map<string, [number, number]>();

/** 跑 seed 的前 rounds 回合，收集每個人每次效用決策的紀錄與特徵值 */
function run(seed: number, rounds: number): Row[] {
  const ctrl = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(base, 'a', seed, pid, MAPS.redrock(), { timeLimits: false }));
  const knobs = ctrl.map((c) => resolveKnobs(c.declaration, {}, c.label));
  const d = new ShooterDriver({ seed, mapId: 'redrock', controllers: ctrl, knobs, record: false } as ConstructorParameters<typeof ShooterDriver>[0]);
  const m = (d as unknown as { match: { over: boolean; roundNumber: number } }).match;
  const choices = (): Choice[] => ctrl.map((c) => (c as unknown as { bot: { choice: Choice } }).bot.choice);
  const last = new Array<number>(PLAYER_COUNT).fill(-1);
  const rows: Row[] = [];
  while (!m.over && m.roundNumber <= rounds) {
    d.step();
    choices().forEach((ch, pid) => {
      const e = ch.log[ch.log.length - 1];
      if (e === undefined || e.tick === last[pid]) return;
      last[pid] = e.tick;
      rows.push({ pid, e, feats: ch.trace, text: ch.text() });
    });
  }
  for (const f of choices()[0].features) declared.set(f.key, [f.min, f.max]);
  return rows;
}

describe('Bot 3.0 效用層：影子模式', () => {
  let rows: Row[] = [];
  beforeAll(() => {
    P.choiceTrace = true;
    rows = run(5, 2);
  }, 300000);
  afterAll(() => {
    P.choiceTrace = false;
  });

  it('每個特徵值都在宣告的範圍內、是有限數', () => {
    expect(rows.length).toBeGreaterThan(100);
    const seen = new Set<string>();
    for (const r of rows) {
      for (const cand of r.feats) {
        for (const f of cand) {
          const rg = declared.get(f.key);
          expect(rg, f.key).toBeDefined();
          expect(Number.isFinite(f.v), `${f.key}=${f.v}`).toBe(true);
          expect(f.v, f.key).toBeGreaterThanOrEqual(rg?.[0] ?? 0);
          expect(f.v, f.key).toBeLessThanOrEqual(rg?.[1] ?? 1);
          seen.add(f.key);
        }
      }
    }
    // 每個宣告的特徵都至少被算過一次
    expect([...declared.keys()].filter((k) => !seen.has(k))).toEqual([]);
  });

  it('確定性：同種子兩次跑，每個人的決策紀錄完全相同', () => {
    const again = run(5, 2);
    const key = (rs: Row[]): string => rs.map((r) => `${r.pid}@${r.e.tick}:${r.e.ev}:${r.text}:${r.e.act}`).join('\n');
    expect(key(again)).toBe(key(rows));
  }, 300000);

  it('錯開：輪值（非事件）決策時，同一隊同一個 tick 最多一人', () => {
    const byTick = new Map<string, number>();
    for (const r of rows) {
      if (r.e.ev !== '') continue;
      const k = `${r.pid < 5 ? 0 : 1}@${r.e.tick}`;
      byTick.set(k, (byTick.get(k) ?? 0) + 1);
    }
    expect(Math.max(...byTick.values())).toBe(1);
  });

  it('紀錄字串照第七節正式格式；凍結期間不決策', () => {
    for (const r of rows) {
      expect(r.text).toMatch(/^!?([hapftgro]\d+ -?\d*\.\d\d)(\|[hapftgro]\d+ -?\d*\.\d\d){0,2} → [hapftgro]\d+$/);
      expect(r.e.stage).not.toBe('freeze');
    }
  });
});
