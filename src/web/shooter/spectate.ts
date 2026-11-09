// 觀戰介面：滑鼠操作（點人跟隨、拖曳自由鏡頭、滾輪縮放、雙擊回跟隨）、兩隊選手列表、按鍵表、跳回合提示。
// 試玩觀戰與經營層觀戰（#watch）共用同一套。資料來自 FullState（觀戰本來就有全狀態）與計分板。
// 教練模式（M5 6.5、UI 審核 #6）也用這一套：沒有全狀態，選手資料由 host.players() 給（己方＝觀察資料聯集、對手＝計分板公開欄位），只能跟隨己方。
// 面板是 DOM，30 Hz 更新，只有內容變了才寫（hud.ts 的 setHtml）。列表的內容會一直換，所以吃 pointerdown 不吃 click：按下到放開之間子元素被換掉就不會有 click。
import type { GrenadeId, WeaponId } from '../../shooter/api.ts';
import { DRAG_PX, SpectateCamera, pickPlayer, type CamEnv, type CamMode, type CamView } from './camera.ts';
import { setHtml, type ShooterHud } from './hud.ts';
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
const PAD_X = 280;
const PAD_Y = 78;
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const HELP: readonly { readonly title: string; readonly rows: readonly (readonly [string, string])[] }[] = [
  {
    title: '滑鼠',
    rows: [
      ['左鍵點人、小地圖、選手列', '跟隨他'],
      ['拖曳畫面', '自由鏡頭'],
      ['滾輪', '以游標為中心縮放'],
      ['雙擊空地', '回到跟隨'],
      ['點小地圖空地', '自由鏡頭移到那裡'],
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
      ['X', '透視'],
      ['-　=', '縮放'],
      ['Tab', '按住看計分板'],
      ['F11　Esc', '進入／離開全螢幕'],
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
  /** 沒有全狀態時（教練模式）的選手列表：己方有血量、金錢、武器，對手只有存活與擊殺／死亡 */
  players?(): readonly FullPlayer[] | null;
  /** 只能跟隨這一組（教練模式＝己方） */
  followOnly?: 0 | 1;
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
  private readonly bodies = new Map<number, HTMLElement>();
  /** 上次畫列表時當 T 的組 */
  private sides: 0 | 1 = 0;
  private readonly heads: [HTMLElement, HTMLElement];
  private readonly help: HTMLElement;
  private readonly seekBox: HTMLElement;
  private lastT = 0;
  private lastPanel = 0;
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
        // 頭像只在換邊時換，內容只換右邊那塊
        row.innerHTML = '<svg></svg>';
        this.rows.set(id, row);
        this.bodies.set(id, div('bd', row));
      }
    });
    this.help = div('sg-help hidden', root);
    this.help.innerHTML =
      `<div class="box"><small class="en">CONTROLS</small><b>觀戰操作</b><div class="cols">` +
      HELP.map((h) => `<section><h4>${h.title}</h4>${h.rows.map(([k, v]) => `<div class="kr"><span class="k">${k}</span><span>${v}</span></div>`).join('')}</section>`).join('') +
      `</div><button type="button" class="primary" data-act="close">知道了</button></div>`;
    this.seekBox = div('sg-seek hidden', root);
    this.paintRows();
    this.bind();
  }

  /** 開局與換邊：列表的隊色與球衣 */
  private paintRows(): void {
    this.sides = this.hud.sides;
    for (const [id, row] of this.rows) {
      row.style.setProperty('--c', this.hud.groupColor(this.meta.groups[id]));
      (row.firstElementChild as Element).outerHTML = this.hud.face(id);
    }
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

  /** 畫面上的選手：全狀態有就用全狀態，沒有（教練模式）就用 host 給的 */
  private players(): readonly FullPlayer[] | null {
    return this.full()?.players ?? this.host.players?.() ?? null;
  }

  /** 這個人能不能被跟隨（教練模式只能跟己方） */
  private canFollow(id: number): boolean {
    return this.host.followOnly === undefined || this.meta.groups[id] === this.host.followOnly;
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
    const list = this.players();
    if (list === null) return null;
    const [wx, wy] = this.worldAt(p);
    const id = pickPlayer(list, wx, wy, this.cam.scale);
    return id !== null && this.canFollow(id) ? id : null;
  }

  /** 跟隨這個人（從任何鏡頭模式回來，平移過去） */
  follow(id: number): void {
    if (!this.canFollow(id)) return;
    this.cam.follow();
    this.host.view(id);
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.hud.closeMenu();
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
      const list = this.players();
      const id = list === null ? null : pickPlayer(list, wx, wy, k, 9);
      if (id !== null && this.canFollow(id)) this.follow(id);
      else this.cam.jumpTo(wx, wy);
    });
    for (const r of this.rosters) {
      r.addEventListener('pointerdown', (e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('.ro')?.dataset.pid;
        if (id !== undefined) this.follow(Number(id));
      });
    }
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
    const me = this.players()?.find((p) => p.id === f.viewId);
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
    const players = this.players();
    if (players === null) return;
    if (this.sides !== this.hud.sides) this.paintRows();
    this.hud.leftRight(f.board).forEach((team, side) => {
      const list = players.filter((p) => p.team === team);
      // 金錢只有看得到的才加總（教練模式對手的是 null，不顯示）
      const known = list.every((p) => p.money !== undefined);
      const money = list.reduce((a, p) => a + (p.money ?? 0), 0);
      setHtml(this.heads[side], `<b style="color:${this.hud.groupColor(this.hud.groupOf(team, f.board))}">${this.hud.groupLabel(this.hud.groupOf(team, f.board))}</b><small>${team}</small><span>存活 ${list.filter((p) => p.alive).length}</span><span class="mo">${known ? `$${money}` : ''}</span>`);
    });
    for (const p of players) {
      const row = this.rows.get(p.id) as HTMLElement;
      const b = f.board[p.id];
      row.classList.toggle('dead', !p.alive);
      row.classList.toggle('sel', p.id === f.viewId);
      setHtml(this.bodies.get(p.id) as HTMLElement, this.rowHtml(p, b));
    }
  }

  private weaponName(id: WeaponId): string {
    return id === 'knife' ? '刀' : (this.meta.weapons.find((w) => w.id === id)?.name ?? id);
  }

  private rowHtml(p: FullPlayer, b: BoardRow): string {
    const name = this.meta.names[p.id] ?? `#${p.id}`;
    const tag = this.meta.watch?.tags[p.id];
    // 教練模式的對手列：只有計分板的公開欄位（存活、擊殺、死亡），沒有血量、金錢、武器
    if (this.host.followOnly !== undefined && this.meta.groups[p.id] !== this.host.followOnly) {
      return `<i class="hpf" style="width:0"></i><div class="l1"><b class="hp">${p.alive ? '●' : '—'}</b><span class="nm">${esc(name)}${tag !== undefined ? `<small>${esc(tag)}</small>` : ''}</span><span class="kd">${b.kills}／${b.deaths}</span></div><div class="l2"><span class="wn">${p.alive ? '存活' : '陣亡'}</span></div>`;
    }
    const head = `<div class="l1"><b class="hp">${p.alive ? p.hp : '—'}</b><span class="nm">${esc(name)}${tag !== undefined ? `<small>${esc(tag)}</small>` : ''}</span><span class="kd">${b.kills}／${b.deaths}</span><span class="mo">$${p.money ?? b.money ?? 0}</span></div>`;
    if (!p.alive) return `<i class="hpf" style="width:0"></i>${head}<div class="l2"><span class="wn">陣亡</span></div>`;
    const counts = new Map<GrenadeId, number>();
    for (const g of p.grenades ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
    const nades = [...counts].map(([g, n]) => `<em>${GRENADE_TAG[g]}${n > 1 ? n : ''}</em>`).join('');
    // 不知道的欄位不顯示（教練模式只有所看那位隊友有彈藥與護甲）
    const ammo = p.weapon === 'knife' || p.ammoMag === undefined ? '' : p.reloading === true ? '換彈' : `${p.ammoMag}／${p.ammoReserve ?? 0}`;
    const armor = p.armor === undefined ? '' : p.armor > 0 ? `<span class="ar">甲 ${p.armor}</span>` : '<span class="ar none">無甲</span>';
    const chips = `${p.kit === true ? '<em class="eq">拆</em>' : ''}${p.hasBomb ? '<em class="eq">包</em>' : ''}`;
    // 下包、拆包：整列下緣一條進度
    const rules = this.meta.rules;
    const plant = p.plantTicks ?? 0;
    const defuse = p.defuseTicks ?? 0;
    const need = p.kit === true ? rules.defuseKitTicks : rules.defuseTicks;
    // 教練模式只知道隊友「在下包／拆包」（沒有進度），進度條畫滿
    const work = plant > 0 ? ['下包中', plant === Infinity ? 1 : plant / rules.plantTicks] : defuse > 0 ? ['拆包中', defuse === Infinity ? 1 : defuse / need] : null;
    const tail = work !== null ? `<span class="st">${work[0]}</span>` : `${chips}${armor}`;
    const prog = work !== null ? `<i class="pg" style="width:${Math.min(100, Math.round(Number(work[1]) * 100))}%"></i>` : '';
    return `<i class="hpf${p.hp <= 30 ? ' low' : ''}" style="width:${Math.max(0, p.hp)}%"></i>${head}<div class="l2"><span class="wn">${this.weaponName(p.weapon)}</span><span class="am">${ammo}</span>${nades}<span class="sp"></span>${tail}</div>${prog}`;
  }
}
