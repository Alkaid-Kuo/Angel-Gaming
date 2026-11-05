// 測試用假 Bot（只在 test/，不進產物）：讀開局 tactics 與每回合 obs.coach，第一次決策喊 B: 與 K:，其他什麼都不做（不移動、不開槍）。
// 用來在 Bot 2.8 之前跑通 M5 驗收工具的「注入 → 標籤 → 統計」整條管線。選法刻意簡單、和規格的目標關係無關：
// 有命令照命令；否則在該陣營沒被禁用的戰術裡取「星級 × 1000 ＋ 隊伍熟練度」最高的（同分取清單前面的）；
// eco 回合（奇數回合，喊 B:eco）排除 default 與 fake。
import type { InitTactics, ShooterDeclaration, ShooterInitData, ShooterObservation } from '../src/shooter/api.ts';
import type { CallOutcome, ShooterController } from '../src/shooter/runner.ts';
import { CT_TACTICS, T_TACTICS } from '../scripts/shooter-coach-lib.ts';

const ok = <T>(value: T): CallOutcome<T> => ({ value, exception: null, timedOut: false, elapsedMs: 0 });

export class CoachStub implements ShooterController {
  readonly label: string;
  readonly declaration: ShooterDeclaration;
  tactics: InitTactics | null = null;
  private said = -1;
  constructor(label = 'coach-stub') {
    this.label = label;
    this.declaration = { name: label, version: '', style: 'stub', knobs: [] };
  }
  init(data: ShooterInitData): CallOutcome<null> {
    this.tactics = data.tactics;
    return ok(null);
  }
  decide(obs: ShooterObservation): CallOutcome<unknown> {
    const n = obs.round.number;
    if (n === this.said) return ok([]);
    this.said = n;
    const eco = n % 2 === 1;
    const pick = this.choose(obs, eco);
    return ok([
      { type: 'say', text: eco ? 'B:eco' : 'B:full' },
      { type: 'say', text: `K:${pick}` },
    ]);
  }
  private choose(obs: ShooterObservation, eco: boolean): string {
    const called = obs.coach?.call?.tactic ?? null;
    if (called !== null) return called;
    const list = obs.me.team === 'T' ? T_TACTICS : CT_TACTICS;
    const pref = (id: string): number => obs.coach?.pref[id] ?? 0;
    const eff = (id: string): number => this.tactics?.team[id] ?? 50;
    const open = list.filter((id) => pref(id) !== -1 && !(eco && (id === 'default' || id === 'fake')));
    let best = open[0] ?? list[0];
    for (const id of open) if (pref(id) * 1000 + eff(id) > pref(best) * 1000 + eff(best)) best = id;
    return best;
  }
}

/** 十個座位都是假 Bot */
export const stubFactory = (): { controllers: CoachStub[] } => ({ controllers: Array.from({ length: 10 }, (_, i) => new CoachStub(`stub${i}`)) });
