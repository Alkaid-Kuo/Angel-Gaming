// CS 射擊可玩版的 HUD：頂部計分（scorebar.ts）、下方中央血甲彈藥、角落的金錢與武器欄、炸彈狀態、回合提示、擊殺訊息、計分板、結束畫面。
// 全部從觀察資料（與計分板的公開資訊）取值。對局中的介面照 CS：半透明、不擋視野，重要的靠中間，次要的放角落，不放教學文字（web/shooter.css）。
// 隊色照 CS：T 黃、CT 藍，敵我都一樣，換邊時跟著換，介面與世界一致（render.ts）。組別固定，隊色看這組現在打哪一邊。
// 我方永遠在左；經營層觀戰顯示隊名、選手名、角色與版本。
import type { RoundEndReason, ShooterObservation, Team, WeaponId } from '../../shooter/api.ts';
import { portraitOfSeat } from '../portrait.ts';
import { mineGroup } from './render.ts';
import type { CamMode } from './camera.ts';
import type { BoardRow, FullState, KillFeedItem, ShooterFrame, ShooterMeta, ShooterSummary } from './protocol.ts';
import { clockText, clockTicks, visibleHp } from './hudinfo.ts';
import { ScoreBar, avatarHtml, gunIconUrl } from './scorebar.ts';
import { EMBED, type WatchTicket } from './watch.ts';

/** 天使金色票（web/sketch/angel.css） */
export const ANGEL = { gold: '#f0b54a', blue: '#57aef5', red: '#ff5d5d', white: '#eef2f6', grey: '#8b95a4' } as const;
/** 隊色 */
export const TEAM_COLOR: Readonly<Record<Team, string>> = { T: ANGEL.gold, CT: ANGEL.blue };
/** 觀戰速度（[ ] 或控制列切換） */
export const SPEEDS = [0.5, 1, 2, 4, 8] as const;

export const REASON: Readonly<Record<RoundEndReason, string>> = { elimination: '殲滅', bomb: '炸彈引爆', defuse: '拆彈成功', timeout: '時間到' };
const FEED_MS = 6000;
/** 名字、隊名來自經營層存檔（玩家可自訂隊名），放進 HTML 前跳脫 */
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BANNER_MS = 3200;
const CUE_MS = 1600;

const CAM_NAME: Readonly<Record<CamMode, string>> = { follow: '跟隨', free: '自由', overview: '全圖' };
/** 血與甲的小圖示 */
const ICON_HP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2h4v8h8v4h-8v8h-4v-8H2v-4h8z"/></svg>';
const ICON_AR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l9 3v7c0 5-3.6 8.6-9 10-5.4-1.4-9-5-9-10V5z"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

/** 只在內容變了才寫 DOM */
export function setHtml(e: HTMLElement, html: string): void {
  if (e.dataset.h !== html) {
    e.dataset.h = html;
    e.innerHTML = html;
  }
}

export interface RoundMark {
  readonly number: number;
  readonly winner: Team;
  readonly reason: RoundEndReason;
  /** 勝方組別（0＝上半場 T 的那一組） */
  readonly winnerGroup?: 0 | 1;
}

/** 經營層觀戰的重播與存檔成績單是否一致（勝方、回合數、逐回合勝方與累計比分） */
export function sameOutcome(a: NonNullable<ShooterSummary['outcome']>, b: WatchTicket['outcome']): boolean {
  if (a.winner !== b.winner || a.rounds.length !== b.rounds.length) return false;
  return a.rounds.every((r, i) => r.winner === b.rounds[i].winner && r.scoreA === b.rounds[i].scoreA && r.scoreB === b.rounds[i].scoreB);
}

export interface HudExtra {
  readonly throwCdFrac: number;
  readonly grenade: string | null;
  readonly bomb: boolean;
  readonly speed: number;
  readonly xray: boolean;
  /** 觀戰的鏡頭模式 */
  readonly cam: CamMode;
  readonly buyOpen: boolean;
}

