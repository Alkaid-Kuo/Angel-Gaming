// @ts-check
// 戰力預估：用引擎實測的傷害速率表（estimate-table.js）推估兩群部隊打一陣子後雙方各剩多少，給指揮官判斷「這仗划不划算」。
// 模型：逐秒模擬，每團挑打起來最划算的敵團，傷害依自己剩下的血量比例縮放；同一個敵團最多四團圍，第三團以後是從側背打（×1.5）。
// 再乘上規則倍率（淺灘裡挨打 ×1.2、高處往下打每階 +10%、被側背打的比例）。架好槍林的長槍正面挨打 ×0.5、攻速 ×1.7；
// 盾牆正面挨打再 ×0.36（75% 減免換算成相對持盾 30%）。前排擋後排：對方還有沒被纏住的近戰部隊時打不到它的弓兵；
// 弓兵沒人貼身就照射（接觸前所有弓兵都射），被貼身才改近戰。
import { ARROW_DPS, CHARGE_HIT, MELEE_DPS } from './estimate-table.js';

/**
 * 一團的狀態（自己的或敵方的都用這個）；braced：架好槍林正面對著對方；walled：盾牆正面對著對方
 * @typedef {{ kind: string, hp: number, hpMax: number, cost: number, braced?: boolean, walled?: boolean }} FightUnit
 */

/**
 * 一方的條件
 * @typedef {{ wet?: boolean, height?: number, flank?: number, covered?: number }} FightSide
 * wet：站在淺灘裡（近戰挨打 ×1.2）；height：所在高度階；flank：被打到側背的比例（0～1，側背擊平均 ×1.75）；
 * covered：弓箭被盾兵掩護擋掉的比例（0～1）
 */

/**
 * @param {readonly FightUnit[]} a
 * @param {readonly FightUnit[]} b
 * @param {{ a?: FightSide, b?: FightSide, seconds?: number, approach?: number }} [opt]
 *   seconds：打多久（預設 40 秒）；approach：接觸前弓兵能先射幾秒（預設 0）
 * @returns {{ aLost: number, bLost: number, aLeft: number, bLeft: number }} 雙方損失與剩下的點數（依血量比例 × 點數）
 */
export function estimateFight(a, b, opt = {}) {
  const sa = opt.a || {};
  const sb = opt.b || {};
  const ha = a.map((u) => u.hp);
  const hb = b.map((u) => u.hp);
  const seconds = opt.seconds ?? 40;
  const approach = opt.approach ?? 0;
  const hdiff = Math.max(-3, Math.min(3, (sa.height || 0) - (sb.height || 0)));
  /**
   * 一方對另一方這一秒造成的傷害
   * @param {readonly FightUnit[]} us
   * @param {number[]} hu
   * @param {readonly FightUnit[]} them
   * @param {number[]} ht
   * @param {FightSide} mine
   * @param {FightSide} theirs
   * @param {number} up 我方比對方高幾階
   * @param {boolean} contact
   * @param {number[]} pressed 上一秒我方各團被幾團近身（弓兵沒被近身就照射）
   * @returns {{ dmg: number[], load: number[] }} 對方各團這一秒的損失、被我方幾團近身
   */
  const strike = (us, hu, them, ht, mine, theirs, up, contact, pressed) => {
    const dmg = them.map(() => 0);
    const load = them.map(() => 0);
    // 對方還有沒被我方纏住的近戰部隊：它的弓兵在後排打不到（先分配近戰目標，所以這裡用「對方近戰團數 > 已分配的」近似）
    const melee = them.filter((t, j) => ht[j] > 0 && t.kind !== 'archer').length;
    const archersFirst = us.filter((u, i) => hu[i] > 0 && u.kind !== 'archer').length;
    const screened = melee > 0 && archersFirst <= melee;
    us.forEach((u, i) => {
      if (hu[i] <= 0) return;
      const share = hu[i] / u.hpMax;
      if (u.kind === 'archer' && (!contact || pressed[i] === 0)) {
        // 弓兵：接觸前、或沒被近身就射（射血最多的那團，扣掉盾兵掩護）
        let t = -1;
        for (let j = 0; j < them.length; j++) if (ht[j] > 0 && (t < 0 || ht[j] > ht[t])) t = j;
        if (t >= 0) dmg[t] += (ARROW_DPS[them[t].kind] || 0) * share * (1 - (theirs.covered || 0)) * (1 + 0.1 * up);
        return;
      }
      if (!contact) return;
      let best = -1;
      let bestV = -1;
      for (let j = 0; j < them.length; j++) {
        if (ht[j] <= 0 || load[j] >= 4) continue;
        const t = them[j];
        if (t.kind === 'archer' && screened && u.kind !== 'lightCav' && u.kind !== 'heavyCav') continue;
        let v = (MELEE_DPS[u.kind] && MELEE_DPS[u.kind][t.kind]) || 0;
        if (t.braced) v *= 0.5;
        if (t.walled) v *= 0.36;
        if (load[j] >= 2) v *= 1.5;
        if (v > bestV) {
          bestV = v;
          best = j;
        }
      }
      if (best < 0) return;
      load[best] += 1;
      const flank = 1 + 0.75 * (theirs.flank || 0);
      dmg[best] += bestV * share * flank * (u.braced ? 1.7 : 1) * (theirs.wet ? 1.2 : 1) * (1 + 0.1 * up);
    });
    return { dmg, load };
  };
  let pa = a.map(() => 0);
  let pb = b.map(() => 0);
  for (let t = 0; t < seconds; t++) {
    const contact = t >= approach;
    const sb2 = strike(b, hb, a, ha, sb, sa, -hdiff, contact, pb);
    const sa2 = strike(a, ha, b, hb, sa, sb, hdiff, contact, pa);
    pa = sb2.load;
    pb = sa2.load;
    for (let i = 0; i < ha.length; i++) ha[i] = Math.max(0, ha[i] - sb2.dmg[i]);
    for (let j = 0; j < hb.length; j++) hb[j] = Math.max(0, hb[j] - sa2.dmg[j]);
    const left = (/** @type {number[]} */ h, /** @type {readonly FightUnit[]} */ us) => h.reduce((s, v, i) => s + v / us[i].hpMax, 0) / Math.max(1, us.length);
    if (left(ha, a) < 0.15 || left(hb, b) < 0.15) break;
  }
  const value = (/** @type {number[]} */ h, /** @type {readonly FightUnit[]} */ us) => h.reduce((s, v, i) => s + (v / us[i].hpMax) * us[i].cost, 0);
  const aStart = value(a.map((u) => u.hp), a);
  const bStart = value(b.map((u) => u.hp), b);
  const aLeft = value(ha, a);
  const bLeft = value(hb, b);
  return { aLost: aStart - aLeft, bLost: bStart - bLeft, aLeft, bLeft };
}

/**
 * 騎兵衝鋒的預估打擊：衝沒架槍林的 target（rear = 從側背衝），回傳 target 損失的點數與騎兵損失的點數（滿編時的實測值依血量比例縮放）
 * @param {FightUnit} cav
 * @param {FightUnit} target
 * @param {boolean} rear
 */
export function estimateCharge(cav, target, rear) {
  const row = CHARGE_HIT[cav.kind] && CHARGE_HIT[cav.kind][target.kind];
  if (!row) return { dealt: 0, taken: 0 };
  const share = cav.hp / cav.hpMax;
  const hit = Math.min(target.hp, (rear ? row[2] : row[0]) * share);
  const taken = Math.max(0, rear ? row[3] : row[1]);
  return { dealt: (hit / target.hpMax) * target.cost, taken: (taken / cav.hpMax) * cav.cost };
}
