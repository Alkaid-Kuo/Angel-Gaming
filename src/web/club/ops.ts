// 訓練基地（設施、練習賽、戰術研發、報告）與賭盤（下注單）。
import { esc, lineageName, wan } from '../manage/format.ts';
import { icon, lineageColor, lineageGlyph } from './art.ts';
import { coin, crest, screenHead } from './cards.ts';
import type { Ctx } from './model.ts';
import { publicRating, rosterOf, teamName } from './model.ts';

const canAct = (ctx: Ctx): boolean => ctx.v.phase === 'offseason' || ctx.v.phase === 'season';

function facilityArt(level: number): string {
  const floors = [0, 1, 2]
    .map((i) => {
      const y = 78 - i * 22;
      const lit = i < level;
      const win = [0, 1, 2, 3]
        .map((k) => `<rect x="${38 + k * 22}" y="${y + 6}" width="12" height="9" rx="1.5" fill="${lit ? '#fde68a' : '#1e293b'}" ${lit ? 'filter="url(#fg)"' : ''}/>`)
        .join('');
      return `<rect x="30" y="${y}" width="100" height="22" fill="${lit ? '#334155' : '#1a2233'}" stroke="#0b1220" stroke-width="1.5"/>${win}`;
    })
    .join('');
  return `<svg class="fac-art" viewBox="0 0 160 112" aria-hidden="true"><defs><filter id="fg"><feGaussianBlur stdDeviation="1.6"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <rect x="0" y="100" width="160" height="12" fill="#0f172a"/><path d="M20 100 H140" stroke="#38bdf8" stroke-opacity=".5"/>
    ${floors}<path d="M26 34 H134 L124 26 H36 Z" fill="${level >= 3 ? '#a78bfa' : '#475569'}"/>
    <path d="M80 26 V10" stroke="#94a3b8" stroke-width="2"/><path d="M80 10 L93 14 L80 18" fill="${level >= 2 ? '#22d3ee' : '#64748b'}"/>
    <rect x="62" y="88" width="36" height="12" rx="2" fill="#0ea5e9" fill-opacity=".25" stroke="#38bdf8"/><text x="80" y="97" font-size="7" fill="#e0f2fe" text-anchor="middle" font-weight="700">TRAINING</text></svg>`;
}

