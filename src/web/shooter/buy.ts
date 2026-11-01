// CS 射擊可玩版的商店：左分類、中商品卡、右選中商品的數值、底部金錢與購買倒數。
// 商品與數值全部來自開局規則（shop.ts 換算），狀態只看自己的觀察資料；點卡片或按熱鍵送 buy 指令，合不合法由引擎判定，這裡只是提示。
// 卡片四種狀態：買得起、買不起、已持有、陣營限定。買不了的卡片不是 disabled：點了要在底部說明為什麼。
import type { BuyItem, GrenadeId, ShooterObservation, Team, WeaponInfo } from '../../shooter/api.ts';
import type { ShooterMeta } from './protocol.ts';
import { BUY_CLOSED_NOTE, SHOP_CATS, compareRow, compareTarget, buyTicksLeft, gearNote, grenadeNote, grenadeRows, isIssued, shopEntries, shopState, stateNote, weaponRows, type ShopCat, type ShopEntry, type ShopState, type StatRow } from './shop.ts';
import { paintGunIcon } from './soldier.ts';

const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];
const KEY_LABEL = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
/** 卡片上的三條摘要（數值列的 key → 卡片上的短標籤） */
const CARD_ROWS: readonly (readonly [string, string])[] = [
  ['damage', '傷害'],
  ['rpm', '射速'],
  ['stand', '精度'],
];
/** 圖示畫布的內部尺寸（CSS 再縮放，所以大一點） */
const ICON_W = 360;
const ICON_H = 120;
const SIGN = { 1: '▲', [-1]: '▼', 0: '' } as const;

function grenadeIcon(g: CanvasRenderingContext2D, id: GrenadeId, cx: number, cy: number): void {
  const body = (x: number, y: number, r: number, fill: string): void => {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  g.strokeStyle = '#c3cad4';
  g.lineWidth = 5;
  g.lineCap = 'round';
  if (id === 'flash') {
    body(cx, cy, 20, '#eef2f6');
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30);
      g.lineTo(cx + Math.cos(a) * 44, cy + Math.sin(a) * 44);
      g.stroke();
    }
  } else if (id === 'smoke') {
    body(cx - 26, cy + 8, 24, '#5b6574');
    body(cx + 26, cy + 8, 24, '#5b6574');
    body(cx, cy - 8, 30, '#8b95a4');
  } else if (id === 'he') {
    body(cx, cy + 6, 32, '#c3cad4');
    g.fillStyle = '#5b6574';
    g.fillRect(cx - 10, cy - 38, 20, 16);
    g.beginPath();
    g.arc(cx + 22, cy - 34, 10, 0, Math.PI * 2);
    g.stroke();
  } else {
    // 燃燒：瓶身加火舌
    g.fillStyle = '#8b95a4';
    g.fillRect(cx - 14, cy - 8, 28, 46);
    g.fillRect(cx - 6, cy - 26, 12, 20);
    g.fillStyle = '#eef2f6';
    g.beginPath();
    g.moveTo(cx, cy - 56);
    g.quadraticCurveTo(cx + 18, cy - 38, cx, cy - 26);
    g.quadraticCurveTo(cx - 18, cy - 38, cx, cy - 56);
    g.fill();
  }
}

function gearIcon(g: CanvasRenderingContext2D, id: BuyItem, cx: number, cy: number): void {
  g.fillStyle = '#c3cad4';
  if (id === 'armor') {
    g.beginPath();
    g.moveTo(cx - 40, cy - 40);
    g.lineTo(cx - 14, cy - 44);
    g.lineTo(cx, cy - 28);
    g.lineTo(cx + 14, cy - 44);
    g.lineTo(cx + 40, cy - 40);
    g.lineTo(cx + 44, cy + 44);
    g.lineTo(cx - 44, cy + 44);
    g.closePath();
    g.fill();
    g.fillStyle = '#5b6574';
    g.fillRect(cx - 28, cy - 6, 24, 14);
    g.fillRect(cx + 4, cy - 6, 24, 14);
  } else if (id === 'kit') {
    g.fillRect(cx - 54, cy - 30, 108, 66);
    g.fillRect(cx - 18, cy - 44, 36, 14);
    g.fillStyle = '#0b0e14';
    g.fillRect(cx - 20, cy - 6, 40, 12);
    g.fillRect(cx - 6, cy - 20, 12, 40);
  } else {
    for (const dx of [-36, 0, 36]) {
      g.fillStyle = '#c3cad4';
      g.fillRect(cx + dx - 11, cy - 16, 22, 56);
      g.fillStyle = '#eef2f6';
      g.beginPath();
      g.moveTo(cx + dx - 11, cy - 18);
      g.quadraticCurveTo(cx + dx, cy - 52, cx + dx + 11, cy - 18);
      g.fill();
    }
  }
}

