// 游標顯示規則（純函式，測試可以直接跑）：準心畫在畫布上，只有真的在瞄準時才藏系統游標。

export interface CursorState {
  readonly spectate: boolean;
  readonly over: boolean;
  readonly paused: boolean;
  readonly buyOpen: boolean;
  readonly alive: boolean;
  readonly focused: boolean;
}

/** 對局中、自己活著、視窗有焦點、沒開選單才藏；觀戰、暫停、購買、結算、陣亡都要看得到游標 */
export const hidesCursor = (s: CursorState): boolean => !s.spectate && !s.over && !s.paused && !s.buyOpen && s.alive && s.focused;
