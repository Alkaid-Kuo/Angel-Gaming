/// <reference lib="webworker" />
// 軍團戰觀戰 Worker：執行比賽（三隻基準 AI）、產生解說，依播放速度把每個 tick 的畫面資料送回主執行緒。
import ambushSource from '../../../bots/legion-ambush.js?raw';
import commanderSource from '../../../bots/legion-commander.js?raw';
import pushSource from '../../../bots/legion-push.js?raw';
import rangedSource from '../../../bots/legion-ranged.js?raw';
import type { LegionEvent } from '../../legion/api.ts';
import { TPS, UNITS } from '../../legion/config.ts';
import { MAPS } from '../../legion/map.ts';
import { LegionBatchController, LegionDriver, type LegionController } from '../../legion/runner.ts';
import type { LegionMatch } from '../../legion/sim.ts';
import { compileBot, type CompiledBot } from '../../sandbox/compile.ts';
import { resolveKnobs } from '../../sandbox/controller.ts';
import { LegionCommentator } from './commentary.ts';
import { PlayerController } from './player.ts';
import type { BotKey, Caption, FromLegionWorker, LegionFrame, LegionMeta, LegionSetup, PlayerMeta, RegFrame, RegStatic, ToLegionWorker } from './protocol.ts';
import { ATTACKED_BIT, DOWN_BIT } from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromLegionWorker, transfer: Transferable[] = []): void => ctx.postMessage(msg, transfer);

const compiled: Record<BotKey, CompiledBot> = {
  push: compileBot(pushSource, 'legion-push.js'),
  ambush: compileBot(ambushSource, 'legion-ambush.js'),
  ranged: compileBot(rangedSource, 'legion-ranged.js'),
  commander: compileBot(commanderSource, 'legion-commander.js'),
};
const SIDES = ['藍方', '紅方'];
const COLORS = ['#3b82f6', '#ef4444'];
/** 每次迴圈最多推進的 tick（避免高速時卡住主執行緒訊息） */
const MAX_STEPS_PER_LOOP = 40;
/** 「跳到下一場交戰」最多快轉的 tick */
const SKIP_LIMIT = 900;
/** 「跳到下一場交戰」至少快轉的 tick */
const SKIP_MIN = 30;

let setup: LegionSetup | null = null;
/** 玩家指揮時的控制器 */
let player: PlayerController | null = null;
/** 玩家指揮哪一方（-1 = 純觀戰） */
let playerSide = -1;
let driver: LegionDriver | null = null;
let comm: LegionCommentator | null = null;
let speed = 1;
let paused = true;
let acc = 0;
let last = 0;
let events: LegionEvent[] = [];
let ended = false;

function regName(m: LegionMatch): RegStatic[] {
  const count = new Map<string, number>();
  const total = new Map<string, number>();
  for (const r of m.regiments) total.set(`${r.owner}:${r.kind}`, (total.get(`${r.owner}:${r.kind}`) ?? 0) + 1);
  return m.regiments.map((r) => {
    const key = `${r.owner}:${r.kind}`;
    const n = (count.get(key) ?? 0) + 1;
    count.set(key, n);
    const name = (total.get(key) ?? 1) > 1 ? `${UNITS[r.kind].name} ${n}` : UNITS[r.kind].name;
    return { id: r.id, owner: r.owner, kind: r.kind, men0: r.men0, cost: r.def.cost, name };
  });
}

