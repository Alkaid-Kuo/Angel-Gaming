// 戰隊（出賽名單＋選手卡）、轉會市場、選手詳情視窗。
import type { KnownPlayer } from '../../manage/index.ts';
import { esc, lineageName, wan } from '../manage/format.ts';
import { icon, lineageColor, lineageGlyph, tierOf } from './art.ts';
import { coin, crest, miniCard, playerCard, screenHead, slotLabel, teamTag } from './cards.ts';
import type { Ctx } from './model.ts';
import { lineupOf, maxVersionOf, playerRecords, publicRating, rosterOf, teamName } from './model.ts';

const canAct = (ctx: Ctx): boolean => ctx.v.phase === 'offseason' || ctx.v.phase === 'season';

export function squadScreen(ctx: Ctx): string {
  const { v, ui, c } = ctx;
  const lu = lineupOf(ctx);
  const recs = playerRecords(v);
  const active = canAct(ctx);
  const mine = rosterOf(ctx, v.me.teamId).sort((a, b) => {
    const sa = lu.ids.indexOf(a.id);
    const sb = lu.ids.indexOf(b.id);
    return (sa < 0 ? 9 : sa) - (sb < 0 ? 9 : sb) || b.elo - a.elo;
  });
  const slots = lu.ids
    .map(
      (id, i) => `<div class="slot ${ui.pickSlot === i ? 'picking' : ''}" data-act="pick-slot" data-slot="${i}" data-drop-slot="${i}">
        <span class="slot-nm">${slotLabel(i)}</span>${miniCard(ctx, ctx.pm.get(id))}</div>`,
    )
    .join('<span class="slot-sep">／</span>');
  const hint =
    ui.pickSlot !== null
      ? `<b class="hl">點一張選手卡，放到「${slotLabel(ui.pickSlot)}」</b>　<button class="btn-link" data-act="pick-slot" data-slot="-1">取消</button>`
      : `拖曳選手卡到出賽位，或先點出賽位再點卡片。選到已上場的人會互換位置。${lu.auto ? '<b class="hl">目前是自動名單（評分最高的 3 人）。</b>' : ''}`;
  return `${screenHead('戰隊', 'users', `${v.me.roster.length} / ${c.economy.rosterMax} 名選手　每週薪資合計 ${wan(v.me.weeklyFixedCost - c.economy.facilityMaintenance[v.me.trainingLevel - 1])} 萬`)}
    <section class="panel lineup-panel"><div class="panel-hd"><h2>${icon('swords', 18)}出賽名單</h2><span>三個對位：先鋒對先鋒、中堅對中堅、大將對大將，贏兩場拿下比賽</span></div>
      <div class="slots">${slots}</div><p class="slot-help">${active ? hint : '賽段已結束。'}</p></section>
    <div class="card-grid">${mine
      .map((p) =>
        playerCard(ctx, p, {
          slot: lu.ids.indexOf(p.id),
          record: recs.get(p.id) ?? { w: 0, l: 0 },
          drag: active,
          act: ui.pickSlot !== null && active ? 'assign' : 'card',
        }),
      )
      .join('')}
      ${v.me.roster.length < c.economy.rosterMax ? `<button class="pc-empty" data-act="go" data-to="market">${icon('contract', 30)}<b>空缺</b><span>到轉會市場簽人</span></button>` : ''}</div>`;
}

function scoutBtn(ctx: Ctx, p: KnownPlayer): string {
  const e = ctx.c.economy;
  const pending = ctx.v.jobs.some((j) => j.kind === 'scout' && j.playerId === p.id);
  const dis = !canAct(ctx) || pending || ctx.v.me.cash < e.scoutCost;
  return `<button class="btn-chip" data-act="scout" data-id="${p.id}" ${dis ? 'disabled' : ''} title="${pending ? '球探已出發，推進一週後回報' : '推進一週後回報真實強度（帶誤差）'}">${icon('search', 14)}${pending ? '偵察中' : `球探 ${wan(e.scoutCost)}萬`}</button>`;
}

function signBtn(ctx: Ctx, p: KnownPlayer): string {
  const e = ctx.c.economy;
  const fee = p.weeklySalary * e.signingFeeWeeks;
  const full = ctx.v.me.roster.length >= e.rosterMax;
  const dis = !canAct(ctx) || full || ctx.v.me.cash < fee;
  return `<button class="btn-chip gold" data-act="sign" data-id="${p.id}" ${dis ? 'disabled' : ''} title="${full ? '陣容已滿' : ctx.v.me.cash < fee ? '資金不足' : `簽約金＝${e.signingFeeWeeks} 週薪資`}">${icon('contract', 14)}簽約 ${wan(fee)}萬</button>`;
}

