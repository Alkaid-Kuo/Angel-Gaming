// 軍團戰文字追蹤：跑一場，每隔幾秒印出每一團的位置、人數、狀態、指令、意圖，以及期間發生的事件（除錯用，上帝視角）。
// 用法：
//   node trace.ts <A.js> <B.js> [--mode siege|capture] [--map 地圖id] [--seed S] [--swap] [--every 秒] [--until 秒]
//                 [--side 0|1] [--events none|key|all] [--knobs-a JSON] [--knobs-b JSON]
//   預設：攻城戰（石關城）、A 坐藍方（playerId 0，西側；攻城戰的攻方）；--swap 讓 A 坐紅方（守方）。每 10 秒印一次，事件印 key（重要事件）。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { KnobValues } from './src/api/types.ts';
import type { LegionEvent } from './src/legion/api.ts';
import { MODE_NAMES, RULES, TILE, type LegionMode } from './src/legion/config.ts';
import { LEAGUE_MAPS, MAPS, defaultMapId } from './src/legion/map.ts';
import { LegionBatchController, LegionDriver } from './src/legion/runner.ts';
import type { Regiment } from './src/legion/sim.ts';
import { BotLoadError, compileBot } from './src/sandbox/compile.ts';
import { resolveKnobs } from './src/sandbox/controller.ts';

function fail(msg: string, code: number): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const positional: string[] = [];
const opts: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--swap') opts[a] = '1';
  else if (a.startsWith('--')) {
    if (i + 1 >= args.length) fail(`${a} 缺少值`, 1);
    opts[a] = args[++i];
  } else positional.push(a);
}
const KNOWN = ['--mode', '--map', '--seed', '--swap', '--every', '--until', '--side', '--events', '--knobs-a', '--knobs-b'];
for (const k of Object.keys(opts)) if (!KNOWN.includes(k)) fail(`不認得的參數 ${k}`, 1);
if (positional.length !== 2) fail('用法：node trace.ts <A.js> <B.js> [--mode siege|capture] [--map 地圖id] [--seed S] [--swap] [--every 秒] [--until 秒] [--side 0|1] [--events none|key|all] [--knobs-a JSON] [--knobs-b JSON]', 1);

const mode = (opts['--mode'] ?? 'siege') as LegionMode;
if (mode !== 'siege' && mode !== 'capture') fail('--mode 只能是 siege 或 capture', 1);
const mapId = opts['--map'] ?? defaultMapId(mode);
if (!LEAGUE_MAPS[mode].includes(mapId)) fail(`--map 只能是 ${LEAGUE_MAPS[mode].join('、')}`, 1);
const seed = Number(opts['--seed'] ?? 1);
const every = Math.max(1, Math.round(Number(opts['--every'] ?? 10) * 10));
const until = opts['--until'] !== undefined ? Math.round(Number(opts['--until']) * 10) : Infinity;
const sideFilter = opts['--side'] !== undefined ? Number(opts['--side']) : -1;
const eventsMode = opts['--events'] ?? 'key';
if (!['none', 'key', 'all'].includes(eventsMode)) fail('--events 只能是 none、key 或 all', 1);
if (!Number.isInteger(seed) || !Number.isFinite(every)) fail('--seed、--every 必須是數字', 1);

function knobsOf(flag: string): KnobValues | undefined {
  const raw = opts[flag];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as KnobValues;
  } catch (e) {
    return fail(`${flag} 不是合法的 JSON：${(e as Error).message}`, 1);
  }
}

const swap = opts['--swap'] !== undefined;
const entries = [
  { path: positional[0], knobs: knobsOf('--knobs-a'), tag: 'A' },
  { path: positional[1], knobs: knobsOf('--knobs-b'), tag: 'B' },
];
const seats = swap ? [entries[1], entries[0]] : entries;
const map = MAPS[mapId]();
let ctrls: LegionBatchController[];
let knobs: KnobValues[];
try {
  ctrls = seats.map((s, i) => {
    let src: string;
    try {
      src = readFileSync(s.path, 'utf8');
    } catch (e) {
      return fail(`無法讀取選手檔案 ${s.path}：${(e as Error).message}`, 2);
    }
    return new LegionBatchController(compileBot(src, basename(s.path)), basename(s.path), map, seed, i);
  });
  knobs = ctrls.map((c, i) => resolveKnobs(c.declaration, seats[i].knobs, c.label));
} catch (e) {
  if (e instanceof BotLoadError) fail(`選手載入失敗：${e.message}`, 2);
  throw e;
}

