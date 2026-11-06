// 經營層 → 可玩版的觀戰票：正式版把一場打完的比賽（存檔裡的請求單＋當時的成績單＋顯示用的隊名、選手名、角色版本）
// 寫進 localStorage，開 web/shooter.html#watch；觀戰頁讀到就用請求單重跑那一場（src/shooter/gateway.ts 的 gatewayDriverOptions）。
// 兩頁同源，localStorage 共用；一次只放一張票（後開的蓋掉先開的）。
import type { CoachEvent, MatchOutcome, MatchRequest } from '../../manage/gateway.ts';
import type { CoachInfo } from './protocol.ts';
import { SHOOTER_ENGINE_VERSION } from '../../shooter/config.ts';

export const WATCH_KEY = 'angel-gaming-watch';
export const WATCH_HASH = '#watch';

/** 經營頁把觀戰嵌在全螢幕框裡（賽前按「看比賽」）：沒有賽後卡，看完或跳過就傳訊息回經營頁 */
export const EMBED = new URLSearchParams(location.search).has('embed');
export const LIVE_MSG = 'angel-live';
/**
 * 觀戰框 → 經營頁：over 看完、skip 跳過（教練模式＝離席）；
 * 教練模式另有 call（一則指令生效，經營頁存檔）、left（離席，打到第 round 回合）。
 */
export type LiveMessage =
  | { type: typeof LIVE_MSG; event: 'over' | 'skip' }
  | { type: typeof LIVE_MSG; event: 'call'; call: CoachEvent }
  | { type: typeof LIVE_MSG; event: 'left'; round: number };

export function tellManage(event: 'over' | 'skip'): void {
  parent.postMessage({ type: LIVE_MSG, event } satisfies LiveMessage, location.origin);
}

/** 教練模式的訊息（指令、離席）；不是嵌在經營頁就不送 */
export function tellManageCoach(msg: { event: 'call'; call: CoachEvent } | { event: 'left'; round: number }): void {
  if (!EMBED) return;
  parent.postMessage({ type: LIVE_MSG, ...msg } satisfies LiveMessage, location.origin);
}

/** 教練身分即時看的票（M5 第四批 4b）：開打前的請求單＋顯示資訊＋教練資訊；一次只放一張 */
export const COACH_KEY = 'angel-gaming-coach';
export const COACH_HASH = '#coach';

export interface CoachTicket extends Omit<WatchTicket, 'outcome'> {
  readonly coach: CoachInfo;
}

export function writeCoachTicket(t: Omit<CoachTicket, 'engineVersion'>): boolean {
  try {
    localStorage.setItem(COACH_KEY, JSON.stringify({ ...t, engineVersion: SHOOTER_ENGINE_VERSION }));
    return true;
  } catch {
    return false;
  }
}

export function readCoachTicket(): CoachTicket | null {
  try {
    const raw = localStorage.getItem(COACH_KEY);
    if (raw === null) return null;
    const t = JSON.parse(raw) as Partial<CoachTicket>;
    if (t.v !== 1 || !t.request || !t.coach || !Array.isArray(t.names) || !Array.isArray(t.teams)) return null;
    return t as CoachTicket;
  } catch {
    return null;
  }
}

const SPEED_KEY = 'angel-gaming-live-speed';

/** 看比賽的速度：下一場沿用（SPEEDS 的索引；沒存過＝null） */
export function loadLiveSpeed(): number | null {
  try {
    const raw = localStorage.getItem(SPEED_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function saveLiveSpeed(i: number): void {
  try {
    localStorage.setItem(SPEED_KEY, String(i));
  } catch {
    // 寫不進去就下次用預設速度
  }
}

export interface WatchTicket {
  readonly v: 1;
  /** 開票時的引擎版本；舊票沒有這欄。不符就不重播：同一張請求單在新引擎是另一場比賽 */
  readonly engineVersion?: string;
  readonly request: MatchRequest;
  /** 存檔裡的成績單（a＝主隊）：重播完拿來對照 */
  readonly outcome: MatchOutcome;
  /** 依 playerId：A 名單 0～4、B 名單 5～9 */
  readonly names: readonly string[];
  /** 依 playerId：角色與版本（打那場時的版本） */
  readonly tags: readonly string[];
  /** 依 playerId：立繪代號（舊票沒有這欄） */
  readonly portraits?: readonly string[];
  /** 0＝主隊（A）、1＝客隊（B） */
  readonly teams: readonly [string, string];
  /** 我方是哪一組（別隊的比賽＝null） */
  readonly mine: 0 | 1 | null;
  /** 例如「例行賽 · 第 3 週」 */
  readonly title: string;
}

export function writeTicket(t: Omit<WatchTicket, 'engineVersion'>): boolean {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify({ ...t, engineVersion: SHOOTER_ENGINE_VERSION }));
    return true;
  } catch {
    return false;
  }
}

/** 票與目前引擎不同版時給玩家看的訊息；同版回傳 null */
export function ticketVersionError(t: WatchTicket): string | null {
  return t.engineVersion === SHOOTER_ENGINE_VERSION ? null : `這場比賽是舊版引擎（${t.engineVersion ?? '1.2 以前'}）打的，目前是 ${SHOOTER_ENGINE_VERSION}：地圖或規則已改，無法重播`;
}

/** 讀票：沒有或格式不對＝null */
export function readTicket(): WatchTicket | null {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    if (raw === null) return null;
    const t = JSON.parse(raw) as Partial<WatchTicket>;
    if (t.v !== 1 || !t.request || !t.outcome || !Array.isArray(t.names) || !Array.isArray(t.teams)) return null;
    return t as WatchTicket;
  } catch {
    return null;
  }
}
