// 對局／觀戰／回放畫面：版面（頂列、地圖區、底部固定面板）、輸入處理、指令格、提示訊息、事件記錄、結束對話框。
import type { Command, GameEvent } from '../api/types.ts';
import { BASE_UPGRADES, BUILDING_STATS, MAX_BASE_LEVEL, RESEARCH, RULES, TILE_SIZE, UNIT_STATS, type BuildingType, type ResearchType, type Stance, type UnitType } from '../config/index.ts';
import type { MatchResult } from '../core/match.ts';
import type { ReplayFile } from '../replay/index.ts';
import { GOD_VIEW, type BuildingFrame, type FrameView, type UnitFrame } from '../view/snapshot.ts';
import type { ScoreRow } from '../view/scoreboard.ts';
import { Broadcast } from './broadcast-ui.ts';
import type { Comment } from './commentary.ts';
import { CommandCard, type CardItem } from './command-card.ts';
import { HelpOverlay } from './help.ts';
import {
  BUILD_KEYS,
  BUILDING_NAME,
  BUILDING_TIP,
  eventText,
  formatTime,
  ORDER_NAME,
  REJECT_HINT,
  REJECT_NAME,
  RESEARCH_KEYS,
  RESEARCH_NAME,
  RESEARCH_TIP,
  STANCE_NAME,
  TRAIN_KEYS,
  UNIT_NAME,
  UNIT_TIP,
} from './labels.ts';
import type { FromWorker, MatchMeta, ToWorker } from './protocol.ts';
import { MAX_ZOOM, MIN_ZOOM, Renderer, teamColor, type ViewModel } from './renderer.ts';
import { Tutorial } from './tutorial.ts';

const LIVE_SPEEDS = [0.5, 1, 2, 3, 4];
const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8];
const STANCES: readonly Stance[] = ['aggressive', 'defensive', 'hold', 'retreat'];
const STANCE_TIP: Record<Stance, string> = {
  aggressive: '主動攻擊視野內的敵人（預設）',
  defensive: '只打射程內的敵人，不追遠',
  hold: '原地不動，只打射程內的敵人',
  retreat: '不自動攻擊，只執行你指定的攻擊',
};
const PAN_PX_PER_SEC = 900;
const EDGE_PX = 6;
const TOAST_MS = 2600;
const LOG_LINES = 7;
const MARKER_COLOR = { move: '#86efac', attack: '#f87171', rally: '#fde047' } as const;
const COMMENT_KEEP = 60;
const TERRAIN_TIP: Record<number, string> = {
  1: '<b>岩石</b><br>不能通過，也不能蓋建築',
  2: `<b>樹林</b><br>可以通過，但速度只有 ${RULES.movement.forestSpeedPercent}%；會擋視線（${RULES.vision.forestSightTiles} 格外看不進去）`,
};

