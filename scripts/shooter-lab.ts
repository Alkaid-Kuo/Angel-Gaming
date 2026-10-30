// CS 射擊離線互打實驗台（步驟 7；給 shooter-gradient.ts 與 shooter-strength.ts 用）：兩隊各 5 人（選手檔＋屬性包＋旋鈕），
// 每個種子雙邊各一場，worker 平行跑，整場確定性。結果依「選手檔內容＋對局」快取在 out/shooter-lab/cache.jsonl，重跑同一批對局不必再打。
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { KnobValues } from '../src/api/types.ts';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import type { Attributes } from '../src/shooter/api.ts';
import { ATTRIBUTE_KEYS, TEAM_SIZE, type AttributeKey } from '../src/shooter/config.ts';
import { MAPS } from '../src/shooter/map.ts';
import { derivePlayer, type ShooterPlayerSpec } from '../src/shooter/players.ts';
import { ShooterBatchController, runShooterMatch } from '../src/shooter/runner.ts';
import { DEFAULT_ATTRIBUTES, PLAYER_COUNT } from '../src/shooter/sim.ts';

export interface LabSeat {
  readonly attributes: Attributes;
  readonly knobs: KnobValues;
}

export interface LabTeam {
  /** 選手檔路徑 */
  readonly bot: string;
  readonly seats: readonly LabSeat[];
}

export interface LabJob {
  readonly seed: number;
  readonly map: string;
  /** A 當玩家 0～4 */
  readonly aFirst: boolean;
  readonly a: LabTeam;
  readonly b: LabTeam;
}

export interface LabGame {
  readonly seed: number;
  readonly map: string;
  readonly aFirst: boolean;
  /** A 贏的回合、B 贏的回合 */
  readonly aRounds: number;
  readonly bRounds: number;
  /** 1 A 勝、0 平、−1 A 敗 */
  readonly result: number;
  readonly overtimes: number;
  readonly exceptions: number;
  readonly timeouts: number;
  readonly decideMsMax: number;
  readonly decideMsTotal: number;
  readonly decisions: number;
  readonly wallMs: number;
}

/** 選手規格（或 null ＝ 全 50、自動角色）→ 座位 */
export function seatOf(spec: ShooterPlayerSpec | null): LabSeat {
  if (spec === null) return { attributes: DEFAULT_ATTRIBUTES, knobs: {} };
  const d = derivePlayer(spec);
  return { attributes: d.attributes, knobs: d.knobs };
}

/** 全 50 只換幾項屬性（整隊同值）、自動角色 */
export function attrSeat(over: Partial<Record<AttributeKey, number>> = {}): LabSeat {
  return { attributes: Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, over[k] ?? 50])) as unknown as Attributes, knobs: {} };
}

export const team = (bot: string, seats: readonly LabSeat[]): LabTeam => ({ bot, seats });
export const specTeam = (bot: string, specs: readonly (ShooterPlayerSpec | null)[]): LabTeam => team(bot, specs.map(seatOf));
export const sameTeam = (bot: string, seat: LabSeat): LabTeam => team(bot, Array.from({ length: TEAM_SIZE }, () => seat));

const compiled = new Map<string, CompiledBot>();
function bot(path: string): CompiledBot {
  let c = compiled.get(path);
  if (c === undefined) {
    c = compileBot(readFileSync(path, 'utf8'), path);
    compiled.set(path, c);
  }
  return c;
}

