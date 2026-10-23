// 驗收測試（規格書 v0.2 第十二節）：一團對一團、平地、不經過 AI，用指令直接操作。
// scripts/legion-acceptance.ts 印出結果表；test/legion-acceptance.test.ts 檢查全部通過。
import { RULES, T, TILE, UNITS, type FormationKind, type ShieldStance, type UnitKind } from './config.ts';
import { heightAt, terrainAt } from './map.ts';
import { LegionMatch, type Regiment } from './sim.ts';

interface Side {
  readonly type: UnitKind;
  readonly formation?: FormationKind;
  readonly stance?: ShieldStance;
  /** 相對 0 號軍團的位置（格）：x 正值往東 */
  readonly dx?: number;
  readonly dy?: number;
  /** 'face' = 面向對方（正面）、'away' = 背對（背擊）、'side' = 側面朝向對方 */
  readonly facing?: 'face' | 'away' | 'side';
}

export interface ScenarioResult {
  readonly id: string;
  readonly name: string;
  readonly pass: boolean;
  readonly expect: string;
  readonly detail: string;
}

interface Run {
  readonly m: LegionMatch;
  readonly A: Regiment[];
  readonly B: Regiment[];
}

const W = 160000;
const H = 100000;

/** 找一塊平坦（同高度、全是平地）的區域中心（格） */
export function flatArea(m: LegionMatch, w: number, h: number): [number, number] {
  for (let cy = 50; cy < m.map.height - h; cy++) {
    for (let cx = 20; cx < 70; cx++) {
      const h0 = heightAt(m.map, cx * TILE, cy * TILE);
      let ok = true;
      for (let y = cy - h; y <= cy + h && ok; y++) {
        for (let x = cx - w; x <= cx + w && ok; x++) {
          if (terrainAt(m.map, x * TILE + 500, y * TILE + 500) !== T.Plain || heightAt(m.map, x * TILE + 500, y * TILE + 500) !== h0) ok = false;
        }
      }
      if (ok) return [cx, cy];
    }
  }
  throw new Error('找不到平坦區域');
}

export function teleport(m: LegionMatch, r: Regiment, x: number, y: number, facing: number): void {
  const dx = x - r.x;
  const dy = y - r.y;
  r.x = x;
  r.y = y;
  r.facing = facing;
  r.px = x;
  r.py = y;
  r.pf = facing;
  for (const sid of r.slots) {
    m.soldiers[sid].x += dx;
    m.soldiers[sid].y += dy;
  }
}

/**
 * 擺好陣：a 側（0 號）在西、面向東；b 側（1 號）在東 dist 格處。
 * 每側第一團是主角，其餘依 dx、dy 偏移。
 */
function setup(a: readonly Side[], b: readonly Side[], dist: number): Run {
  const dep = (s: Side, i: number, p: number): object => ({ type: s.type, x: p === 0 ? 10000 : 150000, y: 10000 + i * 15000 + (p === 0 ? 0 : 5000), ...(s.formation ? { formation: s.formation } : {}), ...(s.stance ? { stance: s.stance } : {}) });
  // 兩邊各補一團輕步兵放在遠處，避免一團潰散就直接判負
  const keep = (p: number): object => ({ type: 'light', x: p === 0 ? 10000 : 150000, y: p === 0 ? 92000 : 8000 });
  const m = new LegionMatch({ seed: 7, mode: 'annihilation', deployments: [[...a.map((s, i) => dep(s, i, 0)), keep(0)], [...b.map((s, i) => dep(s, i, 1)), keep(1)]] });
  const A = m.regiments.filter((r) => r.owner === 0).slice(0, a.length);
  const B = m.regiments.filter((r) => r.owner === 1).slice(0, b.length);
  const [cx, cy] = flatArea(m, 26, 7);
  const ax = (cx - Math.floor(dist / 2)) * TILE;
  const bx = ax + dist * TILE;
  const y = cy * TILE;
  a.forEach((s, i) => teleport(m, A[i], ax + (s.dx ?? 0) * TILE, y + (s.dy ?? 0) * TILE, s.facing === 'away' ? 180 : s.facing === 'side' ? 90 : 0));
  b.forEach((s, i) => teleport(m, B[i], bx + (s.dx ?? 0) * TILE, y + (s.dy ?? 0) * TILE, s.facing === 'away' ? 0 : s.facing === 'side' ? 90 : 180));
  // 讓隊形就位
  for (const r of [...A, ...B]) {
    r.order = 'hold';
  }
  m.step();
  for (const r of [...A, ...B]) for (const sid of r.slots) {
    const s = m.soldiers[sid];
    s.x = s.sx;
    s.y = s.sy;
  }
  return { m, A, B };
}

