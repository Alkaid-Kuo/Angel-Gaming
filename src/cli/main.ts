#!/usr/bin/env node
// rts-sim：headless 模擬器 CLI。子指令 match、roundrobin、mapgen、bench、viewer、shooter（CS 射擊）；輸出 JSON。
// 結束碼：0 成功、1 參數錯誤、2 選手載入失敗、3 引擎內部錯誤。
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnobValues } from '../api/types.ts';
import { MAP_MODES, MATCH_MODES, RULESETS, type MatchMode, type Ruleset } from '../config/index.ts';
import { generateMap, renderAscii, MapGenError } from '../mapgen/index.ts';
import { BotLoadError } from '../sandbox/compile.ts';
import { BatchController, resolveKnobs, type BotController } from '../sandbox/controller.ts';
import { loadBotFile, type BotFile } from '../sandbox/node-loader.ts';
import { OfficialController } from '../sandbox/official.ts';
import { runMatch } from '../sandbox/runner.ts';
import { TPS as SHOOTER_TPS, WEAPONS, WEAPON_IDS, type Team, type WeaponId } from '../shooter/config.ts';
import { DEFAULT_MAP_ID, MAPS as SHOOTER_MAPS, cellOf as shooterCellOf, dumpAscii, inRect as shooterInRect } from '../shooter/map.ts';
import { ShooterBatchController, ShooterDriver, runShooterMatch, runShooterReplay, type ShooterReplay, type ShooterRunOutput } from '../shooter/runner.ts';
import { PLAYER_COUNT, type ShooterMatch } from '../shooter/sim.ts';
import { renderPng } from './png.ts';
import { eloFromWins, gameOutput, summarize, type BotInfo, type GameOutput } from './stats.ts';

class ArgError extends Error {}

type Args = Map<string, string[]>;

