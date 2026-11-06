// @ts-check
// 資源層（3.0 乙）：道具是組的資源。設計見 docs/2026-11-07_CS射擊_Bot3.0資源層設計.md。
// 每個 Bot 各持一份副本；狀態只由隊內喊話（U: 前綴）決定，所以全隊一致。只有指揮者（活著的最小 id）寫：
//   凍結第 1 次決策「U:b <id>:<種類字母>…」購買單 → 每人買完喊「U:h <種類字母>」持有 → 指揮者「U:p <token>…」道具計畫；
//   之後「U:u <序號|種類字母>」用掉、「U:x <序號> <原因>」放棄、「U:r <序號> <新擁有者|-> [目標]」重分配。
// token 5 字元：種類、用途、擁有者 id、目標包點（A／B／-）、目標入口序號（數字／S 包點內／-）。觸發條件由用途決定。
// 沒收到 U:p（例如隊友不是同一支 Bot）：active＝false，claim 一律放行，個人層照 2.8 行為。
// 喊話直接讀 obs.chat（不經警覺延遲），全隊同一個 tick 看到同一串，副本才會一致。

import { UNIT, dist } from './base.js';
import { ANCHOR, AWP, ENTRY, LURK, SUPPORT } from './roles.js';

/** @typedef {'entryFlash' | 'entrySmoke' | 'holdSmoke' | 'fireBackup' | 'fakeUtil' | 'chokeMolotov' | 'retakeSmoke' | 'retakeFlash'} Purpose */
/** @typedef {'f' | 's' | 'h' | 'm'} KindCode */
/** @typedef {{ site: 'A' | 'B' | null, ent: number }} Target ent：入口序號，-1＝包點內架點，-2＝未定 */
/**
 * @typedef {{ idx: number, owner: number, kind: KindCode, purpose: Purpose, target: Target, state: 'plan' | 'used' | 'lost' | 'free', backup: boolean }} UtilItem
 */
/** @typedef {{ purpose: Purpose, kinds: KindCode[], target: Target, roles: number[], must: boolean }} Need */

/** 種類 → 字母（燃燒瓶、燃燒彈同一個字母，陣營決定是哪個） @param {string} k @returns {KindCode} */
export const codeOf = (k) => (k === 'flash' ? 'f' : k === 'smoke' ? 's' : k === 'he' ? 'h' : 'm');
/** 字母 → 種類 @param {KindCode} c @param {'T' | 'CT'} team @returns {import('./base.js').GrenadeId} */
export const kindOf = (c, team) => (c === 'f' ? 'flash' : c === 's' ? 'smoke' : c === 'h' ? 'he' : team === 'T' ? 'molotov' : 'incendiary');

/** 用途 ↔ 字母 */
const PURPOSES = /** @type {const} */ (['entryFlash', 'entrySmoke', 'holdSmoke', 'fireBackup', 'fakeUtil', 'chokeMolotov', 'retakeSmoke', 'retakeFlash']);
const PCODE = 'aedbkcrq';
/** 保留不出借（到期前其他用途拿不走） */
export const RESERVED = new Set(['fireBackup', 'retakeSmoke', 'retakeFlash']);

/** @param {UtilItem} it */
export function encodeItem(it) {
  const s = it.target.site ?? '-';
  const e = it.target.ent >= 0 ? String(it.target.ent) : it.target.ent === -1 ? 'S' : '-';
  return `${it.kind}${PCODE[PURPOSES.indexOf(it.purpose)]}${it.owner}${s}${e}`;
}

/** @param {string} tok @param {number} idx @returns {UtilItem | null} */
export function decodeItem(tok, idx) {
  const m = /^([fshm])([aedbkcrq])(\d)([AB-])([0-9S-])$/.exec(tok);
  if (m === null) return null;
  return {
    idx,
    owner: Number(m[3]),
    kind: /** @type {KindCode} */ (m[1]),
    purpose: PURPOSES[PCODE.indexOf(m[2])],
    target: { site: m[4] === '-' ? null : /** @type {'A' | 'B'} */ (m[4]), ent: m[5] === 'S' ? -1 : m[5] === '-' ? -2 : Number(m[5]) },
    state: 'plan',
    backup: false,
  };
}

