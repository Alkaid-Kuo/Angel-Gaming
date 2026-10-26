// 比賽日演出：開場 → 對戰（先鋒、中堅、大將逐一揭曉）→ 全聯盟戰果 → 週結算 →（賽季結束時）頒獎典禮或破產。
// 結果在推進時就已算好（確定性），這裡只負責「怎麼揭曉」。
import type { AdvanceSummary, KnownFixture } from '../../manage/index.ts';
import { CATEGORY_NAME, esc, wan } from '../manage/format.ts';
import { SLOT_NAMES, icon } from './art.ts';
import { coin, crest, miniCard, signedCoin } from './cards.ts';
import type { Ctx } from './model.ts';
import { rankOf, teamName, weekBreakdown } from './model.ts';

export interface Snapshot {
  cash: number;
  fame: number;
  rank: number;
  week: number;
  elo: Map<string, number>;
}

export function snapshot(ctx: Ctx): Snapshot {
  return {
    cash: ctx.v.me.cash,
    fame: ctx.v.me.fame,
    rank: rankOf(ctx.v, ctx.v.me.teamId),
    week: ctx.v.week,
    elo: new Map(ctx.v.players.map((p) => [p.id, p.elo])),
  };
}

export interface Scene {
  html: string;
  /** 自動進下一幕的毫秒數（0＝等玩家按） */
  auto: number;
  /** 插入畫面後要跑的動畫（計分、數字滾動） */
  enter?: (root: HTMLElement, speed: number) => void;
  /** 「跳過演出」時停在這一幕 */
  stop?: boolean;
}

/** 數字滾動：data-from、data-to（千元，顯示為萬） */
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
        const eased = 1 - (1 - k) * (1 - k) * (1 - k);
        el.textContent = fmt(from + (to - from) * eased);
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delay);
  });
}

function stageName(f: KnownFixture): string {
  return f.stage === 'regular' ? `例行賽 第 ${f.week} 週` : f.stage === 'semi' ? '季後賽・準決賽' : f.stage === 'final' ? '總決賽' : '季軍戰';
}

function matchScene(ctx: Ctx, f: KnownFixture, before: Snapshot): Scene {
  const me = ctx.v.me.teamId;
  const home = f.home === me;
  const opp = home ? f.away : f.home;
  const s = f.score as { home: number; away: number };
  const myScore = home ? s.home : s.away;
  const oppScore = home ? s.away : s.home;
  const result = myScore > oppScore ? 'win' : myScore < oppScore ? 'lose' : 'draw';
  const slots = f.slots.map((x) => {
    const mine = home ? x.home : x.away;
    const theirs = home ? x.away : x.home;
    const won = x.winner === 'draw' ? null : (x.winner === 'a') === home;
    return { mine, theirs, won };
  });
  const T0 = 1.1;
  const GAP = 1.35;
  const rows = slots
    .map((x, i) => {
      const d = T0 + i * GAP;
      const pm = ctx.pm.get(x.mine);
      const pt = ctx.pm.get(x.theirs);
      const de = (id: string): string => {
        const b = before.elo.get(id);
        const a = ctx.pm.get(id)?.elo;
        if (b === undefined || a === undefined || a === b) return '';
        return `<i class="elo ${a > b ? 'up' : 'dn'}">${a > b ? '+' : ''}${a - b}</i>`;
      };
      return `<div class="md-slot" style="--d:${d}s"><span class="md-sl">${SLOT_NAMES[i]}</span>
        <div class="md-p l ${x.won === true ? 'won' : x.won === false ? 'lost' : ''}">${miniCard(ctx, pm, de(x.mine))}</div>
        <div class="md-clash"><span class="md-stamp ${x.won === true ? 'win' : x.won === false ? 'lose' : 'draw'}" style="--d:${d + 0.55}s">${x.won === true ? 'WIN' : x.won === false ? 'LOSE' : 'DRAW'}</span>${icon('swords', 26)}</div>
        <div class="md-p r ${x.won === false ? 'won' : x.won === true ? 'lost' : ''}">${miniCard(ctx, pt, de(x.theirs))}</div></div>`;
    })
    .join('');
  const tEnd = T0 + slots.length * GAP + 0.3;
  const html = `<div class="md md-match ${result}">
    <div class="md-stage">${stageName(f)}</div>
    <div class="md-vs"><div class="md-team">${crest(ctx, me, 104)}<b>${esc(teamName(ctx, me))}</b></div>
      <div class="md-score"><b data-sc="me">0</b><em>:</em><b data-sc="opp">0</b></div>
      <div class="md-team">${crest(ctx, opp, 104)}<b>${esc(teamName(ctx, opp))}</b></div></div>
    <div class="md-slots">${rows}</div>
    <div class="md-final" style="--d:${tEnd}s"><span>${result === 'win' ? '勝利！' : result === 'lose' ? '落敗' : '平手'}</span></div></div>`;
  return {
    html,
    auto: (tEnd + 2.2) * 1000,
    enter: (root, speed) => {
      let a = 0;
      let b = 0;
      slots.forEach((x, i) => {
        setTimeout(
          () => {
            if (x.won === true) a++;
            else if (x.won === false) b++;
            const ea = root.querySelector('[data-sc=me]');
            const eb = root.querySelector('[data-sc=opp]');
            if (ea) ea.textContent = String(a);
            if (eb) eb.textContent = String(b);
            root.querySelector('.md-score')?.classList.remove('bump');
            void (root.querySelector('.md-score') as HTMLElement | null)?.offsetWidth;
            root.querySelector('.md-score')?.classList.add('bump');
          },
          (T0 + i * GAP + 0.55) * 1000 * speed,
        );
      });
    },
  };
}

