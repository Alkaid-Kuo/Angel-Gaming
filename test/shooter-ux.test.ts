// 介面 UX 2.0：鏡頭狀態機、商店數值換算（和引擎的公式對照）、跳回合（確定性）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileBot } from '../src/sandbox/compile.ts';
import type { GrenadeInfo, RoundInfo, ShooterObservation, WeaponId, WeaponInfo } from '../src/shooter/api.ts';
import { GRENADES, TPS, WEAPONS, WEAPON_IDS } from '../src/shooter/config.ts';
import { LEAGUE_FORMAT_ID, gatewayDriverOptions } from '../src/shooter/gateway.ts';
import { DEFAULT_MAP_ID, MAPS } from '../src/shooter/map.ts';
import { BALANCED_ROLES } from '../src/shooter/players.ts';
import { ShooterDriver } from '../src/shooter/runner.ts';
import { armorSplit, damageAt, shooterInitData } from '../src/shooter/sim.ts';
import { BOUND_CELLS, MAX_PPC, SpectateCamera, approach, clampCenter, followTau, overviewCam, pickPlayer, type CamEnv } from '../src/web/shooter/camera.ts';
import { trialHabit, trialRunOptions } from '../src/web/shooter/lineup.ts';
import type { ShooterSetup } from '../src/web/shooter/protocol.ts';
import { seekDriver } from '../src/web/shooter/seek.ts';
import { recentShots } from '../src/web/shooter/shots.ts';
import { accuracyFrac, bodyDamage, buyTicksLeft, cellsPerSecond, compareRow, compareTarget, grenadeRows, reloadSeconds, rpmOf, shopEntries, shopState, speedPercent, stateNote, weaponRows, type ShopData, type ShopEntry, type StatRow } from '../src/web/shooter/shop.ts';

const UNIT = 1000;
const ENV: CamEnv = { w: 1920, h: 1080, padX: 380, padY: 128, mapW: 120, mapH: 120 };
const FRAME = 1000 / 60;

