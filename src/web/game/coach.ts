// 帶路層：把畫面其他地方蓋暗、亮出目標元素，旁邊放說明卡。
// 舞台是 1920×1080 再整個縮放，位置都換算回舞台座標。
import { esc } from '../manage/format.ts';

export interface CoachView {
  target?: string;
  /** 要玩家自己點亮處：亮處不擋點擊 */
  clickThrough: boolean;
  tag: string;
  title: string;
  html: string;
  /** 說明卡的按鈕 */
  buttons: { label: string; act: string; ghost?: boolean }[];
  /** 小連結「跳過教學」 */
  skip: boolean;
}

const CARD_W = 500;
const GAP = 26;

function stageRect(root: HTMLElement, el: Element): { x: number; y: number; w: number; h: number } {
  const stage = root.parentElement as HTMLElement;
  const s = stage.getBoundingClientRect();
  const k = s.width / 1920;
  const r = el.getBoundingClientRect();
  return { x: (r.left - s.left) / k, y: (r.top - s.top) / k, w: r.width / k, h: r.height / k };
}

/** 說明卡放在目標旁邊：右、左、下、上，放得下的第一個；都放不下就置中 */
function place(card: HTMLElement, t: { x: number; y: number; w: number; h: number }): void {
  const h = card.offsetHeight;
  const clampY = (y: number): number => Math.max(20, Math.min(1060 - h, y));
  const clampX = (x: number): number => Math.max(20, Math.min(1900 - CARD_W, x));
  let x: number;
  let y: number;
  if (t.x + t.w + GAP + CARD_W <= 1900) [x, y] = [t.x + t.w + GAP, clampY(t.y)];
  else if (t.x - GAP - CARD_W >= 20) [x, y] = [t.x - GAP - CARD_W, clampY(t.y)];
  else if (t.y + t.h + GAP + h <= 1060) [x, y] = [clampX(t.x), t.y + t.h + GAP];
  else if (t.y - GAP - h >= 20) [x, y] = [clampX(t.x), t.y - GAP - h];
  else [x, y] = [(1920 - CARD_W) / 2, (1080 - h) / 2];
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
}

function position(root: HTMLElement, view: CoachView): void {
  const card = root.querySelector<HTMLElement>('.co-card');
  if (!card) return;
  const el = view.target ? document.querySelector(view.target) : null;
  const ring = root.querySelector<HTMLElement>('.co-ring');
  const blocks = root.querySelectorAll<HTMLElement>('.co-block');
  if (!el || !ring) {
    root.classList.add('center');
    blocks[0].style.cssText = 'left:0;top:0;width:1920px;height:1080px';
    card.style.left = `${(1920 - CARD_W) / 2}px`;
    card.style.top = `${Math.max(20, (1080 - card.offsetHeight) / 2)}px`;
    return;
  }
  root.classList.remove('center');
  const r = stageRect(root, el);
  const pad = 10;
  const t = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  ring.style.cssText = `left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px`;
  if (view.clickThrough) {
    // 亮處留空，其他四塊擋住
    blocks[0].style.cssText = `left:0;top:0;width:1920px;height:${t.y}px`;
    blocks[1].style.cssText = `left:0;top:${t.y + t.h}px;width:1920px;height:${1080 - t.y - t.h}px`;
    blocks[2].style.cssText = `left:0;top:${t.y}px;width:${t.x}px;height:${t.h}px`;
    blocks[3].style.cssText = `left:${t.x + t.w}px;top:${t.y}px;width:${1920 - t.x - t.w}px;height:${t.h}px`;
  } else {
    blocks[0].style.cssText = 'left:0;top:0;width:1920px;height:1080px';
  }
  place(card, t);
}

let settle = 0;

export function showCoach(root: HTMLElement, view: CoachView | null): void {
  clearTimeout(settle);
  if (!view) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;
  root.classList.toggle('center', !view.target);
  root.innerHTML = `<i class="co-block"></i><i class="co-block"></i><i class="co-block"></i><i class="co-block"></i>${view.target ? '<i class="co-ring"></i>' : ''}
    <div class="co-card"><span class="tag">${esc(view.tag)}</span><h3>${esc(view.title)}</h3><p>${view.html}</p>
      <div class="acts">${view.skip ? '<button class="lnk" data-act="guide-skip">跳過教學，全部功能直接開放</button>' : ''}${view.buttons.map((b) => `<button class="btn sm ${b.ghost ? 'ghost' : ''}" data-act="${b.act}"><b>${esc(b.label)}</b></button>`).join('')}</div></div>`;
  position(root, view);
  // 畫面的進場動畫會移動目標，等動畫結束再對一次
  settle = window.setTimeout(() => position(root, view), 1300);
}
