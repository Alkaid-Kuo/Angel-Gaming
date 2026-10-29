// @ts-check
// 道具（戰術層的一部分）：戰術層每次決策提出「想丟什麼到哪裡」，這裡負責算彈道、轉向、丟出去。
// 彈道只用地圖資料與規則：照引擎的飛法模擬（每 tick 走 flySpeed、先 x 後 y、碰牆反彈，只看牆，矮牆飛得過去），力道 = 距離 ／ 最遠投擲距離；
// 只丟一路碰不到牆的（落點與目標差 1.2 格內），丟不到就不丟（由戰術層換位置或放棄）。
// 閃光：丟之前檢查隊友（爆點附近 P.flashMateClear 格內有看得到爆點的隊友就不丟），丟了就喊「E:flash x y 爆炸 tick」，
// 自己轉身背對爆點到爆完；隊友收到後看得到爆點的也轉身（戰術層處理）。
import { P, UNIT, adiff, angleTo, cosd, dist, sind } from './base.js';

/** @typedef {{ kind: import('./base.js').GrenadeId, x: number, y: number, why: string }} ThrowWish */
/** @typedef {{ cmds: import('./base.js').Command[], look: import('./base.js').Pt | null, stop: boolean, thrown: ThrowWish | null }} UtilOut */

export class Utility {
  /**
   * @param {import('./base.js').Grid} g @param {import('./base.js').InitData} data
   */
  constructor(g, data) {
    this.g = g;
    this.rules = data.rules;
    this.tps = data.rules.ticksPerSecond;
    this.range = data.rules.grenadeRules.maxThrowRange * UNIT;
    this.speed = data.rules.grenadeRules.flySpeed;
    /** @type {Map<string, number>} */
    this.fuse = new Map(data.grenades.map((n) => [n.id, n.fuseTicks]));
    this.flashR = (data.grenades.find((n) => n.id === 'flash')?.radius ?? 15 * UNIT);
    this.lastThrow = -1000000;
    /** 最後一次看到敵人的 tick（交戰剛結束時之前送出的移動指令還沒生效，不丟） */
    this.lastEnemy = -1000000;
    /** 自己丟的閃光：指令生效前（from）繼續看投擲方向，之後背對到 until @type {{ x: number, y: number, tx: number, ty: number, from: number, until: number } | null} */
    this.away = null;
    /** 本回合丟過的種類（每種每人一次） @type {Set<string>} */
    this.used = new Set();
    this.throws = 0;
  }

  reset() {
    this.lastThrow = -1000000;
    this.lastEnemy = -1000000;
    this.away = null;
    this.used = new Set();
  }

  /** 身上有這種道具、本回合還沒丟過 @param {import('./base.js').Observation['me']} me @param {import('./base.js').GrenadeId} kind */
  has(me, kind) {
    return me.loadout.grenades.includes(kind) && !this.used.has(kind);
  }

  /** 第一個身上有的種類 @param {import('./base.js').Observation['me']} me @param {import('./base.js').GrenadeId[]} kinds */
  pick(me, kinds) {
    return kinds.find((k) => this.has(me, k)) ?? null;
  }

  /**
   * 丟得到：照引擎的飛法（每 tick 走 flySpeed、先 x 後 y、碰牆反彈）模擬，路上完全不碰牆、落點離目標 1.2 格內才算；
   * 回傳整數方向、力道與落點，丟不到回傳 null
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by
   */
  solve(ax, ay, bx, by) {
    const d = dist(ax, ay, bx, by);
    if (d < 2 * UNIT || d > this.range) return null;
    const deg = angleTo(ax, ay, bx, by);
    const power = Math.max(1, Math.min(100, Math.round((d / this.range) * 100)));
    const land = this.fly(ax, ay, deg, power);
    if (land === null || dist(land.x, land.y, bx, by) > 1.2 * UNIT) return null;
    return { deg, power, x: land.x, y: land.y };
  }

  /** 模擬飛行；碰到牆回傳 null @param {number} ax @param {number} ay @param {number} deg @param {number} power */
  fly(ax, ay, deg, power) {
    const dx = Math.round(cosd(deg) * 10000);
    const dy = Math.round(sind(deg) * 10000);
    let x = ax;
    let y = ay;
    let left = Math.floor((power * this.range) / 100);
    for (let k = 0; k < 400 && left > 0; k++) {
      const step = Math.min(this.speed, left);
      const wx = Math.trunc((dx * step) / 10000);
      const wy = Math.trunc((dy * step) / 10000);
      if (this.hits(x + wx, y)) return null;
      x += wx;
      if (this.hits(x, y + wy)) return null;
      y += wy;
      left -= step;
    }
    return { x, y };
  }

