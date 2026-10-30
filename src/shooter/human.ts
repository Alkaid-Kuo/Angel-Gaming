// 人類玩家（CS 射擊）：與選手相同的指令介面。介面送來的指令每個 tick 由驅動層取出套用並錄進回放
// （同 RTS 的 HumanController 的 takeRealtime 模式）；轉身上限、散佈、冷卻照引擎規則，不另開後門。
import type { ShooterCommand, ShooterDeclaration, ShooterInitData, ShooterObservation } from './api.ts';
import type { CallOutcome, ShooterController } from './runner.ts';

const ok = <T>(value: T): CallOutcome<T> => ({ value, exception: null, timedOut: false, elapsedMs: 0 });

export class ShooterHumanController implements ShooterController {
  readonly label = 'human';
  readonly declaration: ShooterDeclaration = { name: '玩家', version: '', style: '人類玩家', knobs: [] };
  private queue: ShooterCommand[] = [];

  init(_data: ShooterInitData): CallOutcome<null> {
    return ok(null);
  }

  enqueue(cmds: readonly ShooterCommand[]): void {
    this.queue.push(...cmds);
  }

  /** 指令已由 realtime 路徑每 tick 套用，決策 tick 不再另給 */
  decide(_obs: ShooterObservation): CallOutcome<unknown> {
    return ok([]);
  }

  takeRealtime(): unknown[] {
    const commands = JSON.parse(JSON.stringify(this.queue)) as unknown[];
    this.queue = [];
    return commands;
  }
}
