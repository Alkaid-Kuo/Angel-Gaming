// AI 情境測試：把受測 AI 放進固定的戰術情境，對手照腳本行動，檢查 AI 有沒有做對事。
// 用來量化「AI 懂不懂規則」：不正面衝槍林、錘砧戰術、弓兵集火、護弓兵、不送頭、佔點、搶高地、搜敵……
// S1～S18 是統帥的情境；S19～S42 是基準 BOT 二代的情境（docs/2026-10-27_基準BOT訓練計畫與規格.md 第五章），
// 可以指定地圖、模式（攻城、佔點、殲滅）、層（牆頂）、種子與受測 AI 的座位。
// scripts/legion-ai-scenarios.ts 印出各 AI 的結果表；test/legion-ai.test.ts 檢查官方基準 AI 通過 S1～S18。
import type { LegionEvent } from './api.ts';
import { GROUND_FAST, T, TILE, WALL_LAYER, walkableAt, type FormationKind, type LegionMode, type ShieldStance, type UnitKind } from './config.ts';
import { flatArea, teleport } from './acceptance.ts';
import { MAPS, defaultMapId, heightAt, terrainAt, type LegionMap } from './map.ts';
import { LegionBatchController } from './runner.ts';
import { LegionMatch, legionInitData, type Regiment } from './sim.ts';
import type { CompiledBot } from '../sandbox/compile.ts';
import { distSq, isqrt } from '../shared/intmath.ts';
import { angleOf } from '../shared/trig.ts';
import { resolveKnobs } from '../sandbox/controller.ts';

interface Unit {
  readonly type: UnitKind;
  /**
   * 情境座標（格）：受測 AI 在西、對手在東。abs = false 時是相對情境中心的位置（x 往東、y 往南）；abs = true 時是地圖上的格座標。
   * 受測 AI 坐 1 號時整個情境旋轉 180°（只有旋轉對稱的地圖可以；攻城圖照角色固定座位、不旋轉）
   */
  readonly x: number;
  readonly y: number;
  /** 朝向（度）；預設受測 AI 朝東、對手朝西（攻城圖：攻方朝東、守方朝西） */
  readonly facing?: number;
  readonly formation?: FormationKind;
  readonly stance?: ShieldStance;
  /** 橫陣的橫寬（人） */
  readonly width?: number;
  /** 層：0 地面（預設）、1 牆頂 */
  readonly layer?: number;
}

export interface Ctx {
  readonly m: LegionMatch;
  /** 受測 AI、腳本方的軍團，順序同情境定義 */
  readonly A: Regiment[];
  readonly B: Regiment[];
  /** 受測 AI 的座位與腳本方的座位 */
  readonly me: number;
  readonly them: number;
  readonly seed: number;
  /** 情境中心（單位）；abs 情境是 0 */
  readonly cx: number;
  readonly cy: number;
  readonly events: LegionEvent[];
  /** 受測 AI 射出的箭：[目標軍團 id（-1 = 沒有）, 射手所在高度, tick] */
  readonly arrows: [number, number, number][];
  /** 每面旗被爭奪的 tick 數 */
  readonly contested: number[];
  /** 情境自己的量測紀錄（watch 寫、judge 讀） */
  readonly mem: Record<string, number>;
  /** 情境座標（格）→ 地圖座標（單位） */
  at(x: number, y: number): { x: number; y: number };
  /** 地圖座標（單位）→ 情境座標（格） */
  local(x: number, y: number): [number, number];
  /** 某點往情境座標的東（dx 格）、南（dy 格）偏移後的地圖座標 */
  near(p: { readonly x: number; readonly y: number }, dx: number, dy: number): { x: number; y: number };
  /** 情境的朝向（度）→ 地圖上的朝向 */
  face(deg: number): number;
  /** 情境裡的第 i 面旗 → 地圖的旗號 */
  flag(i: number): number;
}

interface AiScenario {
  readonly id: string;
  readonly name: string;
  /** 檢查什麼、怎麼量 */
  readonly expect: string;
  /** 對應的機動（第四章） */
  readonly skill?: string;
  /** 規格待審（S38～S42）：照樣跑，但結果表上標「待審」 */
  readonly pending?: boolean;
  readonly mode?: LegionMode;
  /** 地圖（預設依模式：殲滅戰河谷、佔點大河谷、攻城石關城） */
  readonly mapId?: string;
  /** 用地圖格座標擺位（不找平坦區） */
  readonly abs?: boolean;
  /** 受測 AI 能坐的座位：預設 [0, 1]（雙座位）；攻城情境照角色只有一個（0 攻、1 守） */
  readonly seats?: readonly number[];
  readonly bot: readonly Unit[];
  readonly foe: readonly Unit[];
  readonly ticks: number;
  /** 開打前的設定（例如旗點歸屬） */
  readonly setup?: (c: Ctx) => void;
  /** 腳本方：每次決策回傳指令 */
  readonly script?: (c: Ctx, tick: number) => unknown[];
  /** 每個 tick 結束後的量測（寫進 c.mem） */
  readonly watch?: (c: Ctx, tick: number) => void;
  readonly judge: (c: Ctx) => { pass: boolean; detail: string };
}

export interface AiScenarioResult {
  readonly id: string;
  readonly name: string;
  readonly pass: boolean;
  readonly expect: string;
  readonly detail: string;
  readonly seed: number;
  readonly seat: number;
}

/** 情境的固定種子（規格第五章：每個情境 5 個種子、雙座位，全過才算過）；第一個是 S1～S18 一直以來用的 11 */
export const SCENARIO_SEEDS: readonly number[] = [11, 23, 37, 41, 59];

const pct = (r: Regiment): number => Math.round((r.slots.length * 100) / r.men0);
/** side：0 = 受測 AI、1 = 腳本方 */
const impacts = (c: Ctx, side: number): Extract<LegionEvent, { type: 'impact' }>[] =>
  c.events.filter((e): e is Extract<LegionEvent, { type: 'impact' }> => e.type === 'impact' && c.m.regiments[e.reg].owner === (side === 0 ? c.me : c.them));
const men = (rs: readonly Regiment[]): number => rs.reduce((t, r) => t + r.slots.length, 0);
const groupPct = (rs: readonly Regiment[]): number => Math.round((men(rs) * 100) / rs.reduce((t, r) => t + r.men0, 0));
/** 損失的點數（依人數比例） */
const lostCost = (rs: readonly Regiment[]): number => rs.reduce((t, r) => t + ((r.men0 - r.slots.length) * r.def.cost) / r.men0, 0);
/** 平方根算距離（Math.hypot 在不同 JS 引擎可能有誤差） */
const hypot = (dx: number, dy: number): number => Math.sqrt(dx * dx + dy * dy);
/** 軍團在情境座標的位置（格） */
const pos = (c: Ctx, r: Regiment): [number, number] => c.local(r.x, r.y);
/** 軍團到情境座標某點的距離（格） */
const tilesTo = (c: Ctx, r: Regiment, x: number, y: number): number => {
  const [rx, ry] = pos(c, r);
  return hypot(rx - x, ry - y);
};
const tilesBetween = (a: Regiment, b: Regiment): number => hypot(a.x - b.x, a.y - b.y) / TILE;
/** 兩團最近的士兵相距幾格 */
const gap = (c: Ctx, a: Regiment, b: Regiment): number => {
  let best = Infinity;
  for (const i of a.slots) for (const j of b.slots) best = Math.min(best, distSq(c.m.soldiers[i].x, c.m.soldiers[i].y, c.m.soldiers[j].x, c.m.soldiers[j].y));
  return Math.sqrt(best) / TILE;
};
const gone = (r: Regiment): boolean => r.destroyed || r.slots.length === 0;
/** 離 r 最近、還在場上的軍團 */
const nearest = (r: Regiment, others: readonly Regiment[]): Regiment | null => {
  let best: Regiment | null = null;
  for (const o of others) if (!gone(o) && (best === null || tilesBetween(r, o) < tilesBetween(r, best))) best = o;
  return best;
};
const ladderEvents = (c: Ctx, owner: number, state: 'building' | 'built' | 'cancelled' | 'toppled'): Extract<LegionEvent, { type: 'ladder' }>[] =>
  c.events.filter((e): e is Extract<LegionEvent, { type: 'ladder' }> => e.type === 'ladder' && e.owner === owner && e.state === state);
