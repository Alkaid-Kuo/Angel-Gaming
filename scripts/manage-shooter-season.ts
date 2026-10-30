// 攻防戰經營整季驗證（步驟 8）：射擊內容包＋真閘道（正式賽制 shooter-mr12），六種自動玩家策略各打一個賽段（同一個種子＝同一個聯賽），
// 外加一次「第 k 週存檔、讀檔後打完」與 passive 不中斷的結果比對。每個工作一個 worker 平行跑。
// 檢查：沒有例外、帳本與資金恆等、Elo 總分守恆、32 場都有結果；輸出名次、現金、耗時、每回合平均耗時（填回 SHOOTER_FORMATS 的 estMsPerRound）。
// 用法：node scripts/manage-shooter-season.ts [--seed 2026] [--resume-week 4] [--out out/manage-shooter-season.json]
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { POLICIES, runSeason } from '../src/manage/autoplayer.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { advance, newGame } from '../src/manage/game.ts';
import { ShooterGateway } from '../src/manage/gateway-shooter.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { humanTeam } from '../src/manage/state.ts';
import type { GameState } from '../src/manage/types.ts';

interface Job {
  readonly kind: 'policy' | 'resume';
  readonly policy: string;
  readonly seed: number;
  readonly resumeWeek: number;
}

interface JobResult {
  readonly job: Job;
  readonly error: string | null;
  readonly phase: string;
  readonly rank: number;
  readonly cash: number;
  readonly startCash: number;
  readonly ledgerOk: boolean;
  readonly eloOk: boolean;
  readonly fixturesDone: number;
  readonly weeks: number;
  readonly matches: number;
  readonly rounds: number;
  readonly engineMs: number;
  readonly totalMs: number;
  readonly botExceptions: number;
  readonly hash: string;
  /** 第 1 週第一場的請求單種子與比分（瀏覽器對照用） */
  readonly week1: { home: string; away: string; score: string }[];
}

const content = SHOOTER_CONTENT;

async function play(job: Job): Promise<JobResult> {
  const t0 = performance.now();
  const gateway = new ShooterGateway();
  let state = newGame(job.seed, content, { gateway });
  const start = new Map(state.teams.map((t) => [t.id, t.cash]));
  const eloSum = state.players.reduce((s, p) => s + p.elo, 0);
  let error: string | null = null;
  try {
    if (job.kind === 'resume') {
      while (state.week < job.resumeWeek && (state.phase === 'offseason' || state.phase === 'season')) await advance(state, content, gateway);
      state = deserialize(serialize(state), content);
      await runSeason(state, content, gateway, null);
    } else {
      await runSeason(state, content, gateway, POLICIES[job.policy]);
    }
  } catch (e) {
    error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  }
  const me = humanTeam(state);
  const s: GameState = state;
  return {
    job,
    error,
    phase: s.phase,
    rank: s.seasonResult?.humanRank ?? 0,
    cash: me.cash,
    startCash: start.get(me.id) as number,
    ledgerOk: s.teams.every((t) => t.cash === (start.get(t.id) as number) + t.ledger.reduce((x, e) => x + e.amount, 0)),
    eloOk: s.players.reduce((x, p) => x + p.elo, 0) === eloSum,
    fixturesDone: s.fixtures.filter((f) => f.result !== null).length,
    weeks: s.week,
    matches: gateway.matches,
    rounds: gateway.rounds,
    engineMs: Math.round(gateway.wallMs),
    totalMs: Math.round(performance.now() - t0),
    botExceptions: gateway.exceptions,
    hash: createHash('sha1').update(serialize(s)).digest('hex'),
    week1: s.fixtures
      .filter((f) => f.week === 1 && f.result)
      .map((f) => ({ home: s.teams.find((t) => t.id === f.home)?.name ?? f.home, away: s.teams.find((t) => t.id === f.away)?.name ?? f.away, score: `${f.result?.scoreA}:${f.result?.scoreB}` })),
  };
}

