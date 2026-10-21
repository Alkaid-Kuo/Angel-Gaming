import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { MatchMode } from '../src/config/index.ts';
import { BatchController, resolveKnobs } from '../src/sandbox/controller.ts';
import { loadBotFile, type BotFile } from '../src/sandbox/node-loader.ts';
import { runMatch, type RunMatchOutput } from '../src/sandbox/runner.ts';

const BASELINE = loadBotFile(resolve('bots/baseline.js'));
const RANDOM = loadBotFile(resolve('bots/random.js'));

async function play(mode: MatchMode, seed: number, files: BotFile[], overrides: Record<string, number>[] = []): Promise<RunMatchOutput> {
  const controllers = files.map((f) => new BatchController(f.compiled, f.label));
  const knobs = controllers.map((c, i) => resolveKnobs(c.declaration, overrides[i], c.label));
  return runMatch({ mode, seed, controllers, knobs, record: false });
}

describe('基準 Bot 與隨機 Bot', () => {
  it('1v1：基準 Bot 對隨機 Bot 全勝（20 場）', async () => {
    let wins = 0;
    for (let seed = 100; seed < 120; seed++) {
      const out = await play('1v1', seed, [BASELINE, RANDOM]);
      if (out.result.ranking[0] === 0) wins++;
      expect(out.runtime[0].exceptions).toBe(0);
      expect(out.runtime[1].exceptions).toBe(0);
    }
    expect(wins).toBe(20);
  });

  it('基準 Bot 的旋鈕在範圍兩端都能正常運作', async () => {
    const extremes = [
      { attackThreshold: 6, workerCap: 8, archerRatio: 0 },
      { attackThreshold: 30, workerCap: 24, archerRatio: 80 },
    ];
    for (const k of extremes) {
      const out = await play('1v1', 7, [BASELINE, RANDOM], [k, {}]);
      expect(out.runtime[0].exceptions).toBe(0);
      expect(out.result.ranking[0]).toBe(0);
    }
  });

  it('4 人局：基準 Bot 與隨機 Bot 混戰可正常結束，冠軍為基準 Bot', async () => {
    for (const seed of [5, 6, 7]) {
      const out = await play('ffa4', seed, [BASELINE, RANDOM, BASELINE, RANDOM]);
      for (const rt of out.runtime) expect(rt.exceptions).toBe(0);
      expect([0, 2]).toContain(out.result.ranking[0]);
    }
  });

  it('基準 Bot 鏡像對戰：會生產、會進攻、指令不被拒', async () => {
    const out = await play('1v1', 9, [BASELINE, BASELINE]);
    for (const p of out.result.players) {
      expect(p.stats.unitsProduced.worker).toBeGreaterThan(5);
      expect(p.stats.unitsProduced.spear + p.stats.unitsProduced.archer + p.stats.unitsProduced.cavalry).toBeGreaterThan(10);
      expect(p.stats.firstDamageTick).toBeGreaterThan(0);
      const rejected = Object.entries(p.stats.rejections).filter(([k, v]) => k !== 'NO_BUDGET' && v > 0);
      expect(rejected).toEqual([]);
    }
  });
});
