// 即時比賽（M5 第四批 4b）的請求單換算：只動閘道契約的 calls 與 coachAi，經營核心不解讀賽制內容。
import type { CoachEvent, MatchRequest } from './gateway.ts';

/**
 * 「請求單＋已喊的指令」批次重跑用的請求單（經營層 finishMatchDay 與測試共用）：玩家的指令只留到離席回合，
 * 我方的 AI 教練：沒離席＝null（玩家喊完整場）；離席且有請助理教練＝離席回合＋1。
 */
export function liveRequest(request: MatchRequest, side: 'a' | 'b', calls: readonly CoachEvent[], leftAt: number | null, assistant: boolean): MatchRequest {
  const ai = { ...(request.coachAi ?? { a: null, b: null }), [side]: leftAt !== null && assistant ? leftAt + 1 : null } as { a: number | null; b: number | null };
  const kept = calls.filter((c) => leftAt === null || c.round <= leftAt);
  return { ...request, calls: kept.map((c) => structuredClone(c)), coachAi: ai };
}
