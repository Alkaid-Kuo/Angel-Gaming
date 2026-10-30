// 戰隊（出賽名單 N 張卡＋陣容表＋本週對手）、選手詳情（王牌鏡頭＋版本線＋出賽紀錄＋戰術預設＋合約）、轉會市場。
// 名單人數與出賽位名稱來自內容包（軍團戰暫代包 3 人：先鋒、中堅、大將；攻防戰 5 人：1～5 號位）。
import type { KnownPlayer } from '../../manage/index.ts';
import { lineageName } from '../manage/format.ts';
import { lineupOf, maxVersionOf, myFixture, playerRecords, publicRating, rankOf, rosterOf, teamForm } from '../club/model.ts';
import { avatarSvg } from '../club/art.ts';
import type { Ctx } from './kit.ts';
import { avatar, btn, canAct, crest, crestRing, esc, foeOf, head, icon, intelNote, lineage, pcard, pt, slotEn, slotName, teamName, tierName, wan } from './kit.ts';

// ───── 戰隊 ─────
export function squadScreen(ctx: Ctx): string {
  const { v, ui, c } = ctx;
  const n = c.lineupSize;
  const lu = lineupOf(ctx);
  const recs = playerRecords(v);
  const active = canAct(v);
  const foe = foeOf(v);
  const f = myFixture(v);
  const mine = rosterOf(ctx, v.me.teamId).sort((a, b) => {
    const sa = lu.ids.indexOf(a.id);
    const sb = lu.ids.indexOf(b.id);
    return (sa < 0 ? 9 : sa) - (sb < 0 ? 9 : sb) || b.elo - a.elo;
  });
  const cards = lu.ids
    .map((id, i) => {
      const p = ctx.pm.get(id);
      const r = recs.get(id) ?? { w: 0, l: 0 };
      const card = p
        ? pcard(ctx, p, { act: 'pick-slot', sel: ui.pickSlot === i || !lu.auto, sub: `<span class="num">${r.w}-${r.l}</span> <small>W-L</small>` }).replace('data-act="pick-slot"', `data-act="pick-slot" data-slot="${i}"`)
        : `<div class="pc empty" data-act="pick-slot" data-slot="${i}">空位</div>`;
      return `<div class="ls s${i + 1} ${ui.pickSlot === i ? 'picking' : ''}" data-drop-slot="${i}"><div class="lb"><span class="num">0${i + 1}</span><b>${esc(slotName(ctx, i))}</b><span>${slotEn(ctx, i)}</span></div>${card}
        <div class="vsr"><span>${p ? esc(lineageName(c, p.lineageId)) : '流派'}</span><b>${p ? `v${p.version}` : '—'}</b></div></div>`;
    })
    .join('');
  const hint =
    !active
      ? '賽段已結束，名單不能再改。'
      : ui.pickSlot !== null
        ? `<b class="gd2">點右邊陣容的一位選手，放到「${esc(slotName(ctx, ui.pickSlot))}」</b>　<button class="lnk" data-act="pick-slot" data-slot="-1">取消</button>`
        : `${lu.auto ? `<b class="gd2">目前是自動名單（評分最高的 ${n} 人）。</b>` : ''}點出賽位再點人，或把右邊的人拖到出賽位；選到已上場的人會互換位置。`;
  const rows = mine
    .map((p) => {
      const slot = lu.ids.indexOf(p.id);
      const r = recs.get(p.id) ?? { w: 0, l: 0 };
      const t = tierName(p.version);
      const status = p.upgrading ? '<span class="st-tag bn">升版中</span>' : slot >= 0 ? `<span class="st-tag on">${esc(slotName(ctx, slot))}</span>` : '<span class="st-tag bn">替補</span>';
      return `<div class="row ${slot === 0 || (slot >= 0 && !lu.auto) ? 'me' : ''} ${ui.pickSlot !== null ? 'pickable' : ''}" data-act="${ui.pickSlot !== null && active ? 'assign' : 'player'}" data-pid="${p.id}" ${active ? 'draggable="true"' : ''}>
        ${avatar(ctx, p, 46)}<span class="who"><b>${esc(p.name)}</b>${lineage(ctx, p.lineageId, 13)}</span>
        <span class="ver"><span class="num ${p.version >= 3 ? 'gd' : ''}">v${p.version}</span><small class="dim">${t.zh}</small></span>
        <span class="num">${p.elo}</span><span class="num dim">${r.w}-${r.l}</span><span><span class="num">${wan(p.weeklySalary)}</span> <small class="dim">萬</small></span><span class="act">${status}</span></div>`;
    })
    .join('');
  const empties = Array.from({ length: Math.max(0, c.economy.rosterMax - v.me.roster.length) }, () => `<div class="row empty"><span class="hole"></span><span class="span5">空位 · 陣容上限 ${c.economy.rosterMax} 人，補替補可應付升版與輪替</span><span class="act"><button class="btn sm ghost" data-act="go" data-to="market"><b>去市場</b></button></span></div>`).join('');
  const salary = mine.reduce((s, p) => s + p.weeklySalary, 0);
  let opp: string;
  if (foe) {
    const r = v.standings.find((x) => x.teamId === foe);
    const odds = f ? v.odds.find((o) => o.fixtureId === f.id) : undefined;
    const my = odds && f ? (f.home === v.me.teamId ? odds.homeX100 : odds.awayX100) : null;
    const theirs = rosterOf(ctx, foe).sort((a, b) => b.elo - a.elo);
    opp = `<div class="pn r opp in">${pt('TARGET', '本週對手', '名單比賽日才公開', '')}
      <div class="grid">${crestRing(ctx, foe, 112)}<div><span class="nm">${esc(teamName(v, foe))}</span>
        <div class="meta">評分約 <b>${publicRating(ctx, foe)}</b> · ${r && r.played ? `<b>${r.wins}</b> 勝 <b>${r.losses}</b> 敗 · 積分第 ${rankOf(v, foe)}` : '尚未交手'}${teamForm(v, foe).length ? ` · 近況 ${teamForm(v, foe).join('')}` : ''}</div>
        <div class="pub">${theirs.map((p) => `<span data-act="player" data-pid="${p.id}">${esc(p.name)}<b>${p.elo}</b></span>`).join('')}</div></div>
        <div class="side"><div class="odds"><small>押我方贏</small><span class="num gd">${my ? `×${(my / 100).toFixed(2)}` : '—'}</span></div><button class="btn sm ghost" data-act="go" data-to="betting"><b>去下注</b></button></div></div></div>`;
  } else {
    opp = `<div class="pn opp in">${pt('TARGET', '本週對手')}<p class="dim big">${v.phase === 'offseason' ? '休賽期沒有比賽。第 1 週的對手會在開幕後公布。' : v.phase === 'season' ? '本週沒有我方的比賽。' : '這個賽段結束了。'}</p></div>`;
  }
  return `${head('SQUAD // 戰隊管理', '戰隊', `出賽名單 <b>${lu.auto ? '自動' : `${n}／${n}`}</b> · 陣容 <b>${v.me.roster.length}／${c.economy.rosterMax}</b>${foe ? ` · 本週對手 <b class="rd">${esc(teamName(v, foe))}</b>` : ''}`)}
    <section class="body s-squad">
      <div class="lineup n${n} in"><div class="hint"><span class="chip g">出賽名單 LINEUP</span><span class="chip">${n} 人名單對 ${n} 人名單打一場${n === 3 ? '' : '，流派＝場上角色'}</span></div>${cards}<div class="drag">${icon('swap', 18)}<span>${hint}</span></div></div>
      <div class="pn roster in">${pt('02', '陣容', `${v.me.roster.length}／${c.economy.rosterMax} 人 · 週薪合計 <b class="num">${wan(salary)}</b> 萬`, 'ROSTER')}
        <div class="rows"><div class="row hd"><span></span><span>選手</span><span>版本</span><span>評分</span><span>戰績</span><span>週薪</span><span style="text-align:right">狀態</span></div>${rows}${empties}</div></div>
      ${opp}
    </section>`;
}