function parseArgs(argv: readonly string[]): { command: string; args: Args } {
  const command = argv[0];
  if (command === undefined || command.startsWith('--')) throw new ArgError('缺少子指令（match／roundrobin／mapgen／bench／viewer）');
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

function flag(args: Args, key: string): boolean {
  const v = args.get(key);
  if (v === undefined) return false;
  if (v.length !== 0) throw new ArgError(`--${key} 不需要值`);
  return true;
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

function rulesetArg(args: Args): Ruleset {
  const r = one(args, 'ruleset') ?? 'classic';
  if (!(RULESETS as readonly string[]).includes(r)) throw new ArgError(`--ruleset 必須是 ${RULESETS.join('／')}`);
  return r as Ruleset;
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

interface Roster {
  readonly mode: MatchMode;
  readonly exec: 'official' | 'batch';
  /** 依 --bots 順序 */
  readonly files: readonly BotFile[];
  readonly infos: readonly BotInfo[];
  readonly knobs: readonly KnobValues[];
  readonly replayDir: string | undefined;
  readonly ruleset: Ruleset;
}

/** 一場比賽：seats[playerId] = 選手在 --bots 中的索引 */
interface GamePlan {
  readonly seed: number;
  readonly seats: readonly number[];
}

/** --knobs：JSON 陣列（依 --bots 順序，null 表示預設），或 @檔案路徑 */
function parseKnobs(arg: string | undefined, n: number): (KnobValues | undefined)[] {
  if (arg === undefined) return new Array<undefined>(n).fill(undefined);
  const text = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ArgError('--knobs 必須是 JSON 陣列，例如 [{"attackThreshold":8},null]');
  }
  if (!Array.isArray(data) || data.length !== n) throw new ArgError(`--knobs 陣列長度必須等於選手數 ${n}`);
  return data.map((v: unknown) => {
    if (v === null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) throw new ArgError('--knobs 每一項必須是物件或 null');
    return v as KnobValues;
  });
}

/** 載入選手、讀取宣告並解析旋鈕（旋鈕不合法視為選手載入錯誤） */
function loadRoster(mode: MatchMode, exec: 'official' | 'batch', paths: readonly string[], knobArg: string | undefined, replayDir: string | undefined, ruleset: Ruleset): Roster {
  const files = paths.map((p) => loadBotFile(p));
  const overrides = parseKnobs(knobArg, files.length);
  const infos: BotInfo[] = [];
  const knobs: KnobValues[] = [];
  files.forEach((f, index) => {
    const c = new BatchController(f.compiled, f.label);
    infos.push({ index, file: f.path, name: c.declaration.name, version: c.declaration.version ?? '' });
    knobs.push(resolveKnobs(c.declaration, overrides[index], f.label));
  });
  return { mode, exec, files, infos, knobs, replayDir, ruleset };
}

async function playGame(r: Roster, plan: GamePlan): Promise<GameOutput> {
  const controllers = await makeControllers(plan.seats.map((b) => r.files[b]), r.exec);
  try {
    const knobs = plan.seats.map((b) => r.knobs[b]);
    const run = await runMatch({ mode: r.mode, seed: plan.seed, controllers, knobs, record: r.replayDir !== undefined, ruleset: r.ruleset });
    if (r.replayDir !== undefined && run.replay !== null) {
      mkdirSync(r.replayDir, { recursive: true });
      writeFileSync(join(r.replayDir, `${r.mode}_${plan.seed}_${plan.seats.join('-')}.json`), JSON.stringify(run.replay));
    }
    return gameOutput(r.mode, plan.seed, r.exec, run.map, run.slotOf, plan.seats.map((b) => r.infos[b]), knobs, run.result, run.runtime, run.wallMs, run.finalHash);
  } finally {
    for (const c of controllers) await c.dispose();
  }
}

async function playAll(r: Roster, plans: readonly GamePlan[]): Promise<GameOutput[]> {
  const out: GameOutput[] = [];
  for (const plan of plans) out.push(await playGame(r, plan));
  return out;
}

async function cmdMatch(args: Args): Promise<void> {
  knownArgs(args, ['mode', 'bots', 'games', 'seed', 'exec', 'swap', 'knobs', 'replay-dir', 'out', 'ruleset']);
  const mode = modeArg(args);
  const botPaths = args.get('bots') ?? [];
  const need = MAP_MODES[mode].players;
  if (botPaths.length !== need) throw new ArgError(`${mode} 需要 --bots 指定 ${need} 個選手檔案`);
  const games = intArg(args, 'games', 1, 1)!;
  const seed = intArg(args, 'seed', randomInt(0, 2 ** 31), 0)!;
  const exec = execArg(args, 'official');
  const swap = flag(args, 'swap');
  if (swap && mode !== '1v1') throw new ArgError('--swap 只適用於 1v1');
  if (swap && games % 2 !== 0) throw new ArgError('--swap 時 --games 必須是偶數（每個 seed 打兩場並交換起點）');
  const roster = loadRoster(mode, exec, botPaths, one(args, 'knobs'), one(args, 'replay-dir'), rulesetArg(args));
  const seats = botPaths.map((_, i) => i);
  const plans: GamePlan[] = [];
  if (swap) {
    for (let i = 0; i < games / 2; i++) {
      plans.push({ seed: seed + i, seats });
      plans.push({ seed: seed + i, seats: [...seats].reverse() });
    }
  } else {
    for (let i = 0; i < games; i++) plans.push({ seed: seed + i, seats });
  }
  const out = await playAll(roster, plans);
  emit({ seed, mode, ruleset: roster.ruleset, exec, swap, summary: summarize(mode, roster.infos, out), games: out }, one(args, 'out'));
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

/** 循環賽：1v1 每組選手打 --games 場（同 seed 交換起點各一場）；4 人局為所有 4 人組合各打 --games 場 */
async function cmdRoundrobin(args: Args): Promise<void> {
  knownArgs(args, ['mode', 'bots', 'games', 'seed', 'exec', 'knobs', 'replay-dir', 'out', 'ruleset']);
  const mode = modeArg(args);
  const botPaths = args.get('bots') ?? [];
  const players = MAP_MODES[mode].players;
  if (botPaths.length < players) throw new ArgError(`${mode} 循環賽至少需要 ${players} 個選手檔案`);
  const games = intArg(args, 'games', mode === '1v1' ? 10 : 4, 1)!;
  if (mode === '1v1' && games % 2 !== 0) throw new ArgError('1v1 循環賽的 --games 必須是偶數（同 seed 交換起點）');
  const seed = intArg(args, 'seed', randomInt(0, 2 ** 31), 0)!;
  const exec = execArg(args, 'official');
  const roster = loadRoster(mode, exec, botPaths, one(args, 'knobs'), one(args, 'replay-dir'), rulesetArg(args));
  const n = botPaths.length;
  const plans: GamePlan[] = [];
  if (mode === '1v1') {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = 0; k < games / 2; k++) {
          plans.push({ seed: seed + k, seats: [i, j] });
          plans.push({ seed: seed + k, seats: [j, i] });
        }
      }
    }
  } else {
    for (const group of combinations(n, players)) {
      for (let k = 0; k < games; k++) plans.push({ seed: seed + k, seats: group.map((_, x) => group[(x + k) % group.length]) });
    }
  }
  const out = await playAll(roster, plans);
  // 兩兩勝負：同場名次較前者勝
  const wins = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const g of out) {
    for (const a of g.players) for (const b of g.players) if (a.rank < b.rank) wins[a.botIndex][b.botIndex] += 1;
  }
  const elo = eloFromWins(wins);
  const winRateMatrix = wins.map((row, i) => row.map((w, j) => (i === j || w + wins[j][i] === 0 ? null : Math.round((w * 1000) / (w + wins[j][i])) / 10)));
  const ranking = roster.infos
    .map((b, i) => ({ bot: b.name, version: b.version, file: b.file, elo: elo[i], wins: wins[i].reduce((a, v) => a + v, 0), losses: wins.reduce((a, row) => a + row[i], 0) }))
    .sort((a, b) => b.elo - a.elo);
  emit(
    {
      mode,
      exec,
      seed,
      gamesPerPairing: games,
      bots: roster.infos.map((b) => ({ bot: b.name, version: b.version, file: b.file })),
      winRateMatrix,
      elo: ranking,
      summary: summarize(mode, roster.infos, out),
      games: out.map((g) => ({ seed: g.seed, durationTicks: g.durationTicks, finalHash: g.finalHash, players: g.players.map((p) => ({ botIndex: p.botIndex, bot: p.bot, playerId: p.playerId, rank: p.rank, score: p.score })) })),
    },
    one(args, 'out'),
  );
}

