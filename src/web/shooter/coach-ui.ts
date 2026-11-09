// 教練模式的介面（M5 規格 6.5）：上方狀態列（暫停鍵、速度、轉一般觀戰）與停下時的教練面板。
// 暫停：本回合照打，停在下一回合凍結前，跳出面板（下一回合戰術、經濟、修改比賽計畫）；換邊自動停一次，面板只有修改計畫。
// 其餘 HUD（選手列表、控制列、鏡頭、小地圖）和一般觀戰同一套（spectate.ts、hud.ts），只看得到己方（UI 審核 #6）。
// 沒有倒數（單人遊戲，模擬已停）。照攻防戰對局介面偏好：半透明、重要的放中間、字小、不放說明文字。
import type { CoachCall, CoachPlan } from '../../manage/gateway.ts';
import type { CoachStop } from '../../shooter/live-coach.ts';
import type { CoachInfo, CoachStatus } from './protocol.ts';

export interface CoachUiHandlers {
  readonly pause: (on: boolean) => void;
  readonly resolve: (plan: CoachPlan | null, call: CoachCall | null) => void;
  readonly leave: () => void;
  readonly speed: (i: number) => void;
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
  private status: CoachStatus = { round: 1, timeoutsLeft: 2, pending: false, left: false };
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
    this.status = s;
    this.drawBar();
  }

  setSpeed(i: number): void {
    this.speedIdx = i;
    this.drawBar();
  }

  /** 空白鍵／P：按暫停或取消 */
  togglePause(): void {
    if (this.status.left || this.stop !== null) return;
    if (this.status.pending) this.on.pause(false);
    else if (this.status.timeoutsLeft > 0) this.on.pause(true);
  }

  showStop(s: CoachStop): void {
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
    // 速度鈕在下方控制列（和一般觀戰一樣），這裡只放教練的事：回合、暫停、轉一般觀戰
    this.bar.innerHTML = `<span class="en">COACH</span><b>第 ${s.round} 回合</b>${pause}${s.left ? '' : '<button data-act="cleave" class="lv">轉一般觀戰</button>'}`;
  }

  private drawPanel(): void {
    const s = this.stop;
    const plan = this.plan;
    if (s === null || plan === null) return;
    const mine = this.info.tactics.filter((t) => t.side === s.side);
    const tac = [{ id: null as string | null, name: '交給選手' }, ...mine.map((t) => ({ id: t.id as string | null, name: t.name }))];
    const call =
      s.kind === 'timeout'
        ? `<div class="sec"><small>第 ${s.round} 回合戰術</small><div class="opts">${tac.map((t) => `<button data-act="ctac" data-id="${t.id ?? ''}" class="${t.id === this.tactic ? 'on' : ''}">${esc(t.name)}</button>`).join('')}</div></div>
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
    else if (act === 'cleave' && confirm('轉成一般觀戰之後就不能再下指令，有請助理教練的話由他從下一回合接手。確定？')) this.on.leave();
    b.blur();
  }

  private onPanel(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button');
    if (b === null || b.disabled || this.plan === null) return;
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