// ───── 選手詳情 ─────
function history(ctx: Ctx, p: KnownPlayer): string {
  const { v } = ctx;
  const games: { week: number; opp: string; won: boolean | null; slot: number; my: number; their: number }[] = [];
  for (const f of v.fixtures) {
    const x = f.match;
    const s = f.score;
    if (!x || !s) continue;
    const home = x.home.includes(p.id);
    const i = (home ? x.home : x.away).indexOf(p.id);
    if (i < 0) continue;
    const won = x.winner === null ? null : (x.winner === f.home) === home;
    games.push({ week: f.week, opp: home ? f.away : f.home, won, slot: i, my: home ? s.home : s.away, their: home ? s.away : s.home });
  }
  if (!games.length) return '<p class="dim">還沒有出賽紀錄。</p>';
  return `<div class="hist">${games
    .slice(-5)
    .map((g) => `<div class="hrow"><span class="wk">${g.week <= 7 ? `W${String(g.week).padStart(2, '0')}` : g.week === 8 ? '準決' : '決賽'}</span><span class="sl">${esc(slotName(ctx, g.slot))}</span><span class="vs">vs ${esc(teamName(v, g.opp))} <small class="num">${g.my}:${g.their}</small></span><span class="stamp ${g.won ? 'w' : 'l'}">${g.won === null ? 'DRAW' : g.won ? 'WIN' : 'LOSE'}</span></div>`)
    .join('')}</div>`;
}

