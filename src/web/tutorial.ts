// 新手教學：逐步引導採礦、生產、建造、出兵、進攻。每一步偵測玩家是否完成，完成即自動進到下一步。
import { TILE_SIZE } from '../config/index.ts';
import type { FrameView, StaticMapView, UnitFrame } from '../view/snapshot.ts';

/** 教學判斷用的畫面狀態 */
export interface TutorialView {
  readonly frame: FrameView;
  readonly map: StaticMapView;
  readonly human: number;
  readonly enemy: number;
  readonly selection: ReadonlySet<number>;
}

interface Step {
  readonly title: string;
  readonly text: string;
  /** 要閃爍提示的指令格按鈕（依序取第一個目前有顯示的） */
  readonly highlight?: readonly string[];
  /** 地圖上要標示的位置 */
  readonly beacon?: (v: TutorialView) => { x: number; y: number } | null;
  /** 完成條件；沒有則需按「下一步」 */
  readonly done?: (v: TutorialView) => boolean;
}

function baseCenter(v: TutorialView, pid: number): { x: number; y: number } {
  const b = v.frame.buildings.find((x) => x.owner === pid && x.type === 'base' && !x.remembered);
  if (b !== undefined) return { x: (b.tileX + b.size / 2) * TILE_SIZE, y: (b.tileY + b.size / 2) * TILE_SIZE };
  const s = v.map.players[pid];
  return { x: (s.startTileX + 1.5) * TILE_SIZE, y: (s.startTileY + 1.5) * TILE_SIZE };
}

const mine = (v: TutorialView): UnitFrame[] => v.frame.units.filter((u) => u.owner === v.human);
const count = (v: TutorialView, type: string): number => mine(v).filter((u) => u.type === type).length;
const hasBuilding = (v: TutorialView, type: string): boolean => v.frame.buildings.some((b) => b.owner === v.human && b.type === type && !b.remembered);

