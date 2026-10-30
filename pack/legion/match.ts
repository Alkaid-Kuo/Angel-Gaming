// 軍團戰對戰工具：兩隻選手對打多場（同一個種子雙方交換起點各打一場），印出勝負與基本統計。
// 用法：
//   node match.ts <A.js> <B.js> [--mode annihilation|capture|both] [--games N] [--seed S]
//                 [--knobs-a '{"key":值}'] [--knobs-b '{"key":值}'] [--json] [--quiet]
//   node match.ts --check <bot.js> [--knobs-a '{"key":值}']
// 結束碼：0 成功、1 參數錯誤、2 選手載入失敗。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { KnobValues } from './src/api/types.ts';
import type { LegionEvent } from './src/legion/api.ts';
import { MODE_NAMES, type LegionMode } from './src/legion/config.ts';
import { MAPS, defaultMapId, defaultTimeLimit } from './src/legion/map.ts';
import { LegionBatchController, LegionDriver } from './src/legion/runner.ts';
import { LegionMatch, legionInitData } from './src/legion/sim.ts';
import { BotLoadError, compileBot, type CompiledBot } from './src/sandbox/compile.ts';
import { resolveKnobs } from './src/sandbox/controller.ts';

interface Entry {
  readonly path: string;
  readonly label: string;
  readonly compiled: CompiledBot;
  readonly knobs: KnobValues | undefined;
}

interface Side {
  readonly killValue: number;
  readonly score: number;
  readonly strength: number;
  readonly decideMsAvg: number;
  readonly decideMsMax: number;
  readonly exceptions: number;
  readonly killed: boolean;
  readonly deployRejected: number;
  readonly rejected: number;
  readonly errors: readonly string[];
}

interface Game {
  readonly game: number;
  readonly seed: number;
  /** A 坐的位置：0 藍方（西）、1 紅方（東） */
  readonly seatA: number;
  /** A 的結果 */
  readonly outcome: 'win' | 'loss' | 'draw';
  readonly reason: string;
  readonly seconds: number;
  readonly a: Side;
  readonly b: Side;
}

function fail(msg: string, code: number): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function usage(): never {
  return fail(
    [
      '用法：',
      '  node match.ts <A.js> <B.js> [--mode annihilation|capture|both] [--games N] [--seed S] [--knobs-a JSON] [--knobs-b JSON] [--json] [--quiet]',
      '  node match.ts --check <bot.js> [--knobs-a JSON]',
    ].join('\n'),
    1,
  );
}

// ───────── 參數 ─────────

const args = process.argv.slice(2);
const positional: string[] = [];
const opts: Record<string, string> = {};
const FLAGS = new Set(['--json', '--quiet', '--check']);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (FLAGS.has(a)) opts[a] = '1';
  else if (a.startsWith('--')) {
    if (i + 1 >= args.length) usage();
    opts[a] = args[++i];
  } else positional.push(a);
}
for (const k of Object.keys(opts)) if (!FLAGS.has(k) && !['--mode', '--games', '--seed', '--knobs-a', '--knobs-b'].includes(k)) fail(`不認得的參數 ${k}`, 1);

const modeArg = opts['--mode'] ?? 'both';
if (!['annihilation', 'capture', 'both'].includes(modeArg)) fail(`--mode 只能是 annihilation、capture 或 both，收到 ${modeArg}`, 1);
const modes: LegionMode[] = modeArg === 'both' ? ['annihilation', 'capture'] : [modeArg as LegionMode];
const games = Number(opts['--games'] ?? 2);
if (!Number.isInteger(games) || games < 1) fail('--games 必須是正整數', 1);
const seed0 = Number(opts['--seed'] ?? 1);
if (!Number.isInteger(seed0)) fail('--seed 必須是整數', 1);

function parseKnobs(flag: string): KnobValues | undefined {
  const raw = opts[flag];
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('必須是物件');
    return v as KnobValues;
  } catch (e) {
    return fail(`${flag} 不是合法的 JSON 物件：${(e as Error).message}`, 1);
  }
}

