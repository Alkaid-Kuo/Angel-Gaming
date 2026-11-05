// 戰術室（M5 第一批）：十個戰術的隊伍默契、出賽名單個人平均、執行熟練度，比賽計畫（偏好星級、禁用、經濟風格），排練。
// 資料只讀已知層：自己的默契、計畫、自己人的個人熟練度。排練佔訓練中心的每週時段，推進一週後才漲。
import type { TacticSpec } from '../../manage/index.ts';
import { lineupOf } from '../club/model.ts';
import type { Ctx } from './kit.ts';
import { btn, canAct, esc, head, icon, pt, wan } from './kit.ts';

/** 偏好的循環：0 → 1 → 2 → 3 → 禁用 → 0 */
export function nextPref(p: number): number {
  return p === -1 ? 0 : p >= 3 ? -1 : p + 1;
}

function stars(p: number): string {
  if (p === -1) return '<span class="ban">禁用</span>';
  return `<span class="st">${[1, 2, 3].map((i) => `<i class="${i <= p ? 'on' : ''}">★</i>`).join('')}</span>`;
}

const ECON = ['標準', '保守', '積極'] as const;
const ECON_TIP = ['照隊內預設的買法', '存錢門檻高，少強起', '強起門檻低，常常硬買'] as const;

export function tacticsScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const active = canAct(v);
  const left = Math.max(0, v.me.capacityLeft);
  const sessions = Math.max(1, Math.min(ui.rehearse.sessions, Math.max(1, left)));
  const cost = sessions * c.economy.rehearseCost;
  const lineup = lineupOf(ctx).ids.map((id) => ctx.pm.get(id));
  const avg = (t: string): number => Math.round(lineup.reduce((s, p) => s + (p?.tactics?.[t] ?? 0), 0) / Math.max(1, lineup.length));
  const queued = (t: string): number => v.jobs.reduce((s, j) => (j.kind === 'rehearse' && j.tactic === t ? s + j.sessions : s), 0);
  const plan = v.me.gamePlan;
  const sideOpen = (side: 'T' | 'CT'): number => c.tactics.filter((t) => t.side === side && (plan.pref[t.id] ?? 0) !== -1).length;
  const row = (t: TacticSpec): string => {
    const team = v.me.playbook[t.id] ?? 0;
    const eff = v.me.effective[t.id] ?? 0;
    const p = plan.pref[t.id] ?? 0;
    const q = queued(t.id);
    // 每邊至少留一個戰術：最後一個不能再按成禁用
    const lastOpen = p === 3 && sideOpen(t.side) <= 1;
    return `<div class="tr ${p === -1 ? 'off' : ''}">
      <b>${esc(t.name)}</b>
      <div class="bar"><div class="meter g" style="--v:${team}%"><i></i></div><span class="num">${team}</span></div>
      <span class="num pa">${avg(t.id)}</span>
      <span class="num eff">${eff}</span>
      <button class="pf" data-act="pref" data-t="${t.id}" ${!active || lastOpen ? 'disabled' : ''} title="${lastOpen ? '這一邊至少要留一個戰術' : '點一下切換：不偏好 → 1～3 星 → 禁用'}">${stars(p)}</button>
      <button class="rh" data-act="rehearse" data-t="${t.id}" ${!active || left < sessions || v.me.cash < cost ? 'disabled' : ''}>${q ? `已排 ${q} 節 · ` : ''}排練</button>
    </div>`;
  };
  const table = (side: 'T' | 'CT', no: string, title: string, en: string): string =>
    `<div class="pn ${side === 'T' ? 'tt' : 'tc'} in">${pt(no, title, '', en)}
      <div class="tr hd"><span>戰術</span><span>隊伍默契</span><span>出賽平均</span><span>執行</span><span>比賽計畫</span><span></span></div>
      ${c.tactics.filter((t) => t.side === side).map(row).join('')}</div>`;
  return `${head('TACTICS // 戰術室', '戰術室', `執行熟練度 ＝ 隊伍默契與出賽五人個人熟練度各半 · 比賽計畫決定選手自己選戰術時偏好什麼 · 本週剩 <b>${left}</b> 個訓練時段`)}
    <section class="body s-tactics">
      ${table('T', '01', '進攻方', 'T SIDE')}
      ${table('CT', '02', '防守方', 'CT SIDE')}
      <div class="pn g reh in">${pt('03', '排練與經濟', '', 'REHEARSAL')}
        <div class="lbl">每次排練的節數</div>
        <div class="runs"><input type="range" min="1" max="${Math.max(1, left)}" step="1" value="${sessions}" data-field="rehearse.sessions" ${left < 1 ? 'disabled' : ''}><span class="num" data-out="rehearse.sessions">${sessions}</span></div>
        <p class="dim">${icon('info', 14)}一節佔 1 個訓練時段、${wan(c.economy.rehearseCost)} 萬；出賽五人和隊伍一起漲，越熟越難漲。新人第一次上場，隊伍默契會掉一些。</p>
        <div class="lbl">經濟風格</div>
        <div class="seg3">${ECON.map((n, i) => `<button class="${plan.economy === i ? 'on' : ''}" data-act="econ" data-e="${i}" title="${ECON_TIP[i]}" ${active ? '' : 'disabled'}>${n}</button>`).join('')}</div>
        <div class="go">${btn('去訓練基地', 'data-act="go" data-to="training"', 'sm ghost')}</div>
      </div>
    </section>`;
}
