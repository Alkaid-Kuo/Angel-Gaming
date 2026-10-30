// 聯賽（時間軸、積分榜、某週賽程、季後賽樹狀圖）、財務（現金與資金跑道、資金曲線、固定收支、累計、帳本）、信件。
import type { KnownFixture } from '../../manage/index.ts';
import { CATEGORY_NAME } from '../manage/format.ts';
import { cashSeries, rosterOf, startCash, teamForm } from '../club/model.ts';
import type { IconName } from '../club/art.ts';
import type { Ctx } from './kit.ts';
import { crest, esc, foeOf, head, icon, pt, teamName, wan } from './kit.ts';

// ───── 聯賽 ─────
const NODE = ['休', '1', '2', '3', '4', '5', '6', '7', '準', '決'];

function myResult(ctx: Ctx, w: number): string {
  const { v } = ctx;
  const f = v.fixtures.find((x) => x.week === w && (x.home === v.me.teamId || x.away === v.me.teamId));
  if (!f || !f.score) return '';
  const home = f.home === v.me.teamId;
  const a = home ? f.score.home : f.score.away;
  const b = home ? f.score.away : f.score.home;
  return `<span class="r ${a > b ? 'w' : 'l'}">${a > b ? 'W' : a < b ? 'L' : 'D'} ${a}:${b}</span>`;
}

function fixtureRow(ctx: Ctx, f: KnownFixture): string {
  const { v } = ctx;
  const me = v.me.teamId;
  const s = f.score;
  const won = (id: string): boolean => !!s && (f.home === id ? s.home > s.away : s.away > s.home);
  // 打完、賽制能觀戰（閘道自報）才有「觀戰」
  const watch = f.match?.watchable ? `<button class="wt" data-act="watch" data-f="${esc(f.id)}" title="用存檔的請求單重播這一場">${icon('play', 14)}<span>觀戰</span></button>` : '';
  return `<div class="mt ${f.home === me || f.away === me ? 'me' : ''} ${watch ? 'can-watch' : ''}"><span class="t ${won(f.home) ? 'wn' : s ? 'ls' : ''}">${crest(ctx, f.home, 28)}${esc(teamName(v, f.home))}</span>
    <span class="vs">${s ? `<b>${s.home}</b>:<b>${s.away}</b>` : 'VS'}</span>
    <span class="t r ${won(f.away) ? 'wn' : s ? 'ls' : ''}">${crest(ctx, f.away, 28)}${esc(teamName(v, f.away))}</span>${watch}</div>`;
}