/** 打一場（在 worker 裡） */
export function playLab(job: LabJob): LabGame {
  const map = MAPS[job.map]();
  const isA = (pid: number): boolean => (pid < TEAM_SIZE) === job.aFirst;
  const seatAt = (pid: number): LabSeat => (isA(pid) ? job.a : job.b).seats[pid % TEAM_SIZE];
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => {
    const t = isA(pid) ? job.a : job.b;
    return new ShooterBatchController(bot(t.bot), t.bot, job.seed, pid, map);
  });
  // 只給選手宣告過的旋鈕（陪練 Bot 沒有 role）
  const knobs = controllers.map((c, pid) => {
    const want = seatAt(pid).knobs;
    return resolveKnobs(c.declaration, Object.fromEntries(Object.entries(want).filter(([k]) => c.declaration.knobs.some((d) => d.key === k))), c.label);
  });
  const run = runShooterMatch({ seed: job.seed, mapId: job.map, controllers, knobs, record: false, attributes: controllers.map((_, pid) => seatAt(pid).attributes) });
  const r = run.result;
  const ga = job.aFirst ? 0 : 1;
  let aRounds = 0;
  for (const x of r.rounds) if (x.winnerGroup === ga) aRounds++;
  const rt = run.runtime;
  return {
    seed: job.seed,
    map: job.map,
    aFirst: job.aFirst,
    aRounds,
    bRounds: r.rounds.length - aRounds,
    result: r.winner === null ? 0 : r.winner === ga ? 1 : -1,
    overtimes: r.overtimes,
    exceptions: rt.reduce((s, x) => s + x.exceptions, 0),
    timeouts: rt.reduce((s, x) => s + x.timeouts, 0),
    decideMsMax: Math.max(...rt.map((x) => x.decideMsMax)),
    decideMsTotal: rt.reduce((s, x) => s + x.decideMsTotal, 0),
    decisions: rt.reduce((s, x) => s + x.decisions, 0),
    wallMs: Math.round(run.wallMs),
  };
}

if (!isMainThread && (workerData as { lab?: boolean } | null)?.lab === true) {
  for (const j of (workerData as { jobs: LabJob[] }).jobs) parentPort!.postMessage(playLab(j));
}

const CACHE_DIR = 'out/shooter-lab';
const CACHE = `${CACHE_DIR}/cache.jsonl`;
const fileHash = new Map<string, string>();
function srcHash(path: string): string {
  let h = fileHash.get(path);
  if (h === undefined) {
    h = createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 16);
    fileHash.set(path, h);
  }
  return h;
}
/** 快取鍵：選手檔內容雜湊＋對局（耗時與 decide 毫秒數不影響勝負） */
const keyOf = (j: LabJob): string => createHash('sha1').update(JSON.stringify([srcHash(j.a.bot), srcHash(j.b.bot), j])).digest('hex');

