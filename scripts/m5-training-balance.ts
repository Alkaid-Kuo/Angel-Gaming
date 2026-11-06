// M5 第二批平衡量測（規格 4.9 第 4 條）：攻防戰內容包＋假比賽（瞬間出結果），自動玩家「訓練派」在訓練中心 Lv1／Lv2／Lv3 各跑 N 季。
// 量：開季出賽五人一季的成長（可訓練屬性總和的增加 ÷ 該流派 Σgrowth ＝ 約幾個舊版本；另列「開季離上限還有 1 版以上」的人）、
// 訓練與排練費佔支出比例（玩家、NPC）、NPC 金主補貼次數與金額；玩家到達目標等級的週（平均）、到達後每週實際練幾節、季末現金、破產季數。
// 另列一季全隊總成長點數（開季出賽五人可訓練屬性總和的增加；NPC 為每隊全部選手）與 NPC 季末現金（最低、平均），看訓練規則會不會讓 NPC 把錢花光。
// --rich：玩家開局多給 10 萬（千元單位 100000），量「時段與收益公式」本身的成長能力，不受資金限制。
// 用法：node scripts/m5-training-balance.ts [每級季數，預設 20] [起始種子，預設 1] [--rich]
import { trainerPolicy, runSeason } from '../src/manage/autoplayer.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { newGame } from '../src/manage/game.ts';
import type { BattleGateway } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { strengthSum } from '../src/manage/attrs.ts';
import { humanTeam, effectiveLineup } from '../src/manage/state.ts';
import type { GameState, Team } from '../src/manage/types.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const RICH = process.argv.includes('--rich');
const N = Number(args[0] ?? 20);
const SEED0 = Number(args[1] ?? 1);
const content = SHOOTER_CONTENT;
const fake = new FakeGateway(content);
/** 假比賽冒充攻防戰賽制（只差賽制代號） */
const gateway: BattleGateway = { formats: [{ ...fake.formats[0], id: content.formatId }], simulateBatch: (r, p) => fake.simulateBatch(r, p) };

const growthSum = (lineageId: string): number => {
  const l = content.lineages.find((x) => x.id === lineageId);
  return content.attributes.trainable.reduce((s, k) => s + (l?.growth[k] ?? 0), 0);
};
const spend = (t: Team): { training: number; total: number } => {
  let training = 0;
  let total = 0;
  for (const x of t.ledger) {
    if (x.amount >= 0 || x.category === 'bet') continue;
    total += -x.amount;
    if (x.category === 'training') training += -x.amount;
  }
  return { training, total };
};
const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const fmt = (x: number, d = 2): string => x.toFixed(d);

async function main(): Promise<void> {
  console.log(`攻防戰內容包、假比賽；每級 ${N} 季（種子 ${SEED0}～${SEED0 + N - 1}）${RICH ? '；玩家資金不設限（--rich）' : ''}`);
  for (const level of [1, 2, 3]) {
    const growth: number[] = [];
    const roomy: number[] = [];
    const humanShare: number[] = [];
    const npcShare: number[] = [];
    let bailouts = 0;
    let bailoutSum = 0;
    let reachedLevel = 0;
    const reachWeek: number[] = [];
    const after: number[] = [];
    const endCash: number[] = [];
    let broke = 0;
    const teamPts: number[] = [];
    const npcPts: number[] = [];
    const npcCash: number[] = [];
    for (let i = 0; i < N; i++) {
      const s: GameState = newGame(SEED0 + i, content);
      const me = humanTeam(s);
      if (RICH) me.cash += 100_000;
      const start = effectiveLineup(s, content, me).map((id) => {
        const p = s.players.find((x) => x.id === id) as GameState['players'][number];
        const room = content.attributes.trainable.reduce((t, k) => t + (p.caps[k] - p.attrs[k]), 0) / growthSum(p.lineageId);
        return { p, S: strengthSum(content, p.attrs), room };
      });
      const npcStart = new Map(s.players.filter((p) => p.teamId !== null && p.teamId !== me.id).map((p) => [p.id, strengthSum(content, p.attrs)]));
      await runSeason(s, content, gateway, trainerPolicy(level));
      teamPts.push(start.reduce((t, { p, S }) => t + strengthSum(content, p.attrs) - S, 0));
      for (const t of s.teams) {
        if (t.human) continue;
        npcCash.push(t.cash);
        npcPts.push(s.players.filter((p) => p.teamId === t.id && npcStart.has(p.id)).reduce((x, p) => x + strengthSum(content, p.attrs) - (npcStart.get(p.id) ?? 0), 0));
      }
      if (me.trainingLevel >= level) reachedLevel++;
      if (s.phase === 'bankrupt') broke++;
      endCash.push(me.cash);
      // 升到目標等級那筆帳的週；之後每週的訓練＋排練節數（帳本「訓練」「排練」的 ×n）
      const up = me.ledger.filter((x) => x.category === 'facility' && x.memo.includes(`Lv${level}`) && x.memo.includes('升到'));
      const w0 = level === 1 ? 0 : (up[0]?.week ?? -1);
      if (w0 >= 0) {
        reachWeek.push(w0);
        const weeks = new Map<number, number>();
        for (const x of me.ledger) {
          if (x.category !== 'training' || x.week < w0) continue;
          const n = Number(/×(\d+)/.exec(x.memo)?.[1] ?? 0);
          weeks.set(x.week, (weeks.get(x.week) ?? 0) + n);
        }
        const span = Math.max(1, 9 - w0 + 1);
        after.push([...weeks.values()].reduce((t, x) => t + x, 0) / span);
      }
      for (const { p, S, room } of start) {
        const g = (strengthSum(content, p.attrs) - S) / growthSum(p.lineageId);
        growth.push(g);
        if (room >= 1) roomy.push(g);
      }
      const h = spend(me);
      humanShare.push(h.training / Math.max(1, h.total));
      for (const t of s.teams) {
        if (t.human) continue;
        const n = spend(t);
        npcShare.push(n.training / Math.max(1, n.total));
        for (const x of t.ledger) {
          if (x.category !== 'bailout') continue;
          bailouts++;
          bailoutSum += x.amount;
        }
      }
    }
    console.log(`Lv${level}（達到 ${reachedLevel}/${N} 季）：出賽五人每季成長 ${fmt(mean(growth))} 版、離上限 ≥1 版的 ${roomy.length} 人 ${fmt(mean(roomy))} 版（目標 ${[0.3, 0.5, 0.8][level - 1]}；最少 ${fmt(Math.min(...growth))}、最多 ${fmt(Math.max(...growth))}）；訓練＋排練費佔支出：玩家 ${fmt(mean(humanShare) * 100, 1)}%、NPC ${fmt(mean(npcShare) * 100, 1)}%（目標 30～50%）；NPC 金主補貼 ${bailouts} 次共 ${bailoutSum}；玩家：升到 Lv${level} 平均第 ${reachWeek.length ? fmt(mean(reachWeek), 1) : '—'} 週、之後每週練 ${after.length ? fmt(mean(after), 1) : '—'} 節、季末現金 ${Math.round(mean(endCash))}、破產 ${broke} 季`);
    console.log(`  一季全隊總成長點數：玩家出賽五人 ${fmt(mean(teamPts), 1)} 點（最少 ${Math.min(...teamPts)}、最多 ${Math.max(...teamPts)}）、NPC 每隊 ${fmt(mean(npcPts), 1)} 點；NPC 季末現金 平均 ${Math.round(mean(npcCash))}、最低 ${Math.min(...npcCash)}`);
  }
}

await main();
