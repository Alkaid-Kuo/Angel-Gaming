// 戰術室（M5 第一批）：十個戰術的隊伍默契、出賽名單個人平均、執行熟練度，比賽計畫（偏好星級、禁用、經濟風格），排練。
// 每個戰術名滑過顯示內容包的說明（desc）與相剋提示（tips）（UI 審核 #15）；文字只供顯示。
// 資料只讀已知層：自己的默契、計畫、自己人的個人熟練度、自己派的球探對戰隊報告。排練佔訓練中心的每週時段，推進一週後才漲。
import type { TacticSpec } from '../../manage/index.ts';
import { lineupOf } from '../club/model.ts';
import type { Ctx } from './kit.ts';
import { btn, canAct, crest, esc, foeOf, head, icon, pt, teamName, wan } from './kit.ts';

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

/**
 * 對手情報（M5 5.3 球探對戰隊）：選一隊、派球探（費用同球探），推進一週後看到該隊近 3 場各陣營的常用戰術前三名。
 * 只顯示自己派過的報告（已知層 teamIntel）；對手的熟練度與計畫看不到。
 */
function scoutPanel(ctx: Ctx, active: boolean): string {
  const { v, c, ui } = ctx;
  const others = v.teams.filter((t) => t.id !== v.me.teamId);
  const foe = foeOf(v);
  const sel = others.find((t) => t.id === ui.scoutTeam)?.id ?? foe ?? others[0]?.id ?? null;
  if (sel === null) return '';
  const rep = v.teamIntel.find((r) => r.teamId === sel);
  const pending = v.jobs.some((j) => j.kind === 'scoutTeam' && j.targetId === sel);
  const cost = c.economy.scoutCost;
  const name = (id: string): string => c.tactics.find((t) => t.id === id)?.name ?? id;
  const col = (side: 'T' | 'CT', label: string): string => {
    const list = rep?.top[side] ?? [];
    const n = rep?.rounds[side] ?? 0;
    return `<div class="sc"><h5>${label}<small>${n ? `${n} 回合` : ''}</small></h5>${list.length ? list.map((x) => `<div class="tl2"><b>${esc(name(x.tactic))}</b><span class="num">${x.played}</span><small>贏 ${x.won}</small><span class="shr">${Math.round((x.played * 100) / Math.max(1, n))}%</span></div>`).join('') : `<p class="dim">${rep ? '沒有紀錄' : '—'}</p>`}</div>`;
  };
  const meta = rep ? `第 ${rep.week} 週報告 · ${rep.weeks.length ? `看了 ${rep.weeks.map((w) => `W${w}`).join('、')}` : '還沒有比賽紀錄'}` : '還沒派過球探';
  const canGo = active && v.phase === 'season' && !pending && v.me.cash >= cost;
  return `<div class="pn sct in">${pt('05', '對手情報', '球探看戰隊', 'SCOUTING')}
    <div class="picks">${others.map((t) => `<button class="pk ${t.id === sel ? 'on' : ''} ${t.id === foe ? 'foe' : ''}" data-act="steam" data-t="${t.id}" data-tip="${esc(t.name)}${t.id === foe ? '（本週對手）' : ''}">${crest(ctx, t.id, 30)}</button>`).join('')}</div>
    <div class="who"><b class="${sel === foe ? 'rd' : ''}">${esc(teamName(v, sel))}</b>${sel === foe ? '<small>本週對手</small>' : ''}<span class="meta">${meta}</span></div>
    <div class="cols">${col('T', '進攻')}${col('CT', '防守')}</div>
    <div class="go"><span class="dim">近 3 場的回合戰術，推進一週後回報（含本週那場）</span>${btn(pending ? '球探出發中' : `派球探 · ${wan(cost)} 萬`, `data-act="scoutTeam" data-t="${sel}" ${canGo ? '' : 'disabled'}`, 'sm ghost')}</div>
  </div>`;
}