function load(path: string, knobs: KnobValues | undefined): Entry {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    return fail(`無法讀取選手檔案 ${path}：${(e as Error).message}`, 2);
  }
  const label = basename(path);
  try {
    const compiled = compileBot(source, label);
    // 先建一次實例：檢查 declare()、deploy()、decide() 與旋鈕值
    const probe = new LegionBatchController(compiled, label, MAPS['river-valley'](), 0, 0);
    resolveKnobs(probe.declaration, knobs, label);
    return { path, label, compiled, knobs };
  } catch (e) {
    if (e instanceof BotLoadError) return fail(`選手載入失敗：${e.message}`, 2);
    return fail(`選手載入失敗：${label}：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, 2);
  }
}

// ───────── 檢查模式 ─────────

function check(entry: Entry): void {
  const lines: string[] = [];
  let ok = true;
  const decl = new LegionBatchController(entry.compiled, entry.label, MAPS['river-valley'](), 0, 0).declaration;
  lines.push(`${entry.label}：載入成功（${entry.compiled.sizeBytes} bytes），name=${decl.name}、version=${decl.version ?? ''}、旋鈕 ${decl.knobs.length} 顆`);
  for (const mode of ['annihilation', 'capture'] as LegionMode[]) {
    const map = MAPS[defaultMapId(mode)]();
    for (const seat of [0, 1]) {
      const c = new LegionBatchController(entry.compiled, entry.label, map, seed0, seat);
      const knobs = resolveKnobs(c.declaration, entry.knobs, entry.label);
      const data = legionInitData(map, mode, seat, knobs, defaultTimeLimit(mode));
      const ini = c.init(data);
      const dep = ini.killed ? null : c.deploy(data);
      const raw = dep === null || dep.killed ? [] : dep.value;
      const m = new LegionMatch({ seed: seed0, mode, deployments: seat === 0 ? [raw, []] : [[], raw] });
      const mine = m.regiments.filter((r) => r.owner === seat);
      const field = mine.filter((r) => !r.reserve);
      const reserve = mine.filter((r) => r.reserve);
      const cost = (rs: typeof mine): number => rs.reduce((s, r) => s + r.def.cost, 0);
      const rejected = m.events.filter((e): e is Extract<LegionEvent, { type: 'deployRejected' }> => e.type === 'deployRejected' && e.player === seat);
      const seatName = seat === 0 ? '藍方' : '紅方';
      lines.push(
        `  ${MODE_NAMES[mode]}・${seatName}：init ${ini.elapsedMs.toFixed(1)} ms、deploy ${dep === null ? '未呼叫' : `${dep.elapsedMs.toFixed(1)} ms`}；場上 ${field.length} 團 ${cost(field)} 點` +
          (mode === 'capture' ? `、後備 ${reserve.length} 團 ${cost(reserve)} 點` : '') +
          `；被拒 ${rejected.length} 團`,
      );
      if (ini.exception !== null) lines.push(`    init 例外：${ini.exception}`);
      if (ini.killed) lines.push('    init 超過 1000 ms：整場閒置');
      if (dep !== null && dep.exception !== null) lines.push(`    deploy 例外：${dep.exception}`);
      if (dep !== null && dep.killed) lines.push('    deploy 超過 1000 ms：布陣作廢');
      for (const r of rejected) lines.push(`    第 ${r.index} 個：${r.reason}`);
      if (ini.killed || dep === null || dep.killed || dep.exception !== null || rejected.length > 0 || field.length === 0) ok = false;
    }
    // 自己打自己 30 秒：檢查 decide 有沒有例外、逾時、被拒絕的指令
    const ctrls = [0, 1].map((i) => new LegionBatchController(entry.compiled, entry.label, map, seed0, i));
    const knobs = ctrls.map((c) => resolveKnobs(c.declaration, entry.knobs, entry.label));
    const d = new LegionDriver({ seed: seed0, mode, controllers: ctrls, knobs, record: false });
    const rej = new Map<string, number>();
    d.match.eventTap = (e) => {
      if (e.type === 'rejected') rej.set(`${e.command}：${e.reason}`, (rej.get(`${e.command}：${e.reason}`) ?? 0) + 1);
    };
    while (!d.match.over && d.match.tick < 300) d.step();
    const rts = d.runtime;
    const maxMs = Math.max(...rts.map((r) => r.decideMsMax));
    const exc = rts.reduce((s, r) => s + r.exceptions, 0);
    const killed = rts.some((r) => r.killed);
    lines.push(`  ${MODE_NAMES[mode]}・自己打自己 30 秒：decide 最長 ${maxMs.toFixed(2)} ms、例外 ${exc} 次${killed ? '、有逾時（超過 50 ms）' : ''}、被拒絕的指令 ${[...rej.values()].reduce((s, n) => s + n, 0)} 個`);
    for (const r of rts) for (const e of r.errors) lines.push(`    ${e}`);
    for (const [k, n] of rej) lines.push(`    被拒：${k} ×${n}`);
    if (exc > 0 || killed) ok = false;
  }
  lines.push(ok ? '結果：通過' : '結果：有問題（見上方）');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(ok ? 0 : 2);
}

// ───────── 對戰 ─────────

function play(a: Entry, b: Entry, game: number, seed: number, mode: LegionMode, seatA: number): Game {
  const seats = seatA === 0 ? [a, b] : [b, a];
  const map = MAPS[defaultMapId(mode)]();
  const ctrls = seats.map((s, i) => new LegionBatchController(s.compiled, s.label, map, seed, i));
  const knobs = ctrls.map((c, i) => resolveKnobs(c.declaration, seats[i].knobs, c.label));
  const d = new LegionDriver({ seed, mode, controllers: ctrls, knobs, record: false });
  const m = d.match;
  const deployRejected = [0, 0];
  for (const e of m.events) if (e.type === 'deployRejected') deployRejected[e.player] += 1;
  const rejected = [0, 0];
  m.eventTap = (e) => {
    if (e.type === 'rejected') rejected[e.player] += 1;
  };
  while (!m.over) d.step();
  const r = m.result();
  const side = (p: number): Side => {
    const rt = d.runtime[p];
    return {
      killValue: r.killValue[p],
      score: r.score[p],
      strength: r.strength[p],
      decideMsAvg: rt.decisions > 0 ? rt.decideMsTotal / rt.decisions : 0,
      decideMsMax: rt.decideMsMax,
      exceptions: rt.exceptions,
      killed: rt.killed,
      deployRejected: deployRejected[p],
      rejected: rejected[p],
      errors: rt.errors,
    };
  };
  const pb = 1 - seatA;
  return {
    game,
    seed,
    seatA,
    outcome: r.winner === null ? 'draw' : r.winner === seatA ? 'win' : 'loss',
    reason: r.reason,
    seconds: r.durationTicks / 10,
    a: side(seatA),
    b: side(pb),
  };
}

const OUTCOME = { win: 'A 勝', loss: 'A 敗', draw: '平手' } as const;
const avg = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function gameLine(g: Game, mode: LegionMode): string {
  const score = mode === 'capture' ? `  分數 A ${g.a.score} / B ${g.b.score}` : '';
  const warn = [g.a.exceptions > 0 ? `A 例外 ${g.a.exceptions}` : '', g.b.exceptions > 0 ? `B 例外 ${g.b.exceptions}` : '', g.a.killed ? 'A 逾時' : '', g.b.killed ? 'B 逾時' : ''].filter((s) => s !== '').join('、');
  return `  #${String(g.game).padEnd(3)} 種子 ${String(g.seed).padEnd(5)} A=${g.seatA === 0 ? '藍' : '紅'}  ${OUTCOME[g.outcome]}  ${g.reason.padEnd(12)} ${g.seconds.toFixed(1).padStart(6)} 秒  戰果 A ${g.a.killValue} / B ${g.b.killValue}${score}${warn !== '' ? `  ⚠ ${warn}` : ''}`;
}

function summarize(gs: readonly Game[], mode: LegionMode): Record<string, unknown> {
  const w = gs.filter((g) => g.outcome === 'win').length;
  const l = gs.filter((g) => g.outcome === 'loss').length;
  const dr = gs.length - w - l;
  const reasons: Record<string, number> = {};
  for (const g of gs) reasons[g.reason] = (reasons[g.reason] ?? 0) + 1;
  const sideSum = (k: 'a' | 'b'): Record<string, unknown> => ({
    killValueAvg: avg(gs.map((g) => g[k].killValue)),
    ...(mode === 'capture' ? { scoreAvg: avg(gs.map((g) => g[k].score)) } : {}),
    decideMsAvg: avg(gs.map((g) => g[k].decideMsAvg)),
    decideMsMax: Math.max(...gs.map((g) => g[k].decideMsMax)),
    exceptions: gs.reduce((s, g) => s + g[k].exceptions, 0),
    timeouts: gs.filter((g) => g[k].killed).length,
    deployRejected: gs.reduce((s, g) => s + g[k].deployRejected, 0),
    rejected: gs.reduce((s, g) => s + g[k].rejected, 0),
  });
  return { games: gs.length, wins: w, losses: l, draws: dr, winRate: w / gs.length, points: (w + dr / 2) / gs.length, reasons, secondsAvg: avg(gs.map((g) => g.seconds)), a: sideSum('a'), b: sideSum('b') };
}

function printSummary(a: Entry, b: Entry, mode: LegionMode, gs: readonly Game[], s: Record<string, unknown>): void {
  const sa = s.a as Record<string, number>;
  const sb = s.b as Record<string, number>;
  const out: string[] = [];
  out.push(`  ── 小計：A 勝 ${s.wins}、敗 ${s.losses}、平 ${s.draws}（勝率 ${pct(s.winRate as number)}；平手算半場 ${pct(s.points as number)}）`);
  out.push(`     結束原因：${Object.entries(s.reasons as Record<string, number>).map(([k, n]) => `${k} ×${n}`).join('、')}；平均時間 ${(s.secondsAvg as number).toFixed(1)} 秒`);
  out.push(`     平均戰果：A ${sa.killValueAvg.toFixed(1)} / B ${sb.killValueAvg.toFixed(1)}` + (mode === 'capture' ? `；平均分數：A ${sa.scoreAvg.toFixed(1)} / B ${sb.scoreAvg.toFixed(1)}` : ''));
  for (const [k, e, x] of [['A', a, sa], ['B', b, sb]] as const) {
    out.push(`     ${k}（${e.label}）：decide 平均 ${x.decideMsAvg.toFixed(2)} ms、最長 ${x.decideMsMax.toFixed(2)} ms；例外 ${x.exceptions}、逾時 ${x.timeouts} 場、布陣被拒 ${x.deployRejected}、指令被拒 ${x.rejected}`);
  }
  const errs = new Set<string>();
  for (const g of gs) for (const [k, sd] of [['A', g.a], ['B', g.b]] as const) for (const e of sd.errors) errs.add(`${k}：${e}`);
  for (const e of [...errs].slice(0, 5)) out.push(`     ⚠ ${e}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

if (opts['--check'] !== undefined) {
  if (positional.length !== 1) usage();
  check(load(positional[0], parseKnobs('--knobs-a')));
}

if (positional.length !== 2) usage();
const A = load(positional[0], parseKnobs('--knobs-a'));
const B = load(positional[1], parseKnobs('--knobs-b'));
const json = opts['--json'] !== undefined;
const quiet = opts['--quiet'] !== undefined;
const report: Record<string, unknown>[] = [];
for (const mode of modes) {
  if (!json) process.stdout.write(`== ${MODE_NAMES[mode]}（${mode}）：A = ${A.label}、B = ${B.label}，${games} 場，種子 ${seed0} 起（同一個種子雙方交換起點）\n`);
  const gs: Game[] = [];
  for (let g = 0; g < games; g++) {
    const res = play(A, B, g + 1, seed0 + Math.floor(g / 2), mode, g % 2);
    gs.push(res);
    if (!json && !quiet) process.stdout.write(`${gameLine(res, mode)}\n`);
  }
  const s = summarize(gs, mode);
  if (json) report.push({ mode, a: A.label, b: B.label, summary: s, games: gs });
  else printSummary(A, B, mode, gs, s);
}
if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
