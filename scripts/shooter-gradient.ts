// CS 射擊屬性梯度（步驟 7 驗收）：基準 Bot 對基準 Bot，兩張圖各 --seeds 個種子 × 雙邊，固定種子、確定性。
//   強度屬性 aim／reaction／awareness／aggression × 20／40／60／80（其餘 50、整隊同值）對整隊全 50
//   風格屬性 discipline／movement × 20／80 對整隊全 50
//   版本單調：均衡陣容（五角色各一）版本 1～5 對版本 3
//   五狙：五個狙擊手（版本 3）對均衡陣容版本 3
//   陪練：均衡陣容版本 3 對陪練 v5（全 50）
// 用法：node scripts/shooter-gradient.ts [--seeds 10] [--jobs 4] [--only attr,style,version,awp,practice] [--out out/shooter-gradient.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttributeKey } from '../src/shooter/config.ts';
import { MAX_VERSION, balancedLineup } from '../src/shooter/players.ts';
import { arg, attrSeat, matchup, progress, runLab, sameTeam, specTeam, summarize, type LabJob, type LabSummary } from './shooter-lab.ts';

const BOT = 'bots/shooter-baseline.js';
const PRACTICE = 'bots/shooter-practice.js';
const MAPS = ['redrock', 'dust'];
const seeds = Array.from({ length: Number(arg('seeds', '10')) }, (_, i) => 1001 + i);
const jobs = Number(arg('jobs', '4'));
const only = new Set(arg('only', 'attr,style,version,awp,practice').split(','));
const outPath = arg('out', 'out/shooter-gradient.json');

interface Cond {
  readonly group: string;
  readonly label: string;
  readonly jobs: LabJob[];
}

const conds: Cond[] = [];
const base = sameTeam(BOT, attrSeat());
if (only.has('attr')) {
  for (const k of ['aim', 'reaction', 'awareness', 'aggression'] as AttributeKey[]) {
    for (const v of [20, 40, 60, 80]) conds.push({ group: `attr:${k}`, label: `${k}=${v}`, jobs: matchup(sameTeam(BOT, attrSeat({ [k]: v })), base, MAPS, seeds) });
  }
}
if (only.has('style')) {
  for (const k of ['discipline', 'movement'] as AttributeKey[]) {
    for (const v of [20, 80]) conds.push({ group: `style:${k}`, label: `${k}=${v}`, jobs: matchup(sameTeam(BOT, attrSeat({ [k]: v })), base, MAPS, seeds) });
  }
}
const bal3 = specTeam(BOT, balancedLineup(3));
if (only.has('version')) {
  for (let v = 1; v <= MAX_VERSION; v++) if (v !== 3) conds.push({ group: 'version', label: `v${v}`, jobs: matchup(specTeam(BOT, balancedLineup(v)), bal3, MAPS, seeds) });
}
if (only.has('awp')) conds.push({ group: 'awp', label: '五狙 v3 對均衡 v3', jobs: matchup(specTeam(BOT, Array.from({ length: 5 }, () => ({ role: 'awp' as const, version: 3, habit: 0 }))), bal3, MAPS, seeds) });
if (only.has('practice')) conds.push({ group: 'practice', label: '均衡 v3 對陪練 v5', jobs: matchup(bal3, specTeam(PRACTICE, [null, null, null, null, null]), MAPS, seeds) });

const all = conds.flatMap((c) => c.jobs);
const games = await runLab(all, jobs, progress('梯度'));
let k = 0;
const results: (Omit<Cond, 'jobs'> & LabSummary)[] = conds.map((c) => {
  const gs = games.slice(k, k + c.jobs.length);
  k += c.jobs.length;
  return { group: c.group, label: c.label, ...summarize(gs) };
});
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
for (const r of results) console.log(`${r.group.padEnd(18)}${r.label.padEnd(18)}回合 ${pct(r.roundWin).padStart(6)}  整場 ${pct(r.matchWin).padStart(6)}  （${Object.entries(r.byMap).map(([m, x]) => `${m} ${pct(x.roundWin)}`).join('、')}）  例外 ${r.exceptions} 逾時 ${r.timeouts}`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ seeds, maps: MAPS, results }, null, 1));
console.log(`寫入 ${outPath}`);
