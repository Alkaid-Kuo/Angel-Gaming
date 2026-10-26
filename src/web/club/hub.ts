// 基地（主畫面）：下一場比賽、積分快訊、各設施入口、新聞跑馬燈。
import { esc } from '../manage/format.ts';
import { icon, type IconName } from './art.ts';
import { coin, crest, miniCard, slotLabel } from './cards.ts';
import type { Ctx } from './model.ts';
import { lineupOf, myFixture, opponentOf, publicRating, rankOf, teamForm, teamName } from './model.ts';

function weekTitle(week: number): string {
  if (week === 0) return '季前準備';
  if (week === 8) return '季後賽・準決賽';
  if (week === 9) return '季後賽・總決賽';
  return `例行賽・第 ${week} 週`;
}

function heroCard(ctx: Ctx): string {
  const { v } = ctx;
  if (v.phase === 'ended' || v.phase === 'bankrupt') {
    const broke = v.phase === 'bankrupt';
    const rank = v.seasonResult?.humanRank;
    return `<section class="hero-card ${broke ? 'broke' : 'over'}">
      <div class="hc-label">${broke ? '公司破產' : '賽季落幕'}</div>
      <div class="hc-big">${broke ? '資金耗盡' : `最終第 ${rank} 名`}</div>
      <p>${broke ? '現金跌破零，戰隊解散了。換個打法再來一次。' : '這個賽段結束了。帶著經驗開一支新的戰隊吧。'}</p>
      <div class="hc-row"><button class="btn-main" data-act="new-season">${icon('play', 18)}新的賽季</button><button class="btn-sub" data-act="go" data-to="league">${icon('trophy', 16)}看最終排名</button></div></section>`;
  }
  if (v.phase === 'offseason') {
    const lu = lineupOf(ctx);
    const checks: [boolean, string][] = [
      [v.me.roster.length > 3, `陣容 ${v.me.roster.length} 人（補一名替補，可應付對位與升版）`],
      [!lu.auto, '親手排好先鋒、中堅、大將'],
      [v.jobs.length > 0, '排了練習賽、研發或球探（開幕時出報告）'],
    ];
    return `<section class="hero-card pre">
      <div class="hc-label">${icon('calendar', 16)} 休賽期</div>
      <div class="hc-big">季前準備</div>
      <p>第 1 週開打前，先把戰隊整頓好。休賽期推進不扣薪水。</p>
      <ul class="hc-checks">${checks.map(([ok, t]) => `<li class="${ok ? 'ok' : ''}">${icon(ok ? 'check' : 'info', 16)}${t}</li>`).join('')}</ul>
      <div class="hc-row"><button class="btn-main glow" data-act="advance">${icon('play', 18)}賽季開幕</button></div></section>`;
  }
  const f = myFixture(v);
  if (!f) {
    return `<section class="hero-card idle"><div class="hc-label">${weekTitle(v.week)}</div><div class="hc-big">本週沒有你的比賽</div>
      <p>你沒有進入這一輪。仍然可以到賭盤押別人的比賽，或趁空檔訓練。</p>
      <div class="hc-row"><button class="btn-main glow" data-act="advance">${icon('play', 18)}觀看本週賽事</button><button class="btn-sub" data-act="go" data-to="betting">${icon('ticket', 16)}賭盤</button></div></section>`;
  }
  const opp = opponentOf(f, v.me.teamId);
  const odds = v.odds.find((o) => o.fixtureId === f.id);
  const myOdds = odds ? (f.home === v.me.teamId ? odds.homeX100 : odds.awayX100) : null;
  const lu = lineupOf(ctx);
  const form = (id: string): string => `<span class="form">${teamForm(v, id).map((r) => `<i class="${r}">${r === 'W' ? '勝' : r === 'L' ? '敗' : '和'}</i>`).join('') || '<em>—</em>'}</span>`;
  return `<section class="hero-card match">
    <div class="hc-label">${icon('swords', 16)} ${weekTitle(v.week)}</div>
    <div class="vs-row">
      <div class="vs-side">${crest(ctx, v.me.teamId, 86)}<b>${esc(teamName(ctx, v.me.teamId))}</b><span>公開戰力 ${publicRating(ctx, v.me.teamId)}</span>${form(v.me.teamId)}</div>
      <div class="vs-mid"><span class="vs">VS</span>${myOdds ? `<span class="odds">押你贏 ×${(myOdds / 100).toFixed(2)}</span>` : ''}</div>
      <div class="vs-side">${crest(ctx, opp, 86)}<b>${esc(teamName(ctx, opp))}</b><span>公開戰力 ${publicRating(ctx, opp)}</span>${form(opp)}</div>
    </div>
    <div class="hc-lineup">${lu.ids.map((id, i) => `<div class="hc-slot"><span>${slotLabel(i)}</span>${miniCard(ctx, ctx.pm.get(id))}</div>`).join('')}</div>
    <p class="hc-note">${lu.auto ? '出賽名單目前是<b>自動</b>（評分最高的 3 人）。' : '出賽名單已排定。'}對手的名單要到比賽日才公開——對位順序就是心理戰。</p>
    <div class="hc-row"><button class="btn-main glow" data-act="advance">${icon('play', 18)}進入比賽日</button><button class="btn-sub" data-act="go" data-to="squad">${icon('users', 16)}調整名單</button></div></section>`;
}