export function playerScreen(ctx: Ctx): string {
  const { v, c } = ctx;
  const p = ctx.ui.player ? ctx.pm.get(ctx.ui.player) : undefined;
  if (!p) return `${head('PLAYER // 選手詳情', '選手詳情', '找不到這位選手')}`;
  const e = c.economy;
  const mine = p.teamId === v.me.teamId;
  const active = canAct(v);
  const rec = playerRecords(v).get(p.id) ?? { w: 0, l: 0 };
  const t = tierName(p.version);
  const lu = lineupOf(ctx);
  const slot = mine ? lu.ids.indexOf(p.id) : -1;
  const ln = c.lineages.find((l) => l.id === p.lineageId);
  const maxV = maxVersionOf(c, p.lineageId);
  const upCost = p.weeklySalary * e.upgradeCostWeeks;
  const nextSalary = Math.round((p.weeklySalary * e.salaryGrowthPct) / 100);
  const ladder = Array.from({ length: maxV }, (_, i) => {
    const ver = i + 1;
    const sal = Math.round(p.weeklySalary * Math.pow(e.salaryGrowthPct / 100, ver - p.version));
    const cls = ver < p.version ? 'done' : ver === p.version ? 'cur' : ver === p.version + 1 ? 'next' : '';
    return `<div class="nd ${cls}"><i>v${ver}</i><b>${tierName(ver).zh}</b><small>${wan(sal)} 萬</small></div>`;
  }).join('');
  const fillPct = maxV > 1 ? ((p.version - 1) / (maxV - 1)) * 100 : 100;
  const presets = v.presets.filter((x) => x.playerId === p.id);
  const intel = v.intel.find((x) => x.playerId === p.id);
  const pending = v.jobs.some((j) => j.kind === 'scout' && j.playerId === p.id);
  const fee = p.weeklySalary * e.signingFeeWeeks;
  const full = v.me.roster.length >= e.rosterMax;
  let actions: string;
  if (mine) {
    actions = `${btn('排練習賽／研發', `data-act="train-with" data-id="${p.id}" ${active ? '' : 'disabled'}`, 'ghost')}${btn('解約', `data-act="release" data-id="${p.id}" ${!active || v.me.roster.length <= c.lineupSize ? 'disabled' : ''} title="${v.me.roster.length <= c.lineupSize ? `陣容至少要 ${c.lineupSize} 人` : ''}"`, 'danger')}`;
  } else if (p.teamId === null) {
    actions = `${btn(`簽約 · ${wan(fee)} 萬`, `data-act="sign" data-id="${p.id}" ${!active || full || v.me.cash < fee ? 'disabled' : ''}`, '', 'SIGN')}${btn(pending ? '球探出發中' : `派球探 · ${wan(e.scoutCost)} 萬`, `data-act="scout" data-id="${p.id}" ${!active || pending || v.me.cash < e.scoutCost ? 'disabled' : ''}`, 'ghost')}`;
  } else {
    actions = `${btn(pending ? '球探出發中' : `派球探 · ${wan(e.scoutCost)} 萬`, `data-act="scout" data-id="${p.id}" ${!active || pending || v.me.cash < e.scoutCost ? 'disabled' : ''}`, 'ghost')}${btn('跟他的戰隊打練習賽', `data-act="scrim-vs" data-id="${p.id}" ${active ? '' : 'disabled'}`, 'ghost')}`;
  }
  const tags = mine
    ? `<span class="g"><i>${slot >= 0 ? `${esc(slotName(ctx, slot))} · ${slotEn(ctx, slot)}` : '替補 · BENCH'}</i></span><span class="w"><i>${esc(lineageName(c, p.lineageId))}</i></span>${p.upgrading ? '<span class="o"><i>升版中</i></span>' : ''}`
    : `<span class="w"><i>${esc(teamName(v, p.teamId))}</i></span><span class="w"><i>${esc(lineageName(c, p.lineageId))}</i></span>`;
  const verPanel = `<div class="pn ${mine ? 'g' : ''} p-ver in">${pt('01', '版本線', `${esc(ln?.style ?? '')} · 最高 <b>v${maxV}</b>`, 'VERSION')}
      <div class="ladder" style="--fill:${fillPct}%">${ladder}</div>
      ${mine ? `<div class="upg"><div class="kv"><small>升版費用</small><span class="num">${wan(upCost)}<small class="dim"> 萬</small></span></div><div class="kv"><small>需時</small><span class="num">${e.upgradeWeeks}<small class="dim"> 週</small></span></div><div class="kv"><small>升版後週薪</small><span class="num">${wan(nextSalary)}<small class="dim"> 萬</small></span></div><div class="kv"><small>注意</small><span class="warnx">原戰術預設失效</span></div>
        ${btn(p.upgrading ? '升版中' : p.version >= maxV ? '已是最高版本' : '升版', `data-act="upgrade" data-id="${p.id}" ${!active || p.upgrading || p.version >= maxV || v.me.cash < upCost ? 'disabled' : ''}`, '', p.version >= maxV ? '' : 'UPGRADE')}</div>`
      : `<div class="upg"><div class="kv"><small>週薪</small><span class="num">${wan(p.weeklySalary)}<small class="dim"> 萬</small></span></div><div class="kv"><small>簽約金</small><span class="num">${wan(fee)}<small class="dim"> 萬</small></span></div><div class="kv"><small>出賽場數</small><span class="num">${p.games}</span></div></div>`}</div>`;
  const tac = mine
    ? `<div class="pn p-tac in">${pt('03', '戰術預設', '練習賽研發累積')}
      <div class="tac">${presets.length ? presets.map((x) => { const cap = x.target === 'generic' ? e.researchCapGeneric : e.researchCapSpecific; return `<div class="t ${x.valid ? '' : 'off'}"><span><b>${x.target === 'generic' ? '泛用' : `針對${esc(lineageName(c, x.target))}`}</b>${x.valid ? '' : ' · 升版後失效'}</span><span class="num ${x.valid ? 'gd' : 'dim'}">+${x.reportedBonus}<small class="dim"> /${cap}</small></span><div class="meter g" style="--v:${Math.round((x.reportedBonus / cap) * 100)}%"><i></i></div></div>`; }).join('') : '<p class="dim">還沒有戰術預設。到訓練基地排研發。</p>'}</div></div>`
    : `<div class="pn p-tac in">${pt('03', '球探情報', intel ? `W${String(intel.week).padStart(2, '0')}` : '')}
      ${intel ? `<div class="intel"><span class="num gd">${intel.estPower}</span><span>真實強度估計 ±${intel.sd}</span><span>比公開評分${intel.estPower >= p.elo ? '高' : '低'} <b>${Math.abs(intel.estPower - p.elo)}</b></span></div>` : `<p class="dim">${pending ? '球探已出發，推進一週後回報。' : '還沒有情報。派球探可以知道他的真實強度（帶誤差）。'}</p>`}</div>`;
  return `<div class="back in" data-act="go" data-to="${mine ? 'squad' : 'market'}">${icon('back', 18)}${mine ? '戰隊' : '轉會市場'} · <b>選手詳情</b></div>
    <section class="hero2"><svg class="rings in" viewBox="0 0 640 640">
        <defs><path id="tp" d="M 320 6 A 314 314 0 1 1 319.99 6"/><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd98a"/><stop offset="1" stop-color="#b9832a"/></linearGradient></defs>
        <g class="rr"><text><textPath href="#tp">${slot >= 0 ? slotEn(ctx, slot) : 'PLAYER'} · ${esc(p.name)} · ${esc(lineageName(c, p.lineageId))} · RATING ${p.elo} · ${t.en} v${p.version} · ${esc(teamName(v, p.teamId))} · ${esc(p.name)} ·</textPath></text></g>
        <g class="rs"><circle cx="320" cy="320" r="288" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="11" stroke-dasharray="1.5 5.04"/><circle cx="320" cy="320" r="288" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="20" stroke-dasharray="3 147.8"/></g>
        <circle cx="320" cy="320" r="262" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="9"/>
        <circle cx="320" cy="320" r="262" fill="none" stroke="${mine ? 'url(#gold)' : 'rgba(238,242,246,.6)'}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${Math.round(Math.max(0.05, Math.min(1, (p.elo - 1350) / 350)) * 1646)} 1646" transform="rotate(-90 320 320)"/>
        <g class="rf"><circle cx="320" cy="320" r="238" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="2" stroke-dasharray="50 100 12 70 160 330 24 760"/></g>
        <path d="M 320 30 L 320 52 M 320 588 L 320 610 M 30 320 L 52 320 M 588 320 L 610 320" stroke="#f0b54a" stroke-width="3"/></svg>
      <div class="lens tinted ${mine ? '' : 'grey'} in">${avatarSvg(p.id + p.name, '#3a4458', 370)}<i class="scan"></i></div>
      <div class="orb in" style="left:440px;top:66px"><b>${p.elo}</b><span>RATING</span></div>
      <div class="orb w in" style="left:96px;top:66px"><b>v${p.version}</b><span>${t.en}</span></div></section>
    <section class="plate in"><div class="tags">${tags}</div><h1>${esc(p.name)}</h1><div class="roman">${esc(lineageName(c, p.lineageId))} · ${t.zh}</div>
      <div class="stats"><div><b>${p.elo}</b><span>RATING</span></div><i></i><div><b>${rec.w}-${rec.l}</b><span>RECORD</span></div><i></i><div><b>${wan(p.weeklySalary)}</b><span>萬／週</span></div></div></section>
    <section class="body s-player">${verPanel}
      <div class="pn p-hist in">${pt('02', '出賽紀錄', `${rec.w} 勝 ${rec.l} 敗`)}${history(ctx, p)}</div>
      ${tac}
      <div class="pn p-con in">${pt('04', mine ? '合約與安排' : '動作', mine ? `週薪 <b>${wan(p.weeklySalary)}</b> 萬 · 出賽 ${p.games} 場` : esc(teamName(v, p.teamId)))}
        <div class="acts">${actions}</div></div>
    </section>`;
}

