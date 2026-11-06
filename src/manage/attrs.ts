// 選手屬性制（M5 第二批，規格第四節）：表定屬性、上限（公開公式值與隱藏真值）、等級、成長階段、訓練收益、真實強度內插。
// 核心不解讀屬性的意義：屬性代號、哪些可訓練、各流派的基準與成長都由內容包提供（ContentPack.attributes、Lineage.base／growth）。
// 「版本」只剩生成參數：開局用版本算出屬性（版本 3＝流派基準、每版加成長向量），之後只看屬性。
import { Prng } from '../shared/prng.ts';
import type { ContentPack, Lineage } from './content.ts';

/** 參照版本：Lineage.base 是這一版的屬性 */
export const BASE_VERSION = 3;
/** 成長階段名（1～5） */
export const STAGE_NAMES: readonly string[] = ['新秀', '正選', '主力', '明星', '傳奇'];
export const MAX_STAGE = STAGE_NAMES.length;
/** 習慣對真實上限的偏移範圍（每項 −2～+2） */
export const CAP_HABIT_RANGE = 2;

export type Grade = 'D' | 'C-' | 'C' | 'C+' | 'B-' | 'B' | 'B+' | 'A-' | 'A' | 'A+' | 'S';
/** 等級由低到高；索引 i 的下界 ＝ 40 + 5i（D 是 ≤ 44，S 是 ≥ 90） */
export const GRADES: readonly Grade[] = ['D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+', 'S'];

/** 等級（規格 4.2）：0～100 每 5 點一級，≤44 是 D、≥90 是 S */
export function gradeOf(v: number): Grade {
  const i = Math.floor((Math.round(v) - 40) / 5);
  return GRADES[Math.max(0, Math.min(GRADES.length - 1, i))];
}

/** 等級的中間值（NPC 估值、別隊雷達畫點用）：D 取 42、S 取 92 */
export function gradeMid(g: Grade): number {
  const i = GRADES.indexOf(g);
  return i === 0 ? 42 : i === GRADES.length - 1 ? 92 : 40 + 5 * i + 2;
}

const clamp100 = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

export function lineageOfContent(content: ContentPack, id: string): Lineage {
  const l = content.lineages.find((x) => x.id === id);
  if (!l) throw new Error(`未知流派 ${id}`);
  return l;
}

/** 某版本的表定屬性：base ＋ growth × (版本 − 3)，夾 0～100 整數（攻防戰＝derivePlayer 的 habit 0 屬性） */
export function attrsAt(content: ContentPack, lineageId: string, version: number): Record<string, number> {
  const l = lineageOfContent(content, lineageId);
  return Object.fromEntries(content.attributes.keys.map((k) => [k, clamp100((l.base[k] ?? 0) + (l.growth[k] ?? 0) * (version - BASE_VERSION))]));
}

/** 上限對應的舊版本：品階的 capVersion 與流派最高版本取小 */
export function capVersionOf(content: ContentPack, lineageId: string, rarity: string): number {
  const r = content.rarities.find((x) => x.id === rarity);
  if (!r) throw new Error(`未知品階 ${rarity}`);
  return Math.min(r.capVersion, lineageOfContent(content, lineageId).power.length);
}

/** 公開上限（規格 4.2）：可訓練屬性的 base ＋ growth × (capVersion − 3)；只由流派與品階決定，不含習慣 */
export function capPub(content: ContentPack, lineageId: string, rarity: string): Record<string, number> {
  const l = lineageOfContent(content, lineageId);
  const cv = capVersionOf(content, lineageId, rarity);
  return Object.fromEntries(content.attributes.trainable.map((k) => [k, clamp100((l.base[k] ?? 0) + (l.growth[k] ?? 0) * (cv - BASE_VERSION))]));
}

/** 習慣對真實上限的偏移（隱藏）：可訓練屬性各 −2～+2；habit 0 全 0。和攻防戰 habitOffsets 同法、不同鹽 */
export function habitCapOffsets(habit: number, keys: readonly string[]): Record<string, number> {
  if (habit === 0) return Object.fromEntries(keys.map((k) => [k, 0]));
  const rng = Prng.fromInts(habit | 0, 0xca95);
  return Object.fromEntries(keys.map((k) => [k, rng.nextInt(2 * CAP_HABIT_RANGE + 1) - CAP_HABIT_RANGE]));
}

/** 真實上限（隱藏）：capPub ＋ 習慣偏移，再保證不低於目前屬性 */
export function startCaps(content: ContentPack, lineageId: string, rarity: string, habit: number, attrs: Readonly<Record<string, number>>): Record<string, number> {
  const pub = capPub(content, lineageId, rarity);
  const off = habitCapOffsets(habit, content.attributes.trainable);
  return Object.fromEntries(content.attributes.trainable.map((k) => [k, Math.max(attrs[k] ?? 0, clamp100(pub[k] + off[k]))]));
}

