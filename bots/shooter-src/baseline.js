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
import { Grid, P, clamp, dist, initTrig } from './base.js';
import { MapIntel } from './analysis.js';
import { Perception } from './memory.js';
import { Navigator } from './nav.js';
import { Combat } from './combat.js';
import { Tactics } from './tactics.js';
import { AWP, ROLE_NAME, autoRole } from './roles.js';

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
    this.round = -1;
    /** 除錯用：最近一次決策的說明 */
    this.why = '';
  }

  /** @returns {import('./base.js').Declaration} */
  declare() {
    return {
      name: 'shooter-baseline',
      version: '2.1',
      style: '基準',
      knobs: [
        { key: 'aggression', name: '侵略偏移', description: '加在屬性「侵略」上的偏移（−50～50）：影響探頭方式、撤退門檻、架槍時間', min: -50, max: 50, default: 0, integer: true },
        { key: 'economy', name: '經濟風格', description: '0 標準、1 保守（不半買）、2 積極（差一點也全買、半買門檻低）', min: 0, max: 2, default: 0, integer: true },
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
    this.combat = new Combat(this.g, this.intel, this.perc, this.nav, attrs, data, helpers);
    this.tactics = new Tactics(this.g, this.intel, this.perc, data, helpers, { awpSlot, role, economy: k.economy ?? 0, ctSplitA: k.ctSplitA ?? P.ctSplitA, plan: k.plan ?? 0 }, attrs);
    this.tactics.combat = this.combat;
    this.tactics.nav = this.nav;
  }

  /** @param {import('./base.js').Observation} obs */
  newRound(obs) {
    this.round = obs.round.number;
    this.perc.reset();
    this.nav.reset();
    this.combat.reset();
    this.tactics.reset(obs);
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
    this.combat.track(obs);
    const tac = this.tactics.update(obs);
    /** @type {import('./base.js').Command[]} */
    const out = [];
    /** 下包、拆包這類要最後送（移動會取消它們） @type {import('./base.js').Command[]} */
    const late = [];
    for (const c of tac.cmds) (c.type === 'plant' || c.type === 'defuse' ? late : out).push(c);
    if (tac.goal !== null) this.nav.setGoal(tac.goal.x, tac.goal.y, tac.route);
    else this.nav.clearGoal();
    const ev = this.combat.evade(obs);
    const holding = tac.hold !== null && dist(me.x, me.y, tac.hold.x, tac.hold.y) < 900;
    const fight = this.combat.engage(obs, { holding, objective: tac.objective });
    const w = this.combat.weapon(me.weapon);
    const speed = (w?.speed ?? 130) * (me.walking ? 0.52 : 1) * (me.crouching ? 0.34 : 1);
    const nav = this.nav.step(obs, { allowPeek: tac.allowPeek && !fight.engaged && ev === null, speed });
    // ── 移動：自保 → 交戰 → 架槍 → 導航 ──
    let moving = false;
    if (!tac.objective) {
      if (ev !== null && ev.move !== null) {
        out.push({ type: 'move', x: Math.round(ev.move.x), y: Math.round(ev.move.y) });
        moving = true;
      } else if (ev !== null) out.push({ type: 'stop' });
      else if (fight.move === 'stop') out.push({ type: 'stop' });
      else if (fight.move !== null) {
        out.push({ type: 'move', x: Math.round(fight.move.x), y: Math.round(fight.move.y) });
        moving = true;
      } else if (fight.holdNav || (tac.stop && !fight.engaged)) out.push({ type: 'stop' });
      else {
        out.push(...nav.cmds);
        moving = nav.moving;
      }
    }
    // ── 瞄準 ──
    const next = this.nav.wps[this.nav.wpIdx + 1] ?? this.nav.wps[this.nav.wpIdx] ?? null;
    const aim = ((tac.urgent && !fight.engaged) || tac.hard ? tac.look : null) ?? fight.aim ?? tac.look ?? this.combat.look(obs, { hold: tac.hold, holding: holding && !moving, navLook: nav.look, ahead: next });
    if (aim !== null && (Math.abs(aim.x - me.x) > 50 || Math.abs(aim.y - me.y) > 50)) out.push({ type: 'aim', x: Math.round(aim.x), y: Math.round(aim.y) });
    // ── 開火與武器 ──
    out.push({ type: 'fire', on: (fight.fire || (tac.noise && !fight.engaged)) && !tac.objective && !tac.hard });
    out.push(...fight.cmds);
    if (!fight.engaged) out.push(...this.combat.upkeep(obs, holding && !moving));
    // ── 姿勢：移動時不蹲 ──
    const crouch = moving ? false : ev !== null ? ev.crouch : (fight.crouch ?? false);
    if (crouch !== me.crouching) out.push({ type: 'crouch', on: crouch });
    const walk = (tac.walk ?? nav.walk) && !fight.engaged && ev === null;
    if (walk !== me.walking) out.push({ type: 'walk', on: walk });
    out.push(...late);
    this.why = `${ROLE_NAME[this.tactics.roles.of(me.id)]}・${tac.role}｜${ev !== null ? ev.why : fight.why || (nav.peeking ? `探頭 ${this.nav.peek?.phase ?? ''}` : nav.moving ? '移動' : '待命')}`;
    return out;
  }
}
