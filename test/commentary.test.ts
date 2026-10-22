import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { BatchController, resolveKnobs } from '../src/sandbox/controller.ts';
import { loadBotFile } from '../src/sandbox/node-loader.ts';
import { MatchDriver } from '../src/sandbox/runner.ts';
import { CombatMeter } from '../src/view/broadcast.ts';
import { ScoreTracker } from '../src/view/scoreboard.ts';
import { Commentator, type Comment } from '../src/web/commentary.ts';

const BASELINE = loadBotFile(resolve('bots/baseline.js'));

async function watch(seed: number, primeAt: number | null): Promise<{ comments: Comment[]; afterPrime: Comment[]; hash: string; eliminated: number }> {
  const controllers = [BASELINE, BASELINE].map((f) => new BatchController(f.compiled, f.label));
  const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const d = new MatchDriver({ mode: '1v1', seed, controllers, knobs, record: false });
  await d.init();
  const meter = new CombatMeter();
  const scores = new ScoreTracker();
  const c = new Commentator();
  c.prime(d.match.state);
  d.match.state.eventTap = (pid, ev) => c.onEvent(pid, ev);
  const comments: Comment[] = [];
  const afterPrime: Comment[] = [];
  while (!d.match.over) {
    await d.stepTick();
    const s = d.match.state;
    meter.update(s);
    scores.update(s);
    c.update(s, meter, () => scores.rows(s));
    if (primeAt !== null && s.tick === primeAt) {
      comments.push(...c.take());
      scores.reset();
      c.prime(s);
    }
    (primeAt !== null && s.tick > primeAt ? afterPrime : comments).push(...c.take());
  }
  return { comments, afterPrime, hash: d.match.hash(), eliminated: d.match.state.players.filter((p) => !p.alive).length };
}

describe('自動解說', () => {
  it('一場基準 Bot 對戰：開場、兵營、交戰與結算、淘汰都有播報；選手代號格式正確', async () => {
    const { comments, eliminated } = await watch(3, null);
    const text = comments.map((c) => c.text);
    expect(text[0]).toMatch(/^比賽開始/);
    expect(text.filter((t) => t.includes('第一座兵營')).length).toBe(2);
    expect(text.some((t) => t.includes('交戰！'))).toBe(true);
    expect(text.some((t) => t.startsWith('交戰結束') || t.startsWith('混戰結束'))).toBe(true);
    expect(comments.filter((c) => c.major && c.text.includes('被淘汰')).length).toBe(eliminated);
    if (eliminated === 0) expect(text.some((t) => t.startsWith('剩 2 分鐘'))).toBe(true);
    for (const t of text) for (const m of t.matchAll(/\{P(\d+)\}/g)) expect(Number(m[1])).toBeLessThan(2);
    // tick 依序遞增
    for (let i = 1; i < comments.length; i++) expect(comments[i].tick).toBeGreaterThanOrEqual(comments[i - 1].tick);
  });

  it('中途重新起算（回放跳轉）後，不會重播已經存在的兵營；解說不影響模擬', async () => {
    const plain = await watch(4, null);
    const primed = await watch(4, 2500);
    expect(primed.hash).toBe(plain.hash);
    expect(primed.afterPrime.some((c) => c.text.includes('第一座兵營'))).toBe(false);
  });
});