function cmdMapgen(args: Args): void {
  knownArgs(args, ['mode', 'seed', 'format', 'validate', 'out']);
  const mode = modeArg(args);
  const seed = intArg(args, 'seed', randomInt(0, 2 ** 31), 0)!;
  const format = one(args, 'format') ?? 'ascii';
  if (format !== 'ascii' && format !== 'png') throw new ArgError('--format 必須是 ascii／png');
  const validate = intArg(args, 'validate', undefined, 1);
  if (validate === undefined) {
    const map = generateMap(mode, seed);
    const out = one(args, 'out');
    if (format === 'png') {
      const file = out ?? `map_${mode}_${seed}.png`;
      writeFileSync(file, renderPng(map));
      process.stdout.write(`${JSON.stringify({ mode, seed, attempt: map.attempt, file })}\n`);
      return;
    }
    const text = `${renderAscii(map)}\n`;
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
  knownArgs(args, ['mode', 'games', 'exec', 'seed', 'bot', 'out', 'ruleset']);
  const mode = modeArg(args);
  const games = intArg(args, 'games', mode === '1v1' ? 20 : 10, 1)!;
  const exec = execArg(args, 'batch');
  const seed = intArg(args, 'seed', 1, 0)!;
  const botPath = one(args, 'bot') ?? join(packageRoot(), 'bots', 'baseline.js');
  const roster = loadRoster(mode, exec, [botPath], undefined, undefined, rulesetArg(args));
  const seats = Array.from({ length: MAP_MODES[mode].players }, () => 0);
  const plans = Array.from({ length: games }, (_, i) => ({ seed: seed + i, seats }));
  const t0 = performance.now();
  const out = await playAll(roster, plans);
  const wallMs = performance.now() - t0;
  const ticks = out.reduce((a, g) => a + g.durationTicks, 0);
  emit(
    {
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
    },
    one(args, 'out'),
  );
}

// ───────── CS 射擊 ─────────

function shooterBotFiles(args: Args): BotFile[] {
  const paths = args.get('bots') ?? [join(packageRoot(), 'bots', 'shooter-practice.js')];
  if (paths.length < 1 || paths.length > 2) throw new ArgError('shooter 的 --bots 要 1 或 2 個選手檔案（第一個是玩家 0～4、第二個是玩家 5～9）');
  return paths.map((p) => loadBotFile(p));
}

function shooterMapArg(args: Args): string {
  const id = one(args, 'map') ?? one(args, 'id') ?? DEFAULT_MAP_ID;
  if (SHOOTER_MAPS[id] === undefined) throw new ArgError(`未知地圖：${id}（可用：${Object.keys(SHOOTER_MAPS).join('／')}）`);
  return id;
}

/** --loadout ak,m4：T、CT 的開局主武器（測試用）；只給一個就兩邊相同 */
function shooterLoadoutArg(args: Args): Partial<Record<Team, WeaponId>> | undefined {
  const s = one(args, 'loadout');
  if (s === undefined) return undefined;
  const parts = s.split(',');
  if (parts.length > 2) throw new ArgError('--loadout 格式為 T主武器,CT主武器（例如 ak,m4）');
  for (const w of parts) {
    if (!(WEAPON_IDS as readonly string[]).includes(w) || WEAPONS[w as WeaponId].slot !== 'primary') throw new ArgError(`--loadout：${w} 不是主武器`);
  }
  return { T: parts[0] as WeaponId, CT: (parts[1] ?? parts[0]) as WeaponId };
}

/** --round-money 16000,800：玩家 0～4、5～9 每回合開局強制設定的金錢（測試 eco 對全買用）；- 表示照常結算 */
function shooterRoundMoneyArg(args: Args): readonly [number | null, number | null] | undefined {
  const s = one(args, 'round-money');
  if (s === undefined) return undefined;
  const parts = s.split(',');
  if (parts.length !== 2) throw new ArgError('--round-money 格式為 玩家0～4金錢,玩家5～9金錢（例如 16000,800；- 表示照常結算）');
  const parse = (v: string): number | null => {
    if (v === '-') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new ArgError(`--round-money：${v} 不是非負整數`);
    return n;
  };
  return [parse(parts[0]), parse(parts[1])];
}

interface ShooterPlayOptions {
  readonly loadout?: Partial<Record<Team, WeaponId>>;
  readonly roundMoney?: readonly [number | null, number | null];
}

function playShooter(files: readonly BotFile[], seed: number, mapId: string, opts: ShooterPlayOptions, record: boolean, probe?: (m: ShooterMatch) => void): ShooterRunOutput {
  const map = SHOOTER_MAPS[mapId]();
  const pick = (pid: number): BotFile => files[pid < PLAYER_COUNT / 2 ? 0 : files.length - 1];
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(pick(pid).compiled, pick(pid).label, seed, pid, map));
  const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const runOpts = { seed, mapId, defaultLoadout: opts.loadout, roundMoney: opts.roundMoney, controllers, knobs, record };
  if (probe === undefined) return runShooterMatch(runOpts);
  const t0 = performance.now();
  const d = new ShooterDriver(runOpts);
  while (!d.match.over) {
    d.step();
    probe(d.match);
  }
  return { result: d.match.result(), replay: d.replay, runtime: d.runtime, finalHash: d.match.hash(), wallMs: performance.now() - t0, match: d.match };
}

