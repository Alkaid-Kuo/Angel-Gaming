// 訓練基地（設施與兩種額度、排練習賽、本週排程分組、三欄報告）與賭盤（注單、下注單、已下的注）。
// 練習賽是隊對隊：我方本週出賽名單對選定戰隊的出賽名單，佔「練習賽場數」。屬性訓練（選手詳情）與戰術排練（戰術室）共用「訓練時段」，這裡只列在本週排程裡。
import { myFixture, publicRating, rankOf } from '../club/model.ts';
import type { Ctx } from './kit.ts';
import { btn, canAct, crest, crestRing, esc, foeOf, head, icon, pt, runStep, teamName, waitText, wan } from './kit.ts';

/** 練習賽的等待說明（滑桿拖動時 main.ts 也用它更新） */
export function scrimWaitText(games: number, ms: number): string {
  return `${games} 場推進時多等${waitText(ms)}`;
}

// ───── 訓練基地 ─────
export function trainingScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const lvl = v.me.trainingLevel;
  const cap = e.scrimCapacity[lvl - 1];
  const left = Math.max(0, v.me.capacityLeft);
  const used = cap - left;
  // 訓練時段（M5 第二批）：屬性訓練與戰術排練共用，和練習賽場數分開
  const slotCap = e.trainingSlots[lvl - 1];
  const slots = Math.max(0, v.me.slotsLeft);
  const maxLvl = e.facilityMaintenance.length;
  const active = canAct(v);
  const upCost = lvl < maxLvl ? e.facilityUpgradeCost[lvl - 1] : 0;
  // 本週排程依類型分組：練習賽（佔場數）、屬性訓練與戰術排練（佔時段）、球探（不佔）；每組標題帶「去排」
  const who = (id: string): string => esc(ctx.pm.get(id)?.name ?? '?');
  const scrimJobs = v.jobs.filter((j) => j.kind === 'scrim').map((j) => (j.kind === 'scrim' ? `<div class="job"><span class="ic2 w">${icon('swords', 22)}</span><b>對 ${esc(teamName(v, j.opponentTeamId))}</b><span class="num">${j.games}<small>場</small></span></div>` : ''));
  const trainJobs = v.jobs.filter((j) => j.kind === 'train').map((j) => (j.kind === 'train' ? `<div class="job"><span class="ic2">${icon('levelup', 22)}</span><b>${who(j.playerId)}<small>${esc(c.attributes.names[j.attr] ?? j.attr)}</small></b><span class="num">${j.sessions}<small>節</small></span></div>` : ''));
  const rehearseJobs = v.jobs.filter((j) => j.kind === 'rehearse').map((j) => (j.kind === 'rehearse' ? `<div class="job"><span class="ic2">${icon('target', 22)}</span><b>${esc(c.tactics.find((t) => t.id === j.tactic)?.name ?? j.tactic)}</b><span class="num">${j.sessions}<small>節</small></span></div>` : ''));
  const scoutJobs = v.jobs
    .filter((j) => j.kind === 'scout' || j.kind === 'scoutTeam')
    .map((j) => (j.kind === 'scout' ? `<div class="job"><span class="ic2 w">${icon('search', 22)}</span><b>${who(j.playerId)}<small>${esc(teamName(v, ctx.pm.get(j.playerId)?.teamId ?? null))}</small></b><span class="num sm">${wan(e.scoutCost)}<small>萬</small></span></div>` : j.kind === 'scoutTeam' ? `<div class="job"><span class="ic2 w">${icon('search', 22)}</span><b>${esc(teamName(v, j.targetId))}<small>常用戰術</small></b><span class="num sm">${wan(e.scoutCost)}<small>萬</small></span></div>` : ''));
  const group = (title: string, note: string, items: string[], goTo: string, goLabel: string): string =>
    `<div class="grp"><h4><b>${title}</b><small>${note}</small>${items.length ? `<em>${items.length}</em>` : ''}<button class="lnk" data-act="go" data-to="${goTo}">${goLabel} →</button></h4>${items.join('') || '<p class="none">還沒排</p>'}</div>`;
  const step = runStep(cap);
  const g = Math.max(step, Math.min(ui.scrim.games, Math.max(step, left)));
  const field = 'scrim.games';
  const oppTeam = ui.scrim.opponentId;
  const oppOpts = v.teams
    .filter((t) => t.id !== v.me.teamId)
    .map((t) => `<option value="${t.id}" ${t.id === oppTeam ? 'selected' : ''}>${esc(t.name)}（評分約 ${publicRating(ctx, t.id)} · 第 ${rankOf(v, t.id) || '—'} 名${t.id === foeOf(v) ? ' · 本週對手' : ''}）</option>`)
    .join('');
  // 練習賽真打（攻防戰）：推進時要多等的時間；假比賽是 0 不顯示
  const scrimWait = ctx.estMs(g);
  const queuedScrims = v.jobs.filter((j) => j.kind === 'scrim').reduce((s, j) => s + ctx.estMs(j.games), 0);
  const scrims = [...v.scrims].reverse().slice(0, 3);
  // 戰術手冊摘要：執行熟練度最高的三個（M5）
  const topTactics = [...c.tactics].sort((a, b) => (v.me.effective[b.id] ?? 0) - (v.me.effective[a.id] ?? 0)).slice(0, 3);
  const intel = [...v.intel].reverse().slice(0, 3);
  const ci = (w: number, n: number): number => Math.round(196 * Math.sqrt(((w / n) * (1 - w / n)) / n));
  const slotUsed = slotCap - slots;
  return `${head('TRAINING // 訓練基地', '訓練基地', `訓練中心 <b>Lv${lvl}</b> · 每週兩種額度：練習賽 <b>${cap}</b> 場、訓練時段 <b>${slotCap}</b> 節 · 這週排的工作，推進一週後才出報告`)}
    <section class="body s-training">
      <div class="pn g fac in">${pt('01', '設施', '', 'FACILITY')}
        <div class="lv"><div class="fl3">${[1, 2, 3].map((i) => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('')}</div><div class="t"><b>Lv${lvl}</b><span>維護 ${wan(e.facilityMaintenance[lvl - 1])} 萬／週</span></div>
          ${lvl < maxLvl ? btn(`升 Lv${lvl + 1} · ${wan(upCost)}萬`, `data-act="upfac" ${!active || v.me.cash < upCost ? 'disabled' : ''} data-tip="每週練習賽 ${e.scrimCapacity[lvl]} 場、訓練時段 ${e.trainingSlots[lvl]} 節，維護 ${wan(e.facilityMaintenance[lvl])} 萬"`, 'sm ghost tip-r') : '<span class="chip g">最高等級</span>'}</div>
        <div class="quota"><div class="qh"><small>QUOTA A</small><b>練習賽場數</b><span class="num">${left}<i>／${cap} 場</i></span></div><div class="meter" style="--v:${Math.round((used / Math.max(1, cap)) * 100)}%"><i></i></div><p>用在：<b>練習賽</b>（右邊排）。每場真打，推進時要多等幾秒。</p></div>
        <div class="quota"><div class="qh"><small>QUOTA B</small><b>訓練時段</b><span class="num">${slots}<i>／${slotCap} 節</i></span></div><div class="meter g" style="--v:${Math.round((slotUsed / Math.max(1, slotCap)) * 100)}%"><i></i></div><p>用在：<b>屬性訓練</b>（選手詳情排）與<b>戰術排練</b>（戰術室排），兩邊共用。</p>
          <div class="to">${btn('去選手詳情練屬性', 'data-act="go" data-to="squad"', 'sm ghost')}${c.tactics.length ? btn('去戰術室排練', 'data-act="go" data-to="tactics"', 'sm ghost') : ''}</div></div></div>
      <div class="pn sch in">${pt('02', '排練習賽', `這週還能排 <b>${left}</b> 場`, 'SCRIM')}
        <div class="lbl">對手戰隊</div><select class="sel" data-field="scrim.opponentId">${oppOpts}</select>
        <div class="lbl">場數</div><div class="runs"><input type="range" min="${step}" max="${Math.max(step, left)}" step="${step}" value="${g}" data-field="${field}" ${left < step ? 'disabled' : ''}><span class="num" data-out="${field}">${g}</span></div>
        <p class="desc">我方出賽名單對 ${esc(teamName(v, oppTeam))} 的出賽名單，推進一週後出報告：估計真實勝率，場數越多越準。${scrimWait > 0 ? `<br><small class="wait">${icon('hourglass', 14)}<span data-out="scrim.wait">${scrimWaitText(g, scrimWait)}</span></small>` : ''}</p>
        <div class="go">${btn(left < step ? '這週場數用完了' : '排入練習賽', `data-act="scrim" ${!active || left < step ? 'disabled' : ''}`, '', left < step ? '' : 'QUEUE')}</div></div>
      <div class="pn new in">${pt('03', '本週排程', `${v.jobs.length} 項${queuedScrims > 0 ? ` · 推進時多等${waitText(queuedScrims)}` : ''}`, 'THIS WEEK')}
        <div class="jobs scroll">
          ${group('練習賽', `佔場數 · 已排 ${used}／${cap}`, scrimJobs, 'training', '左邊排')}
          ${group('屬性訓練', `佔時段 · ${trainJobs.length ? `${v.jobs.filter((j) => j.kind === 'train').reduce((s, j) => s + (j.kind === 'train' ? j.sessions : 0), 0)} 節` : '0 節'}`, trainJobs, 'squad', '選手詳情')}
          ${c.tactics.length ? group('戰術排練', `佔時段 · ${v.jobs.filter((j) => j.kind === 'rehearse').reduce((s, j) => s + (j.kind === 'rehearse' ? j.sessions : 0), 0)} 節`, rehearseJobs, 'tactics', '戰術室') : ''}
          ${group('球探', '不佔額度 · 推進一週後回報', scoutJobs, 'market', '轉會市場')}
        </div></div>
      <div class="pn rep in">${pt('04', '報告', '最近的工作成果', 'REPORTS')}
        <div class="cols">
          <div class="col"><h4>${icon('search', 18)}球探報告<small>誤差 ±${e.scoutSd}</small></h4>${intel.length ? intel.map((i) => { const p = ctx.pm.get(i.playerId); const d = p ? i.estPower - p.elo : 0; return `<div class="it" data-act="player" data-pid="${i.playerId}"><b>${esc(p?.name ?? '?')}</b>（${esc(teamName(v, p?.teamId ?? null))}）真實約 <span class="num">${i.estPower}</span>，比評分${d >= 0 ? '高' : '低'} <b>${Math.abs(d)}</b></div>`; }).join('') : '<p class="dim">到轉會市場派球探。</p>'}</div>
          <div class="col"><h4>${icon('swords', 18)}練習賽報告<small>樣本越多越準</small></h4>${scrims.length ? scrims.map((s) => `<div class="it"><b>對 ${esc(teamName(v, s.opponentTeamId))}</b> ${s.games} 場 ${s.wins} 勝：估計勝率 <span class="num">${Math.round((s.wins * 100) / s.games)}%</span> ± ${ci(s.wins, s.games)}%</div>`).join('') : '<p class="dim">還沒有報告。</p>'}</div>
          <div class="col"><h4>${icon('target', 18)}戰術手冊<small>執行熟練度</small></h4>${topTactics.length ? topTactics.map((t) => `<div class="it" data-act="go" data-to="tactics"><b>${esc(t.name)}</b>（${t.side}）執行 <span class="num">${v.me.effective[t.id] ?? 0}</span> · 默契 ${v.me.playbook[t.id] ?? 0}</div>`).join('') : '<p class="dim">這個賽制沒有戰術手冊。</p>'}</div>
        </div></div>
    </section>`;
}

// ───── 賭盤 ─────
export function bettingScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const limit = e.betLimitBase + e.betLimitPerFame * v.me.fame;
  const top = head('BETTING // 賭盤', '賭盤', `莊家抽成 ${e.betMarginPermille / 10}% · 單場上限 <b>${wan(limit)}</b> 萬 · 單注至少 ${wan(e.betMin)} 萬 · 賠率在下注時鎖定 · 自己的比賽只能押自己`);
  if (v.phase !== 'season') return `${top}<section class="body s-betting"><div class="pn board closed in">${pt('01', '本週注單', '', 'ODDS')}<div class="closed-msg">${icon('ticket', 40, 1.4)}<b>${v.phase === 'offseason' ? '賽季開始後才開盤' : '這個賽段結束了'}</b><p>${v.phase === 'offseason' ? '每週可以押比賽勝負；自己的比賽只能押自己，賠率只看公開評分。' : '名次獎金已結算，下個賽季再來。'}</p></div></div></section>`;
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
