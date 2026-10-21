// 觀戰呈現（M3）：自動導播、跟隨選手、事件字幕、戰力曲線、精華模式與快轉。
import type { GameEvent } from '../api/types.ts';
import { TILE_SIZE } from '../config/index.ts';
import { FIGHT_LEVEL, type Hotspot } from '../view/broadcast.ts';
import type { FrameView } from '../view/snapshot.ts';
import { BUILDING_NAME } from './labels.ts';
import type { FromWorker, MatchMeta, ToWorker } from './protocol.ts';
import { teamColor } from './renderer.ts';

type FrameMsg = Extract<FromWorker, { type: 'frame' }>;
export type CameraMode = 'auto' | 'free' | number;

/** 每個鏡頭至少停留的時間（毫秒） */
const MIN_DWELL_MS = 4000;
/** 新熱點強度超過目前的倍數時可提早切換 */
const SWITCH_FACTOR = 2;
const GRAPH_SAMPLE_TICKS = 25;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface CameraHooks {
  center(): { x: number; y: number };
  moveTo(x: number, y: number): void;
}

export class Broadcast {
  mode: CameraMode = 'auto';
  hotspots: readonly Hotspot[] = [];
  private readonly meta: MatchMeta;
  private readonly post: (m: ToWorker) => void;
  private readonly cam: CameraHooks;
  private readonly name: (id: number) => string;
  private readonly caption: HTMLElement;
  private readonly graph: HTMLCanvasElement;
  private readonly controls: HTMLElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly highlightBtn: HTMLButtonElement;
  private readonly skipFightBtn: HTMLButtonElement;
  private readonly skipEndBtn: HTMLButtonElement;
  private captions: { text: string; color: string }[] = [];
  private captionUntil = 0;
  private target: { x: number; y: number; hits: number } | null = null;
  private targetSince = 0;
  private level = 0;
  private wasFighting = false;
  private history: { tick: number; army: number[] }[] = [];
  private frame: FrameView | null = null;

  constructor(root: HTMLElement, meta: MatchMeta, post: (m: ToWorker) => void, cam: CameraHooks, name: (id: number) => string) {
    this.meta = meta;
    this.post = post;
    this.cam = cam;
    this.name = name;
    this.caption = el('div', 'caption hidden');
    this.graph = el('canvas', 'armygraph');
    this.graph.width = 260;
    this.graph.height = 96;
    this.controls = el('div', 'bcast');
    this.modeSelect = el('select');
    this.modeSelect.append(new Option('鏡頭：自動導播', 'auto'), new Option('鏡頭：自由', 'free'));
    for (const p of meta.map.players) this.modeSelect.append(new Option(`鏡頭：跟隨 ${p.name}`, String(p.id)));
    this.modeSelect.addEventListener('change', () => {
      const v = this.modeSelect.value;
      this.mode = v === 'auto' || v === 'free' ? v : Number(v);
      this.target = null;
    });
    this.highlightBtn = el('button', undefined, '精華模式');
    this.highlightBtn.title = '沒有交戰時自動以 8 倍速快轉';
    this.highlightBtn.addEventListener('click', () => this.post({ type: 'highlight', on: !this.highlightBtn.classList.contains('active') }));
    this.skipFightBtn = el('button', undefined, '跳到下一次交戰');
    this.skipFightBtn.addEventListener('click', () => this.post({ type: 'skip', to: 'fight' }));
    this.skipEndBtn = el('button', undefined, '直接看結果');
    this.skipEndBtn.addEventListener('click', () => this.post({ type: 'skip', to: 'end' }));
    this.controls.append(this.modeSelect, this.highlightBtn, this.skipFightBtn, this.skipEndBtn);
    root.append(this.caption, this.graph, this.controls);
  }

  /** 使用者手動移動鏡頭時切回自由鏡頭 */
  userMovedCamera(): void {
    if (this.mode === 'auto' || typeof this.mode === 'number') {
      this.mode = 'free';
      this.modeSelect.value = 'free';
    }
  }

  onFrame(msg: FrameMsg): void {
    const f = msg.frame;
    this.frame = f;
    this.hotspots = msg.combat.hotspots;
    this.level = msg.combat.level;
    this.highlightBtn.classList.toggle('active', msg.highlight);
    this.skipFightBtn.classList.toggle('active', msg.skipping === 'fight');
    this.skipEndBtn.classList.toggle('active', msg.skipping === 'end');
    // 戰力曲線：倒退跳轉時截斷
    while (this.history.length > 0 && this.history[this.history.length - 1].tick > f.tick) this.history.pop();
    const last = this.history[this.history.length - 1];
    if (last === undefined || f.tick - last.tick >= GRAPH_SAMPLE_TICKS) this.history.push({ tick: f.tick, army: f.players.map((p) => p.army) });
    this.drawGraph();
    for (const { to, ev } of msg.events) this.captionFor(to, ev);
    // 交戰開始字幕：強度降到門檻的一半以下才重新計算，避免在門檻附近反覆觸發
    if (this.level >= FIGHT_LEVEL && !this.wasFighting && this.hotspots.length > 0) {
      const ps = this.hotspots[0].players;
      if (ps.length >= 2) this.pushCaption(`交戰！${ps.map((p) => this.name(p)).join(' vs ')}`, teamColor(ps[0]));
    }
    this.wasFighting = this.level >= FIGHT_LEVEL / 2 && (this.wasFighting || this.level >= FIGHT_LEVEL);
  }

