// 軍團戰 AI 情境測試：各 AI 在固定戰術情境中的表現。
// 用法：node scripts/legion-ai-scenarios.ts [AI=commander,push,ambush,ranged] [情境編號,…｜all] [--full] [--md]
//   AI 名稱對應 bots/legion-<名稱>.js（例如 commander、marshal-v2、general-v2、siege）；siege（攻城陪練）只跑攻城情境
//   預設每個情境跑一次（種子 11、情境的第一個座位）；--full 跑規格的通過條件：5 個種子 × 每個座位（攻城情境照角色一個座位）
//   --md：最後印出 Markdown 結果表（情境 × AI，通過幾場／幾場）
//   TRACE=20：每 2 秒印出各團位置、狀態與意圖（情境座標）
import { readFileSync } from 'node:fs';
import { AI_SCENARIOS, SCENARIO_SEEDS, runAiScenario, scenarioSeats, type AiScenarioResult, type Ctx } from '../src/legion/ai-scenarios.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const full = process.argv.includes('--full');
const md = process.argv.includes('--md');
const bots = (args[0] ?? 'commander,push,ambush,ranged').split(',');
const only = args[1] && args[1] !== 'all' ? args[1].split(',') : undefined;
/** 只跑攻城情境的 AI */
const SIEGE_ONLY = new Set(['siege']);

const every = Number(process.env.TRACE ?? 0);
const trace = every > 0
  ? (c: Ctx): void => {
      if (c.m.tick % every !== 0) return;
      console.log(`--- ${c.m.tick / 10}s 「${c.m.players[c.me].plan}」`);
      for (const r of c.m.regiments) {
        if (r.destroyed) continue;
        const [x, y] = c.local(r.x, r.y);
        console.log(`  ${r.owner === c.me ? 'AI' : '腳本'} ${r.kind.padEnd(8)} (${x.toFixed(0).padStart(4)},${y.toFixed(0).padStart(4)}) L${r.layer} f${String(r.facing).padStart(4)} ${String(r.slots.length).padStart(2)}人 ${c.m.regimentStatus(r).padEnd(10)} ${r.order.padEnd(8)}「${r.intent}」`);
      }
    }
  : undefined;

/** 情境 → AI → [通過, 場數, 例外] */
const table = new Map<string, Map<string, [number, number, number]>>();
for (const b of bots) {
  const bot = compileBot(readFileSync(`bots/legion-${b}.js`, 'utf8'), `legion-${b}.js`);
  const list = AI_SCENARIOS.filter((s) => (!only || only.includes(s.id)) && (!SIEGE_ONLY.has(b) || s.mode === 'siege'));
  let pass = 0;
  let runs = 0;
  const t0 = Date.now();
  console.log(`\n=== ${b} ===`);
  for (const sc of list) {
    const seeds = full ? SCENARIO_SEEDS : [SCENARIO_SEEDS[0]];
    const seats = full ? scenarioSeats(sc) : [scenarioSeats(sc)[0]];
    const cell: [number, number, number] = [0, 0, 0];
    for (const seat of seats) {
      for (const seed of seeds) {
        let r: AiScenarioResult;
        try {
          r = runAiScenario(sc, bot, b, { seed, seat, trace });
        } catch (e) {
          cell[1] += 1;
          cell[2] += 1;
          console.log(`ERR   ${sc.id.padEnd(4)}種子 ${seed} 座位 ${seat}　${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        cell[1] += 1;
        if (r.pass) cell[0] += 1;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${sc.id.padEnd(4)}${full ? `種子 ${String(seed).padEnd(3)}座位 ${seat}　` : ''}${sc.name}　${r.detail}`);
      }
    }
    pass += cell[0];
    runs += cell[1];
    const row = table.get(sc.id) ?? new Map<string, [number, number, number]>();
    row.set(b, cell);
    table.set(sc.id, row);
  }
  console.log(`=== ${b}：通過 ${pass} / ${runs} 場（${((Date.now() - t0) / 1000).toFixed(0)} 秒）===`);
}

const cellText = (c: [number, number, number] | undefined): string => (c === undefined ? '—' : `${c[0]}/${c[1]}${c[0] === c[1] ? ' ○' : ''}${c[2] > 0 ? `（例外 ${c[2]}）` : ''}`);
console.log(`\n情境      ${bots.map((b) => b.padEnd(12)).join('')}`);
for (const s of AI_SCENARIOS) if (table.has(s.id)) console.log(`${s.id.padEnd(10)}${bots.map((b) => cellText(table.get(s.id)!.get(b)).padEnd(12)).join('')}${s.name}${s.pending ? '（待審）' : ''}`);
if (md) {
  console.log(`\n| 情境 | 名稱 | 機動 | 模式／地圖 | ${bots.join(' | ')} |`);
  console.log(`| --- | --- | --- | --- | ${bots.map(() => '---').join(' | ')} |`);
  for (const s of AI_SCENARIOS) {
    if (!table.has(s.id)) continue;
    const where = `${s.mode ?? 'annihilation'}${s.mapId ? `／${s.mapId}` : ''}${s.seats ? `（座位 ${s.seats.join('、')}）` : ''}`;
    console.log(`| ${s.id} | ${s.name}${s.pending ? '（待審）' : ''} | ${s.skill ?? ''} | ${where} | ${bots.map((b) => cellText(table.get(s.id)!.get(b))).join(' | ')} |`);
  }
}
