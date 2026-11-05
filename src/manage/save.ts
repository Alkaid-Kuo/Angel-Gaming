// 存檔：狀態是純 JSON，直接序列化。回放不存：每場的請求單存在 FixtureResult.request，觀戰時由它重跑。
// 存檔記錄內容包 id；內容包換版後舊存檔不保證相容。
// M5 起每批提供「上一版 → 本版」的遷移函式，串起來讀得了 M5 開始前（第 5 版）的存檔；第 4 版以前照舊讀不了。
import type { ContentPack } from './content.ts';
import { defaultGamePlan } from './state.ts';
import { startPlaybook, startTactics } from './game.ts';
import type { GameState } from './types.ts';
import { SAVE_VERSION } from './types.ts';

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

/** 第 5 版（M4）的選手與工作：多了戰術預設與研發 */
type V5Player = GameState['players'][number] & { presets?: unknown };
type V5Job = GameState['jobs'][number] | { kind: 'research'; id: number; teamId: string };

/**
 * 第 5 版 → 第 6 版（M5 第一批：戰術手冊）。
 * 刪戰術預設與排定的研發（研發不收費，不必退款，收件匣說明）；個人熟練度、隊伍默契、比賽計畫照開局初值規則補
 * （個人熟練度用開局的獨立串流與選手序號，和新開局同一套）；舊賽程結果沒有回合戰術標籤，留空。
 * 舊請求單裡的 presetBonus 留著：閘道照舊換算，舊賽程觀戰重跑和當時同一場。
 */
export function migrate5to6(s: GameState, content: ContentPack): GameState {
  for (const p of s.players as V5Player[]) {
    delete p.presets;
    p.tactics = startTactics(content, s.seed, Number(p.id.slice(1)), p.lineageId);
    p.newFace = false;
  }
  for (const t of s.teams) {
    t.playbook = startPlaybook(content, t.persona ?? 'human');
    t.gamePlan = defaultGamePlan(content);
  }
  const jobs = s.jobs as V5Job[];
  const dropped = jobs.filter((j) => j.kind === 'research');
  s.jobs = jobs.filter((j): j is GameState['jobs'][number] => j.kind !== 'research');
  const humanDropped = dropped.some((j) => j.teamId === s.humanTeamId);
  s.inbox.push({ week: s.week, kind: 'system', text: `版本更新：戰術研發改成戰術手冊（排練戰術、設比賽計畫），原有的戰術預設已移除${humanDropped ? '，排定的研發已取消' : ''}。` });
  s.version = 6;
  return s;
}

export function deserialize(json: string, content: ContentPack): GameState {
  let s = JSON.parse(json) as GameState;
  if (s.contentId !== content.id) throw new Error(`存檔的內容包 ${s.contentId} 與目前 ${content.id} 不符`);
  if (s.version === 5) s = migrate5to6(s, content);
  if (s.version !== SAVE_VERSION) throw new Error(`存檔版本 ${s.version} 與目前 ${SAVE_VERSION} 不符`);
  return s;
}