export function trainingScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const lvl = v.me.trainingLevel;
  const cap = e.scrimCapacity[lvl - 1];
  const left = Math.max(0, v.me.capacityLeft);
  const used = cap - left;
  const maxLvl = e.facilityMaintenance.length;
  const active = canAct(ctx);
  const mine = rosterOf(ctx, v.me.teamId);
  const segs = 12;
  const bar = Array.from({ length: segs }, (_, i) => `<i class="${i < Math.round((used / cap) * segs) ? 'used' : ''}"></i>`).join('');
  const upCost = lvl < maxLvl ? e.facilityUpgradeCost[lvl - 1] : 0;
  const myOpts = (sel: string): string => mine.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}（${lineageName(c, p.lineageId)} v${p.version}・評分 ${p.elo}）</option>`).join('');
  const oppOpts = v.teams
    .filter((t) => t.id !== v.me.teamId)
    .map(
      (t) => `<optgroup label="${esc(t.name)}">${rosterOf(ctx, t.id)
        .map((p) => `<option value="${p.id}" ${p.id === ui.scrim.opponentId ? 'selected' : ''}>${esc(p.name)}（${lineageName(c, p.lineageId)} v${p.version}・評分 ${p.elo}）</option>`)
        .join('')}</optgroup>`,
    )
    .join('');
  const freeOpts = v.players.filter((p) => p.teamId === null);
  const oppAll = `${oppOpts}${freeOpts.length ? `<optgroup label="自由球員">${freeOpts.map((p) => `<option value="${p.id}" ${p.id === ui.scrim.opponentId ? 'selected' : ''}>${esc(p.name)}（${lineageName(c, p.lineageId)} v${p.version}）</option>`).join('')}</optgroup>` : ''}`;
  const slider = (field: string, val: number): string =>
    `<div class="range"><input type="range" min="10" max="${Math.max(10, left)}" step="10" value="${Math.min(val, Math.max(10, left))}" data-field="${field}" ${left < 10 ? 'disabled' : ''}><output data-out="${field}">${Math.min(val, Math.max(10, left))}</output><span>場</span></div>`;
  const targets = [{ id: 'generic', name: '泛用', color: '#e2e8f0' }, ...c.lineages.map((l) => ({ id: l.id, name: `剋${l.name}`, color: lineageColor(l.id) }))];
  const queue = v.jobs.map((j) => {
    const p = ctx.pm.get(j.playerId);
    const who = esc(p?.name ?? '?');
    if (j.kind === 'scout') return `<li>${icon('search', 16)}<span>球探出發：<b>${who}</b>（${esc(teamName(ctx, p?.teamId ?? null))}）</span></li>`;
    if (j.kind === 'scrim') return `<li>${icon('swords', 16)}<span>練習賽：<b>${who}</b> 對 ${esc(ctx.pm.get(j.opponentId)?.name ?? '?')}</span><em>${j.games} 場</em></li>`;
    return `<li>${icon('flask', 16)}<span>研發：<b>${who}</b> 的${j.target === 'generic' ? '泛用' : `剋${lineageName(c, j.target)}`}戰術</span><em>${j.games} 場</em></li>`;
  });
  const scrims = [...v.scrims].reverse().slice(0, 6);
  const presets = v.presets;
  const intel = [...v.intel].reverse().slice(0, 8);
  const ci = (w: number, n: number): number => Math.round(196 * Math.sqrt(((w / n) * (1 - w / n)) / n));
  return `${screenHead('訓練基地', 'target', `訓練中心 Lv${lvl}・本週可跑 ${cap} 場（練習賽與研發共用）`)}
    <section class="panel fac">${facilityArt(lvl)}
      <div class="fac-info"><div class="fac-lv">${[1, 2, 3].map((i) => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('')}<b>Lv${lvl}</b></div>
        <div class="energy">${bar}</div><p>本週已排 <b>${used}</b> 場，還剩 <b>${left}</b> 場。維護費每週 ${coin(e.facilityMaintenance[lvl - 1])}</p>
        ${lvl < maxLvl ? `<button class="btn-sub" data-act="upfac" ${!active || v.me.cash < upCost ? 'disabled' : ''}>${icon('levelup', 16)}升級到 Lv${lvl + 1}　${wan(upCost)} 萬<small>（每週 ${e.scrimCapacity[lvl]} 場，維護 ${wan(e.facilityMaintenance[lvl])} 萬）</small></button>` : '<span class="chip">已是最高等級</span>'}</div></section>
    <div class="two-col">
      <section class="panel"><div class="panel-hd"><h2>${icon('swords', 18)}練習賽</h2><span>拿自己的選手對別人打大量模擬，估真實勝率</span></div>
        <label class="fld"><span>我方</span><select data-field="scrim.playerId">${myOpts(ui.scrim.playerId)}</select></label>
        <label class="fld"><span>對手</span><select data-field="scrim.opponentId">${oppAll}</select></label>
        <label class="fld"><span>場數</span>${slider('scrim.games', ui.scrim.games)}</label>
        <button class="btn-main" data-act="scrim" ${!active || left < 10 ? 'disabled' : ''}>${icon('play', 16)}排入練習賽</button>
        <p class="fine">場數越多，勝率估計的誤差越小。報告在推進一週後出爐。</p></section>
      <section class="panel"><div class="panel-hd"><h2>${icon('flask', 18)}戰術研發</h2><span>找出更好的戰術預設，賽前自動套用</span></div>
        <label class="fld"><span>選手</span><select data-field="research.playerId">${myOpts(ui.research.playerId)}</select></label>
        <div class="fld"><span>目標</span><div class="chips">${targets
          .map((t) => `<button class="chip pick ${ui.research.target === t.id ? 'on' : ''}" style="--lc:${t.color}" data-act="target" data-t="${t.id}">${t.id === 'generic' ? icon('star', 13) : lineageGlyph(t.id, 13)}${t.name}</button>`)
          .join('')}</div></div>
        <label class="fld"><span>場數</span>${slider('research.games', ui.research.games)}</label>
        <button class="btn-main" data-act="research" ${!active || left < 10 ? 'disabled' : ''}>${icon('play', 16)}排入研發</button>
        <p class="fine">泛用的加成小；剋某流派的加成大，但只在遇到那個流派時有效。選手升版後預設失效。</p></section>
    </div>
    <section class="panel"><div class="panel-hd"><h2>${icon('hourglass', 18)}本週排程</h2><span>推進到下一週時一起完成</span></div>
      ${queue.length ? `<ul class="queue">${queue.join('')}</ul>` : '<p class="empty-note">還沒有排任何工作。</p>'}</section>
    <div class="three-col">
      <section class="panel report"><h3>${icon('swords', 16)}練習賽報告</h3>${scrims.length ? scrims.map((s) => `<div class="rp"><b>${esc(ctx.pm.get(s.playerId)?.name ?? '?')}</b> 對 ${esc(ctx.pm.get(s.opponentId)?.name ?? '?')}<div class="rp-bar"><i style="width:${Math.round((s.wins * 100) / s.games)}%"></i></div><span>${s.wins}/${s.games} 勝・<b>${Math.round((s.wins * 100) / s.games)}%</b> ±${ci(s.wins, s.games)}%</span></div>`).join('') : '<p class="empty-note">還沒有報告</p>'}</section>
      <section class="panel report"><h3>${icon('flask', 16)}戰術預設</h3>${presets.length ? presets.map((x) => `<div class="rp ${x.valid ? '' : 'off'}"><b>${esc(ctx.pm.get(x.playerId)?.name ?? '?')}</b>・${x.target === 'generic' ? '泛用' : `剋${lineageName(c, x.target)}`}<span>估計加成 <b>+${x.reportedBonus}</b>${x.valid ? '' : '（升版後失效）'}</span></div>`).join('') : '<p class="empty-note">還沒有預設</p>'}</section>
      <section class="panel report"><h3>${icon('search', 16)}球探情報</h3>${intel.length ? intel.map((i) => { const p = ctx.pm.get(i.playerId); const d = p ? i.estPower - p.elo : 0; return `<div class="rp"><b>${esc(p?.name ?? '?')}</b>（${esc(teamName(ctx, p?.teamId ?? null))}）<span>真實強度約 <b>${i.estPower}</b> ±${i.sd}・<i class="${d >= 0 ? 'up' : 'dn'}">比評分${d >= 0 ? '高' : '低'} ${Math.abs(d)}</i></span></div>`; }).join('') : '<p class="empty-note">到轉會市場派球探</p>'}</section>
    </div>`;
}

export function bettingScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const head = screenHead('賭盤', 'ticket', `莊家抽成 ${e.betMarginPermille / 10}%・賠率只看公開評分`);
  if (v.phase !== 'season') return `${head}<section class="panel tip-panel">${icon('info', 18)}<p>賽季開始後才開盤。</p></section>`;
  const limit = e.betLimitBase + e.betLimitPerFame * v.me.fame;
  const open = v.fixtures.filter((f) => f.week === v.week && f.score === null);
  const rows = open
    .map((f) => {
      const o = v.odds.find((x) => x.fixtureId === f.id);
      const mine = f.home === v.me.teamId || f.away === v.me.teamId;
      const staked = v.bets.filter((b) => b.fixtureId === f.id).reduce((s, b) => s + b.stake, 0);
      const sel = (side: string): string => (ui.slip?.fixtureId === f.id && ui.slip.side === side ? 'on' : '');
      const dis = (team: string): string => (!o || (mine && team !== v.me.teamId) || staked >= limit ? 'disabled' : '');
      return `<div class="bet-row ${mine ? 'mine' : ''}">
        <div class="br-team">${crest(ctx, f.home, 40)}<div><b>${esc(teamName(ctx, f.home))}</b><span>戰力 ${publicRating(ctx, f.home)}</span></div></div>
        <button class="odd ${sel('home')}" data-act="slip" data-fid="${f.id}" data-side="home" ${dis(f.home)}><span>主勝</span><b>${o ? (o.homeX100 / 100).toFixed(2) : '—'}</b></button>
        <span class="br-vs">VS</span>
        <button class="odd ${sel('away')}" data-act="slip" data-fid="${f.id}" data-side="away" ${dis(f.away)}><span>客勝</span><b>${o ? (o.awayX100 / 100).toFixed(2) : '—'}</b></button>
        <div class="br-team right"><div><b>${esc(teamName(ctx, f.away))}</b><span>戰力 ${publicRating(ctx, f.away)}</span></div>${crest(ctx, f.away, 40)}</div>
        <div class="br-meta">${mine ? '<b class="hl">你的比賽・只能押自己</b>　' : ''}本場已押 ${wan(staked)} / 上限 ${wan(limit)} 萬</div></div>`;
    })
    .join('');
  let slip = `<div class="slip empty">${icon('ticket', 34, 1.4)}<p>點選賠率加入下注單</p></div>`;
  if (ui.slip) {
    const f = v.fixtures.find((x) => x.id === ui.slip?.fixtureId);
    const o = f ? v.odds.find((x) => x.fixtureId === f.id) : undefined;
    if (f && o) {
      const team = ui.slip.side === 'home' ? f.home : f.away;
      const odds = ui.slip.side === 'home' ? o.homeX100 : o.awayX100;
      const staked = v.bets.filter((b) => b.fixtureId === f.id).reduce((s, b) => s + b.stake, 0);
      const maxStake = Math.floor(Math.min(limit - staked, v.me.cash) / 10);
      const stake = Math.max(0, Math.min(ui.slip.stake, maxStake));
      slip = `<div class="slip"><div class="slip-hd">${icon('ticket', 18)}下注單</div>
        <div class="slip-pick">${crest(ctx, team, 44)}<div><b>${esc(teamName(ctx, team))} 勝</b><span>賠率 ×${(odds / 100).toFixed(2)}</span></div></div>
        <div class="stake"><input type="number" min="1" max="${maxStake}" value="${stake}" data-field="slip.stake"><span>萬</span></div>
        <div class="stake-chips">${[1, 5, 10].map((n) => `<button class="chip" data-act="stake-add" data-n="${n}">+${n}</button>`).join('')}<button class="chip" data-act="stake-max">上限 ${maxStake}</button><button class="chip" data-act="stake-clear">清除</button></div>
        <div class="slip-pay"><span>押中可得</span><b data-out="slip.pay">${wan(Math.floor((stake * 10 * odds) / 100))}</b><small>萬</small></div>
        <button class="btn-main glow" data-act="place-bet" ${stake < Math.ceil(e.betMin / 10) ? 'disabled' : ''}>${icon('check', 16)}確定下注</button>
        <button class="btn-link" data-act="slip-clear">取消</button></div>`;
    }
  }
  const tickets = v.bets
    .map((b) => {
      const f = v.fixtures.find((x) => x.id === b.fixtureId);
      if (!f) return '';
      const team = b.side === 'home' ? f.home : f.away;
      return `<div class="tk">${crest(ctx, team, 26)}<div><b>${esc(teamName(ctx, team))} 勝</b><span>${wan(b.stake)} 萬 × ${(b.oddsX100 / 100).toFixed(2)}</span></div><em>${coin(Math.floor((b.stake * b.oddsX100) / 100))}</em></div>`;
    })
    .join('');
  return `${head}
    <div class="bet-layout"><div class="bet-board">${rows || '<p class="empty-note">本週沒有可押的比賽。</p>'}
      <p class="fine">賠率由公開評分算出，結果有隨機性，長期亂押必虧。想贏莊家要靠情報——你比公開評分知道得更多的時候。單場上限隨名氣提高。</p></div>
      <aside class="bet-side">${slip}<div class="tickets"><h3>${icon('ticket', 16)}本週彩券</h3>${tickets || '<p class="empty-note">還沒下注</p>'}</div></aside></div>`;
}
