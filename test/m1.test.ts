import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { renderPng } from '../src/cli/png.ts';
import { RULES } from '../src/config/index.ts';
import { Match } from '../src/core/match.ts';
import { generateMap } from '../src/mapgen/index.ts';
import { ReplayCursor } from '../src/replay/cursor.ts';
import { runReplay } from '../src/replay/index.ts';
import { BatchController, resolveKnobs, type BotController } from '../src/sandbox/controller.ts';
import { HumanController } from '../src/sandbox/human.ts';
import { loadBotFile } from '../src/sandbox/node-loader.ts';
import { MatchDriver, runMatch, type RunMatchOutput } from '../src/sandbox/runner.ts';
import { frameView, GOD_VIEW } from '../src/view/snapshot.ts';
import { newMatch, run, spawn, testMap } from './helpers.ts';

const BASELINE = loadBotFile(resolve('bots/baseline.js'));

async function baselineMirror(seed: number): Promise<RunMatchOutput> {
  const controllers = [BASELINE, BASELINE].map((f) => new BatchController(f.compiled, f.label));
  const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  return runMatch({ mode: '1v1', seed, controllers, knobs, record: true });
}

describe('狀態快照（clone）與回放游標', () => {
  it('中途複製的比賽，與原比賽繼續跑的結果完全相同', async () => {
    const live = await baselineMirror(77);
    const file = live.replay!;
    const cursor = new ReplayCursor(file);
    cursor.seek(1500);
    const a = cursor.current;
    const b = a.clone();
    expect(b.hash()).toBe(a.hash());
    // 兩邊各自用回放指令跑完
    const cursorB = new ReplayCursor(file);
    cursorB.seek(1500);
    while (!cursor.over) cursor.step();
    while (!cursorB.over) cursorB.step();
    expect(cursor.current.hash()).toBe(live.finalHash);
    expect(cursorB.current.hash()).toBe(live.finalHash);
    expect(cursor.desyncTick).toBeNull();
  });

  it('來回跳轉後的狀態與線性播放一致', async () => {
    const live = await baselineMirror(78);
    const file = live.replay!;
    const linear = new ReplayCursor(file);
    const hashAt = new Map<number, string>();
    while (!linear.over) {
      linear.step();
      if (linear.tick % 700 === 0) hashAt.set(linear.tick, linear.current.hash());
    }
    const c = new ReplayCursor(file);
    for (const t of [2100, 700, 3500, 1400, 2800]) {
      if (!hashAt.has(t)) continue;
      c.seek(t);
      expect(c.tick).toBe(t);
      expect(c.current.hash()).toBe(hashAt.get(t));
    }
  });
});

describe('人類玩家', () => {
  it('不限指令額度：一次 12 個指令都會套用', () => {
    const m = new Match({ mode: '1v1', seed: 3, players: [{ knobs: {}, unlimitedBudget: true }, { knobs: {} }], map: testMap() });
    const cmds = Array.from({ length: 12 }, () => ({ type: 'hold' as const, units: [] as number[] }));
    const ev = run(m, 1, { 0: cmds, 1: cmds });
    expect(ev.get(0)!.filter((e) => e.type === 'commandRejected')).toEqual([]);
    expect(ev.get(1)!.filter((e) => e.type === 'commandRejected').length).toBe(7);
  });

  it('人類的指令在決策 tick 套用並錄進回放，回放可重建', async () => {
    const human = new HumanController();
    const bot = new BatchController(BASELINE.compiled, 'baseline.js');
    const controllers: BotController[] = [human, bot];
    const driver = new MatchDriver({ mode: '1v1', seed: 5, controllers, knobs: [{}, resolveKnobs(bot.declaration, undefined, 'b')], record: true, unlimitedBudget: [true, false] });
    await driver.init();
    const m = driver.match;
    const workers = m.state.units.filter((u) => u.owner === 0).map((u) => u.id);
    const node = m.state.nodes.find((n) => n.areaId === m.state.players[0].mainAreaId)!;
    human.enqueue([{ type: 'gather', units: workers, nodeId: node.id }]);
    for (let i = 0; i < 300; i++) await driver.stepTick();
    expect(m.state.players[0].stats.gathered).toBeGreaterThan(0);
    const base = m.state.buildings.find((b) => b.owner === 0)!;
    human.enqueue([{ type: 'train', buildingId: base.id, unit: 'worker' }]);
    while (!m.over) await driver.stepTick();
    const replay = driver.replay!;
    expect(replay.header.players[0].unlimitedBudget).toBe(true);
    expect(replay.decisions.filter((d) => d.playerId === 0).length).toBe(2);
    expect(runReplay(replay, true).finalHash).toBe(m.hash());
  });
});

describe('畫面快照', () => {
  it('選手視角只看得到視野內的敵方單位；上帝視角看得到全部', () => {
    const m = newMatch(testMap());
    const far = spawn(m, 1, 'spear', 30000, 40000);
    const near = spawn(m, 1, 'spear', m.state.players[0].startX + 3000, m.state.players[0].startY);
    const god = frameView(m, GOD_VIEW);
    expect(god.units.some((u) => u.id === far.id)).toBe(true);
    expect(god.fog).toBeNull();
    const view = frameView(m, 0);
    expect(view.units.some((u) => u.id === far.id)).toBe(false);
    expect(view.units.some((u) => u.id === near.id)).toBe(true);
    expect(view.fog!.length).toBe(m.state.width * m.state.height);
    expect(view.fog!.some((f) => f === 0)).toBe(true);
    expect(view.fog!.some((f) => f === 2)).toBe(true);
  });
});

describe('地圖 PNG', () => {
  it('輸出合法 PNG，尺寸為每格 8 像素', () => {
    const map = generateMap('1v1', 4);
    const png = renderPng(map);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(map.width * 8);
    expect(png.readUInt32BE(20)).toBe(map.height * 8);
    // IDAT 解壓後長度 = 高 ×（寬 × 3 ＋ 1）
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(map.height * 8 * (map.width * 8 * 3 + 1));
    expect(RULES.replay.checkpointInterval).toBe(600);
  });
});
