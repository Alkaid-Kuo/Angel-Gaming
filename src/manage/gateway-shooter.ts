// 攻防戰閘道的 Node 殼：同步逐場跑（測試、自動玩家腳本用）。瀏覽器版是 src/web/manage/shooter-gateway.ts（Worker 池），兩者都只呼叫 runGatewayMatch。
// 這個檔案用 node:fs 讀 Bot，不從 index.ts 匯出（網頁打包不會碰到）。
import { readFileSync } from 'node:fs';
import { compileBot, type CompiledBot } from '../sandbox/compile.ts';
import { SHOOTER_FORMATS, runGatewayMatch } from '../shooter/gateway.ts';
import type { BattleGateway, MatchFormat, MatchOutcome, MatchRequest } from './gateway.ts';

export const SHOOTER_BOT_PATH = 'bots/shooter-baseline.js';

export class ShooterGateway implements BattleGateway {
  readonly formats: readonly MatchFormat[] = SHOOTER_FORMATS;
  /** 累計：打了幾場、引擎耗時（毫秒），給量測腳本用 */
  matches = 0;
  wallMs = 0;
  private readonly bot: CompiledBot;

  constructor(bot?: CompiledBot) {
    this.bot = bot ?? compileBot(readFileSync(SHOOTER_BOT_PATH, 'utf8'), SHOOTER_BOT_PATH);
  }

  // async：名單不合等錯誤以 rejected promise 回報（與 Worker 版一致）
  async simulateBatch(requests: readonly MatchRequest[], onProgress?: (done: number, total: number) => void): Promise<MatchOutcome[]> {
    const outs: MatchOutcome[] = [];
    for (const r of requests) {
      const m = runGatewayMatch(r, this.bot);
      outs.push(m.outcome);
      this.matches++;
      this.wallMs += m.wallMs;
      onProgress?.(outs.length, requests.length);
    }
    return outs;
  }
}
