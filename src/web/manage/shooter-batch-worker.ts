/// <reference lib="webworker" />
// 攻防戰閘道的 Worker：收一張請求單、打一整場、回傳成績單。Bot 原始碼以 ?raw 匯入、在 Worker 內編譯一次（同 src/web/shooter/worker.ts）。
// 與 Node 殼（src/manage/gateway-shooter.ts）呼叫同一個 runGatewayMatch，同一張請求單同一個結果。
import baselineSource from '../../../bots/shooter-baseline.js?raw';
import type { MatchOutcome, MatchRequest } from '../../manage/gateway.ts';
import { compileBot } from '../../sandbox/compile.ts';
import { runGatewayMatch } from '../../shooter/gateway.ts';

export type ToBatchWorker = { readonly id: number; readonly request: MatchRequest };
export type FromBatchWorker = { readonly id: number; readonly outcome: MatchOutcome; readonly wallMs: number } | { readonly id: number; readonly error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const bot = compileBot(baselineSource, 'shooter-baseline.js');

ctx.onmessage = (e: MessageEvent<ToBatchWorker>): void => {
  const { id, request } = e.data;
  let msg: FromBatchWorker;
  try {
    const m = runGatewayMatch(request, bot);
    msg = { id, outcome: m.outcome, wallMs: m.wallMs };
  } catch (err) {
    msg = { id, error: err instanceof Error ? err.message : String(err) };
  }
  ctx.postMessage(msg);
};
