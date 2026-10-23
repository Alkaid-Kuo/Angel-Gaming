// AI 情境測試：把受測 AI（0 號）放進固定的戰術情境，對手（1 號）照腳本行動，檢查 AI 有沒有做對事。
// 用來量化「AI 懂不懂規則」：不正面衝槍林、錘砧戰術、弓兵集火、護弓兵、不送頭、佔點、搶高地、搜敵……
// scripts/legion-ai-scenarios.ts 印出各 AI 的結果表；test/legion-ai.test.ts 檢查官方基準 AI 全部通過。
import type { LegionEvent } from './api.ts';
import { T, TILE, type FormationKind, type LegionMode, type ShieldStance, type UnitKind } from './config.ts';
import { flatArea, teleport } from './acceptance.ts';
import { heightAt, terrainAt } from './map.ts';
import { LegionBatchController } from './runner.ts';
import { LegionMatch, legionInitData, type Regiment } from './sim.ts';
import type { CompiledBot } from '../sandbox/compile.ts';
import { resolveKnobs } from '../sandbox/controller.ts';

interface Unit {
  readonly type: UnitKind;
  /** 相對情境中心的位置（格）：x 往東（0 號的進攻方向）、y 往南；abs = true 時是地圖上的格座標 */
  readonly x: number;
  readonly y: number;
  /** 朝向（度）；預設 0 號朝東、1 號朝西 */
  readonly facing?: number;
  readonly formation?: FormationKind;
  readonly stance?: ShieldStance;
}

export interface Ctx {
  readonly m: LegionMatch;
  /** 0 號（受測 AI）、1 號（腳本）的軍團，順序同情境定義 */
  readonly A: Regiment[];
  readonly B: Regiment[];
  /** 情境中心（單位） */
  readonly cx: number;
  readonly cy: number;
  readonly events: LegionEvent[];
  /** 0 號射出的箭：[目標軍團 id（-1 = 沒有）, 射手所在高度, tick] */
  readonly arrows: [number, number, number][];
  /** 每面旗被爭奪的 tick 數 */
  readonly contested: number[];
}

interface AiScenario {
  readonly id: string;
  readonly name: string;
  readonly expect: string;
  readonly mode?: LegionMode;
  /** 用地圖格座標擺位（不找平坦區） */
  readonly abs?: boolean;
  readonly bot: readonly Unit[];
  readonly foe: readonly Unit[];
  readonly ticks: number;
  /** 開打前的設定（例如旗點歸屬） */
  readonly setup?: (c: Ctx) => void;
  /** 1 號的腳本：每次決策回傳指令 */
  readonly script?: (c: Ctx, tick: number) => unknown[];
  readonly judge: (c: Ctx) => { pass: boolean; detail: string };
}

export interface AiScenarioResult {
  readonly id: string;
  readonly name: string;
  readonly pass: boolean;
  readonly expect: string;
  readonly detail: string;
}

const pct = (r: Regiment): number => Math.round((r.slots.length * 100) / r.men0);
const impacts = (c: Ctx, owner: number): Extract<LegionEvent, { type: 'impact' }>[] =>
  c.events.filter((e): e is Extract<LegionEvent, { type: 'impact' }> => e.type === 'impact' && c.m.regiments[e.reg].owner === owner);

