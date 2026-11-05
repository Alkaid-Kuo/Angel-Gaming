// @ts-check
// 效用選擇（2.7 批 3）：把「有條件的決策」寫成幾個候選選項，各自用可觀察的狀態算分數，取最高分。
//   1. 分數只來自可觀察狀態，同樣狀態永遠同樣選擇（可解釋、可回放、可測）
//   2. 前兩名分差在 tie 內才用全隊一致的確定性雜湊（rollOf）二選一，讓兩個都合理時對手讀不出固定選擇
//   3. 係數放在 P 表（之後接 M5 的戰術手冊／選手屬性）
//   4. 對手適應只在 0.75～1.25 之間調整分數（由呼叫的人乘進去）
//   滯後：選定後 hold 秒內不換；之後新的第一名要贏過目前的 margin 以上才換（每 0.1 秒決策一次，避免在邊界來回跳）

/** @typedef {{ id: string, score: number }} Option */

export class Choice {
  constructor() {
    /** 目前的選擇、選定的 tick、針對哪個情況（key 變了就重選） */
    this.pick = '';
    this.since = -1;
    this.key = '';
  }

  reset() {
    this.pick = '';
    this.since = -1;
    this.key = '';
  }

  /**
   * @param {string} key 這次決策針對的情況（例：哪一團火）
   * @param {number} t 現在 tick
   * @param {Option[]} options 可行的候選（不可行的不要放進來）
   * @param {number} roll 平手打破用的確定性雜湊（全隊一致）
   * @param {{ tie: number, hold: number, margin: number }} cfg hold 以 tick 計
   * @returns {Option | null}
   */
  choose(key, t, options, roll, cfg) {
    if (options.length === 0) return null;
    if (key !== this.key) {
      this.key = key;
      this.pick = '';
      this.since = -1;
    }
    const sorted = [...options].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    let best = sorted[0];
    if (sorted.length > 1 && sorted[0].score - sorted[1].score < cfg.tie) best = sorted[roll % 2];
    const cur = options.find((o) => o.id === this.pick);
    if (cur !== undefined && (t - this.since < cfg.hold || best.score - cur.score < cfg.margin)) return cur;
    this.pick = best.id;
    this.since = t;
    return best;
  }
}