/** 炸彈點到達時間：每回合從開打到第一個 T 踏進 A／B 點的秒數（v1.0，量走位與碰撞的影響） */
function siteArrivalProbe(): { probe: (m: ShooterMatch) => void; summary: () => Record<string, unknown> } {
  const sum = { A: 0, B: 0 };
  const hits = { A: 0, B: 0 };
  let liveRounds = 0;
  let round = -1;
  let seen = { A: false, B: false };
  return {
    probe: (m) => {
      if (m.phase === 'freeze') return;
      if (m.roundNumber !== round) {
        round = m.roundNumber;
        seen = { A: false, B: false };
        liveRounds += 1;
      }
      if (m.phase !== 'live' && m.phase !== 'planted') return;
      for (const site of m.map.sites) {
        if (seen[site.id]) continue;
        if (m.players.some((p) => p.alive && p.team === 'T' && shooterInRect(site, shooterCellOf(p.x), shooterCellOf(p.y)))) {
          seen[site.id] = true;
          hits[site.id] += 1;
          sum[site.id] += m.tick - m.liveStartTick;
        }
      }
    },
    summary: () =>
      Object.fromEntries(
        (['A', 'B'] as const).map((k) => [k, { reachedRate: liveRounds === 0 ? 0 : Math.round((hits[k] / liveRounds) * 1000) / 1000, avgSec: hits[k] === 0 ? null : Math.round((sum[k] / hits[k] / SHOOTER_TPS) * 10) / 10 }]),
      ),
  };
}