export const AI_SCENARIOS: readonly AiScenario[] = [
  {
    id: 'S1',
    name: '騎兵不正面衝架好的槍林',
    expect: '重騎兵不撞上槍林正面（繞過去打後面的弓兵或等待），60 秒後騎兵剩 70% 以上',
    bot: [{ type: 'heavyCav', x: -16, y: 0, formation: 'wedge' }],
    foe: [
      { type: 'spear', x: 0, y: 0 },
      { type: 'archer', x: 9, y: 0 },
    ],
    ticks: 600,
    script: (c, t) => (t === 0 ? [{ type: 'brace', id: c.B[0].id, facing: 180 }] : []),
    judge: (c) => {
      const bad = impacts(c, 0).filter((e) => e.braced).length;
      return { pass: bad === 0 && pct(c.A[0]) >= 70, detail: `撞上槍林 ${bad} 次、騎兵剩 ${pct(c.A[0])}%、敵弓兵剩 ${pct(c.B[1])}%` };
    },
  },
  {
    id: 'S2',
    name: '錘砧：步兵纏住、騎兵打側背',
    expect: '敵方劍士和我方步兵接戰後，重騎兵從側面或背面衝它（80 秒內）',
    bot: [
      { type: 'sword', x: -4, y: -4 },
      { type: 'spear', x: -4, y: 4 },
      { type: 'heavyCav', x: -14, y: 14, formation: 'wedge' },
    ],
    foe: [
      { type: 'sword', x: 6, y: -4 },
      { type: 'sword', x: 6, y: 4 },
    ],
    ticks: 800,
    script: (c, t) => (t === 0 ? [{ type: 'attack', id: c.B[0].id, target: c.A[0].id }, { type: 'attack', id: c.B[1].id, target: c.A[1].id }] : []),
    judge: (c) => {
      const flankHits = impacts(c, 0).filter((e) => e.kind === 'charge' && e.flank !== 'front');
      const foeLeft = c.B.reduce((s, r) => s + r.slots.length, 0);
      return { pass: flankHits.length > 0, detail: `側背衝鋒 ${flankHits.length} 次、敵劍士剩 ${foeLeft} 人、我方步兵剩 ${pct(c.A[0])}%／${pct(c.A[1])}%` };
    },
  },
  {
    id: 'S3',
    name: '弓兵不射盾牆、射被纏住的敵人',
    expect: '對面有架盾牆的盾兵和一團跟我方劍士纏鬥的劍士：敵方劍士還在場時，七成以上的箭射向劍士',
    bot: [
      { type: 'archer', x: -12, y: -4 },
      { type: 'archer', x: -12, y: 4 },
      { type: 'sword', x: -3, y: 0 },
    ],
    foe: [
      { type: 'shield', x: -1, y: -9 },
      { type: 'sword', x: 3, y: 0 },
    ],
    ticks: 400,
    script: (c, t) => (t === 0 ? [{ type: 'shield', id: c.B[0].id, mode: 'wall' }, { type: 'attack', id: c.B[1].id, target: c.A[2].id }] : []),
    judge: (c) => {
      // 只算敵方劍士還沒潰散、還沒覆滅時射的箭
      const gone = c.events.find((e) => (e.type === 'routed' || e.type === 'destroyed') && e.reg === c.B[1].id)?.tick ?? Infinity;
      const hits = c.arrows.filter(([id, , t]) => id >= 0 && t < gone);
      const good = hits.filter(([id]) => c.m.regiments[id].kind !== 'shield').length;
      const share = hits.length ? good / hits.length : 0;
      return { pass: hits.length >= 20 && share >= 0.7, detail: `射向非盾兵 ${Math.round(share * 100)}%（${good}/${hits.length} 箭）` };
    },
  },
  {
    id: 'S4',
    name: '長槍對衝來的騎兵架槍林',
    expect: '斥候看到 15 格外的敵方重騎兵，4 秒後它衝向我方弓兵：長槍要先架好槍林擋下或重創騎兵，弓兵損失三成以內',
    bot: [
      { type: 'spear', x: 0, y: 0 },
      { type: 'archer', x: -7, y: 0 },
      { type: 'light', x: 7, y: -7 },
    ],
    foe: [{ type: 'heavyCav', x: 15, y: 0, formation: 'wedge' }],
    ticks: 400,
    script: (c, t) => (t === 40 ? [{ type: 'charge', id: c.B[0].id, x: c.A[1].x, y: c.A[1].y }] : []),
    judge: (c) => {
      const stopped = impacts(c, 1).some((e) => e.braced);
      const cav = pct(c.B[0]);
      return { pass: (stopped || cav <= 50) && pct(c.A[1]) >= 70, detail: `${stopped ? '槍林擋下' : '沒擋下'}、敵騎兵剩 ${cav}%、我方弓兵剩 ${pct(c.A[1])}%` };
    },
  },
  {
    id: 'S5',
    name: '劍士不突擊架好的槍林正面',
    expect: '劍士不朝槍林正面突擊（繞側或去打弓兵），60 秒後劍士剩一半以上',
    bot: [{ type: 'sword', x: -9, y: 0 }],
    foe: [
      { type: 'spear', x: 0, y: 0 },
      { type: 'archer', x: 9, y: 0 },
    ],
    ticks: 600,
    script: (c, t) => (t === 0 ? [{ type: 'brace', id: c.B[0].id, facing: 180 }] : []),
    judge: (c) => {
      const bad = impacts(c, 0).filter((e) => e.braced).length;
      return { pass: bad === 0 && pct(c.A[0]) >= 50, detail: `撞上槍林 ${bad} 次、劍士剩 ${pct(c.A[0])}%、敵弓兵剩 ${pct(c.B[1])}%` };
    },
  },
  {
    id: 'S6',
    name: '弓兵躲衝來的輕騎兵',
    expect: '輕騎兵衝向弓兵：弓兵退到長槍後面、長槍架槍林，弓兵損失一半以內',
    bot: [
      { type: 'archer', x: 0, y: 0 },
      { type: 'spear', x: -9, y: 0 },
    ],
    foe: [{ type: 'lightCav', x: 22, y: 0, formation: 'wedge' }],
    ticks: 400,
    script: (c, t) => (t === 20 ? [{ type: 'charge', id: c.B[0].id, x: c.A[0].x, y: c.A[0].y }] : t > 60 && t % 20 === 0 ? [{ type: 'attack', id: c.B[0].id, target: c.A[0].id }] : []),
    judge: (c) => ({ pass: pct(c.A[0]) >= 50, detail: `弓兵剩 ${pct(c.A[0])}%、敵騎兵剩 ${pct(c.B[0])}%` }),
  },
  {
    id: 'S7',
    name: '盾兵護送弓兵對射',
    expect: '兩團弓兵＋盾兵對兩團弓兵：盾兵舉盾掩護，對射 40 秒我方損失比對方少',
    bot: [
      { type: 'archer', x: -7, y: -4 },
      { type: 'archer', x: -7, y: 4 },
      { type: 'shield', x: -4, y: 0 },
    ],
    foe: [
      { type: 'archer', x: 6, y: -4 },
      { type: 'archer', x: 6, y: 4 },
    ],
    ticks: 400,
    script: (c, t) => (t === 0 ? c.B.map((r) => ({ type: 'hold', id: r.id })) : []),
    judge: (c) => {
      const mine = c.A[0].slots.length + c.A[1].slots.length;
      const theirs = c.B[0].slots.length + c.B[1].slots.length;
      return { pass: mine > theirs, detail: `我方弓兵剩 ${mine} 人、對方剩 ${theirs} 人` };
    },
  },
  {
    id: 'S8',
    name: '側翼來襲：長槍轉向擋騎兵',
    expect: '正面被劍士纏住時，斥候看到北側 20 格外的敵方重騎兵，12 秒後它衝向弓兵：要有長槍轉向架槍林擋下，或騎兵撞擊殺不到 6 人',
    bot: [
      { type: 'spear', x: 0, y: -6 },
      { type: 'sword', x: 0, y: 0 },
      { type: 'spear', x: 0, y: 6 },
      { type: 'archer', x: -9, y: 0 },
      { type: 'light', x: -6, y: -11 },
    ],
    foe: [
      { type: 'sword', x: 7, y: 0 },
      { type: 'heavyCav', x: -6, y: -21, facing: 90, formation: 'wedge' },
    ],
    ticks: 500,
    script: (c, t) => (t === 0 ? [{ type: 'attack', id: c.B[0].id, target: c.A[1].id }] : t === 120 ? [{ type: 'charge', id: c.B[1].id, x: c.A[3].x, y: c.A[3].y }] : []),
    judge: (c) => {
      const hits = impacts(c, 1).filter((e) => e.kind === 'charge');
      const kills = hits.reduce((s, e) => s + e.kills, 0);
      const stopped = hits.some((e) => e.braced);
      return { pass: stopped || kills < 6, detail: `敵騎兵衝鋒 ${hits.length} 次、殺 ${kills} 人${stopped ? '、被槍林擋下' : ''}、我方弓兵剩 ${pct(c.A[3])}%` };
    },
  },
  {
    id: 'S9',
    name: '不送頭：單團不去打一大群',
    expect: '一團劍士面對看得到的 5 團敵軍（站著不動）：不衝上去送死，40 秒後劍士剩八成以上',
    bot: [{ type: 'sword', x: -3, y: 0 }],
    foe: [
      { type: 'spear', x: 6, y: -6 },
      { type: 'spear', x: 6, y: 0 },
      { type: 'spear', x: 6, y: 6 },
      { type: 'sword', x: 9, y: -3 },
      { type: 'sword', x: 9, y: 3 },
    ],
    ticks: 400,
    script: (c, t) => (t === 0 ? c.B.map((r) => ({ type: 'hold', id: r.id })) : []),
    judge: (c) => ({ pass: pct(c.A[0]) >= 80, detail: `劍士剩 ${pct(c.A[0])}%` }),
  },
  {
    id: 'S10',
    name: '佔點：搶下沒人守的旗',
    expect: '大河谷、對手只有一團站在自家陣地：100 秒內至少佔下兩面旗',
    mode: 'capture',
    abs: true,
    bot: [
      { type: 'light', x: 22, y: 60 },
      { type: 'lightCav', x: 22, y: 90, formation: 'wedge' },
      { type: 'spear', x: 30, y: 70 },
      { type: 'sword', x: 30, y: 80 },
      { type: 'archer', x: 26, y: 75 },
    ],
    foe: [{ type: 'spear', x: 230, y: 75 }],
    ticks: 1000,
    script: (c, t) => (t === 0 ? [{ type: 'hold', id: c.B[0].id }] : []),
    judge: (c) => {
      const held = c.m.flags.filter((f) => f.owner === 0).length;
      return { pass: held >= 2, detail: `佔下 ${held} 面旗、分數 ${c.m.scoreOf(0)}` };
    },
  },
  {
    id: 'S11',
    name: '佔點：旗被偷襲要回防',
    expect: '三面旗都是我方的，敵方輕步兵摸進北橋：要派兵趕走，90 秒後北橋還是我方的、被爭奪不超過 30 秒',
    mode: 'capture',
    abs: true,
    bot: [
      { type: 'spear', x: 112, y: 75 },
      { type: 'sword', x: 112, y: 66 },
      { type: 'lightCav', x: 105, y: 60, formation: 'wedge' },
      { type: 'archer', x: 105, y: 75 },
      { type: 'spear', x: 110, y: 120 },
    ],
    foe: [{ type: 'light', x: 136, y: 27 }],
    ticks: 900,
    setup: (c) => {
      for (const f of c.m.flags) f.owner = 0;
    },
    script: (c, t) => (t % 50 === 0 && c.B[0].slots.length > 0 ? [{ type: 'move', id: c.B[0].id, x: c.m.flags[0].x + 1500, y: c.m.flags[0].y }] : []),
    judge: (c) => {
      const f = c.m.flags[0];
      const sec = Math.round(c.contested[0] / 10);
      return { pass: f.owner === 0 && sec <= 30, detail: `北橋${f.owner === 0 ? '仍是我方' : '失守'}、被爭奪 ${sec} 秒、敵輕步兵剩 ${pct(c.B[0])}%` };
    },
  },
  {
    id: 'S12',
    name: '弓兵佔高地射擊',
    expect: '旁邊有高地、敵方劍士逼近：六成以上的箭是站在高度 3 階以上射的',
    abs: true,
    bot: [
      { type: 'archer', x: 55, y: 56 },
      { type: 'archer', x: 55, y: 63 },
      { type: 'spear', x: 60, y: 60 },
    ],
    foe: [
      { type: 'sword', x: 92, y: 55 },
      { type: 'sword', x: 92, y: 65 },
    ],
    ticks: 600,
    script: (c, t) => (t === 100 ? c.B.map((r) => ({ type: 'attackMove', id: r.id, x: c.A[0].x, y: c.A[0].y })) : []),
    judge: (c) => {
      const high = c.arrows.filter(([, h]) => h >= 3).length;
      const share = c.arrows.length ? high / c.arrows.length : 0;
      return { pass: c.arrows.length >= 20 && share >= 0.6, detail: `高地射擊 ${Math.round(share * 100)}%（${high}/${c.arrows.length} 箭）` };
    },
  },
  {
    id: 'S13',
    name: '搜敵：找出躲起來的敵人',
    expect: '殲滅戰、敵方只剩一團弓兵躲在北橋東側的樹林：150 秒內找到並打垮它',
    abs: true,
    bot: [
      { type: 'sword', x: 30, y: 45 },
      { type: 'sword', x: 30, y: 55 },
      { type: 'light', x: 30, y: 35 },
    ],
    foe: [{ type: 'archer', x: 101, y: 13 }],
    ticks: 1500,
    script: (c, t) => (t === 0 ? [{ type: 'hold', id: c.B[0].id }] : []),
    judge: (c) => ({ pass: c.m.over && c.m.result().winner === 0, detail: c.m.over ? `${Math.round(c.m.tick / 10)} 秒結束，${c.m.result().winner === 0 ? '找到並打垮' : '沒有獲勝'}` : `時間到還沒找到（弓兵剩 ${pct(c.B[0])}%）` }),
  },
];

