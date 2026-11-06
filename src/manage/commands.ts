// 指令：玩家、NPC、自動玩家都發同一套指令（公平、好測試，平衡測試可以用自動玩家大量跑）。
// 指令直接修改傳入的 state（純 JSON 物件）；要保留舊狀態請先 structuredClone。
import { betLimit, fixtureOdds } from './betting.ts';
import type { ContentPack } from './content.ts';
import { capacityLeft, findPlayer, post, rosterOf, slotsLeft, teamOf, trainedThisWeek } from './state.ts';
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
      // 個人熟練度跟著人走；隊伍默契等他第一次為本隊出賽時才打折（game.ts 的 newFaceDiscount）
      p.newFace = true;
      return OK;
    }
    case 'release': {
      const p = findPlayer(state, cmd.playerId);
      if (!p || p.teamId !== teamId) return fail('不是自己的選手');
      if (rosterOf(state, teamId).length <= content.lineupSize) return fail(`陣容至少要有 ${content.lineupSize} 人才排得出出賽名單`);
      p.teamId = null;
      p.newFace = false;
      // 排了還沒練的訓練跟著取消（費用不退，和放棄一節一樣）
      state.jobs = state.jobs.filter((j) => !(j.kind === 'train' && j.playerId === p.id));
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
    case 'queueTrain': {
      const p = findPlayer(state, cmd.playerId);
      if (!p || p.teamId !== teamId) return fail('不是自己的選手');
      if (!content.attributes.trainable.includes(cmd.attr)) return fail('只能訓練強度屬性');
      if (!Number.isInteger(cmd.sessions) || cmd.sessions < 1) return fail('節數需為正整數');
      if (trainedThisWeek(state, p.id) + cmd.sessions > e.trainMaxPerPlayer) return fail(`每名選手每週最多練 ${e.trainMaxPerPlayer} 節`);
      if (cmd.sessions > slotsLeft(state, content, team)) return fail('超過本週訓練中心的時段');
      const cost = cmd.sessions * e.trainCost;
      if (team.cash < cost) return fail('資金不足');
      post(state, team, 'training', -cost, `訓練 ${p.name} ${content.attributes.names[cmd.attr] ?? cmd.attr} ×${cmd.sessions}`);
      state.jobs.push({ kind: 'train', id: state.nextId++, teamId, playerId: p.id, attr: cmd.attr, sessions: cmd.sessions });
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
    case 'queueRehearse': {
      if (content.tactics.length === 0) return fail('這個賽制沒有戰術手冊');
      if (!content.tactics.some((t) => t.id === cmd.tactic)) return fail('未知的戰術');
      if (!Number.isInteger(cmd.sessions) || cmd.sessions < 1) return fail('節數需為正整數');
      if (cmd.sessions > slotsLeft(state, content, team)) return fail('超過本週訓練中心的時段');
      const cost = cmd.sessions * e.rehearseCost;
      if (team.cash < cost) return fail('資金不足');
      post(state, team, 'training', -cost, `排練 ${content.tactics.find((t) => t.id === cmd.tactic)?.name ?? cmd.tactic} ×${cmd.sessions}`);
      state.jobs.push({ kind: 'rehearse', id: state.nextId++, teamId, tactic: cmd.tactic, sessions: cmd.sessions });
      return OK;
    }
    case 'setGamePlan': {
      if (content.tactics.length === 0) return fail('這個賽制沒有戰術手冊');
      const plan = cmd.plan;
      if (plan === null || typeof plan !== 'object' || typeof plan.pref !== 'object' || plan.pref === null) return fail('比賽計畫格式不對');
      if (plan.economy !== 0 && plan.economy !== 1 && plan.economy !== 2) return fail('經濟風格只能是 0、1、2');
      const known = new Set(content.tactics.map((t) => t.id));
      for (const [k, v] of Object.entries(plan.pref)) {
        if (!known.has(k)) return fail(`未知的戰術 ${k}`);
        if (!Number.isInteger(v) || v < -1 || v > 3) return fail('偏好只能是 -1（禁用）～3 星');
      }
      const pref = Object.fromEntries(content.tactics.map((t) => [t.id, plan.pref[t.id] ?? 0]));
      for (const side of ['T', 'CT'] as const) {
        const ids = content.tactics.filter((t) => t.side === side).map((t) => t.id);
        if (ids.length > 0 && ids.every((id) => pref[id] === -1)) return fail(`${side} 方至少要留一個戰術`);
      }
      team.gamePlan = { pref, economy: plan.economy };
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
    case 'scoutTeam': {
      // M5 5.3：球探對戰隊，費用同球探；推進一週後回報（含本週那場）
      if (content.tactics.length === 0) return fail('這個賽制沒有戰術手冊');
      const target = state.teams.find((t) => t.id === cmd.teamId);
      if (!target || target.id === teamId) return fail('球探要看的是別隊');
      if (state.phase !== 'season') return fail('賽季還沒開始，沒有比賽可看');
      if (state.jobs.some((j) => j.kind === 'scoutTeam' && j.teamId === teamId && j.targetId === target.id)) return fail('已經派球探去看這隊了');
      if (team.cash < e.scoutCost) return fail('資金不足');
      post(state, team, 'scout', -e.scoutCost, `球探看 ${target.name}`);
      state.jobs.push({ kind: 'scoutTeam', id: state.nextId++, teamId, targetId: target.id });
      return OK;
    }
    default:
      // 舊介面或舊存檔送來已移除的指令（例如 M5 第二批移除的 upgradeVersion）
      return fail('未知的指令');
  }
}