/** 持有字串「ffsm」↔ 字母陣列 @param {readonly string[]} grenades */
export const holdText = (grenades) => grenades.map(codeOf).sort().join('');

const T_FLASH = [SUPPORT, LURK, ANCHOR, 0, ENTRY, AWP];
const T_SMOKE = [SUPPORT, ANCHOR, LURK, 0, ENTRY, AWP];
const T_BACKUP = [ANCHOR, LURK, SUPPORT, 0, ENTRY, AWP];
const CT_ANY = [SUPPORT, LURK, ENTRY, 0, ANCHOR, AWP];

/**
 * 需求表（設計第四節）。plan 為 T 或 CT 計畫；ctx.ent(site, routeIdx) 回傳入口序號；ctx.choke 為 CT 關鍵路口的包點
 * @param {import('./tactics.js').Plan} plan
 * @param {{ ent: (site: 'A' | 'B', route: number) => number, choke: 'A' | 'B' }} ctx
 * @returns {Need[]}
 */
export function needsOf(plan, ctx) {
  /** @type {Need[]} */
  const out = [];
  const add = (/** @type {Purpose} */ purpose, /** @type {KindCode[]} */ kinds, /** @type {Target} */ target, /** @type {number[]} */ roles, must = true) => out.push({ purpose, kinds, target, roles, must });
  if (plan.kind === 'hold') {
    const other = ctx.choke === 'A' ? 'B' : 'A';
    add('chokeMolotov', ['m'], { site: ctx.choke, ent: ctx.ent(ctx.choke, 0) }, [ANCHOR, SUPPORT, LURK, ENTRY, 0, AWP]);
    add('retakeSmoke', ['s'], { site: null, ent: -2 }, CT_ANY);
    add('retakeFlash', ['f'], { site: null, ent: -2 }, CT_ANY);
    add('chokeMolotov', ['m'], { site: other, ent: ctx.ent(other, 0) }, [ANCHOR, SUPPORT, LURK, ENTRY, 0, AWP], false);
    return out;
  }
  const s = plan.site;
  const main = { site: s, ent: ctx.ent(s, plan.r1) };
  switch (plan.kind) {
    case 'rush':
      add('entryFlash', ['f'], main, T_FLASH);
      add('entryFlash', ['f'], main, T_FLASH);
      add('fireBackup', ['s'], main, T_SMOKE);
      break;
    case 'split':
      add('entrySmoke', ['s'], { site: s, ent: -1 }, T_SMOKE);
      add('entryFlash', ['f'], main, T_FLASH);
      add('entryFlash', ['f'], { site: s, ent: ctx.ent(s, plan.r2) }, T_FLASH);
      add('fireBackup', ['s'], main, T_BACKUP, false);
      break;
    case 'default':
    case 'fake':
      if (plan.kind === 'fake') {
        const f = s === 'A' ? 'B' : 'A';
        add('fakeUtil', ['h', 'm', 'f'], { site: f, ent: ctx.ent(f, plan.r2) }, [LURK, ANCHOR, 0, ENTRY, SUPPORT, AWP]);
      }
      add('holdSmoke', ['s'], { site: s, ent: -1 }, T_SMOKE);
      add('fireBackup', ['s'], main, T_BACKUP);
      add('entryFlash', ['f'], main, T_FLASH, false);
      break;
    default:
      // go（eco 集中直走）：只用已有的閃
      add('entryFlash', ['f'], main, T_FLASH, false);
      add('entryFlash', ['f'], main, T_FLASH, false);
  }
  return out;
}

/** 角色偏好的名次（不在表上排最後） @param {number[]} pref @param {number} role */
const prefRank = (pref, role) => {
  const i = pref.indexOf(role);
  return i < 0 ? pref.length : i;
};

