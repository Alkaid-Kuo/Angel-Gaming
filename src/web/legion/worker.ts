/// <reference lib="webworker" />
// 軍團戰觀戰 Worker：執行所選 AI 的比賽、產生解說，依播放速度把每個 tick 的畫面資料送回主執行緒。
import ambushSource from '../../../bots/legion-ambush.js?raw';
import baselineV168Source from '../../../bots/legion-baseline-v1.68.js?raw';
import baselineV114Source from '../../../bots/legion-baseline-v1.114.js?raw';
import commanderSource from '../../../bots/legion-commander.js?raw';
import generalV2Source from '../../../bots/legion-general-v2.js?raw';
import marshalSource from '../../../bots/legion-marshal.js?raw';
import marshalV2Source from '../../../bots/legion-marshal-v2.js?raw';
import pushSource from '../../../bots/legion-push.js?raw';
import rangedSource from '../../../bots/legion-ranged.js?raw';
import type { LegionEvent } from '../../legion/api.ts';
import { TPS, UNITS } from '../../legion/config.ts';
import { normDeg } from '../../legion/geom.ts';
import { MAPS } from '../../legion/map.ts';
import { LegionBatchController, LegionDriver, LegionReplayCursor, type LegionController, type LegionReplay } from '../../legion/runner.ts';
import type { LegionMatch } from '../../legion/sim.ts';
import { compileBot, type CompiledBot } from '../../sandbox/compile.ts';
import { resolveKnobs } from '../../sandbox/controller.ts';
import { LegionCommentator } from './commentary.ts';
import { PlayerController } from './player.ts';
import type { BotKey, Caption, FromLegionWorker, LegionFrame, LegionMeta, LegionSetup, PlayerMeta, RegFrame, RegStatic, SandboxSetup, SandboxUnit, ToLegionWorker } from './protocol.ts';
import { AttackController, IdleController, SANDBOX_MAP, SANDBOX_TICKS, SquadController, checkPlacement, faceOff, toDeployment } from './sandbox.ts';
import { ATTACKED_BIT, DOWN_BIT } from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromLegionWorker, transfer: Transferable[] = []): void => ctx.postMessage(msg, transfer);

