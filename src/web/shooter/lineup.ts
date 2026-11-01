// 試玩頁的陣容 → 驅動選項（純函式，不碰 DOM、不碰 Worker；Worker 與測試都只呼叫這裡）。
// 基準 Bot 座位走經營層同一條路：角色照 BALANCED_ROLES 排、每位一份 PlayerSpec → 閘道的 seatOf、seatController、seatKnobs。
// 人類佔掉的座位（0 或 5，突破手）空著不衍生；陪練座位不吃屬性，全陪練場是最短反應延遲，和基準 Bot 混打時用全 50 屬性的 8 tick（與強度表量測同條件）。
// 所有 Bot 座位都關掉逾時判定（與閘道相同）：結果只由種子與人類操作決定，與機器快慢無關。
// habit 由種子與座位號雜湊（範圍同經營層的 ±60），同種子同陣容的選手完全相同。
import type { PlayerSpec } from '../../manage/gateway.ts';
import type { CompiledBot } from '../../sandbox/compile.ts';
import { TEAM_SIZE } from '../../shooter/config.ts';
import { LEAGUE_FORMAT_ID, formatOptions, seatController, seatKnobs, seatOf } from '../../shooter/gateway.ts';
import { DEFAULT_MAP_ID, MAPS } from '../../shooter/map.ts';
import { BALANCED_ROLES, ROLE_TABLE, reactionTicksFor } from '../../shooter/players.ts';
import { ShooterBatchController, type ShooterController, type ShooterRunOptions } from '../../shooter/runner.ts';
import { DEFAULT_ATTRIBUTES, PLAYER_COUNT } from '../../shooter/sim.ts';
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
    return seatCtl[pid] ?? new ShooterBatchController(bots.practice, 'shooter-practice.js', s.seed, pid, map, { timeLimits: false });
  });
  // 賽制跟聯賽同一份；凍結時間只有觀戰（Bot 對打）照賽制，有人類用引擎預設
  const { freezeTicks, ...format } = formatOptions(LEAGUE_FORMAT_ID);
  const base = { seed: s.seed, mapId: map.id, ...format, controllers, record: true, ...(human === null ? { freezeTicks } : {}), ...(s.loadout !== undefined ? { defaultLoadout: { T: s.loadout, CT: s.loadout } } : {}) };
  if (seats.every((seat) => seat === null)) return base;
  const knobs = seats.map((seat, pid) => (seat !== null ? seatKnobs(seatCtl[pid]!, seat) : {}));
  // 混打：陪練座位用全 50 屬性的延遲（8 tick）；人類座位驅動層一律 0，這裡給的值不會用到
  const mixed = levels.some((l) => l?.kind === 'practice');
  const practiceTicks = reactionTicksFor(DEFAULT_ATTRIBUTES);
  return { ...base, knobs, attributes: seats.map((seat) => seat?.attributes), ...(mixed ? { reactionTicks: seats.map((seat) => seat?.reactionTicks ?? practiceTicks) } : {}) };
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
