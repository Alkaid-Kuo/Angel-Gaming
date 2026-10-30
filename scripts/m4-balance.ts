// M4 經濟平衡測試：用自動玩家跑上百個賽段（假比賽），看名次分布、破產率、下注報酬、NPC 各個性的表現。
// 用法：node scripts/m4-balance.ts [賽段數，預設 300]
import { POLICIES, runSeason } from '../src/manage/autoplayer.ts';
import { STUB_CONTENT } from '../src/manage/content.ts';
import { newGame } from '../src/manage/game.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { humanTeam } from '../src/manage/state.ts';
import type { GameState } from '../src/manage/types.ts';

const N = Number(process.argv[2] ?? 300);
const content = STUB_CONTENT;
const gateway = new FakeGateway(content);

function pct(x: number, n: number): string {
  return `${((x * 100) / n).toFixed(1)}%`;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

interface Row {
  policy: string;
  bankrupt: number;
  rankSum: number;
  rankHist: number[];
  cash: number[];
  betStake: number;
  betNet: number;
  signingSpend: number;
  bailouts: number;
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  const personaRank = new Map<string, number[]>();
  const personaCash = new Map<string, number[]>();

  for (const [name, policy] of [['（不介入）', null], ...Object.entries(POLICIES)] as const) {
    const row: Row = { policy: name, bankrupt: 0, rankSum: 0, rankHist: new Array(8).fill(0), cash: [], betStake: 0, betNet: 0, signingSpend: 0, bailouts: 0 };
    for (let seed = 1; seed <= N; seed++) {
      const s: GameState = newGame(seed, content);
      await runSeason(s, content, gateway, policy);
      const me = humanTeam(s);
      if (s.phase === 'bankrupt') row.bankrupt++;
      const rank = (s.seasonResult?.humanRank ?? 8) as number;
      row.rankSum += rank;
      row.rankHist[rank - 1]++;
      row.cash.push(me.cash);
      for (const e of me.ledger) {
        if (e.category === 'bet') {
          row.betNet += e.amount;
          if (e.amount < 0) row.betStake -= e.amount;
        } else if (e.category === 'signing') row.signingSpend -= e.amount;
      }
      for (const t of s.teams) {
        if (t.human) continue;
        row.bailouts += t.ledger.filter((e) => e.category === 'bailout').length;
        if (policy === null) {
          const r = (s.seasonResult?.ranks.indexOf(t.id) ?? 7) + 1;
          const key = t.persona as string;
          personaRank.set(key, [...(personaRank.get(key) ?? []), r]);
          personaCash.set(key, [...(personaCash.get(key) ?? []), t.cash]);
        }
      }
    }
    rows.push(row);
  }

  console.log(`\n== M4 平衡測試：每種策略 ${N} 個賽段（種子 1～${N}）==\n`);
  console.log('策略\t\t破產\t平均名次\t期末現金 p10/中位/p90\t\t下注報酬率\t簽約花費\tNPC赤字補貼次數');
  for (const r of rows) {
    const sorted = [...r.cash].sort((a, b) => a - b);
    const roi = r.betStake > 0 ? `${((r.betNet * 100) / r.betStake).toFixed(1)}%（押 ${r.betStake}）` : '—';
    console.log(
      `${r.policy.padEnd(12)}\t${pct(r.bankrupt, N)}\t${(r.rankSum / N).toFixed(2)}\t\t${quantile(sorted, 0.1)} / ${quantile(sorted, 0.5)} / ${quantile(sorted, 0.9)}\t\t${roi}\t${Math.round(r.signingSpend / N)}\t\t${r.bailouts}`,
    );
  }

  console.log('\n玩家名次分布（第 1～8 名的次數）');
  for (const r of rows) console.log(`${r.policy.padEnd(12)}\t${r.rankHist.join('\t')}`);

  console.log('\nNPC 各個性（玩家不介入時）：平均名次／期末現金中位數');
  for (const [k, ranks] of personaRank) {
    const cash = [...(personaCash.get(k) as number[])].sort((a, b) => a - b);
    console.log(`${content.personas[k as keyof typeof content.personas].label.padEnd(6)}\t平均名次 ${(ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2)}\t期末現金 ${quantile(cash, 0.5)}`);
  }
}

await main();
