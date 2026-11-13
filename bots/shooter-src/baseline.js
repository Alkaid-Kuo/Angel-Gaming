// @ts-check
// CS 射擊基準 Bot（步驟 6）：四層架構。
//   感知 memory.js（每次決策）：敵情記憶、已清空格、危險格成本（每秒）
//   導航 analysis.js（init 一次：可走格、距離場、區域交界與窄口、掩體點、守點位、下包位、路線集）＋ nav.js（A*、路徑點、被擋重算、探頭）
//   戰鬥 combat.js（每次決策）：目標、預判瞄準、點放、停步、蹲、換彈、狙擊、撤退、被閃、道具自保、沒事時看哪裡
//   戰術 tactics.js（回合開始＋每次決策）：隊內計畫與事件（say）、T 五種計畫與守包、CT 配置／輪轉／回防／保槍、殘局、換血
//        economy.js（指揮統一買法 B:）、utility.js（道具彈道與投擲）、roles.js（2.1：五個角色的分工，隊內喊 R:）
// 公平：只讀 init 資料與觀察資料；不寫死任何地圖座標、區域代號或地圖 id。
// 屬性包（attributes，0～100）接到行為：aim 瞄準誤差與收斂（狙擊手拿其他槍時打折）；reaction 開火前額外等待與對聲音的反應；
// awareness 雷達與聲音採信、隊內事件的反應延遲、預瞄（目標出現在正看著的方向時初始瞄準誤差小）、餘光察覺（視野邊緣的敵人多快注意到）；
// aggression 探頭等待與方式、架槍時間、T 計畫（rush 比例、default 執行時機）、殘局找人、保槍（撤退門檻步驟 7 起固定）；
// discipline 隊友擋線的安全距離、守位中不追出射程外的目標、經濟服從（eco 不偷買）、不追殘血、殘局保槍；
// movement 停步乾淨度、肩探（太低只會寬探）、附近有敵人時靜步、佈置時靜步。旋鈕是外部粗調（侵略偏移、經濟、狙擊手、CT 分點、T 計畫、角色）。
import { Grid, P, UNIT, clamp, dist, initTrig } from './base.js';
import { MapIntel } from './analysis.js';
import { Perception } from './memory.js';
import { Navigator } from './nav.js';
import { Combat } from './combat.js';
import { Tactics } from './tactics.js';
import { AWP, ENTRY, ROLE_NAME, autoRole } from './roles.js';
import { Judgment } from './judgment.js';
import { Mission } from './mission.js';
import { Choice, HERE } from './choice.js';

/** 包點代號 */
const SITE_IDS = /** @type {const} */ (['A', 'B']);

export default class ShooterBaseline {
  constructor() {
    /** @type {import('./base.js').InitData} */
    this.data = /** @type {any} */ (null);
    /** @type {import('./base.js').Helpers} */
    this.h = /** @type {any} */ (null);
    /** @type {Grid} */
    this.g = /** @type {any} */ (null);
    /** @type {MapIntel} */
    this.intel = /** @type {any} */ (null);
    /** @type {Perception} */
    this.perc = /** @type {any} */ (null);
    /** @type {Navigator} */
    this.nav = /** @type {any} */ (null);
    /** @type {Combat} */
    this.combat = /** @type {any} */ (null);
    /** @type {Tactics} */
    this.tactics = /** @type {any} */ (null);
    /** @type {Choice} */
    this.choice = /** @type {any} */ (null);
    this.round = -1;
    /** 除錯用：最近一次決策的說明 */
    this.why = '';
  }

  /** @returns {import('./base.js').Declaration} */
  declare() {
    return {
      name: 'shooter-baseline',
      version: '3.0.0',
      style: '基準',
      knobs: [
        { key: 'aggression', name: '侵略偏移', description: '加在屬性「侵略」上的偏移（−50～50）：影響探頭方式、撤退門檻、架槍時間', min: -50, max: 50, default: 0, integer: true },
        { key: 'economy', name: '經濟風格', description: '0 標準、1 保守（force 門檻高）、2 積極（force 門檻低）', min: 0, max: 2, default: 0, integer: true },
        { key: 'awpSlot', name: '狙擊手', description: '隊內序號幾號在錢夠時買狙擊槍（5 = 沒有狙擊手）', min: 0, max: 5, default: 4, integer: true },
        { key: 'ctSplitA', name: 'CT 守 A 人數', description: 'CT 開局守 A 點的人數（B 固定 2 人，其餘守中路）', min: 0, max: 5, default: P.ctSplitA, integer: true },
        { key: 'plan', name: 'T 計畫', description: '0 自動（依經濟與侵略抽）；1 default、2 rush、3 split、4 fake（指揮才有作用）', min: 0, max: 4, default: 0, integer: true },
        { key: 'role', name: '角色', description: '0 自動（依隊內序號）；1 突破手、2 支援、3 錨點、4 狙擊手（錢夠就買狙擊槍）、5 游擊', min: 0, max: 5, default: 0, integer: true },
      ],
    };
  }

