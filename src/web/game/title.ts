// 標題畫面（隊徽在刻度環中央；只有「繼續」是金色）與創立戰隊（即時預覽、外形 4 種、配色 6 組、圖騰 10 種、亂數種子）。
import { weekLabel } from '../manage/format.ts';
import type { SaveInfo } from '../manage/store.ts';
import { CREST_SHAPE_COUNT, EMBLEM_NAMES, crestSvg, type CrestSpec } from '../club/art.ts';
import { CREST_SCHEMES, esc, icon, wan } from './kit.ts';

export interface Draft {
  name: string;
  crest: CrestSpec;
  seed: number;
}

const RINGS = (text: string): string => `<svg viewBox="0 0 700 700">
  <defs><path id="tp" d="M 350 12 A 338 338 0 1 1 349.99 12"/><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd98a"/><stop offset="1" stop-color="#b9832a"/></linearGradient></defs>
  <g class="rr"><text><textPath href="#tp">${text}</textPath></text></g>
  <g class="rs"><circle cx="350" cy="350" r="310" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="12" stroke-dasharray="1.6 5.4"/><circle cx="350" cy="350" r="310" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="22" stroke-dasharray="3 159"/></g>
  <circle cx="350" cy="350" r="282" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="10"/>
  <circle cx="350" cy="350" r="282" fill="none" stroke="url(#gold)" stroke-width="10" stroke-linecap="round" stroke-dasharray="1180 1772" transform="rotate(-90 350 350)"/>
  <g class="rf"><circle cx="350" cy="350" r="256" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="2" stroke-dasharray="50 100 12 70 160 330 24 760"/></g>
  <path d="M 350 34 L 350 58 M 350 642 L 350 666 M 34 350 L 58 350 M 642 350 L 666 350" stroke="#f0b54a" stroke-width="3"/></svg>`;

export function titleScreen(save: SaveInfo | null, crest: CrestSpec): string {
  const status = save ? (save.phase === 'ended' ? '賽段已結束' : save.phase === 'bankrupt' ? '已破產' : weekLabel(save.week)) : '';
  return `<div class="s-title">
    <section class="emb in">${RINGS('ANGEL GAMING · 天使戰隊 · NEW LEAGUE · SEASON 01 · 先鋒 · 中堅 · 大將 · ANGEL GAMING · 天使戰隊 · NEW LEAGUE ·')}<span class="cr">${crestSvg(crest, 220)}</span></section>
    <section class="brand in"><div class="en">ESPORTS CLUB MANAGER</div><div class="logo">ANGEL<span>GAMING</span></div><div class="zh">天使戰隊</div></section>
    <section class="menu in">
      ${save ? `<button class="btn" data-act="continue"><b>繼續</b><span class="info">${esc(save.teamName)} · ${status} · ${wan(save.cash)}萬</span></button>` : ''}
      <button class="btn ${save ? 'ghost' : ''}" data-act="to-create"><b>創立新戰隊</b><span class="info">${save ? '會覆蓋目前的存檔' : '從休賽期開始'}</span></button>
      <div class="row4"><label class="btn ghost"><b>匯入存檔</b><input id="import" type="file" accept=".json,application/json" hidden></label><a class="btn ghost" href="./club.html"><b>舊版介面</b></a><a class="btn ghost" href="./index.html"><b>回首頁</b></a></div>
    </section>
    <div class="ver">M4 PROTOTYPE · 比賽目前是假比賽（依選手隱藏強度擲骰）· 數值都還在調整</div>
    <div class="press">${save ? 'ENTER 繼續' : ''}</div>
  </div>`;
}

export function createScreen(d: Draft): string {
  const shapes = Array.from({ length: CREST_SHAPE_COUNT }, (_, i) => `<button class="opt ${d.crest.shape === i ? 'on' : ''}" data-act="crest" data-k="shape" data-v="${i}">${crestSvg({ ...d.crest, shape: i }, 62)}</button>`).join('');
  const schemes = CREST_SCHEMES.map((s) => `<button class="opt ${d.crest.primary === s.primary && d.crest.secondary === s.secondary ? 'on' : ''}" data-act="scheme" data-p="${s.primary}" data-s="${s.secondary}"><span class="sw"><i><b style="background:${s.primary}"></b><b style="background:${s.secondary}"></b></i>${s.name}</span></button>`).join('');
  const emblems = EMBLEM_NAMES.map((em) => `<button class="opt ${d.crest.emblem === em ? 'on' : ''}" data-act="crest" data-k="emblem" data-v="${em}">${crestSvg({ ...d.crest, emblem: em }, 42)}</button>`).join('');
  return `<div class="s-create">
    <div class="hd2 in"><button class="lnk back" data-act="to-title">${icon('back', 18)}返回</button><span class="en">NEW TEAM // 創立戰隊</span><h1>創立戰隊</h1></div>
    <section class="pre in"><div class="halo"><svg viewBox="0 0 420 420"><circle cx="210" cy="210" r="200" fill="none" stroke="rgba(240,181,74,.5)" stroke-width="4"/><g class="sp"><circle cx="210" cy="210" r="186" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="5" stroke-dasharray="2 9"/></g><circle cx="210" cy="210" r="166" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="1"/></svg>
      <span class="big">${crestSvg(d.crest, 250)}</span></div>
      <div class="name" data-out="team-name">${esc(d.name || '天使戰隊')}</div><div class="sub">ANGEL GAMING</div>
      <div class="facts"><span>起始資金<b>150</b> 萬</span><span>聯賽<b>8</b> 隊</span><span>賽段<b>9</b> 週</span></div></section>
    <section class="pn g form in"><div class="pt"><span class="no">01</span><b>戰隊設定</b><span class="aux">隊徽只影響畫面，不進存檔</span></div>
      <div class="lbl"><span>戰隊名稱</span><span>最多 10 字</span></div>
      <input class="input" id="team-name" type="text" maxlength="10" value="${esc(d.name)}" data-field="draft.name">
      <div class="lbl"><span>隊徽外形</span></div><div class="opts c4">${shapes}</div>
      <div class="lbl"><span>配色</span><span>介面固定用天使金；隊徽只在金、白、墨之間配</span></div><div class="opts c6">${schemes}</div>
      <div class="lbl"><span>圖騰</span></div><div class="opts c10">${emblems}</div>
      <div class="adv"><span>亂數種子</span><input class="seed" id="seed" type="number" min="0" step="1" value="${d.seed}" data-field="draft.seed"><button class="lnk" data-act="reroll">${icon('swap', 14)}隨機</button><span class="dim">同一個種子，聯賽與選手每次都一樣</span>
        <button class="btn lg" data-act="create"><b>創立戰隊</b><span>START</span></button></div></section>
  </div>`;
}
