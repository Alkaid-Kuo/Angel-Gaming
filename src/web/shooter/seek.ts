// 觀戰跳回合：比賽是確定性的，同設定、同種子重跑就是同一場，不用快照。往後跳直接往前推，往前跳才重建驅動。
import type { ShooterDriver } from '../../shooter/runner.ts';

/** 回到第 round 回合的凍結開始；回傳停在那裡的驅動（比賽先結束就停在結束） */
export function seekDriver(cur: ShooterDriver, build: () => ShooterDriver, round: number, onRound?: (at: number) => void): ShooterDriver {
  const d = cur.match.roundNumber < round && !cur.match.over ? cur : build();
  let at = d.match.roundNumber;
  while (!d.match.over && d.match.roundNumber < round) {
    d.step();
    if (d.match.roundNumber !== at) {
      at = d.match.roundNumber;
      onRound?.(at);
    }
  }
  return d;
}
