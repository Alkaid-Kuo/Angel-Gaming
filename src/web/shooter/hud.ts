// CS 射擊可玩版的 HUD：比分與時間、血甲錢、武器彈藥、道具格與投擲冷卻、炸彈狀態、回合提示、擊殺訊息、計分板、結束畫面。
// 全部從觀察資料（與計分板的公開資訊）取值。外觀是天使金語彙（web/shooter.css）：墨黑面板、左緣金邊、右下切角、Barlow 斜體數字。
// 介面文字的顏色跟組別走：我方金、對手紅；別隊的比賽主隊白、客隊灰（金只給我方）。世界裡的隊色是另一條規則（對手藍，見 render.ts）。
// 我方永遠在左；經營層觀戰顯示隊名、選手名、角色與版本。
import type { RoundEndReason, ShooterObservation, Team } from '../../shooter/api.ts';
import { isLowCell } from '../../shooter/map.ts';
import { GRENADE_TAG, WEAPON_TAG, mineGroup } from './render.ts';
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

export interface HudExtra {
  readonly throwCdFrac: number;
  readonly grenade: string | null;
  readonly bomb: boolean;
  readonly speed: number;
  readonly xray: boolean;
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
  private boardShown = false;
  /** 這回合自己是被誰、用什麼打死的（擊殺訊息是公開資訊） */
  private myDeath: KillFeedItem | null = null;
  readonly rounds: RoundMark[] = [];

  constructor(root: HTMLElement, meta: ShooterMeta, ticket: WatchTicket | null = null) {
    this.meta = meta;
    this.mine = mineGroup(meta);
    this.ticket = meta.watch ? ticket : null;
    this.top = el('div', 'sg-top', root);
    this.feed = el('div', 'sg-feed', root);
    this.banner = el('div', 'sg-banner hidden', root);
    this.hint = el('div', 'sg-hint', root);
    this.left = el('div', 'sg-left', root);
    this.right = el('div', 'sg-right', root);
    this.bombBar = el('div', 'sg-bombbar hidden', root);
    this.board = el('div', 'sg-board hidden', root);
    this.zone = root.querySelector('.sg-radar .rz b');
    this.end = el('div', 'sg-end hidden', root);
    this.pause = el('div', 'sg-pause hidden', root);
    this.ctl = meta.spectate ? el('div', 'sg-ctl', root) : null;
    const resume = meta.spectate ? '繼續（空白鍵）' : '繼續（Esc）';
    const quit = meta.watch ? '回經營' : meta.spectate ? '離開觀戰' : '離開比賽';
    this.pause.innerHTML =
      `<div class="box"><small class="en">PAUSED</small><b>暫停</b>` +
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
        if (!isLowCell(map, gx, gy)) continue;
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

  /** 組別的介面文字顏色：我方金、對手紅；別隊的比賽主隊白、客隊灰 */
  groupColor(g: 0 | 1): string {
    if (this.mine === null) return g === 0 ? ANGEL.white : ANGEL.grey;
    return g === this.mine ? ANGEL.gold : ANGEL.red;
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

  /** 觀戰控制列：暫停／播放、速度、下一回合、全圖（按鈕的 data-act 由 main.ts 處理） */
  updateCtl(speed: number, paused: boolean, over: boolean, map: { xray: boolean; overview: boolean; tactical: boolean }): void {
    if (this.ctl === null) return;
    const sp = SPEEDS.map((s, i) => `<button type="button" class="${s === speed ? 'on' : ''}" data-act="speed" data-i="${i}">${s}×</button>`).join('');
    const tg = (act: string, on: boolean, label: string, key: string): string => `<button type="button" class="${on ? 'on' : ''}" data-act="${act}">${label}<kbd>${key}</kbd></button>`;
    setHtml(
      this.ctl,
      `<button type="button" data-act="pause" ${over ? 'disabled' : ''}>${paused ? '▶ 播放' : 'Ⅱ 暫停'}<kbd>空白</kbd></button>` +
        `<span class="sp">${sp}<kbd>[</kbd><kbd>]</kbd></span>` +
        `<button type="button" data-act="skip" ${over ? 'disabled' : ''}>下一回合 ▶▶<kbd>N</kbd></button>` +
        `<span class="sp">${tg('xray', map.xray, '透視', 'X')}${tg('overview', map.overview, '全圖', 'M')}${tg('tactical', map.tactical, '戰術疊層', 'T')}</span>` +
        `<button type="button" data-act="quit">${this.meta.watch ? '回經營' : '離開觀戰'}</button>`,
    );
  }

  update(f: ShooterFrame, now: number, extra: HudExtra): void {
    const view = f.view;
    const self = f.self;
    const tps = this.meta.rules.ticksPerSecond;
    const r = view.round;
    // 頂部：我方（左）｜時間與回合｜對手（右）
    let time = '';
    let phase = '';
    if (r.phase === 'freeze') {
      time = clock(r.phaseTicksLeft, tps);
      phase = '凍結時間・';
    } else if (r.phase === 'live') {
      time = clock(r.phaseTicksLeft, tps);
    } else if (r.phase === 'planted') {
      time = view.bomb.ticksLeft !== null ? clock(view.bomb.ticksLeft, tps) : '';
      phase = '炸彈已下包・';
    } else {
      phase = r.ended !== null ? `${this.groupName(this.groupOfTeam(r.ended.winner, f.board))}勝・${REASON[r.ended.reason]}・` : '回合結束・';
    }
    const leftGroup: 0 | 1 = this.mine ?? 0;
    const leftTeam: Team = this.groupOfTeam('T', f.board) === leftGroup ? 'T' : 'CT';
    const rightTeam: Team = leftTeam === 'T' ? 'CT' : 'T';
    const alive = (team: Team): number => f.board.filter((b) => b.team === team && b.alive).length;
    const scoreOf = (team: Team): number => (team === 'T' ? r.scoreT : r.scoreCT);
    const side = (team: Team): string => {
      const g = this.groupOfTeam(team, f.board);
      const pips = Array.from({ length: 5 }, (_, i) => `<i class="${i < alive(team) ? 'on' : ''}"></i>`).join('');
      return `<b class="n">${this.groupName(g)}</b><small>${team}</small><span class="pips">${pips}</span><span class="sc">${scoreOf(team)}</span>`;
    };
    const tmStyle = (team: Team): string => `style="--c:${this.groupColor(this.groupOfTeam(team, f.board))}"`;
    setHtml(
      this.top,
      `<div class="tm l" ${tmStyle(leftTeam)}>${side(leftTeam)}</div>` +
        `<div class="mid${r.phase === 'planted' ? ' planted' : ''}"><span class="clock">${time}</span><span class="rd">${phase}第 ${r.number} 回合・${halfLabel(r.half, r.overtime)}</span></div>` +
        `<div class="tm r" ${tmStyle(rightTeam)}>${side(rightTeam)}</div>`,
    );
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
          return `<div class="k${mine ? ' mine' : ''}">${killer}<span class="w">${this.weaponName(item.weapon)}</span>${this.name(item.victim)}</div>`;
        })
        .join(''),
    );
    if (now > this.bannerUntil) this.banner.classList.add('hidden');

