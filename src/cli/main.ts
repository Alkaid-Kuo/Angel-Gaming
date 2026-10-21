#!/usr/bin/env node
// rts-sim：headless 模擬器 CLI。子指令 match、mapgen、bench；輸出 JSON。
// 結束碼：0 成功、1 參數錯誤、2 選手載入失敗、3 引擎內部錯誤。
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnobValues } from '../api/types.ts';
import { MAP_MODES, MATCH_MODES, type MatchMode } from '../config/index.ts';
import { generateMap, renderAscii, MapGenError } from '../mapgen/index.ts';
import { BotLoadError } from '../sandbox/compile.ts';
import { BatchController, resolveKnobs, type BotController } from '../sandbox/controller.ts';
import { loadBotFile, type BotFile } from '../sandbox/node-loader.ts';
import { OfficialController } from '../sandbox/official.ts';
import { runMatch } from '../sandbox/runner.ts';
import { gameOutput, summarize, type BotInfo, type GameOutput } from './stats.ts';

class ArgError extends Error {}

type Args = Map<string, string[]>;

function parseArgs(argv: readonly string[]): { command: string; args: Args } {
  const command = argv[0];
  if (command === undefined || command.startsWith('--')) throw new ArgError('缺少子指令（match／mapgen／bench）');
  const args: Args = new Map();
  let key: string | null = null;
  for (const tok of argv.slice(1)) {
    if (tok.startsWith('--')) {
      key = tok.slice(2);
      if (args.has(key)) throw new ArgError(`參數重複：--${key}`);
      args.set(key, []);
    } else {
      if (key === null) throw new ArgError(`無法解析參數：${tok}`);
      args.get(key)!.push(tok);
    }
  }
  return { command, args };
}

function one(args: Args, key: string): string | undefined {
  const v = args.get(key);
  if (v === undefined) return undefined;
  if (v.length !== 1) throw new ArgError(`--${key} 需要一個值`);
  return v[0];
}

function intArg(args: Args, key: string, fallback: number | undefined, min: number): number | undefined {
  const s = one(args, key);
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) throw new ArgError(`--${key} 必須是 ≥ ${min} 的整數`);
  return n;
}

function modeArg(args: Args): MatchMode {
  const m = one(args, 'mode') ?? '1v1';
  if (!(MATCH_MODES as readonly string[]).includes(m)) throw new ArgError(`--mode 必須是 ${MATCH_MODES.join('／')}`);
  return m as MatchMode;
}

function execArg(args: Args, fallback: 'official' | 'batch'): 'official' | 'batch' {
  const e = one(args, 'exec') ?? fallback;
  if (e !== 'official' && e !== 'batch') throw new ArgError('--exec 必須是 official／batch');
  return e;
}

function knownArgs(args: Args, allowed: readonly string[]): void {
  for (const k of args.keys()) if (!allowed.includes(k)) throw new ArgError(`未知參數：--${k}`);
}

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('找不到專案根目錄');
    dir = parent;
  }
}

function emit(obj: unknown, out: string | undefined): void {
  const text = JSON.stringify(obj, null, 2);
  if (out === undefined) process.stdout.write(text + '\n');
  else {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, text + '\n');
  }
}

async function makeControllers(files: readonly BotFile[], exec: 'official' | 'batch'): Promise<BotController[]> {
  const out: BotController[] = [];
  try {
    for (const f of files) out.push(exec === 'batch' ? new BatchController(f.compiled, f.label) : await OfficialController.create(f));
  } catch (e) {
    for (const c of out) await c.dispose();
    throw e;
  }
  return out;
}

interface SeriesOptions {
  readonly mode: MatchMode;
  readonly files: readonly BotFile[];
  readonly games: number;
  readonly seed: number;
  readonly exec: 'official' | 'batch';
  readonly replayDir: string | undefined;
  readonly knobOverrides: readonly (KnobValues | undefined)[];
}

async function runSeries(o: SeriesOptions): Promise<{ games: GameOutput[]; bots: BotInfo[] }> {
  const games: GameOutput[] = [];
  let bots: BotInfo[] = [];
  for (let i = 0; i < o.games; i++) {
    const seed = o.seed + i;
    const controllers = await makeControllers(o.files, o.exec);
    try {
      bots = controllers.map((c, k) => ({ file: o.files[k].path, name: c.declaration.name, version: c.declaration.version ?? '' }));
      const knobs = controllers.map((c, k) => resolveKnobs(c.declaration, o.knobOverrides[k], c.label));
      const run = await runMatch({ mode: o.mode, seed, controllers, knobs, record: o.replayDir !== undefined });
      games.push(gameOutput(o.mode, seed, o.exec, run.map, run.slotOf, bots, knobs, run.result, run.runtime, run.wallMs, run.finalHash));
      if (o.replayDir !== undefined && run.replay !== null) {
        mkdirSync(o.replayDir, { recursive: true });
        writeFileSync(join(o.replayDir, `${o.mode}_${seed}.json`), JSON.stringify(run.replay));
      }
    } finally {
      for (const c of controllers) await c.dispose();
    }
  }
  return { games, bots };
}

