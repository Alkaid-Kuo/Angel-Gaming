// 指令格：固定 15 個按鈕（5 × 3），只更新內容、不重建元素。
// 每秒會收到約 10 個畫面更新；若每次都重建按鈕，按下與放開之間元素被換掉，瀏覽器就不會觸發點擊。
import { iconSvg, type IconName } from './icons.ts';

export interface CardItem {
  /** 識別碼（教學提示用），例如 'train:worker'、'build:supply' */
  readonly id: string;
  /** 快捷鍵（顯示用；比對時不分大小寫） */
  readonly hotkey: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly cost?: number;
  readonly enabled: boolean;
  /** 不可用的原因 */
  readonly reason?: string;
  readonly tip: string;
  /** 目前生效中（例如目前的姿態） */
  readonly active?: boolean;
  readonly run: () => void;
}

export const CARD_COLS = 5;
export const CARD_SLOTS = 15;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class CommandCard {
  readonly root: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly signatures: string[] = [];
  private readonly tooltip: HTMLElement;
  private items: (CardItem | null)[] = [];
  private hover = -1;
  private highlightId: string | null = null;
  private readonly onBlocked: (reason: string) => void;

  constructor(onBlocked: (reason: string) => void) {
    this.onBlocked = onBlocked;
    this.root = el('div', 'card-grid');
    this.tooltip = el('div', 'card-tip hidden');
    for (let i = 0; i < CARD_SLOTS; i++) {
      const b = el('button', 'slot empty');
      b.type = 'button';
      b.append(el('span', 'hk'), el('span', 'ic'), el('span', 'name'), el('span', 'cost'));
      b.addEventListener('click', () => this.press(i));
      b.addEventListener('mouseenter', () => {
        this.hover = i;
        this.renderTip();
      });
      b.addEventListener('mouseleave', () => {
        if (this.hover === i) this.hover = -1;
        this.renderTip();
      });
      this.buttons.push(b);
      this.signatures.push('');
      this.root.append(b);
    }
    this.root.append(this.tooltip);
  }

  /** 依目前的項目更新按鈕；項目依序放進格子，null 為空格 */
  update(items: readonly (CardItem | null)[]): void {
    this.items = Array.from({ length: CARD_SLOTS }, (_, i) => items[i] ?? null);
    for (let i = 0; i < CARD_SLOTS; i++) {
      const it = this.items[i];
      const sig = it === null ? '' : `${it.id}|${it.hotkey}|${it.label}|${it.icon ?? ''}|${it.cost ?? ''}|${it.enabled ? 1 : 0}|${it.active === true ? 1 : 0}|${it.id === this.highlightId ? 1 : 0}`;
      if (sig === this.signatures[i]) continue;
      this.signatures[i] = sig;
      const b = this.buttons[i];
      const [hk, ic, name, cost] = b.children as unknown as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
      hk.textContent = it?.hotkey ?? '';
      ic.innerHTML = it?.icon !== undefined ? iconSvg(it.icon, 22) : '';
      name.textContent = it?.label ?? '';
      cost.textContent = it?.cost !== undefined ? `◆${it.cost}` : '';
      b.className = `slot${it === null ? ' empty' : ''}${it !== null && !it.enabled ? ' off' : ''}${it?.active === true ? ' on' : ''}${it !== null && it.id === this.highlightId ? ' tut' : ''}`;
    }
    this.renderTip();
  }

  /** 教學：以閃爍外框提示要按的按鈕 */
  setHighlight(id: string | null): void {
    if (id === this.highlightId) return;
    this.highlightId = id;
    for (let i = 0; i < CARD_SLOTS; i++) this.signatures[i] = '';
    this.update(this.items);
  }

  /** 依快捷鍵找出目前的項目 */
  find(key: string): CardItem | null {
    const k = key.toLowerCase();
    return this.items.find((it) => it !== null && it.hotkey.toLowerCase() === k) ?? null;
  }

  /** 執行項目；不可用時回報原因 */
  trigger(it: CardItem): void {
    if (it.enabled) it.run();
    else this.onBlocked(it.reason ?? '目前不能使用');
  }

  private press(i: number): void {
    const it = this.items[i];
    if (it !== null) this.trigger(it);
  }

  private renderTip(): void {
    const it = this.hover >= 0 ? this.items[this.hover] : null;
    if (it === null || it === undefined) {
      this.tooltip.classList.add('hidden');
      return;
    }
    const lines = [`<b>${it.label}</b>${it.hotkey !== '' ? `<span class="k">${it.hotkey}</span>` : ''}`];
    if (it.cost !== undefined) lines.push(`<span class="c">◆ ${it.cost} 礦</span>`);
    lines.push(it.tip);
    if (!it.enabled && it.reason !== undefined) lines.push(`<span class="r">${it.reason}</span>`);
    const html = lines.map((l) => `<div>${l}</div>`).join('');
    if (this.tooltip.innerHTML !== html) this.tooltip.innerHTML = html;
    this.tooltip.classList.remove('hidden');
  }
}
