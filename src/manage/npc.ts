// NPC 戰隊：與玩家一樣只讀「已知層」視圖、只發同一套指令。個性＝數值組合＋出賽排序風格。
import type { ContentPack, PersonaSpec } from './content.ts';
import type { Prng } from '../shared/prng.ts';
import { raritySpec } from './state.ts';
import type { KnownPlayer, KnownView } from './view.ts';
import type { Command, Persona } from './types.ts';

function myPlayers(view: KnownView): KnownPlayer[] {
  const mine = new Set(view.me.roster);
  return view.players.filter((p) => mine.has(p.id));
}

/** 開局：依個性簽自由選手，並保留數週的固定支出當緩衝 */
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

  // 估值＝公開 Elo＋品階加成：品階代表成長空間，不讓玩家零成本把高品階自由選手撿光
  const value = (p: KnownPlayer): number => p.elo + raritySpec(content, p.rarity).npcEloBonus;
  const pool = view.players.filter((p) => p.teamId === null);
  if (persona === 'whale') pool.sort((a, b) => value(b) - value(a) || a.weeklySalary - b.weeklySalary);
  else if (persona === 'youth') pool.sort((a, b) => a.weeklySalary - b.weeklySalary || value(b) - value(a));
  else pool.sort((a, b) => ((value(b) - 1400) * 100) / b.weeklySalary - ((value(a) - 1400) * 100) / a.weeklySalary);

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

/** 每週出賽名單：取公開 Elo 最高的 size 人，再依個性決定出賽順序 */
export function npcLineup(view: KnownView, spec: PersonaSpec, size: number, rng: Prng): Command[] {
  const top = myPlayers(view)
    .sort((a, b) => b.elo - a.elo || (a.id < b.id ? -1 : 1))
    .slice(0, size)
    .map((p) => p.id);
  if (spec.lineup === 'ace-last') top.reverse();
  else if (spec.lineup === 'random') rng.shuffle(top);
  return [{ type: 'setLineup', lineup: top }];
}

/**
 * 每週戰術手冊（M5）：依個性設比賽計畫，並把本週一半的訓練時段拿去排練兩邊執行熟練度最高的戰術。
 * 計畫：豪門、數據派把每邊最熟的戰術給 2 星、次熟的 1 星；青訓派偏好 rush（1 星）；守財奴不設偏好。
 * 經濟風格：豪門與青訓派積極、守財奴保守、數據派標準。排練費要留 8 週固定支出當緩衝。
 */
export function npcPlaybook(view: KnownView, persona: Persona, content: ContentPack): Command[] {
  if (content.tactics.length === 0) return [];
  const eff = view.me.effective;
  const bySide = (side: 'T' | 'CT'): string[] =>
    content.tactics
      .filter((t) => t.side === side)
      .map((t) => t.id)
      .sort((a, b) => (eff[b] ?? 0) - (eff[a] ?? 0) || (a < b ? -1 : 1));
  const pref: Record<string, number> = Object.fromEntries(content.tactics.map((t) => [t.id, 0]));
  if (persona === 'whale' || persona === 'data') {
    for (const side of ['T', 'CT'] as const) {
      const [first, second] = bySide(side);
      if (first !== undefined) pref[first] = 2;
      if (second !== undefined) pref[second] = 1;
    }
  } else if (persona === 'youth') {
    for (const t of content.tactics) if (t.id.startsWith('rush')) pref[t.id] = 1;
  }
  const economy = persona === 'whale' || persona === 'youth' ? 2 : persona === 'miser' ? 1 : 0;
  const cmds: Command[] = [{ type: 'setGamePlan', plan: { pref, economy } }];

  const half = Math.floor(view.me.capacityLeft / 2);
  const afford = Math.floor((view.me.cash - 8 * view.me.weeklyFixedCost) / Math.max(1, content.economy.rehearseCost));
  const sessions = Math.min(half, afford);
  if (sessions >= 2) {
    const [t] = bySide('T');
    const [ct] = bySide('CT');
    if (t !== undefined) cmds.push({ type: 'queueRehearse', tactic: t, sessions: Math.ceil(sessions / 2) });
    if (ct !== undefined) cmds.push({ type: 'queueRehearse', tactic: ct, sessions: Math.floor(sessions / 2) });
  }
  return cmds;
}