function run(r: Run, ticks: number, each?: (tick: number) => void, stop?: () => boolean): void {
  for (let i = 0; i < ticks && !r.m.over; i++) {
    each?.(r.m.tick);
    r.m.step();
    if (stop?.()) break;
  }
}

const loss = (r: Regiment): number => 100 - Math.round((r.slots.length * 100) / r.men0);
/** 血量損失（％）：箭的傷害分散在很多人身上，人數不一定少 */
const hpLoss = (m: LegionMatch, r: Regiment): number => 100 - Math.round((r.slots.reduce((s, sid) => s + m.soldiers[sid].hp, 0) * 100) / (r.men0 * r.def.hp));
const lostPct = (r: Regiment): string => `${loss(r)}%`;
/** 沒有潰散之後，「崩潰」就是整團被殲滅 */
const broke = (r: Regiment): boolean => r.routed || r.destroyed;

function brace(r: Run, reg: Regiment, facing: number): void {
  r.m.applyCommands(reg.owner, [{ type: 'brace', id: reg.id, facing }]);
  run(r, RULES.brace.setTicks + 25);
}

function cmd(r: Run, reg: Regiment, c: Record<string, unknown>): void {
  r.m.applyCommands(reg.owner, [{ id: reg.id, ...c }]);
}

/** 騎兵已經穿過對方隊形（有騎兵跑到對方中心後方超過半個縱深；圓陣則是衝進圓圈內側） */
function penetrated(r: Run, cav: Regiment, t: Regiment): boolean {
  if (t.formation === 'circle') {
    const inner = t.rad - 2 * t.def.spacingY;
    return cav.slots.some((sid) => {
      const s = r.m.soldiers[sid];
      return (s.x - t.x) * (s.x - t.x) + (s.y - t.y) * (s.y - t.y) < inner * inner;
    });
  }
  const lim = t.x + t.halfD + 500;
  return cav.slots.some((sid) => r.m.soldiers[sid].x > lim);
}

/** 衝鋒：朝東衝，直到衝刺結束再等 settle 個 tick */
function charge(r: Run, cav: Regiment, settle: number): { contact: number } {
  const t0 = r.m.tick;
  cmd(r, cav, { type: 'charge', facing: 0 });
  let contact = -1;
  run(r, 200, undefined, () => {
    if (contact < 0 && cav.dash?.contacted) contact = r.m.tick - t0;
    return cav.dash === null;
  });
  run(r, settle);
  return { contact };
}

type Scenario = { id: string; name: string; expect: string; run: () => { pass: boolean; detail: string } };