export function leagueScreen(ctx: Ctx): string {
  const { v, ui } = ctx;
  const started = v.standings.some((r) => r.played > 0);
  const cur = v.phase === 'offseason' ? 0 : v.phase === 'season' ? v.week : 10;
  const weeks = [...new Set(v.fixtures.map((f) => f.week))].sort((a, b) => a - b);
  const sel = ui.leagueWeek ?? (v.phase === 'season' ? v.week : v.phase === 'offseason' ? 1 : weeks[weeks.length - 1]);
  const tl = NODE.map((n, i) => {
    const has = weeks.includes(i);
    return `<button class="wk ${i < cur ? 'past' : ''} ${i === cur ? 'cur' : ''} ${i === sel ? 'sel' : ''} ${i >= 8 || i === 0 ? 'po' : ''}" ${has ? `data-act="lweek" data-w="${i}"` : 'disabled'}><span class="hx">${n}</span>${i === cur && v.phase === 'season' ? '<span class="r w">本週</span>' : myResult(ctx, i) || `<span class="r l">${i === 8 ? '準決賽' : i === 9 ? '決賽' : ''}</span>`}</button>`;
  }).join('');
  const foe = foeOf(v);
  const rows = v.standings
    .map((r, i) => {
      const form = teamForm(v, r.teamId, 3).map((x) => `<i class="${x === 'W' ? 'w' : 'l'}">${x}</i>`).join('');
      const me = r.teamId === v.me.teamId;
      return `<div class="row ${me ? 'me' : ''} ${r.teamId === foe ? 'foe' : ''} ${i < 4 ? 'top4' : ''} ${i === 3 ? 'cut' : ''}"><span class="rk">${i + 1}</span>${crest(ctx, r.teamId, 30)}<span class="nm ${r.teamId === foe ? 'rd' : ''}">${esc(teamName(v, r.teamId))}${me ? '<small>我方</small>' : r.teamId === foe ? '<small>本週對手</small>' : ''}</span>
        <span class="num">${r.wins}-${r.draws}-${r.losses}</span><span class="num">${r.scoreDiff >= 0 ? '+' : '−'}${Math.abs(r.scoreDiff)}</span><span class="form">${form || '—'}</span><span class="num pts">${started ? r.points : '—'}</span></div>`;
    })
    .join('');
  const fx = v.fixtures.filter((f) => f.week === sel);
  const top = v.standings.slice(0, 4).map((r) => r.teamId);
  const semis = v.fixtures.filter((f) => f.stage === 'semi');
  const final = v.fixtures.find((f) => f.stage === 'final');
  const third = v.fixtures.find((f) => f.stage === 'third');
  const slot = (id: string | undefined, score: number | null, win: boolean, label: string, seed: string): string =>
    id ? `<div class="sl ${win ? 'wn' : ''} ${id === foe ? 'foe' : ''} ${id === v.me.teamId ? 'me' : ''}"><span class="sd">${seed}</span>${crest(ctx, id, 22)}${esc(teamName(v, id))}<b>${score ?? ''}</b></div>` : `<div class="sl tbd"><span class="sd"></span>${label}</div>`;
  const match = (f: KnownFixture | undefined, a: string | undefined, b: string | undefined, la: string, lb: string, sa = '', sb = ''): string => {
    const s = f?.score ?? null;
    return `${slot(f?.home ?? a, s ? s.home : null, !!s && s.home > s.away, la, sa)}${slot(f?.away ?? b, s ? s.away : null, !!s && s.away > s.home, lb, sb)}`;
  };
  const projected = semis.length === 0;
  const champ = v.seasonResult?.ranks[0];
  const myRank = v.standings.findIndex((r) => r.teamId === v.me.teamId) + 1;
  const myPts = v.standings.find((r) => r.teamId === v.me.teamId)?.points ?? 0;
  const fourth = v.standings[3]?.points ?? 0;
  const path = v.phase === 'ended' ? `最終第 <b>${v.seasonResult?.humanRank}</b> 名。` : myRank <= 4 ? `我方第 ${myRank}，目前在季後賽圈內。` : `我方第 ${myRank}，離第 4 差 <b>${Math.max(0, fourth - myPts)}</b> 分。`;
  return `${head('LEAGUE // 新創聯賽', '聯賽', `8 隊單循環 · 例行賽 7 週 · 前 <b>4</b> 名進季後賽 · 勝 3 分、平 1 分，同分比比分差（贏的回合 − 輸的回合）`)}
    <section class="body s-league">
      <div class="tl in">${tl}</div>
      <div class="pn tbl in">${pt('01', '積分榜', started ? `第 ${Math.min(7, v.phase === 'season' ? v.week - 1 : 7)} 週後` : '尚未開賽', 'STANDINGS')}
        <div class="rows"><div class="row hd"><span>#</span><span></span><span>戰隊</span><span>勝-平-敗</span><span>比分差</span><span>近況</span><span style="text-align:right">積分</span></div>${rows}</div>
        <div class="note"><span>虛線以上進季後賽</span><span>名次獎金 1 名 ${wan(ctx.c.economy.seasonPrizes[0])} 萬 … 8 名 ${wan(ctx.c.economy.seasonPrizes[7])} 萬</span></div></div>
      <div class="pn wkm in">${pt('02', '賽程', sel === 0 ? '休賽期' : sel <= 7 ? `第 ${sel} 週` : sel === 8 ? '準決賽' : '決賽', `W${String(sel).padStart(2, '0')}`)}
        <div class="scroll">${fx.map((f) => fixtureRow(ctx, f)).join('') || '<p class="dim">這週還沒有對戰組合。</p>'}</div></div>
      <div class="pn br in">${pt('03', '季後賽', projected ? '如果今天結束（預測）' : '第 8 週準決賽、第 9 週決賽與季軍戰', 'PLAYOFFS')}
        <div class="bk"><svg class="lines" viewBox="0 0 700 214"><path d="M250 44 H300 V122 H350 M250 160 H300 V122" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="2"/></svg>
          <div class="m" style="left:0;top:0"><div class="lb">準決賽 · W08</div>${match(semis[0], top[0], top[3], '第 1 名', '第 4 名', '1', '4')}</div>
          <div class="m" style="left:0;top:118px"><div class="lb">準決賽 · W08</div>${match(semis[1], top[1], top[2], '第 2 名', '第 3 名', '2', '3')}</div>
          <div class="m" style="left:350px;top:10px"><div class="lb">決賽 · W09</div>${match(final, undefined, undefined, '準決賽勝方', '準決賽勝方')}</div>
          <div class="m" style="left:350px;top:118px"><div class="lb">季軍戰 · W09</div>${match(third, undefined, undefined, '準決賽敗方', '準決賽敗方')}</div>
          <div class="cup">${champ ? crest(ctx, champ, 56) : icon('trophy', 52)}<b>${champ ? esc(teamName(v, champ)) : 'CHAMPION'}</b><small>冠軍 ${wan(ctx.c.economy.seasonPrizes[0])} 萬</small></div></div>
        <div class="path">${path}</div></div>
    </section>`;
}

