// 人類玩家：與選手相同的指令介面。介面送來的指令在下一個決策 tick 交給引擎（因此也會錄進回放）。
import type { BotDeclaration, Command, GameEvent, InitData } from '../api/types.ts';
import type { ObservationPacket } from '../core/observe.ts';
import type { BotController, DecideOutcome, InitOutcome } from './controller.ts';

export class HumanController implements BotController {
  readonly label = 'human';
  readonly declaration: BotDeclaration = { name: '玩家', version: '', style: '人類玩家', knobs: [] };
  private queue: Command[] = [];
  /** 自上次讀取後收到的事件（介面的事件記錄用） */
  private events: GameEvent[] = [];

  init(_data: InitData): InitOutcome {
    return { exception: null, killed: false, elapsedMs: 0 };
  }

  enqueue(cmds: readonly Command[]): void {
    this.queue.push(...cmds);
  }

  takeEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  decide(packet: ObservationPacket): DecideOutcome {
    this.events.push(...packet.obs.events);
    return { commands: this.takeRealtime(), voided: false, exception: null, killed: false, elapsedMs: 0 };
  }

  /** 人類的指令每個 tick 都會套用（不必等決策 tick） */
  takeRealtime(): Command[] {
    const commands = JSON.parse(JSON.stringify(this.queue)) as Command[];
    this.queue = [];
    return commands;
  }

  dispose(): void {}
}
