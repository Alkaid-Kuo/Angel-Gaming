// 首週對手分析（2026-11-07 使用者回饋「第一個對手幾乎無法打贏」）：玩家開局隊對每支 NPC 開局隊的預期勝率，用閘道真打。
// 每個開局種子：newGame → 推進休賽期（NPC 開局簽人、休賽期工作）→ 第 1 週。對每支 NPC，把第 1 週的賽程換成「玩家 vs 這支」，
// 用 beginMatchDay 取出正式比賽日會送出的請求單（NPC 名單、計畫、默契、新面孔折扣、助理教練都和正式版相同），再換種子打 --games 場。
// --variant b：方案乙的試算，玩家開局隊的新秀（版本 1）屬性改成版本 2（正選），其他不變。
// --schedule-seeds：另外只列這些開局種子的第 1～3 週對手（不打）。
// 用法：node scripts/m5-opening-matchups.ts [--seeds 1,2,3] [--schedule-seeds 1-20] [--games 50] [--match-seeds 1,1001] [--variant base|b] [--jobs 8] [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { attrsAt, stageOf } from '../src/manage/attrs.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { advance, beginMatchDay, newGame } from '../src/manage/game.ts';
import type { MatchRequest } from '../src/manage/gateway.ts';
import { ShooterGateway } from '../src/manage/gateway-shooter.ts';
import { publicPrior, stageOfPlayer, truePower } from '../src/manage/state.ts';
import type { GameState } from '../src/manage/types.ts';
import { runGatewayMatch } from '../src/shooter/gateway.ts';
import { compileBot } from '../src/sandbox/compile.ts';