export class ShooterHud {
  private readonly meta: ShooterMeta;
  private readonly score: ScoreBar;
  private readonly feed: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly vHp: HTMLElement;
  private readonly vAr: HTMLElement;
  private readonly vGun: HTMLElement;
  private readonly vAmmo: HTMLElement;
  private readonly money: HTMLElement;
  private readonly slots: HTMLElement;
  private readonly bombBar: HTMLElement;
  private readonly board: HTMLElement;
  private readonly zone: HTMLElement | null;
  readonly end: HTMLElement;
  /** 暫停選單（Esc）：繼續、全螢幕、離開比賽 */
  readonly pause: HTMLElement;
  /** 觀戰控制列（暫停、速度、下一回合、全圖）；玩家模式沒有 */
  readonly ctl: HTMLElement | null;
  private readonly ticket: WatchTicket | null;
  /** 我方組別；別隊的比賽 null */
  private readonly mine: 0 | 1 | null;
  private feedItems: { item: KillFeedItem; t: number }[] = [];
  private bannerUntil = 0;
  private cueText = '';
  /** 控制列開著的選單 */
  private menu: 'speed' | 'cam' | null = null;
  private cueUntil = 0;
  private boardShown = false;
  /** 這回合自己是被誰、用什麼打死的（擊殺訊息是公開資訊） */
  private myDeath: KillFeedItem | null = null;
  private readonly faces = new Map<string, string>();
  /** 目前當 T 的組 */
  private tGroup: 0 | 1 = 0;
  readonly rounds: RoundMark[] = [];

  constructor(root: HTMLElement, meta: ShooterMeta, ticket: WatchTicket | null = null) {
    this.meta = meta;
    this.mine = mineGroup(meta);
    this.ticket = meta.watch ? ticket : null;
    this.score = new ScoreBar(root, meta, this.mine ?? 0);
    this.score.paint((g) => this.groupColor(g), (id) => this.face(id, true));
    this.feed = el('div', 'sg-feed', root);
    this.banner = el('div', 'sg-banner hidden', root);
    this.hint = el('div', 'sg-hint', root);
    const vitals = el('div', 'sg-vitals', root);
    this.vHp = el('span', 'st hp', vitals);
    this.vAr = el('span', 'st ar', vitals);
    el('i', 'sep', vitals);
    this.vGun = el('span', 'gun', vitals);
    this.vAmmo = el('span', 'am', vitals);
    this.money = el('div', 'sg-money', root);
    this.slots = el('div', 'sg-slots', root);
    this.bombBar = el('div', 'sg-bombbar hidden', root);
    this.board = el('div', 'sg-board hidden', root);
    this.zone = root.querySelector('.sg-radar .rz b');
    this.end = el('div', 'sg-end hidden', root);
    this.pause = el('div', 'sg-pause hidden', root);
    // 觀戰與教練模式都有控制列（教練：暫停鈕是教練暫停、沒有下一回合與透視）
    this.ctl = meta.spectate || meta.coach !== undefined ? el('div', 'sg-ctl', root) : null;
    const resume = meta.spectate ? '繼續（空白鍵）' : '繼續（Esc）';
    const quit = EMBED ? '跳過比賽' : meta.watch ? '回經營' : meta.spectate ? '離開觀戰' : '離開比賽';
    this.pause.innerHTML =
      `<div class="box"><small class="en">PAUSED</small><b>暫停</b>` +
      `<div class="col"><button type="button" class="primary" data-act="resume">${resume}</button>` +
      `<button type="button" data-act="fullscreen">全螢幕（F11）</button>` +
      `<button type="button" data-act="quit">${quit}</button></div>` +
      `<p class="muted small">${meta.spectate ? '' : '全螢幕時 Ctrl 蹲著按 W 不會關掉分頁（按住 Esc 離開全螢幕）。離開比賽＝直接回開局畫面，不計成績。'}</p></div>`;
  }

  /** 短暫提示（按了但現在不能做的事） */
  cue(text: string, now: number): void {
    this.cueText = text;
    this.cueUntil = now + CUE_MS;
  }

  showBanner(html: string, now: number): void {
    this.banner.innerHTML = html;
    this.banner.classList.remove('hidden', 'pop');
    void this.banner.offsetWidth;
    this.banner.classList.add('pop');
    this.bannerUntil = now + BANNER_MS;
  }

  addFeed(items: readonly KillFeedItem[], now: number): void {
    for (const item of items) {
      this.feedItems.push({ item, t: now });
      if (!this.meta.spectate && item.victim === this.meta.playerId) this.myDeath = item;
    }
    if (this.feedItems.length > 6) this.feedItems.splice(0, this.feedItems.length - 6);
  }

  setBoard(show: boolean): void {
    this.boardShown = show;
    this.board.classList.toggle('hidden', !show);
  }

  setPaused(p: boolean): void {
    this.pause.classList.toggle('hidden', !p);
  }

  private weaponName(weapon: string): string {
    return weapon === 'bomb' ? '炸彈' : (this.meta.weapons.find((w) => w.id === weapon)?.name ?? this.meta.grenades.find((g) => g.id === weapon)?.name ?? weapon);
  }

  /** 跳回合：逐幀累積的東西清掉（回合紀錄由 Worker 下一個 frame 整批補回） */
  reset(): void {
    this.feedItems = [];
    this.rounds.length = 0;
    this.bannerUntil = 0;
    this.banner.classList.add('hidden');
    this.end.classList.add('hidden');
  }