async function cmdMatch(args: Args): Promise<void> {
  knownArgs(args, ['mode', 'bots', 'games', 'seed', 'exec', 'replay-dir', 'out']);
  const mode = modeArg(args);
  const botPaths = args.get('bots') ?? [];
  const need = MAP_MODES[mode].players;
  if (botPaths.length !== need) throw new ArgError(`${mode} 需要 --bots 指定 ${need} 個選手檔案`);
  const games = intArg(args, 'games', 1, 1)!;
  const seed = intArg(args, 'seed', randomInt(0, 2 ** 31), 0)!;
  const exec = execArg(args, 'official');
  const files = botPaths.map((p) => loadBotFile(p));
  const { games: out, bots } = await runSeries({ mode, files, games, seed, exec, replayDir: one(args, 'replay-dir'), knobOverrides: files.map(() => undefined) });
  emit({ seed, mode, exec, summary: summarize(mode, bots, out), games: out }, one(args, 'out'));
}

function cmdMapgen(args: Args): void {
  knownArgs(args, ['mode', 'seed', 'format', 'validate', 'out']);
  const mode = modeArg(args);
  const seed = intArg(args, 'seed', randomInt(0, 2 ** 31), 0)!;
  const format = one(args, 'format') ?? 'ascii';
  if (format !== 'ascii') throw new ArgError('--format 目前只支援 ascii（png 於 M1 加入）');
  const validate = intArg(args, 'validate', undefined, 1);
  if (validate === undefined) {
    const map = generateMap(mode, seed);
    const text = `${renderAscii(map)}\n`;
    const out = one(args, 'out');
    if (out === undefined) process.stdout.write(`# mode=${mode} seed=${seed} attempt=${map.attempt}\n${text}`);
    else writeFileSync(out, text);
    return;
  }
  const attempts: Record<string, number> = {};
  const failures: { seed: number; error: string }[] = [];
  for (let s = seed; s < seed + validate; s++) {
    try {
      const m = generateMap(mode, s);
      attempts[m.attempt] = (attempts[m.attempt] ?? 0) + 1;
    } catch (e) {
      if (!(e instanceof MapGenError)) throw e;
      failures.push({ seed: s, error: e.message });
    }
  }
  emit({ mode, seedFrom: seed, count: validate, passed: validate - failures.length, attemptDistribution: attempts, failures }, one(args, 'out'));
}

async function cmdBench(args: Args): Promise<void> {
  knownArgs(args, ['mode', 'games', 'exec', 'seed', 'bot', 'out']);
  const mode = modeArg(args);
  const games = intArg(args, 'games', mode === '1v1' ? 20 : 10, 1)!;
  const exec = execArg(args, 'batch');
  const seed = intArg(args, 'seed', 1, 0)!;
  const botPath = one(args, 'bot') ?? join(packageRoot(), 'bots', 'baseline.js');
  const file = loadBotFile(botPath);
  const files = Array.from({ length: MAP_MODES[mode].players }, () => file);
  const t0 = performance.now();
  const { games: out } = await runSeries({ mode, files, games, seed, exec, replayDir: undefined, knobOverrides: files.map(() => undefined) });
  const wallMs = performance.now() - t0;
  const ticks = out.reduce((a, g) => a + g.durationTicks, 0);
  emit({
    mode,
    exec,
    bot: botPath,
    games,
    seedFrom: seed,
    totalWallMs: Math.round(wallMs),
    gamesPerSec: Math.round((games / (wallMs / 1000)) * 100) / 100,
    ticksPerSec: Math.round(ticks / (wallMs / 1000)),
    avgDurationTicks: Math.round(ticks / games),
    avgGameWallMs: Math.round(wallMs / games),
    endedBeforeTimeLimit: out.filter((g) => g.players.some((p) => p.eliminatedTick !== null)).length,
  }, one(args, 'out'));
}

const USAGE = `用法：
  rts-sim match  --mode 1v1|ffa4 --bots a.js b.js [c.js d.js] [--games N] [--seed S] [--exec official|batch] [--replay-dir D] [--out F]
  rts-sim mapgen --mode 1v1|ffa4 [--seed S] [--format ascii] [--validate N] [--out F]
  rts-sim bench  --mode 1v1|ffa4 [--games N] [--exec batch|official] [--seed S] [--bot F] [--out F]`;

async function main(): Promise<number> {
  let parsed: { command: string; args: Args };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    return 1;
  }
  try {
    switch (parsed.command) {
      case 'match':
        await cmdMatch(parsed.args);
        return 0;
      case 'mapgen':
        cmdMapgen(parsed.args);
        return 0;
      case 'bench':
        await cmdBench(parsed.args);
        return 0;
      default:
        throw new ArgError(`未知子指令：${parsed.command}`);
    }
  } catch (e) {
    if (e instanceof ArgError) {
      process.stderr.write(`${e.message}\n${USAGE}\n`);
      return 1;
    }
    if (e instanceof BotLoadError) {
      process.stderr.write(`選手載入失敗：${e.message}\n`);
      return 2;
    }
    process.stderr.write(`引擎內部錯誤：${(e as Error).stack ?? String(e)}\n`);
    return 3;
  }
}

process.exitCode = await main();
