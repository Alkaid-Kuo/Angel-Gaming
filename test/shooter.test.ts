import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cdegDiff, iatan2, iatan2C, icosC, isinC } from '../src/shared/geom.ts';
import { iatan2 as legionIatan2 } from '../src/legion/geom.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { ECONOMY_SCENARIOS, GRENADE_SCENARIOS, SCENARIOS } from '../src/shooter/acceptance.ts';
import { AMMO, ARMOR, DEFUSE_KIT, ECONOMY, FRIENDLY_FIRE_PCT, GRENADES, GRENADE_RULES, ROUND, SOUND, TEAM_SIZE, UNIT, VISION, WEAPONS, ticks, type GrenadeId } from '../src/shooter/config.ts';
import { applyPercent } from '../src/shared/intmath.ts';
import { MAPS, cellOf, isSolidCell } from '../src/shooter/map.ts';
import { circleHitsWall, findPath, sweptClear } from '../src/shooter/path.ts';
import { ShooterHumanController } from '../src/shooter/human.ts';
import { ScriptController, ShooterBatchController, ShooterDriver, runShooterMatch, runShooterReplay, type ShooterController } from '../src/shooter/runner.ts';
import { FIRE_TICK_DAMAGE, PLAYER_COUNT, ShooterMatch, TURN_STEP_C, armorSplit, damageAt, flashTicks, heDamageAt, smokeRadius, type Projectile, type ShooterMatchOptions } from '../src/shooter/sim.ts';
import { lineOfSight, quantizeDir, rayWallDistance, soundRange } from '../src/shooter/vision.ts';
import type { ShooterObservation, SoundEvent } from '../src/shooter/api.ts';

const map = MAPS.dust();
const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'shooter-practice.js');

function practiceControllers(seed: number): ShooterController[] {
  return Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(practice, 'shooter-practice.js', seed, pid, map));
}

/** 跳過凍結時間 */
function live(opts: Partial<ShooterMatchOptions> = {}): ShooterMatch {
  const m = new ShooterMatch({ mapId: 'dust', seed: 3, ...opts });
  while (m.phase === 'freeze') m.step();
  return m;
}

/** 把其他人移到各自出生區的邊上、面對牆，不干擾測試 */
function parkOthers(m: ShooterMatch, keep: readonly number[]): void {
  m.players.forEach((p, i) => {
    if (keep.includes(i)) return;
    if (p.team === 'T') m.teleport(i, (40 + (i % 5) * 2) * UNIT + 500, 115500, 90);
    else m.teleport(i, (57 + (i % 5) * 2) * UNIT + 500, 2500, 270);
  });
}

const at = (cx: number, cy: number): [number, number] => {
  if (isSolidCell(map, cx, cy)) throw new Error(`(${cx}, ${cy}) 是牆`);
  return [cx * UNIT + 500, cy * UNIT + 500];
};

describe('shared/geom', () => {
  it('軍團戰的 geom 轉出 shared 的同一份實作', () => {
    expect(legionIatan2).toBe(iatan2);
  });

  it('百分度 atan2 與 cos／sin 互相一致（誤差 < 0.05°）', () => {
    for (let a = 0; a < 36000; a += 137) {
      const back = iatan2C(isinC(a), icosC(a));
      expect(Math.abs(cdegDiff(back, a))).toBeLessThanOrEqual(5);
    }
    expect(iatan2C(0, 1000)).toBe(0);
    expect(iatan2C(1000, 0)).toBe(9000);
    expect(iatan2C(0, -1000)).toBe(18000);
    expect(iatan2C(-1000, 0)).toBe(27000);
  });
});

describe('視野與射線', () => {
  it('視線：A 長直線看得到、隔牆看不到；子彈撞牆距離', () => {
    const [ax, ay] = at(106, 90);
    const [bx, by] = at(106, 40);
    expect(lineOfSight(map, ax, ay, bx, by)).toBe(true);
    const [sx, sy] = at(82, 50);
    const [lx, ly] = at(104, 50);
    expect(lineOfSight(map, lx, ly, sx, sy)).toBe(false);
    // 從 A 長 (104.5, 50.5) 往西：x = 100 是牆面
    expect(rayWallDistance(map, lx, ly, -10000, 0, 50 * UNIT)).toBe(4500);
    // 煙霧掛勾：線段穿過圓就擋
    expect(lineOfSight(map, ax, ay, bx, by, [{ x: ax, y: 60000, radius: 3000 }])).toBe(false);
  });

  it('聲音方向量化成 30° 倍數、距離等級分界', () => {
    expect(quantizeDir(0, 0, 1000, 0)).toBe(0);
    expect(quantizeDir(0, 0, 0, -1000)).toBe(270);
    expect(quantizeDir(0, 0, 1000, 500)).toBe(30);
    expect(quantizeDir(0, 0, 1000, -10)).toBe(0);
  });
});

describe('視野公平（引擎強制）', () => {
  it('背後 1 格的敵人看不見；視錐內有視線看得見；牆後看不見', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y + UNIT, 270); // 背後 1 格
    m.teleport(6, x, y - 20 * UNIT, 90); // 正前方 20 格
    const [sx, sy] = at(82, 50);
    const [lx, ly] = at(104, 50);
    m.teleport(1, lx, ly, 180); // 面向西，敵人在短道（中間隔牆）
    m.teleport(7, sx, sy, 0);
    parkOthers(m, [0, 1, 5, 6, 7]);
    const o = m.observe(0);
    const ids = o.enemies.map((e) => e.id);
    expect(ids).not.toContain(5);
    expect(ids).toContain(6);
    expect(m.observe(1).enemies.map((e) => e.id)).not.toContain(7);
    expect(m.canSee(1, 7)).toBe(false);
  });

  it('雷達只給隊友此刻看見的敵人座標，自己看見的不重複', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 90); // 背對北
    m.teleport(1, x + 2 * UNIT, y, 270); // 隊友面北
    m.teleport(6, x, y - 15 * UNIT, 90);
    parkOthers(m, [0, 1, 6]);
    const o0 = m.observe(0);
    expect(o0.enemies.length).toBe(0);
    expect(o0.radar).toEqual([{ id: 6, x, y: y - 15 * UNIT }]);
    const o1 = m.observe(1);
    expect(o1.enemies.map((e) => e.id)).toEqual([6]);
    expect(o1.radar.length).toBe(0);
    // 敵人資料沒有血量與金錢
    expect(Object.keys(o1.enemies[0])).not.toContain('hp');
    expect(Object.keys(o1.enemies[0])).not.toContain('money');
  });

  function listen(walk: boolean, distCells: number): SoundEvent[] {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 0);
    m.teleport(6, x, y - distCells * UNIT, 90);
    parkOthers(m, [0, 6]);
    const heard: SoundEvent[] = [];
    for (let i = 0; i < 40; i++) {
      if (m.isDecisionTick()) {
        heard.push(...m.observe(0).sounds.filter((s) => s.kind === 'footstep'));
        m.applyCommands(6, [{ type: 'walk', on: walk }, { type: 'moveDir', deg: i < 20 ? 0 : 180 }]);
      }
      m.step();
    }
    return heard;
  }

  it('靜步時 20 格內聽不到腳步', () => {
    expect(listen(true, 8)).toEqual([]);
  });

  it('跑步聽得到：方向量化、距離等級正確，沒有座標', () => {
    const near = listen(false, 8);
    expect(near.length).toBeGreaterThan(0);
    for (const s of near) {
      expect(s.dirDeg % SOUND.directionStepDeg).toBe(0);
      expect(s.range).toBe('near');
      expect(s.friendly).toBe(false);
      expect(Object.keys(s).sort()).toEqual(['dirDeg', 'friendly', 'kind', 'range', 'weapon']);
    }
    expect(near.some((s) => s.dirDeg === 270)).toBe(true);
    expect(listen(false, 16).every((s) => s.range === 'mid')).toBe(true);
    expect(listen(false, 16).length).toBeGreaterThan(0);
    expect(listen(false, SOUND.footstepRange + 3)).toEqual([]);
    expect(soundRange(29 * UNIT)).toBe('mid');
    expect(soundRange(30 * UNIT)).toBe('far');
  });

  it('轉身一次決策內不超過上限（720°／秒 → 3 tick 72°）', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 0);
    m.applyCommands(0, [{ type: 'aim', x: x - 10 * UNIT, y }]);
    const f0 = m.observe(0).me.facing;
    for (let i = 0; i < 3; i++) m.step();
    const turned = Math.abs(cdegDiff(m.players[0].facing, f0 * 100));
    expect(turned).toBe(3 * TURN_STEP_C);
    expect(turned).toBeLessThanOrEqual(((VISION.turnDegPerSec * 100) / 30) * 3);
    for (let i = 0; i < 6; i++) m.step();
    expect(m.observe(0).me.facing).toBe(180);
  });

  it('CT 沒看見時不知道炸彈在哪（unknown）；T 知道', () => {
    const m = live();
    // CT 出生區面向北牆：什麼都看不到
    for (let i = TEAM_SIZE; i < PLAYER_COUNT; i++) m.teleport(i, m.players[i].x, 2500, 270);
    const cto = m.observe(5);
    expect(cto.bomb.state).toBe('unknown');
    expect(cto.bomb.x).toBeNull();
    const to = m.observe(0);
    expect(['carried', 'planting']).toContain(to.bomb.state);
    expect(to.bomb.x).not.toBeNull();
  });

  it('死亡與凍結時也有觀察資料', () => {
    const m = new ShooterMatch({ mapId: 'dust', seed: 1 });
    expect(m.observe(0).round.phase).toBe('freeze');
    expect(m.observe(0).round.canBuy).toBe(true);
    while (m.phase === 'freeze') m.step();
    m.kill(3);
    const o = m.observe(3);
    expect(o.me.alive).toBe(false);
    expect(o.enemies.length).toBe(0);
    expect(o.sounds.length).toBe(0);
  });
});