function paintIcon(c: HTMLCanvasElement, e: ShopEntry): void {
  c.width = ICON_W;
  c.height = ICON_H;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  if (e.weapon !== null) paintGunIcon(g, e.weapon.id, ICON_W, ICON_H);
  else if (e.grenade !== null) grenadeIcon(g, e.grenade.id, ICON_W / 2, ICON_H / 2);
  else gearIcon(g, e.id, ICON_W / 2, ICON_H / 2);
}

function barHtml(frac: number | null): string {
  return frac === null ? '<span class="br none"></span>' : `<span class="br"><i style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%"></i></span>`;
}

export class BuyMenu {
  readonly el: HTMLElement;
  private readonly meta: ShooterMeta;
  private readonly entries: readonly ShopEntry[];
  private readonly send: (items: BuyItem[]) => void;
  private open = false;
  private team: Team | null = null;
  private cards = new Map<BuyItem, HTMLButtonElement>();
  /** 快捷鍵 → 品項（只給本隊能買的） */
  private hotkeys = new Map<string, BuyItem>();
  private states = new Map<BuyItem, ShopState>();
  private last: ShooterObservation | null = null;
  private cat: ShopCat = 'primary';
  private sel: ShopEntry;
  /** 比較對象變了才重畫數值 */
  private cmpKey = '';
  private note = '';
  private money!: HTMLElement;
  private after!: HTMLElement;
  private noteEl!: HTMLElement;
  private timer!: HTMLElement;
  private timerBar!: HTMLElement;
  private info!: HTMLElement;

  constructor(el: HTMLElement, meta: ShooterMeta, send: (items: BuyItem[]) => void) {
    this.el = el;
    this.meta = meta;
    this.send = send;
    this.entries = shopEntries(meta);
    this.sel = this.entries.find((e) => e.cat === this.cat) as ShopEntry;
    el.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('hidden', !open);
    if (open) this.setNote('');
    if (open && this.last !== null) this.update(this.last);
  }

  private setNote(text: string): void {
    this.note = text;
    if (this.noteEl !== undefined && this.noteEl.textContent !== text) this.noteEl.textContent = text;
  }