function leagueScene(ctx: Ctx, fixtures: KnownFixture[], title: string): Scene {
  const me = ctx.v.me.teamId;
  const rows = fixtures
    .map((f, i) => {
      const s = f.score as { home: number; away: number };
      const mine = f.home === me || f.away === me;
      return `<div class="md-res ${mine ? 'mine' : ''}" style="--d:${0.25 + i * 0.22}s"><span class="t ${s.home > s.away ? 'w' : ''}">${esc(teamName(ctx, f.home))}${crest(ctx, f.home, 28)}</span><b>${s.home}<em>:</em>${s.away}</b><span class="t r ${s.away > s.home ? 'w' : ''}">${crest(ctx, f.away, 28)}${esc(teamName(ctx, f.away))}</span></div>`;
    })
    .join('');
  return { html: `<div class="md md-league"><h2>${icon('trophy', 24)}${title}</h2><div class="md-reslist">${rows}</div></div>`, auto: (0.6 + fixtures.length * 0.22 + 1.8) * 1000 };
}

function settleScene(ctx: Ctx, summary: AdvanceSummary, before: Snapshot, last: boolean): Scene {
  const { v } = ctx;
  const items = weekBreakdown(v, summary.week).sort((a, b) => b.amount - a.amount);
  const total = items.reduce((s, x) => s + x.amount, 0);
  const rankNow = rankOf(v, v.me.teamId);
  const rankDelta = before.rank > 0 && summary.week <= 7 ? before.rank - rankNow : 0;
  const fameDelta = v.me.fame - before.fame;
  const reports = v.inbox.filter((m) => m.week === summary.week && m.kind === 'report');
  const rows = items
    .map((x, i) => `<div class="st-row" style="--d:${0.2 + i * 0.12}s"><span>${CATEGORY_NAME[x.cat]}</span>${signedCoin(x.amount)}</div>`)
    .join('');
  const html = `<div class="md md-settle"><h2>${icon('coins', 24)}${summary.week === 0 ? '開幕前結算' : `第 ${summary.week} 週結算`}</h2>
    <div class="st-grid"><div class="st-list">${rows || '<p class="empty-note">這週沒有收支</p>'}<div class="st-total"><span>本週淨額</span>${signedCoin(total)}</div></div>
      <div class="st-side"><div class="st-cash"><span>現金</span><span class="coin xxl ${v.me.cash < 0 ? 'neg' : ''}">${icon('coins', 22)}<b data-from="${before.cash}" data-to="${v.me.cash}" data-delay="300">${wan(v.me.cash)}</b><small>萬</small></span></div>
        <div class="st-chips">${summary.week >= 1 && summary.week <= 7 && rankNow > 0 ? `<span class="chip big">${icon('trophy', 14)}第 ${rankNow} 名${rankDelta > 0 ? `<i class="up">▲${rankDelta}</i>` : rankDelta < 0 ? `<i class="dn">▼${-rankDelta}</i>` : ''}</span>` : ''}
          ${fameDelta ? `<span class="chip big">${icon('star', 14)}名氣 ${v.me.fame}<i class="${fameDelta > 0 ? 'up' : 'dn'}">${fameDelta > 0 ? '+' : ''}${fameDelta}</i></span>` : ''}</div></div></div>
    ${reports.length ? `<div class="st-reports"><h3>${icon('mail', 16)}新報告</h3>${reports.map((m, i) => `<div class="st-rep" style="--d:${0.6 + i * 0.15}s">${esc(m.text)}</div>`).join('')}</div>` : ''}
    <div class="md-btns"><button class="btn-main glow" data-act="cine-next">${last ? `${icon('play', 16)}繼續` : `${icon('home', 16)}回到基地`}</button></div></div>`;
  return { html, auto: 0, stop: true, enter: countUps };
}

