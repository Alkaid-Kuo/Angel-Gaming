// 假比賽：依隱藏強度算勝率再擲骰，幾乎瞬間出結果。
// 用途：在不接對戰引擎的情況下，讓經營核心與自動玩家能跑上百個賽段。
// 只有這個檔案（與 content.ts 的真實強度表）知道「強度怎麼換成勝負」。
// 隊伍強度＝名單每人（版本強度＋習慣＋本場戰術預設加成）的平均；一場一回合擲骰（stub-bo1，比分 1:0）。
import { Prng } from '../shared/prng.ts';
import type { ContentPack, Lineage } from './content.ts';
import type { BattleGateway, MatchFormat, MatchOutcome, MatchRequest, PlayerSpec, SideSpec } from './gateway.ts';
import { expectedPermille } from './rating.ts';

export class FakeGateway implements BattleGateway {
  readonly formats: readonly MatchFormat[];
  private readonly lineages: ReadonlyMap<string, Lineage>;

  constructor(content: ContentPack) {
    this.lineages = new Map(content.lineages.map((l) => [l.id, l]));
    this.formats = [{ id: 'stub-bo1', name: '暫代賽制（單回合擲骰）', rounds: 1, estMsPerRound: 0, lineupSize: content.lineupSize }];
  }

  simulateBatch(requests: readonly MatchRequest[], onProgress?: (done: number, total: number) => void): Promise<MatchOutcome[]> {
    const outs = requests.map((r) => this.one(r));
    onProgress?.(outs.length, outs.length);
    return Promise.resolve(outs);
  }

  private power(p: PlayerSpec): number {
    const lg = this.lineages.get(p.lineageId);
    if (!lg) throw new Error(`未知流派 ${p.lineageId}`);
    const base = lg.power[Math.min(p.version, lg.power.length) - 1];
    return base + Number(p.config.habit ?? 0) + Number(p.config.presetBonus ?? 0);
  }

  private teamPower(side: SideSpec): number {
    if (side.players.length === 0) throw new Error('出賽名單是空的');
    return side.players.reduce((s, p) => s + this.power(p), 0) / side.players.length;
  }

  private one(r: MatchRequest): MatchOutcome {
    const pA = expectedPermille(this.teamPower(r.a) - this.teamPower(r.b));
    const aWins = Prng.fromInts(r.seed).nextInt(1000) < pA;
    return {
      winner: aWins ? 'a' : 'b',
      rounds: [{ label: '單回合', winner: aWins ? 'a' : 'b', scoreA: aWins ? 1 : 0, scoreB: aWins ? 0 : 1 }],
    };
  }
}