describe('移動與尋路', () => {
  it('T 出生到 A 點、B 點的路徑：每段圓掃過都不碰牆', () => {
    const s = map.spawns.T[2];
    for (const site of map.sites) {
      const gx = ((site.x0 + site.x1) / 2) * UNIT;
      const gy = ((site.y0 + site.y1) / 2 + 1) * UNIT;
      const path = findPath(map, s.x, s.y, gx, gy);
      expect(path).not.toBeNull();
      let [px, py] = [s.x, s.y];
      for (const [x, y] of path!) {
        expect(sweptClear(map, px, py, x, y, VISION.bodyRadius)).toBe(true);
        [px, py] = [x, y];
      }
    }
  });

  it('沿牆滑動、不穿牆；靜步與蹲下變慢', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 0);
    // 斜向撞東牆（x = 112）：x 被擋、y 繼續走
    m.applyCommands(0, [{ type: 'moveDir', deg: 300 }]);
    for (let i = 0; i < 90; i++) m.step();
    const p = m.players[0];
    expect(circleHitsWall(map, p.x, p.y, VISION.bodyRadius)).toBe(false);
    expect(p.x).toBe(112 * UNIT - VISION.bodyRadius);
    expect(p.y).toBeLessThan(y - 5 * UNIT);
    const speed = (walk: boolean, crouch: boolean): number => {
      const q = live();
      q.teleport(0, x, y, 0);
      q.applyCommands(0, [{ type: 'walk', on: walk }, { type: 'crouch', on: crouch }, { type: 'moveDir', deg: 270 }]);
      q.step();
      return -q.players[0].vy;
    };
    const run = speed(false, false);
    expect(run).toBe(WEAPONS.pistol.speed);
    expect(speed(true, false)).toBe(Math.floor((run * 52) / 100));
    expect(speed(false, true)).toBe(Math.floor((run * 34) / 100));
  });
});