/**
 * 購買單（指揮者，凍結第 1 次決策）：必要列（force 只有第一列 entryFlash）照角色偏好、可花的錢、id 排。
 * 可花的錢＝金錢 −（手上沒好槍就算步槍）− 甲 −（CT 拆彈器）；道具格與每種上限照規則。
 * @param {Need[]} needs @param {'full' | 'force' | 'half' | 'eco'} call
 * @param {{ id: number, money: number, good: boolean, role: number }[]} people
 * @param {{ team: 'T' | 'CT', rifle: number, armor: number, kit: number, price: (k: KindCode) => number, carry: (k: KindCode) => number, slots: number }} r
 * @returns {Map<number, KindCode[]>}
 */
export function buyOrders(needs, call, people, r) {
  /** @type {Map<number, KindCode[]>} */
  const out = new Map();
  if (call === 'eco' || call === 'half') return out;
  let rows = needs.filter((n) => n.must);
  if (call === 'force') rows = rows.filter((n) => n.purpose === 'entryFlash').slice(0, 1);
  const left = new Map(people.map((p) => [p.id, p.money - (p.good ? 0 : r.rifle) - r.armor - (r.team === 'CT' ? r.kit : 0)]));
  for (const n of rows) {
    const k = n.kinds[0];
    const ok = people.filter((p) => {
      const mine = out.get(p.id) ?? [];
      return (left.get(p.id) ?? 0) >= r.price(k) && mine.length < r.slots && mine.filter((x) => x === k).length < r.carry(k);
    });
    if (ok.length === 0) continue;
    // 分散：已經分到購買單的人排後面，再比角色偏好、可花的錢、id
    const got = (/** @type {number} */ id) => (out.get(id) ?? []).length;
    ok.sort((a, b) => got(a.id) - got(b.id) || prefRank(n.roles, a.role) - prefRank(n.roles, b.role) || (left.get(b.id) ?? 0) - (left.get(a.id) ?? 0) || a.id - b.id);
    const p = ok[0];
    out.set(p.id, [...(out.get(p.id) ?? []), k]);
    left.set(p.id, (left.get(p.id) ?? 0) - r.price(k));
  }
  return out;
}

/** @param {Map<number, KindCode[]>} m */
export const buyText = (m) => `U:b ${[...m].sort((a, b) => a[0] - b[0]).map(([id, ks]) => `${id}:${ks.join('')}`).join(' ')}`;

/** @param {string} text @returns {Map<number, KindCode[]> | null} */
export function parseBuyOrders(text) {
  if (!text.startsWith('U:b')) return null;
  /** @type {Map<number, KindCode[]>} */
  const m = new Map();
  for (const w of text.slice(3).trim().split(' ')) {
    const q = /^(\d):([fshm]+)$/.exec(w);
    if (q !== null) m.set(Number(q[1]), /** @type {KindCode[]} */ (q[2].split('')));
  }
  return m;
}

/**
 * 分配（指揮者）：需求表依序從持有裡找擁有者（角色偏好、id）；找不到就略過。上限 19 筆。
 * @param {Need[]} needs @param {Map<number, KindCode[]>} holds @param {(id: number) => number} roleOf
 * @returns {UtilItem[]}
 */
export function allocate(needs, holds, roleOf) {
  /** @type {Map<number, KindCode[]>} */
  const left = new Map([...holds].map(([id, ks]) => [id, [...ks]]));
  /** @type {UtilItem[]} */
  const items = [];
  for (const n of needs) {
    if (items.length >= 19) break;
    /** @type {{ id: number, k: KindCode } | null} */
    let best = null;
    let bk = Infinity;
    for (const [id, ks] of [...left].sort((a, b) => a[0] - b[0])) {
      for (let j = 0; j < n.kinds.length; j++) {
        if (!ks.includes(n.kinds[j])) continue;
        // 多種類可選（佯攻）：先比種類順序，再分散（已分到幾筆），再比角色
        const key = j * 1000 + items.filter((it) => it.owner === id).length * 10 + prefRank(n.roles, roleOf(id));
        if (key < bk) {
          bk = key;
          best = { id, k: n.kinds[j] };
        }
        break;
      }
    }
    if (best === null) continue;
    const ks = /** @type {KindCode[]} */ (left.get(best.id));
    ks.splice(ks.indexOf(best.k), 1);
    items.push({ idx: items.length, owner: best.id, kind: best.k, purpose: n.purpose, target: { ...n.target }, state: 'plan', backup: false });
  }
  return items;
}