function shooterSummary(run: ShooterRunOutput): Record<string, unknown> {
  const r = run.result;
  return {
    winner: r.winner === null ? 'draw' : r.winner === 0 ? 'players0-4' : 'players5-9',
    score: r.score,
    rounds: r.rounds.length,
    overtimes: r.overtimes,
    ticks: r.ticks,
    wallMs: Math.round(run.wallMs),
    finalHash: run.finalHash,
    roundLog: r.rounds.map((x) => `${x.number}:${x.winner}:${x.reason}`),
    players: r.stats.map((s, pid) => {
      const rt = run.runtime[pid];
      return { playerId: pid, kills: s.kills, deaths: s.deaths, exceptions: rt.exceptions, timeouts: rt.timeouts, decideMsMax: Math.round(rt.decideMsMax * 100) / 100, errors: rt.errors };
    }),
  };
}

function cmdShooterMatch(args: Args): void {
  knownArgs(args, ['seed', 'bots', 'map', 'replay', 'loadout', 'round-money', 'out']);
  const seed = intArg(args, 'seed', randomInt(0, 2 ** 31), 0)!;
  const files = shooterBotFiles(args);
  const mapId = shooterMapArg(args);
  const replayPath = one(args, 'replay');
  const run = playShooter(files, seed, mapId, { loadout: shooterLoadoutArg(args), roundMoney: shooterRoundMoneyArg(args) }, replayPath !== undefined);
  if (replayPath !== undefined && run.replay !== null) {
    mkdirSync(dirname(resolve(replayPath)), { recursive: true });
    writeFileSync(replayPath, JSON.stringify(run.replay));
  }
  emit({ seed, map: mapId, bots: files.map((f) => f.path), ...shooterSummary(run) }, one(args, 'out'));
}