describe('武器', () => {
  it('距離衰減：每 10 格 falloffPer10%，超過射程 20%', () => {
    expect(damageAt(WEAPONS.ak, 20 * UNIT)).toBe(34); // 36 × 96%
    expect(damageAt(WEAPONS.pistol, 10 * UNIT)).toBe(27); // 30 × 92%
    expect(damageAt(WEAPONS.pistol, 41 * UNIT)).toBe(6); // 超過 40 格
    expect(damageAt(WEAPONS.knife, 900)).toBe(40);
  });

  it('護甲：吸收 (100 − 穿甲)% 並扣甲值，甲不夠時只擋剩下的', () => {
    expect(armorSplit(30, 100, 50)).toEqual({ hpLoss: 15, armorLoss: 15 });
    expect(armorSplit(36, 100, 77)).toEqual({ hpLoss: 28, armorLoss: 8 });
    expect(armorSplit(30, 5, 50)).toEqual({ hpLoss: 25, armorLoss: 5 });
    expect(armorSplit(30, 0, 50)).toEqual({ hpLoss: 30, armorLoss: 0 });
  });

  it('實際開火：手槍打有甲目標，扣血與扣甲照公式', () => {
    const m = live({ defaultArmor: 100 });
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 5 * UNIT, 270);
    parkOthers(m, [0, 5]);
    m.applyCommands(0, [{ type: 'aim', x, y: y - 5 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    const v = m.players[5];
    const dmg = damageAt(WEAPONS.pistol, 5 * UNIT);
    const split = armorSplit(dmg, 100, WEAPONS.pistol.armorPen);
    expect(v.hp).toBe(100 - split.hpLoss);
    expect(v.armor).toBe(100 - split.armorLoss);
    expect(m.players[0].secondary!.mag).toBe(WEAPONS.pistol.magazine - 1);
  });

  it('霰彈逐顆計算：近距離 8 顆全中', () => {
    const m = live({ defaultLoadout: { T: 'shotgun' } });
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 2 * UNIT, 270);
    parkOthers(m, [0, 5]);
    m.players[5].hp = 1000;
    m.applyCommands(0, [{ type: 'aim', x, y: y - 2 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    const per = damageAt(WEAPONS.shotgun, 2 * UNIT);
    expect(1000 - m.players[5].hp).toBe(WEAPONS.shotgun.pellets * per);
  });

  it('霰彈遠距離部分彈丸打偏', () => {
    const m = live({ defaultLoadout: { T: 'shotgun' } });
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 7 * UNIT, 270);
    parkOthers(m, [0, 5]);
    m.players[5].hp = 1000;
    m.applyCommands(0, [{ type: 'aim', x, y: y - 7 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    const per = damageAt(WEAPONS.shotgun, 7 * UNIT);
    const lost = 1000 - m.players[5].hp;
    expect(lost % per).toBe(0);
    expect(lost / per).toBeGreaterThan(0);
    expect(lost / per).toBeLessThan(WEAPONS.shotgun.pellets);
  });

  it('死亡掉落主武器與炸彈，T 走過去撿起炸彈', () => {
    const m = live({ defaultLoadout: { T: 'ak' } });
    const carrier = m.players.find((p) => p.hasBomb)!;
    const mate = m.players.find((p) => p.team === 'T' && p.id !== carrier.id)!;
    m.kill(carrier.id);
    expect(m.bomb.state).toBe('dropped');
    expect(m.items.some((i) => i.kind === 'weapon' && i.weapon?.id === 'ak')).toBe(true);
    m.applyCommands(mate.id, [{ type: 'move', x: m.bomb.x, y: m.bomb.y }]);
    for (let i = 0; i < 200 && !mate.hasBomb; i++) m.step();
    expect(mate.hasBomb).toBe(true);
    expect(m.bomb.carrier).toBe(mate.id);
  });

  it('下包時移動會中斷', () => {
    const m = live();
    const carrier = m.players.find((p) => p.hasBomb)!;
    const [x, y] = at(19, 36);
    m.teleport(carrier.id, x, y, 270);
    m.applyCommands(carrier.id, [{ type: 'plant' }]);
    for (let i = 0; i < 30; i++) m.step();
    expect(carrier.plantTicks).toBeGreaterThan(0);
    m.applyCommands(carrier.id, [{ type: 'moveDir', deg: 0 }]);
    expect(carrier.plantTicks).toBe(0);
    for (let i = 0; i < ROUND.plantTicks; i++) m.step();
    expect(m.phase).toBe('live');
  });
});

describe('友軍傷害與狙擊鏡', () => {
  it('隊友挨子彈只扣 30%，而且會擋住後面的敵人', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(1, x, y - 5 * UNIT, 90); // 隊友擋在 5 格前
    m.teleport(5, x, y - 10 * UNIT, 90);
    parkOthers(m, [0, 1, 5]);
    m.applyCommands(0, [{ type: 'aim', x, y: y - 10 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    expect(m.players[1].hp).toBe(100 - applyPercent(damageAt(WEAPONS.pistol, 5 * UNIT), FRIENDLY_FIRE_PCT));
    expect(m.players[5].hp).toBe(100);
  });

  it('隊殺不算擊殺數、扣 300', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(1, x, y - 3 * UNIT, 90);
    parkOthers(m, [0, 1]);
    m.players[1].hp = 1;
    m.applyCommands(0, [{ type: 'aim', x, y: y - 3 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    expect(m.players[1].alive).toBe(false);
    expect(m.players[0].kills).toBe(0);
    expect(m.players[0].money).toBe(ECONOMY.startMoney + ECONOMY.teamKillPenalty);
    expect(m.kills.at(-1)).toMatchObject({ killer: 0, victim: 1 });
  });

  it('狙擊槍開鏡散佈是武器表的 scopedSpread（0.2°），未開鏡 25°', () => {
    expect(WEAPONS.awp.scopedSpread).toBe(20);
    expect(WEAPONS.awp.spread).toBe(2500);
    for (const w of Object.values(WEAPONS)) if (w.id !== 'awp') expect(w.scopedSpread).toBeNull();
  });

  /** 狙擊手在 A 長南端朝北對 45 格外的靜止目標開 40 槍，回傳命中次數 */
  function sniperHits(scoped: boolean): number {
    const m = live({ defaultLoadout: { T: 'awp' } });
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 45 * UNIT, 90);
    parkOthers(m, [0, 5]);
    m.players[5].hp = 1_000_000;
    if (scoped) m.applyCommands(0, [{ type: 'scope', on: true }]);
    m.applyCommands(0, [{ type: 'aim', x, y: y - 45 * UNIT }]);
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      const p = m.players[0];
      p.cooldown = 0;
      p.primary!.mag = WEAPONS.awp.magazine;
      expect(p.scoped).toBe(scoped);
      const before = m.players[5].hp;
      m.applyCommands(0, [{ type: 'fire', on: true }]);
      m.step();
      if (m.players[5].hp < before) hits += 1;
    }
    return hits;
  }

  it('開鏡 45 格外對靜止目標的命中率明顯高於未開鏡（固定種子）', () => {
    const on = sniperHits(true);
    const off = sniperHits(false);
    expect(on).toBeGreaterThanOrEqual(36);
    expect(off).toBeLessThanOrEqual(8);
  });
});

describe('回合勝利條件與回合流程（驗收情境）', () => {
  for (const s of SCENARIOS) {
    it(`${s.id} ${s.name}：${s.expect}`, () => {
      const r = s.run();
      expect(r.pass, r.detail).toBe(true);
    });
  }
});

describe('購買', () => {
  /** 凍結時間、人在出生區、每人 16000 */
  const rich = (opts: Partial<ShooterMatchOptions> = {}): ShooterMatch => new ShooterMatch({ mapId: 'dust', seed: 3, startMoney: 16000, ...opts });
  const T0 = 0;
  const CT0 = TEAM_SIZE;

  it('槽位替換：買新槍把舊槍丟在腳邊（可撿），手槍被換掉不退錢', () => {
    const m = rich();
    const p = m.players[T0];
    m.applyCommands(T0, [{ type: 'buy', items: ['smg', 'ak', 'deagle'] }]);
    expect(p.primary?.id).toBe('ak');
    expect(p.secondary?.id).toBe('deagle');
    expect(p.money).toBe(16000 - WEAPONS.smg.price - WEAPONS.ak.price - WEAPONS.deagle.price);
    expect(m.items.map((i) => i.weapon?.id).sort()).toEqual(['pistol', 'smg']);
    expect(m.items.every((i) => i.x === p.x && i.y === p.y)).toBe(true);
    // 別人撿得起來
    m.teleport(1, p.x, p.y);
    m.applyCommands(1, [{ type: 'pickup' }]);
    expect(m.items.length).toBe(1);
  });

  it('錢不夠的項目跳過，其餘照買', () => {
    const m = new ShooterMatch({ mapId: 'dust', seed: 3 });
    const p = m.players[T0];
    m.applyCommands(T0, [{ type: 'buy', items: ['ak', 'armor', 'flash'] }]);
    expect(p.primary).toBeNull();
    expect(p.armor).toBe(ARMOR.points);
    expect(p.money).toBe(ECONOMY.startMoney - ARMOR.price);
    expect(p.grenades).toEqual([]);
  });

  it('陣營限制：T 只能買 AK、燃燒瓶；CT 才能買 M4、拆彈器、燃燒彈', () => {
    const m = rich();
    m.applyCommands(T0, [{ type: 'buy', items: ['m4', 'kit', 'incendiary'] }]);
    expect(m.players[T0].money).toBe(16000);
    m.applyCommands(T0, [{ type: 'buy', items: ['ak', 'molotov'] }]);
    expect(m.players[T0].primary?.id).toBe('ak');
    expect(m.players[T0].grenades).toEqual(['molotov']);
    m.applyCommands(CT0, [{ type: 'buy', items: ['ak', 'molotov', 'pistol', 'knife', 'nope'] }]);
    expect(m.players[CT0].money).toBe(16000);
    m.applyCommands(CT0, [{ type: 'buy', items: ['m4', 'kit', 'kit', 'incendiary'] }]);
    const ct = m.players[CT0];
    expect(ct.primary?.id).toBe('m4');
    expect(ct.kit).toBe(true);
    expect(ct.money).toBe(16000 - WEAPONS.m4.price - DEFUSE_KIT.price - GRENADES.incendiary.price);
  });

  it('護甲已滿不重複扣錢', () => {
    const m = rich();
    m.applyCommands(T0, [{ type: 'buy', items: ['armor'] }]);
    m.applyCommands(T0, [{ type: 'buy', items: ['armor', 'armor'] }]);
    expect(m.players[T0].money).toBe(16000 - ARMOR.price);
    const full = rich({ defaultArmor: 100 });
    full.applyCommands(T0, [{ type: 'buy', items: ['armor'] }]);
    expect(full.players[T0].money).toBe(16000);
  });

  it('道具：同種上限（閃光 2）與總格數 4', () => {
    const m = rich();
    m.applyCommands(T0, [{ type: 'buy', items: ['flash', 'flash', 'flash', 'smoke', 'smoke', 'he', 'molotov'] }]);
    const p = m.players[T0];
    expect(p.grenades).toEqual(['flash', 'flash', 'smoke', 'he']);
    expect(p.money).toBe(16000 - 2 * GRENADES.flash.price - GRENADES.smoke.price - GRENADES.he.price);
    expect(m.observe(T0).me.loadout.grenades).toEqual(['flash', 'flash', 'smoke', 'he']);
  });

  it('購買時間＝從凍結開始算 20 秒：開打後第 5 秒內還能買，之後買不到', () => {
    const m = rich();
    while (m.tick - m.roundStartTick < ROUND.buyTicks - 1) m.step();
    expect(m.phase).toBe('live');
    expect(m.tick - m.liveStartTick).toBe(ROUND.buyTicks - ROUND.freezeTicks - 1);
    expect(m.observe(T0).round.canBuy).toBe(true);
    m.applyCommands(T0, [{ type: 'buy', items: ['armor'] }]);
    expect(m.players[T0].armor).toBe(ARMOR.points);
    m.step();
    expect(m.observe(1).round.canBuy).toBe(false);
    m.applyCommands(1, [{ type: 'buy', items: ['armor'] }]);
    expect(m.players[1].armor).toBe(0);
    expect(m.players[1].money).toBe(16000);
  });

  it('不在出生區買不到', () => {
    const m = rich();
    while (m.phase === 'freeze') m.step();
    const [x, y] = at(54, 90); // T 中路，出生區外
    m.teleport(T0, x, y);
    expect(m.observe(T0).round.canBuy).toBe(false);
    m.applyCommands(T0, [{ type: 'buy', items: ['ak'] }]);
    expect(m.players[T0].primary).toBeNull();
    expect(m.observe(1).round.canBuy).toBe(true);
  });

  it('拆彈器死亡掉落，CT 撿得起來、T 撿不到', () => {
    const m = rich();
    m.applyCommands(CT0, [{ type: 'buy', items: ['kit'] }]);
    while (m.phase === 'freeze') m.step();
    const ct = m.players[CT0];
    m.kill(CT0);
    expect(ct.kit).toBe(false);
    expect(m.items.filter((i) => i.kind === 'kit').length).toBe(1);
    m.teleport(T0, ct.x, ct.y);
    m.applyCommands(T0, [{ type: 'pickup' }]);
    expect(m.players[T0].kit).toBe(false);
    m.teleport(CT0 + 1, ct.x, ct.y);
    m.applyCommands(CT0 + 1, [{ type: 'pickup' }]);
    expect(m.players[CT0 + 1].kit).toBe(true);
    expect(m.items.length).toBe(0);
  });

  it('存活者保留武器（彈藥不補）、甲值、道具到下一回合；死亡者重發手槍＋刀；掉落物在回合交接時清除', () => {
    const m = rich();
    m.applyCommands(T0, [{ type: 'buy', items: ['ak', 'armor', 'he'] }]);
    m.applyCommands(1, [{ type: 'buy', items: ['ak', 'armor'] }]);
    while (m.phase === 'freeze') m.step();
    m.players[T0].primary!.mag = 7;
    m.kill(1);
    expect(m.items.some((i) => i.weapon?.id === 'ak')).toBe(true);
    for (let i = TEAM_SIZE; i < PLAYER_COUNT; i++) m.kill(i);
    while (m.roundNumber === 1) m.step();
    const a = m.players[T0];
    // 彈藥不會自動補（v0.5 第四輪：要買）
    expect(a.primary).toEqual({ id: 'ak', mag: 7, reserve: WEAPONS.ak.reserve });
    expect(a.armor).toBe(ARMOR.points);
    expect(a.grenades).toEqual(['he']);
    expect(a.money).toBe(16000 - WEAPONS.ak.price - ARMOR.price - GRENADES.he.price + ECONOMY.winElimination);
    const b = m.players[1];
    expect(b.primary).toBeNull();
    expect(b.secondary?.id).toBe('pistol');
    expect(b.armor).toBe(0);
    // 12650 + 3250 = 15900；再多就封頂
    expect(b.money).toBe(16000 - WEAPONS.ak.price - ARMOR.price + ECONOMY.winElimination);
    expect(m.items.length).toBe(0);
  });

  it('觀察資料：自己的金錢、隊友金錢公開', () => {
    const m = rich();
    m.applyCommands(1, [{ type: 'buy', items: ['armor'] }]);
    const o = m.observe(T0);
    expect(o.me.money).toBe(16000);
    expect(o.teammates.find((t) => t.id === 1)?.money).toBe(16000 - ARMOR.price);
    expect(o.round.canBuy).toBe(true);
  });

  it('金錢計入雜湊', () => {
    const a = rich();
    const b = rich();
    b.applyCommands(T0, [{ type: 'buy', items: ['armor'] }]);
    b.players[T0].armor = 0;
    expect(a.hash()).not.toBe(b.hash());
  });
});

describe('擊殺獎金與自殺', () => {
  function killWith(weapon: 'pistol' | 'smg' | 'ak' | 'knife'): number {
    const m = live(weapon === 'pistol' || weapon === 'knife' ? {} : { defaultLoadout: { T: weapon } });
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 1000, 90);
    parkOthers(m, [0, 5]);
    m.players[5].hp = 1;
    if (weapon === 'knife') m.applyCommands(0, [{ type: 'switch', slot: 'knife' }]);
    m.applyCommands(0, [{ type: 'aim', x, y: y - 1000 }, { type: 'fire', on: true }]);
    m.step();
    expect(m.players[5].alive).toBe(false);
    return m.players[0].money - ECONOMY.startMoney;
  }

  it('擊殺當下依武器表發獎金給擊殺者', () => {
    expect(killWith('pistol')).toBe(WEAPONS.pistol.killReward);
    expect(killWith('smg')).toBe(WEAPONS.smg.killReward);
    expect(killWith('ak')).toBe(WEAPONS.ak.killReward);
    expect(killWith('knife')).toBe(WEAPONS.knife.killReward);
  });

  it('引爆炸死自己隊的 T 算自殺 −300；炸死的 CT 不算誰的擊殺、不發獎金', () => {
    const m = live();
    const carrier = m.players.find((p) => p.hasBomb)!;
    const mate = m.players.find((p) => p.team === 'T' && p.id !== carrier.id)!;
    const [x, y] = at(19, 36);
    m.teleport(carrier.id, x, y, 270);
    m.applyCommands(carrier.id, [{ type: 'plant' }]);
    for (let i = 0; i < ROUND.plantTicks + 2; i++) m.step();
    expect(m.phase).toBe('planted');
    m.teleport(mate.id, x + UNIT, y, 0);
    m.teleport(TEAM_SIZE, x - UNIT, y, 0);
    while (m.rounds.length === 0) m.step();
    expect(m.rounds[0].reason).toBe('bomb');
    expect(mate.alive).toBe(false);
    expect(m.players[TEAM_SIZE].alive).toBe(false);
    expect(mate.money).toBe(ECONOMY.startMoney + ECONOMY.teamKillPenalty + ECONOMY.winBomb);
    expect(m.players[TEAM_SIZE].money).toBe(ECONOMY.startMoney + ECONOMY.lossBonus[0]);
    expect(m.players.every((p) => p.kills === 0)).toBe(true);
  });
});

describe('回合結算（驗收情境）', () => {
  for (const s of ECONOMY_SCENARIOS) {
    it(`${s.id} ${s.name}：${s.expect}`, () => {
      const r = s.run();
      expect(r.pass, r.detail).toBe(true);
    });
  }
});

describe('選手驅動', () => {
  it('陪練 Bot 通過宣告驗證（3～6 個旋鈕）', () => {
    const c = new ShooterBatchController(practice, 'shooter-practice.js', 1, 0, map);
    expect(c.declaration.knobs.length).toBeGreaterThanOrEqual(3);
    expect(c.declaration.knobs.length).toBeLessThanOrEqual(6);
  });

  it('例外當該次無指令；同一回合連續超時 10 次整回合閒置', () => {
    let calls = 0;
    const thrower = new ScriptController('thrower', () => {
      throw new Error('boom');
    });
    const slow = new ScriptController('slow', () => {
      calls += 1;
      const t0 = performance.now();
      while (performance.now() - t0 < 55) {
        /* 忙等超時 */
      }
      return [{ type: 'moveDir', deg: 270 }];
    });
    const controllers: ShooterController[] = Array.from({ length: PLAYER_COUNT }, (_, i) => (i === 0 ? thrower : i === 1 ? slow : new ScriptController(`idle-${i}`, () => [])));
    const d = new ShooterDriver({ mapId: 'dust', seed: 1, controllers, record: false });
    for (let i = 0; i < 90; i++) d.step();
    expect(d.runtime[0].exceptions).toBeGreaterThan(0);
    expect(d.runtime[1].timeouts).toBe(10);
    expect(d.runtime[1].idleRounds).toBe(1);
    expect(calls).toBe(10);
    // 超時的指令沒有套用
    expect(d.match.players[1].y).toBe(map.spawns.T[1].y);
  });

  it('凍結時間也會呼叫 decide', () => {
    let freezeCalls = 0;
    const controllers = Array.from({ length: PLAYER_COUNT }, (_, i) =>
      new ScriptController(`s-${i}`, (obs: ShooterObservation) => {
        if (obs.round.phase === 'freeze') freezeCalls += 1;
        return [];
      }),
    );
    const d = new ShooterDriver({ mapId: 'dust', seed: 1, controllers, record: false });
    for (let i = 0; i < 30; i++) d.step();
    expect(freezeCalls).toBe(10 * PLAYER_COUNT);
  });
});

describe('確定性與效能', () => {
  const short = { roundsPerHalf: 3, winRounds: 4 };

  it('同種子兩次雜湊相同；不同種子不同；回放重播雜湊相同', () => {
    const a = runShooterMatch({ seed: 11, ...short, controllers: practiceControllers(11), record: true });
    const b = runShooterMatch({ seed: 11, ...short, controllers: practiceControllers(11), record: false });
    const c = runShooterMatch({ seed: 12, ...short, controllers: practiceControllers(12), record: false });
    expect(a.finalHash).toBe(b.finalHash);
    expect(a.finalHash).not.toBe(c.finalHash);
    expect(a.replay!.hashes.length).toBeGreaterThan(10);
    const r = runShooterReplay(JSON.parse(JSON.stringify(a.replay)));
    expect(r.desyncTick).toBeNull();
    expect(r.finalHash).toBe(a.finalHash);
    expect(r.result.score).toEqual(a.result.score);
  });

  it('陪練 Bot 對打（短賽制）打得完且夠快', () => {
    const run = runShooterMatch({ seed: 5, ...short, controllers: practiceControllers(5), record: false });
    expect(run.match.over).toBe(true);
    expect(run.result.rounds.length).toBeGreaterThanOrEqual(4);
    expect(run.runtime.every((rt) => rt.exceptions === 0 && rt.timeouts === 0)).toBe(true);
    // 完整 MR12 要求 15 秒內；短賽制最多 6 回合，給 5 秒
    expect(run.wallMs).toBeLessThan(5000);
    // 有人真的開槍打死人
    expect(run.result.stats.reduce((a, s) => a + s.kills, 0)).toBeGreaterThan(0);
  });

  // 沙城：陪練 Bot 的閃光只丟 10～20 格的敵人，赤岩鎮開闊、交火距離遠，很少丟（規格 v0.5 第十四節待審）
  it('陪練 Bot v3 會丟道具：全買局 T 丟煙霧、CT 丟閃光（沙城，10 個種子短賽制）', () => {
    let tThrows = 0;
    let ctThrows = 0;
    let enemyBlind = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const run = runShooterMatch({ seed, mapId: 'dust', ...short, controllers: practiceControllers(seed), record: false });
      expect(run.runtime.every((rt) => rt.exceptions === 0 && rt.timeouts === 0)).toBe(true);
      for (const r of run.result.rounds) {
        tThrows += r.throws[r.tGroup];
        ctThrows += r.throws[r.tGroup === 0 ? 1 : 0];
        enemyBlind += r.flashEnemyTicks[0] + r.flashEnemyTicks[1];
      }
    }
    expect(tThrows).toBeGreaterThan(0);
    expect(ctThrows).toBeGreaterThan(0);
    expect(enemyBlind).toBeGreaterThan(0);
  });

  it('eco 對全買：玩家 0～4 每回合開局 16000、玩家 5～9 只有 800，20 個種子短賽制回合勝率 ≥ 75%', () => {
    let won = 0;
    let total = 0;
    let fullBuy = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const run = runShooterMatch({ seed, ...short, roundMoney: [16000, 800], controllers: practiceControllers(seed), record: false });
      for (const r of run.result.rounds) {
        total += 1;
        if (r.winnerGroup === 0) won += 1;
        if (r.fullBuy[0]) fullBuy += 1;
        expect(r.money).toEqual([16000, 800]);
        expect(r.fullBuy[1]).toBe(false);
      }
    }
    expect(won / total).toBeGreaterThanOrEqual(0.75);
    expect(fullBuy).toBe(total);
  });

  it('隊伍人數與地圖：每隊 5 人、出生點不在牆裡', () => {
    const m = new ShooterMatch({ mapId: 'dust', seed: 1 });
    expect(m.players.filter((p) => p.team === 'T').length).toBe(TEAM_SIZE);
    for (const p of m.players) expect(isSolidCell(map, cellOf(p.x), cellOf(p.y))).toBe(false);
  });
});

// ───────── 步驟 3：道具 ─────────

/** 在 (x, y) 放一顆已落地、這一 tick 就生效的道具，跑一 tick */
function pop(m: ShooterMatch, kind: GrenadeId, owner: number, x: number, y: number): void {
  m.projectiles.push({ kind, owner, x, y, dx: 0, dy: 0, left: 0, bounces: 0, moving: false, fuseTick: m.tick });
  m.step();
}

/** 放一團已經完全散開的煙霧（視野矩陣每 tick 快取一次：原地瞬移玩家 0 讓它重算） */
function fullSmoke(m: ShooterMatch, x: number, y: number, owner = 5): void {
  m.smokes.push({ x, y, owner, startTick: m.tick - GRENADE_RULES.smokeBloomTicks, endTick: m.tick + GRENADES.smoke.durationTicks });
  m.teleport(0, m.players[0].x, m.players[0].y);
}

/** 放一團剛點著（上一 tick 點火）的火 */
function litFire(m: ShooterMatch, x: number, y: number, owner: number): void {
  m.fires.push({ x, y, owner, kind: 'molotov', startTick: m.tick - 1, endTick: m.tick - 1 + GRENADES.molotov.durationTicks });
}

/** 玩家 0 在 A 長 (106, 90) 朝 deg 丟 kind，跑到停下；回傳那顆道具 */
function throwAndLand(power: number, deg = 270, kind: GrenadeId = 'smoke'): { m: ShooterMatch; g: Projectile; ticks: number } {
  const m = live();
  const [x, y] = at(106, 90);
  // 面向投擲方向（v0.4：投擲方向夾在視錐內）
  m.teleport(0, x, y, deg);
  parkOthers(m, [0]);
  m.players[0].grenades = [kind];
  m.applyCommands(0, [{ type: 'throw', grenade: kind, deg, power }]);
  const g = m.projectiles[0];
  let n = 0;
  while (g.moving && n < 200) {
    m.step();
    n += 1;
  }
  return { m, g, ticks: n };
}

describe('投擲', () => {
  it('力道線性對應距離：0／50／100 → 0／12.5／25 格（直線、沒碰牆）', () => {
    const [, y] = at(106, 90);
    for (const [power, cells] of [
      [0, 0],
      [50, 12.5],
      [100, 25],
    ] as const) {
      const { g } = throwAndLand(power);
      expect(y - g.y).toBe(cells * UNIT);
      expect(g.x).toBe(at(106, 90)[0]);
      expect(g.bounces).toBe(0);
    }
    // 飛行速度：25 格約 44 tick（< 1.5 秒引信）
    expect(throwAndLand(100).ticks).toBe(Math.ceil((25 * UNIT) / GRENADE_RULES.flySpeed));
  });

  it('碰牆反彈一次後繼續飛、第二次碰牆就停', () => {
    // A 長寬 12 格（x 100～111）：從 (106.5, 90.5) 往東全力丟，撞東牆反彈，往西撞西牆停
    const { g } = throwAndLand(100, 0, 'flash');
    expect(g.bounces).toBe(1);
    expect(g.moving).toBe(false);
    expect(g.x).toBe(100 * UNIT + GRENADE_RULES.projectileRadius);
    expect(g.y).toBe(at(106, 90)[1]);
    // 第一次碰牆後沒有停：飛過的路程 > 往東的 5.4 格
    const traveled = 112 * UNIT - GRENADE_RULES.projectileRadius - at(106, 90)[0] + (112 * UNIT - 100 * UNIT - 2 * GRENADE_RULES.projectileRadius);
    expect(traveled).toBeLessThan(25 * UNIT);
    expect(g.left).toBe(0);
  });

  it('斜著撞牆：只反轉撞到的那一軸（法線鏡射）', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    parkOthers(m, [0]);
    m.players[0].grenades = ['smoke'];
    m.applyCommands(0, [{ type: 'throw', grenade: 'smoke', deg: 315, power: 100 }]);
    const g = m.projectiles[0];
    const dy0 = g.dy;
    const dx0 = g.dx;
    while (g.bounces === 0 && g.moving) m.step();
    expect(g.dx).toBe(-dx0);
    expect(g.dy).toBe(dy0);
  });

  it('投出後從背包移除；沒有該道具時忽略；冷卻 0.5 秒內不能再投也不能開火；凍結時間不能投', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    parkOthers(m, [0]);
    m.players[0].grenades = ['flash', 'flash', 'smoke'];
    m.applyCommands(0, [{ type: 'throw', grenade: 'he', deg: 270, power: 50 }]);
    expect(m.projectiles.length).toBe(0);
    m.applyCommands(0, [{ type: 'throw', grenade: 'flash', deg: 270, power: 50 }]);
    expect(m.players[0].grenades).toEqual(['flash', 'smoke']);
    expect(m.projectiles.length).toBe(1);
    // 冷卻內：再投、開火都無效
    m.applyCommands(0, [{ type: 'throw', grenade: 'smoke', deg: 270, power: 50 }, { type: 'fire', on: true }]);
    const mag = m.players[0].secondary!.mag;
    for (let i = 0; i < GRENADE_RULES.throwCooldownTicks - 1; i++) m.step();
    expect(m.players[0].grenades).toEqual(['flash', 'smoke']);
    expect(m.players[0].secondary!.mag).toBe(mag);
    m.step();
    expect(m.players[0].throwCd).toBe(0);
    m.applyCommands(0, [{ type: 'throw', grenade: 'smoke', deg: 270, power: 50 }]);
    expect(m.players[0].grenades).toEqual(['flash']);
    expect(m.observe(0).me.loadout.grenades).toEqual(['flash']);
    // 凍結時間
    const f = new ShooterMatch({ mapId: 'dust', seed: 3 });
    f.players[0].grenades = ['smoke'];
    f.applyCommands(0, [{ type: 'throw', grenade: 'smoke', deg: 270, power: 50 }]);
    expect(f.projectiles.length).toBe(0);
    expect(f.players[0].grenades).toEqual(['smoke']);
  });

  it('飛行中的道具：視錐內或 2 格內看得見，背後看不見', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    parkOthers(m, [0]);
    m.projectiles.push({ kind: 'he', owner: 5, x, y: y - 8 * UNIT, dx: 0, dy: 0, left: 0, bounces: 0, moving: false, fuseTick: m.tick + 100 });
    expect(m.observe(0).projectiles).toEqual([{ kind: 'he', x, y: y - 8 * UNIT }]);
    m.teleport(0, x, y, 90);
    expect(m.observe(0).projectiles).toEqual([]);
    m.teleport(0, x, y - 7 * UNIT, 90);
    expect(m.observe(0).projectiles.length).toBe(1);
  });
});

describe('煙霧', () => {
  it('擴散中半徑線性成長、1 秒長滿 3 格；觀察資料給當下半徑', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    parkOthers(m, [0]);
    pop(m, 'smoke', 5, x, y - 6 * UNIT);
    const s = m.smokes[0];
    expect(smokeRadius(s, s.startTick)).toBe(0);
    expect(smokeRadius(s, s.startTick + 15)).toBe(1500);
    expect(smokeRadius(s, s.startTick + 30)).toBe(3000);
    expect(smokeRadius(s, s.startTick + 300)).toBe(3000);
    for (let i = 0; i < 9; i++) m.step();
    const e = m.observe(0).effects;
    expect(e).toEqual([{ kind: 'smoke', x, y: y - 6 * UNIT, radius: smokeRadius(s, m.tick), ticksLeft: s.endTick - m.tick }]);
    expect(e[0].radius).toBe(1000);
  });

  it('煙後的敵人不在 enemies、也不在隊友的 radar；子彈穿煙照打', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    m.teleport(1, x - 2 * UNIT, y, 270);
    m.teleport(5, x, y - 10 * UNIT, 90);
    m.teleport(6, x - 2 * UNIT, y + 3 * UNIT, 0); // 背後看不見 0，也沒有視線問題
    parkOthers(m, [0, 1, 5, 6]);
    expect(m.observe(0).enemies.map((e) => e.id)).toContain(5);
    fullSmoke(m, x, y - 5 * UNIT);
    expect(m.observe(0).enemies.map((e) => e.id)).not.toContain(5);
    expect(m.observe(0).radar.map((r) => r.id)).not.toContain(5);
    expect(m.observe(1).enemies.map((e) => e.id)).not.toContain(5);
    expect(m.observe(5).enemies.length).toBe(0);
    expect(m.canSee(5, 0)).toBe(false);
    m.applyCommands(0, [{ type: 'aim', x, y: y - 10 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    expect(m.players[5].hp).toBe(100 - damageAt(WEAPONS.pistol, 10 * UNIT));
  });

  it('擋掉落物與炸彈的可見性（2 格內照看得到）', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    parkOthers(m, [0]);
    m.items.push({ kind: 'weapon', weapon: { id: 'ak', mag: 30, reserve: 90 }, x, y: y - 10 * UNIT });
    expect(m.observe(0).items.length).toBe(1);
    fullSmoke(m, x, y - 5 * UNIT);
    expect(m.observe(0).items.length).toBe(0);
  });

  it('18 秒後消失', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    parkOthers(m, [0]);
    pop(m, 'smoke', 0, x, y - 6 * UNIT);
    for (let i = 0; i < GRENADES.smoke.durationTicks - 1; i++) m.step();
    expect(m.smokes.length).toBe(1);
    m.step();
    expect(m.smokes.length).toBe(0);
    expect(m.observe(0).effects).toEqual([]);
  });

  it('撲滅重疊的火（擴散中也算）；火落在煙裡不會點燃', () => {
    const m = live();
    const [x, y] = at(106, 80);
    parkOthers(m, [5]);
    m.teleport(5, x, y, 90);
    litFire(m, x, y, 0);
    for (let i = 0; i < GRENADE_RULES.fireTickInterval; i++) m.step();
    const hp = m.players[5].hp;
    expect(hp).toBe(100 - FIRE_TICK_DAMAGE);
    // 圓心距 3 格：煙剛生效（半徑 0）不重疊，下一 tick 半徑 > 0 就撲滅
    pop(m, 'smoke', 0, x, y + 3 * UNIT);
    expect(m.fires.length).toBe(1);
    m.step();
    expect(m.fires.length).toBe(0);
    for (let i = 0; i < ticks(2); i++) m.step();
    expect(m.players[5].hp).toBe(hp);
    // 燃燒瓶落在已有煙霧裡
    pop(m, 'molotov', 0, x, y + 2 * UNIT);
    expect(m.fires.length).toBe(0);
  });
});

describe('閃光', () => {
  /** 玩家 0 在 (106, 80) 面向 facing，敵人 5 在 (106, 80 − d) 引爆閃光；回傳致盲 tick */
  function flashAt(facing: number, dCells: number, setup?: (m: ShooterMatch) => void): number {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, facing);
    parkOthers(m, [0]);
    setup?.(m);
    pop(m, 'flash', 5, x, y - Math.round(dCells * UNIT));
    return m.players[0].blindTicks;
  }

  it('正對 2.0 秒、側向 1.0 秒、背對 0.3 秒（10 格：乘 2/3）', () => {
    expect(flashAt(270, 10)).toBe(40);
    expect(flashAt(180, 10)).toBe(20);
    expect(flashAt(0, 10)).toBe(20);
    expect(flashAt(90, 10)).toBe(6);
    // 分界：夾角 60° 仍算正對、61° 算側向
    expect(flashAt(330, 10)).toBe(40);
    expect(flashAt(331, 10)).toBe(20);
    expect(flashAt(30, 10)).toBe(20);
    expect(flashAt(31, 10)).toBe(6);
  });

  it('距離係數 1 − d／(2R)：貼臉 100%、7.5 格 75%、15 格 50%、15 格外不致盲', () => {
    expect(flashAt(270, 0)).toBe(GRENADE_RULES.flashFrontTicks);
    expect(flashAt(270, 7.5)).toBe(45);
    expect(flashAt(270, 15)).toBe(30);
    expect(flashAt(90, 15)).toBe(4);
    expect(flashAt(270, 15.1)).toBe(0);
    expect(flashTicks(27000, 0, 0, 0, -15000)).toBe(30);
  });

  it('牆後與煙後不致盲', () => {
    // 柱子 (66, 61～63)：爆點 (64.5, 63.5)、人在 (68.5, 63.5) 面西，距離 4 格但隔柱子
    const m = live();
    const [px, py] = at(68, 63);
    const [fx, fy] = at(64, 63);
    expect(lineOfSight(map, px, py, fx, fy)).toBe(false);
    m.teleport(0, px, py, 180);
    parkOthers(m, [0]);
    pop(m, 'flash', 5, fx, fy);
    expect(m.players[0].blindTicks).toBe(0);
    expect(flashAt(270, 10, (mm) => fullSmoke(mm, at(106, 80)[0], at(106, 75)[1]))).toBe(0);
  });

  it('隊友與自己也會被閃；取較大值不累加', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(1, x + 2 * UNIT, y, 270);
    parkOthers(m, [0, 1]);
    pop(m, 'flash', 0, x, y - 5 * UNIT);
    expect(m.players[0].blindTicks).toBe(flashTicks(27000, x, y, x, y - 5 * UNIT));
    expect(m.players[0].blindTicks).toBe(50);
    expect(m.players[1].blindTicks).toBeGreaterThan(0);
    // 第二顆較弱（側向）：不累加、維持較大值（已倒數 1 tick）
    m.teleport(0, x, y, 180);
    pop(m, 'flash', 0, x, y - 5 * UNIT);
    expect(m.players[0].blindTicks).toBe(49);
    // 第三顆較強（貼臉）：取新值
    pop(m, 'flash', 0, x, y);
    expect(m.players[0].blindTicks).toBe(GRENADE_RULES.flashFrontTicks);
    // 統計：自己隊的致盲 tick 有記下
    expect(m.rounds.length).toBe(0);
  });

  it('致盲期間 enemies／radar／effects／items／projectiles 為空，me 與 teammates 照給；結束後恢復', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(1, x + 3 * UNIT, y + 5 * UNIT, 270);
    m.teleport(5, x, y - 10 * UNIT, 90);
    m.teleport(6, x + 3 * UNIT, y - 12 * UNIT, 0);
    parkOthers(m, [0, 1, 5, 6]);
    m.items.push({ kind: 'weapon', weapon: { id: 'ak', mag: 30, reserve: 90 }, x, y: y - 4 * UNIT });
    litFire(m, x - 3 * UNIT, y - 6 * UNIT, 5);
    m.projectiles.push({ kind: 'he', owner: 5, x: x + UNIT, y: y - 8 * UNIT, dx: 0, dy: 0, left: 0, bounces: 0, moving: false, fuseTick: m.tick + 200 });
    const before = m.observe(0);
    expect(before.enemies.length).toBeGreaterThan(0);
    expect(before.effects.length).toBe(1);
    expect(before.items.length).toBe(1);
    expect(before.projectiles.length).toBe(1);
    m.players[0].blindTicks = 10;
    m.players[1].blindTicks = 0;
    m.teleport(0, x, y, 270);
    const o = m.observe(0);
    expect(o.enemies).toEqual([]);
    expect(o.radar).toEqual([]);
    expect(o.effects).toEqual([]);
    expect(o.items).toEqual([]);
    expect(o.projectiles).toEqual([]);
    expect(o.me.blindTicks).toBe(10);
    expect(o.me.x).toBe(x);
    expect(o.teammates.length).toBe(TEAM_SIZE - 1);
    expect(m.observe(1).teammates.find((t) => t.id === 0)!.blind).toBe(true);
    for (let i = 0; i < 10; i++) m.step();
    expect(m.players[0].blindTicks).toBe(0);
    expect(m.observe(0).enemies.length).toBeGreaterThan(0);
  });

  it('回合紀錄：投擲數與閃光致盲 tick', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 10 * UNIT, 90);
    parkOthers(m, [0, 5]);
    m.players[0].grenades = ['flash'];
    m.applyCommands(0, [{ type: 'throw', grenade: 'flash', deg: 270, power: 40 }]);
    while (m.projectiles.length > 0) m.step();
    expect(m.players[5].blindTicks).toBeGreaterThan(0);
    const enemy = m.players[5].blindTicks;
    const own = m.players[0].blindTicks;
    expect(own).toBeGreaterThan(0);
    for (const p of m.players) if (p.team === 'CT') m.kill(p.id);
    while (m.rounds.length === 0) m.step();
    expect(m.rounds[0].throws).toEqual([1, 0]);
    expect(m.rounds[0].flashEnemyTicks).toEqual([enemy, 0]);
    expect(m.rounds[0].flashTeamTicks).toEqual([own, 0]);
  });
});

