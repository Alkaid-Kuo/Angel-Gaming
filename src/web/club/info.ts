// 聯賽（積分榜、季後賽樹狀圖、賽程）、財務（資金曲線、收支）、信件。
import type { KnownFixture } from '../../manage/index.ts';
import { CATEGORY_NAME, esc, wan } from '../manage/format.ts';
import { icon, type IconName } from './art.ts';
import { coin, crest, screenHead, signedCoin } from './cards.ts';
import type { Ctx } from './model.ts';
import { cashSeries, rosterOf, startCash, teamForm, teamName } from './model.ts';

function weekChip(w: number): string {
  return w <= 7 ? `W${w}` : w === 8 ? '準決' : '決賽';
}

function matchRow(ctx: Ctx, f: KnownFixture): string {
  const me = ctx.v.me.teamId;
  const s = f.score;
  const res = (id: string): string => {
    if (!s) return '';
    const mine = f.home === id ? s.home : s.away;
    const theirs = f.home === id ? s.away : s.home;
    return mine > theirs ? 'win' : mine < theirs ? 'lose' : '';
  };
  const dots = '';
  return `<div class="mrow ${f.home === me || f.away === me ? 'mine' : ''}">
    <span class="mr-t ${res(f.home)}">${esc(teamName(ctx, f.home))}${crest(ctx, f.home, 24)}</span>
    <span class="mr-s">${s ? `<b>${s.home}</b><em>:</em><b>${s.away}</b>` : '<em>VS</em>'}${dots ? `<span class="mr-dots">${dots}</span>` : ''}</span>
    <span class="mr-t r ${res(f.away)}">${crest(ctx, f.away, 24)}${esc(teamName(ctx, f.away))}</span></div>`;
}

function bracket(ctx: Ctx): string {
  const { v } = ctx;
  const top = v.standings.slice(0, 4).map((r) => r.teamId);
  const semis = v.fixtures.filter((f) => f.stage === 'semi');
  const final = v.fixtures.find((f) => f.stage === 'final');
  const third = v.fixtures.find((f) => f.stage === 'third');
  const slot = (id: string | undefined, score: number | null, win: boolean, label = ''): string =>
    id ? `<div class="bk-team ${win ? 'win' : ''} ${id === v.me.teamId ? 'me' : ''}">${crest(ctx, id, 22)}<span>${esc(teamName(ctx, id))}</span><b>${score ?? ''}</b></div>` : `<div class="bk-team tbd"><span>${label || '待定'}</span></div>`;
  const match = (f: KnownFixture | undefined, a: string | undefined, b: string | undefined, la = '', lb = ''): string => {
    const s = f?.score ?? null;
    return `<div class="bk-match">${slot(f?.home ?? a, s ? s.home : null, !!s && s.home > s.away, la)}${slot(f?.away ?? b, s ? s.away : null, !!s && s.away > s.home, lb)}</div>`;
  };
  const projected = semis.length === 0;
  return `<section class="panel"><div class="panel-hd"><h2>${icon('trophy', 18)}季後賽</h2><span>${projected ? '依目前積分榜預測（例行賽結束才確定）' : '第 8 週準決賽、第 9 週總決賽與季軍戰'}</span></div>
    <div class="bracket"><div class="bk-col"><h4>準決賽</h4>${match(semis[0], top[0], top[3], '第 1 名', '第 4 名')}${match(semis[1], top[1], top[2], '第 2 名', '第 3 名')}</div>
      <div class="bk-col"><h4>${icon('crown', 14)}總決賽</h4>${match(final, undefined, undefined, '準決賽勝者', '準決賽勝者')}<h4>季軍戰</h4>${match(third, undefined, undefined, '準決賽敗者', '準決賽敗者')}</div>
      ${v.seasonResult ? `<div class="bk-col champ">${crest(ctx, v.seasonResult.ranks[0], 70)}<b>${esc(teamName(ctx, v.seasonResult.ranks[0]))}</b><span>冠軍</span></div>` : ''}</div></section>`;
}

