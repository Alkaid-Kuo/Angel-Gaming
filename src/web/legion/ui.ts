// 軍團戰觀戰畫面：電競轉播風的計分條、雙方兵力名冊、解說字幕、開戰前陣容、結算、自動導播與操作。
import type { RegimentStatus } from '../../legion/api.ts';
import { BOMBARD, DASH, FORMATION_NAMES, MODE_NAMES, RAM, RULES, SIEGE, T, TERRAIN_NAMES, TILE, TPS, UNITS, VERSUS, dashDefOf, type SkillKind, type UnitKind } from '../../legion/config.ts';
import { unitSvg } from './icons.ts';
import type { Caption, FromLegionWorker, LegionFrame, LegionMeta, ToLegionWorker } from './protocol.ts';
import { LegionRenderer } from './render.ts';
import type { Legion3DView } from './three/view3d.ts';
import type { BattleView } from './view.ts';
import { HOTKEYS, PlayerControl, type Pt } from './control.ts';

const STATUS_NAME: Record<RegimentStatus, string> = {
  idle: '待命',
  moving: '行軍',
  attacking: '進攻',
  engaged: '交戰中',
  charging: '衝鋒',
  assaulting: '突擊',
  infiltrating: '切入',
  bracing: '架槍林中',
  braced: '槍林',
  unbracing: '收陣中',
  walling: '盾牆架設中',
  walled: '盾牆',
  reforming: '換陣形',
  volleying: '齊射',
  laddering: '架雲梯',
  toppling: '推倒雲梯',
  reserve: '後備',
  entering: '入場準備',
  routed: '潰散',
};
const ORDER_NAME: Record<string, string> = { idle: '待命', move: '移動', attackMove: '邊走邊打', attack: '攻擊', hold: '堅守', charge: '衝鋒' };
const TERRAIN_TIP = [
  '',
  '移動 ×1.25',
  `移動 ×0.6（輕步兵不減速）・隱蔽：敵人 ${RULES.vision.concealDetect / TILE} 格內（輕步兵 ${RULES.vision.concealDetectLight / TILE} 格）才看得到・受到的遠程傷害 −${RULES.terrain.forestRangedDR}%・擋得住騎兵衝鋒（步兵的突擊、切入不受影響）`,
  '比周圍高：視野更遠、弓兵射程更遠、居高臨下打人更痛（見上方「地形與高度」）',
  `移動 ×0.5・在這裡受到的近戰傷害 ×${RULES.terrain.shallowMeleeTaken / 100}・擋得住騎兵衝鋒`,
  '不可通行',
  '移動 ×1.25・只有 3 格寬',
  '不可通行・擋住視線',
  '只有牆頂（層 1）可走・擋住視線・牆頂高度 ＝ 地面 ＋ 3 階',
  '地面與牆頂之間的樓梯：進入即換層・移動 ×0.5・騎兵不可',
  '門樓：牆頂永遠可走；地面在城門開啟時可走・擋住視線',
  '城內鋪石的街道、廣場與院落・移動同平地',
  '坍塌城牆的碎石：移動 ×0.6・擋得住騎兵衝鋒',
];
const SKILL_NAME: Record<SkillKind, string> = { brace: '槍林', assault: '突擊', shield: '持盾／舉盾／盾牆', volley: '齊射', infiltrate: '切入', charge: '衝鋒' };
const HEIGHT_TIP = `每高 1 階：視野 +${RULES.height.sightPerLevel / TILE} 格、弓兵射程 +${RULES.height.rangePerLevel / TILE} 格、打較低的敵人傷害 +${RULES.height.rangedPerLevel}%（高低差最多算 ${RULES.height.clamp} 階）・上坡移動 ×${RULES.height.uphillSpeed / 100}、下坡 ×${RULES.height.downhillSpeed / 100}`;
const SPEEDS = [1, 2, 4, 8];
/** 玩家指揮時的速度（多一檔慢動作） */
const PLAYER_SPEEDS = [0.5, 1, 2, 4];
/** 被拒絕的指令名稱（玩家提示） */
const CMD_NAME: Record<string, string> = { move: '移動', attack: '攻擊', attackMove: '邊走邊打', hold: '堅守', face: '轉向', formation: '變陣', follow: '跟隨', brace: '槍林', unbrace: '收槍林', shield: '盾兵姿態', volley: '齊射', charge: '衝鋒', assault: '突擊', infiltrate: '切入', steer: '微調方向', summon: '後備入場', swap: '換兵', withdraw: '撤回', gate: '開關城門', ladder: '架雲梯', topple: '推倒雲梯', man: '推衝車', unman: '卸下衝車', bombard: '砲擊' };

