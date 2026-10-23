// @ts-check
// 軍團戰官方基準 AI：統帥。三層指揮：
//   指揮官（每 2 秒）：推估雙方兵力（含看不到的敵軍：對手最多 500 點，扣掉看到被殲滅的）、評估附近的敵軍集團，
//     決定姿態（集結、固守、迎擊、決戰、收攏、進攻、搜敵）與各戰鬥群的任務；佔點模式另外分派各旗的人手。
//   戰鬥群（每次決策）：戰線（槍兵居中、劍士兩翼，一起推進、只打戰線附近的敵人，依兵種相剋分配目標）、
//     火力（弓兵佔高處、集火與齊射，盾兵護送）、打擊（騎兵在側翼待命，敵人被纏住或露出側背才衝）、
//     斥候（偵察、獵落單弓兵、搶空旗）、護衛（敵人逼近弓兵時就近派兵攔截）、守旗。
//   兵種動作：沿用共用函式庫（槍林、突擊、弓兵後撤與集火、盾牆、斥候）。
import { LegionBase, TILE, TR } from './base.js';

/** @typedef {import('./base.js').Own} Own */
/** @typedef {import('./base.js').Enemy} Enemy */
/** @typedef {import('./base.js').Memory} Memory */
/** @typedef {import('./base.js').Pending} Pending */
/** @typedef {import('./base.js').PlanEntry} PlanEntry */
/** @typedef {import('./base.js').Declaration} Declaration */
/** @typedef {import('./base.js').InitData} InitData */
/** @typedef {import('./base.js').Helpers} Helpers */
/** @typedef {import('./base.js').Observation} Observation */
/** @typedef {import('./base.js').Pt} Pt */
/** @typedef {import('./base.js').UnitKind} UnitKind */
/** @typedef {import('../../src/legion/api.ts').FlagState} Flag */
/** @typedef {{ members: Memory[], x: number, y: number, pts: number, engaged: boolean, cav: number, spears: number }} Cluster */
/** @typedef {'集結' | '固守' | '迎擊' | '決戰' | '收攏' | '進攻' | '搜敵'} Posture */
/** @typedef {{ anchor: Pt, facing: number, mode: 'hold' | 'advance' | 'engage', leash: number, column: boolean }} LineMission */
/** 佯攻：目標長槍、誘餌、騎兵、開始的 tick、誘餌從長槍哪一側（+90／-90）、開始時長槍的朝向、誘餌到側面的 tick @typedef {{ spear: number, bait: number, cav: number, since: number, side: number, facing0: number, at?: number }} Feint */

export default class Commander extends LegionBase {
  constructor() {
    super();
    /** @type {Posture} */
    this.posture = '集結';
    this.stratAt = -100;
    this.planText = '';
    this.planSent = '';
    /** 戰場位置：己方這一側、中央渡口後方的河岸 */
    /** @type {Pt} */
    this.bp = { x: 0, y: 0 };
    /** @type {Pt} */
    this.crossing = { x: 0, y: 0 };
    this.inPositionAt = -1;
    /** 兵力推估：看到被殲滅的敵方點數、每團上次看到的人數 */
    this.killedPts = 0;
    /** @type {Map<number, number>} */
    this.lastMen = new Map();
    /** @type {Set<number>} */
    this.routedSeen = new Set();
    this.myPts = 0;
    this.enemyPts = 500;
    this.ratio = 1;
    /** @type {Cluster[]} */
    this.clusters = [];
    /** 戰線任務 @type {LineMission} */
    this.line = { anchor: { x: 0, y: 0 }, facing: 0, mode: 'hold', leash: 6, column: false };
    /** 被遠程壓制（掉血但沒在近戰）的累計 tick */
    this.pressure = 0;
    this.lastHp = -1;
    /** 佔點：各團負責的旗（團 id → 旗 id） @type {Map<number, number>} */
    this.flagJob = new Map();
    /** 本次決策中已被護衛或守旗占用的團 @type {Set<number>} */
    this.busyIds = new Set();
    /** 佔點：己方的橋、對方的橋 @type {Flag | null} */
    this.nearFlag = null;
    /** @type {Flag | null} */
    this.farFlag = null;
    this.lastTick = 0;
    /** 目前要對付的敵軍集團 @type {Cluster | null} */
    this.engageTarget = null;
    /** 進攻要走的渡口 @type {Pt | null} */
    this.attackCrossing = null;
    /** 佔點：得分競賽落後、兵力又不夠主攻時，派騎兵騷擾對方的橋 */
    this.raid = false;
    /** 搜敵找到目標後的接戰鎖定（tick）：在這之前打得過就直接打，不再顧慮看不到的敵軍 */
    this.huntLock = -1;
    /** 進行中的佯攻 @type {Feint | null} */
    this.feint = null;
    /** 上一次佯攻結束的 tick（隔 20 秒才再發動） */
    this.feintEnd = -1000;
  }

  /** @returns {Declaration} */
  declare() {
    return {
      name: '統帥',
      version: 'v1',
      style: '三層指揮：指揮官評估兵力與地形決定姿態，戰線一起推進、弓兵佔高處集火、騎兵等敵人被纏住再衝側背；佔點時分兵守旗與襲擾',
      knobs: [
        { key: 'style', name: '風格', description: '0 均衡、1 進攻（兵力稍弱也接戰）、2 防守（佔優才接戰）', min: 0, max: 2, default: 0, integer: true },
        { key: 'patience', name: '耐心', description: '在戰場位置等敵人來的時間（秒），之後主動進攻', min: 10, max: 180, default: 45, integer: true },
        { key: 'cavalry', name: '騎兵', description: '騎兵團數', min: 0, max: 2, default: 1, integer: true },
        { key: 'archers', name: '弓兵', description: '弓兵團數', min: 0, max: 3, default: 2, integer: true },
        { key: 'shieldWard', name: '盾兵護誰', description: '0 擋在弓兵前面擋箭；1 擋在長槍前面（盾槍陣：盾兵在前擋傷害，長槍越過盾兵刺人）', min: 0, max: 1, default: 0, integer: true },
      ],
    };
  }

  // ───────── 布陣 ─────────

  /**
   * @param {InitData} data
   * @param {Helpers} helpers
   */
  deploy(data, helpers) {
    this.setup(data, helpers);
    const k = data.knobs;
    const cav = k.cavalry ?? 1;
    const arch = k.archers ?? 2;
    /** @type {[UnitKind, string][]} */
    const wish = [['spear', 'line'], ['spear', 'line'], ['sword', 'line']];
    for (let i = 0; i < arch; i++) wish.push(['archer', 'fire']);
    if (arch > 0 || k.shieldWard === 1) wish.push(['shield', 'escort']);
    if (cav >= 1) wish.push(['heavyCav', 'strike']);
    if (cav >= 2) wish.push(['lightCav', 'strike']);
    wish.push(['light', 'screen']);
    wish.push(['sword', 'line']);
    wish.push(['sword', 'line'], ['light', 'screen'], ['spear', 'line']);
    const list = this.buy(wish, [['spear', 'line'], ['sword', 'line']]);
    let li = 0;
    let ai = 0;
    let ci = 0;
    let si = 0;
    const lineYs = [50, 42, 58, 34, 66, 26];
    /** @type {PlanEntry[]} */
    const plan = list.map((e) => {
      if (e.role === 'line') return { ...e, tx: 16, ty: lineYs[li++ % lineYs.length], facing: 0, ...(e.type === 'spear' ? { formation: /** @type {const} */ ('square') } : {}) };
      if (e.role === 'fire') return { ...e, tx: 9, ty: [46, 54, 50][ai++ % 3], facing: 0, width: 12 };
      if (e.role === 'escort') return { ...e, tx: 12, ty: 50, facing: 0 };
      if (e.role === 'strike') return { ...e, tx: 8, ty: [74, 26][ci++ % 2], facing: 0, formation: /** @type {const} */ ('wedge') };
      return { ...e, tx: 5, ty: [36, 64][si++ % 2], facing: 0 };
    });
    this.chooseBattlefield();
    return this.deployFrom(plan);
  }

  /** 戰場位置：最靠近地圖中央的渡口（淺灘優先）往己方退 8 格的河岸 */
  chooseBattlefield() {
    const mid = { x: this.W / 2, y: this.H / 2 };
    const fords = this.localOrder(this.geo.fords.length ? this.geo.fords : this.geo.bridges);
    let best = fords[0] || mid;
    for (const f of fords) if (this.dist(f, mid) < this.dist(best, mid)) best = f;
    this.crossing = { x: best.x, y: best.y };
    let bestS = -Infinity;
    for (const a of [0, -20, 20, -40, 40]) {
      const p = this.landBehind(this.offset(this.crossing, this.face(180) + a, 8), this.face(180));
      const hg = this.highGround(this.offset(p, this.face(180), 6), 6);
      const s = this.h.heightAt(hg.x, hg.y) * 10 - Math.abs(a) * 0.08;
      if (s > bestS) {
        bestS = s;
        this.bp = p;
      }
    }
  }

  /**
   * 依己方視角排序（先 y 後 x）：同分時雙方的選擇互相對稱
   * @template {Pt} T
   * @param {T[]} list
   * @returns {T[]}
   */
  localOrder(list) {
    return [...list].sort((a, b) => this.loc(a).y - this.loc(b).y || this.loc(a).x - this.loc(b).x);
  }

  /**
   * 落在可站的陸地上：在河裡就往 back 方向退，最多 10 格
   * @param {Pt} p
   * @param {number} back 世界角度
   * @param {boolean} [wade] 可以站在淺灘裡（縱隊過淺灘時）
   */
  landBehind(p, back, wade = false) {
    let q = p;
    for (let i = 0; i < 10; i++) {
      const t = this.h.terrainAt(q.x, q.y);
      if (t !== TR.river && t !== TR.building && t !== TR.wall && (wade || t !== TR.shallow)) return q;
      q = this.offset(q, back, 1);
    }
    return q;
  }