export const SCENARIOS: readonly Scenario[] = [
  {
    id: '1',
    name: '輕騎兵正面衝方陣槍林',
    expect: '輕騎幾乎全滅（損失 ≥ 80%）；長槍損失 < 10%',
    run: () => {
      const r = setup([{ type: 'lightCav' }], [{ type: 'spear', formation: 'square' }], 16);
      brace(r, r.B[0], 180);
      charge(r, r.A[0], 0);
      run(r, 300, undefined, () => broke(r.A[0]));
      return { pass: loss(r.A[0]) >= 80 && loss(r.B[0]) < 10, detail: `輕騎損失 ${lostPct(r.A[0])}、長槍損失 ${lostPct(r.B[0])}` };
    },
  },
  {
    id: '2',
    name: '重騎兵（楔形陣）正面衝方陣槍林',
    expect: '重騎損失 > 60%、衝不過去；長槍損失 < 20%',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'spear', formation: 'square' }], 16);
      brace(r, r.B[0], 180);
      charge(r, r.A[0], 0);
      const through = penetrated(r, r.A[0], r.B[0]);
      run(r, 300, undefined, () => broke(r.A[0]));
      return { pass: loss(r.A[0]) > 60 && !through && loss(r.B[0]) < 20, detail: `重騎損失 ${lostPct(r.A[0])}、${through ? '衝過去了' : '沒衝過去'}、長槍損失 ${lostPct(r.B[0])}` };
    },
  },
  {
    id: '3a',
    name: '輕騎兵（楔形陣）正面衝兩排槍林（橫陣）',
    expect: '衝得過去',
    run: () => {
      const r = setup([{ type: 'lightCav', formation: 'wedge' }], [{ type: 'spear', formation: 'line' }], 16);
      brace(r, r.B[0], 180);
      let through = false;
      cmd(r, r.A[0], { type: 'charge', facing: 0 });
      run(r, 200, () => (through ||= penetrated(r, r.A[0], r.B[0])), () => r.A[0].dash === null);
      return { pass: through, detail: `${through ? '衝過去了' : '沒衝過去'}、輕騎損失 ${lostPct(r.A[0])}、長槍損失 ${lostPct(r.B[0])}` };
    },
  },
  {
    id: '3b',
    name: '重騎兵（楔形陣）正面衝兩排槍林（橫陣）',
    expect: '衝得過去',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'spear', formation: 'line' }], 16);
      brace(r, r.B[0], 180);
      let through = false;
      cmd(r, r.A[0], { type: 'charge', facing: 0 });
      run(r, 200, () => (through ||= penetrated(r, r.A[0], r.B[0])), () => r.A[0].dash === null);
      return { pass: through, detail: `${through ? '衝過去了' : '沒衝過去'}、重騎損失 ${lostPct(r.A[0])}、長槍損失 ${lostPct(r.B[0])}` };
    },
  },
  {
    id: '4',
    name: '重騎兵正面衝圓陣槍林',
    expect: '衝得過去，但損失比衝背對的劍士大',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'spear', formation: 'square' }], 16);
      cmd(r, r.B[0], { type: 'formation', formation: 'circle' });
      run(r, RULES.formationSwitchTicks + 5);
      brace(r, r.B[0], 180);
      let through = false;
      cmd(r, r.A[0], { type: 'charge', facing: 0 });
      run(r, 200, () => (through ||= penetrated(r, r.A[0], r.B[0])), () => r.A[0].dash === null);
      const l1 = loss(r.A[0]);
      const r2 = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'sword', facing: 'away' }], 16);
      charge(r2, r2.A[0], 0);
      const l2 = loss(r2.A[0]);
      return { pass: through && l1 > l2, detail: `${through ? '衝過去了' : '沒衝過去'}、重騎損失 ${l1}%（衝背對劍士 ${l2}%）` };
    },
  },
  {
    id: '5',
    name: '劍士突擊正面衝方陣槍林',
    expect: '劍士傷亡慘重、輸',
    run: () => {
      const r = setup([{ type: 'sword' }], [{ type: 'spear', formation: 'square' }], 10);
      brace(r, r.B[0], 180);
      cmd(r, r.A[0], { type: 'assault', facing: 0 });
      run(r, 600, undefined, () => broke(r.A[0]) || broke(r.B[0]));
      return { pass: broke(r.A[0]) && !broke(r.B[0]), detail: `劍士損失 ${lostPct(r.A[0])}${broke(r.A[0]) ? '（殲滅）' : ''}、長槍損失 ${lostPct(r.B[0])}` };
    },
  },
  {
    id: '6',
    name: '劍士不突擊、正面打方陣槍林',
    expect: '長槍小勝或打平',
    run: () => {
      const r = setup([{ type: 'sword' }], [{ type: 'spear', formation: 'square' }], 9);
      brace(r, r.B[0], 180);
      cmd(r, r.A[0], { type: 'attackMove', x: r.B[0].x, y: r.B[0].y });
      run(r, 900, undefined, () => broke(r.A[0]) || broke(r.B[0]));
      const a = 100 - loss(r.A[0]);
      const b = 100 - loss(r.B[0]);
      return { pass: !broke(r.B[0]) && b >= a - 15, detail: `劍士剩 ${a}%${broke(r.A[0]) ? '（殲滅）' : ''}、長槍剩 ${b}%${broke(r.B[0]) ? '（殲滅）' : ''}` };
    },
  },
  {
    id: '7a',
    name: '劍士正面打沒架陣的長槍（方陣）',
    expect: '劍士贏',
    run: () => {
      const r = setup([{ type: 'sword' }], [{ type: 'spear', formation: 'square' }], 9);
      cmd(r, r.A[0], { type: 'attackMove', x: r.B[0].x, y: r.B[0].y });
      cmd(r, r.B[0], { type: 'attackMove', x: r.A[0].x, y: r.A[0].y });
      run(r, 900, undefined, () => broke(r.A[0]) || broke(r.B[0]));
      return { pass: broke(r.B[0]) && !broke(r.A[0]), detail: `劍士剩 ${100 - loss(r.A[0])}%、長槍剩 ${100 - loss(r.B[0])}%` };
    },
  },
  {
    id: '7b',
    name: '劍士正面打盾兵（持盾）',
    expect: '劍士贏',
    run: () => {
      const r = setup([{ type: 'sword' }], [{ type: 'shield' }], 9);
      cmd(r, r.A[0], { type: 'attackMove', x: r.B[0].x, y: r.B[0].y });
      cmd(r, r.B[0], { type: 'attackMove', x: r.A[0].x, y: r.A[0].y });
      run(r, 900, undefined, () => broke(r.A[0]) || broke(r.B[0]));
      return { pass: broke(r.B[0]) && !broke(r.A[0]), detail: `劍士剩 ${100 - loss(r.A[0])}%、盾兵剩 ${100 - loss(r.B[0])}%` };
    },
  },
  {
    id: '8',
    name: '劍士突擊打橫陣盾兵（持盾）',
    expect: '劍士大勝（剩 60% 以上）',
    run: () => {
      const r = setup([{ type: 'sword' }], [{ type: 'shield' }], 10);
      cmd(r, r.A[0], { type: 'assault', facing: 0 });
      run(r, 900, undefined, () => broke(r.A[0]) || broke(r.B[0]));
      return { pass: broke(r.B[0]) && 100 - loss(r.A[0]) >= 60, detail: `劍士剩 ${100 - loss(r.A[0])}%、盾兵剩 ${100 - loss(r.B[0])}%` };
    },
  },
  {
    id: '9',
    name: '重騎兵衝劍士背後',
    expect: '劍士損失 ≥ 50% 並被殲滅；重騎損失 < 15%',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'sword', facing: 'away' }], 16);
      charge(r, r.A[0], 20);
      return { pass: loss(r.B[0]) >= 50 && broke(r.B[0]) && loss(r.A[0]) < 15, detail: `劍士損失 ${lostPct(r.B[0])}${broke(r.B[0]) ? '（殲滅）' : ''}、重騎損失 ${lostPct(r.A[0])}` };
    },
  },
  {
    id: '10',
    name: '重騎兵衝盾兵背後',
    expect: '盾兵扛不住（損失 ≥ 50%）',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'shield', facing: 'away' }], 16);
      charge(r, r.A[0], 20);
      return { pass: loss(r.B[0]) >= 50, detail: `盾兵損失 ${lostPct(r.B[0])}、重騎損失 ${lostPct(r.A[0])}` };
    },
  },
  {
    id: '11',
    name: '重騎兵衝盾牆正面，後面是弓兵',
    expect: '盾兵多半活著（損失 < 30%）但被擊倒；弓兵損失 ≥ 50%',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'shield' }, { type: 'archer', dx: 4 }], 16);
      cmd(r, r.B[0], { type: 'shield', mode: 'wall' });
      run(r, RULES.shield.wallSetTicks + 5);
      let downed = 0;
      cmd(r, r.A[0], { type: 'charge', facing: 0 });
      run(r, 200, () => (downed = Math.max(downed, r.B[0].slots.filter((sid) => r.m.soldiers[sid].downUntil > r.m.tick).length)), () => r.A[0].dash === null);
      return { pass: loss(r.B[0]) < 30 && downed > 0 && loss(r.B[1]) >= 50, detail: `盾兵損失 ${lostPct(r.B[0])}、最多同時倒地 ${downed} 人、弓兵損失 ${lostPct(r.B[1])}` };
    },
  },
  {
    id: '12',
    name: '輕騎兵衝弓兵',
    expect: '弓兵幾乎全滅（損失 ≥ 80%）',
    run: () => {
      const r = setup([{ type: 'lightCav' }], [{ type: 'archer' }], 16);
      charge(r, r.A[0], 0);
      cmd(r, r.A[0], { type: 'attackMove', x: r.B[0].x, y: r.B[0].y });
      run(r, 300, undefined, () => broke(r.B[0]));
      return { pass: loss(r.B[0]) >= 80, detail: `弓兵損失 ${lostPct(r.B[0])}、輕騎損失 ${lostPct(r.A[0])}` };
    },
  },
  {
    id: '13',
    name: '弓兵射行軍中的劍士；有舉盾掩護時',
    expect: '劍士接觸前血量損失明顯（≥ 15%）；有舉盾掩護時損失減半以上',
    run: () => {
      const until = (r: Run): boolean => r.m.tick - r.A[0].lastMelee <= 1 || r.A[0].slots.some((sid) => Math.abs(r.m.soldiers[sid].x - r.B[0].x) < 2500);
      const r = setup([{ type: 'sword' }], [{ type: 'archer' }], 13);
      cmd(r, r.A[0], { type: 'move', x: r.B[0].x, y: r.B[0].y });
      run(r, 600, undefined, () => until(r));
      const plain = hpLoss(r.m, r.A[0]);
      const r2 = setup([{ type: 'sword' }, { type: 'shield', stance: 'raise', dx: 2 }], [{ type: 'archer' }], 13);
      cmd(r2, r2.A[1], { type: 'move', x: r2.B[0].x, y: r2.B[0].y });
      cmd(r2, r2.A[0], { type: 'follow', target: r2.A[1].id, forward: -2500 });
      run(r2, 1200, undefined, () => until(r2));
      const covered = hpLoss(r2.m, r2.A[0]);
      return { pass: plain >= 15 && covered * 2 <= plain, detail: `沒掩護血量損失 ${plain}%、舉盾掩護血量損失 ${covered}%` };
    },
  },
  {
    id: '14',
    name: '輕步兵切入弓兵（穿過箭雨）',
    expect: '切入時血量損失比走過去少一半以上；弓兵輸',
    run: () => {
      const until = (r: Run): boolean => r.A[0].slots.some((sid) => Math.abs(r.m.soldiers[sid].x - r.B[0].x) < 2500);
      const r = setup([{ type: 'light' }], [{ type: 'archer' }], 12);
      cmd(r, r.A[0], { type: 'move', x: r.B[0].x, y: r.B[0].y });
      run(r, 600, undefined, () => until(r));
      const walk = hpLoss(r.m, r.A[0]);
      const r2 = setup([{ type: 'light' }], [{ type: 'archer' }], 12);
      cmd(r2, r2.A[0], { type: 'infiltrate', facing: 0 });
      run(r2, 600, undefined, () => until(r2));
      const dash = hpLoss(r2.m, r2.A[0]);
      cmd(r2, r2.A[0], { type: 'attackMove', x: r2.B[0].x, y: r2.B[0].y });
      run(r2, 900, undefined, () => broke(r2.A[0]) || broke(r2.B[0]));
      return { pass: dash * 2 <= Math.max(1, walk) && broke(r2.B[0]), detail: `走過去血量損失 ${walk}%、切入血量損失 ${dash}%；之後弓兵${broke(r2.B[0]) ? '被殲滅' : '沒有被殲滅'}（輕步兵剩 ${100 - loss(r2.A[0])}%）` };
    },
  },
  {
    id: '15',
    name: '同點數：2 團輕步兵 vs 1 團劍士',
    expect: '劍士贏',
    run: () => {
      const r = setup([{ type: 'light' }, { type: 'light', dy: 6 }], [{ type: 'sword' }], 9);
      for (const a of r.A) cmd(r, a, { type: 'attackMove', x: r.B[0].x, y: r.B[0].y });
      cmd(r, r.B[0], { type: 'attackMove', x: r.A[0].x, y: r.A[0].y });
      run(r, 1200, undefined, () => broke(r.B[0]) || r.A.every(broke));
      return { pass: !broke(r.B[0]) && r.A.every(broke), detail: `劍士剩 ${100 - loss(r.B[0])}%、輕步兵剩 ${r.A.map((a) => `${100 - loss(a)}%`).join('、')}` };
    },
  },
  {
    id: '16a',
    name: '兩團重騎兵衝刺對撞',
    expect: '雙方都停下（誰都沒穿過去）',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'heavyCav', formation: 'wedge' }], 26);
      cmd(r, r.A[0], { type: 'charge', facing: 0 });
      cmd(r, r.B[0], { type: 'charge', facing: 180 });
      let throughA = false;
      let throughB = false;
      run(
        r,
        200,
        () => {
          throughA ||= r.A[0].slots.some((sid) => r.m.soldiers[sid].x > r.B[0].x + 3000);
          throughB ||= r.B[0].slots.some((sid) => r.m.soldiers[sid].x < r.A[0].x - 3000);
        },
        () => r.A[0].dash === null && r.B[0].dash === null,
      );
      return { pass: !throughA && !throughB, detail: `${throughA ? '藍方穿過去了' : '藍方停下'}、${throughB ? '紅方穿過去了' : '紅方停下'}` };
    },
  },
  {
    id: '16b',
    name: '重騎兵撞輕騎兵（對衝）',
    expect: '輕騎被撞翻（倒地或停下），重騎繼續',
    run: () => {
      const r = setup([{ type: 'heavyCav', formation: 'wedge' }], [{ type: 'lightCav' }], 30);
      cmd(r, r.A[0], { type: 'charge', facing: 0 });
      cmd(r, r.B[0], { type: 'charge', facing: 180 });
      let lightDown = 0;
      let heavyThrough = false;
      run(
        r,
        200,
        () => {
          lightDown = Math.max(lightDown, r.B[0].slots.filter((sid) => r.m.soldiers[sid].downUntil > r.m.tick).length);
          heavyThrough ||= r.A[0].slots.some((sid) => r.m.soldiers[sid].x > r.B[0].x + 2000);
        },
        () => r.A[0].dash === null && r.B[0].dash === null,
      );
      return { pass: lightDown + loss(r.B[0]) > 0 && heavyThrough, detail: `輕騎最多同時倒地 ${lightDown} 騎、損失 ${lostPct(r.B[0])}；重騎${heavyThrough ? '穿過去了' : '被擋下'}（損失 ${lostPct(r.A[0])}）` };
    },
  },
];

export function runAcceptance(filter?: (id: string) => boolean): ScenarioResult[] {
  return SCENARIOS.filter((s) => filter === undefined || filter(s.id)).map((s) => {
    const r = s.run();
    return { id: s.id, name: s.name, expect: s.expect, pass: r.pass, detail: r.detail };
  });
}

/** 一團對一團的正面對決矩陣（參考用） */
export function duelMatrix(kinds: readonly UnitKind[]): string[][] {
  return kinds.map((a) =>
    kinds.map((b) => {
      if (a === b) return '—';
      const r = setup([{ type: a }], [{ type: b }], 9);
      cmd(r, r.A[0], { type: 'attackMove', x: r.B[0].x, y: r.B[0].y });
      cmd(r, r.B[0], { type: 'attackMove', x: r.A[0].x, y: r.A[0].y });
      run(r, 1200, undefined, () => broke(r.A[0]) || broke(r.B[0]));
      const win = broke(r.A[0]) ? (broke(r.B[0]) ? '同' : UNITS[b].name.slice(0, 2)) : broke(r.B[0]) ? UNITS[a].name.slice(0, 2) : '平';
      return `${win} ${100 - loss(r.A[0])}/${100 - loss(r.B[0])}`;
    }),
  );
}

export { W, H };
