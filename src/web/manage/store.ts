// 經營頁的遊戲控制器：持有狀態、發指令、推進一週，並在每次變動後存到 localStorage。
// 對戰只經由 BattleGateway：內容包決定用哪個閘道（軍團戰暫代包＝假比賽、攻防戰＝Worker 池跑真引擎）。
// 讀檔時依存檔的 contentId 選內容包與閘道；版本不符或內容包不明時讀不了，介面顯示 saveProblem() 的訊息。
// 觀戰：賽制自報 watchable 時，畫面可用 watchTicket() 取得某場的請求單（存檔原樣），交給可玩版重播。
import {
  FakeGateway,
  SAVE_VERSION,
  STUB_CONTENT,
  advance,
  applyCommand,
  deserialize,
  knownView,
  newGame,
  serialize,
  type AdvanceSummary,
  type BattleGateway,
  type Command,
  type CommandResult,
  type ContentPack,
  type GameState,
  type KnownView,
  type MatchFormat,
  type MatchOutcome,
  type MatchRequest,
  type Phase,
} from '../../manage/index.ts';
import { SHOOTER_CONTENT } from '../../manage/content-shooter.ts';
import { WorkerShooterGateway } from './shooter-gateway.ts';

// 鍵名沿用第 2 版：同一個鍵讀到舊版存檔時才能說清楚「哪一版、為什麼不能用」
const SAVE_KEY = 'angel-gaming-m4-save-v2';
/** 各舊版存檔不能用的原因（標題畫面的訊息） */
const VERSION_NOTE: Readonly<Record<number, string>> = {
  1: '三個 1 對 1 對位',
  2: '比賽沒有保存請求單，不能觀戰回放',
};
/** 舊存檔鍵（SAVE_VERSION 1，三個 1 對 1 對位的年代）；只拿來告訴玩家舊檔不能用了 */
const OLD_SAVE_KEYS = ['angel-gaming-m4-save-v1'];

export interface GameKind {
  readonly content: ContentPack;
  /** 開新局畫面上的名稱與說明 */
  readonly name: string;
  readonly desc: string;
}

/** 可選的項目（內容包）；第一個是預設 */
export const GAME_KINDS: readonly GameKind[] = [
  { content: SHOOTER_CONTENT, name: '攻防戰', desc: '5v5 攻防射擊，基準 Bot 依角色、版本、習慣真打（一週約 20～40 秒模擬，打完的比賽可以觀戰）' },
  { content: STUB_CONTENT, name: '軍團戰（暫代）', desc: '3 人名單，假比賽依隱藏強度擲骰（瞬間出結果）' },
];

export function kindOf(contentId: string): GameKind | undefined {
  return GAME_KINDS.find((k) => k.content.id === contentId);
}

let shooterGateway: WorkerShooterGateway | null = null;

/** 內容包 → 閘道（攻防戰的 Worker 池整個頁面共用一個） */
function gatewayFor(content: ContentPack): BattleGateway {
  if (content.id === SHOOTER_CONTENT.id) {
    shooterGateway ??= new WorkerShooterGateway();
    return shooterGateway;
  }
  return new FakeGateway(content);
}

export interface SaveInfo {
  teamName: string;
  week: number;
  phase: Phase;
  cash: number;
  /** 項目名稱（攻防戰／軍團戰） */
  kind: string;
}

function summarize(state: GameState): SaveInfo {
  const me = state.teams.find((t) => t.id === state.humanTeamId);
  return { teamName: me?.name ?? '?', week: state.week, phase: state.phase, cash: me?.cash ?? 0, kind: kindOf(state.contentId)?.name ?? state.contentId };
}

/** 解析存檔：成功回傳狀態與內容包；失敗丟出給玩家看的訊息 */
function parseSave(json: string): { state: GameState; content: ContentPack } {
  let raw: { version?: unknown; contentId?: unknown };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch {
    throw new Error('存檔格式不對（不是 JSON）');
  }
  if (raw.version !== SAVE_VERSION) {
    const note = typeof raw.version === 'number' ? VERSION_NOTE[raw.version] : undefined;
    throw new Error(`存檔是第 ${String(raw.version)} 版${note ? `（${note}）` : ''}，目前是第 ${SAVE_VERSION} 版，舊存檔不能繼續`);
  }
  const kind = kindOf(String(raw.contentId));
  if (!kind) throw new Error(`存檔的項目（內容包 ${String(raw.contentId)}）這個版本沒有`);
  return { state: deserialize(json, kind.content), content: kind.content };
}

