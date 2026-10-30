// CS 射擊選手衍生（步驟 7；驅動層資料，不是選手 API）：選手 ＝ 角色（流派）＋版本＋個人習慣。
// derivePlayer 由一個 ShooterPlayerSpec 確定性地算出屬性包（六項 0～100 整數）、旋鈕（基準 Bot 的 role）與反應延遲。
// 版本 3 ＝ 角色基準屬性；每升一版加角色的成長向量（強度主要在 aim／reaction／awareness，風格屬性成長小），版本 1、2 反向扣。
// 個人習慣 habit 經 shared/prng 產生六項各 −4～+4 的偏移（habit = 0 無偏移）。數值都是初值，見規格第十一節。
import type { KnobValues } from '../api/types.ts';
import { Prng } from '../shared/prng.ts';
import type { Attributes } from './api.ts';
import { ATTRIBUTE_KEYS, MIN_REACTION_TICKS, type AttributeKey } from './config.ts';

/** 突破手、狙擊手、支援（道具手）、錨點、游擊 */
export type ShooterRole = 'entry' | 'awp' | 'support' | 'anchor' | 'lurk';
export const SHOOTER_ROLES: readonly ShooterRole[] = ['entry', 'awp', 'support', 'anchor', 'lurk'];

export interface ShooterPlayerSpec {
  readonly role: ShooterRole;
  /** 1～MAX_VERSION */
  readonly version: number;
  /** 個人習慣種子（整數；0 = 無偏移） */
  readonly habit: number;
}

export interface DerivedPlayer {
  readonly attributes: Attributes;
  /** 基準 Bot 的旋鈕：role（1 突破、2 支援、3 錨點、4 狙擊、5 游擊） */
  readonly knobs: KnobValues;
  readonly reactionTicks: number;
}

export const MAX_VERSION = 5;
/** 參照版本（＝角色基準屬性） */
export const BASE_VERSION = 3;
export const HABIT_RANGE = 4;

/** 基準 Bot 旋鈕 role 的代碼（4 ＝ 狙擊沿用 2.0 的意義） */
export const ROLE_KNOB: Readonly<Record<ShooterRole, number>> = { entry: 1, support: 2, anchor: 3, awp: 4, lurk: 5 };

const attrs = (aim: number, reaction: number, awareness: number, aggression: number, discipline: number, movement: number): Attributes => ({ aim, reaction, awareness, aggression, discipline, movement });

/**
 * 角色表：base ＝ 版本 3 的屬性、growth ＝ 每升一版加多少。初值取自 6-2 報告第八節的建議，步驟 7 依量測調過：
 * 侵略不低於 45（侵略低的 CT 架槍太久、撤退早，對陪練吃虧），各角色強度屬性（aim＋reaction＋awareness＋aggression）總和相近（220～240）；
 * 狙擊手的高 aim 只在拿狙擊槍時完整生效（基準 Bot 的狙擊專長：其他槍 aim −25）
 */
export const ROLE_TABLE: Readonly<Record<ShooterRole, { readonly name: string; readonly style: string; readonly base: Attributes; readonly growth: Attributes }>> = {
  entry: { name: '突破手', style: '第一個進點、丟閃，反應快、敢衝', base: attrs(55, 65, 50, 70, 45, 60), growth: attrs(4, 5, 3, 1, 1, 1) },
  awp: { name: '狙擊手', style: '長距離架槍，一槍定生死，不第一個進；換步槍就普通', base: attrs(75, 45, 55, 45, 65, 40), growth: attrs(6, 3, 3, 1, 1, 1) },
  support: { name: '支援', style: '丟煙封點、跟在突破手後補位換血', base: attrs(50, 55, 65, 50, 70, 50), growth: attrs(3, 3, 5, 1, 1, 1) },
  anchor: { name: '錨點', style: '死守包點、不輪轉，紀律最好', base: attrs(55, 50, 70, 45, 75, 45), growth: attrs(4, 3, 5, 1, 1, 1) },
  lurk: { name: '游擊', style: '走第二組與中路，控另一點、繞後', base: attrs(50, 55, 65, 60, 50, 65), growth: attrs(4, 4, 4, 1, 1, 1) },
};

const clampAttr = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/** 反應延遲（tick）：5 + round((100 − reaction) / 100 × 6)；reaction 0 → 11、50 → 8、100 → 5；永遠 ≥ MIN_REACTION_TICKS */
export function reactionTicksFor(a: Attributes): number {
  const r = Math.max(0, Math.min(100, a.reaction));
  return Math.max(MIN_REACTION_TICKS, MIN_REACTION_TICKS + Math.round(((100 - r) / 100) * 6));
}

/** 個人習慣的偏移（六項各 −HABIT_RANGE～+HABIT_RANGE；habit = 0 全 0） */
export function habitOffsets(habit: number): Attributes {
  if (habit === 0) return attrs(0, 0, 0, 0, 0, 0);
  const rng = Prng.fromInts(habit | 0, 0x4ab17);
  return Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, rng.nextInt(2 * HABIT_RANGE + 1) - HABIT_RANGE])) as unknown as Attributes;
}

/** 選手規格檢查：角色合法、版本 1～MAX_VERSION 整數、habit 整數 */
export function validatePlayerSpec(spec: ShooterPlayerSpec): void {
  if (!(SHOOTER_ROLES as readonly string[]).includes(spec.role)) throw new Error(`未知角色：${String(spec.role)}`);
  if (!Number.isInteger(spec.version) || spec.version < 1 || spec.version > MAX_VERSION) throw new Error(`版本必須是 1～${MAX_VERSION} 的整數：${spec.version}`);
  if (!Number.isInteger(spec.habit)) throw new Error(`habit 必須是整數：${spec.habit}`);
}

export function derivePlayer(spec: ShooterPlayerSpec): DerivedPlayer {
  validatePlayerSpec(spec);
  const row = ROLE_TABLE[spec.role];
  const off = habitOffsets(spec.habit);
  const dv = spec.version - BASE_VERSION;
  const attributes = Object.fromEntries(ATTRIBUTE_KEYS.map((k: AttributeKey) => [k, clampAttr(row.base[k] + row.growth[k] * dv + off[k])])) as unknown as Attributes;
  return { attributes, knobs: { role: ROLE_KNOB[spec.role] }, reactionTicks: reactionTicksFor(attributes) };
}

/** 均衡陣容：五個角色各一（座位順序：突破、支援、錨點、游擊、狙擊，與基準 Bot 自動角色的隊內序號一致） */
export const BALANCED_ROLES: readonly ShooterRole[] = ['entry', 'support', 'anchor', 'lurk', 'awp'];

export function balancedLineup(version: number, habit = 0): ShooterPlayerSpec[] {
  return BALANCED_ROLES.map((role) => ({ role, version, habit }));
}