  /**
   * @param {import('./base.js').InitData} data
   * @param {import('./base.js').Helpers} helpers
   */
  init(data, helpers) {
    this.data = data;
    this.h = helpers;
    initTrig(helpers);
    const k = data.knobs;
    /** @param {import('./base.js').AttributeKey} key */
    const at = (key) => clamp((data.attributes?.[key] ?? 50) / 100, 0, 1);
    const awpSlot = k.awpSlot ?? 4;
    const role = (k.role ?? 0) > 0 ? /** @type {number} */ (k.role) : autoRole(data.slot, awpSlot);
    const attrs = {
      aim: at('aim'),
      offAim: role === AWP ? clamp(at('aim') - P.awpOffAim, 0, 1) : at('aim'),
      reaction: at('reaction'),
      awareness: at('awareness'),
      aggression: clamp(at('aggression') + (k.aggression ?? 0) / 100, 0, 1),
      discipline: at('discipline'),
      movement: at('movement'),
    };
    this.attrs = attrs;
    this.g = new Grid(data.map);
    this.intel = new MapIntel(data.map, this.g);
    this.perc = new Perception(this.g, this.intel, data, attrs.awareness);
    this.nav = new Navigator(this.g, this.intel, this.perc, attrs, data);
    this.judge = new Judgment(this.g, this.intel, this.perc, data);
    this.mission = new Mission(data, this.judge);
    this.combat = new Combat(this.g, this.intel, this.perc, this.nav, attrs, data, helpers);
    this.tactics = new Tactics(this.g, this.intel, this.perc, data, helpers, { awpSlot, role, economy: k.economy ?? 0, ctSplitA: k.ctSplitA ?? P.ctSplitA, plan: k.plan ?? 0 }, attrs);
    this.tactics.combat = this.combat;
    this.tactics.nav = this.nav;
    this.tactics.judge = this.judge;
    this.tactics.mission = this.mission;
    /** 3.0 效用層（影子模式：只算分與記錄） */
    this.choice = new Choice(this.g, this.intel, this.perc, data);
  }

  /** @param {import('./base.js').Observation} obs */
  newRound(obs) {
    this.round = obs.round.number;
    this.perc.reset();
    this.nav.reset();
    this.judge?.reset();
    this.mission?.reset();
    this.combat.reset();
    this.tactics.reset(obs);
    this.choice?.reset();
  }

