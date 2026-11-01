// CS 射擊觀戰問題量測（Bot 2.2）：A 對 B 雙邊對打，逐 tick 看引擎狀態（只給離線量測，Bot 看不到），算使用者觀戰指出的五個問題的數字。
//   手槍局輸家：第二、三回合買了幾把主武器、回合勝率、整場勝率（A 當 T／當 CT 分開）
//   全滅即拆：炸彈下了、T 全滅之後，CT 多久開始拆；有沒有炸掉
//   同路：T 進點 ≥ 3 人的回合，全部從同一個區域進點的比例（rush 除外）；團滅：T 在下包前 8 秒內、14 格內死 4 人以上
//   煙霧：同隊同回合兩顆煙落點 < 6 格的比例
//   發呆：開打 10 秒、20 秒還在起點 5 格內的人
// 用法：node scripts/shooter-behavior.ts [--a bots/shooter-baseline.js] [--b 同 a] [--lineup 3] [--maps redrock] [--seeds 100] [--from 1] [--jobs 10] [--format shooter-mr6] [--out out/behavior.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { compileBot, type CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import type { ShooterCommand, ShooterObservation } from '../src/shooter/api.ts';
import { TEAM_SIZE, UNIT } from '../src/shooter/config.ts';
import { LEAGUE_FORMAT_ID, formatOptions } from '../src/shooter/gateway.ts';
import { MAPS, regionsAt } from '../src/shooter/map.ts';
import { balancedLineup, derivePlayer } from '../src/shooter/players.ts';
import { ShooterBatchController, ShooterDriver } from '../src/shooter/runner.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';
import { arg } from './shooter-lab.ts';

interface Job {
  readonly a: string;
  readonly b: string;
  readonly lineupA: number;
  readonly lineupB: number;
  readonly map: string;
  readonly seed: number;
  readonly aFirst: boolean;
  readonly format: string;
}

interface PistolLoss {
  /** 輸手槍局的是 A */
  readonly isA: boolean;
  readonly side: 'T' | 'CT';
  /** 第二回合開打時輸家的主武器數、護甲數、平均錢 */
  readonly guns2: number;
  readonly armor2: number;
  readonly won2: boolean;
  readonly guns3: number;
  readonly won3: boolean;
  readonly matchWon: boolean;
}

interface GameOut {
  readonly rounds: number;
  readonly tWins: number;
  readonly exceptions: number;
  readonly aMatch: number;
  readonly aRounds: number;
  readonly pistol: PistolLoss[];
  /** T 全滅到開始拆包的秒數；−1 ＝ 沒拆到 */
  readonly defuseDelay: { sec: number; exploded: boolean }[];
  readonly entries: { kind: string; n: number; regions: number }[];
  readonly wipes: number;
  readonly tRounds: number;
  /** 回合內兩顆煙都有的同隊配對：最近距離（格） */
  readonly smokePairs: number[];
  readonly idle: { t10: number; t20: number; ct10: number; ct20: number; n: number };
  readonly plans: Record<string, [number, number]>;
}

class Spy extends ShooterBatchController {
  private readonly said: (text: string, obs: ShooterObservation) => void;

  constructor(bot: CompiledBot, label: string, seed: number, pid: number, map: ReturnType<(typeof MAPS)[string]>, said: (text: string, obs: ShooterObservation) => void) {
    super(bot, label, seed, pid, map, { timeLimits: false });
    this.said = said;
  }

  override decide(obs: ShooterObservation): ReturnType<ShooterBatchController['decide']> {
    const out = super.decide(obs);
    if (Array.isArray(out.value)) for (const c of out.value as ShooterCommand[]) if (c.type === 'say') this.said(c.text, obs);
    return out;
  }
}

const compiled = new Map<string, CompiledBot>();
function load(path: string): CompiledBot {
  let c = compiled.get(path);
  if (c === undefined) {
    c = compileBot(readFileSync(path, 'utf8'), path);
    compiled.set(path, c);
  }
  return c;
}

