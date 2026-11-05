// 背景工作：球探、練習賽、戰術排練（M5）。指令只是排程並扣費，結果在「推進時間」時一次算完，
// 所以消耗一週：這週排的，下週平日才看得到報告、熟練度才漲。
import type { ContentPack } from './content.ts';
import type { BattleGateway, MatchRequest } from './gateway.ts';
import { gauss, rngFor, STREAM } from './rng.ts';
import { buildSide, effectiveLineup, findPlayer, grow, lineageOf, notify, playerOf, teamOf, truePower } from './state.ts';
import type { GameState } from './types.ts';

export async function processJobs(state: GameState, content: ContentPack, gateway: BattleGateway, onProgress?: (done: number, total: number) => void): Promise<void> {
  const jobs = state.jobs;
  state.jobs = [];
  const e = content.economy;
  for (const job of jobs) {
    const team = teamOf(state, job.teamId);
    if (job.kind === 'scrim') {
      // 隊對隊：雙方目前的出賽名單（無效時照開賽前補名單的規則補齊，不改存檔裡的名單）
      const opp = teamOf(state, job.opponentTeamId);
      const mine = effectiveLineup(state, content, team).map((id) => playerOf(state, id));
      const theirs = effectiveLineup(state, content, opp).map((id) => playerOf(state, id));
      const reqs: MatchRequest[] = [];
      for (let i = 0; i < job.games; i++) {
        reqs.push({ formatId: state.formatId, a: buildSide(content, team, mine), b: buildSide(content, opp, theirs), seed: rngFor(state.seed, STREAM.scrim, job.id, i).nextU32() });
      }
      const outs = await gateway.simulateBatch(reqs, onProgress);
      const wins = outs.filter((o) => o.winner === 'a').length;
      team.scrims.push({ week: state.week, opponentTeamId: opp.id, games: job.games, wins });
      notify(state, team.id, 'report', `練習賽報告：對 ${opp.name} ${job.games} 場 ${wins} 勝（${Math.round((wins * 100) / job.games)}%）`);
      continue;
    }
    if (job.kind === 'rehearse') {
      rehearse(state, content, job.teamId, job.tactic, job.sessions);
      continue;
    }
    // 球探
    const p = findPlayer(state, job.playerId);
    if (!p) continue;
    {
      const rng = rngFor(state.seed, STREAM.scout, job.id);
      const est = Math.round(truePower(content, p) + gauss(rng) * e.scoutSd);
      team.intel = team.intel.filter((i) => i.playerId !== p.id);
      team.intel.push({ playerId: p.id, week: state.week, estPower: est, sd: e.scoutSd });
      notify(state, team.id, 'report', `球探報告：${p.name}（${lineageOf(content, p.lineageId).name} v${p.version}）真實強度約 ${est}（誤差 ±${e.scoutSd}）`);
    }
  }
}

/** 排練每節的成長（M5 規格 3.3）：隊伍默契 +6、出賽名單個人熟練度 +8，都乘 (1 − cur/100) */
export const REHEARSE_TEAM_GAIN = 6;
export const REHEARSE_PERSONAL_GAIN = 8;

/** 排練：用目前出賽名單（無效時照開賽前補名單的規則補齊，不改存檔），逐節套遞減成長 */
function rehearse(state: GameState, content: ContentPack, teamId: string, tactic: string, sessions: number): void {
  const team = teamOf(state, teamId);
  const spec = content.tactics.find((t) => t.id === tactic);
  if (spec === undefined) return;
  const lineup = effectiveLineup(state, content, team).map((id) => playerOf(state, id));
  const avg = (): number => Math.round(lineup.reduce((s, p) => s + (p.tactics[tactic] ?? 0), 0) / Math.max(1, lineup.length));
  const team0 = Math.round(team.playbook[tactic] ?? 0);
  const avg0 = avg();
  for (let i = 0; i < sessions; i++) {
    team.playbook[tactic] = grow(team.playbook[tactic] ?? 0, REHEARSE_TEAM_GAIN);
    for (const p of lineup) p.tactics[tactic] = grow(p.tactics[tactic] ?? 0, REHEARSE_PERSONAL_GAIN);
  }
  notify(state, team.id, 'report', `排練完成：${spec.name} ${sessions} 節，隊伍默契 ${team0} → ${Math.round(team.playbook[tactic])}，出賽五人個人平均 ${avg0} → ${avg()}`);
}