export function marketScreen(ctx: Ctx): string {
  const { v, ui, c } = ctx;
  const seg = `<div class="seg"><button class="${ui.market === 'free' ? 'on' : ''}" data-act="market" data-m="free">自由球員</button><button class="${ui.market === 'teams' ? 'on' : ''}" data-act="market" data-m="teams">各隊名單</button></div>`;
  let body: string;
  if (ui.market === 'free') {
    const free = v.players.filter((p) => p.teamId === null).sort((a, b) => b.version - a.version || b.elo - a.elo);
    body = free.length
      ? `<div class="card-grid">${free.map((p) => playerCard(ctx, p, { intel: true, footer: `<div class="pc-actions">${signBtn(ctx, p)}${scoutBtn(ctx, p)}</div>` })).join('')}</div>`
      : '<p class="empty-note">市場上沒有自由球員了。</p>';
  } else {
    body = v.teams
      .filter((t) => t.id !== v.me.teamId)
      .map(
        (t) => `<section class="team-block"><div class="team-block-hd">${teamTag(ctx, t.id, 34)}<span>公開戰力 <b>${publicRating(ctx, t.id)}</b></span><span>名氣 <b>${t.fame}</b></span></div>
        <div class="card-grid sm">${rosterOf(ctx, t.id)
          .sort((a, b) => b.elo - a.elo)
          .map((p) => playerCard(ctx, p, { intel: true, size: 'sm', footer: `<div class="pc-actions">${scoutBtn(ctx, p)}</div>` }))
          .join('')}</div></section>`,
      )
      .join('');
  }
  return `${screenHead('轉會市場', 'contract', `陣容 ${v.me.roster.length} / ${c.economy.rosterMax}　現金 ${wan(v.me.cash)} 萬`)}
    <section class="panel tip-panel">${icon('info', 18)}<p>評分（公開 Elo）的起點只看版本，所有流派都一樣——某個流派的 v3 實際上強多少，只有<b>打出來的戰績</b>或<b>球探情報</b>看得出來。這就是撿便宜的空間。</p>${seg}</section>
    ${body}`;
}

export function cardModal(ctx: Ctx, pid: string): string {
  const { v, c } = ctx;
  const p = ctx.pm.get(pid);
  if (!p) return '';
  const e = c.economy;
  const mine = p.teamId === v.me.teamId;
  const rec = playerRecords(v).get(p.id) ?? { w: 0, l: 0 };
  const t = tierOf(p.version);
  const lineage = c.lineages.find((l) => l.id === p.lineageId);
  const intel = v.intel.find((i) => i.playerId === p.id);
  const presets = v.presets.filter((x) => x.playerId === p.id);
  const upCost = p.weeklySalary * e.upgradeCostWeeks;
  const maxed = p.version >= maxVersionOf(c, p.lineageId);
  const active = canAct(ctx);
  const stats: [string, string][] = [
    ['評分', `<b>${p.elo}</b>`],
    ['戰績', `${rec.w} 勝 ${rec.l} 敗`],
    ['版本', `v${p.version}・<span style="color:${t.color}">${t.name}</span>`],
    ['週薪', coin(p.weeklySalary)],
  ];
  let actions: string;
  if (mine) {
    actions = `<button class="btn-main" data-act="upgrade" data-id="${p.id}" ${!active || p.upgrading || maxed || v.me.cash < upCost ? 'disabled' : ''}>${icon('levelup', 16)}${p.upgrading ? '升版中' : maxed ? '已是最高版本' : `升版培訓 ${wan(upCost)} 萬`}</button>
      <button class="btn-sub" data-act="train-with" data-id="${p.id}" ${!active ? 'disabled' : ''}>${icon('target', 16)}排訓練</button>
      <button class="btn-sub danger" data-act="release" data-id="${p.id}" ${!active || v.me.roster.length <= 3 ? 'disabled' : ''} title="${v.me.roster.length <= 3 ? '陣容至少要 3 人' : ''}">${icon('exit', 16)}解約</button>`;
  } else if (p.teamId === null) {
    actions = `${signBtn(ctx, p)}${scoutBtn(ctx, p)}`;
  } else {
    actions = `${scoutBtn(ctx, p)}<button class="btn-chip" data-act="scrim-vs" data-id="${p.id}" ${!active ? 'disabled' : ''}>${icon('target', 14)}找他打練習賽</button>`;
  }
  return `<div class="pm">
    <div class="pm-card">${playerCard(ctx, p, { intel: !mine, record: rec, act: 'noop' })}</div>
    <div class="pm-info">
      <div class="pm-team">${teamTag(ctx, p.teamId, 24)}</div>
      <h2>${esc(p.name)}</h2>
      <div class="pm-lineage" style="--lc:${lineageColor(p.lineageId)}">${lineageGlyph(p.lineageId, 20)}<b>${lineageName(c, p.lineageId)}</b><span>${esc(lineage?.style ?? '')}</span></div>
      <dl class="pm-stats">${stats.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('')}</dl>
      ${mine && p.upgrading ? '<p class="pm-note">升版培訓中，完成後週薪 ×1.3，原有戰術預設失效。</p>' : ''}
      ${!mine ? `<p class="pm-note">${intel ? `球探報告（${intel.week === 0 ? '休賽期' : `第 ${intel.week} 週`}）：真實強度約 <b>${intel.estPower}</b>（±${intel.sd}），比評分${intel.estPower >= p.elo ? '高' : '低'} ${Math.abs(intel.estPower - p.elo)}。` : '還沒有球探情報。'}</p>` : ''}
      ${mine ? `<div class="pm-presets"><h4>${icon('flask', 14)}戰術預設</h4>${presets.length ? presets.map((x) => `<span class="chip ${x.valid ? '' : 'off'}">${x.target === 'generic' ? '泛用' : `剋${lineageName(c, x.target)}`} 約 +${x.reportedBonus}</span>`).join('') : '<span class="muted">還沒有，到訓練基地研發</span>'}</div>` : ''}
      <div class="pm-actions">${actions}</div>
    </div></div>`;
}

/** 戰隊名單的小標，聯賽與市場共用 */
export function teamHeader(ctx: Ctx, teamId: string): string {
  return `${crest(ctx, teamId, 28)}<b>${esc(teamName(ctx, teamId))}</b>`;
}