const SIDE = ['藍', '紅'];
const d = new LegionDriver({ seed, mode, mapId, controllers: ctrls, knobs, record: false });
const m = d.match;
const out = (s: string): boolean => process.stdout.write(`${s}\n`);
const t = (tick: number): string => `${(tick / 10).toFixed(1).padStart(6)}s`;
const regName = (id: number): string => {
  const r = m.regiments[id];
  return r === undefined ? `#${id}` : `${SIDE[r.owner]}${r.id}(${r.kind})`;
};

out(`${MODE_NAMES[mode]}（${mode}）・地圖 ${map.name}（${map.id}）・種子 ${seed}`);
out(`藍方（playerId 0，西）= ${seats[0].tag} ${ctrls[0].label}；紅方（playerId 1，東）= ${seats[1].tag} ${ctrls[1].label}`);
out('座標單位為格（1 格 = 1000），角度 0 = 東、90 = 南；血% 為全團剩餘血量 ÷ 目前人數的上限；「見」= 對手看得到這一團');

const KEY = new Set(['deployRejected', 'rejected', 'impact', 'ambush', 'destroyed', 'levelUp', 'flag', 'enter', 'withdraw', 'gate', 'ladder', 'ramHit', 'bombard']);
function eventText(e: LegionEvent): string {
  switch (e.type) {
    case 'deployRejected':
      return `布陣被拒 ${SIDE[e.player]}方 第 ${e.index} 個：${e.reason}`;
    case 'rejected':
      return `指令被拒 ${SIDE[e.player]}方 ${e.command}：${e.reason}`;
    case 'contact':
      return `接戰 ${regName(e.a)} → ${regName(e.b)}（${e.flank}）`;
    case 'impact':
      return `衝刺結束 ${regName(e.reg)} ${e.kind} 撞 ${regName(e.target)}（${e.flank}）殺 ${e.kills}、擊倒 ${e.downed}${e.braced ? '、撞上槍林' : ''}`;
    case 'ambush':
      return `埋伏 ${regName(e.reg)}`;
    case 'routed':
      return `潰散 ${regName(e.reg)}`;
    case 'destroyed':
      return `覆滅 ${regName(e.reg)}`;
    case 'levelUp':
      return `升級 ${regName(e.reg)} → ${e.level} 級`;
    case 'skill':
      return `技能 ${regName(e.reg)} ${e.skill}`;
    case 'flag':
      return `旗點 ${m.flags[e.flag]?.name ?? e.flag} → ${SIDE[e.owner]}方佔領`;
    case 'enter':
      return `入場 ${regName(e.reg)}（${e.at < 0 ? '出生點' : `補給站 ${e.at}`}）`;
    case 'withdraw':
      return `撤回 ${regName(e.reg)}（${e.at < 0 ? '出生點' : `補給站 ${e.at}`}）`;
    case 'gate':
      return `城門 ${e.gate} → ${e.state}`;
    case 'ladder':
      return `雲梯 ${e.ladder}（${SIDE[e.owner]}方）${e.state}${e.state === 'toppled' ? `，摔下 ${e.fell} 人` : ''}`;
    case 'ramHit':
      return `衝車撞城門 ${e.gate}，剩 ${e.hp}`;
    case 'bombard':
      return `砲擊 ${e.state === 'fired' ? '下令' : `落地（${e.hit} 人）`} (${(e.x / TILE).toFixed(1)}, ${(e.y / TILE).toFixed(1)})`;
  }
}

function showEvent(e: LegionEvent): void {
  if (eventsMode === 'none' || (eventsMode === 'key' && !KEY.has(e.type))) return;
  if (sideFilter >= 0) {
    const owner = 'player' in e ? e.player : 'reg' in e ? m.regiments[e.reg]?.owner : 'a' in e ? m.regiments[e.a]?.owner : -1;
    if (e.type !== 'flag' && owner !== sideFilter && !('b' in e && m.regiments[e.b]?.owner === sideFilter)) return;
  }
  out(`${t(e.tick)}  · ${eventText(e)}`);
}

for (const e of m.events) showEvent(e);
m.eventTap = showEvent;