  /** 結算畫面先收起來，留在比賽畫面回看 */
  hideEnd(): void {
    this.end.classList.add('hidden');
  }

  /** 左邊放哪一組：我方；別隊的比賽放主隊 */
  get leftGroup(): 0 | 1 {
    return this.mine ?? 0;
  }

  /** 目前左、右各是哪個陣營 */
  leftRight(board: readonly BoardRow[]): readonly [Team, Team] {
    const left: Team = this.groupOfTeam('T', board) === this.leftGroup ? 'T' : 'CT';
    return [left, left === 'T' ? 'CT' : 'T'];
  }

  groupOf(team: Team, board: readonly BoardRow[]): 0 | 1 {
    return this.groupOfTeam(team, board);
  }

  groupLabel(g: 0 | 1): string {
    return this.groupName(g);
  }

  /** 組別的隊色 */
  groupColor(g: 0 | 1): string {
    return TEAM_COLOR[this.teamNow(g)];
  }

  /** 這組現在打哪一邊 */
  private teamNow(g: 0 | 1): Team {
    return g === this.tGroup ? 'T' : 'CT';
  }

  /** 目前當 T 的組（換邊時要重畫頭像的地方比對用） */
  get sides(): 0 | 1 {
    return this.tGroup;
  }

  /** 選手頭像，外框是隊色（同一個人同一邊、同一形狀只產生一次）；square＝頂部計分板的方形 */
  face(id: number, square = false): string {
    const team = this.teamNow(this.meta.groups[id]);
    const key = `${id}${team}${square ? 's' : ''}`;
    let html = this.faces.get(key);
    if (html === undefined) {
      // 經營層觀戰用選手的立繪；試玩的 Bot 與舊觀戰票沒有立繪代號，依種子與座位挑
      html = avatarHtml(this.meta.watch?.portraits?.[id] || portraitOfSeat(this.meta.seed, id), TEAM_COLOR[team], square);
      this.faces.set(key, html);
    }
    return html;
  }

  /** 目前當 team 的是哪一組（看名單裡任一個該陣營的人） */
  private groupOfTeam(team: Team, board: readonly BoardRow[]): 0 | 1 {
    const row = board.find((b) => b.team === team);
    return row !== undefined ? this.meta.groups[row.id] : team === 'T' ? 0 : 1;
  }

  /** 組別的稱呼：觀戰是隊名；試玩是我方／對手；試玩觀戰是先攻組／先守組 */
  private groupName(g: 0 | 1): string {
    const w = this.meta.watch;
    if (w) return esc(w.teams[g]);
    if (this.meta.spectate) return g === 0 ? '先攻組' : '先守組';
    return g === this.mine ? '我方' : '對手';
  }

  private name(id: number): string {
    return `<span style="color:${this.groupColor(this.meta.groups[id])}">${esc(this.meta.names[id] ?? `#${id}`)}</span>`;
  }

  /** 所在區域名：面積最小的那一區 */
  private zoneAt(x: number, y: number): string {
    const cx = Math.floor(x / 1000);
    const cy = Math.floor(y / 1000);
    let best = '';
    let area = Infinity;
    for (const r of this.meta.map.regions) {
      if (cx < r.x0 || cy < r.y0 || cx >= r.x1 || cy >= r.y1) continue;
      const a = (r.x1 - r.x0) * (r.y1 - r.y0);
      if (a < area) {
        area = a;
        best = r.name;
      }
    }
    return best;
  }

  /** 開關控制列的選單 */
  toggleMenu(m: 'speed' | 'cam'): void {
    this.menu = this.menu === m ? null : m;
  }

  closeMenu(): void {
    this.menu = null;
  }