export function tacticsScreen(ctx: Ctx): string {
  const { v, c, ui } = ctx;
  const active = canAct(v);
  const left = Math.max(0, v.me.slotsLeft);
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
    const log = v.me.tacticLog[t.id];
    // 每邊至少留一個戰術：最後一個不能再按成禁用
    const lastOpen = p === 3 && sideOpen(t.side) <= 1;
    return `<div class="tr ${p === -1 ? 'off' : ''}">
      <b class="tn">${esc(t.name)}<i class="hint"><span>${esc(t.desc)}</span><small>相剋：${esc(t.tips)}</small></i></b>
      <div class="bar"><div class="meter g" style="--v:${team}%"><i></i></div><span class="num">${team}</span></div>
      <span class="num pa">${avg(t.id)}</span>
      <span class="num eff">${eff}</span>
      <span class="lg">${log ? `<b class="num">${log.played}</b> 打 <b class="num">${log.won}</b> 贏` : '—'}</span>
      <button class="pf" data-act="pref" data-t="${t.id}" ${!active || lastOpen ? 'disabled' : ''} data-tip="${lastOpen ? '這一邊至少要留一個戰術' : '點一下切換：不偏好 → 1～3 星 → 禁用'}">${stars(p)}</button>
      <button class="rh" data-act="rehearse" data-t="${t.id}" ${!active || left < sessions || v.me.cash < cost ? 'disabled' : ''} data-tip="${!active ? '賽段結束' : left < sessions ? '本週訓練時段不夠' : v.me.cash < cost ? '資金不足' : `排 ${sessions} 節，推進一週後熟練度才漲`}">${q ? `已排 ${q} · ` : ''}排練 ${sessions} 節</button>
    </div>`;
  };
  const table = (side: 'T' | 'CT', no: string, title: string, en: string): string =>
    `<div class="pn ${side === 'T' ? 'tt' : 'tc'} in">${pt(no, title, `每次排練 <b>${sessions}</b> 節 · ${wan(cost)} 萬`, en)}
      <div class="tr hd"><span>戰術</span><span data-tip="全隊一起排練、一起打比賽累積的默契">隊伍默契</span><span data-tip="出賽五人各自的個人熟練度平均（跟著選手走）">出賽平均</span><span data-tip="比賽裡實際用的數字：隊伍默契與出賽平均各半">執行</span><span data-tip="本季打過幾回合、贏幾回合">本季</span><span data-tip="點星級切換：不偏好 → 1～3 星 → 禁用；星越多選手越常選">比賽計畫</span><span></span></div>
      ${c.tactics.filter((t) => t.side === side).map(row).join('')}</div>`;
  return `${head('TACTICS // 戰術室', '戰術室', `左邊兩張表：每個戰術的熟練度與比賽計畫 · 右邊：排練節數、比賽計畫的經濟與助理教練、對手情報 · 本週剩 <b>${left}</b> 個訓練時段`)}
    <section class="body s-tactics">
      ${table('T', '01', '進攻方', 'T SIDE')}
      ${table('CT', '02', '防守方', 'CT SIDE')}
      <div class="pn g reh in">${pt('03', '排練', `本週剩 <b>${left}</b> 節`, 'REHEARSAL')}
        <div class="runs"><span class="lbl">每次排練</span><input type="range" min="1" max="${Math.max(1, left)}" step="1" value="${sessions}" data-field="rehearse.sessions" ${left < 1 ? 'disabled' : ''}><span class="num" data-out="rehearse.sessions">${sessions}</span><span class="lbl">節</span></div>
        <p class="dim">${icon('info', 14)}在左邊表格按「排練」。一節佔 1 個訓練時段、${wan(c.economy.rehearseCost)} 萬；出賽五人和隊伍一起漲，越熟越難漲。新人第一次上場，隊伍默契會掉一些。</p>
      </div>
      <div class="pn plan in">${pt('04', '比賽計畫', '選手自己選戰術時照這個', 'GAME PLAN')}
        <div class="row2"><span class="lbl">經濟風格</span><div class="seg3">${ECON.map((n, i) => `<button class="${plan.economy === i ? 'on' : ''}" data-act="econ" data-e="${i}" data-tip="${ECON_TIP[i]}" ${active ? '' : 'disabled'}>${n}</button>`).join('')}</div></div>
        <div class="row2"><span class="asst" data-tip="有請時，跳過的比賽由助理教練代喊暫停與命令（連輸三回合、對方賽點時暫停；換邊時依本場勝負調星級）">${icon('users', 14)}助理教練 ${v.me.assistant ? `<b>已請</b> · ${wan(c.economy.assistantSalary)} 萬／週` : '<span class="dim">未請</span>'}</span>${btn(v.me.assistant ? '辭退' : `請助理教練 · ${wan(c.economy.assistantSalary)} 萬／週`, `data-act="assistant" ${active ? '' : 'disabled'}`, 'sm ghost')}</div>
      </div>
      ${scoutPanel(ctx, active)}
    </section>`;
}
