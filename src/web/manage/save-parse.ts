// 存檔字串 → 狀態（不碰 DOM、localStorage，Node 測試也能直接用）。store.ts 的讀檔、預覽、問題訊息都走這裡。
// 第 5 版（M4 最後一版）到目前版本之間的舊檔交給 manage/save.ts 的 deserialize 串遷移；更舊或比目前新的拒絕，訊息給玩家看。
import { SAVE_VERSION, deserialize, type ContentPack, type GameState } from '../../manage/index.ts';

/** 讀得了的最舊版本（M5 起每批都有「上一版 → 本版」遷移，串起來讀得了 M4 的第 5 版） */
export const OLDEST_MIGRATABLE = 5;

/** 各舊版存檔不能用的原因（標題畫面的訊息） */
export const VERSION_NOTE: Readonly<Record<number, string>> = {
  1: '三個 1 對 1 對位',
  2: '比賽沒有保存請求單，不能觀戰回放',
  3: '地圖與賽制已更新，舊存檔無法沿用',
  4: '新增選手品階與 ID，舊存檔無法沿用',
};

export interface ParsedSave {
  readonly state: GameState;
  readonly content: ContentPack;
  /** 從第幾版遷移上來；本來就是目前版本＝null */
  readonly migratedFrom: number | null;
}

/** 解析存檔：成功回傳狀態與內容包（舊版已遷移）；失敗丟出給玩家看的訊息。kindOf：存檔的 contentId → 內容包 */
export function parseSave(json: string, kindOf: (contentId: string) => ContentPack | undefined): ParsedSave {
  let raw: { version?: unknown; contentId?: unknown };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch {
    throw new Error('存檔格式不對（不是 JSON）');
  }
  const v = raw.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < OLDEST_MIGRATABLE) {
    const note = typeof v === 'number' ? VERSION_NOTE[v] : undefined;
    if (v === 3 || v === 4) throw new Error(`${note}（存檔第 ${v} 版，目前第 ${SAVE_VERSION} 版）`);
    throw new Error(`存檔是第 ${String(v)} 版${note ? `（${note}）` : ''}，目前是第 ${SAVE_VERSION} 版，舊存檔不能繼續`);
  }
  if (v > SAVE_VERSION) throw new Error(`存檔是第 ${v} 版，比這個版本的遊戲（第 ${SAVE_VERSION} 版）新，請用新版開啟`);
  const content = kindOf(String(raw.contentId));
  if (!content) throw new Error(`存檔的項目（內容包 ${String(raw.contentId)}）這個版本沒有`);
  return { state: deserialize(json, content), content, migratedFrom: v === SAVE_VERSION ? null : v };
}
