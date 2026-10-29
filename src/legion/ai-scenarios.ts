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
