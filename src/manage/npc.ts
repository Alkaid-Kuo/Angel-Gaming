// NPC 戰隊：與玩家一樣只讀「已知層」視圖、只發同一套指令。個性＝數值組合＋出賽排序風格。
import type { ContentPack, PersonaSpec } from './content.ts';
import type { Prng } from '../shared/prng.ts';
import type { KnownPlayer, KnownView } from './view.ts';
import type { Command, Persona } from './types.ts';
import { LINEUP_SIZE } from './types.ts';

function myPlayers(view: KnownView): KnownPlayer[] {
  const mine = new Set(view.me.roster);
  return view.players.filter((p) => mine.has(p.id));
}

/** 休賽期：依個性簽自由選手，並保留數週的固定支出當緩衝 */
export function npcOffseason(view: KnownView, persona: Persona, spec: PersonaSpec, content: ContentPack): Command[] {
  const e = content.economy;
  const cmds: Command[] = [];
  let cash = view.me.cash;
  let count = view.me.roster.length;
  let fixed = view.me.weeklyFixedCost;

  if (persona === 'whale' && view.me.trainingLevel < 2 && cash > 3500) {
    cmds.push({ type: 'upgradeTraining' });
    cash -= e.facilityUpgradeCost[view.me.trainingLevel - 1];
    fixed += e.facilityMaintenance[view.me.trainingLevel] - e.facilityMaintenance[view.me.trainingLevel - 1];
  }

  const pool = view.players.filter((p) => p.teamId === null);
  if (persona === 'whale') pool.sort((a, b) => b.elo - a.elo || a.weeklySalary - b.weeklySalary);
  else if (persona === 'youth') pool.sort((a, b) => a.weeklySalary - b.weeklySalary || b.elo - a.elo);
  else pool.sort((a, b) => ((b.elo - 1400) * 100) / b.weeklySalary - ((a.elo - 1400) * 100) / a.weeklySalary);

  for (const p of pool) {
    if (count >= Math.min(spec.rosterTarget, e.rosterMax)) break;
    if (persona === 'youth' && p.version > 2) continue;
    const fee = p.weeklySalary * e.signingFeeWeeks;
    if (cash - fee < 8 * (fixed + p.weeklySalary)) continue;
    cmds.push({ type: 'sign', playerId: p.id });
    cash -= fee;
    fixed += p.weeklySalary;
    count++;
  }
  return cmds;
}

/** 每週出賽名單：取公開 Elo 最高的 3 人，再依個性決定對位順序 */
export function npcLineup(view: KnownView, spec: PersonaSpec, rng: Prng): Command[] {
  const top = myPlayers(view)
    .sort((a, b) => b.elo - a.elo || (a.id < b.id ? -1 : 1))
    .slice(0, LINEUP_SIZE)
    .map((p) => p.id);
  if (spec.lineup === 'ace-last') top.reverse();
  else if (spec.lineup === 'random') rng.shuffle(top);
  return [{ type: 'setLineup', lineup: top }];
}