// ───── 財務 ─────
function chart(ctx: Ctx): string {
  const { v } = ctx;
  const s = cashSeries(v);
  const W = 1110;
  const H = 300;
  const x0 = 70;
  const step = (W - x0 - 20) / 10;
  const start = startCash(v);
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const lastW = s.length ? s[s.length - 1].week : -1;
  const lastCash = s.length ? s[s.length - 1].cash : start;
  const proj: { week: number; cash: number }[] = [];
  if (v.phase === 'season' || v.phase === 'offseason') for (let w = lastW + 1, c = lastCash; w <= 9; w++) proj.push({ week: w, cash: (c += net) });
  const all = [start, ...s.map((x) => x.cash), ...proj.map((x) => x.cash)];
  const hi = Math.max(...all, 10);
  const lo = Math.min(0, ...all);
  const maxNet = Math.max(1, ...s.map((x) => Math.abs(x.net)));
  const top = 20;
  const zero = 220;
  const y = (c: number): number => zero - ((c - Math.max(0, lo)) / (hi - Math.max(0, lo) || 1)) * (zero - top) + (c < 0 ? 0 : 0);
  const yc = (c: number): number => (c >= 0 ? y(c) : zero + (-c / (hi || 1)) * (zero - top));
  const xw = (w: number): number => x0 + step * (w + 0.5);
  const grid = [hi, hi / 2].map((g) => `<line x1="${x0}" y1="${yc(g).toFixed(1)}" x2="${W}" y2="${yc(g).toFixed(1)}"/>`).join('');
  const glab = [hi, hi / 2].map((g) => `<text x="0" y="${(yc(g) + 4).toFixed(1)}">${wan(Math.round(g))}</text>`).join('');
  const bars = s
    .map((x) => {
      const h = (Math.abs(x.net) / maxNet) * 40;
      return `<rect x="${(xw(x.week) - 17).toFixed(1)}" y="${x.net >= 0 ? (zero - h).toFixed(1) : zero}" width="34" height="${Math.max(1.5, h).toFixed(1)}" fill="${x.net >= 0 ? '#eef2f6' : '#ff5d5d'}" opacity=".8"/><text class="nl ${x.net >= 0 ? 'p' : 'n'}" x="${xw(x.week).toFixed(1)}" y="${x.net >= 0 ? (zero - h - 6).toFixed(1) : (zero + h + 16).toFixed(1)}" text-anchor="middle">${x.net >= 0 ? '+' : '−'}${wan(Math.abs(x.net))}</text>`;
    })
    .join('');
  const pts = s.map((x) => `${xw(x.week).toFixed(1)} ${yc(x.cash).toFixed(1)}`);
  const line = pts.length ? `<path d="M${pts.join(' L')} L${xw(lastW).toFixed(1)} ${zero} L${xw(s[0].week).toFixed(1)} ${zero} Z" fill="rgba(240,181,74,.08)"/><path d="M${pts.join(' L')}" fill="none" stroke="#f0b54a" stroke-width="3.5"/>` : '';
  const pl = proj.length && pts.length ? `<path d="M${pts[pts.length - 1]} L${proj.map((x) => `${xw(x.week).toFixed(1)} ${yc(x.cash).toFixed(1)}`).join(' L')}" fill="none" stroke="#f0b54a" stroke-width="2.5" stroke-dasharray="8 8" opacity=".55"/>` : '';
  const dots = s.map((x, i) => `<circle cx="${xw(x.week).toFixed(1)}" cy="${yc(x.cash).toFixed(1)}" r="${i === s.length - 1 ? 7 : 5}" ${i === s.length - 1 ? 'fill="#f0b54a"' : ''}/>`).join('');
  const vals = s.map((x) => `<text x="${xw(x.week).toFixed(1)}" y="${(yc(x.cash) - 14).toFixed(1)}" text-anchor="middle">${wan(x.cash)}</text>`).join('');
  const pend = proj.length ? `<text x="${xw(proj[proj.length - 1].week).toFixed(1)}" y="${(yc(proj[proj.length - 1].cash) - 14).toFixed(1)}" text-anchor="middle" fill="${proj[proj.length - 1].cash < 0 ? '#ffa3a3' : '#ffd98a'}" opacity=".85">${wan(proj[proj.length - 1].cash)}</text>` : '';
  const labs = NODE.map((n, i) => `<text x="${xw(i).toFixed(1)}" y="296" text-anchor="middle" ${i === lastW + 1 && v.phase === 'season' ? 'fill="#f0b54a"' : ''}>${i === 0 ? '休' : i <= 7 ? `W${i}` : n}</text>`).join('');
  return `<svg class="chart" width="${W}" height="${H + 10}" viewBox="0 0 ${W} ${H + 10}">
    <g stroke="rgba(255,255,255,.07)">${grid}</g><line x1="${x0}" y1="${zero}" x2="${W}" y2="${zero}" stroke="rgba(255,93,93,.5)" stroke-dasharray="4 6"/>
    <g class="gl">${glab}<text x="0" y="${zero + 4}" fill="#ff5d5d">0</text></g><g class="xl">${labs}</g>
    <g>${bars}</g>${line}${pl}<g fill="#0b0e14" stroke="#ffd98a" stroke-width="2.5">${dots}</g><g class="vl">${vals}${pend}</g></svg>`;
}

