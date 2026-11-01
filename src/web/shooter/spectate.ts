// 觀戰介面：滑鼠操作（點人跟隨、拖曳自由鏡頭、滾輪縮放、雙擊回跟隨）、兩隊選手列表、回合時間軸、按鍵表、跳回合提示。
// 試玩觀戰與經營層觀戰（#watch）共用同一套。資料來自 FullState（觀戰本來就有全狀態）與計分板。
// 面板是 DOM，30 Hz 更新，只有內容變了才寫（hud.ts 的 setHtml）。列表與時間軸的內容會一直換，所以吃 pointerdown 不吃 click：按下到放開之間子元素被換掉就不會有 click。
import type { GrenadeId, RoundEndReason, ShooterObservation, WeaponId } from '../../shooter/api.ts';
import { DRAG_PX, SpectateCamera, pickPlayer, type CamEnv, type CamMode, type CamView } from './camera.ts';
import { REASON, setHtml, type RoundMark, type ShooterHud } from './hud.ts';
import type { BoardRow, FullPlayer, FullState, ShooterFrame, ShooterMeta } from './protocol.ts';
import { GRENADE_TAG, interp } from './render.ts';

const UNIT = 1000;
/** 面板更新間隔（毫秒） */
const PANEL_MS = 33;
/** 跟隨的預設縮放（1 = 短邊的一半 24 格） */
const ZOOM_SPECTATE = 1;
/** 滾輪每 100 單位的縮放量 */
const WHEEL_RATE = 0.0016;
/** 全圖要留給面板的邊（介面單位，1080p 的 px）：左右兩隊列表、上比分、下控制列 */
const PAD_X = 380;
const PAD_Y = 128;
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 回合結束原因的圖示（16×16，currentColor） */
const REASON_ICON: Readonly<Record<RoundEndReason, string>> = {
  elimination: '<circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4" stroke="currentColor" stroke-width="1.8"/>',
  bomb: '<circle cx="7" cy="9.5" r="5" fill="currentColor"/><path d="M10 5.5 12.5 3" stroke="currentColor" stroke-width="1.8"/><path d="M13 1.2v1.6M14.8 3h-1.6" stroke="currentColor" stroke-width="1.2"/>',
  defuse: '<path d="M3 3l10 10M13 3 3 13" stroke="currentColor" stroke-width="2"/><circle cx="3.4" cy="12.6" r="2" fill="currentColor"/><circle cx="12.6" cy="12.6" r="2" fill="currentColor"/>',
  timeout: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.4V8l2.6 1.8" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};

const reasonIcon = (r: RoundEndReason): string => `<svg viewBox="0 0 16 16" aria-hidden="true">${REASON_ICON[r]}</svg>`;

const HELP: readonly { readonly title: string; readonly rows: readonly (readonly [string, string])[] }[] = [
  {
    title: '滑鼠',
    rows: [
      ['左鍵點人、小地圖、選手列', '跟隨他'],
      ['拖曳畫面', '自由鏡頭'],
      ['滾輪', '以游標為中心縮放'],
      ['雙擊空地', '回到跟隨'],
      ['點小地圖空地', '自由鏡頭移到那裡'],
      ['點回合時間軸', '跳到那一回合開始'],
    ],
  },
  {
    title: '鍵盤',
    rows: [
      ['空白', '暫停／播放'],
      ['[　]', '調速度'],
      ['P　N', '上一回合／下一回合'],
      ['←　→', '換跟隨的人'],
      ['M', '全圖鏡頭'],
      ['X', '全圖透視'],
      ['T', '戰術疊層'],
      ['-　=', '縮放'],
      ['Tab', '按住看計分板'],
      ['F', '全螢幕'],
      ['?　H', '這張按鍵表'],
    ],
  },
];

export interface SpectateHost {
  /** 改跟隨對象（Worker 換 viewId） */
  view(id: number): void;
  seek(round: number): void;
  /** 目前的鏡頭、最新畫面 */
  frame(): ShooterFrame | null;
}

export class SpectateUi {
  readonly cam: SpectateCamera;
  /** 滑鼠指著的選手 */
  hover: number | null = null;
  private readonly meta: ShooterMeta;
  private readonly hud: ShooterHud;
  private readonly host: SpectateHost;
  private readonly canvas: HTMLCanvasElement;
  private readonly mini: HTMLCanvasElement;
  private readonly rosters: readonly [HTMLElement, HTMLElement];
  private readonly rows = new Map<number, HTMLElement>();
  private readonly heads: [HTMLElement, HTMLElement];
  private readonly timeline: HTMLElement;
  private readonly cells: HTMLElement;
  private readonly tlHead: HTMLElement;
  private readonly tlBar: HTMLElement;
  private readonly help: HTMLElement;
  private readonly seekBox: HTMLElement;
  /** 看過的回合結果：跳回去之後時間軸還留著後面的回合 */
  private readonly known = new Map<number, RoundMark>();
  private lastT = 0;
  private lastPanel = 0;
  private cellKey = '';
  /** 按下的位置；drag 表示已經超過拖曳門檻 */
  private press: { x: number; y: number; lastX: number; lastY: number; drag: boolean } | null = null;
  /** 滑鼠在畫布上的位置（畫面座標）；不在畫布上為 null */
  private pointer: { x: number; y: number } | null = null;
  private seekTarget: number | null = null;

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, mini: HTMLCanvasElement, meta: ShooterMeta, hud: ShooterHud, host: SpectateHost) {
    this.meta = meta;
    this.hud = hud;
    this.host = host;
    this.canvas = canvas;
    this.mini = mini;
    this.cam = new SpectateCamera(this.env(), ZOOM_SPECTATE);
    const div = (cls: string, parent: HTMLElement): HTMLElement => {
      const e = document.createElement('div');
      e.className = cls;
      parent.appendChild(e);
      return e;
    };
    const left: 0 | 1 = hud.leftGroup;
    const groups: readonly [0 | 1, 0 | 1] = [left, left === 0 ? 1 : 0];
    this.rosters = [div('sg-roster l', root), div('sg-roster r', root)];
    this.heads = [div('hd', this.rosters[0]), div('hd', this.rosters[1])];
    groups.forEach((g, side) => {
      for (const id of meta.names.keys()) {
        if (meta.groups[id] !== g) continue;
        const row = div('ro', this.rosters[side]);
        row.dataset.pid = String(id);
        row.style.setProperty('--c', hud.groupColor(g));
        this.rows.set(id, row);
      }
    });
    this.timeline = div('sg-timeline', root);
    this.tlHead = div('th', this.timeline);
    this.tlBar = div('tb', this.timeline);
    this.tlBar.appendChild(document.createElement('i'));
    this.cells = div('tc', this.timeline);
    this.help = div('sg-help hidden', root);
    this.help.innerHTML =
      `<div class="box"><small class="en">CONTROLS</small><b>觀戰操作</b><div class="cols">` +
      HELP.map((h) => `<section><h4>${h.title}</h4>${h.rows.map(([k, v]) => `<div class="kr"><span class="k">${k}</span><span>${v}</span></div>`).join('')}</section>`).join('') +
      `</div><button type="button" class="primary" data-act="close">知道了</button></div>`;
    this.seekBox = div('sg-seek hidden', root);
    this.bind();
  }

  /** 鏡頭環境：畫面大小與全圖留給面板的邊 */
  private env(): CamEnv {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const u = Math.min(w / 1920, h / 1080);
    return { w, h, padX: PAD_X * u, padY: PAD_Y * u, mapW: this.meta.map.width, mapH: this.meta.map.height };
  }

  private full(): FullState | null {
    return this.host.frame()?.full ?? null;
  }

  private canvasPos(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private worldAt(p: { x: number; y: number }): [number, number] {
    const e = this.env();
    const c = this.cam;
    return [(p.x - e.w / 2) / c.scale + c.cx, (p.y - e.h / 2) / c.scale + c.cy];
  }

  private pick(p: { x: number; y: number }): number | null {
    const full = this.full();
    if (full === null) return null;
    const [wx, wy] = this.worldAt(p);
    return pickPlayer(full.players, wx, wy, this.cam.scale);
  }

  /** 跟隨這個人（從任何鏡頭模式回來，平移過去） */
  follow(id: number): void {
    this.cam.follow();
    this.host.view(id);
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const p = this.canvasPos(e);
      this.press = { x: p.x, y: p.y, lastX: p.x, lastY: p.y, drag: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.canvasPos(e);
      this.pointer = p;
      const pr = this.press;
      if (pr === null) {
        this.hover = this.pick(p);
        return;
      }
      if (!pr.drag && Math.hypot(p.x - pr.x, p.y - pr.y) < DRAG_PX) return;
      if (!pr.drag) {
        pr.drag = true;
        this.hover = null;
      }
      this.cam.pan(p.x - pr.lastX, p.y - pr.lastY);
      pr.lastX = p.x;
      pr.lastY = p.y;
    });
    const up = (e: PointerEvent): void => {
      const pr = this.press;
      this.press = null;
      if (pr === null || pr.drag || e.button !== 0) return;
      const id = this.pick(this.canvasPos(e));
      if (id !== null) this.follow(id);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => (this.press = null));
    c.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.hover = null;
    });
    c.addEventListener('dblclick', (e) => {
      if (this.pick(this.canvasPos(e)) === null) this.cam.follow();
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.canvasPos(e);
      const step = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      this.cam.zoomAt(Math.exp(-step * WHEEL_RATE), p.x, p.y);
    }, { passive: false });
    this.mini.addEventListener('pointerdown', (e) => {
      const r = this.mini.getBoundingClientRect();
      const k = r.width / (this.meta.map.width * UNIT);
      const wx = (e.clientX - r.left) / k;
      const wy = (e.clientY - r.top) / k;
      const full = this.full();
      const id = full === null ? null : pickPlayer(full.players, wx, wy, k, 9);
      if (id !== null) this.follow(id);
      else this.cam.jumpTo(wx, wy);
    });
    for (const r of this.rosters) {
      r.addEventListener('pointerdown', (e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('.ro')?.dataset.pid;
        if (id !== undefined) this.follow(Number(id));
      });
    }
    this.cells.addEventListener('pointerdown', (e) => {
      const n = (e.target as HTMLElement).closest<HTMLElement>('[data-round]')?.dataset.round;
      if (n !== undefined) this.host.seek(Number(n));
    });
    this.help.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.box') === null || (e.target as HTMLElement).closest('button') !== null) this.setHelp(false);
    });
  }

  get mode(): CamMode {
    return this.cam.mode;
  }

  /** 畫面按鈕的縮放與 -、= 鍵：以畫面中心縮放 */
  zoomStep(step: number): void {
    const e = this.env();
    this.cam.zoomAt(1.2 ** step, e.w / 2, e.h / 2);
  }

  /** 戰術疊層的距離環：全圖與自由鏡頭時跟著滑鼠 */
  rings(): { x: number; y: number } | null {
    if (this.cam.mode === 'follow' || this.pointer === null) return null;
    const [x, y] = this.worldAt(this.pointer);
    return { x, y };
  }

  helpOpen(): boolean {
    return !this.help.classList.contains('hidden');
  }

  setHelp(open: boolean): void {
    this.help.classList.toggle('hidden', !open);
  }

  /** 跳回合等待中：Worker 重跑時顯示進度 */
  seeking(at: number, target: number): void {
    this.seekTarget = target;
    this.seekBox.innerHTML = `<b>重跑到第 ${target} 回合</b><span>目前第 ${at} 回合・同設定同種子重跑，結果完全相同</span>`;
    this.seekBox.classList.remove('hidden');
  }

  /** 跳回合已經送出去了嗎（等 Worker 回 frame 之前不再送） */
  get busy(): boolean {
    return this.seekTarget !== null;
  }

  seekDone(): void {
    this.seekTarget = null;
    this.seekBox.classList.add('hidden');
  }

  /** 每幀：推進鏡頭；面板 30 Hz */
  update(f: ShooterFrame, prev: ShooterFrame | null, alpha: number, t: number, speed: number): CamView {
    this.cam.setEnv(this.env());
    const dt = this.lastT === 0 ? 0 : Math.min(100, t - this.lastT);
    this.lastT = t;
    const me = f.full?.players.find((p) => p.id === f.viewId);
    const view = this.cam.update(dt, me !== undefined ? interp(me, prev?.full?.players, alpha) : null, speed);
    this.canvas.classList.toggle('drag', this.press?.drag === true);
    this.canvas.classList.toggle('pick', this.hover !== null);
    if (t - this.lastPanel >= PANEL_MS) {
      this.lastPanel = t;
      this.panels(f);
    }
    return view;
  }

  private panels(f: ShooterFrame): void {
    const full = f.full;
    if (full === null) return;
    for (const r of this.hud.rounds) this.known.set(r.number, r);
    this.hud.leftRight(f.board).forEach((team, side) => {
      const list = full.players.filter((p) => p.team === team);
      const money = list.reduce((a, p) => a + (p.money ?? 0), 0);
      setHtml(this.heads[side], `<b style="color:${this.hud.groupColor(this.hud.groupOf(team, f.board))}">${this.hud.groupLabel(this.hud.groupOf(team, f.board))}</b><small>${team}</small><span>存活 ${list.filter((p) => p.alive).length}</span><span class="mo">$${money}</span>`);
    });
    for (const p of full.players) {
      const row = this.rows.get(p.id) as HTMLElement;
      const b = f.board[p.id];
      row.classList.toggle('dead', !p.alive);
      row.classList.toggle('sel', p.id === f.viewId);
      setHtml(row, this.rowHtml(p, b));
    }
    this.renderTimeline(f.view);
  }

  private weaponName(id: WeaponId): string {
    return id === 'knife' ? '刀' : (this.meta.weapons.find((w) => w.id === id)?.name ?? id);
  }

  private rowHtml(p: FullPlayer, b: BoardRow): string {
    const name = this.meta.names[p.id] ?? `#${p.id}`;
    const tag = this.meta.watch?.tags[p.id];
    const head = `<div class="l1"><b class="hp">${p.alive ? p.hp : '—'}</b><span class="nm">${esc(name)}${tag !== undefined ? `<small>${esc(tag)}</small>` : ''}</span><span class="kd">${b.kills}／${b.deaths}</span><span class="mo">$${p.money ?? b.money ?? 0}</span></div>`;
    if (!p.alive) return `<i class="hpf" style="width:0"></i>${head}<div class="l2"><span class="wn">陣亡</span></div>`;
    const counts = new Map<GrenadeId, number>();
    for (const g of p.grenades ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
    const nades = [...counts].map(([g, n]) => `<em>${GRENADE_TAG[g]}${n > 1 ? n : ''}</em>`).join('');
    const ammo = p.weapon === 'knife' ? '' : p.reloading === true ? '換彈' : `${p.ammoMag ?? 0}／${p.ammoReserve ?? 0}`;
    const armor = (p.armor ?? 0) > 0 ? `<span class="ar">甲 ${p.armor}</span>` : '<span class="ar none">無甲</span>';
    const chips = `${p.kit === true ? '<em class="eq">拆</em>' : ''}${p.hasBomb ? '<em class="eq">包</em>' : ''}`;
    // 下包、拆包：整列下緣一條進度
    const rules = this.meta.rules;
    const plant = p.plantTicks ?? 0;
    const defuse = p.defuseTicks ?? 0;
    const need = p.kit === true ? rules.defuseKitTicks : rules.defuseTicks;
    const work = plant > 0 ? ['下包中', plant / rules.plantTicks] : defuse > 0 ? ['拆包中', defuse / need] : null;
    const tail = work !== null ? `<span class="st">${work[0]}</span>` : `${chips}${armor}`;
    const prog = work !== null ? `<i class="pg" style="width:${Math.min(100, Math.round(Number(work[1]) * 100))}%"></i>` : '';
    return `<i class="hpf${p.hp <= 30 ? ' low' : ''}" style="width:${Math.max(0, p.hp)}%"></i>${head}<div class="l2"><span class="wn">${this.weaponName(p.weapon)}</span><span class="am">${ammo}</span>${nades}<span class="sp"></span>${tail}</div>${prog}`;
  }

  /** 回合時間軸：已打完的格子是勝方顏色加結束原因；目前回合高亮；還沒看過的空格也能點（往後快轉） */
  private renderTimeline(view: ShooterObservation): void {
    const r = view.round;
    const rules = this.meta.rules;
    const reg = rules.roundsPerHalf * 2;
    const total = Math.max(reg, r.number, ...this.known.keys());
    const key = `${r.number}|${r.phase === 'over'}|${[...this.known.keys()].join()}|${total}`;
    if (key !== this.cellKey) {
      this.cellKey = key;
      let html = '';
      for (let n = 1; n <= total; n++) {
        const m = this.known.get(n);
        const cls = `${n === r.number ? ' cur' : ''}${m !== undefined ? ' won' : ''}${n > r.number ? ' later' : ''}`;
        if (n === rules.roundsPerHalf + 1 || (n > reg && (n - reg - 1) % (rules.overtime === false ? 1 : rules.overtime.roundsPerHalf) === 0)) html += '<span class="gap"></span>';
        const g = m?.winnerGroup ?? (m?.winner === 'T' ? 0 : 1);
        const style = m !== undefined ? ` style="--c:${this.hud.groupColor(g)}"` : '';
        const title = m !== undefined ? `第 ${n} 回合：${this.hud.groupLabel(g)}勝・${REASON[m.reason]}` : `第 ${n} 回合`;
        html += `<button type="button" class="tr${cls}" data-round="${n}" title="${title}"${style}><small>${n}</small>${m !== undefined ? reasonIcon(m.reason) : ''}</button>`;
      }
      this.cells.innerHTML = html;
    }
    const of = r.number > reg ? `第 ${r.number} 回合・加時` : `第 ${r.number}／${reg} 回合`;
    setHtml(this.tlHead, `<span>${of}</span><span class="pt">點回合跳過去</span>`);
    const done = r.phase === 'freeze' ? 0 : r.phase === 'live' ? 1 - r.phaseTicksLeft / rules.roundTicks : 1;
    (this.tlBar.firstElementChild as HTMLElement).style.width = `${Math.round(done * 100)}%`;
  }
}
