// 自動玩家：用與玩家相同的指令與「已知層」視圖打完整個賽段。
// 用途：平衡測試（名次分布、破產率、下注報酬、情報值不值錢）與經營核心的回歸測試。
import type { Prng } from '../shared/prng.ts';
import { betLimit, homeWinPermille } from './betting.ts';
import { applyCommand } from './commands.ts';
import type { ContentPack } from './content.ts';
import { advance } from './game.ts';
import type { BattleGateway } from './gateway.ts';
import { rngFor, STREAM } from './rng.ts';
import { gradeMid } from './attrs.ts';
import { publicPrior } from './state.ts';
import type { Command, GameState, TeamId } from './types.ts';
import { REGULAR_WEEKS } from './types.ts';
import type { KnownFixture, KnownPlayer, KnownView } from './view.ts';
import { knownView } from './view.ts';

export type Policy = (view: KnownView, content: ContentPack, rng: Prng) => Command[];

function playerMap(view: KnownView): Map<string, KnownPlayer> {
  return new Map(view.players.map((p) => [p.id, p]));
}

function openFixtures(view: KnownView): KnownFixture[] {
  return view.fixtures.filter((f) => f.week === view.week && f.score === null);
}

/** 我方的注：自己的比賽只能押自己贏 */
function ownBet(view: KnownView, content: ContentPack, fraction: number): Command[] {
  const f = openFixtures(view).find((x) => x.home === view.me.teamId || x.away === view.me.teamId);
  if (!f) return [];
  const limit = betLimit(content, view.me.fame);
  const stake = Math.min(limit, Math.max(content.economy.betMin, Math.round(view.me.cash * fraction)));
  if (stake > view.me.cash) return [];
  return [{ type: 'bet', fixtureId: f.id, side: f.home === view.me.teamId ? 'home' : 'away', stake }];
}

/** 什麼都不做，只靠開賽前自動補名單 */
const passive: Policy = () => [];

/** 豪賭：把陣容簽滿最貴的、訓練中心升一級、每週押自己 10% */
const splurge: Policy = (view, content) => {
  const e = content.economy;
  const cmds: Command[] = [];
  let cash = view.me.cash;
  if (view.phase === 'offseason') {
    if (view.me.trainingLevel < 2 && cash >= e.facilityUpgradeCost[0]) {
      cmds.push({ type: 'upgradeTraining' });
      cash -= e.facilityUpgradeCost[0];
    }
    let count = view.me.roster.length;
    const pool = view.players.filter((p) => p.teamId === null).sort((a, b) => b.elo - a.elo);
    for (const p of pool) {
      const fee = p.weeklySalary * e.signingFeeWeeks;
      if (count >= e.rosterMax || cash < fee) continue;
      cmds.push({ type: 'sign', playerId: p.id });
      cash -= fee;
      count++;
    }
    return cmds;
  }
  return ownBet(view, content, 0.1);
};

/** 穩健：休賽期補 1 名公開 Elo 最高的自由選手當替補（保留 4 週固定支出當緩衝），每週押自己 5% */
const steady: Policy = (view, content) => {
  const e = content.economy;
  if (view.phase === 'offseason') {
    if (view.me.roster.length > content.lineupSize) return [];
    const pool = view.players.filter((p) => p.teamId === null).sort((a, b) => b.elo - a.elo || a.weeklySalary - b.weeklySalary);
    for (const p of pool) {
      const fee = p.weeklySalary * e.signingFeeWeeks;
      if (view.me.cash - fee >= 4 * (view.me.weeklyFixedCost + p.weeklySalary)) return [{ type: 'sign', playerId: p.id }];
    }
    return [];
  }
  return ownBet(view, content, 0.05);
};

/** 亂押：每場都隨機押一邊（自己的比賽押自己），用來驗證長期亂押必虧 */
const randomBettor: Policy = (view, content, rng) => {
  if (view.phase !== 'season') return [];
  const cmds: Command[] = [];
  let cash = view.me.cash;
  for (const f of openFixtures(view)) {
    const mine = f.home === view.me.teamId || f.away === view.me.teamId;
    const side = mine ? (f.home === view.me.teamId ? 'home' : 'away') : rng.nextInt(2) === 0 ? 'home' : 'away';
    const stake = Math.min(betLimit(content, view.me.fame), rng.range(20, 60));
    if (cash - stake < 300) continue;
    cmds.push({ type: 'bet', fixtureId: f.id, side, stake });
    cash -= stake;
  }
  return cmds;
};

