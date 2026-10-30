// 假比賽：依隱藏強度算勝率再擲骰，幾乎瞬間出結果。
// 用途：在不接對戰引擎的情況下，讓經營核心與自動玩家能跑上百個賽段。
// 只有這個檔案（與 content.ts 的真實強度表）知道「強度怎麼換成勝負」。
import { Prng } from '../shared/prng.ts';
import type { ContentPack, Lineage } from './content.ts';
import type { BattleGateway, MatchFormat, MatchOutcome, MatchRequest, SideSpec } from './gateway.ts';
import { expectedPermille } from './rating.ts';

export class FakeGateway implements BattleGateway {
  readonly formats: readonly MatchFormat[] = [{ id: 'stub-bo1', name: '暫代賽制（單回合擲骰）', rounds: 1, estMsPerRound: 0 }];
  private readonly lineages: ReadonlyMap<string, Lineage>;

  constructor(content: ContentPack) {
    this.lineages = new Map(content.lineages.map((l) => [l.id, l]));
  }

  simulateBatch(requests: readonly MatchRequest[]): Promise<MatchOutcome[]> {
    return Promise.resolve(requests.map((r) => this.one(r)));
  }

  private power(side: SideSpec): number {
    const lg = this.lineages.get(side.lineageId);
    if (!lg) throw new Error(`未知流派 ${side.lineageId}`);
    const base = lg.power[Math.min(side.version, lg.power.length) - 1];
    return base + Number(side.config.habit ?? 0) + Number(side.config.presetBonus ?? 0);
  }

  private one(r: MatchRequest): MatchOutcome {
    const pA = expectedPermille(this.power(r.a) - this.power(r.b));
    const aWins = Prng.fromInts(r.seed).nextInt(1000) < pA;
    return {
      winner: aWins ? 'a' : 'b',
      rounds: [{ label: '單回合', winner: aWins ? 'a' : 'b', scoreA: aWins ? 1 : 0, scoreB: aWins ? 0 : 1 }],
    };
  }
}
