// CS 射擊可玩版的購買選單：列出武器、護甲、拆彈器、道具與價格；買不起、陣營不符、已有、超過攜帶上限就灰掉。
// 點擊或按快捷鍵送 buy 指令（合不合法由引擎判定，這裡只是提示）。
import type { BuyItem, ShooterObservation, Team } from '../../shooter/api.ts';
import type { ShooterMeta } from './protocol.ts';

interface Entry {
  readonly id: BuyItem;
  readonly name: string;
  readonly group: string;
  readonly price: number;
  readonly teams: readonly Team[];
}

const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];
const KEY_LABEL = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

export class BuyMenu {
  readonly el: HTMLElement;
  private readonly meta: ShooterMeta;
  private readonly entries: Entry[];
  private readonly send: (items: BuyItem[]) => void;
  private open = false;
  private team: Team | null = null;
  private buttons = new Map<BuyItem, HTMLButtonElement>();
  /** 快捷鍵 → 品項（只給本隊能買的） */
  private hotkeys = new Map<string, BuyItem>();
  private last: ShooterObservation | null = null;

  constructor(el: HTMLElement, meta: ShooterMeta, send: (items: BuyItem[]) => void) {
    this.el = el;
    this.meta = meta;
    this.send = send;
    const rules = meta.rules;
    const gName: Record<string, string> = { secondary: '手槍', primary: '主武器' };
    this.entries = [
      ...meta.weapons.filter((w) => w.teams.length > 0 && w.slot === 'secondary').map((w) => ({ id: w.id, name: w.name, group: gName.secondary, price: w.price, teams: w.teams })),
      ...meta.weapons.filter((w) => w.teams.length > 0 && w.slot === 'primary').map((w) => ({ id: w.id, name: w.name, group: gName.primary, price: w.price, teams: w.teams })),
      { id: 'armor', name: '護甲', group: '裝備', price: rules.armorPrice, teams: ['T', 'CT'] },
      // 彈藥不會在回合間自動補；買一次補滿主武器與手槍的備彈（都滿就不扣錢）
      { id: 'ammo', name: '彈藥（補滿備彈）', group: '裝備', price: rules.ammoPrice, teams: ['T', 'CT'] },
      { id: 'kit', name: '拆彈器', group: '裝備', price: rules.kitPrice, teams: ['CT'] },
      ...meta.grenades.map((g) => ({ id: g.id, name: g.name, group: '道具', price: g.price, teams: g.teams })),
    ];
    el.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('hidden', !open);
    if (open && this.last !== null) this.update(this.last);
  }

  /** 依目前陣營重建按鈕（換邊時） */
  private build(team: Team): void {
    this.team = team;
    this.buttons.clear();
    this.hotkeys.clear();
    this.el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'sg-buy-head';
    head.innerHTML = `<b>購買</b><span class="money"></span><span class="muted small">B 關閉　數字鍵快速購買</span>`;
    this.el.appendChild(head);
    let k = 0;
    const groups = new Map<string, HTMLElement>();
    for (const e of this.entries) {
      let box = groups.get(e.group);
      if (box === undefined) {
        const sec = document.createElement('section');
        sec.innerHTML = `<h4>${e.group}</h4>`;
        box = document.createElement('div');
        box.className = 'items';
        sec.appendChild(box);
        this.el.appendChild(sec);
        groups.set(e.group, box);
      }
      const b = document.createElement('button');
      b.type = 'button';
      const mine = e.teams.includes(team);
      const key = mine && k < KEYS.length ? KEY_LABEL[k] : '';
      if (mine && k < KEYS.length) this.hotkeys.set(KEYS[k++], e.id);
      b.innerHTML = `<kbd>${key || '·'}</kbd><span class="nm">${e.name}</span><span class="pr">$${e.price}</span>${mine ? '' : `<span class="tm">限 ${e.teams.join('／')}</span>`}`;
      b.addEventListener('click', () => this.send([e.id]));
      box.appendChild(b);
      this.buttons.set(e.id, b);
    }
  }

  /** 快捷鍵；回傳 true 表示是購買鍵 */
  key(code: string): boolean {
    const id = this.hotkeys.get(code);
    if (id === undefined) return false;
    const b = this.buttons.get(id);
    if (b !== undefined && !b.disabled) this.send([id]);
    return true;
  }

  update(s: ShooterObservation): void {
    this.last = s;
    if (this.team !== s.me.team) this.build(s.me.team);
    if (!this.open) return;
    const me = s.me;
    const lo = me.loadout;
    const money = this.el.querySelector('.money');
    if (money !== null) money.textContent = `$${me.money}${s.round.canBuy ? '' : '（不在購買時間或出生區）'}`;
    for (const e of this.entries) {
      const b = this.buttons.get(e.id)!;
      const g = this.meta.grenades.find((x) => x.id === e.id);
      // 彈藥：看得到的只有手上那把的備彈，手上那把滿了而且沒有別的槍才算「已滿」
      const activeW = this.meta.weapons.find((w) => w.id === me.weapon);
      const ammoFull = activeW !== undefined && me.ammoReserve >= activeW.reserve && (lo.primary === null || lo.secondary === null);
      const owned =
        e.id === 'ammo'
          ? ammoFull
          : e.id === 'armor'
          ? lo.armor >= this.meta.rules.maxArmor
          : e.id === 'kit'
            ? lo.kit
            : g !== undefined
              ? lo.grenades.filter((x) => x === e.id).length >= g.maxCarry || lo.grenades.length >= this.meta.rules.grenadeSlots
              : lo.primary === e.id || lo.secondary === e.id;
      const ok = s.round.canBuy && e.teams.includes(me.team) && me.money >= e.price && !owned;
      if (b.disabled === ok) b.disabled = !ok;
      b.classList.toggle('owned', owned);
    }
  }
}
