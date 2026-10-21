// 對局／觀戰／回放畫面：輸入處理、HUD、事件記錄、結束對話框。
import type { Command, GameEvent } from '../api/types.ts';
import { BUILDING_STATS, TILE_SIZE, UNIT_STATS, type BuildingType, type Stance, type UnitType } from '../config/index.ts';
import type { MatchResult } from '../core/match.ts';
import type { ReplayFile } from '../replay/index.ts';
import { GOD_VIEW, type BuildingFrame, type FrameView, type UnitFrame } from '../view/snapshot.ts';
import { BASE_UPGRADES, MAX_BASE_LEVEL, RESEARCH } from '../config/index.ts';
import { BUILD_KEYS, BUILDING_NAME, eventText, formatTime, ORDER_NAME, RESEARCH_KEYS, RESEARCH_NAME, STANCE_NAME, TRAIN_KEYS, UNIT_NAME } from './labels.ts';
import type { FromWorker, MatchMeta, ToWorker } from './protocol.ts';
import { Broadcast } from './broadcast-ui.ts';
import { Renderer, teamColor, type ViewModel } from './renderer.ts';

const LIVE_SPEEDS = [0.5, 1, 2, 3, 4];
const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8];
const STANCE_KEYS: Record<string, Stance> = { F1: 'aggressive', F2: 'defensive', F3: 'hold', F4: 'retreat' };
const PAN_PX_PER_SEC = 900;
const EDGE_PX = 6;

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