function readSave(): string | null {
  try {
    return localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}

export class ManageGame {
  readonly content: ContentPack;
  state: GameState;
  /** 存檔失敗的原因（私密視窗、容量滿等）；空字串＝正常 */
  saveError = '';
  /** false＝展示模式：不讀也不寫 localStorage，不會覆蓋玩家的存檔 */
  readonly persist: boolean;
  private readonly gateway: BattleGateway;

  private constructor(state: GameState, content: ContentPack, persist = true) {
    this.state = state;
    this.content = content;
    this.persist = persist;
    this.gateway = gatewayFor(content);
  }

  /** contentId 省略＝軍團戰暫代包（舊介面用） */
  static create(seed: number, teamName: string, contentId: string = STUB_CONTENT.id): ManageGame {
    const content = kindOf(contentId)?.content ?? STUB_CONTENT;
    const g = new ManageGame(newGame(seed, content, { humanName: teamName, gateway: gatewayFor(content) }), content);
    g.save();
    return g;
  }

  /** 展示用的局：不存檔（截圖、示範） */
  static demo(seed: number, teamName: string, contentId: string = STUB_CONTENT.id): ManageGame {
    const content = kindOf(contentId)?.content ?? STUB_CONTENT;
    return new ManageGame(newGame(seed, content, { humanName: teamName }), content, false);
  }

  /** 從 localStorage 讀檔；沒有或讀不了回傳 null（原因看 saveProblem()） */
  static load(): ManageGame | null {
    const raw = readSave();
    if (!raw) return null;
    try {
      const { state, content } = parseSave(raw);
      return new ManageGame(state, content);
    } catch {
      return null;
    }
  }

  static fromJson(json: string): ManageGame {
    const { state, content } = parseSave(json);
    const g = new ManageGame(state, content);
    g.save();
    return g;
  }

  static peek(): SaveInfo | null {
    const raw = readSave();
    if (!raw) return null;
    try {
      return summarize(parseSave(raw).state);
    } catch {
      return null;
    }
  }

  /** 有存檔卻讀不了（版本不符、項目不明、壞掉）時的訊息；沒有存檔或讀得了＝null */
  static saveProblem(): string | null {
    const raw = readSave();
    if (raw) {
      try {
        parseSave(raw);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : '存檔讀不了';
      }
    }
    try {
      if (OLD_SAVE_KEYS.some((k) => localStorage.getItem(k) !== null)) return `找到舊版存檔（第 1 版：${VERSION_NOTE[1]}），目前是第 ${SAVE_VERSION} 版，舊存檔不能繼續`;
    } catch {
      return null;
    }
    return null;
  }

  /** 丟掉讀不了的存檔（含舊版鍵），讓標題畫面回到乾淨狀態 */
  static clearBrokenSave(): void {
    try {
      if (readSave() !== null && ManageGame.peek() === null) localStorage.removeItem(SAVE_KEY);
      for (const k of OLD_SAVE_KEYS) localStorage.removeItem(k);
    } catch {
      // 私密視窗等：不處理
    }
  }

  get contentId(): string {
    return this.content.id;
  }

  /** 目前賽制（閘道自報） */
  get format(): MatchFormat | undefined {
    return this.gateway.formats.find((x) => x.id === this.state.formatId);
  }

  view(): KnownView {
    return knownView(this.state, this.content, this.state.humanTeamId, this.format);
  }

  /**
   * 某場打完的比賽的觀戰票：存檔裡的請求單原樣＋當時的成績單（重播完拿來對照）。
   * 賽制不能觀戰、比賽沒打或不存在時回傳 null。請求單含隱藏資料（習慣、預設加成），只交給觀戰頁重跑，不顯示。
   */
  watchTicket(fixtureId: string): { request: MatchRequest; outcome: MatchOutcome } | null {
    if (this.format?.watchable !== true) return null;
    const f = this.state.fixtures.find((x) => x.id === fixtureId);
    const r = f?.result;
    if (!f || !r) return null;
    return {
      request: structuredClone(r.request),
      outcome: { winner: r.winner === null ? 'draw' : r.winner === f.home ? 'a' : 'b', rounds: r.rounds.map((x) => ({ ...x })) },
    };
  }

  command(cmd: Command): CommandResult {
    const r = applyCommand(this.state, this.content, this.state.humanTeamId, cmd);
    if (r.ok) this.save();
    return r;
  }

  /**
   * 推進一週。真引擎在 Worker 裡跑，失敗（例外）時狀態回到推進前，不會存到半套。
   * onProgress：模擬進度（已完成、總數；比賽日一批、練習賽各一批）
   */
  async advance(onProgress?: (done: number, total: number) => void): Promise<AdvanceSummary> {
    const before = serialize(this.state);
    try {
      const r = await advance(this.state, this.content, this.gateway, { onProgress });
      this.save();
      return r;
    } catch (e) {
      this.state = deserialize(before, this.content);
      throw e;
    }
  }

  /**
   * 一批 games 場估計多少毫秒：閘道自報的每回合耗時 × 回合數 × 輪數（場數 ÷ 並行數，進位）。
   * 進位是因為一場只能在一個 Worker 裡跑（2 場、4 個 Worker 也要等一整場）。
   */
  estimateMs(games: number): number {
    const f = this.format;
    if (!f || games <= 0) return 0;
    const par = this.gateway instanceof WorkerShooterGateway ? this.gateway.size : 1;
    return Math.round(Math.ceil(games / par) * f.rounds * f.estMsPerRound);
  }

  /** 推進這一週估計多少毫秒：比賽日一批＋已排的練習賽（每個工作一批，依序跑） */
  estimateWeekMs(): number {
    const n = this.state.fixtures.filter((x) => x.week === this.state.week && x.result === null).length;
    const scrims = this.state.jobs.filter((j) => j.kind === 'scrim').reduce((s, j) => s + this.estimateMs(j.games), 0);
    return this.estimateMs(n) + scrims;
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
