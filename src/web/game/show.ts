// 比賽日演出：開場 → 對戰（兩個鏡頭對望，先鋒、中堅、大將逐一揭曉）→ 結果（WIN／LOSE 與這場的收穫）
// → 其他賽場 → 週結算 →（賽段結束時）頒獎典禮或破產。結果在推進時就算好了（確定性），這裡只負責怎麼揭曉。
import type { AdvanceSummary, KnownFixture, KnownPlayer } from '../../manage/index.ts';
import { CATEGORY_NAME, lineageName } from '../manage/format.ts';
import { rankOf, weekBreakdown } from '../club/model.ts';
import { avatarSvg } from '../club/art.ts';
import type { Ctx } from './kit.ts';
import { avatar, crest, crestRing, esc, glyph, icon, teamName, wan } from './kit.ts';

export interface Snapshot {
  cash: number;
  fame: number;
  rank: number;
  week: number;
  elo: Map<string, number>;
}

export function snapshot(ctx: Ctx): Snapshot {
  return { cash: ctx.v.me.cash, fame: ctx.v.me.fame, rank: rankOf(ctx.v, ctx.v.me.teamId), week: ctx.v.week, elo: new Map(ctx.v.players.map((p) => [p.id, p.elo])) };
}

export interface Scene {
  html: string;
  /** 自動進下一幕的毫秒數（0＝等玩家按） */
  auto: number;
  enter?: (root: HTMLElement, speed: number) => void;
  /** 「跳過演出」時停在這一幕 */
  stop?: boolean;
}

