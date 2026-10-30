// CS 射擊隱藏強度表（步驟 7；任務書 2.4）：離線互打 → 每個（角色, 版本）一個 Elo 式分數（整場勝率的尺度，給經營層 expectedPermille）。
//   參照隊 R ＝ 均衡陣容（五角色各一、版本 3、habit 0）
//   版本成長 growth(v)：均衡陣容版本 v 對 R（兩張圖各 --seeds 個種子 × 雙邊）
//   角色偏移：X(r) ＝ R 但角色 r 升到版本 5；五支 X(r) 兩兩互打（10 組），Bradley–Terry 解出「升兩版的價值」θ_r（置中），再依抽樣誤差收縮；
//             隊伍分數＝五人平均，所以 X(r) − X(s) ＝ 2 × (off_r − off_s) / 5 → off_r ＝ 2.5 × θ_r
//   回合 → 整場：量測用回合勝率（整場勝率很快飽和），用全部對局擬合 P(整場) ＝ 1 / (1 + e^(−k × (回合 − 0.5)))，Elo 以整場為準
//   power(r, v) ＝ 1500 + growth(v) + off_r × (v − 3)，再單調化（每個角色隨版本嚴格遞增、最小間隔 10）
//   驗證：10 組隨機名單（角色、版本混搭、habit ≠ 0），兩張圖各 --vseeds 個種子 × 雙邊；預測（隊伍 power ＝ 五人平均）對實測
// 用法：node scripts/shooter-strength.ts [--seeds 20] [--btseeds 10] [--vseeds 5] [--jobs 4] [--out out/shooter-strength/strength.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Prng } from '../src/shared/prng.ts';
import { BALANCED_ROLES, BASE_VERSION, MAX_VERSION, SHOOTER_ROLES, balancedLineup, type ShooterPlayerSpec, type ShooterRole } from '../src/shooter/players.ts';
import { arg, eloOf, matchup, progress, runLab, specTeam, summarize, winOf, type LabSummary } from './shooter-lab.ts';

const BOT = 'bots/shooter-baseline.js';
const MAPS = ['redrock', 'dust'];
const range = (n: number, from = 1001): number[] => Array.from({ length: n }, (_, i) => from + i);
const seeds = range(Number(arg('seeds', '20')));
const btSeeds = range(Number(arg('btseeds', '10')));
const vSeeds = range(Number(arg('vseeds', '5')), 5001);
const jobs = Number(arg('jobs', '4'));
const outPath = arg('out', 'out/shooter-strength/strength.json');
const MIN_STEP = 10;

const R = balancedLineup(BASE_VERSION);
const upgraded = (r: ShooterRole): ShooterPlayerSpec[] => R.map((s) => (s.role === r ? { ...s, version: MAX_VERSION } : s));

// ── 實驗清單 ──
const versions = Array.from({ length: MAX_VERSION }, (_, i) => i + 1).filter((v) => v !== BASE_VERSION);
const growthJobs = versions.map((v) => matchup(specTeam(BOT, balancedLineup(v)), specTeam(BOT, R), MAPS, seeds));
const pairs: [ShooterRole, ShooterRole][] = [];
for (let i = 0; i < SHOOTER_ROLES.length; i++) for (let j = i + 1; j < SHOOTER_ROLES.length; j++) pairs.push([SHOOTER_ROLES[i], SHOOTER_ROLES[j]]);
const btJobs = pairs.map(([a, b]) => matchup(specTeam(BOT, upgraded(a)), specTeam(BOT, upgraded(b)), MAPS, btSeeds));

// 驗證名單：固定種子抽角色（每隊五個座位依均衡順序，角色有機率換成別的）、版本 1～5、habit 1～999
const rng = Prng.fromInts(7, 0x57e);
const randomLineup = (): ShooterPlayerSpec[] =>
  BALANCED_ROLES.map((role) => ({ role: rng.nextInt(4) === 0 ? SHOOTER_ROLES[rng.nextInt(SHOOTER_ROLES.length)] : role, version: 1 + rng.nextInt(MAX_VERSION), habit: 1 + rng.nextInt(999) }));
const vLineups = Array.from({ length: 10 }, () => [randomLineup(), randomLineup()] as const);
const vJobs = vLineups.map(([a, b]) => matchup(specTeam(BOT, a), specTeam(BOT, b), MAPS, vSeeds));

const all = [...growthJobs, ...btJobs, ...vJobs].flat();
const games = await runLab(all, jobs, progress('強度表'));
let k = 0;
const take = (n: number): LabSummary => {
  const s = summarize(games.slice(k, k + n));
  k += n;
  return s;
};
const vStart = [...growthJobs, ...btJobs].reduce((s2, j) => s2 + j.length, 0);
const growthRes = growthJobs.map((j) => take(j.length));
const btRes = btJobs.map((j) => take(j.length));
const vRes = vJobs.map((j) => take(j.length));
// 任務書的口徑：每組 20 場（前 5 個種子 × 兩張圖 × 雙邊）
const half = new Set(vSeeds.slice(0, 5));
let kv = vStart;
const vRes20 = vJobs.map((j) => {
  const gs = games.slice(kv, kv + j.length).filter((g) => half.has(g.seed));
  kv += j.length;
  return summarize(gs);
});

