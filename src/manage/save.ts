// 存檔：狀態是純 JSON，直接序列化。回放不存（由請求單與種子重跑）。
// 存檔記錄內容包 id；內容包換版後舊存檔不保證相容，原型階段直接作廢。
import type { ContentPack } from './content.ts';
import type { GameState } from './types.ts';
import { SAVE_VERSION } from './types.ts';

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(json: string, content: ContentPack): GameState {
  const s = JSON.parse(json) as GameState;
  if (s.version !== SAVE_VERSION) throw new Error(`存檔版本 ${s.version} 與目前 ${SAVE_VERSION} 不符`);
  if (s.contentId !== content.id) throw new Error(`存檔的內容包 ${s.contentId} 與目前 ${content.id} 不符`);
  return s;
}
