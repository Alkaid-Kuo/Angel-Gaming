// 頂部計分：兩隊頭像夾著時間與比分。隊別只看顏色，不寫字；陣亡變灰。
// 頭像是靜態 DOM，每幀只改 class 和血條寬度，SVG 不重建。敵人的血量觀察資料沒有，對局中只有一條隊色線；觀戰有全狀態，全員都有血條。
import type { WeaponId } from '../../shooter/api.ts';
import { portraitSvg } from '../portrait.ts';
import type { BoardRow, ShooterMeta } from './protocol.ts';
import { paintGunIcon } from './soldier.ts';

const ICON_W = 216;
const ICON_H = 72;
const guns = new Map<WeaponId, string>();

/** 武器剪影（快取成圖片網址，換內容時不用重畫） */
export function gunIconUrl(id: WeaponId): string {
  let url = guns.get(id);
  if (url === undefined) {
    const c = document.createElement('canvas');
    c.width = ICON_W;
    c.height = ICON_H;
    paintGunIcon(c.getContext('2d') as CanvasRenderingContext2D, id, ICON_W, ICON_H);
    url = c.toDataURL();
    guns.set(id, url);
  }
  return url;
}

/** 選手頭像：立繪裁圓（頂部計分板用方形），外框是隊色 */
export const avatarHtml = (portraitId: string, ring: string, square = false): string => portraitSvg(portraitId, 96, ring, square);

interface Cell {
  readonly id: number;
  readonly group: 0 | 1;
  readonly el: HTMLElement;
  readonly bar: HTMLElement;
  hp: number;
}

export class ScoreBar {
  private readonly cells: Cell[] = [];
  private readonly clock: HTMLElement;
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  private readonly mid: HTMLElement;
  private readonly groups: readonly [0 | 1, 0 | 1];

  constructor(root: HTMLElement, meta: ShooterMeta, leftGroup: 0 | 1) {
    const top = document.createElement('div');
    top.className = 'sg-top';
    root.appendChild(top);
    const rightGroup: 0 | 1 = leftGroup === 0 ? 1 : 0;
    const side = (g: 0 | 1): void => {
      for (const id of meta.names.keys()) {
        if (meta.groups[id] !== g) continue;
        const el = document.createElement('div');
        el.className = 'av';
        el.innerHTML = '<svg></svg><u><i></i></u>';
        top.appendChild(el);
        this.cells.push({ id, group: g, el, bar: el.querySelector('i') as HTMLElement, hp: -1 });
      }
    };
    side(leftGroup);
    this.mid = document.createElement('div');
    this.mid.className = 'mid';
    this.mid.innerHTML = '<span class="clock"></span><b class="sc"></b><b class="sc"></b>';
    top.appendChild(this.mid);
    side(rightGroup);
    [this.clock, this.left, this.right] = [...this.mid.children] as HTMLElement[];
    this.groups = [leftGroup, rightGroup];
  }

  /** 開局與換邊：隊色與球衣跟著這組現在打的那一邊 */
  paint(color: (g: 0 | 1) => string, face: (id: number) => string): void {
    for (const c of this.cells) {
      c.el.style.setProperty('--c', color(c.group));
      (c.el.firstElementChild as Element).outerHTML = face(c.id);
    }
    this.left.style.color = color(this.groups[0]);
    this.right.style.color = color(this.groups[1]);
  }

  update(board: readonly BoardRow[], hpOf: (id: number) => number | null, clock: string, phase: string, scoreLeft: number, scoreRight: number): void {
    for (const c of this.cells) {
      const alive = board[c.id]?.alive === true;
      c.el.classList.toggle('dead', !alive);
      // 看不到血量的畫滿，只當隊色線
      const hp = alive ? (hpOf(c.id) ?? 100) : 0;
      if (hp !== c.hp) {
        c.hp = hp;
        c.bar.style.width = `${Math.max(0, hp)}%`;
        c.bar.classList.toggle('low', hp <= 30);
      }
    }
    if (this.clock.textContent !== clock) this.clock.textContent = clock;
    if (this.left.textContent !== String(scoreLeft)) this.left.textContent = String(scoreLeft);
    if (this.right.textContent !== String(scoreRight)) this.right.textContent = String(scoreRight);
    if (this.mid.dataset.phase !== phase) this.mid.dataset.phase = phase;
  }
}
