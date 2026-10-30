// 指令：玩家、NPC、自動玩家都發同一套指令（公平、好測試，平衡測試可以用自動玩家大量跑）。
// 指令直接修改傳入的 state（純 JSON 物件）；要保留舊狀態請先 structuredClone。
import { betLimit, fixtureOdds } from './betting.ts';
import type { ContentPack } from './content.ts';
import { capacityLeft, findPlayer, lineageOf, maxVersion, post, rosterOf, teamOf } from './state.ts';
import type { Command, CommandResult, GameState, TeamId } from './types.ts';

const OK: CommandResult = { ok: true };

function fail(reason: string): CommandResult {
  return { ok: false, reason };
}

export function applyCommand(state: GameState, content: ContentPack, teamId: TeamId, cmd: Command): CommandResult {
  if (state.phase !== 'offseason' && state.phase !== 'season') return fail('賽段已結束');
  const team = teamOf(state, teamId);
  const e = content.economy;

  switch (cmd.type) {
    case 'sign': {
      const p = findPlayer(state, cmd.playerId);
      if (!p) return fail('找不到選手');
      if (p.teamId !== null) return fail('不是自由選手');
      if (rosterOf(state, teamId).length >= e.rosterMax) return fail('陣容已滿');
      const fee = p.weeklySalary * e.signingFeeWeeks;
      if (team.cash < fee) return fail('資金不足以支付簽約金');
      post(state, team, 'signing', -fee, `簽約 ${p.name}`);
      p.teamId = teamId;
      p.presets = [];
      return OK;
    }
    case 'release': {
      const p = findPlayer(state, cmd.playerId);
      if (!p || p.teamId !== teamId) return fail('不是自己的選手');
      if (rosterOf(state, teamId).length <= content.lineupSize) return fail(`陣容至少要有 ${content.lineupSize} 人才排得出出賽名單`);
      p.teamId = null;
      p.presets = [];
      p.upgradeUntilWeek = null;
      team.lineup = team.lineup.filter((id) => id !== p.id);
      return OK;
    }
    case 'setLineup': {
      if (cmd.lineup.length !== content.lineupSize) return fail(`出賽名單需要 ${content.lineupSize} 人`);
      if (new Set(cmd.lineup).size !== content.lineupSize) return fail('出賽名單不可重複');
      if (!cmd.lineup.every((id) => findPlayer(state, id)?.teamId === teamId)) return fail('出賽名單含有不是自己的選手');
      team.lineup = [...cmd.lineup];
      return OK;
    }
    case 'upgradeTraining': {
      if (team.trainingLevel >= e.facilityMaintenance.length) return fail('訓練中心已是最高等級');
      const cost = e.facilityUpgradeCost[team.trainingLevel - 1];
      if (team.cash < cost) return fail('資金不足');
      post(state, team, 'facility', -cost, `訓練中心升到 Lv${team.trainingLevel + 1}`);
      team.trainingLevel++;
      return OK;
    }
    case 'upgradeVersion': {
      const p = findPlayer(state, cmd.playerId);
      if (!p || p.teamId !== teamId) return fail('不是自己的選手');
      if (p.upgradeUntilWeek !== null) return fail('已經在升版中');
      if (p.version >= maxVersion(content, p.lineageId)) return fail(`${lineageOf(content, p.lineageId).name}已是最高版本`);
      const cost = p.weeklySalary * e.upgradeCostWeeks;
      if (team.cash < cost) return fail('資金不足');
      post(state, team, 'training', -cost, `${p.name} 升版培訓`);
      p.upgradeUntilWeek = state.week + e.upgradeWeeks;
      return OK;
    }
    case 'bet': {
      if (state.phase !== 'season') return fail('賽季中才能下注');
      const f = state.fixtures.find((x) => x.id === cmd.fixtureId);
      if (!f || f.week !== state.week || f.result !== null) return fail('只能押本週尚未開打的比賽');
      if ((f.home === teamId || f.away === teamId) && (cmd.side === 'home' ? f.home : f.away) !== teamId) return fail('自己的比賽只能押自己贏');
      if (!Number.isInteger(cmd.stake) || cmd.stake < e.betMin) return fail(`單注至少 ${e.betMin}`);
      const already = state.bets.filter((b) => b.teamId === teamId && b.fixtureId === f.id).reduce((s, b) => s + b.stake, 0);
      if (already + cmd.stake > betLimit(content, team.fame)) return fail('超過單場下注上限');
      if (team.cash < cmd.stake) return fail('資金不足');
      const o = fixtureOdds(state, content, f);
      post(state, team, 'bet', -cmd.stake, `下注 ${f.id}`);
      state.bets.push({ id: state.nextId++, teamId, fixtureId: f.id, side: cmd.side, stake: cmd.stake, oddsX100: cmd.side === 'home' ? o.homeX100 : o.awayX100, week: state.week });
      return OK;
    }
    case 'queueScrim': {
      const opp = state.teams.find((t) => t.id === cmd.opponentTeamId);
      if (!opp || opp.id === teamId) return fail('練習賽對手必須是其他戰隊');
      if (!Number.isInteger(cmd.games) || cmd.games < 1) return fail('場數需為正整數');
      if (cmd.games > capacityLeft(state, content, team)) return fail('超過本週訓練中心可跑的場數');
      state.jobs.push({ kind: 'scrim', id: state.nextId++, teamId, opponentTeamId: opp.id, games: cmd.games });
      return OK;
    }
    case 'queueResearch': {
      const p = findPlayer(state, cmd.playerId);
      if (!p || p.teamId !== teamId) return fail('不是自己的選手');
      if (cmd.target !== 'generic' && !content.lineages.some((l) => l.id === cmd.target)) return fail('未知的研發目標');
      if (!Number.isInteger(cmd.games) || cmd.games < 1) return fail('場數需為正整數');
      if (cmd.games > capacityLeft(state, content, team)) return fail('超過本週訓練中心可跑的場數');
      state.jobs.push({ kind: 'research', id: state.nextId++, teamId, playerId: p.id, target: cmd.target, games: cmd.games });
      return OK;
    }
    case 'scout': {
      const p = findPlayer(state, cmd.playerId);
      if (!p || p.teamId === teamId) return fail('球探要看的是別人的選手');
      if (state.jobs.some((j) => j.kind === 'scout' && j.teamId === teamId && j.playerId === p.id)) return fail('已經派球探去看了');
      if (team.cash < e.scoutCost) return fail('資金不足');
      post(state, team, 'scout', -e.scoutCost, `球探 ${p.name}`);
      state.jobs.push({ kind: 'scout', id: state.nextId++, teamId, playerId: p.id });
      return OK;
    }
  }
}
