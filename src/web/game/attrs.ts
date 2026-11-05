// 選手屬性（M5 第二批）的畫面零件：成長階段、強度等級、六維雷達、屬性與訓練面板。
// 公開／隱藏照規格 4.7：自己的人看數字與上限等級（公開公式值、標「約」）；別隊看等級，球探報告過的看報告當下的數字；真實上限與習慣永遠不出現。
import type { ContentPack, KnownPlayer } from '../../manage/index.ts';
import { GRADES, STAGE_NAMES, gradeMid, trainGain, TRAIN_FULL_GAIN, type Grade } from '../../manage/attrs.ts';
import type { Ctx } from './kit.ts';
import { btn, canAct, esc, icon, pt, wan } from './kit.ts';

export function stageName(stage: number): string {
  return STAGE_NAMES[stage - 1] ?? `第 ${stage} 階`;
}

/** 強度等級一行，例「B／B+／C」（可訓練屬性） */
export function strengthGrades(c: ContentPack, p: KnownPlayer): string {
  return c.attributes.trainable.map((k) => p.grades[k] ?? '—').join('／');
}

/** 等級的下界（雷達的上限帶用）：D 取 0～44 太寬，畫成 40～44 */
const gradeLow = (g: Grade): number => 40 + 5 * GRADES.indexOf(g);

/** 六維雷達：自己的人實線＋上限帶；別隊用等級中值畫虛線；球探報告過的用報告數字 */
function radar(c: ContentPack, p: KnownPlayer, mine: boolean): string {
  const keys = c.attributes.keys;
  const R = 104;
  const cx = 130;
  const cy = 122;
  const at = (i: number, v: number): [number, number] => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / keys.length;
    const r = (Math.max(0, Math.min(100, v)) / 100) * R;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const poly = (vals: readonly number[]): string => vals.map((v, i) => at(i, v).map((x) => x.toFixed(1)).join(',')).join(' ');
  const rings = [25, 50, 75, 100].map((v) => `<polygon points="${poly(keys.map(() => v))}" class="rg"/>`).join('');
  const axes = keys.map((k, i) => {
    const [x, y] = at(i, 100);
    const [lx, ly] = at(i, 122);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="ax"/><text x="${lx.toFixed(1)}" y="${(ly + 5).toFixed(1)}" class="lb">${esc(c.attributes.names[k] ?? k)}</text>`;
  }).join('');
  const nums = p.attrs !== undefined;
  const vals = keys.map((k) => (nums ? (p.attrs?.[k] ?? 0) : gradeMid(p.grades[k] ?? 'D')));
  let band = '';
  if (mine && p.capGrades !== undefined) {
    const lo = keys.map((k, i) => (p.capGrades?.[k] !== undefined ? gradeLow(p.capGrades[k]) : vals[i]));
    const hi = keys.map((k, i) => (p.capGrades?.[k] !== undefined ? gradeLow(p.capGrades[k]) + 5 : vals[i]));
    const path = (vs: readonly number[]): string => `M${vs.map((v, i) => at(i, v).map((x) => x.toFixed(1)).join(' ')).join(' L')} Z`;
    band = `<path d="${path(hi)} ${path(lo)}" class="cap" fill-rule="evenodd"/>`;
  }
  return `<svg class="radar" viewBox="0 0 260 250" aria-hidden="true">${rings}${axes}${band}<polygon points="${poly(vals)}" class="v ${nums ? '' : 'est'} ${mine ? 'me' : ''}"/></svg>`;
}

/** 屬性與訓練面板（取代版本線）；自己的人可在這裡排訓練 */
export function attrPanel(ctx: Ctx, p: KnownPlayer): string {
  const { v, c } = ctx;
  const e = c.economy;
  const mine = p.teamId === v.me.teamId;
  const active = canAct(v);
  const queued = (k: string): number => v.jobs.reduce((s, j) => (j.kind === 'train' && j.playerId === p.id && j.attr === k ? s + j.sessions : s), 0);
  const weekUsed = v.jobs.reduce((s, j) => (j.kind === 'train' && j.playerId === p.id ? s + j.sessions : s), 0);
  const slots = Math.max(0, v.me.slotsLeft);
  const rows = c.attributes.keys
    .map((k) => {
      const name = esc(c.attributes.names[k] ?? k);
      const trainable = c.attributes.trainable.includes(k);
      const grade = p.grades[k] ?? '—';
      if (!mine) {
        const n = p.attrs?.[k];
        return `<div class="ar"><b>${name}</b><span class="num ${n !== undefined ? '' : 'gr'}">${n !== undefined ? n : grade}</span><span class="dim">${n !== undefined ? grade : ''}</span>${trainable ? '' : `<span class="lock">${icon('lock', 12)}風格</span>`}</div>`;
      }
      const cur = p.attrs?.[k] ?? 0;
      if (!trainable) return `<div class="ar"><b>${name}</b><span class="num">${cur}</span><span class="dim">${grade}</span><span class="lock">${icon('lock', 12)}風格</span></div>`;
      const capG = p.capGrades?.[k];
      const prog = p.progress?.[k] ?? 0;
      // 預估只用公開的上限等級（取級中值），不看真實上限
      const est = capG !== undefined ? trainGain(gradeMid(capG), cur) : TRAIN_FULL_GAIN;
      const q = queued(k);
      const can = active && slots > 0 && weekUsed < e.trainMaxPerPlayer && v.me.cash >= e.trainCost;
      const why = !active ? '' : weekUsed >= e.trainMaxPerPlayer ? `每人每週最多 ${e.trainMaxPerPlayer} 節` : slots <= 0 ? '本週訓練時段用完了' : v.me.cash < e.trainCost ? '資金不足' : `預估每節 +${(est / 100).toFixed(1)} 點（收益約 ${Math.round((est * 100) / TRAIN_FULL_GAIN)}%）· ${wan(e.trainCost)} 萬`;
      return `<div class="ar t"><b>${name}</b><span class="num">${cur}</span><span class="cap">${capG !== undefined ? `上限 約 ${capG}` : ''}</span><div class="meter g" style="--v:${prog}%" title="訓練進度 ${prog}%"><i></i></div>${btn(q ? `已排 ${q} · 再練` : '練 1 節', `data-act="train" data-id="${p.id}" data-attr="${k}" ${can ? '' : 'disabled'} title="${why}"`, 'sm ghost')}</div>`;
    })
    .join('');
  const aux = mine
    ? `本週時段剩 <b>${slots}</b> · 這人已排 ${weekUsed}／${e.trainMaxPerPlayer} 節`
    : p.attrsWeek !== undefined
      ? `第 ${p.attrsWeek} 週球探報告的數字`
      : '只看得到等級，派球探才有數字';
  return `<div class="pn ${mine ? 'g' : ''} p-ver p-attr in">${pt('01', '屬性', aux, 'ATTRIBUTES')}
      <div class="attrs">${radar(c, p, mine)}<div class="alist">${rows}</div></div></div>`;
}
