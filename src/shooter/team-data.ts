// 攻防戰請求單的隊伍層資料（M5）：SideSpec.team 的 q_／pref_／economy 與選手 config 的 p_ → 引擎的 InitTactics、TeamOrders。
// 閘道（gateway.ts）與教練指令排程（coach.ts）都只用這裡的函式，同一張請求單不管有沒有指令都解出同一個計畫。
import type { SideSpec } from '../manage/gateway.ts';
import type { InitTactics, TeamOrders } from './api.ts';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const num = (v: number | string | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 不透明資料裡某個前綴的數值欄位（例 p_rushA → { rushA }），夾到 lo～hi 的整數 */
export function prefixed(bag: Readonly<Record<string, number | string>> | undefined, prefix: string, lo: number, hi: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (bag === undefined) return out;
  for (const [k, v] of Object.entries(bag)) {
    if (k.startsWith(prefix) && typeof v === 'number' && Number.isFinite(v)) out[k.slice(prefix.length)] = clamp(Math.round(v), lo, hi);
  }
  return out;
}

/** 一方的戰術熟練度（每座位一份）；隊伍沒有 team 資料＝null（舊請求單、試玩） */
export function sideTactics(side: SideSpec): (InitTactics | null)[] {
  if (side.team === undefined) return side.players.map(() => null);
  const team = prefixed(side.team, 'q_', 0, 100);
  return side.players.map((p) => ({ team, personal: prefixed(p.config, 'p_', 0, 100) }));
}

/** 一方的教練指令（比賽計畫，沒有命令）；沒有 team 資料＝null */
export function sideOrders(side: SideSpec): TeamOrders | null {
  if (side.team === undefined) return null;
  const e = num(side.team.economy);
  return { pref: prefixed(side.team, 'pref_', -1, 3), economy: e === 1 ? 1 : e === 2 ? 2 : 0, call: null };
}

