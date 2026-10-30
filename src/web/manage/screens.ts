// 經營頁各畫面：只讀「已知層」視圖（KnownView），輸出 HTML 字串；操作用 data-act 屬性交給 main.ts 處理。
import type { AdvanceSummary, ContentPack, KnownFixture, KnownPlayer, KnownView } from '../../manage/index.ts';
import { CATEGORY_NAME, STAGE_NAME, esc, lineageName, money, pct, signedMoney, weekLabel } from './format.ts';

export type Tab = 'overview' | 'roster' | 'schedule' | 'market' | 'training' | 'betting' | 'finance' | 'inbox';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: '總覽' },
  { id: 'roster', label: '陣容' },
  { id: 'schedule', label: '賽程' },
  { id: 'market', label: '市場' },
  { id: 'training', label: '訓練' },
  { id: 'betting', label: '下注' },
  { id: 'finance', label: '財務' },
  { id: 'inbox', label: '信箱' },
];

export interface Ui {
  tab: Tab;
  market: 'free' | 'others';
  scrim: { playerId: string; opponentId: string; games: number };
  research: { playerId: string; target: string; games: number };
  stake: Record<string, number>;
  ledgerAll: boolean;
  scheduleWeek: number | null;
}

export interface Ctx {
  v: KnownView;
  c: ContentPack;
  ui: Ui;
}

export function newUi(): Ui {
  return {
    tab: 'overview',
    market: 'free',
    scrim: { playerId: '', opponentId: '', games: 50 },
    research: { playerId: '', target: 'generic', games: 50 },
    stake: {},
    ledgerAll: false,
    scheduleWeek: null,
  };
}

// ───── 共用小工具 ─────
export function pmap(v: KnownView): Map<string, KnownPlayer> {
  return new Map(v.players.map((p) => [p.id, p]));
}

function teamName(v: KnownView, id: string | null): string {
  if (id === null) return '自由選手';
  return esc(v.teams.find((t) => t.id === id)?.name ?? id);
}

function teamRating(v: KnownView, pm: Map<string, KnownPlayer>, teamId: string): number {
  const ids = v.teams.find((t) => t.id === teamId)?.roster ?? [];
  const elos = ids
    .map((id) => (pm.get(id) as KnownPlayer).elo)
    .sort((a, b) => b - a)
    .slice(0, 3);
  return elos.length === 0 ? 0 : Math.round(elos.reduce((s, x) => s + x, 0) / elos.length);
}

function myRoster(v: KnownView, pm: Map<string, KnownPlayer>): KnownPlayer[] {
  return v.me.roster.map((id) => pm.get(id) as KnownPlayer);
}