describe('手雷', () => {
  function heOn(victim: number, dCells: number, opts: { armor?: number; owner?: number; hp?: number } = {}): ShooterMatch {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(victim, x, y, 270);
    const owner = opts.owner ?? 5;
    if (owner !== victim) m.teleport(owner, x, y + 10 * UNIT, 270);
    parkOthers(m, [victim, owner]);
    m.players[victim].armor = opts.armor ?? 0;
    if (opts.hp !== undefined) m.players[victim].hp = opts.hp;
    pop(m, 'he', owner, x, y - Math.round(dCells * UNIT));
    return m;
  }

  it('中心 98、線性衰減到 3.5 格歸零', () => {
    expect(heDamageAt(0)).toBe(98);
    expect(heDamageAt(1750)).toBe(49);
    expect(heDamageAt(3500)).toBe(0);
    expect(heOn(0, 0).players[0].hp).toBe(2);
    expect(heOn(0, 1.75).players[0].hp).toBe(51);
    expect(heOn(0, 3.5).players[0].hp).toBe(100);
  });

  it('護甲吸收 50% 並扣甲；甲不夠時只擋剩下的', () => {
    const a = heOn(0, 0, { armor: 100 }).players[0];
    expect(a.hp).toBe(100 - 49);
    expect(a.armor).toBe(100 - 49);
    const b = heOn(0, 0, { armor: 10 }).players[0];
    expect(b.hp).toBe(100 - 88);
    expect(b.armor).toBe(0);
  });

  it('牆後不受傷（煙霧不擋）', () => {
    const m = live();
    const [px, py] = at(67, 63);
    const [fx, fy] = at(65, 63);
    m.teleport(0, px, py, 180);
    parkOthers(m, [0]);
    pop(m, 'he', 5, fx, fy);
    expect(m.players[0].hp).toBe(100);
    const s = heOn(0, 2, { owner: 5 });
    expect(s.players[0].hp).toBe(100 - heDamageAt(2000));
    const t = live();
    const [x, y] = at(106, 80);
    t.teleport(0, x, y, 270);
    parkOthers(t, [0]);
    fullSmoke(t, x, y - UNIT);
    pop(t, 'he', 5, x, y - 2 * UNIT);
    expect(t.players[0].hp).toBe(100 - heDamageAt(2000));
  });

  it('隊友 30%；自己全額', () => {
    expect(heOn(1, 0, { owner: 0 }).players[1].hp).toBe(100 - applyPercent(98, FRIENDLY_FIRE_PCT));
    expect(heOn(0, 0, { owner: 0 }).players[0].hp).toBe(2);
  });

  it(`擊殺獎金 ${ECONOMY.grenadeKillReward}、隊殺 −300、自殺 −300 不算擊殺`, () => {
    const kill = heOn(5, 0, { owner: 0, hp: 50 });
    expect(kill.players[5].alive).toBe(false);
    expect(kill.players[0].kills).toBe(1);
    expect(kill.players[0].money).toBe(ECONOMY.startMoney + ECONOMY.grenadeKillReward);
    expect(kill.kills.at(-1)).toMatchObject({ killer: 0, victim: 5, weapon: 'he' });
    const tk = heOn(1, 0, { owner: 0, hp: 10 });
    expect(tk.players[1].alive).toBe(false);
    expect(tk.players[0].kills).toBe(0);
    expect(tk.players[0].money).toBe(ECONOMY.startMoney + ECONOMY.teamKillPenalty);
    const self = heOn(0, 0, { owner: 0, hp: 50 });
    expect(self.players[0].alive).toBe(false);
    expect(self.players[0].kills).toBe(0);
    expect(self.players[0].money).toBe(ECONOMY.startMoney + ECONOMY.teamKillPenalty);
  });
});

