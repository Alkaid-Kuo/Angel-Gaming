// 頂部計分：兩隊頭像夾著時間與比分。隊別只看顏色，不寫字；陣亡變灰。
// 頭像是靜態 DOM，每幀只改 class 和血條寬度，SVG 不重建。敵人的血量觀察資料沒有，對局中只有一條隊色線；觀戰有全狀態，全員都有血條。
import type { ShooterObservation, WeaponId } from '../../shooter/api.ts';
import { avatarSvg } from '../club/art.ts';
import type { BoardRow, FullState, ShooterMeta } from './protocol.ts';
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

/** 選手頭像：先用經營層的生成頭像，種子是名字 */
export const avatarHtml = (name: string, jersey: string): string => avatarSvg(name, jersey, 96);

/** 這個人的血量：觀戰全員；對局只有自己與隊友，敵人 null */
export function visibleHp(view: ShooterObservation, full: FullState | null, id: number): number | null {
  if (full !== null) return full.players.find((p) => p.id === id)?.hp ?? null;
  if (view.me.id === id) return view.me.hp;
  return view.teammates.find((t) => t.id === id)?.hp ?? null;
}

/** 頂部的時間：凍結與回合中是階段倒數，下包後是炸彈倒數，回合結束不顯示 */
export function clockTicks(view: ShooterObservation): number | null {
  const r = view.round;
  if (r.phase === 'freeze' || r.phase === 'live') return r.phaseTicksLeft;
  if (r.phase === 'planted') return view.bomb.ticksLeft;
  return null;
}

export function clockText(ticks: number, tps: number): string {
  const s = Math.ceil(ticks / tps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface Cell {
  readonly id: number;
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

  constructor(root: HTMLElement, meta: ShooterMeta, leftGroup: 0 | 1, color: (g: 0 | 1) => string, jersey: (g: 0 | 1) => string) {
    const top = document.createElement('div');
    top.className = 'sg-top';
    root.appendChild(top);
    const side = (g: 0 | 1): void => {
      for (const id of meta.names.keys()) {
        if (meta.groups[id] !== g) continue;
        const el = document.createElement('div');
        el.className = 'av';
        el.style.setProperty('--c', color(g));
        el.innerHTML = `${avatarHtml(meta.names[id], jersey(g))}<u><i></i></u>`;
        top.appendChild(el);
        this.cells.push({ id, el, bar: el.querySelector('i') as HTMLElement, hp: -1 });
      }
    };
    const rightGroup: 0 | 1 = leftGroup === 0 ? 1 : 0;
    side(leftGroup);
    this.mid = document.createElement('div');
    this.mid.className = 'mid';
    this.mid.innerHTML = `<span class="clock"></span><b class="sc" style="color:${color(leftGroup)}"></b><b class="sc" style="color:${color(rightGroup)}"></b>`;
    top.appendChild(this.mid);
    side(rightGroup);
    [this.clock, this.left, this.right] = [...this.mid.children] as HTMLElement[];
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
