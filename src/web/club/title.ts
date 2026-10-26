// 標題畫面與「創立戰隊」。
import { esc, wan, weekLabel } from '../manage/format.ts';
import type { SaveInfo } from '../manage/store.ts';
import type { CrestSpec } from './art.ts';
import { CREST_SHAPE_COUNT, EMBLEM_NAMES, PLAYER_COLORS, crestSvg, icon } from './art.ts';

export interface Draft {
  name: string;
  crest: CrestSpec;
  seed: number;
}

const SECONDARY = ['#d4a017', '#f8fafc', '#111827', '#22d3ee'];

export function titleScreen(save: SaveInfo | null, crest: CrestSpec): string {
  const status = save ? (save.phase === 'ended' ? '賽段已結束' : save.phase === 'bankrupt' ? '已破產' : weekLabel(save.week)) : '';
  return `<div class="title">
    <div class="title-bg"><i></i><i></i><i></i></div>
    <div class="title-main">
      <div class="title-crest">${crestSvg(crest, 150)}</div>
      <div class="logo"><span class="logo-en">ANGEL GAMING</span><h1>天使戰隊</h1><span class="logo-sub">電競經營・新創聯賽</span></div>
      <nav class="title-menu">
        ${save ? `<button class="tm-btn primary" data-act="continue"><b>${icon('play', 18)}繼續</b><span>${esc(save.teamName)}・${status}・現金 ${wan(save.cash)} 萬</span></button>` : ''}
        <button class="tm-btn ${save ? '' : 'primary'}" data-act="to-create"><b>${icon('star', 18)}創立新戰隊</b><span>${save ? '會覆蓋目前的存檔' : '從休賽期開始'}</span></button>
        <label class="tm-btn"><b>${icon('upload', 18)}匯入存檔</b><span>讀取匯出的 .json</span><input id="import" type="file" accept=".json,application/json" hidden></label>
        <div class="title-links"><a href="./manage.html">舊版介面</a><span>・</span><a href="./index.html">回首頁</a></div>
      </nav>
    </div>
    <p class="title-foot">原型：只有經營層。比賽目前是「假比賽」（依選手隱藏強度擲骰），所有數值都還在調整。</p>
  </div>`;
}

export function createScreen(d: Draft): string {
  const shapes = Array.from({ length: CREST_SHAPE_COUNT }, (_, i) => `<button class="opt ${d.crest.shape === i ? 'on' : ''}" data-act="crest" data-k="shape" data-v="${i}">${crestSvg({ ...d.crest, shape: i }, 40)}</button>`).join('');
  const colors = PLAYER_COLORS.map((col) => `<button class="sw ${d.crest.primary === col ? 'on' : ''}" style="--c:${col}" data-act="crest" data-k="primary" data-v="${col}" aria-label="主色"></button>`).join('');
  const seconds = SECONDARY.map((col) => `<button class="sw ${d.crest.secondary === col ? 'on' : ''}" style="--c:${col}" data-act="crest" data-k="secondary" data-v="${col}" aria-label="副色"></button>`).join('');
  const emblems = EMBLEM_NAMES.map((em) => `<button class="opt ${d.crest.emblem === em ? 'on' : ''}" data-act="crest" data-k="emblem" data-v="${em}">${crestSvg({ ...d.crest, emblem: em }, 40)}</button>`).join('');
  return `<div class="title create">
    <div class="title-bg"><i></i><i></i><i></i></div>
    <div class="create-box">
      <button class="sc-back" data-act="to-title">${icon('back', 18)}<span>返回</span></button>
      <h1>創立戰隊</h1>
      <div class="create-grid">
        <div class="create-preview"><div class="title-crest">${crestSvg(d.crest, 170)}</div><b data-out="team-name">${esc(d.name || '天使戰隊')}</b><span>新創聯賽 新加盟</span></div>
        <div class="create-form">
          <label class="fld"><span>戰隊名稱</span><input id="team-name" type="text" maxlength="10" value="${esc(d.name)}" data-field="draft.name"></label>
          <div class="fld"><span>隊徽外形</span><div class="opts">${shapes}</div></div>
          <div class="fld"><span>主色</span><div class="sws">${colors}</div></div>
          <div class="fld"><span>副色</span><div class="sws">${seconds}</div></div>
          <div class="fld"><span>圖騰</span><div class="opts">${emblems}</div></div>
          <details class="fld adv"><summary>進階：亂數種子</summary><div class="row"><input id="seed" type="number" min="0" step="1" value="${d.seed}" data-field="draft.seed"><button class="btn-chip" data-act="reroll">${icon('swap', 14)}隨機</button></div><p class="fine">同一個種子、同一組操作，結果每次都一樣；讀檔重來不會改變比賽結果。</p></details>
          <button class="btn-main glow big" data-act="create">${icon('play', 18)}創立戰隊，進入休賽期</button>
        </div>
      </div>
    </div>
  </div>`;
}
