// Elo 類評分。勝率表只用乘除（IEEE 四則運算結果在所有引擎一致），不用 Math.pow／exp，
// 讓「同一份存檔、同一個種子」在不同瀏覽器上得到一樣的勝負。
const RATIO = 1.00577; // 每 1 分的倍率，RATIO^400 ≈ 10（與標準 Elo 的 400 分一個數量級相當）
const MAX_DIFF = 800;

const POW: number[] = (() => {
  const t: number[] = [1];
  for (let i = 1; i <= MAX_DIFF; i++) t.push(t[i - 1] * RATIO);
  return t;
})();

/** 分差（A − B）換成 A 的勝率（千分比，整數，限制在 5～995） */
export function expectedPermille(diff: number): number {
  const d = Math.max(-MAX_DIFF, Math.min(MAX_DIFF, Math.round(diff)));
  const x = d >= 0 ? POW[d] : 1 / POW[-d];
  return Math.max(5, Math.min(995, Math.round((1000 * x) / (1 + x))));
}

/** 一場比賽 A 的評分變化（整數；B 變化 −delta）。score1000：A 勝 1000、平 500、敗 0。 */
export function eloDelta(a: number, b: number, score1000: number, k: number): number {
  const e = expectedPermille(a - b);
  return Math.round((k * (score1000 - e)) / 1000);
}

/** 一場比賽後的新評分。總分守恆。 */
export function updateElo(a: number, b: number, score1000: number, k: number): [number, number] {
  const delta = eloDelta(a, b, score1000, k);
  return [a + delta, b - delta];
}