  /** 觀戰控制列：暫停、下一回合、速度與鏡頭選單、透視、全螢幕、按鍵表、離開（按鈕的 data-act 由 main.ts 處理）；鍵盤熱鍵寫在 title 與按鍵表 */
  updateCtl(speed: number, paused: boolean, over: boolean, map: { xray: boolean; cam: CamMode }): void {
    if (this.ctl === null) return;
    const item = (act: string, on: boolean, label: string, extra = ''): string => `<button type="button" class="${on ? 'on' : ''}" data-act="${act}" ${extra}>${label}</button>`;
    const menu = (m: 'speed' | 'cam', label: string, title: string, items: string): string =>
      `<span class="mn"><button type="button" data-act="menu" data-m="${m}" title="${title}">${label}<small>▾</small></button>${this.menu === m ? `<span class="pop">${items}</span>` : ''}</span>`;
    const speeds = SPEEDS.map((s, i) => item('speed', s === speed, `${s}×`, `data-i="${i}"`)).reverse().join('');
    const cams = item('cam-follow', map.cam === 'follow', CAM_NAME.follow) + item('cam-free', map.cam === 'free', CAM_NAME.free) + item('cam-map', map.cam === 'overview', CAM_NAME.overview);
    const coach = this.meta.coach !== undefined;
    setHtml(
      this.ctl,
      (coach ? '' : `<button type="button" data-act="pause" title="暫停（空白鍵）" ${over ? 'disabled' : ''}>${paused ? '▶' : 'Ⅱ'}</button>`) +
        (coach ? '' : `<button type="button" data-act="skip" title="下一回合（N）" ${over ? 'disabled' : ''}>▶▶</button><i></i>`) +
        menu('speed', `${speed}×`, '速度（[ ]）', speeds) +
        menu('cam', CAM_NAME[map.cam], '鏡頭（M 全圖）', cams) +
        (coach ? '' : item('xray', map.xray, '透視', `title="X" ${map.cam === 'overview' ? 'disabled' : ''}`)) +
        `<i></i>` +
        item('fullscreen', document.fullscreenElement !== null, '⛶', 'title="全螢幕（F11）"') +
        `<button type="button" data-act="help" title="? 或 H">?</button>` +
        `<button type="button" class="${EMBED && !coach ? 'skipm' : ''}" data-act="quit">${coach ? '離席回經營' : EMBED ? '跳過比賽' : this.meta.watch ? '回經營' : '離開'}</button>`,
    );
  }

  /** 觀戰的炸彈狀態：全狀態的炸彈、誰帶著、誰在下包或拆包、倒數 */
  private spectateBomb(full: FullState): string {
    const b = full.bomb;
    const rules = this.meta.rules;
    const tps = rules.ticksPerSecond;
    const who = (id: number): string => this.name(id);
    const bar = (frac: number): string => `<div class="bar"><i style="width:${Math.min(100, frac * 100)}%"></i></div>`;
    const left = b.ticksLeft !== null ? `<b>${(b.ticksLeft / tps).toFixed(1)}</b>` : '';
    if (b.state === 'carried') {
      const c = full.players.find((p) => p.id === b.carrier);
      if (c === undefined) return '';
      const plant = c.plantTicks ?? 0;
      return plant > 0 ? `<span>${who(c.id)} 下包中</span>${bar(plant / rules.plantTicks)}` : `<span>炸彈在 ${who(c.id)} 身上</span>`;
    }
    if (b.state === 'dropped') return '<span>炸彈掉在地上</span>';
    if (b.state === 'planted') {
      const d = full.players.find((p) => (p.defuseTicks ?? 0) > 0);
      const site = `<span>炸彈在 ${b.site ?? '?'} 點</span>`;
      if (d === undefined) return `${site}${bar((b.ticksLeft ?? 0) / rules.bombTicks)}${left}`;
      return `${site}<span>${who(d.id)} 拆包中${d.kit === true ? '（拆彈器）' : ''}</span>${bar((d.defuseTicks ?? 0) / (d.kit === true ? rules.defuseKitTicks : rules.defuseTicks))}${left}`;
    }
    return b.state === 'defused' ? '<span>炸彈已拆除</span>' : b.state === 'exploded' ? '<span>炸彈已引爆</span>' : '';
  }

  /** 沒有全狀態時的炸彈條（教練模式）：己方觀察資料聯集裡的炸彈狀態 */
  private viewBomb(view: ShooterObservation, tps: number): string {
    const vm = view.me;
    if (vm.plantTicks > 0) return `<span>${this.name(vm.id)} 下包中</span>`;
    if (vm.defuseTicks > 0) return `<span>${this.name(vm.id)} 拆包中</span>`;
    const b = view.bomb;
    if (b.state === 'planting') return '<span>隊友下包中</span>';
    if (b.state === 'planted' || b.state === 'defusing') return `<span>炸彈在 ${b.site ?? '?'} 點${b.state === 'defusing' ? '・拆包中' : ''}</span><b>${b.ticksLeft !== null ? (b.ticksLeft / tps).toFixed(1) : ''}</b>`;
    if (b.state === 'carried') {
      const c = vm.hasBomb ? vm.id : (view.teammates.find((t) => t.hasBomb)?.id ?? null);
      return c === null ? '' : `<span>炸彈在 ${this.name(c)} 身上</span>`;
    }
    if (b.state === 'dropped') return '<span>炸彈掉在地上</span>';
    return b.state === 'defused' ? '<span>炸彈已拆除</span>' : b.state === 'exploded' ? '<span>炸彈已引爆</span>' : '';
  }

