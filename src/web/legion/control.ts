// 軍團戰玩家操控：選取（點選、Shift 加選、框選）、右鍵移動／攻擊（拖曳指定朝向，多團排成一列）、技能快捷鍵、後備入場與換兵。
// 指令送到 Worker 排隊，下一個決策 tick（每 0.5 秒）交給引擎；暫停中也能下。
import type { FormationKind, UnitKind } from '../../legion/config.ts';
import { TILE, UNITS } from '../../legion/config.ts';
import { ladderSpots, snapLadder, type LadderReg, type LadderSpot } from '../../legion/ladderSpots.ts';
import type { LegionMap } from '../../legion/map.ts';
import { LAYER_SHIFT, REG_MASK, type LegionFrame, type RegFrame } from './protocol.ts';
import type { BattleView } from './view.ts';

export interface Pt {
  x: number;
  y: number;
}

/** 快捷鍵說明（顯示在指令面板） */
export const HOTKEYS: readonly [string, string][] = [
  ['左鍵', '選取（Shift 加選、拖曳框選）'],
  ['右鍵', '移動（拖曳＝指定朝向）／點敵軍攻擊'],
  ['Q', '按住瞄準（顯示衝刺路線、會被地形擋下的位置、齊射落點），放開施放：槍林、突擊、切入、衝鋒、齊射；盾兵開關盾牆。按住時右鍵或 Esc 取消'],
  ['E', '收起槍林；盾兵切換舉盾／持盾'],
  ['A', '邊走邊打到滑鼠位置'],
  ['H', '堅守原地'],
  ['T', '轉向滑鼠'],
  ['F', '跟隨滑鼠下的友軍（保持目前相對位置）'],
  ['Z X C V', '橫陣、方陣、楔形陣、圓陣'],
  ['L', '攻城：按住瞄準雲梯（能架的牆格亮綠、不能架的亮紅，梯子吸附到最近能架的牆格），左鍵架下；放開 L、右鍵或 Esc 取消（劍士、盾兵、長槍、輕步兵）'],
  ['R', '攻城：附上／卸下衝車'],
  ['B', '攻城：砲擊滑鼠位置（每場 3 發，不必選取）'],
  ['Ctrl+A', '全選；Esc 取消選取'],
  ['WASD', '平移鏡頭（照畫面方向；也可以中鍵拖曳）'],
];

const deg = (a: Pt, b: Pt): number => {
  const d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return Math.round((d + 360) % 360);
};

const FORMATION_KEYS: Record<string, FormationKind> = { z: 'line', x: 'square', c: 'wedge', v: 'circle' };

export class PlayerControl {
  readonly side: number;
  readonly selection = new Set<number>();
  /** 框選（螢幕座標） */
  box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** 右鍵拖曳中：目的地與朝向點（世界座標） */
  order: { from: Pt; to: Pt } | null = null;
  /** 按住 Q 瞄準中（放開才施放） */
  aiming = false;
  /** 按住 L 架梯瞄準中（左鍵架下） */
  ladderAim = false;
  /** 目前的繪製器（2D／3D 切換時換掉） */
  r: BattleView;
  private readonly sendCmds: (cmds: unknown[]) => void;
  private readonly toast: (text: string) => void;
  /** 地圖（架梯瞄準算能架的牆格用；沒有城的地圖也照算，全部不能架） */
  private readonly map: LegionMap | null;

  constructor(r: BattleView, side: number, sendCmds: (cmds: unknown[]) => void, toast: (text: string) => void, map: LegionMap | null = null) {
    this.r = r;
    this.side = side;
    this.sendCmds = sendCmds;
    this.toast = toast;
    this.map = map;
  }

  private get frame(): LegionFrame | null {
    return this.r.frame;
  }

  /** 自己場上的團 */
  mine(): RegFrame[] {
    const f = this.frame;
    if (f === null) return [];
    return f.regs.filter((r) => !r.reserve && this.r.ownerOf[r.id] === this.side);
  }

