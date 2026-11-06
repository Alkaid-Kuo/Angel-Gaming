// 教練視角（M5 規格 6.6，視野公平）：教練身分看我方比賽時，畫面只拿得到己方隊伍知道的事。
// 資料只來自己方「活著的」選手的觀察資料（ShooterMatch.observe）聯集，加上計分板的公開欄位；不讀、也不送引擎全狀態。
// - 敵人、雷達接觸、掉落物、煙與火、飛行中的道具、別人的子彈：各活著隊友觀察資料的聯集（去重）。
// - 炸彈：取最有資訊的一份（照引擎既有的可見規則，下包前 CT 方不知道炸彈在誰身上）。
// - 聲音、隊內喊話、自己的子彈與受傷：所看那名隊友的（隊內喊話只有己方，對方的 K: 戰術宣告不在裡面）。
// 陣亡隊友的觀察資料不用（他看到的停在陣亡那一刻）。這個檔不碰 DOM，Node 測試直接驗。
import type { BombInfo, ShooterObservation } from './api.ts';
import type { ShooterMatch } from './sim.ts';

/** 計分板一列（公開資訊）：敵人的金錢是 null */
export interface CoachBoardRow {
  readonly id: number;
  readonly team: ShooterObservation['me']['team'];
  readonly alive: boolean;
  readonly kills: number;
  readonly deaths: number;
  readonly money: number | null;
}

const BOMB_RANK: Readonly<Record<BombInfo['state'], number>> = { unknown: 0, carried: 1, dropped: 2, planting: 3, planted: 3, defusing: 4, defused: 5, exploded: 5 };

function dedupe<T>(lists: readonly (readonly T[])[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of lists) {
    for (const x of l) {
      const k = key(x);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/** 組別 group 的教練視角：所看的隊友 viewId（要是該組的人）的觀察資料，視野類欄位換成活著隊友的聯集 */
export function teamObservation(m: ShooterMatch, group: 0 | 1, viewId: number): ShooterObservation {
  if (m.players[viewId]?.group !== group) throw new Error(`選手 ${viewId} 不是組 ${group} 的人`);
  const base = m.observe(viewId);
  const alive = m.players.filter((p) => p.group === group && p.alive);
  const obs = alive.length === 0 ? [base] : alive.map((p) => (p.id === viewId ? base : m.observe(p.id)));
  const bomb = obs.reduce((b, o) => {
    const r = BOMB_RANK[o.bomb.state] - BOMB_RANK[b.state];
    return r > 0 || (r === 0 && b.x === null && o.bomb.x !== null) ? o.bomb : b;
  }, base.bomb);
  return {
    ...base,
    enemies: dedupe(
      obs.map((o) => o.enemies),
      (e) => String(e.id),
    ),
    radar: dedupe(
      obs.map((o) => o.radar),
      (r) => String(r.id),
    ),
    tracers: dedupe(
      obs.map((o) => o.tracers),
      (t) => `${t.tick}:${t.x0}:${t.y0}:${t.x1}:${t.y1}`,
    ),
    effects: dedupe(
      obs.map((o) => o.effects),
      (e) => `${e.kind}:${e.x}:${e.y}`,
    ),
    items: dedupe(
      obs.map((o) => o.items),
      (i) => `${i.kind}:${i.weapon ?? ''}:${i.x}:${i.y}`,
    ),
    projectiles: dedupe(
      obs.map((o) => o.projectiles),
      (p) => `${p.kind}:${p.x}:${p.y}`,
    ),
    bomb,
  };
}

/** 計分板：存活、擊殺、死亡全場公開；金錢只給己方 */
export function coachBoard(m: ShooterMatch, group: 0 | 1): CoachBoardRow[] {
  return m.players.map((p) => ({ id: p.id, team: p.team, alive: p.alive, kills: p.kills, deaths: p.deaths, money: p.group === group ? p.money : null }));
}

/** 所看的隊友：指定的人活著就是他，否則同組第一個活著的人，全滅時維持原本的人 */
export function coachViewId(m: ShooterMatch, group: 0 | 1, want: number): number {
  const p = m.players[want];
  if (p !== undefined && p.group === group && p.alive) return want;
  return m.players.find((q) => q.group === group && q.alive)?.id ?? (p?.group === group ? want : m.players.find((q) => q.group === group)?.id ?? 0);
}

/** Worker 送給畫面的教練模式 frame 本體（聲音、擊殺訊息、暫停旗標由 Worker 另外加）：沒有引擎全狀態 */
export interface CoachFrameData {
  readonly tick: number;
  readonly viewId: number;
  readonly view: ShooterObservation;
  readonly self: ShooterObservation;
  readonly board: CoachBoardRow[];
  readonly full: null;
}

export function coachFrame(m: ShooterMatch, group: 0 | 1, viewId: number): CoachFrameData {
  const view = teamObservation(m, group, viewId);
  return { tick: m.tick, viewId, view, self: view, board: coachBoard(m, group), full: null };
}