  /**
   * @param {import('./base.js').Observation} obs
   * @returns {import('./base.js').Command[]}
   */
  decide(obs) {
    const me = obs.me;
    if (obs.round.number !== this.round) this.newRound(obs);
    if (!me.alive || obs.round.phase === 'over') return [];
    this.perc.update(obs);
    if (obs.enemiesAlive === 0) {
      this.perc.clearEnemies();
      this.combat.clearTargets();
    }
    this.combat.track(obs);
    const ev = this.combat.evade(obs);
    const T = this.tactics;
    const tac = T.update(obs);
    // 3.0 第 6 步切換：效用層選動作與視線（choiceDrive）；否則照 r7l（效用層只在影子模式記錄）
    const drive = P.choiceDrive && this.choice !== null;
    if (!drive) T.finish(obs, tac, T.lastWish);
    const holding = tac.hold !== null && dist(me.x, me.y, tac.hold.x, tac.hold.y) < 900;
    const fight = this.combat.engage(obs, { holding, objective: tac.objective });
    const C = this.choice;
    /** 效用層選定的動作（切換後才有；指揮層／硬反射接管移動時不執行） @type {import('./choice.js').Cand | null} */
    let act = null;
    /** 補槍動作的看向 @type {import('./base.js').Pt | null} */
    let tlook = null;
    if (drive) {
      C.step(obs, this.intent(obs, tac, fight.engaged, ev !== null, false));
      act = obs.round.phase === 'freeze' ? null : C.cur;
      // 丟道具：效用層選的道具筆與落點（下拆包進行中不丟；丟出後到下一次決策前不再丟）
      const it = act !== null && act.type === 'g' && !C.gDone && !tac.objective && !tac.commit && !tac.urgent && !tac.escape ? C.nitems[Math.floor(act.ref / 4)] : undefined;
      T.finish(obs, tac, it === undefined || act === null || act.kind === undefined ? null : { kind: /** @type {import('./base.js').GrenadeId} */ (act.kind), x: act.x, y: act.y, why: `效用・${act.why ?? it.pur}` }, it?.it ?? null);
      if (T.thrownNow !== null) C.gDone = true;
    }
    /** @type {import('./base.js').Command[]} */
    const out = [];
    /** 下包、拆包這類要最後送（移動會取消它們） @type {import('./base.js').Command[]} */
    const late = [];
    // 移動目標：指揮層／硬反射接管（撤離、期限承諾、躲閃光、交戰中）時照 PlanIntent；否則執行效用層的動作
    const own = !drive || act === null || tac.escape || tac.commit === true || tac.urgent || fight.engaged;
    // 切換後下包、拆包也是效用層的動作 o（指揮層要下拆包時才是候選）；指揮層或硬反射接管移動時（期限承諾等），指揮層的下拆包指令照送
    for (const c of tac.cmds) {
      if (c.type === 'plant' || c.type === 'defuse') {
        if (own || (act !== null && act.type === 'o')) late.push(c);
      } else out.push(c);
    }
    let goal = tac.goal;
    let route = tac.route;
    let stop = tac.stop;
    /** @type {import('./nav.js').Peek | null | undefined} */
    let peek = drive ? null : undefined;
    if (!own && act !== null) {
      stop = tac.halt === true;
      const near = (/** @type {import('./base.js').Pt} */ p) => tac.goal !== null && dist(p.x, p.y, tac.goal.x, tac.goal.y) < UNIT;
      if (act.type === 'h' && act.ref === HERE) stop = true;
      // 來自 PlanIntent 的目標或守點：跟著指揮層這一步的最新值走（決策之間目標會更新）
      else if (act.src === 'goal' && tac.goal !== null) {
        goal = tac.goal;
        route = tac.route;
      } else if (act.src === 'hold' && tac.hold !== null) {
        goal = { x: tac.hold.x, y: tac.hold.y };
        route = near(tac.hold) ? tac.route : null;
      } else if (act.type === 'h' || act.type === 'a' || act.type === 'f' || act.type === 'r') {
        goal = { x: act.x, y: act.y };
        route = near(act) ? tac.route : null;
      } else if (act.type === 'p') peek = C.pk?.nav ?? null;
      else if (act.type === 't') {
        const q = C.cues.get(act.ref);
        const sp = q === undefined ? null : T.coop.spotFor(obs, q);
        if (sp !== null) {
          goal = sp.goal;
          route = null;
          tlook = sp.look;
        }
      } else if (act.type === 'o') stop = true;
    }
    if (goal !== null) this.nav.setGoal(goal.x, goal.y, route);
    else this.nav.clearGoal();
    const w = this.combat.weapon(me.weapon);
    const speed = (w?.speed ?? 130) * (me.walking ? 0.52 : 1) * (me.crouching ? 0.34 : 1);
    const free = !tac.commit && !fight.engaged && ev === null;
    const nav = this.nav.step(obs, { allowPeek: (peek === undefined ? tac.allowPeek : peek !== null) && free, speed, evading: ev !== null, priority: tac.commit, peek });
    const ahead = this.nav.wps[this.nav.wpIdx] ?? goal;
    const check = ahead !== null && !fight.engaged && ev === null && !tac.objective && !tac.urgent && !stop && !tac.escape && !tac.commit && dist(me.x, me.y, ahead.x, ahead.y) > 900 ? this.judge?.approach(obs, ahead) : null;
    // ── 移動：自保 → 交戰 → 架槍 → 導航 ──
    let moving = false;
    let navUsed = false;
    /** 先架危險角度的停步在 out 的位置（−1＝沒有） */
    let ckIdx = -1;
    if (!tac.objective) {
      if (ev !== null && ev.move !== null) {
        out.push({ type: 'move', x: Math.round(ev.move.x), y: Math.round(ev.move.y) });
        moving = true;
      } else if (ev !== null) out.push({ type: 'stop' });
      else if (tac.escape) {
        out.push(...nav.cmds);
        moving = nav.moving;
        navUsed = true;
      } else if (tac.commit && !fight.engaged) {
        out.push(...nav.cmds);
        moving = nav.moving;
        navUsed = true;
      } else if (fight.move === 'stop') out.push({ type: 'stop' });
      else if (fight.move !== null) {
        out.push({ type: 'move', x: Math.round(fight.move.x), y: Math.round(fight.move.y) });
        moving = true;
      } else if (fight.holdNav || (stop && !fight.engaged)) out.push({ type: 'stop' });
      else if (check?.stop) {
        // 先架危險角度的停步：切換後要看視線頭這一拍有沒有採用預瞄 j（耦合規則），在視線頭之後決定
        ckIdx = out.length;
        out.push({ type: 'stop' });
      } else {
        out.push(...nav.cmds);
        moving = nav.moving;
        navUsed = true;
      }
    }
    // ── 瞄準 ──
    const next = this.nav.wps[this.nav.wpIdx + 1] ?? this.nav.wps[this.nav.wpIdx] ?? null;
    const mv = { holding: holding && !moving, moving, ahead: next };
    /** 視線頭的看向（切換後；不歸視線頭管的拍是 null） @type {import('./base.js').Pt | null} */
    let head = null;
    if (drive) {
      C.look(obs, this.lookIn(obs, tac, nav, fight.engaged, ev !== null, mv, own ? tac.look : (tlook ?? tac.look), check), obs.round.phase === 'freeze');
      if (C.lstat?.active === true && C.lk !== null) head = { x: C.lk.x, y: C.lk.y };
      // 耦合規則（第 6 步修正，根因甲）：視線頭這一拍歸它管、卻沒採用預瞄 j（被探頭或受傷方向蓋過，或計分沒選它），就不送先架危險角度的停步，照導航走
      if (ckIdx >= 0 && C.lstat?.active === true && C.lk?.t !== 'j') {
        out.splice(ckIdx, 1, ...nav.cmds);
        moving = nav.moving;
        navUsed = true;
      }
    }
    if (!navUsed) this.nav.idle();
    const aim = ((tac.urgent && !fight.engaged) || tac.hard ? tac.look : null) ?? (fight.engaged ? fight.aim : head ?? this.combat.alert(obs, holding) ?? check?.look) ?? fight.aim ?? tac.look ?? this.combat.look(obs, { hold: tac.hold, holding: holding && !moving, navLook: nav.look, ahead: next });
    if (aim !== null && (Math.abs(aim.x - me.x) > 50 || Math.abs(aim.y - me.y) > 50)) out.push({ type: 'aim', x: Math.round(aim.x), y: Math.round(aim.y) });
    // ── 開火與武器 ──
    // 所有開火分支（交戰、佯攻）都過同一道友軍檢查
    const shoot = (fight.fire || (tac.noise && !fight.engaged)) && !tac.objective && !tac.hard;
    out.push({ type: 'fire', on: shoot && this.combat.lineClear(obs, aim === null ? [] : [aim]) });
    out.push(...fight.cmds.filter((c) => !(tac.escape || (tac.commit && !fight.engaged)) || c.type !== 'scope' || !c.on));
    if (tac.commit && me.scoped && !fight.engaged) out.push({ type: 'scope', on: false });
    if (!fight.engaged) out.push(...this.combat.upkeep(obs, holding && !moving));
    // ── 姿勢：移動時不蹲 ──
    const crouch = moving ? false : ev !== null ? ev.crouch : (fight.crouch ?? false);
    if (crouch !== me.crouching) out.push({ type: 'crouch', on: crouch });
    const walk = (tac.walk ?? nav.walk) && !tac.commit && !fight.engaged && ev === null;
    if (walk !== me.walking) out.push({ type: 'walk', on: walk });
    out.push(...late);
    if (!drive && P.choiceShadow && C !== null) {
      C.step(obs, this.intent(obs, tac, fight.engaged, ev !== null, true, nav));
      C.look(obs, this.lookIn(obs, tac, nav, fight.engaged, ev !== null, mv, tac.look, check), obs.round.phase === 'freeze');
    }
    const reason = this.mission?.reason ?? '';
    const tag = act === null ? '' : `・${act.type}`;
    this.why = `${ROLE_NAME[this.tactics.roles.of(me.id)]}・${tac.role}${tag}${reason ? `・${reason}` : ''}｜${ev !== null && !tac.objective ? ev.why : fight.why || check?.why || (nav.peeking ? `探頭 ${this.nav.peek?.phase ?? ''}` : nav.moving ? '移動' : '待命')}`;
    return out;
  }