describe('燃燒', () => {
  it('每 0.2 秒 8 點、不吃護甲；站在火裡 2 秒掉 80；隊友 30%', () => {
    expect(FIRE_TICK_DAMAGE).toBe(8);
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(5, x, y, 90);
    m.teleport(1, x + 2 * UNIT, y, 90);
    parkOthers(m, [1, 5]);
    m.players[5].armor = 100;
    litFire(m, x, y, 0);
    for (let i = 0; i < GRENADE_RULES.fireTickInterval - 1; i++) m.step();
    expect(m.players[5].hp).toBe(100);
    m.step();
    expect(m.players[5].hp).toBe(92);
    for (let i = 0; i < ticks(2) - GRENADE_RULES.fireTickInterval; i++) m.step();
    expect(m.players[5].hp).toBe(20);
    expect(m.players[5].armor).toBe(100);
    expect(m.players[1].hp).toBe(100 - 10 * applyPercent(FIRE_TICK_DAMAGE, FRIENDLY_FIRE_PCT));
  });

  it('燒死敵人：擊殺歸投擲者、獎金 300', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(5, x, y, 90);
    parkOthers(m, [5]);
    m.players[5].hp = 8;
    litFire(m, x, y, 0);
    for (let i = 0; i < GRENADE_RULES.fireTickInterval; i++) m.step();
    expect(m.players[5].alive).toBe(false);
    expect(m.kills.at(-1)).toMatchObject({ killer: 0, victim: 5, weapon: 'molotov' });
    expect(m.players[0].money).toBe(ECONOMY.startMoney + ECONOMY.grenadeKillReward);
  });

  it('7 秒後消失；火圈外不受傷', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(5, x, y + 3 * UNIT, 90);
    parkOthers(m, [5]);
    litFire(m, x, y, 0);
    for (let i = 0; i < GRENADES.molotov.durationTicks - 1; i++) m.step();
    expect(m.fires.length).toBe(1);
    m.step();
    expect(m.fires.length).toBe(0);
    expect(m.players[5].hp).toBe(100);
  });

  it('燃燒瓶落地才點火（飛行中不點）', () => {
    const { m, g, ticks: n } = throwAndLand(40, 270, 'molotov');
    expect(g.moving).toBe(false);
    expect(n).toBeLessThan(GRENADES.molotov.fuseTicks);
    expect(m.projectiles.length).toBe(0);
    expect(m.fires.length).toBe(1);
    expect(m.fires[0].y).toBe(g.y);
    expect(at(106, 90)[1] - m.fires[0].y).toBe(10 * UNIT);
  });

  it('飛超過引信上限（1 秒）就在空中點火', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    parkOthers(m, [0]);
    m.players[0].grenades = ['molotov'];
    m.applyCommands(0, [{ type: 'throw', grenade: 'molotov', deg: 270, power: 100 }]);
    for (let i = 0; i <= GRENADES.molotov.fuseTicks; i++) m.step();
    expect(m.fires.length).toBe(1);
    expect(y - m.fires[0].y).toBe(GRENADES.molotov.fuseTicks * GRENADE_RULES.flySpeed);
  });
});