describe('鏡頭狀態機', () => {
  const target = { x: 50000, y: 40000 };
  const fresh = (): SpectateCamera => {
    const c = new SpectateCamera(ENV, 1);
    c.update(FRAME, target, 1);
    return c;
  };

  it('跟隨：指數平滑、幀率不影響、切換對象平移不瞬移', () => {
    const c = fresh();
    expect([c.cx, c.cy]).toEqual([target.x, target.y]);
    const next = { x: 80000, y: 40000 };
    c.update(FRAME, next, 1);
    const k = approach(FRAME, followTau(1));
    expect(c.cx - target.x).toBeCloseTo((next.x - target.x) * k, 6);
    expect(c.cx - target.x).toBeLessThan((next.x - target.x) * 0.15);
    // 同樣的時間切成兩半走，結果相同
    const a = fresh();
    const b = fresh();
    a.update(20, next, 1);
    b.update(10, next, 1);
    b.update(10, next, 1);
    expect(a.cx).toBeCloseTo(b.cx, 6);
    for (let i = 0; i < 180; i++) c.update(FRAME, next, 1);
    expect(Math.abs(c.cx - next.x)).toBeLessThan(1);
  });

  it('速度倍率越高阻尼越緊', () => {
    expect(followTau(1)).toBeGreaterThan(followTau(4));
    expect(followTau(0.5)).toBe(followTau(1));
  });

  it('全圖：到位後 300 幀鏡頭完全不動，跟隨對象怎麼動都一樣', () => {
    const c = fresh();
    c.overview();
    for (let i = 0; i < 120; i++) c.update(FRAME, target, 1);
    const g = overviewCam(ENV);
    expect(c.view).toEqual(g);
    for (let i = 0; i < 300; i++) {
      c.update(FRAME + (i % 7), { x: 10000 + i * 300, y: 90000 - i * 200 }, 1 + (i % 4));
      expect(c.view).toEqual(g);
    }
  });

  it('全圖的縮放讓整張地圖落在面板之間', () => {
    const g = overviewCam(ENV);
    expect(g.cx).toBe(60000);
    expect((ENV.mapH * UNIT * g.scale)).toBeCloseTo(ENV.h - 2 * ENV.padY, 6);
    expect(ENV.mapW * UNIT * g.scale).toBeLessThanOrEqual(ENV.w - 2 * ENV.padX);
  });

  it('自由鏡頭：拖曳換算 px，中心夾在地圖外一圈內', () => {
    const c = fresh();
    const cx0 = c.cx;
    const s = c.scale;
    c.pan(-200, 0);
    expect(c.mode).toBe('free');
    expect(c.cx).toBeCloseTo(cx0 + 200 / s, 6);
    c.pan(-1e7, -1e7);
    c.update(FRAME, target, 1);
    const halfW = ENV.w / c.scale / 2;
    const halfH = ENV.h / c.scale / 2;
    expect(c.cx).toBeCloseTo(ENV.mapW * UNIT + BOUND_CELLS * UNIT - halfW, 6);
    expect(c.cy).toBeCloseTo(ENV.mapH * UNIT + BOUND_CELLS * UNIT - halfH, 6);
    c.pan(1e7, 1e7);
    expect(c.cx).toBeCloseTo(halfW - BOUND_CELLS * UNIT, 6);
    // 畫面比地圖加邊界還大：置中
    expect(clampCenter(5, 200000, 120000, 6000)).toBe(60000);
  });

  it('滾輪以游標為中心：游標下的世界點不動，縮放有上下限', () => {
    const c = fresh();
    c.free();
    const sx = 400;
    const sy = 300;
    const world = (): [number, number] => [(sx - ENV.w / 2) / c.scale + c.cx, (sy - ENV.h / 2) / c.scale + c.cy];
    const [wx, wy] = world();
    c.zoomAt(1.5, sx, sy);
    for (let i = 0; i < 60; i++) c.update(FRAME, target, 1);
    const [ax, ay] = world();
    expect(ax).toBeCloseTo(wx, 3);
    expect(ay).toBeCloseTo(wy, 3);
    for (let i = 0; i < 40; i++) c.zoomAt(1.5, sx, sy);
    for (let i = 0; i < 120; i++) c.update(FRAME, target, 1);
    expect(c.scale).toBeCloseTo(MAX_PPC / UNIT, 9);
    for (let i = 0; i < 60; i++) c.zoomAt(0.5, sx, sy);
    for (let i = 0; i < 120; i++) c.update(FRAME, target, 1);
    expect(c.scale).toBeCloseTo(overviewCam(ENV).scale, 9);
  });

  it('跟隨時滾輪先固定游標下的點，之後回正到跟隨對象', () => {
    const c = fresh();
    c.zoomAt(1.4, 300, 200);
    for (let i = 0; i < 30; i++) c.update(FRAME, target, 1);
    expect(Math.hypot(c.cx - target.x, c.cy - target.y)).toBeGreaterThan(500);
    for (let i = 0; i < 600; i++) c.update(FRAME, target, 1);
    expect(Math.hypot(c.cx - target.x, c.cy - target.y)).toBeLessThan(5);
    expect(c.mode).toBe('follow');
  });

  it('全圖滾輪會進自由鏡頭；回跟隨是平移回去', () => {
    const c = fresh();
    c.overview();
    for (let i = 0; i < 120; i++) c.update(FRAME, target, 1);
    c.zoomAt(1.3, 960, 540);
    expect(c.mode).toBe('free');
    c.follow();
    const before = c.cx;
    c.update(FRAME, target, 1);
    expect(Math.abs(c.cx - before)).toBeLessThan(Math.abs(target.x - before));
    for (let i = 0; i < 180; i++) c.update(FRAME, target, 1);
    expect(Math.abs(c.cx - target.x)).toBeLessThan(1);
  });

  it('點人：底座半徑內最近的活人，遠看至少 12 px', () => {
    const ps = [
      { id: 1, x: 10000, y: 10000, alive: true },
      { id: 2, x: 10500, y: 10000, alive: true },
      { id: 3, x: 10200, y: 10000, alive: false },
    ];
    expect(pickPlayer(ps, 10150, 10000, 0.03)).toBe(1);
    expect(pickPlayer(ps, 10400, 10000, 0.03)).toBe(2);
    expect(pickPlayer(ps, 12000, 10000, 0.03)).toBeNull();
    // 全圖 7 px／格：12 px 約 1.7 格
    expect(pickPlayer(ps, 9000, 9000, 0.007)).toBe(1);
  });
});

const init = shooterInitData(MAPS[DEFAULT_MAP_ID](), 0, {});
const DATA: ShopData = { rules: init.rules, weapons: init.weapons, grenades: init.grenades, scopedSpeeds: { awp: WEAPONS.awp.scopedSpeed as number } };
const weapon = (id: WeaponId): WeaponInfo => DATA.weapons.find((w) => w.id === id) as WeaponInfo;
const knife = weapon('knife');
const obs = (o: { team?: 'T' | 'CT'; money?: number; primary?: WeaponId | null; secondary?: WeaponId | null; held?: WeaponId; armor?: number; kit?: boolean; grenades?: string[]; canBuy?: boolean; reserve?: number }): ShooterObservation =>
  ({ round: { canBuy: o.canBuy ?? true }, me: { team: o.team ?? 'T', money: o.money ?? 16000, weapon: o.held ?? o.primary ?? o.secondary ?? 'pistol', ammoReserve: o.reserve ?? 0, loadout: { primary: o.primary ?? null, secondary: o.secondary === undefined ? 'pistol' : o.secondary, grenades: o.grenades ?? [], armor: o.armor ?? 0, kit: o.kit ?? false } } }) as unknown as ShooterObservation;