function begin(s: LegionSetup): void {
  setup = s;
  const map = MAPS['river-valley']();
  player = null;
  playerSide = s.bots.indexOf('player');
  const ctrls: LegionController[] = s.bots.map((b, i) => {
    if (b !== 'player') return new LegionBatchController(compiled[b], `legion-${b}.js`, map, s.seed, i);
    player = new PlayerController(s.army ?? { field: ['spear', 'spear', 'sword', 'sword', 'archer', 'archer', 'shield', 'heavyCav', 'light'], reserve: [] });
    return player;
  });
  const knobs = ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const rejected: { player: number; reason: string }[] = [];
  driver = new LegionDriver({ seed: s.seed, mode: s.mode, controllers: ctrls, knobs, record: true });
  const m = driver.match;
  for (let p = 0; p < 2; p++) for (const e of m.observe(p).events) if (e.type === 'deployRejected') rejected.push({ player: p, reason: e.reason });
  const regs = regName(m);
  const players: PlayerMeta[] = ctrls.map((c, i) => ({ id: i, side: SIDES[i], color: COLORS[i], bot: c.declaration.name, style: c.declaration.style, cost: m.players[i].cost, knobs: knobs[i] }));
  const meta: LegionMeta = {
    mapName: m.map.name,
    mapDescription: m.map.description,
    width: m.map.width,
    height: m.map.height,
    terrain: m.map.terrain,
    heights: m.map.heights,
    flags: m.map.flags,
    deploy: m.map.deploy,
    spawns: m.mode === 'capture' ? m.map.spawns : [],
    supplies: m.mode === 'capture' ? m.map.supplies : [],
    mode: m.mode,
    timeLimitTicks: m.timeLimitTicks,
    seed: s.seed,
    players,
    regs,
    soldierCount: m.soldiers.length,
    rejected,
    playerSide,
  };
  comm = new LegionCommentator(regs, players, meta.playerSide);
  comm.start(m);
  events = [];
  m.eventTap = (ev) => {
    events.push(ev);
    comm?.onEvent(m, ev);
  };
  paused = true;
  ended = false;
  acc = 0;
  post({ type: 'meta', meta });
  sendFrame();
}

function frameOf(m: LegionMatch, captions: Caption[]): { frame: LegionFrame; transfer: Transferable[] } {
  let n = 0;
  for (const s of m.soldiers) if (s.alive) n += 1;
  const soldiers = new Int32Array(n * 4);
  let k = 0;
  for (const s of m.soldiers) {
    if (!s.alive) continue;
    const r = m.regiments[s.reg];
    soldiers[k++] = s.id;
    soldiers[k++] = s.x;
    soldiers[k++] = s.y;
    soldiers[k++] = s.reg | (s.cd === r.def.cooldown && r.def.range === 0 ? ATTACKED_BIT : 0) | (s.downUntil > m.tick ? DOWN_BIT : 0);
  }
  const regs: RegFrame[] = [];
  for (const r of m.regiments) {
    if (r.destroyed) continue;
    let hp = 0;
    for (const sid of r.reserve ? r.parked : r.slots) hp += m.soldiers[sid].hp;
    let seen = false;
    for (let p = 0; p < m.players.length; p++) if (p !== r.owner && m.visible[p][r.id] === 1) seen = true;
    regs.push({
      id: r.id,
      x: r.x,
      y: r.y,
      facing: r.facing,
      men: r.reserve ? r.parked.length : r.slots.length,
      hp,
      hpMax: Math.floor(((r.reserve ? r.parked.length : r.slots.length) * r.def.hp * [100, 110, 120][r.level - 1]) / 100),
      status: m.regimentStatus(r),
      order: r.dash !== null ? r.dash.def.kind : r.order,
      level: r.level,
      concealed: m.concealed(r) && !seen,
      seen,
      target: r.target,
      fireTarget: r.fireTarget,
      rad: r.rad,
      halfW: r.halfW,
      halfD: r.halfD,
      kills: r.kills,
      formation: r.formation,
      stance: r.stance,
      dashing: r.dash !== null ? r.dash.def.kind : null,
      dash: r.dash !== null ? { dir: r.dash.dir, left: r.dash.left, aligning: r.dash.aligning } : null,
      braceFacing: r.braceFacing,
      volley: r.volley !== null && r.volley.until > m.tick ? { x: r.volley.x, y: r.volley.y, until: r.volley.until } : null,
      switchLeft: Math.max(0, r.switchUntil - m.tick),
      skillCd: Math.max(0, r.skillReadyAt - m.tick),
      // 玩家指揮：看不到對手的意圖
      intent: m.tick - r.intentAt <= 60 && (playerSide < 0 || r.owner === playerSide) ? r.intent : '',
      reserve: r.reserve,
      enterIn: r.reserve && r.enterAt >= 0 ? r.enterAt - m.tick : -1,
    });
  }
  const arrows = new Int32Array(m.projectiles.length * 6);
  m.projectiles.forEach((p, i) => arrows.set([p.x0, p.y0, p.x1, p.y1, p.t0, p.t1], i * 6));
  const visible = m.visible.map((v) => v.slice());
  const frame: LegionFrame = {
    tick: m.tick,
    soldiers,
    regs,
    arrows,
    flags: m.flags.map((f) => ({ owner: f.owner, capturer: f.capturer, progress: f.progress, contested: f.contested })),
    score: m.players.map((p) => m.scoreOf(p.id)),
    plans: m.players.map((p) => (playerSide < 0 || p.id === playerSide ? p.plan : '')),
    strength: m.players.map((p) => m.strength(p.id)),
    kills: m.players.map((p) => p.kills),
    visible,
    events,
    captions,
    over: m.over,
    result: m.over ? m.result() : null,
  };
  events = [];
  return { frame, transfer: [soldiers.buffer, arrows.buffer, ...visible.map((v) => v.buffer)] };
}

