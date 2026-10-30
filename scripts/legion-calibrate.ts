// 軍團戰戰力預估的實測表：用引擎量各兵種互打的傷害速率，寫成 bots/legion-src/estimate-table.js 給 AI 用（AI 不能跑引擎，只能查表）。
// 量的都是「平地、預設陣形、滿編、不用技能、正面」的基準值；側背擊、淺灘、高度、槍林、盾牆、掩護區這些倍率由 estimate.js 照規則另外乘。
// 用法：node scripts/legion-calibrate.ts
import { writeFileSync } from 'node:fs';
import { LEGION_ENGINE_VERSION, TILE, UNIT_KINDS, type UnitKind } from '../src/legion/config.ts';
import { flatArea, teleport } from '../src/legion/acceptance.ts';
import { LegionMatch, type Regiment } from '../src/legion/sim.ts';

const OUT = 'bots/legion-src/estimate-table.js';
const hpOf = (m: LegionMatch, r: Regiment): number => r.slots.reduce((t, sid) => t + m.soldiers[sid].hp, 0);

/** 兩團正面相對擺好（a 在西朝東、b 在東朝西，前緣相距 gap 格），回傳 match 與兩團 */
function face(a: UnitKind, b: UnitKind, gap: number, opt: { aFormation?: string; bFacing?: number } = {}): { m: LegionMatch; A: Regiment; B: Regiment } {
  const m = new LegionMatch({
    seed: 7,
    mode: 'annihilation',
    deployments: [
      [{ type: a, x: 10000, y: 10000, ...(opt.aFormation ? { formation: opt.aFormation } : {}) }, { type: 'light', x: 10000, y: 92000 }],
      [{ type: b, x: 150000, y: 30000 }, { type: 'light', x: 150000, y: 8000 }],
    ],
  });
  const A = m.regiments.find((r) => r.owner === 0)!;
  const B = m.regiments.find((r) => r.owner === 1)!;
  const [cx, cy] = flatArea(m, 26, 7);
  const ax = cx * TILE - A.halfD - 500;
  const bx = cx * TILE + B.halfD + gap * TILE - 500;
  teleport(m, A, ax, cy * TILE, 0);
  teleport(m, B, bx, cy * TILE, opt.bFacing ?? 180);
  m.step();
  for (const r of [A, B]) for (const sid of r.slots) Object.assign(m.soldiers[sid], { x: m.soldiers[sid].sx, y: m.soldiers[sid].sy });
  return { m, A, B };
}

/** 近戰：接觸後 10 秒內，雙方每秒損失的血量（引擎單位） */
function melee(a: UnitKind, b: UnitKind): [number, number] {
  const { m, A, B } = face(a, b, 1);
  m.applyCommands(0, [{ type: 'attack', id: A.id, target: B.id }]);
  m.applyCommands(1, [{ type: 'attack', id: B.id, target: A.id }]);
  let t0 = -1;
  let ha = 0;
  let hb = 0;
  for (let i = 0; i < 400 && !m.over; i++) {
    m.step();
    if (t0 < 0 && (m.tick - A.lastMelee <= 1 || m.tick - B.lastMelee <= 1)) {
      t0 = m.tick;
      ha = hpOf(m, A);
      hb = hpOf(m, B);
    }
    if (t0 >= 0 && m.tick - t0 >= 100) break;
    if (t0 >= 0 && (A.slots.length < A.men0 * 0.4 || B.slots.length < B.men0 * 0.4)) break;
  }
  const secs = Math.max(1, (m.tick - t0) / 10);
  return [(hb - hpOf(m, B)) / secs, (ha - hpOf(m, A)) / secs];
}

/** 遠程：弓兵對 12 格外站著不動的 b，10 秒內 b 每秒損失的血量 */
function ranged(b: UnitKind): number {
  const { m, A, B } = face('archer', b, 12);
  m.applyCommands(0, [{ type: 'attack', id: A.id, target: B.id }]);
  m.applyCommands(1, [{ type: 'hold', id: B.id }]);
  const h0 = hpOf(m, B);
  for (let i = 0; i < 100; i++) m.step();
  return (h0 - hpOf(m, B)) / 10;
}

