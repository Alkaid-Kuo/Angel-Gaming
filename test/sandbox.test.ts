import { describe, expect, it } from 'vitest';
import { RULES } from '../src/config/index.ts';
import { Match } from '../src/core/match.ts';
import { placementKnown } from '../src/core/economy.ts';
import { BotLoadError, compileBot } from '../src/sandbox/compile.ts';
import { BatchController, resolveKnobs, type BotController } from '../src/sandbox/controller.ts';
import { BotHelpers } from '../src/sandbox/helpers.ts';
import type { BotFile } from '../src/sandbox/node-loader.ts';
import { OfficialController } from '../src/sandbox/official.ts';
import { runMatch, type RunMatchOutput } from '../src/sandbox/runner.ts';

const KNOBS = `[
  { key: 'a', name: 'a', description: '', min: 0, max: 1e9, default: 0, integer: true },
  { key: 'b', name: 'b', description: '', min: 0, max: 1, default: 0, integer: true },
  { key: 'c', name: 'c', description: '', min: 0, max: 1, default: 0, integer: true },
]`;

/** 以 decide 本體產生測試選手；可用 this.n（呼叫次數）與 obs.knobs.a */
function botSource(decideBody: string, extra = ''): string {
  return `${extra}
export default class TestBot {
  constructor() { this.n = 0; this.me = -1; }
  declare() { return { name: 'Test', version: 'v1', style: '', knobs: ${KNOBS} }; }
  init(data, helpers) { this.me = data.me; this.helpers = helpers; }
  decide(obs) { this.n += 1; ${decideBody} }
}`;
}

function inline(source: string, label = 'test.js'): BotFile {
  return { path: label, label, source, compiled: compileBot(source, label) };
}

const IDLE = inline(botSource('return [];'), 'idle.js');

async function play(files: BotFile[], exec: 'batch' | 'official', knobsA = 0): Promise<RunMatchOutput> {
  const controllers: BotController[] = [];
  for (const f of files) controllers.push(exec === 'batch' ? new BatchController(f.compiled, f.label) : await OfficialController.create(f));
  try {
    const knobs = controllers.map((c) => resolveKnobs(c.declaration, { a: knobsA }, c.label));
    return await runMatch({ mode: '1v1', seed: 3, controllers, knobs, record: true });
  } finally {
    for (const c of controllers) await c.dispose();
  }
}

/** 校準：找出約 targetMs 毫秒的忙碌迴圈次數 */
function calibrate(targetMs: number): number {
  let n = 1_000_000;
  for (;;) {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < n; i++) x = (x * 31 + i) | 0;
    const ms = performance.now() - t0;
    if (x === 42) n += 1;
    if (ms > 2) return Math.max(1, Math.round((n * targetMs) / ms));
    n *= 2;
  }
}

const BUSY = 'let x = 0; for (let i = 0; i < obs.knobs.a; i++) x = (x * 31 + i) | 0; if (x === 42) return [];';

describe('選手模組檢查', () => {
  it('拒絕 import、動態 import、import.meta、export *、超過 200 KB、缺少 default export、非 ES2020 語法', () => {
    expect(() => compileBot(`import fs from 'fs';\nexport default class A {}`, 'x')).toThrow(BotLoadError);
    expect(() => compileBot(`export default class A { f() { return import('fs'); } }`, 'x')).toThrow(BotLoadError);
    expect(() => compileBot(`export default class A { f() { return import.meta.url; } }`, 'x')).toThrow(BotLoadError);
    expect(() => compileBot(`export * from './b.js';\nexport default class A {}`, 'x')).toThrow(BotLoadError);
    expect(() => compileBot(`class A {}`, 'x')).toThrow(BotLoadError);
    expect(() => compileBot(`export default class A { x = 1; }`, 'x')).toThrow(BotLoadError);
    expect(() => compileBot(`// ${'x'.repeat(RULES.botModule.maxBytes)}\nexport default class A {}`, 'x')).toThrow(BotLoadError);
    expect(() => compileBot(`export const helper = 1;\nexport default class A { f() { return helper; } }`, 'x')).not.toThrow();
  });

  it('模組作用域不跨實例共用（同一檔案的兩個選手無法互通）', () => {
    const c = compileBot(`let shared = 0;\nexport default class A { bump() { shared += 1; return shared; } }`, 'x');
    const A1 = c.createClass();
    const A2 = c.createClass();
    const a1 = new A1() as unknown as { bump(): number };
    const a2 = new A2() as unknown as { bump(): number };
    expect(a1.bump()).toBe(1);
    expect(a1.bump()).toBe(2);
    expect(a2.bump()).toBe(1);
  });

  it('旋鈕數量必須為 3～6', () => {
    const src = `export default class A { declare() { return { name: 'A', style: '', knobs: [] }; } init() {} decide() { return []; } }`;
    expect(() => new BatchController(compileBot(src, 'x'), 'x')).toThrow(BotLoadError);
  });
});