export function financeScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const runway = v.me.runwayWeeks;
  const salaries = rosterOf(ctx, v.me.teamId).sort((a, b) => b.weeklySalary - a.weeklySalary);
  const maint = e.facilityMaintenance[v.me.trainingLevel - 1];
  const maxItem = Math.max(v.me.weeklySponsor, ...salaries.map((p) => p.weeklySalary), maint, 1);
  const fx = (label: string, k: number, inc: boolean): string => `<div class="fx"><span>${label}</span><span class="bar" style="background:linear-gradient(90deg,${inc ? '#eef2f6' : '#ff5d5d'} 0 ${Math.round((k / maxItem) * 100)}%,transparent 0)"></span><span class="num">${inc ? '+' : '−'}${wan(k)}</span></div>`;
  const totals = new Map<string, number>();
  for (const x of v.ledger) totals.set(x.category, (totals.get(x.category) ?? 0) + x.amount);
  const sum = [...totals.values()].reduce((s, x) => s + x, 0);
  const maxCat = Math.max(1, ...[...totals.values()].map((x) => Math.abs(x)));
  const cats = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const ledger = [...v.ledger].reverse().slice(0, ui.ledgerOpen ? 60 : 9);
  const L = 402;
  const frac = runway === null ? 1 : Math.min(1, runway / 12);
  const lowZone = (2 / 12) * L;
  return `${head('FINANCE // 財務', '財務', `起始資金 <b>${wan(startCash(v))}</b> 萬 · 週結算後現金小於 0 就破產 · 金額單位：萬`)}
    <section class="body s-finance">
      <div class="pn g cash in">${pt('01', '現金', v.week === 0 ? '休賽期' : `第 ${v.phase === 'season' ? v.week - 1 : v.week} 週結算後`, 'CASH')}
        <div class="big"><span class="num ${v.me.cash < 0 ? 'rd' : ''}">${wan(v.me.cash)}</span><em>萬</em></div>
        <div class="dl ${net >= 0 ? 'up' : ''}">${net >= 0 ? '▲' : '▼'} 每週固定淨額 ${net >= 0 ? '+' : '−'}${wan(Math.abs(net))} 萬</div>
        <div class="rw"><div class="gauge2"><svg viewBox="0 0 150 150"><circle cx="75" cy="75" r="64" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="12"/><circle cx="75" cy="75" r="64" fill="none" stroke="#ff5d5d" stroke-width="12" stroke-dasharray="0 ${(L - lowZone).toFixed(1)} ${lowZone.toFixed(1)} ${L}" opacity=".45" transform="rotate(-90 75 75)"/><circle cx="75" cy="75" r="64" fill="none" stroke="${runway !== null && runway < 3 ? '#ff5d5d' : '#f0b54a'}" stroke-width="12" stroke-dasharray="${(frac * L).toFixed(1)} ${L}" transform="rotate(-90 75 75)"/><circle cx="75" cy="75" r="64" fill="none" stroke="#0b0e14" stroke-width="14" stroke-dasharray="2 31.5"/></svg>
          <div class="v"><span class="num">${runway === null ? '∞' : runway}</span><small>WEEKS</small></div></div>
          <p>${runway === null ? '贊助養得起固定支出，<b>不會因為薪水破產</b>。' : `資金跑道 <b>${runway} 週</b>：照目前速度，第 <span class="rd">${Math.min(99, (v.phase === 'season' ? v.week : 0) + runway + 1)}</span> 週左右現金歸零。`}<br>賽段在第 9 週結束，名次獎金會先發再檢查。<br>紅色區＝剩 2 週以內。</p></div></div>
      <div class="pn chartp in">${pt('02', '資金曲線', '<span class="lg"><span><i style="background:#f0b54a"></i>週末現金</span><span><i class="dash"></i>照目前速度推估</span><span><i style="background:#eef2f6"></i>當週淨額＋</span><span><i style="background:#ff5d5d"></i>當週淨額−</span></span>', 'CASH FLOW')}${cashSeries(v).length ? chart(ctx) : '<p class="dim big">打完休賽期後，這裡會畫出每週的現金。</p>'}</div>
      <div class="pn fix in">${pt('03', '每週固定收支', '不含比賽收入與下注')}
        ${fx(`贊助 · 名氣 ${v.me.fame}`, v.me.weeklySponsor, true)}${salaries.map((p) => fx(`${esc(p.name)} 週薪`, p.weeklySalary, false)).join('')}${fx(`訓練中心 Lv${v.me.trainingLevel}`, maint, false)}
        <div class="fx tot"><span>淨額</span><span></span><span class="num ${net < 0 ? 'rd' : 'gd2'}">${net >= 0 ? '+' : '−'}${wan(Math.abs(net))}</span></div></div>
      <div class="pn cat in">${pt('04', '本賽段累計', `淨 <b class="num ${sum < 0 ? 'rd' : 'gd2'}">${sum >= 0 ? '+' : '−'}${wan(Math.abs(sum))}</b>`)}
        ${cats.length ? cats.map(([k, amt]) => `<div class="ct"><span>${CATEGORY_NAME[k as keyof typeof CATEGORY_NAME] ?? k}</span><span class="two"><i class="${amt >= 0 ? 'p' : 'n'}" style="width:${Math.round((Math.abs(amt) / maxCat) * 48)}%"></i></span><span class="num ${amt < 0 ? 'rd' : ''}">${amt >= 0 ? '+' : '−'}${wan(Math.abs(amt))}</span></div>`).join('') : '<p class="dim">還沒有帳。</p>'}</div>
      <div class="pn led in">${pt('05', '帳本', `<button class="lnk" data-act="ledger">${ui.ledgerOpen ? '收起' : `全部 ${v.ledger.length} 筆`}</button>`, 'LEDGER')}
        <div class="rows scroll">${ledger.map((x) => `<div class="row"><span class="wk">${x.week === 0 ? '休' : `W${String(x.week).padStart(2, '0')}`}</span><span>${esc(x.memo || CATEGORY_NAME[x.category])}</span><span class="num ${x.amount < 0 ? 'rd' : ''}">${x.amount >= 0 ? '+' : '−'}${wan(Math.abs(x.amount))}</span></div>`).join('') || '<p class="dim">還沒有帳。</p>'}</div></div>
    </section>`;
}

