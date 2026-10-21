// 回放：只保存 seed 與指令紀錄，播放時以引擎重新模擬；每 100 tick 的狀態雜湊用來偵測不同步。
import type { KnobValues } from '../api/types.ts';
import { ENGINE_VERSION, RULES, SPEC_VERSION, type MatchMode } from '../config/index.ts';
import { Match } from '../core/match.ts';

export const REPLAY_FORMAT = 1;

export interface ReplayPlayer {
  readonly playerId: number;
  readonly bot: string;
  readonly version: string;
  readonly knobs: KnobValues;
}

export interface ReplayDecision {
  readonly tick: number;
  readonly playerId: number;
  /** 選手回傳的原始指令（已轉成 JSON 安全的副本） */
  readonly commands: unknown;
  /** 軟超時作廢：不套用 */
  readonly voided?: true;
  /** 旋鈕變更（戰術暫停） */
  readonly knobs?: KnobValues;
}

export interface ReplayHash {
  readonly tick: number;
  readonly hash: string;
}

export interface ReplayFile {
  readonly format: number;
  readonly header: {
    readonly engineVersion: string;
    readonly specVersion: string;
    readonly mode: MatchMode;
    readonly seed: number;
    readonly players: readonly ReplayPlayer[];
  };
  readonly decisions: ReplayDecision[];
  readonly hashes: ReplayHash[];
  result: {
    readonly ranking: readonly number[];
    readonly durationTicks: number;
    readonly finalHash: string;
  } | null;
}

export class ReplayVersionError extends Error {}
export class ReplayDesyncError extends Error {
  readonly tick: number;
  constructor(tick: number, expected: string, actual: string) {
    super(`回放不同步：tick ${tick} 預期雜湊 ${expected}，實際 ${actual}`);
    this.tick = tick;
  }
}

export function createReplay(mode: MatchMode, seed: number, players: readonly ReplayPlayer[]): ReplayFile {
  return {
    format: REPLAY_FORMAT,
    header: { engineVersion: ENGINE_VERSION, specVersion: SPEC_VERSION, mode, seed, players },
    decisions: [],
    hashes: [],
    result: null,
  };
}

/** 是否為記錄雜湊的 tick 邊界（處理完 tick - 1 之後） */
export function isHashTick(tick: number): boolean {
  return tick % RULES.replay.hashInterval === 0;
}

export interface ReplayRunOutput {
  readonly hashes: ReplayHash[];
  readonly finalHash: string;
  readonly ranking: readonly number[];
  readonly durationTicks: number;
}

/**
 * 以回放重建比賽。verify = true 時，每個記錄的雜湊都必須相符，否則拋出 ReplayDesyncError。
 * onTick 可用於播放器（每 tick 結束後呼叫）。
 */
export function runReplay(file: ReplayFile, verify = true, onTick?: (m: Match) => void): ReplayRunOutput {
  if (file.format !== REPLAY_FORMAT) throw new ReplayVersionError(`回放格式 ${file.format} 不支援（目前 ${REPLAY_FORMAT}）`);
  if (file.header.engineVersion !== ENGINE_VERSION || file.header.specVersion !== SPEC_VERSION) {
    throw new ReplayVersionError(`回放版本不符：引擎 ${file.header.engineVersion}／規格 ${file.header.specVersion}，目前為 ${ENGINE_VERSION}／${SPEC_VERSION}`);
  }
  const m = new Match({ mode: file.header.mode, seed: file.header.seed, players: file.header.players.map((p) => ({ knobs: p.knobs })) });
  m.setRecordEvents(false);
  const byTick = new Map<number, ReplayDecision[]>();
  for (const d of file.decisions) {
    const list = byTick.get(d.tick);
    if (list === undefined) byTick.set(d.tick, [d]);
    else list.push(d);
  }
  const expected = new Map<number, string>();
  for (const h of file.hashes) expected.set(h.tick, h.hash);
  const hashes: ReplayHash[] = [];
  while (!m.over) {
    m.beginTick();
    if (m.isDecisionTick()) {
      const list = byTick.get(m.tick) ?? [];
      for (let pid = 0; pid < m.playerCount; pid++) {
        if (!m.isAlive(pid)) continue;
        m.discardObservation(pid);
        const d = list.find((x) => x.playerId === pid);
        if (d === undefined) continue;
        if (d.knobs !== undefined) m.setKnobs(pid, d.knobs);
        if (d.voided !== true) m.applyCommands(pid, d.commands);
      }
    }
    m.endTick();
    if (isHashTick(m.tick)) {
      const hash = m.hash();
      hashes.push({ tick: m.tick, hash });
      const want = expected.get(m.tick);
      if (verify && want !== undefined && want !== hash) throw new ReplayDesyncError(m.tick, want, hash);
    }
    onTick?.(m);
  }
  const finalHash = m.hash();
  if (verify && file.result !== null && file.result.finalHash !== finalHash) {
    throw new ReplayDesyncError(m.tick, file.result.finalHash, finalHash);
  }
  const r = m.result();
  return { hashes, finalHash, ranking: r.ranking, durationTicks: r.durationTicks };
}