function miniTable(ctx: Ctx): string {
  const { v } = ctx;
  const rows = v.standings.slice(0, 8);
  const started = rows.some((r) => r.played > 0);
  return `<section class="side-card"><h3>${icon('trophy', 16)}積分榜</h3>
    <ol class="mini-table">${rows
      .map((r, i) => `<li class="${r.teamId === v.me.teamId ? 'me' : ''} ${i === 3 ? 'cut' : ''}"><span class="rk">${i + 1}</span>${crest(ctx, r.teamId, 20)}<span class="nm">${esc(teamName(ctx, r.teamId))}</span><b>${started ? r.points : '—'}</b></li>`)
      .join('')}</ol>
    <button class="btn-link" data-act="go" data-to="league">完整賽程 ${icon('play', 10)}</button></section>`;
}

interface Tile {
  to: string;
  ic: IconName;
  title: string;
  status: string;
  badge?: string;
  warn?: boolean;
}

function tiles(ctx: Ctx, unread: number): Tile[] {
  const { v, c } = ctx;
  const lu = lineupOf(ctx);
  const cap = c.economy.scrimCapacity[v.me.trainingLevel - 1];
  const open = v.fixtures.filter((f) => f.week === v.week && f.score === null).length;
  const rank = rankOf(v, v.me.teamId);
  const row = v.standings.find((r) => r.teamId === v.me.teamId);
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const scouting = v.jobs.filter((j) => j.kind === 'scout').length;
  const training = v.jobs.filter((j) => j.kind !== 'scout').length;
  return [
    { to: 'squad', ic: 'users', title: '戰隊', status: `${v.me.roster.length} / ${c.economy.rosterMax} 名選手・名單${lu.auto ? '自動' : '已排'}`, badge: lu.auto && v.phase !== 'ended' && v.phase !== 'bankrupt' ? '排名單' : undefined },
    { to: 'market', ic: 'contract', title: '轉會市場', status: `${v.players.filter((p) => p.teamId === null).length} 名自由球員`, badge: scouting ? `球探 ${scouting}` : undefined },
    { to: 'training', ic: 'target', title: '訓練基地', status: `Lv${v.me.trainingLevel}・本週剩 ${Math.max(0, v.me.capacityLeft)} / ${cap} 場`, badge: training ? `進行中 ${training}` : undefined },
    { to: 'league', ic: 'trophy', title: '聯賽', status: row && row.played > 0 ? `第 ${rank} 名・${row.points} 分` : '尚未開賽' },
    { to: 'betting', ic: 'ticket', title: '賭盤', status: v.phase === 'season' ? `本週 ${open} 場・已押 ${v.bets.length} 注` : '賽季中開放' },
    { to: 'finance', ic: 'chart', title: '財務', status: `每週固定 ${net >= 0 ? '+' : '−'}${Math.abs(net / 10).toFixed(1)} 萬`, warn: v.me.runwayWeeks !== null && v.me.runwayWeeks < 3 },
    { to: 'inbox', ic: 'mail', title: '信件', status: unread ? `${unread} 封未讀` : '沒有新信', badge: unread ? String(unread) : undefined },
  ];
}

export function hubScreen(ctx: Ctx, unread: number): string {
  const { v } = ctx;
  const news = [...v.inbox].reverse().slice(0, 8);
  return `<div class="hub">
    <div class="hub-top">${heroCard(ctx)}${miniTable(ctx)}</div>
    <div class="tiles">${tiles(ctx, unread)
      .map(
        (t) => `<button class="tile tile-${t.to} ${t.warn ? 'warn' : ''}" data-act="go" data-to="${t.to}"><span class="tile-ic">${icon(t.ic, 30, 1.6)}</span><span class="tile-tx"><b>${t.title}</b><span>${t.status}</span></span>${t.badge ? `<em class="tile-badge">${t.badge}</em>` : ''}</button>`,
      )
      .join('')}
      <div class="tile tile-money"><span class="tile-tx"><span>現金</span>${coin(v.me.cash, 'xl')}<span>${v.me.runwayWeeks === null ? '贊助養得起固定支出' : `只靠固定收支撐 ${v.me.runwayWeeks} 週`}</span></span></div></div>
    <div class="ticker"><span class="ticker-lb">${icon('bolt', 14)}快訊</span><div class="ticker-tx">${news.length ? news.map((m) => `<span>${esc(m.text)}</span>`).join('') : '<span>戰隊成立，歡迎來到聯賽。</span>'}</div></div>
  </div>`;
}