  update(f: ShooterFrame, now: number, extra: HudExtra): void {
    const view = f.view;
    const self = f.self;
    const tps = this.meta.rules.ticksPerSecond;
    const r = view.round;
    // 頂部：我方（左）｜時間與比分｜對手（右）；回合資訊在 Tab 計分板
    const leftGroup: 0 | 1 = this.mine ?? 0;
    const tGroup = this.groupOfTeam('T', f.board);
    if (tGroup !== this.tGroup) {
      this.tGroup = tGroup;
      this.score.paint((g) => this.groupColor(g), (id) => this.face(id, true));
    }
    const leftTeam: Team = tGroup === leftGroup ? 'T' : 'CT';
    const rightTeam: Team = leftTeam === 'T' ? 'CT' : 'T';
    const scoreOf = (team: Team): number => (team === 'T' ? r.scoreT : r.scoreCT);
    const boardHead = { round: `第 ${r.number} 回合・${halfLabel(r.half, r.overtime)}`, score: `${scoreOf(leftTeam)} : ${scoreOf(rightTeam)}` };
    const ticks = clockTicks(view);
    this.score.update(f.board, (id) => visibleHp(view, f.full, id), ticks !== null ? clockText(ticks, tps) : '', r.phase, scoreOf(leftTeam), scoreOf(rightTeam));
    if (this.zone !== null) {
      const z = this.zoneAt(view.me.x, view.me.y);
      if (this.zone.textContent !== z) this.zone.textContent = z;
    }
    // 擊殺訊息
    this.feedItems = this.feedItems.filter((x) => now - x.t < FEED_MS);
    setHtml(
      this.feed,
      this.feedItems
        .map(({ item }) => {
          const killer = item.killer >= 0 && item.killer !== item.victim ? this.name(item.killer) : '';
          const mine = !this.meta.spectate && (item.killer === this.meta.playerId || item.victim === this.meta.playerId);
          const gun = this.meta.weapons.find((w) => w.id === item.weapon);
          const how = gun !== undefined ? `<img src="${gunIconUrl(gun.id)}" alt="${gun.name}">` : `<span class="w">${this.weaponName(item.weapon)}</span>`;
          return `<div class="k${mine ? ' mine' : ''}">${killer}${how}${this.name(item.victim)}</div>`;
        })
        .join(''),
    );
    if (now > this.bannerUntil) this.banner.classList.add('hidden');

    // 提示列：只放當下要知道的短句，操作說明在開局畫面
    const hints: string[] = [];
    const specLike = this.meta.spectate || this.meta.coach !== undefined;
    if (specLike) {
      if (extra.cam === 'follow') hints.push(`跟隨 ${this.name(f.viewId)}${this.meta.watch ? `<small class="tg">${esc(this.meta.watch.tags[f.viewId] ?? '')}</small>` : ''}`);
    } else if (!self.me.alive) {
      const d = this.myDeath;
      if (d !== null) hints.push(d.killer >= 0 && d.killer !== d.victim ? `你被 ${this.name(d.killer)} 用 ${this.weaponName(d.weapon)} 擊殺` : `你被${this.weaponName(d.weapon)}炸死`);
      if (view.me.alive) hints.push(`觀看 ${this.name(f.viewId)}`);
    } else {
      this.myDeath = null;
      const onSite = this.meta.map.sites.some((s) => self.me.x / 1000 >= s.x0 && self.me.x / 1000 < s.x1 && self.me.y / 1000 >= s.y0 && self.me.y / 1000 < s.y1);
      if (self.me.hasBomb && r.phase === 'live' && onSite) hints.push('按住 <kbd>E</kbd> 下包');
      if (self.me.team === 'CT' && (self.bomb.state === 'planted' || self.bomb.state === 'defusing') && self.bomb.x !== null && Math.hypot(self.bomb.x - self.me.x, (self.bomb.y ?? 0) - self.me.y) <= 1500 && self.me.defuseTicks === 0) hints.push('按住 <kbd>E</kbd> 拆包');
    }
    setHtml(this.hint, hints.join('<span class="sep"></span>'));

    if (specLike) {
      // 觀戰：血甲錢與武器都在選手列表，這裡只剩炸彈條（教練模式沒有全狀態，用己方觀察資料的炸彈狀態）
      const bomb = f.full !== null ? this.spectateBomb(f.full) : this.viewBomb(view, tps);
      setHtml(this.bombBar, bomb);
      this.bombBar.classList.toggle('hidden', bomb === '');
      if (this.boardShown) this.renderBoard(this.board, f.board, null, boardHead);
      return;
    }

    // 下方中央：血、甲、手上的武器與彈藥（死後看隊友時是隊友的）；左下的錢永遠是自己的
    const vm = view.me;
    const hp = vm.alive ? vm.hp : 0;
    this.vHp.classList.toggle('low', hp <= 30);
    setHtml(this.vHp, `${ICON_HP}<b>${hp}</b>`);
    setHtml(this.vAr, `${ICON_AR}<b>${vm.loadout.armor}</b>${vm.loadout.kit ? '<em>拆</em>' : ''}`);
    setHtml(this.money, `<b>$${self.me.money}</b>${self.round.canBuy && !extra.buyOpen ? '<kbd>B</kbd>' : ''}${now < this.cueUntil ? `<span>${this.cueText}</span>` : ''}`);

    // 右下：武器欄 1～5（主武器、手槍、刀、道具、炸彈），沒有的格子不畫
    const mine = vm.id === this.meta.playerId;
    const gName = (g: string): string => this.meta.grenades.find((x) => x.id === g)?.name ?? g;
    const curSlot = mine && extra.bomb ? 5 : mine && extra.grenade !== null ? 4 : ['primary', 'secondary', 'knife'].indexOf(this.meta.weapons.find((w) => w.id === vm.weapon)?.slot ?? 'knife') + 1;
    const kinds = [...new Set(vm.loadout.grenades)];
    const nades = kinds.map((g) => `<span class="${mine && extra.grenade === g ? 'on' : ''}">${gName(g)}${vm.loadout.grenades.filter((x) => x === g).length > 1 ? '×2' : ''}</span>`).join('');
    const gun = (w: WeaponId | null): string => (w === null ? '' : `<img src="${gunIconUrl(w)}" alt="">`);
    const cells: [number, string][] = [
      [1, gun(vm.loadout.primary)],
      [2, gun(vm.loadout.secondary)],
      [3, gun('knife')],
      [4, nades],
      [5, vm.hasBomb ? '<span>炸彈</span>' : ''],
    ];
    const bar = cells.filter(([, c]) => c !== '').map(([n, c]) => `<div class="ws${n === curSlot ? ' sel' : ''}">${c}<small>${n}</small></div>`).join('');
    setHtml(this.slots, `${bar}<div class="cd"><i style="width:${Math.round(extra.throwCdFrac * 100)}%"></i></div>`);
    setHtml(this.vGun, curSlot >= 4 ? `<small>${mine && extra.bomb ? '炸彈' : extra.grenade !== null ? gName(extra.grenade) : ''}</small>` : gun(vm.weapon));
    setHtml(this.vAmmo, curSlot >= 4 || vm.weapon === 'knife' ? '' : vm.reloadTicksLeft > 0 ? '<small>換彈</small>' : `<b>${vm.ammoMag}</b><small>${vm.ammoReserve}</small>`);

    // 炸彈狀態條
    const rules = this.meta.rules;
    let bombHtml = '';
    if (vm.plantTicks > 0) bombHtml = `<span>下包中</span><div class="bar"><i style="width:${Math.min(100, (vm.plantTicks / rules.plantTicks) * 100)}%"></i></div>`;
    else if (vm.defuseTicks > 0) {
      const need = vm.loadout.kit ? rules.defuseKitTicks : rules.defuseTicks;
      bombHtml = `<span>拆包中</span><div class="bar"><i style="width:${Math.min(100, (vm.defuseTicks / need) * 100)}%"></i></div>`;
    } else if (view.bomb.state === 'planting') bombHtml = '<span>隊友下包中</span>';
    else if (view.bomb.state === 'planted' || view.bomb.state === 'defusing') bombHtml = `<span>炸彈在 ${view.bomb.site ?? '?'} 點${view.bomb.state === 'defusing' ? '・拆包中' : ''}</span><b>${view.bomb.ticksLeft !== null ? (view.bomb.ticksLeft / tps).toFixed(1) : ''}</b>`;
    else if (view.bomb.state === 'dropped' && vm.team === 'T') bombHtml = '<span>炸彈掉在地上</span>';
    setHtml(this.bombBar, bombHtml);
    this.bombBar.classList.toggle('hidden', bombHtml === '');

    if (this.boardShown) this.renderBoard(this.board, f.board, null, boardHead);
  }

