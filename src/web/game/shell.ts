// 正式版外框：頂列（隊徽、週次、資金、名氣、資金跑道、信件、選單）與左側導覽（8 個入口＋比賽日按鈕）。
import type { Ctx, Screen } from './kit.ts';
import { crestSpec, esc, icon, wan, weekLabel } from './kit.ts';
import { crestSvg, type IconName } from '../club/art.ts';

const NAV: { id: Screen; label: string; ic: IconName }[] = [
  { id: 'hub', label: '基地', ic: 'home' },
  { id: 'squad', label: '戰隊', ic: 'users' },
  { id: 'market', label: '市場', ic: 'contract' },
  { id: 'training', label: '訓練', ic: 'target' },
  { id: 'league', label: '聯賽', ic: 'trophy' },
  { id: 'betting', label: '賭盤', ic: 'ticket' },
  { id: 'finance', label: '財務', ic: 'chart' },
  { id: 'inbox', label: '信件', ic: 'mail' },
];

/** 圓環錶：0～1 的比例 */
function gauge(frac: number, color: string, val: string): string {
  const L = 182;
  const d = Math.max(0, Math.min(1, frac)) * L;
  return `<div class="gauge"><svg viewBox="0 0 70 70"><circle cx="35" cy="35" r="29" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="6"/><circle cx="35" cy="35" r="29" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${d.toFixed(1)} ${L}"/></svg><b>${val}</b></div>`;
}

export function topBar(ctx: Ctx, unread: number, demo: boolean): string {
  const { v } = ctx;
  const wl = weekLabel(v);
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const runway = v.me.runwayWeeks;
  const low = runway !== null && runway < 3;
  return `<header class="top">
    <button class="team" data-act="go" data-to="hub">${crestSvg(crestSpec(ctx, v.me.teamId), 64)}<div><b>${esc(v.me.name)}</b><small>${demo ? '展示模式 · 不存檔' : 'ANGEL GAMING // 新創聯賽'}</small></div></button>
    <div class="slash"></div>
    <div class="wk"><b>${wl.short}</b><span>${v.phase === 'season' || v.phase === 'offseason' ? `/ 09 · ${wl.en}` : wl.en}</span></div>
    <div class="res">
      <div class="funds"><div class="lb">FUNDS</div><b class="${v.me.cash < 0 ? 'neg' : ''}"><span id="hud-cash">${wan(v.me.cash)}</span><small>萬</small></b><div class="dl ${net >= 0 ? 'up' : ''}">${net >= 0 ? '▲' : '▼'} ${wan(Math.abs(net))} / WEEK</div></div>
      ${gauge(v.me.fame / 30, '#eef2f6', String(v.me.fame))}<div class="gl"><b>名氣</b>REP</div>
      ${gauge(runway === null ? 1 : runway / 12, low ? '#ff5d5d' : '#f0b54a', runway === null ? '∞' : String(runway))}<div class="gl ${low ? 'warn' : ''}"><b>資金跑道</b>WEEKS</div>
      <button class="icon-btn" data-act="go" data-to="inbox" aria-label="信件">${icon('mail', 24)}${unread ? `<em>${unread}</em>` : ''}</button>
      <button class="icon-btn" data-act="menu" aria-label="選單">${icon('menu', 24)}</button>
    </div>
  </header>`;
}

export function rail(ctx: Ctx, screen: Screen, unread: number, busy: boolean): string {
  const { v } = ctx;
  const over = v.phase === 'ended' || v.phase === 'bankrupt';
  const lit = screen === 'player' ? (ctx.ui.player && ctx.pm.get(ctx.ui.player)?.teamId === v.me.teamId ? 'squad' : 'market') : screen;
  const badge = (id: Screen): string => {
    if (id === 'inbox' && unread) return `<em>${unread}</em>`;
    if (id === 'market' && v.jobs.some((j) => j.kind === 'scout')) return '<em class="dot"></em>';
    if (id === 'squad' && v.me.lineup.length !== 3 && !over) return '<em class="dot"></em>';
    return '';
  };
  const md = busy ? ['進行中', 'WAIT'] : over ? ['已結束', 'OVER'] : v.phase === 'offseason' ? ['開幕', 'START'] : ['比賽日', 'MATCH'];
  return `<nav class="rail">${NAV.map((n) => `<button class="${n.id === lit ? 'on' : ''}" data-act="go" data-to="${n.id}">${icon(n.ic, 26)}${n.label}${badge(n.id)}</button>`).join('')}
    <button class="md" data-act="advance" ${busy || over ? 'disabled' : ''}><b>${md[0]}</b><span>${md[1]}</span></button></nav>`;
}