/** 上次用的是 3D 還是 2D（預設 3D） */
function prefers3D(): boolean {
  try {
    return localStorage.getItem('legion.view') !== '2d';
  } catch {
    return true;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function clock(tick: number): string {
  const s = Math.floor(tick / TPS);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class LegionScreen {
  private readonly root: HTMLElement;
  private readonly worker: Worker;
  private readonly meta: LegionMeta;

  /** 玩家指揮的一方（-1 = 觀戰） */
  get playerSide(): number {
    return this.meta.playerSide;
  }
  private readonly onExit: () => void;
  /** 目前的繪製器：2D 或 3D（3D 第一次用到才載入） */
  private r: BattleView;
  private readonly r2d: LegionRenderer;
  private r3d: Legion3DView | null = null;
  private disposed = false;
  private readonly el: Record<string, HTMLElement> = {};
  private raf = 0;
  private frameAt = 0;
  private frameGap = 100;
  private speed = 1;
  private paused = true;
  private started = false;
  private director = true;
  private showIntent = true;
  private viewer = -1;
  private selected = -1;
  private hovered = -1;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private mouse: { x: number; y: number } | null = null;
  private captions: Caption[] = [];
  private bigUntil = 0;
  private lineupTimer = 0;
  private rosterSig = '';
  private ended = false;
  private readonly disposers: (() => void)[] = [];
  /** 玩家指揮（null = 純觀戰） */
  private readonly control: PlayerControl | null = null;
  private readonly speeds: number[];
  /** 玩家：框選起點（螢幕）、右鍵起點（世界）與當時指著的團、中鍵平移、WASD */
  private boxStart: { x: number; y: number } | null = null;
  private rdrag: { from: Pt; target: number } | null = null;
  private pan: { x: number; y: number; cx: number; cy: number } | null = null;
  private readonly keysDown = new Set<string>();
  private lastTick = 0;
  private toastUntil = 0;

  constructor(root: HTMLElement, worker: Worker, meta: LegionMeta, onExit: () => void) {
    this.root = root;
    this.worker = worker;
    this.meta = meta;
    this.onExit = onExit;
    this.speeds = meta.playerSide >= 0 ? PLAYER_SPEEDS : SPEEDS;
    root.innerHTML = this.layout();
    for (const n of root.querySelectorAll<HTMLElement>('[data-el]')) this.el[n.dataset.el!] = n;
    this.r2d = new LegionRenderer(this.el.canvas as HTMLCanvasElement, meta);
    this.r = this.r2d;
    if (meta.playerSide >= 0) {
      this.control = new PlayerControl(this.r, meta.playerSide, (cmds) => this.send({ type: 'command', cmds }), (t) => this.toast(t));
      this.viewer = meta.playerSide;
      this.director = false;
    }
    root.classList.remove('hidden');
    requestAnimationFrame(() => {
      this.r.fit();
      if (!this.started) this.showLineup();
    });
    this.bind();
    this.raf = requestAnimationFrame(this.tick);
    if (prefers3D()) void this.set3D(true);
  }

  /** 切換 2D／3D：鏡頭位置帶過去，兩邊都一直收狀態流 */
  private async set3D(on: boolean): Promise<void> {
    if (on && this.r3d === null) {
      this.el.view3d.textContent = '載入中…';
      const { Legion3DView } = await import('./three/view3d.ts');
      if (this.disposed) return;
      this.r3d = new Legion3DView(this.el.canvas as HTMLCanvasElement, this.meta);
      if (this.r2d.frame !== null) this.r3d.push(this.r2d.frame, performance.now());
      if (this.r === this.r2d) this.r3d.fit();
    }
    const next: BattleView = on ? this.r3d! : this.r2d;
    if (next !== this.r) {
      next.cam.x = this.r.cam.x;
      next.cam.y = this.r.cam.y;
      next.cam.scale = this.r.cam.scale;
    }
    this.r3d?.setVisible(on);
    this.r = next;
    if (this.control) this.control.r = next;
    next.clamp();
    this.el.view3d.textContent = on ? '2D' : '3D';
    this.el.view3d.title = on ? '切回 2D 俯視（M）' : '切到 3D 沙盤（M）；右鍵拖曳或 [ ] 轉鏡頭';
    try {
      localStorage.setItem('legion.view', on ? '3d' : '2d');
    } catch {
      // 無痕模式等：不記也沒關係
    }
  }

  private send(msg: ToLegionWorker): void {
    this.worker.postMessage(msg);
  }

  dispose(): void {
    this.disposed = true;
    this.r3d?.dispose();
    cancelAnimationFrame(this.raf);
    clearInterval(this.lineupTimer);
    for (const d of this.disposers) d();
    this.root.innerHTML = '';
  }

  // ───────── 版面 ─────────

  private layout(): string {
    const p = this.meta.players;
    const player = this.meta.playerSide >= 0;
    const team = (i: number): string =>
      `<div class="team t${i}"><span class="sw" style="background:${p[i].color}"></span><span class="nm">${esc(p[i].side)}</span><span class="bot">${esc(p[i].bot)}</span></div>`;
    return `<div class="lg">
  <aside class="lg-side s0">
    <section class="roster" data-el="roster0"></section>
    ${player ? `<details class="keys small" open><summary>快捷鍵</summary>${HOTKEYS.map(([k, d]) => `<div><kbd>${k}</kbd> ${d}</div>`).join('')}</details>` : ''}
  </aside>
  <div class="lg-stage">
    <canvas data-el="canvas" class="lg-canvas"></canvas>
    <div class="lg-top">
    <div class="lg-bug">
      ${team(0)}
      <div class="bar t0" title="剩餘兵力（點數 × 剩餘人數比例；潰散不算）"><i data-el="bar0" style="background:${p[0].color}"></i><span data-el="pct0"></span></div>
      <div class="mid"><div class="clock" data-el="clock">0:00</div><div class="mode">${MODE_NAMES[this.meta.mode]}・${esc(this.meta.mapName)}${this.meta.replay ? '・重播' : ''}</div><div class="pips" data-el="pips"></div><div class="score hidden" data-el="score"></div></div>
      <div class="bar t1" title="剩餘兵力（點數 × 剩餘人數比例；潰散不算）"><span data-el="pct1"></span><i data-el="bar1" style="background:${p[1].color}"></i></div>
      ${team(1)}
    </div>
    <div class="lg-plans"><div class="pl t0" data-el="plan0"></div><div class="pl t1" data-el="plan1"></div></div>
    <div class="lg-big hidden" data-el="big"></div>
    </div>
    <section class="detail lg-card hidden" data-el="detail"></section>
    <div class="lg-feed" data-el="feed"></div>
    <div class="lg-tip hidden" data-el="tip"></div>
    <div class="lg-toast hidden" data-el="toast"></div>
    <div class="lg-ctrl">
      <button data-act="play" data-el="play" title="播放／暫停（空白鍵）">▶</button>
      ${this.speeds.map((s) => `<button data-act="speed" data-speed="${s}" class="${s === 1 ? 'active' : ''}" title="播放速度（${this.speeds.indexOf(s) + 1}）">${s}×</button>`).join('')}
      ${player ? '' : '<button data-act="skip" title="快轉到下一個交戰、衝鋒或埋伏（N）">⏭ 下一場</button>'}
      <span class="sep"></span>
      <select data-el="viewer" class="${player ? 'hidden' : ''}" title="視角：上帝視角看得到全部；選一方只顯示那一方看得到的敵軍">
        <option value="-1">上帝視角</option><option value="0">${esc(p[0].side)}視角</option><option value="1">${esc(p[1].side)}視角</option>
      </select>
      <button data-act="director" data-el="director" class="${player ? '' : 'active'}" title="自動導播：鏡頭跟著主要戰場${player ? '' : '（F）'}">導播</button>
      <button data-act="intent" data-el="intent" class="active" title="放大時在軍團旗標下顯示 AI 意圖（I）；滑鼠指著或選中的軍團一律顯示">意圖</button>
      <button data-act="fit" title="看全圖（Home）">全圖</button>
      <button data-act="view3d" data-el="view3d" title="切到 3D 沙盤（M）；右鍵拖曳或 [ ] 轉鏡頭">3D</button>
      <span class="sep"></span>
      <button data-act="help" title="規則說明（H）">說明</button>
      <button data-act="replay" title="下載這場比賽的回放檔">回放</button>
      <button data-act="restart" title="${player || this.meta.replay ? '重播剛才玩家打的這一場' : '同一組合重看一次'}">重看</button>
      <button data-act="exit" title="回到選單">返回</button>
    </div>
    <div class="lg-overlay hidden" data-el="lineup"></div>
    <div class="lg-overlay hidden" data-el="result"></div>
    <div class="lg-overlay hidden" data-el="help"></div>
  </div>
  <aside class="lg-side s1">
    <section class="roster" data-el="roster1"></section>
  </aside>
</div>`;
  }

  // ───────── 事件 ─────────

  private bind(): void {
    const canvas = this.el.canvas as HTMLCanvasElement;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K | string, fn: (e: Event) => void): void => {
      t.addEventListener(type, fn);
      this.disposers.push(() => t.removeEventListener(type, fn));
    };
    on(this.root, 'click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (b === null) return;
      this.action(b.dataset.act!, b);
    });
    on(this.el.viewer, 'change', () => {
      this.viewer = Number((this.el.viewer as HTMLSelectElement).value);
    });
    on(canvas, 'wheel', (e) => {
      const we = e as WheelEvent;
      we.preventDefault();
      this.setDirector(false);
      const rect = canvas.getBoundingClientRect();
      const before = this.r.toWorld(we.clientX - rect.left, we.clientY - rect.top);
      this.r.cam.scale *= we.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.r.clamp();
      const after = this.r.toWorld(we.clientX - rect.left, we.clientY - rect.top);
      this.r.cam.x += (before.x - after.x) / TILE;
      this.r.cam.y += (before.y - after.y) / TILE;
      this.r.clamp();
    });
    on(canvas, 'contextmenu', (e) => {
      if (this.control) e.preventDefault();
    });
    on(canvas, 'mousedown', (e) => {
      const me = e as MouseEvent;
      if (this.control) {
        const rect = canvas.getBoundingClientRect();
        const px = me.clientX - rect.left;
        const py = me.clientY - rect.top;
        if (me.button === 2 && this.control.aiming) {
          // 瞄準中按右鍵：取消
          this.control.aiming = false;
          return;
        }
        if (me.button === 0) this.boxStart = { x: px, y: py };
        else if (me.button === 2) this.rdrag = { from: this.r.toWorld(px, py), target: this.r.pick(px, py, this.viewer, this.alpha()) };
        else if (me.button === 1) {
          me.preventDefault();
          this.pan = { x: me.clientX, y: me.clientY, cx: this.r.cam.x, cy: this.r.cam.y };
        }
        return;
      }
      this.drag = { x: me.clientX, y: me.clientY, cx: this.r.cam.x, cy: this.r.cam.y, moved: false };
    });
    on(window, 'mousemove', (e) => {
      const me = e as MouseEvent;
      const rect = canvas.getBoundingClientRect();
      this.mouse = { x: me.clientX - rect.left, y: me.clientY - rect.top };
      if (this.control) {
        if (this.boxStart && (me.buttons & 1) === 1 && Math.abs(this.mouse.x - this.boxStart.x) + Math.abs(this.mouse.y - this.boxStart.y) > 4) this.control.box = { x0: this.boxStart.x, y0: this.boxStart.y, x1: this.mouse.x, y1: this.mouse.y };
        if (this.rdrag) this.control.order = { from: this.rdrag.from, to: this.r.toWorld(this.mouse.x, this.mouse.y) };
        if (this.pan && (me.buttons & 4) === 4) {
          this.r.cam.x = this.pan.cx - (me.clientX - this.pan.x) / this.r.cam.scale;
          this.r.cam.y = this.pan.cy - (me.clientY - this.pan.y) / this.r.cam.scale;
          this.r.clamp();
        }
        return;
      }
      if (this.drag !== null && (me.buttons & 1) === 1) {
        const dx = me.clientX - this.drag.x;
        const dy = me.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          this.drag.moved = true;
          this.setDirector(false);
        }
        if (this.drag.moved) {
          this.r.cam.x = this.drag.cx - dx / this.r.cam.scale;
          this.r.cam.y = this.drag.cy - dy / this.r.cam.scale;
          this.r.clamp();
        }
      } else if (this.drag !== null) this.drag = null;
    });
    on(window, 'mouseup', (e) => {
      const me = e as MouseEvent;
      const c = this.control;
      if (c) {
        const rect = canvas.getBoundingClientRect();
        const px = me.clientX - rect.left;
        const py = me.clientY - rect.top;
        if (me.button === 0 && this.boxStart) {
          if (c.box) c.finishBox(this.alpha(), me.shiftKey);
          else if (me.target === canvas) {
            const id = this.r.pick(px, py, this.viewer, this.alpha());
            c.click(id, me.shiftKey);
            this.select(id, false);
          }
          this.boxStart = null;
          c.box = null;
          this.renderDetail();
        } else if (me.button === 2 && this.rdrag) {
          c.rightClick(this.rdrag.target, this.rdrag.from, this.r.toWorld(px, py));
          this.rdrag = null;
          c.order = null;
        } else if (me.button === 1) this.pan = null;
        return;
      }
      if (this.drag !== null && !this.drag.moved && me.target === canvas) {
        const rect = canvas.getBoundingClientRect();
        this.select(this.r.pick(me.clientX - rect.left, me.clientY - rect.top, this.viewer, this.alpha()), false);
      }
      this.drag = null;
    });
    on(canvas, 'mouseleave', () => {
      this.mouse = null;
    });
    on(canvas, 'dblclick', () => {
      if (this.selected >= 0) this.focusReg(this.selected, 2.2);
    });
    on(window, 'keyup', (e) => {
      const k = (e as KeyboardEvent).key.toLowerCase();
      this.keysDown.delete(k);
      // 放開 Q：朝滑鼠施放（按住時是瞄準）
      if (k === 'q' && this.control) this.control.releaseSkill(this.mouse ? this.r.toWorld(this.mouse.x, this.mouse.y) : null);
    });
    on(window, 'blur', () => {
      if (this.control) this.control.aiming = false;
    });
    on(window, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if ((ke.target as HTMLElement).tagName === 'SELECT' || (ke.target as HTMLElement).tagName === 'INPUT') return;
      if (this.control && this.playerKey(ke)) return;
      if (ke.key === ' ') {
        ke.preventDefault();
        this.action('play');
      } else if (ke.key >= '1' && ke.key <= '4') this.setSpeed(this.speeds[Number(ke.key) - 1]);
      else if (ke.key === 'n' || ke.key === 'N') this.action('skip');
      else if (ke.key === 'f' || ke.key === 'F') this.setDirector(!this.director);
      else if (ke.key === 'i' || ke.key === 'I') this.action('intent');
      else if (ke.key === 'h' || ke.key === 'H') this.action('help');
      else if (ke.key === 'm' || ke.key === 'M') this.action('view3d');
      else if (ke.key === 'Home') this.action('fit');
      else if (ke.key === 'Escape') {
        if (!this.el.help.classList.contains('hidden')) this.el.help.classList.add('hidden');
        else this.select(-1, false);
      }
    });
    on(window, 'resize', () => this.r.clamp());
    for (const i of [0, 1]) {
      on(this.el[`roster${i}`], 'click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-reg]');
        if (row === null) return;
        const id = Number(row.dataset.reg);
        const c = this.control;
        if (c && c.isMine(id)) {
          // 玩家：點自己的後備＝入場（選了一團場上的就換兵）；點場上的＝選取
          if (this.r.reg(id)?.reserve) c.reserveClick(id);
          else {
            c.click(id, (e as MouseEvent).shiftKey);
            this.select(id, true);
          }
          return;
        }
        this.select(id, true);
      });
      on(this.el[`roster${i}`], 'mouseover', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-reg]');
        this.hovered = row === null ? -1 : Number(row.dataset.reg);
      });
      on(this.el[`roster${i}`], 'mouseleave', () => {
        this.hovered = -1;
      });
    }
  }

  /** 玩家模式的按鍵：WASD 平移、指令快捷鍵；回傳 true 表示處理了 */
  private playerKey(ke: KeyboardEvent): boolean {
    const c = this.control!;
    const k = ke.key.toLowerCase();
    if (k === 'w' || k === 's' || k === 'd' || k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright') {
      this.keysDown.add(k);
      this.setDirector(false);
      ke.preventDefault();
      return true;
    }
    const mouse = this.mouse ? this.r.toWorld(this.mouse.x, this.mouse.y) : null;
    const hover = this.mouse ? this.r.pick(this.mouse.x, this.mouse.y, this.viewer, this.alpha()) : -1;
    // a 同時是平移鍵（WASD）與「邊走邊打」：有選取時當指令
    if (k === 'a' && c.selected().length === 0 && !ke.ctrlKey) {
      this.keysDown.add(k);
      return true;
    }
    if (c.key(ke.key, ke.ctrlKey || ke.metaKey, mouse, hover)) {
      ke.preventDefault();
      this.renderDetail();
      return true;
    }
    return false;
  }

  private toast(text: string): void {
    this.el.toast.textContent = text;
    this.el.toast.classList.remove('hidden');
    this.toastUntil = performance.now() + 2500;
  }

  private action(act: string, el?: HTMLElement): void {
    switch (act) {
      case 'play':
        if (!this.started) return this.startBattle();
        this.paused = !this.paused;
        this.send({ type: this.paused ? 'pause' : 'play' });
        this.el.play.textContent = this.paused ? '▶' : '❚❚';
        return;
      case 'speed':
        return this.setSpeed(Number(el?.dataset.speed ?? 1));
      case 'skip':
        if (!this.started) this.startBattle();
        this.send({ type: 'skip' });
        return;
      case 'director':
        return this.setDirector(!this.director);
      case 'intent':
        this.showIntent = !this.showIntent;
        this.el.intent.classList.toggle('active', this.showIntent);
        return;
      case 'fit':
        this.setDirector(false);
        this.r.fit();
        return;
      case 'help':
        this.toggleHelp();
        return;
      case 'view3d':
        void this.set3D(this.r === this.r2d);
        return;
      case 'replay':
        this.send({ type: 'replay' });
        return;
      case 'restart':
        this.ended = false;
        this.captions = [];
        this.el.feed.innerHTML = '';
        this.el.result.classList.add('hidden');
        this.r2d.reset();
        this.r3d?.reset();
        this.send({ type: 'restart' });
        this.started = true;
        this.paused = false;
        this.el.play.textContent = '❚❚';
        return;
      case 'exit':
        this.onExit();
        return;
      case 'start':
        this.startBattle();
        return;
      case 'closeHelp':
        this.el.help.classList.add('hidden');
        return;
    }
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.send({ type: 'speed', speed: s });
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-act=speed]')) b.classList.toggle('active', Number(b.dataset.speed) === s);
  }

  private setDirector(on: boolean): void {
    this.director = on;
    this.el.director.classList.toggle('active', on);
  }

  private select(id: number, focus: boolean): void {
    this.selected = id;
    if (focus && id >= 0) this.focusReg(id, Math.max(this.r.cam.scale, this.r.fitScale * 2));
    this.renderDetail();
  }

  private focusReg(id: number, scale: number): void {
    const p = this.r.regAt(id, this.alpha());
    if (p === null) return;
    this.setDirector(false);
    this.r.cam.x = p.x / TILE;
    this.r.cam.y = p.y / TILE;
    this.r.cam.scale = scale;
    this.r.clamp();
  }

  // ───────── 開戰前陣容 ─────────

  private showLineup(): void {
    const side = (i: number): string => {
      const p = this.meta.players[i];
      const regs = this.meta.regs.filter((r) => r.owner === i);
      const counts = new Map<UnitKind, number>();
      for (const r of regs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
      const men = regs.reduce((s, r) => s + r.men0, 0);
      const rej = this.meta.rejected.filter((x) => x.player === i);
      return `<div class="lu-side t${i}">
        <div class="lu-head" style="border-color:${p.color}"><span class="sw" style="background:${p.color}"></span><b>${esc(p.side)}</b><span class="bot">${esc(p.bot)}</span></div>
        <p class="muted small">${esc(p.style)}</p>
        <div class="lu-units">${[...counts]
          .map(([k, c]) => `<div class="lu-unit"><span class="ic" style="background:${p.color}">${unitSvg(k, 20, '#fff')}</span><span>${UNITS[k].name}</span><b>× ${c}</b><span class="muted small">${UNITS[k].cost} 點／${UNITS[k].men} 人</span></div>`)
          .join('')}</div>
        <div class="lu-total"><b>${p.cost}</b> / ${(this.meta.mode === 'capture' ? RULES.capture.budget : this.meta.mode === 'siege' ? SIEGE.budget : RULES.budget)} 點・${regs.length} 團・${men} 人</div>
        ${rej.length ? `<div class="warn small">有 ${rej.length} 團布陣失敗：${esc(rej.map((x) => x.reason).join('、'))}</div>` : ''}
      </div>`;
    };
    const ps = this.meta.playerSide;
    const hidden = (i: number): string => `<div class="lu-side t${i}"><div class="lu-head" style="border-color:${this.meta.players[i].color}"><b>${esc(this.meta.players[i].side)}</b><span class="bot">${esc(this.meta.players[i].bot)}</span></div><p class="muted">對手的陣容開戰後才看得到。</p></div>`;
    this.el.lineup.innerHTML = `<div class="lu">
      <h2>開戰前陣容</h2>
      <p class="muted">${ps >= 0 ? '你指揮藍方。左鍵選取、右鍵移動或攻擊，快捷鍵見右下；暫停中也可以下指令。' : `雙方各有 ${(this.meta.mode === 'capture' ? RULES.capture.budget : this.meta.mode === 'siege' ? SIEGE.budget : RULES.budget)} 點，在<b>看不到對手</b>的情況下選兵、布陣。觀眾是上帝視角：埋伏在樹林裡的軍團會以黃色虛線框標示。`}</p>
      <div class="lu-cols">${side(0)}<div class="lu-vs">VS</div>${ps === 0 ? hidden(1) : side(1)}</div>
      <div class="lu-foot"><button class="primary" data-act="start">開戰 <span data-el="countdown"></span></button><button data-act="help">規則說明</button></div>
    </div>`;
    this.el.countdown = this.el.lineup.querySelector<HTMLElement>('[data-el=countdown]')!;
    this.el.lineup.classList.remove('hidden');
    if (ps >= 0) return;
    let left = 10;
    this.el.countdown.textContent = `（${left}）`;
    this.lineupTimer = window.setInterval(() => {
      left -= 1;
      if (this.el.countdown) this.el.countdown.textContent = `（${left}）`;
      if (left <= 0 && this.el.help.classList.contains('hidden')) this.startBattle();
    }, 1000);
  }

  private startBattle(): void {
    if (this.started) return;
    clearInterval(this.lineupTimer);
    this.started = true;
    this.paused = false;
    this.el.lineup.classList.add('hidden');
    this.el.play.textContent = '❚❚';
    this.send({ type: 'play' });
  }

  // ───────── 說明 ─────────

  private toggleHelp(): void {
    const h = this.el.help;
    if (!h.classList.contains('hidden')) {
      h.classList.add('hidden');
      return;
    }
    const pct = (n: number): string => `×${(n / 100).toFixed(n % 100 === 0 ? 0 : n % 10 === 0 ? 1 : 2)}`;
    const sec = (t: number): string => `${t / TPS} 秒`;
    const rows = (Object.keys(UNITS) as UnitKind[])
      .map((k) => {
        const u = UNITS[k];
        const good = Object.entries(VERSUS[k])
          .filter(([, v]) => v! > 100)
          .map(([t, v]) => `${UNITS[t as UnitKind].name} ${pct(v!)}`)
          .join('、');
        const d = dashDefOf(k);
        return `<tr><td>${unitSvg(k, 16)} ${u.name}</td><td>${u.cost}</td><td>${u.men}</td><td>${u.hp / 10}</td><td>${u.attack / 10}／${(u.cooldown / TPS).toFixed(1)} 秒</td><td>${u.range ? `${u.range / TILE} 格` : '近戰'}</td><td>${((u.speed * TPS) / TILE).toFixed(1)}${d ? `（${SKILL_NAME[u.skill]} ${((d.speed * TPS) / TILE).toFixed(1)}）` : ''}</td><td>${u.meleeDR}%／${u.rangedDR}%</td><td>${SKILL_NAME[u.skill]}</td><td>${good || '—'}</td></tr>`;
      })
      .join('');
    const B = RULES.brace;
    const S = RULES.shield;
    h.innerHTML = `<div class="lg-helpbox">
      <button class="ghost close" data-act="closeHelp">✕</button>
      <h2>軍團戰怎麼看</h2>
      <p>兩個 AI 選手各用 <b>${RULES.budget} 點</b>（佔點模式 ${RULES.capture.budget} 點，場上最多 ${RULES.capture.fieldCap} 點）選兵、在看不到對方的情況下布陣，開戰後指揮軍團（不是單兵）。<b>沒有資源、沒有建築</b>，開場就行軍接敵。計分條下方是 AI 的戰略意圖、旗標下方的小字是各團的意圖（放大時顯示），<kbd>I</kbd> 開關。</p>
      <h3>勝利條件</h3>
      <ul><li><b>攻城戰</b>（石關城）：攻守各 ${SIEGE.budget} 點、沒有後備。攻方要依序佔下 <b>A 正門廣場</b>（${SIEGE.captureA / TPS} 秒）與 <b>B 本陣</b>（${SIEGE.captureB / TPS} 秒）；圈內只算地面的士兵，守方在圈內就不會增加進度。佔下 A：正門永久開啟、時限延長 ${SIEGE.extendTicks / TPS / 60} 分鐘；佔下 B 攻方勝，時間到（${SIEGE.timeLimitTicks / TPS / 60} 分鐘）守方勝。攻方有雲梯（白色描邊的是牆頂的士兵、半透明的是爬梯中或穿過門洞的）、衝車（${Math.round(RULES.gate.mainHp / RAM.hit)} 下破正門）與 ${BOMBARD.shells} 發砲擊（紅圈是落點與倒數）。</li>
      <li><b>殲滅戰</b>（測試模式）：打光對手全軍。時間到（${RULES.timeLimitTicks / TPS / 60} 分鐘）比戰果（擊殺敵兵的點數價值）。</li>
      <li><b>佔點</b>（大河谷）：三個渡口各有一面旗。圈內有我方、沒有敵方，佔領進度就增加，${RULES.capture.captureTicks / TPS} 秒佔滿才算佔領；沒佔滿就離開，進度會倒退到零；圈內有敵人時進度不動。佔領後每秒得分（中央淺灘 2 分、兩座橋 1 分），圈內有敵人時暫停得分；先到 ${RULES.capture.scoreTarget} 分獲勝，也可以直接殲滅對手。時間到（${RULES.capture.timeLimitTicks / TPS / 60} 分鐘）先比分數、再比戰果。</li>
      <li><b>後備兵力</b>（佔點）：總共 ${RULES.capture.budget} 點，場上同時最多 ${RULES.capture.fieldCap} 點（算全額，不管剩幾人），其餘是後備。場上沒滿時，後備可以從<b>出生點</b>入場（準備 ${RULES.capture.enterTicks / TPS} 秒）；滿了就要把一團帶到出生點或<b>自己的補給站</b>（兩座橋旁，歸佔著那座橋的一方）換下來。撤回的團血量補滿、人數不變；團站在出生點或自己的補給站、${RULES.capture.healQuietTicks / TPS} 秒沒受傷就會回血（每秒 ${RULES.capture.healPct}%）。</li></ul>
      <h3>傷害</h3>
      <ul><li><b>沒有攻擊削弱，只有傷害減免</b>：各兵種有近戰、遠程減免（下表），和姿態、地形、盾兵掩護的減免相乘。</li>
      <li><b>側擊 ×${RULES.flank.side / 100}、背擊 ×${RULES.flank.rear / 100}</b>：看攻擊方在目標陣形的哪一面（旗標旁的小白箭頭是正面；楔形陣正面較窄，圓陣沒有側背）。</li></ul>
      <h3>招牌技能（地圖上的標示）</h3>
      <ul><li><b>槍林</b>（長槍，淡色扇形＋槍尖）：${sec(B.setTicks)}架好，朝指定方向；正面再減免 ${B.frontDR}%、攻速 ×${B.attackSpeed / 100}，正面衝來的敵人越快傷害越高，並擋下任何衝刺；架著時不會被撞倒或推開、不能移動。槍林要厚才擋得住，太薄會被衝穿；圓陣是全方向但效果減半。</li>
      <li><b>突擊</b>（劍士，黃色箭頭）：朝指定方向短衝 ${DASH.assault.dist / TILE} 格擠進敵陣，第一擊 ×${RULES.dash.firstHit / 100}；冷卻 ${sec(DASH.assault.cooldown)}。</li>
      <li><b>盾兵三種姿態</b>：持盾（正常速度）；舉盾（移動 ×${Math.round((S.raise.speed / S.carry.speed) * 100) / 100}）；盾牆（白色粗線，站定，正面近戰 −${S.wall.meleeDR}%、遠程 −${S.wall.rangedDR}%，完全擋下步兵的突擊與切入，但擋不住騎兵衝鋒）。</li>
      <li><b>盾兵掩護區</b>（盾兵正後方的虛線長方形，往後 ${S.cover.depth / TILE} 格）：友軍站在裡面，從盾兵正面來的攻擊就減免——持盾遠程 −${S.cover.carry.rangedDR}%；舉盾遠程 −${S.cover.raise.rangedDR}%、近戰 −${S.cover.raise.meleeDR}%；盾牆遠程 −${S.cover.wall.rangedDR}%、近戰 −${S.cover.wall.meleeDR}%。從側面打進來的不算。長槍可以越過盾兵刺人。</li>
      <li><b>齊射</b>（弓兵，落點圈）：對半徑 ${RULES.volley.radius / TILE} 格的區域密集射擊 ${sec(RULES.volley.duration)}（射速 ×${RULES.volley.rateDiv}），箭可以越過友軍；冷卻 ${sec(RULES.volley.cooldown)}。</li>
      <li><b>切入</b>（輕步兵，綠色箭頭）：快速衝進敵陣亂戰，途中只有 ${RULES.evadeHitChance}% 的箭射得中；冷卻 ${sec(DASH.infiltrate.cooldown)}。</li>
      <li><b>衝鋒</b>（騎兵，橘色箭頭與軌跡）：助跑 ${DASH.heavyCav.runup / TILE} 格後高速直衝，撞擊傷害另算，撞到沒死的會被擊倒 ${sec(RULES.knockdownTicks)}（倒地的士兵橫躺、頭上冒星星）。輕騎兵衝 ${DASH.lightCav.dist / TILE} 格、轉向較靈活，受到重擊會被打斷；重騎兵衝 ${DASH.heavyCav.dist / TILE} 格、幾乎不能轉彎、衝鋒中霸體。樹林、淺灘、牆擋得住衝鋒。冷卻 ${sec(DASH.lightCav.cooldown)}／${sec(DASH.heavyCav.cooldown)}。</li>
      <li><b>衝刺共通</b>：一旦開始就不能取消，只能微調方向（虛線是預定路線）；衝勁撞光、撞上槍林或盾牆正面就停下；兩個衝刺對撞比衝擊力，相近就兩邊都停。楔形陣衝勁 ×${RULES.dash.wedgeMomentum / 100}。</li></ul>
      <h3>陣形</h3>
      <ul><li><b>橫陣</b>：寬、接敵面大；<b>方陣</b>：厚、槍林擋得住衝鋒；<b>楔形陣</b>：衝勁大、正面較窄；<b>圓陣</b>：沒有側背但不能移動。換陣形要 ${sec(RULES.formationSwitchTicks)}（旗標旁「變陣」），人數變少會自動重排。</li></ul>
      <h3>地形與高度</h3>
      <ul><li><b>高度</b>：河 0 階、河岸 1 階、平地 2 階、山丘 3 階、山頂 4 階（地圖上一層層的疊板，滑鼠指著看高度）。${HEIGHT_TIP}；往下衝刺更快更猛、往上變慢。較高的地形與建築擋住視線。</li>
      <li><b>接觸前迷霧</b>：地形公開，但敵軍要進入視野才看得到；<b>樹林中隱蔽</b>，攻擊後曝光 ${sec(RULES.vision.revealTicks)}。</li>
      <li><b>老兵</b>：累積傷害達本團血量的 50%、120% 升級，攻擊與血量 +10%、+20%（旗標上的 ★）。</li>
      <li><b>沒有潰散</b>：每一團都打到最後一人；殘兵要不要撤回由 AI 決定。</li></ul>
      <h3>兵種</h3>
      <table class="lg-table"><tr><th>兵種</th><th>點數</th><th>人數</th><th>血量</th><th>攻擊</th><th>射程</th><th>速度（格／秒）</th><th>減免（近／遠）</th><th>招牌技能</th><th>剋制</th></tr>${rows}</table>
      <table class="lg-table">${TERRAIN_NAMES.map((n, i) => (TERRAIN_TIP[i] ? `<tr><td>${n}</td><td>${TERRAIN_TIP[i]}</td></tr>` : '')).join('')}</table>
      <h3>操作</h3>
      <p class="small"><kbd>空白</kbd> 播放／暫停・<kbd>1</kbd>～<kbd>4</kbd> 速度・<kbd>N</kbd> 下一場交戰・<kbd>F</kbd> 自動導播・<kbd>I</kbd> AI 意圖・<kbd>Home</kbd> 全圖・<kbd>M</kbd> 切換 2D／3D・滾輪縮放、拖曳平移、點軍團看詳情（雙擊跟過去）・3D 時右鍵拖曳或 <kbd>[</kbd> <kbd>]</kbd> 轉鏡頭（拉近才轉得動，全圖固定北朝上）</p>
    </div>`;
    h.classList.remove('hidden');
  }

  // ───────── 訊息 ─────────

  handle(msg: FromLegionWorker): void {
    switch (msg.type) {
      case 'frame': {
        const now = performance.now();
        if (this.r.frame !== null) {
          const gap = now - this.frameAt;
          this.frameGap = this.frameGap * 0.7 + Math.min(400, Math.max(16, gap)) * 0.3;
        }
        this.frameAt = now;
        this.r2d.push(msg.frame, now);
        this.r3d?.push(msg.frame, now);
        this.onFrame(msg.frame);
        return;
      }
      case 'skipped':
        if (this.director) {
          this.r.cam.x = msg.x / TILE;
          this.r.cam.y = msg.y / TILE;
          this.r.cam.scale = Math.max(this.r.cam.scale, this.r.fitScale * 2);
          this.r.clamp();
        }
        return;
      case 'replayFile': {
        const blob = new Blob([msg.json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `legion-${this.meta.seed}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      default:
        return;
    }
  }

  private onFrame(f: LegionFrame): void {
    this.el.clock.textContent = clock(f.tick);
    const costs = this.meta.players.map((p) => p.cost);
    for (const i of [0, 1]) {
      const pct = Math.floor(f.strength[i] / Math.max(1, costs[i]));
      this.el[`bar${i}`].style.width = `${Math.max(0, Math.min(100, pct))}%`;
      this.el[`pct${i}`].textContent = `${pct}%`;
    }
    if (this.meta.mode === 'siege') {
      // 攻城：A、B 兩面旗的狀態
      const att = 1 - this.meta.defender;
      this.el.score.innerHTML = f.flags
        .map((fl, i) => `<b style="color:${fl.owner === att ? this.meta.players[att].color : '#e2e8f0'}">${i === 0 ? 'A' : 'B'} ${fl.owner === att ? '✓' : fl.capturer >= 0 ? `${Math.floor((fl.progress * 100) / fl.need)}%` : fl.open ? '—' : '🔒'}</b>`)
        .join('<span>　</span>');
      this.el.score.classList.remove('hidden');
    }
    if (this.meta.mode === 'capture') {
      this.el.pips.innerHTML = f.flags
        .map((fl, i) => {
          const c = fl.owner >= 0 ? this.meta.players[fl.owner].color : 'transparent';
          return `<i title="${esc(this.meta.flags[i].name)}" class="${fl.contested ? 'contested' : ''}" style="background:${c};border-color:${fl.owner >= 0 ? c : 'rgba(255,255,255,0.55)'}"></i>`;
        })
        .join('');
      // 分數：藍 123 : 87 紅（目標 400）
      const p = this.meta.players;
      this.el.score.innerHTML = `<b style="color:${p[0].color}">${f.score[0]}</b><span>:</span><b style="color:${p[1].color}">${f.score[1]}</b><i>／${RULES.capture.scoreTarget}</i>`;
      this.el.score.classList.remove('hidden');
    }
    // 戰略意圖：一方視角只看得到自己的
    for (const i of [0, 1]) {
      const t = this.showIntent && (this.viewer < 0 || this.viewer === i) ? f.plans[i] ?? '' : '';
      if (this.el[`plan${i}`].textContent !== t) this.el[`plan${i}`].textContent = t;
    }
    for (const c of f.captions) this.caption(c);
    if (this.control) {
      const rej = f.events.filter((e) => e.type === 'rejected' && e.player === this.control!.side);
      const last = rej[rej.length - 1];
      if (last && last.type === 'rejected') this.toast(`${CMD_NAME[last.command] ?? last.command}：${last.reason}`);
    }
    this.renderRosters(f);
    if (this.selected >= 0) this.renderDetail();
    if (f.over && !this.ended) {
      this.ended = true;
      setTimeout(() => this.showResult(f), 1800);
    }
  }

  private caption(c: Caption): void {
    this.captions.push(c);
    const row = document.createElement('div');
    row.className = `cap${c.big ? ' big' : ''}`;
    row.innerHTML = `<span class="t">${clock(c.tick)}</span>${esc(c.text)}`;
    this.el.feed.append(row);
    while (this.el.feed.children.length > 5) this.el.feed.firstElementChild?.remove();
    if (c.big && this.started) {
      this.el.big.textContent = c.text;
      this.el.big.classList.remove('hidden');
      this.el.big.classList.remove('pop');
      void this.el.big.offsetWidth;
      this.el.big.classList.add('pop');
      this.bigUntil = performance.now() + 3200;
    }
  }

  private renderRosters(f: LegionFrame): void {
    const byId = new Map(f.regs.map((r) => [r.id, r]));
    const ps = this.meta.playerSide;
    // 玩家指揮：對手只列出現在看得到的團
    const hide = (id: number, owner: number): boolean => ps >= 0 && owner !== ps && (f.visible[ps][id] !== 1 || byId.get(id)?.reserve === true);
    const sig = f.regs.map((r) => `${r.id}:${r.men}:${r.status}:${r.level}:${r.concealed ? 1 : 0}:${Math.ceil(r.enterIn / TPS)}:${ps >= 0 ? f.visible[ps][r.id] : 0}`).join(',') + `|${this.selected}`;
    if (sig === this.rosterSig) return;
    this.rosterSig = sig;
    for (const i of [0, 1]) {
      const p = this.meta.players[i];
      const all = this.meta.regs.filter((r) => r.owner === i);
      const regs = all.filter((r) => !hide(r.id, i));
      const alive = regs.filter((r) => {
        const x = byId.get(r.id);
        return x !== undefined && x.status !== 'routed';
      }).length;
      const cnt = ps >= 0 && i !== ps ? `看得到 ${regs.length} 團` : `${alive}/${all.length} 團`;
      const row = (s: (typeof regs)[number]): string => {
            const r = byId.get(s.id);
            const men = r?.men ?? 0;
            const frac = men / s.men0;
            const st = r === undefined ? '覆滅' : r.status === 'entering' ? `入場 ${Math.ceil(r.enterIn / TPS)} 秒` : STATUS_NAME[r.status] + (r.concealed ? '・埋伏中' : '');
            const cls = r === undefined ? 'dead' : r.status === 'routed' ? 'routed' : r.status === 'engaged' || r.dashing !== null ? 'hot' : '';
            return `<div class="rr ${cls}${this.selected === s.id ? ' sel' : ''}" data-reg="${s.id}">
              <span class="ic" style="background:${r === undefined || r.status === 'routed' ? '#475569' : p.color}">${unitSvg(s.kind, 16, '#fff')}</span>
              <span class="nm">${esc(s.name)}${r && r.level > 1 ? `<span class="lv">${'★'.repeat(r.level - 1)}</span>` : ''}</span>
              <span class="st">${st}</span>
              <span class="mb"><i style="width:${Math.round(frac * 100)}%;background:${frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#f87171'}"></i></span>
              <span class="mn">${men}</span>
            </div>`;
      };
      // 出戰：在場上的、正在入場的、已覆滅的；備戰：還在後備的（佔點模式）
      const benched = (s: (typeof regs)[number]): boolean => byId.get(s.id)?.status === 'reserve';
      const field = regs.filter((s) => !benched(s));
      const bench = regs.filter(benched);
      const fieldCost = field.reduce((t, s) => (byId.get(s.id) ? t + s.cost : t), 0);
      const capture = this.meta.mode === 'capture';
      this.el[`roster${i}`].innerHTML = `<h3 style="border-color:${p.color}"><span class="sw" style="background:${p.color}"></span>${esc(p.side)}<span class="bot">${esc(p.bot)}</span><span class="cnt">${cnt}・擊殺 ${f.kills[i]} 人・戰果 ${f.killValue[i]} 點</span></h3>
        <div class="rs-h">出戰${capture && !(ps >= 0 && i !== ps) ? `<span>${fieldCost} / ${RULES.capture.fieldCap} 點</span>` : ''}</div>
        ${field.map(row).join('')}
        ${capture && bench.length > 0 ? `<div class="rs-h">備戰<span>${bench.length} 團</span></div>${bench.map(row).join('')}` : ''}`;
    }
  }

  private renderDetail(): void {
    const id = this.selected;
    this.el.detail.classList.toggle('hidden', id < 0);
    if (id < 0) return;
    const s = this.meta.regs[id];
    const r = this.r.reg(id);
    const p = this.meta.players[s.owner];
    const u = UNITS[s.kind];
    const vs = Object.entries(VERSUS[s.kind])
      .map(([t, v]) => `${UNITS[t as UnitKind].name} ×${(v! / 100).toFixed(2).replace(/0$/, '')}`)
      .join('、');
    const target = r !== undefined && (r.target >= 0 || r.fireTarget >= 0) ? this.meta.regs[r.target >= 0 ? r.target : r.fireTarget] : undefined;
    const terrain = r !== undefined ? this.terrainName(r.x, r.y) : '';
    this.el.detail.innerHTML = `<div class="dt-head"><span class="ic" style="background:${p.color}">${unitSvg(s.kind, 22, '#fff')}</span><div><b>${esc(p.side)} ${esc(s.name)}</b><div class="muted small">${u.name}・${u.cost} 點</div></div></div>
      ${
        r === undefined
          ? '<div class="muted">已覆滅</div>'
          : `<div class="dt-grid">
        <span>人數</span><b>${r.men} / ${s.men0}</b>
        <span>血量</span><b>${Math.round(r.hp / 10)} / ${Math.round(r.hpMax / 10)}</b>
        <span>狀態</span><b>${STATUS_NAME[r.status]}${r.concealed ? '・埋伏中' : ''}${r.seen ? '' : '・敵方看不到'}</b>
        <span>指令</span><b>${ORDER_NAME[r.order] ?? r.order}${target ? ` → ${esc(this.meta.players[target.owner].side)}${esc(target.name)}` : ''}</b>
        <span>等級</span><b>${r.level} 級${r.level > 1 ? `（攻擊、血量 +${RULES.veteran.levels[r.level - 1].attack - 100}%）` : ''}</b>
        <span>擊殺</span><b>${r.kills}</b>
        <span>地形</span><b>${terrain}・高度 ${this.heightAt(r.x, r.y)} 階</b>
        <span>陣形</span><b>${FORMATION_NAMES[r.formation]}${r.stance ? `・${r.stance === 'raise' ? '舉盾' : r.stance === 'wall' ? '盾牆' : '持盾'}` : ''}</b>
        <span>招牌技能</span><b>${r.skillCd > 0 ? `冷卻 ${Math.ceil(r.skillCd / TPS)} 秒` : '可以使用'}</b>
        ${r.intent ? `<span>意圖</span><b>${esc(r.intent)}</b>` : ''}
      </div>`
      }
      <div class="dt-stats small muted">攻擊 ${u.attack / 10}／${(u.cooldown / TPS).toFixed(1)} 秒・${u.range ? `射程 ${u.range / TILE} 格` : '近戰'}・速度 ${((u.speed * TPS) / TILE).toFixed(1)} 格／秒・視野 ${u.sight / TILE} 格${vs ? `<br>相剋：${vs}` : ''}</div>`;
  }

  private heightAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return this.meta.heights[ty * this.meta.width + tx] ?? 0;
  }

  private terrainName(x: number, y: number): string {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const t = this.meta.terrain[ty * this.meta.width + tx] ?? 0;
    return TERRAIN_NAMES[t];
  }

  private showResult(f: LegionFrame): void {
    const res = f.result;
    if (res === null) return;
    const byId = new Map(f.regs.map((r) => [r.id, r]));
    const stat = (i: number): string => {
      const regs = this.meta.regs.filter((r) => r.owner === i);
      const men0 = regs.reduce((s, r) => s + r.men0, 0);
      const men = regs.reduce((s, r) => s + (byId.get(r.id)?.men ?? 0), 0);
      const routed = regs.filter((r) => byId.get(r.id) === undefined || byId.get(r.id)!.status === 'routed').length;
      const p = this.meta.players[i];
      return `<div class="rs-side${res.winner === i ? ' win' : ''}" style="border-color:${p.color}"><div class="lu-head"><span class="sw" style="background:${p.color}"></span><b>${esc(p.side)}</b><span class="bot">${esc(p.bot)}</span>${res.winner === i ? '<span class="crown">勝</span>' : ''}</div>
        <div class="dt-grid"><span>剩餘兵力</span><b>${Math.floor(res.strength[i] / Math.max(1, p.cost))}%</b><span>存活士兵</span><b>${men} / ${men0}</b><span>擊殺</span><b>${f.kills[i]}</b><span>潰散或覆滅</span><b>${routed} / ${regs.length} 團</b>${this.meta.mode === 'capture' ? `<span>分數</span><b>${res.score[i]}</b><span>旗點</span><b>${res.flagsHeld[i]}</b>` : ''}</div></div>`;
    };
    const why = res.reason === 'score' ? `先拿到 ${RULES.capture.scoreTarget} 分` : res.reason === 'capture' ? '攻方佔下本陣' : res.reason === 'annihilation' ? '打垮對手全軍' : this.meta.mode === 'siege' ? '時間到，守方守住了城池' : this.meta.mode === 'capture' ? '時間到，比較分數' : '時間到，比較剩餘兵力';
    const title = res.winner === null ? '平手' : `${this.meta.players[res.winner].side}「${esc(this.meta.players[res.winner].bot)}」獲勝`;
    this.el.result.innerHTML = `<div class="lu"><h2>${title}</h2><p class="muted">${why}・比賽時間 ${clock(res.durationTicks)}</p><div class="lu-cols">${stat(0)}<div class="lu-vs">VS</div>${stat(1)}</div>
      <div class="lu-foot"><button class="primary" data-act="restart">重看一次</button><button data-act="replay">下載回放</button><button data-act="exit">換組合</button><button data-act="closeResult">看戰場</button></div></div>`;
    this.el.result.classList.remove('hidden');
    this.el.result.querySelector('[data-act=closeResult]')?.addEventListener('click', () => this.el.result.classList.add('hidden'));
  }

  // ───────── 每格畫面 ─────────

  private alpha(): number {
    return Math.max(0, Math.min(1, (performance.now() - this.frameAt) / Math.max(16, this.frameGap)));
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const now = performance.now();
    const a = this.paused ? 1 : this.alpha();
    if (this.director && this.started) this.direct();
    const dt = Math.min(100, now - (this.lastTick || now));
    this.lastTick = now;
    if (this.keysDown.size > 0) {
      const v = (dt / 1000) * (700 / this.r.cam.scale);
      const k = this.keysDown;
      if (k.has('w') || k.has('arrowup')) this.r.cam.y -= v;
      if (k.has('s') || k.has('arrowdown')) this.r.cam.y += v;
      if (k.has('a') || k.has('arrowleft')) this.r.cam.x -= v;
      if (k.has('d') || k.has('arrowright')) this.r.cam.x += v;
      this.r.clamp();
    }
    const c = this.control;
    const aim = c && c.aiming && this.mouse ? { ids: [...c.selection], to: this.r.toWorld(this.mouse.x, this.mouse.y) } : null;
    this.r.draw(a, now, { viewer: this.viewer, selected: this.selected, hovered: this.hovered, showRanges: true, showIntent: this.showIntent, selection: c?.selection, box: c?.box, order: c?.order, aim });
    if (this.toastUntil > 0 && now > this.toastUntil) {
      this.toastUntil = 0;
      this.el.toast.classList.add('hidden');
    }
    if (this.bigUntil > 0 && now > this.bigUntil) {
      this.bigUntil = 0;
      this.el.big.classList.add('hidden');
    }
    this.updateTip(a);
  };

  /** 自動導播：鏡頭移向交戰中軍團的重心，交戰範圍越集中拉得越近 */
  private direct(): void {
    const f = this.r.frame;
    if (f === null) return;
    const hot = f.regs.filter((r) => r.status === 'engaged' || r.dashing !== null || r.status === 'volleying' || r.fireTarget >= 0);
    const pool = hot.length > 0 ? hot : f.regs.filter((r) => r.status !== 'routed');
    if (pool.length === 0) return;
    let sx = 0;
    let sy = 0;
    let w = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const r of pool) {
      const k = r.men + (r.dashing !== null ? 30 : 0);
      sx += r.x * k;
      sy += r.y * k;
      w += k;
      x0 = Math.min(x0, r.x - r.rad);
      x1 = Math.max(x1, r.x + r.rad);
      y0 = Math.min(y0, r.y - r.rad);
      y1 = Math.max(y1, r.y + r.rad);
    }
    const tx = sx / w / TILE;
    const ty = sy / w / TILE;
    const cw = this.r.canvas.clientWidth;
    const ch = this.r.canvas.clientHeight;
    const span = Math.max((x1 - x0) / TILE + 16, ((y1 - y0) / TILE + 12) * (cw / ch));
    const fit = this.r.fitScale;
    const ts = Math.max(fit, Math.min(fit * 3.2, cw / span));
    const c = this.r.cam;
    c.x += (tx - c.x) * 0.035;
    c.y += (ty - c.y) * 0.035;
    c.scale += (ts - c.scale) * 0.02;
    this.r.clamp();
  }

  private updateTip(a: number): void {
    const tip = this.el.tip;
    // 瞄準技能時不顯示提示框，免得蓋住路線與落點
    if (this.mouse === null || this.drag?.moved || this.control?.aiming) {
      tip.classList.add('hidden');
      return;
    }
    const id = this.r.pick(this.mouse.x, this.mouse.y, this.viewer, a);
    if (id !== this.hovered && !this.root.querySelector('.roster:hover')) this.hovered = id;
    let html = '';
    if (id >= 0) {
      const s = this.meta.regs[id];
      const r = this.r.reg(id);
      const p = this.meta.players[s.owner];
      if (r !== undefined)
        html = `<b style="color:${p.color}">${esc(p.side)} ${esc(s.name)}</b>　${r.men}/${s.men0} 人・${FORMATION_NAMES[r.formation]}・高度 ${this.heightAt(r.x, r.y)} 階<br>${STATUS_NAME[r.status]}${r.concealed ? '・<span class="hint">埋伏中（敵方看不到）</span>' : ''}${r.level > 1 ? `・${r.level} 級老兵` : ''}${r.intent && (this.viewer < 0 || this.viewer === s.owner) ? `<br><span class="muted">意圖：${esc(r.intent)}</span>` : ''}`;
    } else {
      const w = this.r.toWorld(this.mouse.x, this.mouse.y);
      const tx = Math.floor(w.x / TILE);
      const ty = Math.floor(w.y / TILE);
      if (tx >= 0 && ty >= 0 && tx < this.meta.width && ty < this.meta.height) {
        const t = this.meta.terrain[ty * this.meta.width + tx];
        const flag = this.meta.flags.findIndex((fl) => Math.hypot(fl.x - w.x, fl.y - w.y) <= RULES.capture.radius);
        if (this.meta.mode === 'siege' && flag >= 0) {
          const st = this.r.frame?.flags[flag];
          const fl = this.meta.flags[flag];
          const att = 1 - this.meta.defender;
          const own = st === undefined ? '' : st.owner === att ? '攻方已佔下' : st.open ? (st.capturer >= 0 ? `攻方佔領中：${Math.floor((st.progress * 100) / st.need)}%` : '守方持有') : '要先佔下 A';
          html = `<b>${flag === 0 ? 'A' : 'B'} ${esc(fl.name)}</b>　佔滿要 ${(st?.need ?? 0) / TPS} 秒<br>${own}<br><span class="muted">只有攻方能佔；圈內只算地面的士兵，守方在圈內進度不動</span>`;
        } else if (this.meta.mode === 'capture' && flag >= 0) {
          const st = this.r.frame?.flags[flag];
          const fl = this.meta.flags[flag];
          const own = st === undefined || st.owner < 0 ? '沒人佔領' : `${this.meta.players[st.owner].side}佔領${st.contested ? '（爭奪中，暫停得分）' : ''}`;
          const cap = st !== undefined && st.capturer >= 0 ? `<br>${this.meta.players[st.capturer].side}佔領中：${Math.floor((st.progress * 100) / RULES.capture.captureTicks)}%` : '';
          html = `<b>旗點：${esc(fl.name)}</b>　每秒 ${fl.points} 分<br>目前：${own}${cap}<br><span class="muted">圈內有我方、沒有敵方，進度才會增加；${RULES.capture.captureTicks / TPS} 秒佔滿才算佔領，沒佔滿就離開會倒退</span>`;
        } else {
          const hgt = this.meta.heights[ty * this.meta.width + tx];
          const tip = [TERRAIN_TIP[t], t === T.River || t === T.Building || t === T.Wall ? '' : HEIGHT_TIP].filter((x) => x !== '').join('<br>');
          html = `<b>${TERRAIN_NAMES[t]}</b>　高度 ${hgt} 階<br><span class="muted">${tip}</span>`;
        }
      }
    }
    if (html === '') {
      tip.classList.add('hidden');
      return;
    }
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const cw = this.r.canvas.clientWidth;
    tip.style.left = `${Math.min(cw - tip.offsetWidth - 8, this.mouse.x + 16)}px`;
    tip.style.top = `${this.mouse.y + 18}px`;
  }
}
