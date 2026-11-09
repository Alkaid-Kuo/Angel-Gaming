// 檔案室（2026-11-07 UI 審核 #8）：已打完的比賽都在這裡回看。流程裡（結果幕、聯賽頁）不再有「觀戰」，回放只從這裡開，走既有的 watch 路徑。
// 只讀已知層：我方的比賽有我方每回合打的戰術（tactic 只給我方那一半），別隊之間的比賽只有比分與雙方名單，沒有任何隱藏層欄位。
import type { KnownFixture } from '../../manage/index.ts';
import type { Ctx } from './kit.ts';
import { crest, esc, head, icon, pt, teamName } from './kit.ts';

/** 週次短標：W01…W07、準決、決賽、季軍 */
function weekTag(f: KnownFixture): string {
  if (f.stage === 'semi') return '準決';
  if (f.stage === 'final') return '決賽';
  if (f.stage === 'third') return '季軍';
  return `W${String(f.week).padStart(2, '0')}`;
}

/** 我方這場最常打的戰術（最多 3 個，照回合數排）；別隊的比賽沒有資料 */
function tacticTags(ctx: Ctx, f: KnownFixture): string {
  const rounds = f.match?.rounds ?? [];
  const count = new Map<string, number>();
  for (const r of rounds) if (r.tactic) count.set(r.tactic, (count.get(r.tactic) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!top.length) return '<span class="dim2">—</span>';
  return top
    .map(([id, n]) => {
      const t = ctx.c.tactics.find((x) => x.id === id);
      return `<span class="tg" data-tip="${esc(t?.name ?? id)} · 打了 ${n} 回合">${esc(t?.abbr ?? t?.name ?? id)}<small>${n}</small></span>`;
    })
    .join('');
}

function row(ctx: Ctx, f: KnownFixture): string {
  const { v } = ctx;
  const me = v.me.teamId;
  const s = f.score as { home: number; away: number };
  const mine = f.home === me || f.away === me;
  const won = (id: string): boolean => (f.home === id ? s.home > s.away : s.away > s.home);
  const res = !mine ? '' : s.home === s.away ? 'd' : won(me) ? 'w' : 'l';
  const label = res === 'w' ? 'WIN' : res === 'l' ? 'LOSE' : res === 'd' ? 'DRAW' : '';
  const canWatch = f.match?.watchable === true;
  return `<div class="ar-row ${mine ? 'me' : ''}">
    <span class="wk">${weekTag(f)}</span>
    <span class="t ${won(f.home) ? 'wn' : 'ls'}">${crest(ctx, f.home, 28, null)}${esc(teamName(v, f.home))}</span>
    <span class="sc"><b>${s.home}</b>:<b>${s.away}</b></span>
    <span class="t r ${won(f.away) ? 'wn' : 'ls'}">${crest(ctx, f.away, 28, null)}${esc(teamName(v, f.away))}</span>
    <span class="res">${label ? `<i class="stamp ${res === 'l' ? 'l' : 'w'} ${res === 'd' ? 'd' : ''}">${label}</i>` : ''}</span>
    <span class="tags">${mine ? tacticTags(ctx, f) : '<span class="dim2">—</span>'}</span>
    <span class="act">${canWatch ? `<button class="btn sm ghost" data-act="watch" data-f="${esc(f.id)}"><b>${icon('play', 14)} 回放</b></button>` : '<span class="dim2" data-tip="這場不是攻防戰引擎打的，沒有回放">無回放</span>'}</span>
  </div>`;
}

export function archiveScreen(ctx: Ctx): string {
  const { v, ui } = ctx;
  const me = v.me.teamId;
  const played = v.fixtures.filter((f) => f.score !== null && f.match !== null).sort((a, b) => b.week - a.week || a.id.localeCompare(b.id));
  const mine = played.filter((f) => f.home === me || f.away === me);
  const list = ui.archiveTab === 'all' ? played : mine;
  const w = mine.filter((f) => (f.score as { home: number; away: number }).home === (f.score as { home: number; away: number }).away ? false : (f.home === me ? (f.score as { home: number; away: number }).home > (f.score as { home: number; away: number }).away : (f.score as { home: number; away: number }).away > (f.score as { home: number; away: number }).home)).length;
  const tabs = `<div class="tabs"><button class="${ui.archiveTab === 'mine' ? 'on' : ''}" data-act="atab" data-t="mine">我方比賽<i>${mine.length}</i></button><button class="${ui.archiveTab === 'all' ? 'on' : ''}" data-act="atab" data-t="all">全部比賽<i>${played.length}</i></button></div>`;
  const body = list.length
    ? `<div class="ar-rows scroll"><div class="ar-row hd"><span>週次</span><span>主隊</span><span>比分</span><span style="text-align:right">客隊</span><span>勝負</span><span>我方常用戰術</span><span></span></div>${list.map((f) => row(ctx, f)).join('')}</div>`
    : `<p class="dim big">${v.phase === 'offseason' ? '開幕後打完的比賽會存在這裡。' : '還沒有打完的比賽。'}</p>`;
  return `${head('ARCHIVE // 檔案室', '檔案室', `已打完 <b>${played.length}</b> 場 · 我方 <b>${mine.length}</b> 場、${w} 勝 · 回放用當時的名單與設定重跑，結果和成績單一樣`)}
    <section class="body s-archive"><div class="pn list in">${pt('01', '比賽紀錄', '', 'MATCHES')}${tabs}${body}</div></section>`;
}
