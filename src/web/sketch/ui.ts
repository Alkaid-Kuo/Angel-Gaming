// 完整 UI 設計稿共用：舞台、背景、外框（頂列＋左側導覽）、隊徽預設色、單色流派徽記。
// 各頁在 #stage 上標 data-screen（目前在哪一頁，導覽列會亮）、data-word（背景描邊大字）；
// data-shell="none" 不放頂列與導覽（演出畫面、標題畫面），data-bg="none" 不放共用背景。
// 隊徽與頭像的顏色在這裡先補好，最後才呼叫 fill() 畫出來。
import { initStage, dust } from './stage.ts';
import { LINEAGE_LOOK } from '../club/art.ts';
import { fill } from './fill.ts';

const stage = initStage();
const screen = stage.dataset.screen ?? '';

const NAV: [id: string, label: string, icon: string, href: string, badge?: string][] = [
  ['hub', '基地', 'home', '../cyber.html'],
  ['squad', '戰隊', 'users', 'squad.html'],
  ['market', '市場', 'contract', 'market.html', 'dot'],
  ['training', '訓練', 'target', 'training.html'],
  ['league', '聯賽', 'trophy', 'league.html'],
  ['betting', '賭盤', 'ticket', 'betting.html'],
  ['finance', '財務', 'chart', 'finance.html'],
  ['inbox', '信件', 'mail', 'inbox.html', '3'],
];

const TOP = `<header class="top in">
  <div class="team"><span data-crest="天使戰隊" data-size="64"></span><div><b>天使戰隊</b><small>ANGEL GAMING // 新創聯賽</small></div></div>
  <div class="slash"></div>
  <div class="wk"><b>W04</b><span>/ 09 · REGULAR</span></div>
  <div class="res">
    <div class="funds"><div class="lb">FUNDS</div><b>104.8<small>萬</small></b><div class="dl">▼ 14.6 / WEEK</div></div>
    <div class="gauge"><svg viewBox="0 0 70 70"><circle cx="35" cy="35" r="29" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="6"/><circle cx="35" cy="35" r="29" fill="none" stroke="#eef2f6" stroke-width="6" stroke-linecap="round" stroke-dasharray="61 182"/></svg><b>10</b></div>
    <div class="gl"><b>名氣</b>REP</div>
    <div class="gauge"><svg viewBox="0 0 70 70"><circle cx="35" cy="35" r="29" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="6"/><circle cx="35" cy="35" r="29" fill="none" stroke="#f0b54a" stroke-width="6" stroke-linecap="round" stroke-dasharray="64 182"/></svg><b>7</b></div>
    <div class="gl"><b>資金跑道</b>WEEKS</div>
    <div class="icon-btn"><span data-icon="mail" data-size="24"></span><em>3</em></div>
    <div class="icon-btn"><span data-icon="menu" data-size="24"></span></div>
  </div>
</header>`;

function shell(): void {
  if (stage.dataset.bg !== 'none') {
    stage.insertAdjacentHTML(
      'afterbegin',
      `<div class="bgx"><div class="word">${stage.dataset.word ?? ''}</div><div class="beams"><i style="left:640px"></i><i style="left:1060px;width:130px;animation-delay:-2.4s"></i><i style="left:280px;width:150px;opacity:.5;animation-delay:-4.8s"></i></div><div class="fl"><i></i></div><div class="vig"></div></div><canvas id="dust" width="1920" height="1080"></canvas>`,
    );
  }
  if (stage.dataset.shell === 'none') return;
  const rail = NAV.map(([id, label, ic, href, badge]) => {
    const b = badge === 'dot' ? '<em class="dot"></em>' : badge ? `<em>${badge}</em>` : '';
    return `<a href="${href}"${id === screen ? ' class="on"' : ''}><span data-icon="${ic}" data-size="26"></span>${label}${b}</a>`;
  }).join('');
  stage.insertAdjacentHTML('beforeend', `${TOP}<nav class="rail in sl" style="--d:.1s">${rail}<a class="md" href="match.html"><b>比賽日</b><span>MATCH</span></a></nav>`);
}
shell();

const dc = document.getElementById('dust') as HTMLCanvasElement | null;
if (dc) dust(dc, ['rgba(255,217,138,.5)', 'rgba(220,235,255,.3)'], 60);

// 隊徽：我方白底金邊；data-foe 是本週對手（紅）；其他隊一律墨黑＋灰白，不帶各隊自己的顏色
document.querySelectorAll<HTMLElement>('[data-crest]').forEach((el) => {
  if (el.dataset.primary) return;
  const me = el.dataset.crest === '天使戰隊';
  const foe = el.dataset.foe !== undefined;
  el.dataset.primary = me ? '#eef2f6' : foe ? '#2a1416' : '#1c2535';
  el.dataset.secondary = me ? '#f0b54a' : foe ? '#ff5d5d' : '#c9d1dc';
});
document.querySelectorAll<HTMLElement>('[data-avatar]').forEach((el) => {
  if (!el.dataset.jersey) el.dataset.jersey = '#3a4458';
});
// 流派徽記：用原本的圖形，但一律單色（跟著文字顏色）
document.querySelectorAll<HTMLElement>('[data-lineage]').forEach((el) => {
  const l = LINEAGE_LOOK[el.dataset.lineage as string];
  const size = Number(el.dataset.size ?? 16);
  if (l) el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" color="currentColor" aria-hidden="true">${l.glyph}</svg>`;
});
void fill();
