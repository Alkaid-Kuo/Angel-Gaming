// 基地：設計稿 A 的夜城。城市畫布常駐（city.ts），這裡只產生疊在上面的東西：
// 釘在地標上的 AR 標籤（顯示各設施的即時狀態）、競技場上空的比賽卡、屋頂上的我方名單／比賽日按鈕／對手情報。
import { anchorOf } from '../sketch/city.ts';
import { lineupOf, myFixture, publicRating, rankOf, teamForm } from '../club/model.ts';
import type { Ctx } from './kit.ts';
import { avatar, crestRing, esc, foeOf, glyph, slotName, teamName, wan, weekLabel } from './kit.ts';

function tag(id: string, side: 'L' | 'R', L: number, no: string, title: string, en: string, st: string, extra = ''): string {
  const a = anchorOf(id);
  return `<div class="tag ${side === 'R' ? 'R' : ''} ${extra}" data-at="${id}" data-act="go" data-to="${id === 'finance' ? 'finance' : id === 'market' ? 'market' : id === 'training' ? 'training' : id === 'league' ? 'league' : id === 'betting' ? 'betting' : 'squad'}" style="left:${a.x.toFixed(1)}px;top:${a.y.toFixed(1)}px;--k:${a.k.toFixed(3)};--L:${L}px"><i class="pin"></i><i class="stem"></i><div class="card"><span class="no">${no}</span><b>${title}</b><span class="en">${en}</span><span class="st">${st}</span></div></div>`;
}

/** 疊在城市上的標籤與比賽卡（放進城市的 .world 裡，跟著鏡頭飄） */
export function hubTags(ctx: Ctx): string {
  const { v, c } = ctx;
  const e = c.economy;
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const free = v.players.filter((p) => p.teamId === null).length;
  const scouting = v.jobs.filter((j) => j.kind === 'scout').length;
  const cap = e.scrimCapacity[v.me.trainingLevel - 1];
  const left = Math.max(0, v.me.capacityLeft);
  const row = v.standings.find((r) => r.teamId === v.me.teamId);
  const rank = rankOf(v, v.me.teamId);
  const open = v.fixtures.filter((f) => f.week === v.week && f.score === null).length;
  const foe = foeOf(v);
  const foeIntel = foe ? v.intel.filter((i) => ctx.pm.get(i.playerId)?.teamId === foe).length : 0;
  const wl = weekLabel(v);
  const f = myFixture(v);
  const title = v.phase === 'offseason' ? '季前準備' : v.phase === 'ended' ? '賽段落幕' : v.phase === 'bankrupt' ? '戰隊解散' : f ? '比賽日' : '觀戰週';
  const vs = f && foe ? `${esc(v.me.name)}<i>VS</i><em>${esc(teamName(v, foe))}</em>` : v.phase === 'offseason' ? '第 1 週開打前，先把戰隊整頓好' : v.phase === 'ended' ? `最終第 ${v.seasonResult?.humanRank ?? '?'} 名` : v.phase === 'bankrupt' ? '現金跌破零' : '本週沒有我方的比賽';
  const arena = anchorOf('arena');
  return `<div class="mcard" style="left:${arena.x.toFixed(1)}px;top:${arena.y.toFixed(1)}px"><i class="ln"></i><div class="bx">
      <div class="lb">MATCH DAY // ${wl.short} · 中央競技場</div><h1>${title}</h1><div class="vs">${vs}</div></div></div>
    ${tag('finance', 'L', 60, 'FINANCE', '財務', 'CASH FLOW', `<i>${net >= 0 ? '+' : '−'}${wan(Math.abs(net))}</i>萬／週`, v.me.runwayWeeks !== null && v.me.runwayWeeks < 3 ? 'warn' : '')}
    ${tag('market', 'R', 70, 'RECRUIT', '轉會市場', 'MARKET', `${scouting ? '<span class="new"></span>' : ''}<i>${free}</i>名自由球員${scouting ? ` · 球探 ${scouting}` : ''}`)}
    ${tag('training', 'L', 100, `LV${v.me.trainingLevel}`, '訓練基地', 'TRAINING', `<i>${left}</i>／${cap} 場可排`)}
    ${tag('league', 'L', 60, 'LEAGUE', '聯賽', 'STANDINGS', row && row.played > 0 ? `第 <i>${rank}</i> 名 · ${row.points} 分` : '尚未開賽')}
    ${tag('betting', 'R', 100, 'BETTING', '賭盤', 'ODDS', v.phase === 'season' ? `<i>${open}</i>場開盤 · 已押 ${v.bets.length} 注` : '賽季中開盤')}
    ${tag('rival', 'R', 70, foe ? 'TARGET' : 'RIVAL HQ', foe ? esc(teamName(v, foe)) : '對手總部', 'RIVAL HQ', foe ? `評分約 <i>${publicRating(ctx, foe)}</i> · 情報 ${foeIntel}` : '本週沒有對手', foe ? 'op' : 'idle')}`;
}