  /** 依目前陣營重建（換邊時） */
  private build(team: Team): void {
    this.team = team;
    this.cards.clear();
    this.hotkeys.clear();
    this.states.clear();
    this.cmpKey = '';
    this.el.innerHTML =
      `<div class="sb-head"><b>購買</b><span class="sd">${team}</span><span class="tm"><i class="tb"><u></u></i><span class="tt"></span></span><span class="cl"><kbd>B</kbd> 關閉・<kbd>1</kbd>～<kbd>=</kbd> 快速購買</span></div>` +
      `<div class="sb-body"><nav class="sb-cats"></nav><div class="sb-grid"></div><aside class="sb-info"></aside></div>` +
      `<div class="sb-foot"><span class="fm"><small>目前金錢</small><b class="now"></b></span><span class="ar">→</span><span class="fm"><small>購買後</small><b class="af"></b></span><span class="nt"></span></div>`;
    const q = <T extends HTMLElement>(s: string): T => this.el.querySelector(s) as T;
    this.money = q('.now');
    this.after = q('.af');
    this.noteEl = q('.nt');
    this.timer = q('.tt');
    this.timerBar = q('.tb u');
    this.info = q('.sb-info');
    const nav = q('.sb-cats');
    for (const c of SHOP_CATS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.cat = c.id;
      b.innerHTML = `<small>${c.en}</small><b>${c.name}</b>`;
      b.addEventListener('click', () => this.pickCat(c.id));
      nav.appendChild(b);
    }
    const grid = q('.sb-grid');
    let k = 0;
    // 自己能買的排前面，熱鍵順序與排列順序一致
    const order = [...this.entries].sort((a, b) => Number(!a.teams.includes(team)) - Number(!b.teams.includes(team)));
    for (const e of order) {
      const mine = e.teams.includes(team);
      const key = mine && k < KEYS.length ? KEY_LABEL[k] : '';
      if (mine && k < KEYS.length) this.hotkeys.set(KEYS[k++], e.id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sb-card';
      b.dataset.cat = e.cat;
      b.innerHTML = `<canvas></canvas>${key !== '' ? `<kbd>${key}</kbd>` : ''}<span class="nm">${e.name}</span><span class="pr">${isIssued(e) ? '配發' : `$${e.price}`}</span><span class="tg"></span><span class="mb"></span>`;
      paintIcon(b.querySelector('canvas') as HTMLCanvasElement, e);
      b.addEventListener('pointerenter', () => this.select(e));
      b.addEventListener('click', () => this.buy(e));
      grid.appendChild(b);
      this.cards.set(e.id, b);
    }
    this.pickCat(this.cat);
  }

  private pickCat(cat: ShopCat): void {
    this.cat = cat;
    for (const b of this.el.querySelectorAll<HTMLElement>('.sb-cats button')) b.classList.toggle('on', b.dataset.cat === cat);
    for (const b of this.cards.values()) b.classList.toggle('hidden', b.dataset.cat !== cat);
    if (this.sel.cat !== cat) this.select(this.entries.find((e) => e.cat === cat && e.teams.includes(this.team ?? 'T')) ?? this.sel);
  }

  private select(e: ShopEntry): void {
    if (this.sel !== e) this.setNote('');
    this.sel = e;
    for (const [id, b] of this.cards) b.classList.toggle('sel', id === e.id);
    this.renderInfo();
    if (this.last !== null) this.updateFoot(this.last);
  }

  private buy(e: ShopEntry): void {
    const s = this.last;
    if (s === null) return;
    const st = shopState(this.meta, e, s);
    this.select(e);
    if (st === 'ok') {
      this.setNote('');
      this.send([e.id]);
    } else this.setNote(stateNote(e, st, s.me.money));
  }

  /** 快捷鍵；回傳 true 表示是購買鍵 */
  key(code: string): boolean {
    const id = this.hotkeys.get(code);
    if (id === undefined) return false;
    const e = this.entries.find((x) => x.id === id) as ShopEntry;
    if (e.cat !== this.cat) this.pickCat(e.cat);
    this.buy(e);
    return true;
  }

  private rowsOf(w: WeaponInfo): StatRow[] {
    return weaponRows(this.meta, w, this.meta.weapons.filter((x) => x.slot === w.slot));
  }

  /** 卡片上的三條摘要：長條與對照手上的槍的箭頭 */
  private renderCard(e: ShopEntry, ref: WeaponInfo | null): void {
    const box = this.cards.get(e.id)?.querySelector('.mb') as HTMLElement;
    if (e.weapon === null) {
      if (e.grenade !== null) box.innerHTML = grenadeRows(this.meta, e.grenade).slice(1, 3).map((r) => `<span class="ln"><small>${r.label}</small><b>${r.text}</b></span>`).join('');
      else box.textContent = gearNote(this.meta, e.id);
      return;
    }
    const rows = this.rowsOf(e.weapon);
    const refRows = ref !== null ? this.rowsOf(ref) : [];
    box.innerHTML = CARD_ROWS.map(([k, label]) => {
      const r = rows.find((x) => x.key === k) as StatRow;
      const c = compareRow(r, refRows);
      return `<span class="ln"><small>${label}</small>${barHtml(r.frac)}<b class="c${c.sign}">${r.text.replace(' 發／分', '')}<em>${SIGN[c.sign]}</em></b></span>`;
    }).join('');
  }

  private renderInfo(): void {
    const box = this.info;
    if (box === undefined) return;
    const e = this.sel;
    const s = this.last;
    const ref = e.weapon !== null && s !== null ? compareTarget(this.meta, e.weapon, s) : null;
    let body: string;
    if (e.weapon !== null) {
      const refRows = ref !== null ? this.rowsOf(ref) : [];
      body = this.rowsOf(e.weapon)
        .map((r) => {
          const c = compareRow(r, refRows);
          return `<div class="rw"><span class="lb">${r.label}</span>${barHtml(r.frac)}<b>${r.text}</b><em class="c${c.sign}">${c.sign !== 0 ? `${SIGN[c.sign]} ${c.delta}` : ''}</em></div>`;
        })
        .join('');
    } else if (e.grenade !== null) {
      body = `${grenadeRows(this.meta, e.grenade).map((r) => `<div class="rw gr"><span class="lb">${r.label}</span><b>${r.text}</b></div>`).join('')}<p>${grenadeNote(this.meta, e.grenade.id)}</p>`;
    } else body = `<p>${gearNote(this.meta, e.id)}</p>`;
    const cmp = e.weapon === null ? '' : ref !== null ? `和身上的 <b>${ref.name}</b> 比` : '';
    box.innerHTML = `<div class="ih"><canvas></canvas><div><b class="nm">${e.name}</b><span class="pr">${isIssued(e) ? '開局配發' : `$${e.price}`}</span><small>${cmp}</small></div></div><div class="rows">${body}</div>`;
    paintIcon(box.querySelector('canvas') as HTMLCanvasElement, e);
  }

  private updateFoot(s: ShooterObservation): void {
    const st = shopState(this.meta, this.sel, s);
    const money = `$${s.me.money}`;
    if (this.money.textContent !== money) this.money.textContent = money;
    const after = st === 'ok' ? `$${s.me.money - this.sel.price}` : st === 'poor' ? `差 $${this.sel.price - s.me.money}` : '—';
    if (this.after.textContent !== after) this.after.textContent = after;
    this.after.classList.toggle('poor', st === 'poor');
  }

  update(s: ShooterObservation): void {
    this.last = s;
    if (this.team !== s.me.team) this.build(s.me.team);
    if (!this.open) return;
    const me = s.me;
    // 比較對象：身上的主武器、手槍、手上那把
    const key = `${me.loadout.primary}|${me.loadout.secondary}|${me.weapon}`;
    if (key !== this.cmpKey) {
      this.cmpKey = key;
      for (const e of this.entries) this.renderCard(e, e.weapon !== null ? compareTarget(this.meta, e.weapon, s) : null);
      this.renderInfo();
    }
    for (const e of this.entries) {
      const st = shopState(this.meta, e, s);
      const b = this.cards.get(e.id) as HTMLButtonElement;
      const tag = st === 'poor' ? `差 $${e.price - me.money}` : st === 'owned' ? (e.id === 'armor' || e.id === 'ammo' ? '已滿' : e.grenade !== null ? '已達上限' : '已持有') : st === 'locked' ? (isIssued(e) ? '不能購買' : `限 ${e.teams.join('／')}`) : '';
      const old = this.states.get(e.id);
      if (old !== st) {
        if (old !== undefined) b.classList.remove(`st-${old}`);
        b.classList.add(`st-${st}`);
        this.states.set(e.id, st);
      }
      const tagEl = b.querySelector('.tg') as HTMLElement;
      if (tagEl.textContent !== tag) tagEl.textContent = tag;
    }
    this.updateFoot(s);
    const rules = this.meta.rules;
    const left = s.round.canBuy ? buyTicksLeft(s.round, rules) : 0;
    const text = s.round.canBuy ? `剩 ${Math.ceil(left / rules.ticksPerSecond)} 秒可購買` : BUY_CLOSED_NOTE;
    if (this.timer.textContent !== text) this.timer.textContent = text;
    this.timerBar.style.width = `${Math.round((left / rules.buyTicks) * 100)}%`;
    this.timerBar.parentElement?.classList.toggle('low', left < 5 * rules.ticksPerSecond);
  }
}
