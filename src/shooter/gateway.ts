// 攻防戰的對戰閘道（純函式；不碰 DOM、不碰 fs）：經營層的請求單（雙方各 5 人的名單＋種子）→ 打一整場 → 成績單（勝負＋逐回合累計比分）。
// Node 殼（src/manage/gateway-shooter.ts）與瀏覽器 Worker 殼（src/web/manage/shooter-batch-worker.ts）都只呼叫 runGatewayMatch，
// 所以同一張請求單在兩邊得到同一個結果。
//
// 名單 → 引擎：流派 id ＝ 角色（ShooterRole）；derivePlayer({ role, version, habit: 0 }) 得到屬性包與旋鈕 role，
// 再把經營層的「習慣」與「本場戰術預設加成」換成強度屬性（aim、reaction、awareness）的同一個偏移：
//   shift ＝ clamp(round(habit / 15), −4, 4) ＋ clamp(round(presetBonus / 15), 0, 6)
// 係數 15 來自步驟 7 的梯度（整隊每屬性點約 15～20 整場 Elo）；用固定換算而不用亂數，讓真實強度與球探報告方向一致。
// 反應延遲由驅動層依屬性重算（reactionTicksFor）。
// 座位：A 名單 0～4、B 名單 5～9（A 上半場當 T）；地圖照請求單的 mapId，沒有就是預設地圖 redrock（赤岩舊城）；種子＝請求單的種子。
// 確定性：控制器關掉逾時判定（timeLimits: false），結果只由程式碼與種子決定；Bot 例外仍算「該次無指令」。
// 觀戰回放（步驟 9）：可玩版的觀戰 Worker 用同一個 gatewayDriverOptions 建 ShooterDriver、逐 tick 推進，
// 所以重播與經營層當時打的那一場是同一場（成績單與終局雜湊相同，test/manage-shooter.test.ts）。
// 試玩頁的基準 Bot 座位（src/web/shooter/lineup.ts）也呼叫 seatOf、seatController、seatKnobs，座位邏輯只有這一份。
import type { MatchFormat, MatchOutcome, MatchRequest, MatchRound, PlayerSpec } from '../manage/gateway.ts';
import type { KnobValues } from '../api/types.ts';
import { resolveKnobs } from '../sandbox/controller.ts';
import type { CompiledBot } from '../sandbox/compile.ts';
import type { Attributes } from './api.ts';
import { ROUND, TEAM_SIZE } from './config.ts';
import { MAPS, type ShooterMap } from './map.ts';
import { derivePlayer, reactionTicksFor, SHOOTER_ROLES, type ShooterRole } from './players.ts';
import { ShooterBatchController, runShooterMatch, type ShooterReplay, type ShooterRunOptions } from './runner.ts';
import { PLAYER_COUNT, type ShooterMatch, type ShooterMatchOptions, type ShooterResult } from './sim.ts';

export const GATEWAY_MAP_ID = 'redrock';

/** 聯賽賽制（規則 1.2 起）；MR12 留作賽制選項（季後賽日後用） */
export const LEAGUE_FORMAT_ID = 'shooter-mr6';

/** 經營層看得到的賽制（estMsPerRound：基準 Bot 2.4.3 整季 7 個 worker 同時跑的量測平均，貼近瀏覽器 4 個 Worker 實際等待；Node 單執行緒約 1256，見 Bot 2.4.3 強度與耗時重量報告） */
export const SHOOTER_FORMATS: readonly MatchFormat[] = [
  { id: 'shooter-mr6', name: '攻防戰 MR6（先到 7 勝、MR3 加時）', rounds: 12, estMsPerRound: 1500, lineupSize: TEAM_SIZE, watchable: true },
  // 量測用（MR6 對 MR8 對照），聯賽賽制不是這個
  { id: 'shooter-mr8', name: '攻防戰 MR8（先到 9 勝、MR3 加時）', rounds: 16, estMsPerRound: 1500, lineupSize: TEAM_SIZE, watchable: true },
  { id: 'shooter-mr12', name: '攻防戰 MR12（先到 13 勝、MR3 加時）', rounds: 24, estMsPerRound: 1500, lineupSize: TEAM_SIZE, watchable: true },
  { id: 'shooter-short', name: '攻防戰短賽制（測試用：每半場 1 回合、先到 2 勝、不加時，1:1 平手）', rounds: 2, estMsPerRound: 1500, lineupSize: TEAM_SIZE, watchable: true },
];