  /** 選取中、還在場上的團 */
  selected(): RegFrame[] {
    const mine = this.mine();
    for (const id of [...this.selection]) if (!mine.some((r) => r.id === id)) this.selection.delete(id);
    return mine.filter((r) => this.selection.has(r.id));
  }

  isMine(id: number): boolean {
    return this.r.ownerOf[id] === this.side;
  }

  /** 點選：自己的團加入選取（Shift 切換），點空地或敵軍清掉選取 */
  click(id: number, shift: boolean): void {
    if (id >= 0 && this.isMine(id)) {
      if (shift) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      } else {
        this.selection.clear();
        this.selection.add(id);
      }
      return;
    }
    if (!shift) this.selection.clear();
  }

  /** 框選結束：螢幕框內的自己的團 */
  finishBox(alpha: number, shift: boolean): void {
    const b = this.box;
    this.box = null;
    if (b === null) return;
    const x0 = Math.min(b.x0, b.x1);
    const x1 = Math.max(b.x0, b.x1);
    const y0 = Math.min(b.y0, b.y1);
    const y1 = Math.max(b.y0, b.y1);
    if (!shift) this.selection.clear();
    for (const reg of this.mine()) {
      const p = this.r.regAt(reg.id, alpha);
      if (p === null) continue;
      const [sx, sy] = this.r.toScreen(p.x, p.y);
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) this.selection.add(reg.id);
    }
  }

  selectAll(): void {
    for (const r of this.mine()) this.selection.add(r.id);
  }

  /** 右鍵：點到看得到的敵軍就攻擊；否則移動（拖曳超過 1.5 格就照拖曳方向決定朝向） */
  rightClick(target: number, from: Pt, to: Pt): void {
    const sel = this.selected();
    if (sel.length === 0) return;
    if (target >= 0 && !this.isMine(target)) {
      this.sendCmds(sel.map((r) => ({ type: 'attack', id: r.id, target, intent: '玩家：攻擊' })));
      this.r.ping(from.x, from.y, '#f87171');
      return;
    }
    const dragged = Math.hypot(to.x - from.x, to.y - from.y) > 1500;
    this.moveGroup(sel, from, dragged ? deg(from, to) : null);
  }

  /** 移動：多團時在目的地排成一列（垂直於朝向），依目前左右位置分配，不交叉 */
  private moveGroup(sel: RegFrame[], dest: Pt, facing: number | null): void {
    const c = { x: sel.reduce((t, r) => t + r.x, 0) / sel.length, y: sel.reduce((t, r) => t + r.y, 0) / sel.length };
    const f = facing ?? (Math.hypot(dest.x - c.x, dest.y - c.y) > 2000 ? deg(c, dest) : sel[0].facing);
    const rad = ((f + 90) * Math.PI) / 180;
    const lx = Math.cos(rad);
    const ly = Math.sin(rad);
    const order = [...sel].sort((a, b) => (a.x - c.x) * lx + (a.y - c.y) * ly - ((b.x - c.x) * lx + (b.y - c.y) * ly));
    const widths = order.map((r) => (2 * r.halfW) / TILE + 1.5);
    const total = widths.reduce((t, w) => t + w, 0);
    let off = -total / 2;
    const cmds = order.map((r, i) => {
      const mid = off + widths[i] / 2;
      off += widths[i];
      const x = Math.round(dest.x + lx * mid * TILE);
      const y = Math.round(dest.y + ly * mid * TILE);
      return { type: 'move', id: r.id, x, y, facing: f, intent: '玩家：移動' };
    });
    this.sendCmds(cmds);
    this.r.ping(dest.x, dest.y, '#93c5fd');
  }

  /** 快捷鍵；回傳 true 表示處理了 */
  key(k: string, ctrl: boolean, mouse: Pt | null, hover: number): boolean {
    const key = k.toLowerCase();
    if (ctrl && key === 'a') {
      this.selectAll();
      return true;
    }
    if (key === 'escape') {
      if (this.aiming || this.ladderAim) {
        this.aiming = false;
        this.ladderAim = false;
      } else this.selection.clear();
      return true;
    }
    if (key === 'b') {
      if (mouse === null) return true;
      this.sendCmds([{ type: 'bombard', x: Math.round(mouse.x), y: Math.round(mouse.y) }]);
      this.r.ping(mouse.x, mouse.y, '#f87171');
      return true;
    }
    const sel = this.selected();
    if (sel.length === 0) return false;
    const m = mouse;
    const cmds: unknown[] = [];
    switch (key) {
      case 'q':
        // 按住瞄準（畫面顯示路線與落點），放開才施放（releaseSkill）
        this.aiming = true;
        return true;
      case 'e':
        for (const r of sel) {
          const kind = this.r.kindOf[r.id];
          if (kind === 'spear' && (r.status === 'braced' || r.status === 'bracing')) cmds.push({ type: 'unbrace', id: r.id, intent: '玩家：收槍林' });
          if (kind === 'shield') cmds.push({ type: 'shield', id: r.id, mode: r.stance === 'raise' ? 'carry' : 'raise', intent: r.stance === 'raise' ? '玩家：持盾' : '玩家：舉盾' });
        }
        break;
      case 'a':
        if (m) for (const r of sel) cmds.push({ type: 'attackMove', id: r.id, x: Math.round(m.x), y: Math.round(m.y), intent: '玩家：邊走邊打' });
        if (m) this.r.ping(m.x, m.y, '#fca5a5');
        break;
      case 'h':
        for (const r of sel) cmds.push({ type: 'hold', id: r.id, intent: '玩家：堅守' });
        break;
      case 'l':
        // 按住瞄準（畫面標出能架的牆格與吸附的梯子），左鍵架下（placeLadder）
        this.ladderAim = true;
        return true;
      case 'r': {
        const crew = this.frame?.structures.ram?.crew ?? null;
        const r = sel[0];
        cmds.push(crew === r.id ? { type: 'unman', id: r.id, intent: '玩家：卸下衝車' } : { type: 'man', id: r.id, target: 0, intent: '玩家：推衝車' });
        break;
      }
      case 't':
        if (m) for (const r of sel) cmds.push({ type: 'face', id: r.id, facing: deg(r, m), intent: '玩家：轉向' });
        break;
      case 'f': {
        if (hover < 0 || !this.isMine(hover)) {
          this.toast('跟隨：滑鼠要指著自己的另一團');
          return true;
        }
        const t = this.frame?.regs.find((x) => x.id === hover);
        if (!t) return true;
        const a = (t.facing * Math.PI) / 180;
        for (const r of sel) {
          if (r.id === hover) continue;
          const dx = r.x - t.x;
          const dy = r.y - t.y;
          const forward = Math.round(dx * Math.cos(a) + dy * Math.sin(a));
          const right = Math.round(-dx * Math.sin(a) + dy * Math.cos(a));
          cmds.push({ type: 'follow', id: r.id, target: hover, forward, right, intent: '玩家：跟隨' });
        }
        break;
      }
      default: {
        const fm = FORMATION_KEYS[key];
        if (fm === undefined) return false;
        for (const r of sel) {
          if (UNITS[this.r.kindOf[r.id] as UnitKind].formations.includes(fm)) cmds.push({ type: 'formation', id: r.id, formation: fm, intent: '玩家：變陣' });
        }
        if (cmds.length === 0) this.toast('選取的兵種都不能用這個陣形');
      }
    }
    if (cmds.length > 0) this.sendCmds(cmds);
    return true;
  }

  /** 放開 Q：朝滑鼠施放各團的招牌技能 */
  releaseSkill(m: Pt | null): void {
    if (!this.aiming) return;
    this.aiming = false;
    const cmds: unknown[] = [];
    for (const r of this.selected()) {
      const kind = this.r.kindOf[r.id];
      if (kind === 'spear') {
        if (r.status === 'braced' || r.status === 'bracing') cmds.push({ type: 'unbrace', id: r.id, intent: '玩家：收槍林' });
        else if (m) cmds.push({ type: 'brace', id: r.id, facing: deg(r, m), intent: '玩家：槍林' });
      } else if (kind === 'shield') {
        cmds.push({ type: 'shield', id: r.id, mode: r.status === 'walled' || r.status === 'walling' ? 'unwall' : 'wall', intent: '玩家：盾牆' });
      } else if (m) {
        const type = kind === 'archer' ? 'volley' : kind === 'sword' ? 'assault' : kind === 'light' ? 'infiltrate' : 'charge';
        cmds.push({ type, id: r.id, x: Math.round(m.x), y: Math.round(m.y), intent: `玩家：${type === 'volley' ? '齊射' : type === 'assault' ? '突擊' : type === 'infiltrate' ? '切入' : '衝鋒'}` });
      }
    }
    if (cmds.length > 0) this.sendCmds(cmds);
  }

  /** 選取的團的架梯資料（層取多數士兵所在的層） */
  private ladderRegs(): LadderReg[] {
    const f = this.frame;
    if (f === null) return [];
    const sel = this.selected();
    const count = new Map<number, [number, number, number]>();
    const s = f.soldiers;
    for (let i = 0; i < s.length; i += 4) {
      const reg = s[i + 3] & REG_MASK;
      if (!this.selection.has(reg)) continue;
      const c = count.get(reg) ?? [0, 0, 0];
      c[(s[i + 3] >> LAYER_SHIFT) & 3] += 1;
      count.set(reg, c);
    }
    const crew = f.structures.ram?.crew ?? null;
    return sel.map((r) => {
      const c = count.get(r.id) ?? [1, 0, 0];
      const layer = c[1] > c[0] && c[1] >= c[2] ? 1 : c[2] > c[0] ? 2 : 0;
      return { id: r.id, owner: this.side, kind: this.r.kindOf[r.id], x: r.x, y: r.y, layer, building: r.status === 'laddering', manning: crew === r.id };
    });
  }

  /** 架梯瞄準的畫面資料：附近牆格能不能架、滑鼠吸附到的牆格、滑鼠指的那格不能架的原因 */
  ladderPreview(m: Pt | null): { spots: LadderSpot[]; snap: LadderSpot | null; why: string; at: Pt | null } | null {
    if (!this.ladderAim || this.map === null) return null;
    const spots = ladderSpots(this.map, this.ladderRegs(), this.frame?.structures.ladders ?? []);
    const snap = m === null ? null : snapLadder(spots, m.x, m.y);
    let why = '';
    if (snap === null) {
      const at = m === null ? undefined : spots.find((q) => q.tx === Math.floor(m.x / TILE) && q.ty === Math.floor(m.y / TILE));
      why = at?.why ?? (spots.some((q) => q.ok) ? '' : (spots.find((q) => q.why !== '')?.why ?? '附近沒有城牆'));
    }
    return { spots, snap, why, at: m };
  }

  /** 架梯瞄準中按左鍵：在吸附到的牆格架梯（由離梯腳最近、能架的那團架）；結束瞄準 */
  placeLadder(m: Pt | null): void {
    const p = this.ladderPreview(m);
    this.ladderAim = false;
    if (p === null) return;
    if (p.snap === null) {
      this.toast(p.why !== '' ? `不能架雲梯：${p.why}` : '附近沒有能架雲梯的城牆');
      return;
    }
    this.sendCmds([{ type: 'ladder', id: p.snap.reg, x: p.snap.x, y: p.snap.y, intent: '玩家：架雲梯' }]);
    this.r.ping(p.snap.footX, p.snap.footY, '#4ade80');
  }

  /** 名冊點後備：選了一團場上的就換兵，否則從出生點召喚 */
  reserveClick(id: number): void {
    const sel = this.selected();
    if (sel.length === 1) this.sendCmds([{ type: 'swap', id: sel[0].id, with: id, intent: '玩家：換兵' }]);
    else this.sendCmds([{ type: 'summon', id, intent: '玩家：後備入場' }]);
  }
}