// ───── 信件 ─────
const MSG: Record<string, { ic: IconName; name: string; cls: string }> = {
  result: { ic: 'swords', name: '戰報', cls: '' },
  finance: { ic: 'coins', name: '財務', cls: '' },
  report: { ic: 'flask', name: '報告', cls: 'g' },
  system: { ic: 'info', name: '公告', cls: '' },
};

/** 核心寫的信件金額是千元（例如「現金 1216」），畫面統一換成萬 */
function mailText(text: string): string {
  return esc(text).replace(/(淨收支 |現金 )([+-]?)(\d+)/g, (_m, k: string, sign: string, n: string) => `${k}${sign}${wan(Number(n))} 萬`);
}

export function inboxScreen(ctx: Ctx, seen: number): string {
  const { v, ui } = ctx;
  const msgs = v.inbox.map((m, i) => ({ ...m, i, unread: i >= seen })).reverse();
  const unread = msgs.filter((m) => m.unread).length;
  const sel = ui.mailSel !== null && v.inbox[ui.mailSel] ? ui.mailSel : msgs[0]?.i ?? null;
  const open = sel !== null ? v.inbox[sel] : null;
  const k = open ? (MSG[open.kind] ?? MSG.system) : MSG.system;
  const go = open?.kind === 'report' ? `<button class="btn" data-act="go" data-to="training"><b>去訓練基地</b></button><button class="btn ghost" data-act="go" data-to="market"><b>去轉會市場</b></button>` : open?.kind === 'result' ? `<button class="btn ghost" data-act="go" data-to="league"><b>看聯賽</b></button>` : open?.kind === 'finance' ? `<button class="btn ghost" data-act="go" data-to="finance"><b>看財務</b></button>` : '';
  return `${head('INBOX // 信件', '信件', `${unread ? `未讀 <b>${unread}</b> · ` : ''}共 ${msgs.length} 封 · 球探、練習賽、研發的報告在推進一週後寄到`)}
    <section class="body s-inbox">
      <div class="pn list in">${pt('01', '收件匣', `${msgs.length} 封`)}<div class="scroll">${msgs.map((m) => { const q = MSG[m.kind] ?? MSG.system; return `<button class="msg ${m.i === sel ? 'on' : ''} ${m.unread ? 'unread' : 'read'}" data-act="mail" data-i="${m.i}"><span class="ic2 ${q.cls}">${icon(q.ic, 24)}</span><b>${q.name}</b><span class="wk">${m.week === 0 ? '休' : `W${String(m.week).padStart(2, '0')}`}</span><p>${mailText(m.text)}</p></button>`; }).join('') || '<p class="dim">信箱是空的。</p>'}</div></div>
      <div class="pn ${open?.kind === 'report' ? 'g' : ''} open in">${open ? `<div class="meta">${sel !== null && sel >= seen ? '<span class="chip fill">NEW</span>' : ''}<span class="chip ${k.cls}">${k.name}</span><span class="chip">${open.week === 0 ? '休賽期' : `第 ${open.week} 週`}</span></div>
        <div class="txt">${mailText(open.text)}</div><div class="wm">${icon(k.ic, 260, 0.8)}</div><div class="acts">${go}</div>` : '<p class="dim big">沒有信。</p>'}</div>
    </section>`;
}

