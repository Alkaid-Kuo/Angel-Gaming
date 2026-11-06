// 存檔：狀態是純 JSON，直接序列化。回放不存：每場的請求單存在 FixtureResult.request，觀戰時由它重跑。
// 存檔記錄內容包 id；內容包換版後舊存檔不保證相容。
// M5 起每批提供「上一版 → 本版」的遷移函式，串起來讀得了 M5 開始前（第 5 版）的存檔；第 4 版以前照舊讀不了。
import type { ContentPack } from './content.ts';
import { defaultGamePlan } from './state.ts';
import { logTactics, startPlaybook, startTactics } from './game.ts';
import { emptySeason } from './stats.ts';
import { attrsAt, capVersionOf, startCaps } from './attrs.ts';
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

/**
 * 第 6 版 → 第 7 版（M5 第三批：個人統計）。
 * 舊賽程沒有個人統計，留空；選手賽季累計從 0 開始。戰術紀錄由第 6 版之後已打的比賽的回合戰術標籤補回（和比賽當下累計的規則相同）。
 */
export function migrate6to7(s: GameState): GameState {
  for (const p of s.players) p.season = emptySeason();
  for (const t of s.teams) {
    t.tacticLog = {};
    for (const f of s.fixtures) {
      if (f.result === null) continue;
      if (f.home === t.id) logTactics(t.tacticLog, f.result.rounds, 'a');
      else if (f.away === t.id) logTactics(t.tacticLog, f.result.rounds, 'b');
    }
  }
  s.version = 7;
  return s;
}

/** 第 7 版（M4～M5 第三批）的選手：版本制，升版中有完成週 */
type V7Player = Omit<GameState['players'][number], 'attrs' | 'progress' | 'caps'> & { version?: number; upgradeUntilWeek?: number | null; attrs?: Record<string, number>; progress?: Record<string, number>; caps?: Record<string, number> };

/**
 * 第 7 版 → 第 8 版（M5 第二批：屬性制與訓練；第三批先做，所以第二批是 7 → 8）。
 * 表定屬性＝該版本的流派屬性（和新開局同一套）；升版中的人直接完成那一版再轉（費用已付，週薪照舊制調升）；
 * 真實上限由品階與習慣補；訓練進度 0。球探報告補上「報告當下的屬性」（取遷移後的值）。Elo、戰績不動。
 */
export function migrate7to8(s: GameState, content: ContentPack): GameState {
  const e = content.economy;
  let finished = 0;
  for (const raw of s.players as V7Player[]) {
    let v = raw.version ?? 1;
    if (raw.upgradeUntilWeek !== null && raw.upgradeUntilWeek !== undefined && v < capVersionOf(content, raw.lineageId, raw.rarity)) {
      v += 1;
      raw.weeklySalary = Math.round((raw.weeklySalary * e.salaryGrowthPct) / 100);
      if (raw.teamId === s.humanTeamId) finished++;
    }
    const attrs = attrsAt(content, raw.lineageId, v);
    raw.attrs = attrs;
    raw.caps = startCaps(content, raw.lineageId, raw.rarity, raw.habit, attrs);
    raw.progress = Object.fromEntries(content.attributes.trainable.map((k) => [k, 0]));
    delete raw.version;
    delete raw.upgradeUntilWeek;
  }
  const byId = new Map(s.players.map((p) => [p.id, p]));
  for (const t of s.teams) {
    for (const i of t.intel as (GameState['teams'][number]['intel'][number] & { attrs?: Record<string, number> })[]) i.attrs = { ...(byId.get(i.playerId)?.attrs ?? {}) };
  }
  s.inbox.push({ week: s.week, kind: 'system', text: `版本更新：選手改成屬性制，升版改成每週訓練（${content.attributes.trainable.map((k) => content.attributes.names[k] ?? k).join('、')}逐點練）${finished > 0 ? `；升版中的 ${finished} 人已直接完成那一版` : ''}。` });
  s.version = 8;
  return s;
}

/** 第 8 版 → 第 9 版（M5 球探對戰隊）：每隊補空的球探對戰隊報告 */
export function migrate8to9(s: GameState): GameState {
  for (const t of s.teams) t.teamIntel = [];
  s.version = 9;
  return s;
}

/** 第 9 版 → 第 10 版（M5 第四批 4a：教練指令）：沒有助理教練（NPC 下一個比賽日依個性重新決定請不請） */
export function migrate9to10(s: GameState): GameState {
  for (const t of s.teams) t.assistant = false;
  s.version = 10;
  return s;
}

export function deserialize(json: string, content: ContentPack): GameState {
  let s = JSON.parse(json) as GameState;
  if (s.contentId !== content.id) throw new Error(`存檔的內容包 ${s.contentId} 與目前 ${content.id} 不符`);
  if (s.version === 5) s = migrate5to6(s, content);
  if (s.version === 6) s = migrate6to7(s);
  if (s.version === 7) s = migrate7to8(s, content);
  if (s.version === 8) s = migrate8to9(s);
  if (s.version === 9) s = migrate9to10(s);
  if (s.version !== SAVE_VERSION) throw new Error(`存檔版本 ${s.version} 與目前 ${SAVE_VERSION} 不符`);
  return s;
}