// ── 回合 → 整場：P ＝ 1 / (1 + e^(−k(x − 0.5)))，以對局數加權的二項對數概似、黃金分割搜 k ──
const points = [...growthRes, ...btRes].map((s) => ({ x: s.roundWin, y: s.matchWin, n: s.games }));
const logistic = (kk: number, x: number): number => 1 / (1 + Math.exp(-kk * (x - 0.5)));
const nll = (kk: number): number =>
  points.reduce((s, p) => {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, logistic(kk, p.x)));
    return s - p.n * (p.y * Math.log(q) + (1 - p.y) * Math.log(1 - q));
  }, 0);
let lo = 1;
let hi = 120;
for (let i = 0; i < 100; i++) {
  const m1 = lo + (hi - lo) * 0.382;
  const m2 = lo + (hi - lo) * 0.618;
  if (nll(m1) < nll(m2)) hi = m2;
  else lo = m1;
}
const K = (lo + hi) / 2;
const matchFromRound = (x: number): number => logistic(K, x);
const eloFromRound = (x: number): number => eloOf(matchFromRound(x));

// ── 版本成長 ──
const growth: Record<number, number> = { [BASE_VERSION]: 0 };
versions.forEach((v, i) => (growth[v] = eloFromRound(growthRes[i].roundWin)));

// ── Bradley–Terry（回合勝負；MM 演算法）→ 回合 Elo → 整場 Elo ──
const idx = new Map(SHOOTER_ROLES.map((r, i) => [r, i]));
const wins = SHOOTER_ROLES.map(() => 0);
const nMat = SHOOTER_ROLES.map(() => SHOOTER_ROLES.map(() => 0));
pairs.forEach(([a, b], i) => {
  const ia = idx.get(a)!;
  const ib = idx.get(b)!;
  wins[ia] += btRes[i].aRounds;
  wins[ib] += btRes[i].bRounds;
  nMat[ia][ib] += btRes[i].aRounds + btRes[i].bRounds;
  nMat[ib][ia] += btRes[i].aRounds + btRes[i].bRounds;
});
let pi = SHOOTER_ROLES.map(() => 1);
for (let it = 0; it < 2000; it++) {
  const next = pi.map((p, i) => wins[i] / pi.reduce((s, q, j) => (j === i ? s : s + nMat[i][j] / (p + q)), 0));
  const g = Math.exp(next.reduce((s, x) => s + Math.log(x), 0) / next.length);
  pi = next.map((x) => x / g);
}
// θ：BT 的回合勝率尺度 → 對「平均隊」的回合勝率 → 整場 Elo（置中）
const thetaRound = pi.map((p) => 400 * Math.log10(p));
const thetaMatch = pi.map((p) => eloFromRound(p / (p + 1)));
const meanT = thetaMatch.reduce((s, x) => s + x, 0) / thetaMatch.length;
const offsetRaw = Object.fromEntries(SHOOTER_ROLES.map((r, i) => [r, 2.5 * (thetaMatch[i] - meanT)])) as Record<ShooterRole, number>;

// ── 收縮（經驗貝氏）：角色之間的差異有多少是真的。每個角色在它參加的四組對局裡、每場的回合占比 → 平均與抽樣變異；
//    收縮係數 ＝ max(0, 1 − 平均抽樣變異 ÷ 角色平均之間的變異)。量測精度內分不出來的偏移就往 0 拉（原始值照列在報告）
const btStart = growthJobs.reduce((s2, j) => s2 + j.length, 0);
const shares = SHOOTER_ROLES.map(() => [] as number[]);
let kb = btStart;
pairs.forEach(([a, b], i) => {
  for (const g of games.slice(kb, kb + btJobs[i].length)) {
    const x = g.aRounds / Math.max(1, g.aRounds + g.bRounds);
    shares[idx.get(a)!].push(x);
    shares[idx.get(b)!].push(1 - x);
  }
  kb += btJobs[i].length;
});
const meanOf = (xs: readonly number[]): number => xs.reduce((s2, x) => s2 + x, 0) / xs.length;
const roleMean = shares.map(meanOf);
const noiseVar = meanOf(shares.map((xs, i) => xs.reduce((s2, x) => s2 + (x - roleMean[i]) ** 2, 0) / (xs.length - 1) / xs.length));
const grand = meanOf(roleMean);
const betweenVar = roleMean.reduce((s2, m) => s2 + (m - grand) ** 2, 0) / (roleMean.length - 1);
const shrink = Math.max(0, 1 - noiseVar / betweenVar);
const offset = Object.fromEntries(SHOOTER_ROLES.map((r) => [r, shrink * offsetRaw[r]])) as Record<ShooterRole, number>;

