// CS 射擊可玩版的操控：鍵盤滑鼠 → 選手指令（與 Bot 同一套 ShooterCommand，經 Worker 的人類控制器每 tick 套用）。
// 轉身上限、散佈、冷卻都由引擎照規則處理，這裡只把輸入翻成指令。
import type { GrenadeId, ShooterCommand, ShooterObservation, WeaponSlot } from '../../shooter/api.ts';
import { toWorld, type Camera, type ThrowPreview } from './render.ts';
import type { ShooterMeta } from './protocol.ts';

/** 蓄力：按住 0～1 秒線性對應力道 0～100 */
const CHARGE_MS = 1000;
/** 瞄準點最多每幾毫秒送一次（約每個 tick 一次） */
const AIM_MS = 30;
const SLOT_ORDER: readonly WeaponSlot[] = ['primary', 'secondary', 'knife'];
const MOVE_KEYS: Readonly<Record<string, [number, number]>> = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };

export interface InputHost {
  readonly meta: ShooterMeta;
  /** 玩家自己的最新觀察資料 */
  self(): ShooterObservation | null;
  camera(): Camera;
  send(cmds: ShooterCommand[]): void;
  /** 本機投擲冷卻是否還在 */
  throwCooling(): boolean;
  buyOpen(): boolean;
  /** 購買選單的快捷鍵；回傳 true 表示已處理 */
  buyKey(code: string): boolean;
  toggleBuy(): void;
  closeBuy(): boolean;
  setBoard(show: boolean): void;
  togglePause(): void;
  cycleView(step: number): void;
  zoom(step: number): void;
  /** 觀戰模式：全圖透視、播放速度 */
  toggleXray(): void;
  speed(step: number): void;
  /** 觀戰模式：跳到下一回合 */
  skipRound(): void;
  toggleFullscreen(): void;
}

/** 全螢幕且鎖住鍵盤時，Ctrl＋W 之類的組合鍵會交給網頁（不會關分頁） */
const keysLocked = (): boolean => document.fullscreenElement !== null;

export class ShooterInput {
  readonly mouse = { x: 0, y: 0 };
  /** 選中的道具（4 輪流切換）；null = 手上的槍 */
  grenade: GrenadeId | null = null;
  /** 選中炸彈（5）：左鍵等同 E 下包（引擎沒有「手持炸彈」，只是畫面狀態） */
  bomb = false;
  private chargeStart: number | null = null;
  private readonly held = new Set<string>();
  private moving = false;
  private lastAim = 0;
  private lastAimX = NaN;
  private lastAimY = NaN;
  private fireHeld = false;
  private scopeHeld = false;
  private readonly host: InputHost;
  private readonly el: HTMLElement;
  private readonly off: (() => void)[] = [];

