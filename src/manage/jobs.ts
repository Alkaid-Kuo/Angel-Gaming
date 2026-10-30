// 背景工作：球探、練習賽、戰術研發。指令只是排程並扣費，結果在「推進時間」時一次算完，
// 所以消耗一週：這週排的，下週平日才看得到報告、用得上預設。
import type { ContentPack } from './content.ts';
import type { BattleGateway, MatchRequest } from './gateway.ts';
import { gauss, rngFor, STREAM } from './rng.ts';
import { buildSide, findPlayer, lineageOf, notify, teamOf, truePower } from './state.ts';
import type { GameState } from './types.ts';

export async function processJobs(state: GameState, content: ContentPack, gateway: BattleGateway): Promise<void> {
  const jobs = state.jobs;
  state.jobs = [];
  const e = content.economy;
  for (const job of jobs) {
    const team = teamOf(state, job.teamId);
    const p = findPlayer(state, job.playerId);
    if (!p) continue;
    if (job.kind !== 'scout' && p.teamId !== team.id) {
      notify(state, team.id, 'report', `${p.name} 已不在陣容，排定的工作取消`);
      continue;
    }

    if (job.kind === 'scout') {
      const rng = rngFor(state.seed, STREAM.scout, job.id);
      const est = Math.round(truePower(content, p) + gauss(rng) * e.scoutSd);
      team.intel = team.intel.filter((i) => i.playerId !== p.id);
      team.intel.push({ playerId: p.id, week: state.week, estPower: est, sd: e.scoutSd });
      notify(state, team.id, 'report', `球探報告：${p.name}（${lineageOf(content, p.lineageId).name} v${p.version}）真實強度約 ${est}（誤差 ±${e.scoutSd}）`);
    } else if (job.kind === 'scrim') {
      const opp = findPlayer(state, job.opponentId);
      if (!opp) continue;
      const reqs: MatchRequest[] = [];
      for (let i = 0; i < job.games; i++) {
        reqs.push({ formatId: state.formatId, a: buildSide(p, opp), b: buildSide(opp, p), seed: rngFor(state.seed, STREAM.scrim, job.id, i).nextU32() });
      }
      const outs = await gateway.simulateBatch(reqs);
      const wins = outs.filter((o) => o.winner === 'a').length;
      team.scrims.push({ week: state.week, playerId: p.id, opponentId: opp.id, games: job.games, wins });
      notify(state, team.id, 'report', `練習賽報告：${p.name} 對 ${opp.name} ${job.games} 場 ${wins} 勝（${Math.round((wins * 100) / job.games)}%）`);
    } else {
      const rng = rngFor(state.seed, STREAM.research, job.id);
      const cap = job.target === 'generic' ? e.researchCapGeneric : e.researchCapSpecific;
      const factor = 70 + rng.nextInt(61);
      const bonus = Math.round(((cap * job.games) / (job.games + e.researchHalfSat)) * (factor / 100));
      const reported = Math.round(bonus + (gauss(rng) * 18) / Math.sqrt(1 + job.games / 50));
      p.presets = p.presets.filter((x) => x.target !== job.target && x.version === p.version);
      p.presets.push({ id: `r${job.id}`, target: job.target, version: p.version, bonus, reportedBonus: reported });
      if (p.presets.length > e.researchMaxPresets) p.presets.shift();
      const label = job.target === 'generic' ? '泛用' : `針對${lineageOf(content, job.target).name}`;
      notify(state, team.id, 'report', `研發完成：${p.name} 的${label}戰術預設，估計加成約 ${reported}（${job.games} 場樣本）`);
    }
  }
}
