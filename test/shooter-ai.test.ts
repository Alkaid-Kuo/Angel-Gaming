// CS 射擊基準 Bot（步驟 6）：產生檔與原始碼一致、選手模組限制、計畫／事件／買法字串、情境測試 P0～P13 與 T1～T15（每個 5 個種子；T 兩張圖都跑）、
// 地圖分析（不寫死座標：兩張圖都算得出入口、守點位、下包位、至少 2 條路線）、短賽制對陪練零例外零超時。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOOTER_BOTS, buildShooterBot } from '../scripts/build-shooter-bots.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import type { ShooterHelpers, ShooterInitData } from '../src/shooter/api.ts';
import { AI_SCENARIOS, AI_SCENARIO_SEEDS } from '../src/shooter/ai-scenarios.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterBatchController, runShooterMatch, shooterHelpers } from '../src/shooter/runner.ts';
import { PLAYER_COUNT, shooterInitData } from '../src/shooter/sim.ts';
import { Grid, initTrig } from '../bots/shooter-src/base.js';
import { MapIntel } from '../bots/shooter-src/analysis.js';
import { parseEvent, parsePlan, planText } from '../bots/shooter-src/tactics.js';
import { parseBuy } from '../bots/shooter-src/economy.js';

const source = readFileSync('bots/shooter-baseline.js', 'utf8');
const baseline = compileBot(source, 'shooter-baseline.js');
const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'shooter-practice.js');

describe('射擊基準 Bot：檔案與宣告', () => {
  it('bots/shooter-baseline.js 與 bots/shooter-src/ 的原始碼一致（改原始碼後要執行 scripts/build-shooter-bots.ts）', () => {
    for (const b of SHOOTER_BOTS) expect(readFileSync(b.out, 'utf8').replaceAll('\r\n', '\n')).toBe(buildShooterBot(b.entry));
  });

  it('符合選手模組限制（≤ 200 KB、可編譯）並宣告 3～6 顆旋鈕、名稱與版本', () => {
    expect(baseline.sizeBytes).toBeLessThanOrEqual(200 * 1024);
    const c = new ShooterBatchController(baseline, 'baseline', 1, 0, MAPS.redrock());
    expect(c.declaration.name).toBe('shooter-baseline');
    expect(c.declaration.version).toBe('2.0');
    expect(c.declaration.style).toBe('基準');
    expect(c.declaration.knobs.length).toBeGreaterThanOrEqual(3);
    expect(c.declaration.knobs.length).toBeLessThanOrEqual(6);
  });

  it('計畫、事件、買法字串可以來回轉換', () => {
    const plans = ['P:go A 0', 'P:go B 2', 'P:hold A=3 B=2', 'P:rushA 1', 'P:splitB 0 2', 'P:splitB 0 2 go', 'P:default A 0 1', 'P:default A 0 1 >B', 'P:fake B 0 1 >B', 'P:hold A=2 M=1 B=2', 'P:hold A=2 M=1 B=2 rot=B go'];
    for (const t of plans) expect(planText(parsePlan(t)!)).toBe(t);
    expect(parsePlan('E:planted B')).toBeNull();
    expect(parseEvent('E:contact bSite 3')).toEqual({ kind: 'contact', region: 'bSite', n: 3 });
    expect(parseEvent('E:planted B')).toEqual({ kind: 'planted', site: 'B' });
    expect(parseBuy('B:eco')).toBe('eco');
    expect(parseBuy('P:rushA 0')).toBeNull();
  });
});

describe('射擊基準 Bot：地圖分析', () => {
  for (const id of ['redrock', 'dust']) {
    it(`${id}：兩個包點都有入口、守點位、下包位，T 到每個包點至少 2 條路線；init 在 1 秒上限內`, () => {
      const map = MAPS[id]();
      const data: ShooterInitData = shooterInitData(map, 0, {});
      const h: ShooterHelpers = shooterHelpers(map, 1, 0);
      initTrig(h);
      const g = new Grid(data.map);
      const intel = new MapIntel(data.map, g);
      expect(intel.chokes.length).toBeGreaterThan(0);
      for (const s of ['A', 'B'] as const) {
        const site = intel.sites[s];
        expect(site.entrances.length).toBeGreaterThanOrEqual(2);
        expect(site.holds.length).toBeGreaterThanOrEqual(site.entrances.length);
        expect(site.plants.length).toBeGreaterThan(0);
        for (const p of site.plants) expect(p.x >= site.rect.x0 * 1000 && p.x < site.rect.x1 * 1000 && p.y >= site.rect.y0 * 1000 && p.y < site.rect.y1 * 1000).toBe(true);
        for (const hs of site.holds) expect(g.los(hs.x, hs.y, hs.fx, hs.fy)).toBe(true);
        expect(intel.routes.T[s].length).toBeGreaterThanOrEqual(2);
      }
      const Bot = baseline.createClass() as unknown as new () => { init(d: ShooterInitData, h: ShooterHelpers): void };
      const t0 = performance.now();
      new Bot().init(data, h);
      expect(performance.now() - t0).toBeLessThan(1000);
    });
  }
});

describe('射擊基準 Bot：情境測試 P0～P13、T1～T15（每個情境 5 個種子）', () => {
  for (const s of AI_SCENARIOS) {
    it(`${s.id} ${s.name}：${s.expect}`, () => {
      for (const seed of AI_SCENARIO_SEEDS) {
        const r = s.run(baseline, seed, practice);
        expect(r.pass, `種子 ${seed}：${r.detail}`).toBe(true);
      }
    }, 400000);
  }
});

describe('射擊基準 Bot：對陪練短賽制', () => {
  it('兩張圖、雙邊各一場（每半場 3 回合）：零例外、零超時', () => {
    for (const mapId of ['redrock', 'dust']) {
      for (const first of [true, false]) {
        const map = MAPS[mapId]();
        const isBase = (pid: number): boolean => pid < PLAYER_COUNT / 2 === first;
        const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(isBase(pid) ? baseline : practice, isBase(pid) ? 'baseline' : 'practice', 7, pid, map));
        const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
        const run = runShooterMatch({ seed: 7, mapId, roundsPerHalf: 3, winRounds: 4, overtime: false, controllers, knobs, record: false });
        for (const rt of run.runtime) {
          expect(rt.exceptions, rt.errors.join('；')).toBe(0);
          expect(rt.timeouts).toBe(0);
        }
        expect(run.result.rounds.length).toBeGreaterThan(0);
      }
    }
  });
});