// ── 強度表：原始值與單調化 ──
const raw = Object.fromEntries(SHOOTER_ROLES.map((r) => [r, Array.from({ length: MAX_VERSION }, (_, i) => 1500 + growth[i + 1] + offset[r] * (i + 1 - BASE_VERSION))])) as Record<ShooterRole, number[]>;
/** 單調化：從版本 3 往兩邊推，保持嚴格遞增（最小間隔 MIN_STEP），四捨五入成整數 */
const monotone = (xs: readonly number[]): number[] => {
  const out = xs.map((x) => Math.round(x));
  const b = BASE_VERSION - 1;
  for (let i = b + 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + MIN_STEP);
  for (let i = b - 1; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - MIN_STEP);
  return out;
};
const power = Object.fromEntries(SHOOTER_ROLES.map((r) => [r, monotone(raw[r])])) as Record<ShooterRole, number[]>;
const powerOf = (s: ShooterPlayerSpec): number => power[s.role][s.version - 1];
const teamPower = (l: readonly ShooterPlayerSpec[]): number => l.reduce((s, x) => s + powerOf(x), 0) / l.length;

// ── 驗證 ──
const validation = vLineups.map(([a, b], i) => {
  const diff = teamPower(a) - teamPower(b);
  const pred = winOf(diff);
  const s = vRes[i];
  return { a, b, diff: Math.round(diff), predicted: Math.round(pred * 1000) / 1000, actualMatch: s.matchWin, actualRound: s.roundWin, roundImpliedMatch: Math.round(matchFromRound(s.roundWin) * 1000) / 1000, games: s.games, actualMatch20: vRes20[i].matchWin, games20: vRes20[i].games };
});
const mae = (f: (v: (typeof validation)[number]) => number): number => validation.reduce((s, v) => s + Math.abs(f(v)), 0) / validation.length;
const errMatch = mae((v) => v.predicted - v.actualMatch);
const errRoundImplied = mae((v) => v.predicted - v.roundImpliedMatch);
const errMatch20 = mae((v) => v.predicted - v.actualMatch20);

const r1 = (x: number): number => Math.round(x * 10) / 10;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
console.log(`回合 → 整場 logistic：k = ${K.toFixed(2)}（回合 55% → 整場 ${pct(matchFromRound(0.55))}、60% → ${pct(matchFromRound(0.6))}）`);
console.log(`版本成長：${versions.map((v, i) => `v${v} 回合 ${pct(growthRes[i].roundWin)} 整場 ${pct(growthRes[i].matchWin)} → ${r1(growth[v])}`).join('；')}`);
console.log(`BT（回合 Elo）：${SHOOTER_ROLES.map((r, i) => `${r} ${r1(thetaRound[i])}`).join('、')}；每版偏移（原始）：${SHOOTER_ROLES.map((r) => `${r} ${r1(offsetRaw[r])}`).join('、')}`);
console.log(`收縮：角色回合占比 ${SHOOTER_ROLES.map((r, i) => `${r} ${pct(roleMean[i])}`).join('、')}；抽樣變異 ${(noiseVar * 1e4).toFixed(2)}、角色間變異 ${(betweenVar * 1e4).toFixed(2)}（百分點²）→ 係數 ${shrink.toFixed(3)}；採用偏移 ${SHOOTER_ROLES.map((r) => `${r} ${r1(offset[r])}`).join('、')}`);
for (const r of SHOOTER_ROLES) console.log(`${r.padEnd(8)}原始 ${raw[r].map(r1).join(' ')} → 採用 ${power[r].join(' ')}`);
for (const v of validation) console.log(`驗證 差 ${String(v.diff).padStart(5)}  預測 ${pct(v.predicted)}  實測整場 ${pct(v.actualMatch)}  實測回合 ${pct(v.actualRound)}（換整場 ${pct(v.roundImpliedMatch)}）`);
console.log(`平均誤差：對實測整場 ${(errMatch * 100).toFixed(1)} 個百分點（每組 ${vRes[0]?.games ?? 0} 場）；對回合換算的整場 ${(errRoundImplied * 100).toFixed(1)}；只取前 5 個種子（每組 ${vRes20[0]?.games ?? 0} 場）${(errMatch20 * 100).toFixed(1)}`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      seeds,
      btSeeds,
      vSeeds,
      maps: MAPS,
      logisticK: K,
      growth: versions.map((v, i) => ({ version: v, ...growthRes[i], elo: growth[v] })),
      bradleyTerry: { pairs: pairs.map(([a, b], i) => ({ a, b, ...btRes[i] })), pi, thetaRound, thetaMatch, offsetRaw, roleShare: roleMean, noiseVar, betweenVar, shrink, offset },
      raw,
      power,
      validation,
      errMatch,
      errRoundImplied,
      errMatch20,
    },
    null,
    1,
  ),
);
console.log(`寫入 ${outPath}`);