describe('商店數值換算', () => {
  it('開局資料的武器每一把都換算得出數值，和規則表相同', () => {
    expect(DATA.weapons.map((w) => w.id)).toEqual([...WEAPON_IDS]);
    for (const w of DATA.weapons) {
      const d = WEAPONS[w.id];
      expect(rpmOf(w, TPS)).toBe(Math.round((60 * TPS) / d.fireTicks));
      expect(reloadSeconds(w, TPS)).toBeCloseTo(d.reloadTicks / TPS, 9);
      expect(speedPercent(w.speed, knife)).toBe(Math.round((d.speed / WEAPONS.knife.speed) * 100));
    }
    expect(rpmOf(weapon('ak'), TPS)).toBe(600);
    expect(reloadSeconds(weapon('ak'), TPS)).toBeCloseTo(2.5, 9);
    expect(cellsPerSecond(weapon('awp').speed, TPS, UNIT)).toBeCloseTo((WEAPONS.awp.speed * TPS) / UNIT, 9);
  });

  it('對甲傷害和引擎 armorSplit、damageAt 逐顆相同', () => {
    for (const w of DATA.weapons) {
      let armor = 100;
      let hp = 0;
      const d = WEAPONS[w.id];
      for (let i = 0; i < d.pellets; i++) {
        const r = armorSplit(damageAt(d, 0), armor, d.armorPen);
        hp += r.hpLoss;
        armor -= r.armorLoss;
      }
      expect(bodyDamage(w, 100), w.id).toBe(hp);
      expect(bodyDamage(w, 0), w.id).toBe(d.damage * d.pellets);
    }
    // 霰彈 8 顆：前 7 顆吸 13，第 8 顆只剩 9 點甲
    expect(bodyDamage(weapon('shotgun'), 100)).toBe(7 * 13 + 17);
  });

  it('長條在同類別內正規化：最好的滿格，精度是站定最小散佈 ÷ 這個散佈', () => {
    const pool = DATA.weapons.filter((w) => w.slot === 'primary');
    const rowOf = (id: WeaponId, key: string): StatRow => weaponRows(DATA, weapon(id), pool).find((r) => r.key === key) as StatRow;
    expect(rowOf('awp', 'damage').frac).toBeCloseTo(115 / (26 * 8), 9);
    expect(rowOf('shotgun', 'damage').frac).toBe(1);
    expect(rowOf('m4', 'stand').frac).toBe(1);
    expect(rowOf('ak', 'stand').frac).toBeCloseTo(70 / 80, 9);
    expect(rowOf('m4', 'move').frac).toBeCloseTo(70 / (70 * 6), 9);
    expect(accuracyFrac(0, 70)).toBe(1);
    expect(accuracyFrac(35, 70)).toBe(1);
    // 射速同一把 smg 最高
    expect(rowOf('smg', 'rpm').frac).toBe(1);
  });

  it('狙擊槍多兩列開鏡，其他槍沒有', () => {
    const pool = DATA.weapons.filter((w) => w.slot === 'primary');
    const awp = weaponRows(DATA, weapon('awp'), pool);
    expect(awp.find((r) => r.key === 'scopeSpread')?.text).toBe('±0.20°');
    expect(awp.find((r) => r.key === 'scopeSpeed')?.text).toContain('格／秒');
    expect(weaponRows(DATA, weapon('ak'), pool).some((r) => r.key.startsWith('scope'))).toBe(false);
  });

  it('比較：越小越好的數值反過來，相同不標', () => {
    const pool = DATA.weapons.filter((w) => w.slot === 'primary');
    const ak = weaponRows(DATA, weapon('ak'), pool);
    const m4 = weaponRows(DATA, weapon('m4'), pool);
    const cmp = (key: string): ReturnType<typeof compareRow> => compareRow(m4.find((r) => r.key === key) as StatRow, ak);
    expect(cmp('damage').sign).toBe(-1);
    expect(cmp('reload').sign).toBe(-1);
    expect(cmp('stand').sign).toBe(1);
    expect(cmp('speed').sign).toBe(0);
    expect(cmp('auto').sign).toBe(0);
    expect(cmp('damage').delta).toBe('−3');
  });

  it('比較對象：身上同槽位優先，沒有就看手上，刀不比', () => {
    expect(compareTarget(DATA, weapon('m4'), obs({ primary: 'ak', held: 'pistol' }))?.id).toBe('ak');
    expect(compareTarget(DATA, weapon('m4'), obs({ primary: null, held: 'pistol' }))?.id).toBe('pistol');
    expect(compareTarget(DATA, weapon('deagle'), obs({ secondary: null, held: 'knife' }))).toBeNull();
    expect(compareTarget(DATA, weapon('ak'), obs({ primary: 'ak' }))).toBeNull();
  });

  it('商品清單：四類都有、配發的手槍不能買、陣營限定不能買', () => {
    const list = shopEntries(DATA);
    expect(new Set(list.map((e) => e.cat))).toEqual(new Set(['pistol', 'primary', 'gear', 'nade']));
    expect(list.some((e) => e.id === 'knife')).toBe(false);
    const by = (id: string): ShopEntry => list.find((e) => e.id === id) as ShopEntry;
    expect(shopState(DATA, by('pistol'), obs({ secondary: null }))).toBe('locked');
    expect(shopState(DATA, by('m4'), obs({ team: 'T' }))).toBe('locked');
    expect(shopState(DATA, by('ak'), obs({ team: 'T', money: 100 }))).toBe('poor');
    expect(shopState(DATA, by('ak'), obs({ team: 'T' }))).toBe('ok');
    expect(shopState(DATA, by('ak'), obs({ team: 'T', primary: 'ak' }))).toBe('owned');
    expect(shopState(DATA, by('ak'), obs({ team: 'T', canBuy: false }))).toBe('closed');
    expect(shopState(DATA, by('armor'), obs({ armor: 100 }))).toBe('owned');
    expect(shopState(DATA, by('kit'), obs({ team: 'T' }))).toBe('locked');
    expect(shopState(DATA, by('kit'), obs({ team: 'CT', kit: true }))).toBe('owned');
    expect(shopState(DATA, by('flash'), obs({ grenades: ['flash', 'flash'] }))).toBe('owned');
    expect(shopState(DATA, by('he'), obs({ grenades: ['flash', 'flash', 'smoke', 'molotov'] }))).toBe('owned');
    expect(stateNote(by('ak'), 'poor')).toBe('AK：金錢不足');
    expect(stateNote(by('kit'), 'locked')).toBe('拆彈器：限 CT 購買');
    expect(stateNote(by('pistol'), 'locked')).toContain('開局配發');
  });

  it('道具數值全部照開局資料換算', () => {
    const row = (g: GrenadeInfo, label: string): string | undefined => grenadeRows(DATA, g).find((r) => r.label === label)?.text;
    const he = DATA.grenades.find((g) => g.id === 'he') as GrenadeInfo;
    const smoke = DATA.grenades.find((g) => g.id === 'smoke') as GrenadeInfo;
    const molotov = DATA.grenades.find((g) => g.id === 'molotov') as GrenadeInfo;
    expect(row(he, '效果半徑')).toBe(`${(GRENADES.he.radius / UNIT).toFixed(1)} 格`);
    expect(row(he, '持續')).toBe('瞬間');
    expect(row(he, '傷害')).toContain('98');
    expect(row(smoke, '持續')).toBe('18.0 秒');
    expect(row(smoke, '引信')).toBe('1.5 秒');
    expect(row(molotov, '傷害')).toContain('每秒 40');
    expect(row(molotov, '陣營')).toBe('T');
    expect(row(he, '陣營')).toBe('T／CT');
  });

  it('購買倒數：從凍結開始算，開打後接著扣', () => {
    const r = DATA.rules;
    const round = (phase: RoundInfo['phase'], left: number): RoundInfo => ({ phase, phaseTicksLeft: left }) as RoundInfo;
    expect(buyTicksLeft(round('freeze', r.freezeTicks), r)).toBe(r.buyTicks);
    expect(buyTicksLeft(round('freeze', 0), r)).toBe(r.buyTicks - r.freezeTicks);
    expect(buyTicksLeft(round('live', r.roundTicks), r)).toBe(r.buyTicks - r.freezeTicks);
    expect(buyTicksLeft(round('live', r.roundTicks - (r.buyTicks - r.freezeTicks)), r)).toBe(0);
    expect(buyTicksLeft(round('live', 10), r)).toBe(0);
    expect(buyTicksLeft(round('planted', 500), r)).toBe(0);
  });
});