function cmdShooterBatch(args: Args): void {
  knownArgs(args, ['games', 'seed', 'bots', 'map', 'loadout', 'round-money', 'out']);
  const games = intArg(args, 'games', 10, 1)!;
  const seed = intArg(args, 'seed', 1, 0)!;
  const files = shooterBotFiles(args);
  const mapId = shooterMapArg(args);
  const opts: ShooterPlayOptions = { loadout: shooterLoadoutArg(args), roundMoney: shooterRoundMoneyArg(args) };
  const wins = [0, 0];
  const groupRoundWins = [0, 0];
  // 經濟統計：依陣營與依組別的回合開局平均金錢總和、全買回合數
  const econ = { T: { money: 0, fullBuy: 0 }, CT: { money: 0, fullBuy: 0 }, g0: { money: 0, fullBuy: 0 }, g1: { money: 0, fullBuy: 0 } };
  // 道具統計：依陣營與依組別的投擲數、閃光讓敵人／自己隊致盲的 tick 數
  type NadeStat = { throws: number; flashEnemyTicks: number; flashTeamTicks: number };
  const nade = (): NadeStat => ({ throws: 0, flashEnemyTicks: 0, flashTeamTicks: 0 });
  const nades = { T: nade(), CT: nade(), g0: nade(), g1: nade() };
  let draws = 0;
  let overtimeGames = 0;
  const arrival = siteArrivalProbe();
  const roundWins: Record<Team, number> = { T: 0, CT: 0 };
  const reasons: Record<string, number> = {};
  let rounds = 0;
  let ticks = 0;
  let wall = 0;
  let maxWall = 0;
  const list: Record<string, unknown>[] = [];
  for (let i = 0; i < games; i++) {
    const run = playShooter(files, seed + i, mapId, opts, false, arrival.probe);
    const r = run.result;
    if (r.winner === null) draws += 1;
    else wins[r.winner] += 1;
    if (r.overtimes > 0) overtimeGames += 1;
    for (const x of r.rounds) {
      roundWins[x.winner] += 1;
      groupRoundWins[x.winnerGroup] += 1;
      for (const g of [0, 1] as const) {
        const side = x.tGroup === g ? econ.T : econ.CT;
        const grp = g === 0 ? econ.g0 : econ.g1;
        for (const e of [side, grp]) {
          e.money += x.money[g];
          if (x.fullBuy[g]) e.fullBuy += 1;
        }
        for (const e of [x.tGroup === g ? nades.T : nades.CT, g === 0 ? nades.g0 : nades.g1]) {
          e.throws += x.throws[g];
          e.flashEnemyTicks += x.flashEnemyTicks[g];
          e.flashTeamTicks += x.flashTeamTicks[g];
        }
      }
      const key = `${x.winner}:${x.reason}`;
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    rounds += r.rounds.length;
    ticks += r.ticks;
    wall += run.wallMs;
    if (run.wallMs > maxWall) maxWall = run.wallMs;
    list.push({ seed: seed + i, score: r.score, rounds: r.rounds.length, overtimes: r.overtimes, ticks: r.ticks, wallMs: Math.round(run.wallMs), finalHash: run.finalHash });
  }
  emit(
    {
      games,
      seedFrom: seed,
      map: mapId,
      bots: files.map((f) => f.path),
      matchWins: { 'players0-4': wins[0], 'players5-9': wins[1], draws },
      overtimeGames,
      roundWins,
      groupRoundWins: { 'players0-4': groupRoundWins[0], 'players5-9': groupRoundWins[1] },
      economy: Object.fromEntries(
        (Object.entries({ T: econ.T, CT: econ.CT, 'players0-4': econ.g0, 'players5-9': econ.g1 }) as [string, { money: number; fullBuy: number }][]).map(([k, e]) => [
          k,
          { avgRoundStartMoney: rounds === 0 ? 0 : Math.round(e.money / rounds), fullBuyRate: rounds === 0 ? 0 : Math.round((e.fullBuy / rounds) * 1000) / 1000 },
        ]),
      ),
      grenades: Object.fromEntries(
        (Object.entries({ T: nades.T, CT: nades.CT, 'players0-4': nades.g0, 'players5-9': nades.g1 }) as [string, NadeStat][]).map(([k, e]) => [
          k,
          { avgThrowsPerRound: rounds === 0 ? 0 : Math.round((e.throws / rounds) * 100) / 100, flashEnemyBlindSec: Math.round((e.flashEnemyTicks / SHOOTER_TPS) * 10) / 10, flashTeamBlindSec: Math.round((e.flashTeamTicks / SHOOTER_TPS) * 10) / 10 },
        ]),
      ),
      roundReasons: reasons,
      siteArrival: arrival.summary(),
      avgRounds: Math.round((rounds / games) * 10) / 10,
      avgTicks: Math.round(ticks / games),
      avgGameWallMs: Math.round(wall / games),
      maxGameWallMs: Math.round(maxWall),
      list,
    },
    one(args, 'out'),
  );
}

function cmdShooterReplay(file: string | undefined, args: Args): void {
  knownArgs(args, ['out']);
  if (file === undefined) throw new ArgError('shooter replay 需要回放檔路徑');
  let replay: ShooterReplay;
  try {
    replay = JSON.parse(readFileSync(file, 'utf8')) as ShooterReplay;
  } catch (e) {
    throw new ArgError(`無法讀取回放 ${file}：${(e as Error).message}`);
  }
  if (replay.kind !== 'shooter') throw new ArgError(`${file} 不是射擊回放`);
  const t0 = performance.now();
  const r = runShooterReplay(replay);
  const expected = replay.result?.finalHash ?? null;
  const ok = r.desyncTick === null && (expected === null || expected === r.finalHash);
  emit({ file, ok, desyncTick: r.desyncTick, finalHash: r.finalHash, expectedFinalHash: expected, score: r.result.score, rounds: r.result.rounds.length, wallMs: Math.round(performance.now() - t0) }, one(args, 'out'));
  if (!ok) throw new Error('回放不同步');
}

function cmdShooterMap(args: Args): void {
  knownArgs(args, ['id', 'map', 'out']);
  const text = `${dumpAscii(SHOOTER_MAPS[shooterMapArg(args)]())}\n`;
  const out = one(args, 'out');
  if (out === undefined) process.stdout.write(text);
  else writeFileSync(out, text);
}

/** shooter 子指令：match／batch／replay file.json／map */
function cmdShooter(argv: readonly string[]): void {
  const sub = argv[0];
  let rest = argv.slice(1);
  let file: string | undefined;
  if (sub === 'replay' && rest.length > 0 && !rest[0].startsWith('--')) {
    file = rest[0];
    rest = rest.slice(1);
  }
  const { args } = parseArgs(['shooter', ...rest]);
  switch (sub) {
    case 'match':
      cmdShooterMatch(args);
      return;
    case 'batch':
      cmdShooterBatch(args);
      return;
    case 'replay':
      cmdShooterReplay(file, args);
      return;
    case 'map':
      cmdShooterMap(args);
      return;
    default:
      throw new ArgError(`shooter 的子指令必須是 match／batch／replay／map，收到 ${sub ?? '（無）'}`);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** 本機的區網 IPv4 位址（--host 0.0.0.0 時顯示給手機或其他電腦連線用） */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

/**
 * 以 HTTP 伺服器開啟瀏覽器版（瀏覽器的 Worker 不能從 file:// 載入）；只提供建置好的靜態檔案。
 * 預設只綁 127.0.0.1；--host 0.0.0.0 開放給同一個區網的裝置（第一次執行時 Windows 防火牆會詢問）。
 */
function cmdViewer(args: Args): Promise<void> {
  knownArgs(args, ['port', 'dir', 'host']);
  const port = intArg(args, 'port', 8000, 1)!;
  const host = one(args, 'host') ?? '127.0.0.1';
  const root = resolve(one(args, 'dir') ?? [join(packageRoot(), 'viewer'), join(packageRoot(), 'dist-web')].find((d) => existsSync(d)) ?? join(packageRoot(), 'viewer'));
  if (!existsSync(join(root, 'web', 'index.html'))) throw new ArgError(`找不到瀏覽器版（${root}${sep}web${sep}index.html）；原始碼版請先執行 npm run build:web`);
  return new Promise((done) => {
    const server = createServer((req, res) => {
      let url: string;
      try {
        url = decodeURIComponent((req.url ?? '/').split('?')[0]);
      } catch {
        res.writeHead(400).end('Bad request');
        return;
      }
      const path = normalize(join(root, url === '/' ? 'web/index.html' : url));
      // 只允許 root 以內的檔案（root + 分隔符，避免同名前綴的兄弟資料夾）
      if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(readFileSync(path));
    });
    server.listen(port, host, () => {
      const hosts = host === '0.0.0.0' ? ['127.0.0.1', ...lanAddresses()] : [host];
      process.stdout.write(`瀏覽器版（Ctrl+C 結束）：\n${hosts.map((h) => `  http://${h}:${port}/web/index.html`).join('\n')}\n`);
    });
    server.on('close', () => done());
  });
}

const USAGE = `用法：
  rts-sim match      --mode 1v1|ffa4 --bots a.js b.js [c.js d.js] [--games N] [--seed S] [--swap] [--knobs JSON|@檔案] [--ruleset classic|conquest]
                     [--exec official|batch] [--replay-dir D] [--out F]
  rts-sim roundrobin --mode 1v1|ffa4 --bots a.js b.js ... [--games 每組場數] [--seed S] [--knobs JSON|@檔案] [--exec official|batch] [--out F]
  rts-sim mapgen     --mode 1v1|ffa4 [--seed S] [--format ascii|png] [--validate N] [--out F]
  rts-sim bench      --mode 1v1|ffa4 [--games N] [--exec batch|official] [--seed S] [--bot F] [--out F]
  rts-sim viewer     [--port 8000] [--host 127.0.0.1|0.0.0.0] [--dir D]
  rts-sim shooter match  [--seed N] [--bots a.js [b.js]] [--map dust] [--replay out.json] [--loadout ak,m4] [--round-money 16000,800] [--out F]
  rts-sim shooter batch  [--games N] [--seed S] [--bots a.js [b.js]] [--map dust] [--loadout ak,m4] [--round-money 16000,800] [--out F]
  rts-sim shooter replay file.json
  rts-sim shooter map    [--id dust]`;

async function main(): Promise<number> {
  let parsed: { command: string; args: Args };
  const argv = process.argv.slice(2);
  try {
    // shooter 有自己的子指令（replay 還有位置參數），參數交給 cmdShooter 解析
    parsed = argv[0] === 'shooter' ? { command: 'shooter', args: new Map() } : parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    return 1;
  }
  try {
    switch (parsed.command) {
      case 'match':
        await cmdMatch(parsed.args);
        return 0;
      case 'roundrobin':
        await cmdRoundrobin(parsed.args);
        return 0;
      case 'mapgen':
        cmdMapgen(parsed.args);
        return 0;
      case 'bench':
        await cmdBench(parsed.args);
        return 0;
      case 'viewer':
        await cmdViewer(parsed.args);
        return 0;
      case 'shooter':
        cmdShooter(argv.slice(1));
        return 0;
      case 'help':
      case '--help':
        process.stdout.write(`${USAGE}\n`);
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