  /** 計分板：兩隊各一欄（敵人的金錢在比賽中不公開）；我方在左 */
  renderBoard(target: HTMLElement, rows: readonly BoardRow[], summary: ShooterSummary | null, head: { readonly round: string; readonly score: string } | null = null): void {
    const w = this.meta.watch;
    const marks: readonly RoundMark[] = summary !== null ? summary.rounds.map((x) => ({ number: x.number, winner: x.winner, reason: x.reason as RoundEndReason, winnerGroup: x.winnerGroup })) : this.rounds;
    const groupOfMark = (m: RoundMark): 0 | 1 => m.winnerGroup ?? (m.winner === 'T' ? 0 : 1);
    const hist = marks.map((m) => `<i title="第 ${m.number} 回合：${this.groupName(groupOfMark(m))}勝・${REASON[m.reason]}" style="background:${TEAM_COLOR[m.winner]}"><b>${m.reason === 'bomb' ? '炸' : m.reason === 'defuse' ? '拆' : m.reason === 'timeout' ? '時' : ''}</b></i>`).join('');
    const first: 0 | 1 = this.mine ?? 0;
    const keys: readonly (0 | 1)[] = [first, first === 0 ? 1 : 0];
    const cols = keys
      .map((g) => {
        const list = rows.filter((r) => this.meta.groups[r.id] === g).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        const team = list[0]?.team;
        const body = list
          .map((r) => {
            const money = summary !== null ? summary.players[r.id].money : r.money;
            const me = r.id === this.meta.playerId && !this.meta.spectate;
            const tag = w ? `<small class="tg">${esc(w.tags[r.id] ?? '')}</small>` : '';
            return `<tr class="${r.alive || summary !== null ? '' : 'dead'}${me ? ' me' : ''}"><td class="pn">${this.face(r.id)}<b>${esc(this.meta.names[r.id] ?? '')}</b>${tag}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${money === null ? '—' : `$${money}`}</td></tr>`;
          })
          .join('');
        const head = `<th class="pn" style="color:${this.groupColor(g)}">${this.groupName(g)}${team !== undefined && summary === null ? `<small>${team}</small>` : ''}</th>`;
        return `<table><thead><tr>${head}<th>擊殺</th><th>死亡</th><th>金錢</th></tr></thead><tbody>${body}</tbody></table>`;
      })
      .join('');
    const title = head !== null ? `<h2><span>${head.round}</span><em>${head.score}</em></h2>` : '';
    setHtml(target.querySelector('.sg-board-body') ?? target, `${title}<div class="cols">${cols}</div><div class="hist">${hist}</div>`);
  }

