// 個人統計（M5 第三批）的畫面零件：結果幕的雙方數據板、選手詳情的本季數據與近況。
// 統計是公開事實（雙方都看得到）；評分只給畫面用。照攻防戰對局介面偏好：字小、半透明、不放算式與說明。
import type { KnownFixture, KnownPlayer, KnownView, PlayerStat } from '../../manage/index.ts';
import { mvpIndex, ratingOf } from '../../manage/index.ts';
import type { Ctx } from './kit.ts';
import { avatar, esc } from './kit.ts';

/** 這場的雙方統計，我方在前；沒有統計＝null */
export function sidesOf(v: KnownView, f: KnownFixture): { mine: PlayerStat[]; theirs: PlayerStat[] } | null {
  const st = f.match?.stats;
  if (st === undefined) return null;
  const home = f.home === v.me.teamId;
  return home ? { mine: st.home, theirs: st.away } : { mine: st.away, theirs: st.home };
}

const adr = (s: Pick<PlayerStat, 'damage' | 'rounds'>): number => (s.rounds > 0 ? Math.round(s.damage / s.rounds) : 0);
const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

/** 結果幕的數據板：兩邊各五列（名字、K／D、ADR、首殺、存活），我方 MVP 標星 */
export function statsBoard(ctx: Ctx, ids: { mine: string[]; theirs: string[] }, s: { mine: PlayerStat[]; theirs: PlayerStat[] }): string {
  const mvp = mvpIndex(s.mine);
  const side = (list: string[], stats: PlayerStat[], foe: boolean): string =>
    `<div class="sb ${foe ? 'foe' : ''}"><div class="sr hd"><span></span><span></span><span>K / D</span><span>ADR</span><span>首殺</span><span>存活</span></div>${list
      .map((id, i) => {
        const x = stats[i];
        const p = ctx.pm.get(id);
        return x === undefined ? '' : `<div class="sr ${!foe && i === mvp ? 'mvp' : ''}">${avatar(ctx, p, 28)}<b>${!foe && i === mvp ? '<i>★</i>' : ''}${esc(p?.name ?? '?')}</b><span class="num">${x.kills} / ${x.deaths}</span><span class="num">${adr(x)}</span><span class="num">${x.firstKills}</span><span class="num">${x.survived}</span></div>`;
      })
      .join('')}</div>`;
  return `${side(ids.mine, s.mine, false)}${side(ids.theirs, s.theirs, true)}`;
}

/** 選手出賽過的每場（舊到新）：週、對手、比分、勝負、這場的統計（沒有＝null） */
export interface PlayedGame {
  week: number;
  opp: string;
  won: boolean | null;
  slot: number;
  my: number;
  their: number;
  stat: PlayerStat | null;
}

export function playedGames(v: KnownView, p: KnownPlayer): PlayedGame[] {
  const out: PlayedGame[] = [];
  for (const f of v.fixtures) {
    const x = f.match;
    const s = f.score;
    if (!x || !s) continue;
    const home = x.home.includes(p.id);
    const i = (home ? x.home : x.away).indexOf(p.id);
    if (i < 0) continue;
    const won = x.winner === null ? null : (x.winner === f.home) === home;
    const stat = x.stats ? ((home ? x.stats.home : x.stats.away)[i] ?? null) : null;
    out.push({ week: f.week, opp: home ? f.away : f.home, won, slot: i, my: home ? s.home : s.away, their: home ? s.away : s.home, stat });
  }
  return out;
}

/** 近況：近三場評分對本季評分，±0.1 以上算上升／下滑 */
function trend(games: readonly PlayedGame[], season: number): string {
  const last = games.filter((g) => g.stat !== null).slice(-3);
  const cells = last.map((g) => {
    const r = ratingOf(g.stat as PlayerStat);
    const d = r - season;
    const k = d >= 0.1 ? 'up' : d <= -0.1 ? 'dn' : 'eq';
    return `<i class="${k}" data-tip="W${g.week} 評分 ${r.toFixed(2)}">${k === 'up' ? '▲' : k === 'dn' ? '▼' : '—'}</i>`;
  });
  while (cells.length < 3) cells.unshift('<i class="na"></i>');
  return cells.join('');
}

/** 選手詳情的本季數據列 */
export function seasonStrip(v: KnownView, p: KnownPlayer): string {
  const s = p.season;
  if (s.games === 0) return '<div class="season"><span class="dim">本季還沒有比賽數據。</span></div>';
  const r = ratingOf(s);
  const kv = (label: string, val: string, cls = ''): string => `<div class="kv"><small>${label}</small><span class="num ${cls}">${val}</span></div>`;
  return `<div class="season">${kv('場數', String(s.games))}${kv('評分', r.toFixed(2), 'gd')}${kv('場均擊殺', (s.kills / s.games).toFixed(1))}${kv('ADR', String(adr(s)))}${kv('首殺率', pct(s.firstKills, s.rounds))}${kv('存活率', pct(s.survived, s.rounds))}${kv('殘局勝', String(s.clutches))}<div class="kv"><small>近況</small><span class="trend">${trend(playedGames(v, p), r)}</span></div></div>`;
}

/** 出賽紀錄一列的 K／D 與評分（沒有統計＝空） */
export function gameCells(g: PlayedGame): string {
  if (g.stat === null) return '<span class="kd"></span><span class="rt"></span>';
  return `<span class="kd num">${g.stat.kills}/${g.stat.deaths}</span><span class="rt num">${ratingOf(g.stat).toFixed(2)}</span>`;
}