function estStrength(view: KnownView, p: KnownPlayer): number {
  const intel = view.intel.find((i) => i.playerId === p.id);
  return intel ? intel.estPower : p.elo;
}

function teamEst(view: KnownView, size: number, teamId: TeamId, players: Map<string, KnownPlayer>): number {
  const ids = view.teams.find((t) => t.id === teamId)?.roster ?? [];
  const ests = ids
    .map((id) => estStrength(view, players.get(id) as KnownPlayer))
    .sort((a, b) => b - a)
    .slice(0, size);
  return ests.reduce((s, x) => s + x, 0) / Math.max(1, ests.length);
}

/** 情報派：每週替兩場別人的比賽買球探情報，只在自己估的勝率比莊家高出一截時下注 */
const scoutBettor: Policy = (view, content) => {
  if (view.phase !== 'season') return [];
  const players = playerMap(view);
  const cmds: Command[] = [];
  let cash = view.me.cash;
  const others = openFixtures(view).filter((f) => f.home !== view.me.teamId && f.away !== view.me.teamId);

  // 本週先對有把握的比賽下注（依手上已有的情報）
  for (const f of others) {
    const odds = view.odds.find((o) => o.fixtureId === f.id);
    if (!odds) continue;
    const p = homeWinPermille(teamEst(view, content.lineupSize, f.home, players), teamEst(view, content.lineupSize, f.away, players));
    const evHome = (p * odds.homeX100) / 1000 / 100;
    const evAway = ((1000 - p) * odds.awayX100) / 1000 / 100;
    const best = evHome >= evAway ? { side: 'home' as const, ev: evHome } : { side: 'away' as const, ev: evAway };
    if (best.ev < 1.08) continue;
    const stake = Math.min(betLimit(content, view.me.fame), Math.round(cash * 0.15));
    if (stake < content.economy.betMin || cash - stake < 400) continue;
    cmds.push({ type: 'bet', fixtureId: f.id, side: best.side, stake });
    cash -= stake;
  }

  // 為下週買情報：看沒有情報的強隊選手
  const upcoming = view.fixtures.filter((f) => f.week === view.week + 1 && f.home !== view.me.teamId && f.away !== view.me.teamId).slice(0, 2);
  for (const f of upcoming) {
    for (const tid of [f.home, f.away]) {
      const ids = view.teams.find((t) => t.id === tid)?.roster ?? [];
      const top = ids
        .map((id) => players.get(id) as KnownPlayer)
        .sort((a, b) => b.elo - a.elo)
        .slice(0, content.lineupSize);
      for (const p of top) {
        if (view.intel.some((i) => i.playerId === p.id) || cash < 400) continue;
        cmds.push({ type: 'scout', playerId: p.id });
        cash -= content.economy.scoutCost;
      }
    }
  }
  return cmds;
};

/** 挖角派：第 1 週前對便宜的自由選手買情報，下週簽下「真實強度遠高於公開 Elo」的人 */
const moneyball: Policy = (view, content) => {
  const e = content.economy;
  const players = playerMap(view);
  const cmds: Command[] = [];
  let cash = view.me.cash;
  const free = view.players.filter((p) => p.teamId === null);
  if (view.phase === 'offseason') {
    const cheap = [...free].sort((a, b) => a.weeklySalary - b.weeklySalary).slice(0, 6);
    for (const p of cheap) {
      if (cash < 600) break;
      cmds.push({ type: 'scout', playerId: p.id });
      cash -= e.scoutCost;
    }
    return cmds;
  }
  if (view.week === 1) {
    let count = view.me.roster.length;
    const picks = free
      .filter((p) => view.intel.some((i) => i.playerId === p.id))
      .map((p) => ({ p, gain: estStrength(view, p) - publicPrior(p.stage) }))
      .filter((x) => x.gain >= 25)
      .sort((a, b) => b.gain / b.p.weeklySalary - a.gain / a.p.weeklySalary);
    for (const { p } of picks) {
      const fee = p.weeklySalary * e.signingFeeWeeks;
      if (count >= e.rosterMax - 1 || cash - fee < 600) continue;
      cmds.push({ type: 'sign', playerId: p.id });
      cash -= fee;
      count++;
    }
  }
  void players;
  return cmds;
};