describe('全狀態彈道', () => {
  const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'shooter-practice.js');
  const bots = { practice, baseline: (): never => { throw new Error('不該用到基準 Bot'); } };
  const s: ShooterSetup = { team: 'T', seed: 321, spectate: true };
  const build = (): ShooterDriver => new ShooterDriver(trialRunOptions(s, bots, null));

  it('取到真的子彈：欄位齊全、起點是開槍位置、不重複不漏，比賽狀態不受影響', () => {
    const watched = build();
    const plain = build();
    let sent = -1;
    let total = 0;
    const seen = new Set<string>();
    while (watched.match.roundNumber < 3 && !watched.match.over) {
      watched.step();
      plain.step();
      const shots = recentShots(watched.match, sent);
      for (const x of shots) {
        for (const v of [x.tick, x.x0, x.y0, x.x1, x.y1]) expect(Number.isFinite(v)).toBe(true);
        expect(Math.hypot(x.x1 - x.x0, x.y1 - x.y0)).toBeGreaterThan(0);
        seen.add(`${x.tick}|${x.x0}|${x.y0}|${x.x1}|${x.y1}`);
      }
      total += shots.length;
      sent = shots.reduce((a, x) => Math.max(a, x.tick), sent);
    }
    // 打了兩回合一定有開火；霰彈同位置同終點的極少，幾乎每筆都不同
    expect(total).toBeGreaterThan(20);
    expect(seen.size).toBeGreaterThan(total * 0.9);
    expect(recentShots(watched.match, sent)).toEqual([]);
    expect(watched.match.hash()).toBe(plain.match.hash());
  });
});