  showEnd(summary: ShooterSummary, rows: readonly BoardRow[], myGroup: 0 | 1): void {
    const [g0, g1] = summary.score;
    if (this.meta.watch && this.ticket !== null) {
      this.showWatchEnd(summary, rows);
      return;
    }
    const left: 0 | 1 = this.meta.spectate ? 0 : myGroup;
    let title: string;
    let cls = '';
    if (summary.winnerGroup === null) title = '平手';
    else if (this.meta.spectate) title = `${this.groupName(summary.winnerGroup)}獲勝`;
    else {
      title = summary.winnerGroup === myGroup ? '勝利' : '落敗';
      cls = summary.winnerGroup === myGroup ? 'win' : 'lose';
    }
    this.end.innerHTML =
      `<div class="box"><div class="head"><small class="en">MATCH // ${this.meta.spectate ? 'SPECTATE' : 'RESULT'}</small><h2 class="${cls}">${title}</h2>${this.vsLine(left, g0, g1)}</div>` +
      `<div class="sg-board-body"></div>` +
      `<div class="foot"><span class="meta">種子 ${this.meta.seed}・共 ${summary.rounds.length} 回合${summary.overtimes > 0 ? `・加時 ${summary.overtimes} 段` : ''}・終局雜湊 ${summary.finalHash}</span><div class="row"><button type="button" class="primary" data-act="again">再來一場</button>${this.meta.spectate ? '<button type="button" data-act="review">回看比賽</button>' : ''}<button type="button" data-act="replay">下載回放</button><button type="button" data-act="home">回開局畫面</button></div></div></div>`;
    // 結束時的陣營是最後一個半場的（可能是加時），換回依組別顯示
    this.renderBoard(this.end.querySelector('.sg-board-body')!, rows.map((r) => ({ ...r, alive: true })), summary);
    this.end.classList.remove('hidden');
  }

  /** 比分列：left 組在左 */
  private vsLine(left: 0 | 1, g0: number, g1: number): string {
    const right: 0 | 1 = left === 0 ? 1 : 0;
    const a = left === 0 ? g0 : g1;
    const b = left === 0 ? g1 : g0;
    return `<div class="vsl"><b style="color:${this.groupColor(left)}">${this.groupName(left)}</b><span class="sc">${a}<i>:</i>${b}</span><b style="color:${this.groupColor(right)}">${this.groupName(right)}</b></div>`;
  }