function ceremonyScene(ctx: Ctx): Scene {
  const { v, c } = ctx;
  const ranks = v.seasonResult?.ranks ?? [];
  const my = v.seasonResult?.humanRank ?? 0;
  const pod = (i: number): string => (ranks[i] ? `<div class="pod p${i + 1} ${ranks[i] === v.me.teamId ? 'me' : ''}" style="--d:${[1.4, 2.2, 0.8][i]}s">${crest(ctx, ranks[i], i === 0 ? 96 : 76)}<b>${esc(teamName(ctx, ranks[i]))}</b><div class="pod-base"><span>${i + 1}</span></div></div>` : '');
  const prize = c.economy.seasonPrizes[my - 1] ?? 0;
  return {
    html: `<div class="md md-cere"><div class="cere-rays"></div><h1>${icon('crown', 34)}賽季頒獎典禮</h1>
      <div class="podium">${pod(1)}${pod(0)}${pod(2)}</div>
      <div class="cere-me" style="--d:3s"><span>${esc(teamName(ctx, v.me.teamId))}</span><b>最終第 ${my} 名</b><span>名次獎金 ${coin(prize)}　期末現金 ${coin(v.me.cash)}</span></div>
      <div class="md-btns" style="--d:3.4s"><button class="btn-main glow" data-act="new-season">${icon('play', 16)}新的賽季</button><button class="btn-sub" data-act="cine-next">回基地看紀錄</button></div></div>`,
    auto: 0,
    stop: true,
  };
}

function bankruptScene(ctx: Ctx): Scene {
  const { v } = ctx;
  return {
    html: `<div class="md md-over"><div class="over-crack"></div><h1>破產</h1><p>${esc(teamName(ctx, v.me.teamId))} 的現金跌到 <b>${wan(v.me.cash)} 萬</b>，公司撐不下去了。</p>
      <p class="fine">撐了 ${v.week} 週。下次試試少簽一點、慢一點升級，或多靠情報賺錢。</p>
      <div class="md-btns"><button class="btn-main glow" data-act="new-season">${icon('play', 16)}重新創業</button><button class="btn-sub" data-act="cine-next">看看哪裡出錯</button></div></div>`,
    auto: 0,
    stop: true,
  };
}

export function buildScenes(ctx: Ctx, summary: AdvanceSummary, before: Snapshot, wasOffseason: boolean): Scene[] {
  const { v } = ctx;
  const scenes: Scene[] = [];
  const over = v.phase === 'ended' || v.phase === 'bankrupt';
  if (wasOffseason) {
    const reports = v.inbox.filter((m) => m.week === 0 && m.kind === 'report');
    scenes.push({
      html: `<div class="md md-open"><div class="open-burst"></div>${crest(ctx, v.me.teamId, 140)}<h1>賽季開幕</h1><p>新創聯賽・8 支戰隊・例行賽 7 週</p>
        ${reports.length ? `<div class="st-reports"><h3>${icon('mail', 16)}季前報告</h3>${reports.map((m, i) => `<div class="st-rep" style="--d:${1 + i * 0.15}s">${esc(m.text)}</div>`).join('')}</div>` : ''}
        <div class="md-btns" style="--d:1.2s"><button class="btn-main glow" data-act="cine-next">${icon('play', 16)}出發</button></div></div>`,
      auto: 0,
      stop: true,
    });
    return scenes;
  }
  const ids = new Set(summary.results.map((r) => r.fixtureId));
  const fixtures = v.fixtures.filter((f) => ids.has(f.id));
  const mine = fixtures.find((f) => f.home === v.me.teamId || f.away === v.me.teamId);
  const label = summary.week <= 7 ? `第 ${summary.week} 週` : summary.week === 8 ? '準決賽' : '總決賽';
  scenes.push({ html: `<div class="md md-splash"><span>MATCH DAY</span><h1>比賽日</h1><p>${label}</p></div>`, auto: 1500 });
  if (mine) scenes.push(matchScene(ctx, mine, before));
  const others = fixtures.filter((f) => f !== mine);
  if (others.length) scenes.push(leagueScene(ctx, others, mine ? '其他賽場' : `${label}戰果`));
  scenes.push(settleScene(ctx, summary, before, over));
  if (v.phase === 'bankrupt') scenes.push(bankruptScene(ctx));
  else if (v.phase === 'ended') scenes.push(ceremonyScene(ctx));
  return scenes;
}
