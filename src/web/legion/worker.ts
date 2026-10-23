/// <reference lib="webworker" />
// 軍團戰觀戰 Worker：執行比賽（三隻基準 AI）、產生解說，依播放速度把每個 tick 的畫面資料送回主執行緒。
import ambushSource from '../../../bots/legion-ambush.js?raw';
import pushSource from '../../../bots/legion-push.js?raw';
import rangedSource from '../../../bots/legion-ranged.js?raw';
import type { LegionEvent } from '../../legion/api.ts';
import { TPS, UNITS } from '../../legion/config.ts';
import { MAPS } from '../../legion/map.ts';
import { LegionBatchController, LegionDriver } from '../../legion/runner.ts';
import type { LegionMatch } from '../../legion/sim.ts';
import { compileBot, type CompiledBot } from '../../sandbox/compile.ts';
import { resolveKnobs } from '../../sandbox/controller.ts';
import { LegionCommentator } from './commentary.ts';
import type { BotKey, Caption, FromLegionWorker, LegionFrame, LegionMeta, LegionSetup, PlayerMeta, RegFrame, RegStatic, ToLegionWorker } from './protocol.ts';
import { ATTACKED_BIT } from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromLegionWorker, transfer: Transferable[] = []): void => ctx.postMessage(msg, transfer);

const compiled: Record<BotKey, CompiledBot> = {
  push: compileBot(pushSource, 'legion-push.js'),
  ambush: compileBot(ambushSource, 'legion-ambush.js'),
  ranged: compileBot(rangedSource, 'legion-ranged.js'),
};
const SIDES = ['藍方', '紅方'];
const COLORS = ['#3b82f6', '#ef4444'];
/** 每次迴圈最多推進的 tick（避免高速時卡住主執行緒訊息） */
const MAX_STEPS_PER_LOOP = 40;
/** 「跳到下一場交戰」最多快轉的 tick */
const SKIP_LIMIT = 900;

let setup: LegionSetup | null = null;
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
  const ctrls = s.bots.map((b, i) => new LegionBatchController(compiled[b], `legion-${b}.js`, map, s.seed, i));
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
    mode: m.mode,
    timeLimitTicks: m.timeLimitTicks,
    seed: s.seed,
    players,
    regs,
    soldierCount: m.soldiers.length,
    rejected,
  };
  comm = new LegionCommentator(regs, players);
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
    soldiers[k++] = s.reg | (s.cd === r.def.cooldown && r.def.range === 0 ? ATTACKED_BIT : 0);
  }
  const regs: RegFrame[] = [];
  for (const r of m.regiments) {
    if (r.destroyed) continue;
    let hp = 0;
    for (const sid of r.slots) hp += m.soldiers[sid].hp;
    let seen = false;
    for (let p = 0; p < m.players.length; p++) if (p !== r.owner && m.visible[p][r.id] === 1) seen = true;
    regs.push({
      id: r.id,
      x: r.x,
      y: r.y,
      facing: r.facing,
      men: r.slots.length,
      hp,
      hpMax: Math.floor((r.slots.length * r.def.hp * [100, 110, 120][r.level - 1]) / 100),
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
      skillCd: Math.max(0, r.skillReadyAt - m.tick),
      intent: m.tick - r.intentAt <= 60 ? r.intent : '',
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
    flags: m.flags.map((f) => ({ owner: f.owner, value: f.value, capturer: f.capturer })),
    domination: m.players.map((p) => p.domination),
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

/** 快轉到下一個值得看的時刻（接戰、撞擊、埋伏、潰散） */
function skip(): void {
  if (driver === null) return;
  const m = driver.match;
  const start = m.tick;
  let hit: { x: number; y: number } | null = null;
  const before = m.eventTap;
  m.eventTap = (ev) => {
    before?.(ev);
    if (hit !== null) return;
    const id = ev.type === 'contact' ? ev.a : ev.type === 'impact' || ev.type === 'ambush' || ev.type === 'routed' ? ev.reg : -1;
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
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