    // 提示列
    const hints: string[] = [];
    if (this.meta.spectate) {
      const w = this.meta.watch;
      const head = this.ticket ? `${esc(this.ticket.title)}・重播` : '觀戰模式';
      const tag = w ? `<small class="tg">${esc(w.tags[f.viewId] ?? '')}</small>` : '';
      hints.push(`${head}・跟隨 ${this.name(f.viewId)}${tag}（← → 切換）`);
    } else if (!self.me.alive) {
      const d = this.myDeath;
      if (d !== null) hints.push(d.killer >= 0 && d.killer !== d.victim ? `你被 ${this.name(d.killer)} 用 ${this.weaponName(d.weapon)} 擊殺` : `你被${this.weaponName(d.weapon)}炸死`);
      if (view.me.alive) hints.push(`觀看 ${this.name(f.viewId)}（← → 或滑鼠左右鍵切換隊友）`);
      else hints.push('全隊陣亡・等待下一回合');
    } else {
      this.myDeath = null;
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
    const hp = vm.alive ? vm.hp : 0;
    const money = this.meta.spectate ? vm.money : self.me.money;
    setHtml(
      this.left,
      `<div class="stat hp${hp <= 30 ? ' low' : ''}"><span class="lb">血量</span><b>${hp}</b><i class="bar"><u style="width:${Math.max(0, hp)}%"></u></i></div>` +
        `<div class="stat ar"><span class="lb">護甲${vm.loadout.kit ? '<em>拆彈器</em>' : ''}</span><b>${vm.loadout.armor}</b><i class="bar"><u style="width:${vm.loadout.armor}%"></u></i></div>` +
        `<div class="stat mo"><span class="lb">金錢</span><b>$${money}</b></div>`,
    );

    // 右下：武器欄 1～5（主武器、手槍、刀、道具、炸彈；沒有的格子變暗）、彈藥
    const mine = vm.id === this.meta.playerId && !this.meta.spectate;
    const gName = (g: string): string => this.meta.grenades.find((x) => x.id === g)?.name ?? g;
    const wName = (w: string | null): string => (w === null ? '' : (this.meta.weapons.find((x) => x.id === w)?.name ?? w));
    const curSlot = mine && extra.bomb ? 5 : mine && extra.grenade !== null ? 4 : ['primary', 'secondary', 'knife'].indexOf(this.meta.weapons.find((w) => w.id === vm.weapon)?.slot ?? 'knife') + 1;
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
    const held = mine && extra.bomb ? '炸彈' : mine && extra.grenade !== null ? gName(extra.grenade) : wName(vm.weapon);
    const ammo = curSlot >= 4 || vm.weapon === 'knife' ? '' : vm.reloadTicksLeft > 0 ? '<span class="res">換彈中</span>' : `<b>${vm.ammoMag}</b><span class="res">/ ${vm.ammoReserve}</span>`;
    const pose = `${vm.scoped ? '開鏡' : ''}${vm.walking ? '・靜步' : ''}${vm.crouching ? '・蹲' : ''}`.replace(/^・/, '');
    setHtml(
      this.right,
      `<div class="am"><span class="wn">${held}<small>${pose}</small></span>${ammo}</div>` +
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

    if (this.boardShown) this.renderBoard(this.board, f.board, null, `${scoreOf(leftTeam)} : ${scoreOf(rightTeam)}`);
  }

  /** 計分板：兩隊各一欄（敵人的金錢在比賽中不公開）；我方在左 */
  renderBoard(target: HTMLElement, rows: readonly BoardRow[], summary: ShooterSummary | null, score: string | null = null): void {
    const w = this.meta.watch;
    const marks: readonly RoundMark[] = summary !== null ? summary.rounds.map((x) => ({ number: x.number, winner: x.winner, reason: x.reason as RoundEndReason, winnerGroup: x.winnerGroup })) : this.rounds;
    const groupOfMark = (m: RoundMark): 0 | 1 => m.winnerGroup ?? (m.winner === 'T' ? 0 : 1);
    const hist = marks.map((m) => `<i title="第 ${m.number} 回合：${this.groupName(groupOfMark(m))}勝・${REASON[m.reason]}" style="background:${this.groupColor(groupOfMark(m))}"><b>${m.reason === 'bomb' ? '炸' : m.reason === 'defuse' ? '拆' : m.reason === 'timeout' ? '時' : ''}</b></i>`).join('');
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
            return `<tr class="${r.alive || summary !== null ? '' : 'dead'}${me ? ' me' : ''}"><td class="pn"><b>${esc(this.meta.names[r.id] ?? '')}</b>${tag}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${money === null ? '—' : `$${money}`}</td></tr>`;
          })
          .join('');
        const head = `<th class="pn" style="color:${this.groupColor(g)}">${this.groupName(g)}${team !== undefined && summary === null ? `<small>${team}</small>` : ''}</th>`;
        return `<table><thead><tr>${head}<th>擊殺</th><th>死亡</th><th>金錢</th></tr></thead><tbody>${body}</tbody></table>`;
      })
      .join('');
    const title = score !== null ? `<h2><span>計分板</span><em>${score}</em></h2>` : '';
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
      `<div class="foot"><span class="meta">種子 ${this.meta.seed}・共 ${summary.rounds.length} 回合${summary.overtimes > 0 ? `・加時 ${summary.overtimes} 段` : ''}・終局雜湊 ${summary.finalHash}</span><div class="row"><button type="button" class="primary" data-act="again">再來一場</button><button type="button" data-act="replay">下載回放</button><button type="button" data-act="home">回開局畫面</button></div></div></div>`;
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
      `<div class="foot"><span class="meta">共 ${summary.rounds.length} 回合${summary.overtimes > 0 ? `・加時 ${summary.overtimes} 段` : ''}・種子 ${this.meta.seed}・終局雜湊 ${summary.finalHash}</span><div class="row"><button type="button" class="primary" data-act="home">回經營</button><button type="button" data-act="again">重看一次</button><button type="button" data-act="replay">下載回放</button></div></div></div>`;
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
    const sub = meta.spectate ? '' : `<small>你是 <b>${team}</b>${team === 'T' ? '：帶炸彈攻 A／B 點' : '：守住 A／B 點'}</small>`;
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
    if (meta.spectate) return `<span>${w} 勝</span><small>${REASON[cur.round.ended.reason]}</small>`;
    const won = w === cur.me.team;
    return `<span style="color:${won ? ANGEL.gold : ANGEL.red}">${won ? '我方勝' : '對手勝'}</span><small>${REASON[cur.round.ended.reason]}</small>`;
  }
  return null;
}