function sendFrame(): void {
  if (driver === null || comm === null) return;
  const { frame, transfer } = frameOf(driver.match, comm.take());
  post({ type: 'frame', frame }, transfer);
}

function stepOnce(): boolean {
  if (driver === null || comm === null) return false;
  const m = driver.match;
  if (m.over) return false;
  driver.step();
  comm.afterTick(m);
  if (m.over && !ended) {
    ended = true;
    comm.end(m);
  }
  return true;
}

function loop(): void {
  const now = performance.now();
  const dt = Math.min(250, now - last);
  last = now;
  if (driver === null || paused || ended) return;
  acc += (dt * speed * TPS) / 1000;
  let steps = 0;
  while (acc >= 1 && steps < MAX_STEPS_PER_LOOP) {
    acc -= 1;
    if (!stepOnce()) break;
    steps += 1;
  }
  if (acc > MAX_STEPS_PER_LOOP) acc = 0;
  if (steps > 0) sendFrame();
}

/**
 * 快轉到下一個值得看的時刻：新戰場的接戰（快轉開始時已在交戰的團之間的接觸不算）、衝鋒或突擊撞擊、埋伏、潰散、旗點易手；
 * 至少快轉 SKIP_MIN tick，避免交戰中按一下只前進一點點
 */
function skip(): void {
  if (driver === null) return;
  const m = driver.match;
  const start = m.tick;
  const busy = new Set(m.regiments.filter((r) => !r.destroyed && m.tick - r.lastMelee <= 10).map((r) => r.id));
  let hit: { x: number; y: number } | null = null;
  const before = m.eventTap;
  m.eventTap = (ev) => {
    before?.(ev);
    if (hit !== null || m.tick - start < SKIP_MIN) return;
    let id = -1;
    if (ev.type === 'contact') id = busy.has(ev.a) || busy.has(ev.b) ? -1 : ev.a;
    else if (ev.type === 'impact') id = ev.kind !== 'infiltrate' && ev.target >= 0 ? ev.reg : -1;
    else if (ev.type === 'ambush' || ev.type === 'routed') id = ev.reg;
    else if (ev.type === 'flag') hit = { x: m.flags[ev.flag].x, y: m.flags[ev.flag].y };
    if (id >= 0) hit = { x: m.regiments[id].x, y: m.regiments[id].y };
  };
  while (hit === null && m.tick - start < SKIP_LIMIT && stepOnce());
  m.eventTap = before;
  // 快轉期間的解說只保留最後幾則
  sendFrame();
  if (hit !== null) post({ type: 'skipped', x: (hit as { x: number; y: number }).x, y: (hit as { x: number; y: number }).y });
}

setInterval(loop, 16);
last = performance.now();

ctx.onmessage = (ev: MessageEvent<ToLegionWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'start':
        begin(msg.setup);
        break;
      case 'play':
        paused = false;
        last = performance.now();
        break;
      case 'pause':
        paused = true;
        break;
      case 'speed':
        speed = msg.speed;
        break;
      case 'skip':
        skip();
        break;
      case 'restart':
        if (setup !== null) {
          begin(setup);
          paused = false;
        }
        break;
      case 'replay':
        if (driver?.replay) post({ type: 'replayFile', json: JSON.stringify(driver.replay) });
        break;
      case 'command':
        player?.push(msg.cmds);
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
