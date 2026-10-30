// @ts-check
// 戰鬥層（每次決策）：目標選擇（威脅排序）、瞄準（預判自己的反應延遲＋會收斂的誤差）、開火節奏（點放、散佈門檻、
// 射程、隊友擋線）、停步、蹲（矮牆後與遠距離）、換彈與切手槍、狙擊開鏡、撤退到掩體、被閃後退、道具與火的自保，
// 以及沒看到敵人時看哪裡（雷達 → 受傷方向 → 聲音扇形 → 記憶 → 探頭 → 守位掃描 → 前方窄口 → 行進方向）。
import { P, UNIT, adiff, angleTo, clamp, cosd, dist, lerp, segDist, sind } from './base.js';

/**
 * 交戰結果：aim 瞄準點、fire 開火、move（'stop'、座標或 null＝交給導航）、crouch（null＝不管）、holdNav（暫停導航架槍）
 * @typedef {{ engaged: boolean, aim: import('./base.js').Pt | null, fire: boolean, move: 'stop' | import('./base.js').Pt | null, crouch: boolean | null, holdNav: boolean, cmds: import('./base.js').Command[], why: string }} Fight
 */

const HALF_ANGLE_K = 300 * 5730;

export class Combat {
  /**
   * @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./memory.js').Perception} perc @param {import('./nav.js').Navigator} nav
   * @param {Record<import('./base.js').AttributeKey, number>} attrs 0～1
   * @param {import('./base.js').InitData} data @param {import('./base.js').Helpers} h
   */
  constructor(g, intel, perc, nav, attrs, data, h) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.nav = nav;
    this.attrs = attrs;
    this.h = h;
    this.rules = data.rules;
    this.tps = data.rules.ticksPerSecond;
    /** @type {Map<string, import('./base.js').WeaponInfo>} */
    this.weapons = new Map(data.weapons.map((w) => [w.id, w]));
    this.err0 = lerp(P.aimErr0, P.aimErr100, attrs.aim) * UNIT;
    this.conv = lerp(P.aimConv0, P.aimConv100, attrs.aim);
    this.reactExtra = Math.round(lerp(P.react0, P.react100, attrs.reaction));
    this.soundReact = Math.round(lerp(3, 0, attrs.reaction));
    this.lead = data.rules.reactionTicks + P.leadExtra;
    this.retreatHp = lerp(P.retreatHp0, P.retreatHp100, attrs.aggression);
    this.outnumber = Math.floor(lerp(P.outnumber0, P.outnumber100, attrs.aggression) + 1e-9);
    this.holdAngle = Math.round(lerp(P.holdAngle0, P.holdAngle100, attrs.aggression) * this.tps);
    this.sloppy = lerp(P.sloppyStop0, P.sloppyStop100, attrs.movement);
    this.scanEvery = Math.round(lerp(14, 5, attrs.awareness));
    this.friendClear = lerp(P.friendClear0, P.friendClear100, attrs.discipline);
    this.firm = attrs.discipline * 100 >= P.holdFirm;
    this.targetId = -1;
    this.seen = 0;
    this.errX = 0;
    this.errY = 0;
    this.lostTick = -1000000;
    /** @type {import('./base.js').Pt | null} */
    this.lostPos = null;
    this.blocked = 0;
    this.pistolUntil = -1;
    /** @type {import('./base.js').Pt | null} */
    this.retreat = null;
    this.retreatUntil = -1;
    this.engagedDecisions = 0;
    this.scanIdx = 0;
    this.scanLeft = 0;
    this.soundSeen = -1;
    this.soundWait = 0;
    /** 走過的位置（被閃時退回）：每 0.5 秒記一次 @type {import('./base.js').Pt[]} */
    this.trail = [];
    this.trailTick = -1000000;
    /** 被閃時要退回的點 @type {import('./base.js').Pt | null} */
    this.blindBack = null;
  }

  reset() {
    this.targetId = -1;
    this.seen = 0;
    this.errX = 0;
    this.errY = 0;
    this.lostTick = -1000000;
    /** @type {import('./base.js').Pt | null} */
    this.lostPos = null;
    this.blocked = 0;
    this.pistolUntil = -1;
    /** @type {import('./base.js').Pt | null} */
    this.retreat = null;
    this.retreatUntil = -1;
    this.engagedDecisions = 0;
    this.scanIdx = 0;
    this.scanLeft = 0;
    this.soundSeen = -1;
    this.soundWait = 0;
    /** 走過的位置（被閃時退回）：每 0.5 秒記一次 @type {import('./base.js').Pt[]} */
    this.trail = [];
    this.trailTick = -1000000;
    /** 被閃時要退回的點 @type {import('./base.js').Pt | null} */
    this.blindBack = null;
  }

  /** @param {string} id */
  weapon(id) {
    return this.weapons.get(id);
  }

  /** 目前姿勢的基礎散佈 @param {import('./base.js').Observation['me']} me @param {import('./base.js').WeaponInfo} w @param {boolean} still @param {boolean} crouch */
  baseSpread(me, w, still, crouch) {
    const base = me.scoped && w.scopedSpread !== null ? w.scopedSpread : w.spread;
    const mul = crouch ? 0.7 : still ? 1 : me.walking ? 1.2 : w.movingMul;
    return base * mul;
  }

  /** 記錄走過的位置 @param {import('./base.js').Observation} obs */
  track(obs) {
    const me = obs.me;
    if (obs.tick - this.trailTick < this.tps / 2) return;
    const last = this.trail[this.trail.length - 1];
    if (last !== undefined && dist(last.x, last.y, me.x, me.y) < 600) return;
    this.trailTick = obs.tick;
    this.trail.push({ x: me.x, y: me.y });
    if (this.trail.length > 8) this.trail.shift();
  }

  /**
   * 自保：火區、腳邊的手雷／燃燒、被閃。回傳要走去的點與要不要蹲；沒事回傳 null
   * @param {import('./base.js').Observation} obs
   * @returns {{ move: import('./base.js').Pt | null, crouch: boolean, why: string } | null}
   */
  evade(obs) {
    const me = obs.me;
    const g = this.g;
    // 站在火上：走到最近不著火的格
    /** @type {Set<number>} */
    const fire = new Set();
    for (const e of obs.effects) if (e.kind === 'fire' && e.cells !== undefined) for (const c of e.cells) fire.add(c);
    this.nav.hazard = fire;
    const mine = g.cellOf(me.x, me.y);
    if (fire.has(mine)) {
      const p = this.nav.escape(obs, (i) => fire.has(i), 10);
      if (p !== null) return { move: p, crouch: false, why: '離開火區' };
    }
    // 手雷、燃燒的落點在 P.nadeAvoid 格內
    for (const pr of obs.projectiles) {
      if (pr.kind !== 'he' && pr.kind !== 'molotov' && pr.kind !== 'incendiary') continue;
      if (dist(pr.x, pr.y, me.x, me.y) > P.nadeAvoid * UNIT) continue;
      const r = (P.nadeAvoid + 1) * UNIT;
      const p = this.nav.escape(obs, (i) => {
        const c = g.center(i);
        return dist(c.x, c.y, pr.x, pr.y) < r || fire.has(i);
      }, 9);
      if (p !== null) return { move: p, crouch: false, why: '躲道具' };
    }
    // 被閃：退回上一個走過的點（≥ 2.5 格外），到了就蹲
    if (me.blindTicks <= 0) this.blindBack = null;
    else {
      if (this.blindBack !== null) {
        if (dist(me.x, me.y, this.blindBack.x, this.blindBack.y) < 600) return { move: null, crouch: true, why: '被閃・蹲' };
        return { move: this.blindBack, crouch: false, why: '被閃・後退' };
      }
      let back = null;
      for (let i = this.trail.length - 1; i >= 0; i--) {
        const p = this.trail[i];
        if (dist(p.x, p.y, me.x, me.y) >= 2500 && g.walkLine(me.x, me.y, p.x, p.y)) {
          back = p;
          break;
        }
      }
      if (back === null) {
        const th = this.perc.nearestThreat(me.x, me.y);
        const dir = th !== null ? th.dir + 180 : me.facing + 180;
        const p = this.nav.escape(obs, (i) => {
          const c = g.center(i);
          return dist(c.x, c.y, me.x, me.y) < 2500 || Math.abs(adiff(angleTo(me.x, me.y, c.x, c.y), dir)) > 60;
        }, 5);
        back = p;
      }
      if (back === null) return { move: null, crouch: true, why: '被閃・原地蹲' };
      this.blindBack = back;
      return { move: back, crouch: false, why: '被閃・後退' };
    }
    return null;
  }

  /**
   * 交戰
   * @param {import('./base.js').Observation} obs
   * @param {{ holding: boolean, objective: boolean }} ctx holding＝守位中；objective＝下包／拆包中（不開槍不移動）
   * @returns {Fight}
   */
  engage(obs, ctx) {
    const me = obs.me;
    const t = obs.tick;
    /** @type {Fight} */
    const out = { engaged: false, aim: null, fire: false, move: null, crouch: null, holdNav: false, cmds: [], why: '' };
    for (const s of me.shots) if (s.kill && this.targetId >= 0) this.perc.forget(this.targetId);
    const vis = obs.enemies;
    if (vis.length === 0) return this.noEnemy(obs, out, ctx);
    // ── 目標：威脅排序 ──
    let best = vis[0];
    let bestS = -Infinity;
    for (const e of vis) {
      const d = dist(me.x, me.y, e.x, e.y) / UNIT;
      let s = 100 - 2.5 * d;
      if (Math.abs(adiff(e.facing, angleTo(e.x, e.y, me.x, me.y))) < 25) s += 25;
      if (e.weapon === 'awp') s += 10;
      if (e.planting || e.defusing) s += 40;
      if (e.firing) s += 10;
      if (e.id === this.targetId) s += 15;
      if (s > bestS) {
        bestS = s;
        best = e;
      }
    }
    const e = best;
    out.engaged = true;
    this.engagedDecisions++;
    if (e.id !== this.targetId) {
      this.targetId = e.id;
      this.seen = 0;
      const a = Math.floor(this.h.random() * 360);
      const mag = this.err0 * (0.6 + 0.8 * this.h.random());
      this.errX = cosd(a) * mag;
      this.errY = sind(a) * mag;
    } else {
      this.seen++;
      const moving = Math.abs(me.vx) + Math.abs(me.vy) > 30;
      const k = moving ? Math.sqrt(this.conv) : this.conv;
      this.errX *= k;
      this.errY *= k;
    }
    this.lostTick = t;
    // 預判：對方在我的指令生效時的位置
    const k = this.perc.known.get(e.id);
    let vx = k?.vx ?? 0;
    let vy = k?.vy ?? 0;
    const sp = Math.sqrt(vx * vx + vy * vy);
    if (sp > 200) {
      vx = (vx * 200) / sp;
      vy = (vy * 200) / sp;
    }
    const px = e.x + vx * this.lead;
    const py = e.y + vy * this.lead;
    this.lostPos = { x: px, y: py };
    const aim = { x: Math.round(px + this.errX), y: Math.round(py + this.errY) };
    out.aim = aim;
    const d = dist(me.x, me.y, e.x, e.y);
    const dc = d / UNIT;
    if (ctx.objective) {
      out.why = '下包／拆包中';
      return out;
    }
    // ── 武器 ──
    const primary = me.loadout.primary;
    const secondary = me.loadout.secondary;
    const wid = me.weapon;
    if (wid === 'knife' && (primary !== null || secondary !== null) && dc > 2) {
      out.cmds.push({ type: 'switch', slot: primary !== null ? 'primary' : 'secondary' });
      out.why = '拔槍';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    const w = this.weapon(wid);
    if (w === undefined) return out;
    if (wid === 'awp' && dc < P.awpClose && secondary !== null && me.weapon !== secondary) {
      out.cmds.push({ type: 'switch', slot: 'secondary' });
      this.pistolUntil = t + 3 * this.tps;
      out.why = '近距離切手槍';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    if (me.ammoMag === 0 && w.magazine > 0) {
      if (wid === primary && secondary !== null && dc < P.pistolSwitch) {
        out.cmds.push({ type: 'switch', slot: 'secondary' });
        this.pistolUntil = t + 3 * this.tps;
        out.why = '沒子彈・切手槍';
        return this.finishMove(obs, out, e, false, d, ctx);
      }
      if (me.ammoReserve > 0 && me.reloadTicksLeft === 0) out.cmds.push({ type: 'reload' });
      out.why = '換彈';
      return this.finishMove(obs, out, e, false, d, ctx, true);
    }
    // ── 能不能開火 ──
    const inRange = wid === 'knife' ? dc <= 1.4 : dc <= w.range;
    if (!inRange) {
      // 守位中而且紀律高：不離開守位去追
      if (ctx.holding && this.firm) {
        out.why = '射程外・守位不追';
        return out;
      }
      out.why = '射程外・接近';
      out.move = { x: e.x, y: e.y };
      return out;
    }
    // 隊友在彈道上（自己在走的話，加上反應延遲內會走的距離：開火時位置已經變了）
    let block = false;
    const drift = (Math.abs(me.vx) + Math.abs(me.vy)) * this.rules.reactionTicks;
    for (const m of obs.teammates) {
      if (!m.alive) continue;
      const s = segDist(m.x, m.y, me.x, me.y, aim.x, aim.y);
      if (s.t > 0 && s.t < 1 && s.d < this.friendClear + drift) block = true;
    }
    if (block) {
      this.blocked++;
      out.why = '隊友擋線';
      if (this.blocked >= 2 && !ctx.holding) {
        const side = this.sidestep(obs, aim);
        if (side !== null) {
          out.move = side;
          return out;
        }
      }
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    this.blocked = 0;
    if (this.seen < this.reactExtra) {
      out.why = '反應中';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    if (me.reloadTicksLeft > 0 && wid !== 'shotgun') {
      out.why = '換彈中';
      return this.finishMove(obs, out, e, false, d, ctx, true);
    }
    // 狙擊：先開鏡，下一次決策才開火；誤差收斂才開
    if (w.scopedSpread !== null && !me.scoped) {
      out.cmds.push({ type: 'scope', on: true });
      out.why = '開鏡';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    const errMag = Math.sqrt(this.errX * this.errX + this.errY * this.errY);
    if (w.scopedSpread !== null && errMag > P.awpErr * UNIT) {
      out.why = '狙擊瞄準中';
      return this.finishMove(obs, out, e, false, d, ctx);
    }
    // 散佈門檻：停步後的散佈 ≤ 目標半張角 × K（至少允許基礎散佈）
    const lowWall = this.lowCoverNear(me.x, me.y, e.x, e.y);
    const wantCrouch = !lowWall && dc >= P.crouchFireMin;
    const still = Math.abs(me.vx) + Math.abs(me.vy) === 0;
    const recoil = Math.max(0, me.spread - this.baseSpread(me, w, still, me.crouching));
    const next = this.baseSpread(me, w, true, wantCrouch && me.crouching) + Math.max(0, recoil - w.fireTicks * 4);
    const half = HALF_ANGLE_K / Math.max(d, 500);
    const ok = next <= Math.max(half * P.fireSpreadK, w.spread * 1.05) || wid === 'shotgun' || wid === 'knife';
    out.fire = ok;
    out.why = ok ? '開火' : '等散佈';
    return this.finishMove(obs, out, e, ok, d, ctx);
  }

  /**
   * 交戰時的移動與蹲：撤退 → 停步（射程內） → 矮牆後沒開火就蹲
   * @param {import('./base.js').Observation} obs @param {Fight} out @param {import('./base.js').Enemy} e
   * @param {boolean} firing @param {number} d @param {{ holding: boolean, objective: boolean }} ctx @param {boolean} [weak]
   */
  finishMove(obs, out, e, firing, d, ctx, weak = false) {
    const me = obs.me;
    const t = obs.tick;
    // ── 撤退：血少而且打不到、1 對多沒隊友、沒子彈 ──
    const mateNear = obs.teammates.some((m) => m.alive && dist(m.x, m.y, me.x, me.y) < P.mateNear * UNIT);
    const outnumbered = obs.enemies.length >= this.outnumber && !mateNear;
    const lowHp = me.hp < this.retreatHp && (!firing || obs.enemies.length >= 2);
    if (outnumbered || lowHp || (weak && d > 4 * UNIT)) {
      if (this.retreat === null || t > this.retreatUntil) {
        this.retreat = this.nav.findCover(obs, obs.enemies.map((x) => ({ x: x.x, y: x.y })));
        this.retreatUntil = t + 3 * this.tps;
      }
      if (this.retreat !== null && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
        out.move = this.retreat;
        out.crouch = false;
        out.why += '・撤退';
        return out;
      }
    }
    // ── 停步：射程內停下來開火（走位差的偶爾晚一步停）──
    const lowWall = this.lowCoverNear(me.x, me.y, e.x, e.y);
    if (this.engagedDecisions <= 1 && this.h.random() < this.sloppy) out.move = null;
    else out.move = 'stop';
    // ── 蹲：矮牆後沒在開火就蹲下躲；遠距離開火蹲著開 ──
    if (lowWall) out.crouch = !firing;
    else out.crouch = firing && d >= P.crouchFireMin * UNIT;
    return out;
  }

  /** 自己到目標的線在自己 2 格內經過矮牆 @param {number} ax @param {number} ay @param {number} bx @param {number} by */
  lowCoverNear(ax, ay, bx, by) {
    const len = dist(ax, ay, bx, by);
    if (len < 1) return false;
    const r = Math.min(len, this.rules.lowCoverRange * UNIT);
    for (let s = 250; s <= r; s += 250) {
      const i = this.g.cellOf(ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len);
      if (i >= 0 && this.g.low[i] === 1) return true;
    }
    return false;
  }

  /** 隊友擋線：往側邊 1.5 格（可走、直線走得到） @param {import('./base.js').Observation} obs @param {import('./base.js').Pt} aim */
  sidestep(obs, aim) {
    const me = obs.me;
    const a = angleTo(me.x, me.y, aim.x, aim.y);
    for (const s of this.h.random() < 0.5 ? [90, -90] : [-90, 90]) {
      const x = me.x + cosd(a + s) * 1500;
      const y = me.y + sind(a + s) * 1500;
      if (this.g.walkable(this.g.cellOf(x, y)) && this.g.walkLine(me.x, me.y, x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  }

  /**
   * 沒看到敵人：剛丟失目標就架槍（守位中或侵略低時暫停導航）；矮牆後蹲著就站起來再探；受傷又看不到人就找掩體
   * @param {import('./base.js').Observation} obs @param {Fight} out @param {{ holding: boolean, objective: boolean }} ctx
   */
  noEnemy(obs, out, ctx) {
    const me = obs.me;
    const t = obs.tick;
    this.engagedDecisions = 0;
    this.blocked = 0;
    if (t - this.lostTick > this.tps / 2) this.targetId = -1;
    if (this.lostPos !== null && t - this.lostTick < this.holdAngle && !ctx.objective) {
      out.aim = this.lostPos;
      out.crouch = false;
      out.holdNav = ctx.holding || this.attrs.aggression < 0.5;
      out.why = '架槍（目標剛消失）';
      if (this.retreat !== null && t < this.retreatUntil && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
        out.move = this.retreat;
        out.why = '撤退中';
      }
      return out;
    }
    this.lostPos = null;
    // 受傷但看不到開槍的人：血不多就躲
    const hurt = this.perc.lastHurt;
    if (hurt !== null && t - hurt.tick < this.tps && me.hp < 60 && !ctx.objective) {
      const th = { x: me.x + cosd(hurt.dir) * 10 * UNIT, y: me.y + sind(hurt.dir) * 10 * UNIT };
      if (this.retreat === null || t > this.retreatUntil) {
        this.retreat = this.nav.findCover(obs, [th]);
        this.retreatUntil = t + 2 * this.tps;
      }
      if (this.retreat !== null && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
        out.move = this.retreat;
        out.why = '受傷・找掩體';
      }
    }
    return out;
  }

  /**
   * 沒交戰時的武器整理：切回主武器、換彈、狙擊鏡
   * @param {import('./base.js').Observation} obs @param {boolean} holding 站定守位
   * @returns {import('./base.js').Command[]}
   */
  upkeep(obs, holding) {
    const me = obs.me;
    /** @type {import('./base.js').Command[]} */
    const out = [];
    const primary = me.loadout.primary;
    if (primary !== null && me.weapon !== primary && obs.tick > this.pistolUntil) {
      out.push({ type: 'switch', slot: 'primary' });
      return out;
    }
    if (primary === null && me.weapon === 'knife' && me.loadout.secondary !== null) {
      out.push({ type: 'switch', slot: 'secondary' });
      return out;
    }
    const w = this.weapon(me.weapon);
    if (w === undefined || w.magazine === 0) return out;
    if (me.ammoMag < w.magazine * P.reloadBelow && me.ammoReserve > 0 && me.reloadTicksLeft === 0) out.push({ type: 'reload' });
    if (w.scopedSpread !== null && me.reloadTicksLeft === 0 && holding !== me.scoped) out.push({ type: 'scope', on: holding });
    return out;
  }

  /**
   * 沒看到敵人時看哪裡
   * @param {import('./base.js').Observation} obs
   * @param {{ hold: import('./analysis.js').Spot | null, holding: boolean, navLook: import('./base.js').Pt | null, ahead: import('./base.js').Pt | null }} ctx
   * @returns {import('./base.js').Pt | null}
   */
  look(obs, ctx) {
    const me = obs.me;
    const t = obs.tick;
    const g = this.g;
    // 1. 雷達：隊友此刻看到的敵人
    let best = null;
    let bestD = 30 * UNIT;
    for (const r of obs.radar) {
      const d = dist(me.x, me.y, r.x, r.y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best !== null) return { x: best.x, y: best.y };
    // 2. 受傷方向
    const hurt = this.perc.lastHurt;
    if (hurt !== null && t - hurt.tick < this.tps) return { x: me.x + cosd(hurt.dir) * 8 * UNIT, y: me.y + sind(hurt.dir) * 8 * UNIT };
    // 3. 敵方聲音（反應延遲後）
    const snd = this.perc.lastSound;
    if (snd !== null && t - snd.tick < this.tps) {
      if (this.soundSeen !== snd.tick) {
        this.soundSeen = snd.tick;
        this.soundWait = this.soundReact;
      }
      if (this.soundWait > 0) this.soundWait--;
      else {
        const r = clamp((snd.r0 + snd.r1) / 2, 4, 12);
        return { x: me.x + cosd(snd.dir) * r * UNIT, y: me.y + sind(snd.dir) * r * UNIT };
      }
    }
    // 4. 記得的敵人（3 秒內、25 格內、信心 ≥ 50）
    for (const th of this.perc.threats(me.x, me.y, 50)) {
      if (dist(me.x, me.y, th.x, th.y) > 25 * UNIT) break;
      const k = this.perc.known.get(th.id);
      if (k !== undefined && t - k.tick > 3 * this.tps) continue;
      return { x: th.x, y: th.y };
    }
    // 5. 探頭
    if (ctx.navLook !== null) return ctx.navLook;
    // 6. 守位：看守的入口，偶爾掃看得到的其他交界
    if (ctx.hold !== null && ctx.holding) {
      const hold = ctx.hold;
      if (--this.scanLeft <= 0) {
        this.scanLeft = this.scanEvery;
        this.scanIdx++;
      }
      /** @type {import('./base.js').Pt[]} */
      const views = [{ x: hold.fx, y: hold.fy }];
      for (const p of this.intel.portals) {
        if (views.length >= 3) break;
        const d = dist(p.x, p.y, hold.x, hold.y);
        if (d < 5 * UNIT || d > 25 * UNIT || !g.los(hold.x, hold.y, p.x, p.y)) continue;
        if (!this.perc.reachable(g.cellOf(p.x, p.y), t, 6)) continue;
        if (Math.abs(adiff(angleTo(hold.x, hold.y, p.x, p.y), angleTo(hold.x, hold.y, hold.fx, hold.fy))) < 20) continue;
        views.push({ x: p.x, y: p.y });
      }
      // 主要入口看久一點：三次裡兩次看主要入口
      const k = this.scanIdx % (views.length + 1);
      return k < 2 ? views[0] : views[k - 1];
    }
    // 7. 行進中：前方 15 格內看得到、敵人可能已到、沒清過的交界（威脅高的優先）
    let pick = null;
    let pickS = -Infinity;
    for (const p of this.intel.portals) {
      const d = dist(me.x, me.y, p.x, p.y);
      if (d < 2 * UNIT || d > 15 * UNIT) continue;
      const c = g.cellOf(p.x, p.y);
      if (!this.perc.reachable(c, t, 3) || this.perc.cleared(c, t)) continue;
      if (ctx.ahead !== null && Math.abs(adiff(angleTo(me.x, me.y, p.x, p.y), angleTo(me.x, me.y, ctx.ahead.x, ctx.ahead.y))) > 100) continue;
      if (!g.los(me.x, me.y, p.x, p.y)) continue;
      const s = this.perc.portalThreat[p.id] * 2 - d / UNIT + (p.choke ? 3 : 0);
      if (s > pickS) {
        pickS = s;
        pick = p;
      }
    }
    if (pick !== null) return { x: pick.x, y: pick.y };
    // 8. 行進方向
    return ctx.ahead;
  }
}
