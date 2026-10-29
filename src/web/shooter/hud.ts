// CS 射擊可玩版的 HUD：比分與時間、血甲錢、武器彈藥、道具格與投擲冷卻、炸彈狀態、回合提示、擊殺訊息、計分板、結束畫面。
// 全部從觀察資料（與計分板的公開資訊）取值。
import type { RoundEndReason, ShooterObservation, Team } from '../../shooter/api.ts';
import { GRENADE_TAG, TEAM_COLOR, WEAPON_TAG } from './render.ts';
import type { BoardRow, KillFeedItem, ShooterFrame, ShooterMeta, ShooterSummary } from './protocol.ts';

export const REASON: Readonly<Record<RoundEndReason, string>> = { elimination: '殲滅', bomb: '炸彈引爆', defuse: '拆彈成功', timeout: '時間到' };
const FEED_MS = 6000;
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
  private feedItems: { item: KillFeedItem; t: number }[] = [];
  private bannerUntil = 0;
  private boardShown = false;
  /** 這回合自己是被誰、用什麼打死的（擊殺訊息是公開資訊） */
  private myDeath: KillFeedItem | null = null;
  readonly rounds: RoundMark[] = [];

  constructor(root: HTMLElement, meta: ShooterMeta) {
    this.meta = meta;
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
    const resume = meta.spectate ? '繼續（空白鍵）' : '繼續（Esc）';
    const quit = meta.spectate ? '離開觀戰' : '離開比賽';
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

  private name(id: number, board: readonly BoardRow[]): string {
    const team = board[id]?.team;
    const color = team !== undefined ? TEAM_COLOR[team] : '#e2e8f0';
    return `<span style="color:${color}">${this.meta.names[id] ?? `#${id}`}</span>`;
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
    const pips = (team: Team, n: number): string => Array.from({ length: 5 }, (_, i) => `<i style="${i < n ? `background:${TEAM_COLOR[team]}` : ''}"></i>`).join('');
    setHtml(
      this.top,
      `<div class="tm t"><b style="color:${TEAM_COLOR.T}">T</b><span class="sc">${r.scoreT}</span><span class="pips">${pips('T', aliveT)}</span></div>` +
        `<div class="mid${r.phase === 'planted' ? ' planted' : ''}"><span class="clock">${time}</span><span class="ph">${phase}</span><span class="rd">第 ${r.number} 回合・${halfLabel(r.half, r.overtime)}</span></div>` +
        `<div class="tm ct"><span class="pips">${pips('CT', aliveCT)}</span><span class="sc">${r.scoreCT}</span><b style="color:${TEAM_COLOR.CT}">CT</b></div>`,
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
      hints.push(`觀戰模式・跟隨 ${this.name(f.viewId, f.board)}（← → 切換）・<kbd>X</kbd> 全圖透視 ${extra.xray ? '開' : '關'}・<kbd>[</kbd><kbd>]</kbd> 速度 ${extra.speed}×・<kbd>空白</kbd> 暫停`);
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
    const marks = summary !== null ? summary.rounds.map((x) => ({ number: x.number, winner: x.winner, reason: x.reason as RoundEndReason })) : this.rounds;
    const hist = marks.map((m) => `<i title="第 ${m.number} 回合：${m.winner} 勝・${REASON[m.reason]}" style="background:${TEAM_COLOR[m.winner]}">${m.reason === 'bomb' ? '炸' : m.reason === 'defuse' ? '拆' : m.reason === 'timeout' ? '時' : ''}</i>`).join('');
    const cols = teams
      .map((team) => {
        const list = rows.filter((r) => r.team === team).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        const body = list
          .map((r) => {
            const money = summary !== null ? summary.players[r.id].money : r.money;
            const me = r.id === this.meta.playerId && !this.meta.spectate;
            return `<tr class="${r.alive || summary !== null ? '' : 'dead'}${me ? ' me' : ''}"><td>${this.meta.names[r.id]}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${money === null ? '—' : `$${money}`}</td></tr>`;
          })
          .join('');
        return `<table><thead><tr><th style="color:${TEAM_COLOR[team]}">${team}</th><th>擊殺</th><th>死亡</th><th>金錢</th></tr></thead><tbody>${body}</tbody></table>`;
      })
      .join('');
    setHtml(target.querySelector('.sg-board-body') ?? target, `<div class="cols">${cols}</div><div class="hist">${hist}</div>`);
  }

  showEnd(summary: ShooterSummary, rows: readonly BoardRow[], myGroup: 0 | 1): void {
    const [g0, g1] = summary.score;
    let title: string;
    if (summary.winnerGroup === null) title = `平手 ${g0}：${g1}`;
    else if (this.meta.spectate) title = `${summary.winnerGroup === 0 ? '先攻組（上半場 T）' : '先守組（上半場 CT）'}獲勝 ${Math.max(g0, g1)}：${Math.min(g0, g1)}`;
    else title = `${summary.winnerGroup === myGroup ? '勝利' : '落敗'} ${summary.score[myGroup]}：${summary.score[1 - myGroup]}`;
    // 結束時的陣營是最後一個半場的（可能是加時），換回依組別顯示
    const finalRows = rows.map((r) => ({ ...r, alive: true }));
    this.end.innerHTML = `<div class="box"><h2>${title}</h2><p class="muted small">種子 ${this.meta.seed}・共 ${summary.rounds.length} 回合${summary.overtimes > 0 ? `・加時 ${summary.overtimes} 段` : ''}・終局雜湊 ${summary.finalHash}</p><div class="sg-board-body"></div><div class="row"><button type="button" class="primary" data-act="again">再來一場</button><button type="button" data-act="home">回開局畫面</button></div></div>`;
    this.renderBoard(this.end.querySelector('.sg-board-body')!, finalRows, summary);
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