export function leagueScreen(ctx: Ctx): string {
  const { v, ui } = ctx;
  const started = v.standings.some((r) => r.played > 0);
  const table = v.standings
    .map((r, i) => {
      const form = teamForm(v, r.teamId)
        .map((x) => `<i class="${x}">${x === 'W' ? '勝' : x === 'L' ? '敗' : '和'}</i>`)
        .join('');
      return `<tr class="${r.teamId === v.me.teamId ? 'me' : ''} ${i < 4 ? 'po' : ''}"><td class="rk">${i + 1}</td><td class="tm"><span class="tm-in">${crest(ctx, r.teamId, 26)}<span>${esc(teamName(ctx, r.teamId))}</span></span></td><td>${r.played}</td><td>${r.wins}-${r.draws}-${r.losses}</td><td>${r.scoreDiff >= 0 ? '+' : ''}${r.scoreDiff}</td><td class="form">${form || '—'}</td><td class="pts">${started ? r.points : '—'}</td></tr>`;
    })
    .join('');
  const weeks = [...new Set(v.fixtures.map((f) => f.week))].sort((a, b) => a - b);
  const sel = ui.leagueWeek ?? (v.phase === 'season' ? v.week : v.phase === 'offseason' ? 1 : weeks[weeks.length - 1]);
  const fx = v.fixtures.filter((f) => f.week === sel);
  return `${screenHead('聯賽', 'trophy', '新創聯賽・8 隊・例行賽 7 週單循環，前 4 名進季後賽')}
    <div class="two-col wide-left">
      <section class="panel"><div class="panel-hd"><h2>${icon('trophy', 18)}積分榜</h2><span>勝 3、和 1、敗 0；同分比對位勝場差</span></div>
        <table class="standings"><thead><tr><th>#</th><th>戰隊</th><th>賽</th><th>勝-和-敗</th><th>對位差</th><th>近況</th><th>積分</th></tr></thead><tbody>${table}</tbody></table>
        <p class="fine"><span class="po-mark"></span>前 4 名晉級季後賽</p></section>
      <section class="panel"><div class="panel-hd"><h2>${icon('calendar', 18)}賽程</h2></div>
        <div class="week-chips">${weeks.map((w) => `<button class="chip ${w === sel ? 'on' : ''} ${w === v.week && v.phase === 'season' ? 'now' : ''}" data-act="lweek" data-w="${w}">${weekChip(w)}</button>`).join('')}</div>
        <div class="mlist">${fx.map((f) => matchRow(ctx, f)).join('') || '<p class="empty-note">這週還沒有對戰組合</p>'}</div></section>
    </div>${bracket(ctx)}`;
}

const MSG_ICON: Record<string, IconName> = { result: 'swords', finance: 'coins', report: 'flask', system: 'info' };

export function inboxScreen(ctx: Ctx, seen: number): string {
  const msgs = ctx.v.inbox.map((m, i) => ({ ...m, unread: i >= seen })).reverse();
  return `${screenHead('信件', 'mail', `${msgs.length} 封`)}
    <section class="panel mail">${msgs.length ? msgs.map((m) => `<div class="msg k-${m.kind} ${m.unread ? 'new' : ''}"><span class="msg-ic">${icon(MSG_ICON[m.kind] ?? 'mail', 18)}</span><div><span class="msg-w">${m.week === 0 ? '休賽期' : `第 ${m.week} 週`}</span><p>${esc(m.text)}</p></div>${m.unread ? '<em>NEW</em>' : ''}</div>`).join('') : '<p class="empty-note">信箱是空的</p>'}</section>`;
}

