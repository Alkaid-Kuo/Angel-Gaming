// 軍備競賽評測（執行手冊「評測流程」1～5 與 7）：用固定版本的參賽包 CLI（正式模式）評測各次執行的成果。
// 用法：node scripts/evaluate-trials.ts <參賽包目錄> <輸出 JSON> <執行資料夾…>
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [packDir, outFile, ...runDirs] = process.argv.slice(2);
if (runDirs.length === 0) {
  process.stderr.write('用法：node scripts/evaluate-trials.ts <參賽包目錄> <輸出 JSON> <執行資料夾…>\n');
  process.exit(1);
}
const cli = join(packDir, 'rts-sim.mjs');
const baseline = join(packDir, 'bots', 'baseline.js');
const FINAL_GAMES = Number(process.env.FINAL_GAMES ?? 100);
const SNAPSHOT_GAMES = Number(process.env.SNAPSHOT_GAMES ?? 50);
const SEED = 9000;

interface SimPlayer {
  botIndex: number;
  rank: number;
  stats: Record<string, unknown>;
}
interface SimGame {
  seed: number;
  durationTicks: number;
  players: SimPlayer[];
}
interface SimOut {
  summary: { bots: { winRate?: number; avgRank?: number; games: number }[] };
  games: SimGame[];
}

function sim(args: string[]): SimOut {
  const out = execFileSync(process.execPath, [cli, ...args, '--exec', 'official'], { maxBuffer: 1 << 30, encoding: 'utf8' });
  return JSON.parse(out) as SimOut;
}

function avg(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length === 0 ? null : Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
}

/** 某選手（botIndex）在所有場次的風格統計平均 */
function styleStats(games: SimGame[], idx: number): Record<string, number | null> {
  const ps = games.flatMap((g) => g.players.filter((p) => p.botIndex === idx));
  const num = (k: string): number[] => ps.map((p) => p.stats[k]).filter((v): v is number => typeof v === 'number');
  const ratio = (t: string): number[] => ps.map((p) => ((p.stats.productionRatio as Record<string, number> | undefined)?.[t] ?? NaN));
  return {
    firstDamageTick: avg(num('firstDamageTick')),
    firstExpansionTick: avg(num('firstExpansionTick')),
    expandedGamesPct: Math.round((ps.filter((p) => typeof p.stats.firstExpansionTick === 'number').length * 1000) / Math.max(1, ps.length)) / 10,
    gathered: avg(num('gathered')),
    unitsProduced: avg(num('unitsProduced')),
    towersBuilt: avg(num('towersBuilt')),
    workerKills: avg(num('workerKills')),
    scoutCount: avg(num('scoutCount')),
    towerHeldTicks: avg(num('towerHeldTicks')),
    richGatherRatio: avg(num('richGatherRatio')),
    spearPct: avg(ratio('spear')),
    archerPct: avg(ratio('archer')),
    cavalryPct: avg(ratio('cavalry')),
    apm: avg(num('apm')),
    decideMsAvg: avg(num('decideMsAvg')),
    decideMsMax: avg(num('decideMsMax')),
    softTimeouts: avg(num('softTimeouts')),
    exceptions: avg(num('exceptions')),
  };
}

function compliance(file: string): { ok: boolean; bytes: number; error: string | null } {
  const bytes = statSync(file).size;
  try {
    // 用 mapgen 以外最輕的指令觸發載入：1 場 batch 比賽
    execFileSync(process.execPath, [cli, 'match', '--mode', '1v1', '--bots', file, baseline, '--games', '1', '--seed', '1', '--exec', 'batch'], { maxBuffer: 1 << 28, encoding: 'utf8' });
    return { ok: true, bytes, error: null };
  } catch (e) {
    return { ok: false, bytes, error: String((e as { stderr?: string }).stderr ?? e).slice(0, 500) };
  }
}

const report: Record<string, unknown>[] = [];
const finals: string[] = [];
for (const dir of runDirs) {
  const name = basename(dir);
  const final = join(dir, 'final.js');
  const versionsDir = join(dir, 'versions');
  const snapshots = existsSync(versionsDir) ? readdirSync(versionsDir).filter((f) => /^v\d+\.js$/.test(f)).sort((a, b) => Number(a.slice(1, -3)) - Number(b.slice(1, -3))) : [];
  const entry: Record<string, unknown> = { run: name, hasFinal: existsSync(final), snapshots };
  process.stderr.write(`評測 ${name}\n`);
  const files = [...snapshots.map((s) => join(versionsDir, s)), ...(existsSync(final) ? [final] : [])];
  entry.compliance = Object.fromEntries(files.map((f) => [basename(f), compliance(f)]));
  if (existsSync(final) && (entry.compliance as Record<string, { ok: boolean }>)['final.js'].ok) {
    finals.push(final);
    const vs = sim(['match', '--mode', '1v1', '--bots', final, baseline, '--swap', '--games', String(FINAL_GAMES), '--seed', String(SEED)]);
    entry.finalVsBaseline = { winRate: vs.summary.bots[0].winRate, games: vs.summary.bots[0].games };
    entry.style = styleStats(vs.games, 0);
    entry.baselineStyleSameGames = styleStats(vs.games, 1);
    const ffa = sim(['match', '--mode', 'ffa4', '--bots', final, baseline, baseline, baseline, '--games', '20', '--seed', String(SEED)]);
    entry.ffa4VsBaselines = { avgRank: ffa.summary.bots[0].avgRank, games: ffa.summary.bots[0].games };
  }
  entry.versionLine = snapshots.map((s) => {
    const file = join(versionsDir, s);
    if (!(entry.compliance as Record<string, { ok: boolean }>)[s].ok) return { version: s, winRate: null };
    const r = sim(['match', '--mode', '1v1', '--bots', file, baseline, '--swap', '--games', String(SNAPSHOT_GAMES), '--seed', String(SEED + 500)]);
    return { version: s, winRate: r.summary.bots[0].winRate };
  });
  const bugs = join(dir, 'BUGS.md');
  entry.bugs = existsSync(bugs) ? readFileSync(bugs, 'utf8').slice(0, 4000) : '';
  const notes = join(dir, 'NOTES.md');
  entry.notes = existsSync(notes) ? readFileSync(notes, 'utf8').slice(0, 4000) : '';
  report.push(entry);
  writeFileSync(outFile, JSON.stringify({ report }, null, 2));
}

let roundrobin: unknown = null;
if (finals.length >= 2) {
  const rr1 = JSON.parse(execFileSync(process.execPath, [cli, 'roundrobin', '--mode', '1v1', '--bots', ...finals, baseline, '--games', '20', '--seed', String(SEED + 1000), '--exec', 'official'], { maxBuffer: 1 << 30, encoding: 'utf8' })) as Record<string, unknown>;
  const rr4 = finals.length + 1 >= 4
    ? (JSON.parse(execFileSync(process.execPath, [cli, 'roundrobin', '--mode', 'ffa4', '--bots', ...finals, baseline, '--games', '4', '--seed', String(SEED + 2000), '--exec', 'official'], { maxBuffer: 1 << 30, encoding: 'utf8' })) as Record<string, unknown>)
    : null;
  roundrobin = {
    bots: [...finals.map((f) => basename(join(f, '..'))), 'baseline'],
    oneVsOne: { winRateMatrix: rr1.winRateMatrix, elo: rr1.elo },
    ffa4: rr4 === null ? null : { elo: rr4.elo, summary: rr4.summary },
  };
}
writeFileSync(outFile, JSON.stringify({ report, roundrobin }, null, 2));
process.stderr.write(`評測完成：${outFile}\n`);