export class GameScreen {
  private readonly root: HTMLElement;
  private readonly worker: Worker;
  private readonly meta: MatchMeta;
  private readonly onExit: () => void;
  private readonly renderer: Renderer;
  private readonly vm: ViewModel;
  private readonly canvas: HTMLCanvasElement;
  private readonly topbar: HTMLElement;
  private readonly playersEl: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly replaybar: HTMLElement | null = null;
  private readonly broadcast: Broadcast | null = null;
  private slider: HTMLInputElement | null = null;
  private sliderDragging = false;
  private readonly keys = new Set<string>();
  private mouse = { x: -1, y: -1, inside: false };
  private middleDrag: { x: number; y: number } | null = null;
  private leftDown: { x: number; y: number } | null = null;
  private pendingBuild = false;
  private placeType: BuildingType | null = null;
  private speed = 1;
  private paused = false;
  private desyncTick: number | null = null;
  private log: { tick: number; text: string }[] = [];
  private lastFrameAt = 0;
  private raf = 0;
  private lastPanAt = performance.now();
  private disposed = false;
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
    this.canvas = el('canvas', 'view');
    root.append(this.canvas);
    this.topbar = el('div', 'topbar');
    this.playersEl = el('div', 'players');
    const bottom = el('div', 'bottom');
    const minimap = el('canvas', 'minimap');
    minimap.width = 200;
    minimap.height = 200;
    this.selectionEl = el('div', 'selection');
    this.logEl = el('div', 'log');
    bottom.append(minimap, this.selectionEl, this.logEl);
    this.dialog = el('div', 'dialog hidden');
    root.append(this.topbar, this.playersEl, bottom, this.dialog);
    if (meta.kind === 'replay') {
      this.replaybar = el('div', 'replaybar');
      root.append(this.replaybar);
    }
    this.renderer = new Renderer(this.canvas, minimap, meta.map);
    const human = meta.human;
    const start = human !== null ? meta.map.players[human] : null;
    this.vm = {
      map: meta.map,
      prev: null,
      cur: null,
      frameAt: 0,
      frameInterval: 100,
      camera: { x: 0, y: 0, zoom: 1.4 },
      selection: new Set(),
      selectedBuilding: null,
      drag: null,
      ghost: null,
      mode: 'normal',
      alerts: [],
      hotspots: [],
      human,
    };
    this.renderer.resize();
    if (start !== null) this.centerOn((start.startTileX + 1.5) * TILE_SIZE, (start.startTileY + 1.5) * TILE_SIZE);
    else this.centerOn(meta.map.width * 500, meta.map.height * 500);
    if (human === null) {
      this.broadcast = new Broadcast(
        root,
        meta,
        (m) => this.post(m),
        {
          center: () => {
            const s = this.renderer.scale(this.vm.camera);
            return { x: this.vm.camera.x + this.canvas.clientWidth / 2 / s, y: this.vm.camera.y + this.canvas.clientHeight / 2 / s };
          },
          moveTo: (x, y) => this.centerOn(x, y),
        },
        (id) => this.playerName(id),
      );
    }
    this.buildTopbar();
    this.buildReplaybar();
    this.bindInput(minimap);
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
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
      this.vm.hotspots = msg.combat.hotspots;
      this.ingestEvents(
        msg.events.map((e) => e.ev),
        msg.frame,
      );
      this.pruneSelection();
      this.updateHud();
    } else if (msg.type === 'end') {
      this.showEnd(msg.result);
    } else if (msg.type === 'replay') {
      download(`replay_${this.meta.map.mode}_${this.meta.map.seed}.json`, msg.file satisfies ReplayFile);
    }
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
  }

  // ───────── 繪圖迴圈 ─────────

  private tick(t: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, (t - this.lastPanAt) / 1000);
    this.lastPanAt = t;
    this.pan(dt);
    this.broadcast?.update(t, dt);
    this.updateGhost();
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
    if (this.mouse.inside && this.middleDrag === null && this.leftDown === null && document.hasFocus()) {
      if (this.mouse.x <= EDGE_PX) dx -= 1;
      if (this.mouse.x >= this.canvas.clientWidth - EDGE_PX) dx += 1;
      if (this.mouse.y <= EDGE_PX) dy -= 1;
      if (this.mouse.y >= this.canvas.clientHeight - EDGE_PX) dy += 1;
    }
    if (dx === 0 && dy === 0) return;
    this.broadcast?.userMovedCamera();
    const s = this.renderer.scale(this.vm.camera);
    this.vm.camera.x += (dx * PAN_PX_PER_SEC * dt) / s;
    this.vm.camera.y += (dy * PAN_PX_PER_SEC * dt) / s;
    this.renderer.clampCamera(this.vm.camera);
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
    let best: UnitFrame | null = null;
    let bestD = Infinity;
    for (const u of cur.units) {
      const r = UNIT_STATS[u.type].radius + 250;
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

  /** 依選手已知資訊判斷可否放置（與引擎規則相同） */
  private canPlace(type: BuildingType, tx: number, ty: number): boolean {
    const map = this.meta.map;
    const cur = this.vm.cur;
    if (cur === null) return false;
    const size = BUILDING_STATS[type].size;
    if (tx < 0 || ty < 0 || tx + size > map.width || ty + size > map.height) return false;
    for (let y = ty; y < ty + size; y++) {
      for (let x = tx; x < tx + size; x++) {
        const i = y * map.width + x;
        if (map.tiles[i] !== 0) return false;
        if (cur.fog !== null && cur.fog[i] === 0) return false;
        if (map.nodes.some((n) => n.tileX === x && n.tileY === y)) return false;
      }
    }
    return !cur.buildings.some((b) => tx < b.tileX + b.size && tx + size > b.tileX && ty < b.tileY + b.size && ty + size > b.tileY);
  }

  private updateGhost(): void {
    if (this.vm.mode !== 'place' || this.placeType === null || !this.mouse.inside) {
      this.vm.ghost = null;
      return;
    }
    const w = this.renderer.screenToWorld(this.vm.camera, this.mouse.x, this.mouse.y);
    const size = BUILDING_STATS[this.placeType].size;
    const tx = Math.floor(w.x / TILE_SIZE - size / 2 + 0.5);
    const ty = Math.floor(w.y / TILE_SIZE - size / 2 + 0.5);
    this.vm.ghost = { type: this.placeType, tileX: tx, tileY: ty, valid: this.canPlace(this.placeType, tx, ty) };
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
      if (this.leftDown !== null && this.vm.mode === 'normal') {
        this.vm.drag = { x0: this.leftDown.x, y0: this.leftDown.y, x1: e.offsetX, y1: e.offsetY };
      }
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
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) this.middleDrag = null;
      if (e.button === 0 && this.leftDown !== null) this.leftRelease(e);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const cam = this.vm.camera;
        const before = this.renderer.screenToWorld(cam, e.offsetX, e.offsetY);
        cam.zoom = Math.max(0.5, Math.min(3, cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
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
    let miniDrag = false;
    minimap.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        miniDrag = true;
        this.broadcast?.userMovedCamera();
        minimapMove(e);
      } else if (e.button === 2) {
        const w = this.renderer.minimapToWorld(e.offsetX, e.offsetY);
        const ids = this.myUnits().map((u) => u.id);
        if (ids.length > 0) this.send([{ type: 'move', units: ids, x: Math.round(w.x), y: Math.round(w.y) }]);
      }
    });
    minimap.addEventListener('mousemove', (e) => {
      if (miniDrag) minimapMove(e);
    });
    window.addEventListener('mouseup', () => {
      miniDrag = false;
    });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private leftPress(e: MouseEvent): void {
    const w = this.renderer.screenToWorld(this.vm.camera, e.offsetX, e.offsetY);
    if (this.vm.mode === 'place' && this.placeType !== null) {
      const g = this.vm.ghost;
      const workers = this.myUnits().filter((u) => u.type === 'worker');
      if (g !== null && g.valid && workers.length > 0) {
        const cx = (g.tileX + BUILDING_STATS[g.type].size / 2) * TILE_SIZE;
        const cy = (g.tileY + BUILDING_STATS[g.type].size / 2) * TILE_SIZE;
        workers.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2) || a.id - b.id);
        this.send([{ type: 'build', workerId: workers[0].id, building: g.type, tileX: g.tileX, tileY: g.tileY }]);
        if (!e.shiftKey) this.setMode('normal');
      }
      return;
    }
    if (this.vm.mode === 'attackMove') {
      const ids = this.myUnits().map((u) => u.id);
      if (ids.length > 0) this.send([{ type: 'attackMove', units: ids, x: Math.round(w.x), y: Math.round(w.y) }]);
      if (!e.shiftKey) this.setMode('normal');
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
    const moved = Math.abs(e.offsetX - start.x) > 4 || Math.abs(e.offsetY - start.y) > 4;
    if (moved) {
      const a = this.renderer.screenToWorld(this.vm.camera, Math.min(start.x, e.offsetX), Math.min(start.y, e.offsetY));
      const b = this.renderer.screenToWorld(this.vm.camera, Math.max(start.x, e.offsetX), Math.max(start.y, e.offsetY));
      const owner = this.meta.human;
      const inBox = cur.units.filter((u) => u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y && (owner === null || u.owner === owner));
      // 框選時戰鬥單位優先於工人
      const combat = inBox.filter((u) => u.type !== 'worker');
      const picked = combat.length > 0 ? combat : inBox;
      if (!add) this.vm.selection.clear();
      for (const u of picked) this.vm.selection.add(u.id);
      if (picked.length > 0) this.vm.selectedBuilding = null;
    } else {
      const w = this.renderer.screenToWorld(this.vm.camera, e.offsetX, e.offsetY);
      const u = this.unitAt(w.x, w.y);
      if (u !== null) {
        if (!add) this.vm.selection.clear();
        this.vm.selection.add(u.id);
        this.vm.selectedBuilding = null;
      } else {
        const bld = this.buildingAt(w.x, w.y);
        this.vm.selection.clear();
        this.vm.selectedBuilding = bld?.id ?? null;
      }
    }
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
      if (own !== null && BUILDING_STATS[own.type].produces.length > 0) this.send([{ type: 'rally', buildingId: own.id, x, y }]);
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
      return;
    }
    if (tb !== null && tb.owner !== human && !tb.remembered) {
      this.send([{ type: 'attack', units: ids, targetId: tb.id }]);
      return;
    }
    const node = this.nodeAt(w.x, w.y);
    if (node !== null && workers.length > 0) {
      const cmds: Command[] = [{ type: 'gather', units: workers, nodeId: node }];
      if (others.length > 0) cmds.push({ type: 'move', units: others, x, y });
      this.send(cmds);
      return;
    }
    if (tb !== null && tb.owner === human && !tb.complete && workers.length > 0) {
      const cmds: Command[] = [{ type: 'resume', workerId: workers[0], buildingId: tb.id }];
      if (ids.length > 1) cmds.push({ type: 'move', units: ids.filter((id) => id !== workers[0]), x, y });
      this.send(cmds);
      return;
    }
    this.send([{ type: 'move', units: ids, x, y }]);
  }

  private setMode(mode: ViewModel['mode']): void {
    this.vm.mode = mode;
    this.pendingBuild = false;
    if (mode !== 'place') this.placeType = null;
    this.root.classList.toggle('mode-attack', mode === 'attackMove');
    this.updateHud();
  }

  /** 該鍵在目前情境下是否有對應動作（有就不平移鏡頭） */
  private contextUsesKey(k: string): boolean {
    if (this.pendingBuild && BUILD_KEYS[k] !== undefined) return true;
    if (k === 'a' && this.myUnits().length > 0) return true;
    const b = this.selectedOwnBuilding();
    if (b !== null && (TRAIN_KEYS[b.type][k] !== undefined || RESEARCH_KEYS[b.type]?.[k] !== undefined)) return true;
    return false;
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (k.startsWith('f') && STANCE_KEYS[e.key] !== undefined) {
      e.preventDefault();
      const ids = this.myUnits().map((u) => u.id);
      if (ids.length > 0) this.send([{ type: 'stance', units: ids, stance: STANCE_KEYS[e.key] }]);
      return;
    }
    if (k === 'escape') {
      if (this.vm.mode !== 'normal' || this.pendingBuild) this.setMode('normal');
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
    if (this.pendingBuild) {
      const type = BUILD_KEYS[k];
      if (type !== undefined) {
        this.vm.mode = 'place';
        this.placeType = type;
        this.pendingBuild = false;
        this.updateHud();
        return;
      }
    }
    if (k === 'b' && this.myUnits().some((u) => u.type === 'worker')) {
      this.pendingBuild = true;
      this.updateHud();
      return;
    }
    if (k === 'a' && this.myUnits().length > 0) {
      this.setMode('attackMove');
      return;
    }
    if (k === '.') {
      this.selectIdleWorker();
      return;
    }
    if (k === 'h') {
      const ids = this.myUnits().map((u) => u.id);
      if (ids.length > 0) this.send([{ type: 'hold', units: ids }]);
      return;
    }
    const b = this.selectedOwnBuilding();
    if (b !== null) {
      const unit = TRAIN_KEYS[b.type][k];
      if (unit !== undefined) {
        this.send([{ type: 'train', buildingId: b.id, unit }]);
        return;
      }
      if (k === 'x') {
        this.send([{ type: 'cancel', buildingId: b.id }]);
        return;
      }
      if (k === 'u' && b.type === 'base') {
        this.send([{ type: 'upgrade', buildingId: b.id }]);
        return;
      }
      const research = RESEARCH_KEYS[b.type]?.[k];
      if (research !== undefined) {
        this.send([{ type: 'research', buildingId: b.id, research }]);
        return;
      }
    }
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

  private idleCursor = 0;

  /** 句點鍵：輪流選取閒置工人並移動鏡頭 */
  private selectIdleWorker(): void {
    const cur = this.vm.cur;
    if (cur === null || this.meta.human === null) return;
    const idle = cur.units.filter((u) => u.owner === this.meta.human && u.type === 'worker' && u.order === 'idle');
    if (idle.length === 0) return;
    const u = idle[this.idleCursor++ % idle.length];
    this.vm.selection = new Set([u.id]);
    this.vm.selectedBuilding = null;
    this.centerOn(u.x, u.y);
    this.updateHud();
  }

  private stepSpeed(dir: number): void {
    const list = this.meta.kind === 'replay' ? REPLAY_SPEEDS : LIVE_SPEEDS;
    const i = list.indexOf(this.speed);
    const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 1 : i) + dir))];
    this.post({ type: 'speed', speed: next });
  }

  // ───────── HUD ─────────

  private buildTopbar(): void {
    this.topbar.innerHTML = '';
    const stats = el('div', 'stat');
    stats.dataset.role = 'stats';
    const spacer = el('div', 'spacer');
    const pause = el('button', undefined, '暫停');
    pause.dataset.role = 'pause';
    pause.addEventListener('click', () => this.post({ type: 'pause', paused: !this.paused }));
    const slower = el('button', undefined, '−');
    slower.addEventListener('click', () => this.stepSpeed(-1));
    const speed = el('span', 'stat');
    speed.dataset.role = 'speed';
    const faster = el('button', undefined, '＋');
    faster.addEventListener('click', () => this.stepSpeed(1));
    this.topbar.append(stats, spacer);
    if (this.meta.human === null) {
      const viewer = el('select');
      viewer.append(new Option('上帝視角', String(GOD_VIEW)));
      for (const p of this.meta.map.players) viewer.append(new Option(`${p.name} 視角`, String(p.id)));
      viewer.addEventListener('change', () => this.post({ type: 'viewer', viewer: Number(viewer.value) }));
      this.topbar.append(viewer);
    }
    const save = el('button', undefined, '下載回放');
    save.addEventListener('click', () => this.post({ type: 'getReplay' }));
    const exit = el('button', undefined, '離開');
    exit.addEventListener('click', () => this.onExit());
    this.topbar.append(slower, speed, faster, pause);
    if (this.meta.kind === 'live') this.topbar.append(save);
    this.topbar.append(exit);
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
    const stats = this.topbar.querySelector<HTMLElement>('[data-role=stats]')!;
    if (human !== null) {
      const p = cur.players[human];
      const budget = this.meta.limitBudget ? `　額度 <b>${p.budget}</b>` : '';
      const tech = `　科技 <b>Lv${p.tech.level}</b>${p.tech.weapons + p.tech.armor > 0 ? `（武器 ${p.tech.weapons}／護甲 ${p.tech.armor}）` : ''}`;
      const idleWorkers = cur.units.filter((u) => u.owner === human && u.type === 'worker' && u.order === 'idle').length;
      const groups = new Map<number, number>();
      for (const u of cur.units) if (u.owner === human && u.group >= 0) groups.set(u.group, (groups.get(u.group) ?? 0) + 1);
      const groupText = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([g, c]) => `[${g}] ${c}`).join(' ');
      const extra = `${idleWorkers > 0 ? `　<span class="hint">閒置工人 ${idleWorkers}（. 鍵選取）</span>` : ''}${groupText !== '' ? `　編隊 ${groupText}` : ''}`;
      stats.innerHTML = `礦 <b>${p.minerals}</b>　人口 <b>${p.supplyUsed}/${p.supplyCap}</b>　時間 <b>${formatTime(cur.tick)}</b>${tech}${budget}${extra}${p.alive ? '' : '　<span class="warn">已淘汰</span>'}`;
    } else {
      stats.innerHTML = `時間 <b>${formatTime(cur.tick)}</b>　<span style="color:var(--muted)">${this.meta.kind === 'replay' ? '回放' : '觀戰'}　seed ${this.meta.map.seed}</span>`;
    }
    this.topbar.querySelector<HTMLElement>('[data-role=speed]')!.textContent = `${this.speed}x`;
    this.topbar.querySelector<HTMLElement>('[data-role=pause]')!.textContent = this.paused ? '繼續' : '暫停';
    // 選手列
    if (human === null) {
      this.playersEl.innerHTML = '';
      for (const p of cur.players) {
        const row = el('div', `p${p.alive ? '' : ' dead'}`);
        row.innerHTML = `<span class="dot" style="background:${teamColor(p.id)}"></span>${this.playerName(p.id)}　礦 ${p.minerals}　人口 ${p.supplyUsed}/${p.supplyCap}　兵力 ${p.army}　工人 ${p.workers}`;
        this.playersEl.append(row);
      }
    }
    if (this.replaybar !== null && this.slider !== null) {
      if (!this.sliderDragging) this.slider.value = String(cur.tick);
      this.replaybar.querySelector<HTMLElement>('[data-role=time]')!.textContent = `${formatTime(cur.tick)} / ${formatTime(this.meta.durationTicks ?? 0)}`;
      this.replaybar.querySelector<HTMLElement>('[data-role=desync]')!.textContent = this.desyncTick === null ? '' : `不同步！tick ${this.desyncTick}`;
    }
    this.renderSelection();
    this.logEl.innerHTML = this.log
      .slice(-9)
      .map((l) => `<div><span class="t">${formatTime(l.tick)}</span>${l.text}</div>`)
      .join('');
  }

  private renderSelection(): void {
    const cur = this.vm.cur!;
    const box = this.selectionEl;
    box.innerHTML = '';
    const human = this.meta.human;
    if (this.pendingBuild) {
      box.append(el('div', 'hint', '建造：C 主堡、D 採集站、S 補給站、R 兵營、T 防禦塔（Esc 取消）'));
    } else if (this.vm.mode === 'place' && this.placeType !== null) {
      box.append(el('div', 'hint', `放置${BUILDING_NAME[this.placeType]}（${BUILDING_STATS[this.placeType].cost} 礦）：左鍵放置、Shift 連續放置、右鍵或 Esc 取消`));
    }
    const units = cur.units.filter((u) => this.vm.selection.has(u.id));
    if (units.length === 1) {
      const u = units[0];
      box.append(el('div', 'title', `${UNIT_NAME[u.type]}${u.owner === human ? '' : `（${this.playerName(u.owner)}）`}`));
      box.append(el('div', undefined, `血量 ${u.hp}/${u.maxHp}　姿態 ${STANCE_NAME[u.stance]}　狀態 ${ORDER_NAME[u.order] ?? u.order}${u.carrying > 0 ? `　攜帶 ${u.carrying} 礦` : ''}${u.group >= 0 ? `　編隊 ${u.group}` : ''}`));
    } else if (units.length > 1) {
      const counts = new Map<UnitType, number>();
      for (const u of units) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
      box.append(el('div', 'title', `已選取 ${units.length} 個單位`));
      box.append(el('div', undefined, [...counts.entries()].map(([t, n]) => `${UNIT_NAME[t]} ×${n}`).join('　')));
    }
    if (units.length > 0 && units.every((u) => u.owner === human)) {
      const actions = el('div', 'actions');
      const btn = (text: string, fn: () => void): void => {
        const b = el('button', undefined, text);
        b.addEventListener('click', fn);
        actions.append(b);
      };
      const ids = units.map((u) => u.id);
      btn('A 攻擊移動', () => this.setMode('attackMove'));
      btn('H 駐守', () => this.send([{ type: 'hold', units: ids }]));
      (['aggressive', 'defensive', 'hold', 'retreat'] as Stance[]).forEach((s, i) => btn(`F${i + 1} ${STANCE_NAME[s]}`, () => this.send([{ type: 'stance', units: ids, stance: s }])));
      if (units.some((u) => u.type === 'worker')) {
        for (const [key, type] of Object.entries(BUILD_KEYS)) {
          btn(`B${key.toUpperCase()} ${BUILDING_NAME[type]} ${BUILDING_STATS[type].cost}`, () => {
            this.vm.mode = 'place';
            this.placeType = type;
            this.pendingBuild = false;
            this.updateHud();
          });
        }
      }
      box.append(actions);
    }
    if (units.length === 0 && this.vm.selectedBuilding !== null) {
      const b = cur.buildings.find((x) => x.id === this.vm.selectedBuilding);
      if (b !== undefined) {
        box.append(el('div', 'title', `${BUILDING_NAME[b.type]}${b.owner === human ? '' : `（${this.playerName(b.owner)}）`}${b.remembered ? '（記憶）' : ''}`));
        box.append(el('div', undefined, `血量 ${b.hp}/${b.maxHp}${b.type === 'base' ? `　Lv${b.level}` : ''}${b.complete ? '' : `　建造中 ${b.progress}%`}${b.task === null ? '' : `　${b.task.kind === 'upgrade' ? '升級中' : `研究${RESEARCH_NAME[b.task.research as keyof typeof RESEARCH_NAME]}`} ${b.task.progress}%（生產暫停）`}`));
        if (b.queue.length > 0) {
          const q = el('div', 'queue');
          b.queue.forEach((item, i) => q.append(el('span', undefined, `${UNIT_NAME[item.unit]}${i === 0 ? ` ${item.progress}%` : ''}`)));
          box.append(q);
        }
        if (b.owner === human && !b.remembered) {
          const actions = el('div', 'actions');
          for (const [key, unit] of Object.entries(TRAIN_KEYS[b.type])) {
            if (unit === undefined) continue;
            const bt = el('button', undefined, `${key.toUpperCase()} ${UNIT_NAME[unit]} ${UNIT_STATS[unit].cost}`);
            bt.disabled = !b.complete;
            bt.addEventListener('click', () => this.send([{ type: 'train', buildingId: b.id, unit }]));
            actions.append(bt);
          }
          if (b.type === 'base' && b.complete && b.level < MAX_BASE_LEVEL && b.task === null) {
            const up = BASE_UPGRADES[b.level - 1];
            const bt = el('button', undefined, `U 升級 Lv${b.level + 1} ${up.cost}`);
            bt.addEventListener('click', () => this.send([{ type: 'upgrade', buildingId: b.id }]));
            actions.append(bt);
          }
          for (const [key, research] of Object.entries(RESEARCH_KEYS[b.type] ?? {})) {
            if (research === undefined) continue;
            const lv = cur.players[human!].tech[research];
            const def = RESEARCH[research].levels[lv];
            if (def === undefined) continue;
            const bt = el('button', undefined, `${key.toUpperCase()} ${RESEARCH_NAME[research]} Lv${lv + 1} ${def.cost}`);
            bt.disabled = !b.complete || b.task !== null;
            bt.addEventListener('click', () => this.send([{ type: 'research', buildingId: b.id, research }]));
            actions.append(bt);
          }
          if (!b.complete || b.queue.length > 0 || b.task !== null) {
            const bt = el('button', undefined, !b.complete ? 'X 取消建造（退 75%）' : b.task !== null ? 'X 取消升級／研究' : 'X 取消生產');
            bt.addEventListener('click', () => this.send([{ type: 'cancel', buildingId: b.id }]));
            actions.append(bt);
          }
          if (BUILDING_STATS[b.type].produces.length > 0) actions.append(el('span', 'hint', '右鍵設定集結點'));
          box.append(actions);
        }
      }
    }
    if (box.childElementCount === 0) {
      box.append(el('div', undefined, human === null ? '點選單位或建築查看資訊' : '左鍵選取單位；右鍵下達指令'));
    }
  }

  private showEnd(result: MatchResult): void {
    const d = this.dialog;
    d.innerHTML = '';
    const human = this.meta.human;
    const myRank = human === null ? null : result.players.find((p) => p.playerId === human)?.rank ?? null;
    d.append(el('h2', undefined, myRank === null ? '比賽結束' : myRank === 1 ? '勝利！' : `第 ${myRank} 名`));
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