function play(j: Job): GameOut {
  const map = MAPS[j.map]();
  const isA = (pid: number): boolean => (pid < TEAM_SIZE) === j.aFirst;
  const specs = (pid: number) => balancedLineup(isA(pid) ? j.lineupA : j.lineupB)[pid % TEAM_SIZE];
  const seats = Array.from({ length: PLAYER_COUNT }, (_, pid) => derivePlayer(specs(pid)));
  /** 回合 → T 指揮喊的計畫 */
  const planOf = new Map<number, string>();
  let curRound = 0;
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => new Spy(load(isA(pid) ? j.a : j.b), isA(pid) ? 'a' : 'b', j.seed, pid, map, (text, obs) => {
    if (obs.me.team === 'T' && text.startsWith('P:') && !planOf.has(obs.round.number)) planOf.set(obs.round.number, /^P:(rush|split|default|fake|go)/.exec(text)?.[1] ?? '?');
  }));
  const knobs = controllers.map((c, pid) => resolveKnobs(c.declaration, Object.fromEntries(Object.entries(seats[pid].knobs).filter(([k]) => c.declaration.knobs.some((d) => d.key === k))), c.label));
  const d = new ShooterDriver({ seed: j.seed, mapId: j.map, ...formatOptions(j.format), controllers, knobs, record: false, attributes: seats.map((s) => s.attributes) });
  const m = d.match;
  const groupOf = (pid: number): 0 | 1 => (pid < TEAM_SIZE ? 0 : 1);
  /** 回合 → 組 → 開打時主武器數 */
  const liveGear = new Map<number, [number, number][]>();
  const defuseDelay: GameOut['defuseDelay'] = [];
  const entries: GameOut['entries'] = [];
  const smokePairs: number[] = [];
  const idle = { t10: 0, t20: 0, ct10: 0, ct20: 0, n: 0 };
  let wipes = 0;
  let tRounds = 0;
  let liveTick = -1;
  let startPos: { x: number; y: number }[] = [];
  let wipedAt = -1;
  let defuseSeen = false;
  let plantedTick = -1;
  const seenSmoke = new Set<object>();
  let smokesNow: { team: number; x: number; y: number }[] = [];
  const entered = new Map<number, { site: string; region: string }>();
  const lastOut = new Map<number, string>();
  const inSite = (x: number, y: number): string | null => {
    const cx = Math.floor(x / UNIT);
    const cy = Math.floor(y / UNIT);
    for (const s of m.map.sites) if (cx >= s.x0 && cx < s.x1 && cy >= s.y0 && cy < s.y1) return s.id;
    return null;
  };
  const flushRound = (round: number): void => {
    if (round <= 0) return;
    const kind = planOf.get(round) ?? '?';
    const bySite = new Map<string, Set<string>>();
    const count = new Map<string, number>();
    for (const e of entered.values()) {
      if (!bySite.has(e.site)) bySite.set(e.site, new Set());
      bySite.get(e.site)!.add(e.region);
      count.set(e.site, (count.get(e.site) ?? 0) + 1);
    }
    for (const [s, n] of count) if (n >= 3) entries.push({ kind, n, regions: bySite.get(s)!.size });
    for (const team of [0, 1]) {
      const list = smokesNow.filter((x) => x.team === team);
      for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) smokePairs.push(Math.hypot(list[i].x - list[k].x, list[i].y - list[k].y) / UNIT);
    }
    // 團滅：T 在下包前死的人（8 秒、14 格內 ≥ 4）
    const tg = m.rounds.find((r) => r.number === round)?.tGroup ?? 0;
    const dead = m.kills.filter((k) => k.round === round && groupOf(k.victim) === tg && (plantedTick < 0 || k.tick < plantedTick));
    tRounds++;
    for (let i = 0; i + 3 < dead.length; i++) {
      const w = dead.slice(i, i + 4);
      if (w[3].tick - w[0].tick <= 8 * 30) {
        wipes++;
        break;
      }
    }
    entered.clear();
    lastOut.clear();
    smokesNow = [];
  };
  while (!m.over) {
    d.step();
    if (m.roundNumber !== curRound) {
      flushRound(curRound);
      curRound = m.roundNumber;
      liveTick = -1;
      wipedAt = -1;
      defuseSeen = false;
      plantedTick = -1;
    }
    if (m.phase === 'live' && liveTick < 0) {
      liveTick = m.tick;
      startPos = m.players.map((p) => ({ x: p.x, y: p.y }));
      const g: [number, number][] = [[0, 0], [0, 0]];
      for (const p of m.players) {
        if (p.primary !== null) g[groupOf(p.id)][0]++;
        if (p.armor > 0) g[groupOf(p.id)][1]++;
      }
      liveGear.set(curRound, g);
    }
    if (liveTick < 0 || m.phase === 'over' || m.phase === 'freeze') continue;
    const el = m.tick - liveTick;
    if (el === 300 || el === 600) {
      for (const p of m.players) {
        if (!p.alive) continue;
        const moved = Math.hypot(p.x - startPos[p.id].x, p.y - startPos[p.id].y) / UNIT;
        if (el === 300) idle.n++;
        if (moved < 5) {
          const k = (p.team === 'T' ? 't' : 'ct') + (el === 300 ? '10' : '20');
          idle[k as 't10']++;
        }
      }
    }
    for (const s of m.smokes) {
      if (seenSmoke.has(s)) continue;
      seenSmoke.add(s);
      smokesNow.push({ team: groupOf(s.owner), x: s.x, y: s.y });
    }
    if (m.bomb.state === 'planted' && plantedTick < 0) plantedTick = m.tick;
    const tAlive = m.players.filter((p) => p.team === 'T' && p.alive).length;
    const ctAlive = m.players.filter((p) => p.team === 'CT' && p.alive).length;
    if (plantedTick >= 0 && tAlive === 0 && ctAlive > 0 && wipedAt < 0) wipedAt = m.tick;
    if (wipedAt >= 0 && !defuseSeen && m.players.some((p) => p.team === 'CT' && p.alive && p.defuseTicks > 0)) {
      defuseSeen = true;
      defuseDelay.push({ sec: (m.tick - wipedAt) / 30, exploded: false });
    }
    for (const p of m.players) {
      if (p.team !== 'T' || !p.alive || entered.has(p.id)) continue;
      const s = inSite(p.x, p.y);
      if (s === null) lastOut.set(p.id, regionsAt(m.map, p.x, p.y)[0] ?? '');
      else entered.set(p.id, { site: s, region: lastOut.get(p.id) ?? '' });
    }
  }
  flushRound(curRound);
  const rs = m.rounds;
  // 全滅了還炸掉（一直沒開始拆）
  for (const r of rs) {
    const dead = m.kills.filter((k) => k.round === r.number && k.weapon !== 'bomb' && groupOf(k.victim) === r.tGroup).length;
    if (r.reason === 'bomb' && dead >= TEAM_SIZE) defuseDelay.push({ sec: -1, exploded: true });
  }
  const res = m.result();
  const ga = j.aFirst ? 0 : 1;
  const pistol: PistolLoss[] = [];
  for (const first of [1, m.roundsPerHalf + 1]) {
    const r1 = rs[first - 1];
    const r2 = rs[first];
    const r3 = rs[first + 1];
    if (r1 === undefined || r2 === undefined || r3 === undefined) continue;
    const loser = (1 - r1.winnerGroup) as 0 | 1;
    const g2 = liveGear.get(first + 1)?.[loser] ?? [0, 0];
    const g3 = liveGear.get(first + 2)?.[loser] ?? [0, 0];
    pistol.push({ isA: loser === ga, side: r2.tGroup === loser ? 'T' : 'CT', guns2: g2[0], armor2: g2[1], won2: r2.winnerGroup === loser, guns3: g3[0], won3: r3.winnerGroup === loser, matchWon: res.winner === loser });
  }
  const plans: Record<string, [number, number]> = {};
  for (const r of rs) {
    const k = planOf.get(r.number) ?? '?';
    const st = (plans[k] ??= [0, 0]);
    st[0]++;
    if (r.winner === 'T') st[1]++;
  }
  return {
    rounds: rs.length,
    tWins: rs.filter((r) => r.winner === 'T').length,
    exceptions: d.runtime.reduce((s, x) => s + x.exceptions, 0),
    aMatch: res.winner === null ? 0.5 : res.winner === ga ? 1 : 0,
    aRounds: rs.filter((r) => r.winnerGroup === ga).length,
    pistol,
    defuseDelay,
    entries,
    wipes,
    tRounds,
    smokePairs,
    idle,
    plans,
  };
}

