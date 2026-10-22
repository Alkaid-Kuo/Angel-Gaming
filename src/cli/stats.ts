// CLI 輸出：每場比賽的 JSON 與彙總。
import type { KnobValues } from '../api/types.ts';
import { COMBAT_UNIT_TYPES, ENGINE_VERSION, REJECT_REASONS, SPEC_VERSION, TICKS_PER_SECOND, type MatchMode } from '../config/index.ts';
import type { MatchResult } from '../core/match.ts';
import type { GeneratedMap } from '../mapgen/index.ts';
import type { BotRuntimeStats } from '../sandbox/runner.ts';

export interface BotInfo {
  /** 在 --bots 清單中的索引 */
  readonly index: number;
  readonly file: string;
  readonly name: string;
  readonly version: string;
}

export interface GamePlayerOutput {
  readonly botIndex: number;
  readonly bot: string;
  readonly botFile: string;
  readonly version: string;
  readonly playerId: number;
  readonly start: { readonly tileX: number; readonly tileY: number };
  readonly rank: number;
  readonly eliminatedTick: number | null;
  readonly score: number;
  /** 搶點模式的勝利點（傳統模式為 0） */
  readonly vp: number;
  readonly knobs: KnobValues;
  readonly stats: Record<string, unknown>;
}

export interface GameOutput {
  readonly seed: number;
  readonly mode: MatchMode;
  readonly engineVersion: string;
  readonly specVersion: string;
  readonly exec: string;
  readonly durationTicks: number;
  readonly wallMs: number;
  readonly finalHash: string;
  readonly players: GamePlayerOutput[];
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part * 1000) / whole) / 10;
}

export function gameOutput(
  mode: MatchMode,
  seed: number,
  exec: string,
  map: GeneratedMap,
  slotOf: readonly number[],
  bots: readonly BotInfo[],
  knobs: readonly KnobValues[],
  result: MatchResult,
  runtime: readonly BotRuntimeStats[],
  wallMs: number,
  finalHash: string,
): GameOutput {
  const minutes = result.durationTicks / (TICKS_PER_SECOND * 60);
  const players = result.players.map((p): GamePlayerOutput => {
    const s = p.stats;
    const rt = runtime[p.playerId];
    const combatTotal = COMBAT_UNIT_TYPES.reduce((a, t) => a + s.unitsProduced[t], 0);
    const unitsTotal = Object.values(s.unitsProduced).reduce((a, b) => a + b, 0);
    const buildingsTotal = Object.values(s.buildingsBuilt).reduce((a, b) => a + b, 0);
    const rejections: Record<string, number> = {};
    for (const r of REJECT_REASONS) if (s.rejections[r] > 0) rejections[r] = s.rejections[r];
    const productionRatio: Record<string, number> = {};
    for (const t of COMBAT_UNIT_TYPES) productionRatio[t] = percent(s.unitsProduced[t], combatTotal);
    const slot = map.slots[slotOf[p.playerId]];
    return {
      botIndex: bots[p.playerId].index,
      bot: bots[p.playerId].name,
      botFile: bots[p.playerId].file,
      version: bots[p.playerId].version,
      playerId: p.playerId,
      start: { tileX: slot.tileX, tileY: slot.tileY },
      rank: p.rank,
      eliminatedTick: p.eliminatedTick >= 0 ? p.eliminatedTick : null,
      score: p.score,
      vp: p.vp,
      knobs: knobs[p.playerId],
      stats: {
        gathered: s.gathered,
        unitsProduced: unitsTotal,
        unitsProducedByType: s.unitsProduced,
        unitsLost: s.unitsLost,
        kills: s.unitKills + s.buildingKills,
        unitKills: s.unitKills,
        buildingKills: s.buildingKills,
        buildingsBuilt: buildingsTotal,
        buildingsBuiltByType: s.buildingsBuilt,
        firstExpansionTick: s.firstExpansionTick >= 0 ? s.firstExpansionTick : null,
        firstDamageTick: s.firstDamageTick >= 0 ? s.firstDamageTick : null,
        apm: minutes > 0 ? Math.round((s.commandsIssued / minutes) * 10) / 10 : 0,
        rejections,
        softTimeouts: rt.softTimeouts,
        exceptions: rt.exceptions,
        hardKilled: rt.hardKilled || rt.initKilled,
        // 軍備競賽手冊補充的統計
        towersBuilt: s.buildingsBuilt.tower,
        workerKills: s.workerKills,
        productionRatio,
        scoutCount: s.scoutCount,
        towerHeldTicks: s.towerHeldTicks,
        richGatherRatio: percent(s.richGathered, s.gathered),
        decideMsAvg: rt.decisions > 0 ? Math.round((rt.decideMsTotal / rt.decisions) * 1000) / 1000 : 0,
        decideMsMax: Math.round(rt.decideMsMax * 1000) / 1000,
        errors: rt.errors,
      },
    };
  });
  return { seed, mode, engineVersion: ENGINE_VERSION, specVersion: SPEC_VERSION, exec, durationTicks: result.durationTicks, wallMs: Math.round(wallMs), finalHash, players };
}

/** 彙總：1v1 為各選手勝率；4 人為平均名次與名次分布。依選手檔案（--bots 的順序）統計 */
export function summarize(mode: MatchMode, bots: readonly BotInfo[], games: readonly GameOutput[]): Record<string, unknown> {
  const seats = games.length > 0 ? games[0].players.length : 4;
  const per = bots.map((b) => ({ bot: b.name, version: b.version, file: b.file, games: 0, wins: 0, rankSum: 0, ranks: new Array<number>(seats).fill(0) }));
  for (const g of games) {
    for (const p of g.players) {
      const s = per[p.botIndex];
      s.games += 1;
      if (p.rank === 1) s.wins += 1;
      s.rankSum += p.rank;
      s.ranks[p.rank - 1] += 1;
    }
  }
  if (mode === '1v1') {
    return { games: games.length, bots: per.map((s) => ({ bot: s.bot, version: s.version, file: s.file, games: s.games, wins: s.wins, winRate: percent(s.wins, s.games) })) };
  }
  return {
    games: games.length,
    bots: per.map((s) => ({ bot: s.bot, version: s.version, file: s.file, games: s.games, avgRank: s.games === 0 ? 0 : Math.round((s.rankSum / s.games) * 100) / 100, rankDistribution: s.ranks })),
  };
}

/**
 * Bradley–Terry 最大概似評分（與比賽順序無關），換算為 Elo 尺度（平均 1500）。
 * wins[i][j] = i 勝 j 的次數。
 */
export function eloFromWins(wins: readonly (readonly number[])[]): number[] {
  const n = wins.length;
  // 每人加 0.5 場對虛擬平均對手的勝負，避免全勝／全敗發散
  let p = new Array<number>(n).fill(1);
  for (let iter = 0; iter < 2000; iter++) {
    const next = new Array<number>(n).fill(0);
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      let w = 0.5;
      let denom = 1 / (p[i] + 1);
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const games = wins[i][j] + wins[j][i];
        if (games === 0) continue;
        w += wins[i][j];
        denom += games / (p[i] + p[j]);
      }
      next[i] = w / denom;
    }
    const geo = Math.exp(next.reduce((a, v) => a + Math.log(v), 0) / n);
    for (let i = 0; i < n; i++) {
      next[i] /= geo;
      maxDelta = Math.max(maxDelta, Math.abs(next[i] - p[i]));
    }
    p = next;
    if (maxDelta < 1e-10) break;
  }
  return p.map((v) => Math.round(1500 + 400 * Math.log10(v)));
}
