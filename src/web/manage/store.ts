// 經營頁的遊戲控制器：持有狀態、發指令、推進一週，並在每次變動後存到 localStorage。
// 對戰只經由 BattleGateway（目前是假比賽）。
import {
  FakeGateway,
  STUB_CONTENT,
  advance,
  applyCommand,
  deserialize,
  knownView,
  newGame,
  serialize,
  type AdvanceSummary,
  type Command,
  type CommandResult,
  type ContentPack,
  type GameState,
  type KnownView,
  type Phase,
} from '../../manage/index.ts';

const SAVE_KEY = 'angel-gaming-m4-save-v1';

export interface SaveInfo {
  teamName: string;
  week: number;
  phase: Phase;
  cash: number;
}

function summarize(state: GameState): SaveInfo {
  const me = state.teams.find((t) => t.id === state.humanTeamId);
  return { teamName: me?.name ?? '?', week: state.week, phase: state.phase, cash: me?.cash ?? 0 };
}

export class ManageGame {
  readonly content: ContentPack = STUB_CONTENT;
  state: GameState;
  /** 存檔失敗的原因（私密視窗、容量滿等）；空字串＝正常 */
  saveError = '';
  /** false＝展示模式：不讀也不寫 localStorage，不會覆蓋玩家的存檔 */
  readonly persist: boolean;
  private readonly gateway = new FakeGateway(STUB_CONTENT);

  private constructor(state: GameState, persist = true) {
    this.state = state;
    this.persist = persist;
  }

  static create(seed: number, teamName: string): ManageGame {
    const g = new ManageGame(newGame(seed, STUB_CONTENT, { humanName: teamName }));
    g.save();
    return g;
  }

  /** 展示用的局：不存檔（截圖、示範） */
  static demo(seed: number, teamName: string): ManageGame {
    return new ManageGame(newGame(seed, STUB_CONTENT, { humanName: teamName }), false);
  }

  /** 從 localStorage 讀檔；沒有或壞掉回傳 null */
  static load(): ManageGame | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? new ManageGame(deserialize(raw, STUB_CONTENT)) : null;
    } catch {
      return null;
    }
  }

  static fromJson(json: string): ManageGame {
    const g = new ManageGame(deserialize(json, STUB_CONTENT));
    g.save();
    return g;
  }

  static peek(): SaveInfo | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? summarize(deserialize(raw, STUB_CONTENT)) : null;
    } catch {
      return null;
    }
  }

  view(): KnownView {
    return knownView(this.state, this.content, this.state.humanTeamId);
  }

  command(cmd: Command): CommandResult {
    const r = applyCommand(this.state, this.content, this.state.humanTeamId, cmd);
    if (r.ok) this.save();
    return r;
  }

  async advance(): Promise<AdvanceSummary> {
    const r = await advance(this.state, this.content, this.gateway);
    this.save();
    return r;
  }

  exportJson(): string {
    return serialize(this.state);
  }

  private save(): void {
    if (!this.persist) return;
    try {
      localStorage.setItem(SAVE_KEY, serialize(this.state));
      this.saveError = '';
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : '無法存檔';
    }
  }
}