const STEPS: readonly Step[] = [
  {
    title: '歡迎來到天使戰隊 RTS',
    text: '你的隊伍是<b class="blue">藍色</b>。目標是<b>摧毀對手（紅色）的主堡</b>。<br>移動畫面：<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>、方向鍵，或把滑鼠移到畫面邊緣；滾輪縮放。<br>隨時可以按 <kbd>?</kbd> 看說明、<kbd>空白鍵</kbd> 暫停。',
  },
  {
    title: '選取工人',
    text: '按住滑鼠<b>左鍵拖曳</b>，框住主堡旁邊的工人（藍色小圓點，中間有白點）。被選取的單位會出現綠色圓圈。',
    beacon: (v) => {
      const ws = mine(v).filter((u) => u.type === 'worker');
      if (ws.length === 0) return null;
      return { x: ws.reduce((a, u) => a + u.x, 0) / ws.length, y: ws.reduce((a, u) => a + u.y, 0) / ws.length };
    },
    done: (v) => mine(v).filter((u) => u.type === 'worker' && v.selection.has(u.id)).length >= 2,
  },
  {
    title: '採礦',
    text: '用<b>右鍵</b>點一下淺藍色的菱形（礦點），工人就會開始採礦，採到的礦會自動送回主堡。<br>也可以按 <kbd>G</kbd>：工人自動去採最近的礦。記得把 4 名工人都派去。',
    highlight: ['gather'],
    beacon: (v) => {
      const c = baseCenter(v, v.human);
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const n of v.map.nodes) {
        const x = (n.tileX + 0.5) * TILE_SIZE;
        const y = (n.tileY + 0.5) * TILE_SIZE;
        const d = (x - c.x) ** 2 + (y - c.y) ** 2;
        if (!n.rich && d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
      return best;
    },
    done: (v) => mine(v).filter((u) => u.type === 'worker' && u.order === 'gather').length >= 4,
  },
  {
    title: '生產工人',
    text: '<b>左鍵點主堡</b>選取它，再按 <kbd>Q</kbd>（或右下角的「工人」按鈕）。工人越多，礦採得越快。<br>新工人會自己出現在主堡旁邊，記得也派去採礦。',
    highlight: ['train:worker'],
    beacon: (v) => baseCenter(v, v.human),
    done: (v) => count(v, 'worker') >= 5 || v.frame.buildings.some((b) => b.owner === v.human && b.type === 'base' && b.queue.length > 0),
  },
  {
    title: '蓋補給站',
    text: '頂列的「人口」到上限就不能再生產。補給站每座 +8。<br>選一名工人，按 <kbd>B</kbd> 打開建造選單，再按 <kbd>S</kbd>（補給站），然後在主堡附近的空地<b>左鍵放下</b>。綠色可以蓋、紅色不行；礦不夠時按鈕是灰的，等一下就好。',
    highlight: ['build:supply', 'build'],
    done: (v) => hasBuilding(v, 'supply'),
  },
  {
    title: '蓋兵營',
    text: '用同樣的方式蓋一座兵營（<kbd>B</kbd> → <kbd>R</kbd>，150 礦）。兵營可以生產戰鬥單位。<br>等礦的時候可以繼續讓主堡生產工人。',
    highlight: ['build:barracks', 'build'],
    done: (v) => hasBuilding(v, 'barracks'),
  },
  {
    title: '生產長槍兵',
    text: '等兵營蓋好（建築上的黃色進度條跑完），<b>選取兵營按 <kbd>Q</kbd></b> 生產長槍兵，湊滿 3 隻。<br>小技巧：選取兵營時右鍵點地上，可以設定新兵的集結點。',
    highlight: ['train:spear'],
    beacon: (v) => {
      const b = v.frame.buildings.find((x) => x.owner === v.human && x.type === 'barracks');
      return b === undefined ? null : { x: (b.tileX + b.size / 2) * TILE_SIZE, y: (b.tileY + b.size / 2) * TILE_SIZE };
    },
    done: (v) => count(v, 'spear') >= 3,
  },
  {
    title: '進攻',
    text: '框選你的長槍兵，按 <kbd>A</kbd>（攻擊移動），再<b>左鍵點敵方主堡</b>——地圖另一端閃爍的黃圈，小地圖上也有標示（可以直接點小地圖）。<br>攻擊移動途中遇到敵人會自動開打。',
    highlight: ['attackMove'],
    beacon: (v) => baseCenter(v, v.enemy),
    done: (v) => {
      const e = baseCenter(v, v.enemy);
      const r = 14 * TILE_SIZE;
      return mine(v).some((u) => u.type !== 'worker' && (u.order === 'attackMove' || u.order === 'attack' || (u.x - e.x) ** 2 + (u.y - e.y) ** 2 < r * r));
    },
  },
  {
    title: '摧毀敵方主堡',
    text: '部隊抵達後會自動攻擊附近的敵人；也可以選取部隊後<b>右鍵點敵方主堡</b>指定攻擊。<br>持續生產長槍兵增援，按 <kbd>＋</kbd> 可以加速遊戲。',
    beacon: (v) => baseCenter(v, v.enemy),
    done: (v) => !v.frame.players[v.enemy].alive,
  },
];

export interface TutorialHooks {
  setHighlight(ids: readonly string[]): void;
  setBeacon(p: { x: number; y: number } | null): void;
}

export class Tutorial {
  private readonly root: HTMLElement;
  private readonly hooks: TutorialHooks;
  private index = 0;
  private hidden = false;
  private shownIndex = -1;

  constructor(parent: HTMLElement, hooks: TutorialHooks) {
    this.hooks = hooks;
    this.root = document.createElement('div');
    this.root.className = 'tutorial';
    parent.append(this.root);
  }

  get finished(): boolean {
    return this.index >= STEPS.length;
  }

  /** 每次畫面更新呼叫：檢查完成條件、更新提示 */
  update(v: TutorialView): void {
    if (this.hidden) return;
    while (this.index < STEPS.length) {
      const done = STEPS[this.index].done;
      if (done === undefined || !done(v)) break;
      this.index += 1;
    }
    if (this.finished) {
      this.hooks.setHighlight([]);
      this.hooks.setBeacon(null);
      if (this.shownIndex !== this.index) this.render();
      return;
    }
    const step = STEPS[this.index];
    this.hooks.setHighlight(step.highlight ?? []);
    this.hooks.setBeacon(step.beacon?.(v) ?? null);
    if (this.shownIndex !== this.index) this.render();
  }

  private render(): void {
    this.shownIndex = this.index;
    this.root.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tut-head';
    if (this.finished) {
      head.textContent = '教學完成！';
      this.root.append(head, Object.assign(document.createElement('div'), { className: 'tut-text', innerHTML: '你已經學會基本操作。<br>接下來可以回選單試試「1v1：玩家 vs 基準 Bot」，基準 Bot 會出兵反擊。' }));
      return;
    }
    const step = STEPS[this.index];
    head.innerHTML = `<span class="tut-n">教學 ${this.index + 1}／${STEPS.length}</span>${step.title}`;
    const text = document.createElement('div');
    text.className = 'tut-text';
    text.innerHTML = step.text;
    const row = document.createElement('div');
    row.className = 'tut-row';
    if (step.done === undefined) {
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'primary';
      next.textContent = '下一步';
      next.addEventListener('click', () => {
        this.index += 1;
        this.shownIndex = -1;
      });
      row.append(next);
    } else {
      row.append(Object.assign(document.createElement('span'), { className: 'tut-wait', textContent: '完成後會自動進入下一步' }));
    }
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.textContent = '關閉教學';
    skip.addEventListener('click', () => {
      this.hidden = true;
      this.root.classList.add('hidden');
      this.hooks.setHighlight([]);
      this.hooks.setBeacon(null);
    });
    row.append(skip);
    this.root.append(head, text, row);
  }
}
