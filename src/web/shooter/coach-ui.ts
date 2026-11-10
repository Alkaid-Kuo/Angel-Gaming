// 教練模式的介面（M5 規格 6.5）：上方狀態列（暫停鍵、速度、轉一般觀戰）與停下時的教練面板。
// 暫停：本回合照打，停在下一回合凍結前，跳出面板（下一回合戰術、經濟、修改比賽計畫）；換邊自動停一次，面板只有修改計畫。
// 其餘 HUD（選手列表、控制列、鏡頭、小地圖）和一般觀戰同一套（spectate.ts、hud.ts），只看得到己方（UI 審核 #6）。
// 沒有倒數（單人遊戲，模擬已停）。照攻防戰對局介面偏好：半透明、重要的放中間、字小、不放說明文字。
// 往回看（規格 6.12）：狀態列有「◀」回看上一回合；回放中標「回放中 · 第 n 回合」，有「▶」下一回合與「回到現場」，
// 暫停鍵停用（快捷鍵也擋），停點的面板收起、推回現場才再打開（選到一半的指令保留）。
import type { CoachCall, CoachPlan } from '../../manage/gateway.ts';
import type { CoachStop } from '../../shooter/live-coach.ts';
import type { CoachInfo, CoachStatus } from './protocol.ts';

export interface CoachUiHandlers {
  readonly pause: (on: boolean) => void;
  readonly resolve: (plan: CoachPlan | null, call: CoachCall | null) => void;
  readonly leave: () => void;
  readonly speed: (i: number) => void;
  /** 往回看上一回合（回放中是再往前一回合） */
  readonly prev: () => void;
  /** 回放中跳下一回合 */
  readonly next: () => void;
  /** 回放中回到現場 */
  readonly live: () => void;
}

const BUYS: readonly { readonly id: CoachCall['buy']; readonly name: string }[] = [
  { id: null, name: '交給選手' },
  { id: 'full', name: '全買' },
  { id: 'force', name: '強起' },
  { id: 'eco', name: '存錢' },
];
const ECON = ['標準', '保守', '積極'] as const;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const stars = (p: number): string => (p < 0 ? '禁' : p === 0 ? '·' : '★'.repeat(p));
const nextPref = (p: number): number => (p === -1 ? 0 : p >= 3 ? -1 : p + 1);

export class CoachUi {
  private readonly bar: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly info: CoachInfo;
  private readonly on: CoachUiHandlers;
  private status: CoachStatus = { round: 1, timeoutsLeft: 2, pending: false, left: false, replay: false, liveRound: 0, canRewind: false, seeking: false };
  private stop: CoachStop | null = null;
  private tactic: string | null = null;
  private buy: CoachCall['buy'] = null;
  private plan: CoachPlan | null = null;
  private speedIdx: number;
  private readonly speeds: readonly number[];

  constructor(root: HTMLElement, info: CoachInfo, speeds: readonly number[], speedIdx: number, on: CoachUiHandlers) {
    this.info = info;
    this.on = on;
    this.speeds = speeds;
    this.speedIdx = speedIdx;
    this.bar = document.createElement('div');
    this.bar.className = 'sg-coach';
    this.panel = document.createElement('div');
    this.panel.className = 'sg-coachp hidden';
    root.append(this.bar, this.panel);
    this.bar.addEventListener('click', (e) => this.onBar(e));
    this.panel.addEventListener('click', (e) => this.onPanel(e));
    this.drawBar();
  }

  get waiting(): boolean {
    return this.stop !== null;
  }

  setStatus(s: CoachStatus): void {
    // 停點還沒處理（含回看中）：剩餘次數照停點算（這次暫停已經算進去）
    this.status = this.stop !== null ? { ...s, timeoutsLeft: this.stop.timeoutsLeft, pending: false } : s;
    // 回放中收起停點的面板（停點還在，推回現場時 Worker 再交出來）
    if (s.replay) this.panel.classList.add('hidden');
    this.drawBar();
  }

  /** 回放中（含重跑中）：不能下指令 */
  get replaying(): boolean {
    return this.status.replay || this.status.seeking;
  }

  setSpeed(i: number): void {
    this.speedIdx = i;
    this.drawBar();
  }

  /** 空白鍵／P：按暫停或取消 */
  togglePause(): void {
    if (this.status.left || this.stop !== null || this.replaying) return;
    if (this.status.pending) this.on.pause(false);
    else if (this.status.timeoutsLeft > 0) this.on.pause(true);
  }

  showStop(s: CoachStop): void {
    // 回看完推回現場：同一個停點再交出來，面板照原樣打開（選到一半的指令保留）
    if (this.stop !== null && this.stop.round === s.round && this.stop.kind === s.kind) {
      this.status = { ...this.status, round: s.round, timeoutsLeft: s.timeoutsLeft, pending: false, replay: false, seeking: false };
      this.panel.classList.remove('hidden');
      this.drawBar();
      return;
    }
    this.stop = s;
    this.status = { ...this.status, round: s.round, timeoutsLeft: s.timeoutsLeft, pending: false };
    this.tactic = null;
    this.buy = null;
    this.plan = structuredClone(s.plan);
    this.drawPanel();
    this.panel.classList.remove('hidden');
    this.drawBar();
  }