if (!isMainThread && (workerData as { season?: boolean } | null)?.season === true) {
  parentPort!.postMessage(await play((workerData as { job: Job }).job));
} else if (isMainThread) {
  const arg = (name: string, dflt: string): string => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  const seed = Number(arg('--seed', '2026'));
  const resumeWeek = Number(arg('--resume-week', '4'));
  const out = arg('--out', 'out/manage-shooter-season.json');
  const jobs: Job[] = [...Object.keys(POLICIES).map((policy): Job => ({ kind: 'policy', policy, seed, resumeWeek })), { kind: 'resume', policy: 'passive', seed, resumeWeek }];
  console.log(`攻防戰整季：種子 ${seed}，${jobs.length} 個工作平行（第 ${resumeWeek} 週存檔重跑）…`);
  const t0 = performance.now();
  const results = await Promise.all(
    jobs.map(
      (job) =>
        new Promise<JobResult>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { season: true, job } });
          w.once('message', (r: JobResult) => {
            console.log(`  完成 ${job.kind === 'resume' ? `passive（第 ${resumeWeek} 週存檔重跑）` : job.policy}：${Math.round(r.totalMs / 1000)} 秒`);
            resolve(r);
          });
          w.once('error', reject);
        }),
    ),
  );
  const pad = (x: string | number, n: number): string => String(x).padEnd(n);
  console.log(`\n${pad('策略', 14)}${pad('結果', 8)}${pad('名次', 6)}${pad('現金', 14)}${pad('帳本', 6)}${pad('Elo', 6)}${pad('場次', 6)}${pad('回合', 6)}${pad('耗時(秒)', 10)}${pad('ms/回合', 9)}例外`);
  for (const r of results) {
    const name = r.job.kind === 'resume' ? 'passive 讀檔' : r.job.policy;
    console.log(`${pad(name, 14)}${pad(r.error ? '例外' : r.phase, 8)}${pad(r.rank || '—', 6)}${pad(`${r.startCash}→${r.cash}`, 14)}${pad(r.ledgerOk ? 'OK' : '錯', 6)}${pad(r.eloOk ? 'OK' : '錯', 6)}${pad(`${r.fixturesDone}`, 6)}${pad(r.rounds, 6)}${pad((r.totalMs / 1000).toFixed(0), 10)}${pad(r.rounds ? (r.engineMs / r.rounds).toFixed(0) : '—', 9)}${r.botExceptions}`);
    if (r.error) console.log(`    ${r.error.split('\n').slice(0, 4).join('\n    ')}`);
  }
  const passive = results.find((r) => r.job.kind === 'policy' && r.job.policy === 'passive');
  const resumed = results.find((r) => r.job.kind === 'resume');
  const resumeSame = passive !== undefined && resumed !== undefined && passive.hash === resumed.hash;
  const all = results.filter((r) => r.job.kind === 'policy');
  const rounds = all.reduce((s, r) => s + r.rounds, 0);
  const engineMs = all.reduce((s, r) => s + r.engineMs, 0);
  const matches = all.reduce((s, r) => s + r.matches, 0);
  const nonNeg = all.filter((r) => r.cash >= 0).length;
  console.log(`\n存檔重跑一致：${resumeSame ? '是' : '否'}（passive ${passive?.hash.slice(0, 12)}／讀檔 ${resumed?.hash.slice(0, 12)}）`);
  console.log(`現金 ≥ 0 的策略：${nonNeg}／${all.length}`);
  console.log(`每場平均 ${(engineMs / matches / 1000).toFixed(2)} 秒、每回合 ${(engineMs / rounds).toFixed(0)} ms（${matches} 場、${rounds} 回合；7 個 worker 同時跑）；總耗時 ${((performance.now() - t0) / 60000).toFixed(1)} 分`);
  console.log(`第 1 週比分（瀏覽器對照用）：${passive?.week1.map((x) => `${x.home} ${x.score} ${x.away}`).join('、')}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ seed, resumeWeek, resumeSame, nonNegative: nonNeg, msPerRound: engineMs / rounds, msPerMatch: engineMs / matches, results }, null, 2));
  console.log(`寫入 ${out}`);
  const ok = results.every((r) => r.error === null && r.ledgerOk && r.eloOk) && resumeSame && nonNeg >= 4;
  process.exitCode = ok ? 0 : 1;
}
