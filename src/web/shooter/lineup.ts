// 試玩頁的陣容 → 驅動選項（純函式，不碰 DOM、不碰 Worker；Worker 與測試都只呼叫這裡）。
// 基準 Bot 座位走經營層同一條路：角色照 BALANCED_ROLES 排、每位一份 PlayerSpec → 閘道的 seatOf、seatController、seatKnobs。
// 人類佔掉的座位（0 或 5，突破手）空著不衍生；其餘座位都是基準 Bot（沒帶 lineup＝兩邊 v3），延遲由驅動層依屬性算（機率式進位）。
// 所有 Bot 座位都關掉逾時判定（與閘道相同）：結果只由種子與人類操作決定，與機器快慢無關。
// habit 由種子與座位號雜湊（範圍同經營層的 ±60），同種子同陣容的選手完全相同。
import type { PlayerSpec } from '../../manage/gateway.ts';
import type { CompiledBot } from '../../sandbox/compile.ts';
import { TEAM_SIZE } from '../../shooter/config.ts';
import { LEAGUE_FORMAT_ID, formatOptions, seatController, seatKnobs, seatOf } from '../../shooter/gateway.ts';
import { DEFAULT_MAP_ID, MAPS } from '../../shooter/map.ts';
import { BALANCED_ROLES, ROLE_TABLE } from '../../shooter/players.ts';
import type { ShooterController, ShooterRunOptions } from '../../shooter/runner.ts';
import { PLAYER_COUNT } from '../../shooter/sim.ts';
import { Prng } from '../../shared/prng.ts';
import type { BotLevel, Lineup, ShooterSetup } from './protocol.ts';

/** 沒帶 lineup 時兩邊的等級 */
export const DEFAULT_LEVEL: BotLevel = { kind: 'baseline', version: 3 };
const HABIT_RANGE = 60;
const HABIT_TAG = 0x7a1a;

/** 人類的座位（觀戰＝null） */
export function humanSeat(s: Pick<ShooterSetup, 'spectate' | 'team'>): number | null {
  if (s.spectate) return null;
  return s.team === 'T' ? 0 : TEAM_SIZE;
}

/** 依 playerId 的等級（人類座位＝null）；觀戰與玩家當 T 時 lineup.team 在 0～4，玩家當 CT 時在 5～9 */
export function seatLevels(s: Pick<ShooterSetup, 'spectate' | 'team' | 'lineup'>): (BotLevel | null)[] {
  const l: Lineup = s.lineup ?? { team: DEFAULT_LEVEL, enemy: DEFAULT_LEVEL };
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

/** 試玩設定 → 驅動選項。baseline 第一次用到才編譯；human 是人類座位的控制器（觀戰＝null） */
export function trialRunOptions(s: ShooterSetup, bots: { readonly baseline: () => CompiledBot }, human: ShooterController | null): ShooterRunOptions {
  const map = MAPS[s.mapId ?? DEFAULT_MAP_ID]();
  const levels = seatLevels(s);
  const seats = levels.map((l, pid) => (l !== null ? seatOf(trialSpec(s.seed, pid, l.version)) : null));
  const seatCtl = seats.map((seat, pid) => (seat !== null ? seatController(bots.baseline(), s.seed, pid, map) : null));
  const controllers = levels.map((_, pid): ShooterController => {
    const c = seatCtl[pid];
    if (c !== null) return c;
    if (human === null) throw new Error('人類座位沒有控制器');
    return human;
  });
  // 賽制跟聯賽同一份；凍結時間只有觀戰（Bot 對打）照賽制，有人類用引擎預設
  const { freezeTicks, ...format } = formatOptions(LEAGUE_FORMAT_ID);
  const base = { seed: s.seed, mapId: map.id, ...format, controllers, record: true, ...(human === null ? { freezeTicks } : {}), ...(s.loadout !== undefined ? { defaultLoadout: { T: s.loadout, CT: s.loadout } } : {}) };
  // 人類座位沒有旋鈕與屬性（驅動層延遲一律 0）；基準座位的延遲由驅動層依屬性算
  const knobs = seats.map((seat, pid) => (seat !== null ? seatKnobs(seatCtl[pid]!, seat) : {}));
  return { ...base, knobs, attributes: seats.map((seat) => seat?.attributes) };
}

/** 依 playerId 的顯示名：「你」、基準 Bot「v3 支援α」 */
export function seatNames(s: ShooterSetup): string[] {
  return seatLevels(s).map((l, pid) => (l === null ? '你' : `v${l.version} ${ROLE_TABLE[BALANCED_ROLES[pid % TEAM_SIZE]].name}${pid < TEAM_SIZE ? 'α' : 'β'}`));
}

/** 回放頂層的等級欄（依 playerId：「你」或「基準 vN」） */
export function seatLabels(s: ShooterSetup): { readonly lineup: readonly string[] } {
  return { lineup: seatLevels(s).map((l) => (l === null ? '你' : `基準 v${l.version}`)) };
}