describe('道具聲音', () => {
  it('grenadeLand 15 格內聽得到、explosion 60 格；方向量化、隊友標 friendly、投擲者自己不收', () => {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, 270);
    m.teleport(1, x - 3 * UNIT, y, 270);
    m.teleport(5, x, y - 20 * UNIT, 90); // 落點北方 10 格
    m.teleport(6, x, y - 40 * UNIT, 90); // 落點北方 30 格
    parkOthers(m, [0, 1, 5, 6]);
    m.players[0].grenades = ['flash'];
    m.applyCommands(0, [{ type: 'throw', grenade: 'flash', deg: 270, power: 40 }]);
    const heard: Record<number, SoundEvent[]> = { 0: [], 1: [], 5: [], 6: [], 7: [] };
    for (let i = 0; i < 60; i++) {
      m.step();
      if (m.isDecisionTick()) for (const pid of [0, 1, 5, 6, 7]) heard[pid].push(...m.observe(pid).sounds.filter((s) => s.kind === 'grenadeLand' || s.kind === 'explosion'));
    }
    const kinds = (pid: number): string[] => heard[pid].map((s) => s.kind);
    expect(kinds(5)).toEqual(['grenadeLand', 'explosion']);
    expect(heard[5].every((s) => s.dirDeg === 90 && s.range === 'near' && !s.friendly && s.weapon === null)).toBe(true);
    expect(kinds(6)).toEqual(['explosion']);
    expect(heard[6][0]).toMatchObject({ dirDeg: 90, range: 'far' });
    expect(kinds(1)).toEqual(['grenadeLand', 'explosion']);
    expect(heard[1].every((s) => s.friendly && s.dirDeg % SOUND.directionStepDeg === 0)).toBe(true);
    expect(heard[0]).toEqual([]);
    // 玩家 7 停在 CT 出生區，離爆點 60 格以上
    expect(heard[7]).toEqual([]);
    // 反彈也發 grenadeLand
    const b = throwAndLand(100, 0, 'flash');
    expect(b.g.bounces).toBe(1);
  });
});

