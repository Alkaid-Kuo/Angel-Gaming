// 介面偏好：玩家自選的隊徽、已讀的信件數、演出速度。只影響畫面，不進遊戲存檔。
import type { CrestSpec } from './art.ts';

const KEY = 'angel-gaming-m4-ui-v1';

export interface Prefs {
  crest: CrestSpec | null;
  inboxSeen: number;
  fast: boolean;
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { crest: null, inboxSeen: 0, fast: false, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // 私密視窗或格式壞掉：用預設值
  }
  return { crest: null, inboxSeen: 0, fast: false };
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 寫不進去就算了：偏好不影響遊戲進度
  }
}