/** @param {UtilItem[]} items */
export const itemsText = (items) => `U:p ${items.map(encodeItem).join(' ')}`.trimEnd();

export class Resources {
  /** @param {readonly number[]} ids 全隊 id（排序） @param {number} me @param {'T' | 'CT'} [team] */
  constructor(ids, me, team = 'T') {
    this.ids = ids;
    this.me = me;
    this.team = team;
    /** 道具計畫（收到 U:p 才有） @type {UtilItem[]} */
    this.items = [];
    this.active = false;
    /** 本回合聽到的購買單 @type {Map<number, KindCode[]> | null} */
    this.orders = null;
    /** 每人持有（U:h，扣掉 U:u） @type {Map<number, KindCode[]>} */
    this.holds = new Map();
    /** 自己喊過的：U:h、U:p */
    this.saidHold = false;
    this.saidPlan = false;
    /** 回防的點（聽到帶目標的 U:r 才設） @type {'A' | 'B' | null} */
    this.retakeSite = null;
  }

  reset() {
    this.items = [];
    this.active = false;
    this.orders = null;
    this.holds = new Map();
    this.saidHold = false;
    this.saidPlan = false;
    this.retakeSite = null;
  }

  /**
   * 吃喊話（全員，每次決策；包括自己喊的，副本才一致）
   * @param {readonly { from: number, text: string }[]} chat
   */
  read(chat) {
    for (const c of chat) {
      const t = c.text;
      if (!t.startsWith('U:')) continue;
      if (t.startsWith('U:b')) {
        if (this.orders === null) this.orders = parseBuyOrders(t);
      } else if (t.startsWith('U:h')) {
        this.holds.set(c.from, /** @type {KindCode[]} */ (t.slice(3).trim().split('').filter((x) => 'fshm'.includes(x))));
      } else if (t.startsWith('U:p')) {
        if (this.active) continue;
        this.active = true;
        const toks = t.slice(3).trim().split(' ').filter((x) => x !== '');
        this.items = toks.map((x, i) => decodeItem(x, i)).filter((x) => x !== null);
      } else if (t.startsWith('U:u ')) {
        const w = t.slice(4).trim();
        const it = /^\d+$/.test(w) ? this.items[Number(w)] : undefined;
        const k = it !== undefined ? it.kind : /** @type {KindCode} */ (w);
        if (it !== undefined) it.state = 'used';
        const hs = this.holds.get(c.from);
        if (hs !== undefined && hs.includes(k)) hs.splice(hs.indexOf(k), 1);
      } else if (t.startsWith('U:x ')) {
        const it = this.items[Number(t.slice(4).split(' ')[0])];
        if (it !== undefined && it.owner === c.from && it.state === 'plan') it.backup = true;
      } else if (t.startsWith('U:r ')) {
        const q = /^U:r (\d+) (\d|-)(?: ([AB])([0-9S-]))?$/.exec(t);
        const it = q === null ? undefined : this.items[Number(q[1])];
        if (q === null || it === undefined) continue;
        if (q[2] === '-') it.state = 'lost';
        else {
          it.owner = Number(q[2]);
          it.backup = false;
          if (it.state === 'free') it.state = 'plan';
        }
        if (q[3] !== undefined && q[4] === 'S' && (it.purpose === 'retakeSmoke' || it.purpose === 'retakeFlash')) this.retakeSite = /** @type {'A' | 'B'} */ (q[3]);
        if (q[3] !== undefined) it.target = { site: /** @type {'A' | 'B'} */ (q[3]), ent: q[4] === 'S' ? -1 : q[4] === '-' ? -2 : Number(q[4]) };
      }
    }
  }