if (!isMainThread && (workerData as { behavior?: boolean } | null)?.behavior === true) {
  for (const j of (workerData as { jobs: Job[] }).jobs) parentPort!.postMessage(play(j));
} else if (isMainThread) {
  const a = arg('a', 'bots/shooter-baseline.js');
  const b = arg('b', a);
  const lineup = Number(arg('lineup', '3'));
  const lineupB = Number(arg('lineupb', String(lineup)));
  const maps = arg('maps', 'redrock').split(',');
  const nSeeds = Number(arg('seeds', '100'));
  const from = Number(arg('from', '1'));
  const jobsN = Number(arg('jobs', '10'));
  const format = arg('format', LEAGUE_FORMAT_ID);
  const list: Job[] = [];
  const both = a !== b || lineup !== lineupB;
  for (const map of maps) for (let s = 0; s < nSeeds; s++) for (const aFirst of both ? [true, false] : [true]) list.push({ a, b, lineupA: lineup, lineupB, map, seed: from + s, aFirst, format });
  const games: GameOut[] = [];
  const buckets: Job[][] = Array.from({ length: Math.min(jobsN, list.length) }, () => []);
  list.forEach((x, k) => buckets[k % buckets.length].push(x));
  await Promise.all(buckets.map((bk) => new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { behavior: true, jobs: bk }, argv: process.argv.slice(2) });
    w.on('message', (g: GameOut) => games.push(g));
    w.on('error', reject);
    w.on('exit', () => resolve());
  })));
  const pct = (x: number, n: number): string => `${n === 0 ? '—' : ((100 * x) / n).toFixed(1)}%（${x}／${n}）`;
  const sum = (f: (g: GameOut) => number): number => games.reduce((s, g) => s + f(g), 0);
  const nRounds = sum((g) => g.rounds);
  console.log(`${a} 對 ${b}：${games.length} 場 ${nRounds} 回合；例外 ${sum((g) => g.exceptions)}；A 整場 ${(100 * sum((g) => g.aMatch) / games.length).toFixed(1)}%、回合 ${pct(sum((g) => g.aRounds), nRounds)}；T 回合 ${pct(sum((g) => g.tWins), nRounds)}`);
  const report: Record<string, unknown> = {};
  for (const who of both ? [true, false] : [true, false]) {
    for (const side of ['T', 'CT'] as const) {
      const ps = games.flatMap((g) => g.pistol).filter((p) => p.side === side && (!both || p.isA === who));
      if (!both && !who) continue;
      const line = `手槍局輸家${both ? (who ? '（A）' : '（B）') : ''}第二回合當 ${side}：${ps.length} 次；主武器 ${(ps.reduce((s, p) => s + p.guns2, 0) / Math.max(1, ps.length)).toFixed(2)}、護甲 ${(ps.reduce((s, p) => s + p.armor2, 0) / Math.max(1, ps.length)).toFixed(2)}；第二回合勝 ${pct(ps.filter((p) => p.won2).length, ps.length)}；第三回合主武器 ${(ps.reduce((s, p) => s + p.guns3, 0) / Math.max(1, ps.length)).toFixed(2)}、勝 ${pct(ps.filter((p) => p.won3).length, ps.length)}；整場 ${pct(ps.filter((p) => p.matchWon).length, ps.length)}`;
      console.log(line);
      report[`pistol${who ? 'A' : 'B'}${side}`] = line;
    }
  }
  const dd = games.flatMap((g) => g.defuseDelay);
  const ok = dd.filter((x) => !x.exploded).map((x) => x.sec).sort((p, q) => p - q);
  console.log(`全滅即拆：${dd.length} 次；開始拆平均 ${(ok.reduce((s, x) => s + x, 0) / Math.max(1, ok.length)).toFixed(2)} 秒、中位 ${(ok[Math.floor(ok.length / 2)] ?? 0).toFixed(2)}、P90 ${(ok[Math.floor(ok.length * 0.9)] ?? 0).toFixed(2)}；來不及炸掉 ${dd.filter((x) => x.exploded).length}`);
  const es = games.flatMap((g) => g.entries);
  const non = es.filter((e) => e.kind !== 'rush');
  console.log(`同路：非 rush、≥ 3 人進點的回合 ${non.length}，全從同區域進 ${pct(non.filter((e) => e.regions === 1).length, non.length)}；rush ${es.length - non.length}；團滅（T 下包前 8 秒死 4 人）${pct(sum((g) => g.wipes), sum((g) => g.tRounds))}`);
  const sp = games.flatMap((g) => g.smokePairs);
  console.log(`煙霧：同隊同回合兩顆煙 ${sp.length} 對，< 6 格 ${pct(sp.filter((x) => x < 6).length, sp.length)}、< 3 格 ${pct(sp.filter((x) => x < 3).length, sp.length)}`);
  const n10 = sum((g) => g.idle.n);
  console.log(`發呆：開打 10 秒還在起點 5 格內 T ${pct(sum((g) => g.idle.t10), n10 / 2)}、CT ${pct(sum((g) => g.idle.ct10), n10 / 2)}；20 秒 T ${sum((g) => g.idle.t20)}、CT ${sum((g) => g.idle.ct20)}`);
  const plans: Record<string, [number, number]> = {};
  for (const g of games) for (const [k, [n, w]] of Object.entries(g.plans)) {
    const st = (plans[k] ??= [0, 0]);
    st[0] += n;
    st[1] += w;
  }
  console.log(`計畫：${Object.entries(plans).map(([k, [n, w]]) => `${k} ${n} 回合 T 勝 ${((100 * w) / n).toFixed(0)}%`).join('、')}`);
  const outPath = arg('out', '');
  if (outPath !== '') {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ a, b, maps, nSeeds, games: games.length, report, plans, dd: ok }, null, 1));
  }
}