  private captionFor(to: number, ev: GameEvent): void {
    if (ev.type === 'playerEliminated') this.pushCaption(`${this.name(ev.playerId)} 被淘汰！`, teamColor(ev.playerId));
    else if (ev.type === 'towerChanged') this.pushCaption(ev.owner === null ? '瞭望塔失守' : `${this.name(ev.owner)} 佔領瞭望塔`, ev.owner === null ? '#e5e7eb' : teamColor(ev.owner));
    else if (ev.type === 'enemyKilled' && ev.kind === 'building') {
      this.pushCaption(`${this.name(to)} 摧毀了 ${this.name(ev.owner)} 的${BUILDING_NAME[ev.entityType as keyof typeof BUILDING_NAME]}`, teamColor(to));
    }
  }

  private pushCaption(text: string, color: string): void {
    this.captions.push({ text, color });
    if (this.captions.length > 4) this.captions.shift();
  }

  /** 每個繪圖幀呼叫：字幕輪播與鏡頭導播 */
  update(now: number, dt: number): void {
    if (now >= this.captionUntil) {
      const next = this.captions.shift();
      if (next === undefined) this.caption.classList.add('hidden');
      else {
        this.caption.textContent = next.text;
        this.caption.style.borderColor = next.color;
        this.caption.classList.remove('hidden');
        this.captionUntil = now + 2800;
      }
    }
    const f = this.frame;
    if (f === null || this.mode === 'free') return;
    let want: { x: number; y: number; hits: number } | null = null;
    if (this.mode === 'auto') {
      const top = this.hotspots[0];
      const cur = this.target;
      if (top !== undefined && this.level > 0.1) {
        const near = cur !== null && Math.abs(top.x - cur.x) < 10 * TILE_SIZE && Math.abs(top.y - cur.y) < 10 * TILE_SIZE;
        if (cur === null || near || now - this.targetSince > MIN_DWELL_MS || top.hits >= cur.hits * SWITCH_FACTOR) {
          want = { x: top.x, y: top.y, hits: top.hits };
          if (!near) this.targetSince = now;
        } else {
          want = cur;
        }
      } else if (cur === null || now - this.targetSince > MIN_DWELL_MS * 1.5) {
        // 沒有交戰：看兵力最多的部隊
        const leader = [...f.players].filter((p) => p.alive).sort((a, b) => b.army - a.army)[0];
        if (leader !== undefined) {
          const c = this.armyCenter(f, leader.id);
          if (c !== null) {
            want = { ...c, hits: 0 };
            this.targetSince = now;
          }
        }
      } else {
        want = cur;
      }
    } else {
      const c = this.armyCenter(f, this.mode);
      if (c !== null) want = { ...c, hits: 0 };
    }
    if (want === null) return;
    this.target = want;
    const c = this.cam.center();
    const k = Math.min(1, dt * 2.2);
    this.cam.moveTo(c.x + (want.x - c.x) * k, c.y + (want.y - c.y) * k);
  }

  /** 選手戰鬥單位的中心；沒有戰鬥單位時用主堡 */
  private armyCenter(f: FrameView, pid: number): { x: number; y: number } | null {
    const army = f.units.filter((u) => u.owner === pid && u.type !== 'worker');
    if (army.length > 0) {
      return { x: army.reduce((a, u) => a + u.x, 0) / army.length, y: army.reduce((a, u) => a + u.y, 0) / army.length };
    }
    const base = f.buildings.find((b) => b.owner === pid && b.type === 'base' && !b.remembered);
    if (base !== undefined) return { x: (base.tileX + 1.5) * TILE_SIZE, y: (base.tileY + 1.5) * TILE_SIZE };
    const start = this.meta.map.players[pid];
    return start === undefined ? null : { x: (start.startTileX + 1.5) * TILE_SIZE, y: (start.startTileY + 1.5) * TILE_SIZE };
  }

  private drawGraph(): void {
    const g = this.graph.getContext('2d')!;
    const w = this.graph.width;
    const h = this.graph.height;
    g.fillStyle = 'rgba(17,21,27,0.9)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#94a3b8';
    g.font = '11px sans-serif';
    g.fillText('兵力', 6, 13);
    const hist = this.history;
    if (hist.length < 2) return;
    const maxTick = Math.max(hist[hist.length - 1].tick, 600);
    let maxArmy = 100;
    for (const p of hist) for (const a of p.army) maxArmy = Math.max(maxArmy, a);
    const n = hist[0].army.length;
    for (let pid = 0; pid < n; pid++) {
      g.strokeStyle = teamColor(pid);
      g.lineWidth = 1.5;
      g.beginPath();
      hist.forEach((p, i) => {
        const x = 4 + ((w - 8) * p.tick) / maxTick;
        const y = h - 4 - ((h - 22) * p.army[pid]) / maxArmy;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    }
  }
}
