// CS 射擊可玩版的 HUD：比分與時間、血甲錢、武器彈藥、道具格與投擲冷卻、炸彈狀態、回合提示、擊殺訊息、計分板、結束畫面。
// 全部從觀察資料（與計分板的公開資訊）取值。
// 經營層觀戰（meta.watch）：頂列、計分板、擊殺訊息、結束畫面改用天使金色票（我方金、對手紅；別隊的比賽主隊白、客隊灰），
// 顯示隊名、選手名、角色與版本；地圖、角色、彈道的 T／CT 配色不動。
import type { RoundEndReason, ShooterObservation, Team } from '../../shooter/api.ts';
import { GRENADE_TAG, TEAM_COLOR, WEAPON_TAG } from './render.ts';
import type { BoardRow, KillFeedItem, ShooterFrame, ShooterMeta, ShooterSummary } from './protocol.ts';
import type { WatchTicket } from './watch.ts';

/** 天使金色票（web/sketch/angel.css） */
export const ANGEL = { gold: '#f0b54a', red: '#ff5d5d', white: '#eef2f6', grey: '#8b95a4' } as const;
/** 觀戰速度（[ ] 或控制列切換） */
export const SPEEDS = [0.5, 1, 2, 4, 8] as const;

export const REASON: Readonly<Record<RoundEndReason, string>> = { elimination: '殲滅', bomb: '炸彈引爆', defuse: '拆彈成功', timeout: '時間到' };
const FEED_MS = 6000;
/** 名字、隊名來自經營層存檔（玩家可自訂隊名），放進 HTML 前跳脫 */
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BANNER_MS = 3200;

