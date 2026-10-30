// 驗證戰力預估（bots/legion-src/estimate.js）：隨機兩群部隊（各 2～4 團）在平地正面互打 40 秒，比較引擎實際與預估的雙方損失。
// 用法：node scripts/legion-estimate-check.ts [場數，預設 60]
import { TILE, UNIT_KINDS, UNITS, type UnitKind } from '../src/legion/config.ts';
import { flatArea, teleport } from '../src/legion/acceptance.ts';
import { LegionMatch, type Regiment } from '../src/legion/sim.ts';
import { estimateFight } from '../bots/legion-src/estimate.js';
import { Prng } from '../src/shared/prng.ts';

const games = Number(process.argv[2] ?? 60);
const rng = Prng.fromInts(12345);
const INFANTRY: UnitKind[] = UNIT_KINDS.filter((k) => k !== 'lightCav' && k !== 'heavyCav');
const value = (r: Regiment, m: LegionMatch): number => (r.slots.reduce((t, sid) => t + m.soldiers[sid].hp, 0) / (r.men0 * r.def.hp)) * r.def.cost;
let agree = 0;
let n = 0;
const rows: string[] = [];
let errSum = 0;
for (let g = 0; g < games; g++) {
  const pick = (k: number): UnitKind[] => Array.from({ length: k }, () => (rng.nextInt(10) < 8 ? INFANTRY[rng.nextInt(INFANTRY.length)] : UNIT_KINDS[rng.nextInt(UNIT_KINDS.length)]));
  const A = pick(2 + rng.nextInt(3));
  const B = pick(2 + rng.nextInt(3));
  const dep = (ks: UnitKind[], p: number): object[] => ks.map((k, i) => ({ type: k, x: p === 0 ? 10000 : 150000, y: 10000 + i * 14000 }));
  const m = new LegionMatch({ seed: 100 + g, mode: 'annihilation', deployments: [[...dep(A, 0), { type: 'light', x: 10000, y: 95000 }], [...dep(B, 1), { type: 'light', x: 150000, y: 5000 }]] });
  const ra = m.regiments.filter((r) => r.owner === 0).slice(0, A.length);
  const rb = m.regiments.filter((r) => r.owner === 1).slice(0, B.length);
  const [cx, cy] = flatArea(m, 26, 7);
  const place = (rs: Regiment[], x: number, f: number): void => {
    const w = rs.reduce((t, r) => t + r.halfW * 2 + 1500, 0);
    let y = cy * TILE - w / 2;
    for (const r of rs) {
      teleport(m, r, x, y + r.halfW + 750, f);
      y += r.halfW * 2 + 1500;
    }
  };
  place(ra, (cx - 4) * TILE, 0);
  place(rb, (cx + 4) * TILE, 180);
  m.step();
  for (const r of [...ra, ...rb]) for (const sid of r.slots) Object.assign(m.soldiers[sid], { x: m.soldiers[sid].sx, y: m.soldiers[sid].sy });
  const a0 = ra.reduce((t, r) => t + value(r, m), 0);
  const b0 = rb.reduce((t, r) => t + value(r, m), 0);
  for (let t = 0; t < 400 && !m.over; t++) {
    if (t % 10 === 0) {
      const near = (r: Regiment, foes: Regiment[]): Regiment | undefined => foes.filter((f) => f.slots.length > 0).sort((p, q) => Math.hypot(p.x - r.x, p.y - r.y) - Math.hypot(q.x - r.x, q.y - r.y))[0];
      m.applyCommands(0, ra.filter((r) => r.slots.length > 0).map((r) => ({ type: 'attack', id: r.id, target: near(r, rb)?.id ?? -1 })));
      m.applyCommands(1, rb.filter((r) => r.slots.length > 0).map((r) => ({ type: 'attack', id: r.id, target: near(r, ra)?.id ?? -1 })));
    }
    m.step();
  }
  const aLost = a0 - ra.reduce((t, r) => t + value(r, m), 0);
  const bLost = b0 - rb.reduce((t, r) => t + value(r, m), 0);
  const unit = (k: UnitKind): { kind: string; hp: number; hpMax: number; cost: number } => ({ kind: k, hp: UNITS[k].men * UNITS[k].hp, hpMax: UNITS[k].men * UNITS[k].hp, cost: UNITS[k].cost });
  const est = estimateFight(A.map(unit), B.map(unit), { seconds: 40, approach: 2 });
  const actual = bLost - aLost;
  const pred = est.bLost - est.aLost;
  n += 1;
  if (Math.sign(actual) === Math.sign(pred) || Math.abs(actual) < 15) agree += 1;
  errSum += Math.abs(actual - pred);
  rows.push(`${A.join(',').padEnd(34)} vs ${B.join(',').padEnd(34)} 實際 ${aLost.toFixed(0).padStart(4)}/${bLost.toFixed(0).padStart(4)}  預估 ${est.aLost.toFixed(0).padStart(4)}/${est.bLost.toFixed(0).padStart(4)}`);
}
for (const r of rows.slice(0, 15)) console.log(r);
console.log(`\n${n} 場：勝負方向一致（或實際差距 < 15 點）${agree} 場（${Math.round((agree * 100) / n)}%）；交換差的平均誤差 ${(errSum / n).toFixed(0)} 點`);