  /**
   * 站位落在河裡、建築上（退回岸上也不行，例如沿著河岸推進時靠河的那一團）：往戰線中心收攏，找最近可站的點
   * @param {Pt} p
   * @param {Pt} anchor
   */
  pullIn(p, anchor) {
    for (let i = 0; i <= 10; i++) {
      const q = { x: p.x + ((anchor.x - p.x) * i) / 10, y: p.y + ((anchor.y - p.y) * i) / 10 };
      const t = this.h.terrainAt(q.x, q.y);
      if (t !== TR.river && t !== TR.building && t !== TR.wall) return q;
    }
    return anchor;
  }

  // ───────── 每次決策 ─────────

  /** @param {Observation} obs */
  decide(obs) {
    this.update(obs);
    this.assess();
    if (obs.tick - this.stratAt >= 20) {
      this.stratAt = obs.tick;
      this.strategize();
    }
    /** @type {Pending[]} */
    const out = [];
    this.busyIds = new Set();
    this.control(out);
    /** @type {import('../../src/legion/api.ts').LegionCommand[]} */
    const cmds = this.flush(out);
    if (this.planText !== this.planSent) {
      cmds.push({ type: 'plan', text: this.planText });
      this.planSent = this.planText;
    }
    return cmds;
  }

  // ───────── 評估 ─────────

  /** @param {UnitKind} kind */
  perMan(kind) {
    return this.units[kind].cost / this.units[kind].men;
  }

  assess() {
    const obs = this.obs;
    for (const e of obs.enemies) {
      const prev = this.lastMen.get(e.id);
      if (prev !== undefined && e.men < prev) this.killedPts += (prev - e.men) * this.perMan(e.kind);
      if (e.routed && !this.routedSeen.has(e.id)) {
        this.routedSeen.add(e.id);
        this.killedPts += e.men * this.perMan(e.kind);
      }
      this.lastMen.set(e.id, e.men);
    }
    const mine = obs.regiments.filter((r) => !r.routed);
    this.myPts = mine.reduce((s, r) => s + r.men * this.perMan(r.kind), 0);
    const known = this.remembered(600).filter((e) => !e.routed).reduce((s, e) => s + e.men * this.perMan(e.kind), 0);
    this.enemyPts = Math.max(known, this.data.budget * 0.96 - this.killedPts, 1);
    this.ratio = this.myPts / this.enemyPts;
    // 遠程壓制：掉血但沒有任何一團在近戰
    const hp = mine.reduce((s, r) => s + r.hp, 0);
    const meleeing = mine.some((r) => r.engaged);
    if (this.lastHp >= 0 && hp < this.lastHp && !meleeing) this.pressure += obs.tick - this.lastTick;
    else if (meleeing || hp >= this.lastHp) this.pressure = Math.max(0, this.pressure - 2);
    this.lastHp = hp;
    this.lastTick = obs.tick;
    this.clusters = this.cluster(this.remembered(250).filter((e) => !e.routed), 12);
  }

  /**
   * 敵軍集團：彼此 tiles 格內的歸成一群
   * @param {Memory[]} list
   * @param {number} tiles
   * @returns {Cluster[]}
   */
  cluster(list, tiles) {
    /** @type {Cluster[]} */
    const out = [];
    for (const e of list) {
      let c = out.find((g) => this.dist(g, e) <= tiles * TILE);
      if (!c) {
        c = { members: [], x: e.x, y: e.y, pts: 0, engaged: false, cav: 0, spears: 0 };
        out.push(c);
      }
      c.members.push(e);
      const n = c.members.length;
      c.x = (c.x * (n - 1) + e.x) / n;
      c.y = (c.y * (n - 1) + e.y) / n;
      c.pts += e.men * this.perMan(e.kind);
      if (e.engaged) c.engaged = true;
      if (this.isCav(e.kind)) c.cav += 1;
      if (e.kind === 'spear') c.spears += 1;
    }
    return out.sort((a, b) => b.pts - a.pts);
  }

  /** @param {readonly Own[]} regs */
  centroid(regs) {
    if (regs.length === 0) return null;
    return { x: regs.reduce((s, r) => s + r.x, 0) / regs.length, y: regs.reduce((s, r) => s + r.y, 0) / regs.length };
  }

  /** @param {readonly Own[]} regs */
  ptsOf(regs) {
    return regs.reduce((s, r) => s + r.men * this.perMan(r.kind), 0);
  }

  /**
   * 每人交換比：a 打 b 每秒殺掉 b 的比例 ÷ b 打 a 的比例（近戰；含相剋與減免）
   * @param {UnitKind} a
   * @param {UnitKind} b
   */
  edge(a, b) {
    const A = this.units[a];
    const B = this.units[b];
    const va = (this.data.versus[a]?.[b] ?? 100) / 100;
    const vb = (this.data.versus[b]?.[a] ?? 100) / 100;
    const da = ((A.meleeAttack / A.cooldown) * va * (100 - B.meleeDR)) / 100 / B.hp;
    const db = ((B.meleeAttack / B.cooldown) * vb * (100 - A.meleeDR)) / 100 / A.hp;
    return Math.max(0.25, Math.min(4, da / Math.max(1e-9, db)));
  }

  // ───────── 指揮官：姿態與任務 ─────────

  /** 依風格：接戰需要的局部兵力比 */
  get fightEdge() {
    const st = this.k.style ?? 0;
    return st === 1 ? 0.7 : st === 2 ? 1.05 : 0.85;
  }

  /** 戰線的團（槍兵、劍士；不含被派去守旗的） */
  lineRegs() {
    return this.obs.regiments.filter((r) => !r.routed && (r.kind === 'spear' || r.kind === 'sword') && !this.flagJob.has(r.id));
  }

  strategize() {
    const capture = this.data.mode === 'capture';
    if (capture) this.assignFlags();
    const line = this.lineRegs();
    const archers = this.obs.regiments.filter((r) => !r.routed && r.kind === 'archer');
    const main = [...line, ...archers];
    const mc = this.centroid(main.length ? main : this.obs.regiments) || this.bp;
    const fwd = this.forward;
    // 附近的敵軍集團（不含只是路過的輕步兵、騎兵小隊）
    const near = this.clusters.filter((c) => this.dist(c, mc) < 30 * TILE && c.pts >= 25);
    const nearPts = near.reduce((s, c) => s + c.pts, 0);
    const localRatio = this.ptsOf(main) / Math.max(1, nearPts);
    const home = capture ? this.flagHome() : this.bp;
    /** @type {Posture} */
    let posture;
    /** @type {LineMission} */
    let mission;
    if (near.length > 0) {
      const target = near.reduce((a, b) => (this.dist(a, mc) <= this.dist(b, mc) ? a : b));
      const face = this.angle(mc, target);
      const engaged = line.some((r) => r.engaged);
      const coming = target.members.some((e) => this.approaching(e, mc) && !this.isCav(e.kind)) || target.engaged;
      // 地形修正：要涉水過河 ×0.6；敵人每高一階 ×0.85
      const wet = this.waterBetween(mc, target);
      const up = Math.max(0, this.h.heightAt(target.x, target.y) - this.h.heightAt(mc.x, mc.y));
      let eff = localRatio * (wet ? 0.6 : 1);
      for (let i = 0; i < up; i++) eff *= 0.85;
      const archersOpp = target.members.filter((e) => e.kind === 'archer').length;
      // 主動進攻要把看不到的敵軍算進去（推估總兵力 − 記得的），對方主力多半就在附近
      const known = this.remembered(600).filter((e) => !e.routed).reduce((t, e) => t + e.men * this.perMan(e.kind), 0);
      const unseen = Math.max(0, this.enemyPts - known);
      const attackEff = (this.ptsOf(main) / Math.max(1, nearPts + unseen * 0.6)) * (eff / Math.max(1e-9, localRatio));
      if (engaged && eff < this.fightEdge * 0.6 && localRatio < 0.65) {
        posture = '收攏';
        const away = this.angle(target, mc);
        const back = this.behind(mc, home, target) ? home : this.landBehind(this.offset(mc, away, 14), away);
        mission = { anchor: back, facing: this.angle(back, target), mode: 'hold', leash: 2, column: false };
      } else if (engaged) {
        posture = '決戰';
        mission = { anchor: this.stepToward(line.length ? this.centroid(line) || mc : mc, target, 4), facing: face, mode: 'engage', leash: 12, column: false };
      } else if (eff < this.fightEdge * 0.75) {
        posture = '收攏';
        const away = this.angle(target, mc);
        const back = this.behind(mc, home, target) ? home : this.landBehind(this.offset(mc, away, 12), away);
        mission = { anchor: back, facing: this.angle(back, target), mode: 'hold', leash: 4, column: false };
      } else if ((this.posture === '搜敵' || this.obs.tick < this.huntLock) && eff >= this.fightEdge) {
        // 搜敵找到了、局部打得過：直接打（主力既然沒出現，看不到的敵軍就不算在附近）
        posture = '決戰';
        this.huntLock = this.obs.tick + 200;
        mission = { anchor: this.stepToward(mc, target, 7), facing: face, mode: 'engage', leash: 12, column: wet && this.dist(mc, target) < 20 * TILE };
      } else if (coming) {
        posture = '迎擊';
        const at = capture ? home : this.dist(mc, home) < 12 * TILE ? home : mc;
        mission = { anchor: at, facing: this.angle(at, target), mode: 'hold', leash: 6, column: false };
      } else if (!capture && this.quietTooLong() && attackEff >= this.fightEdge * 0.7) {
        // 隔河對峙太久：選離敵軍主力遠的渡口過河壓上
        posture = '進攻';
        if (this.posture !== '進攻' || !this.attackCrossing) this.attackCrossing = this.pickCrossing(mc, target);
        mission = this.advanceMission(mc, { x: target.x, y: target.y });
      } else if (attackEff >= this.fightEdge * 1.3 || (capture && this.standoff() && eff >= this.fightEdge * 0.8)) {
        posture = '決戰';
        mission = { anchor: this.stepToward(mc, target, 7), facing: face, mode: 'engage', leash: 12, column: wet && this.dist(mc, target) < 20 * TILE };
      } else if (this.pressure > 40 && archersOpp > 0) {
        // 對方弓兵在射、我方打不贏：退出射程
        posture = '收攏';
        const away = this.angle(target, mc);
        const back = this.landBehind(this.offset(target, away, 17), away);
        mission = { anchor: back, facing: this.angle(back, target), mode: 'hold', leash: 4, column: false };
      } else {
        posture = '迎擊';
        const at = capture ? home : this.dist(mc, home) < 12 * TILE ? home : mc;
        mission = { anchor: at, facing: this.angle(at, target), mode: 'hold', leash: 6, column: false };
      }
      this.engageTarget = target;
    } else if (capture) {
      posture = '固守';
      const mf = this.mainFlag;
      mission = { anchor: home, facing: mf ? this.angle(home, mf) : fwd, mode: 'hold', leash: 6, column: false };
      // 得分競賽：照目前的得分速度誰先到目標分；會輸就要改變局面
      const race = this.raceLosing();
      this.raid = race && this.ratio < 1.15;
      const enemyFlag = this.flags.filter((f) => f.owner === 1 - this.p && !f.contested).sort((a, b) => b.points - a.points || this.dist(a, mc) - this.dist(b, mc))[0];
      if (enemyFlag && race && (this.ratio >= 1.15 || this.obs.timeLeft < 1500)) {
        posture = '進攻';
        mission = { anchor: this.stepToward(mc, enemyFlag, 8), facing: this.angle(mc, enemyFlag), mode: 'advance', leash: 10, column: this.waterBetween(mc, enemyFlag) && this.dist(mc, enemyFlag) < 18 * TILE };
      }
    } else {
      // 殲滅戰、附近沒有敵人：集結到戰場位置 → 固守等敵人 → 等太久就過河進攻 → 找不到人就搜敵
      const atBp = this.dist(mc, this.bp) < 9 * TILE;
      if (atBp && this.inPositionAt < 0) this.inPositionAt = this.obs.tick;
      const waited = this.inPositionAt >= 0 ? this.obs.tick - this.inPositionAt : 0;
      const patience = (this.k.patience ?? 45) * 10;
      const hunt = this.huntPoint();
      const late = this.obs.timeLeft < 1200 && this.ratio < 1.1;
      const target = this.clusters[0];
      if (hunt && this.lastFight >= 0) {
        posture = '搜敵';
        mission = this.advanceMission(mc, hunt);
      } else if ((waited > patience && this.ratio >= this.fightEdge) || late || this.posture === '進攻') {
        posture = '進攻';
        if (this.posture !== '進攻' || !this.attackCrossing) this.attackCrossing = this.pickCrossing(mc, target || null);
        const goal = target ? { x: target.x, y: target.y } : this.at(128, 50);
        mission = this.advanceMission(mc, goal);
      } else {
        posture = atBp ? '固守' : '集結';
        mission = { anchor: this.bp, facing: target ? this.angle(this.bp, target) : fwd, mode: atBp ? 'hold' : 'advance', leash: atBp ? 6 : 4, column: false };
      }
    }
    if (near.length === 0) this.engageTarget = null;
    this.posture = posture;
    this.line = mission;
    this.planText = this.describe();
  }