const compiled: Record<BotKey, CompiledBot> = {
  push: compileBot(pushSource, 'legion-push.js'),
  ambush: compileBot(ambushSource, 'legion-ambush.js'),
  ranged: compileBot(rangedSource, 'legion-ranged.js'),
  commander: compileBot(commanderSource, 'legion-commander.js'),
  marshal: compileBot(marshalSource, 'legion-marshal.js'),
  general2: compileBot(generalV2Source, 'legion-general-v2.js'),
  marshal2: compileBot(marshalV2Source, 'legion-marshal-v2.js'),
  baseline168: compileBot(baselineV168Source, 'legion-baseline-v1.68.js'),
  baseline114: compileBot(baselineV114Source, 'legion-baseline-v1.114.js'),
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
/** 依 playerId：玩家可以下指令的控制器（一般對戰只有玩家那一方；自訂對戰另有「待命」的一方） */
let manual: ({ push(cmds: readonly unknown[]): void } | null)[] = [null, null];
/** 玩家指揮哪一方（-1 = 純觀戰） */
let playerSide = -1;
/** 正在跑的比賽：AI／玩家對戰是 LegionDriver，重播是 LegionReplayCursor */
let driver: { readonly match: LegionMatch; step(): void; readonly replay: LegionReplay | null } | null = null;
/** 玩家剛打完（或正在打）的那一場的紀錄：「重看」照這份重播，不是重開一局 */
let playerReplay: LegionReplay | null = null;
let comm: LegionCommentator | null = null;
/** 沙盒：布陣中每次調整都會重建整場，解說等開戰才開始（不然開場白會重複） */
let introPending = false;
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

/** 自訂對戰（沙盒）：平地測試場、不限點數；每一方是玩家、待命不動、直接進攻，或用現有 AI 指揮指定的兵團 */
function buildSandbox(s: SandboxSetup & { readonly placement: readonly [readonly SandboxUnit[], readonly SandboxUnit[]] }): { driver: LegionDriver; players: PlayerMeta[] } {
  const map = MAPS[SANDBOX_MAP]();
  const center = (us: readonly SandboxUnit[]): { x: number; y: number } =>
    us.length === 0 ? { x: (map.width * 1000) / 2, y: (map.height * 1000) / 2 } : { x: us.reduce((t, u) => t + u.x, 0) / us.length, y: us.reduce((t, u) => t + u.y, 0) / us.length };
  const ctrls: LegionController[] = s.roles.map((role, i) => {
    const units = toDeployment(s.placement[i]);
    if (role === 'player') {
      player = new PlayerController({ field: [...s.armies[i]], reserve: [] }, units);
      manual[i] = player;
      return player;
    }
    if (role === 'idle') {
      const idle = new IdleController(units);
      manual[i] = idle;
      return idle;
    }
    if (role === 'attack') return new AttackController(units, center(s.placement[1 - i]));
    return new SquadController(new LegionBatchController(compiled[role], `legion-${role}.js`, map, s.seed, i), units);
  });
  const knobs = ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const d = new LegionDriver({ seed: s.seed, mode: 'annihilation', mapId: SANDBOX_MAP, controllers: ctrls, knobs, record: true, timeLimitTicks: SANDBOX_TICKS, sandbox: true });
  const players = ctrls.map((c, i) => {
    const ai = s.roles[i] !== 'player' && s.roles[i] !== 'idle' && s.roles[i] !== 'attack';
    return { id: i, side: SIDES[i], color: COLORS[i], bot: c.declaration.name, style: ai ? `（指揮你指定的兵團）${c.declaration.style}` : c.declaration.style, cost: d.match.players[i].cost, knobs: knobs[i] };
  });
  return { driver: d, players };
}

/** 開一場：replay 有值時照紀錄重播（玩家打過的那一場，上帝視角） */
function begin(s0: LegionSetup, replay: LegionReplay | null = null): void {
  // 沙盒沒指定布陣就自動面對面，並記下來（之後拖曳調整、重來都從這份開始）
  const s: LegionSetup = s0.kind === 'sandbox' && s0.placement === undefined ? { ...s0, placement: faceOff(s0.armies, s0.distance, MAPS[SANDBOX_MAP]()) } : s0;
  setup = s;
  player = null;
  manual = [null, null];
  // 自訂對戰一律上帝視角（不藏對方的意圖與位置）
  playerSide = replay !== null || s.kind === 'sandbox' ? -1 : s.bots.indexOf('player');
  const rejected: { player: number; reason: string }[] = [];
  let players: PlayerMeta[];
  let m: LegionMatch;
  if (replay !== null) {
    const cursor = new LegionReplayCursor(replay);
    driver = cursor;
    m = cursor.match;
    players = replay.header.players.map((p, i) => ({ id: i, side: SIDES[i], color: COLORS[i], bot: p.bot, style: '（重播）', cost: m.players[i].cost, knobs: p.knobs }));
  } else if (s.kind === 'sandbox') {
    const built = buildSandbox({ ...s, placement: s.placement! });
    driver = built.driver;
    m = built.driver.match;
    if (playerSide >= 0) playerReplay = built.driver.replay;
    players = built.players;
  } else {
    const map = MAPS['river-valley']();
    const ctrls: LegionController[] = s.bots.map((b, i) => {
      if (b !== 'player') return new LegionBatchController(compiled[b], `legion-${b}.js`, map, s.seed, i);
      player = new PlayerController(s.army ?? { field: ['spear', 'spear', 'spear', 'sword', 'sword', 'archer', 'archer', 'shield', 'shield', 'heavyCav', 'light'], reserve: [] });
      manual[i] = player;
      return player;
    });
    const knobs = ctrls.map((c) => resolveKnobs(c.declaration, undefined, c.label));
    const d = new LegionDriver({ seed: s.seed, mode: s.mode, controllers: ctrls, knobs, record: true });
    driver = d;
    m = d.match;
    if (playerSide >= 0) playerReplay = d.replay;
    players = ctrls.map((c, i) => ({ id: i, side: SIDES[i], color: COLORS[i], bot: c.declaration.name, style: c.declaration.style, cost: m.players[i].cost, knobs: knobs[i] }));
  }
  for (let p = 0; p < 2; p++) for (const e of m.observe(p).events) if (e.type === 'deployRejected') rejected.push({ player: p, reason: e.reason });
  const regs = regName(m);
  const meta: LegionMeta = {
    mapName: m.map.name,
    mapDescription: m.map.description,
    width: m.map.width,
    height: m.map.height,
    terrain: m.map.terrain,
    heights: m.map.heights,
    flags: m.map.flags,
    deploy: s.kind === 'sandbox' ? [] : m.map.deploy,
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
    controlSides: replay !== null ? [] : [0, 1].filter((p) => manual[p] !== null),
    replay: replay !== null,
    sandbox: s.kind === 'sandbox' && replay === null,
  };
  comm = new LegionCommentator(regs, players, meta.playerSide);
  introPending = meta.sandbox;
  if (!introPending) comm.start(m);
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
    killValue: m.players.map((p) => Math.round(p.killValue / 1000)),
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

/** 玩家的指令依軍團所屬的一方，交給那一方的控制器（自訂對戰可以同時指揮雙方） */
function command(cmds: readonly unknown[]): void {
  const m = driver?.match;
  if (!m) return;
  const by: unknown[][] = [[], []];
  for (const c of cmds) {
    const id = (c as { id?: unknown }).id;
    const owner = typeof id === 'number' ? m.regiments[id]?.owner : undefined;
    if (owner !== undefined && manual[owner] !== null) by[owner].push(c);
  }
  by.forEach((list, p) => {
    if (list.length > 0) manual[p]?.push(list);
  });
}

/** 沙盒開戰：補上延後的開場解說 */
function startIntro(): void {
  if (!introPending || driver === null || comm === null) return;
  introPending = false;
  comm.start(driver.match);
}

/** 沙盒布陣：把一團擺到新的位置、朝向、陣形，整場用新布陣重建（開戰前才行）；擺不下就提示並維持原樣 */
function place(id: number, x: number, y: number, facing: number, formation: SandboxUnit['formation']): void {
  const s = setup;
  if (s?.kind !== 'sandbox' || s.placement === undefined || driver === null || driver.match.tick > 0) return;
  const pl = s.placement;
  if (driver.match.regiments.length !== pl[0].length + pl[1].length) {
    post({ type: 'toast', text: '有軍團沒擺上去（地方不夠），請減少兵力或拉開距離後重開' });
    return;
  }
  const side = id < pl[0].length ? 0 : 1;
  const idx = side === 0 ? id : id - pl[0].length;
  const u = pl[side][idx];
  if (u === undefined) return;
  const next: [SandboxUnit[], SandboxUnit[]] = [pl[0].slice(), pl[1].slice()];
  next[side][idx] = { ...u, x: Math.round(x), y: Math.round(y), facing: normDeg(Math.round(facing)), formation: UNITS[u.kind].formations.includes(formation) ? formation : u.formation };
  const bad = checkPlacement(next, MAPS[SANDBOX_MAP]());
  if (bad !== '') {
    post({ type: 'toast', text: `不能擺在那裡：${bad}` });
    sendFrame();
    return;
  }
  begin({ ...s, placement: next });
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
        startIntro();
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
        // 沙盒：同一組布陣重新開打（edit = 回到布陣階段，暫停等開戰）
        if (setup?.kind === 'sandbox') {
          begin(setup);
          paused = msg.edit === true;
          if (!paused) startIntro();
          break;
        }
        // 玩家打的那一場：照錄下來的指令重播；AI 對戰：同一組合、同一個種子重跑（結果一樣）
        if (setup !== null) {
          const s = setup;
          const rp = s.bots.includes('player') && playerReplay !== null ? playerReplay : null;
          begin(s, rp);
          // 重播會換成觀戰畫面，等畫面上按「開戰」再開始
          paused = rp !== null;
        }
        break;
      case 'replay':
        if (driver?.replay) post({ type: 'replayFile', json: JSON.stringify(driver.replay) });
        break;
      case 'command':
        command(msg.cmds);
        break;
      case 'place':
        place(msg.id, msg.x, msg.y, msg.facing, msg.formation);
        break;
      case 'autoPlace':
        if (setup?.kind === 'sandbox' && driver !== null && driver.match.tick === 0) begin({ ...setup, placement: undefined });
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