describe('道具與確定性', () => {
  it('道具狀態計入雜湊', () => {
    const a = live();
    const b = live();
    expect(a.hash()).toBe(b.hash());
    a.projectiles.push({ kind: 'smoke', owner: 0, x: 1, y: 1, dx: 0, dy: 0, left: 0, bounces: 0, moving: false, fuseTick: a.tick + 10 });
    expect(a.hash()).not.toBe(b.hash());
    const c = live();
    fullSmoke(c, 1000, 1000);
    expect(c.hash()).not.toBe(b.hash());
    const d = live();
    litFire(d, 1000, 1000, 0);
    expect(d.hash()).not.toBe(b.hash());
    const e = live();
    e.players[0].throwCd = 3;
    expect(e.hash()).not.toBe(b.hash());
  });
});

describe('道具（驗收情境）', () => {
  for (const s of GRENADE_SCENARIOS) {
    it(`${s.id} ${s.name}：${s.expect}`, () => {
      const r = s.run();
      expect(r.pass, r.detail).toBe(true);
    });
  }
});

describe('投擲方向夾視錐（v0.4）', () => {
  /** 玩家 0 在 A 長面向 facing，往 deg 丟煙霧；回傳投射物的方向向量換算的角度（整數度） */
  function throwDir(facing: number, deg: number, scoped = false): number {
    const m = live();
    const [x, y] = at(106, 90);
    m.teleport(0, x, y, facing);
    parkOthers(m, [0]);
    m.players[0].grenades = ['smoke'];
    if (scoped) m.players[0].scoped = true;
    m.applyCommands(0, [{ type: 'throw', grenade: 'smoke', deg, power: 50 }]);
    const g = m.projectiles[0];
    return (iatan2(g.dy, g.dx) + 360) % 360;
  }

  it('視錐內照原方向丟', () => {
    expect(throwDir(270, 270)).toBe(270);
    expect(throwDir(270, 300)).toBe(300);
    expect(throwDir(270, 220)).toBe(220);
    // 剛好在邊界（±50°）
    expect(throwDir(270, 320)).toBe(320);
    expect(throwDir(270, 220)).toBe(220);
  });

  it('背後與視錐外夾到邊界（不拒絕）', () => {
    // 面北（270）往南（90）丟：正背後，夾到 ±50° 之一
    expect([220, 320]).toContain(throwDir(270, 90));
    // 往東（0）丟：偏右 90°，夾到 320
    expect(throwDir(270, 0)).toBe(320);
    // 往西（180）丟：偏左 90°，夾到 220
    expect(throwDir(270, 180)).toBe(220);
    // 跨 0° 的情況：面東（0）往 300 丟（偏 −60°）→ 310
    expect(throwDir(0, 300)).toBe(310);
  });

  it('開鏡時用開鏡視錐（30°）', () => {
    expect(throwDir(270, 0, true)).toBe(285);
  });
});

describe('人類控制器（v0.4）', () => {
  it('realtime 指令每個 tick 套用、按實際 tick 錄進回放，重播雜湊相同', () => {
    const seed = 21;
    const human = new ShooterHumanController();
    const controllers = practiceControllers(seed);
    controllers[2] = human;
    const d = new ShooterDriver({ mapId: 'dust', seed, controllers, record: true, roundsPerHalf: 2, winRounds: 3 });
    const applied: number[] = [];
    let n = 0;
    while (!d.match.over && n < 40000) {
      const m = d.match;
      const me = m.players[2];
      // 模擬人類：每 tick 都下指令（瞄準點畫圓、每 7 tick 換移動方向、每 11 tick 開火／停火、偶爾購買與換槍）
      const t = m.tick;
      const cmds: unknown[] = [{ type: 'aim', x: me.x + ((t * 37) % 4000) - 2000, y: me.y + ((t * 53) % 4000) - 2000 }];
      if (t % 7 === 0) cmds.push({ type: 'moveDir', deg: (t * 13) % 360 });
      if (t % 11 === 0) cmds.push({ type: 'fire', on: t % 22 === 0 });
      if (t % 97 === 0) cmds.push({ type: 'buy', items: ['armor', 'smg', 'flash'] });
      if (t % 41 === 0) cmds.push({ type: 'switch', slot: t % 82 === 0 ? 'secondary' : 'primary' });
      if (t % 13 === 0) cmds.push({ type: 'walk', on: t % 26 === 0 });
      human.enqueue(cmds as never);
      const aimBefore = me.aimX;
      d.step();
      if (me.alive && aimBefore !== me.aimX) applied.push(t);
      n += 1;
    }
    // 非決策 tick 也有套用
    expect(applied.some((t) => t % 3 !== 0)).toBe(true);
    const rp = d.replay!;
    const humanTicks = rp.decisions.filter((x) => x.playerId === 2).map((x) => x.tick);
    expect(humanTicks.some((t) => t % 3 === 1)).toBe(true);
    expect(humanTicks.some((t) => t % 3 === 2)).toBe(true);
    // 重播
    const final = d.match.hash();
    const re = runShooterReplay(rp);
    expect(re.desyncTick).toBeNull();
    expect(re.finalHash).toBe(final);
  });

  it('decide 回傳空陣列；takeRealtime 取完即清空', () => {
    const h = new ShooterHumanController();
    h.enqueue([{ type: 'reload' }]);
    expect(h.decide({} as ShooterObservation).value).toEqual([]);
    expect(h.takeRealtime()).toEqual([{ type: 'reload' }]);
    expect(h.takeRealtime()).toEqual([]);
  });
});

describe('視野距離與矮牆（v0.5）', () => {
  it('不開鏡 30 格外看不見；開鏡看得到 40 格外，但視角只有 30°', () => {
    const m = live({ defaultLoadout: { T: 'awp' } });
    const [x, y] = at(106, 100);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 29 * UNIT, 90);
    m.teleport(6, x + 2 * UNIT, y - 40 * UNIT, 90);
    m.teleport(7, x - 4 * UNIT, y - 5 * UNIT, 90); // 正前方偏左 39°：視錐 100° 內、30° 外
    parkOthers(m, [0, 5, 6, 7]);
    expect(VISION.viewRange).toBe(30);
    expect(m.observe(0).enemies.map((e) => e.id).sort()).toEqual([5, 7]);
    m.applyCommands(0, [{ type: 'scope', on: true }]);
    m.step();
    expect(m.observe(0).enemies.map((e) => e.id).sort()).toEqual([5, 6]);
    // 開鏡的人被看見的距離不變：40 格外沒開鏡的人看不到他
    expect(m.canSee(6, 0)).toBe(false);
    expect(m.canSee(5, 0)).toBe(true);
  });

  /** A 長：0 在南面北、5 在北 10 格面南，5 的南邊 1 格有一排矮牆 */
  function coverSetup(): ShooterMatch {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 10 * UNIT, 90);
    parkOthers(m, [0, 5]);
    for (let cx = 100; cx < 112; cx++) m.map.solid[71 * m.map.width + cx] = 2;
    return m;
  }

  it('兩邊都站著：矮牆不擋視線也不擋子彈', () => {
    const m = coverSetup();
    expect(m.canSee(0, 5)).toBe(true);
    expect(m.canSee(5, 0)).toBe(true);
    m.applyCommands(0, [{ type: 'aim', x: m.players[5].x, y: m.players[5].y }, { type: 'fire', on: true }]);
    m.step();
    expect(m.players[5].hp).toBeLessThan(100);
  });

  it('蹲在矮牆後：雙方互相看不見，子彈打不到他，他開槍會打在矮牆上', () => {
    const m = coverSetup();
    m.applyCommands(5, [{ type: 'crouch', on: true }]);
    m.step();
    expect(m.canSee(0, 5)).toBe(false);
    expect(m.canSee(5, 0)).toBe(false);
    m.applyCommands(0, [{ type: 'aim', x: m.players[5].x, y: m.players[5].y }, { type: 'fire', on: true }]);
    m.step();
    expect(m.players[5].hp).toBe(100);
    m.applyCommands(5, [{ type: 'aim', x: m.players[0].x, y: m.players[0].y }, { type: 'fire', on: true }]);
    m.step();
    expect(m.players[0].hp).toBe(100);
  });

  it('蹲著但離矮牆遠：矮牆不擋', () => {
    const m = coverSetup();
    m.applyCommands(0, [{ type: 'crouch', on: true }]);
    m.step();
    expect(m.canSee(0, 5)).toBe(true);
    expect(m.canSee(5, 0)).toBe(true);
  });

  it('矮牆擋移動，道具飛得過去', () => {
    const m = coverSetup();
    m.applyCommands(0, [{ type: 'moveDir', deg: 270 }]);
    for (let i = 0; i < 120; i++) m.step();
    expect(m.players[0].y).toBeGreaterThan(72 * UNIT);
    const n = new ShooterMatch({ mapId: 'dust', seed: 3 });
    while (n.phase === 'freeze') n.step();
    for (let cx = 100; cx < 112; cx++) n.map.solid[71 * n.map.width + cx] = 2;
    const [x, y] = at(106, 80);
    n.teleport(0, x, y, 270);
    n.players[0].grenades = ['smoke'];
    n.applyCommands(0, [{ type: 'throw', grenade: 'smoke', deg: 270, power: 100 }]);
    for (let i = 0; i < 20; i++) n.step();
    expect(n.projectiles[0].y).toBeLessThan(71 * UNIT);
  });
});