/** 屋頂上的三塊：我方出賽名單（人數依內容包）、比賽日按鈕、對手情報 */
export function hubPanels(ctx: Ctx, busy: boolean): string {
  const { v } = ctx;
  const lu = lineupOf(ctx);
  const f = myFixture(v);
  const foe = foeOf(v);
  const odds = f ? v.odds.find((o) => o.fixtureId === f.id) : undefined;
  const myOdds = odds && f ? (f.home === v.me.teamId ? odds.homeX100 : odds.awayX100) : null;
  const over = v.phase === 'ended' || v.phase === 'bankrupt';
  const wl = weekLabel(v);
  const n = ctx.c.lineupSize;
  const units = lu.ids
    .map((id, i) => {
      const p = ctx.pm.get(id);
      return `<div class="u">${avatar(ctx, p, n > 3 ? 52 : 74)}<div><span class="rl">${esc(slotName(ctx, i))}</span><b>${esc(p?.name ?? '未指定')}</b><span class="rt">${p?.elo ?? '—'}<small>${p ? glyph(p.lineageId, 13) : ''}</small></span></div></div>`;
    })
    .join('');
  const go = over
    ? `<button class="go" data-act="new-season"><b>新的賽季</b><span>NEW SEASON</span><span class="chev"><i></i><i></i><i></i></span></button>`
    : `<button class="go" data-act="advance" ${busy ? 'disabled' : ''}><b>${v.phase === 'offseason' ? '開幕' : '開戰'}</b><span>${v.phase === 'offseason' ? 'KICK OFF' : 'DEPLOY'}</span><span class="chev"><i></i><i></i><i></i></span></button>`;
  const cdLine = over ? (v.phase === 'bankrupt' ? '現金跌破零，戰隊解散' : '這個賽段結束了') : `${wl.long}${myOdds ? ` · 押我方贏 ×${(myOdds / 100).toFixed(2)}` : ''}`;
  const lock = over ? '帶著經驗開一支新的戰隊' : lu.auto ? `名單是自動的：評分最高的 ${n} 人` : '名單已排定 · 對手名單比賽日才公開';
  let target: string;
  if (foe) {
    const r = v.standings.find((x) => x.teamId === foe);
    const form = teamForm(v, foe).join('');
    target = `<section class="panel target"><div class="hd"><span class="no">TARGET</span><b>對手情報</b><span class="st">${myOdds ? `ODDS <b>×${(myOdds / 100).toFixed(2)}</b>` : ''}</span></div>
      <div class="tb">${crestRing(ctx, foe, 90)}<div><div class="nm">${esc(teamName(v, foe))}</div><div class="meta">評分約 <b>${publicRating(ctx, foe)}</b> · ${r ? `${r.wins} 勝 ${r.losses} 敗 · 第 ${rankOf(v, foe)} 名` : '尚未交手'}${form ? ` · 近況 ${form}` : ''}</div>
        <div class="slots">${'<i>?</i>'.repeat(n)}<em>名單加密中</em></div></div></div></section>`;
  } else {
    const top = v.standings.slice(0, 3);
    target = `<section class="panel target idle"><div class="hd"><span class="no">LEAGUE</span><b>${over ? '最終排名' : '聯賽前段'}</b></div>
      <div class="tb list">${top.map((r, i) => `<div class="tr"><span class="num">${i + 1}</span>${crestRing(ctx, r.teamId, 40)}<b>${esc(teamName(v, r.teamId))}</b><span class="num">${r.points}</span></div>`).join('')}</div></section>`;
  }
  return `<section class="panel squad n${n}" data-act="go" data-to="squad"><div class="hd"><span class="no">01</span><b>戰隊</b><span class="en">SQUAD</span><span class="st">${v.me.roster.length}／${ctx.c.economy.rosterMax} · ${lu.auto ? '名單自動' : '名單已排'}</span></div><div class="units">${units}</div></section>
    <div class="glowline"></div>
    <section class="deploy"><div class="cd"><span>${cdLine}</span></div>${go}<div class="lock">${lock}</div></section>
    ${target}`;
}
