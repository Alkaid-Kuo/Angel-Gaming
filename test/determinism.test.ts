import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { MatchMode } from '../src/config/index.ts';
import { ReplayDesyncError, ReplayVersionError, runReplay, type ReplayFile } from '../src/replay/index.ts';
import { BatchController, resolveKnobs, type BotController } from '../src/sandbox/controller.ts';
import { loadBotFile } from '../src/sandbox/node-loader.ts';
import { OfficialController } from '../src/sandbox/official.ts';
import { runMatch, type RunMatchOutput } from '../src/sandbox/runner.ts';

const BASELINE = loadBotFile(resolve('bots/baseline.js'));
const RANDOM = loadBotFile(resolve('bots/random.js'));

async function play(mode: MatchMode, seed: number, files = mode === '1v1' ? [BASELINE, RANDOM] : [BASELINE, RANDOM, BASELINE, RANDOM], exec: 'batch' | 'official' = 'batch'): Promise<RunMatchOutput> {
  const controllers: BotController[] = [];
  for (const f of files) controllers.push(exec === 'batch' ? new BatchController(f.compiled, f.label) : await OfficialController.create(f));
  try {
    const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
    return await runMatch({ mode, seed, controllers, knobs, record: true });
  } finally {
    for (const c of controllers) await c.dispose();
  }
}

describe('確定性', () => {
  it('同 seed ＋ 同指令序列連跑 3 次，每 100 tick 狀態雜湊完全一致（1v1）', async () => {
    const live = await play('1v1', 11);
    const replay = live.replay!;
    expect(replay.hashes.length).toBeGreaterThan(10);
    const runs = [0, 1, 2].map(() => runReplay(replay, true));
    for (const r of runs) {
      expect(r.hashes).toEqual(replay.hashes);
      expect(r.finalHash).toBe(live.finalHash);
      expect(r.ranking).toEqual(live.result.ranking);
    }
  });

  it('同 seed ＋ 同指令序列連跑 3 次，雜湊一致（4 人局）', async () => {
    const live = await play('ffa4', 12);
    const runs = [0, 1, 2].map(() => runReplay(live.replay!, true));
    for (const r of runs) expect(r.hashes).toEqual(live.replay!.hashes);
  });

  it('同 seed 同選手再跑一次，結果完全相同；不同 seed 結果不同', async () => {
    const a = await play('1v1', 21);
    const b = await play('1v1', 21);
    const c = await play('1v1', 22);
    expect(b.replay!.hashes).toEqual(a.replay!.hashes);
    expect(b.finalHash).toBe(a.finalHash);
    expect(c.finalHash).not.toBe(a.finalHash);
  });

  it('回放經 JSON 序列化後仍可重建', async () => {
    const live = await play('1v1', 31);
    const file = JSON.parse(JSON.stringify(live.replay)) as ReplayFile;
    expect(runReplay(file, true).finalHash).toBe(live.finalHash);
  });

  it('正式模式錄製的回放，重建後最終雜湊一致', async () => {
    const live = await play('1v1', 41, [BASELINE, RANDOM], 'official');
    expect(runReplay(live.replay!, true).finalHash).toBe(live.finalHash);
  });

  it('竄改指令紀錄會被雜湊偵測到；版本不符拒絕播放', async () => {
    const live = await play('1v1', 51);
    const file = JSON.parse(JSON.stringify(live.replay)) as ReplayFile;
    const idx = file.decisions.findIndex((d) => d.playerId === 0 && Array.isArray(d.commands) && d.commands.length > 0);
    file.decisions.splice(idx, 1);
    expect(() => runReplay(file, true)).toThrow(ReplayDesyncError);
    const bad = { ...file, header: { ...file.header, engineVersion: '0.0.0' } };
    expect(() => runReplay(bad, true)).toThrow(ReplayVersionError);
  });
});
