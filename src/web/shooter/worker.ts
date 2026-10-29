/// <reference lib="webworker" />
// CS 射擊可玩版的引擎 Worker：固定 30 TPS 推進比賽（累積時間，不靠計時器間隔），每次推進後把畫面資料送回主執行緒。
// 玩家模式只送觀察資料與計分板公開資訊；觀戰模式另送引擎全狀態。主執行緒不持有引擎。
import practiceSource from '../../../bots/shooter-practice.js?raw';
import type { ShooterObservation, SoundEvent, Team } from '../../shooter/api.ts';
import { GRENADES, TPS } from '../../shooter/config.ts';
import { ShooterHumanController } from '../../shooter/human.ts';
import { DEFAULT_MAP_ID, MAPS } from '../../shooter/map.ts';
import { ShooterBatchController, ShooterDriver, type ShooterController } from '../../shooter/runner.ts';
import { PLAYER_COUNT, activeWeaponId, shooterInitData, smokeRadius, type ShooterMatch } from '../../shooter/sim.ts';
import { compileBot } from '../../sandbox/compile.ts';
import type { BoardRow, FromShooterWorker, FullState, KillFeedItem, ShooterSetup, ToShooterWorker } from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromShooterWorker): void => ctx.postMessage(msg);

const practice = compileBot(practiceSource, 'shooter-practice.js');
const TICK_MS = 1000 / TPS;
/** 一次迴圈最多補幾個 tick（分頁在背景被節流後回來，不要一口氣快轉太多） */
const MAX_CATCH_UP = 8;

let setup: ShooterSetup | null = null;
let driver: ShooterDriver | null = null;
let human: ShooterHumanController | null = null;
let playerId = 0;
let viewId = 0;
let paused = false;
let speed = 1;
let acc = 0;
let last = 0;
let feedIdx = 0;
let pendingSounds: SoundEvent[] = [];
let overSent = false;

function names(spectate: boolean, pid: number): string[] {
  return Array.from({ length: PLAYER_COUNT }, (_, i) => (!spectate && i === pid ? '你' : `陪練 ${i < 5 ? i + 1 : i - 4}${i < 5 ? 'α' : 'β'}`));
}

function begin(s: ShooterSetup): void {
  setup = s;
  const map = MAPS[DEFAULT_MAP_ID]();
  playerId = s.spectate ? 0 : s.team === 'T' ? 0 : 5;
  human = s.spectate ? null : new ShooterHumanController();
  const controllers: ShooterController[] = Array.from({ length: PLAYER_COUNT }, (_, pid) =>
    human !== null && pid === playerId ? human : new ShooterBatchController(practice, 'shooter-practice.js', s.seed, pid, map),
  );
  driver = new ShooterDriver({ seed: s.seed, mapId: map.id, controllers, record: true });
  viewId = playerId;
  paused = false;
  speed = 1;
  acc = 0;
  last = performance.now();
  feedIdx = 0;
  pendingSounds = [];
  overSent = false;
  const init = shooterInitData(driver.match.map, playerId, {});
  post({
    type: 'meta',
    meta: {
      playerId,
      spectate: s.spectate,
      seed: s.seed,
      names: names(s.spectate, playerId),
      groups: driver.match.players.map((p) => p.group),
      rules: init.rules,
      map: init.map,
      weapons: init.weapons,
      grenades: init.grenades,
    },
  });
  sendFrame();
}

/** 死後（或觀戰時被跟隨的人死了）自動換到同隊還活著的人 */
function fixView(m: ShooterMatch): void {
  const me = m.players[playerId];
  if (!setup?.spectate && me.alive) {
    viewId = playerId;
    return;
  }
  const cur = m.players[viewId];
  const team: Team = setup?.spectate ? cur.team : me.team;
  if (cur.alive && cur.team === team && (setup?.spectate || viewId !== playerId)) return;
  const mate = m.players.find((p) => p.alive && p.team === team && (setup?.spectate || p.id !== playerId));
  if (mate !== undefined) viewId = mate.id;
}

function cycleView(step: number): void {
  const m = driver?.match;
  if (m === undefined) return;
  const me = m.players[playerId];
  if (!setup?.spectate && me.alive) return;
  const pool = m.players.filter((p) => p.alive && (setup?.spectate || (p.team === me.team && p.id !== playerId))).map((p) => p.id);
  if (pool.length === 0) return;
  const at = pool.indexOf(viewId);
  viewId = pool[(((at < 0 ? 0 : at + step) % pool.length) + pool.length) % pool.length];
}