function chart(ctx: Ctx): string {
  const s = cashSeries(ctx.v);
  if (s.length < 2) return '<p class="empty-note">打完幾週後這裡會畫出資金曲線。</p>';
  const W = 640;
  const H = 210;
  const padL = 46;
  const padB = 26;
  const cashes = [startCash(ctx.v), ...s.map((x) => x.cash)];
  const maxCash = Math.max(...cashes, 1);
  const minCash = Math.min(0, ...cashes);
  const maxNet = Math.max(1, ...s.map((x) => Math.abs(x.net)));
  const step = (W - padL - 10) / s.length;
  const y = (c: number): number => 10 + (H - padB - 10) * (1 - (c - minCash) / (maxCash - minCash || 1));
  const zeroNet = (H - padB) / 2 + 5;
  const bars = s
    .map((x, i) => {
      const h = (Math.abs(x.net) / maxNet) * ((H - padB) / 2 - 12);
      const bx = padL + i * step + step * 0.22;
      return `<rect x="${bx}" y="${x.net >= 0 ? zeroNet - h : zeroNet}" width="${step * 0.56}" height="${Math.max(1, h)}" rx="3" fill="${x.net >= 0 ? '#34d399' : '#fb7185'}" fill-opacity=".55"/><text x="${bx + step * 0.28}" y="${H - 8}" text-anchor="middle">${x.week === 0 ? '休' : x.week <= 7 ? x.week : x.week === 8 ? '準' : '決'}</text>`;
    })
    .join('');
  const pts = s.map((x, i) => `${padL + i * step + step / 2},${y(x.cash)}`).join(' ');
  const last = s[s.length - 1];
  return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${padL}" x2="${W - 6}" y1="${zeroNet}" y2="${zeroNet}" class="zl"/>
    ${minCash < 0 ? `<line x1="${padL}" x2="${W - 6}" y1="${y(0)}" y2="${y(0)}" class="danger"/>` : ''}
    ${bars}<polyline points="${pts}" class="cash-line"/>
    ${s.map((x, i) => `<circle cx="${padL + i * step + step / 2}" cy="${y(x.cash)}" r="3.5" class="cash-dot"/>`).join('')}
    <text x="4" y="${y(maxCash) + 4}">${wan(maxCash)}萬</text><text x="4" y="${y(minCash) + 4}">${wan(minCash)}萬</text>
    <text x="${padL + (s.length - 1) * step + step / 2}" y="${y(last.cash) - 10}" text-anchor="middle" class="last">${wan(last.cash)}萬</text></svg>
    <div class="legend"><span><i class="ln"></i>週末現金</span><span><i class="pos"></i>本週賺</span><span><i class="neg"></i>本週虧</span></div>`;
}

export function financeScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const salaries = rosterOf(ctx, v.me.teamId).sort((a, b) => b.weeklySalary - a.weeklySalary);
  const maint = e.facilityMaintenance[v.me.trainingLevel - 1];
  const maxItem = Math.max(v.me.weeklySponsor, ...salaries.map((p) => p.weeklySalary), maint, 1);
  const bar = (label: string, k: number, cls: string): string => `<div class="fbar ${cls}"><span>${label}</span><div><i style="width:${Math.round((k / maxItem) * 100)}%"></i></div><b>${cls === 'in' ? '+' : '−'}${wan(k)}</b></div>`;
  const totals = new Map<string, number>();
  for (const x of v.ledger) totals.set(x.category, (totals.get(x.category) ?? 0) + x.amount);
  const ledger = [...v.ledger].reverse();
  const runway = v.me.runwayWeeks;
  return `${screenHead('財務', 'chart', '所有金額單位：萬')}
    <div class="fin-top">
      <section class="panel fin-cash"><span>現金</span>${coin(v.me.cash, 'xxl')}<div class="runway ${runway !== null && runway < 3 ? 'warn' : ''}">${icon('hourglass', 16)}${runway === null ? '贊助養得起固定支出' : `只靠固定收支還撐 <b>${runway}</b> 週`}</div></section>
      <section class="panel fin-week"><div class="panel-hd"><h2>${icon('calendar', 18)}每週固定收支</h2><span>不含比賽獎金與下注</span></div>
        ${bar('贊助', v.me.weeklySponsor, 'in')}${salaries.map((p) => bar(esc(p.name), p.weeklySalary, 'out')).join('')}${bar(`訓練中心 Lv${v.me.trainingLevel}`, maint, 'out')}
        <div class="fsum">每週 ${signedCoin(net)}</div></section></div>
    <section class="panel"><div class="panel-hd"><h2>${icon('chart', 18)}資金曲線</h2><span>每週結算後的現金與當週淨額</span></div>${chart(ctx)}</section>
    <section class="panel"><div class="panel-hd"><h2>${icon('coins', 18)}本賽段累計</h2></div><div class="cat-grid">${[...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, amt]) => `<div class="cat ${amt >= 0 ? 'pos' : 'neg'}"><span>${CATEGORY_NAME[k as keyof typeof CATEGORY_NAME] ?? k}</span>${signedCoin(amt)}</div>`)
      .join('') || '<p class="empty-note">還沒有帳</p>'}</div></section>
    <section class="panel"><button class="panel-hd btn-flat" data-act="ledger"><h2>${icon('contract', 18)}帳本明細（${ledger.length} 筆）</h2><span>${ui.ledgerOpen ? '收起' : '展開'}</span></button>
      ${ui.ledgerOpen ? `<div class="ledger">${ledger.map((x) => `<div class="lg-row"><span>${x.week === 0 ? '休賽期' : `第 ${x.week} 週`}</span><span>${CATEGORY_NAME[x.category]}</span><span>${esc(x.memo)}</span>${signedCoin(x.amount)}</div>`).join('')}</div>` : ''}</section>`;
}