  /**
   * p 在 me 的「後方」（相對 enemy）而且比較遠離敵人
   * @param {Pt} me
   * @param {Pt} p
   * @param {Pt} enemy
   */
  behind(me, p, enemy) {
    return this.adiff(this.angle(me, p), this.angle(me, enemy)) > 100 && this.dist(p, enemy) > this.dist(me, enemy);
  }

  /**
   * 安全的行軍：直線路上會經過敵軍（不含 except）旁邊 4 格內，就先走到它側面的繞道點
   * @param {Own} r
   * @param {Pt} dest
   * @param {number} [except] 要去打的敵團
   */
  safeStep(r, dest, except = -1) {
    const d = this.dist(r, dest);
    if (d < 3000) return dest;
    const dir = this.angle(r, dest);
    const ux = (dest.x - r.x) / d;
    const uy = (dest.y - r.y) / d;
    /** @type {Enemy | null} */
    let block = null;
    let blockD = Infinity;
    for (const e of this.foes) {
      if (e.id === except || e.routed) continue;
      // e 投影在路上的位置與離路的距離
      const ex = e.x - r.x;
      const ey = e.y - r.y;
      const along = ex * ux + ey * uy;
      if (along < 0 || along > d + (e.radius || 0)) continue;
      const side = Math.abs(ex * uy - ey * ux);
      if (side > (e.radius || 0) + (r.radius || 0) + 4 * TILE) continue;
      if (along < blockD) {
        blockD = along;
        block = e;
      }
    }
    if (!block) return dest;
    const clear = (block.radius || 0) + (r.radius || 0) + 6 * TILE;
    const a = this.offset(block, dir + 90, clear / TILE);
    const b = this.offset(block, dir - 90, clear / TILE);
    const ok = (/** @type {Pt} */ q) => {
      const t = this.h.terrainAt(q.x, q.y);
      return t !== TR.river && t !== TR.building && t !== TR.wall && q.x > 0 && q.y > 0 && q.x < this.W && q.y < this.H;
    };
    const score = (/** @type {Pt} */ q) => (ok(q) ? 0 : 1e9) + this.dist(q, dest) + this.dist(r, q) * 0.3;
    return score(a) <= score(b) ? a : b;
  }

  /**
   * r 直線走到 dest 的路上（到 dest 之前）會碰到別的敵團
   * @param {Own} r
   * @param {Pt} dest
   * @param {number} except
   */
  pathBlocked(r, dest, except) {
    const d = this.dist(r, dest);
    if (d < 1) return false;
    const ux = (dest.x - r.x) / d;
    const uy = (dest.y - r.y) / d;
    return this.foes.some((e) => {
      if (e.id === except || e.routed) return false;
      const ex = e.x - r.x;
      const ey = e.y - r.y;
      const along = ex * ux + ey * uy;
      if (along < 0 || along > d - (e.radius || 0)) return false;
      return Math.abs(ex * uy - ey * ux) < (e.radius || 0) + (r.radius || 0) + 1000;
    });
  }

  /**
   * 從 a 往 b 走 tiles 格（不超過 b）
   * @param {Pt} a
   * @param {Pt} b
   * @param {number} tiles
   */
  stepToward(a, b, tiles) {
    return this.dist(a, b) <= tiles * TILE ? { x: b.x, y: b.y } : this.offset(a, this.angle(a, b), tiles);
  }

