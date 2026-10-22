// 觀賞性指標（M3 過關條件「連看 10 場不無聊；勝率分布有懸念」的客觀輔助，不取代實際觀看）。
// 以目前的引擎（批次模式）讓選手兩兩對戰，逐 tick 用轉播的交戰強度計量，統計每場的節奏與懸念。
// 用法：node scripts/watchability.ts <輸出 JSON> <每組場數（偶數）> <bot.js…>
// 環境變數：RULESET=conquest 改用搶點模式；KNOBS=JSON 陣列（依 bot 順序，null 為預設）同一個檔案可用不同旋鈕當不同選手
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMBAT_UNIT_TYPES, CONQUEST, RULES, UNIT_STATS, type Ruleset } from '../src/config/index.ts';
import type { KnobValues } from '../src/api/types.ts';
import type { MatchState } from '../src/core/state.ts';
import { BatchController, resolveKnobs } from '../src/sandbox/controller.ts';
import { loadBotFile } from '../src/sandbox/node-loader.ts';
import { MatchDriver } from '../src/sandbox/runner.ts';
import { CombatMeter } from '../src/view/broadcast.ts';

const [outFile, gamesArg, ...botPaths] = process.argv.slice(2);
const GAMES = Number(gamesArg);
if (botPaths.length < 2 || !Number.isInteger(GAMES) || GAMES < 2 || GAMES % 2 !== 0) {
  process.stderr.write('用法：node scripts/watchability.ts <輸出 JSON> <每組場數（偶數）> <bot.js…>\n');
  process.exit(1);
}
const SEED = 7000;
const RULESET: Ruleset = process.env.RULESET === 'conquest' ? 'conquest' : 'classic';
const KNOBS: (KnobValues | null)[] = process.env.KNOBS === undefined ? [] : (JSON.parse(process.env.KNOBS) as (KnobValues | null)[]);
const TIME_LIMIT = RULESET === 'conquest' ? CONQUEST.timeLimitTicks : RULES.match.timeLimitTicks;
// 實驗用：CONQUEST_OVERRIDE=JSON 在本次執行中覆寫搶點模式的數值（只影響這支腳本，不改設定檔）
if (process.env.CONQUEST_OVERRIDE !== undefined) Object.assign(CONQUEST as unknown as Record<string, unknown>, JSON.parse(process.env.CONQUEST_OVERRIDE) as Record<string, unknown>);
/** 兵力差超過此值（礦）才算領先易手，避免小幅波動 */
const LEAD_MARGIN = 300;
/** 逆轉：勝方曾在兵力上落後到對手的這個比例以下 */
const COMEBACK_RATIO = 60;
const COMBAT = COMBAT_UNIT_TYPES as readonly string[];

function armyValues(s: MatchState): number[] {
  const out = s.players.map(() => 0);
  for (const u of s.units) if (COMBAT.includes(u.type)) out[u.owner] += UNIT_STATS[u.type].cost;
  return out;
}

interface GameWatch {
  seed: number;
  seats: [number, number];
  winner: number;
  durationTicks: number;
  eliminated: boolean;
  firstFightTick: number | null;
  fights: number;
  quietPct: number;
  peakLevel: number;
  leadChanges: number;
  /** 搶點模式：勝利點領先易手次數 */
  vpLeadChanges: number;
  /** 搶點模式：壓制倒數開始／被中斷的次數 */
  domStarts: number;
  domBroken: number;
  comeback: boolean;
}

