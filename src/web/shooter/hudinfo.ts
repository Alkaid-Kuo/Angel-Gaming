// HUD 要顯示的值（純函式，不碰 DOM，測試可以直接跑）。
import type { ShooterObservation } from '../../shooter/api.ts';
import type { CamMode } from './camera.ts';
import type { FullState } from './protocol.ts';

/** 觀戰看全部還是所看選手的視野：只有全圖一律看全部，跟隨與自由鏡頭照透視開關 */
export const seesAll = (xray: boolean, mode: CamMode): boolean => xray || mode === 'overview';

/** 這個人的血量：觀戰全員；對局只有自己與隊友，敵人 null */
export function visibleHp(view: ShooterObservation, full: FullState | null, id: number): number | null {
  if (full !== null) return full.players.find((p) => p.id === id)?.hp ?? null;
  if (view.me.id === id) return view.me.hp;
  return view.teammates.find((t) => t.id === id)?.hp ?? null;
}

/** 頂部的時間：凍結與回合中是階段倒數，下包後是炸彈倒數，回合結束不顯示 */
export function clockTicks(view: ShooterObservation): number | null {
  const r = view.round;
  if (r.phase === 'freeze' || r.phase === 'live') return r.phaseTicksLeft;
  if (r.phase === 'planted') return view.bomb.ticksLeft;
  return null;
}

export function clockText(ticks: number, tps: number): string {
  const s = Math.ceil(ticks / tps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