/** 數字滾動：data-from、data-to（千元，顯示為萬；data-fmt="int" 顯示整數） */
export function countUps(root: HTMLElement, speed: number): void {
  root.querySelectorAll<HTMLElement>('[data-to]').forEach((el) => {
    const from = Number(el.dataset.from ?? 0);
    const to = Number(el.dataset.to);
    const delay = Number(el.dataset.delay ?? 0) * speed;
    const dur = 900 * speed;
    const fmt = el.dataset.fmt === 'int' ? (n: number): string => String(Math.round(n)) : (n: number): string => wan(Math.round(n));
    el.textContent = fmt(from);
    setTimeout(() => {
      const t0 = performance.now();
      const tick = (now: number): void => {
        const k = Math.min(1, (now - t0) / dur);
        el.textContent = fmt(from + (to - from) * (1 - (1 - k) ** 3));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delay);
  });
}

const SLOT = ['先鋒', '中堅', '大將'];
const SLOT_EN = ['VANGUARD', 'CENTER', 'CAPTAIN'];

function stageName(f: KnownFixture): string {
  return f.stage === 'regular' ? `例行賽 · 第 ${f.week} 週` : f.stage === 'semi' ? '季後賽 · 準決賽' : f.stage === 'final' ? '季後賽 · 決賽' : '季後賽 · 季軍戰';
}

function lens(ctx: Ctx, p: KnownPlayer | undefined, foe: boolean): string {
  return `<div class="ln2 ${foe ? 'foe' : ''}"><svg viewBox="0 0 410 410"><circle cx="205" cy="205" r="196" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2" stroke-dasharray="3 8"/><g class="sp"><circle cx="205" cy="205" r="196" fill="none" stroke="${foe ? '#ff5d5d' : '#f0b54a'}" stroke-width="4" stroke-dasharray="180 1052"/></g></svg>
    <div class="lens tinted ${foe ? 'grey' : ''}">${p ? avatarSvg(p.id + p.name, '#3a4458', 350) : ''}</div></div>`;
}

function matchScene(ctx: Ctx, f: KnownFixture, before: Snapshot): Scene {
  const { v } = ctx;
  const me = v.me.teamId;
  const home = f.home === me;
  const opp = home ? f.away : f.home;
  const s = f.score as { home: number; away: number };
  const slots = f.slots.map((x) => ({ mine: home ? x.home : x.away, theirs: home ? x.away : x.home, won: x.winner === 'draw' ? null : (x.winner === 'a') === home }));
  const de = (id: string): string => {
    const b = before.elo.get(id);
    const a = ctx.pm.get(id)?.elo;
    return b === undefined || a === undefined || a === b ? '' : `${a > b ? '+' : ''}${a - b}`;
  };
  const sides = slots
    .map((x, i) => {
      const pm = ctx.pm.get(x.mine);
      const pt = ctx.pm.get(x.theirs);
      return `<div class="duel" data-bout="${i}">
        <div class="side l">${lens(ctx, pm, false)}<div class="nm">${esc(pm?.name ?? '?')}</div><div class="inf">${pm ? `${glyph(pm.lineageId, 16)}${esc(lineageName(ctx.c, pm.lineageId))} · v${pm.version} · <span class="num">${before.elo.get(pm.id) ?? pm.elo}</span>` : ''}</div></div>
        <div class="mid"><span class="rd2">BOUT 0${i + 1} · ${SLOT_EN[i]}</span><h2>${SLOT[i]}戰</h2><span class="vs">VS</span><div class="st"><i></i>對戰中</div>
          <span class="stamp big ${x.won ? 'w' : 'l'}">${x.won === null ? 'DRAW' : x.won ? 'WIN' : 'LOSE'}</span></div>
        <div class="side r">${lens(ctx, pt, true)}<div class="nm">${esc(pt?.name ?? '?')}</div><div class="inf">${pt ? `${glyph(pt.lineageId, 16)}${esc(lineageName(ctx.c, pt.lineageId))} · v${pt.version} · <span class="num">${before.elo.get(pt.id) ?? pt.elo}</span>` : ''}</div></div></div>`;
    })
    .join('');
  const strips = slots
    .map((x, i) => {
      const pm = ctx.pm.get(x.mine);
      const pt = ctx.pm.get(x.theirs);
      return `<div class="bt2" data-strip="${i}">${avatar(ctx, pm, 50)}<span class="c"><small>0${i + 1} ${SLOT[i]}</small><b>${esc(pm?.name ?? '?')}<i>vs</i><span class="hide">？？？</span><span class="reveal">${esc(pt?.name ?? '?')}</span></b><em class="elo">${de(x.mine)}</em></span><span class="foeav">${avatar(ctx, pt, 50)}</span><span class="stamp ${x.won ? 'w' : 'l'}">${x.won === null ? 'DRAW' : x.won ? 'WIN' : 'LOSE'}</span></div>`;
    })
    .join('');
  const BOUT = 2.6;
  return {
    html: `<div class="md md-match"><div class="hud"><span>${stageName(f)} <b>//</b> 中央競技場</span><span class="live"><i></i>LIVE · 三場對位，勝場多的隊伍獲勝</span></div>
      <div class="score">${crestRing(ctx, me, 84)}<b class="tn">${esc(teamName(v, me))}</b><div class="sc"><span class="num me" data-sc="me">0</span><i>:</i><span class="num" data-sc="opp">0</span></div><b class="tn rd">${esc(teamName(v, opp))}</b>${crestRing(ctx, opp, 84, opp)}</div>
      <div class="duels">${sides}</div><div class="bouts">${strips}</div>
      <div class="final-score" hidden>${s.home}:${s.away}</div></div>`,
    auto: (slots.length * BOUT + 1.4) * 1000,
    enter: (root, speed) => {
      let a = 0;
      let b = 0;
      const show = (i: number): void => {
        root.querySelectorAll('.duel').forEach((d, k) => d.classList.toggle('on', k === i));
        root.querySelector(`[data-strip="${i}"]`)?.classList.add('now');
      };
      show(0);
      slots.forEach((x, i) => {
        setTimeout(() => {
          root.querySelector(`.duel[data-bout="${i}"]`)?.classList.add('done');
          const st = root.querySelector(`[data-strip="${i}"]`);
          st?.classList.remove('now');
          st?.classList.add('done', x.won ? 'won' : 'lost');
          if (x.won === true) a++;
          else if (x.won === false) b++;
          const ea = root.querySelector('[data-sc=me]');
          const eb = root.querySelector('[data-sc=opp]');
          if (ea) ea.textContent = String(a);
          if (eb) eb.textContent = String(b);
          const sc = root.querySelector('.sc');
          sc?.classList.remove('bump');
          void (sc as HTMLElement | null)?.offsetWidth;
          sc?.classList.add('bump');
        }, (i * BOUT + 1.7) * 1000 * speed);
        if (i + 1 < slots.length) setTimeout(() => show(i + 1), ((i + 1) * BOUT) * 1000 * speed);
      });
    },
  };
}

function resultScene(ctx: Ctx, f: KnownFixture, before: Snapshot, summaryWeek: number): Scene {
  const { v, c } = ctx;
  const e = c.economy;
  const me = v.me.teamId;
  const home = f.home === me;
  const opp = home ? f.away : f.home;
  const s = f.score as { home: number; away: number };
  const my = home ? s.home : s.away;
  const their = home ? s.away : s.home;
  const res = my > their ? 'win' : my < their ? 'lose' : 'draw';
  const slots = f.slots.map((x) => ({ mine: home ? x.home : x.away, theirs: home ? x.away : x.home, won: x.winner === 'draw' ? null : (x.winner === 'a') === home }));
  const prize = v.ledger.filter((x) => x.week === summaryWeek && x.category === 'prize').reduce((t, x) => t + x.amount, 0);
  const bets = v.ledger.filter((x) => x.week === summaryWeek && x.category === 'bet' && x.amount > 0).reduce((t, x) => t + x.amount, 0);
  const rows = slots
    .map((x, i) => {
      const pm = ctx.pm.get(x.mine);
      const pt = ctx.pm.get(x.theirs);
      const b = before.elo.get(x.mine);
      const d = pm && b !== undefined ? pm.elo - b : 0;
      return `<div class="bt3 ${x.won ? 'w' : 'l'}" style="--d:${0.5 + i * 0.08}s">${avatar(ctx, pm, 54)}<span class="c"><small>0${i + 1} ${SLOT[i]}</small><b>${esc(pm?.name ?? '?')}<i>vs</i>${esc(pt?.name ?? '?')}</b><em class="${d >= 0 ? 'up' : 'dn'}">${d ? `${d > 0 ? '+' : ''}${d}` : ''}</em></span>${avatar(ctx, pt, 54)}<span class="stamp ${x.won ? 'w' : 'l'}">${x.won === null ? 'DRAW' : x.won ? 'WIN' : 'LOSE'}</span></div>`;
    })
    .join('');
  const fameD = v.me.fame - before.fame;
  return {
    html: `<div class="md md-result ${res}"><div class="flare"></div><div class="hud"><span>${stageName(f)} <b>//</b> 中央競技場</span><span>FINAL</span></div>
      <section class="big"><span class="huge">${res === 'win' ? 'WIN' : res === 'lose' ? 'LOSE' : 'DRAW'}</span><span class="zh">${res === 'win' ? '勝利' : res === 'lose' ? '落敗' : '平手'}</span></section>
      <section class="vsrow"><div class="t">${crestRing(ctx, me, 80)}${esc(teamName(v, me))}</div><div class="sc"><b>${my}</b><i>:</i>${their}</div><div class="t r">${crestRing(ctx, opp, 80, opp)}<span class="rd">${esc(teamName(v, opp))}</span></div></section>
      <section class="bouts">${rows}</section>
      <section class="gains">
        <div class="gn ${prize > 0 ? 'g' : ''}"><small>比賽收入</small><div class="v"><span class="num up">+${wan(prize)}</span><span>萬</span></div><p>${res === 'win' ? `勝 ${wan(e.matchWinPrize)}` : `${res === 'lose' ? '敗' : '平'} ${wan(e.matchLossPrize)}`} ＋ 對位勝 ${slots.filter((x) => x.won).length} 場 × ${wan(e.slotWinBonus)}</p></div>
        <div class="gn ${bets > 0 ? 'g' : ''}"><small>下注開獎</small><div class="v"><span class="num ${bets > 0 ? 'up' : ''}">${bets > 0 ? `+${wan(bets)}` : '0'}</span><span>萬</span></div><p>${bets > 0 ? '押中的彩券已入帳' : '這週沒有押中'}</p></div>
        <div class="gn"><small>名氣</small><div class="v"><span class="num">${before.fame}</span><span>→</span><span class="num ${fameD >= 0 ? 'up' : ''}">${v.me.fame}</span></div><p>每週贊助 ${wan(v.me.weeklySponsor)} 萬</p></div>
        <div class="gn"><small>名次</small><div class="v"><span class="num">${before.rank || '—'}</span><span>→</span><span class="num up">${rankOf(v, me)}</span></div><p>${f.stage === 'regular' ? '例行賽積分榜' : '季後賽'}</p></div>
      </section>
      <div class="ctl"><button class="btn" data-act="cine-next"><b>繼續</b><span>NEXT</span></button></div></div>`,
    auto: 0,
  };
}

function othersScene(ctx: Ctx, fixtures: KnownFixture[], title: string): Scene {
  const { v } = ctx;
  const rows = fixtures
    .map((f, i) => {
      const s = f.score as { home: number; away: number };
      return `<div class="og" style="--d:${0.2 + i * 0.15}s"><span class="t ${s.home > s.away ? 'wn' : 'ls'}">${crest(ctx, f.home, 30, null)}${esc(teamName(v, f.home))}</span><span class="s">${s.home}:${s.away}</span><span class="t r ${s.away > s.home ? 'wn' : 'ls'}">${crest(ctx, f.away, 30, null)}${esc(teamName(v, f.away))}</span></div>`;
    })
    .join('');
  return { html: `<div class="md md-others"><div class="hd2"><span class="en">OTHER RESULTS</span><h1>${title}</h1></div><div class="list">${rows}</div><div class="tap">點畫面繼續</div></div>`, auto: (0.6 + fixtures.length * 0.15 + 2) * 1000 };
}

function settleScene(ctx: Ctx, summary: AdvanceSummary, before: Snapshot, last: boolean): Scene {
  const { v } = ctx;
  const items = weekBreakdown(v, summary.week).sort((a, b) => b.amount - a.amount);
  const total = items.reduce((s, x) => s + x.amount, 0);
  const rankNow = rankOf(v, v.me.teamId);
  const rankD = before.rank > 0 && summary.week <= 7 ? before.rank - rankNow : 0;
  const fameD = v.me.fame - before.fame;
  const reports = v.inbox.filter((m) => m.week === summary.week && m.kind === 'report').slice(0, 4);
  const runway = v.me.runwayWeeks;
  return {
    html: `<div class="md md-week"><div class="hd2"><span class="en">WEEKLY REPORT // ${summary.week === 0 ? '開幕前結算' : '週結算'}</span><h1><span class="num">${summary.week === 0 ? 'PRE' : `W${String(summary.week).padStart(2, '0')}`}</span>${summary.week === 0 ? '開幕前結算' : '週結算'}</h1></div>
      <section class="pn g money">${'<div class="pt"><span class="no">01</span><b>現金</b><span class="aux">本週淨額 <b class="num">' + (total >= 0 ? '+' : '−') + wan(Math.abs(total)) + '</b></span></div>'}
        <div class="big"><span class="from">${wan(before.cash)}</span><span class="to ${v.me.cash < 0 ? 'rd' : ''}" data-from="${before.cash}" data-to="${v.me.cash}" data-delay="300">${wan(v.me.cash)}</span><em>萬</em></div>
        <div class="delta ${total < 0 ? 'rd' : ''}">${total >= 0 ? '▲ +' : '▼ −'}${wan(Math.abs(total))} 萬</div>
        <div class="lines">${items.map((x, i) => `<div class="ln" style="--d:${0.2 + i * 0.1}s"><span>${CATEGORY_NAME[x.cat]}</span><span class="num ${x.amount < 0 ? 'n' : 'p'}">${x.amount >= 0 ? '+' : '−'}${wan(Math.abs(x.amount))}</span></div>`).join('') || '<p class="dim">這週沒有收支。</p>'}</div></section>
      <section class="rank">${summary.week >= 1 && summary.week <= 7 && rankNow > 0 ? `<span class="lb">積分榜名次</span><div class="rk2"><svg viewBox="0 0 340 340"><circle cx="170" cy="170" r="160" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="2"/><g class="sp"><circle cx="170" cy="170" r="160" fill="none" stroke="#f0b54a" stroke-width="3" stroke-dasharray="40 30 4 30"/></g><circle cx="170" cy="170" r="140" fill="none" stroke="rgba(240,181,74,.25)" stroke-width="10"/></svg>
          <div class="v">${before.rank && before.rank !== rankNow ? `<span class="from">#${before.rank}</span>` : ''}${rankD ? `<span class="arrow ${rankD > 0 ? '' : 'dn'}">${icon(rankD > 0 ? 'up' : 'down', 34)}</span>` : ''}<span class="to">${rankNow}</span><small>第 ${rankNow} 名${rankD > 0 ? ` · ▲${rankD}` : rankD < 0 ? ` · ▼${-rankD}` : ''}</small></div></div>` : `<span class="lb">${summary.week === 0 ? '賽季開幕' : '季後賽'}</span>`}
        <div class="row3"><div><small>名氣</small><span class="num">${before.fame} → <span class="${fameD >= 0 ? 'gd2' : 'rd'}">${v.me.fame}</span></span></div><div><small>資金跑道</small><span class="num ${runway !== null && runway < 3 ? 'rd' : ''}">${runway === null ? '∞' : `${runway} 週`}</span></div></div></section>
      <section class="pn mail">${'<div class="pt"><span class="no">02</span><b>新報告</b><span class="aux">已寄到信件</span></div>'}${reports.length ? reports.map((m, i) => `<div class="env" style="--d:${0.6 + i * 0.12}s"><span class="ic2">${icon('flask', 22)}</span><span>${esc(m.text)}</span></div>`).join('') : '<p class="dim">這週沒有新報告。</p>'}</section>
      <div class="ctl"><button class="btn" data-act="cine-next"><b>${last ? '繼續' : '回到基地'}</b><span>${last ? 'NEXT' : 'BASE'}</span></button></div></div>`,
    auto: 0,
    stop: true,
    enter: countUps,
  };
}

function ceremonyScene(ctx: Ctx): Scene {
  const { v, c } = ctx;
  const ranks = v.seasonResult?.ranks ?? [];
  const my = v.seasonResult?.humanRank ?? 0;
  const prize = c.economy.seasonPrizes[my - 1] ?? 0;
  const pod = (i: number, cls: string, box: number): string =>
    ranks[i] ? `<div class="pod ${cls} ${ranks[i] === v.me.teamId ? 'me' : ''}">${ranks[i] === v.me.teamId ? `<span class="tag2">${esc(v.me.name)} · ${['冠軍', '亞軍', '季軍'][i]}</span>` : ''}${crestRing(ctx, ranks[i], box, null)}<span class="nm">${esc(teamName(v, ranks[i]))}</span><div class="blk"><span class="num">${i + 1}</span></div><div class="prize">${['冠軍', '亞軍', '季軍'][i]} <span class="num">${wan(c.economy.seasonPrizes[i])}</span> 萬</div></div>` : '';
  const wins = v.fixtures.filter((f) => f.score && (f.home === v.me.teamId || f.away === v.me.teamId));
  const w = wins.filter((f) => { const s = f.score as { home: number; away: number }; return f.home === v.me.teamId ? s.home > s.away : s.away > s.home; }).length;
  return {
    html: `<div class="md md-season"><i class="spot" style="left:640px"></i><i class="spot" style="left:290px;opacity:.6"></i><i class="spot" style="left:950px;opacity:.6"></i><canvas class="confetti" width="1920" height="1080"></canvas>
      <div class="title"><div class="en">SEASON OVER // AWARD CEREMONY</div><h1>頒獎典禮</h1></div>
      <section class="stage3">${pod(1, 'p2', 110)}${pod(0, 'p1', 130)}${pod(2, 'p3', 110)}</section>
      <section class="side2 l"><div class="kv2 g"><small>最終名次</small><span class="num gd">#${my}</span></div><div class="kv2"><small>戰績</small><span class="num">${w}-${wins.length - w}</span></div><div class="kv2"><small>名氣</small><span class="num">${v.me.fame}</span></div></section>
      <section class="side2 r"><div class="kv2 g"><small>名次獎金</small><span class="num">${wan(prize)}</span> <span>萬</span></div><div class="kv2"><small>期末現金</small><span class="num">${wan(v.me.cash)}</span> <span>萬</span></div></section>
      <div class="ctl"><button class="btn ghost lg" data-act="cine-next"><b>回基地看紀錄</b></button><button class="btn lg" data-act="new-season"><b>新的賽季</b><span>NEW SEASON</span></button></div></div>`,
    auto: 0,
    stop: true,
    enter: (root) => confetti(root.querySelector('canvas.confetti') as HTMLCanvasElement | null),
  };
}

function confetti(cv: HTMLCanvasElement | null): void {
  if (!cv) return;
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  const ps = Array.from({ length: 140 }, (_, i) => ({ x: (i * 397) % 1920, y: ((i * 211) % 1300) - 200, v: 0.8 + ((i * 7) % 10) / 6, w: 6 + (i % 5) * 2, a: i, c: i % 3 ? '#f0b54a' : '#eef2f6' }));
  const t0 = performance.now();
  const tick = (now: number): void => {
    if (!cv.isConnected) return;
    const t = (now - t0) / 1000;
    g.clearRect(0, 0, 1920, 1080);
    for (const p of ps) {
      g.save();
      g.translate(p.x + Math.sin(t * 0.8 + p.a) * 30, ((p.y + t * 60 * p.v) % 1300) - 120);
      g.rotate(t * p.v + p.a);
      g.scale(1, Math.abs(Math.sin(t * 2 * p.v + p.a)));
      g.fillStyle = p.c;
      g.globalAlpha = 0.85;
      g.fillRect(-p.w / 2, -3, p.w, 6);
      g.restore();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function bankruptScene(ctx: Ctx): Scene {
  const { v } = ctx;
  const totals = new Map<string, number>();
  for (const x of v.ledger) totals.set(x.category, (totals.get(x.category) ?? 0) + x.amount);
  const cats = [...totals.entries()].sort((a, b) => a[1] - b[1]);
  const max = Math.max(1, ...cats.map(([, a]) => Math.abs(a)));
  const spent = v.ledger.reduce((s, x) => s + x.amount, 0);
  return {
    html: `<div class="md md-broke"><div class="redwash"></div><div class="hud2">W${String(v.week).padStart(2, '0')} 結算 // 現金低於 0 // 戰隊解散</div>
      <section class="wreck">${crestRing(ctx, v.me.teamId, 300)}<span class="stamp huge">BANKRUPT</span><h1>破產</h1><p>現金跌到 <b>${wan(v.me.cash)} 萬</b>。<br>贊助商撤資，選手合約全部終止，${esc(v.me.name)}解散。</p></section>
      <section class="pn r why">${'<div class="pt"><span class="no">POSTMORTEM</span><b>錢去哪裡了</b><span class="aux">這個賽段</span></div>'}<div class="big"><span class="num">${spent >= 0 ? '+' : '−'}${wan(Math.abs(spent))}</span><span>萬，${v.week} 週</span></div>
        ${cats.map(([k, a]) => `<div class="ct"><span>${CATEGORY_NAME[k as keyof typeof CATEGORY_NAME] ?? k}</span><span class="bar"><i class="${a >= 0 ? 'p' : ''}" style="width:${Math.round((Math.abs(a) / max) * 100)}%"></i></span><span class="num ${a < 0 ? 'rd' : ''}">${a >= 0 ? '+' : '−'}${wan(Math.abs(a))}</span></div>`).join('')}
        <div class="tip">平衡測試裡，簽滿 5 人又升級訓練中心，有八成會破產；適度投資（補 1 人、小額下注）比較穩。</div></section>
      <div class="ctl"><button class="btn ghost" data-act="cine-next"><b>看看哪裡出錯</b></button><button class="btn" data-act="new-season"><b>重新創立戰隊</b><span>NEW TEAM</span></button></div></div>`,
    auto: 0,
    stop: true,
  };
}

export function buildScenes(ctx: Ctx, summary: AdvanceSummary, before: Snapshot, wasOffseason: boolean): Scene[] {
  const { v } = ctx;
  const scenes: Scene[] = [];
  const over = v.phase === 'ended' || v.phase === 'bankrupt';
  if (wasOffseason) {
    scenes.push({
      html: `<div class="md md-open"><div class="flare"></div>${crestRing(ctx, v.me.teamId, 220)}<span class="en">SEASON 01 // KICK OFF</span><h1>賽季開幕</h1><p>新創聯賽 · 8 支戰隊 · 例行賽 7 週 · 前 4 名進季後賽</p>
        <div class="ctl"><button class="btn lg" data-act="cine-next"><b>出發</b><span>GO</span></button></div></div>`,
      auto: 0,
      stop: true,
    });
    scenes.push(settleScene(ctx, summary, before, over));
    if (v.phase === 'bankrupt') scenes.push(bankruptScene(ctx));
    return scenes;
  }
  const ids = new Set(summary.results.map((r) => r.fixtureId));
  const fixtures = v.fixtures.filter((f) => ids.has(f.id));
  const mine = fixtures.find((f) => f.home === v.me.teamId || f.away === v.me.teamId);
  const label = summary.week <= 7 ? `第 ${summary.week} 週` : summary.week === 8 ? '準決賽' : '決賽';
  scenes.push({ html: `<div class="md md-splash"><span class="en">MATCH DAY</span><h1>比賽日</h1><p>${label}${mine ? ` · ${esc(teamName(v, mine.home))} VS ${esc(teamName(v, mine.away))}` : ''}</p></div>`, auto: 1600 });
  if (mine) {
    scenes.push(matchScene(ctx, mine, before));
    scenes.push(resultScene(ctx, mine, before, summary.week));
  }
  const others = fixtures.filter((f) => f !== mine);
  if (others.length) scenes.push(othersScene(ctx, others, mine ? '其他賽場' : `${label}戰果`));
  scenes.push(settleScene(ctx, summary, before, over));
  if (v.phase === 'bankrupt') scenes.push(bankruptScene(ctx));
  else if (v.phase === 'ended') scenes.push(ceremonyScene(ctx));
  return scenes;
}