/** 衝鋒：騎兵從 16 格外衝站著不動的 b（b 正面或背面朝向騎兵、沒架槍林），衝鋒結束時雙方損失的血量 */
function charge(c: UnitKind, b: UnitKind, rear: boolean): [number, number] {
  const { m, A, B } = face(c, b, 16, { aFormation: 'wedge', bFacing: rear ? 0 : 180 });
  m.applyCommands(1, [{ type: 'hold', id: B.id }]);
  const ha = hpOf(m, A);
  const hb = hpOf(m, B);
  m.applyCommands(0, [{ type: 'charge', id: A.id, facing: 0 }]);
  for (let i = 0; i < 200 && A.dash !== null; i++) m.step();
  return [hb - hpOf(m, B), ha - hpOf(m, A)];
}

const r1 = (v: number): number => Math.round(v);
const meleeTable: Record<string, Record<string, number>> = {};
for (const a of UNIT_KINDS) meleeTable[a] = {};
for (let i = 0; i < UNIT_KINDS.length; i++) {
  for (let j = i; j < UNIT_KINDS.length; j++) {
    const a = UNIT_KINDS[i];
    const b = UNIT_KINDS[j];
    const [ab, ba] = melee(a, b);
    meleeTable[a][b] = r1(ab);
    meleeTable[b][a] = a === b ? r1((ab + ba) / 2) : r1(ba);
    if (a === b) meleeTable[a][a] = r1((ab + ba) / 2);
  }
}
const rangedTable: Record<string, number> = {};
for (const b of UNIT_KINDS) rangedTable[b] = r1(ranged(b));
const chargeTable: Record<string, Record<string, [number, number, number, number]>> = {};
for (const c of ['lightCav', 'heavyCav'] as const) {
  chargeTable[c] = {};
  for (const b of UNIT_KINDS) {
    const f = charge(c, b, false);
    const r = charge(c, b, true);
    chargeTable[c][b] = [r1(f[0]), r1(f[1]), r1(r[0]), r1(r[1])];
  }
}

const src = `// 本檔由 scripts/legion-calibrate.ts 產生（引擎 ${LEGION_ENGINE_VERSION} 實測），請不要手改；改了兵種數值就重新產生。
// 數值都是引擎單位的血量（一般單位 ×10）。

/**
 * 近戰：滿編的 a 團正面打 b 團時，b 每秒損失的血量（平地、預設陣形、不用技能）
 * @type {Readonly<Record<string, Readonly<Record<string, number>>>>}
 */
export const MELEE_DPS = ${JSON.stringify(meleeTable)};

/**
 * 遠程：滿編的弓兵團射 12 格外站著不動的 b 團時，b 每秒損失的血量
 * @type {Readonly<Record<string, number>>}
 */
export const ARROW_DPS = ${JSON.stringify(rangedTable)};

/**
 * 衝鋒：滿編的騎兵團（楔形陣）從 16 格外衝沒架槍林、站著不動的 b 團，衝鋒結束時
 * [b 損失的血量（正面）, 騎兵損失（正面）, b 損失（背面）, 騎兵損失（背面）]
 * @type {Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>}
 */
export const CHARGE_HIT = ${JSON.stringify(chargeTable)};
`;
writeFileSync(OUT, src);
console.log(`寫入 ${OUT}`);
console.log('近戰（a 打 b，b 每秒損失血量 ÷10）：');
console.log(['', ...UNIT_KINDS].map((s) => s.padEnd(9)).join(''));
for (const a of UNIT_KINDS) console.log([a, ...UNIT_KINDS.map((b) => String(Math.round(meleeTable[a][b] / 10)))].map((s) => s.padEnd(9)).join(''));
console.log('弓箭（每秒 ÷10）：', UNIT_KINDS.map((b) => `${b} ${Math.round(rangedTable[b] / 10)}`).join('、'));
for (const c of ['lightCav', 'heavyCav']) console.log(`${c} 衝鋒（正面 造成/損失、背面 造成/損失，÷10）：`, UNIT_KINDS.map((b) => `${b} ${chargeTable[c][b].map((v) => Math.round(v / 10)).join('/')}`).join('、'));
