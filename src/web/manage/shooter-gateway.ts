// 攻防戰閘道的瀏覽器殼：Worker 池（min(4, max(1, 核心數 − 1)) 個），一張請求單一個工作，完成一場回報一次進度。
// 每個 Worker 都跑 src/shooter/gateway.ts 的 runGatewayMatch（與 Node 殼同一份程式），所以結果與 Node 相同。
import type { BattleGateway, MatchFormat, MatchOutcome, MatchRequest } from '../../manage/gateway.ts';
import { SHOOTER_FORMATS } from '../../shooter/gateway.ts';
import type { FromBatchWorker, ToBatchWorker } from './shooter-batch-worker.ts';

interface Task {
  readonly id: number;
  readonly request: MatchRequest;
  readonly done: (r: FromBatchWorker) => void;
}

export class WorkerShooterGateway implements BattleGateway {
  readonly formats: readonly MatchFormat[] = SHOOTER_FORMATS;
  readonly size: number;
  /** 最近一批的總耗時（毫秒，牆鐘）；給介面估「推進一週要等多久」 */
  lastBatchMs = 0;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly running = new Map<Worker, Task>();
  private readonly queue: Task[] = [];
  private nextId = 1;

  constructor(size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))) {
    this.size = size;
  }

  private spawn(): void {
    while (this.workers.length < this.size) {
      const w = new Worker(new URL('./shooter-batch-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<FromBatchWorker>): void => this.finish(w, e.data);
      w.onerror = (e: ErrorEvent): void => {
        e.preventDefault();
        this.finish(w, { id: this.running.get(w)?.id ?? -1, error: e.message || 'Worker 錯誤' });
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private finish(w: Worker, r: FromBatchWorker): void {
    const t = this.running.get(w);
    this.running.delete(w);
    this.idle.push(w);
    t?.done(r);
    this.pump();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop() as Worker;
      const t = this.queue.shift() as Task;
      this.running.set(w, t);
      const msg: ToBatchWorker = { id: t.id, request: t.request };
      w.postMessage(msg);
    }
  }

  simulateBatch(requests: readonly MatchRequest[], onProgress?: (done: number, total: number) => void): Promise<MatchOutcome[]> {
    if (requests.length === 0) return Promise.resolve([]);
    this.spawn();
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const outs: MatchOutcome[] = new Array<MatchOutcome>(requests.length);
      let done = 0;
      let failed = false;
      onProgress?.(0, requests.length);
      requests.forEach((request, i) => {
        this.queue.push({
          id: this.nextId++,
          request,
          done: (r) => {
            if (failed) return;
            if ('error' in r) {
              failed = true;
              // 這一批剩下還沒開始的工作不打了
              for (let k = this.queue.length - 1; k >= 0; k--) if (requests.includes(this.queue[k].request)) this.queue.splice(k, 1);
              reject(new Error(`攻防戰模擬失敗：${r.error}`));
              return;
            }
            outs[i] = r.outcome;
            done++;
            onProgress?.(done, requests.length);
            if (done === requests.length) {
              this.lastBatchMs = performance.now() - t0;
              resolve(outs);
            }
          },
        });
      });
      this.pump();
    });
  }

  /** 關掉所有 Worker（換局或離開頁面時） */
  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.running.clear();
    this.queue.length = 0;
  }
}
