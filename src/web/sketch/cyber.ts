// 設計稿 A：夜城天台。城市本體在 city.ts（正式版也用）；這裡只放設計稿頁面的標籤、倒數與連結。
import { mountCity } from './city.ts';
import { initStage, still } from './stage.ts';

initStage();
const city = mountCity(document.getElementById('city') as HTMLCanvasElement, document.getElementById('fx') as HTMLCanvasElement, document.getElementById('rain') as HTMLCanvasElement | null);

// ── AR 標籤與比賽卡：釘在地標頂上，近大遠小 ──
document.querySelectorAll<HTMLElement>('[data-at]').forEach((el) => {
  const a = city.anchor(el.dataset.at as string);
  el.style.left = `${a.x.toFixed(1)}px`;
  el.style.top = `${a.y.toFixed(1)}px`;
  if (el.classList.contains('tag')) el.style.setProperty('--k', a.k.toFixed(3));
});
document.querySelectorAll<HTMLElement>('.tag').forEach((el) => {
  el.addEventListener('mouseenter', () => city.setHot(el.dataset.at ?? ''));
  el.addEventListener('mouseleave', () => city.setHot(''));
});
// 基地是完整 UI 的首頁：點建築、名單、開戰、信件就進到對應畫面
const LINKS: [string, string][] = [
  ['[data-at="finance"]', 'finance'],
  ['[data-at="market"]', 'market'],
  ['[data-at="training"]', 'training'],
  ['[data-at="league"]', 'league'],
  ['[data-at="betting"]', 'betting'],
  ['[data-at="rival"]', 'squad'],
  ['.panel.squad', 'squad'],
  ['.panel.target', 'squad'],
  ['.go', 'match'],
  ['.top .icon-btn', 'inbox'],
  ['.top .team', 'title'],
];
for (const [sel, page] of LINKS) {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) continue;
  el.style.cursor = 'pointer';
  el.addEventListener('click', () => (location.href = `ui/${page}.html`));
}

// 倒數
const cd = document.getElementById('cd');
if (cd && !still) {
  let s = 2 * 3600 + 14 * 60 + 37;
  setInterval(() => {
    s = Math.max(0, s - 1);
    const p2 = (n: number): string => String(n).padStart(2, '0');
    cd.textContent = `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
  }, 1000);
}