/** 名稱等外部文字放進 HTML 前先跳脫 */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function download(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 只在內容改變時才寫入 innerHTML（避免每幀重建） */
function setHtml(e: HTMLElement, html: string): void {
  if (e.dataset.html !== html) {
    e.dataset.html = html;
    e.innerHTML = html;
  }
}

function hpBar(hp: number, max: number): string {
  const f = Math.max(0, Math.min(1, hp / max));
  const color = f > 0.5 ? '#22c55e' : f > 0.25 ? '#eab308' : '#ef4444';
  return `<div class="bar"><i style="width:${Math.round(f * 100)}%;background:${color}"></i></div>`;
}

function progressBar(pct: number, color: string): string {
  return `<div class="bar thin"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></i></div>`;
}

export class GameScreen {
  private readonly root: HTMLElement;
  private readonly worker: Worker;
  private readonly meta: MatchMeta;
  private readonly onExit: () => void;
  private readonly renderer: Renderer;
  private readonly vm: ViewModel;
  private readonly canvas: HTMLCanvasElement;
  private readonly stage: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly idleBtn: HTMLButtonElement;
  private readonly speedEl: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly playersEl: HTMLElement;
  private readonly infoEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly tipEl: HTMLElement;
  private comments: Comment[] = [];
  private scoreboard: readonly ScoreRow[] | null = null;
  private readonly dialog: HTMLElement;
  private readonly card: CommandCard;
  private readonly help: HelpOverlay;
  private readonly tutorial: Tutorial | null = null;
  private tutorialHighlight: readonly string[] = [];
  private readonly replaybar: HTMLElement | null = null;
  private readonly broadcast: Broadcast | null = null;
  private slider: HTMLInputElement | null = null;
  private sliderDragging = false;
  private readonly keys = new Set<string>();
  private mouse = { x: -1, y: -1, inside: false };
  /** 滑鼠在視窗中的位置（邊緣捲動用；只有碰到整個視窗的邊緣才捲動） */
  private screenMouse = { x: -1, y: -1, inside: false };
  private readonly onWindowMouseMove = (e: MouseEvent): void => {
    this.screenMouse = { x: e.clientX, y: e.clientY, inside: true };
  };
  private readonly onWindowMouseOut = (e: MouseEvent): void => {
    if (e.relatedTarget === null) this.screenMouse.inside = false;
  };
  private miniDrag = false;
  private readonly onWindowMouseUp = (e: MouseEvent): void => {
    this.miniDrag = false;
    if (e.button === 1) this.middleDrag = null;
    if (e.button === 0 && this.leftDown !== null) this.leftRelease(e);
  };
  private middleDrag: { x: number; y: number } | null = null;
  private leftDown: { x: number; y: number } | null = null;
  private pendingBuild = false;
  private placeType: BuildingType | null = null;
  private speed = 1;
  private paused = false;
  private desyncTick: number | null = null;
  private log: { tick: number; text: string }[] = [];
  private toastTimer = 0;
  private lastFrameAt = 0;
  private raf = 0;
  private lastPanAt = performance.now();
  private disposed = false;
  private idleCursor = 0;
  private readonly onKeyDown = (e: KeyboardEvent): void => this.keyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  constructor(root: HTMLElement, worker: Worker, meta: MatchMeta, onExit: () => void) {
    this.root = root;
    this.worker = worker;
    this.meta = meta;
    this.onExit = onExit;
    root.innerHTML = '';
    root.classList.remove('hidden');
    const human = meta.human;

    // ── 頂列 ──
    const topbar = el('div', 'topbar');
    this.statsEl = el('div', 'stats');
    this.idleBtn = el('button', 'idle hidden');
    this.idleBtn.type = 'button';
    this.idleBtn.title = '輪流選取閒置的工人（. 鍵）';
    this.idleBtn.addEventListener('click', () => this.selectIdleWorker());
    this.speedEl = el('span', 'speed');
    this.pauseBtn = el('button', undefined, '暫停');
    // ── 地圖區 ──
    this.stage = el('div', 'stage');
    this.canvas = el('canvas', 'view');
    this.playersEl = el('div', 'players');
    this.logEl = el('div', 'log');
    this.toastEl = el('div', 'toast hidden');
    this.tipEl = el('div', 'map-tip hidden');
    this.dialog = el('div', 'dialog hidden');
    this.stage.append(this.canvas, this.playersEl, this.logEl, this.toastEl, this.tipEl, this.dialog);
    // ── 底部面板 ──
    const panel = el('div', 'panel');
    const row = el('div', 'panel-row');
    const minimap = el('canvas', 'minimap');
    minimap.width = 180;
    minimap.height = 180;
    this.infoEl = el('div', 'info');
    this.card = new CommandCard((reason) => this.toast(reason));
    row.append(minimap, this.infoEl);
    if (human !== null) row.append(this.card.root);
    const side = el('div', 'side');
    if (human === null) row.append(side);
    if (meta.kind === 'replay') {
      this.replaybar = el('div', 'replaybar');
      panel.append(this.replaybar);
    }
    panel.append(row);
    root.append(topbar, this.stage, panel);

    this.renderer = new Renderer(this.canvas, minimap, meta.map);
    const start = human !== null ? meta.map.players[human] : null;
    this.vm = {
      map: meta.map,
      prev: null,
      cur: null,
      frameAt: 0,
      frameInterval: 100,
      camera: { x: 0, y: 0, zoom: 1.6 },
      selection: new Set(),
      selectedBuilding: null,
      drag: null,
      ghost: null,
      mode: 'normal',
      alerts: [],
      hotspots: [],
      human,
      markers: [],
      beacon: null,
    };
    this.renderer.resize();
    if (start !== null) this.centerOn((start.startTileX + 1.5) * TILE_SIZE, (start.startTileY + 1.5) * TILE_SIZE);
    else this.centerOn(meta.map.width * 500, meta.map.height * 500);
    if (human === null) {
      this.broadcast = new Broadcast(
        this.stage,
        side,
        meta,
        (m) => this.post(m),
        {
          center: () => {
            const s = this.renderer.scale(this.vm.camera);
            return { x: this.vm.camera.x + this.canvas.clientWidth / 2 / s, y: this.vm.camera.y + this.canvas.clientHeight / 2 / s };
          },
          moveTo: (x, y) => this.centerOn(x, y),
        },
      );
    }
    this.help = new HelpOverlay(this.stage);
    if (meta.tutorial && human !== null) {
      this.tutorial = new Tutorial(this.stage, {
        setHighlight: (ids) => {
          this.tutorialHighlight = ids;
        },
        setBeacon: (p) => {
          this.vm.beacon = p;
        },
      });
    }
    this.buildTopbar(topbar);
    this.buildReplaybar();
    this.bindInput(minimap);
    this.raf = requestAnimationFrame((t) => this.tick(t));
    // 開發模式的自動測試掛鉤（正式建置時移除）
    if (import.meta.env.DEV) (window as unknown as { __game?: { vm: ViewModel; toScreen: (x: number, y: number) => { x: number; y: number } } }).__game = { vm: this.vm, toScreen: (x, y) => this.toScreen(x, y) };
  }

  /** 世界座標 → 畫布座標（自動測試用） */
  private toScreen(x: number, y: number): { x: number; y: number } {
    const s = this.renderer.scale(this.vm.camera);
    return { x: (x - this.vm.camera.x) * s, y: (y - this.vm.camera.y) * s };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.toastTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    document.removeEventListener('mouseout', this.onWindowMouseOut);
    this.root.innerHTML = '';
    this.root.classList.add('hidden');
  }

  private post(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private get isHuman(): boolean {
    return this.meta.human !== null && this.vm.cur !== null && this.vm.cur.players[this.meta.human].alive;
  }

  private send(cmds: Command[]): void {
    if (!this.isHuman || cmds.length === 0) return;
    this.post({ type: 'command', cmds });
  }

  private mark(x: number, y: number, kind: keyof typeof MARKER_COLOR): void {
    this.vm.markers.push({ x, y, color: MARKER_COLOR[kind], at: performance.now() });
  }

  private toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), TOAST_MS);
  }

  private playerName(id: number): string {
    return this.meta.map.players[id]?.name ?? `P${id}`;
  }

  // ───────── 來自 Worker ─────────

  handle(msg: FromWorker): void {
    if (msg.type === 'frame') {
      const now = performance.now();
      this.vm.frameInterval = this.lastFrameAt > 0 ? Math.min(250, Math.max(16, now - this.lastFrameAt)) : 100;
      this.lastFrameAt = now;
      this.vm.prev = this.vm.cur;
      this.vm.cur = msg.frame;
      this.vm.frameAt = now;
      this.speed = msg.speed;
      this.paused = msg.paused;
      this.desyncTick = msg.desyncTick;
      this.broadcast?.onFrame(msg);
      if (msg.analysis !== null) this.ingestAnalysis(msg.analysis.scoreboard, msg.analysis.comments);
      this.vm.hotspots = msg.combat.hotspots;
      this.ingestEvents(
        msg.events.map((e) => e.ev),
        msg.frame,
      );
      this.pruneSelection();
      if (this.tutorial !== null && this.meta.human !== null) {
        this.tutorial.update({ frame: msg.frame, map: this.meta.map, human: this.meta.human, enemy: this.meta.human === 0 ? 1 : 0, selection: this.vm.selection });
      }
      this.updateHud();
    } else if (msg.type === 'end') {
      this.showEnd(msg.result);
    } else if (msg.type === 'replay') {
      download(`replay_${this.meta.map.mode}_${this.meta.map.seed}.json`, msg.file satisfies ReplayFile);
    }
  }

  /** 觀戰：數據面板與自動解說（重大解說同時顯示為大字幕） */
  private ingestAnalysis(scoreboard: readonly ScoreRow[], comments: readonly Comment[]): void {
    this.scoreboard = scoreboard;
    for (const c of comments) {
      this.comments.push(c);
      if (c.major) {
        const first = /\{P(\d+)\}/.exec(c.text);
        this.broadcast?.pushCaption(c.text.replace(/\{P(\d+)\}/g, (_, id: string) => this.playerName(Number(id))), first === null ? '#e5e7eb' : teamColor(Number(first[1])));
      }
    }
    if (this.comments.length > COMMENT_KEEP) this.comments = this.comments.slice(-COMMENT_KEEP);
  }

  /** 解說文字：{P0} 換成帶隊伍色的名稱 */
  private commentHtml(text: string): string {
    return esc(text).replace(/\{P(\d+)\}/g, (_, id: string) => `<b style="color:${teamColor(Number(id))}">${esc(this.playerName(Number(id)))}</b>`);
  }

  private ingestEvents(events: readonly GameEvent[], frame: FrameView): void {
    const now = performance.now();
    for (const ev of events) {
      if (ev.type === 'underAttack') {
        const u = frame.units.find((x) => x.id === ev.targetId);
        const b = frame.buildings.find((x) => x.id === ev.targetId);
        const x = u?.x ?? (b !== undefined ? (b.tileX + b.size / 2) * TILE_SIZE : null);
        const y = u?.y ?? (b !== undefined ? (b.tileY + b.size / 2) * TILE_SIZE : null);
        if (x !== null && y !== null && !this.vm.alerts.some((a) => Math.abs(a.x - x) < 6000 && Math.abs(a.y - y) < 6000)) {
          this.vm.alerts.push({ x, y, until: now + 2500 });
        }
        continue;
      }
      if (this.meta.human !== null && (ev.type === 'commandRejected' || ev.type === 'buildFailed')) {
        const hint = REJECT_HINT[ev.reason];
        const head = ev.type === 'buildFailed' ? `${BUILDING_NAME[ev.building]}無法開工` : '指令無法執行';
        this.toast(`${head}：${REJECT_NAME[ev.reason]}${hint !== undefined ? `——${hint}` : ''}`);
      }
      const text = eventText(ev, (id) => this.playerName(id));
      if (text !== null) this.log.push({ tick: ev.tick, text });
    }
    if (this.log.length > 60) this.log = this.log.slice(-60);
  }

  private pruneSelection(): void {
    const cur = this.vm.cur!;
    const alive = new Set(cur.units.map((u) => u.id));
    for (const id of [...this.vm.selection]) if (!alive.has(id)) this.vm.selection.delete(id);
    if (this.vm.selectedBuilding !== null && !cur.buildings.some((b) => b.id === this.vm.selectedBuilding)) this.vm.selectedBuilding = null;
    if (this.vm.mode !== 'normal' && this.myUnits().length === 0) this.setMode('normal');
  }

  // ───────── 繪圖迴圈 ─────────

  private tick(t: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, (t - this.lastPanAt) / 1000);
    this.lastPanAt = t;
    this.pan(dt);
    this.broadcast?.update(t, dt);
    this.updateGhost();
    this.updateTip();
    this.renderer.draw(this.vm, performance.now());
    this.raf = requestAnimationFrame((tt) => this.tick(tt));
  }

  private pan(dt: number): void {
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has('arrowleft') || (k.has('a') && !this.contextUsesKey('a'))) dx -= 1;
    if (k.has('arrowright') || (k.has('d') && !this.contextUsesKey('d'))) dx += 1;
    if (k.has('arrowup') || (k.has('w') && !this.contextUsesKey('w'))) dy -= 1;
    if (k.has('arrowdown') || (k.has('s') && !this.contextUsesKey('s'))) dy += 1;
    const m = this.screenMouse;
    if (m.inside && this.middleDrag === null && this.leftDown === null && !this.help.isOpen && document.hasFocus()) {
      if (m.x <= EDGE_PX) dx -= 1;
      if (m.x >= window.innerWidth - EDGE_PX) dx += 1;
      if (m.y <= EDGE_PX) dy -= 1;
      if (m.y >= window.innerHeight - EDGE_PX) dy += 1;
    }
    if (dx === 0 && dy === 0) return;
    this.broadcast?.userMovedCamera();
    const s = this.renderer.scale(this.vm.camera);
    this.vm.camera.x += (dx * PAN_PX_PER_SEC * dt) / s;
    this.vm.camera.y += (dy * PAN_PX_PER_SEC * dt) / s;
    this.renderer.clampCamera(this.vm.camera);
  }

  /** 看全圖（觀戰時同時切到自由鏡頭） */
  private fitMap(): void {
    this.broadcast?.userMovedCamera();
    this.renderer.fitCamera(this.vm.camera);
  }

  /** 滑鼠所指的東西的說明（單位、建築、瞭望塔、礦點、地形、迷霧） */
  private hoverHtml(wx: number, wy: number): string | null {
    const cur = this.vm.cur;
    if (cur === null) return null;
    const human = this.meta.human;
    const owner = (o: number): string => (o === human ? '（我方）' : `（${esc(this.playerName(o))}）`);
    const u = this.unitAt(wx, wy);
    if (u !== null) {
      return `<b>${UNIT_NAME[u.type]}</b>${owner(u.owner)}<br>血量 ${u.hp}/${u.maxHp}　${ORDER_NAME[u.order] ?? u.order}${u.carrying > 0 ? `　攜帶 ${u.carrying} 礦` : ''}<br><span class="muted">${UNIT_TIP[u.type]}</span>`;
    }
    const b = this.buildingAt(wx, wy);
    if (b !== null) {
      const status = !b.complete ? `　建造中 ${b.progress}%` : b.task !== null ? `　${b.task.kind === 'upgrade' ? '升級中' : '研究中'} ${b.task.progress}%` : b.queue.length > 0 ? `　生產${UNIT_NAME[b.queue[0].unit]} ${b.queue[0].progress}%` : '';
      return `<b>${BUILDING_NAME[b.type]}${b.type === 'base' ? ` Lv${b.level}` : ''}</b>${owner(b.owner)}<br>血量 ${b.hp}/${b.maxHp}${status}${b.remembered ? '<br><span class="muted">記憶中的樣子（現在看不到）</span>' : ''}<br><span class="muted">${BUILDING_TIP[b.type]}</span>`;
    }
    const towerR = RULES.watchtower.captureRadiusTiles * TILE_SIZE;
    const ti = this.meta.map.towers.findIndex((t) => (t.x - wx) ** 2 + (t.y - wy) ** 2 <= towerR * towerR);
    if (ti >= 0) {
      const t = cur.towers[ti];
      const own = t === undefined || t.owner === -1 ? '目前無人佔領' : t.owner === -2 ? '目前不在視野內，看不到誰佔領' : `目前由 ${t.owner === human ? '我方' : esc(this.playerName(t.owner))} 佔領`;
      const mine = human !== null && t !== undefined ? `　我方佔領進度 ${t.progress[human] ?? 0}%` : '';
      return `<b>瞭望塔</b><br>任何單位站進虛線圈內一段時間就能佔領；佔領後看得到周圍 ${RULES.watchtower.sightTiles} 格。不能被攻擊。<br>${own}${mine}`;
    }
    const tx = Math.floor(wx / TILE_SIZE);
    const ty = Math.floor(wy / TILE_SIZE);
    const map = this.meta.map;
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return null;
    const i = ty * map.width + tx;
    const fog = cur.fog?.[i] ?? 2;
    const ni = map.nodes.findIndex((n) => n.tileX === tx && n.tileY === ty);
    if (ni >= 0 && fog > 0) {
      const n = map.nodes[ni];
      const left = cur.nodes[ni];
      const amount = n.rich ? RULES.economy.richMineAmount : RULES.economy.mineAmount;
      return left <= 0
        ? '<b>礦點（已採光）</b><br>沒有礦了，但仍然擋路、不能在上面蓋建築'
        : `<b>${n.rich ? '富礦點' : '礦點'}</b><br>還剩 ${left} 礦，每趟採 ${amount} 礦<br><span class="muted">選工人後右鍵點礦點開始採礦；同時只能 1 人開採，其他人排隊。蓋採集站在旁邊可以縮短往返</span>`;
    }
    if (fog === 0) return '<b>未探索</b><br>還沒有單位到過這裡';
    const terrain = TERRAIN_TIP[map.tiles[i]];
    if (terrain !== undefined) return terrain;
    return fog === 1 ? '<b>迷霧</b><br>以前看過，但目前沒有單位在附近，看不到這裡的敵人' : null;
  }

  private updateTip(): void {
    const show = this.mouse.inside && this.leftDown === null && this.middleDrag === null && this.vm.mode === 'normal' && !this.help.isOpen;
    if (!show) {
      this.tipEl.classList.add('hidden');
      return;
    }
    const w = this.renderer.screenToWorld(this.vm.camera, this.mouse.x, this.mouse.y);
    const html = this.hoverHtml(w.x, w.y);
    if (html === null) {
      this.tipEl.classList.add('hidden');
      return;
    }
    setHtml(this.tipEl, html);
    this.tipEl.classList.remove('hidden');
    const pad = 18;
    const maxX = this.canvas.clientWidth - this.tipEl.offsetWidth - 4;
    const maxY = this.canvas.clientHeight - this.tipEl.offsetHeight - 4;
    const x = this.mouse.x + pad > maxX ? this.mouse.x - this.tipEl.offsetWidth - pad : this.mouse.x + pad;
    const y = Math.min(maxY, this.mouse.y + pad);
    this.tipEl.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  private centerOn(x: number, y: number): void {
    const s = this.renderer.scale(this.vm.camera);
    this.vm.camera.x = x - this.canvas.clientWidth / 2 / s;
    this.vm.camera.y = y - this.canvas.clientHeight / 2 / s;
    this.renderer.clampCamera(this.vm.camera);
  }

  // ───────── 選取與查詢 ─────────

  private myUnits(): UnitFrame[] {
    const cur = this.vm.cur;
    if (cur === null || this.meta.human === null) return [];
    return cur.units.filter((u) => u.owner === this.meta.human && this.vm.selection.has(u.id));
  }

  private selectedOwnBuilding(): BuildingFrame | null {
    const cur = this.vm.cur;
    if (cur === null || this.vm.selectedBuilding === null) return null;
    const b = cur.buildings.find((x) => x.id === this.vm.selectedBuilding);
    return b !== undefined && b.owner === this.meta.human && !b.remembered ? b : null;
  }

  private unitAt(wx: number, wy: number): UnitFrame | null {
    const cur = this.vm.cur;
    if (cur === null) return null;
    // 點擊判定比單位本身大一些，縮小畫面時也點得到
    const pad = Math.max(250, 9 / this.renderer.scale(this.vm.camera));
    let best: UnitFrame | null = null;
    let bestD = Infinity;
    for (const u of cur.units) {
      const r = UNIT_STATS[u.type].radius + pad;
      const d = (u.x - wx) ** 2 + (u.y - wy) ** 2;
      if (d <= r * r && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private buildingAt(wx: number, wy: number): BuildingFrame | null {
    const cur = this.vm.cur;
    if (cur === null) return null;
    const tx = Math.floor(wx / TILE_SIZE);
    const ty = Math.floor(wy / TILE_SIZE);
    const hits = cur.buildings.filter((b) => tx >= b.tileX && tx < b.tileX + b.size && ty >= b.tileY && ty < b.tileY + b.size);
    return hits.find((b) => !b.remembered) ?? hits[0] ?? null;
  }

  private nodeAt(wx: number, wy: number): number | null {
    const tx = Math.floor(wx / TILE_SIZE);
    const ty = Math.floor(wy / TILE_SIZE);
    const n = this.meta.map.nodes.find((x) => x.tileX === tx && x.tileY === ty);
    return n === undefined ? null : n.id;
  }

  /** 依選手已知資訊判斷可否放置（與引擎規則相同）；不可放置時回傳原因 */
  private placeProblem(type: BuildingType, tx: number, ty: number): string | null {
    const map = this.meta.map;
    const cur = this.vm.cur;
    if (cur === null) return '尚未開始';
    const size = BUILDING_STATS[type].size;
    if (tx < 0 || ty < 0 || tx + size > map.width || ty + size > map.height) return '超出地圖';
    for (let y = ty; y < ty + size; y++) {
      for (let x = tx; x < tx + size; x++) {
        const i = y * map.width + x;
        if (cur.fog !== null && cur.fog[i] === 0) return '還沒探索過的地方不能蓋（先派單位過去看看）';
        if (map.tiles[i] !== 0) return '只能蓋在平地上（不能蓋在岩石或樹林）';
        if (map.nodes.some((n) => n.tileX === x && n.tileY === y)) return '不能壓到礦點';
      }
    }
    if (cur.buildings.some((b) => tx < b.tileX + b.size && tx + size > b.tileX && ty < b.tileY + b.size && ty + size > b.tileY)) return '不能壓到其他建築';
    return null;
  }

  /** 滑鼠位置對應的建築左上角格（建築中心對齊滑鼠） */
  private placeTile(type: BuildingType, px: number, py: number): { tileX: number; tileY: number } {
    const w = this.renderer.screenToWorld(this.vm.camera, px, py);
    const size = BUILDING_STATS[type].size;
    return { tileX: Math.floor(w.x / TILE_SIZE - size / 2 + 0.5), tileY: Math.floor(w.y / TILE_SIZE - size / 2 + 0.5) };
  }

  private updateGhost(): void {
    if (this.vm.mode !== 'place' || this.placeType === null || !this.mouse.inside) {
      this.vm.ghost = null;
      return;
    }
    const t = this.placeTile(this.placeType, this.mouse.x, this.mouse.y);
    this.vm.ghost = { type: this.placeType, ...t, valid: this.placeProblem(this.placeType, t.tileX, t.tileY) === null };
  }

  // ───────── 輸入 ─────────

  private bindInput(minimap: HTMLCanvasElement): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    minimap.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mouseenter', () => {
      this.mouse.inside = true;
    });
    c.addEventListener('mouseleave', () => {
      this.mouse.inside = false;
      this.tipEl.classList.add('hidden');
    });
    c.addEventListener('mousemove', (e) => {
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.mouse.inside = true;
      if (this.middleDrag !== null) {
        this.broadcast?.userMovedCamera();
        const s = this.renderer.scale(this.vm.camera);
        this.vm.camera.x -= (e.offsetX - this.middleDrag.x) / s;
        this.vm.camera.y -= (e.offsetY - this.middleDrag.y) / s;
        this.middleDrag = { x: e.offsetX, y: e.offsetY };
        this.renderer.clampCamera(this.vm.camera);
      }
      if (this.leftDown !== null && (e.buttons & 1) === 0) {
        // 漏收放開事件（例如在視窗外放開）：當作已放開，避免框選卡住
        this.leftRelease(e);
      } else if (this.leftDown !== null && this.vm.mode === 'normal') {
        this.vm.drag = { x0: this.leftDown.x, y0: this.leftDown.y, x1: e.offsetX, y1: e.offsetY };
      }
      this.updateTip();
    });
    c.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.middleDrag = { x: e.offsetX, y: e.offsetY };
      } else if (e.button === 0) {
        this.leftPress(e);
      } else if (e.button === 2) {
        this.rightClick(e.offsetX, e.offsetY);
      }
    });
    c.addEventListener('dblclick', (e) => this.selectSameType(e.offsetX, e.offsetY));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const cam = this.vm.camera;
        const before = this.renderer.screenToWorld(cam, e.offsetX, e.offsetY);
        cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const s = this.renderer.scale(cam);
        cam.x = before.x - e.offsetX / s;
        cam.y = before.y - e.offsetY / s;
        this.renderer.clampCamera(cam);
      },
      { passive: false },
    );
    const minimapMove = (e: MouseEvent): void => {
      const w = this.renderer.minimapToWorld(e.offsetX, e.offsetY);
      this.centerOn(w.x, w.y);
    };
    minimap.addEventListener('mousedown', (e) => {
      const w = this.renderer.minimapToWorld(e.offsetX, e.offsetY);
      if (e.button === 0 && (this.vm.mode === 'attackMove' || this.vm.mode === 'move')) {
        // 攻擊移動／移動模式下，左鍵點小地圖＝目的地
        this.issueAt(w.x, w.y, e.shiftKey);
      } else if (e.button === 0) {
        this.miniDrag = true;
        this.broadcast?.userMovedCamera();
        minimapMove(e);
      } else if (e.button === 2) {
        const ids = this.myUnits().map((u) => u.id);
        if (ids.length > 0) {
          this.send([{ type: 'move', units: ids, x: Math.round(w.x), y: Math.round(w.y) }]);
          this.mark(w.x, w.y, 'move');
        }
      }
    });
    minimap.addEventListener('mousemove', (e) => {
      if (this.miniDrag) minimapMove(e);
    });
    window.addEventListener('mouseup', this.onWindowMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onWindowMouseMove);
    document.addEventListener('mouseout', this.onWindowMouseOut);
  }

  /** 攻擊移動／移動模式的目的地 */
  private issueAt(wx: number, wy: number, keepMode: boolean): void {
    const ids = this.myUnits().map((u) => u.id);
    const x = Math.round(wx);
    const y = Math.round(wy);
    if (ids.length > 0) {
      if (this.vm.mode === 'attackMove') {
        this.send([{ type: 'attackMove', units: ids, x, y }]);
        this.mark(x, y, 'attack');
      } else {
        this.send([{ type: 'move', units: ids, x, y }]);
        this.mark(x, y, 'move');
      }
    }
    if (!keepMode) this.setMode('normal');
  }

  private leftPress(e: MouseEvent): void {
    const w = this.renderer.screenToWorld(this.vm.camera, e.offsetX, e.offsetY);
    if (this.vm.mode === 'place' && this.placeType !== null) {
      const type = this.placeType;
      const workers = this.myUnits().filter((u) => u.type === 'worker');
      if (workers.length === 0) {
        this.toast('請先選取工人');
        this.setMode('normal');
        return;
      }
      const g = this.placeTile(type, e.offsetX, e.offsetY);
      const problem = this.placeProblem(type, g.tileX, g.tileY);
      if (problem !== null) {
        this.toast(`這裡不能蓋：${problem}`);
        return;
      }
      const cx = (g.tileX + BUILDING_STATS[type].size / 2) * TILE_SIZE;
      const cy = (g.tileY + BUILDING_STATS[type].size / 2) * TILE_SIZE;
      workers.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2) || a.id - b.id);
      this.send([{ type: 'build', workerId: workers[0].id, building: type, tileX: g.tileX, tileY: g.tileY }]);
      this.mark(cx, cy, 'move');
      if (!e.shiftKey) this.setMode('normal');
      return;
    }
    if (this.vm.mode === 'attackMove' || this.vm.mode === 'move') {
      this.issueAt(w.x, w.y, e.shiftKey);
      return;
    }
    this.leftDown = { x: e.offsetX, y: e.offsetY };
  }

  private leftRelease(e: MouseEvent): void {
    const start = this.leftDown!;
    this.leftDown = null;
    this.vm.drag = null;
    const cur = this.vm.cur;
    if (cur === null) return;
    const add = e.shiftKey;
    // 以視窗座標計算（滑鼠可能在畫布外放開）
    const rect = this.canvas.getBoundingClientRect();
    const ex = e.clientX - rect.left;
    const ey = e.clientY - rect.top;
    const moved = Math.abs(ex - start.x) > 6 || Math.abs(ey - start.y) > 6;
    if (moved) {
      const a = this.renderer.screenToWorld(this.vm.camera, Math.min(start.x, ex), Math.min(start.y, ey));
      const b = this.renderer.screenToWorld(this.vm.camera, Math.max(start.x, ex), Math.max(start.y, ey));
      const owner = this.meta.human;
      const inBox = cur.units.filter((u) => u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y && (owner === null || u.owner === owner));
      // 框選時戰鬥單位優先於工人
      const combat = inBox.filter((u) => u.type !== 'worker');
      const picked = combat.length > 0 ? combat : inBox;
      if (picked.length > 0 || !add) {
        if (!add) this.vm.selection.clear();
        for (const u of picked) this.vm.selection.add(u.id);
        if (picked.length > 0) this.vm.selectedBuilding = null;
      }
    } else {
      const w = this.renderer.screenToWorld(this.vm.camera, start.x, start.y);
      const u = this.unitAt(w.x, w.y);
      if (u !== null) {
        if (!add) this.vm.selection.clear();
        this.vm.selection.add(u.id);
        this.vm.selectedBuilding = null;
      } else {
        const bld = this.buildingAt(w.x, w.y);
        if (!add || bld !== null) {
          this.vm.selection.clear();
          this.vm.selectedBuilding = bld?.id ?? null;
        }
      }
    }
    this.pendingBuild = false;
    this.updateHud();
  }

  private rightClick(px: number, py: number): void {
    if (this.vm.mode !== 'normal' || this.pendingBuild) {
      this.setMode('normal');
      return;
    }
    const w = this.renderer.screenToWorld(this.vm.camera, px, py);
    const x = Math.round(w.x);
    const y = Math.round(w.y);
    const own = this.selectedOwnBuilding();
    const units = this.myUnits();
    if (units.length === 0) {
      if (own !== null && BUILDING_STATS[own.type].produces.length > 0) {
        this.send([{ type: 'rally', buildingId: own.id, x, y }]);
        this.mark(x, y, 'rally');
      } else if (this.meta.human !== null) {
        this.toast('先用左鍵選取單位，再用右鍵下指令');
      }
      return;
    }
    const ids = units.map((u) => u.id);
    const workers = units.filter((u) => u.type === 'worker').map((u) => u.id);
    const others = units.filter((u) => u.type !== 'worker').map((u) => u.id);
    const human = this.meta.human;
    const tu = this.unitAt(w.x, w.y);
    const tb = this.buildingAt(w.x, w.y);
    if (tu !== null && tu.owner !== human) {
      this.send([{ type: 'attack', units: ids, targetId: tu.id }]);
      this.mark(tu.x, tu.y, 'attack');
      return;
    }
    if (tb !== null && tb.owner !== human && !tb.remembered) {
      this.send([{ type: 'attack', units: ids, targetId: tb.id }]);
      this.mark(x, y, 'attack');
      return;
    }
    const node = this.nodeAt(w.x, w.y);
    if (node !== null && workers.length > 0) {
      const cmds: Command[] = [{ type: 'gather', units: workers, nodeId: node }];
      if (others.length > 0) cmds.push({ type: 'move', units: others, x, y });
      this.send(cmds);
      this.mark(x, y, 'move');
      return;
    }
    if (tb !== null && tb.owner === human && !tb.complete && workers.length > 0) {
      const cmds: Command[] = [{ type: 'resume', workerId: workers[0], buildingId: tb.id }];
      if (ids.length > 1) cmds.push({ type: 'move', units: ids.filter((id) => id !== workers[0]), x, y });
      this.send(cmds);
      this.mark(x, y, 'move');
      return;
    }
    this.send([{ type: 'move', units: ids, x, y }]);
    this.mark(x, y, 'move');
  }

  private setMode(mode: ViewModel['mode']): void {
    this.vm.mode = mode;
    this.pendingBuild = false;
    if (mode !== 'place') this.placeType = null;
    this.root.classList.toggle('mode-target', mode === 'attackMove' || mode === 'move');
    this.updateHud();
  }

  /** 該鍵在目前情境下是否有對應動作（有就不平移鏡頭） */
  private contextUsesKey(k: string): boolean {
    return this.card.find(k) !== null;
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (e.key === '?') {
      this.help.toggle();
      return;
    }
    if (k === 'escape') {
      if (this.help.isOpen) this.help.close();
      else if (this.vm.mode !== 'normal' || this.pendingBuild) this.setMode('normal');
      else {
        this.vm.selection.clear();
        this.vm.selectedBuilding = null;
        this.updateHud();
      }
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      this.post({ type: 'pause', paused: !this.paused });
      return;
    }
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      this.stepSpeed(k === '-' || k === '_' ? -1 : 1);
      return;
    }
    if (/^[0-9]$/.test(k)) {
      const g = Number(k);
      if (e.ctrlKey) {
        e.preventDefault();
        const ids = this.myUnits().map((u) => u.id);
        if (ids.length > 0) this.send([{ type: 'group', group: g, units: ids }]);
      } else if (this.vm.cur !== null && this.meta.human !== null) {
        const members = this.vm.cur.units.filter((u) => u.owner === this.meta.human && u.group === g);
        if (members.length > 0) {
          this.vm.selection = new Set(members.map((u) => u.id));
          this.vm.selectedBuilding = null;
          this.updateHud();
        }
      }
      return;
    }
    if (k === '.') {
      this.selectIdleWorker();
      return;
    }
    const item = this.card.find(k);
    if (item !== null) {
      e.preventDefault();
      this.card.trigger(item);
      return;
    }
    if (k === 'z') {
      this.fitMap();
      return;
    }
    if (/^f[1-4]$/.test(k)) e.preventDefault();
    this.keys.add(k);
  }

  /** 雙擊：選取畫面內所有同類型的己方單位 */
  private selectSameType(px: number, py: number): void {
    const cur = this.vm.cur;
    if (cur === null) return;
    const w = this.renderer.screenToWorld(this.vm.camera, px, py);
    const u = this.unitAt(w.x, w.y);
    if (u === null || (this.meta.human !== null && u.owner !== this.meta.human)) return;
    const a = this.renderer.screenToWorld(this.vm.camera, 0, 0);
    const b = this.renderer.screenToWorld(this.vm.camera, this.canvas.clientWidth, this.canvas.clientHeight);
    this.vm.selection = new Set(cur.units.filter((x) => x.owner === u.owner && x.type === u.type && x.x >= a.x && x.x <= b.x && x.y >= a.y && x.y <= b.y).map((x) => x.id));
    this.vm.selectedBuilding = null;
    this.updateHud();
  }

  /** 輪流選取閒置工人並移動鏡頭 */
  private selectIdleWorker(): void {
    const cur = this.vm.cur;
    if (cur === null || this.meta.human === null) return;
    const idle = cur.units.filter((u) => u.owner === this.meta.human && u.type === 'worker' && u.order === 'idle');
    if (idle.length === 0) {
      this.toast('沒有閒置的工人');
      return;
    }
    const u = idle[this.idleCursor++ % idle.length];
    this.vm.selection = new Set([u.id]);
    this.vm.selectedBuilding = null;
    this.setMode('normal');
    this.centerOn(u.x, u.y);
  }

  /** 工人：去採最近的礦（已探索、還有儲量） */
  private gatherNearest(workers: readonly UnitFrame[]): void {
    const cur = this.vm.cur;
    if (cur === null || workers.length === 0) return;
    const cx = workers.reduce((a, u) => a + u.x, 0) / workers.length;
    const cy = workers.reduce((a, u) => a + u.y, 0) / workers.length;
    const nodes = this.meta.map.nodes;
    let target: { id: number; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (cur.nodes[i] <= 0) continue;
      if (cur.fog !== null && cur.fog[n.tileY * this.meta.map.width + n.tileX] === 0) continue;
      const x = (n.tileX + 0.5) * TILE_SIZE;
      const y = (n.tileY + 0.5) * TILE_SIZE;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        target = { id: n.id, x, y };
      }
    }
    if (target === null) {
      this.toast('附近沒有看得到的礦點');
      return;
    }
    this.send([{ type: 'gather', units: workers.map((u) => u.id), nodeId: target.id }]);
    this.mark(target.x, target.y, 'move');
  }

  private stepSpeed(dir: number): void {
    const list = this.meta.kind === 'replay' ? REPLAY_SPEEDS : LIVE_SPEEDS;
    const i = list.indexOf(this.speed);
    const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 1 : i) + dir))];
    // 先更新本地值：連按時不必等下一幀回報
    this.speed = next;
    this.post({ type: 'speed', speed: next });
  }

  // ───────── 指令格 ─────────

  private cardItems(): (CardItem | null)[] {
    const cur = this.vm.cur;
    const human = this.meta.human;
    if (cur === null || human === null || !cur.players[human].alive) return [];
    const p = cur.players[human];
    const back = (label: string): CardItem => ({ id: 'back', hotkey: 'Esc', label, enabled: true, tip: '回到一般操作', run: () => this.setMode('normal') });
    if (this.vm.mode === 'place' && this.placeType !== null) {
      const t = this.placeType;
      return [{ id: `placing:${t}`, hotkey: '', label: `放置${BUILDING_NAME[t]}`, cost: BUILDING_STATS[t].cost, enabled: true, active: true, tip: '左鍵放在綠色的位置；Shift ＋ 左鍵可以連續放置', run: () => undefined }, null, null, null, back('取消')];
    }
    if (this.vm.mode === 'attackMove' || this.vm.mode === 'move') {
      const am = this.vm.mode === 'attackMove';
      return [{ id: am ? 'attackMove' : 'move', hotkey: '', label: am ? '攻擊移動中' : '移動中', enabled: true, active: true, tip: '左鍵點地圖或小地圖選目的地', run: () => undefined }, null, null, null, back('取消')];
    }
    const units = this.myUnits();
    if (units.length > 0) {
      const workers = units.filter((u) => u.type === 'worker');
      if (this.pendingBuild) {
        const items: (CardItem | null)[] = Object.entries(BUILD_KEYS).map(([key, type]) => {
          const st = BUILDING_STATS[type];
          const reason = st.requiresTech > p.tech.level ? `需要主堡 Lv${st.requiresTech}（選主堡按 U 升級）` : p.minerals < st.cost ? `礦不足（還差 ${st.cost - p.minerals}）` : undefined;
          return {
            id: `build:${type}`,
            hotkey: key.toUpperCase(),
            label: BUILDING_NAME[type],
            cost: st.cost,
            enabled: reason === undefined,
            ...(reason !== undefined ? { reason } : {}),
            tip: BUILDING_TIP[type],
            run: () => {
              this.vm.mode = 'place';
              this.placeType = type;
              this.pendingBuild = false;
              this.updateHud();
            },
          };
        });
        while (items.length < 9) items.push(null);
        items.push(back('返回'));
        return items;
      }
      const ids = units.map((u) => u.id);
      const items: (CardItem | null)[] = [
        { id: 'move', hotkey: 'M', label: '移動', enabled: true, tip: '再左鍵點目的地（右鍵直接點地圖也可以移動）', run: () => this.setMode('move') },
        { id: 'attackMove', hotkey: 'A', label: '攻擊移動', enabled: true, tip: '再左鍵點目的地；途中遇到敵人會自動開打', run: () => this.setMode('attackMove') },
        { id: 'hold', hotkey: 'H', label: '駐守', enabled: true, tip: '原地停下', run: () => this.send([{ type: 'hold', units: ids }]) },
        workers.length > 0 ? { id: 'gather', hotkey: 'G', label: '採礦', enabled: true, tip: '選取的工人去採最近的礦', run: () => this.gatherNearest(workers) } : null,
        workers.length > 0
          ? {
              id: 'build',
              hotkey: 'B',
              label: '建造',
              enabled: true,
              tip: '打開建造選單',
              run: () => {
                this.pendingBuild = true;
                this.updateHud();
              },
            }
          : null,
      ];
      STANCES.forEach((s, i) => {
        items.push({ id: `stance:${s}`, hotkey: `F${i + 1}`, label: STANCE_NAME[s], enabled: true, active: units.every((u) => u.stance === s), tip: `姿態：${STANCE_TIP[s]}`, run: () => this.send([{ type: 'stance', units: ids, stance: s }]) });
      });
      return items;
    }
    const b = this.selectedOwnBuilding();
    if (b === null) return [];
    const items: (CardItem | null)[] = [];
    for (const [key, unit] of Object.entries(TRAIN_KEYS[b.type])) {
      if (unit === undefined) continue;
      const st = UNIT_STATS[unit];
      const reason = !b.complete
        ? '建築還沒蓋好'
        : b.task !== null
          ? '升級／研究中，生產暫停'
          : b.queue.length >= RULES.production.queueMax
            ? `生產佇列已滿（最多 ${RULES.production.queueMax} 個）`
            : p.minerals < st.cost
              ? `礦不足（還差 ${st.cost - p.minerals}）`
              : p.supplyUsed + st.supply > p.supplyCap
                ? p.supplyCap >= RULES.supply.hardCap
                  ? `人口已達上限 ${RULES.supply.hardCap}`
                  : '人口不足——請先蓋補給站'
                : undefined;
      items.push(this.trainItem(b, key, unit, reason));
    }
    for (const [key, research] of Object.entries(RESEARCH_KEYS[b.type] ?? {})) {
      if (research === undefined) continue;
      const lv = p.tech[research];
      const def = RESEARCH[research].levels[lv];
      if (def === undefined) continue;
      const reason = !b.complete ? '建築還沒蓋好' : b.task !== null ? '已經在研究中' : def.tech > p.tech.level ? `需要主堡 Lv${def.tech}` : p.minerals < def.cost ? `礦不足（還差 ${def.cost - p.minerals}）` : undefined;
      items.push(this.researchItem(b, key, research, lv, def.cost, reason));
    }
    while (items.length < 3) items.push(null);
    if (b.type === 'base' && b.level < MAX_BASE_LEVEL) {
      const up = BASE_UPGRADES[b.level - 1];
      const reason = !b.complete ? '建築還沒蓋好' : b.task !== null ? '已經在升級中' : p.minerals < up.cost ? `礦不足（還差 ${up.cost - p.minerals}）` : undefined;
      items.push({ id: 'upgrade', hotkey: 'U', label: '升級', cost: up.cost, enabled: reason === undefined, ...(reason !== undefined ? { reason } : {}), tip: `升級到 Lv${b.level + 1}：提高主堡血量並解鎖鍛造所、攻城工坊與研究；升級中暫停生產`, run: () => this.send([{ type: 'upgrade', buildingId: b.id }]) });
    } else {
      items.push(null);
    }
    if (!b.complete || b.queue.length > 0 || b.task !== null) {
      const label = !b.complete ? '取消建造' : b.task !== null ? '取消升級' : '取消生產';
      const tip = !b.complete ? `退還 ${RULES.construction.cancelRefundPercent}% 的礦` : b.task !== null ? '取消目前的升級或研究' : '取消最後一個排隊的項目，退還全部礦';
      items.push({ id: 'cancel', hotkey: 'X', label, enabled: true, tip, run: () => this.send([{ type: 'cancel', buildingId: b.id }]) });
    }
    return items;
  }

  private trainItem(b: BuildingFrame, key: string, unit: UnitType, reason: string | undefined): CardItem {
    const st = UNIT_STATS[unit];
    return {
      id: `train:${unit}`,
      hotkey: key.toUpperCase(),
      label: UNIT_NAME[unit],
      cost: st.cost,
      enabled: reason === undefined,
      ...(reason !== undefined ? { reason } : {}),
      tip: `${UNIT_TIP[unit]}（人口 ${st.supply}）`,
      run: () => this.send([{ type: 'train', buildingId: b.id, unit }]),
    };
  }

  private researchItem(b: BuildingFrame, key: string, research: ResearchType, lv: number, cost: number, reason: string | undefined): CardItem {
    return {
      id: `research:${research}`,
      hotkey: key.toUpperCase(),
      label: `${RESEARCH_NAME[research]} Lv${lv + 1}`,
      cost,
      enabled: reason === undefined,
      ...(reason !== undefined ? { reason } : {}),
      tip: RESEARCH_TIP[research],
      run: () => this.send([{ type: 'research', buildingId: b.id, research }]),
    };
  }

  // ───────── HUD ─────────

  private buildTopbar(topbar: HTMLElement): void {
    const spacer = el('div', 'spacer');
    this.pauseBtn.addEventListener('click', () => this.post({ type: 'pause', paused: !this.paused }));
    const slower = el('button', undefined, '−');
    slower.title = '減速（−）';
    slower.addEventListener('click', () => this.stepSpeed(-1));
    const faster = el('button', undefined, '＋');
    faster.title = '加速（＋）';
    faster.addEventListener('click', () => this.stepSpeed(1));
    const helpBtn = el('button', undefined, '說明 ?');
    helpBtn.addEventListener('click', () => this.help.toggle());
    const fitBtn = el('button', undefined, '看全圖');
    fitBtn.title = '縮放到整張地圖（Z）';
    fitBtn.addEventListener('click', () => this.fitMap());
    topbar.append(this.statsEl, this.idleBtn, spacer);
    if (this.meta.human === null) {
      const viewer = el('select');
      viewer.append(new Option('上帝視角', String(GOD_VIEW)));
      for (const p of this.meta.map.players) viewer.append(new Option(`${p.name} 視角`, String(p.id)));
      viewer.addEventListener('change', () => this.post({ type: 'viewer', viewer: Number(viewer.value) }));
      topbar.append(viewer);
    }
    topbar.append(fitBtn, slower, this.speedEl, faster, this.pauseBtn, helpBtn);
    if (this.meta.kind === 'live') {
      const save = el('button', undefined, '下載回放');
      save.addEventListener('click', () => this.post({ type: 'getReplay' }));
      topbar.append(save);
    }
    const exit = el('button', undefined, '離開');
    exit.addEventListener('click', () => this.onExit());
    topbar.append(exit);
  }

  private buildReplaybar(): void {
    const bar = this.replaybar;
    if (bar === null) return;
    const play = el('button', undefined, '⏯');
    play.addEventListener('click', () => this.post({ type: 'pause', paused: !this.paused }));
    const slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(this.meta.durationTicks ?? 6000);
    slider.value = '0';
    slider.addEventListener('input', () => {
      this.sliderDragging = true;
    });
    slider.addEventListener('change', () => {
      this.sliderDragging = false;
      this.post({ type: 'seek', tick: Number(slider.value) });
    });
    this.slider = slider;
    const label = el('span');
    label.dataset.role = 'time';
    const warn = el('span', 'warn');
    warn.dataset.role = 'desync';
    bar.append(play, slider, label, warn);
  }

  private updateHud(): void {
    const cur = this.vm.cur;
    if (cur === null) return;
    const human = this.meta.human;
    if (human !== null) {
      const p = cur.players[human];
      const supplyFull = p.supplyUsed >= p.supplyCap;
      const budget = this.meta.limitBudget ? `<span class="stat">額度 <b>${p.budget}</b></span>` : '';
      const tech = `<span class="stat opt">科技 <b>Lv${p.tech.level}</b>${p.tech.weapons + p.tech.armor > 0 ? `（武器 ${p.tech.weapons}／護甲 ${p.tech.armor}）` : ''}</span>`;
      const groups = new Map<number, number>();
      for (const u of cur.units) if (u.owner === human && u.group >= 0) groups.set(u.group, (groups.get(u.group) ?? 0) + 1);
      const groupText = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([g, c]) => `[${g}] ${c}`).join(' ');
      setHtml(
        this.statsEl,
        `<span class="stat big">◆ <b>${p.minerals}</b> 礦</span><span class="stat big${supplyFull ? ' full' : ''}" title="人口滿了就要蓋補給站">人口 <b>${p.supplyUsed}/${p.supplyCap}</b></span><span class="stat">時間 <b>${formatTime(cur.tick)}</b></span>${tech}${budget}${groupText !== '' ? `<span class="stat opt">編隊 ${groupText}</span>` : ''}${p.alive ? '' : '<span class="warn">已淘汰</span>'}`,
      );
      const idle = cur.units.filter((u) => u.owner === human && u.type === 'worker' && u.order === 'idle').length;
      const idleText = `閒置工人 ${idle}`;
      if (this.idleBtn.textContent !== idleText) this.idleBtn.textContent = idleText;
      this.idleBtn.classList.toggle('hidden', idle === 0);
    } else {
      setHtml(this.statsEl, `<span class="stat">時間 <b>${formatTime(cur.tick)}</b></span><span class="stat muted">${this.meta.kind === 'replay' ? '回放' : '觀戰'}　seed ${this.meta.map.seed}</span>`);
    }
    const speedText = `${this.speed}x`;
    if (this.speedEl.textContent !== speedText) this.speedEl.textContent = speedText;
    const pauseText = this.paused ? '繼續' : '暫停';
    if (this.pauseBtn.textContent !== pauseText) this.pauseBtn.textContent = pauseText;
    // 觀戰的選手列（有數據面板時不需要）
    if (human === null && this.scoreboard === null) {
      setHtml(
        this.playersEl,
        cur.players.map((p) => `<div class="p${p.alive ? '' : ' dead'}"><span class="dot" style="background:${teamColor(p.id)}"></span>${esc(this.playerName(p.id))}　礦 ${p.minerals}</div>`).join(''),
      );
    } else {
      setHtml(this.playersEl, '');
    }
    if (this.replaybar !== null && this.slider !== null) {
      if (!this.sliderDragging) this.slider.value = String(cur.tick);
      this.replaybar.querySelector<HTMLElement>('[data-role=time]')!.textContent = `${formatTime(cur.tick)} / ${formatTime(this.meta.durationTicks ?? 0)}`;
      this.replaybar.querySelector<HTMLElement>('[data-role=desync]')!.textContent = this.desyncTick === null ? '' : `不同步！tick ${this.desyncTick}`;
    }
    setHtml(this.infoEl, this.infoHtml());
    if (human !== null) {
      const items = this.cardItems();
      const ids = new Set(items.flatMap((it) => (it === null ? [] : [it.id])));
      this.card.setHighlight(this.tutorialHighlight.find((id) => ids.has(id)) ?? null);
      this.card.update(items);
    }
    setHtml(
      this.logEl,
      this.scoreboard !== null
        ? this.comments
            .slice(-LOG_LINES)
            .map((c) => `<div class="${c.major ? 'major' : ''}"><span class="t">${formatTime(c.tick)}</span>${this.commentHtml(c.text)}</div>`)
            .join('')
        : this.log
            .slice(-LOG_LINES)
            .map((l) => `<div><span class="t">${formatTime(l.tick)}</span>${esc(l.text)}</div>`)
            .join(''),
    );
    this.logEl.classList.toggle('commentary', this.scoreboard !== null);
  }

  /** 觀戰數據面板：各選手一欄，數值最高者標示 */
  private scoreboardHtml(rows: readonly ScoreRow[]): string {
    const alive = rows.filter((r) => r.alive);
    const best = (f: (r: ScoreRow) => number): number => Math.max(...alive.map(f));
    const cell = (r: ScoreRow, v: number, f: (r: ScoreRow) => number, text = String(v)): string => `<td class="${r.alive && alive.length > 1 && v === best(f) && v > 0 ? 'lead' : ''}">${r.alive ? text : '—'}</td>`;
    const comp = (r: ScoreRow): string => (['spear', 'archer', 'cavalry', 'siege'] as UnitType[]).flatMap((t) => ((r.comp[t] ?? 0) > 0 ? [`${UNIT_NAME[t].replace('兵', '')}${r.comp[t]}`] : [])).join(' ') || '—';
    const head = rows.map((r) => `<th style="color:${teamColor(r.id)}">${esc(this.playerName(r.id))}${r.alive ? '' : '（淘汰）'}</th>`).join('');
    const line = (label: string, tip: string, f: (r: ScoreRow) => number, fmt?: (r: ScoreRow) => string): string =>
      `<tr><td title="${tip}">${label}</td>${rows.map((r) => cell(r, f(r), f, fmt?.(r))).join('')}</tr>`;
    return `<table class="score"><tr><th></th>${head}</tr>
${line('礦', '目前持有、還沒花掉的礦', (r) => r.minerals)}
${line('工人', '採礦的工人數', (r) => r.workers)}
${line('收入／分', '最近一分鐘採到的礦', (r) => r.incomePerMin)}
${line('兵力', '戰鬥單位的總成本（礦）', (r) => r.army)}
<tr><td title="戰鬥單位數（長槍、弓、騎、攻城）">兵種</td>${rows.map((r) => `<td>${r.alive ? comp(r) : '—'}</td>`).join('')}</tr>
${line('人口', '目前人口／上限', (r) => r.supplyUsed, (r) => `${r.supplyUsed}/${r.supplyCap}`)}
${line('科技', '主堡等級、武器、護甲研究', (r) => r.techLevel * 100 + r.weapons + r.armor, (r) => `Lv${r.techLevel}${r.weapons + r.armor > 0 ? ` 武${r.weapons} 甲${r.armor}` : ''}${r.holdsWatchtower ? ' ◎塔' : ''}`)}
${line('採集點', '主堡與採集站數（越多代表擴張越多）', (r) => r.dropoffs)}
${line('防禦塔', '已完工的防禦塔', (r) => r.towers)}
${line('資產分數', '時限到時用來排名：存活單位＋已完工建築的成本', (r) => r.assets)}
</table>`;
  }

  private infoHtml(): string {
    const cur = this.vm.cur!;
    const human = this.meta.human;
    // 觀戰：數據面板常駐；選取的東西只顯示一行摘要（細節看滑鼠提示）
    if (human === null && this.scoreboard !== null) {
      const sel = cur.units.filter((u) => this.vm.selection.has(u.id));
      const b = this.vm.selectedBuilding === null ? undefined : cur.buildings.find((x) => x.id === this.vm.selectedBuilding);
      const line =
        sel.length === 1
          ? `${UNIT_NAME[sel[0].type]}（${esc(this.playerName(sel[0].owner))}）血量 ${sel[0].hp}/${sel[0].maxHp}`
          : sel.length > 1
            ? `已選取 ${sel.length} 個單位`
            : b !== undefined
              ? `${BUILDING_NAME[b.type]}（${esc(this.playerName(b.owner))}）血量 ${b.hp}/${b.maxHp}`
              : '';
      return `${line !== '' ? `<div class="kv">${line}</div>` : ''}${this.scoreboardHtml(this.scoreboard)}`;
    }
    const units = cur.units.filter((u) => this.vm.selection.has(u.id));
    const owner = (o: number): string => (o === human ? '' : `<span class="muted">（${this.playerName(o)}）</span>`);
    if (this.pendingBuild) return '<div class="title">建造</div><div class="hint">選一種建築，再左鍵放到地圖上（Esc 返回）</div>';
    if (units.length === 1) {
      const u = units[0];
      return `<div class="title">${UNIT_NAME[u.type]}${owner(u.owner)}</div>${hpBar(u.hp, u.maxHp)}<div class="kv">血量 ${u.hp}/${u.maxHp}　姿態 ${STANCE_NAME[u.stance]}　狀態 ${ORDER_NAME[u.order] ?? u.order}${u.carrying > 0 ? `　攜帶 ${u.carrying} 礦` : ''}${u.group >= 0 ? `　編隊 ${u.group}` : ''}</div><div class="muted small">${UNIT_TIP[u.type]}</div>`;
    }
    if (units.length > 1) {
      const counts = new Map<UnitType, number>();
      for (const u of units) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
      const hp = units.reduce((a, u) => a + u.hp, 0);
      const max = units.reduce((a, u) => a + u.maxHp, 0);
      return `<div class="title">已選取 ${units.length} 個單位</div>${hpBar(hp, max)}<div class="chips">${[...counts.entries()].map(([t, n]) => `<span>${UNIT_NAME[t]} ×${n}</span>`).join('')}</div>`;
    }
    if (this.vm.selectedBuilding !== null) {
      const b = cur.buildings.find((x) => x.id === this.vm.selectedBuilding);
      if (b !== undefined) {
        const parts = [`<div class="title">${BUILDING_NAME[b.type]}${b.type === 'base' ? ` Lv${b.level}` : ''}${owner(b.owner)}${b.remembered ? '<span class="muted">（記憶中的樣子）</span>' : ''}</div>`, hpBar(b.hp, b.maxHp), `<div class="kv">血量 ${b.hp}/${b.maxHp}</div>`];
        if (!b.complete) parts.push(`<div class="kv">建造中 ${b.progress}%</div>${progressBar(b.progress, '#facc15')}`);
        if (b.task !== null) parts.push(`<div class="kv">${b.task.kind === 'upgrade' ? '升級中' : `研究${RESEARCH_NAME[b.task.research as ResearchType]}`} ${b.task.progress}%（生產暫停）</div>${progressBar(b.task.progress, '#a78bfa')}`);
        if (b.queue.length > 0) {
          parts.push(`<div class="queue">${b.queue.map((q, i) => `<span>${UNIT_NAME[q.unit]}${i === 0 ? ` ${q.progress}%` : ''}</span>`).join('')}</div>`);
          parts.push(progressBar(b.queue[0].progress, '#60a5fa'));
        }
        if (b.owner === human && !b.remembered) {
          parts.push(`<div class="muted small">${BUILDING_TIP[b.type]}${BUILDING_STATS[b.type].produces.length > 0 ? '。右鍵點地上設定集結點' : ''}</div>`);
        }
        return parts.join('');
      }
    }
    return human === null ? '<div class="muted">點選單位或建築查看資訊</div>' : '<div class="title">尚未選取</div><div class="muted">左鍵點選或拖曳框選單位、點選建築；右鍵對選取的單位下指令。<br>不知道怎麼玩？按 <kbd>?</kbd> 看說明。</div>';
  }

  private showEnd(result: MatchResult): void {
    const d = this.dialog;
    d.innerHTML = '';
    const human = this.meta.human;
    const myRank = human === null ? null : (result.players.find((p) => p.playerId === human)?.rank ?? null);
    const title = myRank === null ? '比賽結束' : myRank === 1 ? (this.meta.tutorial ? '教學完成！' : '勝利！') : `第 ${myRank} 名`;
    d.append(el('h2', undefined, title));
    if (this.meta.tutorial && myRank === 1) d.append(el('p', undefined, '你已經學會基本操作。回選單試試「1v1：玩家 vs 基準 Bot」，基準 Bot 會出兵反擊。'));
    const ol = el('ol');
    for (const pid of result.ranking) {
      const p = result.players.find((x) => x.playerId === pid)!;
      ol.append(el('li', undefined, `${this.playerName(pid)}　資產 ${p.score}${p.eliminatedTick >= 0 ? `　淘汰於 ${formatTime(p.eliminatedTick)}` : ''}`));
    }
    d.append(ol, el('div', undefined, `比賽長度 ${formatTime(result.durationTicks)}`));
    const row = el('div', 'row');
    if (this.meta.kind === 'live') {
      const save = el('button', undefined, '下載回放');
      save.addEventListener('click', () => this.post({ type: 'getReplay' }));
      row.append(save);
    }
    const stay = el('button', undefined, '繼續查看');
    stay.addEventListener('click', () => d.classList.add('hidden'));
    const exit = el('button', 'primary', '回到選單');
    exit.addEventListener('click', () => this.onExit());
    row.append(stay, exit);
    d.append(row);
    d.classList.remove('hidden');
  }
}