  /** 這個人身上這種道具，還沒被別的有效計畫佔走的數量 @param {number} id @param {KindCode} k @param {UtilItem | null} [except] */
  spare(id, k, except = null) {
    const have = (this.holds.get(id) ?? []).filter((x) => x === k).length;
    const taken = this.items.filter((it) => it !== except && it.owner === id && it.kind === k && it.state === 'plan').length;
    return have - taken;
  }

  /**
   * 個人層：丟之前問。用途相符、擁有者是自己的計畫項目；purposes 含 'free' 時，計畫外（或已轉 free）的同種道具也給（回傳 idx −1 的虛項目）。
   * 沒收到計畫（active＝false）一律放行。
   * @param {number} id @param {import('./base.js').GrenadeId} kind @param {(Purpose | 'free')[]} purposes @returns {UtilItem | null}
   */
  claim(id, kind, purposes) {
    const k = codeOf(kind);
    const virt = /** @returns {UtilItem} */ () => ({ idx: -1, owner: id, kind: k, purpose: 'entryFlash', target: { site: null, ent: -2 }, state: 'free', backup: false });
    if (!this.active) return virt();
    for (const it of this.items) if (it.owner === id && it.kind === k && it.state === 'plan' && purposes.includes(it.purpose)) return it;
    if (!purposes.includes('free')) return null;
    // 轉成 free 的計畫項目、或計畫外的持有
    const fr = this.items.find((it) => it.owner === id && it.kind === k && it.state === 'free');
    if (fr !== undefined) return fr;
    return this.spare(id, k) > 0 ? virt() : null;
  }

  /** 讓某些用途到期轉 free（各副本在同樣的公開條件下呼叫） @param {Purpose[]} purposes */
  release(purposes) {
    for (const it of this.items) if (it.state === 'plan' && purposes.includes(it.purpose)) it.state = 'free';
  }

  /** 丟出時要喊的話 @param {UtilItem} it @returns {string} */
  usedText(it) {
    return it.idx >= 0 ? `U:u ${it.idx}` : `U:u ${it.kind}`;
  }

  /**
   * 指揮者：重分配（擁有者陣亡、放棄）；回防開始時把兩顆回防道具給離包點最近、有該道具的人並寫入目標包點。
   * 回傳要喊的 U:r（各副本等到聽到才改狀態，這裡不直接改）
   * @param {{ id: number, x: number, y: number, alive: boolean }[]} people
   * @param {(t: Target, it: UtilItem) => import('./base.js').Pt | null} pointOf 目標座標
   * @param {'A' | 'B' | null} planted 包下的點（CT 回防用）
   * @returns {string[]}
   */
  upkeep(people, pointOf, planted) {
    if (!this.active) return [];
    /** @type {string[]} */
    const say = [];
    const alive = new Map(people.filter((p) => p.alive).map((p) => [p.id, p]));
    const retake = planted !== null && this.retakeSite === null;
    for (const it of this.items) {
      const isRetake = it.purpose === 'retakeSmoke' || it.purpose === 'retakeFlash';
      const moveRetake = retake && isRetake && it.state === 'plan';
      if (it.state !== 'plan' || (!moveRetake && alive.has(it.owner) && !it.backup)) continue;
      const target = moveRetake ? { site: planted, ent: -1 } : it.target;
      const at = pointOf(target, it);
      let best = -1;
      let bd = Infinity;
      for (const p of [...alive.values()].sort((a, b) => a.id - b.id)) {
        if (it.backup && p.id === it.owner) continue;
        if (this.spare(p.id, it.kind, it) <= 0) continue;
        const d = at === null ? 0 : Math.round(dist(p.x, p.y, at.x, at.y) / UNIT);
        if (d < bd) {
          bd = d;
          best = p.id;
        }
      }
      const tgt = moveRetake ? ` ${planted}S` : '';
      if (best < 0) say.push(`U:r ${it.idx} -${tgt}`);
      else if (best !== it.owner || moveRetake) say.push(`U:r ${it.idx} ${best}${tgt}`);
    }
    return say;
  }
}