describe('跳回合', () => {
  const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'shooter-practice.js');
  const baselineBot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'shooter-baseline.js');
  const bots = { practice, baseline: () => baselineBot };
  const runTo = (d: ShooterDriver, round: number): void => {
    while (!d.match.over && d.match.roundNumber < round) d.step();
  };

  it('試玩觀戰：往前跳與直接跑到該回合的狀態雜湊相同，之後繼續跑也相同', () => {
    const s: ShooterSetup = { team: 'T', seed: 321, spectate: true, lineup: { team: { kind: 'practice' }, enemy: { kind: 'practice' } } };
    const build = (): ShooterDriver => new ShooterDriver(trialRunOptions(s, bots, null));
    const direct = build();
    runTo(direct, 3);
    const hash3 = direct.match.hash();
    
    runTo(direct, 5);
    const seen: number[] = [];
    // 第 5 回合 → 回到第 3 回合
    const back = seekDriver(direct, build, 3, (at) => seen.push(at));
    expect(back).not.toBe(direct);
    expect(back.match.roundNumber).toBe(3);
    expect(back.match.hash()).toBe(hash3);
    expect(seen).toEqual([2, 3]);
    // 再回到第 1 回合：就是開局
    const first = seekDriver(back, build, 1);
    expect(first.match.tick).toBe(0);
    expect(first.match.hash()).toBe(build().match.hash());
    // 回到第 3 回合之後繼續跑到第 5 回合，和當初一樣
    runTo(back, 5);
    expect(back.match.hash()).toBe(direct.match.hash());
  });

  it('往後跳不重建，同一個驅動往前推', () => {
    const s: ShooterSetup = { team: 'T', seed: 321, spectate: true };
    let built = 0;
    const build = (): ShooterDriver => {
      built += 1;
      return new ShooterDriver(trialRunOptions(s, bots, null));
    };
    const d = build();
    expect(seekDriver(d, build, 2)).toBe(d);
    expect(built).toBe(1);
    expect(d.match.roundNumber).toBe(2);
    // 同一回合重來要重建
    expect(seekDriver(d, build, 2)).not.toBe(d);
    expect(built).toBe(2);
  });

  it('經營層觀戰的請求單同一條路：基準 Bot 重跑相同', () => {
    const side = (from: number): { players: { lineageId: string; version: number; config: { habit: number } }[] } => ({ players: BALANCED_ROLES.map((role, i) => ({ lineageId: role, version: 3, config: { habit: trialHabit(77, from + i) } })) });
    const req = { formatId: LEAGUE_FORMAT_ID, a: side(0), b: side(5), seed: 77 };
    const build = (): ShooterDriver => new ShooterDriver(gatewayDriverOptions(req, baselineBot, { record: true }));
    const direct = build();
    runTo(direct, 2);
    const hash2 = direct.match.hash();
    runTo(direct, 3);
    expect(seekDriver(direct, build, 2).match.hash()).toBe(hash2);
  });
});