  /** 經營層觀戰的結束畫面：比分、與存檔成績單的對照、回經營 */
  private showWatchEnd(summary: ShooterSummary, rows: readonly BoardRow[]): void {
    const t = this.ticket as WatchTicket;
    const w = this.meta.watch as NonNullable<ShooterMeta['watch']>;
    const [g0, g1] = summary.score;
    const res = summary.winnerGroup === null ? '平手' : w.mine === null ? `${esc(w.teams[summary.winnerGroup])} 勝` : summary.winnerGroup === w.mine ? '勝利' : '落敗';
    const saved = t.outcome.rounds[t.outcome.rounds.length - 1];
    const ok = summary.outcome !== undefined && sameOutcome(summary.outcome, t.outcome);
    const check = ok
      ? `<p class="ck ok">✓ 與經營層成績單一致：比分 ${g0}：${g1}、${summary.rounds.length} 回合逐回合相同（存檔的請求單重跑）</p>`
      : `<p class="ck bad">✕ 與存檔的成績單不符（存檔 ${saved?.scoreA ?? 0}：${saved?.scoreB ?? 0}、${t.outcome.rounds.length} 回合）</p>`;
    const cls = summary.winnerGroup === null || w.mine === null ? '' : summary.winnerGroup === w.mine ? 'win' : 'lose';
    this.end.innerHTML =
      `<div class="box"><div class="head"><small class="en">${esc(t.title)} // REPLAY</small><h2 class="${cls}">${res}</h2>${this.vsLine(w.mine ?? 0, g0, g1)}</div>` +
      `${check}<div class="sg-board-body"></div>` +
      `<div class="foot"><span class="meta">共 ${summary.rounds.length} 回合${summary.overtimes > 0 ? `・加時 ${summary.overtimes} 段` : ''}・種子 ${this.meta.seed}・終局雜湊 ${summary.finalHash}</span><div class="row"><button type="button" class="primary" data-act="home">回經營</button><button type="button" data-act="review">回看比賽</button><button type="button" data-act="again">重看一次</button><button type="button" data-act="replay">下載回放</button></div></div></div>`;
    this.renderBoard(this.end.querySelector('.sg-board-body')!, rows.map((r) => ({ ...r, alive: true })), summary);
    this.end.classList.remove('hidden');
  }
}

/** 半場名稱：正規「上／下半場」；加時「加時 N・上／下半場」（v1.0） */
export function halfLabel(half: number, overtime: number): string {
  if (overtime === 0) return `${half === 1 ? '上' : '下'}半場`;
  return `加時 ${overtime}・${(half - 3) % 2 === 0 ? '上' : '下'}半場`;
}

/** 回合轉換的提示字：回傳要顯示的 HTML（沒有就 null） */
export function roundBanner(prev: ShooterObservation | null, cur: ShooterObservation, meta: ShooterMeta): string | null {
  if (prev === null || prev.round.number !== cur.round.number) {
    const team = cur.me.team;
    const sub = meta.spectate ? '' : `<small>${meta.coach !== undefined ? '我方' : '你是'} <b>${team}</b>${team === 'T' ? '：帶炸彈攻 A／B 點' : '：守住 A／B 點'}</small>`;
    const n = cur.round.number;
    const rs = meta.rules;
    // 半場首回合：正規下半場換邊；加時每段開始不換邊、段內換邊
    const reg = rs.roundsPerHalf * 2;
    const ot = rs.overtime;
    const k = n - reg;
    if (ot !== false && k > 0 && (k - 1) % (ot.roundsPerHalf * 2) === 0) return `<span>進入加時 ${cur.round.overtime}（不換邊）・第 ${n} 回合</span>${sub}`;
    const halfSwitch = n === rs.roundsPerHalf + 1 || (ot !== false && k > 0 && (k - 1) % ot.roundsPerHalf === 0);
    if (halfSwitch) return `<span>${cur.round.overtime > 0 ? `加時 ${cur.round.overtime}・` : ''}半場換邊・第 ${n} 回合</span>${sub}`;
    return `<span>第 ${n} 回合</span>${sub}`;
  }
  if (prev.round.ended === null && cur.round.ended !== null) {
    const w = cur.round.ended.winner;
    // 玩家模式講我方／對手；觀戰講陣營
    if (meta.spectate) return `<span style="color:${TEAM_COLOR[w]}">${w} 勝</span><small>${REASON[cur.round.ended.reason]}</small>`;
    return `<span style="color:${TEAM_COLOR[w]}">${w === cur.me.team ? '我方勝' : '對手勝'}</span><small>${REASON[cur.round.ended.reason]}</small>`;
  }
  return null;
}
