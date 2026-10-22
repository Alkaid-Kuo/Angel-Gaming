/// <reference lib="webworker" />
// 引擎 Worker（批次模式）：人類對戰／觀戰時逐 tick 推進比賽；回放時以 ReplayCursor 重建。
import baselineSource from '../../bots/baseline.js?raw';
import dummySource from '../../bots/dummy.js?raw';
import randomSource from '../../bots/random.js?raw';
import type { GameEvent } from '../api/types.ts';
import { TICKS_PER_SECOND } from '../config/index.ts';
import type { Match } from '../core/match.ts';
import { ReplayCursor } from '../replay/cursor.ts';
import { compileBot, type CompiledBot } from '../sandbox/compile.ts';
import { BatchController, resolveKnobs, type BotController } from '../sandbox/controller.ts';
import { HumanController } from '../sandbox/human.ts';
import { MatchDriver } from '../sandbox/runner.ts';
import { CombatMeter } from '../view/broadcast.ts';
import { frameView, GOD_VIEW, staticMapView } from '../view/snapshot.ts';
import type { FromWorker, LiveSetup, OpponentKind, ToWorker } from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromWorker, transfer: Transferable[] = []): void => ctx.postMessage(msg, transfer);

const compiled: Record<OpponentKind, CompiledBot> = {
  baseline: compileBot(baselineSource, 'baseline.js'),
  random: compileBot(randomSource, 'random.js'),
  dummy: compileBot(dummySource, 'dummy.js'),
};
const OPPONENT_NAME: Record<OpponentKind, string> = { baseline: '基準 Bot', random: '隨機 Bot', dummy: '教學木樁' };

/** 上帝視角只顯示的事件類型（擊殺只取建築） */
const GOD_EVENTS = new Set<GameEvent['type']>(['playerEliminated', 'towerChanged', 'enemyKilled']);
/** 快轉時每次迴圈最多推進的 tick 數 */
const SKIP_CHUNK = 300;
/** 精華模式沒有交戰時的速度 */
const HIGHLIGHT_FAST = 8;

let driver: MatchDriver | null = null;
let human: HumanController | null = null;
let cursor: ReplayCursor | null = null;
let viewer = GOD_VIEW;
let speed = 1;
let paused = false;
let stepping = false;
let ended = false;
let lastTime = 0;
let tickAcc = 0;
let pendingEvents: { to: number; ev: GameEvent }[] = [];
let highlight = false;
let skipping: 'fight' | 'end' | null = null;
const meter = new CombatMeter();

function currentMatch(): Match | null {
  return driver?.match ?? cursor?.current ?? null;
}

/** 事件監聽：只收集目前觀看者的事件（上帝視角只收重大事件，每個事件只收一次） */
function attachTap(m: Match): void {
  m.state.eventTap = (pid, ev) => {
    if (viewer === GOD_VIEW) {
      if (!GOD_EVENTS.has(ev.type)) return;
      if (ev.type === 'enemyKilled' && ev.kind !== 'building') return;
      if (ev.type === 'playerEliminated' && pendingEvents.some((e) => e.ev.type === 'playerEliminated' && e.ev.playerId === ev.playerId)) return;
      if (ev.type === 'towerChanged' && pendingEvents.some((e) => e.ev.type === 'towerChanged' && e.ev.tick === ev.tick)) return;
      pendingEvents.push({ to: pid, ev });
    } else if (pid === viewer) {
      pendingEvents.push({ to: pid, ev });
    }
  };
}

function sendFrame(): void {
  const m = currentMatch();
  if (m === null) return;
  const frame = frameView(m, viewer);
  const events = pendingEvents;
  pendingEvents = [];
  post(
    { type: 'frame', frame, events, speed, paused, desyncTick: cursor?.desyncTick ?? null, combat: { level: meter.level, hotspots: meter.hotspots }, highlight, skipping },
    frame.fog === null ? [] : [frame.fog.buffer],
  );
}