/** 目前的出賽名單；沒排或無效時是「自動」＝公開 Elo 最高的 3 人 */
export function lineupOf(v: KnownView, pm: Map<string, KnownPlayer>): { ids: string[]; auto: boolean } {
  const mine = new Set(v.me.roster);
  if (v.me.lineup.length === 3 && new Set(v.me.lineup).size === 3 && v.me.lineup.every((id) => mine.has(id))) return { ids: v.me.lineup, auto: false };
  const top = myRoster(v, pm)
    .sort((a, b) => b.elo - a.elo || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((p) => p.id);
  return { ids: top, auto: true };
}

function myFixture(v: KnownView): KnownFixture | undefined {
  return v.fixtures.find((f) => f.week === v.week && (f.home === v.me.teamId || f.away === v.me.teamId));
}

function pdesc(c: ContentPack, p: KnownPlayer): string {
  return `${esc(p.name)}（${lineageName(c, p.lineageId)} v${p.version}）`;
}

function presetBadges(v: KnownView, c: ContentPack, playerId: string): string {
  const list = v.presets.filter((p) => p.playerId === playerId);
  if (list.length === 0) return '<span class="muted">—</span>';
  return list
    .map((p) => `<span class="mg-badge ${p.valid ? '' : 'off'}" title="${p.valid ? '' : '升版後失效'}">${p.target === 'generic' ? '泛用' : `對${lineageName(c, p.target)}`} 約+${p.reportedBonus}</span>`)
    .join(' ');
}

function intelText(v: KnownView, p: KnownPlayer): string {
  const i = v.intel.find((x) => x.playerId === p.id);
  if (!i) return '<span class="muted">未偵察</span>';
  const diff = i.estPower - p.elo;
  return `<b>${i.estPower}</b> <span class="muted">±${i.sd}</span> <span class="${diff >= 0 ? 'good' : 'bad'}">${diff >= 0 ? '+' : ''}${diff}</span>`;
}

function scoreLine(f: KnownFixture, v: KnownView): string {
  const h = esc(v.teams.find((t) => t.id === f.home)?.name ?? f.home);
  const a = esc(v.teams.find((t) => t.id === f.away)?.name ?? f.away);
  const mine = (id: string): string => (id === v.me.teamId ? ' me' : '');
  const s = f.score ? `<b class="num">${f.score.home} : ${f.score.away}</b>` : '<span class="muted">vs</span>';
  return `<span class="mg-tm${mine(f.home)}">${h}</span> ${s} <span class="mg-tm${mine(f.away)}">${a}</span>`;
}

function slotLines(f: KnownFixture, pm: Map<string, KnownPlayer>): string {
  const x = f.match;
  if (!x) return '';
  const names = (ids: string[]): string => ids.map((id) => esc(pm.get(id)?.name ?? id)).join('、');
  const cls = x.winner === f.home ? 'hw' : x.winner === f.away ? 'aw' : '';
  return `<div class="mg-slots"><span class="mg-slot ${cls}">${names(x.home)}</span><span class="mg-slot ${cls}">對 ${names(x.away)}</span></div>`;
}

function runwayText(v: KnownView): string {
  if (v.me.runwayWeeks === null) return '贊助養得起固定支出';
  return `只靠固定收支約撐 ${v.me.runwayWeeks} 週`;
}

// ───── 總覽 ─────
function overview(ctx: Ctx): string {
  const { v, c } = ctx;
  const pm = pmap(v);
  const pos = v.standings.findIndex((r) => r.teamId === v.me.teamId) + 1;
  const row = v.standings.find((r) => r.teamId === v.me.teamId);
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const lowRunway = v.me.runwayWeeks !== null && v.me.runwayWeeks < 3;

  const cards = `<div class="mg-cards">
    <div class="mg-card"><span class="k">現金</span><b class="big ${v.me.cash < 0 ? 'bad' : ''}">${money(v.me.cash)}</b><span class="s ${lowRunway ? 'bad' : ''}">${runwayText(v)}</span></div>
    <div class="mg-card"><span class="k">每週固定收支</span><b class="big ${net < 0 ? 'bad' : 'good'}">${signedMoney(net)}</b><span class="s">薪資＋維護 ${money(v.me.weeklyFixedCost)}　贊助 ${money(v.me.weeklySponsor)}</span></div>
    <div class="mg-card"><span class="k">名氣</span><b class="big">${v.me.fame}</b><span class="s">每點名氣＝每週贊助 ${money(c.economy.sponsorPerFame)}</span></div>
    <div class="mg-card"><span class="k">例行賽排名</span><b class="big">${row && row.played > 0 ? `第 ${pos} 名` : '—'}</b><span class="s">${row ? `${row.wins} 勝 ${row.draws} 平 ${row.losses} 敗，${row.points} 分` : ''}</span></div>
  </div>`;

  let week = '';
  if (v.phase === 'offseason') {
    week = `<section class="card"><h2>休賽期</h2><p>賽季開始前先把陣容與訓練準備好：</p>
      <ul class="mg-todo"><li>到「市場」簽自由選手，或派球探偵察別隊選手（情報要推進一週才有報告）</li>
      <li>到「訓練」排練習賽與戰術研發</li><li>到「陣容」排出賽名單</li></ul>
      <p class="muted small">推進後進入第 1 週。休賽期推進不會結算薪資。</p></section>`;
  } else if (v.phase === 'season') {
    const f = myFixture(v);
    if (!f) {
      week = `<section class="card"><h2>${weekLabel(v.week)}</h2><p>本週沒有你的比賽（沒進季後賽或已淘汰）。你仍可以下注別人的比賽。</p></section>`;
    } else {
      const oppId = f.home === v.me.teamId ? f.away : f.home;
      const odds = v.odds.find((o) => o.fixtureId === f.id);
      const myOdds = odds ? (f.home === v.me.teamId ? odds.homeX100 : odds.awayX100) : null;
      const oppRoster = (v.teams.find((t) => t.id === oppId)?.roster ?? []).map((id) => pm.get(id) as KnownPlayer).sort((a, b) => b.elo - a.elo);
      week = `<section class="card"><h2>${weekLabel(v.week)}　${STAGE_NAME[f.stage]}</h2>
        <p class="mg-vs">${scoreLine(f, v)}</p>
        <div class="mg-two">
          <div><div class="muted small">公開戰力（陣容前 3 名 Elo 平均）</div>
            <div>你 <b>${teamRating(v, pm, v.me.teamId)}</b>　對手 <b>${teamRating(v, pm, oppId)}</b></div>
            ${myOdds ? `<div class="muted small">押你贏的賠率 ${(myOdds / 100).toFixed(2)}</div>` : ''}</div>
          <div><div class="muted small">對手陣容（公開資訊）</div>
            ${oppRoster.map((p) => `<div class="small">${pdesc(c, p)}　Elo ${p.elo}</div>`).join('')}</div>
        </div></section>`;
    }
  }

  const lu = lineupOf(v, pm);
  const todo: string[] = [];
  if (v.phase === 'season' || v.phase === 'offseason') {
    if (lu.auto) todo.push('出賽名單是「自動」（公開 Elo 最高的 3 人）；要自己排對位順序請到「陣容」');
    if (v.me.capacityLeft > 0) todo.push(`訓練中心本週還有 ${v.me.capacityLeft} 場可排練習賽或戰術研發`);
    if (v.jobs.length > 0) todo.push(`已排 ${v.jobs.length} 項背景工作，推進後出報告`);
    if (lowRunway) todo.push(`<span class="bad">資金警示：${runwayText(v)}</span>`);
  }

  const msgs = v.inbox.slice(-5).reverse();
  return `${cards}${week}
    ${todo.length ? `<section class="card"><h2>待辦提示</h2><ul class="mg-todo">${todo.map((t) => `<li>${t}</li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>最新訊息</h2>${msgs.length ? msgs.map((m) => `<div class="mg-msg ${m.kind}"><span class="w">${weekLabel(m.week)}</span>${esc(m.text)}</div>`).join('') : '<p class="muted">還沒有訊息</p>'}</section>`;
}

// ───── 陣容 ─────
function roster(ctx: Ctx): string {
  const { v, c } = ctx;
  const pm = pmap(v);
  const mine = myRoster(v, pm);
  const lu = lineupOf(v, pm);
  const e = c.economy;
  const slotSel = [0, 1, 2]
    .map(
      (i) => `<label class="mg-slotsel"><span>第 ${i + 1} 位</span><select data-slot="${i}">${mine
        .map((p) => `<option value="${p.id}" ${lu.ids[i] === p.id ? 'selected' : ''}>${pdesc(c, p)}　Elo ${p.elo}</option>`)
        .join('')}</select></label>`,
    )
    .join('');
  const canAct = v.phase === 'offseason' || v.phase === 'season';
  const rows = mine
    .map((p) => {
      const slot = lu.ids.indexOf(p.id);
      const maxed = p.version >= (c.lineages.find((l) => l.id === p.lineageId)?.power.length ?? 1);
      const upCost = p.weeklySalary * e.upgradeCostWeeks;
      const upDisabled = !canAct || p.upgrading || maxed || v.me.cash < upCost;
      const upTitle = p.upgrading ? '升版中' : maxed ? '已是最高版本' : v.me.cash < upCost ? '資金不足' : `花 ${money(upCost)}，${e.upgradeWeeks} 週後升到 v${p.version + 1}，週薪 ×${e.salaryGrowthPct / 100}`;
      return `<tr>
        <td>${slot >= 0 ? `<b class="accent">第 ${slot + 1} 位</b>` : '<span class="muted">替補</span>'}</td>
        <td><b>${esc(p.name)}</b></td><td>${lineageName(c, p.lineageId)}</td><td class="num">v${p.version}${p.upgrading ? ' <span class="mg-badge">升版中</span>' : ''}</td>
        <td class="num">${p.elo}</td><td class="num">${p.games}</td><td class="num">${money(p.weeklySalary)}</td><td>${presetBadges(v, c, p.id)}</td>
        <td class="mg-act"><button data-act="upgrade" data-id="${p.id}" ${upDisabled ? 'disabled' : ''} title="${upTitle}">升版 ${money(upCost)}</button>
          <button class="ghost" data-act="release" data-id="${p.id}" ${!canAct || mine.length <= 3 ? 'disabled' : ''} title="${mine.length <= 3 ? '陣容至少要有 3 人' : '解約後成為自由選手'}">解約</button></td></tr>`;
    })
    .join('');
  return `<section class="card"><h2>出賽名單</h2>
    <p class="muted small">戰隊賽三個對位：第 1 位對對手的第 1 位、第 2 位對第 2 位……贏 2 場以上的隊伍勝。雙方名單是同時公開的，對位順序就是你的猜測空間。${lu.auto ? '<br><span class="hint">目前是自動（公開 Elo 最高的 3 人），改任一位就會固定下來。</span>' : ''}</p>
    <div class="mg-lineup">${slotSel}</div></section>
    <section class="card"><h2>陣容（${mine.length} / ${e.rosterMax}）</h2>
    <div class="mg-scroll"><table class="data"><thead><tr><th>出賽</th><th>選手</th><th>流派</th><th>版本</th><th>Elo</th><th>場數</th><th>週薪</th><th>戰術預設</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">Elo 是公開戰績；流派真正的強弱要靠打出來的戰績、球探情報或練習賽才看得出來。戰術預設的加成是研發報告的估計值，帶誤差。</p></section>`;
}

// ───── 賽程 ─────
function schedule(ctx: Ctx): string {
  const { v } = ctx;
  const pm = pmap(v);
  const weeks = [...new Set(v.fixtures.map((f) => f.week))].sort((a, b) => a - b);
  const selWeek = ctx.ui.scheduleWeek ?? (v.phase === 'season' ? v.week : weeks[weeks.length - 1]);
  const rows = v.standings
    .map((r, i) => {
      const name = teamName(v, r.teamId);
      return `<tr class="${r.teamId === v.me.teamId ? 'me' : ''} ${i === 3 ? 'cut' : ''}"><td class="num">${i + 1}</td><td>${name}</td><td class="num">${r.played}</td><td class="num">${r.wins}-${r.draws}-${r.losses}</td><td class="num"><b>${r.points}</b></td><td class="num">${r.scoreDiff >= 0 ? '+' : ''}${r.scoreDiff}</td></tr>`;
    })
    .join('');
  const chips = weeks.map((w) => `<button class="${w === selWeek ? 'active' : ''}" data-act="week" data-week="${w}">${w <= 7 ? w : w === 8 ? '準決' : '決賽'}${w === v.week && v.phase === 'season' ? '·' : ''}</button>`).join('');
  const fx = v.fixtures.filter((f) => f.week === selWeek);
  const list = fx
    .map((f) => {
      const mine = f.home === v.me.teamId || f.away === v.me.teamId;
      return `<div class="mg-fx ${mine ? 'me' : ''}"><span class="mg-tag">${STAGE_NAME[f.stage]}</span> ${scoreLine(f, v)}${mine || f.score ? slotLines(f, pm) : ''}</div>`;
    })
    .join('');
  const final = v.seasonResult;
  return `<section class="card"><h2>例行賽積分榜</h2>
    <div class="mg-scroll"><table class="data"><thead><tr><th>#</th><th>戰隊</th><th>賽</th><th>勝-平-負</th><th>積分</th><th>對位差</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">勝 3 分、平 1 分、敗 0 分，同分比對位勝場差。前 4 名進季後賽（第 8 週準決賽 1v4、2v3，第 9 週決賽與季軍戰）。</p></section>
    <section class="card"><h2>賽程與戰績</h2><div class="row">${chips}</div>${list || '<p class="muted">這一週沒有比賽</p>'}</section>
    ${final ? `<section class="card"><h2>最終名次</h2><ol class="mg-ranks">${final.ranks.map((id, i) => `<li class="${id === v.me.teamId ? 'me' : ''}"><span class="rank">${i + 1}</span>${teamName(v, id)}</li>`).join('')}</ol></section>` : ''}`;
}

// ───── 市場 ─────
function market(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const free = ui.market === 'free';
  const list = v.players
    .filter((p) => (free ? p.teamId === null : p.teamId !== null && p.teamId !== v.me.teamId))
    .sort((a, b) => b.version - a.version || b.elo - a.elo);
  const canAct = v.phase === 'offseason' || v.phase === 'season';
  const full = v.me.roster.length >= e.rosterMax;
  const pending = new Set(v.jobs.filter((j) => j.kind === 'scout').map((j) => j.playerId));
  const rows = list
    .map((p) => {
      const fee = p.weeklySalary * e.signingFeeWeeks;
      const signDis = !canAct || full || v.me.cash < fee;
      const signTitle = full ? '陣容已滿' : v.me.cash < fee ? '資金不足' : `簽約金 ${money(fee)}`;
      const scoutDis = !canAct || pending.has(p.id) || v.me.cash < e.scoutCost;
      return `<tr><td><b>${esc(p.name)}</b></td>${free ? '' : `<td>${teamName(v, p.teamId)}</td>`}<td>${lineageName(c, p.lineageId)}</td><td class="num">v${p.version}</td><td class="num">${p.elo}</td><td class="num">${p.games}</td><td class="num">${money(p.weeklySalary)}</td><td>${intelText(v, p)}</td>
        <td class="mg-act">${free ? `<button data-act="sign" data-id="${p.id}" ${signDis ? 'disabled' : ''} title="${signTitle}">簽約 ${money(fee)}</button>` : ''}
        <button data-act="scout" data-id="${p.id}" ${scoutDis ? 'disabled' : ''} title="${pending.has(p.id) ? '球探已派出，推進一週後出報告' : '推進一週後出報告'}">${pending.has(p.id) ? '偵察中' : `球探 ${money(e.scoutCost)}`}</button></td></tr>`;
    })
    .join('');
  return `<section class="card"><h2>選手市場</h2>
    <div class="row"><button class="${free ? 'active' : ''}" data-act="market" data-m="free">自由選手（${v.players.filter((p) => p.teamId === null).length}）</button>
      <button class="${free ? '' : 'active'}" data-act="market" data-m="others">其他戰隊的選手</button>
      <span class="muted small">你的陣容 ${v.me.roster.length} / ${e.rosterMax}　現金 ${money(v.me.cash)}</span></div>
    <div class="mg-scroll"><table class="data"><thead><tr><th>選手</th>${free ? '' : '<th>戰隊</th>'}<th>流派</th><th>版本</th><th>Elo</th><th>場數</th><th>週薪</th><th>情報（真實強度 ±誤差，對 Elo 差）</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">沒有選手</td></tr>'}</tbody></table></div>
    <p class="muted small">公開 Elo 的起點只看版本號，所有流派一樣；某個流派的 v3 實際比別的 v3 強多少，要靠球探情報（花 ${money(e.scoutCost)}，誤差 ±${e.scoutSd}）或打出來的戰績。簽約金＝${e.signingFeeWeeks} 週薪資。</p></section>`;
}

// ───── 訓練 ─────
function training(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const pm = pmap(v);
  const mine = myRoster(v, pm);
  const level = v.me.trainingLevel;
  const maxLevel = e.facilityMaintenance.length;
  const cap = e.scrimCapacity[level - 1];
  const used = cap - v.me.capacityLeft;
  const upCost = level < maxLevel ? e.facilityUpgradeCost[level - 1] : 0;
  const canAct = v.phase === 'offseason' || v.phase === 'season';
  const others = v.players.filter((p) => p.teamId !== v.me.teamId);
  const opt = (p: KnownPlayer, sel: string): string => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}（${teamName(v, p.teamId)}，${lineageName(c, p.lineageId)} v${p.version}）</option>`;
  const myOpt = (p: KnownPlayer, sel: string): string => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${pdesc(c, p)}</option>`;
  const queue = v.jobs
    .map((j) => {
      if (j.kind === 'scrim') return `<li>練習賽：對 ${esc(teamName(v, j.opponentTeamId))}，${j.games} 場</li>`;
      const p = pm.get(j.playerId);
      const who = p ? esc(p.name) : j.playerId;
      if (j.kind === 'scout') return `<li>球探：${who}</li>`;
      return `<li>研發：${who} 的${j.target === 'generic' ? '泛用' : `對${lineageName(c, j.target)}`}戰術預設，${j.games} 場</li>`;
    })
    .join('');
  const scrims = [...v.scrims].reverse().slice(0, 8);
  const presets = v.presets;
  const intel = v.intel;
  const ci = (w: number, n: number): string => {
    const p = w / n;
    return `±${Math.round(196 * Math.sqrt((p * (1 - p)) / n))}%`;
  };
  return `<section class="card"><h2>訓練中心</h2>
    <div class="mg-two"><div><div><b>Lv${level}</b>　每週可跑 ${cap} 場（練習賽與研發共用）　本週已排 ${used} 場</div>
      <div class="mg-bar"><i style="width:${Math.min(100, (used * 100) / cap)}%"></i></div>
      <div class="muted small">維護費每週 ${money(e.facilityMaintenance[level - 1])}</div></div>
      <div>${level < maxLevel ? `<button data-act="upfac" ${!canAct || v.me.cash < upCost ? 'disabled' : ''}>升到 Lv${level + 1}　${money(upCost)}（維護 ${money(e.facilityMaintenance[level])}／週）</button>` : '<span class="muted">已是最高等級</span>'}</div></div></section>
    <section class="card"><h2>排練習賽</h2>
    <p class="muted small">用自己的選手對別隊選手打大量模擬，估計真實勝率（樣本越多誤差越小）。結果推進一週後出報告。</p>
    <div class="row"><select data-field="scrim.playerId">${mine.map((p) => myOpt(p, ui.scrim.playerId)).join('')}</select> 對
      <select data-field="scrim.opponentId">${others.map((p) => opt(p, ui.scrim.opponentId)).join('')}</select>
      <input type="number" min="1" max="${Math.max(1, v.me.capacityLeft)}" step="10" value="${ui.scrim.games}" data-field="scrim.games"> 場
      <button data-act="scrim" ${!canAct || v.me.capacityLeft < 1 ? 'disabled' : ''}>排入</button></div></section>
    <section class="card"><h2>戰術研發</h2>
    <p class="muted small">替選手找較好的戰術預設，賽前自動套用。泛用的加成較小；針對某個流派加成較大，但只在遇到那個流派時有效。選手升版後預設失效。推進一週後出報告。</p>
    <div class="row"><select data-field="research.playerId">${mine.map((p) => myOpt(p, ui.research.playerId)).join('')}</select>
      目標 <select data-field="research.target"><option value="generic" ${ui.research.target === 'generic' ? 'selected' : ''}>泛用</option>${c.lineages.map((l) => `<option value="${l.id}" ${ui.research.target === l.id ? 'selected' : ''}>針對 ${l.name}</option>`).join('')}</select>
      <input type="number" min="1" max="${Math.max(1, v.me.capacityLeft)}" step="10" value="${ui.research.games}" data-field="research.games"> 場
      <button data-act="research" ${!canAct || v.me.capacityLeft < 1 ? 'disabled' : ''}>排入</button></div></section>
    <section class="card"><h2>本週已排的工作</h2>${queue ? `<ul class="mg-todo">${queue}</ul>` : '<p class="muted">沒有</p>'}</section>
    <section class="card"><h2>報告</h2>
      <h3>練習賽</h3>${scrims.length ? `<ul class="mg-todo">${scrims.map((s) => `<li>${weekLabel(s.week)}：對 ${esc(teamName(v, s.opponentTeamId))}　${s.wins}/${s.games} 勝（${pct(s.wins, s.games)}，${ci(s.wins, s.games)}）</li>`).join('')}</ul>` : '<p class="muted">還沒有</p>'}
      <h3>戰術預設</h3>${presets.length ? `<ul class="mg-todo">${presets.map((p) => `<li>${esc(pm.get(p.playerId)?.name ?? '?')}：${p.target === 'generic' ? '泛用' : `對${lineageName(c, p.target)}`}，估計加成約 +${p.reportedBonus}${p.valid ? '' : '（已失效）'}</li>`).join('')}</ul>` : '<p class="muted">還沒有</p>'}
      <h3>球探情報</h3>${intel.length ? `<ul class="mg-todo">${intel.map((i) => `<li>${weekLabel(i.week)}：${esc(pm.get(i.playerId)?.name ?? '?')} 真實強度約 ${i.estPower}（±${i.sd}）</li>`).join('')}</ul>` : '<p class="muted">還沒有</p>'}</section>`;
}

// ───── 下注 ─────
function betting(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const e = c.economy;
  const pm = pmap(v);
  if (v.phase !== 'season') return '<section class="card"><h2>下注</h2><p class="muted">賽季開始後才能下注。</p></section>';
  const limit = e.betLimitBase + e.betLimitPerFame * v.me.fame;
  const open = v.fixtures.filter((f) => f.week === v.week && f.score === null);
  const rows = open
    .map((f) => {
      const o = v.odds.find((x) => x.fixtureId === f.id);
      const mine = f.home === v.me.teamId || f.away === v.me.teamId;
      const staked = v.bets.filter((b) => b.fixtureId === f.id).reduce((s, b) => s + b.stake, 0);
      const stake = ui.stake[f.id] ?? 5;
      const homeDis = (mine && f.home !== v.me.teamId) || !o;
      const awayDis = (mine && f.away !== v.me.teamId) || !o;
      return `<div class="mg-fx ${mine ? 'me' : ''}"><div>${scoreLine(f, v)} <span class="muted small">公開戰力 ${teamRating(v, pm, f.home)} : ${teamRating(v, pm, f.away)}</span></div>
        <div class="row"><input type="number" min="${Math.ceil(e.betMin / 10)}" step="1" value="${stake}" data-field="stake.${f.id}"> 萬
        <button data-act="bet" data-fid="${f.id}" data-side="home" ${homeDis ? 'disabled' : ''}>押主隊 ×${o ? (o.homeX100 / 100).toFixed(2) : '—'}</button>
        <button data-act="bet" data-fid="${f.id}" data-side="away" ${awayDis ? 'disabled' : ''}>押客隊 ×${o ? (o.awayX100 / 100).toFixed(2) : '—'}</button>
        <span class="muted small">本場已押 ${money(staked)} / 上限 ${money(limit)}${mine ? '（自己的比賽只能押自己）' : ''}</span></div></div>`;
    })
    .join('');
  const bets = v.bets
    .map((b) => {
      const f = v.fixtures.find((x) => x.id === b.fixtureId);
      return `<li>${f ? scoreLine(f, v) : b.fixtureId}　押${b.side === 'home' ? '主' : '客'}隊 ${money(b.stake)} ×${(b.oddsX100 / 100).toFixed(2)}，贏了入帳 ${money(Math.floor((b.stake * b.oddsX100) / 100))}</li>`;
    })
    .join('');
  return `<section class="card"><h2>本週可下注的比賽</h2>
    <p class="muted small">賠率只依公開戰績（陣容公開 Elo）算，莊家抽成 ${e.betMarginPermille / 10}%；比賽結果有隨機性，長期亂押必虧。贏過莊家要靠情報——你知道的比公開 Elo 多。單注至少 ${money(e.betMin)}。</p>
    ${rows || '<p class="muted">本週沒有可下注的比賽</p>'}</section>
    <section class="card"><h2>已下的注</h2>${bets ? `<ul class="mg-todo">${bets}</ul>` : '<p class="muted">沒有</p>'}</section>`;
}

// ───── 財務 ─────
function finance(ctx: Ctx): string {
  const { v, ui } = ctx;
  const net = v.me.weeklySponsor - v.me.weeklyFixedCost;
  const totals = new Map<string, number>();
  for (const e of v.ledger) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amount);
  const cat = [...totals.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([k, amt]) => `<tr><td>${CATEGORY_NAME[k as keyof typeof CATEGORY_NAME] ?? k}</td><td class="num ${amt >= 0 ? 'good' : 'bad'}">${signedMoney(amt)}</td></tr>`)
    .join('');
  const ledger = [...v.ledger].reverse();
  const shown = ui.ledgerAll ? ledger : ledger.slice(0, 40);
  return `<div class="mg-cards">
    <div class="mg-card"><span class="k">現金</span><b class="big ${v.me.cash < 0 ? 'bad' : ''}">${money(v.me.cash)}</b><span class="s">${runwayText(v)}</span></div>
    <div class="mg-card"><span class="k">每週固定支出</span><b class="big bad">${money(v.me.weeklyFixedCost)}</b><span class="s">薪資＋訓練中心維護</span></div>
    <div class="mg-card"><span class="k">每週贊助</span><b class="big good">${money(v.me.weeklySponsor)}</b><span class="s">名氣 ${v.me.fame}</span></div>
    <div class="mg-card"><span class="k">固定淨額</span><b class="big ${net < 0 ? 'bad' : 'good'}">${signedMoney(net)}</b><span class="s">每週，不含比賽獎金與下注</span></div></div>
    <section class="card"><h2>收支分類（本賽段累計）</h2><table class="data"><tbody>${cat || '<tr><td class="muted">還沒有帳</td></tr>'}</tbody></table></section>
    <section class="card"><h2>帳本</h2><div class="mg-scroll"><table class="data"><thead><tr><th>週</th><th>類別</th><th>摘要</th><th>金額</th></tr></thead><tbody>${shown
      .map((e) => `<tr><td>${weekLabel(e.week)}</td><td>${CATEGORY_NAME[e.category]}</td><td>${esc(e.memo)}</td><td class="num ${e.amount >= 0 ? 'good' : 'bad'}">${signedMoney(e.amount)}</td></tr>`)
      .join('')}</tbody></table></div>
    ${ledger.length > 40 ? `<div class="row"><button data-act="ledger-all">${ui.ledgerAll ? '只看最近 40 筆' : `看全部 ${ledger.length} 筆`}</button></div>` : ''}</section>`;
}

// ───── 信箱 ─────
function inbox(ctx: Ctx): string {
  const msgs = [...ctx.v.inbox].reverse();
  return `<section class="card"><h2>信箱</h2>${msgs.length ? msgs.map((m) => `<div class="mg-msg ${m.kind}"><span class="w">${weekLabel(m.week)}</span>${esc(m.text)}</div>`).join('') : '<p class="muted">沒有訊息</p>'}</section>`;
}

export function renderTab(ctx: Ctx): string {
  switch (ctx.ui.tab) {
    case 'overview':
      return overview(ctx);
    case 'roster':
      return roster(ctx);
    case 'schedule':
      return schedule(ctx);
    case 'market':
      return market(ctx);
    case 'training':
      return training(ctx);
    case 'betting':
      return betting(ctx);
    case 'finance':
      return finance(ctx);
    case 'inbox':
      return inbox(ctx);
  }
}

/** 讓表單欄位的預設值落在有效選項上（陣容或對手變了就換成第一個） */
export function normalizeUi(ctx: Ctx): void {
  const { v, ui } = ctx;
  const mine = v.me.roster;
  const others = v.players.filter((p) => p.teamId !== v.me.teamId).map((p) => p.id);
  if (!mine.includes(ui.scrim.playerId)) ui.scrim.playerId = mine[0] ?? '';
  if (!others.includes(ui.scrim.opponentId)) ui.scrim.opponentId = others[0] ?? '';
  if (!mine.includes(ui.research.playerId)) ui.research.playerId = mine[0] ?? '';
  if (v.me.capacityLeft > 0) {
    ui.scrim.games = Math.max(1, Math.min(ui.scrim.games, v.me.capacityLeft));
    ui.research.games = Math.max(1, Math.min(ui.research.games, v.me.capacityLeft));
  }
}

// ───── 對話框 ─────
export function weekReport(ctx: Ctx, summary: AdvanceSummary): string {
  const { v } = ctx;
  const pm = pmap(v);
  const ids = new Set(summary.results.map((r) => r.fixtureId));
  const fx = v.fixtures.filter((f) => ids.has(f.id)).sort((a, b) => Number(b.home === v.me.teamId || b.away === v.me.teamId) - Number(a.home === v.me.teamId || a.away === v.me.teamId));
  const msgs = v.inbox.filter((m) => m.week === summary.week && m.kind !== 'result');
  return `<h2>${weekLabel(summary.week)} 戰報</h2>
    ${fx.map((f) => `<div class="mg-fx ${f.home === v.me.teamId || f.away === v.me.teamId ? 'me' : ''}"><span class="mg-tag">${STAGE_NAME[f.stage]}</span> ${scoreLine(f, v)}${f.home === v.me.teamId || f.away === v.me.teamId ? slotLines(f, pm) : ''}</div>`).join('')}
    ${msgs.length ? `<h3>本週結算與報告</h3>${msgs.map((m) => `<div class="mg-msg ${m.kind}">${esc(m.text)}</div>`).join('')}` : ''}
    <div class="row"><button class="primary" data-act="close-dialog">繼續</button></div>`;
}

export function offseasonReport(ctx: Ctx): string {
  const msgs = ctx.v.inbox.filter((m) => m.week === 0 && m.kind === 'report');
  return `<h2>賽季開始</h2><p>休賽期結束，進入第 1 週。</p>${msgs.map((m) => `<div class="mg-msg report">${esc(m.text)}</div>`).join('')}
    <div class="row"><button class="primary" data-act="close-dialog">開始</button></div>`;
}

export function seasonEnd(ctx: Ctx): string {
  const { v } = ctx;
  const res = v.seasonResult;
  const broke = v.phase === 'bankrupt';
  const ranks = res ? `<ol class="mg-ranks">${res.ranks.map((id, i) => `<li class="${id === v.me.teamId ? 'me' : ''}"><span class="rank">${i + 1}</span>${teamName(v, id)}</li>`).join('')}</ol>` : '';
  return `<h2>${broke ? '破產' : '賽段結束'}</h2>
    <p>${broke ? `現金 ${money(v.me.cash)}，公司撐不下去了${res ? `（最終名次第 ${res.humanRank}）` : `（第 ${v.week} 週結算後現金為負）`}。` : `你的戰隊拿到第 ${res?.humanRank ?? '?'} 名，期末現金 ${money(v.me.cash)}。`}</p>
    ${ranks}<div class="row"><button class="primary" data-act="new-season">再開一個新賽段</button><button data-act="close-dialog">看看紀錄</button></div>`;
}
