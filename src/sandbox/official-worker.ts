// 正式模式的選手 Worker：每位選手一個，量測 decide 耗時並回報。
// 啟動時把 Math.random、Date、performance 換成呼叫即拋例外的函式（量測用的 performance.now 先保存）。
import { parentPort, workerData } from 'node:worker_threads';
import type { Bot, InitData } from '../api/types.ts';
import type { ObservationPacket } from '../core/observe.ts';
import { compileBot } from './compile.ts';
import { BotHelpers } from './helpers.ts';

const perfNow = performance.now.bind(performance);
const thrower = (name: string) => (): never => {
  throw new Error(`選手禁止使用 ${name}（請使用 helpers.random()）`);
};
Math.random = thrower('Math.random');
const g = globalThis as unknown as Record<string, unknown>;
const FakeDate = thrower('Date') as unknown as Record<string, unknown>;
FakeDate.now = thrower('Date.now');
g.Date = FakeDate;
g.performance = { now: thrower('performance.now') };

interface WorkerInput {
  readonly source: string;
  readonly label: string;
}

type Inbound = { type: 'init'; data: InitData } | { type: 'decide'; packet: ObservationPacket };

const port = parentPort!;
const input = workerData as WorkerInput;

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

let bot: Bot | null = null;
let helpers: BotHelpers | null = null;

try {
  const Cls = compileBot(input.source, input.label).createClass();
  bot = new Cls();
  const t0 = perfNow();
  const declaration = bot.declare();
  port.postMessage({ type: 'ready', declaration, elapsedMs: perfNow() - t0 });
} catch (e) {
  port.postMessage({ type: 'loadError', error: errorText(e) });
}

port.on('message', (msg: Inbound) => {
  const b = bot!;
  if (msg.type === 'init') {
    helpers = new BotHelpers(msg.data);
    const t0 = perfNow();
    let exception: string | null = null;
    try {
      b.init(msg.data, helpers.toPublic());
    } catch (e) {
      exception = errorText(e);
    }
    port.postMessage({ type: 'initDone', exception, elapsedMs: perfNow() - t0 });
    return;
  }
  helpers!.update(msg.packet.obs, msg.packet.exploredDelta);
  const t0 = perfNow();
  let commands: unknown;
  let exception: string | null = null;
  try {
    commands = b.decide(msg.packet.obs);
  } catch (e) {
    exception = errorText(e);
    commands = [];
  }
  const elapsedMs = perfNow() - t0;
  try {
    port.postMessage({ type: 'decided', commands, exception, elapsedMs });
  } catch (e) {
    port.postMessage({ type: 'decided', commands: [], exception: `指令無法傳送：${errorText(e)}`, elapsedMs });
  }
});