async function startLive(setup: LiveSetup): Promise<void> {
  const controllers: BotController[] = [];
  human = null;
  for (const seat of setup.seats) {
    if (seat === 'human') {
      human = new HumanController();
      controllers.push(human);
    } else {
      controllers.push(new BatchController(compiled[seat], `${seat}.js`));
    }
  }
  const knobs = controllers.map((c) => (c instanceof HumanController ? {} : resolveKnobs(c.declaration, undefined, c.label)));
  const unlimited = setup.seats.map((s) => s === 'human' && !setup.limitBudget);
  driver = new MatchDriver({ mode: setup.mode, seed: setup.seed, controllers, knobs, record: true, unlimitedBudget: unlimited, ...(setup.timeLimitTicks !== undefined ? { timeLimitTicks: setup.timeLimitTicks } : {}) });
  await driver.init();
  cursor = null;
  ended = false;
  paused = false;
  viewer = setup.human ?? GOD_VIEW;
  pendingEvents = [];
  skipping = null;
  meter.reset();
  attachTap(driver.match);
  const names = setup.seats.map((s, i) => (s === 'human' ? '玩家' : `${OPPONENT_NAME[s]}（P${i}）`));
  post({ type: 'ready', meta: { kind: 'live', map: staticMapView(driver.match, names), human: setup.human, limitBudget: setup.limitBudget, tutorial: setup.tutorial, durationTicks: null } });
  sendFrame();
}

function startReplay(msg: Extract<ToWorker, { type: 'startReplay' }>): void {
  cursor = new ReplayCursor(msg.file);
  driver = null;
  human = null;
  ended = false;
  paused = false;
  viewer = GOD_VIEW;
  pendingEvents = [];
  skipping = null;
  meter.reset();
  attachTap(cursor.current);
  const names = msg.file.header.players.map((p) => `${p.bot}${p.version !== '' ? ` ${p.version}` : ''}（P${p.playerId}）`);
  post({ type: 'ready', meta: { kind: 'replay', map: staticMapView(cursor.current, names), human: null, limitBudget: false, tutorial: false, durationTicks: msg.file.result?.durationTicks ?? null } });
  sendFrame();
}

async function stepOne(m: Match): Promise<void> {
  if (driver !== null) await driver.stepTick();
  else cursor!.step();
  meter.update(m.state);
}

/** 依經過時間推進對應數量的 tick；快轉時一次推進一大段 */
async function loop(): Promise<void> {
  const now = performance.now();
  const dt = Math.min(now - lastTime, 250);
  lastTime = now;
  const m = currentMatch();
  if (m !== null && !ended && !stepping && (!paused || skipping !== null)) {
    let n: number;
    if (skipping !== null) {
      n = SKIP_CHUNK;
    } else {
      const effective = highlight && meter.quiet ? Math.max(speed, HIGHLIGHT_FAST) : speed;
      tickAcc += (dt * TICKS_PER_SECOND * effective) / 1000;
      n = Math.floor(tickAcc);
      tickAcc -= n;
    }
    if (n > 0) {
      stepping = true;
      try {
        while (n-- > 0 && !m.over) {
          await stepOne(m);
          if (skipping === 'fight' && meter.fighting) {
            skipping = null;
            break;
          }
        }
      } catch (e) {
        post({ type: 'error', message: (e as Error).stack ?? String(e) });
        ended = true;
      }
      stepping = false;
      if (m.over) skipping = null;
      sendFrame();
      if (m.over && !ended) {
        ended = true;
        post({ type: 'end', result: m.result() });
      }
    }
  }
  setTimeout(() => void loop(), 16);
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'startLive':
        void startLive(msg.setup).catch((e: unknown) => post({ type: 'error', message: (e as Error).stack ?? String(e) }));
        break;
      case 'startReplay':
        startReplay(msg);
        break;
      case 'command':
        human?.enqueue(msg.cmds);
        break;
      case 'speed':
        speed = msg.speed;
        sendFrame();
        break;
      case 'pause':
        paused = msg.paused;
        sendFrame();
        break;
      case 'seek':
        if (cursor !== null) {
          pendingEvents = [];
          cursor.seek(msg.tick);
          meter.reset();
          attachTap(cursor.current);
          ended = cursor.over;
          sendFrame();
        }
        break;
      case 'viewer':
        viewer = msg.viewer;
        pendingEvents = [];
        sendFrame();
        break;
      case 'highlight':
        highlight = msg.on;
        sendFrame();
        break;
      case 'skip':
        skipping = msg.to;
        if (msg.to === 'fight') meter.reset();
        break;
      case 'getReplay':
        if (driver !== null && driver.replay !== null) post({ type: 'replay', file: driver.replay });
        else if (cursor !== null) post({ type: 'replay', file: cursor.file });
        break;
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).stack ?? String(e) });
  }
};

lastTime = performance.now();
void loop();