function fullState(m: ShooterMatch): FullState {
  return {
    players: m.players.map((p) => ({ id: p.id, team: p.team, alive: p.alive, x: p.x, y: p.y, facing: Math.round(p.facing / 100) % 360, hp: p.hp, weapon: activeWeaponId(p), hasBomb: p.hasBomb, blind: p.blindTicks > 0, scoped: p.scoped, firing: m.tick - p.lastShotTick <= 3 })),
    smokes: m.smokes.filter((s) => m.tick < s.endTick).map((s) => ({ x: s.x, y: s.y, radius: smokeRadius(s, m.tick) })),
    fires: m.fires.map((f) => ({ x: f.x, y: f.y, radius: GRENADES[f.kind].radius })),
    projectiles: m.projectiles.map((g) => ({ kind: g.kind, x: g.x, y: g.y })),
    items: m.items.map((it) => ({ kind: it.kind, weapon: it.weapon?.id ?? null, x: it.x, y: it.y })),
    bomb: { state: m.bomb.state, x: m.bomb.state === 'carried' && m.bomb.carrier >= 0 ? m.players[m.bomb.carrier].x : m.bomb.x, y: m.bomb.state === 'carried' && m.bomb.carrier >= 0 ? m.players[m.bomb.carrier].y : m.bomb.y, ticksLeft: m.bomb.state === 'planted' ? Math.max(0, m.bomb.explodeTick - m.tick) : null },
  };
}

function sendFrame(viewObs?: ShooterObservation): void {
  const d = driver;
  if (d === null || setup === null) return;
  const m = d.match;
  fixView(m);
  const view = viewObs !== undefined && viewObs.me.id === viewId && viewObs.tick === m.tick ? viewObs : m.observe(viewId);
  const self = viewId === playerId ? view : m.observe(playerId);
  const myTeam = m.players[playerId].team;
  const board: BoardRow[] = m.players.map((p) => ({ id: p.id, team: p.team, alive: p.alive, kills: p.kills, deaths: p.deaths, money: setup?.spectate || p.team === myTeam ? p.money : null }));
  const feed: KillFeedItem[] = m.kills.slice(feedIdx).map((k) => ({ tick: k.tick, killer: k.killer, victim: k.victim, weapon: k.weapon }));
  feedIdx = m.kills.length;
  post({ type: 'frame', frame: { tick: m.tick, viewId, view, self, sounds: pendingSounds, board, feed, full: setup.spectate ? fullState(m) : null, paused } });
  pendingSounds = [];
}

function sendOver(): void {
  const d = driver;
  if (d === null || overSent) return;
  overSent = true;
  const m = d.match;
  const r = m.result();
  post({
    type: 'over',
    summary: {
      winnerGroup: r.winner,
      score: [r.score[0], r.score[1]],
      rounds: r.rounds.map((x) => ({ number: x.number, winner: x.winner, winnerGroup: x.winnerGroup, reason: x.reason })),
      players: m.players.map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths, money: p.money })),
      finalHash: m.hash(),
    },
  });
}

function loop(): void {
  const now = performance.now();
  const dt = now - last;
  last = now;
  const d = driver;
  if (d === null || paused || d.match.over) return;
  acc += dt * speed;
  const maxSteps = MAX_CATCH_UP * Math.max(1, speed);
  if (acc > maxSteps * TICK_MS) acc = maxSteps * TICK_MS;
  let stepped = 0;
  let lastObs: ShooterObservation | undefined;
  while (acc >= TICK_MS && !d.match.over) {
    acc -= TICK_MS;
    d.step();
    stepped += 1;
    // 聲音：每個決策 tick 取一次（觀察資料的聲音視窗是上一個決策 tick 到現在），不重複也不漏
    if (d.match.isDecisionTick()) {
      fixView(d.match);
      lastObs = d.match.observe(viewId);
      pendingSounds.push(...lastObs.sounds);
    }
  }
  if (stepped > 0) sendFrame(lastObs);
  if (d.match.over) sendOver();
}

setInterval(loop, 4);
last = performance.now();

ctx.onmessage = (ev: MessageEvent<ToShooterWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'start':
        begin(msg.setup);
        break;
      case 'cmd':
        if (human !== null && driver !== null && !paused) human.enqueue(msg.cmds);
        break;
      case 'view':
        if (msg.id !== undefined && setup?.spectate) viewId = msg.id;
        else if (msg.step !== undefined) cycleView(msg.step);
        sendFrame();
        break;
      case 'pause':
        // 觀戰模式與單機都可以暫停（玩家是唯一的人類，暫停不影響公平）
        paused = msg.paused;
        last = performance.now();
        acc = 0;
        sendFrame();
        break;
      case 'speed':
        if (setup?.spectate) speed = Math.max(0.25, Math.min(8, msg.speed));
        break;
      case 'stop':
        driver = null;
        human = null;
        setup = null;
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