interface Job {
  readonly key: string;
  readonly request: MatchRequest;
  /** 玩家是請求單的哪一方 */
  readonly me: 'a' | 'b';
}
interface Row {
  readonly key: string;
  readonly won: number;
  readonly rounds: number;
  readonly roundsWon: number;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const content = SHOOTER_CONTENT;
const STAGES = ['新秀', '正選', '主力', '明星', '傳奇'];

/** 玩家開局隊的新秀改成正選（方案乙試算）：屬性＝該流派版本 2 的屬性，上限至少到那裡 */
function bumpRookies(state: GameState): void {
  for (const p of state.players) {
    if (p.teamId !== state.humanTeamId || stageOf(content, p.lineageId, p.attrs) !== 1) continue;
    const a = attrsAt(content, p.lineageId, 2);
    p.attrs = a;
    for (const k of Object.keys(p.caps)) p.caps[k] = Math.max(p.caps[k], a[k]);
    p.elo = publicPrior(stageOfPlayer(content, p));
  }
}

if (!isMainThread) {
  const { jobs } = workerData as { jobs: Job[] };
  const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
  for (const j of jobs) {
    const o = runGatewayMatch(j.request, bot).outcome;
    const row: Row = { key: j.key, won: o.winner === j.me ? 1 : o.winner === 'draw' ? 0.5 : 0, rounds: o.rounds.length, roundsWon: o.rounds.filter((r) => r.winner === j.me).length };
    parentPort!.postMessage(row);
  }
} else {
  const seeds = arg('seeds', '1,2,3').split(',').map(Number);
  const games = Number(arg('games', '50'));
  const matchSeeds = arg('match-seeds', '1,1001').split(',').map(Number);
  const variant = arg('variant', 'base');
  const jobsN = Number(arg('jobs', String(Math.max(1, Math.min(8, cpus().length - 2)))));
  const gateway = new ShooterGateway();
  const all: Job[] = [];
  const info: Record<string, { seed: number; team: string; persona: string; elo: number; power: number; stages: string; assistant: boolean; meElo: number; mePower: number; meStages: string }> = {};
  const schedule: { seed: number; me: string; weeks: string[] }[] = [];
  const ss = arg('schedule-seeds', '');
  const scheduleOnly: number[] = ss === '' ? [] : ss.includes('-') ? Array.from({ length: Number(ss.split('-')[1]) - Number(ss.split('-')[0]) + 1 }, (_, i) => Number(ss.split('-')[0]) + i) : ss.split(',').map(Number);
  for (const seed of scheduleOnly) {
    const s0 = newGame(seed, content, { gateway });
    const me = s0.humanTeamId;
    const team = (id: string): string => { const t = s0.teams.find((x) => x.id === id); return `${t?.name}（${t?.persona}）`; };
    schedule.push({ seed, me, weeks: [1, 2, 3].map((w) => { const f = s0.fixtures.find((x) => x.week === w && (x.home === me || x.away === me)); return f === undefined ? '輪空' : team(f.home === me ? f.away : f.home); }) });
  }
  for (const seed of seeds) {
    const s0 = newGame(seed, content, { gateway });
    if (variant === 'b') bumpRookies(s0);
    await advance(s0, content, gateway);
    const me = s0.humanTeamId;
    const name = (id: string): string => s0.teams.find((t) => t.id === id)?.name ?? id;
    const persona = (id: string): string => s0.teams.find((t) => t.id === id)?.persona ?? '玩家';
    const weeks = [1, 2, 3].map((w) => {
      const f = s0.fixtures.find((x) => x.week === w && (x.home === me || x.away === me));
      const opp = f === undefined ? null : f.home === me ? f.away : f.home;
      return opp === null ? '輪空' : `${name(opp)}（${persona(opp)}）`;
    });
    if (!scheduleOnly.includes(seed)) schedule.push({ seed, me, weeks });
    for (const npc of s0.teams.filter((t) => !t.human)) {
      const st = structuredClone(s0);
      const keep = st.fixtures.find((f) => f.week === 1) as GameState['fixtures'][number];
      st.fixtures = st.fixtures.filter((f) => f.week !== 1);
      st.fixtures.push({ ...keep, home: me, away: npc.id });
      const ticket = beginMatchDay(st, content);
      if (ticket === null) throw new Error('沒有我方比賽');
      const key = `${seed}|${npc.id}`;
      const lineupOf = (ids: readonly string[]): { elo: number; power: number; stages: string } => {
        const ps = ids.map((id) => st.players.find((p) => p.id === id)!);
        const counts = new Map<string, number>();
        for (const p of ps) {
          const s = STAGES[stageOfPlayer(content, p) - 1];
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        return { elo: Math.round(ps.reduce((s, p) => s + p.elo, 0) / ps.length), power: Math.round(ps.reduce((s, p) => s + truePower(content, p), 0) / ps.length), stages: [...counts].map(([s, n]) => `${s}${n}`).join(' ') };
      };
      const mine = lineupOf(ticket.lineups[0]);
      const theirs = lineupOf(ticket.lineups[1]);
      info[key] = { seed, team: npc.name, persona: npc.persona ?? '', elo: theirs.elo, power: theirs.power, stages: theirs.stages, assistant: st.teams.find((t) => t.id === npc.id)!.assistant, meElo: mine.elo, mePower: mine.power, meStages: mine.stages };
      for (const ms of matchSeeds) {
        for (let i = 0; i < games; i++) {
          const r = ticket.request;
          const swap = i % 2 === 1;
          const coachAi = r.coachAi === undefined ? {} : { coachAi: swap ? { a: r.coachAi.b, b: r.coachAi.a } : r.coachAi };
          const request: MatchRequest = { formatId: r.formatId, a: swap ? r.b : r.a, b: swap ? r.a : r.b, seed: ms + i, ...coachAi };
          all.push({ key, request, me: swap ? 'b' : 'a' });
        }
      }
    }
  }
  const buckets: Job[][] = Array.from({ length: Math.max(1, Math.min(jobsN, all.length)) }, () => []);
  all.forEach((j, i) => buckets[i % buckets.length].push(j));
  const rows = new Map<string, Row[]>();
  let done = 0;
  const t0 = performance.now();
  await Promise.all(
    buckets.map(
      (jobs) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { jobs } });
          w.on('message', (r: Row) => {
            const list = rows.get(r.key) ?? [];
            list.push(r);
            rows.set(r.key, list);
            if (++done % 100 === 0) console.error(`${done}/${all.length}（${Math.round((performance.now() - t0) / 1000)} 秒）`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  const pct = (x: number): string => (x * 100).toFixed(1);
  /** 比率與 95% 區間（以場為群集） */
  const ratio = (per: { w: number; n: number }[]): { p: number; lo: number; hi: number } => {
    const W = per.reduce((s, x) => s + x.w, 0);
    const N = per.reduce((s, x) => s + x.n, 0);
    const p = N === 0 ? 0 : W / N;
    const G = per.length;
    const v = G < 2 || N === 0 ? 0 : ((G / (G - 1)) * per.reduce((s, x) => s + (x.w - p * x.n) ** 2, 0)) / N ** 2;
    return { p, lo: p - 1.96 * Math.sqrt(v), hi: p + 1.96 * Math.sqrt(v) };
  };
  const out: Record<string, unknown>[] = [];
  console.log(`方案：${variant === 'b' ? '乙（玩家新秀改成正選）' : '現況'}　開局種子：${seeds.join('、')}　每組 ${matchSeeds.length} × ${games} 場（MR6，閘道真打）`);
  for (const sc of schedule) console.log(`種子 ${sc.seed}：玩家第 1～3 週對手 ${sc.weeks.join(' → ')}`);
  console.log(`\n| 種子 | NPC | 個性 | 出賽名單 | 平均公開 Elo | 平均真實強度 | 助理教練 | 玩家整場勝率 | 玩家回合勝率［95%］ |`);
  console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const [key, inf] of Object.entries(info)) {
    const rs = rows.get(key) ?? [];
    const m = ratio(rs.map((r) => ({ w: r.won, n: 1 })));
    const rd = ratio(rs.map((r) => ({ w: r.roundsWon, n: r.rounds })));
    console.log(`| ${inf.seed} | ${inf.team} | ${inf.persona} | ${inf.stages} | ${inf.elo} | ${inf.power} | ${inf.assistant ? '有' : '無'} | ${pct(m.p)}% | ${pct(rd.p)}%［${pct(rd.lo)}, ${pct(rd.hi)}］ |`);
    out.push({ key, ...inf, games: rs.length, match: m, round: rd });
  }
  const meRow = Object.values(info)[0];
  console.log(`\n玩家出賽名單（種子 ${seeds[0]}）：${meRow?.meStages}，平均公開 Elo ${meRow?.meElo}、平均真實強度 ${meRow?.mePower}　（${Math.round((performance.now() - t0) / 1000)} 秒）`);
  const json = arg('json', '');
  if (json !== '') writeFileSync(json, JSON.stringify({ variant, seeds, games, matchSeeds, schedule, rows: out }, null, 1));
}
