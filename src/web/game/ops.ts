// 訓練基地（場數環、本週排程、新增排程、三欄報告）與賭盤（注單、下注單、已下的注）。
// 練習賽是隊對隊：我方本週出賽名單對選定戰隊的出賽名單；研發是每位選手一個預設。
import { lineageName } from '../manage/format.ts';
import { myFixture, publicRating, rankOf, rosterOf } from '../club/model.ts';
import type { Ctx } from './kit.ts';
import { avatar, btn, canAct, crest, crestRing, esc, foeOf, glyph, head, icon, pt, runStep, teamName, wan } from './kit.ts';

// ───── 訓練基地 ─────
export function trainingScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const lvl = v.me.trainingLevel;
  const cap = e.scrimCapacity[lvl - 1];
  const left = Math.max(0, v.me.capacityLeft);
  const used = cap - left;
  const maxLvl = e.facilityMaintenance.length;
  const active = canAct(v);
  const mine = rosterOf(ctx, v.me.teamId);
  const L = 830;
  const usedLen = (used / cap) * L;
  const upCost = lvl < maxLvl ? e.facilityUpgradeCost[lvl - 1] : 0;
  const jobs = v.jobs.map((j) => {
    if (j.kind === 'scrim') return `<div class="job"><span class="ic2 w">${icon('swords', 24)}</span><b>練習賽<small>對 ${esc(teamName(v, j.opponentTeamId))}</small></b><span class="num">${j.games}</span><div class="meter" style="--v:${Math.round((j.games / cap) * 100)}%"><i></i></div></div>`;
    const p = ctx.pm.get(j.playerId);
    const who = esc(p?.name ?? '?');
    if (j.kind === 'scout') return `<div class="job"><span class="ic2 w">${icon('search', 24)}</span><b>球探<small>${who} · ${esc(teamName(v, p?.teamId ?? null))}</small></b><span class="num sm">${wan(e.scoutCost)}萬</span><div class="meter" style="--v:100%"><i></i></div></div>`;
    return `<div class="job"><span class="ic2">${icon('flask', 24)}</span><b>戰術研發<small>${who} · ${j.target === 'generic' ? '泛用' : `針對${esc(lineageName(c, j.target))}`}</small></b><span class="num">${j.games}</span><div class="meter g" style="--v:${Math.round((j.games / cap) * 100)}%"><i></i></div></div>`;
  });
  const pid = ui.research.playerId;
  const picks = mine.map((p) => `<button class="pk ${p.id === pid ? 'on' : ''}" data-act="tpick" data-pid="${p.id}" title="${esc(p.name)}">${avatar(ctx, p, 52)}<small>${esc(p.name)}</small></button>`).join('');
  const step = runStep(cap);
  const games = ui.trainMode === 'scrim' ? ui.scrim.games : ui.research.games;
  const g = Math.max(step, Math.min(games, Math.max(step, left)));
  const field = ui.trainMode === 'scrim' ? 'scrim.games' : 'research.games';
  const oppTeam = ui.scrim.opponentId;
  const oppOpts = v.teams
    .filter((t) => t.id !== v.me.teamId)
    .map((t) => `<option value="${t.id}" ${t.id === oppTeam ? 'selected' : ''}>${esc(t.name)}（評分約 ${publicRating(ctx, t.id)} · 第 ${rankOf(v, t.id) || '—'} 名${t.id === foeOf(v) ? ' · 本週對手' : ''}）</option>`)
    .join('');
  const targets = [{ id: 'generic', name: '泛用' }, ...c.lineages.map((l) => ({ id: l.id, name: l.name }))];
  const form =
    ui.trainMode === 'scrim'
      ? `<div class="lbl">對手戰隊</div><select class="sel" data-field="scrim.opponentId">${oppOpts}</select>`
      : `<div class="lbl">針對流派</div><div class="styles">${targets.map((t) => `<button class="${ui.research.target === t.id ? 'on' : ''}" data-act="target" data-t="${t.id}">${t.id === 'generic' ? icon('star', 15) : glyph(t.id, 16)}${t.name}</button>`).join('')}</div>`;
  const desc =
    ui.trainMode === 'scrim'
      ? `我方出賽名單 vs ${esc(teamName(v, oppTeam))} 的出賽名單 · 估真實勝率`
      : `${esc(ctx.pm.get(pid)?.name ?? '')} · ${ui.research.target === 'generic' ? '泛用（上限 +' + e.researchCapGeneric + '）' : `針對${esc(lineageName(c, ui.research.target))}（上限 +${e.researchCapSpecific}）`}`;
  const scrims = [...v.scrims].reverse().slice(0, 3);
  const presets = v.presets.slice(-3).reverse();
  const intel = [...v.intel].reverse().slice(0, 3);
  const ci = (w: number, n: number): number => Math.round(196 * Math.sqrt(((w / n) * (1 - w / n)) / n));
  return `${head('TRAINING // 訓練基地', '訓練基地', `訓練中心 <b>Lv${lvl}</b> · 本週可跑 <b>${cap}</b> 場 · 已排 <b>${used}</b> · 這週排的工作，推進一週後才出報告`)}
    <section class="body s-training">
      <div class="pn g fac in">${pt('01', '訓練中心', '', 'FACILITY')}
        <div class="ringbox"><svg viewBox="0 0 300 300"><circle cx="150" cy="150" r="132" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="16"/>
          <circle cx="150" cy="150" r="132" fill="none" stroke="rgba(238,242,246,.55)" stroke-width="16" stroke-dasharray="${usedLen.toFixed(1)} ${L}" transform="rotate(-90 150 150)"/>
          <circle cx="150" cy="150" r="132" fill="none" stroke="#f0b54a" stroke-width="16" stroke-dasharray="0 ${usedLen.toFixed(1)} ${(L - usedLen).toFixed(1)} ${L}" transform="rotate(-90 150 150)"/>
          <circle cx="150" cy="150" r="132" fill="none" stroke="#0b0e14" stroke-width="18" stroke-dasharray="2 39.4"/>
          <g class="spin"><circle cx="150" cy="150" r="148" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.5" stroke-dasharray="3 9"/></g></svg>
          <div class="v"><span class="num">${left}</span><small>RUNS LEFT</small><span>本週剩餘場數 ／ ${cap}</span></div></div>
        <div class="lv"><div class="fl3">${[1, 2, 3].map((i) => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('')}</div><div class="t"><b>Lv${lvl}</b><span>維護 ${wan(e.facilityMaintenance[lvl - 1])} 萬／週</span></div>
          ${lvl < maxLvl ? btn(`升 Lv${lvl + 1} · ${wan(upCost)}萬`, `data-act="upfac" ${!active || v.me.cash < upCost ? 'disabled' : ''} title="每週 ${e.scrimCapacity[lvl]} 場，維護 ${wan(e.facilityMaintenance[lvl])} 萬"`, 'sm ghost') : '<span class="chip g">最高等級</span>'}</div></div>
      <div class="pn sch in">${pt('02', '本週排程', `已排 <b>${used}</b>／${cap} 場`)}
        <div class="jobs scroll">${jobs.join('') || '<p class="dim">還沒有排任何工作。右邊選選手與項目排進來。</p>'}</div>
        <div class="sum"><span>研發半飽和約 <b>${e.researchHalfSat}</b> 場；越練越慢</span><span>泛用上限 <b>+${e.researchCapGeneric}</b> · 針對上限 <b>+${e.researchCapSpecific}</b></span></div></div>
      <div class="pn new in">${pt('03', '新增排程', '', 'SCHEDULE')}
        <div class="lbl">項目</div><div class="seg2"><button class="${ui.trainMode === 'scrim' ? 'on' : ''}" data-act="tmode" data-m="scrim">練習賽（隊對隊）</button><button class="${ui.trainMode === 'research' ? 'on' : ''}" data-act="tmode" data-m="research">戰術研發</button></div>
        ${ui.trainMode === 'research' ? `<div class="lbl">選手</div><div class="pick">${picks}</div>` : ''}
        ${form}
        <div class="lbl">場數</div><div class="runs"><input type="range" min="${step}" max="${Math.max(step, left)}" step="${step}" value="${g}" data-field="${field}" ${left < step ? 'disabled' : ''}><span class="num" data-out="${field}">${g}</span></div>
        <div class="go"><span>${desc}</span>${btn('排入', `data-act="${ui.trainMode === 'scrim' ? 'scrim' : 'research'}" ${!active || left < step ? 'disabled' : ''}`, 'sm')}</div></div>
      <div class="pn rep in">${pt('04', '報告', '最近的工作成果')}
        <div class="cols">
          <div class="col"><h4>${icon('search', 18)}球探報告<small>誤差 ±${e.scoutSd}</small></h4>${intel.length ? intel.map((i) => { const p = ctx.pm.get(i.playerId); const d = p ? i.estPower - p.elo : 0; return `<div class="it" data-act="player" data-pid="${i.playerId}"><b>${esc(p?.name ?? '?')}</b>（${esc(teamName(v, p?.teamId ?? null))}）真實約 <span class="num">${i.estPower}</span>，比評分${d >= 0 ? '高' : '低'} <b>${Math.abs(d)}</b></div>`; }).join('') : '<p class="dim">到轉會市場派球探。</p>'}</div>
          <div class="col"><h4>${icon('swords', 18)}練習賽報告<small>樣本越多越準</small></h4>${scrims.length ? scrims.map((s) => `<div class="it"><b>對 ${esc(teamName(v, s.opponentTeamId))}</b> ${s.games} 場 ${s.wins} 勝：估計勝率 <span class="num">${Math.round((s.wins * 100) / s.games)}%</span> ± ${ci(s.wins, s.games)}%</div>`).join('') : '<p class="dim">還沒有報告。</p>'}</div>
          <div class="col"><h4>${icon('flask', 18)}戰術預設<small>升版後失效</small></h4>${presets.length ? presets.map((x) => `<div class="it ${x.valid ? '' : 'off'}"><b>${esc(ctx.pm.get(x.playerId)?.name ?? '?')} · ${x.target === 'generic' ? '泛用' : `針對${esc(lineageName(c, x.target))}`}</b> 估計加成 <span class="num">+${x.reportedBonus}</span>${x.valid ? '' : '（已失效）'}</div>`).join('') : '<p class="dim">還沒有預設。</p>'}</div>
        </div></div>
    </section>`;
}

