// 經營層 → 可玩版的觀戰票：正式版把一場打完的比賽（存檔裡的請求單＋當時的成績單＋顯示用的隊名、選手名、角色版本）
// 寫進 localStorage，開 web/shooter.html#watch；觀戰頁讀到就用請求單重跑那一場（src/shooter/gateway.ts 的 gatewayDriverOptions）。
// 兩頁同源，localStorage 共用；一次只放一張票（後開的蓋掉先開的）。
import type { MatchOutcome, MatchRequest } from '../../manage/gateway.ts';

export const WATCH_KEY = 'angel-gaming-watch';
export const WATCH_HASH = '#watch';

export interface WatchTicket {
  readonly v: 1;
  readonly request: MatchRequest;
  /** 存檔裡的成績單（a＝主隊）：重播完拿來對照 */
  readonly outcome: MatchOutcome;
  /** 依 playerId：A 名單 0～4、B 名單 5～9 */
  readonly names: readonly string[];
  /** 依 playerId：角色與版本（打那場時的版本） */
  readonly tags: readonly string[];
  /** 0＝主隊（A）、1＝客隊（B） */
  readonly teams: readonly [string, string];
  /** 我方是哪一組（別隊的比賽＝null） */
  readonly mine: 0 | 1 | null;
  /** 例如「例行賽 · 第 3 週」 */
  readonly title: string;
}

export function writeTicket(t: WatchTicket): boolean {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(t));
    return true;
  } catch {
    return false;
  }
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