describe('命中回饋（v0.5）', () => {
  function duel(): { m: ShooterMatch; x: number; y: number } {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 5 * UNIT, 90);
    parkOthers(m, [0, 5]);
    return { m, x, y };
  }

  it('打中看得見的敵人：子彈終點是他、hit = enemy；他收到受傷方向，也看得到槍口火光', () => {
    const { m, x, y } = duel();
    m.applyCommands(0, [{ type: 'aim', x, y: y - 5 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    const shots = m.observe(0).me.shots;
    expect(shots.length).toBe(1);
    expect(shots[0]).toMatchObject({ x: m.players[5].x, y: m.players[5].y, hit: 'enemy', kill: false });
    const o5 = m.observe(5);
    expect(o5.me.hurt.map((h) => h.dirDeg)).toEqual([90]);
    expect(o5.enemies.find((e) => e.id === 0)?.firing).toBe(true);
    for (let i = 0; i < 6; i++) m.step();
    expect(m.observe(0).me.shots).toEqual([]);
    expect(m.observe(5).enemies.find((e) => e.id === 0)?.firing).toBe(false);
  });

  it('打空：終點在牆上、hit = null', () => {
    const { m, x, y } = duel();
    m.applyCommands(0, [{ type: 'aim', x: x + 10 * UNIT, y }, { type: 'fire', on: true }]);
    for (let i = 0; i < 6; i++) m.step();
    m.applyCommands(0, [{ type: 'fire', on: true }]);
    m.step();
    const s = m.observe(0).me.shots.at(-1)!;
    expect(s.hit).toBeNull();
    // A 長東牆在 x = 112
    expect(Math.abs(s.x - 112 * UNIT)).toBeLessThan(400);
  });

  it('打中看不見的人（致盲中）：當作沒打中，不給命中、傷害、位置', () => {
    const { m, x, y } = duel();
    m.players[0].blindTicks = 200;
    m.applyCommands(0, [{ type: 'aim', x, y: y - 5 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    const s = m.observe(0).me.shots[0];
    expect(m.players[5].hp).toBeLessThan(100);
    expect(s).toMatchObject({ hit: null, kill: false, damage: 0 });
    expect(s.y).toBeLessThan(m.players[5].y - 5 * UNIT);
  });

  it('擊殺那一發 kill = true', () => {
    const { m, x, y } = duel();
    m.players[5].hp = 1;
    m.applyCommands(0, [{ type: 'aim', x, y: y - 5 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    expect(m.observe(0).me.shots[0].kill).toBe(true);
    expect(m.players[5].alive).toBe(false);
  });
});

describe('別人的子彈與彈藥補充（v0.5）', () => {
  it('隊友開槍：隊友看得到彈道與槍口火光；敵人看得見開槍的人才有彈道，看不見就沒有', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(1, x + 2 * UNIT, y + 3 * UNIT, 270); // 隊友在後面
    m.teleport(5, x, y - 8 * UNIT, 90); // 面向 0：看得見
    m.teleport(6, x + 3 * UNIT, y - 12 * UNIT, 270); // 背對：看不見
    parkOthers(m, [0, 1, 5, 6]);
    m.players[5].hp = 1000;
    m.applyCommands(0, [{ type: 'aim', x, y: y - 8 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    const mate = m.observe(1);
    expect(mate.tracers.length).toBe(1);
    expect(mate.tracers[0]).toMatchObject({ x0: x, y0: y, friendly: true });
    expect(mate.teammates.find((t) => t.id === 0)?.firing).toBe(true);
    const seen = m.observe(5);
    expect(seen.tracers.length).toBe(1);
    expect(seen.tracers[0]).toMatchObject({ x1: m.players[5].x, y1: m.players[5].y, friendly: false });
    expect(m.observe(6).tracers).toEqual([]);
    expect(m.observe(0).tracers).toEqual([]);
  });

  it('打中看不見的人：別人看到的彈道只畫到撞牆處', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(1, x - 3 * UNIT, y, 90); // 隊友面南：看得到 0 開槍（同隊一律算），看不到北邊中彈的 5
    m.teleport(5, x, y - 8 * UNIT, 0);
    parkOthers(m, [0, 1, 5]);
    m.players[5].hp = 1000;
    m.applyCommands(0, [{ type: 'aim', x, y: y - 8 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    const t = m.observe(1).tracers[0];
    expect(m.players[5].hp).toBeLessThan(1000);
    expect(t.y1).toBeLessThan(m.players[5].y - 5 * UNIT);
  });

  it('彈藥不自動補；買彈藥補滿主武器與手槍的備彈，都滿就不扣錢', () => {
    const m = live({ defaultLoadout: { T: 'ak' } });
    const p = m.players[0];
    p.primary!.mag = 3;
    p.primary!.reserve = 10;
    p.secondary!.reserve = 5;
    for (let i = TEAM_SIZE; i < PLAYER_COUNT; i++) m.kill(i);
    while (m.roundNumber === 1) m.step();
    expect(p.primary).toMatchObject({ mag: 3, reserve: 10 });
    const money = p.money;
    m.applyCommands(0, [{ type: 'buy', items: ['ammo'] }]);
    expect(p.primary!.reserve).toBe(WEAPONS.ak.reserve);
    expect(p.secondary!.reserve).toBe(WEAPONS.pistol.reserve);
    expect(p.money).toBe(money - AMMO.price);
    m.applyCommands(0, [{ type: 'buy', items: ['ammo'] }]);
    expect(p.money).toBe(money - AMMO.price);
  });

  it('開鏡視野上限 60 格：70 格外開鏡也看不見', () => {
    const m = live({ defaultLoadout: { T: 'awp' } });
    const [x, y] = at(106, 104);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 55 * UNIT, 90);
    m.teleport(6, x, y - 66 * UNIT, 90);
    parkOthers(m, [0, 5, 6]);
    m.applyCommands(0, [{ type: 'scope', on: true }]);
    m.step();
    expect(VISION.scopedViewRange).toBe(60);
    const ids = m.observe(0).enemies.map((e) => e.id);
    expect(ids).toContain(5);
    expect(ids).not.toContain(6);
  });
});

describe('傷害數字與手雷掩護（v0.5）', () => {
  it('me.shots 帶實際扣血；擊殺那一發只算到剩餘血量', () => {
    const m = live();
    const [x, y] = at(106, 80);
    m.teleport(0, x, y, 270);
    m.teleport(5, x, y - 5 * UNIT, 90);
    parkOthers(m, [0, 5]);
    m.applyCommands(0, [{ type: 'aim', x, y: y - 5 * UNIT }, { type: 'fire', on: true }]);
    m.step();
    expect(m.observe(0).me.shots[0].damage).toBe(damageAt(WEAPONS.pistol, 5 * UNIT));
    for (let i = 0; i < 12; i++) m.step();
    m.players[5].hp = 4;
    m.applyCommands(0, [{ type: 'fire', on: true }]);
    m.step();
    const s = m.observe(0).me.shots.at(-1)!;
    expect(s).toMatchObject({ kill: true, damage: 4 });
  });

  it('手雷：蹲在矮牆後（2 格內）不受傷，站著照扣', () => {
    const run = (crouch: boolean): number => {
      const m = live();
      const [x, y] = at(106, 80);
      m.teleport(0, x, y, 270);
      parkOthers(m, [0]);
      for (let cx = 100; cx < 112; cx++) m.map.solid[79 * m.map.width + cx] = 2;
      if (crouch) m.applyCommands(0, [{ type: 'crouch', on: true }]);
      pop(m, 'he', 5, x, y - 2 * UNIT);
      return m.players[0].hp;
    };
    expect(run(true)).toBe(100);
    expect(run(false)).toBe(100 - heDamageAt(2000));
  });
});

describe('陪練 Bot v4（v0.5）', () => {
  it('錢夠時隊內 4 號買狙擊槍，架點時開鏡', () => {
    const map = MAPS.redrock();
    const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(practice, 'shooter-practice.js', 3, pid, map));
    const d = new ShooterDriver({ seed: 3, controllers, record: false, roundMoney: [16000, 16000], roundsPerHalf: 2, winRounds: 3 });
    let awp = false;
    let scoped = false;
    for (let i = 0; i < 20000 && !d.match.over; i++) {
      d.step();
      const p = d.match.players[4];
      if (p.primary?.id === 'awp') awp = true;
      if (p.scoped) scoped = true;
    }
    expect(awp).toBe(true);
    expect(scoped).toBe(true);
  });
});