let cache: Map<string, LabGame> | null = null;
function loadCache(): Map<string, LabGame> {
  if (cache !== null) return cache;
  cache = new Map();
  if (existsSync(CACHE)) {
    for (const line of readFileSync(CACHE, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      // 兩個實驗同時寫同一個檔時可能有壞行：跳過（那一場重打）
      try {
        const { k, g } = JSON.parse(line) as { k: string; g: LabGame };
        cache.set(k, g);
      } catch {
        continue;
      }
    }
  }
  return cache;
}

/** 跑一批對局（快取過的直接用）；jobs 個 worker 平行；onDone 每完成一場呼叫一次 */
export async function runLab(list: readonly LabJob[], jobs: number, onDone?: (done: number, total: number) => void): Promise<LabGame[]> {
  const c = loadCache();
  mkdirSync(CACHE_DIR, { recursive: true });
  const keys = list.map(keyOf);
  const todo = list.map((j, i) => ({ j, i })).filter((x) => !c.has(keys[x.i]));
  const out: (LabGame | undefined)[] = list.map((_, i) => c.get(keys[i]));
  let done = list.length - todo.length;
  const buckets: { j: LabJob; i: number }[][] = Array.from({ length: Math.max(1, Math.min(jobs, todo.length)) }, () => []);
  todo.forEach((x, k) => buckets[k % buckets.length].push(x));
  await Promise.all(
    buckets
      .filter((b) => b.length > 0)
      .map(
        (b) =>
          new Promise<void>((resolve, reject) => {
            let n = 0;
            const w = new Worker(new URL(import.meta.url), { workerData: { lab: true, jobs: b.map((x) => x.j) } });
            w.on('message', (g: LabGame) => {
              const { i } = b[n++];
              out[i] = g;
              c.set(keys[i], g);
              appendFileSync(CACHE, `${JSON.stringify({ k: keys[i], g })}\n`);
              onDone?.(++done, list.length);
            });
            w.on('error', reject);
            w.on('exit', () => resolve());
          }),
      ),
  );
  return out as LabGame[];
}

/** 一組比較：A 對 B，maps 每張圖 seeds 個種子 × 雙邊 */
export function matchup(a: LabTeam, b: LabTeam, maps: readonly string[], seeds: readonly number[]): LabJob[] {
  return maps.flatMap((map) => seeds.flatMap((seed) => [true, false].map((aFirst) => ({ seed, map, aFirst, a, b }))));
}

export interface LabSummary {
  readonly games: number;
  /** A 的整場勝率（平手算半場）、回合勝率 */
  readonly matchWin: number;
  readonly roundWin: number;
  readonly aRounds: number;
  readonly bRounds: number;
  readonly wins: number;
  readonly draws: number;
  readonly exceptions: number;
  readonly timeouts: number;
  readonly decideMsMax: number;
  readonly decideMsAvg: number;
  readonly byMap: Record<string, { readonly matchWin: number; readonly roundWin: number }>;
}

const r4 = (x: number): number => Math.round(x * 10000) / 10000;

export function summarize(games: readonly LabGame[]): LabSummary {
  const agg = (gs: readonly LabGame[]): { matchWin: number; roundWin: number } => {
    const ar = gs.reduce((s, g) => s + g.aRounds, 0);
    const br = gs.reduce((s, g) => s + g.bRounds, 0);
    const w = gs.reduce((s, g) => s + (g.result === 1 ? 1 : g.result === 0 ? 0.5 : 0), 0);
    return { matchWin: r4(w / Math.max(1, gs.length)), roundWin: r4(ar / Math.max(1, ar + br)) };
  };
  const maps = [...new Set(games.map((g) => g.map))];
  const all = agg(games);
  const dec = games.reduce((s, g) => s + g.decisions, 0);
  return {
    games: games.length,
    ...all,
    aRounds: games.reduce((s, g) => s + g.aRounds, 0),
    bRounds: games.reduce((s, g) => s + g.bRounds, 0),
    wins: games.filter((g) => g.result === 1).length,
    draws: games.filter((g) => g.result === 0).length,
    exceptions: games.reduce((s, g) => s + g.exceptions, 0),
    timeouts: games.reduce((s, g) => s + g.timeouts, 0),
    decideMsMax: Math.round(Math.max(0, ...games.map((g) => g.decideMsMax)) * 100) / 100,
    decideMsAvg: Math.round((games.reduce((s, g) => s + g.decideMsTotal, 0) / Math.max(1, dec)) * 1000) / 1000,
    byMap: Object.fromEntries(maps.map((m) => [m, agg(games.filter((g) => g.map === m))])),
  };
}

/** 勝率 → Elo 差（標準 Elo：400 分 10 倍；勝率夾在 1%～99%） */
export function eloOf(p: number): number {
  const q = Math.min(0.99, Math.max(0.01, p));
  return 400 * Math.log10(q / (1 - q));
}

/** Elo 差 → 勝率 */
export function winOf(diff: number): number {
  return 1 / (1 + 10 ** (-diff / 400));
}

/** 命令列參數 --name value */
export function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

export function progress(label: string): (done: number, total: number) => void {
  const t0 = performance.now();
  return (done, total) => {
    if (done % 10 === 0 || done === total) process.stderr.write(`${label} ${done}/${total}（${Math.round((performance.now() - t0) / 1000)} 秒）\n`);
  };
}