  private drawBar(): void {
    const s = this.status;
    const pause = s.left
      ? '<span class="tag">一般觀戰</span>'
      : s.pending
        ? `<button data-act="cpause" class="on">暫停已排定（剩 ${s.timeoutsLeft}）· 取消</button>`
        : `<button data-act="cpause" ${s.timeoutsLeft <= 0 || this.stop !== null ? 'disabled' : ''}>暫停（剩 ${s.timeoutsLeft}）</button>`;
    // 速度鈕在下方控制列（和一般觀戰一樣），這裡只放教練的事：回合、往回看、暫停、轉一般觀戰
    const busy = s.seeking ? 'disabled' : '';
    const back = s.left || !s.canRewind ? '' : `<button data-act="cprev" title="上一回合（P）" ${busy}>◀</button>`;
    const round = this.replaying ? `<b class="rp">回放中 · 第 ${s.round} 回合</b>` : `<b>第 ${s.round} 回合</b>`;
    const fwd = this.replaying ? `<button data-act="cnext" title="下一回合（N）" ${busy}>▶</button><button data-act="clive" class="on" ${busy}>回到現場</button>` : '';
    const pauseBtn = this.replaying && !s.left ? `<button data-act="cpause" disabled>暫停（剩 ${s.timeoutsLeft}）</button>` : pause;
    this.bar.innerHTML = `<span class="en">COACH</span>${back}${round}${fwd}${pauseBtn}${s.left ? '' : '<button data-act="cleave" class="lv">轉一般觀戰</button>'}`;
  }

  private drawPanel(): void {
    const s = this.stop;
    const plan = this.plan;
    if (s === null || plan === null) return;
    const mine = this.info.tactics.filter((t) => t.side === s.side);
    const tac = [{ id: null as string | null, name: '交給選手', tips: '' }, ...mine.map((t) => ({ id: t.id as string | null, name: t.name, tips: t.tips ?? '' }))];
    const call =
      s.kind === 'timeout'
        ? `<div class="sec"><small>第 ${s.round} 回合戰術</small><div class="opts">${tac.map((t) => `<button data-act="ctac" data-id="${t.id ?? ''}" class="${t.id === this.tactic ? 'on' : ''}" ${t.tips ? `data-tip="${esc(t.tips)}"` : ''}>${esc(t.name)}</button>`).join('')}</div></div>
           <div class="sec"><small>經濟</small><div class="opts">${BUYS.map((b) => `<button data-act="cbuy" data-id="${b.id ?? ''}" class="${b.id === this.buy ? 'on' : ''}">${b.name}</button>`).join('')}</div></div>`
        : '';
    const prefs = (['T', 'CT'] as const)
      .map((side) => `<div class="pl"><small>${side === 'T' ? '進攻' : '防守'}</small>${this.info.tactics.filter((t) => t.side === side).map((t) => `<button data-act="cpref" data-id="${t.id}" class="pf ${(plan.pref[t.id] ?? 0) < 0 ? 'ban' : ''}">${esc(t.name)}<i>${stars(plan.pref[t.id] ?? 0)}</i></button>`).join('')}</div>`)
      .join('');
    this.panel.innerHTML = `<div class="box"><span class="en">${s.kind === 'timeout' ? 'TIMEOUT' : 'HALFTIME'}</span><b>${s.kind === 'timeout' ? `暫停 · 第 ${s.round} 回合` : `換邊 · 第 ${s.round} 回合`}</b>
      ${call}
      <div class="sec"><small>比賽計畫</small>${prefs}<div class="opts">${ECON.map((n, i) => `<button data-act="cecon" data-i="${i}" class="${plan.economy === i ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <div class="go"><button class="primary" data-act="cgo">繼續</button></div></div>`;
  }

  private onBar(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button');
    if (b === null || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'cpause') this.togglePause();
    else if (act === 'cspeed') this.on.speed(Number(b.dataset.i));
    else if (act === 'cprev') this.on.prev();
    else if (act === 'cnext') this.on.next();
    else if (act === 'clive') this.on.live();
    else if (act === 'cleave' && confirm('轉成一般觀戰之後就不能再下指令，有請助理教練的話由他從下一回合接手。確定？')) this.on.leave();
    b.blur();
  }

  private onPanel(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button');
    if (b === null || b.disabled || this.plan === null || this.replaying) return;
    const act = b.dataset.act;
    const id = b.dataset.id ?? '';
    if (act === 'ctac') this.tactic = id === '' ? null : id;
    else if (act === 'cbuy') this.buy = id === '' ? null : (id as CoachCall['buy']);
    else if (act === 'cecon') this.plan = { ...this.plan, economy: Number(b.dataset.i) as 0 | 1 | 2 };
    else if (act === 'cpref') {
      const next = nextPref(this.plan.pref[id] ?? 0);
      const side = this.info.tactics.find((t) => t.id === id)?.side;
      const pref = { ...this.plan.pref, [id]: next };
      // 每邊至少留一個戰術
      if (next === -1 && this.info.tactics.filter((t) => t.side === side).every((t) => (pref[t.id] ?? 0) === -1)) pref[id] = 0;
      this.plan = { ...this.plan, pref };
    } else if (act === 'cgo') {
      const s = this.stop;
      if (s === null) return;
      const call = s.kind === 'timeout' && (this.tactic !== null || this.buy !== null) ? { tactic: this.tactic, buy: this.buy } : null;
      this.stop = null;
      this.panel.classList.add('hidden');
      this.on.resolve(this.plan, call);
      this.drawBar();
      return;
    }
    this.drawPanel();
  }
}