async function play(seed: number, seats: [number, number]): Promise<GameWatch> {
  const files = seats.map((b) => loadBotFile(resolve(botPaths[b])));
  const controllers = files.map((f) => new BatchController(f.compiled, f.label));
  const knobs = controllers.map((c, i) => resolveKnobs(c.declaration, KNOBS[seats[i]] ?? undefined, c.label));
  const d = new MatchDriver({ mode: '1v1', seed, controllers, knobs, record: false, ruleset: RULESET });
  await d.init();
  const meter = new CombatMeter();
  let fighting = false;
  let firstFightTick: number | null = null;
  let fights = 0;
  let quiet = 0;
  let peak = 0;
  let leader = -1;
  let leadChanges = 0;
  let vpLeader = -1;
  let vpLeadChanges = 0;
  let domStarts = 0;
  let domBroken = 0;
  const prevDom = [0, 0];
  const minRatio = [Infinity, Infinity];
  while (!d.match.over) {
    await d.stepTick();
    const s = d.match.state;
    meter.update(s);
    if (meter.quiet) quiet += 1;
    peak = Math.max(peak, meter.level);
    if (!fighting && meter.fighting) {
      fighting = true;
      fights += 1;
      if (firstFightTick === null) firstFightTick = s.tick;
    } else if (fighting && meter.quiet) fighting = false;
    if (RULESET === 'conquest') {
      for (const p of [0, 1]) {
        const d = s.players[p].domination;
        if (d === 1) domStarts += 1;
        if (d === 0 && prevDom[p] > 0 && !s.over) domBroken += 1;
        prevDom[p] = d;
      }
    }
    if (RULESET === 'conquest' && s.tick % 10 === 0) {
      const [v0, v1] = [s.players[0].vp, s.players[1].vp];
      const margin = 30;
      const lead = v0 - v1 >= margin ? 0 : v1 - v0 >= margin ? 1 : vpLeader;
      if (lead !== vpLeader) {
        if (vpLeader !== -1) vpLeadChanges += 1;
        vpLeader = lead;
      }
    }
    const army = armyValues(s);
    for (const p of [0, 1]) {
      const q = 1 - p;
      if (army[q] >= LEAD_MARGIN) minRatio[p] = Math.min(minRatio[p], Math.floor((army[p] * 100) / army[q]));
      if (army[p] - army[q] >= LEAD_MARGIN && leader !== p) {
        if (leader !== -1) leadChanges += 1;
        leader = p;
      }
    }
  }
  const r = d.match.result();
  const winner = r.ranking[0];
  return {
    seed,
    seats,
    winner: seats[winner],
    durationTicks: r.durationTicks,
    eliminated: r.players.some((p) => p.eliminatedTick >= 0),
    firstFightTick,
    fights,
    quietPct: Math.round((quiet * 1000) / r.durationTicks) / 10,
    peakLevel: Math.round(peak * 10) / 10,
    leadChanges,
    vpLeadChanges,
    domStarts,
    domBroken,
    comeback: minRatio[winner] < COMEBACK_RATIO,
  };
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
}

function summarize(gs: GameWatch[]): Record<string, number | null> {
  const ff = gs.map((g) => g.firstFightTick).filter((t): t is number => t !== null);
  return {
    games: gs.length,
    avgDurationTicks: mean(gs.map((g) => g.durationTicks)),
    eliminationPct: mean(gs.map((g) => (g.eliminated ? 100 : 0))),
    timeLimitPct: mean(gs.map((g) => (g.durationTicks >= TIME_LIMIT ? 100 : 0))),
    avgFirstFightTick: mean(ff),
    avgFights: mean(gs.map((g) => g.fights)),
    avgQuietPct: mean(gs.map((g) => g.quietPct)),
    avgPeakLevel: mean(gs.map((g) => g.peakLevel)),
    avgLeadChanges: mean(gs.map((g) => g.leadChanges)),
    avgVpLeadChanges: mean(gs.map((g) => g.vpLeadChanges)),
    avgDomStarts: mean(gs.map((g) => g.domStarts)),
    avgDomBroken: mean(gs.map((g) => g.domBroken)),
    comebackPct: mean(gs.map((g) => (g.comeback ? 100 : 0))),
  };
}

const names = botPaths.map((p, i) => {
  const c = new BatchController(loadBotFile(resolve(p)).compiled, p);
  const k = KNOBS[i];
  return `${c.declaration.name} ${c.declaration.version ?? ''}${k !== undefined && k !== null ? ` ${JSON.stringify(k)}` : ''}`.trim();
});
const pairs: { a: number; b: number; winRateA: number; watch: Record<string, number | null> }[] = [];
const all: GameWatch[] = [];
for (let a = 0; a < botPaths.length; a++) {
  for (let b = a + 1; b < botPaths.length; b++) {
    const gs: GameWatch[] = [];
    for (let k = 0; k < GAMES / 2; k++) {
      gs.push(await play(SEED + k, [a, b]));
      gs.push(await play(SEED + k, [b, a]));
    }
    all.push(...gs);
    const winRateA = Math.round((gs.filter((g) => g.winner === a).length * 1000) / gs.length) / 10;
    pairs.push({ a, b, winRateA, watch: summarize(gs) });
    process.stderr.write(`${names[a]} vs ${names[b]}：${winRateA}%\n`);
  }
}
const close = pairs.filter((p) => p.winRateA >= 30 && p.winRateA <= 70).length;
writeFileSync(
  outFile,
  JSON.stringify({ bots: names, gamesPerPair: GAMES, overall: summarize(all), closePairs: `${close}/${pairs.length}（勝率 30%～70%）`, pairs, games: all }, null, 1),
);
