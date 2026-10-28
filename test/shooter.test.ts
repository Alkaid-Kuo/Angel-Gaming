import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cdegDiff, iatan2, iatan2C, icosC, isinC } from '../src/shared/geom.ts';
import { iatan2 as legionIatan2 } from '../src/legion/geom.ts';
import { compileBot } from '../src/sandbox/compile.ts';
import { ECONOMY_SCENARIOS, SCENARIOS } from '../src/shooter/acceptance.ts';
import { ARMOR, DEFUSE_KIT, ECONOMY, FRIENDLY_FIRE_PCT, GRENADES, ROUND, SOUND, TEAM_SIZE, UNIT, VISION, WEAPONS } from '../src/shooter/config.ts';
import { applyPercent } from '../src/shared/intmath.ts';
import { MAPS, cellOf, isSolidCell } from '../src/shooter/map.ts';
import { circleHitsWall, findPath, sweptClear } from '../src/shooter/path.ts';
import { ScriptController, ShooterBatchController, ShooterDriver, runShooterMatch, runShooterReplay, type ShooterController } from '../src/shooter/runner.ts';
import { PLAYER_COUNT, ShooterMatch, TURN_STEP_C, armorSplit, damageAt, type ShooterMatchOptions } from '../src/shooter/sim.ts';
import { lineOfSight, quantizeDir, rayWallDistance, soundRange } from '../src/shooter/vision.ts';
import type { ShooterObservation, SoundEvent } from '../src/shooter/api.ts';

const map = MAPS.dust();
const practice = compileBot(readFileSync('bots/shooter-practice.js', 'utf8'), 'shooter-practice.js');

function practiceControllers(seed: number): ShooterController[] {
  return Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(practice, 'shooter-practice.js', seed, pid, map));
}

/** 跳過凍結時間 */
function live(opts: Partial<ShooterMatchOptions> = {}): ShooterMatch {
  const m = new ShooterMatch({ seed: 3, ...opts });
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
    const m = new ShooterMatch({ seed: 1 });
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
  const rich = (opts: Partial<ShooterMatchOptions> = {}): ShooterMatch => new ShooterMatch({ seed: 3, startMoney: 16000, ...opts });
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
    const m = new ShooterMatch({ seed: 3 });
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

  it('存活者保留武器、甲值、道具到下一回合；死亡者重發手槍＋刀；掉落物在回合交接時清除', () => {
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
    const d = new ShooterDriver({ seed: 1, controllers, record: false });
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
    const d = new ShooterDriver({ seed: 1, controllers, record: false });
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
    const m = new ShooterMatch({ seed: 1 });
    expect(m.players.filter((p) => p.team === 'T').length).toBe(TEAM_SIZE);
    for (const p of m.players) expect(isSolidCell(map, cellOf(p.x), cellOf(p.y))).toBe(false);
  });
});
