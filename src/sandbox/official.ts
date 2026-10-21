// 正式模式：每位選手一個 worker_threads Worker；主執行緒設硬計時，逾時即終止 Worker。
import { Worker } from 'node:worker_threads';
import type { BotDeclaration, InitData } from '../api/types.ts';
import { RULES } from '../config/index.ts';
import type { ObservationPacket } from '../core/observe.ts';
import { BotLoadError } from './compile.ts';
import { jsonClone, validateDeclaration, type BotController, type DecideOutcome, type InitOutcome } from './controller.ts';
import type { BotFile } from './node-loader.ts';

const WORKER_URL = new URL(import.meta.url.endsWith('.ts') ? './official-worker.ts' : './official-worker.js', import.meta.url);
/** 載入（含 declare）的寬限時間 */
const LOAD_TIMEOUT_MS = 10000;

type WorkerMessage =
  | { type: 'ready'; declaration: unknown; elapsedMs: number }
  | { type: 'loadError'; error: string }
  | { type: 'initDone'; exception: string | null; elapsedMs: number }
  | { type: 'decided'; commands: unknown; exception: string | null; elapsedMs: number };

export class OfficialController implements BotController {
  readonly label: string;
  readonly declaration: BotDeclaration;
  private readonly worker: Worker;
  private dead = false;
  private waiter: ((m: WorkerMessage) => void) | null = null;

  private constructor(label: string, worker: Worker, declaration: BotDeclaration) {
    this.label = label;
    this.worker = worker;
    this.declaration = declaration;
    worker.on('message', (m: WorkerMessage) => {
      const w = this.waiter;
      this.waiter = null;
      w?.(m);
    });
    worker.on('error', () => {
      this.dead = true;
    });
  }

  static async create(file: BotFile): Promise<OfficialController> {
    const worker = new Worker(WORKER_URL, { workerData: { source: file.source, label: file.label } });
    let first: WorkerMessage;
    try {
      first = await new Promise<WorkerMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new BotLoadError(`${file.label}：載入逾時`)), LOAD_TIMEOUT_MS);
        worker.once('message', (m: WorkerMessage) => {
          clearTimeout(timer);
          resolve(m);
        });
        worker.once('error', (e) => {
          clearTimeout(timer);
          reject(new BotLoadError(`${file.label}：Worker 錯誤 ${e.message}`));
        });
      });
      if (first.type === 'loadError') throw new BotLoadError(first.error);
      if (first.type !== 'ready') throw new BotLoadError(`${file.label}：Worker 回應錯誤`);
      if (first.elapsedMs > RULES.timing.hardMs) throw new BotLoadError(`${file.label}：declare() 超過 ${RULES.timing.hardMs} ms`);
      const decl = validateDeclaration(first.declaration, file.label);
      return new OfficialController(file.label, worker, decl);
    } catch (e) {
      await worker.terminate();
      throw e;
    }
  }

  /** 送出訊息並等待回覆；逾時回傳 null 並終止 Worker */
  private request(msg: unknown, timeoutMs: number): Promise<WorkerMessage | null> {
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.kill();
        resolve(null);
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.worker.postMessage(msg);
    });
  }

  private kill(): void {
    if (this.dead) return;
    this.dead = true;
    void this.worker.terminate();
  }

  async init(data: InitData): Promise<InitOutcome> {
    const t0 = performance.now();
    const m = await this.request({ type: 'init', data }, RULES.timing.initMs);
    if (m === null || m.type !== 'initDone') return { exception: null, killed: true, elapsedMs: performance.now() - t0 };
    return { exception: m.exception, killed: m.elapsedMs > RULES.timing.initMs, elapsedMs: m.elapsedMs };
  }

  async decide(packet: ObservationPacket): Promise<DecideOutcome> {
    const t0 = performance.now();
    const m = await this.request({ type: 'decide', packet }, RULES.timing.hardMs);
    if (m === null || m.type !== 'decided') {
      return { commands: [], voided: false, exception: null, killed: true, elapsedMs: performance.now() - t0 };
    }
    let commands: unknown = [];
    let exception = m.exception;
    if (exception === null) {
      try {
        commands = jsonClone(m.commands);
      } catch (e) {
        exception = (e as Error).message;
      }
    }
    const voided = m.elapsedMs > RULES.timing.decideSoftMs;
    return { commands, voided, exception, killed: false, elapsedMs: m.elapsedMs };
  }

  async dispose(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    await this.worker.terminate();
  }
}