describe('批次模式', () => {
  it('使用 Math.random、Date：立即拋例外並記錄，比賽繼續', async () => {
    const bad = inline(botSource('if (this.n % 2 === 0) Math.random(); else Date.now(); return [];'), 'bad.js');
    const out = await play([bad, IDLE], 'batch');
    expect(out.result.durationTicks).toBe(RULES.match.timeLimitTicks);
    expect(out.runtime[0].exceptions).toBe(out.runtime[0].decisions);
    expect(out.runtime[0].errors[0]).toMatch(/Math\.random|Date/);
  });

  it('拋例外：該次視為無指令，比賽繼續', async () => {
    const thrower = inline(botSource('if (this.n === 3) throw new Error("boom"); return [];'), 'throw.js');
    const out = await play([thrower, IDLE], 'batch');
    expect(out.runtime[0].exceptions).toBe(1);
    expect(out.result.durationTicks).toBe(RULES.match.timeLimitTicks);
  });

  it('超過 50 ms 硬上限：整場閒置', async () => {
    const slow = inline(botSource(`if (this.n === 2) { ${BUSY} } return [];`), 'slow.js');
    const out = await play([slow, IDLE], 'batch', calibrate(120));
    expect(out.runtime[0].hardKilled).toBe(true);
    expect(out.runtime[0].decisions).toBe(2);
  });
});

describe('正式模式', () => {
  it('decide 超過 5 ms：該次指令作廢', async () => {
    // 每次都超時並下達 hold；作廢後不會出現在套用的指令中
    const slow = inline(botSource(`if (this.n <= 3) { ${BUSY} return [{ type: 'hold', units: [] }]; } return [];`), 'slow.js');
    const out = await play([slow, IDLE], 'official', calibrate(20));
    expect(out.runtime[0].softTimeouts).toBe(3);
    expect(out.runtime[0].hardKilled).toBe(false);
    const p = out.result.players.find((x) => x.playerId === 0)!;
    expect(p.stats.commandsIssued).toBe(0);
    expect(out.replay!.decisions.filter((d) => d.voided === true).length).toBe(3);
  });

  it('無窮迴圈：50 ms 被終止，比賽正常結束', async () => {
    const loop = inline(botSource('if (this.n === 4) { for (;;) {} } return [];'), 'loop.js');
    const out = await play([loop, IDLE], 'official');
    expect(out.runtime[0].hardKilled).toBe(true);
    expect(out.runtime[0].decisions).toBe(4);
    expect(out.result.durationTicks).toBe(RULES.match.timeLimitTicks);
  });

  it('使用 Math.random、Date：立即拋例外並記錄；拋例外比賽繼續', async () => {
    const bad = inline(botSource('if (this.n === 1) Math.random(); if (this.n === 2) new Date(); if (this.n === 3) throw new Error("x"); return [];'), 'bad.js');
    const out = await play([bad, IDLE], 'official');
    expect(out.runtime[0].exceptions).toBe(3);
    expect(out.runtime[0].errors.join('\n')).toMatch(/Math\.random/);
    expect(out.result.durationTicks).toBe(RULES.match.timeLimitTicks);
  });
});

describe('輔助工具', () => {
  it('canPlace 與引擎「依已知資訊」的放置判定一致；random 依 (seed, playerId) 確定', () => {
    const m = new Match({ mode: '1v1', seed: 9, players: [{ knobs: {} }, { knobs: {} }] });
    const pid = 0;
    const h = new BotHelpers(m.initData(pid));
    const { obs, exploredDelta } = m.observe(pid);
    h.update(obs, exploredDelta);
    const p = m.state.players[pid];
    let checked = 0;
    for (const type of ['supply', 'barracks', 'base'] as const) {
      for (let y = 0; y < m.state.height; y += 1) {
        for (let x = 0; x < m.state.width; x += 1) {
          expect(h.canPlace(type, x, y)).toBe(placementKnown(m.state, p, type, x, y));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    const h2 = new BotHelpers(m.initData(pid));
    const h3 = new BotHelpers(m.initData(1));
    const a = [h.random(), h.random()];
    expect([h2.random(), h2.random()]).toEqual(a);
    expect(h3.random()).not.toBe(a[0]);
  });

  it('pathDistance：直線與斜線長度、起訖被建築佔據仍可計算、不可達回傳 -1', () => {
    const m = new Match({ mode: '1v1', seed: 9, players: [{ knobs: {} }, { knobs: {} }] });
    const data = m.initData(0);
    const h = new BotHelpers(data);
    const { obs, exploredDelta } = m.observe(0);
    h.update(obs, exploredDelta);
    const s = data.startSlots[0];
    // 從主堡（被自己的建築佔據）出發仍可計算
    const d = h.pathDistance(s.tileX + 1, s.tileY + 1, data.startSlots[1].tileX + 1, data.startSlots[1].tileY + 1);
    expect(d).toBeGreaterThan(0);
    // 開闊地：同列移動 3 格 = 3000；斜移 2 格 = 2828
    const free = (x: number, y: number): boolean => h.terrainAt(x, y) === 0 && data.mineNodes.every((n) => n.tileX !== x || n.tileY !== y);
    let found = false;
    for (let y = 1; y < data.height - 3 && !found; y++) {
      for (let x = 1; x < data.width - 3 && !found; x++) {
        let ok = true;
        for (let dy = 0; dy <= 2 && ok; dy++) for (let dx = 0; dx <= 3 && ok; dx++) ok = free(x + dx, y + dy);
        if (!ok || m.state.buildingAt[y * data.width + x] !== 0) continue;
        expect(h.pathDistance(x, y, x + 3, y)).toBe(3000);
        expect(h.pathDistance(x, y, x + 2, y + 2)).toBe(2828);
        found = true;
      }
    }
    expect(found).toBe(true);
    expect(h.pathDistance(-1, 0, 5, 5)).toBe(-1);
    expect(h.terrainAt(-1, 0)).toBe(1);
  });
});