type FormatOptions = Pick<ShooterMatchOptions, 'roundsPerHalf' | 'winRounds' | 'overtime' | 'freezeTicks'>;

/** 各賽制的引擎選項：賽制長度與凍結時間（經營層全是 Bot 對打，都用 Bot 的凍結時間） */
const FORMAT_OPTIONS: Readonly<Record<string, FormatOptions>> = {
  'shooter-mr6': { roundsPerHalf: 6, winRounds: 7, freezeTicks: ROUND.botFreezeTicks },
  'shooter-mr8': { roundsPerHalf: 8, winRounds: 9, freezeTicks: ROUND.botFreezeTicks },
  'shooter-mr12': { freezeTicks: ROUND.botFreezeTicks },
  'shooter-short': { roundsPerHalf: 1, winRounds: 2, overtime: false, freezeTicks: ROUND.botFreezeTicks },
};

/** 賽制的引擎選項（量測腳本也用這份，才與聯賽同一套規則） */
export function formatOptions(id: string): FormatOptions {
  const o = FORMAT_OPTIONS[id];
  if (o === undefined) throw new Error(`攻防戰沒有賽制 ${id}`);
  return o;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const num = (v: number | string | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 經營層 config → 強度屬性偏移（habit：±60 左右的隱藏習慣；presetBonus：本場可用的戰術預設加成） */
export function attributeShift(config: PlayerSpec['config']): number {
  return clamp(Math.round(num(config.habit) / 15), -4, 4) + clamp(Math.round(num(config.presetBonus) / 15), 0, 6);
}

export interface GatewaySeat {
  readonly role: ShooterRole;
  readonly attributes: Attributes;
  readonly knobs: { readonly role: number };
  readonly reactionTicks: number;
}

/** 一位選手的規格 → 座位（屬性包、旋鈕、反應延遲） */
export function seatOf(p: PlayerSpec): GatewaySeat {
  if (!(SHOOTER_ROLES as readonly string[]).includes(p.lineageId)) throw new Error(`攻防戰沒有流派 ${p.lineageId}`);
  const role = p.lineageId as ShooterRole;
  const d = derivePlayer({ role, version: p.version, habit: 0 });
  const shift = attributeShift(p.config);
  const a = d.attributes;
  const attributes: Attributes = { ...a, aim: clamp(a.aim + shift, 0, 100), reaction: clamp(a.reaction + shift, 0, 100), awareness: clamp(a.awareness + shift, 0, 100) };
  return { role, attributes, knobs: { role: Number(d.knobs.role) }, reactionTicks: reactionTicksFor(attributes) };
}

/** 座位的控制器：關掉逾時判定，結果只由程式碼與種子決定；pid 0～4 標 A、5～9 標 B */
export function seatController(bot: CompiledBot, seed: number, pid: number, map: ShooterMap): ShooterBatchController {
  return new ShooterBatchController(bot, pid < TEAM_SIZE ? 'A' : 'B', seed, pid, map, { timeLimits: false });
}

/** 座位的旋鈕：只給選手宣告過的旋鈕（基準 Bot 有 role） */
export function seatKnobs(c: ShooterBatchController, seat: GatewaySeat): KnobValues {
  return resolveKnobs(c.declaration, c.declaration.knobs.some((k) => k.key === 'role') ? seat.knobs : {}, c.label);
}

export function formatOf(id: string): MatchFormat {
  const f = SHOOTER_FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`攻防戰沒有賽制 ${id}`);
  return f;
}

/** 回合標籤：正規「第 n 回合」、加時「加時 n」（n 從加時第一回合算起） */
function roundLabel(n: number, regulation: number): string {
  return n <= regulation ? `第 ${n} 回合` : `加時 ${n - regulation}`;
}

/** 賽段標籤：正規「上半場」「下半場」；加時每段（兩個加時半場）一個「加時 k」 */
export function roundPhase(n: number, rules: Pick<ShooterMatch, 'roundsPerHalf' | 'overtimeRule'>): string {
  const reg = rules.roundsPerHalf * 2;
  if (n <= rules.roundsPerHalf) return '上半場';
  if (n <= reg) return '下半場';
  const per = (rules.overtimeRule?.roundsPerHalf ?? 1) * 2;
  return `加時 ${Math.floor((n - reg - 1) / per) + 1}`;
}

/** 引擎結果 → 成績單（A＝組 0＝玩家 0～4）；rules：該場的半場長度與加時規則（ShooterMatch 本身就有） */
export function outcomeOf(result: ShooterResult, rules: Pick<ShooterMatch, 'roundsPerHalf' | 'overtimeRule'>): MatchOutcome {
  const regulation = rules.roundsPerHalf * 2;
  let a = 0;
  let b = 0;
  const rounds: MatchRound[] = result.rounds.map((r) => {
    if (r.winnerGroup === 0) a++;
    else b++;
    return { label: roundLabel(r.number, regulation), winner: r.winnerGroup === 0 ? 'a' : 'b', scoreA: a, scoreB: b, phase: roundPhase(r.number, rules) };
  });
  return { winner: result.winner === 0 ? 'a' : result.winner === 1 ? 'b' : 'draw', rounds };
}

export interface GatewayMatch {
  readonly outcome: MatchOutcome;
  /** record: true 時才有（回放） */
  readonly replay?: ShooterReplay;
  /** 終局雜湊（與觀戰重播、回放重播對照用） */
  readonly finalHash: string;
  readonly wallMs: number;
  /** 除錯用：Bot 例外次數（不影響結果） */
  readonly exceptions: number;
}

/**
 * 請求單 → 驅動選項（座位、旋鈕、屬性、逾時關閉、賽制長度、是否錄影）。
 * runGatewayMatch 與觀戰 Worker 都只走這裡建 ShooterDriver，兩邊打的是同一場。
 */
export function gatewayDriverOptions(request: MatchRequest, bot: CompiledBot, opts: { record?: boolean } = {}): ShooterRunOptions {
  const format = formatOf(request.formatId);
  for (const side of [request.a, request.b]) {
    if (side.players.length !== format.lineupSize) throw new Error(`攻防戰每方 ${format.lineupSize} 人，名單是 ${side.players.length} 人`);
  }
  const seats = [...request.a.players, ...request.b.players].map(seatOf);
  const buildMap = MAPS[request.mapId ?? GATEWAY_MAP_ID];
  if (buildMap === undefined) throw new Error(`攻防戰沒有地圖 ${request.mapId}`);
  const map = buildMap();
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => seatController(bot, request.seed, pid, map));
  const knobs = controllers.map((c, pid) => seatKnobs(c, seats[pid]));
  const fo = formatOptions(format.id);
  return { seed: request.seed, mapId: map.id, controllers, knobs, attributes: seats.map((s) => s.attributes), record: opts.record === true, ...fo };
}

/** 打一場：同一張請求單＋同一份 Bot 程式碼 → 同一個結果 */
export function runGatewayMatch(request: MatchRequest, bot: CompiledBot, opts: { record?: boolean } = {}): GatewayMatch {
  const run = runShooterMatch(gatewayDriverOptions(request, bot, opts));
  return {
    outcome: outcomeOf(run.result, run.match),
    ...(run.replay ? { replay: run.replay } : {}),
    finalHash: run.finalHash,
    wallMs: run.wallMs,
    exceptions: run.runtime.reduce((s, r) => s + r.exceptions, 0),
  };
}