/** 角度差（0～180 度） */
const angleDiff = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);
/** 步兵主力（不含輕步兵與騎兵） */
const mainBody = (r: Regiment): boolean => r.kind !== 'light' && !r.def.cavalry;
/** 記下第一次發生的 tick */
const once = (c: Ctx, key: string, cond: boolean): void => {
  if (cond && c.mem[key] === undefined) c.mem[key] = c.m.tick;
};
/** 腳本方攻擊：看得到就 attack，看不到就 attackMove 到目標目前的位置（引擎的 attack 要看得到目標） */
const strike = (c: Ctx, r: Regiment, tgt: Regiment): object => (c.m.visible[c.them][tgt.id] === 1 ? { type: 'attack', id: r.id, target: tgt.id } : { type: 'attackMove', id: r.id, x: tgt.x, y: tgt.y });
/** 腳本方衝鋒：朝目標目前的位置（看不到也能衝） */
const chargeAt = (r: Regiment, tgt: Regiment): object => ({ type: 'charge', id: r.id, x: tgt.x, y: tgt.y });
const sec = (ticks: number): string => `${Math.round(ticks / 10)} 秒`;

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
    script: (c, t) => (t === 0 ? [{ type: 'brace', id: c.B[0].id, facing: c.face(180) }] : []),
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
    script: (c, t) => (t === 0 ? [{ type: 'brace', id: c.B[0].id, facing: c.face(180) }] : []),
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
      const held = c.m.flags.filter((f) => f.owner === c.me).length;
      return { pass: held >= 2, detail: `佔下 ${held} 面旗、分數 ${c.m.scoreOf(c.me)}` };
    },
  },
  {
    id: 'S11',
    name: '佔點：旗被偷襲要回防',
    expect: '三面旗都是我方的，敵方輕步兵從北橋東邊 24 格外摸過來：要派兵趕走，90 秒後北橋還是我方的、被爭奪不超過 30 秒',
    mode: 'capture',
    abs: true,
    bot: [
      { type: 'spear', x: 112, y: 75 },
      { type: 'sword', x: 112, y: 66 },
      { type: 'lightCav', x: 105, y: 60, formation: 'wedge' },
      { type: 'archer', x: 105, y: 75 },
      { type: 'spear', x: 110, y: 120 },
    ],
    foe: [{ type: 'light', x: 150, y: 27 }],
    ticks: 900,
    setup: (c) => {
      for (const f of c.m.flags) f.owner = c.me;
    },
    script: (c, t) => (t % 50 === 0 && c.B[0].slots.length > 0 ? [{ type: 'move', id: c.B[0].id, ...c.near(c.m.flags[c.flag(0)], 1.5, 0) }] : []),
    judge: (c) => {
      const f = c.m.flags[c.flag(0)];
      const sec = Math.round(c.contested[c.flag(0)] / 10);
      return { pass: f.owner === c.me && sec <= 30, detail: `北橋${f.owner === c.me ? '仍是我方' : '失守'}、被爭奪 ${sec} 秒、敵輕步兵剩 ${pct(c.B[0])}%` };
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
    expect: '殲滅戰、敵方一團輕步兵衝過來被打光後，只剩一團弓兵躲在北橋東側的樹林：150 秒內找到並打垮它',
    abs: true,
    bot: [
      { type: 'sword', x: 30, y: 45 },
      { type: 'sword', x: 30, y: 55 },
      { type: 'light', x: 30, y: 35 },
    ],
    foe: [{ type: 'archer', x: 101, y: 13 }, { type: 'light', x: 90, y: 50 }],
    ticks: 1500,
    script: (c, t) => (t === 0 ? [{ type: 'hold', id: c.B[0].id }, { type: 'attackMove', id: c.B[1].id, x: c.A[0].x, y: c.A[0].y }] : []),
    judge: (c) => ({ pass: c.m.over && c.m.result().winner === c.me, detail: c.m.over ? `${Math.round(c.m.tick / 10)} 秒結束，${c.m.result().winner === c.me ? '找到並打垮' : '沒有獲勝'}` : `時間到還沒找到（弓兵剩 ${pct(c.B[0])}%）` }),
  },
  {
    id: 'S14',
    name: '騎兵衝鋒冷卻中也打軟目標',
    expect: '重騎兵剛衝過鋒（冷卻 40 秒）：附近有一團沒人保護、正在射我方劍士的弓兵，要直接上去近戰（弓兵被貼身拉不開弓），40 秒內弓兵損失六成以上',
    bot: [
      { type: 'heavyCav', x: -9, y: 0, formation: 'wedge' },
      { type: 'sword', x: -2, y: 12 },
    ],
    foe: [{ type: 'archer', x: 6, y: 0 }],
    ticks: 400,
    setup: (c) => {
      c.A[0].skillReadyAt = c.m.tick + 400;
    },
    script: (c, t) => (t % 20 === 0 ? [{ type: 'attack', id: c.B[0].id, target: c.A[1].id }] : []),
    judge: (c) => ({ pass: pct(c.B[0]) <= 40, detail: `敵弓兵剩 ${pct(c.B[0])}%、重騎剩 ${pct(c.A[0])}%` }),
  },
  {
    id: 'S15',
    name: '不被佯攻騙：長槍守住騎兵的方向',
    expect: '敵方重騎兵在 20 格外待機，敵方劍士從側面打我方長槍；15 秒後重騎兵衝長槍：長槍不能轉去打劍士而把側背露給騎兵（側面交給友軍），騎兵要撞上槍林正面、剩三成以下，長槍撐住沒被殲滅',
    bot: [
      { type: 'spear', x: 0, y: 0, formation: 'square' },
      { type: 'sword', x: -6, y: 6 },
      { type: 'archer', x: -9, y: 0 },
    ],
    foe: [
      { type: 'heavyCav', x: 20, y: 0, formation: 'wedge' },
      { type: 'sword', x: 0, y: -11, facing: 90 },
    ],
    ticks: 500,
    script: (c, t) => {
      if (t === 0) return [{ type: 'hold', id: c.B[0].id }, { type: 'attack', id: c.B[1].id, target: c.A[0].id }];
      if (t === 150) return [{ type: 'charge', id: c.B[0].id, x: c.A[0].x, y: c.A[0].y }];
      return [];
    },
    judge: (c) => {
      const stopped = impacts(c, 1).some((e) => e.braced);
      const cav = pct(c.B[0]);
      return { pass: stopped && cav <= 30 && c.A[0].slots.length > 0, detail: `${stopped ? '槍林擋下' : '沒擋下'}、敵重騎剩 ${cav}%、長槍剩 ${pct(c.A[0])}%、敵劍士剩 ${pct(c.B[1])}%` };
    },
  },
  {
    id: 'S16',
    name: '佯攻誘敵：騙槍林轉向，騎兵衝側背',
    expect: '敵方長槍對著我方重騎兵架好槍林、後面有弓兵；對手很天真（誰逼近就把槍林轉向誰）。派誘餌從側面逼近騙它轉向，騎兵再衝它的側背：90 秒內長槍損失五成以上、重騎損失三成以內，而且騎兵沒撞上槍林正面',
    bot: [
      { type: 'heavyCav', x: -16, y: 0, formation: 'wedge' },
      { type: 'light', x: -12, y: 12 },
    ],
    foe: [
      { type: 'spear', x: 0, y: 0, formation: 'square' },
      { type: 'archer', x: 9, y: 0 },
    ],
    ticks: 900,
    script: (c, t) => {
      const sp = c.B[0];
      if (sp.slots.length === 0) return [];
      if (t === 0) return [{ type: 'brace', id: sp.id, facing: c.face(180) }, { type: 'hold', id: c.B[1].id }];
      if (t % 10 !== 0) return [];
      // 天真的對手：12 格內最近、正在逼近的我方軍團，槍林就轉過去對著它
      let near: Regiment | null = null;
      let best = 12 * TILE;
      for (const r of c.A) {
        if (r.slots.length === 0 || r.order === 'hold' || r.order === 'idle') continue;
        const d = isqrt(distSq(r.x, r.y, sp.x, sp.y));
        if (d < best) {
          best = d;
          near = r;
        }
      }
      if (near === null) return [];
      const want = angleOf(near.x - sp.x, near.y - sp.y);
      const diff = Math.abs(((want - sp.facing + 540) % 360) - 180);
      // 架著槍林不能直接轉：先收（2 秒）再朝新方向架
      if (diff <= 40) return [];
      if (sp.brace === 1 || sp.brace === 2) return [{ type: 'unbrace', id: sp.id }];
      return sp.brace === 0 ? [{ type: 'brace', id: sp.id, facing: want }] : [];
    },
    judge: (c) => {
      const intoFront = impacts(c, 0).filter((e) => e.target === c.B[0].id && e.braced).length;
      return { pass: pct(c.B[0]) <= 50 && pct(c.A[0]) >= 70 && intoFront === 0, detail: `敵長槍剩 ${pct(c.B[0])}%、重騎剩 ${pct(c.A[0])}%、誘餌剩 ${pct(c.A[1])}%、撞上槍林正面 ${intoFront} 次` };
    },
  },
  {
    id: 'S17',
    name: '破弓兵龜陣',
    expect: '敵方兩團弓兵躲在舉盾的盾兵後面（正面掩護 85%）、中間一團長槍架槍林、後方再一團弓兵，站著不動一直射。不能站在射程裡對射乾耗：要貼上去讓弓兵拉不開弓，或從側面打弓兵。150 秒內敵方弓兵損失七成以上，而且我方損失的點數比對方少',
    bot: [
      { type: 'spear', x: -16, y: -5, formation: 'square' },
      { type: 'spear', x: -16, y: 5, formation: 'square' },
      { type: 'sword', x: -16, y: -14 },
      { type: 'sword', x: -16, y: 14 },
      { type: 'archer', x: -22, y: 0 },
      { type: 'heavyCav', x: -24, y: 12, formation: 'wedge' },
      { type: 'light', x: -22, y: -12 },
    ],
    foe: [
      { type: 'archer', x: 11, y: -6 },
      { type: 'archer', x: 11, y: 6 },
      { type: 'archer', x: 16, y: 0 },
      { type: 'shield', x: 8, y: -6, stance: 'raise' },
      { type: 'shield', x: 8, y: 6, stance: 'raise' },
      { type: 'spear', x: 7, y: 0, formation: 'square' },
    ],
    ticks: 1500,
    script: (c, t) => {
      const [a1, a2, a3, s1, s2, sp] = c.B;
      if (t === 0) return [...[a1, a2, a3, s1, s2].map((r): unknown => ({ type: 'hold', id: r.id })), { type: 'brace', id: sp.id, facing: c.face(180) }];
      return [];
    },
    judge: (c) => {
      const archers = c.B.slice(0, 3);
      const left = archers.reduce((t, r) => t + r.slots.length, 0);
      const total = archers.reduce((t, r) => t + r.men0, 0);
      const lost = (side: Regiment[]): number => side.reduce((t, r) => t + ((r.men0 - r.slots.length) * r.def.cost) / r.men0, 0);
      const mine = lost(c.A);
      const theirs = lost(c.B);
      return { pass: left <= total * 0.3 && mine < theirs, detail: `敵弓兵剩 ${Math.round((left * 100) / total)}%、我方損失 ${Math.round(mine)} 點、敵方損失 ${Math.round(theirs)} 點` };
    },
  },
  {
    id: 'S18',
    name: '主動錘砧：步兵纏住、騎兵事先繞到側後方衝',
    expect: '敵方兩團劍士、一團長槍（沒架槍林）站著防守不動；我方步兵兵力略少，加一團重騎兵。要主動接戰：步兵上去纏住，騎兵先繞到側後方、從側背衝。120 秒內至少一次從側背的衝鋒，而且我方損失的點數比對方少',
    bot: [
      { type: 'spear', x: -14, y: -5, formation: 'square' },
      { type: 'sword', x: -14, y: 5 },
      { type: 'heavyCav', x: -22, y: 0, formation: 'wedge' },
    ],
    foe: [
      { type: 'sword', x: 6, y: -6 },
      { type: 'sword', x: 6, y: 6 },
      { type: 'spear', x: 6, y: 0, formation: 'square' },
    ],
    ticks: 1200,
    script: (c, t) => (t % 50 === 0 ? c.B.filter((r) => r.slots.length > 0 && r.order === 'idle').map((r) => ({ type: 'hold', id: r.id })) : []),
    judge: (c) => {
      const flankHits = impacts(c, 0).filter((e) => e.kind === 'charge' && e.flank !== 'front').length;
      const lost = (side: Regiment[]): number => side.reduce((t, r) => t + ((r.men0 - r.slots.length) * r.def.cost) / r.men0, 0);
      const mine = lost(c.A);
      const theirs = lost(c.B);
      return { pass: flankHits > 0 && mine < theirs, detail: `側背衝鋒 ${flankHits} 次、我方損失 ${Math.round(mine)} 點、敵方損失 ${Math.round(theirs)} 點` };
    },
  },
  // ───────── 基準 BOT 二代（規格第五章 S19～S42）─────────
  // 野戰情境（殲滅、佔點）雙座位：受測 AI 坐 1 號時整個情境旋轉 180°。攻城情境在石關城、照角色固定座位（0 號攻、1 號守）。
  {
    id: 'S19',
    name: '偵察不進威脅格',
    skill: 'M1',
    expect: '敵方兩團弓兵（射程 16 格）與一團架好槍林的長槍站在 36 格外不動，我方一團輕步兵在前、兩團劍士在後，一開始誰也看不到誰。60 秒內要看到敵方弓兵，而且輕步兵損失 < 10%（到射程邊緣就停，不進射程）',
    bot: [
      { type: 'light', x: -16, y: 0 },
      { type: 'sword', x: -24, y: -4 },
      { type: 'sword', x: -24, y: 4 },
    ],
    foe: [
      { type: 'archer', x: 20, y: -4 },
      { type: 'archer', x: 20, y: 4 },
      { type: 'spear', x: 16, y: 0, formation: 'square' },
    ],
    ticks: 600,
    script: (c, t) => (t === 0 ? [{ type: 'hold', id: c.B[0].id }, { type: 'hold', id: c.B[1].id }, { type: 'brace', id: c.B[2].id, facing: c.face(180) }] : []),
    watch: (c) => once(c, 'seen', c.m.visible[c.me][c.B[0].id] === 1 || c.m.visible[c.me][c.B[1].id] === 1),
    judge: (c) => {
      const seen = c.mem.seen;
      return { pass: seen !== undefined && pct(c.A[0]) > 90, detail: `${seen === undefined ? '沒看到敵方弓兵' : `${sec(seen)}看到敵方弓兵`}、輕步兵剩 ${pct(c.A[0])}%、劍士剩 ${groupPct(c.A.slice(1))}%` };
    },
  },
  {
    id: 'S20',
    name: '未確認樹林先探再過河',
    skill: 'M1',
    mapId: 'grand-valley',
    abs: true,
    expect: '大河谷殲滅戰：我方在北橋西岸，敵方重騎兵藏在北橋東岸的樹林（中心約 152, 16），另一團弓兵在更東邊。主力（劍、槍）第一次過北橋到東岸（x ≥ 131、y ≤ 45）之前，120 秒內要有輕單位（輕步、騎兵）探到樹林 10 格內或看到藏著的騎兵，而且探到之前主力不過河（主力一直沒過河也可以）。伏兵：有我方軍團進到它 12 格內就衝鋒',
    bot: [
      { type: 'light', x: 114, y: 29 },
      { type: 'sword', x: 112, y: 22 },
      { type: 'sword', x: 112, y: 35 },
      { type: 'spear', x: 106, y: 28, formation: 'square' },
    ],
    foe: [
      { type: 'heavyCav', x: 152, y: 15, formation: 'wedge' },
      { type: 'archer', x: 200, y: 40 },
    ],
    ticks: 1200,
    script: (c, t) => {
      const cav = c.B[0];
      if (t === 0) return [{ type: 'hold', id: cav.id }, { type: 'hold', id: c.B[1].id }];
      if (gone(cav) || c.mem.sprung !== undefined) return [];
      const prey = nearest(cav, c.A);
      if (prey === null || tilesBetween(cav, prey) > 12) return [];
      c.mem.sprung = t;
      return [chargeAt(cav, prey)];
    },
    watch: (c) => {
      once(c, 'probed', c.m.visible[c.me][c.B[0].id] === 1 || c.A.some((r) => !mainBody(r) && !gone(r) && tilesTo(c, r, 152, 16) <= 10));
      once(c, 'crossed', c.A.some((r) => mainBody(r) && !gone(r) && pos(c, r)[0] >= 131 && pos(c, r)[1] <= 45));
    },
    judge: (c) => {
      const { probed, crossed } = c.mem;
      const ok = probed !== undefined && (crossed === undefined || probed <= crossed);
      return { pass: ok, detail: `${probed === undefined ? '沒探樹林' : `${sec(probed)}探到樹林`}、${crossed === undefined ? '主力沒過北橋' : `${sec(crossed)}主力過北橋`}、我方剩 ${groupPct(c.A)}%` };
    },
  },
  {
    id: 'S21',
    name: '牽制不追擊',
    skill: 'M2',
    expect: '我方兩團劍士與敵方兩團劍士接戰，我方弓兵在後；15 秒後敵方劍士退回 13 格外的槍林與弓兵前面（陷阱）。15 秒後我方劍士往前不超過退兵當下位置 5 格（不追），而且我方弓兵在 15～60 秒間至少射 10 箭（繼續施壓）',
    bot: [
      { type: 'sword', x: -3, y: -4 },
      { type: 'sword', x: -3, y: 4 },
      { type: 'archer', x: -10, y: -4 },
      { type: 'archer', x: -10, y: 4 },
    ],
    foe: [
      { type: 'sword', x: 3, y: -4 },
      { type: 'sword', x: 3, y: 4 },
      { type: 'spear', x: 17, y: 0, formation: 'square' },
      { type: 'archer', x: 21, y: 0 },
    ],
    ticks: 600,
    script: (c, t) => {
      const [s1, s2, sp, ar] = c.B;
      if (t === 0) return [strike(c, s1, c.A[0]), strike(c, s2, c.A[1]), { type: 'brace', id: sp.id, facing: c.face(180) }, { type: 'hold', id: ar.id }];
      if (t === 150) return [{ type: 'move', id: s1.id, ...c.at(13, -4), facing: c.face(180) }, { type: 'move', id: s2.id, ...c.at(13, 4), facing: c.face(180) }];
      return [];
    },
    watch: (c, t) => {
      const xs = c.A.slice(0, 2).filter((r) => !gone(r)).map((r) => pos(c, r)[0]);
      if (xs.length === 0) return;
      if (t === 149) c.mem.x0 = Math.max(...xs);
      if (t >= 150) c.mem.maxX = Math.max(c.mem.maxX ?? -Infinity, ...xs);
    },
    judge: (c) => {
      const adv = (c.mem.maxX ?? 0) - (c.mem.x0 ?? 0);
      const shots = c.arrows.filter(([, , t]) => t >= 150).length;
      return { pass: c.mem.x0 !== undefined && adv <= 5 && shots >= 10, detail: `退兵後劍士最多前進 ${adv.toFixed(1)} 格、弓兵射 ${shots} 箭、我方劍士剩 ${groupPct(c.A.slice(0, 2))}%` };
    },
  },
  {
    id: 'S22',
    name: '側翼走低威脅路徑',
    skill: 'M3',
    expect: '敵方兩團劍士在正面不動，一團弓兵在它們東北（10, -12）掩護北側；我方重騎兵在西北。重騎兵 90 秒內要繞到敵方劍士的背後（x ≥ 14、4 ≤ y ≤ 10），而且到達前離敵方弓兵始終超過 16 格（不穿過射程；直線過去會穿過，要從南邊繞）',
    bot: [
      { type: 'heavyCav', x: -14, y: -10, formation: 'wedge' },
      { type: 'sword', x: -8, y: -4 },
      { type: 'sword', x: -8, y: 4 },
    ],
    foe: [
      { type: 'sword', x: 8, y: -3 },
      { type: 'sword', x: 8, y: 3 },
      { type: 'archer', x: 10, y: -12 },
    ],
    ticks: 900,
    script: (c, t) => (t === 0 ? c.B.map((r) => ({ type: 'hold', id: r.id })) : []),
    watch: (c) => {
      const cav = c.A[0];
      if (gone(cav) || c.mem.arrived !== undefined) return;
      const [x, y] = pos(c, cav);
      once(c, 'arrived', x >= 14 && y >= 4 && y <= 10);
      if (!gone(c.B[2])) c.mem.minD = Math.min(c.mem.minD ?? Infinity, tilesBetween(cav, c.B[2]));
    },
    judge: (c) => {
      const { arrived, minD } = c.mem;
      return { pass: arrived !== undefined && (minD ?? Infinity) > 16, detail: `${arrived === undefined ? '沒繞到背後' : `${sec(arrived)}到背後`}、離敵弓兵最近 ${(minD ?? Infinity).toFixed(1)} 格、重騎剩 ${pct(c.A[0])}%` };
    },
  },
  {
    id: 'S23',
    name: '側翼被發現就放棄',
    skill: 'M3',
    expect: '敵方兩團長槍朝西架好槍林、後面一團弓兵；我方重騎兵從南側繞。重騎兵到南側長槍 14 格內（而且在它南邊）就算被發現：那團長槍收槍、轉向重騎兵重架（一直跟著轉）。要有側翼行動（被發現過），而且重騎兵不撞上槍林正面、90 秒後剩 80% 以上',
    bot: [
      { type: 'heavyCav', x: -10, y: 12, formation: 'wedge' },
      { type: 'sword', x: -8, y: -3 },
      { type: 'sword', x: -8, y: 3 },
    ],
    foe: [
      { type: 'spear', x: 6, y: -3, formation: 'square' },
      { type: 'spear', x: 6, y: 4, formation: 'square' },
      { type: 'archer', x: 13, y: 0 },
    ],
    ticks: 900,
    script: (c, t) => {
      const [sp1, sp2, ar] = c.B;
      if (t === 0) return [{ type: 'brace', id: sp1.id, facing: c.face(180) }, { type: 'brace', id: sp2.id, facing: c.face(180) }, { type: 'hold', id: ar.id }];
      const cav = c.A[0];
      if (t % 10 !== 0 || gone(sp2) || gone(cav)) return [];
      if (c.mem.found === undefined) {
        if (tilesBetween(cav, sp2) > 14 || pos(c, cav)[1] < pos(c, sp2)[1] + 2) return [];
        c.mem.found = t;
      }
      const want = angleOf(cav.x - sp2.x, cav.y - sp2.y);
      if (angleDiff(want, sp2.facing) <= 40) return [];
      if (sp2.brace === 1 || sp2.brace === 2) return [{ type: 'unbrace', id: sp2.id }];
      return sp2.brace === 0 ? [{ type: 'brace', id: sp2.id, facing: want }] : [];
    },
    judge: (c) => {
      const intoFront = impacts(c, 0).filter((e) => e.reg === c.A[0].id && e.braced).length;
      const found = c.mem.found;
      return { pass: found !== undefined && intoFront === 0 && pct(c.A[0]) >= 80, detail: `${found === undefined ? '沒有側翼行動' : `${sec(found)}被發現`}、撞上槍林正面 ${intoFront} 次、重騎剩 ${pct(c.A[0])}%` };
    },
  },
  {
    id: 'S24',
    name: '衝完就脫離再衝',
    skill: 'M4',
    expect: '我方兩劍一槍纏住敵方三團劍士與一團舉盾的盾兵，敵方兩團弓兵在後；我方重騎兵在南側待命。150 秒內重騎兵至少衝鋒兩次、兩次都打在側面或背面，而且第一次衝完 5 秒內脫離（衝刺結束、離所有敵兵 4 格以上），冷卻 30 秒後再衝',
    bot: [
      { type: 'heavyCav', x: -8, y: 16, formation: 'wedge' },
      { type: 'sword', x: -2, y: -7 },
      { type: 'spear', x: -2, y: 0, formation: 'square' },
      { type: 'sword', x: -2, y: 7 },
    ],
    foe: [
      { type: 'sword', x: 2, y: -7 },
      { type: 'shield', x: 2, y: 0, stance: 'raise' },
      { type: 'sword', x: 2, y: 7 },
      { type: 'sword', x: 6, y: 0 },
      { type: 'archer', x: 12, y: -4 },
      { type: 'archer', x: 12, y: 4 },
    ],
    ticks: 1500,
    script: (c, t) => (t === 0 ? [strike(c, c.B[0], c.A[1]), strike(c, c.B[1], c.A[2]), strike(c, c.B[2], c.A[3]), { type: 'hold', id: c.B[3].id }, { type: 'hold', id: c.B[4].id }, { type: 'hold', id: c.B[5].id }] : []),
    watch: (c) => {
      const cav = c.A[0];
      const first = impacts(c, 0).find((e) => e.reg === cav.id && e.kind === 'charge');
      if (first === undefined || gone(cav) || c.m.tick > first.tick + 50) return;
      // 脫離：衝刺結束、離所有敵兵 4 格以上
      once(c, 'away', cav.dash === null && c.B.every((r) => gone(r) || gap(c, cav, r) >= 4));
    },
    judge: (c) => {
      const charges = impacts(c, 0).filter((e) => e.reg === c.A[0].id && e.kind === 'charge');
      const flanked = charges.slice(0, 2).filter((e) => e.flank !== 'front').length;
      const first = charges[0];
      const away = c.mem.away;
      return {
        pass: charges.length >= 2 && flanked === 2 && away !== undefined,
        detail: `衝鋒 ${charges.length} 次（前兩次側背 ${flanked} 次）、${first === undefined ? '沒衝' : away === undefined ? '第一次衝完 5 秒內沒脫離' : `第一次衝完 ${((away - first.tick) / 10).toFixed(1)} 秒脫離`}、重騎剩 ${pct(c.A[0])}%`,
      };
    },
  },
  {
    id: 'S25',
    name: '佯退引入殺傷區',
    skill: 'M5',
    expect: '我方一團輕步兵在前、後面是兩團弓兵、一團長槍與一團劍士（殺傷區）；敵方兩團劍士會追最近的我方軍團。90 秒後敵方損失的點數 > 我方損失 × 2（而且敵方至少損失 30 點，代表真的打過）',
    bot: [
      { type: 'light', x: 4, y: 0 },
      { type: 'archer', x: -14, y: -4 },
      { type: 'archer', x: -14, y: 4 },
      { type: 'spear', x: -9, y: 0, formation: 'square' },
      { type: 'sword', x: -9, y: 8 },
    ],
    foe: [
      { type: 'sword', x: 12, y: -3 },
      { type: 'sword', x: 12, y: 3 },
    ],
    ticks: 900,
    script: (c, t) => {
      if (t % 20 !== 0) return [];
      const out: unknown[] = [];
      for (const r of c.B) {
        const prey = gone(r) ? null : nearest(r, c.A);
        if (prey !== null && r.target !== prey.id) out.push(strike(c, r, prey));
      }
      return out;
    },
    judge: (c) => {
      const mine = lostCost(c.A);
      const theirs = lostCost(c.B);
      return { pass: theirs > mine * 2 && theirs >= 30, detail: `我方損失 ${Math.round(mine)} 點、敵方損失 ${Math.round(theirs)} 點` };
    },
  },
  {
    id: 'S26',
    name: '撤退不退進攔截路線',
    skill: 'M6',
    expect: '東邊四團敵軍（三劍一槍）壓上來、追 15 秒後停下，西南另有一支敵軍（輕騎＋劍士）埋伏不動；我方兩劍一弓打不贏。40 秒內我方任何一團都不進到西南伏兵 8 格內（撤退方向避開第二支），而且我方剩 40% 以上',
    bot: [
      { type: 'sword', x: 14, y: -3 },
      { type: 'sword', x: 14, y: 3 },
      { type: 'archer', x: 10, y: 0 },
    ],
    foe: [
      { type: 'sword', x: 26, y: -6 },
      { type: 'sword', x: 26, y: 0 },
      { type: 'sword', x: 26, y: 6 },
      { type: 'spear', x: 29, y: 0 },
      { type: 'lightCav', x: -2, y: 12, formation: 'wedge' },
      { type: 'sword', x: 2, y: 14 },
    ],
    ticks: 400,
    script: (c, t) => {
      if (t % 20 !== 0) return [];
      const out: unknown[] = [];
      c.B.forEach((r, i) => {
        if (gone(r)) return;
        const prey = nearest(r, c.A);
        if (prey === null) return;
        // 伏兵：有人進到 10 格內才動
        if (i >= 4 && tilesBetween(r, prey) > 10) {
          if (t === 0) out.push({ type: 'hold', id: r.id });
          return;
        }
        // 主力追 15 秒後停下
        if (i < 4 && t >= 150) {
          if (t === 160) out.push({ type: 'hold', id: r.id });
          return;
        }
        if (r.target !== prey.id) out.push(strike(c, r, prey));
      });
      return out;
    },
    watch: (c) => {
      for (const r of c.A) {
        if (gone(r)) continue;
        for (const q of c.B.slice(4)) if (!gone(q)) c.mem.minD = Math.min(c.mem.minD ?? Infinity, tilesBetween(r, q));
      }
    },
    judge: (c) => {
      const minD = c.mem.minD ?? Infinity;
      return { pass: minD >= 8 && groupPct(c.A) >= 40, detail: `離伏兵最近 ${minD.toFixed(1)} 格、我方剩 ${groupPct(c.A)}%` };
    },
  },
  {
    id: 'S27',
    name: '掩護撤退',
    skill: 'M6',
    expect: '一團盾兵掩護兩團弓兵，東邊三團敵方劍士 2 秒後壓上來（追到 20 秒就停）。要盾兵面敵後退、弓兵先走：40 秒後我方總損失 < 20%，弓兵損失也 < 20%',
    bot: [
      { type: 'shield', x: 16, y: 0 },
      { type: 'archer', x: 11, y: -4 },
      { type: 'archer', x: 11, y: 4 },
    ],
    foe: [
      { type: 'sword', x: 26, y: -4 },
      { type: 'sword', x: 26, y: 0 },
      { type: 'sword', x: 26, y: 4 },
    ],
    ticks: 400,
    script: (c, t) => {
      if (t < 20 || t % 20 !== 0) return [];
      if (t >= 200) return t === 200 ? c.B.filter((r) => !gone(r)).map((r) => ({ type: 'hold', id: r.id })) : [];
      const out: unknown[] = [];
      for (const r of c.B) {
        const prey = gone(r) ? null : nearest(r, c.A);
        if (prey !== null && r.target !== prey.id) out.push(strike(c, r, prey));
      }
      return out;
    },
    judge: (c) => {
      const all = 100 - groupPct(c.A);
      const arch = 100 - groupPct(c.A.slice(1));
      return { pass: all < 20 && arch < 20, detail: `我方損失 ${all}%、弓兵損失 ${arch}%、盾兵剩 ${pct(c.A[0])}%` };
    },
  },
  {
    id: 'S28',
    name: '選高地架殺傷區',
    skill: 'M8',
    mode: 'capture',
    mapId: 'grand-valley',
    abs: true,
    expect: '大河谷，我方佔著中央淺灘、要守住；敵方兩劍一輕步在東岸，20 秒後渡淺灘來搶。西岸淺灘旁 12 格內有一座高地（3～4 階，東緣離淺灘中央約 19 格，在高地弓兵射程邊緣）。30 秒時（敵軍正在渡河）兩團弓兵的中心都站在 3 階以上，而且長槍在淺灘西口（114, 75）6 格內擋正面；高地射出的箭比例只記錄',
    bot: [
      { type: 'archer', x: 110, y: 72 },
      { type: 'archer', x: 110, y: 79 },
      { type: 'spear', x: 106, y: 75, formation: 'square' },
      { type: 'sword', x: 104, y: 70 },
    ],
    foe: [
      { type: 'sword', x: 140, y: 72 },
      { type: 'sword', x: 140, y: 79 },
      { type: 'light', x: 144, y: 75 },
    ],
    ticks: 900,
    setup: (c) => {
      c.m.flags[c.flag(1)].owner = c.me;
    },
    script: (c, t) => {
      if (t === 0) return c.B.map((r) => ({ type: 'hold', id: r.id }));
      if (t !== 200) return [];
      const f = c.m.flags[c.flag(1)];
      return c.B.map((r) => ({ type: 'attackMove', id: r.id, x: f.x, y: f.y }));
    },
    watch: (c, t) => {
      if (t !== 299) return;
      c.mem.spearD = gone(c.A[2]) ? Infinity : tilesTo(c, c.A[2], 114, 75);
      c.mem.archerH = Math.min(...c.A.slice(0, 2).map((r) => (gone(r) ? 0 : heightAt(c.m.map, r.x, r.y))));
    },
    judge: (c) => {
      const high = c.arrows.filter(([, h]) => h >= 3).length;
      const share = c.arrows.length ? high / c.arrows.length : 0;
      const d = c.mem.spearD ?? Infinity;
      const h = c.mem.archerH ?? 0;
      return { pass: h >= 3 && d <= 6, detail: `30 秒時弓兵最低站在 ${h} 階、高地射擊 ${Math.round(share * 100)}%（${high}/${c.arrows.length} 箭）、30 秒時長槍離淺灘西口 ${d.toFixed(1)} 格、中央淺灘${c.m.flags[c.flag(1)].owner === c.me ? '仍是我方' : '失守'}` };
    },
  },
  {
    id: 'S29',
    name: '多點佯攻找薄弱牆段',
    skill: 'M9',
    mode: 'siege',
    abs: true,
    seats: [0],
    expect: '石關城攻方：西牆北段（y 38～52）有兩團弓兵＋一團長槍守，甕城西牆一團弓兵，西牆南段（y 87～103）只有一團輕步兵；守方站著不動。我方從西橋外出發（要自己去看）。150 秒內第一架開始架的雲梯要在南段（梯口 y ≥ 84）',
    bot: [
      { type: 'sword', x: 84, y: 58 },
      { type: 'sword', x: 84, y: 67 },
      { type: 'sword', x: 80, y: 62 },
      { type: 'light', x: 87, y: 63 },
      { type: 'spear', x: 78, y: 70 },
    ],
    foe: [
      { type: 'archer', x: 111.5, y: 40, layer: 1 },
      { type: 'archer', x: 111.5, y: 51, layer: 1 },
      { type: 'spear', x: 111.5, y: 45.5, layer: 1 },
      { type: 'archer', x: 97.5, y: 72, layer: 1 },
      { type: 'light', x: 111.5, y: 99, layer: 1 },
    ],
    ticks: 1500,
    script: (c, t) => (t === 0 ? c.B.map((r) => ({ type: 'hold', id: r.id })) : []),
    judge: (c) => {
      const first = ladderEvents(c, c.me, 'building')[0];
      if (first === undefined) return { pass: false, detail: `150 秒內沒架雲梯、我方剩 ${groupPct(c.A)}%` };
      const l = c.m.ladders[first.ladder];
      const y = l.ty / TILE;
      const where = y >= 84 ? '南段（薄弱）' : y <= 55 ? '北段（重兵）' : '甕城';
      return { pass: y >= 84, detail: `${sec(first.tick)}第一架雲梯在${where}（梯口 ${(l.tx / TILE).toFixed(1)}, ${y.toFixed(1)}）、共架 ${ladderEvents(c, c.me, 'building').length} 次` };
    },
  },
  {
    id: 'S30',
    name: '登城清梯口',
    skill: 'M9',
    mode: 'siege',
    abs: true,
    seats: [0],
    expect: '石關城攻方：我方兩團劍士剛從雲梯登上西牆北段（牆頂 111.5, 45～50，以直接擺在牆頂代替爬梯），守方一團長槍站在往正門的牆頂上（111.5, 63）、一團弓兵在門樓頂。60 秒內登城組要沿牆頂推到門樓（任一團中心在牆頂、離門樓中心 112, 69.5 不到 5 格），不停在登城點',
    bot: [
      { type: 'sword', x: 111.5, y: 45, layer: 1, facing: 90 },
      { type: 'sword', x: 111.5, y: 50, layer: 1, facing: 90 },
      { type: 'sword', x: 84, y: 62 },
    ],
    foe: [
      { type: 'spear', x: 111.5, y: 63, layer: 1, facing: 270 },
      { type: 'archer', x: 112, y: 69.5, layer: 1 },
      { type: 'sword', x: 125, y: 69.5 },
    ],
    ticks: 600,
    script: (c, t) => (t === 0 ? c.B.map((r) => ({ type: 'hold', id: r.id })) : []),
    watch: (c) => {
      for (const r of c.A.slice(0, 2)) if (!gone(r) && r.layer === WALL_LAYER) c.mem.best = Math.min(c.mem.best ?? Infinity, tilesTo(c, r, 112, 69.5));
      once(c, 'reached', (c.mem.best ?? Infinity) < 5);
    },
    judge: (c) => {
      const best = c.mem.best ?? Infinity;
      return { pass: c.mem.reached !== undefined, detail: `牆頂離門樓最近 ${best.toFixed(1)} 格${c.mem.reached === undefined ? '' : `（${sec(c.mem.reached)}到）`}、登城組剩 ${groupPct(c.A.slice(0, 2))}%` };
    },
  },
  {
    id: 'S31',
    name: 'A 佔下後推 B',
    skill: 'M9',
    mode: 'siege',
    abs: true,
    seats: [0],
    expect: '石關城攻方：我方四團站在正門廣場（A 旗）圈內、進度差 1 秒佔滿，守方兩團在衙署（B 旗）不動。A 佔下後 10 秒時，我方六成以上的人（依人數）所屬的團要比 A 佔下當下離 B 近了 4 格以上（主力轉向 B，不留在 A）',
    bot: [
      { type: 'sword', x: 120, y: 67 },
      { type: 'sword', x: 120, y: 72 },
      { type: 'spear', x: 124, y: 69.5, formation: 'square' },
      { type: 'archer', x: 117, y: 69.5 },
    ],
    foe: [
      { type: 'sword', x: 190, y: 66 },
      { type: 'spear', x: 190, y: 73, formation: 'square' },
    ],
    ticks: 500,
    setup: (c) => {
      const a = c.m.flags[0];
      a.capturer = c.me;
      a.progress = a.need - 10;
    },
    script: (c, t) => (t === 0 ? c.B.map((r) => ({ type: 'hold', id: r.id })) : []),
    watch: (c) => {
      const tA = c.events.find((e) => e.type === 'flag' && e.flag === 0 && e.owner === c.me)?.tick;
      if (tA === undefined) return;
      const b = c.m.flags[1];
      const dB = (r: Regiment): number => hypot(r.x - b.x, r.y - b.y) / TILE;
      if (c.mem.tA === undefined) {
        c.mem.tA = tA;
        c.A.forEach((r, i) => (c.mem[`d${i}`] = dB(r)));
      }
      if (c.m.tick === tA + 100) {
        let moved = 0;
        c.A.forEach((r, i) => {
          if (!gone(r) && c.mem[`d${i}`] - dB(r) >= 4) moved += r.slots.length;
        });
        c.mem.share = men(c.A) ? moved / men(c.A) : 0;
      }
    },
    judge: (c) => {
      if (c.mem.tA === undefined) return { pass: false, detail: 'A 沒佔下' };
      const share = c.mem.share ?? 0;
      return { pass: share >= 0.6, detail: `${sec(c.mem.tA)}佔下 A；10 秒後往 B 推進 4 格以上的人 ${Math.round(share * 100)}%` };
    },
  },
  {
    id: 'S32',
    name: '守方依攻方主攻重分配牆段',
    skill: 'M10',
    mode: 'siege',
    abs: true,
    seats: [1],
    expect: '石關城守方：我方弓兵在西牆北段與南段牆頂各一團，預備隊（劍士、長槍）在城內正門北側；攻方四團過西橋後全部壓向西牆北段。從攻方集中（三團以上到北段牆外 105, 44 的 8 格內）起 10 秒內，至少一團原本不在北段的我方軍團到北段（離 112, 44 不到 6 格，牆頂或牆後地面都算；提前到也算）',
    bot: [
      { type: 'archer', x: 111.5, y: 40, layer: 1 },
      { type: 'archer', x: 111.5, y: 98, layer: 1 },
      { type: 'sword', x: 120, y: 53 },
      { type: 'spear', x: 126, y: 62, formation: 'square' },
    ],
    foe: [
      { type: 'sword', x: 84, y: 58 },
      { type: 'sword', x: 84, y: 66 },
      { type: 'sword', x: 80, y: 62 },
      { type: 'spear', x: 78, y: 68 },
    ],
    ticks: 900,
    script: (c, t) => {
      if (t % 20 !== 0) return [];
      const goals: [number, number][] = [[105, 38], [105, 44], [106, 50], [103, 46]];
      const out: unknown[] = [];
      c.B.forEach((r, i) => {
        if (gone(r)) return;
        const [gx, gy] = goals[i];
        // 到了就架雲梯（劍士、長槍），還沒到就往牆外走
        if (tilesTo(c, r, gx, gy) <= 3) {
          if (r.building < 0 && t % 100 === 0) out.push({ type: 'ladder', id: r.id, ...c.at(gx + 5.5, gy + 0.5) });
        } else if (r.order !== 'move') out.push({ type: 'move', id: r.id, ...c.at(gx, gy) });
      });
      return out;
    },
    watch: (c) => {
      const near = c.B.filter((r) => !gone(r) && tilesTo(c, r, 105, 44) <= 8).length;
      once(c, 'massed', near >= 3);
      once(c, 'arrived', c.A.slice(1).some((r) => !gone(r) && tilesTo(c, r, 112, 44) < 6));
    },
    judge: (c) => {
      const { massed, arrived } = c.mem;
      if (massed === undefined) return { pass: false, detail: `攻方沒集中到北段（情境沒發生）、我方剩 ${groupPct(c.A)}%` };
      return { pass: arrived !== undefined && arrived <= massed + 100, detail: `${sec(massed)}攻方集中、${arrived === undefined ? '預備隊沒到北段' : `${sec(arrived)}預備隊到北段`}` };
    },
  },
  {
    id: 'S33',
    name: '推倒雲梯',
    skill: 'M10',
    mode: 'siege',
    abs: true,
    seats: [1],
    expect: '石關城守方：我方一團長槍、一團劍士在西牆北段牆頂（沒有弓兵）；攻方一團盾兵在牆外架雲梯（梯口 110.5, 40.5），架好後不爬、站在梯腳。雲梯架好後 10 秒內要被我方推倒（梯口 1 格內沒有攻方士兵，讀條 3 秒）',
    bot: [
      { type: 'spear', x: 111.5, y: 37, layer: 1, facing: 90 },
      { type: 'sword', x: 111.5, y: 52, layer: 1, facing: 270 },
    ],
    foe: [
      { type: 'shield', x: 107, y: 40, stance: 'raise' },
      { type: 'light', x: 70, y: 62 },
    ],
    ticks: 600,
    script: (c, t) => {
      if (t === 0) return [{ type: 'ladder', id: c.B[0].id, ...c.at(110.5, 40.5) }, { type: 'hold', id: c.B[1].id }];
      return [];
    },
    judge: (c) => {
      const built = ladderEvents(c, c.them, 'built')[0];
      if (built === undefined) return { pass: false, detail: '攻方的雲梯沒架好（情境沒發生）' };
      const down = ladderEvents(c, c.them, 'toppled').find((e) => e.ladder === built.ladder);
      return { pass: down !== undefined && down.tick - built.tick <= 100, detail: down === undefined ? `${sec(built.tick)}架好，一直沒推倒` : `架好後 ${((down.tick - built.tick) / 10).toFixed(1)} 秒推倒` };
    },
  },
  {
    id: 'S34',
    name: '出擊打無護衛弓兵',
    skill: 'M10',
    mode: 'siege',
    abs: true,
    seats: [1],
    expect: '石關城守方：攻方兩團弓兵沒有護衛、站在甕城裡離正門 8 格處，一直射我方牆頂的長槍；我方兩團劍士在正門內側（我方沒有弓兵，不出擊打不到它們）。要開門出擊：90 秒內敵方弓兵損失五成以上，而且 90 秒時我方地面部隊都回到城內（地面不在正門以西 x < 110，退回）',
    bot: [
      { type: 'sword', x: 117, y: 66 },
      { type: 'sword', x: 117, y: 73 },
      { type: 'spear', x: 122, y: 69.5, formation: 'square' },
      { type: 'spear', x: 111.5, y: 62, layer: 1 },
    ],
    foe: [
      { type: 'archer', x: 104, y: 66 },
      { type: 'archer', x: 104, y: 73 },
    ],
    ticks: 900,
    // 弓兵站著不動（hold 照樣射射程內看得到的敵人）
    script: (c, t) => (t === 0 ? c.B.map((r) => ({ type: 'hold', id: r.id })) : []),
    judge: (c) => {
      const foe = groupPct(c.B);
      // 城外 ＝ 地面、在正門以西（城牆 x 110～113 的地面不可走，門洞外就是甕城）
      const out = c.A.filter((r) => !gone(r) && r.layer === 0 && pos(c, r)[0] < 110).length;
      return { pass: foe <= 50 && out === 0, detail: `敵弓兵剩 ${foe}%、城外還有 ${out} 團、我方劍士剩 ${groupPct(c.A.slice(0, 2))}%、正門${c.m.gates[0].state}` };
    },
  },
  {
    id: 'S35',
    name: '反輕步洪流',
    skill: 'M11',
    mode: 'capture',
    mapId: 'grand-valley',
    abs: true,
    expect: '大河谷，北橋與中央淺灘是我方的；敵方三團輕步兵從東岸一直衝向北橋搶旗。我方北橋只有一團劍士，另有一團輕騎兵在西岸機動。90 秒後北橋仍是我方的，而且敵方輕步兵損失五成以上',
    bot: [
      { type: 'sword', x: 121, y: 27 },
      { type: 'lightCav', x: 108, y: 45, formation: 'wedge' },
      { type: 'spear', x: 117, y: 75, formation: 'square' },
      { type: 'archer', x: 112, y: 76 },
    ],
    foe: [
      { type: 'light', x: 158, y: 28 },
      { type: 'light', x: 156, y: 36 },
      { type: 'light', x: 162, y: 22 },
    ],
    ticks: 900,
    setup: (c) => {
      c.m.flags[c.flag(0)].owner = c.me;
      c.m.flags[c.flag(1)].owner = c.me;
    },
    script: (c, t) => {
      if (t % 30 !== 0) return [];
      const f = c.m.flags[c.flag(0)];
      return c.B.filter((r) => !gone(r)).map((r) => ({ type: 'attackMove', id: r.id, x: f.x, y: f.y }));
    },
    judge: (c) => {
      const f = c.m.flags[c.flag(0)];
      return { pass: f.owner === c.me && groupPct(c.B) <= 50, detail: `北橋${f.owner === c.me ? '仍是我方' : '失守'}（被爭奪 ${sec(c.contested[c.flag(0)])}）、敵輕步兵剩 ${groupPct(c.B)}%、我方輕騎剩 ${pct(c.A[1])}%` };
    },
  },
  {
    id: 'S36',
    name: '不被佯攻騙（整軍）',
    skill: 'M7',
    expect: '我方六團（劍、槍、劍一線，兩團弓兵在後，一團長槍護衛在南後方）面向東邊 16 格外不動的敵方兩團劍士；敵方一團輕騎兵在北側 15 格處來回晃、從不衝鋒。60 秒內任何時候「朝向輕騎兵（50° 內）而且背離正面（離東方超過 50°）」的我方軍團不超過 2 團（只有護衛反應）',
    bot: [
      { type: 'sword', x: 0, y: -6 },
      { type: 'spear', x: 0, y: 0, formation: 'square' },
      { type: 'sword', x: 0, y: 6 },
      { type: 'archer', x: -6, y: -3 },
      { type: 'archer', x: -6, y: 3 },
      { type: 'spear', x: -9, y: 8, formation: 'square' },
    ],
    foe: [
      { type: 'sword', x: 16, y: -4 },
      { type: 'sword', x: 16, y: 4 },
      { type: 'lightCav', x: -4, y: -15, formation: 'wedge', facing: 0 },
    ],
    ticks: 600,
    script: (c, t) => {
      if (t === 0) return [{ type: 'hold', id: c.B[0].id }, { type: 'hold', id: c.B[1].id }];
      const cav = c.B[2];
      if (gone(cav) || t % 60 !== 0) return [];
      return [{ type: 'move', id: cav.id, ...c.at((t / 60) % 2 === 1 ? 6 : -12, -15) }];
    },
    watch: (c, t) => {
      const cav = c.B[2];
      if (t < 30 || t % 10 !== 0 || gone(cav)) return;
      const front = c.face(0);
      const turned = c.A.filter((r) => !gone(r) && angleDiff(r.facing, angleOf(cav.x - r.x, cav.y - r.y)) <= 50 && angleDiff(r.facing, front) > 50).length;
      c.mem.maxTurn = Math.max(c.mem.maxTurn ?? 0, turned);
    },
    judge: (c) => {
      const n = c.mem.maxTurn ?? 0;
      return { pass: n <= 2, detail: `同時轉向輕騎兵最多 ${n} 團、輕騎兵剩 ${pct(c.B[2])}%、我方剩 ${groupPct(c.A)}%` };
    },
  },
  {
    id: 'S37',
    name: '對人類反例 77393808（合成）',
    skill: 'M7、M10',
    expect: '回放 77393808 找不到檔案，照規格文字合成：我方兩團弓兵在中後、長槍居中、兩團劍士在兩翼；敵方兩團劍士從兩翼接近、兩團重騎兵從外側繞到我方背後，25 秒時四團同時撲向弓兵。70 秒後我方弓兵合計剩 40% 以上（沒被同時四團消滅）',
    bot: [
      { type: 'archer', x: -10, y: -3 },
      { type: 'archer', x: -10, y: 3 },
      { type: 'spear', x: -4, y: 0, formation: 'square' },
      { type: 'sword', x: -4, y: -8 },
      { type: 'sword', x: -4, y: 8 },
    ],
    foe: [
      { type: 'sword', x: 12, y: -12 },
      { type: 'sword', x: 12, y: 12 },
      { type: 'heavyCav', x: 14, y: -16, formation: 'wedge' },
      { type: 'heavyCav', x: 14, y: 16, formation: 'wedge' },
    ],
    ticks: 700,
    script: (c, t) => {
      const [w1, w2, c1, c2] = c.B;
      const [a1, a2] = c.A;
      if (t === 0) return [strike(c, w1, c.A[3]), strike(c, w2, c.A[4]), { type: 'move', id: c1.id, ...c.at(-24, -14) }, { type: 'move', id: c2.id, ...c.at(-24, 14) }];
      if (t === 200) return [{ type: 'move', id: c1.id, ...c.at(-24, -4) }, { type: 'move', id: c2.id, ...c.at(-24, 4) }];
      if (t === 250) {
        const out: unknown[] = [];
        const pick = (r: Regiment, want: Regiment): void => {
          const tgt = gone(want) ? nearest(r, c.A.slice(0, 2)) : want;
          if (!gone(r) && tgt !== null) out.push(r.def.cavalry ? chargeAt(r, tgt) : strike(c, r, tgt));
        };
        pick(w1, a1);
        pick(w2, a2);
        pick(c1, a1);
        pick(c2, a2);
        return out;
      }
      if (t > 250 && t % 30 === 0) {
        return c.B.filter((r) => !gone(r) && r.dash === null).flatMap((r) => {
          const tgt = nearest(r, c.A.slice(0, 2)) ?? nearest(r, c.A);
          return tgt !== null && r.target !== tgt.id ? [strike(c, r, tgt)] : [];
        });
      }
      return [];
    },
    judge: (c) => {
      const left = groupPct(c.A.slice(0, 2));
      return { pass: left >= 40, detail: `弓兵剩 ${left}%、我方剩 ${groupPct(c.A)}%、敵方剩 ${groupPct(c.B)}%` };
    },
  },
  {
    id: 'S38',
    name: '窄口前先探',
    skill: 'M1、M6',
    pending: true,
    mode: 'siege',
    abs: true,
    seats: [0],
    expect: '石關城攻方：甕城（西橋過去、正門外的轉角）裡藏著守方一團重騎兵與一團劍士（甕城南半部，從城外看不到），甕城北牆頂有一團弓兵。我方要往正門走就得經過甕城口。90 秒內：要有輕單位先進甕城（x 96～110、y 60～78）或看到藏兵，而且在任何主力（劍、槍、盾、弓）進甕城之前；主力不能吃到伏兵的衝鋒。伏兵：有我方軍團進到甕城或它 8 格內就衝',
    bot: [
      { type: 'light', x: 86, y: 62.5 },
      { type: 'sword', x: 82, y: 58 },
      { type: 'sword', x: 82, y: 67 },
      { type: 'spear', x: 78, y: 62.5, formation: 'square' },
    ],
    foe: [
      { type: 'heavyCav', x: 104, y: 74, formation: 'wedge', facing: 270 },
      { type: 'sword', x: 107, y: 73, facing: 270 },
      { type: 'archer', x: 104, y: 59, layer: 1, facing: 180 },
    ],
    ticks: 900,
    script: (c, t) => {
      const [cav, sw, ar] = c.B;
      if (t === 0) return [{ type: 'hold', id: cav.id }, { type: 'hold', id: sw.id }, { type: 'hold', id: ar.id }];
      if (c.mem.sprung !== undefined || gone(cav)) return [];
      const inside = (r: Regiment): boolean => {
        const [x, y] = pos(c, r);
        return x >= 96 && x <= 110 && y >= 60 && y <= 78;
      };
      const prey = c.A.find((r) => !gone(r) && r.layer === 0 && (inside(r) || tilesBetween(r, cav) <= 8));
      if (prey === undefined) return [];
      c.mem.sprung = t;
      return [chargeAt(cav, prey), strike(c, sw, prey)];
    },
    watch: (c) => {
      const inside = (r: Regiment): boolean => {
        const [x, y] = pos(c, r);
        return !gone(r) && r.layer === 0 && x >= 96 && x <= 110 && y >= 60 && y <= 78;
      };
      once(c, 'scout', c.m.visible[c.me][c.B[0].id] === 1 || c.A.some((r) => !mainBody(r) && inside(r)));
      once(c, 'main', c.A.some((r) => mainBody(r) && inside(r)));
    },
    judge: (c) => {
      const { scout, main } = c.mem;
      const hit = impacts(c, 1).filter((e) => e.kind === 'charge' && mainBody(c.m.regiments[e.target])).length;
      const ok = scout !== undefined && (main === undefined || scout < main) && hit === 0;
      return { pass: ok, detail: `${scout === undefined ? '沒探甕城' : `${sec(scout)}探到甕城`}、${main === undefined ? '主力沒進甕城' : `${sec(main)}主力進甕城`}、主力吃到衝鋒 ${hit} 次` };
    },
  },
  {
    id: 'S39',
    name: '追擊不進未確認窄口',
    skill: 'M5、M6',
    pending: true,
    mapId: 'grand-valley',
    abs: true,
    expect: '大河谷殲滅戰：敵方一團輕步兵在北橋西端，開打就往東過橋退進東岸樹林（中心約 152, 16）；樹林裡藏著敵方重騎兵與長槍。我方兩團劍士、一團輕騎在北橋西岸。90 秒內我方不吃到伏兵的衝鋒，而且總損失 ≤ 15%（追擊組停在橋口外）。伏兵：有我方軍團進到重騎兵 10 格內就衝',
    bot: [
      { type: 'sword', x: 114, y: 24 },
      { type: 'sword', x: 114, y: 31 },
      { type: 'lightCav', x: 109, y: 28, formation: 'wedge' },
    ],
    foe: [
      { type: 'light', x: 121, y: 27.5 },
      { type: 'heavyCav', x: 150, y: 15, formation: 'wedge' },
      { type: 'spear', x: 153, y: 19 },
    ],
    ticks: 900,
    script: (c, t) => {
      const [bait, cav, sp] = c.B;
      if (t === 0) return [{ type: 'move', id: bait.id, ...c.at(152, 12) }, { type: 'hold', id: cav.id }, { type: 'hold', id: sp.id }];
      if (c.mem.sprung !== undefined || gone(cav)) return [];
      const prey = nearest(cav, c.A);
      if (prey === null || tilesBetween(cav, prey) > 10) return [];
      c.mem.sprung = t;
      return [chargeAt(cav, prey), strike(c, sp, prey)];
    },
    judge: (c) => {
      const hit = impacts(c, 1).filter((e) => e.kind === 'charge').length;
      const lost = 100 - groupPct(c.A);
      return { pass: hit === 0 && lost <= 15, detail: `${c.mem.sprung === undefined ? '伏兵沒出動' : `${sec(c.mem.sprung)}伏兵出動`}、吃到衝鋒 ${hit} 次、我方損失 ${lost}%、誘餌剩 ${pct(c.B[0])}%` };
    },
  },
  {
    id: 'S40',
    name: '留兵防繞後',
    skill: 'M7',
    pending: true,
    expect: '我方兩團劍士在前、兩團弓兵居中、兩團長槍在後；敵方兩團劍士 10 秒後上來纏住我方劍士（引我方前推），敵方一團重騎兵一開始在北側視野外，15 秒起從北邊繞到我方背後、36 秒起追著我方弓兵衝（衝鋒就緒、弓兵在 14 格內就衝，不然繞到弓兵背後 8 格）。要有長槍留在弓兵後方架槍：重騎兵的衝鋒被槍林擋下，或撞擊合計殺不到 6 人，而且 60 秒後弓兵剩 60% 以上（重騎兵還沒衝就被打掉一半以上也算擋下）',
    bot: [
      { type: 'archer', x: -8, y: -3 },
      { type: 'archer', x: -8, y: 3 },
      { type: 'sword', x: -2, y: -5 },
      { type: 'sword', x: -2, y: 5 },
      { type: 'spear', x: -6, y: 0, formation: 'square' },
      { type: 'spear', x: -12, y: 0, formation: 'square' },
    ],
    foe: [
      { type: 'sword', x: 12, y: -4 },
      { type: 'sword', x: 12, y: 4 },
      { type: 'heavyCav', x: 4, y: -22, formation: 'wedge', facing: 180 },
    ],
    ticks: 600,
    script: (c, t) => {
      const [s1, s2, cav] = c.B;
      if (t === 0) return [{ type: 'hold', id: s1.id }, { type: 'hold', id: s2.id }, { type: 'hold', id: cav.id }];
      if (t === 100) return [strike(c, s1, c.A[2]), strike(c, s2, c.A[3])];
      if (gone(cav)) return [];
      if (t === 150) return [{ type: 'move', id: cav.id, ...c.at(-22, -16) }];
      if (t === 280) return [{ type: 'move', id: cav.id, ...c.at(-26, -2) }];
      // 36 秒起追著我方弓兵：衝鋒就緒、弓兵在 14 格內就衝，否則繞到弓兵背後 8 格
      if (t < 360 || t % 10 !== 0 || cav.dash !== null) return [];
      const tgt = nearest(cav, c.A.slice(0, 2));
      if (tgt === null) return [];
      if (cav.skillReadyAt <= c.m.tick && tilesBetween(cav, tgt) <= 14) return [chargeAt(cav, tgt)];
      return t % 30 === 0 ? [{ type: 'move', id: cav.id, ...c.near(tgt, -8, 0) }] : [];
    },
    judge: (c) => {
      const hits = impacts(c, 1).filter((e) => e.reg === c.B[2].id && e.kind === 'charge');
      const kills = hits.reduce((s, e) => s + e.kills, 0);
      const stopped = hits.some((e) => e.braced);
      const arch = groupPct(c.A.slice(0, 2));
      // 重騎兵沒衝成（還沒衝就被打掉一半以上）也算擋下；沒衝又沒被打 = 情境沒發生
      const cav = pct(c.B[2]);
      const happened = hits.length > 0 || cav <= 50;
      return { pass: happened && (stopped || kills < 6) && arch >= 60, detail: `敵重騎衝鋒 ${hits.length} 次、殺 ${kills} 人${stopped ? '、被槍林擋下' : ''}、敵重騎剩 ${cav}%、弓兵剩 ${arch}%` };
    },
  },
  {
    id: 'S41',
    name: '護衛衝車到門',
    skill: 'M9、M7',
    pending: true,
    mode: 'siege',
    abs: true,
    seats: [0],
    expect: '石關城攻方：我方四團（兩劍、盾、槍）在衝車起點（46, 61.5）旁；守方兩團劍士在正門內側，衝車走完四分之三軌道時開門出擊、打推車的團，打 25 秒或剩一半就退回關門；甕城北牆頂一團弓兵。200 秒內衝車至少撞門一下（要有團推車、護衛擋住出擊）',
    bot: [
      { type: 'sword', x: 48, y: 58 },
      { type: 'sword', x: 48, y: 65 },
      { type: 'shield', x: 42, y: 61.5 },
      { type: 'spear', x: 40, y: 67, formation: 'square' },
    ],
    foe: [
      { type: 'sword', x: 118, y: 66 },
      { type: 'sword', x: 118, y: 73 },
      { type: 'archer', x: 104, y: 59, layer: 1 },
    ],
    ticks: 2000,
    script: (c, t) => {
      const [s1, s2, ar] = c.B;
      const ram = c.m.ram;
      if (t === 0) return [{ type: 'hold', id: s1.id }, { type: 'hold', id: s2.id }, { type: 'hold', id: ar.id }];
      if (ram === null || t % 10 !== 0) return [];
      const sally = c.B.slice(0, 2).filter((r) => !gone(r));
      if (c.mem.sally === undefined) {
        if (ram.dist < (ram.len * 3) / 4) return [];
        c.mem.sally = t;
        return [{ type: 'gate', gate: 0, action: 'open' }];
      }
      if (c.mem.back === undefined) {
        if (t - c.mem.sally >= 250 || groupPct(c.B.slice(0, 2)) <= 50) {
          c.mem.back = t;
          return sally.map((r) => ({ type: 'move', id: r.id, ...c.at(118, 69.5) }));
        }
        if (t % 20 !== 0) return [];
        const crew = ram.crew >= 0 ? c.m.regiments[ram.crew] : null;
        return sally.flatMap((r) => {
          const tgt = crew !== null && !gone(crew) ? crew : nearest(r, c.A);
          return tgt !== null && r.target !== tgt.id ? [strike(c, r, tgt)] : [];
        });
      }
      if (c.mem.closed === undefined && sally.every((r) => pos(c, r)[0] >= 114.5)) {
        c.mem.closed = t;
        return [{ type: 'gate', gate: 0, action: 'close' }];
      }
      return [];
    },
    judge: (c) => {
      const hits = c.events.filter((e) => e.type === 'ramHit').length;
      const ram = c.m.ram;
      const prog = ram === null ? 0 : Math.round((ram.dist * 100) / ram.len);
      return { pass: hits >= 1, detail: `衝車走了 ${prog}%、撞門 ${hits} 下、${c.mem.sally === undefined ? '守方沒出擊' : `${sec(c.mem.sally)}守方出擊`}、我方剩 ${groupPct(c.A)}%` };
    },
  },
  {
    id: 'S42',
    name: '砲擊落點散開',
    skill: 'M10',
    pending: true,
    mode: 'siege',
    abs: true,
    seats: [1],
    expect: '石關城守方：我方兩團弓兵在西牆北段牆頂；攻方 5 秒時砲擊第一團弓兵所在處、65 秒時砲擊第二團（落點選牆頂最西一格，避開陰影），落地前 5 秒雙方都看得到落點。兩發都要落地，而且每發打到的人 ≤ 4（5 秒內離開半徑 3 格）',
    bot: [
      { type: 'archer', x: 111.5, y: 40, layer: 1 },
      { type: 'archer', x: 111.5, y: 51, layer: 1 },
    ],
    foe: [{ type: 'light', x: 70, y: 62 }],
    ticks: 750,
    script: (c, t) => {
      if (t === 0) return [{ type: 'hold', id: c.B[0].id }];
      const tgt = t === 50 ? c.A[0] : t === 650 ? c.A[1] : null;
      if (tgt === null || gone(tgt)) return [];
      // 牆頂的弓兵：落點在牆頂最西一格（再往西就不是牆，不在陰影裡）
      let x = tgt.x;
      while (c.m.bombardShadowed(x, tgt.y) && x > 0) x -= 500;
      return [{ type: 'bombard', x, y: tgt.y }];
    },
    judge: (c) => {
      const landed = c.events.filter((e): e is Extract<LegionEvent, { type: 'bombard' }> => e.type === 'bombard' && e.state === 'landed');
      return { pass: landed.length >= 2 && landed.every((e) => e.hit <= 4), detail: landed.length === 0 ? '砲擊沒落地（情境沒發生）' : `落地 ${landed.length} 發、打到 ${landed.map((e) => e.hit).join('／')} 人、弓兵剩 ${groupPct(c.A)}%` };
    },
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

/** 情境用到的座位（預設雙座位） */
export function scenarioSeats(sc: AiScenario): readonly number[] {
  return sc.seats ?? [0, 1];
}

/**
 * 攻城圖的集結位置：布陣區（含遮罩）裡依層找可布陣的格，彼此相隔 12 格以上。
 * 只用來通過布陣檢查，開打前再搬到情境指定的位置。
 */
function stagingSpots(map: LegionMap, p: number, units: readonly Unit[]): object[] {
  const z = map.deploy[p];
  const mask = map.deployMask?.[p] ?? null;
  const used: [number, number, number][] = [];
  return units.map((u) => {
    // 攻方布陣區沒有牆：牆頂的團先在地面集結，搬過去時再換層
    const layer = p === map.defender ? (u.layer ?? 0) : 0;
    for (let ty = z.y0 + 1; ty < z.y1 - 1; ty++) {
      for (let tx = z.x0 + 1; tx < z.x1 - 1; tx++) {
        const k = ty * map.width + tx;
        if (mask !== null && mask[k] !== 1) continue;
        const t = map.terrain[k];
        if (layer === WALL_LAYER ? t !== T.Wall : GROUND_FAST[t] !== 1 || t === T.Shallow) continue;
        if (used.some(([x, y, l]) => l === layer && Math.abs(x - tx) < 12 && Math.abs(y - ty) < 12)) continue;
        used.push([tx, ty, layer]);
        return { type: u.type, x: tx * TILE + 500, y: ty * TILE + 500, layer, ...(u.formation ? { formation: u.formation } : {}), ...(u.stance ? { stance: u.stance } : {}), ...(u.width ? { width: u.width } : {}) };
      }
    }
    throw new Error(`${map.id}：${p} 號找不到第 ${used.length} 團的集結位置`);
  });
}

/** 搬到新位置後重排隊形、士兵直接站到隊形位置（同布陣） */
function relayout(m: LegionMatch, r: Regiment): void {
  (m as unknown as { layout(reg: Regiment, force: boolean): void }).layout(r, true);
  for (const sid of r.slots) {
    const s = m.soldiers[sid];
    s.x = s.sx;
    s.y = s.sy;
  }
}

export interface AiScenarioOptions {
  /** 種子（預設 11） */
  readonly seed?: number;
  /** 受測 AI 的座位（預設情境的第一個座位） */
  readonly seat?: number;
  readonly trace?: (c: Ctx) => void;
}

/** 執行一個情境：受測 AI（用自己的預設旋鈕）坐 seat 號，另一方照腳本 */
export function runAiScenario(sc: AiScenario, bot: CompiledBot, label: string, opts: AiScenarioOptions = {}): AiScenarioResult {
  const mode = sc.mode ?? 'annihilation';
  const seed = opts.seed ?? 11;
  const me = opts.seat ?? scenarioSeats(sc)[0];
  if (!scenarioSeats(sc).includes(me)) throw new Error(`${sc.id}：受測 AI 不能坐 ${me} 號`);
  const them = 1 - me;
  const siege = mode === 'siege';
  const map = MAPS[sc.mapId ?? defaultMapId(mode)]();
  // 旋轉 180°：受測 AI 坐 1 號的野戰情境（攻城圖照角色固定座位）
  const rot = me === 1 && !siege;
  if (rot && !map.symmetric) throw new Error(`${sc.id}：${map.id} 不是旋轉對稱的地圖，不能換座位`);
  const s = rot ? -1 : 1;
  const deployments: object[][] = [[], []];
  if (siege) {
    deployments[me] = stagingSpots(map, me, sc.bot);
    deployments[them] = stagingSpots(map, them, sc.foe);
  } else {
        // 指定地圖的情境：在布陣區正中排一列；預設地圖照舊
    const zx = (p: number): number => (sc.mapId ? ((map.deploy[p].x0 + map.deploy[p].x1) * TILE) / 2 : p === 0 ? 8000 : mode === 'capture' ? 232000 : 152000);
    const dep = (u: Unit, i: number, p: number): object => ({ type: u.type, x: zx(p), y: 6000 + i * 12000, ...(u.formation ? { formation: u.formation } : {}), ...(u.stance ? { stance: u.stance } : {}), ...(u.width ? { width: u.width } : {}) });
    deployments[me] = sc.bot.map((u, i) => dep(u, i, me));
    deployments[them] = sc.foe.map((u, i) => dep(u, i, them));
  }
  const m = new LegionMatch({ seed, mode, ...(sc.mapId ? { mapId: sc.mapId } : {}), deployments });
  const A = m.regiments.filter((r) => r.owner === me);
  const B = m.regiments.filter((r) => r.owner === them);
  if (A.length !== sc.bot.length || B.length !== sc.foe.length) {
    const why = m.events.filter((e) => e.type === 'deployRejected').map((e) => (e.type === 'deployRejected' ? `${e.player} 號第 ${e.index} 團：${e.reason}` : ''));
    throw new Error(`${sc.id}：布陣失敗 ${why.join('；')}`);
  }
  let cx = 0;
  let cy = 0;
  if (!sc.abs) {
    // 坐 1 號：用 0 號的中心再旋轉 180°（地圖旋轉對稱，兩個座位的地形完全鏡像）
    const [fx, fy] = openArea(m, [...sc.bot, ...sc.foe]);
    cx = rot ? m.map.width * TILE - fx * TILE : fx * TILE;
    cy = rot ? m.map.height * TILE - fy * TILE : fy * TILE;
  }
  const W = m.map.width * TILE;
  const H = m.map.height * TILE;
  const at = (x: number, y: number): { x: number; y: number } => {
    if (sc.abs) return rot ? { x: Math.round(W - x * TILE), y: Math.round(H - y * TILE) } : { x: Math.round(x * TILE), y: Math.round(y * TILE) };
    return { x: Math.round(cx + s * x * TILE), y: Math.round(cy + s * y * TILE) };
  };
  const local = (x: number, y: number): [number, number] => {
    if (sc.abs) return rot ? [(W - x) / TILE, (H - y) / TILE] : [x / TILE, y / TILE];
    return [(s * (x - cx)) / TILE, (s * (y - cy)) / TILE];
  };
  const face = (deg: number): number => (rot ? (deg + 180) % 360 : deg);
  const flag = (i: number): number => {
    if (!rot) return i;
    const f = m.map.flags[i];
    const j = m.map.flags.findIndex((g) => Math.abs(g.x - (W - f.x)) <= TILE && Math.abs(g.y - (H - f.y)) <= TILE);
    if (j < 0) throw new Error(`${sc.id}：第 ${i} 面旗沒有對稱的旗`);
    return j;
  };
  const events: LegionEvent[] = [];
  const ctx: Ctx = {
    m, A, B, me, them, seed, cx, cy, events, arrows: [], contested: m.flags.map(() => 0), mem: {},
    at, local, face, flag,
    near: (p, dx, dy) => {
      const [x, y] = local(p.x, p.y);
      return at(x + dx, y + dy);
    },
  };
  const legacy = Number(sc.id.slice(1)) <= 18;
  const place = (r: Regiment, u: Unit, side: number): void => {
    const p = at(u.x, u.y);
    const layer = u.layer ?? 0;
    // S1～S18 照舊不檢查（S11 有一團擺在河上，由引擎吸附到岸邊）
    if (!legacy && !walkableAt(terrainAt(m.map, p.x, p.y), layer)) throw new Error(`${sc.id}：${side === 0 ? '受測方' : '腳本方'}的 ${u.type} (${u.x}, ${u.y}) 層 ${layer} 不可通行`);
    // 預設朝向：情境裡受測 AI 朝東、對手朝西；攻城圖不旋轉，攻方朝東、守方朝西
    const deg = u.facing ?? ((siege ? r.owner : side) === 0 ? 0 : 180);
    if (siege || layer !== r.layer) {
      r.layer = layer;
      for (const sid of r.slots) m.soldiers[sid].layer = layer;
    }
    teleport(m, r, p.x, p.y, face(deg));
    if (siege) relayout(m, r);
  };
  sc.bot.forEach((u, i) => place(A[i], u, 0));
  sc.foe.forEach((u, i) => place(B[i], u, 1));
  for (const r of m.regiments) {
    r.tx = r.x;
    r.ty = r.y;
  }
  m.eventTap = (e) => events.push(e);
  sc.setup?.(ctx);
  // 視野依擺好的位置重算，AI 第一次決策就看得到敵人
  m.refreshVision();
  const ctrl = new LegionBatchController(bot, label, m.map, seed, me);
  const data = legionInitData(m.map, mode, me, resolveKnobs(ctrl.declaration, undefined, label), m.timeLimitTicks);
  ctrl.init(data);
  ctrl.deploy(data);
  for (let t = 0; t < sc.ticks && !m.over; t++) {
    if (m.isDecisionTick()) {
      const out = ctrl.decide(m.observe(me));
      if (out.exception !== null) throw new Error(`${sc.id}：${label} 例外 ${out.exception}`);
      m.applyCommands(me, out.value);
      m.observe(them);
      if (sc.script) m.applyCommands(them, sc.script(ctx, t));
    }
    m.step();
    // 這個 tick 新射出的箭（受測 AI）：目標軍團與射手高度
    for (const pj of m.projectiles) {
      if (pj.t0 !== m.tick - 1 || pj.owner !== me) continue;
      let target = pj.target >= 0 ? m.soldiers[pj.target].reg : -1;
      if (pj.target === -2) {
        let best = Infinity;
        for (const r of m.regiments) {
          if (r.owner === me || r.destroyed) continue;
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
    sc.watch?.(ctx, t);
    opts.trace?.(ctx);
  }
  const j = sc.judge(ctx);
  return { id: sc.id, name: sc.name, expect: sc.expect, pass: j.pass, detail: j.detail, seed, seat: me };
}

/** 跑一組情境（各一個種子、預設座位） */
export function runAiScenarios(bot: CompiledBot, label: string, filter?: (id: string) => boolean, trace?: (c: Ctx) => void): AiScenarioResult[] {
  return AI_SCENARIOS.filter((s) => !filter || filter(s.id)).map((s) => runAiScenario(s, bot, label, { trace }));
}