  /** 半徑 0.12 格的圓碰到牆 @param {number} x @param {number} y */
  hits(x, y) {
    const g = this.g;
    const r = 120;
    for (let cy = Math.floor((y - r) / UNIT); cy <= Math.floor((y + r) / UNIT); cy++) {
      for (let cx = Math.floor((x - r) / UNIT); cx <= Math.floor((x + r) / UNIT); cx++) {
        if (!g.isWall(cx, cy)) continue;
        const nx = Math.max(cx * UNIT, Math.min(x, cx * UNIT + UNIT));
        const ny = Math.max(cy * UNIT, Math.min(y, cy * UNIT + UNIT));
        if ((nx - x) * (nx - x) + (ny - y) * (ny - y) <= r * r) return true;
      }
    }
    return false;
  }

  /**
   * 閃光會不會閃到隊友：爆點 P.flashMateClear 格內有看得到爆點的隊友、看得到爆點又最近在開火的隊友、或隊友正看著爆點附近的敵人，就不丟
   * @param {import('./base.js').Observation} obs @param {number} x @param {number} y @param {Set<number>} busy 最近在交戰的隊友
   */
  flashSafe(obs, x, y, busy) {
    // 隊友此刻看得到爆點附近的敵人（雷達）：他正對著爆點，不丟
    if (obs.radar.some((r) => dist(r.x, r.y, x, y) < this.flashR)) return false;
    for (const m of obs.teammates) {
      if (!m.alive) continue;
      if (!this.g.los(m.x, m.y, x, y)) continue;
      const d = dist(m.x, m.y, x, y);
      if (d < P.flashMateClear * UNIT) return false;
      // 最近在開火的隊友（交戰中轉不開）
      if (busy.has(m.id) && d < this.flashR) return false;
    }
    return true;
  }

  /**
   * 每次決策：處理戰術層這次的願望（最多一個）。要轉向就回傳 look；朝向對了就丟
   * @param {import('./base.js').Observation} obs @param {ThrowWish | null} wish @param {Set<number>} busy 最近在交戰的隊友 @returns {UtilOut}
   */
  step(obs, wish, busy) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {UtilOut} */
    const out = { cmds: [], look: null, stop: false, thrown: null };
    if (obs.enemies.length > 0) this.lastEnemy = t;
    // 自己丟的閃光：背對爆點
    if (this.away !== null) {
      if (t > this.away.until) this.away = null;
      else {
        // 丟出的指令要等反應延遲才生效：這段時間繼續看投擲方向（免得方向被夾到視錐邊界）
        out.look = t < this.away.from ? { x: this.away.tx, y: this.away.ty } : { x: me.x + (me.x - this.away.x) * 2, y: me.y + (me.y - this.away.y) * 2 };
        return out;
      }
    }
    if (wish === null || obs.round.phase === 'freeze' || me.blindTicks > 0 || t - this.lastThrow < this.tps) return out;
    if (!this.has(me, wish.kind)) return out;
    // 看得到敵人時只丟手雷與燃燒（閃光、煙霧要在交戰前丟）
    if (obs.enemies.length > 0 && (wish.kind === 'flash' || wish.kind === 'smoke')) return out;
    const s = this.solve(me.x, me.y, wish.x, wish.y);
    if (s === null) return out;
    if (wish.kind === 'flash' && !this.flashSafe(obs, s.x, s.y, busy)) return out;
    out.look = { x: wish.x, y: wish.y };
    out.stop = true;
    // 方向要在視錐內（引擎會把視錐外的方向夾到邊界），留 15° 裕度；還在走就先停（指令延遲生效時位置會偏，窄處會撞牆反彈）
    const half = (me.scoped ? this.rules.scopedFovDeg : this.rules.fovDeg) / 2;
    if (Math.abs(adiff(s.deg, me.facing)) > half - 15 || Math.abs(me.vx) + Math.abs(me.vy) > 20) return out;
    if ((wish.kind === 'flash' || wish.kind === 'smoke') && t - this.lastEnemy <= 2 * this.rules.reactionTicks) return out;
    out.cmds.push({ type: 'throw', grenade: wish.kind, deg: s.deg, power: s.power });
    this.lastThrow = t;
    this.used.add(wish.kind);
    this.throws++;
    out.thrown = { ...wish, x: Math.round(s.x), y: Math.round(s.y) };
    if (wish.kind === 'flash') {
      const pop = t + this.rules.reactionTicks + (this.fuse.get('flash') ?? 45);
      this.away = { x: s.x, y: s.y, tx: wish.x, ty: wish.y, from: t + this.rules.reactionTicks + 1, until: pop + 3 };
      out.cmds.push({ type: 'say', text: `E:flash ${Math.round(s.x / 100)} ${Math.round(s.y / 100)} ${pop}` });
    } else if (wish.kind === 'smoke') out.cmds.push({ type: 'say', text: `E:smoke ${Math.round(s.x / 100)} ${Math.round(s.y / 100)}` });
    return out;
  }

  /** 閃光的影響範圍（座標單位） */
  get flashRadius() {
    return this.flashR;
  }
}