  /**
   * 3.0：stage 'wait'＝已經執行、計畫裡進點的煙或閃（目標是這次執行的包點）還沒丟（資源層的狀態，不看 r7l 停不停）
   * @param {import('./base.js').Observation} obs
   */
  utilPending(obs) {
    const T = this.tactics;
    const p = T.plan;
    if (p === null || p.kind === 'hold' || !T.res.active) return false;
    const exec = p.exec ?? p.site;
    const alive = new Set([obs.me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)]);
    return T.res.items.some((it) => (it.purpose === 'entrySmoke' || it.purpose === 'entryFlash') && it.state === 'plan' && it.target.site === exec && alive.has(it.owner));
  }

  /**
   * 視線頭的輸入（每個 decide tick）。不接管的看向＝躲閃光與守包撤離（urgent／hard）、丟道具的瞄準、下拆包、交戰中與自保
   * @param {import('./base.js').Observation} obs @param {import('./tactics.js').TacOut} tac @param {import('./nav.js').NavOut} nav
   * @param {boolean} engaged @param {boolean} evading
   * @param {{ holding: boolean, moving: boolean, ahead: import('./base.js').Pt | null }} mv 這一步的守位、移動與行進方向
   * @param {import('./base.js').Pt | null} actLook 動作附帶的看向（等槍線、補槍、佯攻）
   * @param {{ look: import('./base.js').Pt | null, stop: boolean } | null | undefined} check 先架危險角度（judgment.approach）這一拍的結果
   * @returns {import('./choice.js').LookIn}
   */
  lookIn(obs, tac, nav, engaged, evading, mv, actLook, check) {
    const me = obs.me;
    const T = this.tactics;
    const near = (/** @type {import('./base.js').Pt} */ p) => dist(me.x, me.y, p.x, p.y);
    const pk = nav.peeking ? this.nav.peek : null;
    const own = tac.urgent || tac.hard || T.utilLook;
    return {
      active: obs.round.phase !== 'freeze' && obs.round.phase !== 'over' && obs.enemies.length === 0 && !engaged && !evading && !own && !tac.objective,
      peek: pk === null ? null : { x: pk.far.x, y: pk.far.y, lock: pk.phase === 'hold' || pk.phase === 'shoulder' },
      hold: tac.hold !== null && near(tac.hold) < 3 * UNIT ? { x: tac.hold.x, y: tac.hold.y, fx: tac.hold.fx, fy: tac.hold.fy } : null,
      holding: mv.holding, moving: mv.moving,
      act: actLook !== null && !own ? { x: actLook.x, y: actLook.y } : null,
      pre: check === null || check === undefined || check.look === null ? null : { x: check.look.x, y: check.look.y, stop: check.stop },
      ahead: mv.ahead, soundReact: this.combat.soundReact,
    };
  }

  /**
   * 效用層的輸入：PlanIntent（指揮層這一步的目標、守點、階段、計畫）、資源層與觸發紀錄、個人狀態。
   * shadow＝影子模式（切換前的量測）：另外把 r7l 這一步的實際動作分類記下（一致率用）
   * @param {import('./base.js').Observation} obs @param {import('./tactics.js').TacOut} tac
   * @param {boolean} engaged @param {boolean} evading @param {boolean} shadow @param {import('./nav.js').NavOut} [nav]
   * @returns {import('./choice.js').ShadowIn}
   */
  intent(obs, tac, engaged, evading, shadow, nav) {
    const me = obs.me;
    const T = this.tactics;
    const b = obs.bomb.state;
    const planted = b === 'planted' || b === 'defusing';
    /** @type {import('./choice.js').Stage} */
    const stage = obs.round.phase === 'freeze' ? 'freeze'
      : tac.task === 'save' || T.saving ? 'save'
        : planted ? (me.team === 'T' ? 'post' : 'retake')
          : me.team === 'T' && T.execTick >= 0 ? (this.utilPending(obs) ? 'wait' : 'execute') : 'setup';
    const hold = tac.hold === null ? null : { x: tac.hold.x, y: tac.hold.y };
    const peek = this.nav.peek === null ? null : this.nav.peek.hold;
    // 硬反射（不算分母）：火區與手雷自保、避火、閃光躲避與等閃（設計第二節第 2、3 項）
    const reflex = evading || (tac.escape && tac.task !== 'save') || T.util.away !== null || T.mateFlash.some((x) => obs.tick <= x.pop + 2);
    // 丟道具（第 5 步）：候選由效用層從資源層與指揮層的觸發紀錄自己產生（不看 lastWish）
    const g = this.g;
    // 丟出那一步：用丟出前的煙、火、閃光紀錄與資源層狀態（影子量測的假象；切換後丟出在效用層決策之後，不會發生）
    const tn = T.thrownNow;
    const fs = T.flashSpots;
    const lastFs = tn?.kind === 'flash' && fs.length > 0 && fs[fs.length - 1].tick === obs.tick;
    /** @type {import('./choice.js').NadeIn} */
    const nade = {
      res: T.res,
      trig: T.trig,
      solve: (x, y) => T.util.solve(me.x, me.y, x, y) !== null,
      fighting: (id) => {
        const m = obs.teammates.find((q) => q.id === id);
        return obs.tick - (T.mateFired.get(id) ?? -1e9) < 1.5 * T.tps || (m !== undefined && this.perc.threats(m.x, m.y, 30).some((k) => dist(k.x, k.y, m.x, m.y) < 30 * UNIT && g.los(k.x, k.y, m.x, m.y)));
      },
      canHide: (x, y, c) => T.canHide(x, y, c, 4),
      flashR: T.util.flashRadius,
      smokes: tn?.kind === 'smoke' ? T.smokes.slice(0, -1) : T.smokes,
      burns: tn?.kind === 'molotov' || tn?.kind === 'incendiary' ? T.burns.slice(0, -1) : T.burns,
      used: tn?.it === null || tn === null ? null : { it: tn.it, state: tn.state },
      info: (p, site) => T.flashInfo(obs, p, site),
      deep: (s) => T.deepSpots(s),
      taken: (p) => {
        if (!lastFs) return T.flashTaken(obs, p);
        T.flashSpots = fs.slice(0, -1);
        const r = T.flashTaken(obs, p);
        T.flashSpots = fs;
        return r;
      },
      ent: T.planEnt,
      awp: T.awp,
      post: me.team === 'T' && planted && obs.bomb.site !== null ? T.postEnt(obs, obs.bomb.site) : null,
    };
    // 照路徑再走 3 格的位置（封槍線的起點；和指揮層 lineCheck 同一個算法）
    const w0 = this.nav.wps[this.nav.wpIdx];
    const k0 = w0 === undefined ? 0 : Math.min(1, (3 * UNIT) / Math.max(dist(me.x, me.y, w0.x, w0.y), 1));
    const soon = w0 === undefined ? null : { x: me.x + (w0.x - me.x) * k0, y: me.y + (w0.y - me.y) * k0 };
    const near = (/** @type {import('./base.js').Pt} */ p) => dist(me.x, me.y, p.x, p.y);
    const objOk = tac.objective || tac.cmds.some((c) => c.type === 'plant' || c.type === 'defuse');
    /** 影子模式：r7l 這一步實際做的動作 @type {{ type: import('./choice.js').Act, x: number, y: number, ref?: number, kind?: string } | null} */
    let actual = null;
    if (shadow) {
      const wish = T.lastWish;
      const cues = [...T.coop.cues].map(([id, q]) => ({ id, x: q.x, y: q.y, dead: q.dead }));
      if (objOk) actual = { type: 'o', x: obs.bomb.x ?? me.x, y: obs.bomb.y ?? me.y };
      else if (wish !== null) actual = { type: 'g', x: wish.x, y: wish.y, kind: wish.kind };
      else if (nav?.peeking === true && peek !== null) actual = { type: 'p', x: peek.x, y: peek.y };
      else if (T.coop.acted) {
        // 跟進的是哪個隊友：離 r7l 選的站位最近的線索
        const gx = tac.goal?.x ?? me.x;
        const gy = tac.goal?.y ?? me.y;
        const cue = cues.reduce((q0, q) => (q0 === null || dist(q.x, q.y, gx, gy) < dist(q0.x, q0.y, gx, gy) ? q : q0), /** @type {typeof cues[number] | null} */ (null));
        actual = { type: 't', x: gx, y: gy, ref: cue?.id ?? -1 };
      }
      else if (hold !== null && near(hold) < 3 * UNIT) actual = near(hold) > UNIT ? { type: 'h', x: hold.x, y: hold.y } : { type: 'h', x: me.x, y: me.y };
      else if (tac.stop || tac.goal === null) actual = { type: 'h', x: me.x, y: me.y };
      else if (near(tac.goal) < P.U.holdZone * UNIT) actual = near(tac.goal) > UNIT ? { type: 'h', x: tac.goal.x, y: tac.goal.y } : { type: 'h', x: me.x, y: me.y };
      else actual = { type: 'a', x: tac.goal.x, y: tac.goal.y };
    }
    const p = T.prof === null || T.tagNow === null ? 0.5 : T.pOf(T.tagNow);
    const inSite = SITE_IDS.some((k) => { const r = this.intel.sites[k].rect; const cx = me.x / UNIT, cy = me.y / UNIT; return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1; });
    const pathless = tac.goal !== null && this.nav.path.length === 0 && near(tac.goal) > UNIT;
    // PlanIntent 的合法等待（指揮層）：2.8 執行品質（熟練度低的慢半拍、跟上、慢了一步、跟上隊形）
    const planWait = T.waitTag === 'qpause' || T.waitTag === 'qlag' || T.waitTag === 'qsync' || T.waitTag === 'qflash';
    // f21 進點順序（取代 yieldTo、spawnWait 的條件；只讀，不碰 tactics 的計時器與快取）
    const plan = T.plan;
    const exec = me.team === 'T' && plan !== null && plan.kind !== 'hold' && T.execTick >= 0 ? (plan.exec ?? plan.site) : null;
    const c0 = this.g.cellOf(me.x, me.y);
    let spawnF = 0;
    const ent = obs.teammates.find((m) => m.alive && m.id === T.roles.who(ENTRY));
    const site0 = exec ?? (plan !== null && plan.kind !== 'hold' ? plan.site : null);
    if (me.team === 'T' && site0 !== null && plan !== null && plan.kind !== 'go' && ent !== undefined && c0 >= 0 && this.intel.distSpawn.T[c0] <= P.spawnLead * 10 && (T.groups?.get(ent.id) ?? 0) === (T.groups?.get(me.id) ?? 0)) {
      const ce = this.g.cellOf(ent.x, ent.y);
      const dS = this.intel.distSite[site0];
      // r7l 的時間上限：先停 P.spawnStop 秒（之後慢走，靜步由指揮層的 walk 給），每回合最多 P.spawnLeadMax 秒（計時在 tactics.spawnWait）
      if (ce >= 0 && dS[ce] >= dS[c0] - 10 && T.spawnHeld <= P.spawnStop * T.tps && T.spawnHeld < P.spawnLeadMax * T.tps) spawnF = 1;
    }
    const awpF = T.roles.of(me.id) === AWP && me.loadout.primary === 'awp' && hold !== null && near(hold) < 4 * UNIT ? 1 : 0;
    return {
      stage, goal: tac.goal, hold, role: T.roles.of(me.id), p, fight: engaged, reflex, actual, inSite, peek, nade, pathless, planWait, order: { spawnF, awpF },
      exec, planGo: plan === null || plan.kind === 'go', entryId: T.roles.who(ENTRY),
      path: this.nav.path, allowPeek: tac.allowPeek && !tac.commit, follow: tac.task === 'execute' || tac.task === 'retake', objOk,
      rush: plan !== null && plan.kind === 'rush', flashed: obs.tick >= T.flashPop && obs.tick < T.flashPop + 2 * T.tps, flashOwner: T.flashOwner,
      // 探一次停幾個決策：停 peekHold，低積極、高走位的人再側身出去 3、退回 3
      peekLen: this.nav.peekHold + (this.nav.attrs.aggression * 100 < P.shoulderBelow && this.nav.attrs.movement * 100 >= P.shoulderMove ? 6 : 0),
      // 計畫包點（T：這次執行的包點或計畫包點；CT：守點所在包點）：落點找不到所在包點時用
      site: site0 !== null ? SITE_IDS.indexOf(site0) : this.choice.siteOf(hold ?? tac.goal), soon,
      cover: () => this.nav.findCover(obs, this.perc.threats(me.x, me.y), undefined),
      trade: (q) => T.coop.spotFor(obs, q) !== null,
      group: (id) => T.groups?.get(id) ?? 0,
    };
  }
}