/** 情境中心（格）：主戰區 24 × 8 格內全是同高度的平地，而且每一團的位置也都是同高度的平地 */
function openArea(m: LegionMatch, units: readonly Unit[]): [number, number] {
  const plain = (x: number, y: number, h0: number): boolean => terrainAt(m.map, x * TILE + 500, y * TILE + 500) === T.Plain && heightAt(m.map, x * TILE + 500, y * TILE + 500) === h0;
  for (let cy = 30; cy < 75; cy++) {
    for (let cx = 34; cx < 66; cx++) {
      const h0 = heightAt(m.map, cx * TILE + 500, cy * TILE + 500);
      let ok = units.every((u) => plain(cx + u.x, cy + u.y, h0));
      for (let y = cy - 8; y <= cy + 8 && ok; y++) for (let x = cx - 24; x <= cx + 24 && ok; x++) if (!plain(x, y, h0)) ok = false;
      if (ok) return [cx, cy];
    }
  }
  return flatArea(m, 24, 7);
}

/** 執行一個情境：0 號由受測 AI 指揮（用自己的預設旋鈕），1 號照腳本 */
export function runAiScenario(sc: AiScenario, bot: CompiledBot, label: string, trace?: (c: Ctx) => void): AiScenarioResult {
  const mode = sc.mode ?? 'annihilation';
  const dep = (u: Unit, i: number, p: number): object => ({ type: u.type, x: p === 0 ? 8000 : (mode === 'capture' ? 232000 : 152000), y: 6000 + i * 12000, ...(u.formation ? { formation: u.formation } : {}), ...(u.stance ? { stance: u.stance } : {}) });
  const m = new LegionMatch({ seed: 11, mode, deployments: [sc.bot.map((u, i) => dep(u, i, 0)), sc.foe.map((u, i) => dep(u, i, 1))] });
  const A = m.regiments.filter((r) => r.owner === 0);
  const B = m.regiments.filter((r) => r.owner === 1);
  if (A.length !== sc.bot.length || B.length !== sc.foe.length) throw new Error(`${sc.id}：布陣失敗`);
  let cx = 0;
  let cy = 0;
  if (!sc.abs) {
    const [fx, fy] = openArea(m, [...sc.bot, ...sc.foe]);
    cx = fx * TILE;
    cy = fy * TILE;
  }
  const place = (r: Regiment, u: Unit, p: number): void => teleport(m, r, cx + u.x * TILE, cy + u.y * TILE, u.facing ?? (p === 0 ? 0 : 180));
  sc.bot.forEach((u, i) => place(A[i], u, 0));
  sc.foe.forEach((u, i) => place(B[i], u, 1));
  for (const r of m.regiments) {
    r.tx = r.x;
    r.ty = r.y;
  }
  const events: LegionEvent[] = [];
  m.eventTap = (e) => events.push(e);
  const ctx: Ctx = { m, A, B, cx, cy, events, arrows: [], contested: m.flags.map(() => 0) };
  sc.setup?.(ctx);
  // 視野依擺好的位置重算，AI 第一次決策就看得到敵人
  m.refreshVision();
  const ctrl = new LegionBatchController(bot, label, m.map, 11, 0);
  const data = legionInitData(m.map, mode, 0, resolveKnobs(ctrl.declaration, undefined, label), m.timeLimitTicks);
  ctrl.init(data);
  ctrl.deploy(data);
  for (let t = 0; t < sc.ticks && !m.over; t++) {
    if (m.isDecisionTick()) {
      const out = ctrl.decide(m.observe(0));
      if (out.exception !== null) throw new Error(`${sc.id}：${label} 例外 ${out.exception}`);
      m.applyCommands(0, out.value);
      m.observe(1);
      if (sc.script) m.applyCommands(1, sc.script(ctx, t));
    }
    m.step();
    // 這個 tick 新射出的箭（0 號）：目標軍團與射手高度
    for (const pj of m.projectiles) {
      if (pj.t0 !== m.tick - 1 || pj.owner !== 0) continue;
      let target = pj.target >= 0 ? m.soldiers[pj.target].reg : -1;
      if (pj.target === -2) {
        let best = Infinity;
        for (const r of m.regiments) {
          if (r.owner === 0 || r.destroyed) continue;
          const d = (r.x - pj.x1) * (r.x - pj.x1) + (r.y - pj.y1) * (r.y - pj.y1);
          if (d < best) {
            best = d;
            target = r.id;
          }
        }
      }
      ctx.arrows.push([target, heightAt(m.map, pj.x0, pj.y0), pj.t0]);
    }
    m.flags.forEach((f, i) => {
      if (f.contested) ctx.contested[i] += 1;
    });
    trace?.(ctx);
  }
  const j = sc.judge(ctx);
  return { id: sc.id, name: sc.name, expect: sc.expect, pass: j.pass, detail: j.detail };
}

export function runAiScenarios(bot: CompiledBot, label: string, filter?: (id: string) => boolean, trace?: (c: Ctx) => void): AiScenarioResult[] {
  return AI_SCENARIOS.filter((s) => !filter || filter(s.id)).map((s) => runAiScenario(s, bot, label, trace));
}