const clock = (ticks: number, tps: number): string => {
  const s = Math.ceil(ticks / tps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

/** 只在內容變了才寫 DOM */
function setHtml(e: HTMLElement, html: string): void {
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

export class ShooterHud {
  private readonly meta: ShooterMeta;
  private readonly top: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  private readonly bombBar: HTMLElement;
  private readonly board: HTMLElement;
  readonly end: HTMLElement;
  /** 暫停選單（Esc）：繼續、全螢幕、離開比賽 */
  readonly pause: HTMLElement;
  /** 觀戰控制列（暫停、速度、下一回合）；玩家模式沒有 */
  readonly ctl: HTMLElement | null;
  private readonly ticket: WatchTicket | null;
  private feedItems: { item: KillFeedItem; t: number }[] = [];
  private bannerUntil = 0;
  private boardShown = false;
  /** 這回合自己是被誰、用什麼打死的（擊殺訊息是公開資訊） */
  private myDeath: KillFeedItem | null = null;
  readonly rounds: RoundMark[] = [];

  constructor(root: HTMLElement, meta: ShooterMeta, ticket: WatchTicket | null = null) {
    this.meta = meta;
    this.ticket = meta.watch ? ticket : null;
    this.top = el('div', 'sg-top', root);
    this.feed = el('div', 'sg-feed', root);
    this.banner = el('div', 'sg-banner hidden', root);
    this.hint = el('div', 'sg-hint', root);
    this.left = el('div', 'sg-left', root);
    this.right = el('div', 'sg-right', root);
    this.bombBar = el('div', 'sg-bombbar hidden', root);
    this.board = el('div', 'sg-board hidden', root);
    this.end = el('div', 'sg-end hidden', root);
    this.pause = el('div', 'sg-pause hidden', root);
    this.ctl = meta.spectate ? el('div', 'sg-ctl', root) : null;
    const resume = meta.spectate ? '繼續（空白鍵）' : '繼續（Esc）';
    const quit = meta.watch ? '回經營' : meta.spectate ? '離開觀戰' : '離開比賽';
    this.pause.innerHTML =
      `<div class="box"><b>暫停</b>` +
      `<div class="col"><button type="button" class="primary" data-act="resume">${resume}</button>` +
      `<button type="button" data-act="fullscreen">全螢幕（F）</button>` +
      `<button type="button" data-act="quit">${quit}</button></div>` +
      `<p class="muted small">全螢幕時 Ctrl 蹲著按 W 不會關掉分頁（按住 Esc 離開全螢幕）。${meta.spectate ? '' : '離開比賽＝直接回開局畫面，不計成績。'}</p></div>`;
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

  /** 座標（座標單位）周圍 r 格內有沒有矮牆 */
  private nearLow(x: number, y: number, r: number): boolean {
    const map = this.meta.map;
    const cx = x / 1000;
    const cy = y / 1000;
    for (let gy = Math.floor(cy - r); gy <= Math.floor(cy + r); gy++) {
      for (let gx = Math.floor(cx - r); gx <= Math.floor(cx + r); gx++) {
        if (gx < 0 || gy < 0 || gx >= map.width || gy >= map.height || map.solid[gy * map.width + gx] !== 2) continue;
        const dx = Math.max(gx - cx, 0, cx - (gx + 1));
        const dy = Math.max(gy - cy, 0, cy - (gy + 1));
        if (dx * dx + dy * dy <= r * r) return true;
      }
    }
    return false;
  }

  private weaponName(weapon: string): string {
    return weapon === 'bomb' ? '炸彈' : weapon in WEAPON_TAG ? WEAPON_TAG[weapon as keyof typeof WEAPON_TAG] : GRENADE_TAG[weapon as keyof typeof GRENADE_TAG];
  }

  /** 組別的外框顏色（只在經營層觀戰）：我方金、對手紅；別隊的比賽主隊白、客隊灰 */
  groupColor(g: 0 | 1): string {
    const mine = this.meta.watch?.mine ?? null;
    if (mine === null) return g === 0 ? ANGEL.white : ANGEL.grey;
    return g === mine ? ANGEL.gold : ANGEL.red;
  }

  /** 選手名字的顏色：觀戰依組別、其他依陣營 */
  private colorOf(id: number, team: Team | undefined): string {
    if (this.meta.watch) return this.groupColor(this.meta.groups[id]);
    return team !== undefined ? TEAM_COLOR[team] : '#e2e8f0';
  }

  /** 目前當 team 的是哪一組（看名單裡任一個該陣營的人） */
  private groupOfTeam(team: Team, board: readonly BoardRow[]): 0 | 1 {
    const row = board.find((b) => b.team === team);
    return row !== undefined ? this.meta.groups[row.id] : team === 'T' ? 0 : 1;
  }

  private name(id: number, board: readonly BoardRow[]): string {
    return `<span style="color:${this.colorOf(id, board[id]?.team)}">${this.meta.names[id] ?? `#${id}`}</span>`;
  }

  /** 觀戰控制列：暫停／播放、速度、下一回合（按鈕的 data-act 由 main.ts 處理） */
  updateCtl(speed: number, paused: boolean, over: boolean): void {
    if (this.ctl === null) return;
    const sp = SPEEDS.map((s, i) => `<button type="button" class="${s === speed ? 'on' : ''}" data-act="speed" data-i="${i}">${s}×</button>`).join('');
    setHtml(
      this.ctl,
      `<button type="button" data-act="pause" ${over ? 'disabled' : ''}>${paused ? '▶ 播放' : 'Ⅱ 暫停'}<kbd>空白</kbd></button>` +
        `<span class="sp">${sp}<kbd>[</kbd><kbd>]</kbd></span>` +
        `<button type="button" data-act="skip" ${over ? 'disabled' : ''}>下一回合 ▶▶<kbd>N</kbd></button>` +
        `<button type="button" data-act="quit">${this.meta.watch ? '回經營' : '離開觀戰'}</button>`,
    );
  }

  update(f: ShooterFrame, now: number, extra: { throwCdFrac: number; grenade: string | null; bomb: boolean; speed: number; xray: boolean }): void {
    const view = f.view;
    const self = f.self;
    const tps = this.meta.rules.ticksPerSecond;
    const r = view.round;
    // 頂部：T 比分｜時間與回合｜CT 比分
    let time = '';
    let phase: string;
    if (r.phase === 'freeze') {
      time = clock(r.phaseTicksLeft, tps);
      phase = '凍結時間';
    } else if (r.phase === 'live') {
      time = clock(r.phaseTicksLeft, tps);
      phase = `第 ${r.number} 回合`;
    } else if (r.phase === 'planted') {
      time = view.bomb.ticksLeft !== null ? clock(view.bomb.ticksLeft, tps) : '';
      phase = '炸彈已下包';
    } else {
      phase = r.ended !== null ? `${r.ended.winner} 勝・${REASON[r.ended.reason]}` : '回合結束';
    }
    const aliveT = f.board.filter((b) => b.team === 'T' && b.alive).length;
    const aliveCT = f.board.filter((b) => b.team === 'CT' && b.alive).length;
    const w = this.meta.watch;
    const tc = (team: Team): string => (w ? this.groupColor(this.groupOfTeam(team, f.board)) : TEAM_COLOR[team]);
    const pips = (team: Team, n: number): string => Array.from({ length: 5 }, (_, i) => `<i style="${i < n ? `background:${tc(team)}` : ''}"></i>`).join('');
    // 觀戰：隊名（依組別上色）＋小字陣營；其他：T／CT
    const label = (team: Team): string => (w ? `<b style="color:${tc(team)}">${esc(w.teams[this.groupOfTeam(team, f.board)])}</b><small>${team}</small>` : `<b style="color:${TEAM_COLOR[team]}">${team}</b>`);
    setHtml(
      this.top,
      `<div class="tm t">${label('T')}<span class="sc">${r.scoreT}</span><span class="pips">${pips('T', aliveT)}</span></div>` +
        `<div class="mid${r.phase === 'planted' ? ' planted' : ''}"><span class="clock">${time}</span><span class="ph">${phase}</span><span class="rd">第 ${r.number} 回合・${halfLabel(r.half, r.overtime)}</span></div>` +
        `<div class="tm ct"><span class="pips">${pips('CT', aliveCT)}</span><span class="sc">${r.scoreCT}</span>${label('CT')}</div>`,
    );
    // 擊殺訊息
    this.feedItems = this.feedItems.filter((x) => now - x.t < FEED_MS);
    setHtml(
      this.feed,
      this.feedItems
        .map(({ item }) => {
          const killer = item.killer >= 0 && item.killer !== item.victim ? this.name(item.killer, f.board) : '';
          const mine = !this.meta.spectate && (item.killer === this.meta.playerId || item.victim === this.meta.playerId);
          return `<div class="k${mine ? ' mine' : ''}">${killer}<span class="w">${this.weaponName(item.weapon)}</span>${this.name(item.victim, f.board)}</div>`;
        })
        .join(''),
    );
    if (now > this.bannerUntil) this.banner.classList.add('hidden');

    // 提示列
    const hints: string[] = [];
    if (this.meta.spectate) {
      const head = this.ticket ? `${esc(this.ticket.title)}・重播` : '觀戰模式';
      const tag = w ? `<small class="tg">${esc(w.tags[f.viewId] ?? '')}</small>` : '';
      hints.push(`${head}・跟隨 ${this.name(f.viewId, f.board)}${tag}（← → 切換）・<kbd>X</kbd> 全圖透視 ${extra.xray ? '開' : '關'}`);
    } else if (!self.me.alive) {
      const d = this.myDeath;
      if (d !== null) hints.push(d.killer >= 0 && d.killer !== d.victim ? `你被 ${this.name(d.killer, f.board)} 用 ${this.weaponName(d.weapon)} 擊殺` : `你被${this.weaponName(d.weapon)}炸死`);
      if (view.me.alive) hints.push(`觀看 ${this.name(f.viewId, f.board)}（← → 或滑鼠左右鍵切換隊友）`);
      else hints.push('全隊陣亡・等待下一回合');
    } else {
      this.myDeath = null;
      if (r.phase === 'freeze') hints.push(`凍結中：${clock(r.phaseTicksLeft, tps)} 後開打`);
      if (self.round.canBuy) hints.push('可購買：按 <kbd>B</kbd>');
      // 矮牆掩護：蹲著且 lowCoverRange 格內有矮牆才算；站在箱子旁提醒要蹲
      const cover = this.nearLow(self.me.x, self.me.y, this.meta.rules.lowCoverRange);
      if (self.me.crouching && cover) hints.push('蹲在掩體後：箱子另一側的人看不到、打不到你（你也看不到他）');
      else if (!self.me.crouching && this.nearLow(self.me.x, self.me.y, 1.2)) hints.push('靠著箱子：按住 <kbd>C</kbd> 蹲下才有掩護，站著會被打到');
      if (self.me.hasBomb && r.phase === 'live') hints.push('你帶著炸彈：到 A／B 點按住 <kbd>E</kbd>（或 <kbd>5</kbd> 選炸彈後按住左鍵）下包');
      if (self.me.team === 'CT' && (self.bomb.state === 'planted' || self.bomb.state === 'defusing') && self.bomb.x !== null && Math.hypot(self.bomb.x - self.me.x, (self.bomb.y ?? 0) - self.me.y) <= 1500 && self.me.defuseTicks === 0) hints.push('按住 <kbd>E</kbd> 拆包');
    }
    setHtml(this.hint, hints.join('<span class="sep"></span>'));

    // 左下：血、甲、錢（死後看隊友時，血甲是隊友的、錢是自己的）
    const vm = view.me;
    const hpLow = vm.hp <= 30;
    setHtml(
      this.left,
      `<div class="stat${hpLow ? ' low' : ''}"><span class="lb">血</span><b>${vm.alive ? vm.hp : 0}</b></div>` +
        `<div class="stat"><span class="lb">甲</span><b>${vm.loadout.armor}</b>${vm.loadout.kit ? '<span class="tag">拆彈器</span>' : ''}</div>` +
        (this.meta.spectate ? `<div class="stat"><span class="lb">錢</span><b>$${vm.money}</b></div>` : `<div class="stat money"><span class="lb">錢</span><b>$${self.me.money}</b></div>`),
    );

    // 右下：武器欄 1～5（主武器、手槍、刀、道具、炸彈；沒有的格子變暗）、彈藥
    const mine = vm.id === this.meta.playerId && !this.meta.spectate;
    const gName = (g: string): string => this.meta.grenades.find((x) => x.id === g)?.name ?? g;
    const wName = (w: string | null): string => (w === null ? '' : (this.meta.weapons.find((x) => x.id === w)?.name ?? w));
    const curSlot = mine && extra.bomb ? 5 : mine && extra.grenade !== null ? 4 : (['primary', 'secondary', 'knife'].indexOf(this.meta.weapons.find((w) => w.id === vm.weapon)?.slot ?? 'knife') + 1);
    const kinds = [...new Set(vm.loadout.grenades)];
    const nades = kinds.map((g) => `<span class="${mine && extra.grenade === g ? 'on' : ''}">${gName(g)}${vm.loadout.grenades.filter((x) => x === g).length > 1 ? '×2' : ''}</span>`).join('');
    const cells: [number, string, boolean][] = [
      [1, wName(vm.loadout.primary), vm.loadout.primary !== null],
      [2, wName(vm.loadout.secondary), vm.loadout.secondary !== null],
      [3, '刀', true],
      [4, nades, kinds.length > 0],
      [5, '炸彈', vm.hasBomb],
    ];
    const bar = cells.map(([n, name, has]) => `<div class="ws${n === curSlot ? ' sel' : ''}${has ? '' : ' empty'}"><kbd>${n}</kbd><span class="nm">${has ? name : '—'}</span></div>`).join('');
    const ammo = curSlot >= 4 || vm.weapon === 'knife' ? '' : vm.reloadTicksLeft > 0 ? '換彈中…' : `<b>${vm.ammoMag}</b><span class="res">/ ${vm.ammoReserve}</span>`;
    const pose = `${vm.scoped ? '開鏡' : ''}${vm.walking ? '・靜步' : ''}${vm.crouching ? '・蹲' : ''}`.replace(/^・/, '');
    setHtml(
      this.right,
      `<div class="wp"><span class="lo muted small">${pose}</span><span class="am">${ammo}</span></div>` +
        `<div class="wbar">${bar}</div>` +
        `<div class="cd"><i style="width:${Math.round(extra.throwCdFrac * 100)}%"></i></div>`,
    );

    // 炸彈狀態條
    const rules = this.meta.rules;
    let bombHtml = '';
    if (vm.plantTicks > 0) bombHtml = `<span>下包中</span><div class="bar"><i style="width:${Math.min(100, (vm.plantTicks / rules.plantTicks) * 100)}%"></i></div>`;
    else if (vm.defuseTicks > 0) {
      const need = vm.loadout.kit ? rules.defuseKitTicks : rules.defuseTicks;
      bombHtml = `<span>拆包中</span><div class="bar"><i style="width:${Math.min(100, (vm.defuseTicks / need) * 100)}%"></i></div>`;
    } else if (view.bomb.state === 'planting') bombHtml = '<span>隊友下包中</span>';
    else if (view.bomb.state === 'planted' || view.bomb.state === 'defusing') bombHtml = `<span>炸彈在 ${view.bomb.site ?? '?'} 點${view.bomb.state === 'defusing' ? '・拆包中' : ''}</span><b>${view.bomb.ticksLeft !== null ? (view.bomb.ticksLeft / tps).toFixed(1) : ''}</b>`;
    else if (vm.hasBomb) bombHtml = '<span>持有炸彈</span>';
    else if (view.bomb.state === 'dropped' && vm.team === 'T') bombHtml = '<span>炸彈掉在地上</span>';
    setHtml(this.bombBar, bombHtml);
    this.bombBar.classList.toggle('hidden', bombHtml === '');

    if (this.boardShown) this.renderBoard(this.board, f.board, null);
  }

  /** 計分板：兩隊各一欄（敵人的金錢在比賽中不公開） */
  renderBoard(target: HTMLElement, rows: readonly BoardRow[], summary: ShooterSummary | null): void {
    const teams: Team[] = ['T', 'CT'];
    const w = this.meta.watch;
    const marks: readonly RoundMark[] = summary !== null ? summary.rounds.map((x) => ({ number: x.number, winner: x.winner, reason: x.reason as RoundEndReason, winnerGroup: x.winnerGroup })) : this.rounds;
    const markColor = (m: RoundMark): string => (w && m.winnerGroup !== undefined ? this.groupColor(m.winnerGroup) : TEAM_COLOR[m.winner]);
    const markWho = (m: RoundMark): string => (w && m.winnerGroup !== undefined ? esc(w.teams[m.winnerGroup]) : m.winner);
    const hist = marks.map((m) => `<i title="第 ${m.number} 回合：${markWho(m)} 勝・${REASON[m.reason]}" style="background:${markColor(m)}">${m.reason === 'bomb' ? '炸' : m.reason === 'defuse' ? '拆' : m.reason === 'timeout' ? '時' : ''}</i>`).join('');
    // 觀戰的結束畫面依組別（主隊在左）；其他依陣營
    const byGroup = w !== undefined && summary !== null;
    const keys: readonly (Team | 0 | 1)[] = byGroup ? [0, 1] : teams;
    const cols = keys
      .map((key) => {
        const inCol = (r: BoardRow): boolean => (typeof key === 'number' ? this.meta.groups[r.id] === key : r.team === key);
        const list = rows.filter(inCol).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        const body = list
          .map((r) => {
            const money = summary !== null ? summary.players[r.id].money : r.money;
            const me = r.id === this.meta.playerId && !this.meta.spectate;
            const tag = w ? `<small class="tg">${esc(w.tags[r.id] ?? '')}</small>` : '';
            return `<tr class="${r.alive || summary !== null ? '' : 'dead'}${me ? ' me' : ''}"><td>${esc(this.meta.names[r.id] ?? '')}${tag}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${money === null ? '—' : `$${money}`}</td></tr>`;
          })
          .join('');
        let head: string;
        if (typeof key === 'number') head = `<th style="color:${this.groupColor(key)}">${esc(w?.teams[key] ?? '')}</th>`;
        else if (w) {
          const g = this.groupOfTeam(key, rows);
          head = `<th style="color:${this.groupColor(g)}">${esc(w.teams[g])} <small>${key}</small></th>`;
        } else head = `<th style="color:${TEAM_COLOR[key]}">${key}</th>`;
        return `<table><thead><tr>${head}<th>擊殺</th><th>死亡</th><th>金錢</th></tr></thead><tbody>${body}</tbody></table>`;
      })
      .join('');
    setHtml(target.querySelector('.sg-board-body') ?? target, `<div class="cols">${cols}</div><div class="hist">${hist}</div>`);
  }

  showEnd(summary: ShooterSummary, rows: readonly BoardRow[], myGroup: 0 | 1): void {
    const [g0, g1] = summary.score;
    if (this.meta.watch && this.ticket !== null) {
      this.showWatchEnd(summary, rows);
      return;
    }
    let title: string;
    if (summary.winnerGroup === null) title = `平手 ${g0}：${g1}`;
    else if (this.meta.spectate) title = `${summary.winnerGroup === 0 ? '先攻組（上半場 T）' : '先守組（上半場 CT）'}獲勝 ${Math.max(g0, g1)}：${Math.min(g0, g1)}`;
    else title = `${summary.winnerGroup === myGroup ? '勝利' : '落敗'} ${summary.score[myGroup]}：${summary.score[1 - myGroup]}`;
    // 結束時的陣營是最後一個半場的（可能是加時），換回依組別顯示
    const finalRows = rows.map((r) => ({ ...r, alive: true }));
    this.end.innerHTML = `<div class="box"><h2>${title}</h2><p class="muted small">種子 ${this.meta.seed}・共 ${summary.rounds.length} 回合${summary.overtimes > 0 ? `・加時 ${summary.overtimes} 段` : ''}・終局雜湊 ${summary.finalHash}</p><div class="sg-board-body"></div><div class="row"><button type="button" class="primary" data-act="again">再來一場</button><button type="button" data-act="replay">下載回放</button><button type="button" data-act="home">回開局畫面</button></div></div>`;
    this.renderBoard(this.end.querySelector('.sg-board-body')!, finalRows, summary);
    this.end.classList.remove('hidden');
  }

  /** 經營層觀戰的結束畫面：比分（主隊在左）、與存檔成績單的對照、回經營 */
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
      `<div class="box"><small class="en">${esc(t.title)} // REPLAY</small><h2 class="${cls}">${res}</h2>` +
      `<div class="vsl"><b style="color:${this.groupColor(0)}">${esc(w.teams[0])}</b><span class="sc">${g0}<i>:</i>${g1}</span><b style="color:${this.groupColor(1)}">${esc(w.teams[1])}</b></div>` +
      `${check}<p class="muted small">共 ${summary.rounds.length} 回合${summary.overtimes > 0 ? `・加時 ${summary.overtimes} 段` : ''}・種子 ${this.meta.seed}・終局雜湊 ${summary.finalHash}</p>` +
      `<div class="sg-board-body"></div><div class="row"><button type="button" class="primary" data-act="home">回經營</button><button type="button" data-act="again">重看一次</button><button type="button" data-act="replay">下載回放</button></div></div>`;
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
    const sub = meta.spectate ? '' : `<small>你是 <b style="color:${TEAM_COLOR[team]}">${team}</b>${team === 'T' ? '：帶炸彈攻 A／B 點' : '：守住 A／B 點'}</small>`;
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
    return `<span style="color:${TEAM_COLOR[w]}">${w} 勝</span><small>${REASON[cur.round.ended.reason]}</small>`;
  }
  return null;
}