  constructor(el: HTMLElement, host: InputHost) {
    this.el = el;
    this.host = host;
    this.mouse.x = el.clientWidth / 2;
    this.mouse.y = el.clientHeight / 2;
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, 'keydown', (e) => this.keyDown(e));
    on(window, 'keyup', (e) => this.keyUp(e));
    on(window, 'blur', () => this.releaseAll());
    on(el, 'mousemove', (e) => {
      const r = el.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    });
    on(el, 'mousedown', (e) => this.mouseDown(e));
    on(window, 'mouseup', (e) => this.mouseUp(e));
    on(el, 'contextmenu', (e) => e.preventDefault());
    // 滑鼠側鍵（上一頁／下一頁）：遊戲中攔下，不要離開頁面
    const noNav = (e: MouseEvent): void => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    on(window, 'mousedown', noNav);
    on(window, 'auxclick', noNav);
    on(el, 'wheel', (e) => this.wheel(e), { passive: false });
  }

  dispose(): void {
    for (const f of this.off) f();
  }

  private alive(): ShooterObservation | null {
    const s = this.host.self();
    return s !== null && s.me.alive && !this.host.meta.spectate ? s : null;
  }

  /** 目前的蓄力（畫面畫預估落點用） */
  charge(now: number): ThrowPreview | null {
    if (this.grenade === null || this.chargeStart === null) return null;
    return { grenade: this.grenade, power: Math.min(100, ((now - this.chargeStart) / CHARGE_MS) * 100) };
  }

  /** 每個畫面更新：送瞄準點、選中的道具用完了就切回槍 */
  update(now: number): void {
    const s = this.alive();
    if (s === null) {
      this.grenade = null;
      this.bomb = false;
      this.chargeStart = null;
      return;
    }
    if (this.grenade !== null && !s.me.loadout.grenades.includes(this.grenade)) {
      this.grenade = null;
      this.chargeStart = null;
    }
    if (this.bomb && !s.me.hasBomb) this.bomb = false;
    if (now - this.lastAim < AIM_MS) return;
    const [wx, wy] = toWorld(this.host.camera(), this.mouse.x, this.mouse.y);
    const x = Math.round(wx);
    const y = Math.round(wy);
    if (Math.abs(x - this.lastAimX) < 5 && Math.abs(y - this.lastAimY) < 5) return;
    this.lastAim = now;
    this.lastAimX = x;
    this.lastAimY = y;
    this.host.send([{ type: 'aim', x, y }]);
  }

  /** WASD 以畫面方向移動：0° = 東、90° = 南（畫面下） */
  private sendMove(): void {
    if (this.alive() === null) return;
    let dx = 0;
    let dy = 0;
    for (const k of this.held) {
      const v = MOVE_KEYS[k];
      if (v !== undefined) {
        dx += v[0];
        dy += v[1];
      }
    }
    if (dx === 0 && dy === 0) {
      if (this.moving) this.host.send([{ type: 'stop' }]);
      this.moving = false;
      return;
    }
    this.moving = true;
    this.host.send([{ type: 'moveDir', deg: Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 }]);
  }

  private keyDown(e: KeyboardEvent): void {
    const code = e.code;
    // 遊戲中攔下瀏覽器快捷鍵（Ctrl＋S／D／F／R、F1／F3／F5／F7、Alt 選單、Backspace…），讓 Ctrl 蹲著也能按 A／S／D。
    // Ctrl＋W／T／N 只有全螢幕鎖鍵盤時攔得住（瀏覽器限制）；F11、F12 保留
    if (code !== 'F11' && code !== 'F12') e.preventDefault();
    if (code === 'Tab') {
      this.host.setBoard(true);
      return;
    }
    if (e.ctrlKey && code === 'KeyW' && !keysLocked()) return;
    if (this.host.buyOpen() && !e.repeat && this.host.buyKey(code)) {
      e.preventDefault();
      return;
    }
    if (MOVE_KEYS[code] !== undefined) {
      e.preventDefault();
      if (!this.held.has(code)) {
        this.held.add(code);
        this.sendMove();
      }
      return;
    }
    if (e.repeat) return;
    const s = this.alive();
    switch (code) {
      case 'Escape':
        if (!this.host.closeBuy()) this.host.togglePause();
        return;
      case 'KeyB':
        this.host.toggleBuy();
        return;
      case 'Equal':
      case 'NumpadAdd':
        this.host.zoom(1);
        return;
      case 'Minus':
      case 'NumpadSubtract':
        this.host.zoom(-1);
        return;
      case 'ArrowLeft':
        this.host.cycleView(-1);
        return;
      case 'ArrowRight':
        this.host.cycleView(1);
        return;
      case 'KeyX':
        this.host.toggleXray();
        return;
      case 'Space':
        if (this.host.meta.spectate) {
          e.preventDefault();
          this.host.togglePause();
        }
        return;
      case 'BracketLeft':
        this.host.speed(-1);
        return;
      case 'BracketRight':
        this.host.speed(1);
        return;
      case 'KeyN':
        if (this.host.meta.spectate) this.host.skipRound();
        return;
      case 'KeyF':
        this.host.toggleFullscreen();
        return;
    }
    if (s === null) return;
    switch (code) {
      case 'KeyR':
        this.host.send([{ type: 'reload' }]);
        return;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
        this.grenade = null;
        this.bomb = false;
        this.chargeStart = null;
        this.host.send([{ type: 'switch', slot: SLOT_ORDER[Number(code.slice(5)) - 1] }]);
        return;
      case 'Digit4': {
        // 道具：每按一次換下一種（身上有的種類，依購買順序），換完一輪回到槍
        const kinds = [...new Set(s.me.loadout.grenades)];
        if (kinds.length === 0) return;
        const i = this.grenade === null ? -1 : kinds.indexOf(this.grenade);
        this.grenade = i + 1 < kinds.length ? kinds[i + 1] : null;
        this.bomb = false;
        this.chargeStart = null;
        if (this.fireHeld) this.stopFire();
        return;
      }
      case 'Digit5':
        if (!s.me.hasBomb) return;
        this.bomb = !this.bomb;
        this.grenade = null;
        this.chargeStart = null;
        if (this.fireHeld) this.stopFire();
        return;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.host.send([{ type: 'walk', on: true }]);
        return;
      case 'ControlLeft':
      case 'ControlRight':
      case 'KeyC':
        this.host.send([{ type: 'crouch', on: true }]);
        return;
      case 'KeyE':
        this.interact(s);
        return;
      case 'KeyG':
        this.host.send([{ type: 'drop' }]);
        return;
    }
  }

  private keyUp(e: KeyboardEvent): void {
    const code = e.code;
    // 放開 Alt 會打開瀏覽器選單，一併攔下
    if (code !== 'F11' && code !== 'F12') e.preventDefault();
    if (code === 'Tab') {
      this.host.setBoard(false);
      return;
    }
    if (MOVE_KEYS[code] !== undefined) {
      this.held.delete(code);
      this.sendMove();
      return;
    }
    const s = this.alive();
    if (s === null) return;
    switch (code) {
      case 'ShiftLeft':
      case 'ShiftRight':
        this.host.send([{ type: 'walk', on: false }]);
        return;
      case 'ControlLeft':
      case 'ControlRight':
      case 'KeyC':
        this.host.send([{ type: 'crouch', on: false }]);
        return;
      case 'KeyE':
        this.cancelAction(s);
        return;
    }
  }

  /** 放開 E（或選中炸彈時放開左鍵）：中斷下包／拆包（引擎的中斷方式是移動指令；沒按方向鍵就再送停止） */
  private cancelAction(s: ShooterObservation): void {
    if (s.me.plantTicks > 0 || s.me.defuseTicks > 0) {
      this.host.send([{ type: 'moveDir', deg: s.me.facing }, { type: 'stop' }]);
      this.moving = false;
      this.sendMove();
    }
  }

  /** E：在炸彈點持彈 → 下包；貼近已下的炸彈（CT）→ 拆包；否則撿起腳邊的東西 */
  private interact(s: ShooterObservation): void {
    const me = s.me;
    const cx = Math.floor(me.x / 1000);
    const cy = Math.floor(me.y / 1000);
    const onSite = this.host.meta.map.sites.some((z) => cx >= z.x0 && cx < z.x1 && cy >= z.y0 && cy < z.y1);
    if (me.hasBomb && onSite && s.round.phase === 'live') {
      this.host.send([{ type: 'plant' }]);
      return;
    }
    const b = s.bomb;
    if (me.team === 'CT' && (b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null && Math.hypot(b.x - me.x, b.y - me.y) <= 1500) {
      this.host.send([{ type: 'defuse' }]);
      return;
    }
    this.host.send([{ type: 'pickup' }]);
  }

  private mouseDown(e: MouseEvent): void {
    if (this.host.meta.spectate) return;
    const s = this.alive();
    if (s === null) {
      // 死後：左鍵下一個隊友、右鍵上一個
      if (e.button === 0) this.host.cycleView(1);
      else if (e.button === 2) this.host.cycleView(-1);
      return;
    }
    if (e.button === 0) {
      if (this.grenade !== null) {
        if (!this.host.throwCooling()) this.chargeStart = performance.now();
        return;
      }
      if (this.bomb) {
        this.interact(s);
        return;
      }
      this.fireHeld = true;
      this.host.send([{ type: 'fire', on: true }]);
    } else if (e.button === 2) {
      // 狙擊鏡：按住右鍵開鏡、放開收鏡
      this.scopeHeld = true;
      this.host.send([{ type: 'scope', on: true }]);
    }
  }

  private mouseUp(e: MouseEvent): void {
    if (e.button === 2 && this.scopeHeld) {
      this.scopeHeld = false;
      if (this.alive() !== null) this.host.send([{ type: 'scope', on: false }]);
      return;
    }
    if (e.button !== 0) return;
    if (this.grenade !== null && this.chargeStart !== null) {
      const s = this.alive();
      const power = Math.round(Math.min(100, ((performance.now() - this.chargeStart) / CHARGE_MS) * 100));
      this.chargeStart = null;
      if (s === null) return;
      const [wx, wy] = toWorld(this.host.camera(), this.mouse.x, this.mouse.y);
      const deg = Math.round((Math.atan2(wy - s.me.y, wx - s.me.x) * 180) / Math.PI + 360) % 360;
      this.host.send([{ type: 'throw', grenade: this.grenade, deg, power }]);
      return;
    }
    if (this.bomb) {
      const s = this.alive();
      if (s !== null) this.cancelAction(s);
      return;
    }
    if (this.fireHeld) this.stopFire();
  }

  private stopFire(): void {
    this.fireHeld = false;
    this.host.send([{ type: 'fire', on: false }]);
  }

  /** 滾輪：依序切換主武器、副武器、刀（沒有的跳過） */
  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const s = this.alive();
    if (s === null) return;
    const have = SLOT_ORDER.filter((slot) => slot === 'knife' || (slot === 'primary' ? s.me.loadout.primary !== null : s.me.loadout.secondary !== null));
    const cur = this.host.meta.weapons.find((w) => w.id === s.me.weapon)?.slot ?? 'knife';
    const i = have.indexOf(cur);
    const next = have[(((i + (e.deltaY > 0 ? 1 : -1)) % have.length) + have.length) % have.length];
    this.grenade = null;
    this.bomb = false;
    this.chargeStart = null;
    this.host.send([{ type: 'switch', slot: next }]);
  }

  /** 失焦：放開所有按鍵（避免一直往前走、一直開火） */
  releaseAll(): void {
    this.held.clear();
    this.chargeStart = null;
    if (this.alive() === null) return;
    const cmds: ShooterCommand[] = [{ type: 'walk', on: false }, { type: 'crouch', on: false }];
    if (this.scopeHeld) cmds.push({ type: 'scope', on: false });
    this.scopeHeld = false;
    if (this.moving) cmds.push({ type: 'stop' });
    if (this.fireHeld) cmds.push({ type: 'fire', on: false });
    this.moving = false;
    this.fireHeld = false;
    this.host.send(cmds);
    this.host.setBoard(false);
  }

  /** 新回合：重送移動狀態（凍結期間按住的方向鍵在開打後才有效） */
  resync(): void {
    this.moving = false;
    this.sendMove();
  }
}