/**
 * 訓練派（M5 平衡量測用的自動玩家）：照整季算帳，不練到破產。
 * - 保留金＝剩餘週數 ×（固定支出 − 九成贊助）− 剩餘例行賽週數 × 輸球獎金：假設剩下每場都輸、季後賽沒進、名氣往下掉，還付得起薪水與維護。
 * - 升級：升完扣掉保留金，每週預算還要夠排滿 Lv1 的時段（「升後還練得動」），才往 level 升；賽季中任何一週都可以升。
 * - 每週預算＝（現金 − 保留金）÷ 剩餘週數；時段一半排練、一半屬性訓練，訓練平均分給出賽名單（每人練離公開上限等級最遠的那項）。
 */
export function trainerPolicy(level: number): Policy {
  return (view, content) => {
    const e = content.economy;
    const cmds: Command[] = [];
    if (view.phase !== 'offseason' && view.phase !== 'season') return cmds;
    let cash = view.me.cash;
    let lvl = view.me.trainingLevel;
    let fixed = view.me.weeklyFixedCost;
    // 還要付幾次週結算：休賽期（第 0 週）不結算，賽季第 w 週推進時要付
    const weeksLeft = Math.max(1, view.totalWeeks - view.week + (view.phase === 'season' ? 1 : 0));
    const regularLeft = Math.max(0, REGULAR_WEEKS - view.week + (view.phase === 'season' ? 1 : 0));
    const reserve = (f: number): number => Math.max(0, weeksLeft * (f - 0.9 * view.me.weeklySponsor) - regularLeft * e.matchLossPrize);
    const unit = (e.trainCost + e.rehearseCost) / 2;
    while (lvl < level && lvl < e.facilityMaintenance.length) {
      const cost = e.facilityUpgradeCost[lvl - 1];
      const fixedAfter = fixed + e.facilityMaintenance[lvl] - e.facilityMaintenance[lvl - 1];
      if ((cash - cost - reserve(fixedAfter)) / weeksLeft < e.trainingSlots[0] * unit) break;
      cmds.push({ type: 'upgradeTraining' });
      cash -= cost;
      fixed = fixedAfter;
      lvl++;
    }
    const budget = Math.max(0, cash - reserve(fixed)) / weeksLeft;
    let slots = Math.min(e.trainingSlots[lvl - 1] - (e.trainingSlots[view.me.trainingLevel - 1] - view.me.slotsLeft), Math.floor(budget / Math.max(1, unit)));
    if (slots <= 0) return cmds;
    const rehearse = content.tactics.length > 0 ? Math.floor(slots / 2) : 0;
    if (rehearse > 0) {
      const top = [...content.tactics].sort((a, b) => (view.me.effective[a.id] ?? 0) - (view.me.effective[b.id] ?? 0))[0];
      cmds.push({ type: 'queueRehearse', tactic: top.id, sessions: rehearse });
      slots -= rehearse;
    }
    const players = playerMap(view);
    const lineup = (view.me.lineup.length === content.lineupSize ? view.me.lineup : view.me.roster.slice(0, content.lineupSize)).map((id) => players.get(id) as KnownPlayer);
    const per = Math.min(e.trainMaxPerPlayer, Math.floor(slots / Math.max(1, lineup.length)));
    let extra = slots - per * lineup.length;
    for (const p of lineup) {
      const n = Math.min(e.trainMaxPerPlayer, per + (extra > 0 ? 1 : 0));
      if (extra > 0 && n > per) extra--;
      if (n <= 0) continue;
      const k = content.attributes.trainable
        .map((key) => ({ key, gap: gradeMid(p.capGrades?.[key] ?? 'D') - (p.attrs?.[key] ?? 100) }))
        .sort((a, b) => b.gap - a.gap || (a.key < b.key ? -1 : 1))[0].key;
      cmds.push({ type: 'queueTrain', playerId: p.id, attr: k, sessions: n });
    }
    return cmds;
  };
}

export const POLICIES: Readonly<Record<string, Policy>> = { passive, steady, splurge, randomBettor, scoutBettor, moneyball, trainer: trainerPolicy(2) };

/** 用指定策略打完整個賽段（policy 為 null＝完全不介入） */
export async function runSeason(state: GameState, content: ContentPack, gateway: BattleGateway, policy: Policy | null): Promise<GameState> {
  while (state.phase === 'offseason' || state.phase === 'season') {
    if (policy) {
      const cmds = policy(knownView(state, content, state.humanTeamId), content, rngFor(state.seed, STREAM.auto, state.week));
      for (const c of cmds) applyCommand(state, content, state.humanTeamId, c);
    }
    await advance(state, content, gateway);
  }
  return state;
}
