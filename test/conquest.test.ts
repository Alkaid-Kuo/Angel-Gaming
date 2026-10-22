import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { CONQUEST } from '../src/config/index.ts';
import { Match } from '../src/core/match.ts';
import { ReplayCursor } from '../src/replay/cursor.ts';
import { runReplay } from '../src/replay/index.ts';
import { BatchController, resolveKnobs } from '../src/sandbox/controller.ts';
import { loadBotFile } from '../src/sandbox/node-loader.ts';
import { runMatch } from '../src/sandbox/runner.ts';

const CONQ = loadBotFile(resolve('bots/conquest.js'));

function newConquest(seed: number): Match {
  return new Match({ mode: '1v1', seed, players: [{ knobs: {} }, { knobs: {} }], ruleset: 'conquest' });
}

/** 待送出的指令：在下一個決策 tick 套用 */
let pending: Record<number, unknown> = {};

function step(m: Match, cmds: Record<number, unknown> = {}): void {
  pending = { ...pending, ...cmds };
  m.beginTick();
  if (m.isDecisionTick()) {
    for (let pid = 0; pid < m.playerCount; pid++) {
      m.observe(pid);
      if (pending[pid] !== undefined) m.applyCommands(pid, pending[pid]);
    }
    pending = {};
  }
  m.endTick();
}

describe('搶點模式（原型）', () => {
  it('開局：沒有礦點、7 個控制點（1 個中央）、每人 2 工人 4 長槍兵；觀察資料提供控制點與勝利點', () => {
    const m = newConquest(3);
    const s = m.state;
    expect(s.nodes.length).toBe(0);
    expect(s.towers.length).toBe(7);
    expect(s.towers.filter((t) => t.center).length).toBe(1);
    for (const p of s.players) {
      const mine = s.units.filter((u) => u.owner === p.id);
      expect(mine.filter((u) => u.type === 'worker').length).toBe(CONQUEST.startWorkers);
      expect(mine.filter((u) => u.type === 'spear').length).toBe(CONQUEST.startArmy.length);
      expect(p.minerals).toBe(CONQUEST.startMinerals);
    }
    const init = m.initData(0);
    expect(init.ruleset).toBe('conquest');
    expect(init.conquest?.points.length).toBe(7);
    const obs = m.observe(0).obs;
    expect(obs.controlPoints?.length).toBe(7);
    expect(obs.victoryPoints).toEqual([0, 0]);
    expect(obs.watchtowers).toEqual([]);
  });

  it('佔領：單方在圈內累積佔領值後佔領；敵方進圈先把佔領值扣到 0 變中立，再由敵方佔領', () => {
    const m = newConquest(5);
    const s = m.state;
    const t = s.towers.find((x) => x.center)!;
    const a = s.units.filter((u) => u.owner === 0 && u.type === 'spear').map((u) => u.id);
    const b = s.units.filter((u) => u.owner === 1 && u.type === 'spear').map((u) => u.id);
    for (let i = 0; i < 400 && t.owner !== 0; i++) step(m, i === 0 ? { 0: [{ type: 'move', units: a, x: t.x, y: t.y }] } : {});
    expect(t.owner).toBe(0);
    expect(t.hold).toBe(CONQUEST.captureTarget);
    // 0 號撤離，1 號進圈：先中立再易主
    let sawNeutral = false;
    for (let i = 0; i < 600 && t.owner !== 1; i++) {
      step(m, i === 0 ? { 0: [{ type: 'move', units: a, x: s.players[0].startX, y: s.players[0].startY }], 1: [{ type: 'move', units: b, x: t.x, y: t.y }] } : {});
      if (t.owner === -1) sawNeutral = true;
    }
    expect(sawNeutral).toBe(true);
    expect(t.owner).toBe(1);
  });

  it('壓制倒數：控制超過半數的點持續 dominationTicks 即獲勝，名次第 1', () => {
    const m = newConquest(7);
    const s = m.state;
    for (const t of s.towers.slice(0, 4)) {
      t.owner = 1;
      t.hold = CONQUEST.captureTarget;
    }
    let ticks = 0;
    while (!m.over) {
      step(m);
      ticks += 1;
    }
    expect(ticks).toBe(CONQUEST.dominationTicks);
    expect(m.result().ranking[0]).toBe(1);
  });

  it('搶點基準 Bot 對戰：不出錯、回放（runReplay 與回放游標）可重建、同 seed 結果相同', async () => {
    const play = async (): Promise<{ hash: string; replay: NonNullable<Awaited<ReturnType<typeof runMatch>>['replay']> }> => {
      const controllers = [CONQ, CONQ].map((f) => new BatchController(f.compiled, f.label));
      const knobs = controllers.map((c, i) => resolveKnobs(c.declaration, i === 0 ? undefined : { groups: 1, aggression: 100 }, c.label));
      const out = await runMatch({ mode: '1v1', seed: 11, controllers, knobs, record: true, ruleset: 'conquest' });
      for (const rt of out.runtime) expect(rt.exceptions).toBe(0);
      return { hash: out.finalHash, replay: out.replay! };
    };
    const a = await play();
    const b = await play();
    expect(a.hash).toBe(b.hash);
    expect(a.replay.header.ruleset).toBe('conquest');
    expect(runReplay(a.replay, true).finalHash).toBe(a.hash);
    const cursor = new ReplayCursor(a.replay);
    while (!cursor.over) cursor.step();
    expect(cursor.desyncTick).toBeNull();
  });
});