const f1 = (v: number): string => (v / TILE).toFixed(1);
function regLine(r: Regiment): string {
  const sids = r.reserve ? r.parked : r.slots;
  let hp = 0;
  for (const sid of sids) hp += m.soldiers[sid].hp;
  const hpMax = Math.floor((sids.length * r.def.hp * RULES.veteran.levels[r.level - 1].hp) / 100);
  const order = r.dash !== null ? r.dash.def.kind : r.order;
  const cd = Math.max(0, r.skillReadyAt - m.tick);
  const seen = r.reserve ? '-' : m.visible[1 - r.owner][r.id] === 1 ? '見' : '　';
  const pos = r.reserve ? (r.enterAt >= 0 ? `入場倒數 ${((r.enterAt - m.tick) / 10).toFixed(1)}s` : '後備') : `(${f1(r.x).padStart(5)}, ${f1(r.y).padStart(5)})`;
  const intent = r.intent !== '' ? `「${r.intent}」${((m.tick - r.intentAt) / 10).toFixed(0)}s 前` : '';
  return [
    ` ${SIDE[r.owner]} ${String(r.id).padStart(3)} ${r.kind.padEnd(8)}`,
    pos.padEnd(16),
    String(r.facing).padStart(3),
    `${String(sids.length).padStart(2)}/${String(r.men0).padEnd(2)}`,
    `${hpMax > 0 ? Math.round((hp * 100) / hpMax) : 0}%`.padStart(4),
    r.formation.padEnd(6),
    (r.stance ?? '-').padEnd(5),
    m.regimentStatus(r).padEnd(12),
    order.padEnd(10),
    (r.target >= 0 ? String(r.target) : '-').padStart(3),
    `L${r.level}`,
    `cd${String(Math.ceil(cd / 10)).padStart(2)}`,
    seen,
    intent,
  ].join(' ');
}

function snapshot(): void {
  const kv = m.players.map((p) => Math.floor(p.killValue / 1000));
  const head = [`=== ${t(m.tick)}（tick ${m.tick}）`, `兵力 藍 ${m.strength(0)} / 紅 ${m.strength(1)}`, `戰果 藍 ${kv[0]} / 紅 ${kv[1]}`];
  if (mode === 'capture') head.push(`分數 藍 ${m.scoreOf(0)} / 紅 ${m.scoreOf(1)}`, `場上點數 藍 ${m.fieldCost(0)} / 紅 ${m.fieldCost(1)}`);
  if (mode === 'siege') head.push(`剩 ${((m.timeLimitTicks - m.tick) / 10).toFixed(0)} 秒`);
  out(head.join('  '));
  if (mode === 'siege') {
    out(
      `  旗：${m.flags.map((f) => `${f.id === 0 ? 'A' : 'B'} ${f.name} ${f.owner === m.map.defender ? '守方持有' : '攻方已佔'} 進度 ${f.progress}/${f.need}${m.flagOpen(f) ? '' : '（鎖定）'}${f.contested ? ' 爭奪中' : ''}`).join('｜')}`,
    );
    const st = m.structures();
    out(`  城門：${st.gates.map((g) => `${g.kind} ${g.state} ${g.hp}/${g.hpMax}`).join('｜')}；雲梯 ${st.ladders.length} 座；衝車 ${st.ram === null ? '無' : `(${f1(st.ram.x)}, ${f1(st.ram.y)}) 推的團 ${st.ram.crew ?? '無'}`}；砲擊剩 ${st.bombardsLeft} 發`);
  }
  if (mode === 'capture') {
    out(
      `  旗：${m.flags
        .map((f) => `${f.name} 佔領=${f.owner < 0 ? '無' : SIDE[f.owner]} 正在佔=${f.capturer < 0 ? '無' : SIDE[f.capturer]} 進度 ${f.progress}/${RULES.capture.captureTicks}${f.contested ? ' 爭奪中' : ''}`)
        .join('｜')}`,
    );
  }
  out(`  戰略意圖：藍「${m.players[0].plan}」 紅「${m.players[1].plan}」`);
  out('  方  id 兵種     位置(格)         朝向 人數  血% 陣形   姿態  狀態         指令       目標 級 冷卻 見 意圖');
  for (const r of m.regiments) {
    if (r.destroyed || (sideFilter >= 0 && r.owner !== sideFilter)) continue;
    out(regLine(r));
  }
}

snapshot();
while (!m.over && m.tick < until) {
  d.step();
  if (m.tick % every === 0 || m.over) snapshot();
}
for (const [p, rt] of d.runtime.entries()) {
  const avg = rt.decisions > 0 ? rt.decideMsTotal / rt.decisions : 0;
  out(`${SIDE[p]}方 ${ctrls[p].label}：decide ${rt.decisions} 次，平均 ${avg.toFixed(2)} ms、最長 ${rt.decideMsMax.toFixed(2)} ms；例外 ${rt.exceptions}${rt.killed ? '；逾時（整場閒置）' : ''}`);
  for (const e of rt.errors) out(`  ${e}`);
}
if (m.over) {
  const r = m.result();
  out(`結果：${r.winner === null ? '平手' : `${SIDE[r.winner]}方（${ctrls[r.winner].label}）勝`}，原因 ${r.reason}，${(r.durationTicks / 10).toFixed(1)} 秒；戰果 藍 ${r.killValue[0]} / 紅 ${r.killValue[1]}${mode === 'capture' ? `；分數 藍 ${r.score[0]} / 紅 ${r.score[1]}` : ''}`);
} else out(`在 ${(m.tick / 10).toFixed(1)} 秒停止（--until）`);