// ───── 轉會市場 ─────
function faRow(ctx: Ctx, p: KnownPlayer, sel: boolean): string {
  const intel = ctx.v.intel.find((i) => i.playerId === p.id);
  const pending = ctx.v.jobs.some((j) => j.kind === 'scout' && j.playerId === p.id);
  const d = intel ? intel.estPower - p.elo : 0;
  return `<div class="row ${sel ? 'me' : ''}" data-act="pick-fa" data-pid="${p.id}">${avatar(ctx, p, 44)}<span class="who"><b>${esc(p.name)}</b>${lineage(ctx, p.lineageId, 13)}</span>
    <span class="num ${p.version >= 3 ? 'gd' : ''}">v${p.version}</span><span class="num">${p.elo}</span>
    <span class="intel">${intel ? `<b class="${d >= 0 ? 'gd2' : 'rd'}">${d >= 0 ? '+' : ''}${d}</b><small>真實 ${intel.estPower}</small>` : pending ? '<small>球探中</small>' : '<small class="dim2">—</small>'}</span>
    <span><span class="num">${wan(p.weeklySalary)}</span> <small class="dim">萬</small></span></div>`;
}

export function marketScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const active = canAct(v);
  const free = v.players.filter((p) => p.teamId === null).sort((a, b) => b.version - a.version || b.elo - a.elo);
  const tabs = `<div class="tabs"><button class="${ui.marketTab === 'free' ? 'on' : ''}" data-act="mtab" data-t="free">自由球員<i>${free.length}</i></button><button class="${ui.marketTab === 'teams' ? 'on' : ''}" data-act="mtab" data-t="teams">各隊名單<i>${v.players.filter((p) => p.teamId !== null && p.teamId !== v.me.teamId).length}</i></button><button class="${ui.marketTab === 'intel' ? 'on' : ''}" data-act="mtab" data-t="intel">球探報告<i>${v.intel.length}</i></button></div>`;
  let list: string;
  if (ui.marketTab === 'free') {
    list = `<div class="rows scroll"><div class="row hd"><span></span><span>選手</span><span>版本</span><span>評分</span><span>情報</span><span>週薪</span></div>${free.map((p) => faRow(ctx, p, p.id === ui.marketPick)).join('') || '<p class="dim">市場上沒有自由球員了。</p>'}</div>`;
  } else if (ui.marketTab === 'teams') {
    list = `<div class="rows scroll">${v.teams
      .filter((t) => t.id !== v.me.teamId)
      .map((t) => `<div class="grp">${crest(ctx, t.id, 22)}<b>${esc(t.name)}</b><span class="dim">公開戰力 ${publicRating(ctx, t.id)} · 名氣 ${t.fame}</span></div>${rosterOf(ctx, t.id)
        .sort((a, b) => b.elo - a.elo)
        .map((p) => faRow(ctx, p, p.id === ui.marketPick))
        .join('')}`)
      .join('')}</div>`;
  } else {
    const rep = [...v.intel].reverse();
    list = `<div class="rows scroll">${rep.length ? rep.map((i) => { const p = ctx.pm.get(i.playerId); if (!p) return ''; const d = i.estPower - p.elo; return `<div class="row" data-act="pick-fa" data-pid="${p.id}">${avatar(ctx, p, 44)}<span class="who"><b>${esc(p.name)}</b><small class="dim">${esc(teamName(v, p.teamId))}</small></span><span class="num">${p.elo}</span><span class="num gd2">${i.estPower}</span><span class="intel"><b class="${d >= 0 ? 'gd2' : 'rd'}">${d >= 0 ? '比評分高' : '比評分低'} ${Math.abs(d)}</b><small>±${i.sd} · W${String(i.week).padStart(2, '0')}</small></span></div>`; }).join('') : '<p class="dim">還沒有球探報告。選一位選手派球探，推進一週後回報。</p>'}</div>`;
  }
  const picked = ui.marketPick ? ctx.pm.get(ui.marketPick) : undefined;
  const pick = picked && picked.teamId !== v.me.teamId ? picked : free[0];
  let side = `<div class="pn sel in">${pt('PICK', '選一位選手')}<p class="dim big">點左邊的選手看詳細。</p></div>`;
  if (pick) {
    const lu = lineupOf(ctx);
    const bench = rosterOf(ctx, v.me.teamId).filter((p) => !lu.ids.includes(p.id));
    const cmp = (bench.length ? bench : rosterOf(ctx, v.me.teamId)).sort((a, b) => a.elo - b.elo)[0];
    const fee = pick.weeklySalary * e.signingFeeWeeks;
    const isFree = pick.teamId === null;
    const full = v.me.roster.length >= e.rosterMax;
    const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
    const netAfter = net - pick.weeklySalary;
    const cashAfter = v.me.cash - fee;
    const runAfter = netAfter >= 0 ? null : Math.max(0, Math.floor(cashAfter / -netAfter));
    const pending = v.jobs.some((j) => j.kind === 'scout' && j.playerId === pick.id);
    const bar = (a: number, b: number, lo: number, hi: number): [number, number] => [Math.round(((a - lo) / (hi - lo)) * 100), Math.round(((b - lo) / (hi - lo)) * 100)];
    const line = (k: string, a: number | string, b: number | string, pa: number, pb: number, gold: boolean): string =>
      `<div class="line"><span class="num l ${gold ? 'gd' : ''}">${a}</span><span class="bar lft"><i class="${gold ? 'g' : ''}" style="width:${Math.max(4, Math.min(100, pa))}%"></i></span><span class="k">${k}</span><span class="bar rgt"><i style="width:${Math.max(4, Math.min(100, pb))}%"></i></span><span class="num">${b}</span></div>`;
    const [ea, eb] = cmp ? bar(pick.elo, cmp.elo, 1350, 1700) : [0, 0];
    side = `<div class="sel in"><div class="card">${pcard(ctx, pick, { act: 'player', sel: true, note: intelNote(ctx, pick) })}</div>
      <div class="pn g cmp">${pt('COMPARE', cmp ? '跟替補比' : '選手資料', esc(teamName(v, pick.teamId)))}
        ${cmp ? `<div class="hdr"><div class="who">${avatar(ctx, pick, 54)}<div><b>${esc(pick.name)}</b><small>${esc(lineageName(c, pick.lineageId))} · v${pick.version}</small></div></div><div class="mid">VS</div><div class="who r">${avatar(ctx, cmp, 54)}<div><b>${esc(cmp.name)}</b><small>${esc(lineageName(c, cmp.lineageId))} · v${cmp.version} · 我方</small></div></div></div>
          ${line('公開評分', pick.elo, cmp.elo, ea, eb, pick.elo > cmp.elo)}${line('版本', `v${pick.version}`, `v${cmp.version}`, pick.version * 18, cmp.version * 18, false)}${line('週薪（萬）', wan(pick.weeklySalary), wan(cmp.weeklySalary), pick.weeklySalary, cmp.weeklySalary, false)}${line('流派上限', `v${maxVersionOf(c, pick.lineageId)}`, `v${maxVersionOf(c, cmp.lineageId)}`, maxVersionOf(c, pick.lineageId) * 16, maxVersionOf(c, cmp.lineageId) * 16, false)}` : ''}</div>
      ${isFree ? `<div class="pn sim">${pt('SIMULATE', '簽下之後', `簽約金 <b class="num">${wan(fee)}</b> 萬 · 週薪 <b class="num">${wan(pick.weeklySalary)}</b> 萬`)}
        <div class="grid"><div class="k"><small>現金</small><div class="ch"><span class="num">${wan(v.me.cash)}</span><i>→</i><span class="num to ${cashAfter < 0 ? 'bad' : ''}">${wan(cashAfter)}</span></div></div>
          <div class="k"><small>每週固定淨額</small><div class="ch"><span class="num">${net >= 0 ? '+' : '−'}${wan(Math.abs(net))}</span><i>→</i><span class="num to ${netAfter < 0 ? 'bad' : ''}">${netAfter >= 0 ? '+' : '−'}${wan(Math.abs(netAfter))}</span></div></div>
          <div class="k"><small>資金跑道</small><div class="ch"><span class="num">${v.me.runwayWeeks ?? '∞'} 週</span><i>→</i><span class="num to ${runAfter !== null && runAfter < 4 ? 'bad' : ''}">${runAfter ?? '∞'} 週</span></div></div></div>
        ${runAfter !== null && runAfter < 4 ? `<div class="warn">${icon('warn', 20)}資金跑道會降到 ${runAfter} 週，之後要靠贏球收入或下注把淨額拉回來。</div>` : ''}
        <div class="go">${btn(pending ? '球探出發中' : `派球探 · ${wan(e.scoutCost)} 萬`, `data-act="scout" data-id="${pick.id}" ${!active || pending || v.me.cash < e.scoutCost ? 'disabled' : ''}`, 'ghost')}${btn(full ? '陣容已滿' : `簽下${esc(pick.name)}`, `data-act="sign" data-id="${pick.id}" ${!active || full || v.me.cash < fee ? 'disabled' : ''}`, '', 'SIGN')}</div></div>`
      : `<div class="pn sim">${pt('ACTION', '別隊選手', 'M5 才開放轉會')}<p class="dim">別隊選手不能簽，但可以派球探摸清真實強度，或跟他的戰隊打練習賽估勝率。</p>
        <div class="go">${btn(pending ? '球探出發中' : `派球探 · ${wan(e.scoutCost)} 萬`, `data-act="scout" data-id="${pick.id}" ${!active || pending || v.me.cash < e.scoutCost ? 'disabled' : ''}`, 'ghost')}${btn('跟他的戰隊打練習賽', `data-act="scrim-vs" data-id="${pick.id}" ${active ? '' : 'disabled'}`, 'ghost')}</div></div>`}</div>`;
  }
  return `${head('RECRUIT // 轉會市場', '轉會市場', `自由球員 <b>${free.length}</b> 名 · 先到先簽 · 簽約金＝${e.signingFeeWeeks} 週薪資 · 陣容 <b>${v.me.roster.length}／${e.rosterMax}</b>`)}
    <section class="body s-market"><div class="pn list in">${tabs}${list}
      <p class="tip">${icon('info', 16)}評分的起點只看版本，每個流派都一樣——某流派的 v3 實際上強多少，只有戰績或球探情報看得出來。</p></div>
      ${side}</section>`;
}