// ───── 賭盤 ─────
export function bettingScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const limit = e.betLimitBase + e.betLimitPerFame * v.me.fame;
  const top = head('BETTING // 賭盤', '賭盤', `莊家抽成 ${e.betMarginPermille / 10}% · 單場上限 <b>${wan(limit)}</b> 萬 · 單注至少 ${wan(e.betMin)} 萬 · 賠率在下注時鎖定 · 自己的比賽只能押自己`);
  if (v.phase !== 'season') return `${top}<section class="body s-betting"><div class="pn board in">${pt('01', '本週注單')}<p class="dim big">${v.phase === 'offseason' ? '賽季開始後才開盤。' : '這個賽段結束了。'}</p></div></section>`;
  const foe = foeOf(v);
  const mf = myFixture(v);
  const open = v.fixtures.filter((f) => f.week === v.week && f.score === null);
  const slips = open
    .map((f) => {
      const o = v.odds.find((x) => x.fixtureId === f.id);
      const mine = f === mf;
      const staked = v.bets.filter((b) => b.fixtureId === f.id).reduce((s, b) => s + b.stake, 0);
      const myBet = v.bets.filter((b) => b.fixtureId === f.id);
      const sel = (side: string): boolean => ui.slip?.fixtureId === f.id && ui.slip.side === side;
      const side = (s: 'home' | 'away'): string => {
        const team = s === 'home' ? f.home : f.away;
        const x = o ? (s === 'home' ? o.homeX100 : o.awayX100) : 0;
        const lock = !o || (mine && team !== v.me.teamId) || staked >= limit;
        const placed = myBet.filter((b) => b.side === s).reduce((t, b) => t + b.stake, 0);
        return `<button class="odd ${sel(s) ? 'on' : ''} ${lock ? 'lock' : ''} ${placed ? 'mine' : ''}" data-act="slip" data-fid="${f.id}" data-side="${s}" ${lock ? 'disabled' : ''}><span>${mine && team !== v.me.teamId ? '不能押對手' : placed ? `已下 ${wan(placed)} 萬` : s === 'home' ? '主勝' : '客勝'}</span><span class="num">×${(x / 100).toFixed(2)}</span></button>`;
      };
      const tm = (id: string, r: boolean): string => `<div class="tm ${r ? 'r' : ''}">${crestRing(ctx, id, 54)}<div><b class="${id === foe ? 'rd' : ''}">${esc(teamName(v, id))}</b><small>評分約 <span class="num">${publicRating(ctx, id)}</span> · 第 ${rankOf(v, id)}</small></div></div>`;
      return `<div class="slip ${mine ? 'me' : ''}">${tm(f.home, false)}<div class="mid"><span class="vs">VS</span><small>${mine ? '我方比賽' : `已押 ${wan(staked)}／${wan(limit)}`}</small></div>${tm(f.away, true)}${side('home')}<div></div>${side('away')}</div>`;
    })
    .join('');
  let slip = `<div class="pn g bs in">${pt('02', '下注單', '', 'BET SLIP')}<div class="empty">${icon('ticket', 40, 1.4)}<p>點左邊的賠率，加入下注單。</p></div></div>`;
  if (ui.slip) {
    const f = v.fixtures.find((x) => x.id === ui.slip?.fixtureId);
    const o = f ? v.odds.find((x) => x.fixtureId === f.id) : undefined;
    if (f && o) {
      const team = ui.slip.side === 'home' ? f.home : f.away;
      const odds = ui.slip.side === 'home' ? o.homeX100 : o.awayX100;
      const staked = v.bets.filter((b) => b.fixtureId === f.id).reduce((s, b) => s + b.stake, 0);
      const maxStake = Math.max(0, Math.floor(Math.min(limit - staked, v.me.cash) / 10));
      const stake = Math.max(0, Math.min(ui.slip.stake, maxStake));
      slip = `<div class="pn g bs in">${pt('02', '下注單', '', 'BET SLIP')}
        <div class="pick">${crest(ctx, team, 40)}<div><b>${esc(teamName(v, team))} 勝</b><small>${esc(teamName(v, f.home))} vs ${esc(teamName(v, f.away))} · 賠率鎖定</small></div><span class="num">×${(odds / 100).toFixed(2)}</span></div>
        <div class="amt"><small>下注金額（萬）</small><input class="stake num" type="number" min="1" max="${maxStake}" value="${stake}" data-field="slip.stake"></div>
        <div class="chips">${[1, 5, 10].map((n) => `<button data-act="stake-add" data-n="${n}">+${n}</button>`).join('')}<button class="mx" data-act="stake-max">MAX</button><button data-act="stake-clear">清除</button></div>
        <div class="lim"><div class="row2"><span>單場上限（${wan(e.betLimitBase)}＋名氣 × ${wan(e.betLimitPerFame)}）</span><span>${wan(staked)}／${wan(limit)} 萬</span></div><div class="meter g" style="--v:${Math.round((staked / limit) * 100)}%"><i></i></div></div>
        <div class="win"><span>押中可得</span><span class="num"><span data-out="slip.pay">${wan(Math.floor((stake * 10 * odds) / 100))}</span><small class="dim"> 萬</small></span></div>
        <div class="go"><button class="lnk" data-act="slip-clear">取消</button>${btn('確認下注', `data-act="place-bet" ${stake < Math.ceil(e.betMin / 10) ? 'disabled' : ''}`, '', 'PLACE BET')}</div></div>`;
    }
  }
  const myBets = v.bets
    .map((b) => {
      const f = v.fixtures.find((x) => x.id === b.fixtureId);
      if (!f) return '';
      const team = b.side === 'home' ? f.home : f.away;
      return `<div class="row ${team === v.me.teamId ? 'me' : ''}"><span class="s">${crest(ctx, team, 20)}${esc(teamName(v, team))} 勝</span><span class="num">×${(b.oddsX100 / 100).toFixed(2)}</span><span class="num">${wan(b.stake)}</span><span class="num gd">${wan(Math.floor((b.stake * b.oddsX100) / 100))}</span></div>`;
    })
    .join('');
  const betLedger = v.ledger.filter((x) => x.category === 'bet');
  const net = betLedger.reduce((s, x) => s + x.amount, 0);
  const stakes = -betLedger.filter((x) => x.amount < 0).reduce((s, x) => s + x.amount, 0);
  return `${top}<section class="body s-betting">
    <div class="pn board in">${pt('01', '本週注單', `${v.week <= 7 ? `第 ${v.week} 週` : v.week === 8 ? '準決賽' : '決賽'} · 開賽前都能下注`, 'ODDS')}<div class="scroll">${slips || '<p class="dim">本週沒有可押的比賽。</p>'}</div>
      <p class="tip">${icon('info', 16)}賠率只看公開評分，長期亂押必虧。比公開評分知道更多的時候（球探、練習賽），才有機會贏莊家。</p></div>
    ${slip}
    <div class="pn mybets in">${pt('03', '已下的注', '開獎在比賽日之後')}
      <div class="rows"><div class="row hd"><span>內容</span><span>賠率</span><span>下注</span><span>可得</span></div>${myBets || '<p class="dim">本週還沒下注。</p>'}</div>
      <div class="season"><span>本季投入<span class="num">${wan(stakes)}</span> 萬</span><span>淨額<span class="num ${net < 0 ? 'rd' : 'gd2'}">${net >= 0 ? '+' : '−'}${wan(Math.abs(net))}</span> 萬</span></div></div>
  </section>`;
}
