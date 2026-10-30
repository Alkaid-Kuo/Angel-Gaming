// @ts-check
// 角色（2.1）：旋鈕 role 1 突破手、2 支援、3 錨點、4 狙擊手、5 游擊；0 自動（隊內序號 0 突破、1 支援、2 錨點、3 游擊、4 狙擊；旋鈕 awpSlot 指定的序號當狙擊）。
// 每個人每回合第一次決策喊「R:<代碼>」；隊友沒喊過的照他隊內序號的自動角色（大家用同一條規則，結果一致）。
// 分工：每個角色由喊這個角色、序號最小的人擔任；喊重複的人依序號補缺的角色（突破、支援、錨點、游擊；狙擊不補）；
// 都補滿了還多出來的人沒有角色（0）。五個人都喊狙擊時：序號最小的是狙擊手（只有他買狙擊槍），其他人依序補成突破、支援、錨點、游擊。

export const ENTRY = 1;
export const SUPPORT = 2;
export const ANCHOR = 3;
export const AWP = 4;
export const LURK = 5;
export const ROLE_NAME = ['無', '突破', '支援', '錨點', '狙擊', '游擊'];
const AUTO = [ENTRY, SUPPORT, ANCHOR, LURK, AWP];
const FILL = [ENTRY, SUPPORT, ANCHOR, LURK];

/** 自動角色 @param {number} slot @param {number} awpSlot */
export function autoRole(slot, awpSlot) {
  if (slot === awpSlot) return AWP;
  const r = AUTO[slot] ?? ENTRY;
  return r === AWP ? LURK : r;
}

/** 解析「R:<代碼>」 @param {string} text */
export function parseRole(text) {
  const m = /^R:([1-5])$/.exec(text);
  return m === null ? 0 : Number(m[1]);
}

export class Roles {
  /** @param {number[]} ids 全隊 id（排序＝隊內序號） @param {number} me @param {number} mine 自己喊的角色 @param {number} awpSlot */
  constructor(ids, me, mine, awpSlot) {
    this.ids = ids;
    /** 喊過的角色（自己的直接知道） @type {Map<number, number>} */
    this.said = new Map([[me, mine]]);
    this.awpSlot = awpSlot;
    /** id → 實際分工；角色 → 擔任的人 @type {Map<number, number>} */
    this.eff = new Map();
    /** @type {Map<number, number>} */
    this.holder = new Map();
    /** 分工變了就換（分組、守位快取的鍵） */
    this.key = '';
    this.solve();
  }

  /** 收到隊友喊的角色 @param {number} id @param {number} r */
  hear(id, r) {
    if (r === 0 || this.said.get(id) === r || !this.ids.includes(id)) return;
    this.said.set(id, r);
    this.solve();
  }

  /** @param {number} id */
  announced(id) {
    return this.said.get(id) ?? autoRole(this.ids.indexOf(id), 4);
  }

  solve() {
    this.eff = new Map();
    this.holder = new Map();
    /** @type {number[]} */
    const extra = [];
    for (const id of this.ids) {
      const r = this.announced(id);
      if (this.holder.has(r)) extra.push(id);
      else {
        this.holder.set(r, id);
        this.eff.set(id, r);
      }
    }
    for (const id of extra) {
      const r = FILL.find((x) => !this.holder.has(x)) ?? 0;
      this.eff.set(id, r);
      if (r !== 0) this.holder.set(r, id);
    }
    this.key = this.ids.map((id) => this.eff.get(id) ?? 0).join('');
  }

  /** 實際分工 @param {number} id */
  of(id) {
    return this.eff.get(id) ?? 0;
  }

  /** 擔任某角色的人（−1 = 沒有） @param {number} r */
  who(r) {
    return this.holder.get(r) ?? -1;
  }

  /** 買狙擊槍的人：喊狙擊的人中序號最小的（不是補位來的） */
  awper() {
    for (const id of this.ids) if (this.announced(id) === AWP) return id;
    return -1;
  }
}