/** 強度和 S：可訓練屬性的總和 */
export function strengthSum(content: ContentPack, attrs: Readonly<Record<string, number>>): number {
  return content.attributes.trainable.reduce((s, k) => s + (attrs[k] ?? 0), 0);
}

/** 流派的 Σbase 與 Σgrowth（可訓練屬性） */
function sums(content: ContentPack, l: Lineage): { base: number; growth: number } {
  const t = content.attributes.trainable;
  return { base: t.reduce((s, k) => s + (l.base[k] ?? 0), 0), growth: t.reduce((s, k) => s + (l.growth[k] ?? 0), 0) };
}

/** 階段門檻 T(v) ＝ Σbase ＋ Σgrowth × (v − 3) */
export function stageThreshold(content: ContentPack, lineageId: string, v: number): number {
  const s = sums(content, lineageOfContent(content, lineageId));
  return s.base + s.growth * (v - BASE_VERSION);
}

/** 成長階段（規格 4.4）：S ≥ T(v) 的最大 v（1～5；低於 T(1) 也算 1） */
export function stageOf(content: ContentPack, lineageId: string, attrs: Readonly<Record<string, number>>): number {
  const S = strengthSum(content, attrs);
  let stage = 1;
  for (let v = 2; v <= MAX_STAGE; v++) if (S >= stageThreshold(content, lineageId, v)) stage = v;
  return stage;
}

/** 小數版本 vf ＝ 3 ＋ (S − T(3)) ／ Σgrowth（規格 4.5） */
export function fractionalVersion(content: ContentPack, lineageId: string, attrs: Readonly<Record<string, number>>): number {
  const l = lineageOfContent(content, lineageId);
  const s = sums(content, l);
  if (s.growth <= 0) return BASE_VERSION;
  return BASE_VERSION + (strengthSum(content, attrs) - s.base) / s.growth;
}

/** 屬性 → 流派強度表上的強度（不含習慣）：在 power[] 上依小數版本線性內插，夾 1～最高版本；整數版本時＝表上的值 */
export function powerOfAttrs(content: ContentPack, lineageId: string, attrs: Readonly<Record<string, number>>): number {
  const l = lineageOfContent(content, lineageId);
  const vf = Math.max(1, Math.min(l.power.length, fractionalVersion(content, lineageId, attrs)));
  const lo = Math.floor(vf);
  const hi = Math.min(l.power.length, lo + 1);
  const t = vf - lo;
  return l.power[lo - 1] + (l.power[hi - 1] - l.power[lo - 1]) * t;
}

/** 訓練每節滿收益（百分之一點；2026-11-07 使用者決定 60 → 100：離上限 6 點以上每節 1 點） */
export const TRAIN_FULL_GAIN = 100;
/** 最後幾點開始遞減 */
export const TRAIN_TAPER = 6;
/**
 * 碰上限前的最低收益（等比例 10 → 17）。屬性與上限都是整數，離上限至少 1 點，遞減段最小值本來就是 round(100 × 1/6) = 17；
 * 取 17 讓常數等於實際的最低值（舊值 10 也是 60 × 1/6，同理從來沒生效過）。
 */
export const TRAIN_MIN_GAIN = 17;

/** 每節收益（百分之一點，規格 4.3）：離上限 6 點以上 100，最後 6 點線性遞減、最低 17，碰上限 0 */
export function trainGain(cap: number, cur: number): number {
  if (cur >= cap) return 0;
  return Math.max(TRAIN_MIN_GAIN, Math.round(TRAIN_FULL_GAIN * Math.max(0, Math.min(1, (cap - cur) / TRAIN_TAPER))));
}

/** 練一節：progress 加收益，滿 100 進 1 點（不超過上限；碰上限時進度歸零）。回傳這節的收益 */
export function trainOnce(attrs: Record<string, number>, progress: Record<string, number>, caps: Readonly<Record<string, number>>, key: string): number {
  const cap = caps[key] ?? 0;
  const gain = trainGain(cap, attrs[key] ?? 0);
  progress[key] = (progress[key] ?? 0) + gain;
  while (progress[key] >= 100 && (attrs[key] ?? 0) < cap) {
    progress[key] -= 100;
    attrs[key] = (attrs[key] ?? 0) + 1;
  }
  if ((attrs[key] ?? 0) >= cap) progress[key] = 0;
  return gain;
}
