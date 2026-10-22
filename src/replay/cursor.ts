// 回放游標：逐 tick 重建比賽，供回放播放器使用；每 600 tick 存快照，跳轉時從最近快照重算。
import { RULES } from '../config/index.ts';
import { Match } from '../core/match.ts';
import { applyDecision, checkReplayVersion, isHashTick, replaySetup, type ReplayDecision, type ReplayFile } from './index.ts';

export class ReplayCursor {
  readonly file: ReplayFile;
  private match: Match;
  private readonly byTick = new Map<number, ReplayDecision[]>();
  private readonly expected = new Map<number, string>();
  private readonly checkpoints = new Map<number, Match>();
  /** 第一個雜湊不符的 tick；null 表示目前一致 */
  desyncTick: number | null = null;

  constructor(file: ReplayFile) {
    checkReplayVersion(file);
    this.file = file;
    for (const d of file.decisions) {
      const list = this.byTick.get(d.tick);
      if (list === undefined) this.byTick.set(d.tick, [d]);
      else list.push(d);
    }
    for (const h of file.hashes) this.expected.set(h.tick, h.hash);
    this.match = new Match(replaySetup(file));
    this.checkpoints.set(0, this.match.clone());
  }

  get current(): Match {
    return this.match;
  }

  get tick(): number {
    return this.match.tick;
  }

  get over(): boolean {
    return this.match.over;
  }

  /** 推進一個 tick；事件保留在各選手的事件佇列，由呼叫端讀取後清除 */
  step(): void {
    const m = this.match;
    if (m.over) return;
    m.beginTick();
    const list = this.byTick.get(m.tick);
    if (list !== undefined) {
      for (let pid = 0; pid < m.playerCount; pid++) {
        if (!m.isAlive(pid)) continue;
        const d = list.find((x) => x.playerId === pid);
        if (d !== undefined) applyDecision(m, pid, d);
      }
    }
    m.endTick();
    // 回放沒有選手讀取事件：清掉避免累積（畫面透過 eventTap 取得事件）
    for (const p of m.state.players) p.events.length = 0;
    if (isHashTick(m.tick)) {
      const want = this.expected.get(m.tick);
      if (want !== undefined && this.desyncTick === null && want !== m.hash()) this.desyncTick = m.tick;
    }
    if (m.tick % RULES.replay.checkpointInterval === 0 && !this.checkpoints.has(m.tick)) this.checkpoints.set(m.tick, m.clone());
  }

  /** 跳到指定 tick（從最近的快照重算） */
  seek(target: number): void {
    let best = 0;
    for (const t of this.checkpoints.keys()) if (t <= target && t > best) best = t;
    const tap = this.match.state.eventTap;
    if (!(this.match.tick <= target && this.match.tick >= best)) this.match = this.checkpoints.get(best)!.clone();
    this.match.state.eventTap = null;
    while (this.match.tick < target && !this.match.over) this.step();
    this.match.state.eventTap = tap;
  }
}