  /**
   * a 走到 b 要經過幾格河、淺灘
   * @param {Pt} a
   * @param {Pt} b
   */
  wetTiles(a, b) {
    const n = Math.max(1, Math.ceil(this.dist(a, b) / 1000));
    let w = 0;
    for (let i = 1; i <= n; i++) {
      const t = this.h.terrainAt(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      if (t === TR.river || t === TR.shallow) w += 1;
    }
    return w;
  }

  /**
   * 兩點之間有河或淺灘（要涉水或過橋）
   * @param {Pt} a
   * @param {Pt} b
   */
  waterBetween(a, b) {
    const n = Math.max(1, Math.ceil(this.dist(a, b) / 1000));
    for (let i = 1; i < n; i++) {
      const t = this.h.terrainAt(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      if (t === TR.river || t === TR.shallow || t === TR.bridge) return true;
    }
    return false;
  }

  /** 殲滅戰：太久沒交戰（開局到現在、或上次交戰後超過「耐心」秒數；時間剩不到 2 分鐘時減半） */
  quietTooLong() {
    const patience = (this.k.patience ?? 45) * 10 * (this.obs.timeLeft < 1200 ? 0.5 : 1);
    return this.obs.tick - Math.max(0, this.lastFight) > patience && this.obs.tick > 300;
  }

  /** 佔點：中央旗點被雙方爭奪（都站在圈內）、而且 20 秒沒有交戰：僵持中 */
  standoff() {
    const mf = this.mainFlag;
    if (!mf) return false;
    const rad = this.data.capture.radius;
    const mine = this.obs.regiments.some((r) => !r.routed && this.dist(r, mf) < rad + (r.radius || 0));
    const theirs = this.foes.some((e) => this.dist(e, mf) < rad + (e.radius || 0));
    return mine && theirs && this.obs.tick - Math.max(0, this.lastFight) > 200;
  }

  /** 佔點：照目前雙方的得分速度（佔著、沒被爭奪的旗），對方會先到目標分 */
  raceLosing() {
    const goal = this.data.capture.scoreTarget;
    const rate = (/** @type {number} */ p) => this.flags.reduce((t, f) => t + (f.owner === p && !f.contested ? f.points : 0), 0);
    const sc = this.obs.score;
    const mine = rate(this.p);
    const theirs = rate(1 - this.p);
    const tMe = mine > 0 ? (goal - sc[this.p]) / mine : Infinity;
    const tThem = theirs > 0 ? (goal - sc[1 - this.p]) / theirs : Infinity;
    return tThem < tMe || (tThem === Infinity && tMe === Infinity && sc[this.p] < sc[1 - this.p]);
  }

  /**
   * 推進任務：還沒過河就先走到渡口對岸（縱隊通過），過河後往目標推進；每次最多比戰線重心前 7 格，維持隊形
   * @param {Pt} mc 主力重心
   * @param {Pt} goal
   * @returns {LineMission}
   */
  advanceMission(mc, goal) {
    const cr = this.attackCrossing || this.crossing;
    const crossed = this.loc(mc).x > this.loc(cr).x + 4;
    const needCross = !crossed && this.loc(goal).x > this.loc(cr).x;
    const exit = this.landBehind(this.offset(cr, this.forward, 9), this.forward);
    const target = needCross ? (this.dist(mc, cr) > 10 * TILE ? this.landBehind(this.offset(cr, this.face(180), 6), this.face(180)) : exit) : goal;
    const d = this.dist(mc, target);
    const step = d > 9 * TILE ? this.offset(mc, this.angle(mc, target), 7) : target;
    const column = needCross && this.dist(mc, cr) < 14 * TILE;
    // 還沒過河：面向渡口（縱隊沿著走向排）；過河後面向目標
    return { anchor: step, facing: this.angle(mc, needCross ? target : goal), mode: 'advance', leash: 8, column };
  }

  /**
   * 進攻的渡口：離敵軍主力遠（避開對方的弓兵與高地）、離我方近
   * @param {Pt} mc
   * @param {Cluster | null} enemy
   */
  pickCrossing(mc, enemy) {
    const all = this.localOrder([...this.geo.fords, ...this.geo.bridges]);
    if (all.length === 0) return this.crossing;
    let best = all[0];
    let bestS = -Infinity;
    for (const c of all) {
      const s = (enemy ? Math.min(30 * TILE, this.dist(c, enemy)) : 0) - this.dist(c, mc) * 0.6 + (this.geo.fords.includes(c) ? 3 * TILE : 0);
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    return { x: best.x, y: best.y };
  }

  /** 觀戰顯示的戰略意圖 */
  describe() {
    const capture = this.data.mode === 'capture';
    const where = (/** @type {Pt} */ p) => this.placeName(p);
    switch (this.posture) {
      case '集結':
        return `集結：主力到${where(this.bp)}列陣`;
      case '固守':
        return capture ? `佔點：主力守${this.mainFlag?.name ?? '中央'}，分兵守旗襲擾` : `固守：在${where(this.bp)}等敵軍過河`;
      case '迎擊':
        return '迎擊：戰線站穩，弓兵先射，等敵人上來';
      case '決戰':
        return '決戰：戰線接敵，騎兵找側背';
      case '收攏':
        return `收攏：兵力不足，退回${capture ? '旗點' : where(this.bp)}重整`;
      case '進攻':
        return capture ? '進攻：分數落後，全軍搶旗' : `進攻：經${where(this.attackCrossing || this.crossing)}過河壓上`;
      case '搜敵':
        return '搜敵：交戰中斷，主動找敵軍';
      default:
        return '';
    }
  }

  /**
   * 地點的名字：最近的旗點、淺灘、橋、高地
   * @param {Pt} p
   */
  placeName(p) {
    /** @type {[string, Pt][]} */
    const cands = [];
    for (const f of this.flags) cands.push([f.name, f]);
    for (const f of this.geo.fords) cands.push(['淺灘', f]);
    for (const b of this.geo.bridges) cands.push([this.loc(b).y < 50 ? '北橋' : '南橋', b]);
    let best = '河岸';
    let bestD = 16 * TILE;
    for (const [n, q] of cands) {
      const d = this.dist(p, q);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  // ───────── 佔點：分派各旗 ─────────

  /** 主力在中央旗的站位：中央旗往己方退 4 格的河岸（站在圈內但不下水） */
  flagHome() {
    const mf = this.mainFlag;
    if (!mf) return this.bp;
    return this.landBehind(this.offset(mf, this.face(180), 4), this.face(180));
  }

  assignFlags() {
    const flags = this.flags;
    const mf = this.mainFlag;
    const sides = flags.filter((f) => f !== mf);
    if (sides.length === 0) return;
    // 己方的橋（離己方布陣區近的）與對方的橋
    const myRear = this.at(0, 50);
    sides.sort((a, b) => this.dist(a, myRear) - this.dist(b, myRear));
    const near = sides[0];
    const far = sides[1] || null;
    this.nearFlag = near;
    this.farFlag = far;
    // 主力集中守中央；己方的橋交給斥候，被騷擾時由騎兵回防（不再固定派長槍駐守，避免中央兵力不足）
    this.flagJob.clear();
  }

  // ───────── 戰鬥群 ─────────

  // ───────── 後備（佔點） ─────────

  /**
   * 召喚後備：場上沒滿時挑陣容最缺的兵種（戰線 4 團、弓兵 2 團、騎兵 1 團、斥候 1 團）
   * @override
   * @param {Pending[]} out
   */
  reinforce(out) {
    if (this.data.mode !== 'capture') return;
    const room = this.obs.fieldCap - this.obs.fieldCost;
    const ready = this.reserves.filter((q) => q.enterIn < 0 && this.units[q.kind].cost <= room);
    if (ready.length === 0) return;
    const best = ready.sort((a, b) => this.need(b.kind) - this.need(a.kind) || b.men - a.men)[0];
    this.send(out, 3, { type: 'summon', id: best.id }, '後備入場', 0);
  }

  /**
   * 陣容缺口：這個兵種還差幾團（越大越缺）
   * @param {UnitKind} kind
   */
  need(kind) {
    const field = this.obs.regiments.filter((r) => !r.routed && r.men / r.men0 >= 0.4);
    const n = (/** @type {(k: UnitKind) => boolean} */ f) => field.filter((r) => f(r.kind)).length;
    if (kind === 'spear' || kind === 'sword') return 4 - n((k) => k === 'spear' || k === 'sword') + (kind === 'sword' ? 0.1 : 0);
    if (kind === 'archer') return 2 - n((k) => k === 'archer');
    if (kind === 'shield') return 1 - n((k) => k === 'shield');
    if (this.isCav(kind)) return 1 - n((k) => this.isCav(k)) + (kind === 'heavyCav' ? 0.1 : 0);
    return 1 - n((k) => k === 'light');
  }

  /** 自己可以換兵的地點：出生點、佔著的橋的補給站 */
  depots() {
    /** @type {Pt[]} */
    const out = [this.data.map.spawns[this.p]];
    for (const su of this.data.map.supplies) if (this.flags[su.flag]?.owner === this.p) out.push(su);
    return out;
  }

  /**
   * 輪替：場上滿了、有後備可換時，把剩不到四成、沒在交戰的團帶到最近的出生點或補給站換掉（同時最多兩團）
   * @param {Pending[]} out
   */
  rotate(out) {
    if (this.data.mode !== 'capture' || this.reserves.every((q) => q.enterIn >= 0)) return;
    const cap = this.data.capture;
    const going = this.obs.regiments.filter((r) => this.state(r.id).rotating === 1);
    const weak = this.obs.regiments.filter((r) => !r.engaged && !r.dashing && r.men / r.men0 < 0.4 && this.state(r.id).rotating !== 1).sort((a, b) => a.men / a.men0 - b.men / b.men0);
    for (const r of weak) {
      if (going.length >= 2) break;
      this.state(r.id).rotating = 1;
      going.push(r);
    }
    for (const r of going) {
      if (r.routed) continue;
      this.busyIds.add(r.id);
      const dep = this.depots().sort((a, b) => this.dist(a, r) - this.dist(b, r))[0];
      const rad = dep === this.data.map.spawns[this.p] ? cap.spawnRadius : cap.supplyRadius;
      if (this.dist(r, dep) > rad * 0.7) {
        const step = this.safeStep(r, dep);
        this.send(out, 6, { type: 'move', id: r.id, x: step.x, y: step.y }, '殘兵回去換兵', 20);
        continue;
      }
      // 到了：換成最缺的後備；換不了（點數）就直接撤回
      const room = this.obs.fieldCap - this.obs.fieldCost + this.units[r.kind].cost;
      const sub = this.reserves.filter((q) => q.enterIn < 0 && this.units[q.kind].cost <= room).sort((a, b) => this.need(b.kind) - this.need(a.kind) || b.men - a.men)[0];
      this.state(r.id).rotating = 0;
      if (sub) this.send(out, 9, { type: 'swap', id: r.id, with: sub.id }, `換上${this.units[sub.kind].name}`, 0);
      else this.send(out, 9, { type: 'withdraw', id: r.id }, '撤回後備休整', 0);
    }
  }

  /** @param {Pending[]} out */
  control(out) {
    this.rotate(out);
    this.coverSpears(out);
    this.feintControl(out);
    const regs = this.obs.regiments.filter((r) => !r.routed && !this.busyIds.has(r.id));
    const archers = regs.filter((r) => r.kind === 'archer');
    this.guard(out, archers);
    this.garrison(out);
    this.lineControl(out, this.lineRegs().filter((r) => !this.busyIds.has(r.id)));
    this.fireControl(out, archers, regs.filter((r) => r.kind === 'shield'));
    this.strikeControl(out, regs.filter((r) => this.isCav(r.kind) && !this.busyIds.has(r.id)));
    this.screenControl(out, regs.filter((r) => r.kind === 'light' && !this.busyIds.has(r.id)));
  }

  /**
   * 護衛：敵人（沒被纏住）逼近弓兵 7 格內，就近派一團攔截（騎兵派槍兵，步兵派劍士或槍兵）
   * @param {Pending[]} out
   * @param {Own[]} archers
   */
  guard(out, archers) {
    for (const a of archers) {
      // 會動、正朝弓兵來（或已經貼近）的敵人才算威脅；站著架盾牆、槍林的不算
      const threat = this.nearestFoe(a, (e) => e.kind !== 'archer' && !e.engaged && !e.routed && e.status !== 'walled' && e.status !== 'walling' && e.status !== 'braced' && (this.approaching(e, a) || this.gap(a, e) < 1.2), 7);
      if (!threat) continue;
      const cav = this.isCav(threat.kind);
      // 對著騎兵架槍林的長槍不派去攔截步兵（那是佯攻要的效果）
      const pool = this.obs.regiments.filter((r) => !r.routed && !r.engaged && !r.dashing && !this.busyIds.has(r.id) && !this.flagJob.has(r.id) && (cav ? r.kind === 'spear' || r.kind === 'heavyCav' : r.kind === 'sword' || r.kind === 'shield' || (r.kind === 'spear' && !this.cavThreat(r, 22))));
      const best = pool.sort((x, y) => this.dist(x, threat) - this.dist(y, threat))[0];
      if (!best || this.dist(best, threat) > 16 * TILE) continue;
      this.busyIds.add(best.id);
      if (best.kind === 'spear' && cav && this.gap(best, threat) < 6 && best.status !== 'braced' && best.status !== 'bracing') {
        this.send(out, 9, { type: 'brace', id: best.id, facing: this.angle(best, threat) }, '架槍林護弓兵', 30);
        continue;
      }
      if (best.status === 'braced' && cav) continue;
      this.send(out, 7, { type: 'attack', id: best.id, target: threat.id }, `攔截${this.units[threat.kind].name}`, 20);
    }
  }

  /**
   * 守旗：被分派的團站進旗點；有敵人進圈就打
   * @param {Pending[]} out
   */
  garrison(out) {
    for (const [id, fid] of this.flagJob) {
      const r = this.obs.regiments.find((x) => x.id === id);
      const f = this.flags.find((x) => x.id === fid);
      if (!r || !f || r.routed) continue;
      this.busyIds.add(r.id);
      if (r.kind === 'spear' && this.spearGuard(out, r, true)) continue;
      const foe = this.nearestFoe(f, (e) => !e.routed && this.dist(e, f) < this.data.capture.radius + 4 * TILE, 12);
      if (foe && !(r.kind === 'spear' && this.isCav(foe.kind) && !foe.engaged)) {
        this.send(out, 6, { type: 'attack', id: r.id, target: foe.id }, `守旗：攔截${this.units[foe.kind].name}`, 20);
        continue;
      }
      if (!r.engaged) this.takeFlag(out, r, f, 5);
    }
  }

  /**
   * 戰線：槍兵居中、劍士兩翼；依任務站位、推進或接敵；目標依相剋分配，只打離自己站位 leash 格內的敵人
   * @param {Pending[]} out
   * @param {Own[]} line
   */
  lineControl(out, line) {
    if (line.length === 0) return;
    const m = this.line;
    // 排列：劍士在兩側、槍兵在中間
    const spears = line.filter((r) => r.kind === 'spear');
    const swords = line.filter((r) => r.kind === 'sword');
    /** @type {Own[]} */
    const order = [];
    swords.forEach((s, i) => (i % 2 === 0 ? order.unshift(s) : order.push(s)));
    const mid = Math.ceil(order.length / 2);
    order.splice(mid, 0, ...spears);
    // 佔點守中央：正面不超過 18 格（太寬就排兩排），兵力集中在旗點圈附近
    const slots = m.column ? this.columnSlots(order, m.anchor, m.facing) : this.data.mode === 'capture' ? this.compactSlots(order, m.anchor, m.facing, 18) : this.lineSlots(order, m.anchor, m.facing, 1.5);
    // 推進、縱隊過河時站位可以在淺灘裡（拉回岸上就永遠過不去）；站定、接敵時才退回岸上
    for (const [id, p] of slots) slots.set(id, this.pullIn(this.landBehind(p, m.facing + 180, m.column || m.mode === 'advance'), m.anchor));
    const targets = this.assignTargets(order, slots, m.leash, this.posture === '收攏');
    // 推進中（沒有任何一團接敵）：沿朝向的進度比最慢的一團多 4 格以上就等
    const progress = (/** @type {Own} */ r) => {
      const dx = r.x - m.anchor.x;
      const dy = r.y - m.anchor.y;
      const [fx, fy] = this.h.offset(0, 0, m.facing, 1000);
      return (dx * fx + dy * fy) / 1000 / TILE;
    };
    const anyEngaged = order.some((r) => r.engaged);
    // 縱隊（過河）本來就前後拉開，不等；最慢的一團沒在走（卡住）也不等
    const laggard = order.reduce((a, b) => (progress(a) <= progress(b) ? a : b));
    const slowest = progress(laggard);
    const waitOk = !m.column && laggard.status === 'moving';
    for (const r of order) {
      const slot = slots.get(r.id) || m.anchor;
      if (waitOk && !anyEngaged && m.mode !== 'hold' && order.length > 1 && progress(r) - slowest > 4 && !r.engaged) {
        if (r.kind === 'spear' && this.spearGuard(out, r, false)) continue;
        if (r.status !== 'idle') this.send(out, 4, { type: 'hold', id: r.id }, '等戰線跟上', 15);
        continue;
      }
      if (r.kind === 'spear' && this.spearGuard(out, r, m.mode !== 'advance')) continue;
      const t = targets.get(r.id);
      if (t) {
        if (r.kind === 'sword' && this.swordAssault(out, r, t)) continue;
        const via = r.engaged ? t : this.safeStep(r, t, t.id);
        if (via !== t && this.dist(r, t) > 4000) {
          this.send(out, 5, { type: 'move', id: r.id, x: via.x, y: via.y }, `繞路去打${this.units[t.kind].name}`, 15);
          continue;
        }
        this.send(out, 5, { type: 'attack', id: r.id, target: t.id }, `${m.mode === 'engage' ? '接戰' : '迎擊'}${this.units[t.kind].name}`, 20);
        continue;
      }
      if (r.engaged && this.posture !== '收攏') continue;
      if (this.dist(r, slot) > 2500) {
        const why = m.mode === 'advance' ? (m.column ? '縱隊過河' : '戰線推進') : m.mode === 'engage' ? '壓上接敵' : '戰線站位';
        this.send(out, 2, { type: 'move', id: r.id, x: slot.x, y: slot.y, facing: m.facing }, why, 20);
      } else if (r.status === 'idle' && this.adiff(r.facing, m.facing) > 30 && !r.engaged) {
        this.send(out, 1, { type: 'face', id: r.id, facing: m.facing }, '轉向敵軍', 20);
      }
    }
  }

  /**
   * 長槍防騎兵：沒被纏住的敵方騎兵在附近（固守 26 格、推進 14 格；衝鋒中一律）就朝它架槍林，任何方向都算；其餘交給共用的槍林反應
   * @param {Pending[]} out
   * @param {Own} r
   * @param {boolean} mayHold
   */
  spearGuard(out, r, mayHold) {
    // 接戰中也要顧騎兵：敵方步兵從側面打我、騎兵在附近等，就是要騙我轉向（佯攻）——守住騎兵的方向，側面交給劍士、盾兵
    const reach = r.engaged ? 22 : mayHold ? 26 : 14;
    const cav = this.cavThreat(r, reach);
    if (!cav) return this.spearReact(out, r, mayHold);
    const s = this.state(r.id);
    s.lastThreat = this.obs.tick;
    const f = this.angle(r, this.predict(cav, 10));
    const braced = r.status === 'braced' || r.status === 'bracing';
    if (!braced) {
      if (r.status !== 'unbracing') this.send(out, 9, { type: 'brace', id: r.id, facing: f }, '架槍林擋騎兵', 30);
    } else if (this.adiff(r.facing, f) > 50 && !(cav.dashing === 'charge' && this.gap(r, cav) < 10)) {
      // 架著的槍林不能直接轉：先收再朝新方向架（騎兵已經衝到 10 格內就來不及了，維持原樣）
      this.send(out, 9, { type: 'unbrace', id: r.id }, '收槍林轉向騎兵', 20);
    }
    return true;
  }

  /**
   * 佯攻誘敵：敵方長槍對著我方騎兵架槍林（騎兵在它正面衝不進去），派一團劍士或輕步兵繞到它側面 9 格、再逼上去打，騙它轉向；
   * 它一開始收槍林（架著的槍林要先收 2 秒才能轉）或正面轉離我方騎兵，騎兵就衝。騎兵在槍尖 10 格外等；
   * 它沒上當，誘餌就照樣打它側面（架著槍林的長槍側面沒有減免）。誘餌傷亡過半、騎兵或目標不在了、超過 40 秒就收手。
   * @param {Pending[]} out
   */
  feintControl(out) {
    const own = (/** @type {number} */ id) => this.obs.regiments.find((r) => r.id === id && !r.routed);
    const f = this.feint;
    if (f !== null) {
      const sp = this.foes.find((e) => e.id === f.spear);
      const bait = own(f.bait);
      const cav = own(f.cav);
      if (!sp || !bait || !cav || bait.men < bait.men0 * 0.5 || this.obs.tick - f.since > 400) {
        this.feint = null;
        this.feintEnd = this.obs.tick;
        return;
      }
      this.busyIds.add(bait.id);
      this.busyIds.add(cav.id);
      // 騎兵：目標的正面離開我了（上當了）就衝；否則在它正面 12 格外等
      if (!cav.dashing) {
        // 上當了：它開始收槍林（收起中沒有減免、沒有迎擊），或正面已經轉離我
        const braced = sp.status === 'braced' || sp.status === 'bracing';
        const exposed = sp.formation !== 'circle' && (!braced || !this.inFront(sp, cav, 70));
        const d = this.gap(cav, sp);
        if (exposed && cav.skillCooldown === 0 && d >= 3 && d <= 22 && this.clearLine(cav, sp, true)) {
          const p = this.predict(sp, Math.round((d * TILE) / 600));
          const through = this.offset(p, this.angle(cav, p), 3);
          this.send(out, 9, { type: 'charge', id: cav.id, x: through.x, y: through.y }, `佯攻得手：衝${this.units[sp.kind].name}側背`, 20);
          this.feint = null;
          this.feintEnd = this.obs.tick;
          return;
        }
        if (d < 10) {
          const back = this.landBehind(this.offset(cav, this.angle(sp, cav), 4), this.angle(sp, cav));
          this.send(out, 6, { type: 'move', id: cav.id, x: back.x, y: back.y }, '佯攻：騎兵在槍尖外等', 15);
        } else if (cav.status !== 'idle') this.send(out, 3, { type: 'hold', id: cav.id }, '佯攻：騎兵待機', 20);
      }
      // 誘餌：先到長槍側面 6 格，騙它轉向；12 秒沒上當就直接打它側面
      if (!bait.dashing && !bait.engaged) {
        const flank = this.landBehind(this.offset(sp, f.facing0 + f.side, 9), f.facing0 + f.side);
        if (f.at === undefined && this.dist(bait, flank) < 2500) f.at = this.obs.tick;
        if (f.at !== undefined) {
          this.send(out, 7, { type: 'attack', id: bait.id, target: sp.id }, '佯攻：誘餌從側面逼上去', 20);
        } else {
          const step = this.safeStep(bait, flank, sp.id);
          this.send(out, 6, { type: 'move', id: bait.id, x: step.x, y: step.y, facing: this.angle(flank, sp) }, `佯攻：誘餌繞到${this.units[sp.kind].name}側面`, 15);
        }
      }
      return;
    }
    if (this.obs.tick - this.feintEnd < 200) return;
    // 發動條件：我方有衝鋒好了的騎兵，正被一團架著槍林的敵方長槍擋在正面；附近有可以當誘餌的輕步兵或劍士
    for (const cav of this.obs.regiments) {
      if (!this.isCav(cav.kind) || cav.routed || cav.engaged || cav.dashing || cav.skillCooldown > 0 || this.busyIds.has(cav.id) || this.flagJob.has(cav.id)) continue;
      const sp = this.nearestFoe(cav, (e) => e.kind === 'spear' && !e.engaged && e.formation !== 'circle' && (e.status === 'braced' || e.status === 'bracing') && this.inFront(e, cav, 70), 24);
      if (!sp || this.gap(cav, sp) < 5) continue;
      // 它旁邊還有沒被纏住的長槍：轉過來也還是有槍尖對著我，不值得
      if (this.foes.some((o) => o !== sp && o.kind === 'spear' && !o.engaged && this.dist(o, sp) < 9 * TILE)) continue;
      const bait = this.obs.regiments
        .filter((r) => (r.kind === 'light' || r.kind === 'sword') && !r.routed && !r.engaged && !r.dashing && !this.busyIds.has(r.id) && !this.flagJob.has(r.id) && r.men >= r.men0 * 0.6 && this.dist(r, sp) < 30 * TILE)
        .sort((a, b) => (a.kind === 'sword' ? 0 : 1) - (b.kind === 'sword' ? 0 : 1) || this.dist(a, sp) - this.dist(b, sp))[0];
      if (!bait) continue;
      // 誘餌從長槍的哪一側來：選能站、離誘餌近的那一側（要偏離騎兵的方向，長槍轉過去才會把騎兵露在側面）
      const sides = [90, -90]
        .map((a) => ({ a, p: this.offset(sp, sp.facing + a, 6) }))
        .filter((c) => {
          const t = this.h.terrainAt(c.p.x, c.p.y);
          return t !== TR.river && t !== TR.building && t !== TR.wall;
        })
        .sort((x, y) => this.dist(bait, x.p) - this.dist(bait, y.p));
      if (sides.length === 0) continue;
      this.feint = { spear: sp.id, bait: bait.id, cav: cav.id, since: this.obs.tick, side: sides[0].a, facing0: sp.facing };
      this.busyIds.add(bait.id);
      this.busyIds.add(cav.id);
      return;
    }
  }

  /**
   * 對 r 有威脅的敵方騎兵：看得到的，或 30 秒內見過、推估位置在 tiles 格內的；衝鋒中的一律算（30 格內）
   * @param {Pt} r
   * @param {number} tiles
   * @returns {Enemy | null}
   */
  cavThreat(r, tiles) {
    const seen = this.nearestFoe(r, (e) => this.isCav(e.kind) && !e.engaged && (e.dashing === 'charge' || this.gap(r, e) <= tiles), 30);
    if (seen) return seen;
    const visible = new Set(this.obs.enemies.map((e) => e.id));
    /** @type {Enemy | null} */
    let best = null;
    let bestD = tiles;
    for (const e of this.remembered(300)) {
      if (visible.has(e.id) || !this.isCav(e.kind) || e.engaged || e.routed) continue;
      const d = this.gap(r, e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * 掩護守著騎兵方向的長槍：敵方步兵從側面、背面打它時，就近派劍士或盾兵去打那團步兵（長槍不轉向）
   * @param {Pending[]} out
   */
  coverSpears(out) {
    for (const sp of this.obs.regiments) {
      if (sp.kind !== 'spear' || sp.routed || !sp.engaged || !this.cavThreat(sp, 22)) continue;
      const foe = this.nearestFoe(sp, (e) => !this.isCav(e.kind) && e.kind !== 'archer' && !this.inFront(sp, e, 60), 3);
      if (!foe) continue;
      const pool = this.obs.regiments.filter((o) => !o.routed && !o.dashing && !this.busyIds.has(o.id) && !this.flagJob.has(o.id) && (o.kind === 'sword' || o.kind === 'shield') && (!o.engaged || this.gap(o, foe) < 2));
      const best = pool.sort((a, b) => this.dist(a, foe) - this.dist(b, foe))[0];
      if (!best || this.dist(best, foe) > 18 * TILE) continue;
      this.busyIds.add(best.id);
      this.send(out, 8, { type: 'attack', id: best.id, target: foe.id }, `掩護長槍側面：打${this.units[foe.kind].name}`, 20);
    }
  }

  /**
   * 緊密的陣：正面寬度超過 maxTiles 就把後面的團排到第二排（中間的團在前）
   * @param {Own[]} regs
   * @param {Pt} anchor
   * @param {number} facing
   * @param {number} maxTiles
   */
  compactSlots(regs, anchor, facing, maxTiles) {
    const width = (/** @type {Own[]} */ rs) => rs.reduce((t, r) => t + (r.radius * 2) / TILE + 0.8, 0);
    if (width(regs) <= maxTiles) return this.lineSlots(regs, anchor, facing, 0.8);
    const mid = Math.floor(regs.length / 2);
    const front = regs.slice(Math.max(0, mid - 1), mid + 1);
    const back = regs.filter((r) => !front.includes(r));
    const out = this.lineSlots(front, anchor, facing, 0.8);
    const depth = Math.max(...front.map((r) => r.radius)) / TILE + Math.max(1, ...back.map((r) => r.radius)) / TILE + 1;
    for (const [id, p] of this.lineSlots(back, this.offset(anchor, facing + 180, depth), facing, 0.8)) out.set(id, p);
    return out;
  }

  /**
   * 縱隊：一團接一團排在 anchor 後方（過渡口、過橋時用）
   * @param {Own[]} regs
   * @param {Pt} anchor
   * @param {number} facing
   */
  columnSlots(regs, anchor, facing) {
    /** @type {Map<number, Pt>} */
    const out = new Map();
    let back = 0;
    for (const r of regs) {
      out.set(r.id, this.offset(anchor, facing + 180, back));
      back += (r.radius * 2) / TILE + 1;
    }
    return out;
  }

  /**
   * 戰線目標分配：每團在站位 leash 格內挑最划算的敵人（相剋、已被我方纏住、能打側背加分；槍林、盾牆正面扣分；同一目標最多兩團）
   * @param {Own[]} regs
   * @param {Map<number, Pt>} slots
   * @param {number} leash
   * @param {boolean} retreat 收攏中：只還擊已經貼身的敵人
   * @returns {Map<number, Enemy>}
   */
  assignTargets(regs, slots, leash, retreat) {
    /** @type {Map<number, Enemy>} */
    const out = new Map();
    /** @type {Map<number, number>} */
    const load = new Map();
    /** @type {[number, Own, Enemy][]} */
    const pairs = [];
    for (const r of regs) {
      const slot = slots.get(r.id) || r;
      for (const e of this.foes) {
        const dSlot = this.gap(slot, e);
        const d = this.gap(r, e);
        if (retreat ? !(r.engaged && d < 1) : dSlot > leash && d > 2) continue;
        // 步兵追不上沒被纏住、正在跑的騎兵
        if (this.isCav(e.kind) && !e.engaged && e.status !== 'idle' && d > 2) continue;
        // 不追下水：要涉水超過 2 格才打得到的不打（除非是主動過河進攻）
        if (this.posture !== '進攻' && !(r.engaged && d < 1.5) && this.wetTiles(r, e) > 2) continue;
        const ed = this.edge(r.kind, e.kind);
        let s = 6 * (ed >= 1 ? ed - 1 : 1 - 1 / ed) - d;
        if (e.engaged) s += 6;
        if (!this.inFront(e, r, 60)) s += 5;
        if ((r.kind === 'sword' || r.kind === 'light') && this.spearWall(e, r)) s -= 25;
        if (this.shieldWall(e, r)) s -= 10;
        if (e.kind === 'archer') s += 4;
        if (r.engaged && d < 1.5) s += 8;
        // 太不划算的對手（例如劍士對槍林正面）：除非已經貼身，不打
        if (s < -14 && !(r.engaged && d < 1.5)) continue;
        pairs.push([s, r, e]);
      }
    }
    pairs.sort((a, b) => b[0] - a[0]);
    for (const [, r, e] of pairs) {
      if (out.has(r.id)) continue;
      if ((load.get(e.id) || 0) >= 2) continue;
      out.set(r.id, e);
      load.set(e.id, (load.get(e.id) || 0) + 1);
    }
    return out;
  }

  /**
   * 火力：弓兵在戰線後方 7 格、就近找高處；盾兵護送
   * @param {Pending[]} out
   * @param {Own[]} archers
   * @param {Own[]} shields
   */
  fireControl(out, archers, shields) {
    const m = this.line;
    const n = archers.length;
    const tgt = this.engageTarget;
    const range = this.units.archer.range / TILE;
    const lineC = this.centroid(this.lineRegs()) || m.anchor;
    // 射擊陣地：戰線後方 7 格（決戰時離敵軍約射程 - 2 格），在 12 格內找高處；各團在陣地兩側 3.5 格
    let center = this.offset(m.anchor, m.facing + 180, 7);
    if (tgt && m.mode === 'engage') center = this.offset(tgt, m.facing + 180, Math.min(range - 2, this.dist(tgt, lineC) / TILE + 6));
    // 交戰點：戰線前方 4 格（或敵軍）；陣地離它不能超過射程 - 2 格
    // 交戰點：決戰時是敵軍；固守、迎擊時是戰線（在高處等敵人進射程，不離開高地去迎敵）
    const front = tgt && m.mode === 'engage' && this.dist(tgt, lineC) < 20 * TILE ? tgt : m.anchor;
    center = this.highGround(this.landBehind(center, m.facing + 180), 12, tgt, front, range - 2);
    archers.forEach((r, i) => {
      if (this.busyIds.has(r.id)) return;
      const lat = n <= 1 ? 0 : (i - (n - 1) / 2) * 7;
      const base = this.landBehind(this.offset(center, m.facing + 90, lat), m.facing + 180);
      if (this.archerCover(out, r)) return;
      const spot = this.archerReposition(r);
      if (spot && this.dist(r, spot) > 1500 && !r.engaged && r.status !== 'volleying') {
        this.send(out, 5, { type: 'move', id: r.id, x: spot.x, y: spot.y }, '移位射擊好目標', 20);
        return;
      }
      this.archerReact(out, r, spot || this.highGround(base, 5, tgt, front, range - 2));
    });
    // 盾兵：護弓兵（站在弓兵前方 3.5 格），或擋在長槍前面（緊貼長槍正面，長槍才刺得到盾兵前面的敵人）
    const spears = this.k.shieldWard === 1 ? this.lineRegs().filter((r) => r.kind === 'spear') : [];
    shields.forEach((r, i) => {
      if (this.busyIds.has(r.id)) return;
      const sp = spears.length > 0 ? spears[i % spears.length] : null;
      // 方陣每排 6 人，剛好站在盾兵各列的空隙，可以貼到 2.45 格；橫陣和盾兵同列，要隔開一點
      if (sp) this.shieldReact(out, r, sp, sp.formation === 'square' ? 2450 : 1350);
      else this.shieldReact(out, r, archers[i % Math.max(1, n)] || null);
    });
  }

  /**
   * 弓兵躲騎兵：沒被纏住的敵方騎兵在 16 格內，就躲到最近的我方長槍（或盾兵、劍士）背後；沒有掩護就往反方向跑
   * @param {Pending[]} out
   * @param {Own} r
   */
  archerCover(out, r) {
    if (r.engaged) return false;
    const cav = this.nearestFoe(r, (e) => this.isCav(e.kind) && !e.engaged && !e.routed, 16);
    if (!cav) return false;
    const mates = this.obs.regiments.filter((o) => !o.routed && o.id !== r.id && (o.kind === 'spear' || o.kind === 'shield' || o.kind === 'sword') && this.dist(o, r) < 18 * TILE);
    const prot = mates.sort((a, b) => (a.kind === 'spear' ? 0 : 1) - (b.kind === 'spear' ? 0 : 1) || this.dist(a, r) - this.dist(b, r))[0];
    const away = prot ? this.angle(cav, prot) : this.angle(cav, r);
    const dest = this.landBehind(prot ? this.offset(prot, away, (prot.radius + r.radius) / TILE + 2) : this.offset(r, away, 10), away);
    if (this.dist(r, dest) < 1500) return false;
    this.send(out, 8, { type: 'move', id: r.id, x: dest.x, y: dest.y }, prot ? `躲到${this.units[prot.kind].name}後面` : '避開騎兵', 25);
    return true;
  }

  /**
   * 弓兵移位：射程內只有盾牆或舉盾的盾兵、射程外一點有值得射的敵人（不是盾兵，最好是被纏住的），就往前移到射程內；
   * 那個位置 5 格內有沒被纏住的敵方近戰就不去
   * @param {Own} r
   * @returns {Pt | null}
   */
  archerReposition(r) {
    const range = this.units.archer.range / TILE;
    const inRange = (/** @type {Enemy} */ e) => (this.dist(r, e) - (e.radius || 0) / 2) / TILE <= range + (r.height - e.height) - 1.5;
    const good = (/** @type {Enemy} */ e) => !e.routed && (e.kind !== 'shield' || (e.stance === 'carry' && e.status !== 'walled' && e.status !== 'walling'));
    if (this.foes.some((e) => good(e) && inRange(e))) return null;
    /** @type {Enemy | null} */
    let best = null;
    let bestS = -Infinity;
    for (const e of this.foes) {
      if (!good(e)) continue;
      const d = this.gap(r, e);
      if (d > range + 8) continue;
      const s = (e.engaged ? 10 : 0) + (e.kind === 'archer' ? 4 : 0) - d;
      if (s > bestS) {
        bestS = s;
        best = e;
      }
    }
    if (!best) return null;
    // 目標正朝這裡來：在原地（多半是高處）等它進射程
    if (this.approaching(best, r)) return null;
    const spot = this.highGround(this.landBehind(this.offset(best, this.angle(best, r), range - 2), this.angle(best, r)), 2, best);
    const danger = this.foes.some((e) => e !== best && !e.engaged && e.kind !== 'archer' && e.status !== 'walled' && e.status !== 'braced' && this.gap(spot, e) < 5);
    // 不為了找目標離開高處（除非戰線正在決戰、目標已經被纏住）
    if (this.h.heightAt(spot.x, spot.y) < r.height && !(this.line.mode === 'engage' && best.engaged)) return null;
    return danger ? null : spot;
  }

  /**
   * p 附近 tiles 格內最高的可站位置（同高度取最近）；有敵軍時不往敵人那邊靠
   * @param {Pt} p
   * @param {number} tiles
   * @param {Pt | null} [enemy]
   * @param {Pt | null} [keepNear] 不能離這一點超過 maxTiles 格
   * @param {number} [maxTiles]
   */
  highGround(p, tiles, enemy = null, keepNear = null, maxTiles = 0) {
    let best = p;
    let bestS = this.h.heightAt(p.x, p.y) * 10;
    const d0 = enemy ? this.dist(p, enemy) : 0;
    // 掃描順序用己方視角（1 號整個反過來），同分時雙方挑到互相對稱的位置
    const sg = this.p === 0 ? 1 : -1;
    for (let dy = -tiles; dy <= tiles; dy += 2) {
      for (let dx = -tiles; dx <= tiles; dx += 2) {
        const q = { x: p.x + sg * dx * TILE, y: p.y + sg * dy * TILE };
        const t = this.h.terrainAt(q.x, q.y);
        if (t === TR.river || t === TR.shallow || t === TR.building || t === TR.wall) continue;
        if (enemy && this.dist(q, enemy) < d0 - 1500) continue;
        // 越高射得越遠：每高一階多 1 格
        if (keepNear && this.dist(q, keepNear) > (maxTiles + Math.max(0, this.h.heightAt(q.x, q.y) - this.h.heightAt(keepNear.x, keepNear.y))) * TILE) continue;
        if (this.obs && this.foes.some((e) => e.kind !== 'archer' && !e.routed && this.gap(q, e) < 7)) continue;
        const s = this.h.heightAt(q.x, q.y) * 12 - Math.sqrt(dx * dx + dy * dy) * 0.8;
        if (s > bestS) {
          bestS = s;
          best = q;
        }
      }
    }
    return best;
  }

  /**
   * 打擊：騎兵在戰線側翼待命；佔點時沒事就去襲擾對方的橋
   * @param {Pending[]} out
   * @param {Own[]} cavs
   */
  strikeControl(out, cavs) {
    const m = this.line;
    const lineRegs = this.lineRegs();
    const lineC = this.centroid(lineRegs.length ? lineRegs : this.obs.regiments.filter((o) => o.kind === 'archer' && !o.routed)) || m.anchor;
    cavs.forEach((r, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const rally = this.landBehind(this.offset(this.offset(lineC, m.facing + 90 * side, 14), m.facing + 180, 6), m.facing + 180);
      if (this.data.mode === 'capture' && this.posture !== '決戰' && !r.dashing) {
        // 回防：己方的旗被小股敵軍騷擾（附近沒有敵方主力）；處理完 20 秒內守在旗旁（黏著期）
        const st = this.state(r.id);
        const sticky = this.flags.find((f) => f.id === st.guardFlag && this.obs.tick < (st.guardUntil || 0) && f.owner === this.p);
        const mine = this.flags.find((f) => f.owner === this.p && f.contested && f !== this.mainFlag) || sticky;
        if (mine && (!r.engaged || this.dist(r, mine) < this.data.capture.radius + 3 * TILE)) {
          if (mine.contested) {
            st.guardFlag = mine.id;
            st.guardUntil = this.obs.tick + 200;
          }
          const raiders = this.foes.filter((e) => this.dist(e, mine) < this.data.capture.radius + 3 * TILE);
          const pts = raiders.reduce((t, e) => t + e.men * this.perMan(e.kind), 0);
          // 看不到是誰在偷（旗點被爭奪是公開資訊）：也派騎兵去看
          if (pts <= r.men * this.perMan(r.kind) * 1.3 && !raiders.some((e) => e.kind === 'spear')) {
            // 衝鋒好了、跟偷旗的拉開了距離：直接衝穿它（不管在不在圈內）
            const first = raiders.slice().sort((a, b) => this.dist(a, r) - this.dist(b, r))[0];
            if (first && r.skillCooldown === 0 && !r.engaged && this.gap(r, first) >= 2.5 && this.gap(r, first) <= 18) {
              const p = this.predict(first, 8);
              const through = this.offset(p, this.angle(r, p), 4);
              // 旗點在橋與淺灘上：衝到目標之前會碰到河、淺灘、樹林就不衝（衝鋒會在那裡停住）
              if (this.clearLine(r, p, true)) {
                this.send(out, 9, { type: 'charge', id: r.id, x: through.x, y: through.y }, `衝鋒趕走偷${mine.name}的`, 20);
                return;
              }
            }
            // 先進到圈內（中心離旗 4.5 格內，士兵都在圈裡）擋住對方的佔領進度，再打
            if (this.dist(r, mine) > this.data.capture.radius - 500) {
              const step = this.safeStep(r, mine);
              this.send(out, 6, { type: 'move', id: r.id, x: step.x, y: step.y }, `回防${mine.name}`, 20);
            } else {
              // 在圈內：騎兵靠衝鋒殺人，不要站著肉搏。衝鋒好了就直接衝穿偷旗的（太近先拉開）；
              // 冷卻中：人數佔優才近戰，否則站在圈內離它最遠的一側，維持爭奪讓它佔不下來
              const raider = raiders.sort((a, b) => this.dist(a, r) - this.dist(b, r))[0];
              if (raider) {
                const gap = this.gap(r, raider);
                const away = this.angle(raider, r);
                const p = this.predict(raider, 8);
                const through = this.offset(p, this.angle(r, p), 4);
                const back = this.landBehind(this.offset(r, away, 8), away);
                // 衝到目標之前（從現在的位置，或拉開之後的位置）會碰到河、淺灘、樹林就不衝，改用近戰或牽制；
                // 拉開距離不能退出旗圈，否則對方的佔領進度又開始累積
                const charge = r.skillCooldown === 0 && gap >= 2.5 && !r.engaged && this.clearLine(r, p, true);
                const reposition = r.skillCooldown === 0 && !charge && this.dist(back, mine) < this.data.capture.radius - 500 && this.clearLine(back, p, true);
                if (charge) {
                  this.send(out, 9, { type: 'charge', id: r.id, x: through.x, y: through.y }, `衝鋒趕走偷${mine.name}的`, 20);
                } else if (reposition) {
                  this.send(out, 8, { type: 'move', id: r.id, x: back.x, y: back.y }, '拉開距離再衝', 15);
                } else if (r.men * this.perMan(r.kind) >= pts * 1.3) {
                  this.send(out, 6, { type: 'attack', id: r.id, target: raider.id }, `趕走偷${mine.name}的${this.units[raider.kind].name}`, 20);
                } else {
                  const hover = this.landBehind(this.offset(mine, away, 3.5), away);
                  if (this.dist(r, hover) > 1500) this.send(out, 6, { type: 'move', id: r.id, x: hover.x, y: hover.y }, `在${mine.name}圈內牽制`, 15);
                }
              } else if (r.status !== 'idle' && !r.engaged) this.send(out, 3, { type: 'hold', id: r.id }, `守住${mine.name}`, 20);
            }
            return;
          }
        }
        // 中央還沒開打：第一團騎兵負責己方的橋（佔下後在橋與中央之間待命，有人來偷就回防）
        const near = this.nearFlag;
        const far0 = this.farFlag;
        if (this.raid && far0 && !r.engaged && near && near.owner === this.p && !near.contested) {
          // 騷擾對方的橋：站進圈內讓它暫停得分；圈內有長槍就在外圍等
          if (!this.foes.some((e) => e.kind === 'spear' && !e.engaged && this.dist(e, far0) < 8 * TILE)) {
            this.takeFlag(out, r, far0, 5);
            return;
          }
        }
        if (near && i === 0 && !r.engaged) {
          if ((near.owner !== this.p || near.contested) && !this.foes.some((e) => e.kind === 'spear' && this.dist(e, near) < 10 * TILE)) {
            this.takeFlag(out, r, near, 4);
            return;
          }
          const mf = this.mainFlag;
          // 兩座橋都是我的：待在中央後方（到兩座橋一樣近，哪邊被偷都來得及）；否則守在己方的橋往中央 8 格
          const both = far0 && far0.owner === this.p;
          const post = this.landBehind(mf && both ? this.offset(mf, this.face(180), 10) : mf ? this.offset(near, this.angle(near, mf), 8) : near, this.face(180));
          this.hammer(out, r, post);
          return;
        }
        // 輕騎兵：對方的橋附近沒有敵軍才去偷
        const far = this.farFlag;
        if (far && r.kind === 'lightCav' && !r.engaged && (far.owner !== this.p || far.contested) && !this.foes.some((e) => this.dist(e, far) < 14 * TILE)) {
          this.takeFlag(out, r, far, 4);
          return;
        }
      }
      this.hammer(out, r, rally);
    });
  }

  /**
   * 騎兵的錘：只衝被纏住、露出側背的敵人或弓兵、輕步兵、潰兵；繞到側背再衝；衝完拉開重整
   * @param {Pending[]} out
   * @param {Own} r
   * @param {Pt} rally
   */
  hammer(out, r, rally) {
    if (r.dashing) return;
    const heavy = r.kind === 'heavyCav';
    const name = heavy ? '重騎' : '輕騎';
    if (r.engaged) {
      const near = this.nearestFoe(r, null, 2);
      const stay = near && ((near.men / near.men0 < 0.4 && near.kind !== 'spear') || near.kind === 'archer' || near.kind === 'light');
      if (!stay && r.men > 1) {
        const back = this.offset(r, this.angle(near || r, r), 10);
        this.send(out, 7, { type: 'move', id: r.id, x: back.x, y: back.y }, `${name}脫離重整`, 25);
      }
      return;
    }
    /** @type {Enemy | null} */
    let best = null;
    let bestS = -Infinity;
    for (const e of this.foes) {
      const d = this.gap(r, e);
      if (d > 28 || this.isCav(e.kind) || e.dashing) continue;
      const front = this.inFront(e, r, 65);
      const bracedFront = e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing') && (e.formation === 'circle' || front);
      if (bracedFront) continue;
      if (e.kind === 'spear' && !e.engaged && front) continue;
      // 附近有沒被纏住的敵方長槍：衝進去會被架槍林
      const spearNear = this.foes.some((o) => o !== e && o.kind === 'spear' && !o.engaged && this.dist(o, e) < 6 * TILE);
      // 沒被纏住的目標：只有身邊沒有長槍、盾兵、劍士保護的弓兵、輕步兵或殘兵才值得衝；
      // 側背對著我的長槍也值得（架著槍林轉不過來，沒架的也來不及架）
      if (!e.engaged) {
        const soft = e.kind === 'archer' || e.kind === 'light' || e.men / e.men0 < 0.35;
        const exposedSpear = e.kind === 'spear' && !front && e.formation !== 'circle';
        const guarded = this.foes.some((o) => o !== e && !o.engaged && (o.kind === 'spear' || o.kind === 'shield' || o.kind === 'sword') && this.dist(o, e) < 8 * TILE && (o.kind !== 'spear' || this.inFront(o, r, 70)));
        if ((!soft && !exposedSpear) || guarded) continue;
      }
      let s = 30 - d;
      if (e.kind === 'archer') s += 25;
      if (e.kind === 'light') s += 10;
      if (e.engaged) s += 20;
      s += front ? -12 : 14;
      if (spearNear) s -= 18;
      if (!heavy && (e.kind === 'shield' || e.kind === 'spear')) s -= 20;
      if (e.men / e.men0 < 0.4) s += 6;
      if (s > bestS) {
        bestS = s;
        best = e;
      }
    }
    if (best && bestS > 0 && r.skillCooldown === 0) {
      const d = this.gap(r, best);
      const soft = best.kind === 'archer' || best.kind === 'light' || best.men / best.men0 < 0.3;
      const exposed = !this.inFront(best, r, 70) || soft;
      if (exposed && d >= 3 && d <= 20) {
        const p = this.predict(best, Math.round((d * TILE) / (heavy ? 600 : 680)));
        const through = this.offset(p, this.angle(r, p), 3);
        if (this.clearLine(r, through, true) && !this.pathBlocked(r, p, best.id)) {
          this.send(out, 9, { type: 'charge', id: r.id, x: through.x, y: through.y }, `${name}衝${best.engaged ? '側背' : ''}${this.units[best.kind].name}`, 20);
          return;
        }
      }
      // 繞到側背：目標背後或側面 11 格，挑離敵方長槍最遠、能走的點
      const cands = [180, 110, -110].map((a) => this.offset(best, best.facing + a, 11)).filter((q) => {
        const t = this.h.terrainAt(q.x, q.y);
        return t !== TR.river && t !== TR.building && t !== TR.wall && t !== TR.forest;
      });
      const spears = this.foes.filter((o) => o.kind === 'spear' && !o.engaged);
      const score = (/** @type {Pt} */ q) => Math.min(30 * TILE, ...spears.map((o) => this.dist(o, q))) - this.dist(r, q) * 0.5;
      const fp = cands.sort((a, b) => score(b) - score(a))[0];
      if (fp) {
        const step = this.safeStep(r, fp, best.id);
        this.send(out, 6, { type: 'move', id: r.id, x: step.x, y: step.y }, `${name}繞到${this.units[best.kind].name}側背`, 20);
        return;
      }
    }
    // 衝鋒冷卻中（或衝不了）：近戰沒人保護的軟目標——弓兵（被貼身拉不開弓）、輕步兵、殘兵，不要在旁邊乾等
    const prey = this.nearestFoe(r, (e) => {
      if (this.isCav(e.kind) || e.dashing || this.spearWall(e, r)) return false;
      const soft = e.kind === 'archer' || e.kind === 'light' || e.men / e.men0 < 0.3 || (e.engaged && !this.inFront(e, r, 70));
      if (!soft) return false;
      return !this.foes.some((o) => o !== e && !o.engaged && (o.kind === 'spear' || o.kind === 'shield' || o.kind === 'sword') && this.dist(o, e) < 6 * TILE);
    }, 16);
    if (prey) {
      const step = this.dist(r, prey) > 5000 ? this.safeStep(r, prey, prey.id) : prey;
      if (step !== prey) this.send(out, 6, { type: 'move', id: r.id, x: step.x, y: step.y }, `${name}繞路去打${this.units[prey.kind].name}`, 15);
      else this.send(out, 6, { type: 'attack', id: r.id, target: prey.id }, `${name}近戰${this.units[prey.kind].name}`, 20);
      return;
    }
    if (this.dist(r, rally) > 3000) {
      const step = this.safeStep(r, rally);
      this.send(out, 2, { type: 'move', id: r.id, x: step.x, y: step.y, facing: this.line.facing }, r.skillCooldown > 0 ? `${name}重整，等待再衝` : `${name}在側翼待命`, 20);
    }
  }

  /**
   * 斥候：佔點時搶空旗與守己方的橋；殲滅戰偵察兩座橋
   * @param {Pending[]} out
   * @param {Own[]} lights
   */
  screenControl(out, lights) {
    lights.forEach((r, i) => {
      /** @type {Pt} */
      let watch;
      let name;
      if (this.data.mode === 'capture') {
        const near = this.nearFlag;
        const far = this.farFlag;
        // 斥候守己方的橋（沒人守的旗一個人就能偷）；得分落後時第二團去騷擾對方的橋
        const f = i === 1 && this.raid ? far || near : near || far;
        if (f) {
          watch = { x: f.x, y: f.y };
          name = f.name;
          // 己方的橋還沒到手：先去佔
          if (f.owner !== this.p && !this.nearestFoe(r, (e) => e.kind !== 'light' && e.kind !== 'archer', 7)) {
            this.takeFlag(out, r, f, 4);
            return;
          }
        } else {
          watch = this.bp;
          name = '河岸';
        }
      } else {
        const ys = [24, 76];
        watch = this.landBehind(this.at(70, ys[i % 2]), this.face(180));
        name = i % 2 === 0 ? '北橋' : '南橋';
        // 沒有敵情又沒交戰：往前偵察
        if (this.clusters.length === 0 && this.obs.tick > 300) watch = this.landBehind(this.at(92, ys[i % 2]), this.face(180));
      }
      this.scoutReact(out, r, watch, name);
    });
  }
}
