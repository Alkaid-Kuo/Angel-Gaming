// 試玩頁的陣容 → 驅動選項（純函式，不碰 DOM、不碰 Worker；Worker 與測試都只呼叫這裡）。
// 基準 Bot 座位走經營層同一條路：角色照 BALANCED_ROLES 排、每位一份 PlayerSpec → 閘道的 seatOf、seatController、seatKnobs。
// 人類佔掉的座位（0 或 5，突破手）空著不衍生；陪練座位維持原樣（不吃屬性、最短反應延遲、保留逾時判定）。
// habit 由種子與座位號雜湊（範圍同經營層的 ±60），同種子同陣容的選手完全相同。
import type { PlayerSpec } from '../../manage/gateway.ts';
import type { CompiledBot } from '../../sandbox/compile.ts';
import { MIN_REACTION_TICKS, TEAM_SIZE } from '../../shooter/config.ts';
import { seatController, seatKnobs, seatOf } from '../../shooter/gateway.ts';
import { DEFAULT_MAP_ID, MAPS } from '../../shooter/map.ts';
import { BALANCED_ROLES, ROLE_TABLE } from '../../shooter/players.ts';
import { ShooterBatchController, type ShooterController, type ShooterRunOptions } from '../../shooter/runner.ts';
import { PLAYER_COUNT } from '../../shooter/sim.ts';
import { Prng } from '../../shared/prng.ts';
import type { BotLevel, Lineup, ShooterSetup } from './protocol.ts';

const PRACTICE: BotLevel = { kind: 'practice' };
const HABIT_RANGE = 60;
const HABIT_TAG = 0x7a1a;

/** 人類的座位（觀戰＝null） */
export function humanSeat(s: Pick<ShooterSetup, 'spectate' | 'team'>): number | null {
  if (s.spectate) return null;
  return s.team === 'T' ? 0 : TEAM_SIZE;
}

/** 依 playerId 的等級（人類座位＝null）；觀戰與玩家當 T 時 lineup.team 在 0～4，玩家當 CT 時在 5～9 */
export function seatLevels(s: Pick<ShooterSetup, 'spectate' | 'team' | 'lineup'>): (BotLevel | null)[] {
  const l: Lineup = s.lineup ?? { team: PRACTICE, enemy: PRACTICE };
  const human = humanSeat(s);
  const [low, high] = human === TEAM_SIZE ? [l.enemy, l.team] : [l.team, l.enemy];
  return Array.from({ length: PLAYER_COUNT }, (_, pid) => (pid === human ? null : pid < TEAM_SIZE ? low : high));
}

export function trialHabit(seed: number, pid: number): number {
  return Prng.fromInts(seed, pid, HABIT_TAG).nextInt(2 * HABIT_RANGE + 1) - HABIT_RANGE;
}

/** 基準 Bot 座位的選手規格（閘道的 PlayerSpec）：流派＝該座位在均衡陣容的角色 */
export function trialSpec(seed: number, pid: number, version: number): PlayerSpec {
  return { lineageId: BALANCED_ROLES[pid % TEAM_SIZE], version, config: { habit: trialHabit(seed, pid) } };
}

/** 試玩設定 → 驅動選項。baseline 只在有基準座位時才呼叫（第一次用到才編譯）；human 是人類座位的控制器（觀戰＝null） */
export function trialRunOptions(s: ShooterSetup, bots: { readonly practice: CompiledBot; readonly baseline: () => CompiledBot }, human: ShooterController | null): ShooterRunOptions {
  const map = MAPS[s.mapId ?? DEFAULT_MAP_ID]();
  const levels = seatLevels(s);
  const seats = levels.map((l, pid) => (l?.kind === 'baseline' ? seatOf(trialSpec(s.seed, pid, l.version)) : null));
  const seatCtl: (ShooterBatchController | null)[] = seats.map((seat, pid) => (seat !== null ? seatController(bots.baseline(), s.seed, pid, map) : null));
  const controllers = levels.map((l, pid): ShooterController => {
    if (l === null) {
      if (human === null) throw new Error('人類座位沒有控制器');
      return human;
    }
    return seatCtl[pid] ?? new ShooterBatchController(bots.practice, 'shooter-practice.js', s.seed, pid, map);
  });
  const base = { seed: s.seed, mapId: map.id, controllers, record: true, ...(s.loadout !== undefined ? { defaultLoadout: { T: s.loadout, CT: s.loadout } } : {}) };
  if (seats.every((seat) => seat === null)) return base;
  const knobs = seats.map((seat, pid) => (seat !== null ? seatKnobs(seatCtl[pid]!, seat) : {}));
  // 有 attributes 時驅動層會替沒給延遲的座位用預設屬性算，所以陪練座位要明講原本的最短延遲
  const mixed = levels.some((l) => l?.kind === 'practice');
  return { ...base, knobs, attributes: seats.map((seat) => seat?.attributes), ...(mixed ? { reactionTicks: seats.map((seat) => seat?.reactionTicks ?? MIN_REACTION_TICKS) } : {}) };
}

/** 依 playerId 的顯示名：「你」、陪練沿用原名、基準 Bot「v3 支援α」 */
export function seatNames(s: ShooterSetup): string[] {
  return seatLevels(s).map((l, pid) => {
    const mark = pid < TEAM_SIZE ? 'α' : 'β';
    if (l === null) return '你';
    if (l.kind === 'baseline') return `v${l.version} ${ROLE_TABLE[BALANCED_ROLES[pid % TEAM_SIZE]].name}${mark}`;
    return `陪練 ${pid % TEAM_SIZE + 1}${mark}`;
  });
}

/** 回放頂層的等級欄：有基準 Bot 座位才加（預設陪練的回放與改前相同） */
export function seatLabels(s: ShooterSetup): { readonly lineup?: readonly string[] } {
  const levels = seatLevels(s);
  if (!levels.some((l) => l?.kind === 'baseline')) return {};
  return { lineup: levels.map((l) => (l === null ? '你' : l.kind === 'baseline' ? `基準 v${l.version}` : '陪練 v5')) };
}
